/**
 * Tool executor core (S21 chunk 2; PRD §7, D35, D38, E13, G2/G3/G6).
 * Red-first: these tests pin the chunk-2 behaviors before the module exists.
 *
 *   1. The D35 ladder is DATA: every D9 risk class maps to an execution
 *      posture (READ_ONLY automatic; everything else gated) and a preview
 *      kind — never prose inference (G2). Capability prefixes refine the
 *      preview kind (code.* → command; repo.* → repo change).
 *   2. The executor is the ONE execution path: bindings refuse to run without
 *      the executor-minted execution authority (AC1 — a direct binding call
 *      from agent-facing code is structurally impossible).
 *   3. Validation: an unknown tool, a disabled tool, args outside the tool's
 *      input schema, and a digest mismatch are typed refusals recorded as
 *      blocked history rows — never prose errors.
 *   4. Per-tool limits (AC5): a tool whose execution overshoots its
 *      timeout_ms fails with TOOL_EXECUTION_TIMEOUT; a result over the tool's
 *      max_response_bytes fails with TOOL_RESPONSE_TOO_LARGE — both enforced
 *      through the tool's OWN record fields, not global guesses.
 *   5. E13 recovery class (AC4): a tool with no declared class carries the
 *      stored default needs_human; the executor exposes it and never invents
 *      another.
 *   6. Successful executions record a history row whose result text is
 *      redacted and bounded BEFORE any write (G3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { RISK_CLASSES } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { RISK_CLASS_LADDER, resolvePreviewKind } from "./risk-ladder.ts";
import {
  canonicalArgsDigest,
  ToolExecutor,
  type ToolExecutorDeps,
} from "./tool-executor.service.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { assertExecutionAuthority, makeNoteBindings, type ToolBinding } from "./tool-binding.ts";

const WS = "ws_default_01";
const TASK = "task_01";
const CONV = "conv_01";
const AGENT = "agent_researcher";
const NOW_ISO = "2026-10-29T12:00:00.000Z";

const tempDirs: string[] = [];

/** A controllable millisecond clock: each read advances by stepMs. */
function makeFakeClock(stepMs = 1_000, startMs = 1_000) {
  let current = startMs;
  return {
    nowMs: () => {
      const value = current;
      current += stepMs;
      return value;
    },
    peek: () => current,
  };
}

interface TestRuntime {
  executor: ToolExecutor;
  registry: ToolRegistry;
  repo: ToolsRepository;
  conn: SqliteConnection;
  clock: ReturnType<typeof makeFakeClock>;
  notes: Map<string, string>;
}

function buildRuntime(overrides: Partial<ToolExecutorDeps> = {}): TestRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-tool-executor-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const repo = new ToolsRepository(conn.db);
  const registry = new ToolRegistry();
  const clock = makeFakeClock();
  const tx = new SqliteTransactions(conn.db);
  const bindings = makeNoteBindings();
  registry.registerBinding("notes-read", bindings.read);
  registry.registerBinding("notes-append", bindings.append);
  const executor = new ToolExecutor({
    registry,
    tools: repo,
    tx,
    nowMs: clock.nowMs,
    now: () => NOW_ISO,
    ...overrides,
  });
  return { executor, registry, repo, conn, clock, notes: bindings.notes };
}

interface FixtureTool {
  tool_id: string;
  version: string;
  name: string;
  purpose: string;
  capabilities: string[];
  risk_class: "READ_ONLY" | "LOCAL_MUTATION";
  timeout_ms: number;
  max_response_bytes: number;
  bindingName: string;
}

function readTool(overrides: Partial<FixtureTool> = {}): FixtureTool {
  return {
    tool_id: "tool_note_read",
    version: "1.0.0",
    name: "Read a note",
    purpose: "Read a workspace note's content.",
    capabilities: ["notes.read"],
    risk_class: "READ_ONLY",
    timeout_ms: 60_000,
    max_response_bytes: 4_096,
    bindingName: "notes-read",
    ...overrides,
  };
}

function registerTool(runtime: TestRuntime, tool: FixtureTool): void {
  runtime.registry.registerBuiltinTool({
    definition: {
      tool_id: tool.tool_id,
      workspace_id: WS,
      version: tool.version,
      name: tool.name,
      purpose: tool.purpose,
      owner: { kind: "platform" },
      inventory_scope: "shared",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, steps: { type: "integer" } },
        required: ["path"],
      },
      output_schema: { type: "object" },
      capabilities: tool.capabilities,
      risk_class: tool.risk_class,
      timeout_ms: tool.timeout_ms,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      redaction_policy: "standard",
      approval_policy: tool.risk_class === "READ_ONLY" ? "auto_read_only" : "approval_required",
      created_at: NOW_ISO,
    },
    enabled: true,
    max_response_bytes: tool.max_response_bytes,
    bindingName: tool.bindingName,
  });
}

const RUN = {
  task_id: TASK,
  workspace_id: WS,
  conversation_id: CONV,
  state: "RUNNING",
  version: 3,
} as unknown as Parameters<ToolExecutor["executeProposal"]>[0]["run"];

function proposalInput(
  overrides: {
    rawArgs?: Record<string, unknown>;
    proposalOverrides?: Record<string, unknown>;
    toolOverrides?: Partial<Record<string, unknown>>;
  } = {},
) {
  const rawArgs = overrides.rawArgs ?? { path: "notes.md" };
  return {
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: "tool_note_read",
      tool_version: "1.0.0",
      capability: "notes.read",
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "read the notes file",
      ...overrides.proposalOverrides,
    },
    run: RUN,
    agent_id: AGENT,
    rawArgs,
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("risk-class ladder as data (S21 chunk 2)", () => {
  it("covers every D9 risk class with an execution posture and preview kind", () => {
    for (const riskClass of RISK_CLASSES) {
      expect(RISK_CLASS_LADDER[riskClass]).toBeDefined();
    }
    expect(RISK_CLASS_LADDER.READ_ONLY.execution).toBe("automatic");
    for (const riskClass of RISK_CLASSES) {
      if (riskClass !== "READ_ONLY") {
        expect(RISK_CLASS_LADDER[riskClass].execution).toBe("gated");
      }
    }
  });

  it("refines the preview kind from capability prefixes — the code and repo ladder rows", () => {
    expect(resolvePreviewKind("LOCAL_MUTATION", ["code.exec.sandbox"])).toBe("command");
    expect(resolvePreviewKind("LOCAL_MUTATION", ["repo.push"])).toBe("repo");
    expect(resolvePreviewKind("LOCAL_MUTATION", ["file.write"])).toBe("diff");
    expect(resolvePreviewKind("EXTERNAL_WRITE", ["http.post"])).toBe("target_effect");
    expect(resolvePreviewKind("READ_ONLY", ["notes.read"])).toBe("none");
  });
});

describe("no-bypass execution authority (S21 chunk 2, AC1)", () => {
  it("refuses a binding invoked without the executor-minted authority", () => {
    const rt = buildRuntime();
    const bindings = makeNoteBindings();
    expect(() =>
      bindings.read.execute(
        { path: "notes.md" },
        {
          authority: undefined as never,
          deadline: 61_000,
          nowMs: rt.clock.nowMs,
          maxResponseBytes: 4_096,
          resourceLimits: {
            max_memory_mb: 256,
            max_cpu_seconds: 30,
            max_processes: 4,
            max_disk_mb: 64,
          },
          signal: new AbortController().signal,
        },
      ),
    ).toThrow(/EXECUTION_AUTHORITY/);
    rt.conn.close();
  });

  it("accepts a binding invoked WITH the executor-minted authority", () => {
    const rt = buildRuntime();
    const bindings = makeNoteBindings();
    const result = bindings.read.execute(
      { path: "notes.md" },
      {
        authority: rt.executor.mintExecutionAuthority(),
        deadline: 61_000,
        nowMs: rt.clock.nowMs,
        maxResponseBytes: 4_096,
        resourceLimits: {
          max_memory_mb: 256,
          max_cpu_seconds: 30,
          max_processes: 4,
          max_disk_mb: 64,
        },
        signal: new AbortController().signal,
      },
    );
    expect(result.ok).toBe(true);
    rt.conn.close();
  });

  it("refuses forged authority tokens at the assert boundary", () => {
    const rt = buildRuntime();
    expect(() => assertExecutionAuthority(undefined)).toThrow(/EXECUTION_AUTHORITY/);
    expect(() => assertExecutionAuthority({ spoofed: true } as never)).toThrow(
      /EXECUTION_AUTHORITY/,
    );
    expect(() => assertExecutionAuthority(rt.executor.mintExecutionAuthority())).not.toThrow();
    rt.conn.close();
  });
});

describe("executor validation (S21 chunk 2)", () => {
  it("refuses an unregistered tool with a typed error and NO history row (no honest class to store)", () => {
    const rt = buildRuntime();
    const result = rt.executor.executeProposal(
      proposalInput({ proposalOverrides: { tool_id: "tool_missing" } }),
    );
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.error_code).toBe("TOOL_NOT_REGISTERED");
    }
    // G2: an unknown tool is a PROPOSAL rejection (the run's typed-rejection
    // path carries it) — writing a history row would require inventing a risk
    // class the runtime does not know, and classification is data, never
    // prose (the history table records executions of KNOWN tools only).
    expect(rt.repo.listExecutionsByTool(WS, "tool_missing")).toEqual([]);
    rt.conn.close();
  });

  it("blocks a disabled tool BEFORE any grant consult (AC6)", () => {
    const rt = buildRuntime();
    registerTool(rt, readTool());
    rt.repo.insertDisablement(WS, "tool_note_read", "user_owner", NOW_ISO);
    const result = rt.executor.executeProposal(proposalInput());
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.error_code).toBe("TOOL_DISABLED");
    }
    rt.conn.close();
  });

  it("refuses args outside the tool's input schema (typed, recorded)", () => {
    const rt = buildRuntime();
    registerTool(rt, readTool());
    const result = rt.executor.executeProposal(proposalInput({ rawArgs: { wrong: "shape" } }));
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.error_code).toBe("TOOL_ARGS_INVALID");
    }
    rt.conn.close();
  });

  it("refuses when the executed args do not match the journalled digest (G3 tie)", () => {
    const rt = buildRuntime();
    registerTool(rt, readTool());
    const result = rt.executor.executeProposal(
      proposalInput({
        proposalOverrides: { args_digest: canonicalArgsDigest({ path: "other.md" }) },
      }),
    );
    expect(result.outcome).toBe("blocked");
    if (result.outcome === "blocked") {
      expect(result.error_code).toBe("TOOL_ARGS_DIGEST_MISMATCH");
    }
    rt.conn.close();
  });
});

describe("per-tool limits (S21 chunk 2, AC5)", () => {
  it("fails a tool that overshoots its own timeout_ms with TOOL_EXECUTION_TIMEOUT", () => {
    const rt = buildRuntime();
    registerTool(rt, readTool({ timeout_ms: 2_500 }));
    // The fake clock advances 1000ms per read; 4 steps read past a 2500ms deadline.
    const rawArgs = { path: "notes.md", steps: 4 };
    const result = rt.executor.executeProposal(
      proposalInput({ rawArgs, proposalOverrides: { args_digest: canonicalArgsDigest(rawArgs) } }),
    );
    expect(result.outcome).toBe("execution_failed");
    if (result.outcome === "execution_failed") {
      expect(result.error_code).toBe("TOOL_EXECUTION_TIMEOUT");
    }
    const row = rt.repo.listExecutionsByTool(WS, "tool_note_read");
    expect(row[0]?.status).toBe("failed");
    expect(row[0]?.error_code).toBe("TOOL_EXECUTION_TIMEOUT");
    rt.conn.close();
  });

  it("fails a result over the tool's max_response_bytes with TOOL_RESPONSE_TOO_LARGE", () => {
    const rt = buildRuntime();
    registerTool(rt, readTool({ max_response_bytes: 128 }));
    const rawArgs = { path: "notes.md", payload: "x".repeat(1_000) };
    const result = rt.executor.executeProposal(
      proposalInput({ rawArgs, proposalOverrides: { args_digest: canonicalArgsDigest(rawArgs) } }),
    );
    expect(result.outcome).toBe("execution_failed");
    if (result.outcome === "execution_failed") {
      expect(result.error_code).toBe("TOOL_RESPONSE_TOO_LARGE");
    }
    const row = rt.repo.listExecutionsByTool(WS, "tool_note_read");
    expect(row[0]?.status).toBe("failed");
    // The oversized payload is NOT stored.
    expect(row[0]?.result_summary).toBeNull();
    rt.conn.close();
  });
});

describe("READ_ONLY auto-execution and records (S21 chunk 2)", () => {
  it("executes a READ_ONLY tool with no prompt and records a redacted history row", () => {
    const rt = buildRuntime();
    rt.notes.set("notes.md", "hello world");
    registerTool(rt, readTool());
    const rawArgs = { path: "notes.md", api_key: "supersecret-value-123" };
    const result = rt.executor.executeProposal(
      proposalInput({ rawArgs, proposalOverrides: { args_digest: canonicalArgsDigest(rawArgs) } }),
    );
    expect(result.outcome).toBe("executed");
    if (result.outcome === "executed") {
      expect(result.result_summary).toContain("hello world");
    }
    const rows = rt.repo.listExecutionsByTool(WS, "tool_note_read");
    expect(rows[0]?.status).toBe("succeeded");
    expect(rows[0]?.risk_class).toBe("READ_ONLY");
    // AC4: no recovery class declared anywhere -> the stored default needs_human.
    expect(rows[0]?.recovery).toBe("needs_human");
    // G3: the recorded summary carries no secret-shaped value.
    expect(rows[0]?.args_summary).not.toContain("supersecret-value-123");
    expect(rows[0]?.result_summary).not.toContain("supersecret-value-123");
    rt.conn.close();
  });

  it("exposes the E13 recovery class a tool declares, defaulting to needs_human", () => {
    const rt = buildRuntime();
    registerTool(rt, readTool());
    const record = rt.registry.resolve(WS, "tool_note_read", "1.0.0");
    expect(record?.definition.recovery).toBe("needs_human");
    rt.conn.close();
  });
});

export type { ToolBinding };

describe("the adapter seam is proposal-only (S21 chunk 2, AC1)", () => {
  it("the sink handed to adapters exposes propose and nothing else", async () => {
    const rt = buildRuntime();
    let sinkKeys: string[] = [];
    const probeAdapter = {
      harness: "fake" as const,
      driveRun(_request: unknown, sink: { propose: unknown }) {
        sinkKeys = Object.keys(sink);
        sink.propose({
          kind: "task_command",
          command: {
            type: "complete_task",
            command_id: "cmd_x",
            idempotency_key: "idem_x",
            expected_version: 2,
            workspace_id: WS,
            task_id: TASK,
            actor: { type: "runtime", id: "harness:fake" },
            issued_at: NOW_ISO,
          },
        });
      },
    };
    const { HarnessRunService } = await import("../runtime/harness-run-service.ts");
    const service = new HarnessRunService({
      adapter: probeAdapter as never,
      tx: { transaction: (fn: (exec: unknown) => unknown) => fn({}) } as never,
      journal: { nextSequence: () => 1, findById: () => null } as never,
      events: { appendEvent: () => ({}) as never } as never,
      pinned_pack: { pack_id: "p", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
      workspace_id: WS,
      policy: { max_retries: 3 },
    });
    service.startRun({
      event_id: "evt_probe_trigger",
      stream_id: `conversation:${CONV}`,
      sequence: 1,
      event_version: 1,
      actor: { type: "system", id: "scheduler" },
      task_id: TASK,
      conversation_id: CONV,
      occurred_at: NOW_ISO,
      redaction_class: "internal",
      event_type: "trigger.scheduled",
      payload: { schedule_id: "sch_probe", due_at: NOW_ISO },
    });
    // AC1: the ONLY thing an adapter can do with the sink is PROPOSE — the
    // execution authority lives behind the executor, unreachable from here.
    expect(sinkKeys).toEqual(["propose"]);
    rt.conn.close();
  });
});
