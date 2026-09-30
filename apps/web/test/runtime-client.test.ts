import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GA_DIRECT_CHAT_SEED_KEY,
  ensureGaConversation,
  fetchConversationEvents,
  RuntimeApiError,
} from "../lib/runtime-client";

/**
 * The real conversation backing's client (S09 chunk 1): the General Assistant
 * direct chat resolves its conversation through the idempotent S07 command
 * (fixed seed key → receipt replay → same conversation_id) and reads the
 * journal back through the cursor replay endpoint. fetch is stubbed at the
 * proxy boundary; the REAL rows round trip is proven against the real runtime
 * in apps/user-runtime.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureGaConversation", () => {
  it("sends the fixed-seed conversation.create command for the workspace", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        kind: "created",
        conversation_id: "conv-1",
        title: "General Assistant",
        revision: 1,
        event_id: "evt-1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureGaConversation("ws_account-1");
    expect(result.conversation_id).toBe("conv-1");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/conversations/commands");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: "conversation.create",
      workspace_id: "ws_account-1",
      // The FIXED seed key: every call for this chat reuses it, so the
      // upstream receipt replay returns the SAME conversation (D23 rule 6).
      idempotency_key: GA_DIRECT_CHAT_SEED_KEY,
      payload: { title: "General Assistant" },
    });
  });

  it("raises typed failures from the local API's SheraError bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: "COMMAND_PAYLOAD_INVALID",
          category: "validation",
          safe_message: "The command body is not valid.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "corr-9",
        }),
      ),
    );

    const error = await ensureGaConversation("ws_account-1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeApiError);
    if (!(error instanceof RuntimeApiError)) throw new Error("expected RuntimeApiError");
    expect(error.sheraError.code).toBe("COMMAND_PAYLOAD_INVALID");
  });
});

describe("fetchConversationEvents", () => {
  it("GETs the replay endpoint scoped by workspace and cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        kind: "events",
        stream_id: "conversation:conv-1",
        workspace_id: "ws_account-1",
        events: [
          {
            event_id: "evt-1",
            stream_id: "conversation:conv-1",
            sequence: 1,
            type: "conversation.created",
            schema_version: 1,
            payload: {
              conversation_id: "conv-1",
              workspace_id: "ws_account-1",
              title: "General Assistant",
            },
            workspace_id: "ws_account-1",
            occurred_at: "2026-09-30T10:00:00Z",
            correlation_id: "corr-1",
          },
        ],
        next_cursor: 1,
        replayed: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchConversationEvents("conv-1", "ws_account-1");
    expect(result.kind).toBe("events");

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(
      "/api/runtime/v1/conversations/conv-1/events?workspace_id=ws_account-1&last_acknowledged_sequence=0",
    );
  });

  it("a snapshot-required answer surfaces as its own honest kind, never as events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          kind: "snapshot_required",
          stream_id: "conversation:conv-1",
          workspace_id: "ws_account-1",
          reason: "cursor_below_retention_horizon",
          earliest_available_sequence: 5,
          next_cursor: 5,
          replayed: false,
        }),
      ),
    );

    const result = await fetchConversationEvents("conv-1", "ws_account-1");
    expect(result.kind).toBe("snapshot_required");
  });

  it("a drifted 2xx body fails loudly into the typed fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { kind: "events" })));

    const error = await fetchConversationEvents("conv-1", "ws_account-1").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RuntimeApiError);
    if (!(error instanceof RuntimeApiError)) throw new Error("expected RuntimeApiError");
    expect(error.sheraError.internal_details).toBeNull();
  });
});
