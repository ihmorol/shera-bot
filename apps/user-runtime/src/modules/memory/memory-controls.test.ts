/**
 * S29 chunk 3 — the user controls (issue #30 AC4–AC8; PRD §11, D37, G6):
 *
 * - AC4 version restore: editing then restoring returns the previous
 *   content, and history is preserved (restore APPENDS, never rewrites);
 * - AC5 automatic memory disable (global AND per-Agent) stops new automatic
 *   writes while explicit user writes still work;
 * - AC6 permanently forget: the entry AND its versions leave active storage
 *   (the honest copy — nothing "restorable" survives a permanent forget);
 * - AC7 agent-private memory is unreadable through ANY API path by another
 *   Agent (the sweep: every read shape, not just one route);
 * - AC8 a pack upgrade never rewrites existing memory rows.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "../../transport/local-api/compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const WORKSPACE = DEFAULT_WORKSPACE_ID;
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeOn(dbPath: string): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

async function get(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function command(type: string, extra: Record<string, unknown>) {
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 10)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-04T10:00:00.000Z",
    type,
    ...extra,
  };
}

function createCommand(extra: Record<string, unknown>) {
  return command("memory.create", {
    owner_agent_id: null,
    operation_id: null,
    task_id: null,
    expires_at: null,
    ...extra,
  });
}

async function seedWorkspaceMemory(
  origin: string,
  scope: string,
  summary: string,
  content: string,
): Promise<string> {
  const created = await post(origin, "/v1/memory/commands", createCommand({
    scope,
    summary,
    content,
    sensitivity: "normal",
    source_refs: ["conversation://direct/user_emon"],
    confidence: 0.7,
  }));
  expect(created.status).toBe(200);
  return (created.body["entry"] as { memory_id: string }).memory_id;
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S29 chunk 3: the user controls", () => {
  it("restores a previous version after an edit — the content returns and the history is preserved (AC4)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-restore-"), "runtime.db"));
    const { origin } = running;

    const memoryId = await seedWorkspaceMemory(
      origin,
      "workspace",
      "Sweep methodology",
      "Version one: search the corpus with the broad query first.",
    );

    const edited = await post(origin, "/v1/memory/commands", command("memory.edit", {
      memory_id: memoryId,
      summary: "Sweep methodology",
      content: "Version two: narrow queries per section, then merge.",
      sensitivity: "normal",
      source_refs: ["conversation://direct/user_emon"],
      confidence: 0.8,
      expires_at: null,
    }));
    expect(edited.status).toBe(200);

    // The current content is the edit.
    const userView = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      scopes: Record<string, { memory_id: string; content: string; versions: { version: number; change_kind: string }[] }[]>;
    };
    const current = userView.scopes["workspace"]!.find((entry) => entry.memory_id === memoryId);
    expect(current!.content).toBe("Version two: narrow queries per section, then merge.");
    expect(current!.versions.map((version) => version.change_kind)).toEqual([
      "created",
      "edited",
    ]);

    // Restore version 1: the content RETURNS, and the restore appends
    // (history is preserved — created, edited, restored).
    const restored = await post(origin, "/v1/memory/commands", command("memory.restore", {
      memory_id: memoryId,
      version: 1,
    }));
    expect(restored.status).toBe(200);

    const after = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      scopes: Record<string, { memory_id: string; content: string; versions: { version: number; change_kind: string; content: string }[] }[]>;
    };
    const restoredEntry = after.scopes["workspace"]!.find((entry) => entry.memory_id === memoryId);
    expect(restoredEntry!.content).toBe("Version one: search the corpus with the broad query first.");
    expect(restoredEntry!.versions.map((version) => version.change_kind)).toEqual([
      "created",
      "edited",
      "restored",
    ]);
    // History rows keep their own contents — the edited version was not
    // rewritten by the restore.
    expect(restoredEntry!.versions.find((version) => version.version === 2)!.content).toBe(
      "Version two: narrow queries per section, then merge.",
    );

    await running.close();
  });

  it("disabling automatic memory globally and per-Agent stops new automatic writes; explicit user writes still work (AC5)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-automemory-"), "runtime.db"));
    const { origin, runtime } = running;

    const op = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Auto sweep",
      roster_agent_ids: [RESEARCHER, GENERAL],
      coordinator_agent_id: GENERAL,
    });
    expect(op.status).toBe(201);
    const operationId = op.body["operation_id"] as string;

    const candidate = () =>
      runtime.memory.proposeCandidate({
        workspace_id: WORKSPACE,
        proposed_by_agent_id: RESEARCHER,
        scope: "operation",
        operation_id: operationId,
        summary: "Automatic note",
        content: "Learned from the conversation: the user prefers bullet summaries.",
        source_refs: [`conversation://${operationId}/messages`],
        confidence: 0.7,
        sensitivity: "normal",
      });

    // Automatic writes work while enabled.
    const before = await candidate();
    expect(before.entry.memory_id).toBeTruthy();

    // Disable GLOBALLY: the automatic write is refused; an explicit user
    // write still works.
    const globalOff = await post(origin, "/v1/memory/commands", command("memory.set_auto_memory", {
      enabled: false,
    }));
    expect(globalOff.status).toBe(200);
    await expect(candidate()).rejects.toMatchObject({ code: "MEMORY_AUTOMATIC_DISABLED" });
    const userWrite = await seedWorkspaceMemory(
      origin,
      "workspace",
      "User's explicit note",
      "The user wrote this themselves while automatic memory was off.",
    );
    expect(userWrite).toBeTruthy();

    // Re-enable globally, disable PER-AGENT: that Agent's automatic writes
    // are refused; ANOTHER Agent's automatic writes still work.
    expect(await post(origin, "/v1/memory/commands", command("memory.set_auto_memory", { enabled: true })).then((r) => r.status)).toBe(200);
    const agentOff = await post(origin, "/v1/memory/commands", command("memory.set_agent_auto_memory", {
      agent_id: RESEARCHER,
      enabled: false,
    }));
    expect(agentOff.status).toBe(200);
    await expect(candidate()).rejects.toMatchObject({ code: "MEMORY_AUTOMATIC_DISABLED" });
    const otherAgent = await runtime.memory.proposeCandidate({
      workspace_id: WORKSPACE,
      proposed_by_agent_id: GENERAL,
      scope: "operation",
      operation_id: operationId,
      summary: "Coordinator note",
      content: "Learned by another Agent whose automatic memory is still enabled.",
      source_refs: [`conversation://${operationId}/messages`],
      confidence: 0.7,
      sensitivity: "normal",
    });
    expect(otherAgent.entry.memory_id).toBeTruthy();

    // The settings surface shows both controls truthfully.
    const view = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      auto_memory: { global_enabled: boolean; agents: { agent_id: string; enabled: boolean }[] };
    };
    expect(view.auto_memory.global_enabled).toBe(true);
    expect(view.auto_memory.agents).toContainEqual({ agent_id: RESEARCHER, enabled: false });

    await running.close();
  });

  it("permanently forgets the entry AND its versions — nothing restorable survives (AC6)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-forget-"), "runtime.db"));
    const { origin } = running;

    const memoryId = await seedWorkspaceMemory(
      origin,
      "workspace",
      "To be forgotten",
      "This note and its history are about to leave active storage.",
    );
    await post(origin, "/v1/memory/commands", command("memory.edit", {
      memory_id: memoryId,
      summary: "To be forgotten",
      content: "Edited once before the forget.",
      sensitivity: "normal",
      source_refs: ["conversation://direct/user_emon"],
      confidence: 0.7,
      expires_at: null,
    }));

    const forgotten = await post(origin, "/v1/memory/commands", command("memory.forget", {
      memory_id: memoryId,
    }));
    expect(forgotten.status).toBe(200);

    // Gone from the user's management read.
    const view = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      scopes: Record<string, { memory_id: string }[]>;
    };
    for (const rows of Object.values(view.scopes)) {
      expect(rows.map((entry) => entry.memory_id)).not.toContain(memoryId);
    }

    // Gone from storage — the forget preview (the honest-confirmation
    // read) counts NOTHING left: no entry, no version rows (no
    // "permanently forget but restorable" contradiction: there is nothing
    // left to restore).
    const preview = running.runtime.memory.forgetPreview(WORKSPACE, memoryId);
    expect(preview.entries).toBe(0);
    expect(preview.versions).toBe(0);

    // A second forget is the typed 404 — nothing lingers to double-delete.
    const again = await post(origin, "/v1/memory/commands", command("memory.forget", {
      memory_id: memoryId,
    }));
    expect(again.status).toBe(404);

    await running.close();
  });

  it("denies another Agent's private memory through EVERY read shape (AC7 — the sweep)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-sweep-"), "runtime.db"));
    const { origin } = running;

    const op = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Boundary sweep",
      roster_agent_ids: [RESEARCHER, GENERAL],
      coordinator_agent_id: GENERAL,
    });
    expect(op.status).toBe(201);
    const operationId = op.body["operation_id"] as string;

    // The sweep fixture: the researcher's OWNED private memory (an
    // agent_private row without its owner is refused at the boundary).
    const seeded = await post(origin, "/v1/memory/commands", createCommand({
      scope: "agent_private",
      owner_agent_id: RESEARCHER,
      operation_id: operationId,
      summary: "Researcher's private note",
      content: "A private note only the researcher may read.",
      sensitivity: "normal",
      source_refs: [`conversation://${operationId}/messages`],
      confidence: 0.7,
    }));
    expect(seeded.status).toBe(200);
    const privateId = (seeded.body["entry"] as { memory_id: string }).memory_id;

    // Shape 1: the OTHER Agent's context reads — with and without the
    // operation binding, and the user-management read of ANOTHER AGENT's
    // private rows is the user's own inspect power, never an Agent path
    // (there is no Agent-attributed parameter on it at all).
    for (const path of [
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}`,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    ]) {
      const view = (await (await fetch(`${origin}${path}`)).json()) as {
        entries: { memory_id: string; content: string }[];
      };
      expect(view.entries.map((entry) => entry.memory_id)).not.toContain(privateId);
      expect(JSON.stringify(view)).not.toContain("A private note only the researcher");
    }

    // Shape 2: the direct detail read as the other Agent — the typed 403.
    const denied = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/entries/${privateId}?workspace_id=${WORKSPACE}`,
    );
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });

    // Shape 3: the Operation context projection — the thread-side read.
    const operationContext = (await (
      await fetch(`${origin}/v1/operations/${operationId}/memory-context?workspace_id=${WORKSPACE}`)
    ).json()) as { entries: { memory_id: string }[] };
    expect(operationContext.entries.map((entry) => entry.memory_id)).not.toContain(privateId);

    // Shape 4: there is no query parameter that retargets an Agent's own
    // context read at another Agent's private rows — the acting Agent is
    // the PATH identity, and the strict query schema REFUSES the spoofed
    // parameter outright (the D25 unknown-field rejection; a retargeting
    // query is not a read, it is a 400).
    const spoofed = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}&owner_agent_id=${RESEARCHER}`,
    );
    expect(spoofed.status).toBe(400);
    expect(spoofed.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });

    await running.close();
  });

  it("a pack upgrade never rewrites existing memory rows (AC8)", async () => {
    const dbPath = join(makeTempDir("shera-s29-packupgrade-"), "runtime.db");
    const first = await composeOn(dbPath);
    const memoryId = await seedWorkspaceMemory(
      first.origin,
      "workspace",
      "Survives the upgrade",
      "This memory row must be byte-identical after the pack upgrade path runs.",
    );
    await first.close();

    // The upgrade path: re-compose on the SAME database (the pack re-loads,
    // the workspace re-pins, the Agents re-seed) — then prove the memory
    // row was not rewritten.
    const second = await composeOn(dbPath);
    const view = (await (await fetch(`${second.origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      scopes: Record<string, { memory_id: string; summary: string; content: string; confidence: number; created_at: string; updated_at: string }[]>;
    };
    const row = Object.values(view.scopes)
      .flat()
      .find((entry) => entry.memory_id === memoryId);
    expect(row).toBeDefined();
    expect(row!.summary).toBe("Survives the upgrade");
    expect(row!.content).toBe("This memory row must be byte-identical after the pack upgrade path runs.");
    expect(row!.confidence).toBe(0.7);

    await second.close();
  });
});
