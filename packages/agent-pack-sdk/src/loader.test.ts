import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  BuiltInPackLoader,
  PackRegistry,
  PackResolutionError,
  type PackListing,
} from "./loader.ts";
import { canonicalManifestHash, PackIntegrityError } from "./integrity.ts";
import { minimalManifest } from "./fixtures.ts";
import { PackManifestValidationError } from "./manifest.ts";

/**
 * BuiltInPackLoader tests run against fixture pack directories in a temp
 * packsRoot (the loader path is configurable for exactly this reason). The
 * in-repo agent-packs/ content is filled by S10 chunk 2; these tests pin the
 * loading contract that content must satisfy.
 */
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makePacksRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "shera-pack-sdk-"));
  tempRoots.push(root);
  return root;
}

function writePack(
  root: string,
  packId: string,
  dirName: string,
  manifest: Record<string, unknown>,
  recordedHash?: string,
): string {
  const dir = join(root, packId, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (recordedHash !== undefined) {
    writeFileSync(join(dir, "manifest.sha256"), `${recordedHash}\n`);
  }
  return dir;
}

describe("BuiltInPackLoader (D28)", () => {
  it("resolves a pack directory by id and version", () => {
    const root = makePacksRoot();
    const manifest = minimalManifest();
    writePack(root, "student", "v1", manifest);
    const loader = new BuiltInPackLoader({ packsRoot: root });

    const record = loader.resolve("student", "1.0.0");
    expect(record.manifest.pack_id).toBe("student");
    expect(record.manifest.version).toBe("1.0.0");
    expect(record.manifest_hash).toBe(canonicalManifestHash(manifest));
  });

  it("resolves the highest declared version when no version is given", () => {
    const root = makePacksRoot();
    writePack(root, "student", "v1", minimalManifest());
    writePack(
      root,
      "student",
      "v2",
      minimalManifest((m) => {
        m.version = "1.1.0";
      }),
    );
    const loader = new BuiltInPackLoader({ packsRoot: root });

    expect(loader.resolve("student").manifest.version).toBe("1.1.0");
    expect(loader.resolve("student", "1.0.0").manifest.version).toBe("1.0.0");
  });

  it("rejects an unknown pack and an unknown version with the typed error", () => {
    const root = makePacksRoot();
    writePack(root, "student", "v1", minimalManifest());
    const loader = new BuiltInPackLoader({ packsRoot: root });

    expect(() => loader.resolve("ghost_pack", "1.0.0")).toThrow(PackResolutionError);
    expect(() => loader.resolve("student", "9.9.9")).toThrow(PackResolutionError);
    try {
      loader.resolve("student", "9.9.9");
    } catch (error) {
      const resolution = error as PackResolutionError;
      expect(resolution.reason).toBe("not-found");
      expect(resolution.pack_id).toBe("student");
    }
  });

  it("rejects two directories declaring the same version as ambiguous", () => {
    const root = makePacksRoot();
    const manifest = minimalManifest();
    writePack(root, "student", "v1", manifest);
    writePack(root, "student", "v1-copy", manifest);
    const loader = new BuiltInPackLoader({ packsRoot: root });

    try {
      loader.resolve("student", "1.0.0");
      throw new Error("expected resolve to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackResolutionError);
      expect((error as PackResolutionError).reason).toBe("ambiguous");
    }
  });

  it("ignores directories whose manifest pack_id does not match the requested pack", () => {
    const root = makePacksRoot();
    writePack(
      root,
      "student",
      "v1",
      minimalManifest((m) => {
        m.pack_id = "other_pack";
      }),
    );
    const loader = new BuiltInPackLoader({ packsRoot: root });

    expect(() => loader.resolve("student", "1.0.0")).toThrow(PackResolutionError);
  });

  it("rejects manifest files that are not valid JSON with a typed reason", () => {
    const root = makePacksRoot();
    const dir = join(root, "student", "v1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ not json");
    const loader = new BuiltInPackLoader({ packsRoot: root });

    try {
      loader.resolve("student", "1.0.0");
      throw new Error("expected resolve to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackResolutionError);
      expect((error as PackResolutionError).reason).toBe("invalid-manifest");
    }
  });

  it("rejects manifest files that fail the schema with the manifest validation error", () => {
    const root = makePacksRoot();
    writePack(
      root,
      "student",
      "v1",
      minimalManifest((m) => {
        delete m.agents;
      }),
    );
    const loader = new BuiltInPackLoader({ packsRoot: root });

    expect(() => loader.resolve("student", "1.0.0")).toThrow(PackManifestValidationError);
  });

  it("detects a manifest that was modified after its hash was recorded (sidecar)", () => {
    const root = makePacksRoot();
    const original = minimalManifest();
    const tampered = minimalManifest((m) => {
      m.title = "Student Pack (edited)";
    });
    // The sidecar records the ORIGINAL manifest's hash; the file on disk carries
    // the tampered one — exactly the post-recording modification D28 forbids.
    writePack(root, "student", "v1", tampered, canonicalManifestHash(original));
    const loader = new BuiltInPackLoader({ packsRoot: root });

    expect(() => loader.resolve("student", "1.0.0")).toThrow(PackIntegrityError);
  });

  it("loads a pack without a sidecar and self-records the canonical hash", () => {
    const root = makePacksRoot();
    const manifest = minimalManifest();
    writePack(root, "student", "v1", manifest);
    const loader = new BuiltInPackLoader({ packsRoot: root });

    const record = loader.resolve("student", "1.0.0");
    expect(record.manifest_hash).toBe(canonicalManifestHash(manifest));
  });

  it("lists packs and their declared versions, newest first", () => {
    const root = makePacksRoot();
    writePack(root, "student", "v1", minimalManifest());
    writePack(
      root,
      "student",
      "v2",
      minimalManifest((m) => {
        m.version = "1.1.0";
      }),
    );
    const loader = new BuiltInPackLoader({ packsRoot: root });

    const listings: PackListing[] = loader.listPacks();
    expect(listings).toEqual([{ pack_id: "student", versions: ["1.1.0", "1.0.0"] }]);
  });

  it("constructs against the in-repo agent-packs root by default", () => {
    const loader = new BuiltInPackLoader();
    // The in-repo content ships in S10 chunk 2; today the loader must simply
    // behave on the real root (an array listing, possibly empty).
    expect(Array.isArray(loader.listPacks())).toBe(true);
  });
});

describe("PackRegistry (D28 loader interface)", () => {
  it("falls through to the loader that actually holds the pack", () => {
    const root = makePacksRoot();
    writePack(root, "student", "v1", minimalManifest());
    const registry = new PackRegistry([
      new BuiltInPackLoader({ packsRoot: makePacksRoot() }),
      new BuiltInPackLoader({ packsRoot: root }),
    ]);

    const record = registry.resolve("student", "1.0.0");
    expect(record.manifest.version).toBe("1.0.0");
  });

  it("reports not-found when no loader holds the pack", () => {
    const registry = new PackRegistry();
    expect(() => registry.resolve("ghost_pack", "1.0.0")).toThrow(PackResolutionError);
    try {
      registry.resolve("ghost_pack", "1.0.0");
    } catch (error) {
      expect((error as PackResolutionError).reason).toBe("not-found");
    }
  });

  it("propagates ambiguity instead of falling through", () => {
    const root = makePacksRoot();
    const manifest = minimalManifest();
    writePack(root, "student", "v1", manifest);
    writePack(root, "student", "v1-copy", manifest);
    const registry = new PackRegistry([new BuiltInPackLoader({ packsRoot: root })]);

    try {
      registry.resolve("student", "1.0.0");
      throw new Error("expected resolve to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PackResolutionError);
      expect((error as PackResolutionError).reason).toBe("ambiguous");
    }
  });
});
