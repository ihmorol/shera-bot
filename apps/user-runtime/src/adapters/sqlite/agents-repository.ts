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
 * agent_settings stores ONLY the validated overrides blob: every write (and
 * read) parses through the contracts' AgentSettingsOverrides schema, so a
 * non-conforming payload is a typed CONTRACT_VALIDATION_FAILED rejection —
 * never silently stored JSON (S11 chunk 3 replaces chunk 1's raw blob).
 * agent_memory_entries and agent_task_history are private, per-agent ledger
 * placeholders: publication rules and cross-agent reads arrive with the
 * memory slice, so nothing here reads across agents.
 *
 * Direct chats (S11 chunk 2, D39): the agent_direct_chats mapping table is
 * agent-domain SQL, so its statements live HERE. The binding row is written
 * in the SAME transaction as the conversation row and its journal event (the
 * conversations service composes that unit); this repository only owns the
 * lookup and the insert. "Exactly one direct chat per (workspace, agent)" is
 * enforced by the table's primary key — a racing loser's insert fails the
 * UNIQUE constraint and re-reads the winner's binding (the B5 receipt
 * pattern; see isDirectChatConflict).
 */
import type { DatabaseSync } from "node:sqlite";

import { AgentSettingsOverrides } from "@shera-bot/contracts";

import type { SqliteTransactions } from "./transactions.ts";

/**
 * The pack-side agent shape this repository seeds from — a structural subset
 * of the agent-pack-sdk AgentManifest. The adapter does not import the SDK;
 * the seed helper below accepts a loaded PackManifest as-is. Every agent_id
 * must satisfy the AgentFolderUri host charset (AGENT_FOLDER_HOST_CHARSET):
 * the seeding boundary rejects anything else, because the private folder URI
 * `agent://<agent_id>/` is derived from the id and must stay valid forever.
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

/**
 * The typed "no such Agent in THIS workspace" rejection. Carries the same
 * stable code/category pair as the module service errors so the transport's
 * typed error middleware maps it onto the SheraError taxonomy (404) without
 * special-casing — and its message is never echoed to a client (G3).
 */
export class AgentNotFoundError extends Error {
  readonly code = "AGENT_NOT_FOUND" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, agentId: string) {
    super(`agent ${agentId} not found in workspace ${workspaceId}`);
    this.name = "AgentNotFoundError";
  }
}

/**
 * The typed rejection for settings that do not conform to the contracts'
 * AgentSettingsOverrides schema (S11 chunk 3: the validated writer replaced
 * chunk 1's raw blob). Carries the stable CONTRACT_VALIDATION_FAILED
 * code/category pair so the transport's typed error middleware answers 400
 * without special-casing — and its message is never echoed to a client (G3).
 */
export class AgentSettingsValidationError extends Error {
  readonly code = "CONTRACT_VALIDATION_FAILED" as const;
  readonly category = "validation" as const;

  constructor(context: string) {
    super(`${context} does not conform to AgentSettingsOverrides`);
    this.name = "AgentSettingsValidationError";
  }
}

/**
 * The typed rejection for a pack roster that names the same agent_id twice
 * (S11 fix round): the manifest schema rejects duplicate ids upstream, and
 * this defensive re-check keeps the roster unambiguous even for unvalidated
 * callers — but as the TYPED error, not a raw Error, so a seeding failure at
 * startup is a typed startup failure like the pack load above it (G4) and a
 * test can pin the exact rejection instead of a message string.
 */
export class AgentSeedConflictError extends Error {
  readonly code = "CONTRACT_VALIDATION_FAILED" as const;
  readonly category = "validation" as const;

  constructor(agentId: string) {
    super(`duplicate agent_id in pack roster: ${agentId}`);
    this.name = "AgentSeedConflictError";
  }
}

/**
 * The AgentFolderUri host charset (packages/contracts agent.ts) — the rule
 * every seeded agent_id must satisfy so the private folder root written at
 * seed time, `agent://<agent_id>/`, is a VALID AgentFolderUri forever. The
 * folder guard (agent-folders.service.ts) enforces the same charset when
 * parsing URIs; the contracts' AgentFolderUri schema is the shared authority.
 */
export const AGENT_FOLDER_HOST_CHARSET = /^[a-z0-9_-]+$/;

/**
 * The typed rejection for a pack roster whose agent_id cannot address its own
 * private folder: seeding writes `agent://<agent_id>/`, and an id outside the
 * AgentFolderUri host charset (uppercase, spaces, slashes, control characters)
 * would violate the folder URI contracts FOREVER — unparsable by the folder
 * guard, unusable by the memory slice. Rejected at the seeding boundary
 * instead of stranding a broken identity in the agents table. Carries the
 * stable CONTRACT_VALIDATION_FAILED code/category pair (validation-category:
 * malformed pack INPUT, not a runtime state failure).
 */
export class AgentSeedCharsetError extends Error {
  readonly code = "CONTRACT_VALIDATION_FAILED" as const;
  readonly category = "validation" as const;

  constructor(agentId: string) {
    super(
      `agent_id ${agentId} does not match the agent:// folder URI charset (lowercase letters, digits, '-', '_')`,
    );
    this.name = "AgentSeedCharsetError";
  }
}

/**
 * True when a direct-chat binding insert lost the race against the winner's
 * committed (workspace_id, agent_id) primary key (B5): THIS unit rolled back
 * atomically and the winner's binding is durable, so the caller re-reads and
 * resolves to it — the exact contract of the non-race path.
 */
export function isDirectChatConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("agent_direct_chats.workspace_id") &&
    error.message.includes("agent_direct_chats.agent_id")
  );
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
  upsertFromPack(workspaceId: string, packAgents: readonly PackAgentSeed[]): UpsertFromPackResult {
    return this.tx.transaction((db) => this.upsertFromPackWithin(workspaceId, packAgents, db));
  }

  private upsertFromPackWithin(
    workspaceId: string,
    packAgents: readonly PackAgentSeed[],
    db: DatabaseSync,
  ): UpsertFromPackResult {
    const existing = new Map(this.listAgents(workspaceId, db).map((row) => [row.agent_id, row]));
    const inserted: string[] = [];
    const updated: string[] = [];
    const incoming = new Set<string>();

    for (const agent of packAgents) {
      if (incoming.has(agent.agent_id)) {
        // The manifest schema rejects duplicates upstream; a re-check here
        // keeps the roster unambiguous even for unvalidated callers — typed,
        // so the startup composition fails with a named rejection (G4).
        throw new AgentSeedConflictError(agent.agent_id);
      }
      if (!AGENT_FOLDER_HOST_CHARSET.test(agent.agent_id)) {
        // The seed writes `agent://<agent_id>/`; an id outside the folder
        // charset would violate the AgentFolderUri contracts FOREVER. Every
        // roster entry is checked (insert AND refresh) so the seeding boundary
        // never blesses an identity its own folder URI cannot address.
        throw new AgentSeedCharsetError(agent.agent_id);
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
   * Replace the agent's settings overrides. THE validated writer (S11 chunk 3):
   * the payload is parsed through the contracts' AgentSettingsOverrides schema
   * BEFORE anything is stored — a non-conforming payload is the typed
   * AgentSettingsValidationError, never silently persisted JSON.
   */
  updateSettings(
    workspaceId: string,
    agentId: string,
    settings: unknown,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    this.requireAgent(workspaceId, agentId, db);
    const parsed = AgentSettingsOverrides.safeParse(settings ?? {});
    if (!parsed.success) {
      throw new AgentSettingsValidationError("agent settings payload");
    }
    db.prepare(
      `INSERT INTO agent_settings (workspace_id, agent_id, settings_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, agent_id) DO UPDATE SET
         settings_json = excluded.settings_json,
         updated_at = excluded.updated_at`,
    ).run(workspaceId, agentId, JSON.stringify(parsed.data), new Date().toISOString());
  }

  /**
   * The agent's validated settings overrides, or an empty object when none was
   * stored. A stored blob that no longer conforms (invalid JSON, schema drift)
   * is corruption: the typed rejection, not a silent fallback.
   */
  getSettings(workspaceId: string, agentId: string, exec?: DatabaseSync): AgentSettingsOverrides {
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
    let raw: unknown;
    try {
      raw = JSON.parse(row.settings_json);
    } catch {
      throw new AgentSettingsValidationError("stored agent settings JSON");
    }
    const parsed = AgentSettingsOverrides.safeParse(raw);
    if (!parsed.success) {
      throw new AgentSettingsValidationError("stored agent settings JSON");
    }
    return parsed.data;
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

  /**
   * The conversation id bound as this Agent's direct chat in THIS workspace,
   * or null when no direct chat exists yet (S11 chunk 2; D39). The binding
   * references the SAME agent_id as the agents row — one identity everywhere.
   */
  findDirectChat(workspaceId: string, agentId: string, exec?: DatabaseSync): string | null {
    const db = exec ?? this.tx.connection();
    const row = db
      .prepare(
        `SELECT conversation_id
         FROM agent_direct_chats
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  /**
   * Bind a conversation as the Agent's direct chat. Must run in the SAME
   * transaction that created the conversation row and its journal event (the
   * caller composes that unit). A racing duplicate fails on the primary key —
   * the caller detects it via isDirectChatConflict and re-reads the winner.
   */
  bindDirectChat(
    workspaceId: string,
    agentId: string,
    conversationId: string,
    createdAt: string,
    exec?: DatabaseSync,
  ): void {
    const db = exec ?? this.tx.connection();
    db.prepare(
      `INSERT INTO agent_direct_chats (workspace_id, agent_id, conversation_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(workspaceId, agentId, conversationId, createdAt);
  }

  private requireAgent(workspaceId: string, agentId: string, db: DatabaseSync): void {
    const row = db
      .prepare(`SELECT 1 AS present FROM agents WHERE workspace_id = ? AND agent_id = ?`)
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
