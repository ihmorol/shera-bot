/**
 * S18 chunk 1 terminal recorder tests (D10, G3, E12): every recorded
 * terminal row and its event-journal entry commit in the SAME SQLite
 * transaction (D10 — the row never appears without its journal entry and the
 * journal entry never appears without its row), output chunks pass through
 * the secret-redaction layer BEFORE persistence (G3 — no secret-shaped value
 * reaches terminal_events or the journal), and the journal events ride the
 * per-Agent `terminal:<workspace_id>:<agent_id>` streams with the runtime
 * event vocabulary (no contracts change).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { TerminalEventsRepository } from "../../adapters/sqlite/terminal-events-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { terminalStreamFor } from "./terminals.events.ts";
import { TerminalRecorder } from "./terminal-recorder.service.ts";

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

interface Fixture {
  conn: SqliteConnection;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  repo: TerminalEventsRepository;
  recorder: TerminalRecorder;
}

function makeFixture(now?: () => string): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "shera-s18-recorder-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const repo = new TerminalEventsRepository(tx);
  const recorder = new TerminalRecorder({
    tx,
    terminals: repo,
    events: new EventsService(journal, tx),
    ...(now ? { now } : {}),
  });
  return { conn, tx, journal, repo, recorder };
}

describe("TerminalRecorder (S18 chunk 1)", () => {
  it("records a start execution: row + journal entry, same facts", () => {
    const f = makeFixture();
    const terminalId = f.recorder.startExecution({
      workspace_id: WS,
      agent_id: AGENT,
      session_id: "sess-0001",
      command: "node fake-pi-child.mjs --session_id sess-0001",
      workdir: "/container/data",
      resource_policy: { os_resource_limits: null, supervision: { stderr_max_bytes: 8192 } },
      approval_state: "not_required",
    });
    expect(terminalId).toMatch(/^term-/);

    const record = f.repo.requireRecord(WS, terminalId);
    expect(record.command).toBe("node fake-pi-child.mjs --session_id sess-0001");
    expect(record.approval_state).toBe("not_required");
    expect(record.state).toBe("running");

    const stream = f.journal.listStream(terminalStreamFor(WS, AGENT), WS);
    expect(stream).toHaveLength(1);
    expect(stream[0]?.event_type).toBe("terminal.started");
    const payload = JSON.parse(stream[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload).toMatchObject({
      workspace_id: WS,
      agent_id: AGENT,
      terminal_id: terminalId,
      session_id: "sess-0001",
      command: "node fake-pi-child.mjs --session_id sess-0001",
      workdir: "/container/data",
      approval_state: "not_required",
    });
    expect(payload["resource_policy"]).toEqual({
      os_resource_limits: null,
      supervision: { stderr_max_bytes: 8192 },
    });
  });

  it("records output and exit chunks as journal events on the same stream, in order", () => {
    const f = makeFixture();
    const terminalId = f.recorder.startExecution({
      workspace_id: WS,
      agent_id: AGENT,
      session_id: null,
      command: "npm run build",
      workdir: "/container/workspace",
      resource_policy: {},
      approval_state: "not_required",
    });
    f.recorder.recordOutput({
      workspace_id: WS,
      agent_id: AGENT,
      terminal_id: terminalId,
      stream: "stdout",
      raw_chunk: "built 42 modules",
    });
    f.recorder.recordExit({
      workspace_id: WS,
      agent_id: AGENT,
      terminal_id: terminalId,
      exit_code: 0,
      exit_signal: null,
    });

    const stream = f.journal.listStream(terminalStreamFor(WS, AGENT), WS);
    expect(stream.map((row) => row.event_type)).toEqual([
      "terminal.started",
      "terminal.output",
      "terminal.exited",
    ]);
    // Per-stream sequences are gapless and strictly increasing (D26 shape).
    expect(stream.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(JSON.parse(stream[1]?.payload ?? "{}")).toMatchObject({
      terminal_id: terminalId,
      stream: "stdout",
      text: "built 42 modules",
    });
    expect(JSON.parse(stream[2]?.payload ?? "{}")).toMatchObject({
      terminal_id: terminalId,
      exit_code: 0,
      exit_signal: null,
    });
  });

  it("redacts output chunks BEFORE persistence: no secret in rows or journal (G3)", () => {
    const f = makeFixture();
    const terminalId = f.recorder.startExecution({
      workspace_id: WS,
      agent_id: AGENT,
      session_id: "sess-0002",
      command: "printenv && curl -H 'Authorization: Bearer sk-live-abc123def456' https://api",
      workdir: "/container/workspace",
      resource_policy: {},
      approval_state: "not_required",
    });
    f.recorder.recordOutput({
      workspace_id: WS,
      agent_id: AGENT,
      terminal_id: terminalId,
      stream: "stdout",
      raw_chunk: [
        "export API_KEY=sk-live-abc123def456",
        "postgres://app_user:s3cr3t-pw@db.internal:5432/shera",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/yGWy+X6wDUrNwmSrMm8CgLqkLdzXJyiBIQ==",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    });

    const secrets = ["sk-live-abc123def456", "s3cr3t-pw", "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn"];
    // The persisted terminal_events rows are clean.
    for (const row of f.repo.listRows(WS, terminalId)) {
      const serialized = JSON.stringify(row);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
    // The journal entries are clean too (the broadcast replays these rows).
    for (const row of f.journal.listStream(terminalStreamFor(WS, AGENT), WS)) {
      for (const secret of secrets) {
        expect(row.payload).not.toContain(secret);
      }
    }
  });

  it("bounds an oversized chunk to the recorded storage cap", () => {
    const f = makeFixture();
    const terminalId = f.recorder.startExecution({
      workspace_id: WS,
      agent_id: AGENT,
      session_id: null,
      command: "yes",
      workdir: "/container/workspace",
      resource_policy: {},
      approval_state: "not_required",
    });
    f.recorder.recordOutput({
      workspace_id: WS,
      agent_id: AGENT,
      terminal_id: terminalId,
      stream: "stdout",
      raw_chunk: "x".repeat(50_000),
    });
    const record = f.repo.requireRecord(WS, terminalId);
    expect(record.output).toHaveLength(1);
    expect((record.output[0]?.text ?? "").length).toBeLessThanOrEqual(8192);
  });

  it("D10: a journal failure rolls the terminal row back — no row without its entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s18-recorder-rb-"));
    tempDirs.push(dir);
    const conn = openDatabase(join(dir, "runtime.db"));
    openConnections.push(conn);
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const repo = new TerminalEventsRepository(tx);
    const failingEvents = {
      appendEvent: () => {
        throw new Error("simulated journal failure");
      },
    } as unknown as EventsService;
    const recorder = new TerminalRecorder({ tx, terminals: repo, events: failingEvents });

    expect(() =>
      recorder.startExecution({
        workspace_id: WS,
        agent_id: AGENT,
        session_id: null,
        command: "npm test",
        workdir: "/container/workspace",
        resource_policy: {},
        approval_state: "not_required",
      }),
    ).toThrow("simulated journal failure");
    expect(repo.listRecordsByAgent(WS, AGENT, 10)).toEqual([]);
  });

  it("D10: a row refusal leaves no journal entry — no entry without its row", () => {
    const f = makeFixture();
    // Output for an unknown terminal: the repository refuses the row write,
    // and the same transaction must roll back the journal append too.
    expect(() =>
      f.recorder.recordOutput({
        workspace_id: WS,
        agent_id: AGENT,
        terminal_id: "term-never-started",
        stream: "stdout",
        raw_chunk: "orphan chunk",
      }),
    ).toThrow(/never started/i);
    expect(f.journal.listStream(terminalStreamFor(WS, AGENT), WS)).toEqual([]);
  });
});
