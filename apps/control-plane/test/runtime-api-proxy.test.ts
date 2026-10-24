import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeApiProxy } from "../src/runtime/api-proxy.ts";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  servers.length = 0;
});
async function start(user: { id: string; name: string } | null, upstream?: Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const actualFetch = fetch;
  const target = vi.fn(async (id: string) => ({
    endpoint: `http://runtime-${id}.test`,
    bearer: "audit-test-only",
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).startsWith("http://127.0.0.1")) return actualFetch(url, init);
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(upstream ?? Response.json({ kind: "ok" }));
    }),
  );
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.session = user ? { user } : null;
    next();
  });
  app.use("/api/runtime/local", createRuntimeApiProxy({ targetForAccount: target }));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { calls, target, origin };
}
describe("authenticated runtime routing", () => {
  it("rejects anonymous access and cross-account selectors before choosing an endpoint", async () => {
    const h = await start(null);
    const reply = await fetch(`${h.origin}/api/runtime/local/v1/agents?workspace_id=ws_a`);
    expect(reply.status).toBe(401);
    expect(h.target).not.toHaveBeenCalled();
  });
  it("rejects a different user's workspace", async () => {
    const h = await start({ id: "a", name: "Alice" });
    const reply = await fetch(`${h.origin}/api/runtime/local/v1/agents?workspace_id=ws_b`);
    expect(reply.status).toBe(403);
    expect(h.target).not.toHaveBeenCalled();
  });
  it("uses the account's server-selected runtime and replaces forged message attribution", async () => {
    const h = await start({ id: "a", name: "Alice" });
    const reply = await fetch(`${h.origin}/api/runtime/local/v1/conversations/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "message.send",
        workspace_id: "ws_a",
        payload: { text: "Hello", sender: { kind: "agent", agent_id: "agent_developer" } },
      }),
    });
    expect(reply.status).toBe(200);
    expect(h.target).toHaveBeenCalledWith("a");
    expect(h.calls[0]?.url).toBe(
      "http://runtime-a.test/internal/v1/local/v1/conversations/commands?",
    );
    expect(JSON.parse(String(h.calls[0]?.init.body)).payload.sender).toEqual({
      kind: "user",
      display_name: "Alice",
    });
    expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer audit-test-only",
    );
    expect(await reply.text()).not.toContain("audit-test-only");
  });

  it.each([{ payload: "invalid" }, { payload: ["invalid"] }])(
    "forwards malformed message payload $payload for authoritative validation",
    async ({ payload }) => {
      const validationError = {
        code: "CONTRACT_VALIDATION_FAILED",
        category: "validation",
        safe_message: "Request body failed contract validation.",
        retryable: false,
        details: {},
      };
      const h = await start(
        { id: "a", name: "Alice" },
        Response.json(validationError, { status: 400 }),
      );
      const reply = await fetch(`${h.origin}/api/runtime/local/v1/conversations/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "message.send", workspace_id: "ws_a", payload }),
      });

      expect(reply.status).toBe(400);
      expect(h.target).toHaveBeenCalledWith("a");
      expect(JSON.parse(String(h.calls[0]?.init.body)).payload).toEqual(payload);
      expect(await reply.json()).toEqual(validationError);
    },
  );

  it("attributes settings commands to the authenticated user", async () => {
    const h = await start({ id: "a", name: "Alice" });
    const reply = await fetch(
      `${h.origin}/api/runtime/local/v1/agents/agent_general_assistant/settings/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "agent.settings.update",
          workspace_id: "ws_a",
          actor: { type: "agent", id: "agent_developer" },
        }),
      },
    );
    expect(reply.status).toBe(200);
    expect(JSON.parse(String(h.calls[0]?.init.body)).actor).toEqual({ type: "user", id: "a" });
  });
});
