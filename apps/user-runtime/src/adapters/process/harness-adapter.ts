/**
 * HarnessAdapter — the harness-agnostic adapter seam (S07; D51).
 *
 * The gateway speaks ONLY to this contract, never to Pi specifics: Pi is the
 * default harness and Hermes is selectable per Agent later (D51). The seam is
 * PROPOSAL-ONLY (G2 — agents propose; the runtime gateway validates and
 * executes): an adapter hands the gateway typed proposals, and every proposal
 * goes through the gateway's own validation (the task command contract and
 * transition table, the D26 envelope contract) before anything is journalled.
 * No natural-language classification exists on either side of this seam.
 *
 * Placement (D23 module shape): the contract lives under adapters/process/
 * with the adapters that implement it — the real Pi adapter is a later slice
 * and will run real processes; the deterministic FAKE (fake-harness-adapter)
 * has no processes, no timers, no I/O beyond what the gateway journals.
 */
import type { TaskJournalEventType, TaskTriggerEventType } from "@shera-bot/contracts";

/** What the gateway asks the harness to drive: one existing task run. */
export interface HarnessRunRequest {
  workspace_id: string;
  task_id: string;
  conversation_id: string;
}

/**
 * A proposal across the seam. `task_command` proposals are applied through the
 * D8 transition table (the run's state machine); `journal_event` proposals are
 * non-transition durable events journalled on the run's stream without
 * changing its state — the execution-journal vocabulary (progress/artifact/
 * checkpoint) AND the D34 trigger vocabulary (S20 chunk 4: a TYPED
 * `tool.proposed` proposed MID-RUN by the scripted harness rides here; the
 * gateway journals it through the unchanged D26 registry path and, through
 * the approvals delegate, runs the approval boundary over it). The gateway
 * validates every proposal against the D26 envelope registry regardless of
 * which side of this union it lands on — no adapter is trusted (G2).
 */
export type HarnessProposal =
  | { kind: "task_command"; command: unknown }
  | {
      kind: "journal_event";
      event_type: TaskJournalEventType | TaskTriggerEventType;
      payload: Record<string, unknown>;
    };

export interface HarnessEventSink {
  /** Propose one unit of work; the gateway validates and executes (or rejects). */
  propose(proposal: HarnessProposal): void;
}

/** Harness identity (D51: Pi default, Hermes selectable; "fake" drives tests). */
export type HarnessName = "pi" | "hermes" | "fake";

export interface HarnessAdapter {
  readonly harness: HarnessName;
  /**
   * Drive one task run to completion by proposing through the sink.
   * Implementations MUST be deterministic per run request — no wall-clock
   * branching, no timers, no threads, no child processes (G4: the prototype
   * seam is fully reproducible; the process-backed adapter is a later slice).
   */
  driveRun(request: HarnessRunRequest, sink: HarnessEventSink): void;
}
