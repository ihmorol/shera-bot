/**
 * S09 chunk 2 — the message send path over HTTP (the web composer's path).
 *
 * The real-mode composer sends one idempotent `message.send` command through
 * `POST /v1/conversations/commands`; a double-send (retry after an ambiguous
 * failure) replays the receipt and produces exactly ONE durable message,
 * visible in the journal replay the thread reads back.
 */
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { composeLocalApi } from "./compose.ts";
import { cleanupTempResources, makeTempDir } from "../../../test/helpers/temp-resources.ts";

const WORKSPACE = "ws_account-1";
const SEND_KEY = "s09-ga-msg-send-1";

interface RunningApi {
  origin: string;
  close(): Promise<void>;
}

async function composeAndListen(): Promise<RunningApi> {
  const dir = makeTempDir("shera-runtime-s09-send-");
  const composed = composeLocalApi({ dbPath: join(dir, "runtime.db") });
  const server: Server = createServer(composed.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function postCommand(origin: string, body: Record<string, unknown>) {
  const response = await fetch(`${origin}/v1/conversations/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getEvents(origin: string, conversationId: string, cursor: number) {
  const response = await fetch(
    `${origin}/v1/conversations/${conversationId}/events?workspace_id=${WORKSPACE}&last_acknowledged_sequence=${cursor}`,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("S09 message send over HTTP (composer path)", () => {
  it("sends, double-sends, and reads back exactly one durable message", async () => {
    const running = await composeAndListen();
    try {
      const created = await postCommand(running.origin, {
        type: "conversation.create",
        workspace_id: WORKSPACE,
        idempotency_key: "s09-send-seed-v1",
        payload: { title: "General Assistant" },
      });
      const conversationId = created.body["conversation_id"] as string;

      const send = {
        type: "message.send",
        workspace_id: WORKSPACE,
        idempotency_key: SEND_KEY,
        payload: {
          conversation_id: conversationId,
          text: "Outline a plan for my thesis chapter, please.",
          sender: { kind: "user", display_name: "Emon" },
        },
      };

      const first = await postCommand(running.origin, send);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ kind: "message_sent", conversation_id: conversationId });
      const messageId = first.body["message_id"] as string;

      // The ambiguous-retry path: the SAME key replays the SAME message.
      const second = await postCommand(running.origin, send);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(second.body["message_id"]).toBe(messageId);

      // The thread's journal replay shows exactly one user message.
      const events = await getEvents(running.origin, conversationId, 0);
      const list = events.body["events"] as Array<{
        type: string;
        payload: Record<string, unknown>;
      }>;
      const messages = list.filter((event) => event.type === "message.appended");
      expect(messages).toHaveLength(1);
      expect(messages[0]!.payload).toMatchObject({
        message_id: messageId,
        sender: { kind: "user", display_name: "Emon" },
        text: "Outline a plan for my thesis chapter, please.",
      });

      // A malformed send is the typed 400, never a raw failure.
      const bad = await postCommand(running.origin, {
        type: "message.send",
        workspace_id: WORKSPACE,
        idempotency_key: "s09-bad-send-1",
        payload: {
          conversation_id: conversationId,
          text: "",
          sender: { kind: "user", display_name: "Emon" },
        },
      });
      expect(bad.status).toBe(400);
    } finally {
      await running.close();
    }
  });
});
