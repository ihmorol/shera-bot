/**
 * E8 mock-runtime mode (S09 chunk 1) — the deterministic, in-process runtime
 * for the end-to-end thin slice.
 *
 * WHAT THIS IS: the full S07 composition (typed local API + WebSocket gateway
 * + container-local SQLite + the D51 harness seam) running entirely in
 * process, driven by the FakeHarnessAdapter's FIXED D8 script (queue → start
 * → one progress report → complete). The E2E test can drive the whole path —
 * sign-in surface aside, which belongs to the control plane — with no container engine
 * and no live providers, and every run proposal arrives in the same order
 * with the same payloads.
 *
 * MODE SELECTION: `RUNTIME_E2E_MOCK=1` in the environment (isE2eMockMode)
 * selects this mode for a process entrypoint; today the E2E harness calls
 * startE2eMockRuntime() directly and receives typed handles back. The flag is
 * read from the environment only — nothing here auto-detects CI or guesses.
 *
 * DETERMINISM CONTRACT (what "mock" promises):
 * - no child processes, no container engine, no provider network calls —
 *   the ONLY harness adapter wired here is the FakeHarnessAdapter (G4: the
 *   mode can never quietly grow a live dependency; the process-backed Pi
 *   adapter stays out by construction);
 * - a FIXED clock (E2E_MOCK_FIXED_EPOCH) stamps harness events, so the D8
 *   script's journal output is byte-comparable apart from identity UUIDs
 *   (event ids are identity, not behavior);
 * - a DISPOSABLE database: without an explicit dbPath each start gets a fresh
 *   temp-dir SQLite file, so a stopped-and-restarted mock never inherits
 *   state (the caller owns removing the directory).
 *
 * The loopback-only posture of the local API is unchanged (main.ts): the mock
 * binds 127.0.0.1 and refuses any non-loopback host, because the surface is
 * unauthenticated in this slice (PRD §16, G3). The composition's own HTTP
 * server is used directly — the WebSocket gateway is mounted on it at compose
 * time, so both surfaces share one port (S07).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeHarnessAdapter } from "../adapters/process/fake-harness-adapter.ts";
import { HarnessRunService } from "../modules/runtime/harness-run-service.ts";
import { DEFAULT_SCRIPTED_REPLY } from "../modules/conversations/reply-streamer.ts";
import {
  composeRuntime,
  DEFAULT_WORKSPACE_ID,
  type RuntimeHandle,
} from "../transport/local-api/compose.ts";

/** The environment flag that selects the E8 mock mode for an entrypoint. */
export const E2E_MOCK_ENV_FLAG = "RUNTIME_E2E_MOCK";

export function isE2eMockMode(env: Record<string, string | undefined>): boolean {
  return env[E2E_MOCK_ENV_FLAG] === "1";
}

/** The fixed epoch the fake harness script is stamped with (determinism). */
export const E2E_MOCK_FIXED_EPOCH = "2026-09-30T00:00:00.000Z";

export interface E2eMockRuntimeOptions {
  /** Bind host; default 127.0.0.1. A non-loopback host is REFUSED (G3). */
  host?: string;
  /** Listen port; default: an ephemeral port (resolved into `port`). */
  port?: number;
  /** SQLite path; default: a fresh temp directory per start (disposable). */
  dbPath?: string;
  /** E12 default workspace; default: DEFAULT_WORKSPACE_ID. */
  workspaceId?: string;
  /** Deterministic clock for the fake harness script; default: fixed epoch. */
  now?: () => string;
  /**
   * Scripted agent replies for conversation turns (S09 chunk 2). ON by
   * default in the mock mode — the E2E path needs the reply leg; pass false
   * to start a reply-less mock (G4: the default composition without this
   * produces no replies at all).
   */
  scriptedReplies?: boolean;
}

export interface E2eMockRuntime {
  origin: string;
  port: number;
  workspace_id: string;
  /** The D51 harness seam: the E2E test drives typed triggers through it. */
  harness: HarnessRunService;
  /** The disposable SQLite file; the caller owns removing its directory. */
  dbPath: string;
  /** Idempotent: drains the gateway (and the HTTP server), closes SQLite. */
  stop(): Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export async function startE2eMockRuntime(
  options: E2eMockRuntimeOptions = {},
): Promise<E2eMockRuntime> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      `E2E mock runtime refuses non-loopback host ${host}: the local surface is unauthenticated in this slice.`,
    );
  }
  const dbPath =
    options.dbPath ?? join(mkdtempSync(join(tmpdir(), "shera-e2e-mock-")), "runtime.db");
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const now = options.now ?? (() => E2E_MOCK_FIXED_EPOCH);

  const runtime: RuntimeHandle = composeRuntime({
    dbPath,
    workspaceId,
    harnessAdapter: new FakeHarnessAdapter({ now }),
    // The fixed clock must reach the JOURNAL too — the service stamps every
    // harness-run envelope with it (adapter proposals alone are not enough).
    now,
    // The E2E path needs the reply leg: scripted agent replies with
    // deterministic content on a fast cadence (real-timer driven). The
    // composition without this produces no replies at all (G4).
    ...(options.scriptedReplies === false
      ? {}
      : { scriptedReplies: { ...DEFAULT_SCRIPTED_REPLY, deltaIntervalMs: 15 } }),
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    runtime.httpServer.once("error", onError);
    runtime.httpServer.listen(options.port ?? 0, host, () => {
      runtime.httpServer.off("error", onError);
      resolve();
    });
  });
  const address = runtime.httpServer.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    // gateway.close() closes the socket.io engine AND the HTTP server it is
    // mounted on; composeRuntime then closes SQLite.
    await runtime.close();
  };

  return {
    origin: `http://${host}:${port}`,
    port,
    workspace_id: workspaceId,
    harness: runtime.harness,
    dbPath,
    stop,
  };
}
