/**
 * S27 ST-08 — agent-created tool privilege escalation (threat model §5 ST-08;
 * TM-4.4; PRD §7/E4 + D38 + D35, G6). The adversarial shapes, driven through
 * the REAL S21 stack (inventory → registry → executor → approvals):
 *
 *   1. CAPABILITY ESCALATION AT CREATION — a tool declaring
 *      `credential.access` (the platform does not implement it) or
 *      `repo.push` (the platform implements it but the pinned pack's
 *      allow-list does not carry it) is refused at the D38 intersection with
 *      the REFUSING LAYER named — nothing an Agent creates can widen
 *      platform or pack limits; preview AND create re-derive the verdict;
 *      a refused creation registers NOTHING in the registry.
 *   2. SELF-GRANTING ACTIVATION — the creating Agent (and any Agent actor)
 *      cannot record the activation grant, even for its own tool (G6:
 *      prompts cannot grant capabilities); only a user decision can.
 *   3. EXECUTION WITHOUT ACTIVATION — a risky (LOCAL_MUTATION) tool created
 *      but never activated refuses every execution (TOOL_NOT_ACTIVATED);
 *      disabling beats any grant (TOOL_DISABLED); the notes sentinel proves
 *      NO effect ever happened on any refused leg.
 *   4. PRIVATE-SCOPE EXFILTRATION — another Agent running the creator's
 *      private tool is refused (TOOL_NOT_SHARED) even after a workspace
 *      activation would exist for the owner.
 *   5. NO EXECUTOR BYPASS — the created tool's binding is a RUNTIME binding
 *      resolved by name (a creation form never supplies executable content,
 *      D28), and that binding refuses a direct sync execute even with
 *      genuine authority (AC1) — the effect cannot leave the executor path.
 *
 * RED-FIRST evidence: the D38 intersection check was disabled (hostile
 * creations accepted) AND the executor's agent-created lifecycle gate was
 * disabled (unactivated tools executing), the suite FAILED, both controls
 * were restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st08-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-08, PRD §7, E4, D38, D35, D28, G6.
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
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { ApprovalsRepository } from "../../apps/user-runtime/src/adapters/sqlite/approvals-repository.ts";
import { OperationsRepository } from "../../apps/user-runtime/src/adapters/sqlite/operations-repository.ts";
import { ApprovalsService } from "../../apps/user-runtime/src/modules/approvals/approvals.service.ts";
import { ToolsRepository } from "../../apps/user-runtime/src/adapters/sqlite/tools-repository.ts";
import { ToolRegistry } from "../../apps/user-runtime/src/modules/tools/tool-registry.ts";
import {
  ToolsInventoryService,
  type ToolCreationInput,
} from "../../apps/user-runtime/src/modules/tools/tools-inventory.service.ts";
import { ToolExecutor } from "../../apps/user-runtime/src/modules/tools/tool-executor.service.ts";
import { makeNoteBindings } from "../../apps/user-runtime/src/modules/tools/tool-binding.ts";
import { canonicalArgsDigest } from "../../apps/user-runtime/src/modules/tools/tool-executor.service.ts";

const WS = "ws_s27_esc";
const AGENT = "agent_creator";
const AGENT_OTHER = "agent_other";
const TASK = "task_s27_st08";
const CONV = "conv_s27_st08";
const NOW = "2026-11-05T12:00:00.000Z";
const USER = { type: "user" as const, id: "user_owner" };

/** The student pack's tool allow-list (the composition's resolved input). */
const PACK_TOOL_ALLOW_LIST = [
  { tool_id: "tool_web_search", version: "1.4.0" },
  { tool_id: "tool_file_read", version: "1.2.0" },
  { tool_id: "tool_file_write", version: "1.1.0" },
];

const tempDirs: string[] = [];

interface EscRuntime {
  inventory: ToolsInventoryService;
  executor: ToolExecutor;
  repo: ToolsRepository;
  registry: ToolRegistry;
  notes: Map<string, string>;
  conn: SqliteConnection;
}

function buildRuntime(): EscRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-s27-st08-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: new ApprovalsRepository(tx),
    operations: new OperationsRepository(tx),
    clock: () => NOW,
  });
  const repo = new ToolsRepository(conn.db);
  const registry = new ToolRegistry();
  const bindings = makeNoteBindings();
  registry.registerBinding("notes-append", bindings.append);
  registry.registerBinding("notes-read", bindings.read);
  const inventory = new ToolsInventoryService({
    tx,
    tools: repo,
    registry,
    packToolAllowList: PACK_TOOL_ALLOW_LIST,
    now: () => NOW,
  });
  const executor = new ToolExecutor({
    registry,
    tools: repo,
    tx,
    approvals,
    now: () => NOW,
    nowMs: () => 1_000,
  });
  return { inventory, executor, repo, registry, notes: bindings.notes, conn };
}

function creationInput(overrides: Partial<ToolCreationInput["tool"]> = {}): ToolCreationInput {
  return {
    workspace_id: WS,
    requested_by: { type: "agent", id: AGENT },
    tool: {
      tool_id: "tool_st08_probe",
      name: "ST-08 escalation probe",
      purpose: "The adversarial creation under test.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, line: { type: "string" } },
        required: ["path", "line"],
      },
      output_schema: { type: "object" },
      capabilities: ["file.write"],
      risk_class: "LOCAL_MUTATION",
      inventory_scope: "shared",
      ...overrides,
    },
  };
}

function makeRun(agentId = AGENT): TaskRun {
  return {
    task_id: TASK,
    workspace_id: WS,
    conversation_id: CONV,
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_st08" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: "a".repeat(64) },
    roster: [agentId],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

function propose(
  rt: EscRuntime,
  agentId: string,
  toolId: string,
  capability = "file.write",
): ReturnType<ToolExecutor["executeProposal"]> {
  const rawArgs = { path: "notes.md", line: "sentinel-line" };
  return rt.executor.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: TASK,
      conversation_id: CONV,
      tool_id: toolId,
      tool_version: "1.0.0",
      capability,
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: "the hostile escalation probe's proposal",
    },
    run: makeRun(agentId),
    agent_id: agentId,
    rawArgs,
    resource_scope: "workspace://notes/notes.md",
  });
}

describe("S27 ST-08 — the D38 intersection at creation (no widening)", () => {
  it("a tool declaring CREDENTIAL_ACCESS-shaped capability is refused at the PLATFORM layer — nothing registered", () => {
    const rt = buildRuntime();
    try {
      const preview = rt.inventory.previewCreation(
        creationInput({ capabilities: ["credential.access"] }),
      );
      expect(preview.ok).toBe(false);
      if (!preview.ok) {
        expect(preview.error_code).toBe("TOOL_CAPABILITY_NOT_ALLOWED");
        expect(preview.layer).toBe("platform");
      }
      // Create re-derives the verdict — the same hostile creation refused.
      expect(() =>
        rt.inventory.createTool(creationInput({ capabilities: ["credential.access"] })),
      ).toThrow(/TOOL_CAPABILITY_NOT_ALLOWED/);
      // NOTHING landed: the registry resolves nothing, no inventory row exists.
      expect(rt.registry.resolve(WS, "tool_st08_probe", "1.0.0")).toBeNull();
      expect(rt.repo.getAgentTool(WS, "tool_st08_probe", "1.0.0")).toBeNull();
    } finally {
      rt.conn.close();
    }
  });

  it("a tool declaring a platform capability the PACK does not allow is refused at the PACK layer", () => {
    const rt = buildRuntime();
    try {
      // repo.push IS in the platform catalog — but the pinned pack's
      // allow-list does not carry it: the pack layer refuses.
      const preview = rt.inventory.previewCreation(creationInput({ capabilities: ["repo.push"] }));
      expect(preview.ok).toBe(false);
      if (!preview.ok) {
        expect(preview.error_code).toBe("TOOL_CAPABILITY_NOT_ALLOWED");
        expect(preview.layer).toBe("pack");
      }
      expect(() => rt.inventory.createTool(creationInput({ capabilities: ["repo.push"] }))).toThrow(
        /TOOL_CAPABILITY_NOT_ALLOWED/,
      );
      expect(rt.registry.resolve(WS, "tool_st08_probe", "1.0.0")).toBeNull();
    } finally {
      rt.conn.close();
    }
  });
});

describe("S27 ST-08 — activation is a user-only runtime grant (G6)", () => {
  it("the creating Agent cannot self-activate; a user decision records the grant", () => {
    const rt = buildRuntime();
    try {
      rt.inventory.createTool(
        creationInput({ tool_id: "tool_st08_risky", risk_class: "LOCAL_MUTATION" }),
      );
      // The creating Agent itself: refused BEFORE any state check.
      expect(() =>
        rt.inventory.activateTool({
          workspace_id: WS,
          tool_id: "tool_st08_risky",
          version: "1.0.0",
          actor: { type: "agent", id: AGENT },
          target: { kind: "agent", id: AGENT },
        }),
      ).toThrow(/ACTIVATION_REQUIRES_RUNTIME_GRANT/);
      // Any other Agent actor: equally refused.
      expect(() =>
        rt.inventory.activateTool({
          workspace_id: WS,
          tool_id: "tool_st08_risky",
          version: "1.0.0",
          actor: { type: "agent", id: AGENT_OTHER },
          target: { kind: "agent", id: AGENT_OTHER },
        }),
      ).toThrow(/ACTIVATION_REQUIRES_RUNTIME_GRANT/);
      // The row is still unactivated — no grant slipped through.
      expect(rt.repo.getAgentTool(WS, "tool_st08_risky", "1.0.0")?.state).toBe("created");
      // The user decision records the grant (the ONE runtime place).
      const activation = rt.inventory.activateTool({
        workspace_id: WS,
        tool_id: "tool_st08_risky",
        version: "1.0.0",
        actor: USER,
        target: { kind: "agent", id: AGENT },
      });
      expect(activation.granted).toBe(true);
      expect(rt.repo.getAgentTool(WS, "tool_st08_risky", "1.0.0")?.state).toBe("active");
    } finally {
      rt.conn.close();
    }
  });
});

describe("S27 ST-08 — the executor honors the lifecycle (no grant, no effect)", () => {
  it("execution before activation is TOOL_NOT_ACTIVATED; the effect sentinel never moved", () => {
    const rt = buildRuntime();
    try {
      rt.inventory.createTool(
        creationInput({ tool_id: "tool_st08_unactivated", risk_class: "LOCAL_MUTATION" }),
      );
      const blocked = propose(rt, AGENT, "tool_st08_unactivated");
      expect(blocked.outcome).toBe("blocked");
      if (blocked.outcome === "blocked") {
        expect(blocked.error_code).toBe("TOOL_NOT_ACTIVATED");
      }
      // NO effect happened: the notes sentinel (the REAL effect surface of
      // the runtime binding this tool resolves to) is untouched.
      expect([...rt.notes.values()]).toEqual([]);
      // And the history row exists with the honest blocked outcome.
      const rows = rt.repo.listExecutionsByTask(WS, TASK);
      expect(rows.some((row) => row.error_code === "TOOL_NOT_ACTIVATED")).toBe(true);
    } finally {
      rt.conn.close();
    }
  });

  it("disabling beats activation: a disabled tool refuses even the activated owner (AC6)", () => {
    const rt = buildRuntime();
    try {
      rt.inventory.createTool(
        creationInput({ tool_id: "tool_st08_disabled", risk_class: "LOCAL_MUTATION" }),
      );
      rt.inventory.activateTool({
        workspace_id: WS,
        tool_id: "tool_st08_disabled",
        version: "1.0.0",
        actor: USER,
        target: { kind: "agent", id: AGENT },
      });
      rt.repo.insertDisablement(WS, "tool_st08_disabled", "user_owner", NOW);
      const blocked = propose(rt, AGENT, "tool_st08_disabled");
      expect(blocked.outcome).toBe("blocked");
      if (blocked.outcome === "blocked") {
        expect(blocked.error_code).toBe("TOOL_DISABLED");
      }
      expect([...rt.notes.values()]).toEqual([]);
    } finally {
      rt.conn.close();
    }
  });

  it("a private tool is TOOL_NOT_SHARED for another Agent — the creator's scope is not a kit others assemble", () => {
    const rt = buildRuntime();
    try {
      rt.inventory.createTool(
        creationInput({
          tool_id: "tool_st08_private",
          risk_class: "LOCAL_MUTATION",
          inventory_scope: "private",
        }),
      );
      // The OWNER is still unactivated (no grant yet) — but the OTHER agent
      // is refused for the SCOPE before any activation consult matters.
      const blockedOther = propose(rt, AGENT_OTHER, "tool_st08_private");
      expect(blockedOther.outcome).toBe("blocked");
      if (blockedOther.outcome === "blocked") {
        expect(blockedOther.error_code).toBe("TOOL_NOT_SHARED");
      }
      expect([...rt.notes.values()]).toEqual([]);
    } finally {
      rt.conn.close();
    }
  });
});

describe("S27 ST-08 — no bypass: the effect only exists through the executor", () => {
  it("the created tool's binding is the RUNTIME's binding, and it refuses a direct sync execute (AC1)", () => {
    const rt = buildRuntime();
    try {
      rt.inventory.createTool(
        creationInput({ tool_id: "tool_st08_binding", risk_class: "LOCAL_MUTATION" }),
      );
      const resolved = rt.registry.resolve(WS, "tool_st08_binding", "1.0.0");
      expect(resolved).not.toBeNull();
      // The binding was resolved BY NAME from the runtime's registered
      // bindings — a creation form never supplied executable content (D28).
      expect(resolved!.binding.name).toBe("notes-append");
      // AC1: a direct call WITHOUT the executor-minted authority is the
      // typed EXECUTION_AUTHORITY_MISSING refusal — the brand is unforgeable
      // and minted only inside the executor, so no proposing surface (or
      // hostile creation) can run effects outside validation, limits,
      // approval, and history.
      const direct = resolved!.binding;
      const forgedContext = {
        // A forged "authority" (any object an attacker could construct — the
        // brand symbol is module-private, so nothing outside mints a real one).
        authority: {} as never,
        deadline: Date.now() + 1_000,
        nowMs: () => Date.now(),
        maxResponseBytes: 4_096,
        resourceLimits: {
          max_memory_mb: 256,
          max_cpu_seconds: 30,
          max_processes: 4,
          max_disk_mb: 64,
        },
        signal: new AbortController().signal,
        execution: {
          execution_id: "exe_bypass_probe",
          workspace_id: WS,
          task_id: TASK,
          conversation_id: CONV,
          agent_id: AGENT,
          capability: "file.write",
          approval_id: null,
          grant_id: null,
        },
      };
      expect(() => direct.execute({ path: "notes.md", line: "bypass" }, forgedContext)).toThrow(
        /EXECUTION_AUTHORITY_MISSING/,
      );
      // The sentinel proves the bypass performed NO effect.
      expect([...rt.notes.values()]).toEqual([]);
    } finally {
      rt.conn.close();
    }
  });
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
