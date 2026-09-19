/**
 * Internal-channel credential issuance (S06; D2, PRD §16, G3).
 *
 * The control plane issues one bearer token per container at provisioning.
 * The raw value exists exactly once: it is generated here, handed to the
 * runtime backend for delivery (only its digest reaches the container), and
 * registered with the secret registry for value-based redaction. Storage is
 * the SHA-256 digest only — the raw value is never persisted, logged, or
 * returned.
 */
import { createHash, randomBytes } from "node:crypto";

/** 256-bit token, URL-safe. */
export function generateChannelToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
