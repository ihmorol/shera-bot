/**
 * Mock-runtime process launcher (S09 chunk 3, test infrastructure).
 *
 * The ONLY test helper permitted to reference `child_process` on the runtime
 * side (named exception in scripts/boundary-guards.ts): the kill -9 recovery
 * probe needs the E8 mock runtime as a real OS process — in-process runs
 * cannot exercise SIGKILL against SQLite's WAL recovery. The pattern follows
 * the S05 control-plane helpers (pg-cluster.ts, test-server.ts) that spawn
 * throwaway infrastructure for integration tests.
 *
 * What it does: spawn `node <mock-runtime-main.ts>` with RUNTIME_E2E_MOCK=1,
 * wait for the ready line (the bound port), expose the origin, and provide
 * graceful stop() and SIGKILL kill9() teardowns. Nothing here touches the
 * runtime's modules directly — the child owns the composition entirely.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const MOCK_ENTRY_URL = new URL("../../src/mock/mock-runtime-main.ts", import.meta.url);
const ENTRY_PATH = fileURLToPath(MOCK_ENTRY_URL);

export interface MockRuntimeProcess {
  origin: string;
  port: number;
  dbPath: string;
  /** SIGTERM: the entry's drain handlers run, then the process exits. */
  stop(): Promise<void>;
  /** SIGKILL: the abrupt-crash leg of the recovery probe — no drain at all. */
  kill9(): Promise<void>;
}

interface ReadyLine {
  event: string;
  origin: string;
  port: number;
  workspace_id: string;
  db_path: string;
}

function waitForExit(child: ChildProcess, label: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for the mock runtime to ${label}`)),
      timeoutMs,
    );
    const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      if (code === 0 || signal !== null) {
        resolve();
        return;
      }
      reject(new Error(`mock runtime ${label} failed: code=${String(code)} signal=${String(signal)}`));
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      settle(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", settle);
  });
}

/** Start the E8 mock runtime as a child process; resolves when it is serving. */
export async function startMockRuntimeProcess(options: {
  dbPath: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}): Promise<MockRuntimeProcess> {
  const child = spawn(
    process.execPath,
    // --experimental-transform-types: the composition uses non-erasable TS
    // (constructor parameter properties), which plain type stripping refuses.
    ["--experimental-transform-types", ENTRY_PATH],
    {
      env: {
        ...process.env,
        RUNTIME_E2E_MOCK: "1",
        RUNTIME_DB_PATH: options.dbPath,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const ready = new Promise<ReadyLine>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for the mock runtime ready line")),
      options.timeoutMs ?? 15_000,
    );
    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const line = buffered.split("\n").find((entry) => entry.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line) as ReadyLine);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`mock runtime exited before ready: code=${String(code)} signal=${String(signal)}`));
    });
  });

  const readyLine = await ready;
  return {
    origin: readyLine.origin,
    port: readyLine.port,
    dbPath: readyLine.db_path,
    stop: () => {
      child.kill("SIGTERM");
      return waitForExit(child, "drain");
    },
    kill9: () => {
      child.kill("SIGKILL");
      return waitForExit(child, "die from SIGKILL");
    },
  };
}

/** Typed-HTTP probe loop against the child's health surface. */
export async function waitForHealth(origin: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}/internal/v1/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // not serving yet
    }
    if (Date.now() > deadline) {
      throw new Error("timeout waiting for the mock runtime health probe");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
