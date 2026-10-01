/**
 * Pack loading (S10 chunk 1, D28): packs are versioned directories in the
 * repository, selected from a local registry. The PackLoader interface is the
 * seam for the future SignedPackagePackLoader / AdminRegistryPackLoader;
 * BuiltInPackLoader loads the packs shipped in-repo (agent-packs/**, content
 * filled in S10 chunk 2).
 *
 * Directory layout: <packsRoot>/<pack_id>/<version-dir>/manifest.json with an
 * optional sibling manifest.sha256 recording the canonical manifest hash at
 * authoring/pinning time. Identity and version come from the manifest itself,
 * never from directory names; the packsRoot is configurable so tests can use
 * fixtures. Loading a pack whose file content no longer matches its recorded
 * hash throws PackIntegrityError — a modified pack never resolves (D28).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertIntegrity,
  canonicalManifestHash,
  PackIntegrityError,
  type PackRecord,
} from "./integrity.ts";
import { assertValidManifest, type PackManifest } from "./manifest.ts";
import type { Sha256Hex } from "./primitives.ts";

export type PackResolutionReason = "not-found" | "ambiguous" | "invalid-manifest";

export class PackResolutionError extends Error {
  readonly pack_id: string;
  readonly version: string | undefined;
  readonly reason: PackResolutionReason;

  constructor(fields: {
    pack_id: string;
    version: string | undefined;
    reason: PackResolutionReason;
    detail?: string;
  }) {
    const versioned =
      fields.version === undefined ? fields.pack_id : `${fields.pack_id}@${fields.version}`;
    super(
      `pack ${versioned} cannot be resolved: ${fields.reason}` +
        (fields.detail === undefined ? "" : ` — ${fields.detail}`),
    );
    this.name = "PackResolutionError";
    this.pack_id = fields.pack_id;
    this.version = fields.version;
    this.reason = fields.reason;
  }
}

export interface PackListing {
  pack_id: string;
  /** Declared manifest versions, newest first. */
  versions: string[];
}

export interface PackLoader {
  resolve(packId: string, version?: string): PackRecord;
  listPacks(): PackListing[];
}

const MANIFEST_FILE = "manifest.json";
const HASH_SIDECAR = "manifest.sha256";

interface Candidate {
  manifest: PackManifest;
  dir: string;
}

function versionParts(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

function isNewerVersion(a: string, b: string): boolean {
  const pa = versionParts(a);
  const pb = versionParts(b);
  if (pa[0] !== pb[0]) return pa[0] > pb[0];
  if (pa[1] !== pb[1]) return pa[1] > pb[1];
  return pa[2] > pb[2];
}

function parseManifestFile(manifestPath: string, packId: string, version?: string): PackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new PackResolutionError({
      pack_id: packId,
      version,
      reason: "invalid-manifest",
      detail: "manifest.json is not valid JSON",
    });
  }
  return assertValidManifest(raw);
}

function readRecordedHash(sidecarPath: string, packId: string, version?: string): Sha256Hex {
  const recorded = readFileSync(sidecarPath, "utf8").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(recorded)) {
    throw new PackResolutionError({
      pack_id: packId,
      version,
      reason: "invalid-manifest",
      detail: "manifest.sha256 does not contain a 64-char lowercase sha256 digest",
    });
  }
  return recorded;
}

export class BuiltInPackLoader implements PackLoader {
  readonly #packsRoot: string;

  constructor(options?: { packsRoot?: string }) {
    // Default: the packs shipped in this repository (repo root / agent-packs).
    this.#packsRoot = options?.packsRoot ?? join(import.meta.dirname, "../../../agent-packs");
  }

  resolve(packId: string, version?: string): PackRecord {
    const packDir = join(this.#packsRoot, packId);
    if (!existsSync(packDir)) {
      throw new PackResolutionError({ pack_id: packId, version, reason: "not-found" });
    }

    const candidates: Candidate[] = [];
    for (const entry of readdirSync(packDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(packDir, entry.name);
      const manifestPath = join(dir, MANIFEST_FILE);
      if (!existsSync(manifestPath)) continue;
      const manifest = parseManifestFile(manifestPath, packId, version);
      // Identity comes from the manifest; a directory whose declared pack_id
      // does not match the requested pack is treated as absent.
      if (manifest.pack_id !== packId) continue;
      if (version !== undefined && manifest.version !== version) continue;
      candidates.push({ manifest, dir });
    }

    if (candidates.length === 0) {
      throw new PackResolutionError({ pack_id: packId, version, reason: "not-found" });
    }

    let chosen: Candidate;
    if (version === undefined) {
      // Pick the highest declared version; two directories sharing that top
      // version are an authoring error, not a tie to resolve silently.
      const newest = candidates.reduce((best, candidate) =>
        isNewerVersion(candidate.manifest.version, best.manifest.version) ? candidate : best,
      );
      const top = candidates.filter(
        (candidate) => candidate.manifest.version === newest.manifest.version,
      );
      if (top.length > 1) {
        throw new PackResolutionError({
          pack_id: packId,
          version: newest.manifest.version,
          reason: "ambiguous",
          detail: `${top.length} directories declare version ${newest.manifest.version}`,
        });
      }
      chosen = newest;
    } else {
      if (candidates.length > 1) {
        throw new PackResolutionError({
          pack_id: packId,
          version,
          reason: "ambiguous",
          detail: `${candidates.length} directories declare version ${version}`,
        });
      }
      chosen = candidates[0] as Candidate;
    }

    const sidecarPath = join(chosen.dir, HASH_SIDECAR);
    const manifest_hash: Sha256Hex = existsSync(sidecarPath)
      ? readRecordedHash(sidecarPath, packId, version)
      : // No independently recorded hash: self-record the canonical hash at load
        // time. Pinning strength comes from the sidecar or the workspace record.
        canonicalManifestHash(chosen.manifest);

    const record: PackRecord = { manifest: chosen.manifest, manifest_hash };
    // A recorded hash that no longer matches the file content is a hard stop.
    assertIntegrity(record);
    return record;
  }

  listPacks(): PackListing[] {
    if (!existsSync(this.#packsRoot)) return [];
    const listings: PackListing[] = [];
    for (const entry of readdirSync(this.#packsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packDir = join(this.#packsRoot, entry.name);
      const versions = new Set<string>();
      for (const sub of readdirSync(packDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const manifestPath = join(packDir, sub.name, MANIFEST_FILE);
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = parseManifestFile(manifestPath, entry.name);
          if (manifest.pack_id === entry.name) versions.add(manifest.version);
        } catch {
          // A broken pack directory surfaces through resolve(); listing stays total.
        }
      }
      listings.push({
        pack_id: entry.name,
        versions: [...versions].sort((a, b) => (isNewerVersion(a, b) ? -1 : 1)),
      });
    }
    return listings;
  }
}

/**
 * A registry over one or more loaders (D28). Resolution tries loaders in
 * registration order; a loader that does not hold the pack ("not-found") is
 * skipped, while hard failures (ambiguity, integrity, invalid manifests)
 * propagate immediately — they are authoring errors, never fallback signals.
 */
export class PackRegistry {
  readonly #loaders: PackLoader[];

  constructor(loaders: PackLoader[] = []) {
    this.#loaders = [...loaders];
  }

  register(loader: PackLoader): void {
    this.#loaders.push(loader);
  }

  resolve(packId: string, version?: string): PackRecord {
    let lastMiss: PackResolutionError | undefined;
    for (const loader of this.#loaders) {
      try {
        return loader.resolve(packId, version);
      } catch (error) {
        if (error instanceof PackResolutionError && error.reason === "not-found") {
          lastMiss = error;
          continue;
        }
        throw error;
      }
    }
    throw lastMiss ?? new PackResolutionError({ pack_id: packId, version, reason: "not-found" });
  }

  listPacks(): PackListing[] {
    const byPack = new Map<string, Set<string>>();
    for (const loader of this.#loaders) {
      for (const listing of loader.listPacks()) {
        const versions = byPack.get(listing.pack_id) ?? new Set<string>();
        for (const version of listing.versions) versions.add(version);
        byPack.set(listing.pack_id, versions);
      }
    }
    return [...byPack.entries()].map(([pack_id, versions]) => ({
      pack_id,
      versions: [...versions].sort((a, b) => (isNewerVersion(a, b) ? -1 : 1)),
    }));
  }
}

// Re-exported so loader consumers get the integrity failure type that
// resolve() can throw without importing the integrity module directly.
export { PackIntegrityError };
