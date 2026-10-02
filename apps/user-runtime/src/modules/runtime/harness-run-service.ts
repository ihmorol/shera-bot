/**
 * Harness run service (S07; D51, G2, D23 rule 5/6, D34).
 *
 * The GATEWAY side of the harness-agnostic seam: adapters PROPOSE, this
 * service validates and executes. A task run is created ONLY from a typed
 * trigger event (D34/G2 — the creator rejects everything else as typed
 * values); each adapter proposal is then applied through the gateway's own
 * machinery inside ONE transaction:
 *
 *   - task_command proposals -> parseTaskCommand -> evaluateTaskTransition
 *     (the D8 table; typed rejections are recorded as data, never thrown);
 *   - journal_event proposals -> parsed against the D26 envelope contract and
 *     journalled without a state change; a proposal that fails the envelope
 *     contract is a typed rejection recorded as data — the run continues (B2;
 *     adapters are untrusted, their faults never crash the gateway).
 *
 * Every applied unit journals its FULL contract-valid D26 envelope as the
 * journal row payload (the envelope IS the durable event; the registry
 * validates it at append and replay). Idempotency: journal rows are keyed by
 * event_id, so replaying the same trigger through the deterministic fake
 * appends nothing new and fans out nothing twice.
 *
 * Live fanout happens strictly AFTER the transaction commits (AC8) through
 * the injected publish hook — the WebSocket layer implements it and owns no
 * mutation path (D26).
 */
import type { ZodType } from "zod";

import {
  EVENT_ENVELOPES,
  type Actor,
  type PackSnapshot,
  type RunState,
  type TaskJournalEventType,
  type TaskPolicy,
  type TaskRejection,
  type TaskRun,
  type TypedExecutionEvent,
} from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type {
  HarnessAdapter,
  HarnessProposal,
  HarnessRunRequest,
} from "../../adapters/process/harness-adapter.ts";
import { parseTaskCommand, evaluateTaskTransition } from "../tasks/task-transitions.ts";
import { createTaskRunFromTypedEvent, type PackDefinitions } from "../tasks/task-run-creator.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import type { EventsService } from "../events/events.service.ts";

export interface HarnessRunServiceDeps {
  adapter: HarnessAdapter;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  events: EventsService;
  /** Post-commit live fanout (WS gateway); optional in tests. */
  publish?: (event: EventEnvelope) => void;
  pinned_pack: PackSnapshot;
  /**
   * S10 (D29): the pinned pack's DEFINITIONS, from which the creation-time
   * skill/connector/provider snapshots resolve. Optional for direct service
   * callers (older tests); the runtime composition always supplies it, and
   * every runtime-created run stamps all resolvable fields. Typed as the
   * creator's structural PackDefinitions: BOTH the contracts Pack and the
   * agent-pack-sdk PackManifest satisfy it (no conversion layer).
   */
  pack_content?: PackDefinitions;
  /** E12: the container's default workspace (the prototype has one). */
  workspace_id: string;
  policy: TaskPolicy;
  now?: () => string;
}

export type HarnessStartRunResult =
  | {
      ok: true;
      task_id: string;
      workspace_id: string;
      state: RunState;
      version: number;
      /** Journal envelopes appended by THIS call (empty on an idempotent replay). */
      journal_events: EventEnvelope[];
      /** Typed rejections from adapter proposals — data for the journal, not throws. */
      rejections: TaskRejection[];
    }
  | {
      ok: false;
      reason: "not_a_typed_event" | "not_a_task_trigger";
      code: string;
      safe_message: string;
      detail: Record<string, unknown> | null;
    };

export class HarnessRunService {
  constructor(private readonly deps: HarnessRunServiceDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /**
   * Create a task run from a typed trigger and drive it through the adapter.
   * The whole unit — run creation, every proposal execution, every journal
   * append — commits atomically (D23 rule 5).
   */
  startRun(rawTrigger: unknown): HarnessStartRunResult {
    // The creator is pure: run it first to derive the run (and its typed
    // rejections for anything that is not a D34 trigger — this is where
    // natural language dies, G2).
    const created = createTaskRunFromTypedEvent(rawTrigger, {
      pinned_pack: this.deps.pinned_pack,
      ...(this.deps.pack_content ? { pack_content: this.deps.pack_content } : {}),
      workspace_id: this.deps.workspace_id,
      clock: { now: this.now(), next_sequence: 1 },
    });
    if (!created.ok) {
      return {
        ok: false,
        reason: created.rejection.kind,
        code: created.rejection.code,
        safe_message: created.rejection.safe_message,
        detail: created.rejection.detail,
      };
    }

    const run = created.run;
    const published: EventEnvelope[] = [];
    const rejections: TaskRejection[] = [];
    const appliedKeys = new Set<string>();
    // Occurrence counters per journal-event type: event ids stay stable across
    // deterministic replays (the Nth progress report of a run is always the
    // Nth) while repeated reports of one type remain distinct events.
    const journalEventCounts = new Map<TaskJournalEventType, number>();

    this.deps.tx.transaction((exec) => {
      // Creation event first (idempotent by event_id on a replayed trigger).
      this.appendContractEvent(
        created.creation_event,
        created.creation_event.event_id,
        exec,
        published,
      );

      // The adapter drives the run synchronously inside the same atomic unit.
      const request: HarnessRunRequest = {
        workspace_id: run.workspace_id,
        task_id: run.task_id,
        conversation_id: run.conversation_id,
      };
      const sink = {
        propose: (proposal: HarnessProposal) => {
          const next = this.applyProposal(
            run,
            appliedKeys,
            journalEventCounts,
            proposal,
            exec,
            published,
            rejections,
          );
          Object.assign(run, next);
        },
      };
      this.deps.adapter.driveRun(request, sink);
    });

    for (const event of published) {
      this.deps.publish?.(event);
    }

    return {
      ok: true,
      task_id: run.task_id,
      workspace_id: run.workspace_id,
      state: run.state,
      version: run.version,
      journal_events: published,
      rejections,
    };
  }

  /**
   * Validate and execute one proposal (G2). Returns the run's next projection;
   * rejected proposals are recorded as data and never mutate the run.
   *
   * The projection lives IN MEMORY for the duration of startRun: task runs
   * have no durable table, and restart recovery from the journal is deferred
   * to the recovery slice (S31). The DURABLE record is the journal itself —
   * every applied unit is a contract-valid D26 envelope row — but nothing
   * rebuilds task-run state from it yet. (Conversation projections rebuild
   * from the journal today: conversations.projection.ts.)
   */
  private applyProposal(
    run: TaskRun,
    appliedKeys: Set<string>,
    journalEventCounts: Map<TaskJournalEventType, number>,
    proposal: HarnessProposal,
    exec: SqliteExec,
    published: EventEnvelope[],
    rejections: TaskRejection[],
  ): TaskRun {
    const streamId = taskStreamId(run.task_id);

    if (proposal.kind === "task_command") {
      const parsed = parseTaskCommand(proposal.command);
      if (!parsed.ok) {
        rejections.push(parsed.rejection);
        return run;
      }
      const command = parsed.command;
      // Allocate the stream sequence first; the D26 envelope embeds it so the
      // journalled payload and the journal row agree (D26 gapless cursors).
      const sequence = this.deps.journal.nextSequence(streamId, run.workspace_id, exec);
      const verdict = evaluateTaskTransition({
        run,
        command,
        policy: this.deps.policy,
        applied_idempotency_keys: [...appliedKeys],
        clock: { now: this.now(), next_sequence: sequence },
      });
      if (!verdict.ok) {
        rejections.push(verdict.rejection);
        return run;
      }
      // The transition is journalled either way (a null append means the
      // event_id already exists from a previous, identical run): the
      // projection advances so a replayed deterministic script lines up with
      // the journal instead of recording spurious version conflicts.
      this.appendContractEvent(verdict.emitted_event, command.command_id, exec, published);
      appliedKeys.add(command.idempotency_key);
      return { ...run, state: verdict.to, version: verdict.next_version, updated_at: this.now() };
    }

    // journal_event proposal: durable, non-transition (progress/artifact/checkpoint).
    // C-1: the registry lookup is GUARDED. TypeScript narrows event_type to
    // the D26 vocabulary, but adapter values are RUNTIME data (D51/G2 —
    // adapters are untrusted), so an unregistered type must be a typed
    // rejection recorded as data, never an undefined-schema crash (the exact
    // crash class B2 fixed). The run continues; nothing is appended or fanned
    // out, and the unregistered value surfaces only as the rejection's
    // event_type detail (schema vocabulary, not payload content — G3).
    const envelopeSchema = (EVENT_ENVELOPES as Record<string, ZodType | undefined>)[
      proposal.event_type
    ];
    if (!envelopeSchema) {
      rejections.push({
        kind: "malformed_command",
        code: "JOURNAL_EVENT_UNKNOWN_TYPE",
        safe_message: `The proposed journal event ${proposal.event_type} is not in the D26 envelope registry.`,
        detail: {
          event_type: proposal.event_type,
          registered_types: Object.keys(EVENT_ENVELOPES),
        },
      });
      return run;
    }
    const sequence = this.deps.journal.nextSequence(streamId, run.workspace_id, exec);
    const actor: Actor = { type: "runtime", id: `harness:${this.deps.adapter.harness}` };
    // The occurrence counter (not the allocation-time sequence) keys the event
    // id: skipped appends on a replayed run do not consume sequences, so a
    // sequence-derived id would fork on replay and duplicate the event.
    const occurrence = (journalEventCounts.get(proposal.event_type) ?? 0) + 1;
    journalEventCounts.set(proposal.event_type, occurrence);
    // Adapters are UNTRUSTED (D51/G2): a proposal that fails the D26 envelope
    // contract is a typed rejection recorded as data — exactly like a failed
    // command proposal — and the run continues. Nothing is appended or fanned
    // out, and the raw invalid payload never enters the journal or the
    // rejection detail (G3): only the schema's own issues (paths + messages,
    // no received values) are recorded.
    const parsedEnvelope = envelopeSchema.safeParse({
      event_id: `evt_${proposal.event_type.replaceAll(".", "_")}_${run.task_id}_${occurrence}`,
      event_type: proposal.event_type,
      stream_id: streamId,
      sequence,
      event_version: 1,
      actor,
      task_id: run.task_id,
      conversation_id: run.conversation_id,
      occurred_at: this.now(),
      redaction_class: "public",
      payload: proposal.payload,
    });
    if (!parsedEnvelope.success) {
      rejections.push({
        kind: "malformed_command",
        code: "JOURNAL_EVENT_MALFORMED",
        safe_message: `The proposed journal event ${proposal.event_type} failed the D26 envelope contract.`,
        detail: {
          event_type: proposal.event_type,
          issues: parsedEnvelope.error.issues.map((issue) => ({
            path: issue.path.map(String).join("."),
            message: issue.message,
          })),
        },
      });
      return run;
    }
    // safeParse's output is `unknown` through the guarded lookup (C-1); the
    // cast is justified because the envelope schema IS the D26 contract for
    // this event type — the parse just proved it.
    const envelope = parsedEnvelope.data as TypedExecutionEvent;
    this.appendContractEvent(envelope, envelope.event_id, exec, published);
    return run;
  }

  /**
   * Journal one contract-valid D26 envelope: the full envelope is the row
   * payload (the registry validates it — G2), the row columns carry storage
   * identity. A pre-existing event_id means an idempotent replay: nothing is
   * appended and nothing is published (exactly-once fanout).
   */
  private appendContractEvent(
    event: TypedExecutionEvent,
    correlationId: string,
    exec: SqliteExec,
    published: EventEnvelope[],
  ): EventEnvelope | null {
    const existing = this.deps.journal.findById(this.deps.workspace_id, event.event_id, exec);
    if (existing) {
      return null;
    }
    const appended = this.deps.events.appendEvent({
      event_id: event.event_id,
      stream_id: event.stream_id,
      type: event.event_type,
      payload: event,
      workspace_id: this.deps.workspace_id,
      correlation_id: correlationId,
    });
    published.push(appended);
    return appended;
  }
}
