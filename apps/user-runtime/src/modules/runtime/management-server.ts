import {
  createServer,
  request as requestHttp,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import { join, dirname } from "node:path";
import type { Duplex } from "node:stream";
import type { Express } from "express";
import { Id } from "@shera-bot/contracts";
import { channelState } from "../../adapters/fs/channel-state.ts";
import { ChannelCredentialStore } from "./channel-credentials.ts";
import { createInternalApi, InMemorySecurityEventRecorder } from "./internal-api.ts";
import type { RuntimeAdminCommandsHandle } from "../admin/runtime-admin-commands.ts";

export interface ManagementConfig {
  host: string;
  port: number;
  accountId: string;
  credentialSha256: string;
}
export interface ManagementServer extends Server {
  closeLiveConnections(): void;
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 404 | 502 | 504): void {
  const reason =
    status === 401
      ? "Unauthorized"
      : status === 404
        ? "Not Found"
        : status === 502
          ? "Bad Gateway"
          : status === 504
            ? "Gateway Timeout"
            : "Bad Request";
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function channelBearer(header: string | undefined): string | null {
  const match = header ? /^Bearer (.+)$/s.exec(header) : null;
  return match?.[1] || null;
}

function websocketHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return {
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

function isLiveUpgrade(request: IncomingMessage): boolean {
  try {
    const url = new URL(request.url ?? "", "http://runtime.invalid");
    return (
      request.method === "GET" &&
      url.pathname === "/internal/v1/live" &&
      [...url.searchParams].length === 2 &&
      url.searchParams.get("EIO") === "4" &&
      url.searchParams.get("transport") === "websocket"
    );
  } catch {
    return false;
  }
}
export function managementConfigFromEnv(env: NodeJS.ProcessEnv): ManagementConfig | undefined {
  const digest = env.SHERA_INTERNAL_CHANNEL_CREDENTIAL_SHA256;
  if (!digest) return undefined;
  const accountId = Id.parse(env.SHERA_ACCOUNT_ID);
  const port = Number(env.SHERA_INTERNAL_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SHERA_INTERNAL_PORT must be a valid port");
  return { host: "0.0.0.0", port, accountId, credentialSha256: digest };
}
export function createManagementServer(
  config: ManagementConfig,
  localApi: Express,
  dbPath: string,
  localPort: number,
  /** S32: the composed admin command seam (issue #33). */
  adminCommands?: RuntimeAdminCommandsHandle,
): ManagementServer {
  Id.parse(config.accountId);
  const state = channelState(
    join(dirname(dbPath), ".runtime-control", "channel.json"),
    config.credentialSha256,
  );
  let loaded = false;
  let invalidateLiveConnections = (): void => undefined;
  const credentials = new ChannelCredentialStore((values) => {
    if (loaded) {
      state.save(values);
      if (values.length === 1) invalidateLiveConnections();
    }
  });
  for (const value of state.digests) credentials.admitDigest(value);
  loaded = true;
  state.save(state.digests);
  const securityEvents = new InMemorySecurityEventRecorder();
  const internal = createInternalApi({
    credentials,
    accountId: config.accountId,
    localApi,
    securityEvents,
    ...(adminCommands ? { adminCommands } : {}),
  });
  const server = createServer(internal.app) as ManagementServer;
  const liveSockets = new Set<Duplex>();
  const pendingRequests = new Set<ReturnType<typeof requestHttp>>();
  const peers = new Map<Duplex, Duplex>();
  const closeSocket = (socket: Duplex): void => {
    const peer = peers.get(socket);
    peers.delete(socket);
    liveSockets.delete(socket);
    socket.destroy();
    if (peer) {
      peers.delete(peer);
      liveSockets.delete(peer);
      peer.destroy();
    }
  };
  const trackPair = (left: Duplex, right: Duplex): void => {
    liveSockets.add(left);
    liveSockets.add(right);
    peers.set(left, right);
    peers.set(right, left);
    left.once("close", () => closeSocket(left));
    right.once("close", () => closeSocket(right));
    left.once("error", () => closeSocket(left));
    right.once("error", () => closeSocket(right));
  };
  server.closeLiveConnections = () => {
    for (const request of pendingRequests) request.destroy();
    pendingRequests.clear();
    for (const socket of liveSockets) socket.destroy();
    liveSockets.clear();
    peers.clear();
  };
  invalidateLiveConnections = server.closeLiveConnections;
  server.on("upgrade", (request, downstream, downstreamHead) => {
    downstream.on("error", () => downstream.destroy());
    if (!isLiveUpgrade(request)) {
      rejectUpgrade(downstream, 404);
      return;
    }
    const bearer = channelBearer(request.headers.authorization);
    if (!bearer || !credentials.verifies(bearer)) {
      securityEvents.record({
        event: "internal_channel_rejected",
        reason: bearer ? "invalid_credential" : "missing_bearer",
        path: "/internal/v1/live",
        occurred_at: new Date().toISOString(),
      });
      rejectUpgrade(downstream, 401);
      return;
    }

    const upstream = requestHttp({
      host: "127.0.0.1",
      port: localPort,
      method: "GET",
      path: "/socket.io/?EIO=4&transport=websocket",
      headers: websocketHeaders(request.headers),
    });
    pendingRequests.add(upstream);
    downstream.once("close", () => upstream.destroy());
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingRequests.delete(upstream);
      upstream.destroy();
      rejectUpgrade(downstream, 504);
    }, 10_000);
    upstream.once("upgrade", (response, upstreamSocket, upstreamHead) => {
      if (settled || downstream.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingRequests.delete(upstream);
      trackPair(downstream, upstreamSocket);
      const responseHeaders: string[] = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
      }
      downstream.write(
        `HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join("\r\n")}\r\n\r\n`,
      );
      if (upstreamHead.length > 0) downstream.write(upstreamHead);
      if (downstreamHead.length > 0) upstreamSocket.write(downstreamHead);
      downstream.pipe(upstreamSocket).pipe(downstream);
    });
    upstream.once("response", (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRequests.delete(upstream);
      response.resume();
      rejectUpgrade(downstream, 502);
    });
    upstream.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingRequests.delete(upstream);
      rejectUpgrade(downstream, 502);
    });
    upstream.end();
  });
  return server;
}
