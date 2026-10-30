/**
 * Provider credential vault (S23 chunk 2; D22, E9, PRD §9, §12, G3) —
 * AES-256-GCM custody INSIDE the user container.
 *
 * CUSTODY SHAPE (D22): provider credentials are "encrypted inside the user
 * container, decrypted only at call time". This module is the single
 * encryption boundary for provider keys: the custody service seals at store
 * time and opens ONLY when an adapter is about to call the provider. No API
 * surface reads a key back — the API answers masked hints, and revoke +
 * re-store (replace) are the only lifecycle moves.
 *
 * KEY MANAGEMENT (the prototype stance, documented): the AES-256 key is a
 * random 32-byte value generated on first use and persisted in a container-
 * local key file placed beside the database (the composition passes the path;
 * the directory is the same user-container volume that already holds the
 * SQLite product state). This is the "protected bootstrap key" of D22 in its
 * prototype form — the container volume is the trust boundary; a
 * deployment-grade secret manager is the production replacement and is
 * exactly why the vault is a seam the composition wires, not a global. A
 * missing key file is generated ONCE; an unreadable or wrong-length EXISTING
 * key file is a typed failure (G4) — never a silent re-key (which would
 * brick every stored ciphertext).
 *
 * FORMAT: one sealed payload = 12-byte random iv + ciphertext + 16-byte GCM
 * auth tag, stored as three columns on the custody row (v18). key_version
 * records the generation of the key that sealed it (1 until a rotation slice
 * exists); decryption verifies the tag — tampered or foreign-key ciphertext
 * fails closed (never plaintext, never a guess).
 *
 * Construction note: this is the SAME construction S19's project-credential
 * vault established (the recorded D22/E9 reading). S19's module is not on
 * main at this branch's base, so the shape is restated here for provider
 * keys; consolidation into one shared vault module is an integration-time
 * cleanup the orchestrator can make when the sibling branches merge.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export class ProviderCredentialError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`provider credential: ${message}`);
    this.name = "ProviderCredentialError";
    this.code = code;
  }
}

/** One sealed (encrypted) secret: the exact shapes the v18 row stores. */
export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  key_version: number;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The key-file generation this vault writes and reads (a rotation slice bumps it). */
const KEY_VERSION = 1;

export class ProviderCredentialVault {
  private key: Buffer | null = null;

  constructor(private readonly keyPath: string) {}

  /**
   * Load the container-local key, generating it on first use. Failure to read
   * an EXISTING key file is a typed hard failure (G4): silently generating a
   * new key would orphan every stored credential.
   */
  private loadKey(): Buffer {
    if (this.key !== null) {
      return this.key;
    }
    let existing: Buffer;
    try {
      existing = readFileSync(this.keyPath);
    } catch (error) {
      const missing =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT";
      if (!missing) {
        throw new ProviderCredentialError(
          "PROVIDER_CREDENTIAL_KEY_UNREADABLE",
          "the key file could not be read",
        );
      }
      const key = randomBytes(KEY_BYTES);
      // Owner-only: the key file is the D22 bootstrap key — a 0644 default
      // would hand every same-host process the whole vault.
      writeFileSync(this.keyPath, key, { mode: 0o600 });
      this.key = key;
      return key;
    }
    if (existing.length !== KEY_BYTES) {
      throw new ProviderCredentialError(
        "PROVIDER_CREDENTIAL_KEY_INVALID",
        "the key file has an unexpected length",
      );
    }
    this.key = existing;
    return this.key;
  }

  /** Seal one secret with AES-256-GCM. */
  seal(plaintext: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), key_version: KEY_VERSION };
  }

  /** Open one sealed secret; any tampering or key mismatch fails closed. */
  open(sealed: SealedSecret): string {
    if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
      throw new ProviderCredentialError(
        "PROVIDER_CREDENTIAL_SEALED_MALFORMED",
        "the sealed payload has an unexpected shape",
      );
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), sealed.iv);
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new ProviderCredentialError(
        "PROVIDER_CREDENTIAL_SEALED_AUTH_FAILED",
        "the sealed payload failed authentication",
      );
    }
  }
}

/**
 * The masked display value (D22: "the UI shows masked values with
 * revoke/replace"). Reveals only the final four characters of a secret long
 * enough to make that safe — below 12 characters a four-character reveal is
 * too large a fraction of the secret, so anything shorter is fully masked.
 */
export function maskProviderSecret(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length < 12) {
    return "••••••";
  }
  return `••••${trimmed.slice(-4)}`;
}
