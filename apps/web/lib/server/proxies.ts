import { randomUUID } from "node:crypto";

/**
 * Web server-side proxies (S09 chunk 1).
 *
 * The browser talks to THIS origin only; the Next server forwards two scoped
 * surfaces deployment-internally:
 *
 * 1. control-plane proxy → S05 auth/session + S06 runtime lifecycle at
 *    CONTROL_PLANE_URL (session resolution, provisioning status, the explicit
 *    provision trigger). Auth.js session cookies flow through on both legs.
 * 2. runtime proxy → the container-local S07 local API at
 *    RUNTIME_LOCAL_API_URL, with a STRICT path allowlist (only the surfaces
 *    the client uses: the two conversation surfaces and the four S11 agent
 *    surfaces — never /internal/*, never the chunk-2 agent PATCH routes). The
 *    local API stays loopback-only; the proxy is the prototype's deployment seam
 *    and carries NO authentication in this slice — the principal-to-workspace
 *    binding arrives with the authenticated transport wiring (recorded S07
 *    posture). Documented honestly here rather than hidden (G4).
 *
 * Both are transport-only: typed SheraError bodies the services already
 * redacted pass through verbatim (D23 rule 4), as do response redirects
 * (location) and cache-control directives; nothing is logged or rewritten
 * (G3). An unconfigured deployment is a first-class honest state, never a
 * fake success.
 */

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
  const allowed =
    request.method === "POST" && upstreamPath === "/v1/conversations/commands"
      ? true
      : request.method === "GET" && /^\/v1\/conversations\/[^/]+\/events$/.test(upstreamPath)
        ? true
        : request.method === "GET" && upstreamPath === "/v1/agents"
          ? true
          : request.method === "GET" && /^\/v1\/agents\/[^/]+$/.test(upstreamPath)
            ? true
            : request.method === "GET" && /^\/v1\/agents\/[^/]+\/settings$/.test(upstreamPath)
              ? true
              : request.method === "POST" &&
                  /^\/v1\/agents\/[^/]+\/settings\/commands$/.test(upstreamPath)
                ? true
                : false;
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
  return forward(request, process.env["RUNTIME_LOCAL_API_URL"], upstreamPath);
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
      headers,
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return typedFailure(PROXY_UNREACHABLE, 503);
  }

  const payload = await response.text();
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
