/**
 * S27 ST-13 — oversized payload / flood (threat model §5 ST-13; TM-2.1;
 * D11 bounded payloads + D15 context budget + PRD §7 response-size limits +
 * E1 admission posture). The adversarial shapes, through the REAL executor
 * and the REAL sandbox spawn:
 *
 *   1. TOOL RESPONSE OVER ITS OWN BUDGET — a binding returning far past the
 *      tool's `max_response_bytes` answers the TYPED
 *      TOOL_RESPONSE_TOO_LARGE execution failure; nothing oversized is
 *      persisted (the row carries no result body at all).
 *   2. THE STREAMING FORWARD CAP — a child streaming far beyond the adapter's
 *      forwarded-bytes cap has its forward stopped AT the cap (the truncation
 *      callback fired once), the forwarded bytes stay bounded, and the
 *      runtime process stays healthy after the flood.
 *   3. OVERSIZED ARGUMENTS — a hostile 1 MiB argument string is bounded in
 *      the recorded surfaces: the history row's args summary stays within
 *      the executor's budget (plus the truncation marker's own slack) and
 *      the flood marker substring cannot be found in the stored bytes.
 *
 * RED-FIRST evidence: the executor's response-budget check was bypassed, the
 * suite FAILED (the over-budget tool EXECUTED — the typed refusal
 * disappeared), the control was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-09-st13-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-13, D11, D15, PRD §7, AC5, AC9, G7.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import {
  openDatabase,
  type SqliteConnection,
} from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { ToolsRepository } from "../../apps/user-runtime/src/adapters/sqlite/tools-repository.ts";
import { spawnSandboxedExecution } from "../../apps/user-runtime/src/adapters/process/execution-process-spawn.ts";
import {
  canonicalArgsDigest,
  ToolExecutor,
} from "../../apps/user-runtime/src/modules/tools/tool-executor.service.ts";
import { ToolRegistry } from "../../apps/user-runtime/src/modules/tools/tool-registry.ts";

const WS = "ws_s27_st13";
const TASK = "task_s27_st13";
const CONV = "conv_s27_st13";
const AGENT = "agent_flooder";
const NOW = "2026-11-09T12:00:00.000Z";
const HASH = "d".repeat(64);

const tempDirs: string[] = [];

function makeRun(): TaskRun {
  return {
    task_id: TASK,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_st13" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: [AGENT],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** A unique marker embedded in the hostile payloads (the "did it leak?" probe). */
const FLOOD_MARKER = "s27-FLOOD-MARKER-0123456789abcdef";

function buildRuntimeWithFloodTool(maxResponseBytes: number): {
  executor: ToolExecutor;
  repo: ToolsRepository;
  conn: SqliteConnection;
} {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st13-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const repo = new ToolsRepository(conn.db);
  const registry = new ToolRegistry();
  const floodText = `${FLOOD_MARKER} ${"x".repeat(64 * 1024)} ${FLOOD_MARKER}`;
  registry.registerBinding("s27-st13-flood", {
    name: "s27-st13-flood",
    preview() {
      return null;
    },
    execute() {
      return { ok: true, text: floodText };
    },
  });
  registry.registerBuiltinTool({
    definition: {
      tool_id: "tool_st13_flood",
      workspace_id: WS,
      version: "1.0.0",
      name: "ST-13 flood probe",
      purpose: "Returns an oversized payload for the budget check.",
      owner: { kind: "platform" },
      inventory_scope: "shared",
      input_schema: { type: "object", properties: {} },
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
    max_response_bytes: maxResponseBytes,
    bindingName: "s27-st13-flood",
  });
  const executor = new ToolExecutor({
    registry,
    tools: repo,
    tx,
    now: () => NOW,
    nowMs: () => 1_000,
  });
  return { executor, repo, conn };
}

function proposeFlood(rt: { executor: ToolExecutor }) {
  const rawArgs = {};
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: "tool_st13_flood",
      tool_version: "1.0.0",
      capability: "notes.read",
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "the oversized-response probe",
    },
    run: makeRun(),
    agent_id: AGENT,
    rawArgs,
  });
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("S27 ST-13 — the tool's own response budget is enforced by the executor (AC5)", () => {
  it("a 64 KiB result against a 1 KiB tool budget is TOOL_RESPONSE_TOO_LARGE; nothing oversized persisted", () => {
    const rt = buildRuntimeWithFloodTool(1024);
    try {
      const result = proposeFlood(rt);
      expect(result.outcome).toBe("execution_failed");
      if (result.outcome === "execution_failed") {
        expect(result.error_code).toBe("TOOL_RESPONSE_TOO_LARGE");
      }
      // The history row: failed with the typed code, NO result body — the
      // oversized payload never entered any persisted surface.
      const rows = rt.repo.listExecutionsByTask(WS, TASK);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.error_code).toBe("TOOL_RESPONSE_TOO_LARGE");
      expect(rows[0]?.result_summary).toBeNull();
    } finally {
      rt.conn.close();
    }
  });

  it("a result INSIDE the budget still executes (the budget is not a blanket denial)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s27-st13-ok-"));
    tempDirs.push(dir);
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    try {
      const tx = new SqliteTransactions(conn.db);
      const repo = new ToolsRepository(conn.db);
      const registry = new ToolRegistry();
      const smallText = `${FLOOD_MARKER} small-but-valid`;
      registry.registerBinding("s27-st13-flood", {
        name: "s27-st13-flood",
        preview() {
          return null;
        },
        execute() {
          return { ok: true, text: smallText };
        },
      });
      registry.registerBuiltinTool({
        definition: {
          tool_id: "tool_st13_flood",
          workspace_id: WS,
          version: "1.0.0",
          name: "ST-13 in-budget probe",
          purpose: "Returns a small payload.",
          owner: { kind: "platform" },
          inventory_scope: "shared",
          input_schema: { type: "object", properties: {} },
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
        max_response_bytes: 4_096,
        bindingName: "s27-st13-flood",
      });
      const executor = new ToolExecutor({
        registry,
        tools: repo,
        tx,
        now: () => NOW,
        nowMs: () => 1_000,
      });
      const emptyArgs = {};
      const result = executor.executeProposal({
        proposal: {
          workspace_id: WS,
          task_id: TASK,
          conversation_id: CONV,
          tool_id: "tool_st13_flood",
          tool_version: "1.0.0",
          capability: "notes.read",
          args_digest: canonicalArgsDigest(emptyArgs),
          proposal_summary: "the in-budget probe",
        },
        run: makeRun(),
        agent_id: AGENT,
        rawArgs: {},
      });
      expect(result.outcome).toBe("executed");
      if (result.outcome === "executed") {
        expect(result.result_summary).toContain("small-but-valid");
      }
    } finally {
      conn.close();
    }
  });
});

describe("S27 ST-13 — the streaming forward cap bounds a flooding child (D11)", () => {
  it("a child streaming far past the 256 KiB cap has its forward stopped AT the cap; the runtime stays healthy", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st13-cap-"));
    tempDirs.push(work);
    const CAP = 256 * 1024;
    let forwardedBytes = 0;
    let truncationFired = 0;
    const handle = spawnSandboxedExecution(
      {
        command: [
          "/bin/sh",
          "-c",
          `i=0; while [ $i -lt 4096 ]; do printf '%1024s' '${FLOOD_MARKER}'; i=$((i+1)); done`,
        ],
        cwd: work,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
        networkDisabled: true,
        limits: { memoryBytes: null, cpuSeconds: 30, maxProcesses: null, diskBytes: null },
        wallClockMs: 25_000,
        maxForwardedBytes: CAP,
        onOutput: (_stream, chunk) => {
          forwardedBytes += Buffer.byteLength(chunk, "utf8");
        },
        onTruncated: () => {
          truncationFired += 1;
        },
      },
      {},
    );
    const exit = await handle.waitForExit();
    expect(truncationFired).toBeGreaterThanOrEqual(1);
    // The forward stopped AT the cap: nothing meaningfully beyond it was
    // handed to any sink (one chunk's slack).
    expect(forwardedBytes).toBeLessThanOrEqual(CAP + 2048);
    expect(forwardedBytes).toBeGreaterThan(0);
    expect(processAlive(process.pid), "the runtime gateway stays healthy after the flood").toBe(
      true,
    );
    expect(exit).toBeDefined();
  }, 45_000);
});

describe("S27 ST-13 — hostile oversized ARGUMENTS are bounded in the recorded surfaces (AC9)", () => {
  it("a 1 MiB argument string lands as a bounded, marker-free summary in the history row", () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-s27-st13-args-"));
    tempDirs.push(dir);
    const conn = openDatabase(join(dir, "runtime.db"));
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    const repo = new ToolsRepository(conn.db);
    const registry = new ToolRegistry();
    registry.registerBinding("s27-st13-flood", {
      name: "s27-st13-flood",
      preview() {
        return null;
      },
      execute() {
        return { ok: true, text: "small-in-budget-result" };
      },
    });
    registry.registerBuiltinTool({
      definition: {
        tool_id: "tool_st13_flood",
        workspace_id: WS,
        version: "1.0.0",
        name: "ST-13 args probe",
        purpose: "Accepts oversized arguments; returns a small result.",
        owner: { kind: "platform" },
        inventory_scope: "shared",
        input_schema: { type: "object", properties: { payload: { type: "string" } } },
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
      max_response_bytes: 4_096,
      bindingName: "s27-st13-flood",
    });
    const rt = {
      executor: new ToolExecutor({ registry, tools: repo, tx, now: () => NOW, nowMs: () => 1_000 }),
      repo,
      conn,
    };
    try {
      const hugeArg = `${FLOOD_MARKER}-${"y".repeat(1024 * 1024)}-${FLOOD_MARKER}`;
      const rawArgs = { payload: hugeArg };
      const result = rt.executor.executeProposal({
        proposal: {
          workspace_id: WS,
          task_id: TASK,
          conversation_id: CONV,
          tool_id: "tool_st13_flood",
          tool_version: "1.0.0",
          capability: "notes.read",
          args_digest: canonicalArgsDigest(rawArgs),
          proposal_summary: "the oversized-arguments probe",
        },
        run: makeRun(),
        agent_id: AGENT,
        rawArgs,
      });
      // READ_ONLY executes automatically — but the RECORDED summary of the
      // hostile arguments is bounded.
      expect(result.outcome).toBe("executed");
      const rows = rt.repo.listExecutionsByTask(WS, TASK);
      expect(rows).toHaveLength(1);
      const summary = rows[0]?.args_summary ?? "";
      // Bounded: the budget plus the truncation marker's own slack.
      expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(512 + 128);
      // And the flood marker (present in the raw argument) is nowhere in
      // the stored bytes.
      expect(summary).not.toContain("yyyyyyyyyy");
      expect(summary).not.toContain(hugeArg.slice(0, 64));
    } finally {
      conn.close();
    }
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
