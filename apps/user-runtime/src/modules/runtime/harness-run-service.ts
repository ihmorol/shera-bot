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
 *     journalled without a state change.
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
import { createTaskRunFromTypedEvent } from "../tasks/task-run-creator.ts";
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
  /** The workspace's pinned pack (D28) recorded on every run this service creates. */
  pinned_pack: PackSnapshot;
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
    const sequence = this.deps.journal.nextSequence(streamId, run.workspace_id, exec);
    const actor: Actor = { type: "runtime", id: `harness:${this.deps.adapter.harness}` };
    // The occurrence counter (not the allocation-time sequence) keys the event
    // id: skipped appends on a replayed run do not consume sequences, so a
    // sequence-derived id would fork on replay and duplicate the event.
    const occurrence = (journalEventCounts.get(proposal.event_type) ?? 0) + 1;
    journalEventCounts.set(proposal.event_type, occurrence);
    const envelope = EVENT_ENVELOPES[proposal.event_type].parse({
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
    this.appendContractEvent(envelope as TypedExecutionEvent, envelope.event_id, exec, published);
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
