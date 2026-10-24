import { Router } from "express";
import { isBrowserRuntimePath, runtimeWorkspaceMatches } from "@shera-bot/contracts";
import {
  routeNotFoundError,
  runtimeTenantMismatchError,
  runtimeUnavailableError,
  RuntimeOperationError,
  statusForError,
  unauthenticatedError,
} from "../errors.ts";
import { workspaceIdFor } from "../modules/session-projection.ts";

export interface RuntimeApiProxyDeps {
  targetForAccount(accountId: string): Promise<{ endpoint: string; bearer: string }>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Mounted only behind requireSession; the browser never supplies a runtime target. */
export function createRuntimeApiProxy(deps: RuntimeApiProxyDeps): Router {
  const router = Router();
  router.use(async (req, res) => {
    const user = res.locals.session?.user;
    if (!user?.id) {
      res.status(401).json(unauthenticatedError());
      return;
    }
    if (!isBrowserRuntimePath(req.method, req.path)) {
      res.status(404).json(routeNotFoundError());
      return;
    }
    const query = new URL(req.url, "http://runtime.invalid").searchParams;
    if (!runtimeWorkspaceMatches(req.method, query, req.body, workspaceIdFor(user.id))) {
      const error = runtimeTenantMismatchError();
      res.status(403).json(error.sheraError);
      return;
    }
    // A browser may send user text, never forge an Agent's message identity.
    const body: unknown = req.method === "POST" ? structuredClone(req.body) : undefined;
    if (isJsonObject(body) && body["type"] === "message.send" && isJsonObject(body["payload"])) {
      body.payload.sender = { kind: "user", display_name: user.name || "User" };
    }
    if (isJsonObject(body) && req.path.endsWith("/settings/commands")) {
      body.actor = { type: "user", id: user.id };
    }
    try {
      const target = await deps.targetForAccount(user.id);
      const upstream = await fetch(
        `${target.endpoint.replace(/\/$/, "")}/internal/v1/local${req.path}?${query}`,
        {
          method: req.method,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${target.bearer}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      res
        .status(upstream.status)
        .set("cache-control", "no-store")
        .type("application/json")
        .send(await upstream.text());
    } catch (error) {
      const typed = error instanceof RuntimeOperationError ? error : runtimeUnavailableError();
      res.status(statusForError(typed.sheraError)).json(typed.sheraError);
    }
  });
  return router;
}
