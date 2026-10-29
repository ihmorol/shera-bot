/**
 * Agent-created tool inventory (S21 chunk 5; PRD §7, E4, D38, G2/G6, AC7/AC8).
 * Red-first: these tests pin the chunk-5 behaviors before the service exists.
 *
 *   1. Creation is PREVIEW-GATED (D35 preview policy): the preview is a pure
 *      read model (zero rows written) that resolves the ladder entry and the
 *      D38 intersection verdict; the create command RE-validates everything —
 *      preview answers are never trusted (D30/D36 discipline).
 *   2. AC7: the D38 intersection is enforced at creation — a tool claiming a
 *      capability the PLATFORM does not implement, or the PACK does not
 *      allow, is refused with the layer named. Nothing an Agent creates can
 *      widen platform, pack, or workspace limits.
 *   3. E4 lifecycle: a READ_ONLY tool auto-activates on creation
 *      (non-destructive creation may auto-activate); a risky tool lands in
 *      the `created` state and stays unexecutable until activated.
 *   4. AC8: activating an agent-created tool into an Agent's toolset requires
 *      a RUNTIME GRANT — the creating Agent cannot grant it to itself (an
 *      agent actor is refused, even for its own tool); a USER decision
 *      records the activation grant in the one runtime place, idempotently.
 *   5. The executor honors the lifecycle: before activation the proposing
 *      Agent is refused (TOOL_NOT_ACTIVATED); after activation the tool
 *      executes through the same executor path as every built-in.
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
import { makeNoteBindings } from "./tool-binding.ts";
import { ToolRegistry } from "./tool-registry.ts";
import {
  PLATFORM_TOOL_CATALOG,
  ToolsInventoryService,
  type ToolCreationInput,
} from "./tools-inventory.service.ts";

const WS = "ws_default_01";
const TASK = "task_001";
const CONV = "conv_001";
const AGENT = "agent_researcher";
const OTHER_AGENT = "agent_writer";
const USER = { type: "user" as const, id: "user_owner" };
const NOW = "2026-10-29T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

/** The student pack's tool allow-list, resolved (the composition's input). */
const PACK_TOOL_ALLOW_LIST = [
  { tool_id: "tool_web_search", version: "1.4.0" },
  { tool_id: "tool_file_read", version: "1.2.0" },
  { tool_id: "tool_file_write", version: "1.1.0" },
  { tool_id: "tool_code_exec", version: "2.0.1" },
  { tool_id: "tool_repo_push", version: "0.9.2" },
];

interface InventoryRuntime {
  inventory: ToolsInventoryService;
  executor: ToolExecutor;
  repo: ToolsRepository;
  registry: ToolRegistry;
  conn: SqliteConnection;
  notes: Map<string, string>;
}

function buildRuntime(): InventoryRuntime {
  const dir = mkdtempSync(join(tmpdir(), "shera-tools-inventory-"));
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
  return { inventory, executor, repo, registry, conn, notes: bindings.notes };
}

function creationInput(overrides: Partial<ToolCreationInput["tool"]> = {}): ToolCreationInput {
  return {
    workspace_id: WS,
    requested_by: { type: "agent", id: AGENT },
    tool: {
      tool_id: "tool_digest_builder",
      name: "Digest builder",
      purpose: "Builds a digest line for a note.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, line: { type: "string" } },
        required: ["path", "line"],
      },
      output_schema: { type: "object" },
      capabilities: ["file.read"],
      risk_class: "READ_ONLY",
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
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_001" },
    pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
    roster: [agentId],
    state: "RUNNING",
    version: 7,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the D38 intersection at creation (S21 chunk 5, AC7)", () => {
  it("the platform catalog maps the pack's tools to their capability union", () => {
    expect(PLATFORM_TOOL_CATALOG.tool_file_write).toContain("file.write");
    expect(PLATFORM_TOOL_CATALOG.tool_code_exec).toContain("code.exec");
    // A platform capability the student pack does not allow exists in the
    // catalog — the pack layer of the intersection is testable.
    expect(PLATFORM_TOOL_CATALOG.tool_memory_write).toContain("memory.write");
  });

  it("refuses a tool claiming a capability the PLATFORM does not implement (layer named)", () => {
    const rt = buildRuntime();
    const verdict = rt.inventory.previewCreation(
      creationInput({ capabilities: ["deploy.cluster"] }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error_code).toBe("TOOL_CAPABILITY_NOT_ALLOWED");
      expect(verdict.layer).toBe("platform");
    }
    // The create command refuses too (previews are never trusted).
    expect(() =>
      rt.inventory.createTool(creationInput({ capabilities: ["deploy.cluster"] })),
    ).toThrow(/TOOL_CAPABILITY_NOT_ALLOWED/);
    expect(rt.repo.listAgentTools(WS)).toEqual([]);
    rt.conn.close();
  });

  it("refuses a tool claiming a platform capability the PACK does not allow (layer named)", () => {
    const rt = buildRuntime();
    const verdict = rt.inventory.previewCreation(creationInput({ capabilities: ["memory.write"] }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error_code).toBe("TOOL_CAPABILITY_NOT_ALLOWED");
      expect(verdict.layer).toBe("pack");
    }
    expect(() =>
      rt.inventory.createTool(creationInput({ capabilities: ["memory.write"] })),
    ).toThrow(/TOOL_CAPABILITY_NOT_ALLOWED/);
    rt.conn.close();
  });

  it("creates a tool within the intersection and registers it runtime-owned", () => {
    const rt = buildRuntime();
    const verdict = rt.inventory.previewCreation(creationInput());
    expect(verdict.ok).toBe(true);
    // Zero side effects: the preview wrote nothing.
    expect(rt.repo.listAgentTools(WS)).toEqual([]);

    const created = rt.inventory.createTool(creationInput());
    expect(created.state).toBe("active"); // READ_ONLY: non-destructive -> auto-activate (E4)
    const row = rt.repo.getAgentTool(WS, "tool_digest_builder", "1.0.0");
    expect(row?.inventory_scope).toBe("shared");
    expect(row?.owner_agent_id).toBe(AGENT);
    // Registered into the runtime registry — the executor resolves it.
    expect(rt.registry.resolve(WS, "tool_digest_builder", "1.0.0")).not.toBeNull();
    rt.conn.close();
  });
});

describe("the E4 lifecycle (S21 chunk 5)", () => {
  it("a risky tool lands in the created state; a READ_ONLY tool auto-activates", () => {
    const rt = buildRuntime();
    const risky = rt.inventory.createTool(
      creationInput({
        tool_id: "tool_note_append_custom",
        capabilities: ["file.write"],
        risk_class: "LOCAL_MUTATION",
      }),
    );
    expect(risky.state).toBe("created");
    const safe = rt.inventory.createTool(creationInput());
    expect(safe.state).toBe("active");
    rt.conn.close();
  });

  it("AC8: the creating Agent cannot grant activation — even to itself", () => {
    const rt = buildRuntime();
    rt.inventory.createTool(
      creationInput({
        tool_id: "tool_note_append_custom",
        capabilities: ["file.write"],
        risk_class: "LOCAL_MUTATION",
      }),
    );
    expect(() =>
      rt.inventory.activateTool({
        workspace_id: WS,
        tool_id: "tool_note_append_custom",
        version: "1.0.0",
        target: { kind: "agent", id: AGENT },
        actor: { type: "agent", id: AGENT },
      }),
    ).toThrow(/ACTIVATION_REQUIRES_RUNTIME_GRANT/);
    // Still unactivated.
    expect(rt.repo.hasActivationGrant(WS, "tool_note_append_custom", "1.0.0", "agent", AGENT)).toBe(
      false,
    );
    rt.conn.close();
  });

  it("AC8: a USER decision activates the tool (the runtime grant, idempotent)", () => {
    const rt = buildRuntime();
    rt.inventory.createTool(
      creationInput({
        tool_id: "tool_note_append_custom",
        capabilities: ["file.write"],
        risk_class: "LOCAL_MUTATION",
      }),
    );
    const first = rt.inventory.activateTool({
      workspace_id: WS,
      tool_id: "tool_note_append_custom",
      version: "1.0.0",
      target: { kind: "agent", id: AGENT },
      actor: USER,
    });
    expect(first.granted).toBe(true);
    // Idempotent replay: already granted (D23 rule 6).
    const replay = rt.inventory.activateTool({
      workspace_id: WS,
      tool_id: "tool_note_append_custom",
      version: "1.0.0",
      target: { kind: "agent", id: AGENT },
      actor: USER,
    });
    expect(replay.granted).toBe(false);
    expect(rt.repo.getAgentTool(WS, "tool_note_append_custom", "1.0.0")?.state).toBe("active");
    rt.conn.close();
  });
});

describe("the executor honors the lifecycle (S21 chunk 5)", () => {
  function proposeThroughExecutor(rt: InventoryRuntime, agentId: string, toolId: string) {
    const rawArgs = { path: "notes.md", line: "hello" };
    return rt.executor.executeProposal({
      proposal: {
        workspace_id: WS,
        task_id: TASK,
        conversation_id: CONV,
        tool_id: toolId,
        tool_version: "1.0.0",
        capability: "file.write",
        args_digest: canonicalArgsDigest(rawArgs),
        proposal_summary: "append a digest line",
      },
      run: makeRun(agentId),
      agent_id: agentId,
      rawArgs,
      resource_scope: "workspace://notes/notes.md",
    });
  }

  it("before activation the proposing Agent is refused; after activation it executes", () => {
    const rt = buildRuntime();
    rt.inventory.createTool(
      creationInput({
        tool_id: "tool_note_append_custom",
        capabilities: ["file.write"],
        risk_class: "LOCAL_MUTATION",
      }),
    );
    const blocked = proposeThroughExecutor(rt, AGENT, "tool_note_append_custom");
    expect(blocked.outcome).toBe("blocked");
    if (blocked.outcome === "blocked") {
      expect(blocked.error_code).toBe("TOOL_NOT_ACTIVATED");
    }

    // A user decision activates it for the creator.
    rt.inventory.activateTool({
      workspace_id: WS,
      tool_id: "tool_note_append_custom",
      version: "1.0.0",
      target: { kind: "agent", id: AGENT },
      actor: USER,
    });
    // The gated path pauses (approval machinery — LOCAL_MUTATION); the
    // refusal is gone, so the lifecycle is what changed.
    const gated = proposeThroughExecutor(rt, AGENT, "tool_note_append_custom");
    expect(gated.outcome).toBe("paused_for_approval");
    // A DIFFERENT agent without an activation grant is still refused.
    const other = proposeThroughExecutor(rt, OTHER_AGENT, "tool_note_append_custom");
    expect(other.outcome).toBe("blocked");
    if (other.outcome === "blocked") {
      expect(other.error_code).toBe("TOOL_NOT_ACTIVATED");
    }
    rt.conn.close();
  });

  it("a private-scope tool refuses execution by any other Agent even when activated for the owner", () => {
    const rt = buildRuntime();
    rt.inventory.createTool(
      creationInput({
        tool_id: "tool_private_digest",
        inventory_scope: "private",
        capabilities: ["file.read"],
        risk_class: "READ_ONLY",
      }),
    );
    const ownerRun = proposeThroughExecutor(rt, AGENT, "tool_private_digest");
    expect(ownerRun.outcome).toBe("executed"); // READ_ONLY: auto, owner allowed
    const otherRun = proposeThroughExecutor(rt, OTHER_AGENT, "tool_private_digest");
    expect(otherRun.outcome).toBe("blocked");
    if (otherRun.outcome === "blocked") {
      expect(otherRun.error_code).toBe("TOOL_NOT_SHARED");
    }
    rt.conn.close();
  });
});
