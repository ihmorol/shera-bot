/**
 * Local API tests (S07; D26 over HTTP, AC4/AC6/E10).
 *
 * The typed local API is the container's loopback surface: commands are the
 * ONLY mutation path (D26), typed rejections map to stable SheraError HTTP
 * responses through the shared error middleware, idempotency keys replay
 * recorded receipts instead of duplicating effects (AC6), and the replay
 * cursor endpoint returns exactly the missed durable events in order once
 * (AC4) with the E10 snapshot fallback below the retention horizon.
 *
 * Tests run the real Express app over real HTTP on an ephemeral loopback
 * port against a real temp-dir SQLite database — the same composition the
 * container will run (no mock transport).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, describe, expect, it } from "vitest";
import type { Express } from "express";

import { ConversationsService } from "../../modules/conversations/conversations.service.ts";
import { ReplayService } from "../../modules/events/replay.service.ts";
import { composeLocalApi } from "./compose.ts";
import { createLocalApi } from "./app.ts";

const tempDirs: string[] = [];
const WS_A = "ws-11111111-1111-4111-8111-111111111111";

interface RunningApi {
  origin: string;
  close(): Promise<void>;
}

async function listenHttp(app: Express): Promise<RunningApi> {
  const server: Server = createServer(app);
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

function composeAndListen(
  options: { retentionHorizon?: (workspaceId: string, streamId: string) => number } = {},
): Promise<{ api: ReturnType<typeof composeLocalApi> } & RunningApi> {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-local-api-"));
  tempDirs.push(dir);
  const composed = composeLocalApi({
    dbPath: join(dir, "runtime.db"),
    ...(options.retentionHorizon ? { retentionHorizon: options.retentionHorizon } : {}),
  });
  return listenHttp(composed.app).then((running) => ({ ...running, api: composed }));
}

function commandBody(
  overrides: Record<string, unknown> = {},
  payloadOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "conversation.create",
    workspace_id: WS_A,
    idempotency_key: `idem-${Math.random().toString(36).slice(2)}`,
    payload: { title: "Operation kickoff", ...payloadOverrides },
    ...overrides,
  };
}

async function postJson(
  origin: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(
  origin: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterAll(async () => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local API — conversation commands (D26: commands are the only mutation path)", () => {
  it("creates and renames a conversation over HTTP with typed results", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        kind: "created",
        title: "Operation kickoff",
        revision: 1,
      });
      const conversationId = created.body["conversation_id"] as string;
      expect(typeof created.body["event_id"]).toBe("string");

      const renamed = await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.rename",
        workspace_id: WS_A,
        idempotency_key: "idem-rename-over-http-1",
        payload: { conversation_id: conversationId, title: "renamed", expected_revision: 1 },
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        kind: "renamed",
        title: "renamed",
        revision: 2,
      });
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("rejects a body that is not a valid command with the typed 400 (stable fields)", async () => {
    const running = await composeAndListen();
    try {
      // Missing idempotency_key entirely: the transport schema rejects it.
      const response = await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.create",
        workspace_id: WS_A,
        payload: { title: "no key" },
      });
      expect(response.status).toBe(400);
      expect(response.body["code"]).toBe("CONTRACT_VALIDATION_FAILED");
      expect(response.body["category"]).toBe("validation");
      expect(response.body["internal_details"]).toBeNull();
      expect(typeof response.body["correlation_id"]).toBe("string");
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("maps an unknown conversation to the typed 404 with stable error fields", async () => {
    const running = await composeAndListen();
    try {
      const response = await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.rename",
        workspace_id: WS_A,
        idempotency_key: "idem-rename-missing-1",
        payload: {
          conversation_id: "no-such-conversation",
          title: "x",
          expected_revision: 1,
        },
      });
      expect(response.status).toBe(404);
      expect(response.body["code"]).toBe("CONVERSATION_NOT_FOUND");
      expect(response.body["category"]).toBe("state");
      expect(response.body["internal_details"]).toBeNull();
      // The typed rejection's internal message never crosses the wire (G3).
      expect(JSON.stringify(response.body)).not.toContain("no-such-conversation");
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("maps a stale expected_revision to the typed 409 conflict with a user action", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      const conversationId = created.body["conversation_id"] as string;

      const stale = await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.rename",
        workspace_id: WS_A,
        idempotency_key: "idem-rename-stale-1",
        payload: { conversation_id: conversationId, title: "v3", expected_revision: 99 },
      });
      expect(stale.status).toBe(409);
      expect(stale.body["code"]).toBe("CONVERSATION_REVISION_CONFLICT");
      expect(stale.body["category"]).toBe("conflict");
      expect(stale.body["retryable"]).toBe(false);
      expect(stale.body["user_action"]).toBeTruthy();
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("rejects an over-long title at the transport gate with the typed 400 and keeps state intact", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      const conversationId = created.body["conversation_id"] as string;

      // The command schema caps titles at 300 — the same bound the journal's
      // event payload schema enforces — so an over-long title never executes.
      // The journal gate below the transport is defense in depth: it is
      // reachable only when a caller bypasses this API (covered by the module
      // tests, where the transition + event + receipt roll back atomically).
      const tooLong = "x".repeat(301);
      const rejected = await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.rename",
        workspace_id: WS_A,
        idempotency_key: "idem-rename-toolong-1",
        payload: { conversation_id: conversationId, title: tooLong, expected_revision: 1 },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body["code"]).toBe("CONTRACT_VALIDATION_FAILED");
      expect(rejected.body["internal_details"]).toBeNull();

      // No partial effect: exactly the creation event exists, nothing else.
      const stream = `conversation:${conversationId}`;
      const replay = await getJson(
        running.origin,
        `/v1/conversations/${conversationId}/events?workspace_id=${WS_A}&last_acknowledged_sequence=0`,
      );
      expect(replay.body).toMatchObject({ kind: "events", stream_id: stream });
      expect((replay.body["events"] as unknown[]).length).toBe(1);
    } finally {
      await running.close();
      running.api.close();
    }
  });
});

describe("local API — idempotency over HTTP (AC6)", () => {
  it("replays the recorded result for a repeated idempotency_key without duplicating effects", async () => {
    const running = await composeAndListen();
    try {
      const body = commandBody({}, { title: "first title" });
      const first = await postJson(running.origin, "/v1/conversations/commands", body);
      // Same key, DIFFERENT payload: the recorded receipt still wins.
      const second = await postJson(running.origin, "/v1/conversations/commands", {
        ...body,
        payload: { title: "a different title, same key" },
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);

      const conversationId = first.body["conversation_id"] as string;
      const replay = await getJson(
        running.origin,
        `/v1/conversations/${conversationId}/events?workspace_id=${WS_A}&last_acknowledged_sequence=0`,
      );
      expect(replay.body).toMatchObject({ kind: "events", replayed: true });
      expect((replay.body["events"] as unknown[]).length).toBe(1);
    } finally {
      await running.close();
      running.api.close();
    }
  });
});

describe("local API — replay cursors (AC4, E10)", () => {
  it("returns exactly the missed events, in order, once; then an empty catch-up", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      const conversationId = created.body["conversation_id"] as string;
      await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.rename",
        workspace_id: WS_A,
        idempotency_key: "idem-replay-1",
        payload: { conversation_id: conversationId, title: "v2", expected_revision: 1 },
      });
      await postJson(running.origin, "/v1/conversations/commands", {
        type: "conversation.rename",
        workspace_id: WS_A,
        idempotency_key: "idem-replay-2",
        payload: { conversation_id: conversationId, title: "v3", expected_revision: 2 },
      });
      const base = `/v1/conversations/${conversationId}/events?workspace_id=${WS_A}`;

      const fromZero = await getJson(running.origin, `${base}&last_acknowledged_sequence=0`);
      expect(fromZero.status).toBe(200);
      expect(fromZero.body).toMatchObject({
        kind: "events",
        stream_id: `conversation:${conversationId}`,
        workspace_id: WS_A,
        next_cursor: 3,
        replayed: true,
      });
      expect((fromZero.body["events"] as Array<{ sequence: number }>).map((e) => e.sequence)).toEqual(
        [1, 2, 3],
      );

      const caughtUp = await getJson(running.origin, `${base}&last_acknowledged_sequence=3`);
      expect(caughtUp.body).toMatchObject({ kind: "events", next_cursor: 3, replayed: true });
      expect(caughtUp.body["events"]).toEqual([]);

      const tail = await getJson(running.origin, `${base}&last_acknowledged_sequence=1`);
      expect((tail.body["events"] as Array<{ sequence: number }>).map((e) => e.sequence)).toEqual([
        2, 3,
      ]);
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("answers a cursor below the retention horizon with a snapshot + new cursor (E10)", async () => {
    const running = await composeAndListen({
      // E10 test seam: everything below sequence 3 is "compacted away".
      retentionHorizon: () => 3,
    });
    try {
      const created = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      const conversationId = created.body["conversation_id"] as string;

      const fallback = await getJson(
        running.origin,
        `/v1/conversations/${conversationId}/events?workspace_id=${WS_A}&last_acknowledged_sequence=0`,
      );
      expect(fallback.status).toBe(200);
      expect(fallback.body).toMatchObject({
        kind: "snapshot_required",
        reason: "cursor_below_retention_horizon",
        earliest_available_sequence: 3,
        replayed: false,
      });
      expect(fallback.body["snapshot"]).toMatchObject({
        kind: "conversation",
        conversation_id: conversationId,
        revision: 1,
      });
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("rejects a replay request without workspace scoping with the typed 400", async () => {
    const running = await composeAndListen();
    try {
      const created = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      const conversationId = created.body["conversation_id"] as string;
      const response = await getJson(
        running.origin,
        `/v1/conversations/${conversationId}/events?last_acknowledged_sequence=0`,
      );
      expect(response.status).toBe(400);
      expect(response.body["code"]).toBe("CONTRACT_VALIDATION_FAILED");
    } finally {
      await running.close();
      running.api.close();
    }
  });
});

describe("local API — health probe (transport status, not a business event)", () => {
  it("serves /internal/v1/health with the same spelling and shape as the internal API", async () => {
    const running = await composeAndListen();
    try {
      const response = await getJson(running.origin, "/internal/v1/health");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ok" });
    } finally {
      await running.close();
      running.api.close();
    }
  });
});

describe("local API — typed error middleware integration", () => {
  it("answers unknown routes with the typed 404", async () => {
    const running = await composeAndListen();
    try {
      const response = await getJson(running.origin, "/v1/no-such-route");
      expect(response.status).toBe(404);
      expect(response.body["code"]).toBe("ROUTE_NOT_FOUND");
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("answers an invalid JSON body with the typed 400, not the parser's raw error", async () => {
    const running = await composeAndListen();
    try {
      const response = await fetch(`${running.origin}/v1/conversations/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{definitely not json",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("CONTRACT_VALIDATION_FAILED");
      expect(JSON.stringify(body)).not.toContain("definitely not json");
    } finally {
      await running.close();
      running.api.close();
    }
  });

  it("degrades an untyped internal fault to a generic 500 that leaks nothing (G3)", async () => {
    // Stub services that throw a raw error with embarrassing internals: the
    // middleware must strip everything down to the generic INTERNAL_ERROR.
    const throwing = () => {
      throw new Error("SQLITE_CONSTRAINT: secret table schema leaked");
    };
    const app = createLocalApi({
      conversations: { executeCommand: throwing } as unknown as ConversationsService,
      replay: { resolve: throwing } as unknown as ReplayService,
    });
    const running = await listenHttp(app);
    try {
      const response = await postJson(running.origin, "/v1/conversations/commands", commandBody());
      expect(response.status).toBe(500);
      expect(response.body["code"]).toBe("INTERNAL_ERROR");
      expect(response.body["category"]).toBe("internal");
      expect(response.body["internal_details"]).toBeNull();
      expect(JSON.stringify(response.body)).not.toContain("SQLITE_CONSTRAINT");
      expect(JSON.stringify(response.body)).not.toContain("leaked");
    } finally {
      await running.close();
    }
  });
});
