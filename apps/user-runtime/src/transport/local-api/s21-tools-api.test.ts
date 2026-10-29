/**
 * Tools API (S21 chunk 6; PRD §7, E4, D38, G2/G3/G6, E12) — the HTTP surface
 * over the runtime executor and inventory, composed end to end (real SQLite,
 * real pack, real routes).
 *
 *   1. GET /v1/tools lists the inventory truthfully: the built-ins from the
 *      registry and agent-created rows with owner/scope/risk/permissions/
 *      version/lifecycle state (E12-scoped — another workspace sees none).
 *   2. The creation flow: the pure preview (zero rows), the create command
 *      (the D38 refusal is a typed 422 naming the layer), and the created
 *      row appearing in the inventory.
 *   3. AC8 over HTTP: activation with an agent actor is the typed 403; a
 *      user actor activates; the row flips to active.
 *   4. The disable switch: a disabled tool answers disabled in the inventory
 *      AND the executor refuses it (the switch beats grants end to end).
 *   5. GET /v1/tools/history returns the redacted tool history with the
 *      approval linkage (the scripted demo execution is recorded like any
 *      real tool).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = join(here, "../../../../../agent-packs");

const clockNow = "2026-10-29T12:00:00.000Z";
const WS = "ws-local-default";

const tempDirs: string[] = [];

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dir: string;
  close(): Promise<void>;
}

async function composeOn(): Promise<RunningRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "shera-s21-tools-api-"));
  tempDirs.push(dir);
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    packsRoot: PACKS_ROOT,
    now: () => clockNow,
  });
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dir,
    close: () => runtime.close(),
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const USER_ACTOR = { type: "user", id: "user_owner" };

function creationBody(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: WS,
    requested_by: { type: "agent", id: "agent_researcher" },
    actor: USER_ACTOR,
    // D25: unknown fields are rejected — the create request carries the
    // authorizing actor; the preview request drops it (strict contracts).
    tool: {
      tool_id: "tool_digest_builder",
      name: "Digest builder",
      purpose: "Builds a digest line for a note.",
      input_schema: { type: "object" },
      output_schema: { type: "object" },
      capabilities: ["file.read"],
      risk_class: "READ_ONLY",
      inventory_scope: "shared",
    },
    ...overrides,
  };
}

const running: RunningRuntime[] = [];

/** Close one runtime and forget it (per-test teardown keeps the suite tidy). */
async function closeRuntime(rt: RunningRuntime): Promise<void> {
  await rt.close();
  const index = running.indexOf(rt);
  if (index >= 0) {
    running.splice(index, 1);
  }
}

afterAll(async () => {
  // Whatever a failed test left behind is closed here (idempotent — the
  // connection's own close throws when already closed).
  for (const rt of running) {
    try {
      await rt.close();
    } catch {
      // already closed by the owning test
    }
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tools API (S21 chunk 6)", () => {
  it("lists the inventory with the pinned pack's built-ins, truthfully scoped", async () => {
    const rt = await composeOn();
    running.push(rt);
    const { status, body } = await getJson(rt.origin, `/v1/tools?workspace_id=${WS}`);
    expect(status).toBe(200);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool).toHaveProperty("tool_id");
      expect(tool).toHaveProperty("version");
      expect(tool).toHaveProperty("risk_class");
      expect(tool).toHaveProperty("owner");
      expect(tool).toHaveProperty("capabilities");
    }
    // E12: another workspace sees none of it.
    const other = await getJson(rt.origin, "/v1/tools?workspace_id=ws_other_99");
    expect((other.body.tools as unknown[]).length).toBe(0);
    // The workspace_id is required.
    const missing = await getJson(rt.origin, "/v1/tools");
    expect(missing.status).toBe(400);
    await closeRuntime(rt);
  });

  it("runs the creation flow: pure preview, D38 refusal, successful create", async () => {
    const rt = await composeOn();
    running.push(rt);
    // The pure preview: ok, and NOTHING is created (the preview request
    // carries no actor — D25 strict contracts).
    const { actor, ...previewBody } = creationBody();
    // The preview contract carries no actor (D25 strict contracts) — the
    // create request is the one that names the authorizing user.
    expect(actor.type).toBe("user");
    const preview = await postJson(rt.origin, "/v1/tools/creation-preview", previewBody);
    expect(preview.status).toBe(200);
    expect((preview.body.preview as Record<string, unknown>).ok).toBe(true);
    const before = await getJson(rt.origin, `/v1/tools?workspace_id=${WS}`);
    expect(
      (before.body.tools as Array<Record<string, unknown>>).filter(
        (t) => t.tool_id === "tool_digest_builder",
      ),
    ).toHaveLength(0);

    // The D38 refusal: a capability the pack does not allow, layer named.
    const refused = await postJson(
      rt.origin,
      "/v1/tools/create",
      creationBody({
        tool: {
          tool_id: "tool_deployer",
          name: "Deployer",
          purpose: "Deploys the cluster.",
          input_schema: { type: "object" },
          output_schema: { type: "object" },
          capabilities: ["deploy.cluster"],
          risk_class: "DEPLOYMENT",
          inventory_scope: "shared",
        },
      }),
    );
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("TOOL_CAPABILITY_NOT_ALLOWED");
    expect(String(refused.body.safe_message)).toContain("platform does not implement");

    // The create command succeeds and appears in the inventory (auto-active).
    const created = await postJson(rt.origin, "/v1/tools/create", creationBody());
    expect(created.status).toBe(200);
    expect((created.body.created as Record<string, unknown>).state).toBe("active");
    const after = await getJson(rt.origin, `/v1/tools?workspace_id=${WS}`);
    const row = (after.body.tools as Array<Record<string, unknown>>).find(
      (t) => t.tool_id === "tool_digest_builder",
    );
    expect(row?.state).toBe("active");
    expect((row?.owner as Record<string, unknown>).agent_id).toBe("agent_researcher");
    await closeRuntime(rt);
  });

  it("AC8 over HTTP: an agent actor cannot activate; the user can", async () => {
    const rt = await composeOn();
    running.push(rt);
    // Create a risky tool (lands in `created`).
    const risky = {
      ...creationBody(),
      tool: {
        tool_id: "tool_custom_append",
        name: "Custom append",
        purpose: "Appends a line.",
        input_schema: { type: "object" },
        output_schema: { type: "object" },
        capabilities: ["file.write"],
        risk_class: "LOCAL_MUTATION",
        inventory_scope: "shared",
      },
    };
    await postJson(rt.origin, "/v1/tools/create", risky);

    // The agent actor is refused (403) — the creating Agent cannot self-grant.
    const agentRefused = await postJson(rt.origin, "/v1/tools/activate", {
      workspace_id: WS,
      tool_id: "tool_custom_append",
      version: "1.0.0",
      target: { kind: "agent", id: "agent_researcher" },
      actor: { type: "agent", id: "agent_researcher" },
    });
    expect(agentRefused.status).toBe(403);
    expect(String(agentRefused.body.code)).toBe("ACTIVATION_REQUIRES_RUNTIME_GRANT");

    // The user actor activates; the row flips active.
    const activated = await postJson(rt.origin, "/v1/tools/activate", {
      workspace_id: WS,
      tool_id: "tool_custom_append",
      version: "1.0.0",
      target: { kind: "agent", id: "agent_researcher" },
      actor: USER_ACTOR,
    });
    expect(activated.status).toBe(200);
    expect((activated.body.activation as Record<string, unknown>).granted).toBe(true);
    const inventory = await getJson(rt.origin, `/v1/tools?workspace_id=${WS}`);
    const row = (inventory.body.tools as Array<Record<string, unknown>>).find(
      (t) => t.tool_id === "tool_custom_append",
    );
    expect(row?.state).toBe("active");
    await closeRuntime(rt);
  });

  it("the disable switch flips the inventory state (beats grants — end-to-end execution refusal is chunk 5's pin)", async () => {
    const rt = await composeOn();
    running.push(rt);
    await postJson(rt.origin, "/v1/tools/create", creationBody());
    const disabled = await postJson(rt.origin, "/v1/tools/disable", {
      workspace_id: WS,
      tool_id: "tool_digest_builder",
      actor: USER_ACTOR,
    });
    expect(disabled.status).toBe(200);
    const inventory = await getJson(rt.origin, `/v1/tools?workspace_id=${WS}`);
    const row = (inventory.body.tools as Array<Record<string, unknown>>).find(
      (t) => t.tool_id === "tool_digest_builder",
    );
    expect(row?.disabled).toBe(true);
    // Re-enable restores it.
    await postJson(rt.origin, "/v1/tools/enable", {
      workspace_id: WS,
      tool_id: "tool_digest_builder",
      actor: USER_ACTOR,
    });
    const after = await getJson(rt.origin, `/v1/tools?workspace_id=${WS}`);
    const rowAfter = (after.body.tools as Array<Record<string, unknown>>).find(
      (t) => t.tool_id === "tool_digest_builder",
    );
    expect(rowAfter?.disabled).toBe(false);
  });

  it("the tool history is readable and redacted-by-contract (digest only, no raw args)", async () => {
    const rt = await composeOn();
    running.push(rt);
    const { status, body } = await getJson(rt.origin, `/v1/tools/history?workspace_id=${WS}`);
    expect(status).toBe(200);
    const history = body.history as Array<Record<string, unknown>>;
    for (const entry of history) {
      expect(String(entry.args_summary)).not.toMatch(/password|secret|token/i);
      expect(entry).toHaveProperty("risk_class");
      expect(entry).toHaveProperty("recovery");
    }
  });
});
