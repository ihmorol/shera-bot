/**
 * Runtime node bootstrap (S07 5a) — minimal composition root entry.
 *
 * Config comes from the environment with loopback-safe defaults: RUNTIME_HOST
 * (default 127.0.0.1 — the gateway never binds a public interface here; D2,
 * D11), RUNTIME_PORT (default 8080), RUNTIME_DB_PATH (default ./data/runtime.db).
 * No secrets are read from the environment (G3) — credentials belong to the
 * internal channel's credential store, provisioned by the control plane (S06).
 *
 * Composition reuses composeRuntime(): ONE HTTP server serving the typed
 * local API and the WebSocket gateway, over the container-local SQLite
 * database (WAL, foreign keys, committed migrations). Clean shutdown: stop()
 * stops accepting connections, closes the WebSocket gateway (Socket.IO closes
 * the HTTP server it is mounted on), then closes SQLite. SIGINT/SIGTERM are
 * wired only when `signals: true` is passed — the real entrypoint opts in;
 * tests drive stop() directly. Process supervision is a later slice's concern.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_WORKSPACE_ID,
  composeRuntime,
  type RuntimeHandle,
} from "./transport/local-api/compose.ts";

export interface RuntimeNodeConfig {
  /** Bind address; default 127.0.0.1 (loopback only). */
  host?: string;
  /** Listen port; 0 picks an ephemeral port. Default 8080. */
  port?: number;
  /** SQLite database path; parent directory is created if missing. */
  dbPath?: string;
  /**
   * E12: the container's default workspace for harness-driven runs.
   * Default: RUNTIME_DEFAULT_WORKSPACE_ID, else DEFAULT_WORKSPACE_ID
   * ("ws-local-default" — a PROTOTYPE default the owner must confirm).
   */
  defaultWorkspaceId?: string;
  /** Install SIGINT/SIGTERM handlers that drain and stop the node. Default false. */
  signals?: boolean;
}

export interface RuntimeNode {
  host: string;
  /** The bound port (resolved after listen — useful with ephemeral port 0). */
  port: number;
  /** Drains and stops everything; idempotent. */
  stop(): Promise<void>;
}

export interface RuntimeNodeEnvConfig {
  host: string;
  port: number;
  dbPath: string;
  defaultWorkspaceId: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_DB_PATH = join("data", "runtime.db");

/** Parse the environment into a node config; explicit values win. Pure (G3). */
export function runtimeConfigFromEnv(
  env: Record<string, string | undefined>,
  overrides: RuntimeNodeConfig = {},
): RuntimeNodeEnvConfig {
  const host = overrides.host ?? env["RUNTIME_HOST"] ?? DEFAULT_HOST;
  const rawPort = overrides.port ?? env["RUNTIME_PORT"];
  let port: number;
  if (rawPort === undefined || rawPort === "") {
    port = DEFAULT_PORT;
  } else {
    port = typeof rawPort === "number" ? rawPort : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      // Honest configuration failure (G4): a bad port is a clear error state,
      // never a silent fallback.
      throw new Error(`RUNTIME_PORT is not a valid port: ${String(rawPort)}`);
    }
  }
  const dbPath = overrides.dbPath ?? env["RUNTIME_DB_PATH"] ?? DEFAULT_DB_PATH;
  const defaultWorkspaceId =
    overrides.defaultWorkspaceId ?? env["RUNTIME_DEFAULT_WORKSPACE_ID"] ?? DEFAULT_WORKSPACE_ID;
  return { host, port, dbPath, defaultWorkspaceId };
}

/** Start the runtime node: compose, bind, (optionally) wire shutdown signals. */
export async function startRuntimeNode(config: RuntimeNodeConfig = {}): Promise<RuntimeNode> {
  const { host, port, dbPath, defaultWorkspaceId } = runtimeConfigFromEnv(process.env, config);
  mkdirSync(dirname(dbPath), { recursive: true });

  const runtime: RuntimeHandle = composeRuntime({ dbPath, workspaceId: defaultWorkspaceId });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    runtime.httpServer.once("error", onError);
    runtime.httpServer.listen(port, host, () => {
      runtime.httpServer.off("error", onError);
      resolve();
    });
  });
  const address = runtime.httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
    // gateway.close() closes the WebSocket engine AND the HTTP server it is
    // mounted on; composeRuntime then closes SQLite. Draining in-flight work
    // beyond Socket.IO's own shutdown is later-slice supervision.
    await runtime.close();
  };

  if (config.signals) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        void stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.on(signal, handler);
      signalHandlers.set(signal, handler);
    }
  }

  return { host, port: boundPort, stop };
}
