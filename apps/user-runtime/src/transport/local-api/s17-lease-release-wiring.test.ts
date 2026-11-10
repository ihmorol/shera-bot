/**
 * The D6 lease force-release COMPOSE wiring — the stress-scenario review
 * round's conditions C1, C2a, and C2b.
 *
 * The stress suites (tests/stress/gateway-concurrent-operations.test.ts,
 * tests/stress/cancellation-storm.test.ts) construct
 * RunFlowOperationsService directly and re-declare onRunExecutionEnded by
 * hand — they MIRROR the compose.ts wiring, they do not test it. These
 * suites drive runs to terminal states through the ACTUAL product
 * composition (composeRuntime — the same wire() main.ts composes) and pin
 * the release through the composed write-leases repository, observed on the
 * workspace HTTP surface (GET /v1/workspace/leases).
 *
 * C1: the harness composition's runFlow wiring (compose.ts, inside the
 *     workers system) fires releaseLeasesForTask when a COMMITTED transition
 *     ends the run's execution — a lease NEVER outlives its task (D6).
 *
 * Scope honesty (post C2a/C2b): the claim these suites pin is "every
 * terminal path that composes the flow-wired seam AND the two
 * formerly-bypassed paths" — the approvals-decision cancel (C2a) and the
 * no-harness composition the scheduler walk terminates runs through (C2b).
 *
 * Governing records: D6, D32, D8; E29 (the recorded gateway-wiring deferral
 * this closes); the stress-scenario review round on branch stress-wave-1.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "./compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const WS = DEFAULT_WORKSPACE_ID;
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

/**
 * The committed fake task worker child as the CONFIGURED harness command —
 * the production spawn adapter launches it exactly as it would launch a real
 * worker. This variant hangs right after ready (`hangAfterStep` 0): the run
 * stays RUNNING until the test's own terminal write, so the release the test
 * pins is the COMPOSE wiring's, never the worker's own done aftermath.
 */
const HANGING_WORKER_HARNESS = {
  file: process.execPath,
  args: [
    resolve(here, "../../modules/workers/fake-task-worker-child.ts"),
    "--run-id",
    "{run_id}",
    "--worker-id",
    "{worker_id}",
    "--heartbeat-ms",
    "{heartbeat_interval_ms}",
    "--hang-after-step",
    "0",
  ],
};

const runtimes: Array<RuntimeHandle> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
});

afterAll(async () => {
  await cleanupTempResources();
});

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

/** Acquire one agent-held task-scoped lease through the workspace HTTP surface. */
async function acquireLease(origin: string, path: string, taskId: string) {
  return postJson(origin, "/v1/workspace/leases", {
    workspace_id: WS,
    path,
    task_id: taskId,
    actor: { type: "agent", id: RESEARCHER },
    ttl_ms: 60_000,
  });
}

/** The workspace's ACTIVE leases as the API answers them (the D6 read). */
async function activeLeases(origin: string): Promise<Array<Record<string, unknown>>> {
  const listed = await getJson(origin, `/v1/workspace/leases?workspace_id=${WS}`);
  expect(listed.status).toBe(200);
  return (listed.body["leases"] ?? []) as Array<Record<string, unknown>>;
}

/**
 * Seed one task-scoped child run through the operations REPOSITORY on a
 * second connection (the S20 chunk-2 arrangement: harness runs live on the
 * journal, the approval cascade is task-scoped over operations.runs rows;
 * arrangement writes stay inside the repository — no SQL here).
 */
function seedChildRun(dbPath: string, parentTaskId: string, runId: string, state = "RUNNING") {
  const conn = openDatabase(dbPath);
  try {
    const row = {
      run_id: runId,
      workspace_id: WS,
      operation_id: "op_lease_wiring_children",
      parent_task_id: parentTaskId,
      state: state as "RUNNING",
      events_seq_cursor: 0,
      credits: {} as Record<string, unknown>,
      artifacts: [] as string[],
      created_at: clockNow,
      updated_at: clockNow,
    };
    new OperationsRepository(new SqliteTransactions(conn.db)).createRun(WS, row);
    return row;
  } finally {
    conn.close();
  }
}

/** Re-read one child run through the repository on a second connection. */
function readChildRun(dbPath: string, parentTaskId: string, runId: string) {
  const conn = openDatabase(dbPath);
  try {
    return new OperationsRepository(new SqliteTransactions(conn.db))
      .listRunsByParentTaskId(WS, parentTaskId)
      .find((row) => row.run_id === runId);
  } finally {
    conn.close();
  }
}

describe("C1 — the harness composition's task-finish seam releases the run's leases", () => {
  it("a run driven to FAILED through the composed runtime takes its write lease with it (D6)", async () => {
    const dbPath = join(makeTempDir("shera-s17-lease-wiring-"), "runtime.db");
    const runtime = composeRuntime({
      dbPath,
      packsRoot: PACKS_ROOT,
      workerHarness: HANGING_WORKER_HARNESS,
    });
    trackConnection(runtime);
    runtimes.push(runtime);
    await new Promise<void>((resolveListen) =>
      runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const origin = `http://127.0.0.1:${(runtime.httpServer.address() as { port: number }).port}`;

    // The run is created and driven through the composed operations seam —
    // the RunFlowOperationsService instance compose.ts wires, reached the
    // same way the product reaches it (the harness, the scheduler walk, and
    // the routes all hold this ONE instance).
    const operation = runtime.operations.createOperation(WS, {
      definition_ref: null,
      name: "S17 lease-wiring op",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: GENERAL,
    });
    const runId = "run_lease_wiring_c1";
    runtime.operations.createRun(WS, operation.operation_id, { run_id: runId });

    const lease = await acquireLease(origin, "workspace://docs/c1-release-wiring.md", runId);
    expect(lease.status).toBe(201);
    expect(await activeLeases(origin)).toHaveLength(1);

    runtime.operations.applyRunState(WS, operation.operation_id, runId, "QUEUED");
    // RUNNING spawns the hanging worker through the composed runFlow wiring
    // (fire-and-forget); the run stays RUNNING until the test's own write.
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "RUNNING");
    expect(runtime.operations.getRun(WS, operation.operation_id, runId).state).toBe("RUNNING");
    // The lease survives the non-terminal transitions — only execution's END
    // releases it.
    expect(await activeLeases(origin)).toHaveLength(1);

    // The terminal transition THROUGH the composition: the committed FAILED
    // state fires the wired onRunExecutionEnded → releaseLeasesForTask.
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "FAILED");
    expect(runtime.operations.getRun(WS, operation.operation_id, runId).state).toBe("FAILED");

    expect(await activeLeases(origin)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C2a — the approvals-decision cancel path (the formerly-bypassed seam #1)
// ---------------------------------------------------------------------------

/**
 * The gated scripted demo tool (runtime-owned typed definition, D38) — the
 * S20 arrangement: a RUNNING scripted run proposing it pauses
 * WAITING_FOR_APPROVAL and files the pending approval the cancel decision
 * needs.
 */
const GATED_TOOL = {
  agent_id: GENERAL,
  tool: {
    tool_id: "tool_repo_push",
    tool_version: "1.2.0",
    capability: "repo.push",
    risk_class: "EXTERNAL_WRITE",
    resource_scope: "workspace://notes/draft.md",
    side_effect_summary: "Pushes local commits to the configured remote repository.",
  },
  args_digest: `sha256:${"c".repeat(64)}`,
  proposal_summary: "Scripted demo proposal: push the drafted notes.",
} as const;

const clockNow = "2026-11-10T12:00:00.000Z";

/** A typed trigger (D34/G2) whose derived task id is unique per call. */
function scriptedTrigger(n: number): Record<string, unknown> {
  return {
    event_id: `evt_lease_wiring_trig_${n}`,
    stream_id: "conversation:conv_lease_wiring_001",
    sequence: 1,
    event_version: 1,
    actor: { type: "system", id: "scheduler" },
    task_id: `task_lease_wiring_${n}`,
    conversation_id: "conv_lease_wiring_001",
    occurred_at: clockNow,
    redaction_class: "internal",
    event_type: "trigger.scheduled",
    payload: { schedule_id: "sch_lease_wiring_001", due_at: clockNow },
  };
}

describe("C2a — an approval decision that cancels the task releases its leases", () => {
  it("cancel-the-task through the composed approvals boundary releases the parent run's lease AND each cancelled child's (D6)", async () => {
    const dbPath = join(makeTempDir("shera-s17-lease-wiring-"), "runtime.db");
    const runtime = composeRuntime({
      dbPath,
      packsRoot: PACKS_ROOT,
      now: () => clockNow,
      scriptedToolProposal: GATED_TOOL,
    });
    trackConnection(runtime);
    runtimes.push(runtime);
    await new Promise<void>((resolveListen) =>
      runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const origin = `http://127.0.0.1:${(runtime.httpServer.address() as { port: number }).port}`;

    // The scripted run pauses WAITING_FOR_APPROVAL with one pending request.
    const started = runtime.harness.startRun(
      scriptedTrigger(1) as unknown as Parameters<RuntimeHandle["harness"]["startRun"]>[0],
    );
    if (!started.ok) {
      throw new Error(`the scripted run refused to start: ${started.code}`);
    }
    const taskId = started.task_id;
    expect(started.state).toBe("WAITING_FOR_APPROVAL");
    const pending = (await getJson(origin, `/v1/approvals/pending?workspace_id=${WS}`)).body[
      "approvals"
    ] as Array<Record<string, unknown>>;
    expect(pending).toHaveLength(1);
    const approvalId = pending[0]!["approval_id"] as string;

    // One non-terminal child run (D34/D46 delegation link) — the cascade
    // approvals.service.ts writes CANCELLED through the raw repository
    // updateRunState, never through OperationsService.applyRunState.
    const childRunId = "run_lease_wiring_child";
    const child = seedChildRun(dbPath, taskId, childRunId);
    expect(child.state).toBe("RUNNING");

    // Both runs hold leases.
    await acquireLease(origin, "workspace://docs/c2a-parent.md", taskId);
    await acquireLease(origin, "workspace://docs/c2a-child.md", childRunId);
    expect(await activeLeases(origin)).toHaveLength(2);

    // The user cancels the task through the five-contract-choices decision
    // route — the ONLY effects path (applyDecision).
    const decision = await postJson(origin, `/v1/approvals/${approvalId}/decision`, {
      workspace_id: WS,
      choice: "cancel-the-task",
      decided_by: { type: "user", id: "user_owner" },
    });
    expect(decision.status).toBe(200);
    expect(decision.body["outcome"]).toBe("task_cancelled");
    expect(decision.body["cancelled_child_run_ids"]).toEqual([childRunId]);

    // The child row is durably CANCELLED (the cascade ran).
    expect(readChildRun(dbPath, taskId, childRunId)?.state).toBe("CANCELLED");

    // A lease NEVER outlives its task: BOTH the journalled parent cancel and
    // the raw-repository child writes release their leases at the same seam.
    expect(await activeLeases(origin)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C2b — the no-harness composition (the formerly-bypassed seam #2)
// ---------------------------------------------------------------------------

describe("C2b — the no-harness composition's terminal transitions release leases", () => {
  it("a run driven to a terminal state on a composition WITHOUT a worker harness takes its write lease with it (D6)", async () => {
    const dbPath = join(makeTempDir("shera-s17-lease-wiring-"), "runtime.db");
    // No workerHarness, no scripted proposals: the plain composition — the
    // shape whose writeLeases repository is composed unconditionally while
    // its operations service carried NO runFlow hook (compose.ts composes
    // the plain OperationsService when options.workerHarness is absent).
    // The scheduler walk terminates runs through THIS composition
    // (OperationsRunSeam(operations) → applyRunState, scheduler.service.ts
    // fail_task/complete_task), so a failed/completed scheduled run leaked
    // its lease.
    const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
    trackConnection(runtime);
    runtimes.push(runtime);
    await new Promise<void>((resolveListen) =>
      runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const origin = `http://127.0.0.1:${(runtime.httpServer.address() as { port: number }).port}`;

    const operation = runtime.operations.createOperation(WS, {
      definition_ref: null,
      name: "S17 lease-wiring no-harness op",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: GENERAL,
    });
    const runId = "run_lease_wiring_c2b";
    runtime.operations.createRun(WS, operation.operation_id, { run_id: runId });

    await acquireLease(origin, "workspace://docs/c2b-release-wiring.md", runId);
    expect(await activeLeases(origin)).toHaveLength(1);

    // The exact seam the scheduler walk drives: applyRunState on the
    // composed operations instance (OperationsRunSeam(operations) holds this
    // ONE instance — the walk's fail_task/complete_task land here).
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "QUEUED");
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "RUNNING");
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "FAILED");
    expect(runtime.operations.getRun(WS, operation.operation_id, runId).state).toBe("FAILED");

    // A lease NEVER outlives its task — on the no-harness composition too.
    expect(await activeLeases(origin)).toHaveLength(0);
  });
});
