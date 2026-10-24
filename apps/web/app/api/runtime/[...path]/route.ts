import { proxyToLocalApi } from "@/lib/server/proxies";

/**
 * Web → runtime local API proxy route (S09 chunk 1, extended in S11): forwards
 * the surfaces the client uses to the container-local local API
 * through the authenticated control plane (CONTROL_PLANE_URL):
 *
 *   POST /api/runtime/v1/conversations/commands        (D26 mutation path)
 *   GET  /api/runtime/v1/conversations/:id/events      (cursor replay)
 *   GET  /api/runtime/v1/agents                        (S11 roster)
 *   GET  /api/runtime/v1/agents/:agent_id              (S11 detail + direct chat)
 *   GET  /api/runtime/v1/agents/:agent_id/settings     (S11 D16 snapshot)
 *   POST /api/runtime/v1/agents/:agent_id/settings/commands (S11 D16 commands)
 *
 * The allowlist lives in the proxy — every other path (including the
 * internal channel under /internal/*) answers a typed 404 here. The proxied
 * surface is unauthenticated in this prototype slice; the authenticated
 * transport is a later chunk (recorded S07 posture).
 */
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const upstreamPath = url.pathname.replace(/^\/api\/runtime/, "");
  return proxyToLocalApi(request, upstreamPath);
}

export { handle as GET, handle as POST };
