/**
 * The E8 mock-runtime process entrypoint (S09 chunk 3).
 *
 * Chunk 1 composed the mock runtime in-process (startE2eMockRuntime); the
 * recovery probes need it as a real PROCESS so a crash can be induced against
 * real OS semantics — the probe kills this process with SIGKILL mid-stream and
 * restarts it on the SAME SQLite file, exercising the journal/WAL recovery
 * path no in-process test can reach.
 *
 * Mode selection stays explicit (chunk-1 contract): the entry only ever starts
 * the mock mode — RUNTIME_E2E_MOCK=1 is checked by the caller/launcher, and
 * the file refuses to start when the flag is absent so it can never be
 * mistaken for the production entrypoint (main.ts). Loopback-only binding is
 * inherited from startE2eMockRuntime (G3). Configuration comes from the same
 * environment names the real entry uses (RUNTIME_HOST, RUNTIME_PORT,
 * RUNTIME_DB_PATH) — no secrets are read (G3).
 *
 * Readiness contract: once the HTTP+WS server is listening, the process prints
 * ONE JSON line `{"event":"mock_runtime_ready",...}` on stdout — the launcher
 * parses it for the bound port. On SIGINT/SIGTERM the runtime drains and exits.
 */
import { argv, env } from "node:process";
import { pathToFileURL } from "node:url";

import { isE2eMockMode, startE2eMockRuntime } from "./e2e-mode.ts";

export interface MockRuntimeMainConfig {
  host: string;
  port: number;
  dbPath: string | undefined;
}

/** Parse the process env into the mock entry config. Pure (G3). */
export function mockRuntimeConfigFromEnv(
  env: Record<string, string | undefined>,
): MockRuntimeMainConfig {
  const host = env["RUNTIME_HOST"] ?? "127.0.0.1";
  const rawPort = env["RUNTIME_PORT"];
  let port = 0;
  if (rawPort !== undefined && rawPort !== "") {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      // Honest configuration failure (G4) — never a silent fallback.
      throw new Error(`RUNTIME_PORT is not a valid port: ${String(rawPort)}`);
    }
    port = parsed;
  }
  const dbPath = env["RUNTIME_DB_PATH"];
  return { host, port, dbPath: dbPath === "" ? undefined : dbPath };
}

/** Run the mock runtime until a termination signal arrives. */
export async function runMockRuntimeMain(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  // The mock entry is not the production entrypoint: without the explicit
  // mode flag it refuses to start (G4 — a mock can never be started by
  // accident in place of the real runtime).
  if (!isE2eMockMode(env)) {
    throw new Error(
      "The mock runtime entry requires RUNTIME_E2E_MOCK=1; the production entrypoint is main.ts.",
    );
  }
  const config = mockRuntimeConfigFromEnv(env);
  const runtime = await startE2eMockRuntime({
    host: config.host,
    port: config.port,
    ...(config.dbPath !== undefined ? { dbPath: config.dbPath } : {}),
  });
  process.stdout.write(
    `${JSON.stringify({
      event: "mock_runtime_ready",
      origin: runtime.origin,
      port: runtime.port,
      workspace_id: runtime.workspace_id,
      db_path: runtime.dbPath,
    })}\n`,
  );

  const drain = (): void => {
    void runtime
      .stop()
      .then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", drain);
  process.on("SIGTERM", drain);
}

// Run only when THIS file is the launched module — importing it (tests) never
// starts a runtime.
if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  void runMockRuntimeMain(env).catch((error: unknown) => {
    process.exitCode = 1;
    process.stderr.write(
      `${JSON.stringify({
        event: "mock_runtime_start_failed",
        reason: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  });
}
