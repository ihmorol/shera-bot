/**
 * S27 ST-03 — environment-variable secret exposure to child processes
 * (threat model §5 ST-03; D27 + D22/E9; the OPEN-8 resolution S26 shipped:
 * the child environment is a FIXED ALLOWLIST — the runtime's process.env is
 * never consulted and no caller environment is merged).
 *
 * The adversarial shape: the RUNTIME's own environment is seeded with two
 * synthetic, clearly-labelled secret fixtures (G3 — no real values), one
 * provider-key-shaped and one token-shaped (the ST-03 hostile input: code
 * hunting `<provider-key-reference>`). The payload — executed through the
 * REAL executor binding → sandbox spawn path — prints its ENTIRE
 * process.env as JSON and every /proc/self/environ key name. The assertions:
 *   - the child saw ONLY the allowlist keys (PATH/HOME/TMPDIR/LANG/TERM);
 *   - the raw secret values appear NOWHERE in the captured output, the
 *     persisted terminal rows + journal (a WHOLE-DATABASE byte scan), or the
 *     database sidecar files.
 *
 * RED-FIRST evidence: buildSandboxEnv was patched to spread process.env
 * (the allowlist disabled — exactly the exposure ST-03 describes), the suite
 * FAILED (the secrets were visible to the child and hit the sinks), the
 * allowlist was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st03-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-03/OPEN-8, D27, D22/E9, E36, G3.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { TerminalEventsRepository } from "../../apps/user-runtime/src/adapters/sqlite/terminal-events-repository.ts";
import { TerminalRecorder } from "../../apps/user-runtime/src/modules/terminals/terminal-recorder.service.ts";
import { spawnSandboxedExecution } from "../../apps/user-runtime/src/adapters/process/execution-process-spawn.ts";
import {
  makeCodeExecutionBinding,
  type ExecutionToolDeps,
} from "../../apps/user-runtime/src/modules/execution/execution-tool-binding.ts";
import {
  makeExecutionAuthority,
  type ToolExecutionContext,
} from "../../apps/user-runtime/src/modules/tools/tool-binding.ts";

/** Synthetic secret fixtures — clearly labelled, NEVER real values (G3). */
const PROVIDER_KEY_ENV = "SHERA_S27_PROVIDER_KEY";
const PROVIDER_KEY_VALUE = "sk-s27-SYNTHETIC-provider-key-not-a-real-credential";
const TOKEN_ENV = "SHERA_S27_TEST_TOKEN";
const TOKEN_VALUE = "tok-s27-SYNTHETIC-token-not-a-real-credential";

/** The recorded D27 allowlist (sandbox-policy buildSandboxEnv). */
const ALLOWLIST_KEYS = new Set(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);

const tempDirs: string[] = [];

interface St03Harness {
  dbPath: string;
  runPayload(): Promise<string>;
  dispose(): void;
}

/** Build the REAL composition: binding → sandbox spawn → recorder → rows. */
function buildHarness(): St03Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st03-"));
  tempDirs.push(dir);
  const workspaceRoot = join(dir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const dbPath = join(dir, "runtime.db");
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const recorder = new TerminalRecorder({
    tx,
    terminals: new TerminalEventsRepository(tx),
    events: new EventsService(new EventJournalRepository(tx), tx),
  });
  const deps: ExecutionToolDeps = {
    spawn: (request) => spawnSandboxedExecution(request),
    workspaceRoots: { ws_s27: workspaceRoot },
    terminalRecorder: recorder,
    artifacts: null,
    logFault: () => {},
  };
  const binding = makeCodeExecutionBinding(deps);
  if (typeof binding.executeAsync !== "function") {
    throw new Error("the code-execution binding must dispatch through executeAsync");
  }
  const dispatch = binding.executeAsync.bind(binding);
  return {
    dbPath,
    async runPayload(): Promise<string> {
      const payload = [
        `const env = {};`,
        `for (const k of Object.keys(process.env)) env[k] = process.env[k];`,
        `console.log("ENVJSON " + JSON.stringify(env));`,
        `const environ = require("node:fs").readFileSync("/proc/self/environ", "utf8");`,
        `console.log("ENVIRON_KEYS " + environ.split("\\0").filter(s => s.includes("=")).map(s => s.slice(0, s.indexOf("="))).join(","));`,
      ].join("\n");
      const ctx: ToolExecutionContext = {
        authority: makeExecutionAuthority(),
        deadline: Date.now() + 20_000,
        nowMs: () => Date.now(),
        maxResponseBytes: 65_536,
        resourceLimits: {
          // RLIMIT_DATA must clear node's boot floor on this box (E36).
          max_memory_mb: 2048,
          max_cpu_seconds: 20,
          max_processes: 64,
          max_disk_mb: 64,
        },
        signal: new AbortController().signal,
        execution: {
          execution_id: "exe_s27_st03",
          workspace_id: "ws_s27",
          task_id: "task_s27_st03",
          conversation_id: "conv_s27_st03",
          agent_id: "agent_dev",
          capability: "code.exec",
          approval_id: null,
          grant_id: null,
        },
      };
      const result = await dispatch({ language: "node", code: payload, workdir: "." }, ctx);
      if (!result.ok) throw new Error(`payload failed: ${result.errorCode} ${result.message}`);
      return result.text;
    },
    dispose(): void {
      try {
        conn.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Scan the database file and every sibling sidecar (WAL/SHM) for a value. */
function scanStoreBytes(dbPath: string): string {
  const base = dbPath.split("/").pop() ?? "runtime.db";
  const parts = [readFileSync(dbPath).toString("latin1")];
  for (const name of readdirSync(join(dbPath, ".."))) {
    if (!name.startsWith(base)) continue;
    parts.push(readFileSync(join(dbPath, "..", name)).toString("latin1"));
  }
  return parts.join("\n---sidecar---\n");
}

describe("S27 ST-03 — child environment secret exposure (D27 allowlist)", () => {
  afterEach(() => {
    delete process.env[PROVIDER_KEY_ENV];
    delete process.env[TOKEN_ENV];
  });

  it("executed code sees ONLY the allowlist keys — the runtime's env is invisible", async () => {
    // The hostile setup: secrets planted in the RUNTIME's own environment.
    process.env[PROVIDER_KEY_ENV] = PROVIDER_KEY_VALUE;
    process.env[TOKEN_ENV] = TOKEN_VALUE;
    const h = buildHarness();
    try {
      const text = await h.runPayload();
      const envLine = text.split("\n").find((line) => line.startsWith("ENVJSON "));
      expect(envLine, "the payload must report its environment").toBeDefined();
      const childEnv: Record<string, string> = JSON.parse(envLine!.slice("ENVJSON ".length));
      // THE CONTROL: exactly the allowlist — no SHERA_*, nothing inherited.
      expect(Object.keys(childEnv).sort()).toEqual([...ALLOWLIST_KEYS].sort());
      const environKeysLine = text.split("\n").find((line) => line.startsWith("ENVIRON_KEYS "));
      expect(environKeysLine).toBeDefined();
      const environKeys = environKeysLine!.slice("ENVIRON_KEYS ".length).split(",");
      for (const key of environKeys) {
        expect(ALLOWLIST_KEYS.has(key), `unexpected /proc/self/environ key ${key}`).toBe(true);
      }
      // Neither value rode the environment the child actually received.
      expect(Object.values(childEnv)).not.toContain(PROVIDER_KEY_VALUE);
      expect(Object.values(childEnv)).not.toContain(TOKEN_VALUE);
    } finally {
      h.dispose();
    }
  });

  it("neither secret value reaches any sink: capture, terminal rows, journal, or raw database bytes", async () => {
    process.env[PROVIDER_KEY_ENV] = PROVIDER_KEY_VALUE;
    process.env[TOKEN_ENV] = TOKEN_VALUE;
    const h = buildHarness();
    try {
      const text = await h.runPayload();
      // The result text (the bounded capture) carries neither value.
      expect(text).not.toContain(PROVIDER_KEY_VALUE);
      expect(text).not.toContain(TOKEN_VALUE);
    } finally {
      h.dispose();
    }
    // The whole persisted store — rows AND journal sidecars — carries neither.
    const bytes = scanStoreBytes(h.dbPath);
    expect(bytes).not.toContain(PROVIDER_KEY_VALUE);
    expect(bytes).not.toContain(TOKEN_VALUE);
  });
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
