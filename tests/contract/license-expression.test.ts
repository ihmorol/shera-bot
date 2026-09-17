import { describe, expect, it } from "vitest";

import { createEvaluator, type LicensePolicy } from "../../scripts/license-expression.ts";

const policy: LicensePolicy = {
  allowed: ["MIT", "Apache-2.0", "BSD-3-Clause"],
  reviewedExceptions: [
    {
      license: "LGPL-3.0-or-later",
      packages: ["@img/sharp-*"],
      rationale: "test fixture",
    },
    {
      license: "EPL-2.0",
      rationale: "fixture with no package scope",
    },
  ],
};

const evaluate = createEvaluator(policy);

describe("license-expression evaluation (S01 gate)", () => {
  it("accepts an allowed license", () => {
    expect(evaluate("MIT", "some-package").ok).toBe(true);
  });

  it("rejects an unknown license", () => {
    const verdict = evaluate("GPL-3.0-only", "some-package");

    expect(verdict.ok).toBe(false);
    expect(verdict.unmatched).toEqual(["GPL-3.0-only"]);
  });

  it("rejects an empty license field", () => {
    // A dependency with no license field at all must not slip through as vacuously true.
    expect(evaluate("", "license-less-package").ok).toBe(false);
    expect(evaluate(undefined, "license-less-package").unmatched).toEqual([
      "(empty license field)",
    ]);
    expect(evaluate("   ", "license-less-package").ok).toBe(false);
  });

  it("passes an OR expression when either side passes", () => {
    expect(evaluate("MIT OR GPL-3.0-only", "some-package").ok).toBe(true);
    expect(evaluate("GPL-3.0-only OR MIT", "some-package").ok).toBe(true);
    expect(evaluate("GPL-3.0-only OR AGPL-3.0-only", "some-package").ok).toBe(false);
  });

  it("requires both sides of an AND expression", () => {
    expect(evaluate("MIT AND Apache-2.0", "some-package").ok).toBe(true);

    const verdict = evaluate("MIT AND GPL-3.0-only", "some-package");

    expect(verdict.ok).toBe(false);
    expect(verdict.unmatched).toEqual(["GPL-3.0-only"]);
  });

  it("fails closed on parenthesized mixed expressions", () => {
    // Regression for the review finding: splitting on OR before evaluating AND let
    // "(MIT OR GPL-3.0-only) AND LicenseRef-Proprietary" pass on the strength of MIT alone.
    const verdict = evaluate("(MIT OR GPL-3.0-only) AND LicenseRef-Proprietary", "some-package");

    expect(verdict.ok).toBe(false);
    expect(verdict.unmatched).toContain("LicenseRef-Proprietary");
  });

  it("treats a WITH clause as granting extra permissions on the base license", () => {
    const verdict = evaluate("Apache-2.0 WITH LLVM-exception", "llvm-tooling");

    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(" ")).toContain("LLVM-exception");
  });

  it("still rejects a WITH clause whose base license is not allowed", () => {
    expect(evaluate("GPL-2.0-only WITH Classpath-exception-2.0", "some-package").ok).toBe(false);
  });

  it("applies a reviewed exception to a matching package", () => {
    const verdict = evaluate("LGPL-3.0-or-later", "@img/sharp-linux-x64");

    expect(verdict.ok).toBe(true);
    expect(verdict.exceptionsUsed).toEqual(["LGPL-3.0-or-later"]);
  });

  it("rejects a reviewed exception carried by a different package", () => {
    // Regression for the review finding: the rationale was written for the sharp binaries,
    // so an unrelated package must not inherit it.
    const verdict = evaluate("LGPL-3.0-or-later", "totally-different-lib");

    expect(verdict.ok).toBe(false);
    expect(verdict.unmatched.join(" ")).toContain("does not cover totally-different-lib");
  });

  it("notes an exception that declares no package scope", () => {
    const verdict = evaluate("EPL-2.0", "any-package");

    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(" ")).toContain("no package scope");
  });

  it("covers the compound expression in the installed tree", () => {
    // The real expression on the sharp binaries: both an allowed component and an
    // exception-scoped component.
    const verdict = evaluate("Apache-2.0 AND LGPL-3.0-or-later", "@img/sharp-win32-x64");

    expect(verdict.ok).toBe(true);
    expect(verdict.exceptionsUsed).toEqual(["LGPL-3.0-or-later"]);
  });
});
