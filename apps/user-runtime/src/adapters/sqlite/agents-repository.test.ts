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
  AGENT_FOLDER_HOST_CHARSET,
  AgentsRepository,
  AgentNotFoundError,
  AgentSeedCharsetError,
  AgentSeedConflictError,
  AgentSettingsValidationError,
  isDirectChatConflict,
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
const studentManifestPath = resolve(here, "../../../../../agent-packs/student/v1/manifest.json");
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
    // S13 chunk 2's v6 (operation chat records) extends the chain further, and
    // chunk 3's v7 (operation chat binding + addressing) after that.
    const v4 = MIGRATIONS.find((migration) => migration.version === 4);
    const v5 = MIGRATIONS.find((migration) => migration.version === 5);
    expect(v4?.name).toBe("agent-identities");
    expect(v5?.name).toBe("agent-direct-chat-binding");
    expect(MIGRATIONS.at(-1)?.version).toBe(7);
    expect(MIGRATIONS.at(-1)?.name).toBe("operation-chat-binding-and-addressing");
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

  it("rejects a duplicate agent_id roster with the typed seed conflict — and lands nothing", () => {
    // The manifest schema rejects duplicate ids upstream; the repository's
    // defensive re-check is the TYPED startup failure (G4), not a raw Error.
    const duplicated = [
      ...studentManifest.agents,
      studentManifest.agents[0]!, // the SAME agent_id twice
    ];
    expect(() => repo.upsertFromPack("ws-prim-dup", duplicated)).toThrow(AgentSeedConflictError);
    try {
      repo.upsertFromPack("ws-prim-dup", duplicated);
    } catch (error) {
      const seedConflict = error as AgentSeedConflictError;
      expect(seedConflict.code).toBe("CONTRACT_VALIDATION_FAILED");
      expect(seedConflict.category).toBe("validation");
      expect(seedConflict.message).toBe(
        `duplicate agent_id in pack roster: ${studentManifest.agents[0]!.agent_id}`,
      );
    }
    // The rejection arrived mid-roster, but the upsert is one transaction:
    // the agents inserted BEFORE the duplicate was detected rolled back too.
    expect(repo.listAgents("ws-prim-dup")).toEqual([]);
  });

  it("rejects agent_ids whose charset breaks their agent:// folder URI", () => {
    // The contracts' Id schema allows uppercase (and the repository accepts a
    // structural seed, not just a validated SDK manifest), but the seed writes
    // `agent://<agent_id>/` — an id like "Atlas" would violate the folder URI
    // contracts FOREVER. The seeding boundary rejects it, typed.
    const roster = (agentId: string): ManifestAgent => ({
      agent_id: agentId,
      display_name: "Broken Charsetter",
      role_description: "An id the folder guard could never address",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 10, initial_glyph: "B" },
      home_operation_id: null,
    });
    for (const badId of ["Atlas", "agent general", "agent.v2"]) {
      expect(() => repo.upsertFromPack("ws-charset", [roster(badId)])).toThrow(
        AgentSeedCharsetError,
      );
      try {
        repo.upsertFromPack("ws-charset", [roster(badId)]);
      } catch (error) {
        const rejected = error as AgentSeedCharsetError;
        expect(rejected.code).toBe("CONTRACT_VALIDATION_FAILED");
        expect(rejected.category).toBe("validation");
        expect(rejected.message).toContain(badId);
      }
      // Nothing landed — a rejected roster seeds nothing.
      expect(repo.listAgents("ws-charset")).toEqual([]);
    }

    // The charset rule the boundary enforces IS the folder guard's rule: the
    // student pack's lowercase ids all seed folder roots that parse, and the
    // rejected id provably would not.
    const seeded = repo.upsertFromPack("ws-charset", studentManifest.agents);
    expect(seeded.inserted_agent_ids).toHaveLength(6);
    for (const agent of repo.listAgents("ws-charset")) {
      expect(AGENT_FOLDER_HOST_CHARSET.test(agent.agent_id)).toBe(true);
      expect(agent.private_folder_path).toBe(`agent://${agent.agent_id}/`);
      expect(agent.private_folder_path).toMatch(/^agent:\/\/[a-z0-9_-]+\/$/);
    }
    expect(AGENT_FOLDER_HOST_CHARSET.test("Atlas")).toBe(false);
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
    const general = mutated.find((agent) => agent.agent_id === "agent_general_assistant");
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
    expect(repo.getAgent("ws-primary", "agent_general_assistant")?.user_instructions).toBe(
      "Never send drafts without review.",
    );

    // Clearing is allowed (null).
    repo.updateUserInstructions("ws-primary", "agent_general_assistant", null);
    expect(repo.getAgent("ws-primary", "agent_general_assistant")?.user_instructions).toBeNull();

    expect(() => repo.updateUserInstructions("ws-primary", "agent_missing", "nope")).toThrow(
      AgentNotFoundError,
    );
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

    expect(() => repo.updateDefaultProvider("ws-primary", "agent_missing", "a", "b")).toThrow(
      AgentNotFoundError,
    );
  });

  it("stores and returns validated per-agent settings overrides (the typed writer)", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const agentId = "agent_general_assistant";
    // No settings row yet: the validated overrides default to an empty object.
    expect(repo.getSettings("ws-primary", agentId)).toEqual({});

    // Chunk 1 stored a raw JSON blob here; chunk 3's writer validates through
    // the contracts' AgentSettingsOverrides schema, so only conforming
    // payloads persist (the raw `{ temperature, tone }` payloads of the old
    // test are now rejections — pinned below, not summarized away).
    const overrides = {
      tool_defaults: [{ tool_id: "tool_web_search", config: { depth: "standard" } }],
    };
    repo.updateSettings("ws-primary", agentId, overrides);
    expect(repo.getSettings("ws-primary", agentId)).toEqual(overrides);

    // The blob is replaced wholesale at this layer; `null` normalizes to {}.
    repo.updateSettings("ws-primary", agentId, { tool_defaults: [] });
    expect(repo.getSettings("ws-primary", agentId)).toEqual({ tool_defaults: [] });

    // Non-conforming payloads are the typed rejection — never stored.
    expect(() => repo.updateSettings("ws-primary", agentId, { temperature: 0.2 })).toThrow(
      AgentSettingsValidationError,
    );
    expect(() => repo.updateSettings("ws-primary", agentId, { tone: "warm" })).toThrow(
      AgentSettingsValidationError,
    );
    const thrown = (() => {
      try {
        repo.updateSettings("ws-primary", agentId, { temperature: 0.2 });
      } catch (error) {
        return error as AgentSettingsValidationError;
      }
      throw new Error("expected a throw");
    })();
    expect(thrown.code).toBe("CONTRACT_VALIDATION_FAILED");
    expect(thrown.category).toBe("validation");
    expect(repo.getSettings("ws-primary", agentId)).toEqual({ tool_defaults: [] });

    expect(() => repo.updateSettings("ws-primary", "agent_missing", {})).toThrow(
      AgentNotFoundError,
    );
  });

  it("rejects stored settings JSON that no longer conforms (read-side validation)", () => {
    repo.upsertFromPack("ws-primary", studentManifest.agents);

    const agentId = "agent_general_assistant";
    // Simulate a legacy chunk-1 raw blob (or corruption) landing in the table
    // outside the typed writer: reading it back is the typed rejection, not a
    // silent fallback to {}.
    repo.updateSettings("ws-primary", agentId, {});
    conn.db
      .prepare(
        `UPDATE agent_settings SET settings_json = '{"tone":"warm"}'
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .run("ws-primary", agentId);
    expect(() => repo.getSettings("ws-primary", agentId)).toThrow(AgentSettingsValidationError);

    // Invalid JSON never reaches the read path at all: the v4 table carries a
    // json_valid CHECK constraint, so the repository's JSON.parse guard is a
    // second line of defense, not the only one.
    expect(() =>
      conn.db
        .prepare(
          `UPDATE agent_settings SET settings_json = 'not-json-at-all'
           WHERE workspace_id = ? AND agent_id = ?`,
        )
        .run("ws-primary", agentId),
    ).toThrow(/json_valid/);
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
    repo.updateSettings("ws-beta", "agent_general_assistant", {
      tool_defaults: [{ tool_id: "tool_web_search", config: {} }],
    });
    repo.addMemoryEntry("ws-beta", "agent_general_assistant", "beta memory");
    repo.addTaskHistoryEntry("ws-beta", "agent_general_assistant", "task-beta");

    expect(repo.listAgents("ws-alpha").every((agent) => agent.workspace_id === "ws-alpha")).toBe(
      true,
    );
    expect(repo.listAgents("ws-beta").every((agent) => agent.workspace_id === "ws-beta")).toBe(
      true,
    );
    expect(repo.listAgents("ws-alpha")).toHaveLength(6);
    expect(repo.listAgents("ws-beta")).toHaveLength(6);

    expect(repo.getAgent("ws-alpha", "agent_general_assistant")?.user_instructions).toBe(
      "alpha rules",
    );
    expect(repo.getAgent("ws-beta", "agent_general_assistant")?.user_instructions).toBeNull();

    expect(repo.getSettings("ws-alpha", "agent_general_assistant")).toEqual({});
    expect(repo.getSettings("ws-beta", "agent_general_assistant")).toEqual({
      tool_defaults: [{ tool_id: "tool_web_search", config: {} }],
    });

    expect(repo.listMemoryEntries("ws-alpha", "agent_general_assistant")).toEqual([]);
    expect(repo.listMemoryEntries("ws-beta", "agent_general_assistant")).toHaveLength(1);

    expect(repo.listTaskHistory("ws-alpha", "agent_general_assistant")).toEqual([]);
    expect(repo.listTaskHistory("ws-beta", "agent_general_assistant")).toHaveLength(1);

    expect(repo.getAgent("ws-alpha", "agent_does_not_exist")).toBeNull();
    expect(repo.listAgents("ws-unknown")).toEqual([]);
  });
});

/**
 * B5 race classification, pinned against the REAL driver (node:sqlite): the
 * get-or-create loser's failure is the (workspace_id, agent_id) primary-key
 * UNIQUE violation, and ONLY that. The service's catch path trusts this
 * predicate to decide between "re-read the winner" and "rethrow" — a
 * misclassification here either swallows real failures or turns the loser
 * path into a 500, so the exact driver error shape is pinned, not simulated.
 */
describe("isDirectChatConflict (B5 race classification — real driver errors)", () => {
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

  function insertBinding(workspaceId: string, agentId: string, conversationId: string): void {
    conn.db
      .prepare(
        `INSERT INTO agent_direct_chats (workspace_id, agent_id, conversation_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(workspaceId, agentId, conversationId, "2026-10-07T00:00:00.000Z");
  }

  function caught(run: () => void): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected the statement to throw");
  }

  it("classifies the real (workspace_id, agent_id) primary-key violation as the binding race", () => {
    // The winner's committed binding: the racing loser's insert fails on the
    // table's primary key — the exact error two concurrent first calls produce.
    insertBinding("ws-primary", "agent_one", "conv_winner");
    const loser = caught(() => insertBinding("ws-primary", "agent_one", "conv_loser"));

    expect((loser as { code?: unknown }).code).toBe("ERR_SQLITE_ERROR");
    expect((loser as Error).message).toBe(
      "UNIQUE constraint failed: agent_direct_chats.workspace_id, agent_direct_chats.agent_id",
    );
    expect(isDirectChatConflict(loser)).toBe(true);
  });

  it("does NOT classify the conversation-id UNIQUE violations as the binding race", () => {
    insertBinding("ws-primary", "agent_one", "conv_shared");
    // UNIQUE (workspace_id, conversation_id): claiming the SAME conversation
    // for a DIFFERENT agent is a different failure — never misread as the
    // get-or-create loser (whose re-read would be a lie here).
    const sameConversationOtherAgent = caught(() =>
      insertBinding("ws-primary", "agent_two", "conv_shared"),
    );
    expect((sameConversationOtherAgent as Error).message).toContain(
      "agent_direct_chats.conversation_id",
    );
    expect(isDirectChatConflict(sameConversationOtherAgent)).toBe(false);

    // The conversations table's own id collision is not a binding race either.
    const insertConversation = (id: string, title: string) =>
      conn.db
        .prepare(
          `INSERT INTO conversations (id, workspace_id, title, revision, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .run(id, "ws-primary", title, "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z");
    insertConversation("conv_dupe", "First");
    const conversationIdClash = caught(() => insertConversation("conv_dupe", "Second"));
    expect(isDirectChatConflict(conversationIdClash)).toBe(false);
  });

  it("does not classify non-driver failures or other UNIQUE violations", () => {
    // A plain Error with a matching message is NOT enough — the predicate
    // requires the driver's ERR_SQLITE_ERROR error code, so fabricated or
    // wrapped failures are never mistaken for the race.
    expect(
      isDirectChatConflict(
        new Error(
          "UNIQUE constraint failed: agent_direct_chats.workspace_id, agent_direct_chats.agent_id",
        ),
      ),
    ).toBe(false);
    // A real-driver-code error on a DIFFERENT table is not the binding race.
    expect(
      isDirectChatConflict(
        Object.assign(new Error("UNIQUE constraint failed: agents.workspace_id, agents.agent_id"), {
          code: "ERR_SQLITE_ERROR",
        }),
      ),
    ).toBe(false);
    expect(isDirectChatConflict(undefined)).toBe(false);
    expect(isDirectChatConflict("UNIQUE constraint failed: agent_direct_chats.agent_id")).toBe(
      false,
    );
    // The instance still works after the failed statements above.
    expect(repo.listAgents("ws-primary")).toEqual([]);
  });
});
