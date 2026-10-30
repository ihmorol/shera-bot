/**
 * Provider credential custody repository (S23 chunk 2; D22, E9, E12, G3) —
 * the ONLY storage a provider key may have: sealed AES-256-GCM payloads in
 * the v15 `provider_credentials` table. No plaintext column exists anywhere
 * in the schema, so an at-rest byte scan of this database can never surface a
 * provider key. `credential_hint` is the mask computed at store time (at most
 * the final four characters) — the display value D22's UI rule shows, kept
 * beside the seal so the ciphertext is NEVER opened for display. Every read
 * and write is workspace-scoped (E12) and the writer validates the provider
 * row in the same workspace (the v4/v5 discipline).
 */
import type { DatabaseSync } from "node:sqlite";

import type { SealedSecret } from "../../modules/providers/provider-credential-vault.ts";
import type { SqliteTransactions } from "./transactions.ts";

export class ProviderCredentialsRepositoryError extends Error {
  readonly code: "PROVIDER_NOT_FOUND";

  constructor(message: string) {
    super(`PROVIDER_NOT_FOUND: ${message}`);
    this.name = "ProviderCredentialsRepositoryError";
    this.code = "PROVIDER_NOT_FOUND";
  }
}

export interface ProviderCredentialRow {
  workspace_id: string;
  provider_id: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
  credential_hint: string;
  created_at: string;
  updated_at: string;
}

export class ProviderCredentialsRepository {
  constructor(private readonly tx: SqliteTransactions) {}

  private db(exec?: DatabaseSync): DatabaseSync {
    return exec ?? this.tx.connection();
  }

  /** Upsert the sealed payload (and its store-time hint) for one entry. */
  store(
    input: {
      workspace_id: string;
      provider_id: string;
      credential_hint: string;
    } & SealedSecret & { updated_at: string },
    exec?: DatabaseSync,
  ): void {
    const db = this.db(exec);
    const provider = db
      .prepare("SELECT id FROM providers WHERE workspace_id = ? AND id = ?")
      .get(input.workspace_id, input.provider_id);
    if (!provider) {
      throw new ProviderCredentialsRepositoryError(
        `provider ${input.provider_id} does not exist in this workspace`,
      );
    }
    const existing = this.getSealed(input.workspace_id, input.provider_id, exec);
    if (existing) {
      db.prepare(
        `UPDATE provider_credentials
         SET ciphertext = ?, iv = ?, tag = ?, key_version = ?, credential_hint = ?, updated_at = ?
         WHERE workspace_id = ? AND provider_id = ?`,
      ).run(
        input.ciphertext,
        input.iv,
        input.tag,
        input.key_version,
        input.credential_hint,
        input.updated_at,
        input.workspace_id,
        input.provider_id,
      );
      return;
    }
    db.prepare(
      `INSERT INTO provider_credentials
         (workspace_id, provider_id, ciphertext, iv, tag, key_version, credential_hint,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.workspace_id,
      input.provider_id,
      input.ciphertext,
      input.iv,
      input.tag,
      input.key_version,
      input.credential_hint,
      input.updated_at,
      input.updated_at,
    );
  }

  getSealed(
    workspaceId: string,
    providerId: string,
    exec?: DatabaseSync,
  ): (SealedSecret & { credential_hint: string; created_at: string; updated_at: string }) | null {
    const row = this.db(exec)
      .prepare(
        `SELECT ciphertext, iv, tag, key_version, credential_hint, created_at, updated_at
         FROM provider_credentials
         WHERE workspace_id = ? AND provider_id = ?`,
      )
      .get(workspaceId, providerId) as
      | (SealedSecret & { credential_hint: string; created_at: string; updated_at: string })
      | undefined;
    return row ?? null;
  }

  /** The store-time masked hint (display only — the seal is never opened). */
  getHint(workspaceId: string, providerId: string, exec?: DatabaseSync): string | null {
    return this.getSealed(workspaceId, providerId, exec)?.credential_hint ?? null;
  }

  has(workspaceId: string, providerId: string, exec?: DatabaseSync): boolean {
    return this.getSealed(workspaceId, providerId, exec) !== null;
  }

  /** Revocation = DELETE: the sealed payload ceases to exist (D22). */
  delete(workspaceId: string, providerId: string, exec?: DatabaseSync): boolean {
    const result = this.db(exec)
      .prepare("DELETE FROM provider_credentials WHERE workspace_id = ? AND provider_id = ?")
      .run(workspaceId, providerId);
    return result.changes > 0;
  }
}
