import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyToControlPlane, proxyToLocalApi } from "../lib/server/proxies";

/**
 * The web server-side proxies (S09 chunk 1) as their own module contract: the
 * browser talks to THIS origin only, and the forwarder must be transparent —
 * status, typed bodies, set-cookie, redirects (location), cache directives,
 * and request bodies for every body-bearing method. The Google sign-in 302's
 * `location` header IS the OAuth handoff (container-gate links
 * /api/control/api/auth/signin/google on this origin); a proxy that dropped
 * it broke the sign-in button silently. fetch is stubbed at the boundary —
 * the E2E exercises proxyToLocalApi against the real mock runtime.
 */

const CONTROL_BASE = "http://control-plane.test";
const RUNTIME_BASE = "http://runtime-local.test";
const SESSION_BODY = {
  workspace_id: "ws_account-1",
  google_sub: "google-account-1",
  email: "user@example.com",
  display_name: "User",
  tier: "balanced",
  is_admin: false,
  created_at: "2026-09-19T00:00:00.000Z",
  last_active_at: "2026-10-20T00:00:00.000Z",
};

/** The stubbed fetch's captured calls (input URL + the forwarded init). */
interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit | undefined;
}

/** A fetch stub that records every call and answers with the given response. */
function stubFetch(
  respond: () => Response,
  session: () => Response = () => Response.json({ ...SESSION_BODY, workspace_id: "ws_1" }),
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(String(input).endsWith("/api/session") ? session() : respond());
    }),
  );
  return { calls };
}

function upstream302(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc",
      "cache-control": "no-store",
      "set-cookie": "shera.session=seed; Path=/; HttpOnly; SameSite=Lax",
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["CONTROL_PLANE_URL"];
  delete process.env["RUNTIME_LOCAL_API_URL"];
  delete process.env["SHERA_WEB_ORIGIN"];
});

describe("control-plane proxy — redirect passthrough (sign-in 302)", () => {
  it("a 302's location (and cache-control) reaches the client — the OAuth handoff works", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    const { calls } = stubFetch(() => upstream302());

    const request = new Request("http://web.test/api/control/api/auth/signin/google", {
      method: "GET",
    });
    const response = await proxyToControlPlane(request, "/api/auth/signin/google");

    // The upstream was called on the control-plane leg with the forwarded path.
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(`${CONTROL_BASE}/api/auth/signin/google`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&state=abc",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The session cookie still flows through on the same leg.
    expect(response.headers.getSetCookie()).toEqual([
      "shera.session=seed; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });
});

describe("runtime proxy — allowlist + passthrough", () => {
  it("accepts the configured public origin when the internal request URL differs", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["SHERA_WEB_ORIGIN"] = "https://public.shera.test";
    const { calls } = stubFetch(() => Response.json({ ok: true }));
    const request = new Request("http://internal-next:3000/api/runtime/v1/conversations/commands", {
      method: "POST",
      body: JSON.stringify({
        type: "conversation.create",
        workspace_id: "ws_1",
        idempotency_key: "public-origin",
        payload: { title: "Public origin" },
      }),
      headers: {
        "content-type": "application/json",
        origin: "https://public.shera.test",
      },
    });

    const response = await proxyToLocalApi(request, "/v1/conversations/commands");

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("rejects a foreign browser origin before forwarding a command", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["SHERA_WEB_ORIGIN"] = "https://public.shera.test";
    const { calls } = stubFetch(() => Response.json({ ok: true }));
    const request = new Request("http://internal-next:3000/api/runtime/v1/conversations/commands", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "ws_1" }),
      headers: {
        "content-type": "application/json",
        origin: "https://foreign.test",
      },
    });

    const response = await proxyToLocalApi(request, "/v1/conversations/commands");

    expect(response.status).toBe(403);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(`${CONTROL_BASE}/api/session`);
  });

  it("rejects an anonymous command before the runtime can be reached", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(
      () => new Response(null, { status: 500 }),
      () =>
        Response.json(
          {
            code: "UNAUTHENTICATED",
            category: "authentication",
            safe_message: "Sign in to continue.",
            retryable: false,
            user_action: "Sign in with Google.",
            internal_details: null,
            correlation_id: "corr-unauthenticated",
          },
          { status: 401 },
        ),
    );

    const request = new Request("http://web.test/api/runtime/v1/conversations/commands", {
      method: "POST",
      body: JSON.stringify({
        type: "conversation.create",
        workspace_id: "ws_victim",
        idempotency_key: "anonymous-forgery",
        payload: { title: "Victim workspace" },
      }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/conversations/commands");

    expect(response.status).toBe(401);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(`${CONTROL_BASE}/api/session`);
  });

  it("rejects a caller-chosen workspace that differs from the authenticated session", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(
      () => Response.json(SESSION_BODY),
      () => Response.json(SESSION_BODY),
    );

    const request = new Request("http://web.test/api/runtime/v1/conversations/commands", {
      method: "POST",
      body: JSON.stringify({
        type: "conversation.create",
        workspace_id: "ws_victim",
        idempotency_key: "authenticated-forgery",
        payload: { title: "Victim workspace" },
      }),
      headers: {
        "content-type": "application/json",
        cookie: "shera.session=authenticated",
      },
    });
    const response = await proxyToLocalApi(request, "/v1/conversations/commands");

    expect(response.status).toBe(403);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "RUNTIME_TENANT_MISMATCH",
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe(`${CONTROL_BASE}/api/session`);
  });

  it("an allowed GET keeps transparent headers — cache-control reaches the client", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    stubFetch(
      () =>
        new Response(JSON.stringify({ kind: "events", events: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );

    const request = new Request(
      "http://web.test/api/runtime/v1/conversations/conv-1/events?workspace_id=ws_1",
      {
        method: "GET",
      },
    );
    const response = await proxyToLocalApi(request, "/v1/conversations/conv-1/events");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("bodies forward for every body-bearing method, not only POST", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    const { calls } = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));

    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const request = new Request("http://web.test/api/control/api/resource/1", {
        method,
        body: JSON.stringify({ value: 1 }),
        headers: { "content-type": "application/json" },
      });
      await proxyToControlPlane(request, "/api/resource/1");
      const call = calls.at(-1)!;
      expect(call.init?.method).toBe(method);
      expect(call.init?.body).toBe(JSON.stringify({ value: 1 }));
    }
    // GET never carries a body.
    const get = new Request("http://web.test/api/control/api/resource/1", { method: "GET" });
    await proxyToControlPlane(get, "/api/resource/1");
    expect(calls.at(-1)!.init?.body).toBeUndefined();
  });

  it("the strict allowlist still refuses non-conversation paths", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    const request = new Request("http://web.test/api/runtime/internal/whatever", {
      method: "GET",
    });
    const response = await proxyToLocalApi(request, "/internal/whatever");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("runtime proxy — S11 agent surfaces (allowlist additions)", () => {
  /** The stubbed fetch answer for a forwarded agent call. */
  function agentResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("forwards the workspace roster read", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request("http://web.test/api/runtime/v1/agents?workspace_id=ws_1");
    const response = await proxyToLocalApi(request, "/v1/agents");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/agents?workspace_id=ws_1`,
    );
  });

  it("forwards the agent detail read (the get-or-create direct chat binding)", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(request, "/v1/agents/agent_general_assistant");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/agents/agent_general_assistant?workspace_id=ws_1`,
    );
  });

  it("forwards the settings snapshot read", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant/settings?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(request, "/v1/agents/agent_general_assistant/settings");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/agents/agent_general_assistant/settings?workspace_id=ws_1`,
    );
  });

  it("forwards the D16 settings command POST with its body (the one mutation surface)", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant/settings/commands",
      {
        method: "POST",
        body: JSON.stringify({ type: "agent_settings.reset_all", workspace_id: "ws_1" }),
        headers: { "content-type": "application/json" },
      },
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/agents/agent_general_assistant/settings/commands",
    );

    expect(response.status).toBe(200);
    const call = calls.at(-1)!;
    expect(String(call.input)).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/agents/agent_general_assistant/settings/commands`,
    );
    expect(call.init?.body).toBe(
      JSON.stringify({ type: "agent_settings.reset_all", workspace_id: "ws_1" }),
    );
  });

  it("still refuses the chunk-2 PATCH routes — the commands endpoint is the only agent mutation", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    for (const path of [
      "/v1/agents/agent_general_assistant/instructions",
      "/v1/agents/agent_general_assistant/provider",
    ]) {
      const request = new Request(`http://web.test/api/runtime${path}`, {
        method: "PATCH",
        body: JSON.stringify({ workspace_id: "ws_1" }),
        headers: { "content-type": "application/json" },
      });
      const response = await proxyToLocalApi(request, path);
      expect(response.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("still refuses agent sub-paths outside the four surfaces (detail must not swallow settings)", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant/memory",
    );
    const response = await proxyToLocalApi(request, "/v1/agents/agent_general_assistant/memory");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("runtime proxy — S13 Operation surfaces (allowlist additions)", () => {
  /** The stubbed fetch answer for a forwarded operation call. */
  function operationResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("forwards the workspace operations list read", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request("http://web.test/api/runtime/v1/operations?workspace_id=ws_1");
    const response = await proxyToLocalApi(request, "/v1/operations");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operations?workspace_id=ws_1`,
    );
  });

  it("forwards the Operation detail read (roster + runs + refusals + chat binding)", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operations/op_research_01?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(request, "/v1/operations/op_research_01");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operations/op_research_01?workspace_id=ws_1`,
    );
  });

  it("forwards the merged thread read with its after cursor", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operations/op_research_01/thread?workspace_id=ws_1&after=4",
    );
    const response = await proxyToLocalApi(request, "/v1/operations/op_research_01/thread");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operations/op_research_01/thread?workspace_id=ws_1&after=4`,
    );
  });

  it("forwards the ad-hoc Operation creation POST with its body", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request("http://web.test/api/runtime/v1/operations", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "ws_1",
        definition_ref: null,
        name: "Research Paper",
        roster_agent_ids: ["agent_general_assistant"],
        coordinator_agent_id: "agent_general_assistant",
      }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/operations");

    expect(response.status).toBe(200);
    const call = calls.at(-1)!;
    expect(String(call.input)).toBe(`${CONTROL_BASE}/api/runtime/local/v1/operations`);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe(
      JSON.stringify({
        workspace_id: "ws_1",
        definition_ref: null,
        name: "Research Paper",
        roster_agent_ids: ["agent_general_assistant"],
        coordinator_agent_id: "agent_general_assistant",
      }),
    );
  });

  it("forwards the D36 roster command POST with its body", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operations/op_research_01/roster/commands",
      {
        method: "POST",
        body: JSON.stringify({ type: "operation.remove_roster_agent", workspace_id: "ws_1" }),
        headers: { "content-type": "application/json" },
      },
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/operations/op_research_01/roster/commands",
    );

    expect(response.status).toBe(200);
    const call = calls.at(-1)!;
    expect(String(call.input)).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operations/op_research_01/roster/commands`,
    );
    expect(call.init?.body).toBe(
      JSON.stringify({ type: "operation.remove_roster_agent", workspace_id: "ws_1" }),
    );
  });

  it("forwards the D42/D49 coordinator POST with its body", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operations/op_research_01/coordinator",
      {
        method: "POST",
        body: JSON.stringify({ workspace_id: "ws_1", coordinator_agent_id: "none" }),
        headers: { "content-type": "application/json" },
      },
    );
    const response = await proxyToLocalApi(request, "/v1/operations/op_research_01/coordinator");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.init?.body).toBe(
      JSON.stringify({ workspace_id: "ws_1", coordinator_agent_id: "none" }),
    );
  });

  it("forwards the run creation POST with its body", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request("http://web.test/api/runtime/v1/operations/op_research_01/runs", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "ws_1" }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/operations/op_research_01/runs");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.init?.body).toBe(JSON.stringify({ workspace_id: "ws_1" }));
  });

  it("forwards the D41 addressed message send POST with its body", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operations/op_research_01/thread/messages",
      {
        method: "POST",
        body: JSON.stringify({
          workspace_id: "ws_1",
          idempotency_key: "idem_msg_draft_0001",
          sender: { kind: "user", display_name: "Emon" },
          text: "hello",
        }),
        headers: { "content-type": "application/json" },
      },
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/operations/op_research_01/thread/messages",
    );

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.init?.body).toBe(
      JSON.stringify({
        workspace_id: "ws_1",
        idempotency_key: "idem_msg_draft_0001",
        sender: { kind: "user", display_name: "Emon" },
        text: "hello",
      }),
    );
  });

  it("forwards the S14 rename POST with its contracts envelope", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(operationResponse);

    const envelope = {
      command_id: "cmd_s14_rename_001",
      idempotency_key: "idem_s14_rename_001",
      workspace_id: "ws_1",
      operation_id: "op_research_01",
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-10-24T12:00:00.000Z",
      type: "operation.rename_operation",
      name: "Weekly Review",
    };
    const request = new Request("http://web.test/api/runtime/v1/operations/op_research_01/rename", {
      method: "POST",
      body: JSON.stringify(envelope),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/operations/op_research_01/rename");

    expect(response.status).toBe(200);
    const call = calls.at(-1)!;
    expect(String(call.input)).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operations/op_research_01/rename`,
    );
    expect(call.init?.method).toBe("POST");
    expect(call.init?.body).toBe(JSON.stringify(envelope));
  });

  it("still refuses the D7 collaboration-event write — the browser renders events, never authors them", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    const request = new Request("http://web.test/api/runtime/v1/operations/op_research_01/events", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "ws_1" }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/operations/op_research_01/events");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("still refuses operation sub-paths outside the surfaced reads (detail must not swallow everything)", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    for (const path of [
      "/v1/operations/op_research_01/events",
      "/v1/operations/op_research_01/runs/run_top_01",
      "/v1/operations/op_research_01/roster",
    ]) {
      const request = new Request(`http://web.test/api/runtime${path}`, { method: "GET" });
      const response = await proxyToLocalApi(request, path);
      expect(response.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("runtime proxy — S16 worker admission readout (allowlist addition)", () => {
  /** The stubbed fetch answer for a forwarded worker-readout call. */
  function admissionResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("forwards the workspace admission read with its workspace selector", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(admissionResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/workers/admission?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(request, "/v1/workers/admission");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/workers/admission?workspace_id=ws_1`,
    );
  });

  it("still refuses worker mutations — the browser renders pressure, never authors it", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    const request = new Request("http://web.test/api/runtime/v1/workers/admission", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "ws_1" }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/workers/admission");

    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("still refuses other /v1/workers sub-paths — the readout is the one surface", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    for (const path of ["/v1/workers", "/v1/workers/admission/history", "/v1/workers/run-1"]) {
      const request = new Request(`http://web.test/api/runtime${path}?workspace_id=ws_1`, {
        method: "GET",
      });
      const response = await proxyToLocalApi(request, path);
      expect(response.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("runtime proxy — S20 approval decision actor binding (server-side)", () => {
  it("binds decided_by to the authenticated session — a body-asserted actor never reaches the runtime", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(() => Response.json({ ok: true }));

    const request = new Request("http://web.test/api/runtime/v1/approvals/apr_review_01/decision", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: "ws_1",
        choice: "approve-this-execution-only",
        // The attacker-chosen audit trail the proxy must overwrite.
        decided_by: { type: "user", id: "body-asserted-subject" },
      }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/approvals/apr_review_01/decision");

    expect(response.status).toBe(200);
    const call = calls.at(-1)!;
    expect(String(call.input)).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/approvals/apr_review_01/decision`,
    );
    // The deciding actor arriving at the runtime IS the session identity
    // (SESSION_BODY's google_sub) — the body value was overwritten.
    expect(JSON.parse(String(call.init?.body))["decided_by"]).toEqual({
      type: "user",
      id: "google-account-1",
    });
  });

  it("a decision body without any decided_by still forwards — the session supplies it", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(() => Response.json({ ok: true }));

    const request = new Request("http://web.test/api/runtime/v1/approvals/apr_review_01/decision", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "ws_1", choice: "reject-this-action" }),
      headers: { "content-type": "application/json" },
    });
    const response = await proxyToLocalApi(request, "/v1/approvals/apr_review_01/decision");

    expect(response.status).toBe(200);
    expect(JSON.parse(String(calls.at(-1)!.init?.body))["decided_by"]).toEqual({
      type: "user",
      id: "google-account-1",
    });
  });

  it("the binding stays scoped to the decision route — other bodies forward verbatim", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(() => Response.json({ ok: true }));

    const request = new Request("http://web.test/api/runtime/v1/operations/op_01/rename", {
      method: "POST",
      body: JSON.stringify({ workspace_id: "ws_1", name: "Unrelated" }),
      headers: { "content-type": "application/json" },
    });
    await proxyToLocalApi(request, "/v1/operations/op_01/rename");

    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({
      workspace_id: "ws_1",
      name: "Unrelated",
    });
  });
});

describe("runtime request boundaries", () => {
  it("rejects oversized bodies before forwarding commands", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    const { calls } = stubFetch(() => Response.json({ ok: true }));
    const response = await proxyToLocalApi(
      new Request("http://web.test/api/runtime/v1/conversations/commands", {
        method: "POST",
        body: JSON.stringify({ workspace_id: "ws_1", text: "a".repeat(65536) }),
      }),
      "/v1/conversations/commands",
    );
    expect(response.status).toBe(413);
    expect(calls).toHaveLength(1);
  });
  it("preserves empty upstream responses", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    stubFetch(() => new Response(null, { status: 204 }));
    const response = await proxyToControlPlane(
      new Request("http://web.test/logout", { method: "POST" }),
      "/logout",
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});
describe("runtime proxy — S15 launch preview surfaces (allowlist additions)", () => {
  /** The stubbed fetch answer for a forwarded preview call. */
  function previewResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("forwards the pinned pack's operation definitions read", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(previewResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operation-definitions?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(request, "/v1/operation-definitions");

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operation-definitions?workspace_id=ws_1`,
    );
  });

  it("forwards the D30 launch preview read with its optional override params", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(previewResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/operation-definitions/operation_research_paper/preview" +
        "?workspace_id=ws_1&roster_agent_ids=agent_researcher,agent_citation_manager&coordinator_agent_id=none",
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/operation-definitions/operation_research_paper/preview",
    );

    expect(response.status).toBe(200);
    expect(calls.at(-1)?.input).toBe(
      `${CONTROL_BASE}/api/runtime/local/v1/operation-definitions/operation_research_paper/preview` +
        "?workspace_id=ws_1&roster_agent_ids=agent_researcher,agent_citation_manager&coordinator_agent_id=none",
    );
  });

  it("still refuses every mutation on the definitions prefix — the preview is GET-only (D30)", async () => {
    process.env["CONTROL_PLANE_URL"] = CONTROL_BASE;
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return Promise.resolve(new Response(null, { status: 500 }));
      }),
    );

    for (const [method, path] of [
      ["POST", "/v1/operation-definitions"],
      ["POST", "/v1/operation-definitions/operation_research_paper/preview"],
      ["DELETE", "/v1/operation-definitions/operation_research_paper"],
    ] as const) {
      const request = new Request(`http://web.test/api/runtime${path}`, {
        method,
        body: JSON.stringify({ workspace_id: "ws_1" }),
        headers: { "content-type": "application/json" },
      });
      const response = await proxyToLocalApi(request, path);
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});
