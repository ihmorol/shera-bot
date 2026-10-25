/**
 * S14 chunk 1 — ad-hoc Operation creation, auto-label, rename, zero-Agent
 * refusal, and the shared-machinery acceptance walk: typed routes over the
 * REAL composed stack (real SQLite, real migrations, real HTTP), mirroring
 * s13-operations-api.test.ts.
 *
 * Governing decisions: D41 (ad-hoc Operations: same rules as pack-defined,
 * no reusable definition behind them), D36 (runtime-validated roster), D42/
 * D49 (coordinator set/"none" at ANY time), D23 rule 6 (idempotent rename
 * replay answers the record), D23 rule 4 (typed failures only), E12
 * (workspace scoping), PRD §4.1/§4.2 AC5 (ad-hoc Operations obey the same
 * machinery — one composite walk proves no parallel implementation).
 *
 * Auto-label: a nameless ad-hoc create names itself `Ad-hoc · N Agents`
 * (N = roster size); an explicit name is respected; a pack-defined create
 * REQUIRES a name (typed OPERATION_NAME_REQUIRED). A rename is a durable row
 * update — the Operation record has no event stream of its own to journal to.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(resolve(PACKS_ROOT, "student/v1/manifest.json"), "utf8"),
) as {
  pack_id: string;
  version: string;
  agents: Array<{ agent_id: string; display_name: string }>;
};

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";
const CITATION = "agent_citation_manager";
const DEVELOPER = "agent_developer";
const PACK_DEFINITION_REF = "agent-packs/student/v1/operations/research-paper@1.0.0";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeOn(dbPath: string, workspaceId: string = WORKSPACE): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT, workspaceId });
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

/** An ad-hoc create body WITHOUT a name — the server auto-labels it (D41). */
function adhocCreateBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: WORKSPACE,
    definition_ref: null,
    roster_agent_ids: [RESEARCHER, CITATION, DEVELOPER],
    coordinator_agent_id: GENERAL,
    ...extra,
  };
}

/** A valid operation.rename_operation envelope (RAW — the route parses it). */
function renameCommand(operationId: string, extra: Record<string, unknown> = {}) {
  return {
    command_id: "cmd_s14_rename_001",
    idempotency_key: "idem_s14_rename_001",
    workspace_id: WORKSPACE,
    operation_id: operationId,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-24T12:00:00.000Z",
    type: "operation.rename_operation",
    name: "Weekly Review",
    ...extra,
  };
}

interface RunningWithOperation extends RunningRuntime {
  operationId: string;
}

/** Boot the stack AND create one named ad-hoc Operation through the API. */
async function composeWithNamedOperation(dbPath: string): Promise<RunningWithOperation> {
  const running = await composeOn(dbPath);
  const created = await postJson(running.origin, "/v1/operations", {
    ...adhocCreateBody(),
    name: "Named Ad-hoc",
  });
  expect(created.status).toBe(201);
  return { ...running, operationId: created.body["operation_id"] as string };
}

function listRows(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body["operations"] as Array<Record<string, unknown>>;
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S14 auto-label + ad-hoc read models (D41)", () => {
  it("auto-labels a nameless ad-hoc Operation from the roster size and marks is_adhoc/auto_label", async () => {
    const dir = makeTempDir("shera-runtime-s14-autolabel-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const created = await postJson(running.origin, "/v1/operations", adhocCreateBody());
      expect(created.status).toBe(201);
      const operationId = created.body["operation_id"] as string;
      expect(created.body["name"]).toBe("Ad-hoc · 3 Agents");
      expect(created.body["definition_ref"]).toBeNull();

      // The detail read model marks the derivation.
      const detail = await getJson(
        running.origin,
        `/v1/operations/${operationId}?workspace_id=${WORKSPACE}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ is_adhoc: true, auto_label: true });

      // The list read model carries the SAME derived fields per row.
      const list = await getJson(running.origin, `/v1/operations?workspace_id=${WORKSPACE}`);
      expect(list.status).toBe(200);
      const row = listRows(list.body).find((item) => item["operation_id"] === operationId);
      expect(row).toMatchObject({
        name: "Ad-hoc · 3 Agents",
        is_adhoc: true,
        auto_label: true,
      });
    } finally {
      await running.close();
    }
  });

  it("respects an explicit ad-hoc name (auto_label false, is_adhoc true)", async () => {
    const dir = makeTempDir("shera-runtime-s14-explicit-name-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const created = await postJson(running.origin, "/v1/operations", {
        ...adhocCreateBody(),
        name: "My Custom Op",
      });
      expect(created.status).toBe(201);
      expect(created.body["name"]).toBe("My Custom Op");

      const detail = await getJson(
        running.origin,
        `/v1/operations/${created.body["operation_id"] as string}?workspace_id=${WORKSPACE}`,
      );
      expect(detail.body).toMatchObject({ is_adhoc: true, auto_label: false });
    } finally {
      await running.close();
    }
  });

  it("keeps pack-defined creation named (S13 regression) and refuses a nameless pack-defined create", async () => {
    const dir = makeTempDir("shera-runtime-s14-pack-defined-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      // Regression from S13: definition_ref + name still creates.
      const created = await postJson(running.origin, "/v1/operations", {
        ...adhocCreateBody(),
        definition_ref: PACK_DEFINITION_REF,
        name: "Research Paper",
      });
      expect(created.status).toBe(201);
      const packDefinedId = created.body["operation_id"] as string;
      const detail = await getJson(
        running.origin,
        `/v1/operations/${packDefinedId}?workspace_id=${WORKSPACE}`,
      );
      expect(detail.body).toMatchObject({
        is_adhoc: false,
        auto_label: false,
      });

      // A pack-defined create with NO name is typed-rejected — the server
      // never auto-labels a defined Operation.
      const nameless = await postJson(running.origin, "/v1/operations", {
        ...adhocCreateBody(),
        definition_ref: PACK_DEFINITION_REF,
      });
      expect(nameless.status).toBe(400);
      expect(nameless.body).toMatchObject({ code: "OPERATION_NAME_REQUIRED" });
    } finally {
      await running.close();
    }
  });
});

describe("S14 zero-Agent refusal (D41: ad-hoc obeys the same rules)", () => {
  it("refuses an empty roster over HTTP with a typed 400 and persists nothing", async () => {
    const dir = makeTempDir("shera-runtime-s14-zero-agent-http-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const refused = await postJson(running.origin, "/v1/operations", {
        ...adhocCreateBody(),
        roster_agent_ids: [],
        name: "Nobody Home",
      });
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ code: "OPERATION_ROSTER_EMPTY" });
      expect(String(refused.body["safe_message"])).toMatch(/at least one Agent/i);

      const list = await getJson(running.origin, `/v1/operations?workspace_id=${WORKSPACE}`);
      expect(listRows(list.body)).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it("refuses an empty roster at the service seam with the same typed code", async () => {
    const dir = makeTempDir("shera-runtime-s14-zero-agent-service-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      try {
        running.runtime.operations.createOperation(WORKSPACE, {
          definition_ref: null,
          name: "Nobody Home",
          roster_agent_ids: [],
          coordinator_agent_id: GENERAL,
        });
        throw new Error("expected the empty roster to be refused");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("OPERATION_ROSTER_EMPTY");
      }

      // The service-side twin of the pack-defined rule: an empty name on a
      // defined Operation is OPERATION_NAME_REQUIRED there too.
      try {
        running.runtime.operations.createOperation(WORKSPACE, {
          definition_ref: PACK_DEFINITION_REF,
          name: "   ",
          roster_agent_ids: [RESEARCHER],
          coordinator_agent_id: GENERAL,
        });
        throw new Error("expected the nameless pack-defined create to be refused");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("OPERATION_NAME_REQUIRED");
      }
    } finally {
      await running.close();
    }
  });
});

describe("S14 rename (D23 rule 6 — idempotent replay answers the record)", () => {
  it("renames, persists, replays idempotently, and answers typed failures", async () => {
    const dir = makeTempDir("shera-runtime-s14-rename-");
    const running = await composeWithNamedOperation(join(dir, "runtime.db"));
    const renamePath = `/v1/operations/${running.operationId}/rename`;
    try {
      const renamed = await postJson(
        running.origin,
        renamePath,
        renameCommand(running.operationId),
      );
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        operation_id: running.operationId,
        name: "Weekly Review",
      });

      // The rename is a durable row update: the detail read shows it.
      const detail = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}?workspace_id=${WORKSPACE}`,
      );
      expect((detail.body["operation"] as Record<string, unknown>)["name"]).toBe("Weekly Review");
      // A rename away from the auto-label pattern clears the derived flag.
      expect(detail.body).toMatchObject({ is_adhoc: true, auto_label: false });

      // The SAME envelope replayed returns the record (D23 rule 6) — never a
      // duplicated effect, never a 404 for an applied rename.
      const replay = await postJson(running.origin, renamePath, renameCommand(running.operationId));
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        operation_id: running.operationId,
        name: "Weekly Review",
      });

      // Unknown operation → typed 404.
      const missing = await postJson(running.origin, "/v1/operations/op_nobody/rename", {
        ...renameCommand("op_nobody"),
        command_id: "cmd_s14_rename_404",
        idempotency_key: "idem_s14_rename_404",
      });
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: "OPERATION_NOT_FOUND" });

      // Validation: empty, whitespace-only, and too-long (>120) names are the
      // typed 400; the envelope's operation_id must agree with the path.
      for (const badName of ["", "   ", "x".repeat(121)]) {
        const invalid = await postJson(running.origin, renamePath, {
          ...renameCommand(running.operationId, { name: badName }),
        });
        expect(invalid.status, `name ${JSON.stringify(badName.slice(0, 8))}… must be refused`).toBe(
          400,
        );
        expect(invalid.body).toMatchObject({ code: "OPERATION_COMMAND_INVALID" });
      }
      const mismatched = await postJson(running.origin, renamePath, {
        ...renameCommand(running.operationId),
        operation_id: "op_other",
      });
      expect(mismatched.status).toBe(400);
      expect(mismatched.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
    } finally {
      await running.close();
    }
  });
});

describe("S14 shared machinery (PRD §4.1/§4.2 AC5) — ad-hoc reuses the SAME code paths", () => {
  it("walks roster add/remove, coordinator set/remove, run creation, and an @-addressed message on one ad-hoc Operation", async () => {
    const dir = makeTempDir("shera-runtime-s14-shared-machinery-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      // 1. Ad-hoc create, auto-labeled (the S14 creation path — everything
      //    after goes through the SAME routes/service methods the pack-defined
      //    S13 tests use).
      const created = await postJson(running.origin, "/v1/operations", adhocCreateBody());
      expect(created.status).toBe(201);
      const operationId = created.body["operation_id"] as string;
      expect(created.body["name"]).toBe("Ad-hoc · 3 Agents");

      // 2. Roster add/remove through the D36 command route (same envelope the
      //    pack-defined flow sends).
      const commandsPath = `/v1/operations/${operationId}/roster/commands`;
      const added = await postJson(running.origin, commandsPath, {
        command_id: "cmd_s14_shared_add",
        idempotency_key: "idem_s14_shared_add",
        workspace_id: WORKSPACE,
        operation_id: operationId,
        actor: { type: "user", id: "user_emon" },
        issued_at: "2026-10-24T12:00:00.000Z",
        type: "operation.add_roster_agent",
        agent_id: GENERAL,
        pack_id: STUDENT_MANIFEST.pack_id,
        pack_version: STUDENT_MANIFEST.version,
        risk: { same_pack: true, cost_or_access_increasing: false, requires_approval: false },
      });
      expect(added.status).toBe(200);
      expect(added.body).toMatchObject({ outcome: "applied" });

      const removed = await postJson(running.origin, commandsPath, {
        command_id: "cmd_s14_shared_remove",
        idempotency_key: "idem_s14_shared_remove",
        workspace_id: WORKSPACE,
        operation_id: operationId,
        actor: { type: "user", id: "user_emon" },
        issued_at: "2026-10-24T12:00:00.000Z",
        type: "operation.remove_roster_agent",
        agent_id: CITATION,
      });
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ outcome: "applied" });

      // 3. Coordinator lifecycle (D42/D49): set an Agent, then remove to
      //    "none" — the run-less Operation continues peer-to-peer.
      const coordinatorPath = `/v1/operations/${operationId}/coordinator`;
      const setCoordinator = await postJson(running.origin, coordinatorPath, {
        workspace_id: WORKSPACE,
        coordinator_agent_id: DEVELOPER,
      });
      expect(setCoordinator.status).toBe(200);
      expect((setCoordinator.body as Record<string, unknown>)["coordinator_agent_id"]).toBe(
        DEVELOPER,
      );
      const removeCoordinator = await postJson(running.origin, coordinatorPath, {
        workspace_id: WORKSPACE,
        coordinator_agent_id: "none",
      });
      expect(removeCoordinator.status).toBe(200);
      expect((removeCoordinator.body as Record<string, unknown>)["coordinator_agent_id"]).toBe(
        "none",
      );

      // 4. Run creation through the same typed-creation route.
      const run = await postJson(running.origin, `/v1/operations/${operationId}/runs`, {
        workspace_id: WORKSPACE,
      });
      expect(run.status).toBe(201);
      expect(run.body).toMatchObject({ operation_id: operationId, state: "CREATED" });

      // 5. An @-addressed thread message resolves against the CURRENT roster
      //    (Citation was removed; the mention resolves to Developer only).
      const sent = await postJson(running.origin, `/v1/operations/${operationId}/thread/messages`, {
        workspace_id: WORKSPACE,
        idempotency_key: "idem_s14_shared_msg_001",
        sender: { kind: "user", display_name: "Emon" },
        text: "@agent_developer please start the outline",
      });
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({ kind: "message_sent", addressed_to: [DEVELOPER] });

      // 6. The detail read model reflects every mutation on the SAME record.
      const detail = await getJson(
        running.origin,
        `/v1/operations/${operationId}?workspace_id=${WORKSPACE}`,
      );
      expect(detail.body).toMatchObject({ is_adhoc: true });
      expect(
        (detail.body["roster"] as Array<Record<string, unknown>>)
          .map((member) => member["agent_id"])
          .sort(),
      ).toEqual([DEVELOPER, GENERAL, RESEARCHER].sort());
      expect((detail.body["operation"] as Record<string, unknown>)["coordinator_agent_id"]).toBe(
        "none",
      );
      expect(detail.body["runs"]).toHaveLength(1);

      const thread = await getJson(
        running.origin,
        `/v1/operations/${operationId}/thread?workspace_id=${WORKSPACE}`,
      );
      expect(thread.status).toBe(200);
      const messages = (thread.body["items"] as Array<Record<string, unknown>>).filter(
        (item) => item["kind"] === "message",
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ addressed_to: [DEVELOPER] });
    } finally {
      await running.close();
    }
  });
});
