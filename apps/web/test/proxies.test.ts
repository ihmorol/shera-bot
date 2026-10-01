import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyToControlPlane, proxyToLocalApi } from "../lib/server/proxies";

/**
 * The web server-side proxies (S09 chunk 1) as their own module contract: the
 * browser talks to THIS origin only, and the forwarder must be transparent —
 * status, typed bodies, set-cookie, and (fix round) REDIRECTS. The Google
 * sign-in 302's `location` header IS the OAuth handoff (container-gate links
 * /api/control/api/auth/signin/google on this origin); a proxy that dropped
 * it broke the sign-in button silently. fetch is stubbed at the boundary —
 * the E2E exercises proxyToLocalApi against the real mock runtime.
 */

const CONTROL_BASE = "http://control-plane.test";
const RUNTIME_BASE = "http://runtime-local.test";

function upstream_302(): Response {
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
    const fetchMock = vi.fn(() => Promise.resolve(upstream_302()));
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://web.test/api/control/api/auth/signin/google", {
      method: "GET",
    });
    const response = await proxyToControlPlane(request, "/api/auth/signin/google");

    // The upstream was called on the control-plane leg with the forwarded path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${CONTROL_BASE}/api/auth/signin/google`);

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
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ kind: "events", events: [] }), {
          status: 200,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://web.test/api/runtime/v1/conversations/conv-1/events", {
      method: "GET",
    });
    const response = await proxyToLocalApi(request, "/v1/conversations/conv-1/events");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("the strict allowlist still refuses non-conversation paths", async () => {
    process.env["RUNTIME_LOCAL_API_URL"] = RUNTIME_BASE;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request("http://web.test/api/runtime/internal/whatever", {
      method: "GET",
    });
    const response = await proxyToLocalApi(request, "/internal/whatever");

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
