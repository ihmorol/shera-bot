/**
 * S31 fix round (P2-5) — the recovery status read model + the
 * /v1/recovery/status route, over a REAL seeded store and the REAL
 * RecoveryDriver's markers (the runtime's own records; the read model never
 * invents).
 *
 * Pinned here:
 *  - the banner precedence is exactly review_needed > recovering > resumed >
 *    idle (UI_DESIGN S11);
 *  - a resumed entry's basis comes from the run's LAST `recovery.decided`
 *    journal marker — never re-derived from the latest checkpoint, which a
 *    post-resume boundary would move (the resume-basis-drift fix);
 *  - the RESUMED workspace_state DECAYS after the recorded window (the S11
 *    transient; the durable per-run markers stay);
 *  - `timelineFor` renders the durable journal story in order: checkpoint →
 *    restart → resume/pause, with the pause naming the unprovable step;
 *  - the route serves the read model on a valid workspace-scoped GET and
 *    refuses a query without workspace_id typed.
 *
 * Governing records: PRD §13, UI_DESIGN S11, D32/D33; AC8-bullet surfaces.
 */
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import {
  RunCheckpointsRepository,
  type RunCheckpointRow,
} from "../../adapters/sqlite/run-checkpoints-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { CheckpointService } from "../../modules/tasks/checkpoint.service.ts";
import { EventsService } from "../../modules/events/events.service.ts";
import { OperationsService } from "../../modules/operations/operations.service.ts";
import {
  RecoveryDriver,
  type RecoveryScanReport,
} from "../../modules/recovery/recovery-driver.service.ts";
import {
  buildRecoveryApiHandle,
  registerRecoveryRoutes,
  RECOVERY_STATUS_PATH,
  type RecoveryApiHandle,
} from "./s31-recovery-api.ts";

const WS = "ws_s31_api";
const AGENT = "agent_api_test";
const NOW = "2026-11-04T11:00:00.000Z";

const PACK_CATALOG = {
  pack_id: "pack_api_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "API Test Agent",
      role_description: "recovers on cue",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 3, initial_glyph: "A" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_api_test" : null),
  skills: [],
  connectors: [],
};

interface ApiHarness {
  conn: SqliteConnection;
  journal: EventJournalRepository;
  events: EventsService;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  checkpoints: RunCheckpointsRepository;
  checkpointService: CheckpointService;
  driver: RecoveryDriver;
  operationId: string;
  runSeq: { n: number };
  dir: string;
}

const openHarnesses: ApiHarness[] = [];

function makeHarness(): ApiHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s31-api-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const operationsRepo = new OperationsRepository(tx);
  const ops = new OperationsService({ operations: operationsRepo, tx, packCatalog: PACK_CATALOG });
  const checkpoints = new RunCheckpointsRepository(tx);
  const checkpointService = new CheckpointService({
    tx,
    journal,
    events,
    checkpoints,
    now: () => NOW,
  });
  const driver = new RecoveryDriver({
    tx,
    journal,
    events,
    operations: operationsRepo,
    runControl: {
      runState: (_workspaceId, runId) => {
        const opId = operationsRepo.findRunOperation(WS, runId);
        if (opId === null) return null;
        try {
          return ops.getRun(WS, opId, runId).state;
        } catch {
          return null;
        }
      },
      applyRunState: (_workspaceId, runId, state) => {
        const opId = operationsRepo.findRunOperation(WS, runId);
        if (opId === null) throw new Error(`run ${runId} not found`);
        ops.applyRunState(WS, opId, runId, state);
      },
    },
    latestRecoveryBasis: (workspaceId, taskId) => {
      const latest = checkpoints.latestForTask(workspaceId, taskId);
      if (latest === null) return null;
      const parsed: unknown = latest.pending_action_json
        ? JSON.parse(latest.pending_action_json)
        : null;
      return {
        pendingAction: (parsed ?? null) as Record<string, unknown> | null,
        checkpointVersion: latest.checkpoint_version,
      };
    },
    runs: { listRunsByState: (state) => operationsRepo.listRunsByState(state) },
    hasLiveWorker: () => false,
    resume: () => {
      // The re-drive succeeds (the report's resumed entries are real).
    },
    now: () => NOW,
  });
  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "API Recovery Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;
  const harness: ApiHarness = {
    conn,
    journal,
    events,
    ops,
    operationsRepo,
    checkpoints,
    checkpointService,
    driver,
    operationId,
    runSeq: { n: 0 },
    dir,
  };
  openHarnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of openHarnesses.splice(0)) {
    try {
      harness.conn.close();
    } finally {
      rmSync(harness.dir, { recursive: true, force: true });
    }
  }
});

function createRun(harness: ApiHarness, state: "RUNNING" | "RECOVERY_REQUIRED"): string {
  harness.runSeq.n += 1;
  const runId = `run_api_${harness.runSeq.n}`;
  harness.ops.createRun(WS, harness.operationId, { run_id: runId });
  harness.ops.applyRunState(WS, harness.operationId, runId, "RUNNING");
  if (state === "RECOVERY_REQUIRED") {
    harness.ops.applyRunState(WS, harness.operationId, runId, "RECOVERY_REQUIRED");
  }
  return runId;
}

function takeCheckpoint(
  harness: ApiHarness,
  runId: string,
  pendingAction: Record<string, unknown> | null,
): RunCheckpointRow {
  harness.runSeq.n += 1;
  const verdict = harness.checkpointService.record({
    workspaceId: WS,
    taskId: runId,
    conversationId: harness.operationId,
    stepId: `step_api_${harness.runSeq.n}`,
    stepKind: "completed_search",
    completedActions: [{ kind: "tool_execution", summary: "the boundary search completed" }],
    pendingAction: pendingAction as never,
    artifactRefs: [],
    resumeInstructions: "Resume from the recorded boundary.",
  });
  if (!verdict.ok) throw new Error(`checkpoint refused: ${verdict.safeMessage}`);
  const row = harness.checkpoints.latestForTask(WS, runId);
  if (row === null) throw new Error("checkpoint row missing");
  return row;
}

function buildHandle(
  harness: ApiHarness,
  report: RecoveryScanReport | null,
  bootSettled: boolean,
  now?: () => string,
): RecoveryApiHandle {
  return buildRecoveryApiHandle({
    recovery: { lastReport: () => report, bootSettled: () => bootSettled },
    operations: harness.operationsRepo,
    checkpoints: harness.checkpoints,
    journal: harness.journal,
    ...(now ? { now } : {}),
  });
}

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("S31 recovery status read model — the banner precedence (UI_DESIGN S11)", () => {
  it("review_needed wins over everything — even while the boot pass is still in flight", () => {
    const harness = makeHarness();
    createRun(harness, "RECOVERY_REQUIRED");
    const handle = buildHandle(harness, null, false);
    const status = handle.status(WS);
    expect(status.workspace_state).toBe("review_needed");
    expect(status.review_needed).toHaveLength(1);
  });

  it("recovering is the boot-in-flight state when nothing needs review", () => {
    const harness = makeHarness();
    const handle = buildHandle(harness, null, false);
    expect(handle.status(WS).workspace_state).toBe("recovering");
  });

  it("resumed is the fresh post-boot state; idle is the settled no-news state", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "parse the document",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    const report = await harness.driver.recoverInterruptedRuns();
    const fresh = buildHandle(harness, report, true);
    expect(fresh.status(WS).workspace_state).toBe("resumed");
    const idle = buildHandle(harness, null, true);
    expect(idle.status(WS).workspace_state).toBe("idle");
  });
});

describe("S31 recovery status read model — the basis is the journal's own decision", () => {
  it("a resumed entry anchors the DECIDED checkpoint version — a newer boundary never drifts it", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    const boundary = takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "parse the document",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    expect(boundary.checkpoint_version).toBe(1);
    const report = await harness.driver.recoverInterruptedRuns();
    expect(report.visited[0]?.outcome.outcome).toBe("resumed");

    // A NEWER boundary lands after the resume (the run kept working) — the
    // entry must STILL anchor v1, the step the decision actually named.
    const newer = takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "the next completed step",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    expect(newer.checkpoint_version).toBe(2);

    const handle = buildHandle(harness, report, true);
    const status = handle.status(WS);
    expect(status.resumed).toHaveLength(1);
    expect(status.resumed[0]).toMatchObject({
      run_id: runId,
      basis: "replayable",
      checkpoint_version: 1,
      step_id: boundary.step_id,
      replayed: true,
    });
  });

  it("the RESUMED banner state decays after the recorded window — the durable markers stay", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "parse the document",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    const report = await harness.driver.recoverInterruptedRuns();

    // Fresh (the decision just happened — the journal rows carry the real
    // wall clock): resumed.
    const fresh = buildHandle(harness, report, true);
    expect(fresh.status(WS).workspace_state).toBe("resumed");
    // 61 real seconds later (the window is 60s): the banner decays to idle
    // while the run card's timeline keeps its markers.
    const later = new Date(Date.now() + 61_000).toISOString();
    const decayed = buildHandle(harness, report, true, () => later);
    const status = decayed.status(WS);
    expect(status.workspace_state).toBe("idle");
    expect(status.resumed).toHaveLength(1);
    expect(status.timelines[runId]?.markers.length).toBeGreaterThan(0);
  });
});

describe("S31 recovery status read model — the per-run timeline", () => {
  it("renders the durable journal story in order: checkpoint → restart → resume", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    const boundary = takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "parse the document",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    // The crash left a reaped worker row (the restart marker) on the RAW run
    // stream — journaled exactly as the reaper does.
    harness.events.appendEvent({
      event_id: `evt_worker_reaped_${runId}`,
      stream_id: runId,
      type: "worker.reaped",
      payload: {
        worker_id: "wk_dead",
        workspace_id: WS,
        run_id: runId,
        pid: 999_999,
        previous_state: "running",
        cause: "gateway_restart",
      },
      workspace_id: WS,
      correlation_id: `worker:${runId}`,
    });
    const report = await harness.driver.recoverInterruptedRuns();

    const handle = buildHandle(harness, report, true);
    const status = handle.status(WS);
    const timeline = status.timelines[runId];
    expect(timeline).toBeDefined();
    const kinds = timeline!.markers.map((marker) => marker.kind);
    expect(kinds).toEqual(["checkpoint", "restart", "resume"]);
    const checkpointMarker = timeline!.markers[0];
    expect(checkpointMarker).toMatchObject({
      kind: "checkpoint",
      checkpoint_version: 1,
      step_id: boundary.step_id,
    });
    const resumeMarker = timeline!.markers[2];
    expect(resumeMarker).toMatchObject({
      kind: "resume",
      basis: "replayable",
      checkpoint_version: 1,
      step_id: boundary.step_id,
    });
  });

  it("renders the pause marker with the unprovable step's summary and no resume claim", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "send the external request",
      recovery_class: "needs_human",
      risk_class: "EXTERNAL_WRITE",
    });
    const report = await harness.driver.recoverInterruptedRuns();
    expect(report.visited[0]?.outcome.outcome).toBe("paused_for_review");

    const handle = buildHandle(harness, report, true);
    const status = handle.status(WS);
    expect(status.workspace_state).toBe("review_needed");
    const timeline = status.timelines[runId];
    expect(timeline).toBeDefined();
    const kinds = timeline!.markers.map((marker) => marker.kind);
    expect(kinds).toEqual(["checkpoint", "pause"]);
    const pauseMarker = timeline!.markers[1];
    expect(pauseMarker).toMatchObject({
      kind: "pause",
      pending_summary: "send the external request",
    });
  });
});

describe("S31 recovery status route — the workspace-scoped GET", () => {
  it("serves the read model on a valid GET and refuses a query without workspace_id typed", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RECOVERY_REQUIRED");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "send the external request",
      recovery_class: "needs_human",
      risk_class: "EXTERNAL_WRITE",
    });
    const handle = buildHandle(harness, null, true);
    const app = express();
    registerRecoveryRoutes(app, { recovery: handle });
    const { server, url } = await listen(app);
    try {
      const ok = await fetch(`${url}${RECOVERY_STATUS_PATH}?workspace_id=${WS}`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ workspace_id: WS, workspace_state: "review_needed" });
      expect(Array.isArray(body.review_needed)).toBe(true);

      const bad = await fetch(`${url}${RECOVERY_STATUS_PATH}`);
      expect(bad.status).toBe(400);
      const badBody = (await bad.json()) as Record<string, unknown>;
      expect(badBody).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
