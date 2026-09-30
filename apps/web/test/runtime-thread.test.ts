import { describe, expect, it } from "vitest";

import { threadItemsFromEvents } from "../lib/runtime-thread";
import type { RuntimeEvent } from "../lib/runtime-client";

/**
 * Real journal events → thread items (S09 chunk 1): the thread shows the
 * conversation's REAL lifecycle and never fabricates message content (G4).
 */

function event(overrides: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">): RuntimeEvent {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2)}`,
    stream_id: "conversation:abc",
    sequence: 1,
    schema_version: 1,
    payload: {},
    workspace_id: "ws_account-1",
    occurred_at: "2026-09-30T10:00:00Z",
    correlation_id: "corr-1",
    ...overrides,
  };
}

describe("threadItemsFromEvents", () => {
  it("a created event is a system record of the real lifecycle, not a chat message", () => {
    const items = threadItemsFromEvents([
      event({ type: "conversation.created", payload: { title: "General Assistant" } }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "system",
      at: "2026-09-30T10:00:00Z",
    });
    expect(items[0]!.kind === "system" && items[0]!.text).toContain("General Assistant");
    // G4: no message item, no agent attribution, no fabricated sender.
    expect(items.every((item) => item.kind === "system")).toBe(true);
  });

  it("a renamed event records the real new title", () => {
    const items = threadItemsFromEvents([
      event({ type: "conversation.renamed", payload: { title: "Thesis planning" } }),
    ]);
    expect(items[0]!.kind === "system" && items[0]!.text).toContain("Thesis planning");
  });

  it("events render in journal order (occurred_at, then kind rank)", () => {
    const items = threadItemsFromEvents([
      event({ type: "conversation.renamed", occurred_at: "2026-09-30T11:00:00Z" }),
      event({ type: "conversation.created", occurred_at: "2026-09-30T10:00:00Z" }),
    ]);
    expect(items[0]!.kind === "system" && items[0]!.text).toContain("started");
  });

  it("unknown event types surface verbatim — never silently dropped", () => {
    const items = threadItemsFromEvents([event({ type: "conversation.archived" })]);
    expect(items[0]!.kind === "system" && items[0]!.text).toContain("conversation.archived");
  });
});
