import { describe, expect, it } from "vitest";

import {
  assertIntegrity,
  canonicalJson,
  canonicalManifestHash,
  PackIntegrityError,
  verifyIntegrity,
  type PackRecord,
} from "./integrity.ts";
import { minimalManifest } from "./fixtures.ts";
import { assertValidManifest } from "./manifest.ts";

const MANIFEST = assertValidManifest(minimalManifest());

describe("canonical manifest hashing (D28)", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, 4] } })).toBe(
      canonicalJson({ a: { c: [3, 4], d: 2 }, b: 1 }),
    );
    expect(canonicalManifestHash({ b: 1, a: 2 })).toBe(canonicalManifestHash({ a: 2, b: 1 }));
  });

  it("changes when content changes", () => {
    expect(canonicalManifestHash({ a: 1 })).not.toBe(canonicalManifestHash({ a: 2 }));
  });

  it("preserves array order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("verifyIntegrity (D28)", () => {
  it("accepts an untampered pack record", () => {
    const record: PackRecord = {
      manifest: MANIFEST,
      manifest_hash: canonicalManifestHash(MANIFEST),
    };
    const result = verifyIntegrity(record);
    expect(result.ok).toBe(true);
  });

  it("detects manifest modification after the hash was recorded", () => {
    const tampered = structuredClone(MANIFEST);
    tampered.title = "Student Pack (edited)";
    const record: PackRecord = {
      manifest: tampered,
      manifest_hash: canonicalManifestHash(MANIFEST),
    };
    const result = verifyIntegrity(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.expected).toBe(canonicalManifestHash(MANIFEST));
      expect(result.actual).toBe(canonicalManifestHash(tampered));
      expect(result.expected).not.toBe(result.actual);
    }
  });

  it("throws the typed error from assertIntegrity", () => {
    const tampered = structuredClone(MANIFEST);
    tampered.title = "Student Pack (edited)";
    const record: PackRecord = {
      manifest: tampered,
      manifest_hash: canonicalManifestHash(MANIFEST),
    };
    expect(() => assertIntegrity(record)).toThrow(PackIntegrityError);
    try {
      assertIntegrity(record);
    } catch (error) {
      expect(error).toBeInstanceOf(PackIntegrityError);
      const integrity = error as PackIntegrityError;
      expect(integrity.expected).toBe(canonicalManifestHash(MANIFEST));
      expect(integrity.actual).toBe(canonicalManifestHash(tampered));
    }
  });
});
