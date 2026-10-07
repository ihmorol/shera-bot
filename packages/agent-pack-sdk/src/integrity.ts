/**
 * Pack integrity (S10 chunk 1, D28): every loaded pack carries the manifest
 * hash recorded for it — from an independently recorded sidecar at load time,
 * or from a workspace pin — and verifyIntegrity recomputes the canonical hash
 * to detect any post-recording modification. A workspace pins one pack version
 * and its hash (D19, D28); a task keeps the pack version + hash that created
 * it, so a pack upgrade can never silently change an existing task (D28).
 */
import { createHash } from "node:crypto";

import type { PackManifest } from "./manifest.ts";
import type { Sha256Hex } from "./primitives.ts";

/** A loaded pack: the validated manifest plus its recorded manifest hash. */
export interface PackRecord {
  manifest: PackManifest;
  manifest_hash: Sha256Hex;
}

/**
 * Canonical JSON: object keys sorted recursively, array order preserved, no
 * insignificant whitespace. Two byte-different manifest files that declare the
 * same data therefore share one hash, while any data change changes the hash.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The SHA-256 digest over the canonical JSON of a manifest (D28). */
export function canonicalManifestHash(manifest: unknown): Sha256Hex {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export type IntegrityResult =
  { ok: true; manifest_hash: Sha256Hex } | { ok: false; expected: string; actual: string };

/**
 * Recompute the canonical manifest hash and compare it with the recorded one.
 * Hashes are not secrets, so result fields may carry them verbatim.
 */
export function verifyIntegrity(pack: PackRecord): IntegrityResult {
  const actual = canonicalManifestHash(pack.manifest);
  if (actual === pack.manifest_hash) {
    return { ok: true, manifest_hash: actual };
  }
  return { ok: false, expected: pack.manifest_hash, actual };
}

export class PackIntegrityError extends Error {
  /** The recorded hash as found (a malformed sidecar yields a malformed string). */
  readonly expected: string;
  /** The hash recomputed from the manifest actually present. */
  readonly actual: string;

  constructor(expected: string, actual: string) {
    super(
      "pack integrity check failed: the recorded manifest hash " +
        `${expected} does not match the recomputed hash ${actual}`,
    );
    this.name = "PackIntegrityError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Verify integrity, throwing the typed error on mismatch. */
export function assertIntegrity(pack: PackRecord): void {
  const result = verifyIntegrity(pack);
  if (!result.ok) {
    throw new PackIntegrityError(result.expected, result.actual);
  }
}
