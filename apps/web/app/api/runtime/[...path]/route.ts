import { proxyToLocalApi } from "@/lib/server/proxies";

/**
 * Web → runtime local API proxy route (S09 chunk 1): forwards the two
 * conversation surfaces the client uses to the container-local S07 local API
 * (RUNTIME_LOCAL_API_URL):
 *
 *   POST /api/runtime/v1/conversations/commands        (D26 mutation path)
 *   GET  /api/runtime/v1/conversations/:id/events      (cursor replay)
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
