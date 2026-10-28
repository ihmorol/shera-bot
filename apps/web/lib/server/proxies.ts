import { randomUUID } from "node:crypto";
import { Session, isBrowserRuntimePath, runtimeWorkspaceMatches } from "@shera-bot/contracts";

/**
 * The S20 review fixes (F1/F2): on the BROWSER path the approval mutations
 * that name an acting user bind that user SERVER-SIDE from the authenticated
 * session — the body-asserted `decided_by` (decision) / `created_by` (mute)
 * is overwritten, so the audit trail is the session's google_sub, never a
 * client-chosen identity. Direct runtime-API callers (no proxy) are the
 * documented systemic exception: the local routes still relay their body
 * actor (the pre-existing prototype pattern). The session contract guarantees
 * google_sub once Session parses; the explicit typed 401 below is the
 * defensive answer for a session-shaped body that somehow carries no identity
 * — the same UNAUTHENTICATED failure shape the control plane serves.
 */
const SESSION_ACTOR_BINDINGS: ReadonlyArray<{ pathPattern: RegExp; bodyField: string }> = [
  { pathPattern: /^\/v1\/approvals\/[a-zA-Z0-9_-]+\/decision$/, bodyField: "decided_by" },
  { pathPattern: /^\/v1\/approvals\/mutes$/, bodyField: "created_by" },
  // S19 chunk 2 (PRD §10, G6): the merge-review decision binds the session's
  // user server-side exactly like the approval decision — agents never
  // decide, and a client-chosen identity never reaches the runtime.
  {
    pathPattern: /^\/v1\/projects\/[a-zA-Z0-9_-]+\/merge-requests\/[a-zA-Z0-9_-]+\/decision$/,
    bodyField: "decided_by",
  },
];

/** The 401 failure shape for a request whose session carries no usable identity. */
const SESSION_IDENTITY_REQUIRED: TypedFailure = {
  code: "UNAUTHENTICATED",
  category: "authentication",
  safe_message: "Sign in to continue.",
  retryable: false,
  user_action: "Sign in with Google.",
  internal_details: null,
};

/** Browser requests pass through the authenticated control plane, which owns
 * per-account runtime routing. No browser request selects an internal endpoint. */
interface TypedFailure {
  code: string;
  category: string;
  safe_message: string;
  retryable: boolean;
  user_action: string | null;
  internal_details: null;
}

const PROXY_UNCONFIGURED: TypedFailure = {
  code: "AUTH_CONFIGURATION_INVALID",
  category: "internal",
  safe_message: "This deployment is not fully configured; the workspace cannot be resolved.",
  retryable: false,
  user_action: "Contact the operator.",
  internal_details: null,
};

const PROXY_UNREACHABLE: TypedFailure = {
  code: "RESOURCE_UNAVAILABLE",
  category: "resource",
  safe_message: "The connection to Shera failed. You can try again.",
  retryable: true,
  user_action: "Try again shortly.",
  internal_details: null,
};

/**
 * Forward a browser call to the control plane. `upstreamPath` starts at the
 * control-plane root (e.g. "/api/session"), so the control plane owns its
 * routing — the web app adds no paths of its own.
 */
export async function proxyToControlPlane(
  request: Request,
  upstreamPath: string,
): Promise<Response> {
  return forward(request, process.env["CONTROL_PLANE_URL"], upstreamPath);
}

/**
 * Forward a browser call to the container's local API. The reachable surfaces
 * are exactly the ones the client uses — the two conversation surfaces (S07)
 * and the four S11 agent surfaces (roster, detail, settings snapshot, settings
 * commands). Any other path — notably the chunk-2 agent PATCH routes the UI
 * must not use (D16: commands are the one mutation surface) and the internal
 * channel under /internal/* — is refused here, typed 404.
 */
export async function proxyToLocalApi(request: Request, upstreamPath: string): Promise<Response> {
  const allowed = isBrowserRuntimePath(request.method, upstreamPath);
  if (!allowed) {
    return Response.json(
      {
        code: "ROUTE_NOT_FOUND",
        category: "validation",
        safe_message: "The requested resource does not exist.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: randomUUID(),
      },
      { status: 404 },
    );
  }
  const base = process.env["CONTROL_PLANE_URL"];
  const sessionResponse = await forward(
    new Request(new URL("/api/session", request.url), { headers: request.headers }),
    base,
    "/api/session",
  );
  if (!sessionResponse.ok) return sessionResponse;
  const session = Session.safeParse(await sessionResponse.json().catch(() => null));
  if (!session.success) return typedFailure(PROXY_UNCONFIGURED, 503);
  const url = new URL(request.url);
  if (
    request.method === "POST" &&
    request.headers.has("origin") &&
    request.headers.get("origin") !== process.env["SHERA_WEB_ORIGIN"]
  ) {
    return tenantMismatch();
  }
  let body: unknown = null;
  // S17: PUT/DELETE join POST as body-carrying methods — the workspace panel's
  // gated file write (PUT /v1/workspace/files) and the holder-task lease
  // release (DELETE /v1/workspace/leases/:id) carry workspace_id + actor in
  // the body, so the runtimeWorkspaceMatches binding below needs them parsed.
  if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") {
    try {
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 64 * 1024) {
              await reader.cancel();
              return typedFailure(
                {
                  code: "CONTRACT_VALIDATION_FAILED",
                  category: "validation",
                  safe_message: "The request body is too large.",
                  retryable: false,
                  user_action: null,
                  internal_details: null,
                },
                413,
              );
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      body = JSON.parse(raw);
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: raw,
      });
    } catch {
      return typedFailure(
        {
          code: "CONTRACT_VALIDATION_FAILED",
          category: "validation",
          safe_message: "The request body must be valid JSON.",
          retryable: false,
          user_action: null,
          internal_details: null,
        },
        400,
      );
    }
  }
  if (!runtimeWorkspaceMatches(request.method, url.searchParams, body, session.data.workspace_id))
    return tenantMismatch();
  // F1: the session-bound actor overrides the body's on the browser path for
  // the approval mutations that name one. The request is rebuilt with the
  // bound body — the runtime sees ONLY the session identity.
  const binding = SESSION_ACTOR_BINDINGS.find((entry) => entry.pathPattern.test(upstreamPath));
  if (binding && request.method === "POST") {
    const googleSub = session.data.google_sub;
    if (!googleSub) {
      return typedFailure(SESSION_IDENTITY_REQUIRED, 401);
    }
    const boundBody: Record<string, unknown> = {
      ...(typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}),
      [binding.bodyField]: { type: "user", id: googleSub },
    };
    request = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(boundBody),
    });
  }
  return forward(request, base, `/api/runtime/local${upstreamPath}`);
}

function tenantMismatch(): Response {
  return typedFailure(
    {
      code: "RUNTIME_TENANT_MISMATCH",
      category: "unauthorized",
      safe_message: "This workspace is not available to your account.",
      retryable: false,
      user_action: null,
      internal_details: null,
    },
    403,
  );
}

async function forward(
  request: Request,
  base: string | undefined,
  upstreamPath: string,
): Promise<Response> {
  if (!base) {
    return typedFailure(PROXY_UNCONFIGURED, 503);
  }
  const url = new URL(request.url);
  const upstream = `${base.replace(/\/$/, "")}${upstreamPath}${url.search}`;

  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }
  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  // Bodies forward for EVERY body-bearing method (POST, PUT, PATCH, DELETE —
  // not GET/HEAD): the runtime leg's allowlist only admits GET + POST, but
  // the control-plane leg owns its own routing and may grow body-bearing
  // methods; a dropped body would be a silent corruption, not a typed error.
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody ? await request.text() : undefined;

  let response: Response;
  try {
    response = await fetch(upstream, {
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
      headers,
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return typedFailure(PROXY_UNREACHABLE, 503);
  }

  const payload =
    request.method === "HEAD" || [204, 205, 304].includes(response.status)
      ? null
      : await response.text();
  const downstream = new Response(payload, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
  for (const setCookie of response.headers.getSetCookie()) {
    downstream.headers.append("set-cookie", setCookie);
  }
  // Redirect + cache directives pass through verbatim, like the typed bodies:
  // the Google sign-in 302's `location` IS the OAuth handoff (container-gate
  // links /api/control/api/auth/signin/google on this origin), so dropping it
  // silently broke the sign-in button; `cache-control` carries the upstream's
  // no-store directive so a redirect or session-bearing response is never
  // cached by the browser. Same-origin hop only — the location points at the
  // control plane's upstream OAuth provider, never at an internal surface.
  for (const header of ["location", "cache-control"] as const) {
    const value = response.headers.get(header);
    if (value) {
      downstream.headers.set(header, value);
    }
  }
  return downstream;
}

function typedFailure(body: TypedFailure, status: number): Response {
  return Response.json({ ...body, correlation_id: randomUUID() }, { status });
}
