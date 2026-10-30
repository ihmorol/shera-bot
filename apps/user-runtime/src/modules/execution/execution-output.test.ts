/**
 * Execution output capture (S26 chunk 4; AC8 "large outputs become artifacts;
 * prompt/history payloads stay bounded", G3 redaction-before-any-write, the
 * S18 whole-database byte-scan pattern). Red-first: pins the behaviors before
 * the artifact layer exists.
 *
 *   1. A large stdout/stderr stream becomes an ARTIFACT (S17's artifact
 *      repository) whose bytes are the REDACTED stream; the history row's
 *      result text stays bounded and references the artifact.
 *   2. Secret-shaped content printed by the executed code reaches NEITHER the
 *      terminal records, NOR the history row, NOR the artifact bytes, NOR the
 *      runtime.db file at the byte level (the G3 boundary is upstream of every
 *      sink).
 *   3. Prompt/history payloads stay bounded whatever the child emits: the
 *      result text carries a bounded head; the adapter's forwarded-stream cap
 *      bounds the runtime's memory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { spawnSandboxedExecution } from "../../adapters/process/execution-process-spawn.ts";
import { TerminalEventsRepository } from "../../adapters/sqlite/terminal-events-repository.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { EventsService } from "../events/events.service.ts";
import { TerminalRecorder } from "../terminals/terminal-recorder.service.ts";
import { canonicalArgsDigest, ToolExecutor } from "../tools/tool-executor.service.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import type { TaskRun } from "@shera-bot/contracts";
import { makeCodeExecutionBinding, type ExecutionToolDeps } from "./execution-tool-binding.ts";

const WS = "ws_default_01";
const TASK = "task_001";
const CONV = "conv_001";
const AGENT = "agent_researcher";
const USER = { type: "user" as const, id: "user_owner" };
const NOW = "2026-10-31T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

function makeRun(): TaskRun {
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
  };
}

interface CaptureRuntime {
  executor: ToolExecutor;
  repo: ToolsRepository;
  terminals: TerminalEventsRepository;
  artifacts: ArtifactsRepository;
  conn: SqliteConnection;
  dbDir: string;
  workspaceRoot: string;
}

function buildRuntime(): CaptureRuntime {
  const dir = mkdtempSyncSafe("shera-exec-capture-");
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepo = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepo,
    operations: new OperationsRepository(tx),
    clock: () => NOW,
  });
  const repo = new ToolsRepository(conn.db);
  const artifacts = new ArtifactsRepository(tx);
  const terminalsRepo = new TerminalEventsRepository(tx);
  const terminalRecorder = new TerminalRecorder({ tx, terminals: terminalsRepo, events });
  const registry = new ToolRegistry();
  const workspaceRoot = join(dir, "workspace");
  rmSync(workspaceRoot, { force: true, recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const deps: ExecutionToolDeps = {
    spawn: (request) => spawnSandboxedExecution(request),
    workspaceRoots: { [WS]: workspaceRoot },
    artifacts,
    terminalRecorder,
    logFault: () => {},
  };
  registry.registerBinding("code-execution", makeCodeExecutionBinding(deps));
  registry.registerBuiltinTool({
    definition: {
      workspace_id: WS,
      version: "1.0.0",
      tool_id: "tool_code_exec",
      name: "Sandboxed code execution",
      purpose: "Run a code payload inside the D27 sandbox.",
      owner: { kind: "platform" },
      inventory_scope: "shared",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          language: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["code", "language"],
      },
      output_schema: { type: "object" },
      capabilities: ["code.execute"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 60_000,
      resource_limits: {
        max_memory_mb: 1024,
        max_cpu_seconds: 30,
        max_processes: 32,
        max_disk_mb: 64,
      },
      redaction_policy: "standard",
      approval_policy: "approval_required",
      created_at: NOW,
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "code-execution",
  });
  // The reusable task grant rides the AC26 fast-path (the dispatch tests' posture).
  approvalsRepo.insertGrant({
    grant_id: "grant_code_exec",
    workspace_id: WS,
    source_choice: "always-approve-this-tool",
    principal_type: "task",
    principal_id: TASK,
    tool_id: "tool_code_exec",
    tool_version: "1.0.0",
    capability: "code.execute",
    resource_scope: `workspace:${WS}`,
    conversation_scope: "any",
    workspace_scope: WS,
    expires_at: null,
    one_time: false,
    created_by: USER,
    approved_at: NOW,
    revoked_at: null,
    args_digest: null,
    consumed_at: null,
  });
  const executor = new ToolExecutor({
    registry,
    tools: repo,
    tx,
    approvals,
    nowMs: () => Date.now(),
  });
  return { executor, repo, terminals: terminalsRepo, artifacts, conn, dbDir: dir, workspaceRoot };
}

function mkdtempSyncSafe(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function propose(rt: CaptureRuntime, code: string) {
  const rawArgs = { language: "node", code, workdir: "." };
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: "tool_code_exec",
      tool_version: "1.0.0",
      capability: "code.execute",
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "sandboxed execution proposal",
    },
    run: makeRun(),
    agent_id: AGENT,
    rawArgs,
    resource_scope: `workspace:${WS}`,
  });
}

/** The byte-level scan surface: every file the runtime persisted (db + WAL). */
function databaseBytes(dbDir: string): string {
  return readdirSync(dbDir)
    .filter((file) => file.startsWith("runtime.db"))
    .map((file) => readFileSync(join(dbDir, file)).toString("latin1"))
    .join("");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("execution output capture (S26 chunk 4)", () => {
  it("AC8: a large output becomes an artifact; the history result stays bounded and references it", async () => {
    const rt = buildRuntime();
    const result = propose(
      rt,
      `process.stdout.write("y".repeat(200 * 1024)); console.log("tail-marker");`,
    );
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    const settled = await result.completion;
    expect(settled.outcome).toBe("executed");
    if (settled.outcome !== "executed") throw new Error("unreachable");
    // Bounded prompt/history payload — the executor's 2048-byte summary budget.
    expect(settled.result_summary.length).toBeLessThanOrEqual(2100);
    // The artifact exists, carries the FULL redacted stream, and is referenced.
    // (The pointer uses the artifact id's display prefix: the executor's
    // high-entropy pass collapses full UUIDs as opaque tokens by design — the
    // durable linkage is producer_task_id + the artifacts API.)
    const refs = rt.artifacts.listArtifactsByWorkspace(WS);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.artifact_type).toBe("execution_output");
    expect(refs[0]!.producer_task_id).toBe(TASK);
    expect(refs[0]!.size).toBeGreaterThan(200 * 1024);
    expect(settled.result_summary).toContain("captured as artifact");
    expect(settled.result_summary).toContain(refs[0]!.artifact_id.slice(0, 8));
    const full = rt.artifacts.getArtifact(WS, refs[0]!.artifact_id);
    expect(full).not.toBeNull();
    const text = Buffer.from(full!.content).toString("utf8");
    expect(text).toContain("tail-marker");
    expect(text.length).toBeGreaterThan(200 * 1024);
  });

  it("G3: secret-shaped stdout reaches neither the terminal records, the history, the artifact, nor the database bytes", async () => {
    const secret = "SK-S26-CAPTURE-SECRET-9f8e7d6c5b4a";
    const rt = buildRuntime();
    const result = propose(
      rt,
      `console.log("API_KEY=${secret}");
       process.stdout.write("z".repeat(120 * 1024));`,
    );
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    const settled = await result.completion;
    expect(settled.outcome).toBe("executed");
    if (settled.outcome !== "executed") throw new Error("unreachable");
    expect(settled.result_summary).not.toContain(secret);
    // History row.
    const history = rt.repo.listExecutionsByTool(WS, "tool_code_exec");
    expect(history[0]!.result_summary).not.toContain(secret);
    // Terminal records (rows + journal payloads).
    const terminalRecords = rt.terminals.listRecordsByAgent(WS, AGENT, 10);
    expect(terminalRecords.length).toBeGreaterThan(0);
    for (const record of terminalRecords) {
      expect(JSON.stringify(record)).not.toContain(secret);
    }
    // Artifact bytes.
    const refs = rt.artifacts.listArtifactsByWorkspace(WS);
    expect(refs).toHaveLength(1);
    const artifactText = Buffer.from(
      rt.artifacts.getArtifact(WS, refs[0]!.artifact_id)!.content,
    ).toString("utf8");
    expect(artifactText).not.toContain(secret);
    // The whole database at the byte level (the S18 pattern).
    expect(existsSync(join(rt.dbDir, "runtime.db"))).toBe(true);
    expect(databaseBytes(rt.dbDir)).not.toContain(secret);
  });

  it("the terminal records for one execution show started/output/exit with the enforced policy", async () => {
    const rt = buildRuntime();
    const result = propose(rt, `console.log("terminal-live-output");`);
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    await result.completion;
    const records = rt.terminals.listRecordsByAgent(WS, AGENT, 10);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.state).toBe("exited");
    expect(record.command).toContain("node");
    expect(record.resource_policy["network"]).toBe("disabled");
    expect(record.approval_state).toBe("approved");
    expect(record.exit_code).toBe(0);
    const outputText = record.output.map((chunk) => chunk.text).join("");
    expect(outputText).toContain("terminal-live-output");
  });
});
