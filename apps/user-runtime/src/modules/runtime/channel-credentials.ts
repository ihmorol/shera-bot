/**
 * Internal-channel credential store (S06; D2, D11, PRD §16).
 *
 * The runtime gateway verifies the control plane's per-container bearer token
 * with a deterministic credential check before any command runs (G2 — the
 * gateway/client authentication shape). The container holds ONLY SHA-256
 * digests, never the raw token (G3): the digest is delivered through the
 * container environment at provisioning, and rotation exchanges digests over
 * the already-authenticated channel. Presentation is compared in constant
 * time (timingSafeEqual over fixed-length digests), so verification does not
 * leak token material through timing.
 *
 * Rotation protocol (documented in docs terms as: stage → overlap → commit):
 * - stage(new_digest)    authenticated with the CURRENT token; both verify
 *                        during the overlap window.
 * - commitTo(new_digest) authenticated with the NEW token; prunes every other
 *                        digest, so the old token stops working immediately.
 * The store is bounded: at most two digests (current + one staged rotation).
 */
import { createHash, timingSafeEqual } from "node:crypto";

const MAX_DIGESTS = 2;

function digestOfRaw(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

function digestOfHex(hex: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(hex)) {
    throw new Error("credential digest must be a 64-char sha256 hex string");
  }
  return Buffer.from(hex, "hex");
}

export class ChannelCredentialStore {
  private readonly digests: Buffer[] = [];

  /** Admit the provisioned credential; the raw value is hashed and discarded. */
  admit(rawToken: string): void {
    this.insert(digestOfRaw(rawToken));
  }

  /**
   * Admit a credential digest directly — the provisioning path: the engine
   * environment carries the digest, never the raw token (G3).
   */
  admitDigest(credentialSha256: string): void {
    this.insert(digestOfHex(credentialSha256));
  }

  /** Stage a rotation digest (hex) received over the authenticated channel. */
  stage(credentialSha256: string): void {
    this.insert(digestOfHex(credentialSha256));
  }

  /** Keep only the committed digest; every other staged/old digest is pruned. */
  commitTo(credentialSha256: Buffer): void {
    if (this.digests.some((digest) => digest.equals(credentialSha256))) {
      this.digests.length = 0;
      this.digests.push(Buffer.from(credentialSha256));
    }
  }

  /** Constant-time verification of a presented bearer token. */
  verifies(rawToken: string): boolean {
    if (rawToken.length === 0) return false;
    const presented = digestOfRaw(rawToken);
    return this.digests.some((digest) => timingSafeEqual(digest, presented));
  }

  /** The digest matching a presented (verified) token, for commit targeting. */
  digestOf(rawToken: string): Buffer {
    const presented = digestOfRaw(rawToken);
    const match = this.digests.find((digest) => timingSafeEqual(digest, presented));
    if (!match) throw new Error("credential is not present in the store");
    return match;
  }

  digestCount(): number {
    return this.digests.length;
  }

  private insert(digest: Buffer): void {
    if (this.digests.some((existing) => existing.equals(digest))) return;
    if (this.digests.length >= MAX_DIGESTS) {
      // Fail closed: an uncommitted rotation must complete before another
      // stage is accepted (bounded credential state, observable failure).
      throw new Error("credential rotation bound reached: commit the staged digest first");
    }
    this.digests.push(digest);
  }
}
