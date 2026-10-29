/**
 * Provider catalog repository (S23 chunk 1; PRD §9, §19 AC10/AC11, D17, D20,
 * D22, E9, E12, G3) — the only place provider-catalog SQL lives.
 *
 * Three STRICT tables (v15):
 *   - providers                  one configured provider entry per row
 *   - conversation_provider_overrides   the AC11 per-conversation override
 *   (provider_credentials lives in its own repository — the custody rows are
 *   the secret-shaped storage and stay out of every catalog read, G3.)
 *
 * Writer-side rules keep a provider entry honest: the display name, model id,
 * protocol, api_mode, and origin carry their PRD §9 vocabulary as schema
 * CHECKs; a base URL, when present, is http(s) only; the JSON columns are
 * objects. The repository NEVER sees or stores a credential — the schema has
 * no column for one (D22: the key's only storage is the sealed custody
 * table), and a secret-bearing header is refused by the service layer before
 * a row can exist (G3). Every read and write is workspace-scoped (E12); the
 * override writer validates BOTH the conversation and the provider in the
 * same workspace (the v5/v7 discipline — no FOREIGN KEY is declared).
 */
import type { DatabaseSync } from "node:sqlite";

import type { SqliteTransactions } from "./transactions.ts";

/** The PRD §9 protocol vocabulary (Ollama rides the OpenAI-compatible shape). */
export const PROVIDER_PROTOCOLS = [
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/** API key mode (custody applies) or no-key mode (local endpoints). */
export type ProviderApiMode = "api_key" | "no_key";

/** Who provisioned the entry (E9: platform credentials are admin-written). */
export type ProviderOrigin = "platform" | "user";

/** Enable/disable (PRD §9; a disabled provider resolves to nothing). */
export type ProviderStatus = "enabled" | "disabled";

/** Storage failure codes for the provider boundary (SCREAMING_SNAKE). */
export type ProvidersFailureCode =
  | "PROVIDER_ALREADY_EXISTS"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_CONFIG_INVALID"
  | "CONVERSATION_NOT_FOUND";

export class ProvidersRepositoryError extends Error {
  readonly code: ProvidersFailureCode;
  readonly category: "conflict" | "validation" | "state";

  constructor(
    code: ProvidersFailureCode,
    category: "conflict" | "validation" | "state",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProvidersRepositoryError";
    this.code = code;
    this.category = category;
  }
}

/** One durable provider entry, exactly as the table holds it. */
export interface ProviderRow {
  id: string;
  workspace_id: string;
  display_name: string;
  protocol: ProviderProtocol;
  /** Null = the protocol's native endpoint (native adapters only). */
  base_url: string | null;
  api_mode: ProviderApiMode;
  default_model_id: string;
  organization: string | null;
  project: string | null;
  /** Validated JSON object (the schema CHECK enforces object shape). */
  headers_json: string;
  /** Validated JSON object (the schema CHECK enforces object shape). */
  request_params_json: string;
  origin: ProviderOrigin;
  status: ProviderStatus;
  created_at: string;
  updated_at: string;
}

export interface ProviderCreateInput {
  id: string;
  workspace_id: string;
  display_name: string;
  protocol: ProviderProtocol;
  base_url: string | null;
  api_mode: ProviderApiMode;
  default_model_id: string;
  organization: string | null;
  project: string | null;
  headers_json: string;
  request_params_json: string;
  origin: ProviderOrigin;
  created_at: string;
}

/** The mutable configuration fields of one entry (identity/origin are fixed). */
export interface ProviderConfigPatch {
  display_name?: string;
  base_url?: string | null;
  default_model_id?: string;
  organization?: string | null;
  project?: string | null;
  headers_json?: string;
  request_params_json?: string;
  updated_at: string;
}

export interface ProviderOverrideInput {
  workspace_id: string;
  conversation_id: string;
  provider_id: string;
  /** Null = "use the provider's default model". */
  model: string | null;
  updated_at: string;
}

export interface ProviderOverrideRow {
  workspace_id: string;
  conversation_id: string;
  provider_id: string;
  model: string | null;
  updated_at: string;
}

/** Column bounds mirrored from the schema CHECKs (typed rejections first). */
const DISPLAY_NAME_MAX = 120;
const MODEL_ID_MAX = 256;
const HEADER_KEY_MAX = 128;
const HEADER_VALUE_MAX = 1024;
const PARAMS_JSON_MAX = 8_192;
const HEADERS_JSON_MAX = 8_192;

function httpBaseUrl(url: string): boolean {
  return /^https:\/\//.test(url) || /^http:\/\//.test(url);
}

/**
 * Validate the JSON-object columns: an object of string→string (headers) or
 * JSON scalars/arrays (request params), bounded. Typed refusal before any SQL
 * runs so a malformed shape never reaches the CHECK as an opaque constraint
 * error (G4 — the caller gets the named reason).
 */
function validateJsonColumns(input: { headers_json: string; request_params_json: string }): void {
  for (const [column, value, max, entryCheck] of [
    ["headers_json", input.headers_json, HEADERS_JSON_MAX, true],
    ["request_params_json", input.request_params_json, PARAMS_JSON_MAX, false],
  ] as const) {
    if (value.length > max) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `${column} exceeds ${max} characters`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `${column} is not valid JSON`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `${column} must be a JSON object`,
      );
    }
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (key.length === 0 || key.length > HEADER_KEY_MAX) {
        throw new ProvidersRepositoryError(
          "PROVIDER_CONFIG_INVALID",
          "validation",
          `${column} has a key outside 1..${HEADER_KEY_MAX} characters`,
        );
      }
      if (entryCheck) {
        if (typeof entry !== "string" || entry.length > HEADER_VALUE_MAX) {
          throw new ProvidersRepositoryError(
            "PROVIDER_CONFIG_INVALID",
            "validation",
            `${column} values must be strings of at most ${HEADER_VALUE_MAX} characters`,
          );
        }
      } else if (
        !["string", "number", "boolean"].includes(typeof entry) ||
        (typeof entry === "string" && entry.length > 1024)
      ) {
        throw new ProvidersRepositoryError(
          "PROVIDER_CONFIG_INVALID",
          "validation",
          `${column} values must be JSON scalars (string/number/boolean)`,
        );
      }
    }
  }
}

export class ProvidersRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  private db(exec?: DatabaseSync): DatabaseSync {
    return exec ?? this.tx.connection();
  }

  /** Insert one entry; identity (workspace_id, id) is unique by primary key. */
  create(input: ProviderCreateInput, exec?: DatabaseSync): ProviderRow {
    const db = this.db(exec);
    if (!PROVIDER_PROTOCOLS.includes(input.protocol)) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `protocol ${input.protocol} is not one of ${PROVIDER_PROTOCOLS.join(", ")}`,
      );
    }
    const displayName = input.display_name.trim();
    if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `display_name must be 1..${DISPLAY_NAME_MAX} characters`,
      );
    }
    if (
      input.default_model_id.trim().length === 0 ||
      input.default_model_id.length > MODEL_ID_MAX
    ) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `default_model_id must be 1..${MODEL_ID_MAX} characters`,
      );
    }
    if (input.base_url !== null && !httpBaseUrl(input.base_url)) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        "base_url must be an http:// or https:// URL (null for native adapters)",
      );
    }
    validateJsonColumns(input);
    try {
      db.prepare(
        `INSERT INTO providers (
           workspace_id, id, display_name, protocol, base_url, api_mode,
           default_model_id, organization, project, headers_json,
           request_params_json, origin, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?)`,
      ).run(
        input.workspace_id,
        input.id,
        displayName,
        input.protocol,
        input.base_url,
        input.api_mode,
        input.default_model_id.trim(),
        input.organization,
        input.project,
        input.headers_json,
        input.request_params_json,
        input.origin,
        input.created_at,
        input.created_at,
      );
    } catch (error) {
      // UNIQUE primary-key violation → the typed already-exists refusal; the
      // CHECK constraints should never fire (validation above runs first).
      if (
        error instanceof Error &&
        (error as { code?: unknown }).code === "ERR_SQLITE_ERROR" &&
        error.message.includes("UNIQUE constraint failed") &&
        error.message.includes("providers.workspace_id")
      ) {
        throw new ProvidersRepositoryError(
          "PROVIDER_ALREADY_EXISTS",
          "conflict",
          `provider ${input.id} already exists in this workspace`,
        );
      }
      throw error;
    }
    return this.get(input.workspace_id, input.id, exec)!;
  }

  get(workspaceId: string, providerId: string, exec?: DatabaseSync): ProviderRow | null {
    const row = this.db(exec)
      .prepare(
        `SELECT id, workspace_id, display_name, protocol, base_url, api_mode,
                default_model_id, organization, project, headers_json,
                request_params_json, origin, status, created_at, updated_at
         FROM providers
         WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, providerId) as ProviderRow | undefined;
    return row ?? null;
  }

  /** All of a workspace's entries, oldest first (stable for the UI list). */
  list(workspaceId: string, exec?: DatabaseSync): ProviderRow[] {
    return this.db(exec)
      .prepare(
        `SELECT id, workspace_id, display_name, protocol, base_url, api_mode,
                default_model_id, organization, project, headers_json,
                request_params_json, origin, status, created_at, updated_at
         FROM providers
         WHERE workspace_id = ?
         ORDER BY created_at, id`,
      )
      .all(workspaceId) as unknown as ProviderRow[];
  }

  /** Update the mutable configuration; unknown ids are typed refusals (E12). */
  updateConfig(
    workspaceId: string,
    providerId: string,
    patch: ProviderConfigPatch,
    exec?: DatabaseSync,
  ): ProviderRow {
    const db = this.db(exec);
    const existing = this.get(workspaceId, providerId, exec);
    if (!existing) {
      throw new ProvidersRepositoryError(
        "PROVIDER_NOT_FOUND",
        "state",
        `provider ${providerId} does not exist in this workspace`,
      );
    }
    if (patch.display_name !== undefined) {
      const trimmed = patch.display_name.trim();
      if (trimmed.length === 0 || trimmed.length > DISPLAY_NAME_MAX) {
        throw new ProvidersRepositoryError(
          "PROVIDER_CONFIG_INVALID",
          "validation",
          `display_name must be 1..${DISPLAY_NAME_MAX} characters`,
        );
      }
    }
    if (patch.default_model_id !== undefined) {
      const trimmed = patch.default_model_id.trim();
      if (trimmed.length === 0 || trimmed.length > MODEL_ID_MAX) {
        throw new ProvidersRepositoryError(
          "PROVIDER_CONFIG_INVALID",
          "validation",
          `default_model_id must be 1..${MODEL_ID_MAX} characters`,
        );
      }
    }
    if (patch.base_url !== undefined && patch.base_url !== null && !httpBaseUrl(patch.base_url)) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        "base_url must be an http:// or https:// URL (null for native adapters)",
      );
    }
    if (patch.headers_json !== undefined || patch.request_params_json !== undefined) {
      validateJsonColumns({
        headers_json: patch.headers_json ?? existing.headers_json,
        request_params_json: patch.request_params_json ?? existing.request_params_json,
      });
    }
    db.prepare(
      `UPDATE providers
       SET display_name   = COALESCE(?, display_name),
           base_url       = ?,
           default_model_id = COALESCE(?, default_model_id),
           organization   = ?,
           project        = ?,
           headers_json   = COALESCE(?, headers_json),
           request_params_json = COALESCE(?, request_params_json),
           updated_at     = ?
       WHERE workspace_id = ? AND id = ?`,
    ).run(
      patch.display_name?.trim() ?? null,
      patch.base_url !== undefined ? patch.base_url : existing.base_url,
      patch.default_model_id?.trim() ?? null,
      patch.organization !== undefined ? patch.organization : existing.organization,
      patch.project !== undefined ? patch.project : existing.project,
      patch.headers_json ?? null,
      patch.request_params_json ?? null,
      patch.updated_at,
      workspaceId,
      providerId,
    );
    return this.get(workspaceId, providerId, exec)!;
  }

  /** Enable/disable (PRD §9); a disabled provider resolves to nothing. */
  setStatus(
    workspaceId: string,
    providerId: string,
    status: ProviderStatus,
    updatedAt: string,
    exec?: DatabaseSync,
  ): ProviderRow {
    const db = this.db(exec);
    const result = db
      .prepare(
        `UPDATE providers SET status = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(status, updatedAt, workspaceId, providerId);
    if (result.changes === 0) {
      throw new ProvidersRepositoryError(
        "PROVIDER_NOT_FOUND",
        "state",
        `provider ${providerId} does not exist in this workspace`,
      );
    }
    return this.get(workspaceId, providerId, exec)!;
  }

  /**
   * Set (or replace) one conversation's override. Both the conversation and
   * the provider are validated in the SAME workspace before the write (E12;
   * the v5/v7 discipline — no FOREIGN KEY is declared).
   */
  setOverride(input: ProviderOverrideInput, exec?: DatabaseSync): ProviderOverrideRow {
    const db = this.db(exec);
    const conversation = db
      .prepare("SELECT id FROM conversations WHERE workspace_id = ? AND id = ?")
      .get(input.workspace_id, input.conversation_id);
    if (!conversation) {
      throw new ProvidersRepositoryError(
        "CONVERSATION_NOT_FOUND",
        "state",
        `conversation ${input.conversation_id} does not exist in this workspace`,
      );
    }
    if (!this.get(input.workspace_id, input.provider_id, exec)) {
      throw new ProvidersRepositoryError(
        "PROVIDER_NOT_FOUND",
        "state",
        `provider ${input.provider_id} does not exist in this workspace`,
      );
    }
    if (
      input.model !== null &&
      (input.model.trim().length === 0 || input.model.length > MODEL_ID_MAX)
    ) {
      throw new ProvidersRepositoryError(
        "PROVIDER_CONFIG_INVALID",
        "validation",
        `model must be 1..${MODEL_ID_MAX} characters or null`,
      );
    }
    db.prepare(
      `INSERT INTO conversation_provider_overrides
         (workspace_id, conversation_id, provider_id, model, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, conversation_id)
       DO UPDATE SET provider_id = excluded.provider_id,
                     model = excluded.model,
                     updated_at = excluded.updated_at`,
    ).run(
      input.workspace_id,
      input.conversation_id,
      input.provider_id,
      input.model,
      input.updated_at,
    );
    return this.getOverride(input.workspace_id, input.conversation_id, exec)!;
  }

  getOverride(
    workspaceId: string,
    conversationId: string,
    exec?: DatabaseSync,
  ): ProviderOverrideRow | null {
    const row = this.db(exec)
      .prepare(
        `SELECT workspace_id, conversation_id, provider_id, model, updated_at
         FROM conversation_provider_overrides
         WHERE workspace_id = ? AND conversation_id = ?`,
      )
      .get(workspaceId, conversationId) as ProviderOverrideRow | undefined;
    return row ?? null;
  }

  clearOverride(workspaceId: string, conversationId: string, exec?: DatabaseSync): boolean {
    const result = this.db(exec)
      .prepare(
        `DELETE FROM conversation_provider_overrides
         WHERE workspace_id = ? AND conversation_id = ?`,
      )
      .run(workspaceId, conversationId);
    return result.changes > 0;
  }
}
