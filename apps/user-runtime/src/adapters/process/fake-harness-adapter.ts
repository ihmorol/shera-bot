/**
 * FakeHarnessAdapter — the deterministic in-process harness (S07; D51, G4).
 *
 * Drives a task run end-to-end with a FIXED D8 script: queue -> start -> one
 * progress report -> complete. No real processes, no timers, no child
 * processes, no I/O — every proposal is emitted synchronously in the same
 * order for the same run request, so later slices and tests run the gateway
 * deterministically without any real harness. The process-backed Pi adapter
 * is a later slice.
 *
 * S20 chunk 4: an OPTIONAL scripted TYPED tool proposal (G2) can be
 * configured — when present the script additionally proposes one durable
 * `tool.proposed` journal event while the run is RUNNING (right after start).
 * What the proposal authorizes is the GATEWAY's decision (the approvals seam
 * in HarnessRunService), never this adapter's; without the option the script
 * is exactly the pre-S20 one (G4).
 */
import type {
  HarnessAdapter,
  HarnessEventSink,
  HarnessName,
  HarnessRunRequest,
} from "./harness-adapter.ts";

/** The scripted tool proposal's D26 payload fields (digest-only — G3). */
export interface FakeHarnessToolProposal {
  tool_id: string;
  tool_version: string;
  args_digest: string;
  proposal_summary: string;
}

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly harness: HarnessName = "fake";

  constructor(
    private readonly options: {
      now?: () => string;
      toolProposal?: FakeHarnessToolProposal;
    } = {},
  ) {}

  driveRun(request: HarnessRunRequest, sink: HarnessEventSink): void {
    const issued_at = this.options.now ? this.options.now() : new Date().toISOString();
    const actor = { type: "runtime" as const, id: `harness:${this.harness}` };
    const base = {
      workspace_id: request.workspace_id,
      task_id: request.task_id,
      actor,
      issued_at,
    };

    // The scripted D8 path (versions follow the creator: run starts at v1):
    // CREATED -> QUEUED -> RUNNING -> SUCCEEDED, with one progress report.
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
    // S20 chunk 4: the scripted TYPED tool proposal, proposed while the run is
    // RUNNING (v3). A gated risk class then pauses the run through the
    // gateway's approvals seam; the script's complete_task below is rejected
    // as typed data (an approval waits — G5) and the run stays paused.
    if (this.options.toolProposal) {
      sink.propose({
        kind: "journal_event",
        event_type: "tool.proposed",
        payload: { ...this.options.toolProposal },
      });
    }
    sink.propose({
      kind: "journal_event",
      event_type: "progress.reported",
      payload: { summary: "fake harness made deterministic progress", fraction: 0.5 },
    });
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
