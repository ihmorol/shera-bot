/**
 * Provider credential custody service (S23 chunk 2; D22, E9, PRD §9, §12,
 * §16, G3) — the runtime's single custody boundary for provider keys.
 *
 * CUSTODY RULES (E9, D22, the recorded reading of PRD §9/§12):
 *  - a credential lives ONLY here: sealed at rest in the container-local
 *    SQLite custody table, under a container-local 0600 key file;
 *  - `decryptForCall` is the ONLY plaintext-producing path, and it exists for
 *    exactly one caller shape: the adapter assembling one provider request.
 *    The plaintext is consumed in-process and never persisted, logged,
 *    journalled, or returned through any API;
 *  - display answers the store-time MASKED HINT only (at most the final four
 *    characters, persisted beside the seal) — the ciphertext is never opened
 *    for display;
 *  - revoke deletes the sealed payload; replace upserts a new one — a
 *    replaced key takes effect on the NEXT call (the service holds no
 *    plaintext cache, so no restart is ever needed);
 *  - a missing credential is a TYPED state (PROVIDER_CREDENTIAL_REVOKED), the
 *    caller's signal to surface a clear configuration state (G4) — never a
 *    reason to fall back to anything.
 *
 * Admin provisioning (E9) stores the platform credential through this same
 * service and never reads it back.
 */
import type { SqliteExec } from "../../adapters/sqlite/transactions.ts";
import type { ProviderCredentialsRepository } from "../../adapters/sqlite/provider-credentials-repository.ts";
import {
  ProviderCredentialError,
  ProviderCredentialVault,
  maskProviderSecret,
} from "./provider-credential-vault.ts";

export {
  ProviderCredentialError,
  ProviderCredentialVault,
  maskProviderSecret,
} from "./provider-credential-vault.ts";

/** The secret bounds: 1..8192 characters, trimmed non-empty. */
const SECRET_MAX_CHARS = 8_192;

export class ProviderCredentialsService {
  constructor(
    private readonly deps: {
      vault: ProviderCredentialVault;
      credentials: ProviderCredentialsRepository;
    },
  ) {}

  /**
   * Store (or replace) the credential for one provider entry. The secret is
   * sealed immediately and reduced to its mask; only the sealed payload and
   * the masked hint survive this call.
   */
  store(workspaceId: string, providerId: string, secret: string, now: string): void {
    const trimmed = secret.trim();
    if (trimmed.length === 0 || trimmed.length > SECRET_MAX_CHARS) {
      throw new ProviderCredentialError(
        "PROVIDER_CREDENTIAL_INVALID",
        `a credential must be 1..${SECRET_MAX_CHARS} characters`,
      );
    }
    const sealed = this.deps.vault.seal(trimmed);
    this.deps.credentials.store({
      workspace_id: workspaceId,
      provider_id: providerId,
      credential_hint: maskProviderSecret(trimmed),
      ...sealed,
      updated_at: now,
    });
  }

  /** Revoke = the sealed payload is deleted (D22: revocable). */
  revoke(workspaceId: string, providerId: string): boolean {
    return this.deps.credentials.delete(workspaceId, providerId);
  }

  hasCredential(workspaceId: string, providerId: string, exec?: SqliteExec): boolean {
    return this.deps.credentials.has(workspaceId, providerId, exec);
  }

  /** The store-time masked hint for display; null when none is stored. */
  credentialHint(workspaceId: string, providerId: string, exec?: SqliteExec): string | null {
    return this.deps.credentials.getHint(workspaceId, providerId, exec);
  }

  /**
   * The ONLY plaintext-producing path — call-time decryption for one provider
   * request (D22). A revoked (or never-stored) credential is a typed
   * configuration state, not an exception to recover from.
   */
  decryptForCall(workspaceId: string, providerId: string, exec?: SqliteExec): string {
    const sealed = this.deps.credentials.getSealed(workspaceId, providerId, exec);
    if (!sealed) {
      throw new ProviderCredentialError(
        "PROVIDER_CREDENTIAL_REVOKED",
        `provider ${providerId} has no stored credential in this workspace`,
      );
    }
    return this.deps.vault.open(sealed);
  }
}
