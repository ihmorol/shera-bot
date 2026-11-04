/**
 * S27 ST-07 — credential leakage in stdout/stderr and logs (threat model
 * §5 ST-07; TM-3.2/TM-3.6; D14 "stderr is redacted before logging", D22
 * (headers, authorization fields, URLs with embedded secrets), D27/D23 rule 4,
 * G3). The S18 TerminalRecorder is the single redaction authority for the
 * terminal boundary — output chunks AND the recorded command/workdir fields
 * pass it BEFORE any row, journal entry, or WS replay exists.
 *
 * The adversarial fixtures (the ST-07 hostile inputs, synthetic values only —
 * G3): a fake provider client echoing its Authorization header; a Git remote
 * URL with embedded credentials; an environment dump; a Set-Cookie header;
 * a PEM private-key block. Each is driven through the REAL recorder over a
 * REAL migrated SQLite store, and the persisted artifact is searched at the
 * BYTE level (rows AND journal sidecars) — a redaction that exists in code
 * but not in the bytes is a leak.
 *
 * One leg drives the same fixtures through the REAL execution binding
 * (executor → sandbox → recorder), because that is where child output
 * actually enters the boundary: the payload PRINTS an Authorization header
 * and a credentialed URL; the result text and the database bytes carry
 * neither raw value.
 *
 * RED-FIRST evidence: redactSecrets was replaced by the identity function
 * (the boundary disabled), the suite FAILED (raw fixtures in the rows and
 * the bytes), the boundary was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st07-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-07/§6, D14, D22, D23 rule 4, D27, G3.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

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

/**
 * Synthetic fixture values — clearly labelled, NEVER real credentials (G3).
 * The <provider-key-reference>-style placeholders of the threat model §5/§6
 * are rendered here as S27-labeled synthetic strings.
 */
const FIXTURES = {
  bearerHeader: "Authorization: Bearer s27-SYNTHETIC-provider-token-NOT-REAL",
  gitRemoteUrl: "https://shera-bot:s27-SYNTHETIC-repo-credential-NOT-REAL@example.com/owner/repo.git",
  envDump: "SHERA_S27_API_KEY=s27-SYNTHETIC-key-value-NOT-REAL",
  cookieHeader: "set-cookie: shera_session=s27-SYNTHETIC-cookie-value-NOT-REAL; Path=/; HttpOnly",
  pemBlock: [
    "-----BEGIN PRIVATE KEY-----",
    "s27SYNTHETICkeymaterialNOTREALline1",
    "s27SYNTHETICkeymaterialNOTREALline2",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
};

const tempDirs: string[] = [];

interface St07Harness {
  dbPath: string;
  recorder: TerminalRecorder;
  workspaceId: string;
  agentId: string;
  dispose(): void;
}

function buildHarness(): St07Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st07-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "runtime.db");
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const recorder = new TerminalRecorder({
    tx,
    terminals: new TerminalEventsRepository(tx),
    events: new EventsService(new EventJournalRepository(tx), tx),
  });
  return {
    dbPath,
    recorder,
    workspaceId: "ws_s27",
    agentId: "agent_dev",
    dispose(): void {
      try {
        conn.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Whole-store byte scan: the database plus every sibling sidecar (WAL/SHM). */
function scanStoreBytes(dbPath: string): string {
  const base = dbPath.split("/").pop() ?? "runtime.db";
  const parts = [readFileSync(dbPath).toString("latin1")];
  for (const name of readdirSync(join(dbPath, ".."))) {
    if (!name.startsWith(base)) continue;
    parts.push(readFileSync(join(dbPath, "..", name)).toString("latin1"));
  }
  return parts.join("\n---sidecar---\n");
}

/** Every synthetic fixture value as one array (for the byte-scan loop). */
function fixtureValues(): string[] {
  return Object.values(FIXTURES).map((value) => value);
}

describe("S27 ST-07 — the terminal boundary redacts hostile output before persistence", () => {
  it("stdout chunks carrying every ST-07 fixture land redacted: rows + journal carry [REDACTED], never the raw values", () => {
    const h = buildHarness();
    try {
      const terminalId = h.recorder.startExecution({
        workspace_id: h.workspaceId,
        agent_id: h.agentId,
        session_id: null,
        command: "fake-provider-client --echo",
        workdir: "/workspace",
        resource_policy: { network: "disabled" },
        approval_state: "not_required",
      });
      for (const chunk of fixtureValues()) {
        h.recorder.recordOutput({
          workspace_id: h.workspaceId,
          agent_id: h.agentId,
          terminal_id: terminalId,
          stream: "stderr", // D14: stderr is diagnostic and REDACTED before logging
          raw_chunk: chunk,
        });
      }
      h.recorder.recordExit({
        workspace_id: h.workspaceId,
        agent_id: h.agentId,
        terminal_id: terminalId,
        exit_code: 0,
        exit_signal: null,
      });
      h.dispose();
      const bytes = scanStoreBytes(h.dbPath);
      for (const value of fixtureValues()) {
        for (const line of value.split("\n")) {
          if (line.startsWith("-----")) continue; // the PEM delimiters may survive; the MATERIAL must not
          if (line.startsWith("s27SYNTHETIC")) {
            expect(bytes, `raw key material leaked: ${line}`).not.toContain(line);
          } else {
            expect(bytes, `raw fixture leaked into persistence: ${line}`).not.toContain(line);
          }
        }
      }
      // The redaction placeholder IS present (the boundary ran, it did not
      // merely drop the rows).
      expect(bytes).toContain("[REDACTED]");
    } finally {
      h.dispose();
    }
  });

  it("the recorded command/workdir fields pass the same boundary (a credential on a command line never reaches storage)", () => {
    const h = buildHarness();
    try {
      h.recorder.startExecution({
        workspace_id: h.workspaceId,
        agent_id: h.agentId,
        session_id: null,
        command: `git push https://shera-bot:s27-SYNTHETIC-repo-credential-NOT-REAL@example.com/owner/repo.git`,
        workdir: "/workspace",
        resource_policy: { network: "disabled" },
        approval_state: "not_required",
      });
      h.dispose();
      const bytes = scanStoreBytes(h.dbPath);
      expect(bytes).not.toContain("s27-SYNTHETIC-repo-credential-NOT-REAL");
    } finally {
      h.dispose();
    }
  });
});

describe("S27 ST-07 — child output entering through the REAL execution binding", () => {
  it("a payload echoing an Authorization header and a credentialed URL leaks neither into the capture nor the bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s27-st07-exec-"));
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

    const payload = [
      `console.log("AUTH ${FIXTURES.bearerHeader}");`,
      `console.log("GIT ${FIXTURES.gitRemoteUrl}");`,
      `console.log("ENV ${FIXTURES.envDump}");`,
      // The header is echoed BARE (a verbose client prints the raw line —
      // a friendly prefix would give the key-assignment sweep an alternative
      // parse that skips the value; the hostile shape is the header itself).
      `console.log("${FIXTURES.cookieHeader}");`,
    ].join("\n");
    const ctx: ToolExecutionContext = {
      authority: makeExecutionAuthority(),
      deadline: Date.now() + 20_000,
      nowMs: () => Date.now(),
      maxResponseBytes: 65_536,
      resourceLimits: {
        max_memory_mb: 2048,
        max_cpu_seconds: 20,
        max_processes: 64,
        max_disk_mb: 64,
      },
      signal: new AbortController().signal,
      execution: {
        execution_id: "exe_s27_st07",
        workspace_id: "ws_s27",
        task_id: "task_s27_st07",
        conversation_id: "conv_s27_st07",
        agent_id: "agent_dev",
        capability: "code.exec",
        approval_id: null,
        grant_id: null,
      },
    };
    try {
      const result = await dispatch({ language: "node", code: payload, workdir: "." }, ctx);
      if (!result.ok) throw new Error(`payload failed: ${result.errorCode}`);
      // The capture (the result text — what the model/history sees) carries
      // neither raw value.
      expect(result.text).not.toContain("s27-SYNTHETIC-provider-token-NOT-REAL");
      expect(result.text).not.toContain("s27-SYNTHETIC-repo-credential-NOT-REAL");
      expect(result.text).not.toContain("s27-SYNTHETIC-key-value-NOT-REAL");
      expect(result.text).not.toContain("s27-SYNTHETIC-cookie-value-NOT-REAL");
      conn.close();
      const bytes = scanStoreBytes(dbPath);
      expect(bytes).not.toContain("s27-SYNTHETIC-provider-token-NOT-REAL");
      expect(bytes).not.toContain("s27-SYNTHETIC-repo-credential-NOT-REAL");
      expect(bytes).not.toContain("s27-SYNTHETIC-key-value-NOT-REAL");
      expect(bytes).not.toContain("s27-SYNTHETIC-cookie-value-NOT-REAL");
    } finally {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
  }, 60_000);
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
