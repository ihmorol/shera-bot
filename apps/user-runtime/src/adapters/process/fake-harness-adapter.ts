/**
 * FakeHarnessAdapter — the deterministic in-process harness (S07; D51, G4).
 *
 * Drives a task run end-to-end with a FIXED D8 script: queue -> start -> one
 * progress report -> complete. No real processes, no timers, no child
 * processes, no I/O — every proposal is emitted synchronously in the same
 * order for the same run request, so later slices and tests run the gateway
 * deterministically without any real harness. The process-backed Pi adapter
 * is a later slice.
 */
import type {
  HarnessAdapter,
  HarnessEventSink,
  HarnessName,
  HarnessRunRequest,
} from "./harness-adapter.ts";

export class FakeHarnessAdapter implements HarnessAdapter {
  readonly harness: HarnessName = "fake";

  constructor(private readonly options: { now?: () => string } = {}) {}

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
