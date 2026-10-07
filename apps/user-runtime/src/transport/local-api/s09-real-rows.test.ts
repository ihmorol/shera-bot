/**
 * S09 chunk 1 — the REAL rows round trip the web client performs.
 *
 * The General Assistant direct chat's backing path, exercised over real HTTP
 * against the real composed runtime (real SQLite, real transactions — no mock
 * transport): a conversation is created through the typed command, read back
 * through the cursor replay endpoint, and a repeated idempotency key replays
 * the recorded receipt instead of creating a second row. This is exactly the
 * two local-API surfaces the web's runtime-client.ts drives through the
 * /api/runtime proxy (POST /v1/conversations/commands,
 * GET /v1/conversations/:id/events).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { composeLocalApi } from "./compose.ts";

const tempDirs: string[] = [];
const WORKSPACE = "ws_account-1";
/** The client's fixed seed key (apps/web/lib/runtime-client.ts) — any fixed key proves the same receipt contract. */
const GA_SEED_KEY = "s09-ga-direct-chat-seed-v1";

interface RunningApi {
  origin: string;
  close(): Promise<void>;
}

async function composeAndListen(): Promise<RunningApi & { dbDir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s09-"));
  tempDirs.push(dir);
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
    dbDir: dir,
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
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("S09 real-rows round trip (web backing path over the local API)", () => {
  it("creates the conversation, replays the seed receipt, and reads the journal back", async () => {
    const running = await composeAndListen();
    try {
      // 1. First ensure call: creates the REAL conversation row + journal event.
      const seed = {
        type: "conversation.create",
        workspace_id: WORKSPACE,
        idempotency_key: GA_SEED_KEY,
        payload: { title: "General Assistant" },
      };
      const created = await postCommand(running.origin, seed);
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        kind: "created",
        title: "General Assistant",
        revision: 1,
      });
      const conversationId = created.body["conversation_id"] as string;

      // 2. Second ensure call with the SAME key: receipt replay — the SAME
      // conversation returns, no second row, revision unchanged.
      const replayed = await postCommand(running.origin, seed);
      expect(replayed.status).toBe(200);
      expect(replayed.body).toMatchObject({
        kind: "created",
        conversation_id: conversationId,
        revision: 1,
      });

      // 3. The journal reads back through the cursor replay: one durable event.
      const events = await getEvents(running.origin, conversationId, 0);
      expect(events.status).toBe(200);
      expect(events.body["kind"]).toBe("events");
      const list = events.body["events"] as Array<Record<string, unknown>>;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        type: "conversation.created",
        sequence: 1,
        stream_id: `conversation:${conversationId}`,
        workspace_id: WORKSPACE,
      });

      // 4. A rename lands a second durable event; the cursor acknowledges
      // exactly what was consumed.
      const renamed = await postCommand(running.origin, {
        type: "conversation.rename",
        workspace_id: WORKSPACE,
        idempotency_key: "s09-rename-check-v1",
        payload: {
          conversation_id: conversationId,
          title: "Thesis planning",
          expected_revision: 1,
        },
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ kind: "renamed", revision: 2 });

      const fromZero = await getEvents(running.origin, conversationId, 0);
      const all = fromZero.body["events"] as Array<Record<string, unknown>>;
      expect(all.map((event) => event["type"])).toEqual([
        "conversation.created",
        "conversation.renamed",
      ]);
      expect(fromZero.body["next_cursor"]).toBe(2);

      const fromCursor = await getEvents(running.origin, conversationId, 1);
      const missed = fromCursor.body["events"] as Array<Record<string, unknown>>;
      expect(missed.map((event) => event["type"])).toEqual(["conversation.renamed"]);
      expect(fromCursor.body["next_cursor"]).toBe(2);
    } finally {
      await running.close();
    }
  });
});
