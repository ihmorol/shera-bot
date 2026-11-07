/**
 * S31 chunk 1 — semantic checkpoints (D33, AC5; issue #32).
 *
 * The D33 field set is DURABLE STATE (the v21 run_checkpoints table) + the
 * journal marker (the contract's checkpoint.taken envelope on the task
 * stream), written in ONE transaction by the runtime's CheckpointService.
 * Checkpoints are taken at SAFE SEMANTIC BOUNDARIES ONLY — a completed
 * search, a downloaded document, a saved artifact, an applied patch, a
 * completed test run, a received approval, a confirmed external request —
 * never per token, never on an arbitrary timer. Between checkpoints, the
 * lightweight progress vocabulary (progress.reported) carries the fine
 * grain (D33).
 *
 * The pins:
 *
 *  1. Migration v21 (run-checkpoints): the chain head moves to v21 and the
 *     STRICT table exists with the full D33 column set.
 *  2. AC5 structural: the ONLY writer entry point validates the step kind
 *     against the closed semantic-boundary vocabulary — a stream/token-style
 *     step is a typed NON_SEMANTIC_STEP refusal, no row, no journal event.
 *  3. AC5 end-to-end: a long streamed response (many progress.reported
 *     frames from the run's harness) journals the lightweight progress
 *     events and produces NO checkpoint rows and NO checkpoint.taken events.
 *  4. The executor hook: a SUCCEEDED tool execution (the recorded boundary)
 *     takes exactly one checkpoint — the full D33 record on the task stream,
 *     monotonic per-task checkpoint_version, the tool's identity in
 *     external_effect_state, and the capability-mapped step kind
 *     (research.fetch → downloaded_document).
 *
 * Governing records: D32, D33, E13, PRD §13, AC5/AC19/AC25; G2/G3/G4.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { TaskRun, TypedExecutionEvent } from "@shera-bot/contracts";

import { openDatabase } from "../../adapters/sqlite/connection.ts";
import {
  appliedMigrationVersions,
  applyMigrations,
  sqliteTableColumns,
  sqliteTableExists,
} from "../../adapters/sqlite/migrations.ts";
import {
  RunCheckpointsRepository,
  CHECKPOINT_COLUMNS,
} from "../../adapters/sqlite/run-checkpoints-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { WorkspaceFilesRepository } from "../../adapters/sqlite/workspace-files-repository.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { HarnessRunService } from "../runtime/harness-run-service.ts";
import type {
  HarnessAdapter,
  HarnessEventSink,
  HarnessName,
  HarnessRunRequest,
} from "../../adapters/process/harness-adapter.ts";
import { ToolExecutor, canonicalArgsDigest } from "../tools/tool-executor.service.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { registerResearchTools } from "../../transport/local-api/s25-research-api.ts";
import {
  CHECKPOINT_STEP_KINDS,
  CheckpointService,
  recoveryIdempotencyKeyFor,
  stepKindForCapability,
  stepKindForCapabilities,
} from "./checkpoint.service.ts";
import { taskStreamId } from "./task-events.ts";

const WS = "ws_s31_checkpoints";
const TASK = "task_s31_ckpt";
const CONV = "conv_s31_ckpt";
const AGENT = "agent_researcher";
const NOW = "2026-11-04T10:00:00.000Z";

/** The typed D34 trigger the streamed-run leg starts from (the S07 shape). */
const TRIGGER: TypedExecutionEvent = {
  event_id: "evt_s31_stream_trigger",
  stream_id: `conversation:${CONV}`,
  sequence: 1,
  event_version: 1,
  actor: { type: "system", id: "scheduler" },
  task_id: "task_s31_stream",
  conversation_id: CONV,
  occurred_at: NOW,
  redaction_class: "internal",
  event_type: "trigger.scheduled",
  payload: { schedule_id: "sch_s31", due_at: NOW },
};

const tempDirs: string[] = [];
const track = (dir: string): string => {
  tempDirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The composed S31 kernel: real SQLite (migrated), the ONE journal, the
 * checkpoint service, and the executor with the checkpoint port wired. */
interface CheckpointRuntime {
  dbPath: string;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  events: EventsService;
  checkpoints: RunCheckpointsRepository;
  checkpointService: CheckpointService;
  executor: ToolExecutor;
  registry: ToolRegistry;
}

function buildRuntime(): CheckpointRuntime {
  const dir = track(mkdtempSync(join(tmpdir(), "shera-s31-ckpt-")));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const checkpoints = new RunCheckpointsRepository(tx);
  const checkpointService = new CheckpointService({
    tx,
    journal,
    events,
    checkpoints,
    now: () => NOW,
  });
  const registry = new ToolRegistry();
  registerResearchTools(registry, WS, {
    searxng: null,
    artifacts: new ArtifactsRepository(tx),
    files: new WorkspaceFilesRepository(tx, new WriteLeasesRepository(tx)),
    visionModel: null,
  });
  const executor = new ToolExecutor({
    registry,
    tools: new ToolsRepository(conn.db),
    tx,
    nowMs: () => 1_000,
    now: () => NOW,
    // The REAL production writer (the P1 fix — the port is the service's own
    // recordFromToolExecution, never a test-side re-implementation).
    checkpoints: {
      recordFromToolExecution: (input) => {
        checkpointService.recordFromToolExecution(input);
      },
    },
  });
  return {
    dbPath: join(dir, "runtime.db"),
    tx,
    journal,
    events,
    checkpoints,
    checkpointService,
    executor,
    registry,
  };
}

function makeRun(taskId = TASK): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s31" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "c".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** Journal event types on one stream (bounded read). */
function streamEvents(rt: CheckpointRuntime, taskId: string): Array<{ type: string }> {
  const rows = rt.journal.readFrom(WS, taskStreamId(taskId), 0, 10_000);
  return rows.map((row) => ({ type: row.event_type }));
}

describe("S31 migration v21 (run-checkpoints)", () => {
  it("keeps the S31 v21 run-checkpoints entry (v22 memory and v23 backup-snapshots follow; the head moves with each integration) and creates the STRICT D33 table", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "shera-s31-mig-")));
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    const versions = appliedMigrationVersions(conn.db);
    expect(versions).toContain(21);
    // No duplicate of any version anywhere in the chain (the hole guard
    // moved with the head: authored v20, renumbered to v21 at the main
    // integration where S24's landed v20 credit-ledger kept its slot; the
    // S29 integration renumbered the memory tables, authored v21, to v22
    // the same way — run-checkpoints keeps its landed v21 slot; the S33
    // integration renumbered backup-snapshots, authored v22, to v23 —
    // memory keeps its landed v22 slot).
    expect(versions[versions.length - 1]).toBe(23);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).not.toContain(24);
    expect(sqliteTableExists(conn.db, "run_checkpoints")).toBe(true);
    // The exact D33 column set (field-for-field, D33) — through the
    // adapter's column helper (the table introspection never leaves
    // adapters/sqlite, AC7/D23 rule 2).
    const columns = sqliteTableColumns(conn.db, "run_checkpoints");
    for (const column of CHECKPOINT_COLUMNS) {
      expect(columns).toContain(column);
    }
    expect(columns).toHaveLength(CHECKPOINT_COLUMNS.length);
  });
});

describe("S31 checkpoint writer (D33)", () => {
  it("records a semantic checkpoint: the full D33 row + one checkpoint.taken envelope, versioned per task", () => {
    const rt = buildRuntime();
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_search_1",
      stepKind: "completed_search",
      completedActions: [
        { kind: "tool_execution", summary: "tool_web_search completed", ref: "execution:exec_1" },
      ],
      pendingAction: {
        kind: "tool_execution",
        summary: "fetch the top result",
        tool_id: "tool_page_fetch",
        recovery_class: "idempotent_retry",
      },
      artifactRefs: [],
      providerUsage: { provider_id: "p1", model: "m1", input_tokens: 10, output_tokens: 5 },
      leaseState: { lease_id: "lease_1", state: "held" },
      approvalState: null,
      externalEffectState: { tool_id: "tool_web_search", settled: "confirmed" },
      resumeInstructions: "Resume by fetching the top search result.",
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    // The durable row carries the FULL D33 field set.
    const rows = rt.checkpoints.listForTask(WS, TASK);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.step_id).toBe("step_search_1");
    expect(row.checkpoint_version).toBe(1);
    expect(row.step_kind).toBe("completed_search");
    expect(JSON.parse(row.completed_actions_json)).toHaveLength(1);
    expect(row.pending_action_json).not.toBeNull();
    expect(JSON.parse(row.pending_action_json ?? "{}")).toMatchObject({
      tool_id: "tool_page_fetch",
      recovery_class: "idempotent_retry",
    });
    expect(row.provider_usage_json).not.toBeNull();
    expect(row.lease_state_json).not.toBeNull();
    expect(row.approval_state_json).toBeNull();
    expect(row.external_effect_state_json).not.toBeNull();
    expect(JSON.parse(row.external_effect_state_json ?? "{}")).toMatchObject({
      settled: "confirmed",
    });
    expect(row.resume_instructions).toBe("Resume by fetching the top search result.");
    expect(row.created_at).toBe(NOW);

    // Exactly ONE journal marker (the contract envelope) on the task stream.
    const markers = streamEvents(rt, TASK).filter((e) => e.type === "checkpoint.taken");
    expect(markers).toHaveLength(1);

    // A second boundary bumps the version monotonically.
    const second = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_fetch_1",
      stepKind: "downloaded_document",
      completedActions: [
        { kind: "tool_execution", summary: "tool_page_fetch completed", ref: "execution:exec_2" },
      ],
      pendingAction: null,
      artifactRefs: ["workspace://artifacts/page.md"],
      resumeInstructions: "Summarize the downloaded page.",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.checkpointVersion).toBe(2);
    expect(rt.checkpoints.listForTask(WS, TASK)).toHaveLength(2);
    expect(streamEvents(rt, TASK).filter((e) => e.type === "checkpoint.taken")).toHaveLength(2);
    expect(rt.checkpointService.latestForTask(WS, TASK)?.step_id).toBe("step_fetch_1");
  });

  it("is idempotent on a replayed step (the same step + version deduplicates)", () => {
    const rt = buildRuntime();
    const input = {
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_once",
      stepKind: "saved_artifact" as const,
      completedActions: [{ kind: "artifact_saved", summary: "report artifact saved" }],
      pendingAction: null,
      artifactRefs: ["workspace://artifacts/report.md"],
      resumeInstructions: "Continue after the saved artifact.",
    };
    const first = rt.checkpointService.record(input);
    const replay = rt.checkpointService.record(input);
    expect(first.ok && replay.ok).toBe(true);
    if (first.ok && replay.ok) {
      expect(replay.checkpointVersion).toBe(first.checkpointVersion);
    }
    expect(rt.checkpoints.listForTask(WS, TASK)).toHaveLength(1);
    expect(streamEvents(rt, TASK).filter((e) => e.type === "checkpoint.taken")).toHaveLength(1);
  });

  it("rejects a NON-semantic step kind typed — the structural AC5 refusal", () => {
    const rt = buildRuntime();
    // A stream/token-style step is NOT in the closed boundary vocabulary.
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_token_42",
      // @ts-expect-error — deliberately outside the closed vocabulary (AC5).
      stepKind: "stream_delta",
      completedActions: [],
      pendingAction: null,
      artifactRefs: [],
      resumeInstructions: "never taken",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("NON_SEMANTIC_STEP");
    expect(rt.checkpoints.listForTask(WS, TASK)).toHaveLength(0);
    expect(streamEvents(rt, TASK).filter((e) => e.type === "checkpoint.taken")).toHaveLength(0);
  });

  it("rejects an out-of-bounds record typed (bounded fields, G3)", () => {
    const rt = buildRuntime();
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_bounds",
      stepKind: "completed_search",
      completedActions: [],
      pendingAction: null,
      artifactRefs: [],
      resumeInstructions: "", // empty instructions are not a resume plan
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("CHECKPOINT_INVALID");
  });

  it("maps tool capabilities onto the boundary vocabulary (data, not inference)", () => {
    expect(stepKindForCapability("research.search")).toBe("completed_search");
    expect(stepKindForCapability("research.fetch")).toBe("downloaded_document");
    expect(stepKindForCapability("research.parse.document")).toBe("downloaded_document");
    expect(stepKindForCapability("research.describe.image")).toBe("tool_execution");
    expect(stepKindForCapability("anything.else")).toBe("tool_execution");
  });
});

describe("S31 AC5 — a long streamed response produces NO per-token checkpoints", () => {
  it("journals lightweight progress frames and zero checkpoints for a streamed run", () => {
    // The streamed-response surface: the run's harness proposes many
    // progress.reported frames (the lightweight between-checkpoint
    // vocabulary) — 50 deltas stand in for a long stream.
    class LongStreamAdapter implements HarnessAdapter {
      readonly harness: HarnessName = "fake";
      driveRun(request: HarnessRunRequest, sink: HarnessEventSink): void {
        const actor = { type: "runtime" as const, id: "harness:fake" };
        const base = {
          workspace_id: request.workspace_id,
          task_id: request.task_id,
          actor,
          issued_at: NOW,
        };
        sink.propose({
          kind: "task_command",
          command: {
            type: "queue_task",
            command_id: `cmd_queue_${request.task_id}`,
            idempotency_key: `idem_queue_${request.task_id}`,
            expected_version: 1,
            ...base,
          },
        });
        sink.propose({
          kind: "task_command",
          command: {
            type: "start_task",
            command_id: `cmd_start_${request.task_id}`,
            idempotency_key: `idem_start_${request.task_id}`,
            expected_version: 2,
            ...base,
          },
        });
        for (let index = 0; index < 50; index += 1) {
          sink.propose({
            kind: "journal_event",
            event_type: "progress.reported",
            payload: { summary: `stream delta ${index}`, fraction: index / 50 },
          });
        }
        sink.propose({
          kind: "task_command",
          command: {
            type: "complete_task",
            command_id: `cmd_complete_${request.task_id}`,
            idempotency_key: `idem_complete_${request.task_id}`,
            expected_version: 3,
            ...base,
          },
        });
      }
    }

    const dir = track(mkdtempSync(join(tmpdir(), "shera-s31-stream-")));
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const journal = new EventJournalRepository(tx);
    const events = new EventsService(journal, tx);
    const checkpoints = new RunCheckpointsRepository(tx);
    const harness = new HarnessRunService({
      adapter: new LongStreamAdapter(),
      tx,
      journal,
      events,
      pinned_pack: {
        pack_id: "pack_student",
        pack_version: "1.0.0",
        pack_hash: "c".repeat(64),
      },
      workspace_id: WS,
      policy: { max_retries: 3 },
      now: () => NOW,
    });
    const started = harness.startRun(TRIGGER);
    expect(started.ok).toBe(true);

    // The creator derives the run's task id from the trigger event id.
    const runTaskId = `task_${TRIGGER.event_id}`;
    const types = journal
      .readFrom(WS, taskStreamId(runTaskId), 0, 10_000)
      .map((row) => row.event_type);
    // The lightweight progress vocabulary carried the stream…
    const progress = types.filter((type) => type === "progress.reported");
    expect(progress).toHaveLength(50);
    // …and NO per-token checkpoint was taken: no checkpoint.taken markers and
    // no durable checkpoint rows for the streamed run (D33 — never per token).
    expect(types.filter((type) => type === "checkpoint.taken")).toHaveLength(0);
    expect(checkpoints.listForTask(WS, runTaskId)).toHaveLength(0);
  });
});

describe("S31 executor hook — a succeeded tool execution is a semantic boundary", () => {
  it("takes exactly one D33 checkpoint per settled execution with the tool identity", async () => {
    const rt = buildRuntime();
    // The document-parse family against a seeded workspace file: a no-network
    // SUCCESS through the ONE executor path (text passes as itself).
    const files = new WorkspaceFilesRepository(rt.tx, new WriteLeasesRepository(rt.tx));
    files.write(
      WS,
      "workspace://uploads/notes.txt",
      { type: "user", id: "user_owner" },
      new Uint8Array(Buffer.from("deterministic body for the checkpoint boundary", "utf8")),
      null,
      {},
    );

    const rawArgs = { path: "workspace://uploads/notes.txt" };
    const outcome = rt.executor.executeProposal({
      proposal: {
        workspace_id: WS,
        task_id: TASK,
        conversation_id: CONV,
        tool_id: "tool_document_parse",
        tool_version: "1.0.0",
        capability: "research.parse.document",
        args_digest: canonicalArgsDigest(rawArgs),
        proposal_summary: "parse the uploaded notes",
      },
      run: makeRun(),
      agent_id: AGENT,
      rawArgs,
    });
    const settled = outcome.outcome === "dispatched" ? await outcome.completion : outcome;
    expect(settled.outcome).toBe("executed");

    // One semantic checkpoint for the settled execution.
    const rows = rt.checkpoints.listForTask(WS, TASK);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.step_kind).toBe("downloaded_document");
    expect(row.checkpoint_version).toBe(1);
    // The pending action is the REAL writer record (the P1 fix): the tool's
    // identity, its DECLARED class, and the runtime-verified risk class —
    // recorded from the resolved definition, never from the tool result.
    const pending = JSON.parse(row.pending_action_json!) as Record<string, unknown>;
    expect(pending).toMatchObject({
      kind: "tool_execution",
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    expect(String(pending.summary)).toContain("tool_document_parse");
    expect(pending.idempotency_key).toBeUndefined();
    const effects = JSON.parse(row.external_effect_state_json!) as Record<string, unknown>;
    expect(effects).toMatchObject({
      tool_id: "tool_document_parse",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
      settled: "confirmed",
    });
    const markers = streamEvents(rt, TASK).filter((e) => e.type === "checkpoint.taken");
    expect(markers).toHaveLength(1);

    // A second succeeded execution bumps the version (monotonic per task).
    const rawArgs2 = { path: "workspace://uploads/notes.txt" };
    const outcome2 = rt.executor.executeProposal({
      proposal: {
        workspace_id: WS,
        task_id: TASK,
        conversation_id: CONV,
        tool_id: "tool_document_parse",
        tool_version: "1.0.0",
        capability: "research.parse.document",
        args_digest: canonicalArgsDigest(rawArgs2),
        proposal_summary: "parse again (new step)",
      },
      run: makeRun(),
      agent_id: AGENT,
      rawArgs: rawArgs2,
    });
    const settled2 = outcome2.outcome === "dispatched" ? await outcome2.completion : outcome2;
    expect(settled2.outcome).toBe("executed");
    expect(rt.checkpoints.listForTask(WS, TASK)).toHaveLength(2);
    expect(rt.checkpoints.latestForTask(WS, TASK)?.checkpoint_version).toBe(2);
  });
});

describe("S31 checkpoint writer — the recovery fields are validated runtime data", () => {
  it("derives the idempotency key from the execution identity for an idempotent_retry tool (deterministic, bounded, never agent-chosen)", () => {
    const rt = buildRuntime();
    const digest = canonicalArgsDigest({ path: "workspace://uploads/notes.txt" });
    const verdict = rt.checkpointService.recordFromToolExecution({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      executionId: "exe_idem_1",
      toolId: "tool_cache_refresh",
      capabilities: ["anything.else"],
      recovery: "idempotent_retry",
      riskClass: "READ_ONLY",
      argsDigest: digest,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const pending = JSON.parse(
      rt.checkpoints.latestForTask(WS, TASK)!.pending_action_json!,
    ) as Record<string, unknown>;
    expect(pending.idempotency_key).toBe(recoveryIdempotencyKeyFor("tool_cache_refresh", digest));
    expect(String(pending.idempotency_key)).toContain("tool_cache_refresh");
    expect(String(pending.idempotency_key).length).toBeLessThanOrEqual(200);
    // Deterministic: the same digest derives the SAME key (the collapse's
    // precondition) — and a replayable tool records NO key.
    expect(recoveryIdempotencyKeyFor("tool_cache_refresh", digest)).toBe(
      recoveryIdempotencyKeyFor("tool_cache_refresh", digest),
    );
    const replayable = rt.checkpointService.recordFromToolExecution({
      workspaceId: WS,
      taskId: `${TASK}_b`,
      conversationId: CONV,
      executionId: "exe_replay_1",
      toolId: "tool_document_parse",
      capabilities: ["research.parse.document"],
      recovery: "replayable",
      riskClass: "READ_ONLY",
      argsDigest: digest,
    });
    expect(replayable.ok).toBe(true);
    if (!replayable.ok) return;
    const replayPending = JSON.parse(
      rt.checkpoints.latestForTask(WS, `${TASK}_b`)!.pending_action_json!,
    ) as Record<string, unknown>;
    expect(replayPending.idempotency_key).toBeUndefined();
  });

  it("refuses a pending action whose recovery_class is not a declared E13 class (the closed enum at the writer)", () => {
    const rt = buildRuntime();
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_bad_class",
      stepKind: "tool_execution",
      pendingAction: {
        kind: "tool_execution",
        summary: "the malformed class",
        recovery_class: "auto_replay" as never,
      },
      resumeInstructions: "Resume.",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("the malformed class must refuse");
    expect(verdict.code).toBe("CHECKPOINT_INVALID");
    expect(rt.checkpoints.listForTask(WS, TASK)).toHaveLength(0);
  });

  it("refuses a pending action whose risk_class is not a declared D9 class", () => {
    const rt = buildRuntime();
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_bad_risk",
      stepKind: "tool_execution",
      pendingAction: {
        kind: "tool_execution",
        summary: "the malformed risk class",
        recovery_class: "replayable",
        risk_class: "SORT_OF_SAFE" as never,
      },
      resumeInstructions: "Resume.",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("the malformed risk class must refuse");
  });

  it("refuses a pending action whose idempotency_key exceeds the decision's bound", () => {
    const rt = buildRuntime();
    const verdict = rt.checkpointService.record({
      workspaceId: WS,
      taskId: TASK,
      conversationId: CONV,
      stepId: "step_bad_key",
      stepKind: "tool_execution",
      pendingAction: {
        kind: "tool_execution",
        summary: "the over-long key",
        recovery_class: "idempotent_retry",
        idempotency_key: "k".repeat(201),
      },
      resumeInstructions: "Resume.",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("the over-long key must refuse");
  });

  it("maps the boundary kind from the resolved definition's capability list (data, not the proposal string)", () => {
    expect(stepKindForCapabilities(["research.parse.document", "other.thing"])).toBe(
      "downloaded_document",
    );
    expect(stepKindForCapabilities(["other.thing", "research.search"])).toBe("completed_search");
    expect(stepKindForCapabilities(["other.thing"])).toBe("tool_execution");
  });
});

describe("S31 checkpoint vocabulary", () => {
  it("is the closed D33 boundary set", () => {
    expect([...CHECKPOINT_STEP_KINDS]).toEqual([
      "completed_search",
      "downloaded_document",
      "saved_artifact",
      "applied_patch",
      "completed_test_run",
      "received_approval",
      "confirmed_external_request",
      "tool_execution",
    ]);
  });
});
