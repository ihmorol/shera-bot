/**
 * Agent identity repository (S11 chunk 1; D32 layer 1, D39) — the only place
 * agent SQL lives.
 *
 * Vocabulary is Pack → Operations → Agents: an Agent is a durable identity
 * seeded from the workspace's pinned pack. "Expert" is a forbidden historical
 * alias and never appears as an object here.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL (E12): every method takes workspace_id
 * and every statement keys rows by it. The agents table's primary key is
 * (workspace_id, agent_id) — the same agent_id in two workspaces are
 * independent rows, so every workspace can seed the same pinned pack.
 *
 * Pack-owned vs user-owned fields: upsertFromPack refreshes the pack-owned
 * fields (display_name, role_description, ui_identity, capabilities_json,
 * home_operation_id) and NEVER overwrites user_instructions or the default
 * provider pair — updateDefaultProvider is the user's mutation path, and a
 * re-seed must not undo it. Pack agents removed by a newer pack version are
 * left in place (removal is a product decision, not a re-seed side effect)
 * and reported as orphaned in the upsert result.
 *
 * agent_settings stores a raw JSON blob at this layer; the typed D16 per-agent
 * command surface replaces it in S11 chunk 2. agent_memory_entries and
 * agent_task_history are private, per-agent ledger placeholders: publication
 * rules and cross-agent reads arrive with the memory slice, so nothing here
 * reads across agents.
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

/**
 * The pack-side agent shape this repository seeds from — a structural subset
 * of the agent-pack-sdk AgentManifest. The adapter does not import the SDK;
 * the seed helper below accepts a loaded PackManifest as-is.
 */
export interface PackAgentSeed {
  agent_id: string;
  display_name: string;
  role_description: string;
  default_provider: { provider_id: string; model: string };
  skills: readonly string[];
  tools: readonly { tool_id: string; version: string }[];
  connectors: readonly string[];
  ui_identity: { avatar_hue: number; initial_glyph: string };
  home_operation_id: string | null;
}

export interface AgentRow {
  agent_id: string;
  workspace_id: string;
  display_name: string;
  role_description: string;
  avatar_hue: number;
  initial_glyph: string;
  default_provider_id: string;
  default_provider_model: string;
  /** User-editable layer above the pack's fixed role_description; nullable. */
  user_instructions: string | null;
  /** skills + tools + connectors copied from the pack manifest. */
  capabilities_json: string;
  /** The agent's private folder URI: agent://<agent_id>/. */
  private_folder_path: string;
  home_operation_id: string | null;
  is_seeded_from_pack: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMemoryEntryRow {
  id: number;
  workspace_id: string;
  agent_id: string;
  content: string;
  created_at: string;
}

export interface AgentTaskHistoryRow {
  id: number;
  workspace_id: string;
  agent_id: string;
  task_id: string;
  created_at: string;
}

export interface UpsertFromPackResult {
  inserted_agent_ids: string[];
  updated_agent_ids: string[];
  /** Previously seeded agents absent from the incoming roster (left in place). */
  orphaned_agent_ids: string[];
}

export class AgentNotFoundError extends Error {
  constructor(workspaceId: string, agentId: string) {
    super(`agent ${agentId} not found in workspace ${workspaceId}`);
    this.name = "AgentNotFoundError";
  }
}

const AGENT_COLUMNS = `
  agent_id,
  workspace_id,
  display_name,
  role_description,
  avatar_hue,
  initial_glyph,
  default_provider_id,
  default_provider_model,
  user_instructions,
  capabilities_json,
  private_folder_path,
  home_operation_id,
  is_seeded_from_pack,
  created_at,
  updated_at`;

export class AgentsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  /**
   * Seed (or re-seed) the workspace's agents from the pinned pack's agent
   * roster. Idempotent: new agents insert, existing agents refresh their
   * pack-owned fields only when they actually changed, user-owned fields are
   * never touched, and roster removals are reported — not deleted. Runs in
   * one short transaction; a call inside an open transaction joins it.
   */
  upsertFromPack(
    workspaceId: string,
    packAgents: readonly PackAgentSeed[],
  ): UpsertFromPackResult {
    return this.tx.transaction((db) =>
      this.upsertFromPackWithin(workspaceId, packAgents, db),
    );
  }

  private upsertFromPackWithin(
    workspaceId: string,
    packAgents: readonly PackAgentSeed[],
    db: DatabaseSync,
  ): UpsertFromPackResult {
    const existing = new Map(
      this.listAgents(workspaceId, db).map((row) => [row.agent_id, row]),
    );
    const inserted: string[] = [];
    const updated: string[] = [];
    const incoming = new Set<string>();

    for (const agent of packAgents) {
      if (incoming.has(agent.agent_id)) {
        // The manifest schema rejects duplicates upstream; a re-check here
        // keeps the roster unambiguous even for unvalidated callers.
        throw new Error(`duplicate agent_id in pack roster: ${agent.agent_id}`);
      }
      incoming.add(agent.agent_id);

      const capabilitiesJson = JSON.stringify({
        skills: agent.skills,
        tools: agent.tools,
        connectors: agent.connectors,
      });
      const current = existing.get(agent.agent_id);

      if (current === undefined) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO agents (
             agent_id, workspace_id, display_name, role_description,
             avatar_hue, initial_glyph, default_provider_id, default_provider_model,
             user_instructions, capabilities_json, private_folder_path,
             home_operation_id, is_seeded_from_pack, created_at, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?)`,
        ).run(
          agent.agent_id,
          workspaceId,
          agent.display_name,
          agent.role_description,
          agent.ui_identity.avatar_hue,
          agent.ui_identity.initial_glyph,
          agent.default_provider.provider_id,
          agent.default_provider.model,
          capabilitiesJson,
          `agent://${agent.agent_id}/`,
          agent.home_operation_id,
          now,
          now,
        );
        inserted.push(agent.agent_id);
        continue;
      }

      const changed =
        current.display_name !== agent.display_name ||
        current.role_description !== agent.role_description ||
        current.avatar_hue !== agent.ui_identity.avatar_hue ||
        current.initial_glyph !== agent.ui_identity.initial_glyph ||
        current.home_operation_id !== agent.home_operation_id ||
        current.capabilities_json !== capabilitiesJson;

      if (changed) {
        db.prepare(
          `UPDATE agents
           SET display_name = ?,
               role_description = ?,
               avatar_hue = ?,
               initial_glyph = ?,
               home_operation_id = ?,
               capabilities_json = ?,
               is_seeded_from_pack = 1,
               updated_at = ?
           WHERE workspace_id = ? AND agent_id = ?`,
        ).run(
          agent.display_name,
          agent.role_description,
          agent.ui_identity.avatar_hue,
          agent.ui_identity.initial_glyph,
          agent.home_operation_id,
          capabilitiesJson,
          new Date().toISOString(),
          workspaceId,
          agent.agent_id,
        );
        updated.push(agent.agent_id);
      }
    }

    const orphaned_agent_ids = [...existing.keys()]
      .filter((agentId) => !incoming.has(agentId))
      .sort();
    return {
      inserted_agent_ids: inserted.sort(),
      updated_agent_ids: updated.sort(),
      orphaned_agent_ids,
    };
  }

  listAgents(workspaceId: string, exec?: DatabaseSync): AgentRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT ${AGENT_COLUMNS}
         FROM agents
         WHERE workspace_id = ?
         ORDER BY agent_id`,
      )
      .all(workspaceId) as unknown as AgentRow[];
  }

  getAgent(workspaceId: string, agentId: string, exec?: DatabaseSync): AgentRow | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT ${AGENT_COLUMNS}
         FROM agents
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId) as AgentRow | undefined;
    return row ?? null;
  }

  updateUserInstructions(
    workspaceId: string,
    agentId: string,
    instructions: string | null,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE agents
         SET user_instructions = ?, updated_at = ?
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .run(instructions, new Date().toISOString(), workspaceId, agentId);
    if (Number(result.changes) === 0) {
      throw new AgentNotFoundError(workspaceId, agentId);
    }
  }

  updateDefaultProvider(
    workspaceId: string,
    agentId: string,
    providerId: string,
    model: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    const result = db
      .prepare(
        `UPDATE agents
         SET default_provider_id = ?,
             default_provider_model = ?,
             updated_at = ?
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .run(providerId, model, new Date().toISOString(), workspaceId, agentId);
    if (Number(result.changes) === 0) {
      throw new AgentNotFoundError(workspaceId, agentId);
    }
  }

  /**
   * Replace the agent's raw settings blob. Chunk 1 stores plain JSON; the
   * typed D16 command surface (chunk 2) becomes the validated writer.
   */
  updateSettings(
    workspaceId: string,
    agentId: string,
    settings: unknown,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    this.requireAgent(workspaceId, agentId, db);
    db.prepare(
      `INSERT INTO agent_settings (workspace_id, agent_id, settings_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, agent_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = excluded.updated_at`,
    ).run(
      workspaceId,
      agentId,
      JSON.stringify(settings ?? {}),
      new Date().toISOString(),
    );
  }

  /** The agent's settings blob, or an empty object when none was stored. */
  getSettings(workspaceId: string, agentId: string, exec?: DatabaseSync): unknown {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT settings_json
         FROM agent_settings
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId) as { settings_json: string } | undefined;
    if (row === undefined) {
      return {};
    }
    return JSON.parse(row.settings_json) as unknown;
  }

  /** Append to the agent's private memory ledger (no cross-agent reads). */
  addMemoryEntry(
    workspaceId: string,
    agentId: string,
    content: string,
    exec?: DatabaseSync,
  ): AgentMemoryEntryRow {
    const db = exec ?? this.tx.connection();
    this.requireAgent(workspaceId, agentId, db);
    const created_at = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO agent_memory_entries (workspace_id, agent_id, content, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(workspaceId, agentId, content, created_at);
    return {
      id: Number(result.lastInsertRowid),
      workspace_id: workspaceId,
      agent_id: agentId,
      content,
      created_at,
    };
  }

  listMemoryEntries(
    workspaceId: string,
    agentId: string,
    exec?: DatabaseSync,
  ): AgentMemoryEntryRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT id, workspace_id, agent_id, content, created_at
         FROM agent_memory_entries
         WHERE workspace_id = ? AND agent_id = ?
         ORDER BY id`,
      )
      .all(workspaceId, agentId) as unknown as AgentMemoryEntryRow[];
  }

  /** Append to the agent's task history ledger (placeholder for the task slice). */
  addTaskHistoryEntry(
    workspaceId: string,
    agentId: string,
    taskId: string,
    exec?: DatabaseSync,
  ): AgentTaskHistoryRow {
    const db = exec ?? this.tx.connection();
    this.requireAgent(workspaceId, agentId, db);
    const created_at = new Date().toISOString();
    const result = db
      .prepare(
        `INSERT INTO agent_task_history (workspace_id, agent_id, task_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(workspaceId, agentId, taskId, created_at);
    return {
      id: Number(result.lastInsertRowid),
      workspace_id: workspaceId,
      agent_id: agentId,
      task_id: taskId,
      created_at,
    };
  }

  listTaskHistory(
    workspaceId: string,
    agentId: string,
    exec?: DatabaseSync,
  ): AgentTaskHistoryRow[] {
    const db = exec ?? this.tx.connection();
    return db
      .prepare(
        `SELECT id, workspace_id, agent_id, task_id, created_at
         FROM agent_task_history
         WHERE workspace_id = ? AND agent_id = ?
         ORDER BY id`,
      )
      .all(workspaceId, agentId) as unknown as AgentTaskHistoryRow[];
  }

  private requireAgent(workspaceId: string, agentId: string, db: DatabaseSync): void {
    const row = db
      .prepare(
        `SELECT 1 AS present FROM agents WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId) as { present: number } | undefined;
    if (row === undefined) {
      throw new AgentNotFoundError(workspaceId, agentId);
    }
  }
}

/**
 * Seed the workspace's agents from a LOADED pack manifest — pure wiring only:
 * no filesystem access, no startup composition (S11 chunk 2 owns that). Takes
 * the manifest object as loaded by loadWorkspacePack / BuiltInPackLoader and
 * forwards its agents roster to upsertFromPack. Idempotent per re-seed rules.
 */
export function seedAgentsFromPack(
  tx: SqliteTransactions,
  workspaceId: string,
  manifest: { agents: readonly PackAgentSeed[] },
): UpsertFromPackResult {
  return new AgentsRepository(tx).upsertFromPack(workspaceId, manifest.agents);
}
