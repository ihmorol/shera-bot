import { proxyToControlPlane } from "@/lib/server/proxies";

/**
 * Web → control-plane proxy route (S09 chunk 1): everything under
 * /api/control/* forwards verbatim to the deployment's control plane
 * (CONTROL_PLANE_URL) — /api/control/api/session, /api/control/api/runtime/*,
 * and the Auth.js surfaces the client needs. The control plane owns routing
 * and its typed redacted error bodies pass through untouched.
 *
 * Always dynamic: session and lifecycle answers are never cached.
 */
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const upstreamPath = url.pathname.replace(/^\/api\/control/, "");
  return proxyToControlPlane(request, upstreamPath);
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH };
