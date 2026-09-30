import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControlPlaneError,
  fetchRuntimeStatus,
  fetchSession,
  provisionRuntime,
} from "../lib/control-plane-client";

/**
 * Typed control-plane client (S09 chunk 1): every failure is the S02 typed
 * taxonomy parsed from the proxy's SheraError body (D23 rule 4); drifted or
 * non-typed payloads fail loudly into honest fallbacks, never into fabricated
 * successes. fetch is stubbed at the boundary — the proxy itself is a thin
 * forwarder exercised by its own module contract.
 */

const SESSION_BODY = {
  workspace_id: "ws_account-1",
  google_sub: "google-sub-1",
  email: "emon@example.com",
  display_name: "Emon",
  tier: "balanced",
  is_admin: false,
  created_at: "2026-09-01T10:00:00Z",
  last_active_at: "2026-09-30T10:00:00Z",
};

const STATUS_BODY = {
  runtime_handle: `rt_${"a".repeat(32)}`,
  account_id: "account-1",
  tier: "balanced",
  provisioning_status: "running",
  health: "healthy",
  resource_summary: {
    tier: "balanced",
    cpu_vcpus: 2,
    memory_bytes: 4 * 1024 ** 3,
    storage_bytes: 25 * 1024 ** 3,
  },
  checked_at: "2026-09-30T10:00:00Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSession", () => {
  it("parses the S02 session projection from the proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SESSION_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const session = await fetchSession();
    expect(session.workspace_id).toBe("ws_account-1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/control/api/session");
  });

  it("raises the typed UNAUTHENTICATED error from the 401 body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          code: "UNAUTHENTICATED",
          category: "unauthorized",
          safe_message: "Sign in to continue.",
          retryable: false,
          user_action: "Continue with Google.",
          internal_details: null,
          correlation_id: "corr-1",
        }),
      ),
    );

    const error = await fetchSession().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlPlaneError);
    if (!(error instanceof ControlPlaneError)) throw new Error("expected ControlPlaneError");
    expect(error.sheraError.code).toBe("UNAUTHENTICATED");
    expect(error.sheraError.retryable).toBe(false);
  });

  it("a non-typed failure body maps to the honest fallback, not internals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, "<html>boom</html>")));

    const error = await fetchSession().catch((caught: unknown) => caught);
    if (!(error instanceof ControlPlaneError)) throw new Error("expected ControlPlaneError");
    expect(error.sheraError.code).toBe("INTERNAL_ERROR");
    expect(error.sheraError.internal_details).toBeNull();
  });

  it("a 2xx body that fails its contract is a server drift, raised honestly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { drifted: true })));

    const error = await fetchSession().catch((caught: unknown) => caught);
    if (!(error instanceof ControlPlaneError)) throw new Error("expected ControlPlaneError");
    expect(error.sheraError.code).toBe("INTERNAL_ERROR");
  });

  it("an unreachable origin is a retryable transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));

    const error = await fetchSession().catch((caught: unknown) => caught);
    if (!(error instanceof ControlPlaneError)) throw new Error("expected ControlPlaneError");
    expect(error.sheraError.retryable).toBe(true);
    expect(error.sheraError.code).toBe("RESOURCE_UNAVAILABLE");
  });
});

describe("runtime lifecycle calls", () => {
  it("fetchRuntimeStatus parses the D12 opaque status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, STATUS_BODY)));

    const status = await fetchRuntimeStatus();
    expect(status.runtime_handle).toMatch(/^rt_[0-9a-f]{32}$/);
    expect(status.provisioning_status).toBe("running");
  });

  it("provisionRuntime POSTs the explicit trigger and parses the result", async () => {
    // ProvisionRuntimeResult (strict) has provisioned_at, not checked_at.
    const provisionBody = { ...STATUS_BODY, provisioned_at: "2026-09-30T10:00:00Z" };
    delete (provisionBody as Record<string, unknown>)["checked_at"];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, provisionBody));
    vi.stubGlobal("fetch", fetchMock);

    const provisioned = await provisionRuntime();
    expect(provisioned.provisioning_status).toBe("running");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
  });

  it("RUNTIME_NOT_PROVISIONED arrives as a typed retryable-where-marked error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: "RUNTIME_NOT_PROVISIONED",
          category: "state",
          safe_message: "No runtime has been provisioned for this account yet.",
          retryable: false,
          user_action: "Provision your runtime first.",
          internal_details: null,
          correlation_id: "corr-2",
        }),
      ),
    );

    const error = await fetchRuntimeStatus().catch((caught: unknown) => caught);
    if (!(error instanceof ControlPlaneError)) throw new Error("expected ControlPlaneError");
    expect(error.sheraError.code).toBe("RUNTIME_NOT_PROVISIONED");
    expect(error.sheraError.retryable).toBe(false);
  });
});
