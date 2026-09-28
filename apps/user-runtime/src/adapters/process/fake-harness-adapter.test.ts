/**
 * FakeHarnessAdapter tests (S07; D51, G4).
 *
 * The fake is the seam later slices drive deterministically: its script must
 * be a fixed, synchronous, timer-free D8 walk per run request — the same
 * proposals in the same order every time, with no processes and no I/O.
 */
import { describe, expect, it } from "vitest";

import type { HarnessProposal } from "./harness-adapter.ts";
import { FakeHarnessAdapter } from "./fake-harness-adapter.ts";

const REQUEST = {
  workspace_id: "ws-11111111-1111-4111-8111-111111111111",
  task_id: "task_evt_abc",
  conversation_id: "conv_001",
} as const;

function collect(): { proposals: HarnessProposal[]; sink: { propose(p: HarnessProposal): void } } {
  const proposals: HarnessProposal[] = [];
  return { proposals, sink: { propose: (p) => proposals.push(p) } };
}

describe("FakeHarnessAdapter — the deterministic D51 seam", () => {
  it("emits a fixed queue -> start -> progress -> complete script", () => {
    const adapter = new FakeHarnessAdapter();
    const { proposals, sink } = collect();

    adapter.driveRun(REQUEST, sink);

    expect(adapter.harness).toBe("fake");
    expect(proposals.map((p) => p.kind)).toEqual([
      "task_command",
      "task_command",
      "journal_event",
      "task_command",
    ]);

    const commands = proposals
      .filter((p): p is Extract<HarnessProposal, { kind: "task_command" }> => p.kind === "task_command")
      .map((p) => p.command as Record<string, unknown>);
    expect(commands.map((c) => c["type"])).toEqual(["queue_task", "start_task", "complete_task"]);
    // G2: proposals are typed commands carrying the full D23 rule 6 envelope.
    expect(commands[0]).toMatchObject({
      workspace_id: REQUEST.workspace_id,
      task_id: REQUEST.task_id,
      expected_version: 1,
      actor: { type: "runtime", id: "harness:fake" },
    });
    // Optimistic versions follow the creator's v1 start.
    expect(commands.map((c) => c["expected_version"])).toEqual([1, 2, 3]);
    // Idempotency keys are data and unique per command (D23 rule 6).
    expect(new Set(commands.map((c) => c["idempotency_key"])).size).toBe(3);

    const progress = proposals[2] as Extract<HarnessProposal, { kind: "journal_event" }>;
    expect(progress.event_type).toBe("progress.reported");
    expect(progress.payload).toMatchObject({ summary: expect.any(String), fraction: 0.5 });
  });

  it("is deterministic: identical proposals (modulo the clock) for identical run requests", () => {
    const adapter = new FakeHarnessAdapter({ now: () => "2026-09-28T00:00:00.000Z" });
    const first = collect();
    const second = collect();

    adapter.driveRun(REQUEST, first.sink);
    adapter.driveRun(REQUEST, second.sink);

    expect(second.proposals).toEqual(first.proposals);
    expect(JSON.stringify(second.proposals)).not.toContain("child_process");
  });

  it("never blocks: the whole script is emitted synchronously", () => {
    const adapter = new FakeHarnessAdapter();
    const { proposals, sink } = collect();
    adapter.driveRun(REQUEST, sink);
    // A synchronous drive means the sink has seen everything on return.
    expect(proposals.length).toBe(4);
  });
});
