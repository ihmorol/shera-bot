/**
 * Tools repository storage (S21 chunk 1; PRD §7, E4, E13, E12, D23 rule 2).
 * Red-first: these tests pin the chunk-1 behaviors before the migration and
 * repository exist.
 *
 *   1. v15 ("tool-inventory") appends the committed chain: agent-created tool
 *      inventory rows, execution history rows, and activation grants. All
 *      three tables are STRICT and workspace-scoped (E12).
 *   2. The inventory row carries the full declarative record (name, purpose,
 *      owner, scope, schemas, capabilities, risk class, limits, redaction
 *      policy, approval policy) and the E13 recovery class DEFAULTED to
 *      needs_human — the default is stored data, never invented per call.
 *   3. Lifecycle states are unrepresentable outside the checked vocabulary,
 *      and activation is a durable runtime grant row created in one place.
 *   4. Execution history stores ONLY redacted bounded summaries (the args
 *      summary and result text arrive pre-redacted — the repository stores
 *      what the executor hands it) with the approval/grant linkage fields.
 *   5. Disablements are workspace-scoped rows that beat any grant (the
 *      executor consults them before grants — the repository only stores).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import {
  appliedMigrationVersions,
  applyMigrations,
  MIGRATIONS,
  sqliteTableExists,
} from "./migrations.ts";
import { ToolsRepository } from "./tools-repository.ts";

const WS = "ws_default_01";
const OTHER_WS = "ws_other_99";

const tempDirs: string[] = [];

function openTempDatabase(): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), "shera-tools-repo-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  return conn;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function agentToolRow() {
  return {
    workspace_id: WS,
    tool_id: "tool_summarize",
    version: "1.0.0",
    name: "Summarize notes",
    purpose: "Summarize a workspace note file into a digest.",
    owner_kind: "agent" as const,
    owner_agent_id: "agent_researcher",
    inventory_scope: "shared" as const,
    input_schema: { type: "object", properties: { path: { type: "string" } } },
    output_schema: { type: "object", properties: { digest: { type: "string" } } },
    capabilities: ["file.read"],
    risk_class: "READ_ONLY" as const,
    timeout_ms: 10_000,
    resource_limits: { max_memory_mb: 256, max_cpu_seconds: 30, max_processes: 4, max_disk_mb: 64 },
    redaction_policy: "standard" as const,
    approval_policy: "auto_read_only" as const,
    recovery: "needs_human" as const,
    state: "active" as const,
    enabled: 1 as const,
    max_response_bytes: 262_144,
    created_by_agent_id: "agent_researcher",
    created_at: "2026-10-29T12:00:00.000Z",
  };
}

describe("tool inventory storage (S21 migration v15)", () => {
  it("appends the tool-inventory migration as version 15 of the committed chain", () => {
    const v15 = MIGRATIONS.find((migration) => migration.version === 15);
    expect(v15?.name).toBe("tool-inventory");
    expect(MIGRATIONS.at(-1)?.version).toBe(15);
    const conn = openTempDatabase();
    expect(appliedMigrationVersions(conn.db)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(sqliteTableExists(conn.db, "tool_inventory")).toBe(true);
    expect(sqliteTableExists(conn.db, "tool_execution_history")).toBe(true);
    expect(sqliteTableExists(conn.db, "tool_activation_grants")).toBe(true);
    expect(sqliteTableExists(conn.db, "tool_disablements")).toBe(true);
    conn.close();
  });

  it("stores an agent-created tool declaratively and reads it back E12-scoped", () => {
    const conn = openTempDatabase();
    const repo = new ToolsRepository(conn.db);
    repo.insertAgentTool(agentToolRow());
    const row = repo.getAgentTool(WS, "tool_summarize", "1.0.0");
    expect(row).not.toBeNull();
    expect(row?.risk_class).toBe("READ_ONLY");
    expect(row?.recovery).toBe("needs_human");
    expect(row?.inventory_scope).toBe("shared");
    expect(row?.capabilities).toEqual(["file.read"]);
    // E12: the same tool_id in another workspace is an independent absence.
    expect(repo.getAgentTool(OTHER_WS, "tool_summarize", "1.0.0")).toBeNull();
    expect(repo.listAgentTools(OTHER_WS)).toEqual([]);
    expect(repo.listAgentTools(WS)).toHaveLength(1);
    conn.close();
  });

  it("defaults a missing recovery class to needs_human at the storage boundary", () => {
    const conn = openTempDatabase();
    const repo = new ToolsRepository(conn.db);
    const row = { ...agentToolRow() };
    delete (row as { recovery?: string }).recovery;
    // The stored row type makes recovery optional; the DB column default
    // (needs_human) is what lands — the runtime never invents a class.
    repo.insertAgentTool(row);
    expect(repo.getAgentTool(WS, "tool_summarize", "1.0.0")?.recovery).toBe("needs_human");
    conn.close();
  });

  it("moves lifecycle states (created -> active -> disabled) with the activation grant recorded once", () => {
    const conn = openTempDatabase();
    const repo = new ToolsRepository(conn.db);
    repo.insertAgentTool({ ...agentToolRow(), state: "created" });

    const granted = repo.recordActivationGrant({
      workspace_id: WS,
      tool_id: "tool_summarize",
      tool_version: "1.0.0",
      target_kind: "agent",
      target_id: "agent_researcher",
      granted_by: "user_owner",
      granted_at: "2026-10-29T12:01:00.000Z",
    });
    expect(granted).toBe(true);
    // Idempotent: the same activation replay records nothing new (D23 rule 6).
    expect(
      repo.recordActivationGrant({
        workspace_id: WS,
        tool_id: "tool_summarize",
        tool_version: "1.0.0",
        target_kind: "agent",
        target_id: "agent_researcher",
        granted_by: "user_owner",
        granted_at: "2026-10-29T12:02:00.000Z",
      }),
    ).toBe(false);

    repo.updateAgentToolState(WS, "tool_summarize", "1.0.0", "active");
    expect(repo.getAgentTool(WS, "tool_summarize", "1.0.0")?.state).toBe("active");
    expect(
      repo.hasActivationGrant(WS, "tool_summarize", "1.0.0", "agent", "agent_researcher"),
    ).toBe(true);
    expect(repo.hasActivationGrant(WS, "tool_summarize", "1.0.0", "agent", "agent_other")).toBe(
      false,
    );

    repo.updateAgentToolState(WS, "tool_summarize", "1.0.0", "disabled");
    expect(repo.getAgentTool(WS, "tool_summarize", "1.0.0")?.state).toBe("disabled");
    conn.close();
  });

  it("stores disablements that the executor consults before any grant", () => {
    const conn = openTempDatabase();
    const repo = new ToolsRepository(conn.db);
    expect(repo.isDisabled(WS, "tool_file_read")).toBe(false);
    repo.insertDisablement(WS, "tool_file_read", "user_owner", "2026-10-29T12:00:00.000Z");
    expect(repo.isDisabled(WS, "tool_file_read")).toBe(true);
    expect(repo.isDisabled(OTHER_WS, "tool_file_read")).toBe(false);
    repo.deleteDisablement(WS, "tool_file_read");
    expect(repo.isDisabled(WS, "tool_file_read")).toBe(false);
    conn.close();
  });

  it("records execution history rows redacted-by-contract with approval linkage", () => {
    const conn = openTempDatabase();
    const repo = new ToolsRepository(conn.db);
    const execution = {
      workspace_id: WS,
      execution_id: "exe_01",
      task_id: "task_01",
      conversation_id: "conv_01",
      agent_id: "agent_researcher",
      tool_id: "tool_file_write",
      tool_version: "1.1.0",
      capability: "file.write",
      risk_class: "LOCAL_MUTATION" as const,
      recovery: "needs_human" as const,
      args_digest: `sha256:${"b".repeat(64)}`,
      args_summary: "path=notes.md size=120",
      preview: null,
      status: "awaiting_approval" as const,
      approval_id: "apr_01",
      grant_id: null,
      error_code: null,
      result_summary: null,
      timeout_ms: 10_000,
      max_response_bytes: 262_144,
      resource_limits: {
        max_memory_mb: 256,
        max_cpu_seconds: 30,
        max_processes: 4,
        max_disk_mb: 64,
      },
      started_at: "2026-10-29T12:00:00.000Z",
      finished_at: null,
    };
    repo.insertExecution(execution);
    const stored = repo.getExecution(WS, "exe_01");
    expect(stored?.status).toBe("awaiting_approval");
    expect(stored?.approval_id).toBe("apr_01");
    expect(stored?.args_summary).toBe("path=notes.md size=120");

    repo.updateExecutionResult(WS, "exe_01", {
      status: "succeeded",
      result_summary: "appended 1 line",
      finished_at: "2026-10-29T12:05:00.000Z",
      error_code: null,
      grant_id: "grt_01",
    });
    const done = repo.getExecution(WS, "exe_01");
    expect(done?.status).toBe("succeeded");
    expect(done?.grant_id).toBe("grt_01");
    expect(done?.finished_at).toBe("2026-10-29T12:05:00.000Z");

    expect(repo.listExecutionsByTask(WS, "task_01")).toHaveLength(1);
    expect(repo.listExecutionsByTask(OTHER_WS, "task_01")).toEqual([]);
    expect(repo.listExecutionsByTool(WS, "tool_file_write")).toHaveLength(1);
    conn.close();
  });

  it("refuses rows that violate the checked vocabularies (unrepresentable states)", () => {
    const conn = openTempDatabase();
    const repo = new ToolsRepository(conn.db);
    expect(() =>
      repo.insertAgentTool({
        ...agentToolRow(),
        risk_class: "READ_ONLY" as const,
        state: "active" as const,
        recovery: "whatever" as never,
      }),
    ).toThrow();
    conn.close();
  });
});
