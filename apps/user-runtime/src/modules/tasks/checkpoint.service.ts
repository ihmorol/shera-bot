/**
 * CheckpointService (S31 chunk 1; PRD §13, D32, D33, E13, AC19/AC25) — the
 * runtime-owned semantic checkpoint writer.
 *
 * D33: checkpoints are taken at SAFE SEMANTIC BOUNDARIES ONLY — a completed
 * search, a downloaded document, a saved artifact, an applied patch, a
 * completed test run, a received approval, a confirmed external request —
 * never per token, never on an arbitrary timer. The boundary vocabulary is
 * CLOSED DATA (CHECKPOINT_STEP_KINDS): the only writer entry point validates
 * the step kind against it, so a stream/token-style step is structurally
 * unrepresentable — the typed NON_SEMANTIC_STEP refusal is AC5's guarantee,
 * not a convention. Between checkpoints, the lightweight progress vocabulary
 * (progress.reported frames) carries the fine grain.
 *
 * ONE transaction (D23 rule 5): the durable D33 row (the v20 run_checkpoints
 * table) and the task stream's `checkpoint.taken` contract envelope commit
 * together; the envelope is the journal marker the UI timeline renders, the
 * row is the recovery payload. Idempotency is the deterministic event id
 * (`evt_checkpoint_taken_<task>_<step>_v<n>`) — a replayed step deduplicates
 * at the journal append (the winner's row is the contract, D23 rule 6).
 * checkpoint_version is monotonic per (workspace, task).
 *
 * lease_state / approval_state CAPTURE the recorded S16 lease and S20
 * approval states at the boundary — never a new mechanism. Every field is
 * bounded before any write (G3 — a checkpoint never carries secrets or
 * unbounded payloads); the caller (the executor's succeeded-execution hook,
 * the approvals decision path) supplies the record, the service validates it.
 *
 * Governing records: PRD §13, D32, D33, E13, D23 rules 5/6; AC5/AC19/AC25.
 */
import { EVENT_ENVELOPES } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { RunCheckpointsRepository } from "../../adapters/sqlite/run-checkpoints-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";
import { taskStreamId } from "./task-events.ts";

/**
 * The closed semantic-boundary vocabulary (D33's meaningful steps). A tool
 * capability maps onto it through the recorded table below; every OTHER step
 * a caller might propose (stream deltas, token ticks, timers) is outside the
 * vocabulary and refuses typed.
 */
export const CHECKPOINT_STEP_KINDS = [
  "completed_search",
  "downloaded_document",
  "saved_artifact",
  "applied_patch",
  "completed_test_run",
  "received_approval",
  "confirmed_external_request",
  "tool_execution",
] as const;
export type CheckpointStepKind = (typeof CHECKPOINT_STEP_KINDS)[number];

/**
 * Capability → boundary kind, as DATA (the recorded mapping, never prose
 * inference): searches and document fetches/parses name their specific
 * boundary; every other capability lands on the generic succeeded-tool
 * boundary.
 */
const CAPABILITY_STEP_KINDS: Readonly<Record<string, CheckpointStepKind>> = {
  "research.search": "completed_search",
  "research.fetch": "downloaded_document",
  "research.parse.document": "downloaded_document",
};

export function stepKindForCapability(capability: string): CheckpointStepKind {
  return CAPABILITY_STEP_KINDS[capability] ?? "tool_execution";
}

/** One completed action recorded at the boundary (bounded fields, G3). */
export interface CheckpointCompletedAction {
  kind: string;
  summary: string;
  /** A bounded reference (execution id, artifact uri) — never payload content. */
  ref?: string;
}

/** The action that was pending at the boundary (the recovery re-drive target). */
export interface CheckpointPendingAction {
  kind: string;
  summary: string;
  tool_id?: string;
  /** The E13 recovery class the pending tool declares (chunk 2 consumes it). */
  recovery_class?: "replayable" | "idempotent_retry" | "needs_human";
  /** The idempotency key an idempotent_retry re-drive re-executes under. */
  idempotency_key?: string;
}

export interface RecordCheckpointInput {
  workspaceId: string;
  taskId: string;
  conversationId: string;
  stepId: string;
  stepKind: CheckpointStepKind;
  completedActions?: readonly CheckpointCompletedAction[];
  pendingAction?: CheckpointPendingAction | null;
  artifactRefs?: readonly string[];
  providerUsage?: Record<string, unknown> | null;
  leaseState?: Record<string, unknown> | null;
  approvalState?: Record<string, unknown> | null;
  externalEffectState?: Record<string, unknown> | null;
  resumeInstructions: string;
}

export type RecordCheckpointResult =
  | { ok: true; stepId: string; checkpointVersion: number; eventId: string }
  | {
      ok: false;
      code: "NON_SEMANTIC_STEP" | "CHECKPOINT_INVALID";
      safeMessage: string;
      detail: Record<string, unknown>;
    };

/** The field bounds (G3: bounded payloads or the record refuses). */
const MAX_STEP_ID = 128;
const MAX_RESUME_INSTRUCTIONS = 2_000;
const MAX_COMPLETED_ACTIONS = 50;
const MAX_ACTION_KIND = 80;
const MAX_ACTION_SUMMARY = 500;
const MAX_ACTION_REF = 200;
const MAX_ARTIFACT_REFS = 50;
const MAX_ARTIFACT_REF = 200;
const MAX_JSON_BYTES = 8_192;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown): { ok: true; text: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true, text: null };
  }
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > MAX_JSON_BYTES) {
      return { ok: false };
    }
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}

export interface CheckpointServiceDeps {
  tx: SqliteTransactions;
  /** The ONLY journal seam (no second journal). */
  journal: Pick<EventJournalRepository, "nextSequence" | "readFrom" | "findById">;
  events: Pick<EventsService, "appendEvent">;
  checkpoints: RunCheckpointsRepository;
  /** Injectable ISO clock; default wall clock. */
  now?: (() => string) | undefined;
  /** Post-commit live fanout (the WS gateway); optional. */
  publish?: ((event: EventEnvelope) => void) | undefined;
}

export class CheckpointService {
  constructor(private readonly deps: CheckpointServiceDeps) {}

  /** One task's checkpoints, ascending by version. */
  listForTask(workspaceId: string, taskId: string) {
    return this.deps.checkpoints.listForTask(workspaceId, taskId);
  }

  /** The newest checkpoint of one task, or null. */
  latestForTask(workspaceId: string, taskId: string) {
    return this.deps.checkpoints.latestForTask(workspaceId, taskId);
  }

  /**
   * The S21 executor's port: one succeeded tool execution, mapped onto the
   * boundary vocabulary through the recorded capability table. The record is
   * digest/pointer-shaped (G3) — the tool identity, its DECLARED recovery
   * class (E13 data, never inference), and the settled confirmation; never
   * result content (the executor's own history row is the redacted record).
   */
  recordFromToolExecution(input: {
    workspaceId: string;
    taskId: string;
    conversationId: string;
    executionId: string;
    toolId: string;
    capability: string;
    recovery: "replayable" | "idempotent_retry" | "needs_human";
  }): RecordCheckpointResult {
    return this.record({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      conversationId: input.conversationId,
      stepId: `step_tool_${input.executionId}`,
      stepKind: stepKindForCapability(input.capability),
      completedActions: [
        {
          kind: "tool_execution",
          summary: `${input.toolId} completed`,
          ref: `execution:${input.executionId}`,
        },
      ],
      pendingAction: null,
      artifactRefs: [],
      externalEffectState: {
        tool_id: input.toolId,
        capability: input.capability,
        recovery_class: input.recovery,
        execution_id: input.executionId,
        settled: "confirmed",
      },
      resumeInstructions: `Resume after ${input.toolId} (${input.capability}); re-drive the pending plan from this step.`,
    });
  }

  /**
   * Take ONE semantic checkpoint: validate the boundary, write the durable
   * D33 row + the journal marker in one transaction, publish post-commit.
   * Never throws — a refused or failed checkpoint is a typed result (a
   * checkpoint gap is honest; a crashed caller is not acceptable).
   */
  record(input: RecordCheckpointInput): RecordCheckpointResult {
    // 1. The AC5 boundary gate: only the closed semantic vocabulary writes.
    if (!(CHECKPOINT_STEP_KINDS as readonly string[]).includes(input.stepKind)) {
      return {
        ok: false,
        code: "NON_SEMANTIC_STEP",
        safeMessage: "Checkpoints are taken only at semantic boundaries.",
        detail: {
          // The closed vocabulary is schema knowledge, not payload content (G3).
          allowed_step_kinds: [...CHECKPOINT_STEP_KINDS],
        },
      };
    }

    // 2. Field bounds (G3).
    const stepId = input.stepId;
    if (typeof stepId !== "string" || stepId.length < 1 || stepId.length > MAX_STEP_ID) {
      return invalid("step id must be 1..128 characters");
    }
    const resume = input.resumeInstructions;
    if (
      typeof resume !== "string" ||
      resume.trim().length < 1 ||
      resume.length > MAX_RESUME_INSTRUCTIONS
    ) {
      return invalid("resume instructions must be 1..2000 characters");
    }
    const completedActions = input.completedActions ?? [];
    if (completedActions.length > MAX_COMPLETED_ACTIONS) {
      return invalid(`at most ${MAX_COMPLETED_ACTIONS} completed actions per checkpoint`);
    }
    for (const action of completedActions) {
      if (
        typeof action.kind !== "string" ||
        action.kind.length < 1 ||
        action.kind.length > MAX_ACTION_KIND ||
        typeof action.summary !== "string" ||
        action.summary.length < 1 ||
        action.summary.length > MAX_ACTION_SUMMARY ||
        (action.ref !== undefined &&
          (typeof action.ref !== "string" || action.ref.length > MAX_ACTION_REF))
      ) {
        return invalid("completed actions must be bounded kind/summary/ref records");
      }
    }
    const artifactRefs = input.artifactRefs ?? [];
    if (artifactRefs.length > MAX_ARTIFACT_REFS) {
      return invalid(`at most ${MAX_ARTIFACT_REFS} artifact refs per checkpoint`);
    }
    for (const ref of artifactRefs) {
      if (typeof ref !== "string" || ref.length < 1 || ref.length > MAX_ARTIFACT_REF) {
        return invalid("artifact refs must be bounded strings");
      }
    }
    if (input.pendingAction !== undefined && input.pendingAction !== null) {
      const pending = input.pendingAction;
      if (
        !isPlainObject(pending) ||
        typeof pending.kind !== "string" ||
        pending.kind.length < 1 ||
        pending.kind.length > MAX_ACTION_KIND ||
        typeof pending.summary !== "string" ||
        pending.summary.length < 1 ||
        pending.summary.length > MAX_ACTION_SUMMARY
      ) {
        return invalid("the pending action must be a bounded kind/summary record");
      }
    }
    const completedJson = boundedJson(completedActions);
    const refsJson = boundedJson(artifactRefs);
    const pendingJson = boundedJson(input.pendingAction ?? null);
    const providerJson = boundedJson(input.providerUsage ?? null);
    const leaseJson = boundedJson(input.leaseState ?? null);
    const approvalJson = boundedJson(input.approvalState ?? null);
    const effectsJson = boundedJson(input.externalEffectState ?? null);
    for (const bounded of [
      completedJson,
      refsJson,
      pendingJson,
      providerJson,
      leaseJson,
      approvalJson,
      effectsJson,
    ]) {
      if (!bounded.ok) {
        return invalid("a checkpoint field exceeded its bounded JSON budget");
      }
    }

    const now = this.deps.now ? this.deps.now() : new Date().toISOString();

    // 3. ONE transaction: version, durable row, journal marker (D23 rule 5).
    let version = 0;
    let eventId = "";
    try {
      this.deps.tx.transaction((exec) => {
        // Idempotent replay: a checkpoint for THIS step already exists — the
        // winner's row is the contract (D23 rule 6), return it as success.
        // (A re-evaluated boundary is a NEW step id, not a rewrite of taken
        // evidence.)
        const existing = this.deps.checkpoints.findByStep(
          input.workspaceId,
          input.taskId,
          stepId,
          exec,
        );
        if (existing !== null) {
          version = existing.checkpoint_version;
          eventId = `evt_checkpoint_taken_${input.taskId}_${stepId}_v${existing.checkpoint_version}`;
          return;
        }
        version = this.deps.checkpoints.countForTask(input.workspaceId, input.taskId, exec) + 1;
        eventId = `evt_checkpoint_taken_${input.taskId}_${stepId}_v${version}`;
        const row = this.deps.checkpoints.insert(
          {
            workspace_id: input.workspaceId,
            task_id: input.taskId,
            step_id: stepId,
            checkpoint_version: version,
            step_kind: input.stepKind,
            completed_actions_json: completedJson.ok ? (completedJson.text ?? "[]") : "[]",
            pending_action_json: pendingJson.ok ? pendingJson.text : null,
            artifact_refs_json: refsJson.ok ? (refsJson.text ?? "[]") : "[]",
            provider_usage_json: providerJson.ok ? providerJson.text : null,
            lease_state_json: leaseJson.ok ? leaseJson.text : null,
            approval_state_json: approvalJson.ok ? approvalJson.text : null,
            external_effect_state_json: effectsJson.ok ? effectsJson.text : null,
            resume_instructions: resume,
            created_at: now,
          },
          exec,
        );
        const sequence = this.deps.journal.nextSequence(
          taskStreamId(input.taskId),
          input.workspaceId,
          exec,
        );
        const envelope = EVENT_ENVELOPES["checkpoint.taken"].parse({
          event_id: eventId,
          event_type: "checkpoint.taken",
          stream_id: taskStreamId(input.taskId),
          sequence,
          event_version: 1,
          actor: { type: "runtime", id: "runtime-gateway" },
          task_id: input.taskId,
          conversation_id: input.conversationId,
          occurred_at: now,
          redaction_class: "public",
          payload: { step_id: row.step_id, checkpoint_version: row.checkpoint_version },
        });
        // The full contract envelope IS the journal payload (the D26 task-
        // event discipline — the registry validates the whole envelope).
        this.deps.events.appendEvent({
          event_id: eventId,
          stream_id: taskStreamId(input.taskId),
          type: "checkpoint.taken",
          payload: envelope,
          workspace_id: input.workspaceId,
          correlation_id: eventId,
        });
      });
    } catch (error) {
      // Contained: a failed checkpoint write is a typed refusal, never a
      // crashed caller (the boundary evidence stays in the caller's record).
      return {
        ok: false,
        code: "CHECKPOINT_INVALID",
        safeMessage: "The checkpoint could not be recorded.",
        detail: {
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }

    // 4. Post-commit fanout (contained).
    if (this.deps.publish) {
      try {
        const published = this.deps.journal.findById(input.workspaceId, eventId);
        if (published) {
          this.deps.publish({
            event_id: published.event_id,
            stream_id: published.stream_id,
            sequence: published.sequence,
            type: "checkpoint.taken",
            schema_version: published.schema_version,
            payload: JSON.parse(published.payload) as never,
            workspace_id: published.workspace_id,
            occurred_at: published.occurred_at,
            correlation_id: published.correlation_id,
          });
        }
      } catch {
        // A fanout failure never invalidates the committed checkpoint (B4).
      }
    }

    return { ok: true, stepId, checkpointVersion: version, eventId };
  }
}

function invalid(message: string): RecordCheckpointResult {
  return {
    ok: false,
    code: "CHECKPOINT_INVALID",
    safeMessage: "The checkpoint record was not valid.",
    detail: { reason: message },
  };
}
