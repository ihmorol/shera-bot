/**
 * S18 chunk 1 session/harness spawn-seam recorder tests: the wrapper around
 * the SessionSupervisor's spawnChild seam records every Agent session child
 * the runtime actually launches — command (the substituted harness argv),
 * working directory, resource policy, and approval state — streams the
 * child's stderr chunks through the redaction boundary as terminal output
 * events, and records the exit. A recorder failure is CONTAINED: supervision
 * proceeds exactly as before, the fault is recorded (the supervisor must
 * never lose a session to a recording failure).
 *
 * The D14 protocol has NO terminal frame; these events are DERIVED on the
 * runtime side from what the spawn seam already emits (the configured harness
 * command it executes, the child's stderr, the child's exit). Recorded for
 * the slice report and for the S26 terminal executor, which will feed real
 * Agent-initiated shell executions through the same recorder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { SessionHarnessConfig } from "../../adapters/process/session-process-spawn.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { TerminalEventsRepository } from "../../adapters/sqlite/terminal-events-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import type {
  SessionChild,
  SessionChildExit,
  SessionSpawnRequest,
} from "../sessions/session-supervisor.service.ts";
import { terminalStreamFor } from "./terminals.events.ts";
import { TerminalRecorder } from "./terminal-recorder.service.ts";
import {
  observeSessionSpawnWithTerminalRecorder,
  type SessionSupervisionRecord,
} from "./session-terminal-recorder.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const AGENT = "agent_general_assistant";
const clock = "2026-10-29T12:00:00.000Z";

const SUPERVISION: SessionSupervisionRecord = {
  heartbeat_interval_ms: 5_000,
  watchdog_window_ms: 15_000,
  stderr_max_bytes: 8_192,
  escalation: "shutdown_frame_then_sigterm_then_sigkill",
};

const HARNESS: SessionHarnessConfig = {
  command: "node",
  args: ["fake-pi-child.mjs", "--session_id", "{session_id}", "--beat", "{heartbeat_interval_ms}"],
};

interface FakeChildHandle {
  child: SessionChild;
  emitLine(line: string): void;
  emitStderr(chunk: string): void;
  resolveExit(exit: SessionChildExit): void;
}

function makeFakeChild(): FakeChildHandle {
  const lineListeners: Array<(line: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  let resolveExit!: (exit: SessionChildExit) => void;
  const exitPromise = new Promise<SessionChildExit>((resolve) => {
    resolveExit = resolve;
  });
  return {
    child: {
      onLine: (listener) => {
        lineListeners.push(listener);
        return () => {
          const index = lineListeners.indexOf(listener);
          if (index >= 0) lineListeners.splice(index, 1);
        };
      },
      onStderr: (listener) => {
        stderrListeners.push(listener);
        return () => {
          const index = stderrListeners.indexOf(listener);
          if (index >= 0) stderrListeners.splice(index, 1);
        };
      },
      send: () => {},
      kill: () => {},
      waitForExit: () => exitPromise,
    },
    emitLine: (line) => {
      for (const listener of [...lineListeners]) listener(line);
    },
    emitStderr: (chunk) => {
      for (const listener of [...stderrListeners]) listener(chunk);
    },
    resolveExit,
  };
}

function newDb(): { conn: SqliteConnection; tx: SqliteTransactions } {
  const dir = mkdtempSync(join(tmpdir(), "shera-s18-seam-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  return { conn, tx: new SqliteTransactions(conn.db) };
}

function spawnRequest(): SessionSpawnRequest {
  return {
    workspace_id: WS,
    agent_id: AGENT,
    session_id: "sess-0001",
    heartbeat_interval_ms: 250,
    context: {
      workspace_id: WS,
      agent_id: AGENT,
      display_name: "General Assistant",
      instructions: null,
      pack_profile: "profile",
    },
  };
}

describe("session spawn seam terminal recorder (S18 chunk 1)", () => {
  it("records the harness launch as a terminal execution with truthful fields", () => {
    const { conn, tx } = newDb();
    const journal = new EventJournalRepository(tx);
    const repo = new TerminalEventsRepository(tx);
    const recorder = new TerminalRecorder({
      tx,
      terminals: repo,
      events: new EventsService(journal, tx),
      now: () => clock,
    });
    const faults: Array<Record<string, unknown>> = [];

    const spawn = observeSessionSpawnWithTerminalRecorder(
      {
        recorder,
        harness: HARNESS,
        supervision: SUPERVISION,
        logFault: (event, fields) => faults.push({ event, fields }),
      },
      () => makeFakeChild().child,
    );

    const child = spawn(spawnRequest());
    expect(child).toBeDefined();

    const record = repo.latestRecord(WS, AGENT);
    expect(record).not.toBeNull();
    // The command is the substituted argv the runtime actually executed.
    expect(record?.command).toBe("node fake-pi-child.mjs --session_id sess-0001 --beat 250");
    expect(record?.session_id).toBe("sess-0001");
    // The child inherits the runtime's working directory (no cwd override at
    // the seam) — recorded truthfully.
    expect(record?.workdir).toBe(process.cwd());
    expect(record?.resource_policy).toEqual({
      os_resource_limits: null,
      supervision: {
        heartbeat_interval_ms: 5_000,
        watchdog_window_ms: 15_000,
        stderr_max_bytes: 8_192,
        escalation: "shutdown_frame_then_sigterm_then_sigkill",
      },
    });
    expect(record?.approval_state).toBe("not_required");
    expect(record?.state).toBe("running");
    expect(faults).toEqual([]);

    const started = journal
      .listStream(terminalStreamFor(WS, AGENT), WS)
      .find((row) => row.event_type === "terminal.started");
    expect(started).toBeDefined();
  });

  it("streams the child's stderr through the redaction boundary as output events", () => {
    const { conn, tx } = newDb();
    const journal = new EventJournalRepository(tx);
    const repo = new TerminalEventsRepository(tx);
    const recorder = new TerminalRecorder({
      tx,
      terminals: repo,
      events: new EventsService(journal, tx),
      now: () => clock,
    });

    let handle!: FakeChildHandle;
    const spawn = observeSessionSpawnWithTerminalRecorder(
      {
        recorder,
        harness: HARNESS,
        supervision: SUPERVISION,
        logFault: () => {},
      },
      () => {
        handle = makeFakeChild();
        return handle.child;
      },
    );
    const supervisorListenerChunks: string[] = [];
    const child = spawn(spawnRequest());
    // The supervisor's own stderr listener still works THROUGH the wrapper
    // (the supervisor keeps its bounded diagnostic sink).
    child.onStderr((chunk) => supervisorListenerChunks.push(chunk));

    handle.emitStderr("export API_KEY=sk-live-abc123def456\n");
    handle.emitStderr("ready\n");

    const record = repo.latestRecord(WS, AGENT);
    expect(record?.output.map((chunk) => chunk.stream)).toEqual(["stderr", "stderr"]);
    // The secret VALUE collapses; the non-secret shape around it stays
    // readable (the redaction layer's pinned behavior).
    expect(record?.output.map((chunk) => chunk.text)).toEqual([
      "export API_KEY=[REDACTED]\n",
      "ready\n",
    ]);
    // The supervisor's own consumer still received the raw chunk (the
    // redaction boundary is the PERSISTENCE boundary, not the process pipe).
    expect(supervisorListenerChunks).toEqual(["export API_KEY=sk-live-abc123def456\n", "ready\n"]);
    // And the journal is clean (G3).
    for (const row of journal.listStream(terminalStreamFor(WS, AGENT), WS)) {
      expect(row.payload).not.toContain("sk-live-abc123def456");
    }
  });

  it("records the child's exit and closes the execution", async () => {
    const { conn, tx } = newDb();
    const journal = new EventJournalRepository(tx);
    const repo = new TerminalEventsRepository(tx);
    const recorder = new TerminalRecorder({
      tx,
      terminals: repo,
      events: new EventsService(journal, tx),
      now: () => clock,
    });

    let handle!: FakeChildHandle;
    const spawn = observeSessionSpawnWithTerminalRecorder(
      {
        recorder,
        harness: HARNESS,
        supervision: SUPERVISION,
        logFault: () => {},
      },
      () => {
        handle = makeFakeChild();
        return handle.child;
      },
    );
    const child = spawn(spawnRequest());

    const exitPromise = child.waitForExit();
    handle.resolveExit({ code: 0, signal: null });
    const exit = await exitPromise;
    expect(exit).toEqual({ code: 0, signal: null });

    const record = repo.latestRecord(WS, AGENT);
    expect(record?.state).toBe("exited");
    expect(record?.exit_code).toBe(0);
    const exited = journal
      .listStream(terminalStreamFor(WS, AGENT), WS)
      .find((row) => row.event_type === "terminal.exited");
    expect(exited).toBeDefined();
  });

  it("contains recorder failures: the supervisor still receives a working child", () => {
    const { conn, tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    // A recorder whose journal seam always fails.
    const failingEvents = {
      appendEvent: () => {
        throw new Error("simulated journal failure");
      },
    } as unknown as EventsService;
    const recorder = new TerminalRecorder({ tx, terminals: repo, events: failingEvents });
    const faults: Array<{ event: string; fields: Record<string, unknown> }> = [];

    let childCreatedAt = false;
    const spawn = observeSessionSpawnWithTerminalRecorder(
      {
        recorder,
        harness: HARNESS,
        supervision: SUPERVISION,
        logFault: (event, fields) => faults.push({ event, fields }),
      },
      () => {
        childCreatedAt = true;
        return makeFakeChild().child;
      },
    );
    const child = spawn(spawnRequest());

    // The child was created and handed to the supervisor anyway.
    expect(childCreatedAt).toBe(true);
    expect(child.onLine).toBeTypeOf("function");
    // No terminal row was recorded, and the fault was contained to the log.
    expect(repo.listRecordsByAgent(WS, AGENT, 10)).toEqual([]);
    expect(faults.length).toBeGreaterThan(0);
    expect(faults[0]?.event).toContain("terminal_record");
  });
});
