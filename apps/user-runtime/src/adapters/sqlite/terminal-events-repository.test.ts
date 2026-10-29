/**
 * S18 chunk 1 terminal event storage contract tests (PRD §4.3, §19 AC19/AC21,
 * D10, D27, E12, G3): the v14 migration creates the STRICT terminal_events
 * table, the repository records the three record kinds (started / output /
 * exit) with per-terminal gapless sequences, refuses every shape that would
 * misrepresent a recorded execution, and scopes every read and write by
 * workspace (E12). Real SQLite, real migrations — the same discipline as the
 * agents-repository tests.
 *
 * Vocabulary: Pack → Operations → Agents; "Agent" everywhere (G1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import { appliedMigrationVersions, applyMigrations, MIGRATIONS } from "./migrations.ts";
import {
  TerminalEventsRepository,
  TerminalEventsRepositoryError,
  type TerminalStartRow,
} from "./terminal-events-repository.ts";
import { SqliteTransactions } from "./transactions.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

function newDb(): { conn: SqliteConnection; tx: SqliteTransactions } {
  const dir = mkdtempSync(join(tmpdir(), "shera-s18-terminals-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  return { conn, tx: new SqliteTransactions(conn.db) };
}

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const OTHER_WS = "ws-other-0000";
const AGENT = "agent_general_assistant";
const TERMINAL = "term-0001";
const clock = "2026-10-29T12:00:00.000Z";

function startRow(overrides: Partial<TerminalStartRow> = {}): TerminalStartRow {
  return {
    workspace_id: WS,
    terminal_id: TERMINAL,
    agent_id: AGENT,
    session_id: "sess-0001",
    command: "node fake-pi-child.mjs --session_id sess-0001",
    workdir: "/container/data",
    resource_policy_json: JSON.stringify({ os_resource_limits: null }),
    approval_state: "not_required",
    recorded_at: clock,
    ...overrides,
  };
}

describe("terminal_events storage (S18 migration v14)", () => {
  it("appends the terminal-events migration as version 14 of the committed chain", () => {
    const v14 = MIGRATIONS.find((migration) => migration.version === 14);
    expect(v14?.name).toBe("terminal-events");
    // The S19 integration appended v15/v16 (projects) and the S21 integration
    // appended v17 (tool-inventory) after this migration; v14 itself stays in
    // place (each slice's own entries never move once merged).
    expect(MIGRATIONS.at(-1)?.version).toBe(17);
    expect(MIGRATIONS.at(-4)?.version).toBe(14);
  });

  it("creates the STRICT terminal_events table through the migration runner", () => {
    const { conn } = newDb();
    expect(appliedMigrationVersions(conn.db)).toContain(14);
    const table = conn.db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'terminal_events'")
      .get() as { sql: string } | undefined;
    expect(table?.sql).toContain("STRICT");
  });

  it("persists the three record kinds with per-terminal gapless sequences", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);

    repo.insertStart(startRow());
    repo.appendOutput({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      stream: "stderr",
      chunk: "compiling module 1/3",
      recorded_at: clock,
    });
    repo.appendOutput({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      stream: "stdout",
      chunk: "build succeeded",
      recorded_at: clock,
    });
    repo.appendExit({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      exit_code: 0,
      exit_signal: null,
      recorded_at: clock,
    });

    const rows = repo.listRows(WS, TERMINAL);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.kind)).toEqual(["started", "output", "output", "exit"]);
    expect(rows[0]?.command).toBe("node fake-pi-child.mjs --session_id sess-0001");
    expect(rows[0]?.approval_state).toBe("not_required");
    expect(rows[1]?.stream).toBe("stderr");
    expect(rows[1]?.chunk).toBe("compiling module 1/3");
    expect(rows[3]?.exit_code).toBe(0);
    expect(rows[3]?.exit_signal).toBeNull();
  });

  it("assembles the durable record: started fields, redacted chunks, exit state", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    repo.insertStart(
      startRow({
        resource_policy_json: JSON.stringify({
          os_resource_limits: null,
          supervision: { stderr_max_bytes: 8192 },
        }),
      }),
    );
    repo.appendOutput({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      stream: "stderr",
      chunk: "warmup",
      recorded_at: clock,
    });

    const running = repo.getRecord(WS, TERMINAL);
    expect(running).toMatchObject({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      session_id: "sess-0001",
      command: "node fake-pi-child.mjs --session_id sess-0001",
      workdir: "/container/data",
      approval_state: "not_required",
      state: "running",
      exit_code: null,
      exit_signal: null,
    });
    expect(running?.resource_policy).toEqual({
      os_resource_limits: null,
      supervision: { stderr_max_bytes: 8192 },
    });
    expect(running?.output).toEqual([
      { sequence: 2, stream: "stderr", text: "warmup", recorded_at: clock },
    ]);

    repo.appendExit({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      exit_code: null,
      exit_signal: "SIGKILL",
      recorded_at: clock,
    });
    const exited = repo.getRecord(WS, TERMINAL);
    expect(exited?.state).toBe("exited");
    expect(exited?.exit_code).toBeNull();
    expect(exited?.exit_signal).toBe("SIGKILL");
    expect(exited?.exited_at).toBe(clock);
  });

  it("refuses a second started row for the same terminal", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    repo.insertStart(startRow());
    expect(() => repo.insertStart(startRow())).toThrow(TerminalEventsRepositoryError);
    expect(() => repo.insertStart(startRow())).toThrow(/already started/i);
  });

  it("refuses output and exit rows for a terminal that never started", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    expect(() =>
      repo.appendOutput({
        workspace_id: WS,
        terminal_id: TERMINAL,
        agent_id: AGENT,
        stream: "stderr",
        chunk: "orphan",
        recorded_at: clock,
      }),
    ).toThrow(TerminalEventsRepositoryError);
    expect(() =>
      repo.appendExit({
        workspace_id: WS,
        terminal_id: TERMINAL,
        agent_id: AGENT,
        exit_code: 1,
        exit_signal: null,
        recorded_at: clock,
      }),
    ).toThrow(TerminalEventsRepositoryError);
    // Nothing was written: the table stays empty for the terminal.
    expect(repo.listRows(WS, TERMINAL)).toEqual([]);
  });

  it("refuses output and further records after the execution exited", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    repo.insertStart(startRow());
    repo.appendExit({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      exit_code: 0,
      exit_signal: null,
      recorded_at: clock,
    });
    expect(() =>
      repo.appendOutput({
        workspace_id: WS,
        terminal_id: TERMINAL,
        agent_id: AGENT,
        stream: "stdout",
        chunk: "late chunk",
        recorded_at: clock,
      }),
    ).toThrow(/exited/i);
    expect(() =>
      repo.appendExit({
        workspace_id: WS,
        terminal_id: TERMINAL,
        agent_id: AGENT,
        exit_code: 0,
        exit_signal: null,
        recorded_at: clock,
      }),
    ).toThrow(/exited/i);
  });

  it("scopes every read and write by workspace (E12): another workspace is invisible", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    repo.insertStart(startRow());
    repo.appendOutput({
      workspace_id: WS,
      terminal_id: TERMINAL,
      agent_id: AGENT,
      stream: "stderr",
      chunk: "visible only in its workspace",
      recorded_at: clock,
    });

    expect(repo.listRows(OTHER_WS, TERMINAL)).toEqual([]);
    expect(repo.getRecord(OTHER_WS, TERMINAL)).toBeNull();
    expect(repo.latestRecord(OTHER_WS, AGENT)).toBeNull();

    // The same terminal id in another workspace is an independent row space:
    // it can start its own execution without colliding (E12).
    repo.insertStart(startRow({ workspace_id: OTHER_WS, command: "other workspace execution" }));
    expect(repo.getRecord(OTHER_WS, TERMINAL)?.command).toBe("other workspace execution");
  });

  it("lists an Agent's terminal records newest-first and answers the latest one", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    repo.insertStart(
      startRow({ terminal_id: "term-0001", recorded_at: "2026-10-29T12:00:01.000Z" }),
    );
    repo.insertStart(
      startRow({ terminal_id: "term-0002", recorded_at: "2026-10-29T12:00:02.000Z" }),
    );
    repo.insertStart(
      startRow({ terminal_id: "term-0003", recorded_at: "2026-10-29T12:00:03.000Z" }),
    );
    repo.appendExit({
      workspace_id: WS,
      terminal_id: "term-0002",
      agent_id: AGENT,
      exit_code: 0,
      exit_signal: null,
      recorded_at: clock,
    });

    const records = repo.listRecordsByAgent(WS, AGENT, 10);
    expect(records.map((record) => record.terminal_id)).toEqual([
      "term-0003",
      "term-0002",
      "term-0001",
    ]);
    expect(records.find((record) => record.terminal_id === "term-0002")?.state).toBe("exited");
    expect(repo.latestRecord(WS, AGENT)?.terminal_id).toBe("term-0003");
  });

  it("throws the typed TERMINAL_NOT_FOUND for an unknown terminal id", () => {
    const { tx } = newDb();
    const repo = new TerminalEventsRepository(tx);
    try {
      repo.requireRecord(WS, "term-missing");
      expect.unreachable("requireRecord must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalEventsRepositoryError);
      expect((error as TerminalEventsRepositoryError).code).toBe("TERMINAL_NOT_FOUND");
    }
  });
});
