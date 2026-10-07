/**
 * S11 chunk 1 agent identity contract tests (D32 layer 1, D39): the migration
 * chain creates workspace-scoped agent tables, the repository seeds them from
 * the pinned student pack idempotently, and re-seeding refreshes pack-owned
 * fields but never clobbers user-owned fields. Real SQLite, real migrations —
 * the same discipline as the workspaces repository test.
 *
 * Vocabulary: Pack → Operations → Agents; "Expert" is a forbidden alias.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import { applyMigrations, MIGRATIONS } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import {
  AgentsRepository,
  AgentNotFoundError,
  seedAgentsFromPack,
} from "./agents-repository.ts";

interface ManifestAgent {
  agent_id: string;
  display_name: string;
  role_description: string;
  default_provider: { provider_id: string; model: string };
  skills: string[];
  tools: { tool_id: string; version: string }[];
  connectors: string[];
  ui_identity: { avatar_hue: number; initial_glyph: string };
  home_operation_id: string | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const studentManifestPath = resolve(
  here,
  "../../../../../agent-packs/student/v1/manifest.json",
);
const studentManifest = JSON.parse(readFileSync(studentManifestPath, "utf8")) as {
  agents: ManifestAgent[];
};

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s11-agents-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent identities (S11 migration v4)", () => {
  let conn: SqliteConnection;
  let tx: SqliteTransactions;
  let repo: AgentsRepository;

  beforeEach(() => {
    conn = openDatabase(newTempDbPath());
    applyMigrations(conn.db);
    tx = new SqliteTransactions(conn.db);
    repo = new AgentsRepository(tx);
  });

  afterEach(() => {
    conn.close();
  });

  it("appends the agent migrations to the committed migration chain", () => {
    // The chain is append-only (D24): v4 introduced the agent identities, and
    // chunk 2's v5 (direct-chat binding) extends it — v4 is no longer last.
    const v4 = MIGRATIONS.find((migration) => migration.version === 4);
    expect(v4?.name).toBe("agent-identities");
    expect(MIGRATIONS.at(-1)?.version).toBe(5);
    expect(MIGRATIONS.at(-1)?.name).toBe("agent-direct-chat-binding");
  });

  it("seeds the six student-pack agents with pack-owned fields", () => {
    const result = repo.upsertFromPack("ws-primary", studentManifest.agents);

    expect(result.inserted_agent_ids).toHaveLength(6);
    expect(result.updated_agent_ids).toEqual([]);
    expect(result.orphaned_agent_ids).toEqual([]);

    const agents = repo.listAgents("ws-primary");
    expect(agents).toHaveLength(6);
    expect(agents.map((agent) => agent.agent_id).sort()).toEqual(
      studentManifest.agents.map((agent) => agent.agent_id).sort(),
    );

    const manifestGeneral = studentManifest.agents.find(
      (agent) => agent.agent_id === "agent_general_assistant",
    );
    expect(manifestGeneral).toBeDefined();
    // Actual student-pack value (S11 brief): agent_general_assistant / hue 217.
    expect(manifestGeneral?.ui_identity.avatar_hue).toBe(217);

    const general = repo.getAgent("ws-primary", "agent_general_assistant");
    expect(general).toEqual({
      agent_id: "agent_general_assistant",
      workspace_id: "ws-primary",
      display_name: manifestGeneral?.display_name,
      role_description: manifestGeneral?.role_description,
      avatar_hue: 217,
      initial_glyph: manifestGeneral?.ui_identity.initial_glyph,
      default_provider_id: manifestGeneral?.default_provider.provider_id,
      default_provider_model: manifestGeneral?.default_provider.model,
      user_instructions: null,
      capabilities_json: JSON.stringify({
        skills: manifestGeneral?.skills,
        tools: manifestGeneral?.tools,
        connectors: manifestGeneral?.connectors,
      }),
      private_folder_path: "agent://agent_general_assistant/",
      home_operation_id: manifestGeneral?.home_operation_id,
      is_seeded_from_pack: 1,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });

    // Every seeded agent carries its private folder URI and pack provenance.
    for (const agent of agents) {
      expect(agent.private_folder_path).toBe(`agent://${agent.agent_id}/`);
      expect(agent.is_seeded_from_pack).toBe(1);
    }
  });

  it("seedAgentsFromPack maps a loaded pack manifest onto upsertFromPack", () => {
    const result = seedAgentsFromPack(tx, "ws-primary", studentManifest);
    expect(result.inserted_agent_ids).toHaveLength(6);
    expect(repo.listAgents("ws-primary")).toHaveLength(6);
  });

  it("re-seeding an unchanged pack reports no inserts, updates, or orphans", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const result = repo.upsertFromPack("ws-primary", studentManifest.agents);
    expect(result.inserted_agent_ids).toEqual([]);
    expect(result.updated_agent_ids).toEqual([]);
    expect(result.orphaned_agent_ids).toEqual([]);
    expect(repo.listAgents("ws-primary")).toHaveLength(6);
  });

  it("re-seeding refreshes pack-owned fields but never clobbers user-owned fields", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);
    repo.updateUserInstructions(
      "ws-primary",
      "agent_general_assistant",
      "Always answer in Bengali.",
    );
    repo.updateDefaultProvider(
      "ws-primary",
      "agent_general_assistant",
      "user-pick",
      "user/selected-model",
    );

    const mutated: ManifestAgent[] = structuredClone(studentManifest.agents);
    const general = mutated.find(
      (agent) => agent.agent_id === "agent_general_assistant",
    );
    expect(general).toBeDefined();
    general!.display_name = "Renamed Assistant";
    general!.role_description = "Renamed role description";
    general!.ui_identity.avatar_hue = 42;
    general!.default_provider = { provider_id: "pack-pick", model: "pack/model" };

    const result = repo.upsertFromPack("ws-primary", mutated);
    expect(result.inserted_agent_ids).toEqual([]);
    expect(result.updated_agent_ids).toEqual(["agent_general_assistant"]);

    const updated = repo.getAgent("ws-primary", "agent_general_assistant");
    expect(updated).not.toBeNull();
    // User-owned fields survive the re-seed untouched.
    expect(updated?.user_instructions).toBe("Always answer in Bengali.");
    expect(updated?.default_provider_id).toBe("user-pick");
    expect(updated?.default_provider_model).toBe("user/selected-model");
    // Pack-owned fields follow the pack.
    expect(updated?.display_name).toBe("Renamed Assistant");
    expect(updated?.role_description).toBe("Renamed role description");
    expect(updated?.avatar_hue).toBe(42);
  });

  it("leaves removed pack agents in place and reports them as orphaned", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const withoutGeneral = studentManifest.agents.filter(
      (agent) => agent.agent_id !== "agent_general_assistant",
    );
    const result = repo.upsertFromPack("ws-primary", withoutGeneral);
    expect(result.orphaned_agent_ids).toEqual(["agent_general_assistant"]);
    // Removal is a product decision, not a re-seed side effect: the row stays.
    expect(repo.getAgent("ws-primary", "agent_general_assistant")).not.toBeNull();
    expect(repo.listAgents("ws-primary")).toHaveLength(6);
  });

  it("inserts newly added pack agents on re-seed", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const extended: ManifestAgent[] = [
      ...studentManifest.agents,
      {
        agent_id: "agent_newcomer",
        display_name: "Newcomer",
        role_description: "Added by a later pack version",
        default_provider: { provider_id: "provider_platform", model: "platform-default" },
        skills: [],
        tools: [],
        connectors: [],
        ui_identity: { avatar_hue: 10, initial_glyph: "N" },
        home_operation_id: null,
      },
    ];

    const result = repo.upsertFromPack("ws-primary", extended);
    expect(result.inserted_agent_ids).toEqual(["agent_newcomer"]);
    expect(repo.getAgent("ws-primary", "agent_newcomer")).not.toBeNull();
    expect(repo.listAgents("ws-primary")).toHaveLength(7);
  });

  it("updates user instructions and rejects unknown agents", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    repo.updateUserInstructions(
      "ws-primary",
      "agent_general_assistant",
      "Never send drafts without review.",
    );
    expect(
      repo.getAgent("ws-primary", "agent_general_assistant")?.user_instructions,
    ).toBe("Never send drafts without review.");

    // Clearing is allowed (null).
    repo.updateUserInstructions("ws-primary", "agent_general_assistant", null);
    expect(
      repo.getAgent("ws-primary", "agent_general_assistant")?.user_instructions,
    ).toBeNull();

    expect(() =>
      repo.updateUserInstructions("ws-primary", "agent_missing", "nope"),
    ).toThrow(AgentNotFoundError);
  });

  it("updates the default provider for an agent", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    repo.updateDefaultProvider(
      "ws-primary",
      "agent_general_assistant",
      "provider_platform",
      "platform-large",
    );
    const general = repo.getAgent("ws-primary", "agent_general_assistant");
    expect(general?.default_provider_id).toBe("provider_platform");
    expect(general?.default_provider_model).toBe("platform-large");

    expect(() =>
      repo.updateDefaultProvider("ws-primary", "agent_missing", "a", "b"),
    ).toThrow(AgentNotFoundError);
  });

  it("stores and returns raw per-agent settings JSON", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const agentId = "agent_general_assistant";
    // No settings row yet: the raw blob defaults to an empty object (the
    // typed D16 command surface arrives in S11 chunk 2).
    expect(repo.getSettings("ws-primary", agentId)).toEqual({});

    const settings = { temperature: 0.2, tone: "warm" };
    repo.updateSettings("ws-primary", agentId, settings);
    expect(repo.getSettings("ws-primary", agentId)).toEqual(settings);

    // The blob is replaced wholesale at this layer.
    repo.updateSettings("ws-primary", agentId, { tone: "concise" });
    expect(repo.getSettings("ws-primary", agentId)).toEqual({ tone: "concise" });

    expect(() => repo.updateSettings("ws-primary", "agent_missing", {})).toThrow(
      AgentNotFoundError,
    );
  });

  it("round-trips private memory entries per agent", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const agentId = "agent_general_assistant";
    repo.addMemoryEntry("ws-primary", agentId, "Prefers morning summaries.");
    repo.addMemoryEntry("ws-primary", agentId, "Allergic to shellfish.");

    const entries = repo.listMemoryEntries("ws-primary", agentId);
    expect(entries.map((entry) => entry.content)).toEqual([
      "Prefers morning summaries.",
      "Allergic to shellfish.",
    ]);
    expect(entries.every((entry) => entry.agent_id === agentId)).toBe(true);
    expect(entries.every((entry) => typeof entry.created_at === "string")).toBe(true);
  });

  it("round-trips the task history ledger per agent", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const agentId = "agent_general_assistant";
    repo.addTaskHistoryEntry("ws-primary", agentId, "task-001");
    repo.addTaskHistoryEntry("ws-primary", agentId, "task-002");

    const rows = repo.listTaskHistory("ws-primary", agentId);
    expect(rows.map((row) => row.task_id)).toEqual(["task-001", "task-002"]);
    expect(rows.every((row) => row.agent_id === agentId)).toBe(true);
  });

  it("scopes all agent data to its workspace", () => {
    // Both workspaces seed the same pinned pack; identical agent_ids must
    // coexist as independent rows (E12).
    repo.upsertFromPack("ws-alpha", studentManifest.agents);
    repo.upsertFromPack("ws-beta", studentManifest.agents);

    repo.updateUserInstructions("ws-alpha", "agent_general_assistant", "alpha rules");
    repo.updateSettings("ws-beta", "agent_general_assistant", { tone: "beta" });
    repo.addMemoryEntry("ws-beta", "agent_general_assistant", "beta memory");
    repo.addTaskHistoryEntry("ws-beta", "agent_general_assistant", "task-beta");

    expect(
      repo.listAgents("ws-alpha").every((agent) => agent.workspace_id === "ws-alpha"),
    ).toBe(true);
    expect(
      repo.listAgents("ws-beta").every((agent) => agent.workspace_id === "ws-beta"),
    ).toBe(true);
    expect(repo.listAgents("ws-alpha")).toHaveLength(6);
    expect(repo.listAgents("ws-beta")).toHaveLength(6);

    expect(repo.getAgent("ws-alpha", "agent_general_assistant")?.user_instructions).toBe(
      "alpha rules",
    );
    expect(repo.getAgent("ws-beta", "agent_general_assistant")?.user_instructions).toBeNull();

    expect(repo.getSettings("ws-alpha", "agent_general_assistant")).toEqual({});
    expect(repo.getSettings("ws-beta", "agent_general_assistant")).toEqual({ tone: "beta" });

    expect(repo.listMemoryEntries("ws-alpha", "agent_general_assistant")).toEqual([]);
    expect(repo.listMemoryEntries("ws-beta", "agent_general_assistant")).toHaveLength(1);

    expect(repo.listTaskHistory("ws-alpha", "agent_general_assistant")).toEqual([]);
    expect(repo.listTaskHistory("ws-beta", "agent_general_assistant")).toHaveLength(1);

    expect(repo.getAgent("ws-alpha", "agent_does_not_exist")).toBeNull();
    expect(repo.listAgents("ws-unknown")).toEqual([]);
  });
});
