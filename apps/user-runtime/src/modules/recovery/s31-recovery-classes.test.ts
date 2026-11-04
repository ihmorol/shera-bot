/**
 * S31 chunk 2 — the E13 recovery classes drive restart recovery (D32, D33,
 * E13, PRD §13; issue #32 AC-matrix bullets 3+4).
 *
 * The class matrix, one scripted case per class:
 *
 *  - `replayable` re-executes from the checkpoint WITHOUT user action — the
 *    run auto-resumes (interrupted RUNNING runs re-drive directly; interrupted
 *    RECOVERY_REQUIRED runs walk the runtime-actor `recovery_auto_resume`
 *    transition the 2026-09-19 review note reserved for this layer) and the
 *    effect happens exactly ONCE.
 *  - `idempotent_retry` re-executes UNDER ITS RECORDED IDEMPOTENCY KEY — the
 *    scripted ledger proves the recovery re-execution collapses into the
 *    original effect: net effect count stays 1 even though the original
 *    effect LANDED before the interruption (the worst case).
 *  - `needs_human` (and every fail-closed variant: no checkpoint, no pending
 *    action, an undeclared class, an idempotent_retry with no recorded key)
 *    pauses RECOVERY_REQUIRED and the ambiguous effect is NEVER replayed —
 *    the scripted effect ledger is untouched, the resume port is never
 *    called.
 *
 * A tool that declares nothing is needs_human (E13). RECOVERY_REQUIRED runs
 * with no checkpoint to vouch for them stay as-is (the S16 reconciliation
 * semantics are preserved for anything the checkpoints cannot prove).
 *
 * Governing records: D8, D32, D33, E13, D23 rule 5; PRD §13.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { TaskLifecyclePayload } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import {
  RunCheckpointsRepository,
  type RunCheckpointRow,
} from "../../adapters/sqlite/run-checkpoints-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  EventJournalRepository,
  type EventJournalRow,
} from "../../adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { OperationsService } from "../operations/operations.service.ts";
import { TASK_TRANSITIONS } from "../tasks/task-transitions.ts";
import { CheckpointService } from "../tasks/checkpoint.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import { decideRecovery, recoveryRedriveSpec, RecoveryDriver } from "./recovery-driver.service.ts";

const WS = "ws_s31_recovery";
const AGENT = "agent_recovery_test";
const NOW = "2026-11-04T11:00:00.000Z";

const PACK_CATALOG = {
  pack_id: "pack_recovery_test",
  pack_version: "1.0.0",
  agents: [
    {
      agent_id: AGENT,
      display_name: "Recovery Test Agent",
      role_description: "dies on cue",
      default_provider: { provider_id: "fake", model: "fake-model" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 7, initial_glyph: "R" },
      home_operation_id: null,
    },
  ],
  locateAgentPack: (agentId: string) => (agentId === AGENT ? "pack_recovery_test" : null),
  skills: [],
  connectors: [],
};

/** The scripted external-effect ledger: every effect execution is recorded;
 * an idempotent key collapses into the effect that first consumed it. */
class EffectLedger {
  private readonly consumedKeys = new Set<string>();
  readonly effects: Array<{ key: string | null }> = [];

  execute(key: string | null): void {
    if (key !== null) {
      if (this.consumedKeys.has(key)) return; // the idempotency collapse
      this.consumedKeys.add(key);
    }
    this.effects.push({ key });
  }
}

interface RecoveryHarness {
  conn: SqliteConnection;
  journal: EventJournalRepository;
  ops: OperationsService;
  operationsRepo: OperationsRepository;
  checkpoints: RunCheckpointsRepository;
  checkpointService: CheckpointService;
  driver: RecoveryDriver;
  ledger: EffectLedger;
  /** The re-drive calls in order (what the supervisor would receive). */
  resumeCalls: Array<{
    runId: string;
    basis: "replayable" | "idempotent_retry";
    idempotencyKey: string | null;
  }>;
  operationId: string;
  runSeq: { n: number };
  dir: string;
}

const openHarnesses: RecoveryHarness[] = [];

function makeHarness(): RecoveryHarness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s31-recovery-"));
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
  const ledger = new EffectLedger();
  const resumeCalls: RecoveryHarness["resumeCalls"] = [];

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
    runs: {
      listRunsByState: (state) => operationsRepo.listRunsByState(state),
    },
    // The matrix harness has no worker rows — nothing is ever live.
    hasLiveWorker: () => false,
    resume: (input) => {
      resumeCalls.push({
        runId: input.runId,
        basis: input.basis,
        idempotencyKey: input.idempotencyKey,
      });
      // The re-driven worker re-executes the pending action: the effect is
      // keyed exactly as the recovery class demands (replayable re-runs
      // unkeyed; idempotent_retry re-runs under the recorded key).
      ledger.execute(input.basis === "idempotent_retry" ? input.idempotencyKey : null);
    },
    now: () => NOW,
  });

  const operationId = ops.createOperation(WS, {
    definition_ref: null,
    name: "Recovery Operation",
    roster_agent_ids: [AGENT],
    coordinator_agent_id: AGENT,
  }).operation_id;

  const harness: RecoveryHarness = {
    conn,
    journal,
    ops,
    operationsRepo,
    checkpoints,
    checkpointService,
    driver,
    ledger,
    resumeCalls,
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

function createRun(harness: RecoveryHarness, state: "RUNNING" | "RECOVERY_REQUIRED"): string {
  harness.runSeq.n += 1;
  const runId = `run_recovery_${harness.runSeq.n}`;
  harness.ops.createRun(WS, harness.operationId, { run_id: runId });
  harness.ops.applyRunState(WS, harness.operationId, runId, "RUNNING");
  if (state === "RECOVERY_REQUIRED") {
    harness.ops.applyRunState(WS, harness.operationId, runId, "RECOVERY_REQUIRED");
  }
  return runId;
}

/** Record one checkpoint with a pending action (the boundary's recovery data). */
function takeCheckpoint(
  harness: RecoveryHarness,
  runId: string,
  pendingAction: Record<string, unknown> | null,
): RunCheckpointRow {
  const verdict = harness.checkpointService.record({
    workspaceId: WS,
    taskId: runId,
    conversationId: harness.operationId,
    stepId: `step_boundary_${runId}`,
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

function runEvents(
  harness: RecoveryHarness,
  runId: string,
): Array<{ type: string; payload: Record<string, unknown> }> {
  return harness.journal
    .readFrom(WS, taskStreamId(runId), 0, 1_000)
    .filter((row: EventJournalRow) => row.event_type !== "task.created")
    .map((row) => ({
      type: row.event_type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
}

function runState(harness: RecoveryHarness, runId: string): string {
  return harness.ops.getRun(WS, harness.operationId, runId).state;
}

// ── The pure policy ──────────────────────────────────────────────────────────

describe("S31 recovery policy — the E13 class decision is pure fail-closed data", () => {
  it("resumes a replayable pending action", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "parse the document",
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    expect(decision).toEqual({ action: "resume", basis: "replayable", idempotencyKey: null });
  });

  it("resumes an idempotent_retry under its recorded key", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "charge the card",
      tool_id: "tool_charge",
      recovery_class: "idempotent_retry",
      idempotency_key: "idem_charge_1",
      risk_class: "READ_ONLY",
    });
    expect(decision).toEqual({
      action: "resume",
      basis: "idempotent_retry",
      idempotencyKey: "idem_charge_1",
    });
  });

  it("refuses to resume an idempotent_retry with no recorded key (unprovable dedupe)", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "charge the card",
      recovery_class: "idempotent_retry",
      risk_class: "READ_ONLY",
    });
    expect(decision).toEqual({ action: "pause_for_review", reason: "no_idempotency_key" });
  });

  it("pauses a needs_human pending action", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "send the wire",
      recovery_class: "needs_human",
    });
    expect(decision).toEqual({ action: "pause_for_review", reason: "recovery_class_needs_human" });
  });

  it("pauses when the tool declares nothing (the E13 default) and when there is no pending action", () => {
    expect(decideRecovery({ kind: "tool_execution", summary: "undeclared" })).toEqual({
      action: "pause_for_review",
      reason: "recovery_class_needs_human",
    });
    expect(decideRecovery(null)).toEqual({
      action: "pause_for_review",
      reason: "recovery_class_needs_human",
    });
  });
});

// ── The trust boundary (the D35 ladder applied to recovery; G6) ──────────────
//
// Tools-inventory stores an agent-DECLARED recovery class verbatim. The
// decision layer therefore CAPS the declared class by the tool's runtime-
// verified risk class: only a READ_ONLY tool may auto-resume; a WRITE or
// EXTERNAL tool's declaration — however friendly — pauses RECOVERY_REQUIRED.
// A malicious WRITE tool declaring `replayable` must never blind-re-execute
// at every restart (G6: agents never self-approve).

describe("S31 recovery policy — the risk-class cap is the trust boundary", () => {
  it("a non-READ_ONLY tool declaring replayable pauses — the declaration never outranks the risk class", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "the external write its declaration calls replayable",
      tool_id: "tool_external_post",
      recovery_class: "replayable",
      risk_class: "EXTERNAL_WRITE",
    });
    expect(decision).toEqual({ action: "pause_for_review", reason: "risk_class_caps_recovery" });
  });

  it("a non-READ_ONLY idempotent_retry pauses even WITH its recorded key (the cap beats the key)", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "the charge its declaration calls idempotent_retry",
      tool_id: "tool_charge",
      recovery_class: "idempotent_retry",
      idempotency_key: "idem_charge_1",
      risk_class: "FINANCIAL_OR_IRREVERSIBLE",
    });
    expect(decision).toEqual({ action: "pause_for_review", reason: "risk_class_caps_recovery" });
  });

  it("a declaration with NO recorded risk_class is capped (fail-closed — the record must prove READ_ONLY)", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "no risk class on the record",
      tool_id: "tool_mystery",
      recovery_class: "replayable",
    });
    expect(decision).toEqual({ action: "pause_for_review", reason: "risk_class_caps_recovery" });
  });

  it("a READ_ONLY tool declaring replayable resumes (the boundary's affirmative leg)", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "parse the document",
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    expect(decision).toEqual({ action: "resume", basis: "replayable", idempotencyKey: null });
  });

  it("a READ_ONLY idempotent_retry resumes under its recorded key", () => {
    const decision = decideRecovery({
      kind: "tool_execution",
      summary: "refresh the cached read",
      tool_id: "tool_cache_refresh",
      recovery_class: "idempotent_retry",
      idempotency_key: "idem_cache_1",
      risk_class: "READ_ONLY",
    });
    expect(decision).toEqual({
      action: "resume",
      basis: "idempotent_retry",
      idempotencyKey: "idem_cache_1",
    });
  });
});

// ── The class matrix (one scripted case per class) ───────────────────────────

describe("S31 recovery driver — the class matrix (issue #32)", () => {
  it("replayable: an interrupted RUNNING run auto-resumes without user action and the effect happens exactly once", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "parse the downloaded document",
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    // The pre-interruption effect never landed (the worker died first).
    expect(harness.ledger.effects).toHaveLength(0);

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "resumed", basis: "replayable" });
    // Exactly ONE re-drive, without any user action (no approval event, no
    // human-actor transition — the run was RUNNING and stays RUNNING).
    expect(harness.resumeCalls).toHaveLength(1);
    expect(harness.resumeCalls[0]).toMatchObject({ runId, basis: "replayable" });
    expect(runState(harness, runId)).toBe("RUNNING");
    // Single effect: the recovery re-execution is the one effect.
    expect(harness.ledger.effects).toHaveLength(1);
    // The journal marker records the decision honestly.
    const decided = runEvents(harness, runId).filter((e) => e.type === "recovery.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({
      run_id: runId,
      basis: "replayable",
      replayed: true,
    });
  });

  it("idempotent_retry: the re-execution rides the RECORDED key — the landed original collapses, net one effect", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "execute the confirmed external request",
      tool_id: "tool_external_post",
      recovery_class: "idempotent_retry",
      idempotency_key: "idem_s31_charge_1",
      risk_class: "READ_ONLY",
    });
    // The WORST case: the original effect LANDED before the interruption
    // (the confirmation was lost with the worker).
    harness.ledger.execute("idem_s31_charge_1");
    expect(harness.ledger.effects).toHaveLength(1);

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "resumed", basis: "idempotent_retry" });
    // The driver handed the RECORDED key to the re-drive — a fresh key here
    // would double the effect, and that is exactly what this pin forbids.
    expect(harness.resumeCalls).toHaveLength(1);
    expect(harness.resumeCalls[0]).toMatchObject({
      runId,
      basis: "idempotent_retry",
      idempotencyKey: "idem_s31_charge_1",
    });
    // Net effect count stays at ONE (the key collapsed the re-execution).
    expect(harness.ledger.effects).toHaveLength(1);
  });

  it("needs_human: an interrupted RUNNING run enters RECOVERY_REQUIRED and the ambiguous effect is NEVER replayed", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "send the external request",
      tool_id: "tool_external_post",
      recovery_class: "needs_human",
      risk_class: "EXTERNAL_WRITE",
    });
    // The ambiguous effect MAY have landed before the interruption.
    harness.ledger.execute(null);
    expect(harness.ledger.effects).toHaveLength(1);

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "paused_for_review" });
    expect(runState(harness, runId)).toBe("RECOVERY_REQUIRED");
    // The ambiguous effect is NEVER replayed: the ledger is untouched and
    // the resume port was never called.
    expect(harness.resumeCalls).toHaveLength(0);
    expect(harness.ledger.effects).toHaveLength(1);
    // The pause walked the D8 table with the runtime actor.
    const lifecycle = runEvents(harness, runId).filter((e) => e.type === "task.recovery_required");
    expect(lifecycle).toHaveLength(1);
    expect(
      (lifecycle[0]!.payload as unknown as { payload: TaskLifecyclePayload }).payload,
    ).toMatchObject({ from_state: "RUNNING", to_state: "RECOVERY_REQUIRED" });
    // The decision marker records the honest no-replay basis.
    const decided = runEvents(harness, runId).filter((e) => e.type === "recovery.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({
      run_id: runId,
      basis: null,
      replayed: false,
    });
  });

  it("an interrupted RECOVERY_REQUIRED run auto-resumes through the runtime-actor recovery_auto_resume transition when the class permits", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RECOVERY_REQUIRED");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "save the artifact",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "resumed", basis: "replayable" });
    expect(runState(harness, runId)).toBe("RUNNING");
    expect(harness.resumeCalls).toHaveLength(1);
    // The resume walked the runtime-actor transition with its OWN reason —
    // the journal never mistakes a class-driven resume for a human approval.
    const resumes = runEvents(harness, runId).filter((e) => e.type === "task.recovery_resumed");
    expect(resumes).toHaveLength(1);
    expect(
      (resumes[0]!.payload as unknown as { payload: TaskLifecyclePayload }).payload,
    ).toMatchObject({ to_state: "RUNNING", reason: "recovery_class_permits" });
  });

  it("a RECOVERY_REQUIRED run with NO checkpoint stays as-is (nothing can vouch for a resume)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RECOVERY_REQUIRED");

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "paused_for_review" });
    expect(runState(harness, runId)).toBe("RECOVERY_REQUIRED");
    expect(harness.resumeCalls).toHaveLength(0);
  });

  it("non-recovery states are skipped — QUEUED is reconciliation's, RETRYING is the coordinator's, terminals are closed", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "replayable pending",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    // Move it out of the recovery slice's remit.
    harness.ops.applyRunState(WS, harness.operationId, runId, "QUEUED");

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "skipped" });
    expect(harness.resumeCalls).toHaveLength(0);
    expect(runState(harness, runId)).toBe("QUEUED");
  });

  it("the boot scan visits each recovery-owned run exactly once and reports per-run outcomes", async () => {
    const harness = makeHarness();
    const replayableRun = createRun(harness, "RUNNING");
    takeCheckpoint(harness, replayableRun, {
      kind: "tool_execution",
      summary: "replayable pending",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    const ambiguousRun = createRun(harness, "RUNNING");
    takeCheckpoint(harness, ambiguousRun, {
      kind: "tool_execution",
      summary: "ambiguous pending",
      recovery_class: "needs_human",
      risk_class: "EXTERNAL_WRITE",
    });

    const report = await harness.driver.recoverInterruptedRuns();

    const visited = report.visited.map((entry) => entry.runId).sort();
    expect(visited).toEqual([ambiguousRun, replayableRun].sort());
    const byRun = new Map(report.visited.map((entry) => [entry.runId, entry.outcome]));
    expect(byRun.get(replayableRun)).toMatchObject({ outcome: "resumed" });
    expect(byRun.get(ambiguousRun)).toMatchObject({ outcome: "paused_for_review" });
    // One pass, one decision per run: no double re-drives.
    expect(harness.resumeCalls).toHaveLength(1);
  });

  it("a non-READ_ONLY tool declaring replayable pauses RECOVERY_REQUIRED — the capped effect is NEVER replayed (the composed trust boundary)", async () => {
    const harness = makeHarness();
    const runId = createRun(harness, "RUNNING");
    // The untrusted declaration, exactly as tools-inventory stores it: an
    // agent-declared `replayable` on an EXTERNAL_WRITE tool.
    takeCheckpoint(harness, runId, {
      kind: "tool_execution",
      summary: "the external write its declaration calls replayable",
      tool_id: "tool_external_post",
      recovery_class: "replayable",
      risk_class: "EXTERNAL_WRITE",
    });
    // The effect MAY have landed before the interruption.
    harness.ledger.execute(null);
    expect(harness.ledger.effects).toHaveLength(1);

    const outcome = await harness.driver.recoverRun(WS, runId);

    expect(outcome).toMatchObject({ outcome: "paused_for_review" });
    expect(runState(harness, runId)).toBe("RECOVERY_REQUIRED");
    // The declared-replayable WRITE effect is never blind-re-executed (G6:
    // agents never self-approve recovery) — the ledger is untouched, the
    // resume port is never called.
    expect(harness.resumeCalls).toHaveLength(0);
    expect(harness.ledger.effects).toHaveLength(1);
    // The marker names the CAP, not the declaration.
    const decided = runEvents(harness, runId).filter((e) => e.type === "recovery.decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]!.payload).toMatchObject({ basis: null, replayed: false });
  });
});

// ── The re-drive spec (the recorded key's ride to the worker) ────────────────

describe("S31 recovery re-drive spec — the recorded key threads to the worker seam", () => {
  it("carries the recorded idempotency key in the worker spec config (the collapse rides the SAME key)", () => {
    expect(recoveryRedriveSpec("idem_s31_charge_1")).toEqual({
      config: { recovery_idempotency_key: "idem_s31_charge_1" },
    });
  });

  it("carries no config for an unkeyed replayable re-drive", () => {
    expect(recoveryRedriveSpec(null)).toEqual({});
  });
});

// ── The transition-table pins ────────────────────────────────────────────────

describe("S31 recovery transitions — the D8 table gains the runtime-actor auto-resume", () => {
  it("adds recovery_auto_resume as a runtime-only RECOVERY_REQUIRED -> RUNNING row with its own reason", () => {
    const row = TASK_TRANSITIONS.find(
      (candidate) =>
        candidate.from === "RECOVERY_REQUIRED" && candidate.command === "recovery_auto_resume",
    );
    expect(row).toBeDefined();
    expect(row!.to).toBe("RUNNING");
    expect(row!.actors).toEqual(["runtime"]);
    expect(row!.reason).toBe("recovery_class_permits");
    expect(row!.event).toBe("task.recovery_resumed");
  });

  it("keeps the human recovery_resume row exactly as it was (auto-resume never widens the human path)", () => {
    const row = TASK_TRANSITIONS.find(
      (candidate) =>
        candidate.from === "RECOVERY_REQUIRED" && candidate.command === "recovery_resume",
    );
    expect(row).toBeDefined();
    expect(row!.actors).toEqual(["user", "admin"]);
    expect(row!.reason).toBe("recovery_approved");
  });
});
