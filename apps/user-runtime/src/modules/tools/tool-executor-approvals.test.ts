/**
 * Tool executor × the S20 approval machinery (S21 chunk 3; PRD §8/§19 AC26,
 * D9, D35, G2/G3/G6, AC2/AC3). Red-first: these tests pin the chunk-3
 * behaviors with the REAL ApprovalsService (the executor is its first
 * production caller — the S20 P0).
 *
 *   1. AC3: a gated (LOCAL_MUTATION) proposal pauses the run through the D8
 *      machinery and NOTHING executes before the decision — the side effect
 *      (a real append, observable in the note store) does not exist while the
 *      request is pending.
 *   2. AC2: the diff preview is recorded BEFORE any write — the history row
 *      carries the preview while awaiting approval, and the append happens
 *      only after the approve decision commits.
 *   3. The grant fast-path (AC26): after "always approve this tool" the same
 *      proposal executes WITHOUT a new approval request; revoking the grant
 *      restores the pause; a one-time grant executes once and is consumed.
 *   4. A disabled tool refuses even when a grant exists (AC6, end to end).
 *   5. reject-this-action ends the action as a typed denial — no execution;
 *      cancel-the-task cancels the run.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ApprovalChoice, TaskRun } from "@shera-bot/contracts";

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
const CONV = "conv_001";
const AGENT = "agent_researcher";
const USER = { type: "user" as const, id: "user_owner" };
const NOW = "2026-10-29T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

interface ApprovalRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  repo: ToolsRepository;
  approvals: ApprovalsService;
  approvalsRepo: ApprovalsRepository;
  conn: SqliteConnection;
  notes: Map<string, string>;
  decisions: {
    decide(
      approvalId: string,
      choice: ApprovalChoice,
      run: TaskRun,
    ): ReturnType<ApprovalsService["applyDecision"]>;
  };
}

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

function buildRuntime(): ApprovalRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-tool-approvals-"));
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
  return {
    executor,
    registry,
    repo,
    approvals,
    approvalsRepo,
    conn,
    notes: bindings.notes,
    decisions: {
      decide: (approvalId, choice, run) =>
        approvals.applyDecision({
          approval_id: approvalId,
          choice,
          decided_by: USER,
          run,
          execute: () => {},
        }),
    },
  };
}

const RAW_ARGS = { path: "notes.md", line: "second line" };
const RESOURCE_SCOPE = "workspace://notes/notes.md";

function propose(
  rt: ApprovalRuntime,
  run: TaskRun = makeRun(),
  overrides: { rawArgs?: Record<string, unknown>; resourceScope?: string } = {},
) {
  const rawArgs = overrides.rawArgs ?? RAW_ARGS;
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
    resource_scope: overrides.resourceScope ?? RESOURCE_SCOPE,
  });
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("gated execution pauses through the S20 machinery (S21 chunk 3)", () => {
  it("AC3: a LOCAL_MUTATION proposal pauses with ZERO side effects before the decision", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const result = propose(rt, run);
    expect(result.outcome).toBe("paused_for_approval");
    // The side effect does not exist yet — the REAL effect, not a flag.
    expect(rt.notes.get("notes.md")).toBeUndefined();
    if (result.outcome === "paused_for_approval") {
      expect(result.run.state).toBe("WAITING_FOR_APPROVAL");
      const request = rt.approvalsRepo.getRequest(WS, result.approval_id);
      expect(request?.status).toBe("pending");
      expect(request?.risk_class).toBe("LOCAL_MUTATION");
    }
    rt.conn.close();
  });

  it("AC2: the diff preview is recorded BEFORE any write; the write happens only after approval", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const result = propose(rt, run);
    expect(result.outcome).toBe("paused_for_approval");
    // The preview exists on the awaiting row while nothing was written.
    const rows = rt.repo.listExecutionsByTool(WS, "tool_note_append");
    expect(rows[0]?.status).toBe("awaiting_approval");
    expect(rows[0]?.preview).not.toBeNull();
    expect(rows[0]?.preview).toHaveProperty("kind", "diff");
    expect(String(rows[0]?.preview && (rows[0].preview as Record<string, unknown>).text)).toContain(
      "+second line",
    );
    expect(rt.notes.get("notes.md")).toBeUndefined();

    if (result.outcome !== "paused_for_approval") {
      throw new Error("expected pause");
    }
    // Approve-this-execution-only: the withheld callback runs AFTER the
    // commit — the production callback IS executor.runWithheld.
    const decision = rt.approvals.applyDecision({
      approval_id: result.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: result.run,
      execute: () => {
        expect(rt.executor.runWithheld(result.approval_id)).toBe(true);
      },
    });
    expect(decision.outcome).toBe("approved");
    // The write happened exactly once — after the decision.
    expect(rt.notes.get("notes.md")).toContain("second line");
    rt.conn.close();
  });

  it("reject-this-action denies the action without executing; the run resumes", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const result = propose(rt, run);
    if (result.outcome !== "paused_for_approval") {
      throw new Error("expected pause");
    }
    const decision = rt.approvals.applyDecision({
      approval_id: result.approval_id,
      choice: "reject-this-action",
      decided_by: USER,
      run: result.run,
      execute: () => {
        throw new Error("the withheld action must never run on reject");
      },
    });
    expect(decision.outcome).toBe("action_rejected");
    expect(rt.notes.get("notes.md")).toBeUndefined();
    if (decision.outcome !== "action_rejected") {
      throw new Error("expected action_rejected");
    }
    expect(decision.run.state).toBe("RUNNING");
    rt.conn.close();
  });
});

describe("the grant fast-path (AC26 — skips the prompt, never the check)", () => {
  it("a reusable grant executes without a new approval request; revocation restores the pause", () => {
    const rt = buildRuntime();
    const run = makeRun();
    // First proposal pauses; approve ALWAYS-THIS-TOOL (task-principal grant).
    const first = propose(rt, run);
    if (first.outcome !== "paused_for_approval") {
      throw new Error("expected pause");
    }
    const decision = rt.approvals.applyDecision({
      approval_id: first.approval_id,
      choice: "always-approve-this-tool",
      decided_by: USER,
      run: first.run,
      // The production callback: the executor's withheld execution.
      execute: () => {
        expect(rt.executor.runWithheld(first.approval_id)).toBe(true);
      },
    });
    expect(decision.outcome).toBe("approved");
    if (decision.outcome !== "approved") {
      throw new Error("expected approval");
    }
    // The withheld execution wrote once, after the commit.
    expect(rt.notes.get("notes.md")).toContain("second line");

    // Second identical proposal: the grant skips the prompt entirely.
    const second = propose(rt, decision.run);
    expect(second.outcome).toBe("executed");
    expect(
      (rt.notes.get("notes.md") ?? "").split("\n").filter((l) => l === "second line"),
    ).toHaveLength(2);

    // Revoke the grant: the same proposal pauses again (fail-closed recheck).
    const grants = rt.approvalsRepo.listGrants(WS);
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      rt.approvalsRepo.revokeGrant(WS, grant.grant_id, NOW);
    }
    const third = propose(rt, second.run);
    expect(third.outcome).toBe("paused_for_approval");
    rt.conn.close();
  });

  it("a one-time grant executes exactly once and is consumed after the effect", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const first = propose(rt, run);
    if (first.outcome !== "paused_for_approval") {
      throw new Error("expected pause");
    }
    const decision = rt.approvals.applyDecision({
      approval_id: first.approval_id,
      choice: "approve-this-execution-only",
      decided_by: USER,
      run: first.run,
      execute: () => {
        expect(rt.executor.runWithheld(first.approval_id)).toBe(true);
      },
    });
    expect(decision.outcome).toBe("approved");
    if (decision.outcome !== "approved") {
      throw new Error("expected approval");
    }
    expect(decision.grant.one_time).toBe(true);
    expect(rt.notes.get("notes.md")).toContain("second line");
    // The consumed stamp: a SECOND execution through the same grant pauses.
    const second = propose(rt, decision.run);
    expect(second.outcome).toBe("paused_for_approval");
    rt.conn.close();
  });

  it("AC6 end to end: a disabled tool refuses even when a grant exists", () => {
    const rt = buildRuntime();
    const run = makeRun();
    const first = propose(rt, run);
    if (first.outcome !== "paused_for_approval") {
      throw new Error("expected pause");
    }
    rt.approvals.applyDecision({
      approval_id: first.approval_id,
      choice: "always-approve-this-tool",
      decided_by: USER,
      run: first.run,
      execute: () => {},
    });
    // Disable the tool; the grant remains active.
    rt.repo.insertDisablement(WS, "tool_note_append", "user_owner", NOW);
    const second = propose(rt, first.run);
    expect(second.outcome).toBe("blocked");
    if (second.outcome === "blocked") {
      expect(second.error_code).toBe("TOOL_DISABLED");
    }
    expect(rt.notes.get("notes.md")).toBeUndefined();
    rt.conn.close();
  });
});
