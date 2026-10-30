/**
 * Tool executor × cancellation (S22 chunk 4; AC5, D32, E13, G6) — red-first.
 * Cancelling a run must terminate its tool work through the executor seam:
 *
 *   1. a WITHHELD gated execution (paused for approval) is dropped — the
 *      effect NEVER runs after the cancel (fail-closed; runWithheld answers
 *      the typed false), and the history row reads `cancelled`;
 *   2. non-terminal history rows of the task (`running`, `awaiting_approval`
 *      — the crash-era orphans) sweep to `cancelled`; terminal rows keep
 *      their outcome (nothing is rewritten);
 *   3. the cancelled execution ids are returned (the cancellation evidence)
 *      and a second call is an empty no-op (idempotent).
 *
 * The abort-signal registry rides ctx.signal for the process-backed binding
 * family (S26's escalation hook); the in-process binding family is
 * synchronous, so the honest cancellation surface today is the withheld
 * executions and the row sweep — recorded in E35.
 *
 * Governing records: AC5, D32, D9 (no grant from a cancelled approval), G6.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
import { makeNoteBindings } from "./tool-binding.ts";

const WS = "ws_default_01";
const TASK = "task_001";
const OTHER_TASK = "task_002";
const CONV = "conv_001";
const AGENT = "agent_researcher";
const NOW = "2026-10-29T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

interface Runtime {
  executor: ToolExecutor;
  repo: ToolsRepository;
  approvals: ApprovalsService;
  conn: SqliteConnection;
  notes: Map<string, string>;
}

function makeRun(taskId: string = TASK, overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    task_id: taskId,
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

function buildRuntime(): Runtime {
  const dir = mkdtempSync(join(tmpdir(), "shera-tool-cancel-"));
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
    max_response_bytes: 4_096,
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
  return { executor, repo, approvals, conn, notes: bindings.notes };
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const RAW_ARGS = { path: "notes.md", line: "second line" };
const RESOURCE_SCOPE = "workspace://notes/notes.md";

function propose(
  rt: Runtime,
  run: TaskRun = makeRun(),
): ReturnType<ToolExecutor["executeProposal"]> {
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: run.workspace_id,
      task_id: run.task_id,
      conversation_id: run.conversation_id,
      tool_id: "tool_note_append",
      tool_version: "1.1.0",
      capability: "notes.write",
      args_digest: canonicalArgsDigest(RAW_ARGS),
      proposal_summary: "Append one line to the workspace note.",
    },
    run,
    agent_id: AGENT,
    rawArgs: RAW_ARGS,
    resource_scope: RESOURCE_SCOPE,
    side_effect_summary: "Appends a line to notes.md",
  });
}

describe("S22 — the executor cancellation seam (AC5)", () => {
  it("drops a withheld gated execution: the effect never runs after the cancel", () => {
    const rt = buildRuntime();
    const paused = propose(rt);
    expect(paused.outcome).toBe("paused_for_approval");
    if (paused.outcome !== "paused_for_approval") return;

    // The run is cancelled before any decision: the withheld execution dies.
    const cancelledIds = rt.executor.cancelForTask(WS, TASK);
    expect(cancelledIds).toHaveLength(1);

    // The decision machinery's post-commit callback can no longer reach it.
    expect(rt.executor.runWithheld(paused.approval_id)).toBe(false);

    // The effect never happened and the row reads cancelled.
    expect(rt.notes.has("notes.md")).toBe(false);
    const row = rt.repo.getExecution(WS, paused.execution_id);
    expect(row?.status).toBe("cancelled");
    expect(row?.finished_at).not.toBeNull();
  });

  it("sweeps non-terminal history rows of the task to cancelled; terminal rows keep their outcome", () => {
    const rt = buildRuntime();
    // A crash-era orphan: a row the executor never reached a terminal write for.
    rt.repo.insertExecution({
      workspace_id: WS,
      execution_id: "exe_orphan_running",
      task_id: TASK,
      conversation_id: CONV,
      agent_id: AGENT,
      tool_id: "tool_note_append",
      tool_version: "1.1.0",
      capability: "notes.write",
      risk_class: "LOCAL_MUTATION",
      recovery: "needs_human",
      args_digest: "sha256:" + "b".repeat(64),
      args_summary: "{}",
      preview: null,
      status: "running",
      approval_id: null,
      grant_id: null,
      error_code: null,
      result_summary: null,
      timeout_ms: 60_000,
      max_response_bytes: 4_096,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      started_at: NOW,
      finished_at: null,
    });
    // A terminal row that must NOT be rewritten.
    rt.repo.insertExecution({
      workspace_id: WS,
      execution_id: "exe_finished",
      task_id: TASK,
      conversation_id: CONV,
      agent_id: AGENT,
      tool_id: "tool_note_append",
      tool_version: "1.1.0",
      capability: "notes.write",
      risk_class: "LOCAL_MUTATION",
      recovery: "needs_human",
      args_digest: "sha256:" + "c".repeat(64),
      args_summary: "{}",
      preview: null,
      status: "succeeded",
      approval_id: null,
      grant_id: null,
      error_code: null,
      result_summary: "done",
      timeout_ms: 60_000,
      max_response_bytes: 4_096,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      started_at: NOW,
      finished_at: NOW,
    });
    // Another task's running row is out of scope (cancel is task-scoped).
    rt.repo.insertExecution({
      workspace_id: WS,
      execution_id: "exe_other_task",
      task_id: OTHER_TASK,
      conversation_id: CONV,
      agent_id: AGENT,
      tool_id: "tool_note_append",
      tool_version: "1.1.0",
      capability: "notes.write",
      risk_class: "LOCAL_MUTATION",
      recovery: "needs_human",
      args_digest: "sha256:" + "d".repeat(64),
      args_summary: "{}",
      preview: null,
      status: "running",
      approval_id: null,
      grant_id: null,
      error_code: null,
      result_summary: null,
      timeout_ms: 60_000,
      max_response_bytes: 4_096,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      started_at: NOW,
      finished_at: null,
    });

    const cancelledIds = rt.executor.cancelForTask(WS, TASK);
    expect(cancelledIds).toContain("exe_orphan_running");
    expect(cancelledIds).not.toContain("exe_finished");
    expect(cancelledIds).not.toContain("exe_other_task");

    expect(rt.repo.getExecution(WS, "exe_orphan_running")?.status).toBe("cancelled");
    expect(rt.repo.getExecution(WS, "exe_finished")?.status).toBe("succeeded");
    expect(rt.repo.getExecution(WS, "exe_other_task")?.status).toBe("running");
  });

  it("a second cancel is an empty no-op (idempotent)", () => {
    const rt = buildRuntime();
    expect(rt.executor.cancelForTask(WS, TASK)).toEqual([]);
    expect(rt.executor.cancelForTask(WS, TASK)).toEqual([]);
  });
});
