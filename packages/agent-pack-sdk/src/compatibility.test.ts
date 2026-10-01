import { describe, expect, it } from "vitest";

import { checkCompatibility, PackCompatibilityError } from "./compatibility.ts";
import { minimalManifest } from "./fixtures.ts";
import { assertValidManifest, type PackManifest } from "./manifest.ts";
import { canonicalManifestHash, type PackRecord } from "./integrity.ts";

function packWithRange(range: string): PackManifest {
  return assertValidManifest(
    minimalManifest((m) => {
      m.runtime_compatibility = range;
    }),
  );
}

describe("checkCompatibility (D18, D28)", () => {
  it("accepts a runtime inside the caret range, including the lower bound", () => {
    expect(() => checkCompatibility(packWithRange("^0.10.0"), "0.10.0")).not.toThrow();
    expect(() => checkCompatibility(packWithRange("^0.10.0"), "0.10.9")).not.toThrow();
  });

  it("rejects a runtime outside the range with the typed error carrying pack fields", () => {
    for (const runtime of ["0.9.9", "0.11.0", "1.10.0"]) {
      let error: unknown;
      try {
        checkCompatibility(packWithRange("^0.10.0"), runtime);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PackCompatibilityError);
      const compatibility = error as PackCompatibilityError;
      expect(compatibility.pack_id).toBe("student");
      expect(compatibility.pack_version).toBe("1.0.0");
      expect(compatibility.runtime_compatibility).toBe("^0.10.0");
      expect(compatibility.runtime_version).toBe(runtime);
    }
  });

  it("caret on a 0.x target pins the minor (standard caret semantics)", () => {
    expect(() => checkCompatibility(packWithRange("^0.10.0"), "0.10.5")).not.toThrow();
    expect(() => checkCompatibility(packWithRange("^0.10.0"), "0.11.0")).toThrow(
      PackCompatibilityError,
    );
  });

  it("caret on a 1.x target allows any 1.y.z but not the next major", () => {
    expect(() => checkCompatibility(packWithRange("^1.2.3"), "1.9.0")).not.toThrow();
    expect(() => checkCompatibility(packWithRange("^1.2.3"), "2.0.0")).toThrow(
      PackCompatibilityError,
    );
  });

  it("tilde pins the minor", () => {
    expect(() => checkCompatibility(packWithRange("~1.2.3"), "1.2.9")).not.toThrow();
    expect(() => checkCompatibility(packWithRange("~1.2.3"), "1.3.0")).toThrow(
      PackCompatibilityError,
    );
  });

  it("an exact range matches only that version", () => {
    expect(() => checkCompatibility(packWithRange("1.2.3"), "1.2.3")).not.toThrow();
    expect(() => checkCompatibility(packWithRange("1.2.3"), "1.2.4")).toThrow(
      PackCompatibilityError,
    );
  });

  it("a star range accepts every runtime", () => {
    for (const runtime of ["0.0.1", "1.99.99", "123.0.0"]) {
      expect(() => checkCompatibility(packWithRange("*"), runtime)).not.toThrow();
    }
  });

  it("rejects a malformed runtime version with the typed error", () => {
    expect(() => checkCompatibility(packWithRange("^0.10.0"), "0.10")).toThrow(
      PackCompatibilityError,
    );
    expect(() => checkCompatibility(packWithRange("^0.10.0"), "latest")).toThrow(
      PackCompatibilityError,
    );
  });

  it("works on a loaded pack record as well as a bare manifest", () => {
    const manifest = packWithRange("^0.10.0");
    const record: PackRecord = { manifest, manifest_hash: canonicalManifestHash(manifest) };
    expect(() => checkCompatibility(record, "0.10.2")).not.toThrow();
    expect(() => checkCompatibility(record, "0.11.0")).toThrow(PackCompatibilityError);
  });
});
