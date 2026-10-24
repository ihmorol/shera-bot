/**
 * S13 chunk 3 — the Operation chat API: typed routes over the REAL composed
 * stack (real SQLite, real migrations, real HTTP), plus the thread read model
 * and @-addressing.
 *
 * Governing decisions: D41 (an Operation chat is a real conversation in the
 * chat taxonomy), D31 (the Operation holds multiple independently tracked
 * runs), D29 (creation-time pinning snapshot), D36 (user controls the roster;
 * the runtime validates against the pinned pack and persists refusals),
 * D42/D49 (coordinator set/"none" at ANY time; runs unaffected), D34/D46
 * (TaskDelegated creates EXACTLY ONE child run, idempotent on the event_id),
 * D7 (typed collaboration events with sender attribution), D26 (gapless
 * per-stream sequences; cursor reads), D23 rule 4 (typed failures only), E12
 * (every route is workspace-scoped).
 *
 * Addressing: a thread message that @-mentions roster Agents stores the
 * resolved recipient Agent ids; unaddressed messages are Operation-wide
 * ([]); an unresolvable mention keeps its literal text and resolves to [] —
 * the send NEVER fails on an unresolvable mention.
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

const displayNameOf = (agentId: string): string =>
  STUDENT_MANIFEST.agents.find((agent) => agent.agent_id === agentId)!.display_name;

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

function createOperationBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: WORKSPACE,
    definition_ref: null,
    name: "Research Paper",
    roster_agent_ids: [RESEARCHER, CITATION],
    coordinator_agent_id: GENERAL,
    ...extra,
  };
}

/** A valid operation.add_roster_agent envelope (RAW — the route parses it). */
function addRosterCommand(operationId: string, extra: Record<string, unknown> = {}) {
  return {
    command_id: "cmd_route_add_001",
    idempotency_key: "idem_route_add_001",
    workspace_id: WORKSPACE,
    operation_id: operationId,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-24T10:00:00.000Z",
    type: "operation.add_roster_agent",
    agent_id: DEVELOPER,
    pack_id: STUDENT_MANIFEST.pack_id,
    pack_version: STUDENT_MANIFEST.version,
    risk: { same_pack: true, cost_or_access_increasing: false, requires_approval: false },
    ...extra,
  };
}

/** A valid operation.remove_roster_agent envelope (RAW). */
function removeRosterCommand(operationId: string, extra: Record<string, unknown> = {}) {
  return {
    command_id: "cmd_route_remove_001",
    idempotency_key: "idem_route_remove_001",
    workspace_id: WORKSPACE,
    operation_id: operationId,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-10-24T10:00:00.000Z",
    type: "operation.remove_roster_agent",
    agent_id: RESEARCHER,
    ...extra,
  };
}

/** A D7 collaboration event envelope (RAW — the route validates the union). */
function collaborationEvent(operationId: string, extra: Record<string, unknown> = {}) {
  return {
    event_id: "evt_route_001",
    workspace_id: WORKSPACE,
    operation_id: operationId,
    run_id: null,
    sender_agent_id: GENERAL,
    recipient_agent_ids: [],
    correlation_id: "corr_route_001",
    issued_at: "2026-10-24T10:00:00.000Z",
    type: "ProgressReported",
    payload: { progress_text: "sources gathered" },
    ...extra,
  };
}

interface RunningWithOperation extends RunningRuntime {
  operationId: string;
}

/** Boot the stack AND create one Operation through the API (the common case). */
async function composeWithOperation(
  dbPath: string,
  createExtra: Record<string, unknown> = {},
): Promise<RunningWithOperation> {
  const running = await composeOn(dbPath);
  const created = await postJson(
    running.origin,
    "/v1/operations",
    createOperationBody(createExtra),
  );
  expect(created.status).toBe(201);
  return { ...running, operationId: created.body["operation_id"] as string };
}

function messageItems(thread: Record<string, unknown>): Array<Record<string, unknown>> {
  return (thread["items"] as Array<Record<string, unknown>>).filter(
    (item) => item["kind"] === "message",
  );
}

function collaborationItems(thread: Record<string, unknown>): Array<Record<string, unknown>> {
  return (thread["items"] as Array<Record<string, unknown>>).filter(
    (item) => item["kind"] === "collaboration_event",
  );
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S13 Operation API — create, list, detail (D31, D29, D36, D41)", () => {
  it("creates an Operation with the pinning snapshot and reads the detail back", async () => {
    const dir = makeTempDir("shera-runtime-s13-create-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    try {
      const detail = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}?workspace_id=${WORKSPACE}`,
      );
      expect(detail.status).toBe(200);
      const operation = detail.body["operation"] as Record<string, unknown>;
      expect(operation).toMatchObject({
        operation_id: running.operationId,
        workspace_id: WORKSPACE,
        definition_ref: null,
        name: "Research Paper",
        status: "active",
        coordinator_agent_id: GENERAL,
        pinning: {
          pack_id: STUDENT_MANIFEST.pack_id,
          pack_version: STUDENT_MANIFEST.version,
          // Membership is the roster table's order (added_at, agent_id) —
          // assert as a set, never an insertion order.
          roster_agent_ids: expect.arrayContaining([RESEARCHER, CITATION]),
          provider_snapshot: {},
        },
      });
      expect((operation["pinning"] as Record<string, unknown>)["capabilities"]).toEqual(
        expect.any(Array),
      );

      // The roster is queryable with its requires_approval flags and sender-
      // ready display names (resolved from the seeded Agent identities).
      const roster = detail.body["roster"] as Array<Record<string, unknown>>;
      expect(roster.map((member) => member["agent_id"]).sort()).toEqual(
        [RESEARCHER, CITATION].sort(),
      );
      for (const member of roster) {
        expect(member).toMatchObject({
          requires_approval: false,
          display_name: displayNameOf(member["agent_id"] as string),
        });
      }

      // Nothing has happened yet: no runs, no refusals, no thread access.
      expect(detail.body["runs"]).toEqual([]);
      expect(detail.body["recent_refusals"]).toEqual([]);
      // The chat binding is created LAZILY on first thread access, not here.
      expect(detail.body["chat_conversation_id"]).toBeNull();

      const list = await getJson(running.origin, `/v1/operations?workspace_id=${WORKSPACE}`);
      expect(list.status).toBe(200);
      expect(
        (list.body["operations"] as Array<Record<string, unknown>>).map(
          (operation) => operation["operation_id"],
        ),
      ).toEqual([running.operationId]);
    } finally {
      await running.close();
    }
  });

  it("answers typed failures for malformed creates: validation 400, refused roster 403, unknown coordinator 404", async () => {
    const dir = makeTempDir("shera-runtime-s13-create-failures-");
    const running = await composeOn(join(dir, "runtime.db"));
    try {
      const malformed = await postJson(
        running.origin,
        "/v1/operations",
        createOperationBody({ name: "" }),
      );
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });

      // An Agent no installed pack claims → the typed D36 refusal (403), and
      // NOTHING is persisted behind it.
      const ghost = await postJson(
        running.origin,
        "/v1/operations",
        createOperationBody({ roster_agent_ids: ["agent_ghost"] }),
      );
      expect(ghost.status).toBe(403);
      expect(ghost.body).toMatchObject({ code: "OPERATION_ROSTER_REFUSED", category: "policy" });

      const unknownCoordinator = await postJson(
        running.origin,
        "/v1/operations",
        createOperationBody({ coordinator_agent_id: "agent_nobody" }),
      );
      expect(unknownCoordinator.status).toBe(404);
      expect(unknownCoordinator.body).toMatchObject({ code: "OPERATION_COORDINATOR_NOT_FOUND" });

      const list = await getJson(running.origin, `/v1/operations?workspace_id=${WORKSPACE}`);
      expect(list.body["operations"]).toEqual([]);
    } finally {
      await running.close();
    }
  });
});

describe("S13 roster commands over HTTP (D36)", () => {
  it("applies a same-pack add, persists typed refusals for foreign-pack and cost-increasing adds, and removes", async () => {
    const dir = makeTempDir("shera-runtime-s13-roster-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const commandsPath = `/v1/operations/${running.operationId}/roster/commands`;
    try {
      // Same-pack low-risk add applies.
      const applied = await postJson(
        running.origin,
        commandsPath,
        addRosterCommand(running.operationId),
      );
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ outcome: "applied" });
      expect((applied.body["operation"] as Record<string, unknown>)["pinning"]).toMatchObject({
        roster_agent_ids: expect.arrayContaining([RESEARCHER, CITATION, DEVELOPER]),
      });

      // Foreign pack: the contract boundary refuses the envelope outright and
      // the runtime PERSISTS the refusal so the UI can show WHY (403-class).
      const foreign = await postJson(running.origin, commandsPath, {
        ...addRosterCommand(running.operationId, {
          command_id: "cmd_route_add_foreign",
          idempotency_key: "idem_route_add_foreign",
          agent_id: "agent_external_statistician",
          pack_id: "statistics-external",
        }),
        risk: { same_pack: false, cost_or_access_increasing: false, requires_approval: false },
      });
      expect(foreign.status).toBe(403);
      expect(foreign.body).toMatchObject({
        outcome: "refused",
        refusal: {
          refusal_code: "foreign-pack-refused",
          agent_id: "agent_external_statistician",
          pack_id: "statistics-external",
        },
      });

      // Cost-increasing without the required approval flag → typed refusal.
      const costly = await postJson(running.origin, commandsPath, {
        ...addRosterCommand(running.operationId, {
          command_id: "cmd_route_add_cost",
          idempotency_key: "idem_route_add_cost",
          agent_id: CITATION,
        }),
        risk: { same_pack: true, cost_or_access_increasing: true, requires_approval: false },
      });
      expect(costly.status).toBe(403);
      expect(costly.body).toMatchObject({
        outcome: "refused",
        refusal: { refusal_code: "cost-increase-needs-approval" },
      });

      // The refusals are PERSISTED: the detail's recent_refusals shows why.
      const detail = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}?workspace_id=${WORKSPACE}`,
      );
      const refusals = detail.body["recent_refusals"] as Array<Record<string, unknown>>;
      expect(refusals.map((refusal) => refusal["refusal_code"]).sort()).toEqual([
        "cost-increase-needs-approval",
        "foreign-pack-refused",
      ]);
      // The refused candidates never joined the roster.
      const roster = detail.body["roster"] as Array<Record<string, unknown>>;
      expect(roster.map((member) => member["agent_id"]).sort()).toEqual(
        [RESEARCHER, CITATION, DEVELOPER].sort(),
      );

      // Removal applies; the SAME command replayed returns the original
      // applied outcome through its receipt (D23 rule 6) — a committed
      // removal is never re-answered with a 404.
      const removed = await postJson(
        running.origin,
        commandsPath,
        removeRosterCommand(running.operationId),
      );
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({ outcome: "applied" });
      const replayed = await postJson(
        running.origin,
        commandsPath,
        removeRosterCommand(running.operationId),
      );
      expect(replayed.status).toBe(200);
      expect(replayed.body).toMatchObject({ outcome: "applied" });

      // A remove whose member is already gone is the idempotent no-op
      // (add/remove symmetry, D23 rule 6): applied with the CURRENT record —
      // never a replayed-remove 404.
      const missing = await postJson(
        running.origin,
        commandsPath,
        removeRosterCommand(running.operationId, {
          command_id: "cmd_route_remove_again",
          idempotency_key: "idem_route_remove_again",
        }),
      );
      expect(missing.status).toBe(200);
      expect(missing.body).toMatchObject({ outcome: "applied" });

      // Not a roster command at all → the contract's typed 400.
      const malformed = await postJson(running.origin, commandsPath, {
        ...addRosterCommand(running.operationId),
        type: "operation.promote_agent",
      });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
    } finally {
      await running.close();
    }
  });

  it("records the approval-declared flag on an applied cost-increasing add and exposes it on the detail read (D36/AC3)", async () => {
    const dir = makeTempDir("shera-runtime-s13-approval-flag-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const commandsPath = `/v1/operations/${running.operationId}/roster/commands`;
    try {
      // Cost-increasing WITH the approval flag declared: applied (the
      // approval-ARTIFACT gate is the approvals slice's; the flag recording
      // is this slice's contract).
      const applied = await postJson(running.origin, commandsPath, {
        ...addRosterCommand(running.operationId, {
          command_id: "cmd_route_add_approved",
          idempotency_key: "idem_route_add_approved",
          agent_id: DEVELOPER,
        }),
        risk: { same_pack: true, cost_or_access_increasing: true, requires_approval: true },
      });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ outcome: "applied" });

      // The detail read model exposes the flag on the roster member.
      const detail = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}?workspace_id=${WORKSPACE}`,
      );
      const member = (detail.body["roster"] as Array<Record<string, unknown>>).find(
        (row) => row["agent_id"] === DEVELOPER,
      );
      expect(member).toMatchObject({ requires_approval: true });
      // The other members carry no approval flag.
      const clean = (detail.body["roster"] as Array<Record<string, unknown>>).find(
        (row) => row["agent_id"] === RESEARCHER,
      );
      expect(clean).toMatchObject({ requires_approval: false });
    } finally {
      await running.close();
    }
  });
});

describe("S13 coordinator lifecycle over HTTP (D42/D49)", () => {
  it("sets and removes the coordinator mid-run; runs are untouched", async () => {
    const dir = makeTempDir("shera-runtime-s13-coordinator-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const coordinatorPath = `/v1/operations/${running.operationId}/coordinator`;
    try {
      const run = await postJson(running.origin, `/v1/operations/${running.operationId}/runs`, {
        workspace_id: WORKSPACE,
      });
      expect(run.status).toBe(201);
      const runId = (run.body as Record<string, unknown>)["run_id"] as string;

      const set = await postJson(running.origin, coordinatorPath, {
        workspace_id: WORKSPACE,
        coordinator_agent_id: DEVELOPER,
      });
      expect(set.status).toBe(200);
      expect((set.body as Record<string, unknown>)["coordinator_agent_id"]).toBe(DEVELOPER);

      // Removal ("none") at ANY time — including with a run in flight.
      const removed = await postJson(running.origin, coordinatorPath, {
        workspace_id: WORKSPACE,
        coordinator_agent_id: "none",
      });
      expect(removed.status).toBe(200);
      expect((removed.body as Record<string, unknown>)["coordinator_agent_id"]).toBe("none");

      // The in-flight run was never cancelled or paused by the removal.
      const runDetail = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/runs/${runId}?workspace_id=${WORKSPACE}`,
      );
      expect(runDetail.status).toBe(200);
      expect(runDetail.body).toMatchObject({ state: "CREATED" });

      // An unknown coordinator Agent is the typed 404-class.
      const unknown = await postJson(running.origin, coordinatorPath, {
        workspace_id: WORKSPACE,
        coordinator_agent_id: "agent_nobody",
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toMatchObject({ code: "OPERATION_COORDINATOR_NOT_FOUND" });
    } finally {
      await running.close();
    }
  });
});

describe("S13 runs over HTTP (D31/AC24, D8 vocabulary, D26 cursor)", () => {
  it("creates, lists, and details runs; unknown run is the typed 404", async () => {
    const dir = makeTempDir("shera-runtime-s13-runs-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    try {
      const first = await postJson(running.origin, `/v1/operations/${running.operationId}/runs`, {
        workspace_id: WORKSPACE,
      });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        workspace_id: WORKSPACE,
        operation_id: running.operationId,
        parent_task_id: null,
        state: "CREATED",
        events_seq_cursor: 0,
        credits: {},
        artifacts: [],
      });

      const named = await postJson(running.origin, `/v1/operations/${running.operationId}/runs`, {
        workspace_id: WORKSPACE,
        run_id: "run_named_001",
      });
      expect(named.status).toBe(201);
      expect((named.body as Record<string, unknown>)["run_id"]).toBe("run_named_001");

      const list = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/runs?workspace_id=${WORKSPACE}`,
      );
      expect(list.status).toBe(200);
      expect(list.body["runs"]).toHaveLength(2);

      const detail = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/runs/run_named_001?workspace_id=${WORKSPACE}`,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ run_id: "run_named_001", events_seq_cursor: 0 });

      const missing = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/runs/run_nobody?workspace_id=${WORKSPACE}`,
      );
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: "OPERATION_RUN_NOT_FOUND" });

      // Run ids may never take the reserved Operation-chat stream prefix.
      const reserved = await postJson(
        running.origin,
        `/v1/operations/${running.operationId}/runs`,
        {
          workspace_id: WORKSPACE,
          run_id: "operation:evil",
        },
      );
      expect(reserved.status).toBe(400);
      expect(reserved.body).toMatchObject({ code: "OPERATION_COMMAND_INVALID" });
    } finally {
      await running.close();
    }
  });
});

describe("S13 collaboration events over HTTP (D7/D26) and delegation (D34/D46)", () => {
  it("appends D7 events with gapless per-stream sequences and cursor reads", async () => {
    const dir = makeTempDir("shera-runtime-s13-events-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const eventsPath = `/v1/operations/${running.operationId}/events`;
    try {
      for (const [index, eventId] of ["evt_seq_1", "evt_seq_2", "evt_seq_3"].entries()) {
        const appended = await postJson(running.origin, eventsPath, {
          ...collaborationEvent(running.operationId, { event_id: eventId }),
        });
        expect(appended.status).toBe(201);
        expect(appended.body).toMatchObject({
          sequence: index + 1,
          stream_id: `operation:${running.operationId}`,
          event_id: eventId,
          created: true,
          type: "ProgressReported",
        });
      }

      // Replaying an appended event_id is an idempotent no-op (AC3).
      const replay = await postJson(running.origin, eventsPath, {
        ...collaborationEvent(running.operationId, { event_id: "evt_seq_1" }),
      });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ sequence: 1, created: false });

      const all = await getJson(running.origin, `${eventsPath}?workspace_id=${WORKSPACE}`);
      expect(all.status).toBe(200);
      expect(
        (all.body["events"] as Array<Record<string, unknown>>).map((event) => event["sequence"]),
      ).toEqual([1, 2, 3]);

      const tail = await getJson(
        running.origin,
        `${eventsPath}?workspace_id=${WORKSPACE}&after_sequence=2`,
      );
      expect(
        (tail.body["events"] as Array<Record<string, unknown>>).map((event) => event["sequence"]),
      ).toEqual([3]);

      // Not a D7 event → typed 400; a foreign operation_id in the body never
      // silently retargets the append.
      const malformed = await postJson(running.origin, eventsPath, {
        ...collaborationEvent(running.operationId, { event_id: "evt_bad", type: "TaskExploded" }),
      });
      expect(malformed.status).toBe(400);
      const mismatched = await postJson(running.origin, eventsPath, {
        ...collaborationEvent(running.operationId, {
          event_id: "evt_bad",
          operation_id: "op_other",
        }),
      });
      expect(mismatched.status).toBe(400);
    } finally {
      await running.close();
    }
  });

  it("renders appended D7 events in the thread as typed items with sender attribution", async () => {
    const dir = makeTempDir("shera-runtime-s13-thread-events-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    try {
      const appended = await postJson(
        running.origin,
        `/v1/operations/${running.operationId}/events`,
        {
          ...collaborationEvent(running.operationId, {
            event_id: "evt_thread_001",
            sender_agent_id: RESEARCHER,
          }),
        },
      );
      expect(appended.status).toBe(201);

      const thread = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/thread?workspace_id=${WORKSPACE}`,
      );
      expect(thread.status).toBe(200);
      const items = collaborationItems(thread.body);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "collaboration_event",
        sequence: 1,
        sender: {
          kind: "agent",
          agent_id: RESEARCHER,
          display_name: displayNameOf(RESEARCHER),
        },
      });
      expect(items[0]!["event"]).toMatchObject({
        type: "ProgressReported",
        sender_agent_id: RESEARCHER,
        payload: { progress_text: "sources gathered" },
      });
    } finally {
      await running.close();
    }
  });

  it("TaskDelegated creates EXACTLY ONE child run, idempotent on replay", async () => {
    const dir = makeTempDir("shera-runtime-s13-delegation-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const eventsPath = `/v1/operations/${running.operationId}/events`;
    try {
      const parent = await postJson(running.origin, `/v1/operations/${running.operationId}/runs`, {
        workspace_id: WORKSPACE,
        run_id: "run_parent_001",
      });
      expect(parent.status).toBe(201);

      const delegated = collaborationEvent(running.operationId, {
        event_id: "evt_delegate_001",
        run_id: "run_parent_001",
        sender_agent_id: RESEARCHER,
        type: "TaskDelegated",
        payload: { task_description: "gather the related-work section" },
      });
      const first = await postJson(running.origin, eventsPath, delegated);
      expect(first.status).toBe(201);
      const firstChildId = first.body["child_run_id"] as string;
      expect(typeof firstChildId).toBe("string");

      const runsAfterFirst = (
        await getJson(
          running.origin,
          `/v1/operations/${running.operationId}/runs?workspace_id=${WORKSPACE}`,
        )
      ).body["runs"] as Array<Record<string, unknown>>;
      const children = runsAfterFirst.filter((run) => run["parent_task_id"] === "run_parent_001");
      expect(children).toHaveLength(1);
      expect(children[0]!["run_id"]).toBe(firstChildId);
      expect(children[0]).toMatchObject({ state: "CREATED", operation_id: running.operationId });

      // Replay: the SAME event id delegates again — the original child run is
      // returned, still exactly one child.
      const replay = await postJson(running.origin, eventsPath, delegated);
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ created: false, child_run_id: firstChildId });

      const runsAfterReplay = (
        await getJson(
          running.origin,
          `/v1/operations/${running.operationId}/runs?workspace_id=${WORKSPACE}`,
        )
      ).body["runs"] as Array<Record<string, unknown>>;
      expect(
        runsAfterReplay.filter((run) => run["parent_task_id"] === "run_parent_001"),
      ).toHaveLength(1);

      // A TaskDelegated without the parent link is the typed 400.
      const orphan = await postJson(running.origin, eventsPath, {
        ...delegated,
        event_id: "evt_delegate_orphan",
        run_id: null,
      });
      expect(orphan.status).toBe(400);
      expect(orphan.body).toMatchObject({ code: "OPERATION_EVENT_INVALID" });
    } finally {
      await running.close();
    }
  });
});

describe("S13 operation thread read model + @-addressing (D41, D7)", () => {
  it("sends @-addressed, unaddressed, and unresolvable messages; thread renders addressed_to", async () => {
    const dir = makeTempDir("shera-runtime-s13-addressing-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const sendPath = `/v1/operations/${running.operationId}/thread/messages`;
    const send = (idempotencyKey: string, text: string) =>
      postJson(running.origin, sendPath, {
        workspace_id: WORKSPACE,
        idempotency_key: idempotencyKey,
        sender: { kind: "user", display_name: "Emon" },
        text,
      });

    try {
      const addressed = await send("idem_msg_addr_001", "@agent_researcher please gather sources");
      expect(addressed.status).toBe(201);
      expect(addressed.body).toMatchObject({
        kind: "message_sent",
        addressed_to: [RESEARCHER],
        created: true,
      });
      const conversationId = addressed.body["conversation_id"] as string;

      const unaddressed = await send("idem_msg_addr_002", "status update for everyone");
      expect(unaddressed.status).toBe(201);
      expect(unaddressed.body).toMatchObject({ addressed_to: [] });

      // An unresolvable mention keeps its literal text and resolves to [] —
      // the send NEVER fails on it.
      const unresolvable = await send("idem_msg_addr_003", "@nobody_here ping");
      expect(unresolvable.status).toBe(201);
      expect(unresolvable.body).toMatchObject({ addressed_to: [] });

      const multi = await send(
        "idem_msg_addr_004",
        "@agent_citation_manager and @agent_researcher please review",
      );
      expect(multi.body).toMatchObject({ addressed_to: [CITATION, RESEARCHER] });

      // One idempotency key → one message, forever (D23 rule 6).
      const replay = await send("idem_msg_addr_002", "status update for everyone");
      expect(replay.body).toMatchObject({
        message_id: unaddressed.body["message_id"],
        created: false,
      });

      const thread = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/thread?workspace_id=${WORKSPACE}`,
      );
      expect(thread.status).toBe(200);
      expect(thread.body["chat_conversation_id"]).toBe(conversationId);
      const messages = messageItems(thread.body);
      expect(messages).toHaveLength(4);
      expect(messages.map((item) => item["text"])).toEqual([
        "@agent_researcher please gather sources",
        "status update for everyone",
        "@nobody_here ping",
        "@agent_citation_manager and @agent_researcher please review",
      ]);
      expect(messages[0]).toMatchObject({
        kind: "message",
        addressed_to: [RESEARCHER],
        sender: { kind: "user", display_name: "Emon" },
      });
      expect(messages[1]).toMatchObject({ addressed_to: [] });
      expect(messages[2]).toMatchObject({ addressed_to: [] });
      expect(messages[3]).toMatchObject({ addressed_to: [CITATION, RESEARCHER] });

      // The `after` cursor pages the message leg (journal sequence cursor).
      const cursor = messages[1]!["sequence"] as number;
      const paged = await getJson(
        running.origin,
        `/v1/operations/${running.operationId}/thread?workspace_id=${WORKSPACE}&after=${cursor}`,
      );
      expect(messageItems(paged.body).map((item) => item["message_id"])).toEqual(
        messages.slice(2).map((item) => item["message_id"]),
      );

      // The binding get-or-create journaled the conversation like every chat.
      const events = await getJson(
        running.origin,
        `/v1/conversations/${conversationId}/events?workspace_id=${WORKSPACE}&last_acknowledged_sequence=0`,
      );
      expect(events.status).toBe(200);
      const created = (events.body["events"] as Array<{ type: string }>).filter(
        (event) => event.type === "conversation.created",
      );
      expect(created).toHaveLength(1);
    } finally {
      await running.close();
    }
  });

  it("get-or-create binds exactly one conversation per workspace+operation (journaled, race-safe)", async () => {
    const dir = makeTempDir("shera-runtime-s13-binding-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    try {
      const first = running.runtime.operations.getOrCreateChat(WORKSPACE, running.operationId);
      expect(first.created).toBe(true);
      const second = running.runtime.operations.getOrCreateChat(WORKSPACE, running.operationId);
      expect(second.created).toBe(false);
      expect(second.conversation_id).toBe(first.conversation_id);

      // The creation is journaled like every other conversation creation.
      const events = await getJson(
        running.origin,
        `/v1/conversations/${first.conversation_id}/events?workspace_id=${WORKSPACE}&last_acknowledged_sequence=0`,
      );
      expect(events.status).toBe(200);
      const created = (
        events.body["events"] as Array<{ type: string; payload: Record<string, unknown> }>
      ).filter((event) => event.type === "conversation.created");
      expect(created).toHaveLength(1);
      expect(created[0]!.payload).toMatchObject({
        conversation_id: first.conversation_id,
        workspace_id: WORKSPACE,
        title: "Research Paper",
      });
    } finally {
      await running.close();
    }
  });
});

describe("S13 AC8 — the chat stays usable after runs complete", () => {
  it("accepts a follow-up message and a NEW run after a run reaches a terminal state", async () => {
    const dir = makeTempDir("shera-runtime-s13-ac8-after-run-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    const opId = running.operationId;
    try {
      const run = await postJson(running.origin, `/v1/operations/${opId}/runs`, {
        workspace_id: WORKSPACE,
      });
      expect(run.status).toBe(201);
      const runId = run.body["run_id"] as string;

      // Drive the run to a terminal state through the composed runtime's
      // service seam (in-process: applyRunState validates the D8 vocabulary;
      // transition LEGALITY is the runtime gateway's job, and no HTTP route
      // exposes state writes in this slice).
      const finished = running.runtime.operations.applyRunState(
        WORKSPACE,
        opId,
        runId,
        "SUCCEEDED",
      );
      expect(finished.state).toBe("SUCCEEDED");

      // The thread accepts a follow-up message AFTER the run is terminal.
      const sent = await postJson(running.origin, `/v1/operations/${opId}/thread/messages`, {
        workspace_id: WORKSPACE,
        idempotency_key: "idem_ac8_after_terminal_1",
        sender: { kind: "user", display_name: "Emon" },
        text: "the run finished — @agent_researcher please summarize",
      });
      expect(sent.status).toBe(201);
      expect(sent.body).toMatchObject({
        kind: "message_sent",
        addressed_to: [RESEARCHER],
        created: true,
      });

      // A NEW run can be created afterwards.
      const next = await postJson(running.origin, `/v1/operations/${opId}/runs`, {
        workspace_id: WORKSPACE,
        run_id: "run_ac8_followup",
      });
      expect(next.status).toBe(201);
      expect(next.body).toMatchObject({ run_id: "run_ac8_followup", state: "CREATED" });

      // Both appear: the thread renders the follow-up message and the runs
      // list shows the terminal run BESIDE the new one.
      const thread = await getJson(
        running.origin,
        `/v1/operations/${opId}/thread?workspace_id=${WORKSPACE}`,
      );
      expect(thread.status).toBe(200);
      expect(messageItems(thread.body).map((item) => item["text"])).toEqual([
        "the run finished — @agent_researcher please summarize",
      ]);
      const runs = await getJson(
        running.origin,
        `/v1/operations/${opId}/runs?workspace_id=${WORKSPACE}`,
      );
      expect(runs.status).toBe(200);
      const stateById = new Map(
        (runs.body["runs"] as Array<Record<string, unknown>>).map((row) => [
          row["run_id"],
          row["state"],
        ]),
      );
      expect(stateById.get(runId)).toBe("SUCCEEDED");
      expect(stateById.get("run_ac8_followup")).toBe("CREATED");
    } finally {
      await running.close();
    }
  });
});

describe("S13 typed failures + workspace scoping (E12)", () => {
  it("unknown operation → typed 404 on every route; foreign workspaces cannot reach it", async () => {
    const dir = makeTempDir("shera-runtime-s13-scoping-");
    const running = await composeWithOperation(join(dir, "runtime.db"));
    try {
      const paths = [
        `/v1/operations/op_nobody?workspace_id=${WORKSPACE}`,
        `/v1/operations/op_nobody/runs?workspace_id=${WORKSPACE}`,
        `/v1/operations/op_nobody/runs/run_x?workspace_id=${WORKSPACE}`,
        `/v1/operations/op_nobody/events?workspace_id=${WORKSPACE}`,
        `/v1/operations/op_nobody/thread?workspace_id=${WORKSPACE}`,
        `/v1/operations/op_nobody?workspace_id=ws-s13-foreign`,
      ];
      for (const path of paths) {
        const response = await getJson(running.origin, path);
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: "OPERATION_NOT_FOUND" });
      }

      const foreignPost = await postJson(running.origin, "/v1/operations/op_nobody/events", {
        ...collaborationEvent("op_nobody"),
      });
      expect(foreignPost.status).toBe(404);
      expect(foreignPost.body).toMatchObject({ code: "OPERATION_NOT_FOUND" });

      // A roster command naming a foreign workspace can never reach this
      // workspace's Operation (E12 — the envelope's workspace scopes it).
      const foreignCommand = await postJson(
        running.origin,
        `/v1/operations/${running.operationId}/roster/commands`,
        addRosterCommand(running.operationId, { workspace_id: "ws-s13-foreign" }),
      );
      expect(foreignCommand.status).toBe(404);
      expect(foreignCommand.body).toMatchObject({ code: "OPERATION_NOT_FOUND" });

      const foreignList = await getJson(
        running.origin,
        "/v1/operations?workspace_id=ws-s13-foreign",
      );
      expect(foreignList.status).toBe(200);
      expect(foreignList.body["operations"]).toEqual([]);
    } finally {
      await running.close();
    }
  });
});
