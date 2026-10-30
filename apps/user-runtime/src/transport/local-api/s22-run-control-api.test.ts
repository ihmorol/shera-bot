/**
 * S22 run-control API tests — the composition-level suite over the REAL
 * stack (real SQLite, real HTTP, real worker processes through the
 * production spawn adapter).
 *
 * Pinned here (the slice's merge bar):
 *  - AC15 end to end: a RUNNING run's worker spawns a descendant; the POST
 *    cancel route stops the WHOLE tree (no descendant survives a real
 *    process probe), the run reaches CANCELLED, and the worker row is killed;
 *  - AC7: a second cancel is a 200 already_cancelled (never an error); a
 *    cancel racing a completed run answers already_settled deterministically;
 *  - AC5: a queued child never starts — the parent's cancel cancels it;
 *  - AC3: GET events exposes the run's journal (the TRUE attempt-count
 *    source — the task.retry_scheduled envelopes carry the attempt numbers);
 *  - AC14 at composition level: a worker-reported transient failure walks
 *    the bounded retry walk (fast backoff policy override) and lands PAUSED
 *    with the retry_exhausted reason;
 *  - AC10: an ambiguous failure class lands RECOVERY_REQUIRED with the
 *    decision recorded on the stream.
 *
 * Governing records: PRD §8, D8, D9, D20, D27, D32, E13; the slice ACs.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";
import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import type { TaskWorkerSupervisorPolicy } from "../../modules/workers/task-worker-supervisor.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const RESEARCHER = "agent_researcher";
const CITATION = "agent_citation_manager";
const GENERAL = "agent_general_assistant";

const MS_POLICY: Partial<TaskWorkerSupervisorPolicy> = {
  heartbeatIntervalMs: 40,
  missedHeartbeatLimit: 25,
  leaseWindowMs: 150,
  handshakeTimeoutMs: 4_000,
  shutdownGraceMs: 200,
  killGraceMs: 200,
};

/** The S22 fast retry walk (real timers, bounded): 30ms between attempts. */
const FAST_RETRY_POLICY = { maxAttempts: 3, backoffScheduleMs: [30, 30, 30] } as const;

function workerHarness(extraArgs: string[] = []) {
  return {
    file: process.execPath,
    args: [
      resolve(here, "../../modules/workers/fake-task-worker-child.ts"),
      "--run-id",
      "{run_id}",
      "--worker-id",
      "{worker_id}",
      "--heartbeat-ms",
      "{heartbeat_interval_ms}",
      "--steps",
      "500",
      "--step-delay-ms",
      "40",
      ...extraArgs,
    ],
  };
}

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close: () => void;
}

const runtimes: RunningRuntime[] = [];

async function composeOn(dbPath: string, harness: ReturnType<typeof workerHarness>): Promise<RunningRuntime> {
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    workerHarness: harness,
    workerPolicy: MS_POLICY,
    retryPolicy: FAST_RETRY_POLICY,
  });
  const handle: RunningRuntime = {
    runtime,
    origin: "",
    dbPath,
    close: () => runtime.close(),
  };
  runtimes.push(handle);
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  handle.origin = `http://127.0.0.1:${address.port}`;
  return handle;
}

afterAll(() => {
  cleanupTempResources();
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

async function until<T>(
  read: () => T | undefined | null | Promise<T | undefined | null>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createOperationAndRun(
  origin: string,
  runId: string,
  parentTaskId?: string,
): Promise<{ operationId: string; runId: string }> {
  const created = await postJson(origin, "/v1/operations", {
    workspace_id: WORKSPACE,
    definition_ref: null,
    name: `S22 Op ${runId}`,
    roster_agent_ids: [RESEARCHER, CITATION],
    coordinator_agent_id: GENERAL,
  });
  expect(created.status).toBe(201);
  const operationId = (created.body as { operation_id: string }).operation_id;
  const run = await postJson(origin, `/v1/operations/${operationId}/runs`, {
    workspace_id: WORKSPACE,
    run_id: runId,
    ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
  });
  expect(run.status).toBe(201);
  return { operationId, runId };
}

async function runStateOf(origin: string, operationId: string, runId: string): Promise<string> {
  const detail = await getJson(
    origin,
    `/v1/operations/${operationId}/runs/${runId}?workspace_id=${WORKSPACE}`,
  );
  expect(detail.status).toBe(200);
  return detail.body["state"] as string;
}

interface JournalRow {
  type: string;
  payload: Record<string, unknown>;
}

function readRunJournal(dbPath: string, runId: string): JournalRow[] {
  const conn = openDatabase(dbPath);
  try {
    const rows: JournalRow[] = [];
    for (const stream of [runId, `task:${runId}`]) {
      const result = conn.db
        .prepare(
          `SELECT event_type, payload FROM event_journal
           WHERE workspace_id = ? AND stream_id = ? ORDER BY sequence`,
        )
        .all(WORKSPACE, stream) as Array<{ event_type: string; payload: string }>;
      for (const row of result) {
        rows.push({ type: row.event_type, payload: JSON.parse(row.payload) });
      }
    }
    return rows;
  } finally {
    conn.close();
  }
}

const ACTOR = { type: "user" as const, id: "user_owner" };

describe("S22 run-control API — cancellation over the real stack (AC15, AC7, AC5)", () => {
  it("POST cancel stops the whole process tree, lands CANCELLED, and preserves the outputs", async () => {
    const markerPath = join(makeTempDir("shera-s22-api-tree-"), "descendant.pid");
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-cancel-"), "runtime.db"),
      workerHarness(["--spawn-descendant", "--descendant-marker-file", markerPath]),
    );
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run_s22_tree");
    // Preserve an artifact BEFORE the cancel (AC6's partial output).
    runtime.runtime.operations.publishRunArtifact(WORKSPACE, operationId, runId, "artifact_partial");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");

    const descendantPid = await until(() => {
      if (!existsSync(markerPath)) return null;
      const pid = Number(readFileSync(markerPath, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
    });

    const cancel = await postJson(
      runtime.origin,
      `/v1/operations/${operationId}/runs/${runId}/cancel`,
      { workspace_id: WORKSPACE, cancelled_by: ACTOR },
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body["outcome"]).toBe("cancelled");
    expect(cancel.body["state"]).toBe("CANCELLED");
    expect((cancel.body["preserved"] as { artifact_ids: string[] }).artifact_ids).toEqual([
      "artifact_partial",
    ]);

    // AC15's bar: NO descendant process survives (a real process probe).
    await until(() => (isAlive(descendantPid) ? null : true));
    // The run is CANCELLED and stays there.
    expect(await runStateOf(runtime.origin, operationId, runId)).toBe("CANCELLED");

    // AC7: the replayed cancel is a 200 no-op, not an error.
    const replay = await postJson(
      runtime.origin,
      `/v1/operations/${operationId}/runs/${runId}/cancel`,
      { workspace_id: WORKSPACE, cancelled_by: ACTOR },
    );
    expect(replay.status).toBe(200);
    expect(replay.body["outcome"]).toBe("already_cancelled");
  });

  it("a cancel racing a completed run answers already_settled (deterministic)", async () => {
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-race-"), "runtime.db"),
      workerHarness(),
    );
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run_s22_race");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "SUCCEEDED");

    const cancel = await postJson(
      runtime.origin,
      `/v1/operations/${operationId}/runs/${runId}/cancel`,
      { workspace_id: WORKSPACE, cancelled_by: ACTOR },
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ outcome: "already_settled", state: "SUCCEEDED" });
    expect(await runStateOf(runtime.origin, operationId, runId)).toBe("SUCCEEDED");
  });

  it("a queued child never starts when the parent is cancelled (AC5)", async () => {
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-child-"), "runtime.db"),
      workerHarness(),
    );
    const created = await postJson(runtime.origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "S22 Op children",
      roster_agent_ids: [RESEARCHER, CITATION],
      coordinator_agent_id: GENERAL,
    });
    expect(created.status).toBe(201);
    const operationId = (created.body as { operation_id: string }).operation_id;
    const parentId = "run_s22_parent";
    const childId = "run_s22_child";
    for (const [runIdKey, parentTaskId] of [
      [parentId, undefined],
      [childId, parentId],
    ] as const) {
      const run = await postJson(runtime.origin, `/v1/operations/${operationId}/runs`, {
        workspace_id: WORKSPACE,
        run_id: runIdKey,
        ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
      });
      expect(run.status).toBe(201);
    }
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, parentId, "RUNNING");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, childId, "QUEUED");
    await until(async () => ((await runStateOf(runtime.origin, operationId, parentId)) === "RUNNING" ? true : null));

    const cancel = await postJson(
      runtime.origin,
      `/v1/operations/${operationId}/runs/${parentId}/cancel`,
      { workspace_id: WORKSPACE, cancelled_by: ACTOR },
    );
    expect(cancel.status).toBe(200);
    expect(cancel.body["outcome"]).toBe("cancelled");
    expect(cancel.body["cancelled_child_run_ids"]).toEqual([childId]);
    // The child never started: it is CANCELLED and has no worker row.
    expect(await runStateOf(runtime.origin, operationId, childId)).toBe("CANCELLED");
    const workers = readRunJournal(runtime.dbPath, childId).filter((row) =>
      row.type.startsWith("worker."),
    );
    expect(workers).toEqual([]);
  });

  it("an agent actor is refused the cancel (typed, the run untouched)", async () => {
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-actor-"), "runtime.db"),
      workerHarness(),
    );
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run_s22_actor");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");
    const cancel = await postJson(
      runtime.origin,
      `/v1/operations/${operationId}/runs/${runId}/cancel`,
      { workspace_id: WORKSPACE, cancelled_by: { type: "agent", id: RESEARCHER } },
    );
    expect(cancel.status).toBe(400);
    // The body contract refuses the agent actor at the boundary.
  });
});

describe("S22 run-control API — retries and events over the real stack (AC14, AC3, AC10)", () => {
  it("a transient worker failure walks exactly three retries then pauses (fast backoff)", async () => {
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-retry-"), "runtime.db"),
      workerHarness([
        "--error-on-step",
        "1",
        "--error-class",
        "TOOL_EXECUTION_TIMEOUT",
      ]),
    );
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run_s22_retry");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");

    // The walk: fail → retry 1 → fail → retry 2 → fail → retry 3 → fail →
    // PAUSED (each attempt restarts the worker; the fast policy keeps the
    // whole walk well inside the poll budget).
    const state = await until(async () => {
      const current = await runStateOf(runtime.origin, operationId, runId);
      return current === "PAUSED" ? "PAUSED" : null;
    }, 20_000);
    expect(state).toBe("PAUSED");

    const lifecycle = readRunJournal(runtime.dbPath, runId);
    const scheduled = lifecycle.filter((row) => row.type === "task.retry_scheduled");
    expect(scheduled).toHaveLength(3);
    // The attempt number rides the envelope's payload (the contract shape).
    expect(
      scheduled.map((row) => (row.payload as { payload: { attempt: number } }).payload.attempt),
    ).toEqual([1, 2, 3]);
    const pauses = lifecycle.filter((row) => row.type === "task.paused");
    expect(pauses).toHaveLength(1);
    expect((pauses[0]!.payload as { payload: { reason: string } }).payload.reason).toBe(
      "retry_exhausted",
    );
  });

  it("GET events exposes the run's journal with the true attempt numbers (AC3)", async () => {
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-events-"), "runtime.db"),
      workerHarness(["--error-on-step", "1", "--error-class", "TOOL_EXECUTION_TIMEOUT"]),
    );
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run_s22_events");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");
    await until(async () => {
      const current = await runStateOf(runtime.origin, operationId, runId);
      return current === "RETRYING" || current === "PAUSED" ? true : null;
    }, 20_000);

    const events = await getJson(
      runtime.origin,
      `/v1/operations/${operationId}/runs/${runId}/events?workspace_id=${WORKSPACE}`,
    );
    expect(events.status).toBe(200);
    const list = events.body["events"] as Array<{ type: string; payload: Record<string, unknown> }>;
    const scheduled = list.filter((event) => event.type === "task.retry_scheduled");
    expect(scheduled.length).toBeGreaterThanOrEqual(1);
    // The attempt number comes from the envelope payload — the UI renders
    // THIS number, never a hardcoded "2 of 3".
    expect(
      (scheduled[0]!.payload as { payload: { attempt: number } }).payload["attempt"],
    ).toBe(1);
    const decisions = list.filter((event) => event.type === "run.failure_decided");
    expect(decisions.length).toBeGreaterThanOrEqual(1);
  });

  it("an ambiguous failure pauses for review with the reason recorded (AC10)", async () => {
    const runtime = await composeOn(
      join(makeTempDir("shera-s22-api-ambig-"), "runtime.db"),
      workerHarness(["--error-on-step", "1", "--error-class", "PROVIDER_RESPONSE_AMBIGUOUS"]),
    );
    const { operationId, runId } = await createOperationAndRun(runtime.origin, "run_s22_ambig");
    runtime.runtime.operations.applyRunState(WORKSPACE, operationId, runId, "RUNNING");

    const state = await until(async () => {
      const current = await runStateOf(runtime.origin, operationId, runId);
      return current === "RECOVERY_REQUIRED" ? "RECOVERY_REQUIRED" : null;
    }, 20_000);
    expect(state).toBe("RECOVERY_REQUIRED");
    // NO retry was scheduled.
    const lifecycle = readRunJournal(runtime.dbPath, runId);
    expect(lifecycle.filter((row) => row.type === "task.retry_scheduled")).toEqual([]);
    const decisions = lifecycle.filter((row) => row.type === "run.failure_decided");
    expect(decisions).toHaveLength(1);
    // The runtime decision event's stored payload IS the bare record.
    expect(decisions[0]!.payload).toMatchObject({
      decision: "pause_for_review",
      failure_code: "PROVIDER_RESPONSE_AMBIGUOUS",
      reason: "ambiguous_external_effect",
    });
  });
});
