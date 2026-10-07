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

/** The stubbed fetch's captured calls (input URL + the forwarded init). */
interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit | undefined;
}

/** A fetch stub that records every call and answers with the given response. */
function stubFetch(respond: () => Response): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(respond());
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
  it("an allowed GET keeps transparent headers — cache-control reaches the client", async () => {
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    stubFetch(
      () =>
        new Response(JSON.stringify({ kind: "events", events: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    );

    const request = new Request("http://web.test/api/runtime/v1/conversations/conv-1/events", {
      method: "GET",
    });
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
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request("http://web.test/api/runtime/v1/agents?workspace_id=ws_1");
    const response = await proxyToLocalApi(request, "/v1/agents");

    expect(response.status).toBe(200);
    expect(calls[0]?.input).toBe(`${RUNTIME_BASE}/v1/agents?workspace_id=ws_1`);
  });

  it("forwards the agent detail read (the get-or-create direct chat binding)", async () => {
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/agents/agent_general_assistant?workspace_id=ws_1",
    );

    expect(response.status).toBe(200);
    expect(calls[0]?.input).toBe(
      `${RUNTIME_BASE}/v1/agents/agent_general_assistant?workspace_id=ws_1`,
    );
  });

  it("forwards the settings snapshot read", async () => {
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant/settings?workspace_id=ws_1",
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/agents/agent_general_assistant/settings?workspace_id=ws_1",
    );

    expect(response.status).toBe(200);
    expect(calls[0]?.input).toBe(
      `${RUNTIME_BASE}/v1/agents/agent_general_assistant/settings?workspace_id=ws_1`,
    );
  });

  it("forwards the D16 settings command POST with its body (the one mutation surface)", async () => {
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const { calls } = stubFetch(agentResponse);

    const request = new Request(
      "http://web.test/api/runtime/v1/agents/agent_general_assistant/settings/commands",
      {
        method: "POST",
        body: JSON.stringify({ type: "agent_settings.reset_all" }),
        headers: { "content-type": "application/json" },
      },
    );
    const response = await proxyToLocalApi(
      request,
      "/v1/agents/agent_general_assistant/settings/commands",
    );

    expect(response.status).toBe(200);
    const call = calls[0]!;
    expect(String(call.input)).toBe(
      `${RUNTIME_BASE}/v1/agents/agent_general_assistant/settings/commands`,
    );
    expect(call.init?.body).toBe(JSON.stringify({ type: "agent_settings.reset_all" }));
  });

  it("still refuses the chunk-2 PATCH routes — the commands endpoint is the only agent mutation", async () => {
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
