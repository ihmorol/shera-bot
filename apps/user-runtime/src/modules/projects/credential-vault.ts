/**
 * Project credential vault (S19 chunk 1; D22, E9, PRD §10, G3) — AES-256-GCM
 * custody INSIDE the user container.
 *
 * CUSTODY SHAPE (D22): repository secrets are provided per repository and are
 * "encrypted inside the user container, decrypted only at call time". This
 * module is the single encryption boundary: the git service encrypts at store
 * time and decrypts ONLY when a clone/fetch actually needs the secret. No API
 * surface reads secrets back — the API answers masked hints, and revoke +
 * re-store (replace) are the only lifecycle moves.
 *
 * KEY MANAGEMENT (the prototype stance, documented): the AES-256 key is a
 * random 32-byte value generated on first use and persisted in a container-
 * local key file placed beside the database (the composition passes the path;
 * the directory is the same user-container volume that already holds the
 * SQLite product state and the agent folders). This is the "protected
 * bootstrap key" of D22 in its prototype form — the container volume is the
 * trust boundary; a deployment-grade secret manager is the production
 * replacement and is exactly why the vault is a seam the composition wires,
 * not a global. A missing or unreadable key file is a typed failure (G4) —
 * never a silent re-key (which would brick every stored ciphertext).
 *
 * FORMAT: one sealed payload = 12-byte random iv + ciphertext + 16-byte GCM
 * auth tag, stored as three columns on the credential row (v15). key_version
 * records the generation of the key that sealed it (1 until a rotation slice
 * exists); decryption verifies the tag — tampered or foreign-key ciphertext
 * fails closed with CredentialVaultError (never plaintext, never a guess).
 *
 * URL handling lives here too (the only secret-adjacent string shapes):
 *  - sanitizeGitUrl strips userinfo for PERSISTENCE and display (G3: the
 *    stored source_url never carries credential material);
 *  - buildAuthenticatedUrl injects the credential into an https URL at CALL
 *    time only — and refuses any non-https URL, so a local file:// path can
 *    never collect a secret.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export class CredentialVaultError extends Error {
  constructor(message: string) {
    super(`credential vault: ${message}`);
    this.name = "CredentialVaultError";
  }
}

/** One sealed (encrypted) secret: the exact shapes the v15 row stores. */
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

export class CredentialVault {
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
    try {
      const existing = readFileSync(this.keyPath);
      if (existing.length !== KEY_BYTES) {
        throw new CredentialVaultError("the key file has an unexpected length");
      }
      this.key = existing;
      return this.key;
    } catch (error) {
      if (error instanceof CredentialVaultError) {
        throw error;
      }
      const missing =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT";
      if (!missing) {
        throw new CredentialVaultError("the key file could not be read");
      }
      const key = randomBytes(KEY_BYTES);
      // Owner-only: the key file is the D22 bootstrap key — a 0644 default
      // would hand every same-host process the whole vault.
      writeFileSync(this.keyPath, key, { mode: 0o600 });
      this.key = key;
      return key;
    }
  }

  /** Seal one secret with AES-256-GCM. */
  encrypt(plaintext: string): SealedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.loadKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), key_version: KEY_VERSION };
  }

  /** Open one sealed secret; any tampering or key mismatch fails closed. */
  decrypt(sealed: SealedSecret): string {
    if (sealed.iv.length !== IV_BYTES || sealed.tag.length !== TAG_BYTES) {
      throw new CredentialVaultError("the sealed payload has an unexpected shape");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.loadKey(), sealed.iv);
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new CredentialVaultError("the sealed payload failed authentication");
    }
  }
}

/**
 * The masked display value (D22: "the UI shows masked values with
 * revoke/replace"). Reveals only the final four characters of a secret long
 * enough to make that safe — below 12 characters a four-character reveal is
 * too large a fraction of the secret, so anything shorter is fully masked.
 */
export function maskSecret(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length < 12) {
    return "••••••";
  }
  return `••••${trimmed.slice(-4)}`;
}

/** Any scheme's `//user:password@` userinfo (https, ssh, git, ftp, …). The
 * scp-like form (`git@host:owner/repo.git`, no scheme, no `//`) deliberately
 * does not match — it carries no password and is standard git syntax. */
const USERINFO_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/\s:@]+):([^/\s@]+)@/;

/**
 * Strip any userinfo component from a git URL (G3: the credential-free form
 * is the ONLY form that is persisted, returned, or logged). URLs without
 * userinfo pass through unchanged.
 */
export function sanitizeGitUrl(url: string): string {
  return url.replace(USERINFO_URL, "$1://");
}

/** True when the URL carries an embedded userinfo component (any scheme). */
export function urlHasEmbeddedCredentials(url: string): boolean {
  return USERINFO_URL.test(url);
}

/**
 * Build the credential-bearing URL for ONE call (clone/fetch). Injects the
 * secret into https URLs only — a local file:// path never takes a credential
 * (typed refusal), and the result must never be persisted or logged (G3): the
 * git service consumes it in-process and disposes it.
 */
export function buildAuthenticatedUrl(
  url: string,
  credential: { username: string | null; secret: string },
): string {
  if (!/^https:\/\//i.test(url)) {
    throw new CredentialVaultError("credentials apply only to https git URLs");
  }
  const username = credential.username ?? "x-access-token";
  const encodedUser = encodeURIComponent(username);
  const encodedSecret = encodeURIComponent(credential.secret);
  return url.replace(/^https:\/\//i, `https://${encodedUser}:${encodedSecret}@`);
}
