/**
 * kill -9 recovery probe (S09 chunk 3; D10/E13, E8 mock mode).
 *
 * The ONE probe an in-process test cannot run: the mock runtime is a REAL OS
 * process (apps/user-runtime/src/mock/mock-runtime-main.ts), driven over its
 * real HTTP surface, killed with SIGKILL mid-reply-stream, and restarted on
 * the SAME SQLite file. It asserts the durable promises after an abrupt crash:
 *
 * - the journal is intact: exactly the committed events, contiguous
 *   sequences, the pre-crash receipt still replaying (AC2/D23 rule 6);
 * - the conversation loads correctly on the restarted process;
 * - NOTHING is invented: the in-flight reply (transient deltas, durable
 *   reply not yet committed at kill time) appears nowhere after the restart —
 *   only persisted events render (G4/E10).
 *
 * SQLite's WAL mode is the D10 recovery mechanism under probe: a SIGKILL
 * cannot corrupt the journal — the restart replays the committed prefix.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { startMockRuntimeProcess, waitForHealth } from "../helpers/mock-runtime-process.ts";

const tempDirs: string[] = [];
const WORKSPACE = "ws-local-default";
const SEED_KEY = "s09-kill9-seed-v1";
const SEND_KEY = "s09-kill9-send-1";
const SEND_TEXT = "Outline a plan for my thesis chapter, please.";

interface CommandResponse {
  status: number;
  body: Record<string, unknown>;
}

async function postCommand(
  origin: string,
  body: Record<string, unknown>,
): Promise<CommandResponse> {
  const response = await fetch(`${origin}/v1/conversations/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function replay(
  origin: string,
  conversationId: string,
): Promise<{
  kind: string;
  events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
}> {
  const response = await fetch(
    `${origin}/v1/conversations/${conversationId}/events?workspace_id=${WORKSPACE}&last_acknowledged_sequence=0`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    kind: string;
    events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("recovery: kill -9 mid-reply-stream, restart on the same database", () => {
  it("recovers the committed prefix exactly, replays the receipt, invents nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-kill9-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "runtime.db");

    // 1. Start the runtime as a real process and commit a user turn.
    const first = await startMockRuntimeProcess({ dbPath });
    try {
      await waitForHealth(first.origin);

      const created = await postCommand(first.origin, {
        type: "conversation.create",
        workspace_id: WORKSPACE,
        idempotency_key: SEED_KEY,
        payload: { title: "General Assistant" },
      });
      expect(created.status).toBe(200);
      const conversationId = created.body["conversation_id"] as string;

      const sent = await postCommand(first.origin, {
        type: "message.send",
        workspace_id: WORKSPACE,
        idempotency_key: SEND_KEY,
        payload: {
          conversation_id: conversationId,
          text: SEND_TEXT,
          sender: { kind: "user", display_name: "Emon" },
        },
      });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({ kind: "message_sent", conversation_id: conversationId });
      const messageId = sent.body["message_id"] as string;

      // 2. Kill -9 MID-STREAM: the scripted reply streams ~15ms deltas and
      // commits its durable reply only after the full burst (~500ms). The
      // kill lands inside the window — deltas in flight, reply uncommitted.
      await new Promise((resolve) => setTimeout(resolve, 40));
      await first.kill9();

      // 3. Restart on the SAME database file.
      const second = await startMockRuntimeProcess({ dbPath });
      try {
        await waitForHealth(second.origin);

        // The conversation loads: the seed receipt replays to the SAME row.
        const recreated = await postCommand(second.origin, {
          type: "conversation.create",
          workspace_id: WORKSPACE,
          idempotency_key: SEED_KEY,
          payload: { title: "General Assistant" },
        });
        expect(recreated.status).toBe(200);
        expect(recreated.body["conversation_id"]).toBe(conversationId);

        // The journal is intact: exactly the committed prefix, contiguous
        // sequences, and NO agent reply — the in-flight stream is gone, and
        // nothing fabricated takes its place (G4/E10).
        const events = await replay(second.origin, conversationId);
        expect(events.kind).toBe("events");
        expect(events.events.map((event) => event.type)).toEqual([
          "conversation.created",
          "message.appended",
        ]);
        expect(events.events.map((event) => event.sequence)).toEqual([1, 2]);
        expect(events.events[1]!.payload).toMatchObject({
          message_id: messageId,
          sender: { kind: "user", display_name: "Emon" },
          text: SEND_TEXT,
        });

        // The receipt survived the SIGKILL: the same idempotency key replays
        // the SAME message and adds NO new journal rows (D23 rule 6, AC2).
        const resent = await postCommand(second.origin, {
          type: "message.send",
          workspace_id: WORKSPACE,
          idempotency_key: SEND_KEY,
          payload: {
            conversation_id: conversationId,
            text: SEND_TEXT,
            sender: { kind: "user", display_name: "Emon" },
          },
        });
        expect(resent.status).toBe(200);
        expect(resent.body).toEqual(sent.body);
        const afterReplay = await replay(second.origin, conversationId);
        expect(afterReplay.events).toHaveLength(2);
      } finally {
        await second.stop();
      }
    } finally {
      // The first process is already SIGKILLed; its exit was awaited by
      // kill9() and the temp dir cleanup runs in afterAll — nothing further
      // is needed here.
      void first;
    }
  }, 60_000);
});
