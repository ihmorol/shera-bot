import { createHash } from "node:crypto";
import {
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { request as requestHttps } from "node:https";
import type { Duplex } from "node:stream";

import { getSession, type ExpressAuthConfig } from "@auth/express";
import { and, eq, gt } from "drizzle-orm";
import type { Request as ExpressRequest } from "express";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlAccounts, controlSessions } from "../db/schema.ts";
import type { ControlPlaneLogger } from "../logger.ts";
import type { SecretRegistry } from "../redaction.ts";
import { parseCookieHeader, SESSION_COOKIE_NAMES } from "../auth/session-middleware.ts";

interface LiveSession {
  accountId: string;
  expires: Date;
}

interface LivePeer {
  accountId: string;
  token: string;
  downstream: Duplex;
  upstream: Duplex;
  expiryTimer: NodeJS.Timeout;
  validationTimer: NodeJS.Timeout;
  validating: boolean;
}

export interface LiveRuntimeTransport {
  attach(server: Server): void;
  revokeSession(sessionToken: string): void;
  close(): void;
}

export interface LiveRuntimeTransportDeps {
  db: ControlPlaneDb;
  authConfig: ExpressAuthConfig;
  registry: SecretRegistry;
  trustedWebOrigin: string | undefined;
  targetForAccount(accountId: string): Promise<{ endpoint: string; bearer: string }>;
  logger: Pick<ControlPlaneLogger, "info" | "error">;
  sessionValidationIntervalMs?: number;
}

function sessionTokenOf(request: IncomingMessage): string | null {
  const cookies = parseCookieHeader(request.headers.cookie ?? "");
  for (const name of SESSION_COOKIE_NAMES) {
    const value = cookies.get(name);
    if (value) return value;
  }
  return null;
}

function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 404 | 503 | 504): void {
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 404
          ? "Not Found"
          : status === 503
            ? "Service Unavailable"
            : status === 504
              ? "Gateway Timeout"
              : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function isLiveUpgrade(request: IncomingMessage): boolean {
  try {
    const url = new URL(request.url ?? "", "http://control.invalid");
    return (
      request.method === "GET" &&
      url.pathname === "/api/runtime/live" &&
      [...url.searchParams].length === 2 &&
      url.searchParams.get("EIO") === "4" &&
      url.searchParams.get("transport") === "websocket"
    );
  } catch {
    return false;
  }
}

function websocketHeaders(headers: IncomingHttpHeaders, bearer: string): IncomingHttpHeaders {
  return {
    authorization: `Bearer ${bearer}`,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": headers["sec-websocket-key"],
    "sec-websocket-version": headers["sec-websocket-version"],
    ...(headers["sec-websocket-extensions"]
      ? { "sec-websocket-extensions": headers["sec-websocket-extensions"] }
      : {}),
    ...(headers["sec-websocket-protocol"]
      ? { "sec-websocket-protocol": headers["sec-websocket-protocol"] }
      : {}),
  };
}

function managementEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || url.hash || url.search) return null;
    return url;
  } catch {
    return null;
  }
}

async function findLiveSession(
  db: ControlPlaneDb,
  token: string,
  now = new Date(),
): Promise<LiveSession | null> {
  const [row] = await db
    .select({
      accountId: controlSessions.userId,
      expires: controlSessions.expires,
    })
    .from(controlSessions)
    .innerJoin(controlAccounts, eq(controlAccounts.id, controlSessions.userId))
    .where(
      and(
        eq(controlSessions.sessionToken, token),
        gt(controlSessions.expires, now),
        eq(controlAccounts.signupState, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function createLiveRuntimeTransport(deps: LiveRuntimeTransportDeps): LiveRuntimeTransport {
  let trustedWebOrigin: URL | null = null;
  try {
    const parsed = deps.trustedWebOrigin ? new URL(deps.trustedWebOrigin) : null;
    if (
      parsed &&
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash
    ) {
      trustedWebOrigin = parsed;
    }
  } catch {
    trustedWebOrigin = null;
  }
  const peers = new Set<LivePeer>();
  const pending = new Set<Duplex>();
  const peersBySession = new Map<string, Set<LivePeer>>();
  const intervalMs = deps.sessionValidationIntervalMs ?? 30_000;
  let attached = false;

  const removePeer = (peer: LivePeer): void => {
    if (!peers.delete(peer)) return;
    clearTimeout(peer.expiryTimer);
    clearInterval(peer.validationTimer);
    const key = sessionKey(peer.token);
    const sessionPeers = peersBySession.get(key);
    sessionPeers?.delete(peer);
    if (sessionPeers?.size === 0) peersBySession.delete(key);
  };
  const closePeer = (peer: LivePeer): void => {
    removePeer(peer);
    peer.downstream.destroy();
    peer.upstream.destroy();
  };
  const trackPeer = (peer: LivePeer): void => {
    peers.add(peer);
    const key = sessionKey(peer.token);
    const sessionPeers = peersBySession.get(key) ?? new Set<LivePeer>();
    sessionPeers.add(peer);
    peersBySession.set(key, sessionPeers);
    peer.downstream.once("close", () => closePeer(peer));
    peer.upstream.once("close", () => closePeer(peer));
    peer.downstream.once("error", () => closePeer(peer));
    peer.upstream.once("error", () => closePeer(peer));
  };

  const transport: LiveRuntimeTransport = {
    attach(server) {
      if (attached) throw new Error("live runtime transport is already attached");
      attached = true;
      server.on("upgrade", async (request, downstream, downstreamHead) => {
        downstream.on("error", () => downstream.destroy());
        if (!isLiveUpgrade(request)) {
          rejectUpgrade(downstream, 404);
          return;
        }
        if (!trustedWebOrigin || request.headers.origin !== trustedWebOrigin.origin) {
          rejectUpgrade(downstream, 403);
          return;
        }
        const token = sessionTokenOf(request);
        if (!token) {
          rejectUpgrade(downstream, 401);
          return;
        }
        deps.registry.register(token, "session-token");
        pending.add(downstream);
        downstream.once("close", () => pending.delete(downstream));

        let session: LiveSession | null;
        try {
          const authRequest = Object.assign(request, {
            protocol: trustedWebOrigin.protocol.slice(0, -1),
          }) as ExpressRequest;
          const validated = await getSession(authRequest, deps.authConfig);
          session = validated?.user?.id ? await findLiveSession(deps.db, token) : null;
          if (session?.accountId !== validated?.user?.id) session = null;
        } catch (error) {
          deps.logger.error("live_session_validation_failed", {
            error_type: error instanceof Error ? error.name : "Error",
          });
          pending.delete(downstream);
          rejectUpgrade(downstream, 503);
          return;
        }
        if (!session) {
          pending.delete(downstream);
          rejectUpgrade(downstream, 401);
          return;
        }
        if (downstream.destroyed) {
          pending.delete(downstream);
          return;
        }

        let target: { endpoint: string; bearer: string };
        try {
          target = await deps.targetForAccount(session.accountId);
        } catch {
          pending.delete(downstream);
          rejectUpgrade(downstream, 503);
          return;
        }
        const endpoint = managementEndpoint(target.endpoint);
        if (!endpoint) {
          deps.logger.error("live_runtime_endpoint_rejected", { account_id: session.accountId });
          pending.delete(downstream);
          rejectUpgrade(downstream, 503);
          return;
        }
        const requestUpgrade = endpoint.protocol === "https:" ? requestHttps : requestHttp;
        const upstream = requestUpgrade({
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          port: endpoint.port || undefined,
          method: "GET",
          path: "/internal/v1/live?EIO=4&transport=websocket",
          headers: websocketHeaders(request.headers, target.bearer),
        });
        downstream.once("close", () => upstream.destroy());
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          upstream.destroy();
          pending.delete(downstream);
          rejectUpgrade(downstream, 504);
        }, 10_000);
        upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
          if (settled || downstream.destroyed) {
            upstreamSocket.destroy();
            return;
          }
          settled = true;
          clearTimeout(timeout);
          pending.delete(downstream);
          const responseHeaders: string[] = [];
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            responseHeaders.push(
              `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`,
            );
          }
          downstream.write(
            `HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join("\r\n")}\r\n\r\n`,
          );
          if (upstreamHead.length > 0) downstream.write(upstreamHead);
          if (downstreamHead.length > 0) upstreamSocket.write(downstreamHead);

          const peer: LivePeer = {
            accountId: session.accountId,
            token,
            downstream,
            upstream: upstreamSocket,
            validating: false,
            expiryTimer: setTimeout(() => undefined, 0),
            validationTimer: setInterval(() => undefined, intervalMs),
          };
          clearTimeout(peer.expiryTimer);
          clearInterval(peer.validationTimer);
          peer.expiryTimer = setTimeout(
            () => closePeer(peer),
            Math.max(0, session.expires.getTime() - Date.now()),
          );
          peer.validationTimer = setInterval(() => {
            if (peer.validating) return;
            peer.validating = true;
            void findLiveSession(deps.db, peer.token)
              .then((current) => {
                if (!current || current.accountId !== peer.accountId) closePeer(peer);
              })
              .catch((error) => {
                deps.logger.error("live_session_revalidation_failed", {
                  account_id: peer.accountId,
                  error_type: error instanceof Error ? error.name : "Error",
                });
                closePeer(peer);
              })
              .finally(() => {
                peer.validating = false;
              });
          }, intervalMs);
          trackPeer(peer);
          downstream.pipe(upstreamSocket).pipe(downstream);
        });
        upstream.once("response", (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          pending.delete(downstream);
          response.resume();
          rejectUpgrade(downstream, 503);
        });
        upstream.once("error", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          pending.delete(downstream);
          rejectUpgrade(downstream, 503);
        });
        upstream.end();
      });
    },
    revokeSession(sessionToken) {
      for (const peer of peersBySession.get(sessionKey(sessionToken)) ?? []) closePeer(peer);
    },
    close() {
      for (const socket of pending) socket.destroy();
      pending.clear();
      for (const peer of [...peers]) closePeer(peer);
    },
  };
  return transport;
}
