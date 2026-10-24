/**
 * Runtime node bootstrap (S07 5a) — minimal composition root entry.
 *
 * Config comes from the environment with loopback-safe defaults: RUNTIME_HOST
 * (default 127.0.0.1; a non-loopback bind is REFUSED unless
 * RUNTIME_ALLOW_NON_LOOPBACK_BIND=1 is set — the unauthenticated local surface
 * stays scoped to the container, PRD §16; D2, D11), RUNTIME_PORT (default
 * 8080), RUNTIME_DB_PATH (default ./data/runtime.db).
 * No secrets are read from the environment (G3) — credentials belong to the
 * internal channel's credential store, provisioned by the control plane (S06).
 *
 * Composition reuses composeRuntime(): ONE HTTP server serving the typed
 * local API and the WebSocket gateway, over the container-local SQLite
 * database (WAL, foreign keys, committed migrations). Clean shutdown: stop()
 * stops accepting connections, closes the WebSocket gateway (Socket.IO closes
 * the HTTP server it is mounted on), then closes SQLite. SIGINT/SIGTERM are
 * wired only when `signals: true` is passed — the real entrypoint opts in;
 * tests drive stop() directly. S12: stop() drains the supervised Agent
 * session children (when a harness command is configured) before the
 * transport goes down.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionHarnessConfig } from "./adapters/process/session-process-spawn.ts";
import {
  DEFAULT_WORKSPACE_ID,
  composeRuntime,
  type RuntimeHandle,
} from "./transport/local-api/compose.ts";
import {
  createManagementServer,
  managementConfigFromEnv,
  type ManagementConfig,
} from "./modules/runtime/management-server.ts";
import { defaultPacksRoot } from "./modules/runtime/pack-pin.ts";

export interface RuntimeNodeConfig {
  management?: ManagementConfig;
  /** Bind address; default 127.0.0.1 (loopback only). */
  host?: string;
  /** Listen port; 0 picks an ephemeral port. Default 8080. */
  port?: number;
  /**
   * SQLite database path; parent directory is created if missing. The
   * journal's lifetime is the container filesystem's lifetime — a container
   * recreate wipes it; recovery/restore is owned by S31/S32.
   */
  dbPath?: string;
  /**
   * E12: the container's default workspace for harness-driven runs.
   * Default: RUNTIME_DEFAULT_WORKSPACE_ID, else DEFAULT_WORKSPACE_ID
   * ("ws-local-default" — a PROTOTYPE default the owner must confirm).
   */
  defaultWorkspaceId?: string;
  /**
   * S10 (D19/D28): directory of loadable agent packs. Default:
   * RUNTIME_PACKS_ROOT, else the repository's own agent-packs tree. The pack
   * is compatibility-checked against RUNTIME_VERSION at startup and pinned on
   * the default workspace (typed failure on mismatch — G4).
   */
  packsRoot?: string;
  /**
   * S12 (D32 layer 2): the configured session harness command. When set, the
   * composed runtime supervises warm Agent sessions (on-demand starts on the
   * first direct-chat message). Default: SHERA_SESSION_HARNESS_COMMAND, else
   * unset — the supervisor is DISABLED (G4: no harness command, no process
   * ever spawns, presence "none" everywhere, send path unchanged).
   */
  sessionHarness?: SessionHarnessConfig;
  /** Install SIGINT/SIGTERM handlers that drain and stop the node. Default false. */
  signals?: boolean;
}

export interface RuntimeNode {
  /** Authenticated management listener; null in standalone local mode. */
  managementPort: number | null;
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
  /** S10: the resolved agent-packs root (env, override, or the repo default). */
  packsRoot: string;
  /**
   * S12: the resolved session harness command, or null when none is
   * configured (supervisor disabled — G4).
   */
  sessionHarness: SessionHarnessConfig | null;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_DB_PATH = join("data", "runtime.db");

/** Loopback hosts: localhost, the 127.0.0.0/8 range, and ::1. Anything else needs the opt-in. */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * S12: the session harness command from the environment. The command is one
 * executable path; SHERA_SESSION_HARNESS_ARGS is a whitespace-split argument
 * list (no shell, no quoting layer — G3/G4: nothing is interpolated, and the
 * documented `{session_id}` / `{heartbeat_interval_ms}` placeholders are
 * substituted per spawn by the adapter). Empty/absent → null (disabled).
 */
function sessionHarnessFromEnv(
  env: Record<string, string | undefined>,
  overrides: RuntimeNodeConfig,
): SessionHarnessConfig | null {
  if (overrides.sessionHarness !== undefined) {
    return overrides.sessionHarness;
  }
  const command = env["SHERA_SESSION_HARNESS_COMMAND"];
  if (command === undefined || command.trim() === "") {
    return null;
  }
  const rawArgs = env["SHERA_SESSION_HARNESS_ARGS"];
  const args =
    rawArgs === undefined || rawArgs.trim() === ""
      ? []
      : rawArgs.trim().split(/\s+/);
  return { command, args };
}

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
  if (!isLoopbackHost(host) && env["RUNTIME_ALLOW_NON_LOOPBACK_BIND"] !== "1") {
    // Honest configuration failure (G4, C-6): the local API is unauthenticated
    // in this slice and PRD §16 scopes localhost services to the container, so
    // a non-loopback bind is refused unless explicitly opted in. The opt-in is
    // read from the ENVIRONMENT only — an explicit programmatic override
    // cannot grant it to itself.
    throw new Error(
      `RUNTIME_HOST ${host} is not a loopback address; refusing to bind the unauthenticated local surface. Set RUNTIME_ALLOW_NON_LOOPBACK_BIND=1 to allow it.`,
    );
  }
  const dbPath = overrides.dbPath ?? env["RUNTIME_DB_PATH"] ?? DEFAULT_DB_PATH;
  const defaultWorkspaceId =
    overrides.defaultWorkspaceId ?? env["RUNTIME_DEFAULT_WORKSPACE_ID"] ?? DEFAULT_WORKSPACE_ID;
  const packsRoot =
    overrides.packsRoot ?? env["RUNTIME_PACKS_ROOT"] ?? defaultPacksRoot(import.meta.dirname);
  const sessionHarness = sessionHarnessFromEnv(env, overrides);
  return { host, port, dbPath, defaultWorkspaceId, packsRoot, sessionHarness };
}

/** Start the runtime node: compose, bind, (optionally) wire shutdown signals. */
export async function startRuntimeNode(config: RuntimeNodeConfig = {}): Promise<RuntimeNode> {
  const management = config.management ?? managementConfigFromEnv(process.env);
  const {
    host,
    port,
    dbPath,
    defaultWorkspaceId: configuredWorkspace,
    packsRoot,
    sessionHarness,
  } = runtimeConfigFromEnv(process.env, config);
  const defaultWorkspaceId = management ? `ws_${management.accountId}` : configuredWorkspace;
  if (management && !isLoopbackHost(host))
    throw new Error("managed runtime local API must bind loopback");
  if (
    management &&
    (config.defaultWorkspaceId || process.env.RUNTIME_DEFAULT_WORKSPACE_ID) &&
    configuredWorkspace !== defaultWorkspaceId
  ) {
    throw new Error("runtime workspace does not match the provisioned account");
  }
  mkdirSync(dirname(dbPath), { recursive: true });

  const runtime: RuntimeHandle = composeRuntime({
    dbPath,
    workspaceId: defaultWorkspaceId,
    packsRoot,
    // S12 (D32 layer 2): the supervised warm Agent session when a harness
    // command is configured; absent otherwise (supervisor disabled, G4).
    ...(sessionHarness ? { sessionHarness } : {}),
  });
  let managementServer: ReturnType<typeof createManagementServer> | undefined;
  let managementPort: number | null = null;
  let boundPort: number;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      runtime.httpServer.once("error", onError);
      runtime.httpServer.listen(port, host, () => {
        runtime.httpServer.off("error", onError);
        resolve();
      });
    });
    const address = runtime.httpServer.address();
    boundPort = typeof address === "object" && address ? address.port : port;

    if (management) {
      managementServer = createManagementServer(management, runtime.app, dbPath, boundPort);
      const server = managementServer;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(management.port, management.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      managementPort = typeof address === "object" && address ? address.port : null;
    }
  } catch (error) {
    managementServer?.closeLiveConnections();
    managementServer?.close();
    await runtime.close();
    throw error;
  }

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
    if (managementServer) {
      managementServer.closeLiveConnections();
      await new Promise<void>((resolve, reject) =>
        managementServer!.close((error) => (error ? reject(error) : resolve())),
      );
    }
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

  return { host, port: boundPort, managementPort, stop };
}
