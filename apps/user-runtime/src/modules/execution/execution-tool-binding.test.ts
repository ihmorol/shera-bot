/**
 * Execution tool bindings through the runtime executor (S26 chunk 3; PRD §7,
 * D27, D35, D23 rule 2, AC2/AC5/AC7, G2/G3/G6). Red-first: the tests pin the
 * behaviors before the module exists.
 *
 *   1. Code execution and terminal execution are TOOLS: they ride the S21
 *      executor — the ONE execution path — and no sync shortcut exists (the
 *      process-backed bindings refuse a direct sync execute even with a
 *      genuine authority token).
 *   2. The executor dispatches process-backed bindings ASYNC (the E33-recorded
 *      arrival): the proposal answers `dispatched` with a completion that
 *      settles the history row to its terminal state with exit code and
 *      duration recorded.
 *   3. The D27 sandbox policy applies at execution time: traversal, absolute
 *      host paths, and planted-symlink escapes are typed SANDBOX_PATH_ESCAPE
 *      failures recorded as failed history rows — nothing spawns.
 *   4. The child environment is the fixed allowlist (AC5): a secret-shaped
 *      variable planted in the RUNTIME's environment never reaches the
 *      executed code or the history row.
 *   5. Gated approval (D35/AC7): a LOCAL_MUTATION code execution pauses
 *      through the S20 machinery and NOTHING dispatches before the decision —
 *      the sentinel file the child would create does not exist until
 *      runWithheld fires post-decision.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { ApprovalChoice, TaskRun } from "@shera-bot/contracts";

import { spawnSandboxedExecution } from "../../adapters/process/execution-process-spawn.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { EventsService } from "../events/events.service.ts";
import {
  canonicalArgsDigest,
  ToolExecutor,
  type ToolExecutorDeps,
} from "../tools/tool-executor.service.ts";
import { ToolRegistry } from "../tools/tool-registry.ts";
import { makeExecutionAuthority, ToolBindingError } from "../tools/tool-binding.ts";
import {
  makeCodeExecutionBinding,
  makeTerminalExecutionBinding,
  type ExecutionToolDeps,
} from "./execution-tool-binding.ts";

const WS = "ws_default_01";
const TASK = "task_001";
const CONV = "conv_001";
const AGENT = "agent_researcher";
const USER = { type: "user" as const, id: "user_owner" };
const NOW = "2026-10-31T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

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

interface ExecutionRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  repo: ToolsRepository;
  approvals: ApprovalsService;
  conn: SqliteConnection;
  workspaceRoot: string;
  deps: ExecutionToolDeps;
}

/**
 * Build one execution runtime: a real SQLite stack, the real approvals
 * machinery, and the REAL spawn adapter pointed at a temp workspace scope.
 * By default a reusable task-principal grant ("always approve this tool")
 * is seeded for both execution tools, so the dispatch tests ride the AC26
 * grant fast-path exactly as a granted production execution would; the
 * gating test passes `seedGrants: false` to exercise the pause.
 */
function buildRuntime(options: { seedGrants?: boolean } = {}): ExecutionRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-exec-tools-"));
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
  const workspaceRoot = join(dir, "workspace");
  rmSync(workspaceRoot, { force: true, recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const deps: ExecutionToolDeps = {
    spawn: (request) => spawnSandboxedExecution(request),
    workspaceRoots: { [WS]: workspaceRoot },
    artifacts: null,
    terminalRecorder: null,
    logFault: () => {},
  };
  const codeBinding = makeCodeExecutionBinding(deps);
  const terminalBinding = makeTerminalExecutionBinding(deps);
  registry.registerBinding("code-execution", codeBinding);
  registry.registerBinding("terminal-execution", terminalBinding);
  const common = {
    workspace_id: WS,
    version: "1.0.0",
    owner: { kind: "platform" } as const,
    inventory_scope: "shared" as const,
    output_schema: { type: "object" },
    resource_limits: {
      max_memory_mb: 1024,
      max_cpu_seconds: 30,
      max_processes: 32,
      max_disk_mb: 64,
    },
    redaction_policy: "standard" as const,
    created_at: NOW,
  };
  registry.registerBuiltinTool({
    definition: {
      ...common,
      tool_id: "tool_code_exec",
      name: "Sandboxed code execution",
      purpose: "Run a code payload inside the D27 sandbox (network disabled, limited).",
      input_schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          language: { type: "string" },
          workdir: { type: "string" },
        },
        required: ["code", "language"],
      },
      capabilities: ["code.execute"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 60_000,
      approval_policy: "approval_required",
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "code-execution",
  });
  registry.registerBuiltinTool({
    definition: {
      ...common,
      tool_id: "tool_terminal_exec",
      name: "Sandboxed terminal execution",
      purpose: "Run one shell command inside the D27 sandbox (network disabled, limited).",
      input_schema: {
        type: "object",
        properties: { command: { type: "string" }, workdir: { type: "string" } },
        required: ["command"],
      },
      capabilities: ["terminal.execute"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: 60_000,
      approval_policy: "approval_required",
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "terminal-execution",
  });
  const executor = new ToolExecutor({
    registry,
    tools: repo,
    tx,
    approvals,
    nowMs: () => Date.now(),
    now: () => NOW,
  } satisfies ToolExecutorDeps);
  if (options.seedGrants !== false) {
    // Seed the reusable task-principal grants the dispatch tests ride (the
    // AC26 fast-path: a grant skips the prompt, never the policy check).
    const approvalsRepo2 = new ApprovalsRepository(tx);
    approvalsRepo2.insertGrant({
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
    approvalsRepo2.insertGrant({
      grant_id: "grant_terminal_exec",
      workspace_id: WS,
      source_choice: "always-approve-this-tool",
      principal_type: "task",
      principal_id: TASK,
      tool_id: "tool_terminal_exec",
      tool_version: "1.0.0",
      capability: "terminal.execute",
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
  }
  return { executor, registry, repo, approvals, conn, workspaceRoot, deps };
}

type ProposalOverrides = {
  tool_id: string;
  rawArgs: Record<string, unknown>;
  capability: string;
};

function propose(rt: ExecutionRuntime, overrides: ProposalOverrides) {
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: overrides.tool_id,
      tool_version: "1.0.0",
      capability: overrides.capability,
      args_digest: canonicalArgsDigest(overrides.rawArgs),
      proposal_summary: "sandboxed execution proposal",
    },
    run: makeRun(),
    agent_id: AGENT,
    rawArgs: overrides.rawArgs,
    resource_scope: `workspace:${WS}`,
  });
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("execution tools dispatch through the executor (S26 chunk 3)", () => {
  it("a code-execution proposal dispatches async and settles with exit code and duration", async () => {
    const rt = buildRuntime();
    const rawArgs = {
      language: "node",
      code: `require("node:fs").writeFileSync("side-effect.txt", "ran"); console.log("hello-s26");`,
      workdir: ".",
    };
    const result = propose(rt, { tool_id: "tool_code_exec", rawArgs, capability: "code.execute" });
    // The process-backed family answers DISPATCHED (the effect is running);
    // the completion settles the history row.
    if (result.outcome !== "dispatched") {
      throw new Error(`expected dispatched, got ${result.outcome}`);
    }
    expect(typeof result.cancel).toBe("function");
    const settled = await result.completion;
    expect(settled.outcome).toBe("executed");
    if (settled.outcome === "executed") {
      expect(settled.result_summary).toContain("exit=0");
      expect(settled.result_summary).toContain("hello-s26");
    }
    // The REAL side effect exists inside the workspace scope.
    expect(existsSync(join(rt.workspaceRoot, "side-effect.txt"))).toBe(true);
    // The history row is terminal, honest, and carries the runtime facts.
    const history = rt.repo.listExecutionsByTool(WS, "tool_code_exec");
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("succeeded");
    expect(history[0]!.result_summary).toContain("exit=0");
    expect(history[0]!.result_summary).toMatch(/duration_ms=\d+/);
    expect(history[0]!.finished_at).not.toBeNull();
  });

  it("a terminal-execution proposal runs one shell command in the resolved workdir", async () => {
    const rt = buildRuntime();
    const rawArgs = { command: `echo hello-terminal > terminal-out.txt; cat terminal-out.txt` };
    const result = propose(rt, {
      tool_id: "tool_terminal_exec",
      rawArgs,
      capability: "terminal.execute",
    });
    if (result.outcome !== "dispatched") {
      throw new Error(`expected dispatched, got ${result.outcome}`);
    }
    const settled = await result.completion;
    expect(settled.outcome).toBe("executed");
    if (settled.outcome === "executed") {
      expect(settled.result_summary).toContain("hello-terminal");
    }
    expect(readFileSync(join(rt.workspaceRoot, "terminal-out.txt"), "utf8").trim()).toBe(
      "hello-terminal",
    );
    const history = rt.repo.listExecutionsByTool(WS, "tool_terminal_exec");
    expect(history[0]!.status).toBe("succeeded");
  });

  it("a non-zero exit is a recorded, succeeded tool execution with the honest exit code", async () => {
    const rt = buildRuntime();
    const rawArgs = { language: "shell", code: `exit 7` };
    const result = propose(rt, { tool_id: "tool_code_exec", rawArgs, capability: "code.execute" });
    if (result.outcome !== "dispatched") {
      throw new Error(`expected dispatched, got ${result.outcome}`);
    }
    const settled = await result.completion;
    // The command RAN and exited 7 — the tool executed; the exit code is data.
    expect(settled.outcome).toBe("executed");
    if (settled.outcome === "executed") {
      expect(settled.result_summary).toContain("exit=7");
    }
  });

  it("sandbox escapes are typed failures recorded as failed rows, and nothing spawns", async () => {
    const rt = buildRuntime();
    writeFileSync(join(rt.workspaceRoot, "..", "outside-sentinel"), "host");
    const escapes = [{ workdir: "../outside" }, { workdir: "/etc" }];
    for (const rawArgs of escapes.map((e) => ({ language: "shell", code: `true`, ...e }))) {
      const result = propose(rt, {
        tool_id: "tool_code_exec",
        rawArgs,
        capability: "code.execute",
      });
      if (result.outcome !== "dispatched") {
        throw new Error(`expected dispatched, got ${result.outcome}`);
      }
      const settled = await result.completion;
      expect(settled.outcome).toBe("execution_failed");
      if (settled.outcome === "execution_failed") {
        expect(settled.error_code).toBe("SANDBOX_PATH_ESCAPE");
      }
    }
    const history = rt.repo.listExecutionsByTool(WS, "tool_code_exec");
    expect(history.filter((row) => row.status === "failed")).toHaveLength(2);
  });

  it("a planted symlink escape is refused at execution time (AC2)", async () => {
    const rt = buildRuntime();
    const outside = join(rt.workspaceRoot, "..", "s26-outside-dir");
    rmSync(outside, { recursive: true, force: true });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outside);
    symlinkSync(outside, join(rt.workspaceRoot, "escape-link"));
    const rawArgs = { language: "shell", code: `true`, workdir: "escape-link" };
    const result = propose(rt, { tool_id: "tool_code_exec", rawArgs, capability: "code.execute" });
    if (result.outcome !== "dispatched") {
      throw new Error(`expected dispatched, got ${result.outcome}`);
    }
    const settled = await result.completion;
    expect(settled.outcome).toBe("execution_failed");
    if (settled.outcome === "execution_failed") {
      expect(settled.error_code).toBe("SANDBOX_PATH_ESCAPE");
    }
    rmSync(outside, { recursive: true, force: true });
  });

  it("the runtime's environment never reaches executed code or the history (AC5)", async () => {
    const planted = "sk-s26-e2e-planted-secret-0123456789";
    process.env.SHERA_S26_EXEC_PLANTED_SECRET = planted;
    try {
      const rt = buildRuntime();
      const rawArgs = {
        language: "node",
        code: `console.log("env-keys:", Object.keys(process.env).join(","));`,
      };
      const result = propose(rt, {
        tool_id: "tool_code_exec",
        rawArgs,
        capability: "code.execute",
      });
      if (result.outcome !== "dispatched") {
        throw new Error(`expected dispatched, got ${result.outcome}`);
      }
      const settled = await result.completion;
      expect(settled.outcome).toBe("executed");
      if (settled.outcome === "executed") {
        expect(settled.result_summary).not.toContain("SHERA_S26_EXEC_PLANTED_SECRET");
      }
      const history = rt.repo.listExecutionsByTool(WS, "tool_code_exec");
      expect(history[0]!.result_summary).not.toContain(planted);
      expect(history[0]!.result_summary).toContain("env-keys:");
    } finally {
      delete process.env.SHERA_S26_EXEC_PLANTED_SECRET;
    }
  });

  it("AC7: a gated code execution dispatches NOTHING before the approval decision", async () => {
    const rt = buildRuntime({ seedGrants: false });
    const sentinel = join(rt.workspaceRoot, "post-decision-sentinel.txt");
    const rawArgs = {
      language: "node",
      code: `require("node:fs").writeFileSync("post-decision-sentinel.txt", "after");`,
    };
    const result = propose(rt, { tool_id: "tool_code_exec", rawArgs, capability: "code.execute" });
    // Paused through the S20 machinery; the effect does not exist.
    expect(result.outcome).toBe("paused_for_approval");
    expect(existsSync(sentinel)).toBe(false);
    if (result.outcome !== "paused_for_approval") throw new Error("unreachable");
    const approvalId = result.approval_id;
    const runNow = rt.repo.listExecutionsByTool(WS, "tool_code_exec")[0]!;
    expect(runNow.status).toBe("awaiting_approval");

    // The user approves; the decision commits, and the composition's
    // decideExecute hook fires runWithheld — the real execution starts only
    // here (AC3's decision side), and the completion settles the row.
    const run = makeRun();
    rt.approvals.applyDecision({
      approval_id: approvalId,
      choice: "approve-this-execution-only" satisfies ApprovalChoice,
      decided_by: USER,
      run,
      execute: () => {},
    });
    const withheld = rt.executor.runWithheld(approvalId);
    expect(withheld).not.toBe(false);
    if (!(withheld instanceof Promise)) throw new Error("expected the dispatched completion");
    const settled = await withheld;
    expect(settled.outcome).toBe("executed");
    expect(existsSync(sentinel)).toBe(true);
    const history = rt.repo.listExecutionsByTool(WS, "tool_code_exec");
    expect(history[0]!.status).toBe("succeeded");
    expect(history[0]!.approval_id).toBe(approvalId);
  });

  it("the process-backed bindings refuse a direct sync execute even with genuine authority (AC1)", () => {
    const rt = buildRuntime({ seedGrants: false });
    const code = makeCodeExecutionBinding(rt.deps);
    const authority = makeExecutionAuthority();
    expect(() =>
      code.execute(
        { language: "shell", code: "true" },
        {
          authority,
          deadline: Number.MAX_SAFE_INTEGER,
          nowMs: () => Date.now(),
          maxResponseBytes: 1024,
          resourceLimits: {
            max_memory_mb: 1024,
            max_cpu_seconds: 30,
            max_processes: 32,
            max_disk_mb: 64,
          },
          signal: new AbortController().signal,
          execution: {
            execution_id: "exe_test",
            workspace_id: WS,
            task_id: TASK,
            conversation_id: CONV,
            agent_id: AGENT,
            capability: "code.execute",
            approval_id: null,
            grant_id: null,
          },
        },
      ),
    ).toThrow(ToolBindingError);
  });
});
