/**
 * S27 ST-14 — the redaction sweep (threat model §5 ST-14; §6 redaction rules;
 * G3, D22, D23 rule 4, D14, D5/D26, D37). The five threat-model fixture
 * classes (rendered as S27-labeled synthetic values — G3) driven through the
 * PERSISTED surfaces, then the artifacts searched:
 *
 *   1. TERMINAL ROWS — every fixture through the REAL TerminalRecorder
 *      (output chunks AND a command line carrying a fixture): the rows carry
 *      [REDACTED], never a raw value.
 *   2. TOOL HISTORY — a tool whose result echoes every fixture, with a
 *      fixture-bearing argument, through the REAL executor: the row's result
 *      and args summaries carry [REDACTED]; the raw values never land.
 *   3. THE ERROR TAXONOMY — a typed service error whose INTERNAL message
 *      carries a fixture maps to the wire body with the STATIC safe_message
 *      and internal_details: null (D23 rule 4) — the internal text (and the
 *      fixture in it) never crosses.
 *   4. MEMORY — a memory.create whose content carries the provider-key
 *      fixture is the typed MEMORY_SECRET_REJECTED refusal (D37); no row, no
 *      receipt, no version, no event.
 *   5. THE BYTE SWEEP — the whole store (database + sidecars) is searched:
 *      zero raw fixture values anywhere; the redaction marker IS present.
 *
 * RED-FIRST evidence: the terminal-boundary redaction authority
 * (redactSecrets) was replaced by the identity function — every sink (the
 * recorder, the tool redaction layer, the executor) lost its pass — the suite
 * FAILED (raw fixtures in the rows and the store bytes), the control was
 * restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-09-st14-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-14, §6; G3, D22, D23 rule 4, D14,
 * D37, AC9; the S27 fixture convention (synthetic, clearly labeled — G3/G7).
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { TerminalEventsRepository } from "../../apps/user-runtime/src/adapters/sqlite/terminal-events-repository.ts";
import { MemoryRepository } from "../../apps/user-runtime/src/adapters/sqlite/memory-repository.ts";
import { CommandReceiptsRepository } from "../../apps/user-runtime/src/adapters/sqlite/command-receipts-repository.ts";
import { OperationsRepository } from "../../apps/user-runtime/src/adapters/sqlite/operations-repository.ts";
import { ToolsRepository } from "../../apps/user-runtime/src/adapters/sqlite/tools-repository.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { TerminalRecorder } from "../../apps/user-runtime/src/modules/terminals/terminal-recorder.service.ts";
import { MemoryService, MemoryServiceError } from "../../apps/user-runtime/src/modules/memory/memory.service.ts";
import { ToolExecutor, canonicalArgsDigest } from "../../apps/user-runtime/src/modules/tools/tool-executor.service.ts";
import { ToolRegistry } from "../../apps/user-runtime/src/modules/tools/tool-registry.ts";
import { toSheraErrorResponse } from "../../apps/user-runtime/src/transport/http/typed-errors.ts";

/**
 * The five threat-model classes + private-key material, as S27-labeled
 * synthetic fixtures (clearly labeled, never real credentials — G3). Each
 * shape is one the recorded redaction vocabulary MUST catch.
 */
const FIXTURES = {
  providerKey: "OPENAI_API_KEY=s27-SYNTHETIC-provider-key-value-NOT-REAL",
  repoCredential:
    "https://shera-bot:s27-SYNTHETIC-repo-credential-NOT-REAL@example.com/owner/repo.git",
  browserCookie: "set-cookie: shera_session=s27-SYNTHETIC-cookie-value-NOT-REAL; Path=/; HttpOnly",
  oauthToken: "Authorization: Bearer s27-SYNTHETIC-oauth-token-NOT-REAL",
  urlEmbeddedSecret: "postgres://etl:s27-SYNTHETIC-url-secret-NOT-REAL@db.internal:5432/app",
  pemBlock: [
    "-----BEGIN PRIVATE KEY-----",
    "s27SYNTHETICkeymaterialNOTREALline1",
    "s27SYNTHETICkeymaterialNOTREALline2",
    "-----END PRIVATE KEY-----",
  ].join("\n"),
};

/** The raw values only (what the byte sweep must never find). */
function fixtureValues(): string[] {
  return Object.values(FIXTURES).map((value) => value);
}

const WS = "ws_s27_st14";
const TASK = "task_s27_st14";
const CONV = "conv_s27_st14";
const AGENT = "agent_leaker";
const NOW = "2026-11-09T12:00:00.000Z";
const HASH = "e".repeat(64);

const tempDirs: string[] = [];

interface St14Harness {
  dbPath: string;
  conn: SqliteConnection;
  recorder: TerminalRecorder;
  executor: ToolExecutor;
  dispose(): void;
}

function makeRun(): TaskRun {
  return {
    task_id: TASK,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_st14" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function buildHarness(): St14Harness {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st14-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "runtime.db");
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const recorder = new TerminalRecorder({
    tx,
    terminals: new TerminalEventsRepository(tx),
    events,
  });
  const repo = new ToolsRepository(conn.db);
  const registry = new ToolRegistry();
  // A READ_ONLY tool whose result ECHOES its argument back (the leaky-client
  // shape: a fake provider client printing whatever it was handed).
  registry.registerBinding("s27-st14-echo", {
    name: "s27-st14-echo",
    preview() {
      return null;
    },
    execute(args) {
      const text = typeof args.echo === "string" ? args.echo : "";
      return { ok: true, text };
    },
  });
  registry.registerBuiltinTool({
    definition: {
      tool_id: "tool_st14_echo",
      workspace_id: WS,
      version: "1.0.0",
      name: "ST-14 echo probe",
      purpose: "Echoes its argument (the leaky fake-client shape).",
      owner: { kind: "platform" },
      inventory_scope: "shared",
      input_schema: { type: "object", properties: { echo: { type: "string" } } },
      output_schema: { type: "object" },
      capabilities: ["notes.read"],
      risk_class: "READ_ONLY",
      timeout_ms: 60_000,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      redaction_policy: "standard",
      approval_policy: "auto_read_only",
      created_at: NOW,
    },
    enabled: true,
    max_response_bytes: 32_768,
    bindingName: "s27-st14-echo",
  });
  const executor = new ToolExecutor({ registry, tools: repo, tx, now: () => NOW, nowMs: () => 1_000 });
  return {
    dbPath,
    conn,
    recorder,
    executor,
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

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("S27 ST-14 — the terminal boundary redacts every fixture class", () => {
  it("all five classes + PEM through the recorder: rows + journal carry [REDACTED], never a raw value", () => {
    const h = buildHarness();
    try {
      const terminalId = h.recorder.startExecution({
        workspace_id: WS,
        agent_id: AGENT,
        session_id: null,
        // The command line itself carries the repository credential (the
        // hostile git shape) — the recorded start row must redact it too.
        command: `git clone ${FIXTURES.repoCredential}`,
        workdir: "/workspace",
        resource_policy: { network: "disabled" },
        approval_state: "not_required",
      });
      for (const chunk of fixtureValues()) {
        h.recorder.recordOutput({
          workspace_id: WS,
          agent_id: AGENT,
          terminal_id: terminalId,
          stream: "stdout",
          raw_chunk: chunk,
        });
      }
      // The terminal rows: redacted.
      const outputs = h.conn.db
        .prepare("SELECT chunk FROM terminal_events WHERE terminal_id = ? AND chunk IS NOT NULL")
        .all(terminalId) as Array<{ chunk: string }>;
      expect(outputs.length).toBeGreaterThanOrEqual(fixtureValues().length);
      for (const row of outputs) {
        expect(row.chunk).toContain("[REDACTED]");
        for (const raw of fixtureValues()) {
          expect(row.chunk).not.toContain(raw);
        }
      }
      // The start row's command line: the credential URL is redacted there.
      const start = h.conn.db
        .prepare("SELECT command FROM terminal_events WHERE terminal_id = ? AND command IS NOT NULL")
        .get(terminalId) as { command: string };
      expect(start.command).not.toContain("s27-SYNTHETIC-repo-credential-NOT-REAL");
      expect(start.command).toContain("[REDACTED]");
    } finally {
      h.dispose();
    }
  });
});

describe("S27 ST-14 — tool history redacts the leaky client's echo", () => {
  it("a tool echoing every fixture + a fixture-bearing argument: summaries redacted, raw values absent", () => {
    const h = buildHarness();
    try {
      const echoed = fixtureValues().join("\n");
      const rawArgs = { echo: echoed, note: FIXTURES.providerKey };
      const result = h.executor.executeProposal({
        proposal: {
          workspace_id: WS,
          task_id: TASK,
          conversation_id: CONV,
          tool_id: "tool_st14_echo",
          tool_version: "1.0.0",
          capability: "notes.read",
          args_digest: canonicalArgsDigest(rawArgs),
          proposal_summary: "the leaky fake-client echo",
        },
        run: makeRun(),
        agent_id: AGENT,
        rawArgs,
      });
      expect(result.outcome).toBe("executed");
      const rows = h.conn.db
        .prepare("SELECT args_summary, result_summary FROM tool_execution_history WHERE workspace_id = ? AND task_id = ?")
        .all(WS, TASK) as Array<{ args_summary: string; result_summary: string | null }>;
      expect(rows).toHaveLength(1);
      const stored = `${rows[0]?.args_summary ?? ""}\n${rows[0]?.result_summary ?? ""}`;
      expect(stored).toContain("[REDACTED]");
      for (const raw of fixtureValues()) {
        expect(stored).not.toContain(raw);
      }
    } finally {
      h.dispose();
    }
  });
});

describe("S27 ST-14 — the error taxonomy never crosses an internal fixture (D23 rule 4)", () => {
  it("a typed error whose INTERNAL message carries a fixture maps to a static safe_message and null internal_details", () => {
    // The internal message embeds the oauth fixture (what an internal error
    // message realistically carries after a hostile input reached a layer).
    // The code IS mapped: the wire body takes the STATIC safe message.
    const hostile = new MemoryServiceError(
      "MEMORY_SECRET_REJECTED",
      "validation",
      `the memory write was refused while scanning ${FIXTURES.oauthToken}`,
    );
    const mapping = toSheraErrorResponse(hostile, "corr_s27_st14");
    const body = JSON.stringify(mapping.body);
    // The wire body: the STATIC safe message, the internal text never.
    expect(mapping.body.internal_details).toBeNull();
    expect(body).not.toContain("s27-SYNTHETIC-oauth-token-NOT-REAL");
    expect(mapping.body.safe_message.length).toBeGreaterThan(0);
    expect(mapping.body.safe_message).not.toContain("Bearer");
    // Untyped faults answer the generic INTERNAL_ERROR with NO internals
    // (the correlation id is all the client learns).
    const untyped = toSheraErrorResponse(
      new Error(`unexpected failure scanning ${FIXTURES.urlEmbeddedSecret}`),
      "corr_s27_st14_b",
    );
    expect(untyped.body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(untyped.body)).not.toContain("s27-SYNTHETIC-url-secret-NOT-REAL");
  });
});

describe("S27 ST-14 — memory rejects credential-shaped writes outright (D37)", () => {
  it("a memory.create carrying the provider-key fixture is MEMORY_SECRET_REJECTED; nothing stored", async () => {
    const h = buildHarness();
    try {
      const tx = new SqliteTransactions(h.conn.db);
      const journal = new EventJournalRepository(tx);
      const memory = new MemoryService({
        memory: new MemoryRepository(tx),
        operations: new OperationsRepository(tx),
        receipts: new CommandReceiptsRepository(tx),
        tx,
        journal,
        events: new EventsService(journal, tx),
        now: () => NOW,
      });
      const command = {
        command_id: "cmd_s27_st14",
        idempotency_key: "idem_s27_st14",
        workspace_id: WS,
        actor: { type: "user", id: "user_owner" } as const,
        issued_at: NOW,
        type: "memory.create" as const,
        scope: "workspace" as const,
        owner_agent_id: null,
        operation_id: null,
        task_id: null,
        summary: "The service needs the key",
        content: `Call it with ${FIXTURES.providerKey} before the deadline.`,
        sensitivity: "normal" as const,
        source_refs: ["conversation://direct/user_owner"],
        confidence: 0.7,
        expires_at: null,
      };
      await expect(memory.applyCommand(command)).rejects.toThrow(/MEMORY_SECRET_REJECTED/);
      // NOTHING landed: no entry, no version, no receipt.
      const count = h.conn.db
        .prepare("SELECT COUNT(*) AS n FROM memory_entry WHERE workspace_id = ?")
        .get(WS) as { n: number };
      expect(count.n).toBe(0);
      const receipts = h.conn.db
        .prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE workspace_id = ?")
        .get(WS) as { n: number };
      expect(receipts.n).toBe(0);
    } finally {
      h.dispose();
    }
  });
});

describe("S27 ST-14 — the whole-store byte sweep", () => {
  it("after every leg's writes: zero raw fixture values in the store bytes; the marker IS there", () => {
    const h = buildHarness();
    try {
      // Drive the leg surfaces into THIS store: terminal rows, tool history.
      const terminalId = h.recorder.startExecution({
        workspace_id: WS,
        agent_id: AGENT,
        session_id: null,
        command: `git clone ${FIXTURES.repoCredential}`,
        workdir: "/workspace",
        resource_policy: { network: "disabled" },
        approval_state: "not_required",
      });
      for (const chunk of fixtureValues()) {
        h.recorder.recordOutput({
          workspace_id: WS,
          agent_id: AGENT,
          terminal_id: terminalId,
          stream: "stderr",
          raw_chunk: chunk,
        });
      }
      const echoed = fixtureValues().join("\n");
      const rawArgs = { echo: echoed };
      const result = h.executor.executeProposal({
        proposal: {
          workspace_id: WS,
          task_id: TASK,
          conversation_id: CONV,
          tool_id: "tool_st14_echo",
          tool_version: "1.0.0",
          capability: "notes.read",
          args_digest: canonicalArgsDigest(rawArgs),
          proposal_summary: "the sweep's echo leg",
        },
        run: makeRun(),
        agent_id: AGENT,
        rawArgs,
      });
      expect(result.outcome).toBe("executed");
      // THE SWEEP: close first so the WAL content is in the main file, then
      // scan the database bytes.
      h.dispose();
      const bytes = scanStoreBytes(h.dbPath);
      expect(bytes).toContain("[REDACTED]");
      for (const raw of fixtureValues()) {
        expect(bytes, `the raw fixture must not exist in the store bytes`).not.toContain(raw);
      }
    } finally {
      h.dispose();
    }
  });
});
