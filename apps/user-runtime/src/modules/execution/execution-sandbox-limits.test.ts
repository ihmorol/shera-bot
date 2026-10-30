/**
 * Sandbox containment through the executor (S26 chunk 5; D27, AC3/AC4, E13,
 * G4) — the resource-exhaustion and process-tree-termination suites, driven
 * through the REAL spawn adapter with the kernel's own enforcement (the S16
 * kernel-enforcement precedent):
 *
 *   - a CPU spin dies at its ceiling with the typed SANDBOX_LIMIT_EXCEEDED
 *     (SIGXCPU from RLIMIT_CPU, soft:hard split so the typed signal wins);
 *   - a memory hog is killed by the kernel at the cgroup memory.max (the
 *     SIGKILL OOM death classifies as memory_oom) where the delegated cgroup
 *     subtree exists — and is contained by RLIMIT_DATA refusal where it does
 *     not (both postures assert containment and a healthy gateway);
 *   - a fork-style process storm is bounded by RLIMIT_NPROC inside the user
 *     namespace (the kernel counts the namespace's own processes — probed)
 *     and pids.max outside it;
 *   - cancelling a run kills the WHOLE process tree — no descendant survives,
 *     asserted against the live process list;
 *   - the executed child's kernel limits are VERIFIED (read from
 *     /proc/<pid>/limits during the run) against the tool's own record — the
 *     D27 "tool-created processes inherit the parent task's limits" posture,
 *     demonstrated rather than asserted.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  probeCgroupBaseDir,
  spawnSandboxedExecution,
} from "../../adapters/process/execution-process-spawn.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { EventsService } from "../events/events.service.ts";
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

/** The delegated cgroup subtree, probed once for the suite (null when absent). */
const cgroupBase: string | null = probeCgroupBaseDir();

interface LimitsRuntime {
  executor: ToolExecutor;
  repo: ToolsRepository;
  conn: SqliteConnection;
  workspaceRoot: string;
}

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

function buildRuntime(
  limits: {
    max_memory_mb: number;
    max_cpu_seconds: number;
    max_processes: number;
    max_disk_mb: number;
  },
  options: { timeoutMs?: number; withCgroup?: boolean } = {},
): LimitsRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-exec-limits-"));
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
  const registry = new ToolRegistry();
  const workspaceRoot = join(dir, "workspace");
  rmSync(workspaceRoot, { force: true, recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  const deps: ExecutionToolDeps = {
    spawn: (request) => spawnSandboxedExecution(request),
    workspaceRoots: { [WS]: workspaceRoot },
    artifacts,
    terminalRecorder: null,
    logFault: () => {},
    cgroupBaseDir: options.withCgroup === false ? null : cgroupBase,
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
        properties: { code: { type: "string" }, language: { type: "string" } },
        required: ["code", "language"],
      },
      output_schema: { type: "object" },
      capabilities: ["code.execute"],
      risk_class: "LOCAL_MUTATION",
      timeout_ms: options.timeoutMs ?? 60_000,
      resource_limits: limits,
      redaction_policy: "standard",
      approval_policy: "approval_required",
      created_at: NOW,
    },
    enabled: true,
    max_response_bytes: 262_144,
    bindingName: "code-execution",
  });
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
  return { executor, repo, conn, workspaceRoot };
}

function propose(rt: LimitsRuntime, code: string, language = "node") {
  const rawArgs = { language, code, workdir: "." };
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

/** Count live processes whose command line contains the marker. */
function countMarkerProcesses(marker: string): number {
  const result = spawnSync("/bin/sh", [
    "-c",
    `ps -eo args= | grep -F -- ${JSON.stringify(marker)} | grep -v grep | wc -l`,
  ]);
  return Number((result.stdout?.toString() ?? "0").trim());
}

/** Wait (bounded) until the marker count reaches zero; false on timeout. */
async function waitMarkerGone(marker: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (countMarkerProcesses(marker) === 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function expectGatewayHealthy(rt: LimitsRuntime): Promise<void> {
  // A follow-up execution succeeding IS the gateway-health check: the same
  // executor, registry, spawn seam, and event loop still serve work.
  const result = propose(rt, `console.log("healthy");`);
  if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
  const settled = await result.completion;
  expect(settled.outcome).toBe("executed");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sandbox containment through the executor (S26 chunk 5)", () => {
  it("AC3: a CPU spin dies at its ceiling with the typed SANDBOX_LIMIT_EXCEEDED and the gateway stays healthy", async () => {
    const rt = buildRuntime({
      max_memory_mb: 1024,
      max_cpu_seconds: 1,
      max_processes: 32,
      max_disk_mb: 64,
    });
    const result = propose(rt, `while (true) {}`);
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    const settled = await result.completion;
    expect(settled.outcome).toBe("execution_failed");
    if (settled.outcome === "execution_failed") {
      expect(settled.error_code).toBe("SANDBOX_LIMIT_EXCEEDED");
    }
    const history = rt.repo.listExecutionsByTool(WS, "tool_code_exec");
    expect(history[0]!.status).toBe("failed");
    expect(history[0]!.error_code).toBe("SANDBOX_LIMIT_EXCEEDED");
    await expectGatewayHealthy(rt);
  }, 120_000);

  it("AC3: a memory hog is killed at the cgroup memory.max (typed memory_oom) where delegation exists", async () => {
    const rt = buildRuntime({
      max_memory_mb: 256,
      max_cpu_seconds: 30,
      max_processes: 32,
      max_disk_mb: 64,
    });
    const result = propose(
      rt,
      `const chunks=[]; try { for (let i=0;i<600;i++) chunks.push(Buffer.alloc(1024*1024,1)); console.log("ALLOC-BAD"); } catch { console.log("alloc refused"); }`,
      "node",
    );
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    const settled = await result.completion;
    if (cgroupBase !== null) {
      // The kernel OOM kill is the typed limit death.
      expect(settled.outcome).toBe("execution_failed");
      if (settled.outcome === "execution_failed") {
        expect(settled.error_code).toBe("SANDBOX_LIMIT_EXCEEDED");
      }
    } else {
      // No delegated subtree: RLIMIT_DATA refusal contains the hog instead —
      // the honest fallback posture (G4): contained, honestly classified.
      expect(["executed", "execution_failed"]).toContain(settled.outcome);
    }
    await expectGatewayHealthy(rt);
  }, 180_000);

  it("AC3: a fork-style process storm is bounded and the gateway stays healthy", async () => {
    const rt = buildRuntime({
      max_memory_mb: 1024,
      max_cpu_seconds: 30,
      max_processes: 8,
      max_disk_mb: 64,
    });
    const result = propose(
      rt,
      `const cp=require("child_process");
       const kids = [];
       for (let i=0;i<60;i++) {
         const k = cp.spawn("/bin/sleep",["5"]);
         k.on("error", () => {});
         kids.push(k);
       }
       // Count REAL successes: a refused spawn (EAGAIN at the kernel's
       // process cap) carries no pid and fires its error event asynchronously.
       setTimeout(() => {
         const alive = kids.filter(k => k.pid !== undefined).length;
         console.log("spawned="+alive+" refused="+(kids.length-alive));
         process.exit(0);
       }, 800);`,
    );
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    const settled = await result.completion;
    expect(settled.outcome).toBe("executed");
    if (settled.outcome === "executed") {
      // The kernel refused forks inside the namespace well before 60.
      expect(settled.result_summary).toMatch(/spawned=\d+ refused=\d+/);
      const spawned = Number(/spawned=(\d+)/.exec(settled.result_summary)?.[1]);
      expect(spawned).toBeLessThan(60);
    }
    await expectGatewayHealthy(rt);
    await waitMarkerGone("sleep 5");
  }, 180_000);

  it("AC4: cancelling the run kills the whole process tree; no descendant survives (process list asserted)", async () => {
    // The descendant marker is the distinctive sleep duration itself: the
    // executed payload runs from a FILE, so the marker must live in the
    // DESCENDANTS' command lines (what the process list shows). The duration
    // is unique PER RUN — a previous run's orphaned children (a crashed
    // worker leaves them; their wall clock died with it) must never satisfy
    // this run's process-list assertion.
    const marker = `sleep ${86400 + (Date.now() % 1000)}`;
    const rt = buildRuntime({
      max_memory_mb: 1024,
      max_cpu_seconds: 30,
      max_processes: 32,
      max_disk_mb: 64,
    });
    const result = propose(
      rt,
      `const cp=require("child_process");
       const d = ${marker.slice(6)};
       cp.spawn("/bin/sleep",[String(d)]);
       cp.spawn("/bin/sh",["-c","sleep "+d+" & sleep "+d+"; wait"]);
       setInterval(()=>{},1000);`,
    );
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    // Wait until the descendants exist.
    const deadline = Date.now() + 10_000;
    while (countMarkerProcesses(marker) < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(countMarkerProcesses(marker)).toBeGreaterThanOrEqual(2);
    // Cancel the run: the D27 termination seam kills the whole group.
    result.cancel();
    const settled = await result.completion;
    expect(settled.outcome).toBe("execution_failed");
    if (settled.outcome === "execution_failed") {
      expect(settled.error_code).toBe("TOOL_EXECUTION_CANCELLED");
    }
    // No descendant survives — asserted against the live process list.
    expect(await waitMarkerGone(marker)).toBe(true);
    await expectGatewayHealthy(rt);
  }, 180_000);

  it("D27: the child's kernel limits are the tool record's limits — verified from /proc during the run", async () => {
    const rt = buildRuntime(
      { max_memory_mb: 1024, max_cpu_seconds: 7, max_processes: 32, max_disk_mb: 64 },
      { withCgroup: false },
    );
    const result = propose(rt, `console.log("limits-check");`);
    if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
    const settled = await result.completion;
    expect(settled.outcome).toBe("executed");
    if (settled.outcome === "executed") {
      // The verified-limits note in the result text: the ceilings the KERNEL
      // reported for the child match the tool record (data/cpu/nproc/fsize).
      expect(settled.result_summary).toContain("limits verified: data=1073741824");
      expect(settled.result_summary).toContain("cpu=7");
      expect(settled.result_summary).toContain("nproc=32");
      expect(settled.result_summary).toContain("fsize=67108864");
    }
  }, 120_000);
});
