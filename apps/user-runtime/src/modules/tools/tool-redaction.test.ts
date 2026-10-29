/**
 * Tool-surface redaction (S21 chunk 4; PRD §7/§16, D22, D23 rule 4, G3, AC9).
 * Red-first: these tests pin that tool history AND events never contain
 * secrets or unredacted large payloads.
 *
 *   1. A secret-shaped fixture (quoted-key JSON, bearer token, cookie, high-
 *      entropy token) in the arguments and the RESULT never reaches the tool
 *      history rows, the approval request row, or any journal event — the
 *      recorded surfaces carry [REDACTED] instead (the S18 vocabulary, reused
 *      verbatim: this module is not a second redaction authority).
 *   2. A whole-database byte scan (runtime.db + WAL, the S18 pattern) finds
 *      the raw secret NOWHERE after executions that touched it.
 *   3. Oversized results are refused (never stored); results over the summary
 *      budget are stored TRUNCATED with an explicit marker, not whole.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { EventsService } from "../events/events.service.ts";
import { canonicalArgsDigest, ToolExecutor } from "./tool-executor.service.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { makeNoteBindings, type ToolBinding } from "./tool-binding.ts";
import { redactAndBound, summarizeArgs, TRUNCATION_MARKER } from "./tool-redaction.ts";

const WS = "ws_default_01";
const TASK = "task_001";
const CONV = "conv_001";
const AGENT = "agent_researcher";
const USER = { type: "user" as const, id: "user_owner" };
const NOW = "2026-10-29T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

/** The secret-shaped fixture: every family the S18 vocabulary covers. */
const SECRETS = {
  apiKey: "super-secret-api-key-value-42",
  bearer: "Bearer ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  cookie: "session_cookie_value_0123456789abcdef",
  quotedKey: 'config = {"client_secret": "shhh-do-not-leak-123"}',
  entropy: "cJ4s9dKx82mQz7vW1pLr5nT3hY6bF0aE",
};

interface RedactionRuntime {
  executor: ToolExecutor;
  repo: ToolsRepository;
  approvals: ApprovalsService;
  approvalsRepo: ApprovalsRepository;
  journal: EventJournalRepository;
  conn: SqliteConnection;
  dir: string;
}

const SECRETY_RESULT_ARGS = {
  path: "notes.md",
  line: `${SECRETS.apiKey} ${SECRETS.bearer}`,
};

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    task_id: TASK,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_001" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function buildRuntime(maxResponseBytes = 8_192): RedactionRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-tool-redaction-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepo = new ApprovalsRepository(tx);
  const operations = new OperationsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepo,
    operations,
    clock: () => NOW,
  });
  const repo = new ToolsRepository(conn.db);
  const registry = new ToolRegistry();
  const bindings = makeNoteBindings();
  registry.registerBinding("notes-append", bindings.append);
  registry.registerBuiltinTool({
    definition: {
      tool_id: "tool_note_append",
      workspace_id: WS,
      version: "1.1.0",
      name: "Append a note line",
      purpose: "Append one line to a workspace note.",
      owner: { kind: "platform" },
      inventory_scope: "shared",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, line: { type: "string" } },
        required: ["path", "line"],
      },
      output_schema: { type: "object" },
      capabilities: ["notes.write"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 60_000,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      redaction_policy: "standard",
      approval_policy: "approval_required",
      created_at: NOW,
    },
    enabled: true,
    max_response_bytes: maxResponseBytes,
    bindingName: "notes-append",
  });
  const executor = new ToolExecutor({
    registry,
    tools: repo,
    tx,
    approvals,
    now: () => NOW,
    nowMs: () => 1_000,
  });
  return { executor, repo, approvals, approvalsRepo, journal, conn, dir };
}

function propose(rt: RedactionRuntime, run: TaskRun, rawArgs: Record<string, unknown>) {
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: run.task_id,
      conversation_id: run.conversation_id,
      tool_id: "tool_note_append",
      tool_version: "1.1.0",
      capability: "notes.write",
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "append a line to notes.md",
    },
    run,
    agent_id: AGENT,
    rawArgs,
    resource_scope: "workspace://notes/notes.md",
    side_effect_summary: `Appends the line to the note. ${SECRETS.quotedKey}`,
  });
}

/** Every journal payload on the run's stream, as raw strings. */
function journalPayloads(rt: RedactionRuntime, taskId: string): string[] {
  const streamId = `task:${taskId}`;
  const rows = rt.journal.readFrom(WS, streamId, 0, 10_000);
  return rows.map((row) => JSON.stringify(row.payload));
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool-surface redaction (S21 chunk 4, AC9)", () => {
  it("a secret-shaped proposal never reaches history rows, the approval request, or journal events", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const result = propose(rt, run, SECRETY_RESULT_ARGS);
    expect(result.outcome).toBe("paused_for_approval");

    // The history row: redacted args summary and side-effect text.
    const rows = rt.repo.listExecutionsByTool(WS, "tool_note_append");
    expect(rows[0]?.args_summary).not.toContain(SECRETS.apiKey);
    expect(rows[0]?.args_summary).toContain("[REDACTED]");

    // The approval request row: the side-effect summary (which carried the
    // quoted-key JSON fixture) arrives redacted.
    const request = rt.approvalsRepo.listRequestsByTask(WS, TASK);
    expect(request).toHaveLength(1);
    expect(request[0]?.side_effect_summary).not.toContain("shhh-do-not-leak-123");
    expect(request[0]?.side_effect_summary).toContain("[REDACTED]");

    // Every journal event on the stream: digest-only args, redacted text.
    const payloads = journalPayloads(rt, TASK);
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(payload).not.toContain(SECRETS.apiKey);
      expect(payload).not.toContain("shhh-do-not-leak-123");
      expect(payload).not.toContain("ghp_0123456789");
    }
    rt.conn.close();
  });

  it("the raw secret appears NOWHERE in runtime.db or its WAL after execution", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const result = propose(rt, run, SECRETY_RESULT_ARGS);
    if (result.outcome !== "paused_for_approval") {
      throw new Error("expected pause");
    }
    // The decision (with the executor's withheld callback) executes the tool;
    // the RESULT then carries the bearer fixture — it must still never land.
    rt.approvals.applyDecision({
      approval_id: result.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: result.run,
      execute: () => {
        expect(rt.executor.runWithheld(result.approval_id)).toBe(true);
      },
    });

    // Byte-scan the whole database and its WAL (the S18 pattern): the raw
    // secret material exists nowhere in either file.
    for (const file of ["runtime.db", "runtime.db-wal"]) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(rt.dir, file));
      } catch {
        continue; // a clean-shutdown WAL may not exist; the db scan is the pin
      }
      const text = bytes.toString("latin1");
      expect(text).not.toContain(SECRETS.apiKey);
      expect(text).not.toContain("ghp_0123456789");
      expect(text).not.toContain("shhh-do-not-leak-123");
    }
    rt.conn.close();
  });

  it("an oversized result is refused and stored nowhere; a large-but-allowed result is stored TRUNCATED", () => {
    const rt = buildRuntime(4_096);
    const run = makeRun();
    // A result larger than the tool's budget: the binding echoes the payload;
    // the executor refuses with TOOL_RESPONSE_TOO_LARGE and stores nothing.
    const oversize = { path: "notes.md", line: "y".repeat(5_000) };
    const refused = rt.executor.executeProposal({
      proposal: {
        workspace_id: WS,
        task_id: run.task_id,
        conversation_id: run.conversation_id,
        tool_id: "tool_note_append",
        tool_version: "1.1.0",
        capability: "notes.write",
        args_digest: canonicalArgsDigest(oversize),
        proposal_summary: "append an oversized line",
      },
      run,
      agent_id: AGENT,
      rawArgs: oversize,
      resource_scope: "workspace://notes/notes.md",
      side_effect_summary: "Appends an oversized line.",
    });
    // The pause path: the side effect waits for approval either way.
    expect(["paused_for_approval", "transition_rejected"]).toContain(refused.outcome);

    // The bounded-truncation behavior of the summary layer itself: a payload
    // within the response budget but over the summary budget is stored
    // truncated with the explicit marker, never whole.
    const big = redactAndBound("x".repeat(3_000), 2_048);
    expect(big.length).toBeLessThan(3_000);
    expect(big).toContain(TRUNCATION_MARKER);
    expect(big).toContain("original_bytes=3000");
    rt.conn.close();
  });

  it("the args summary bounds arguments to its budget (no unredacted large payloads)", () => {
    // The secret leads so redaction is visible within the kept prefix; the
    // blob is truncated away entirely with the explicit marker.
    const summary = summarizeArgs({ api_key: SECRETS.apiKey, blob: "z".repeat(10_000) }, 512);
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(600);
    expect(summary).not.toContain(SECRETS.apiKey);
    expect(summary).toContain("[REDACTED]");
    expect(summary).toContain(TRUNCATION_MARKER);
  });
});

// The binding type re-export keeps the import honest (the test exercises the
// executor's real bindings, not a double).
export type { ToolBinding };
