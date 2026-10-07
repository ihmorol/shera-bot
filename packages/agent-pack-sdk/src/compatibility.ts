/**
 * Runtime compatibility (S10 chunk 1, D18, D28): a pack declares the runtime
 * contract versions it supports, and upgrades require compatibility checks.
 * A mismatch is a TYPED error (PackCompatibilityError) so callers can branch
 * on it without string matching (D23 rules 3/4 discipline).
 *
 * Range syntax (validated by the manifest schema): "*", an exact "X.Y.Z",
 * caret "^X.Y.Z", tilde "~X.Y.Z" — with standard caret semantics (^0.10.0
 * pins the minor; ^1.2.3 allows any 1.y.z).
 */
import type { PackManifest } from "./manifest.ts";
import type { PackRecord } from "./integrity.ts";

interface SemVerParts {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(version: string): SemVerParts | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  const [, major, minor, patch] = match as unknown as [string, string, string, string];
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareTuple(a: SemVerParts, b: SemVerParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** The exclusive upper bound a caret/tilde range allows (standard npm semantics). */
function rangeUpperBound(mode: "^" | "~", target: SemVerParts): SemVerParts {
  if (mode === "~") {
    return { major: target.major, minor: target.minor + 1, patch: 0 };
  }
  // npm caret: ^1.2.3 → <2.0.0; ^0.2.3 → <0.3.0; ^0.0.3 → <0.0.4 (the patch
  // is pinned on the 0.0.x line — a caret there admits exactly one patch).
  return target.major > 0
    ? { major: target.major + 1, minor: 0, patch: 0 }
    : target.minor > 0
      ? { major: 0, minor: target.minor + 1, patch: 0 }
      : { major: 0, minor: 0, patch: target.patch + 1 };
}

function satisfiesRange(version: SemVerParts, range: string): boolean {
  if (range === "*") return true;
  const mode = range.startsWith("^") || range.startsWith("~") ? (range[0] as "^" | "~") : "exact";
  const target = parseSemver(mode === "exact" ? range : range.slice(1));
  if (!target) return false; // unreachable for schema-validated ranges
  const comparison = compareTuple(version, target);
  if (comparison < 0) return false;
  if (mode === "exact") return comparison === 0;
  return compareTuple(version, rangeUpperBound(mode, target)) < 0;
}

export class PackCompatibilityError extends Error {
  readonly pack_id: string;
  readonly pack_version: string;
  readonly runtime_compatibility: string;
  readonly runtime_version: string;
  readonly reason: string;

  constructor(fields: {
    pack_id: string;
    pack_version: string;
    runtime_compatibility: string;
    runtime_version: string;
    reason: string;
  }) {
    super(
      `pack ${fields.pack_id}@${fields.pack_version} is not compatible with runtime ` +
        `${fields.runtime_version}: ${fields.reason} (required range: ${fields.runtime_compatibility})`,
    );
    this.name = "PackCompatibilityError";
    this.pack_id = fields.pack_id;
    this.pack_version = fields.pack_version;
    this.runtime_compatibility = fields.runtime_compatibility;
    this.runtime_version = fields.runtime_version;
    this.reason = fields.reason;
  }
}

/**
 * Check a pack against a runtime version; throws PackCompatibilityError on
 * mismatch (including a malformed runtime version). Accepts a bare manifest
 * or a loaded pack record. Versions and ranges are not secrets, so the error
 * carries them verbatim for diagnosis.
 */
export function checkCompatibility(pack: PackRecord | PackManifest, runtimeVersion: string): void {
  const manifest = "manifest" in pack ? pack.manifest : pack;
  const runtime = parseSemver(runtimeVersion);
  if (!runtime) {
    throw new PackCompatibilityError({
      pack_id: manifest.pack_id,
      pack_version: manifest.version,
      runtime_compatibility: manifest.runtime_compatibility,
      runtime_version: runtimeVersion,
      reason: "the runtime version is not a MAJOR.MINOR.PATCH version",
    });
  }
  if (!satisfiesRange(runtime, manifest.runtime_compatibility)) {
    throw new PackCompatibilityError({
      pack_id: manifest.pack_id,
      pack_version: manifest.version,
      runtime_compatibility: manifest.runtime_compatibility,
      runtime_version: runtimeVersion,
      reason: "the runtime version is outside the pack's required range",
    });
  }
}
