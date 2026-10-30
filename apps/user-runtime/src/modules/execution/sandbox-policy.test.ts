/**
 * Sandbox policy tests (S26 chunk 2; D27 "workspace paths are resolved and
 * checked before every file operation; working directory is fixed to the
 * task/workspace scope", the D27 environment-variable secret-exposure
 * prevention, G3) — the path/envelope rules the execution tools resolve
 * BEFORE anything spawns. The AC2 shapes are all here: `../` traversal,
 * absolute host paths, and a symlink planted inside the workspace.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SandboxPolicyError,
  buildSandboxEnv,
  prepareDirectoryInsideScope,
  resolveFileInsideScope,
} from "./sandbox-policy.ts";

describe("sandbox policy — workspace scope resolution (D27, AC2)", () => {
  let scope: string;
  let outside: string;

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "s26-policy-"));
    scope = join(root, "workspace");
    outside = join(root, "outside");
    mkdirSync(scope);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "host secret");
  });

  afterEach(() => {
    rmSync(join(scope, ".."), { recursive: true, force: true });
  });

  it("resolves a plain relative path to its absolute location inside the scope", () => {
    mkdirSync(join(scope, "sub"));
    const resolved = resolveFileInsideScope(scope, "sub");
    expect(resolved.absolute).toBe(join(scope, "sub"));
    expect(resolved.relative).toBe("sub");
  });

  it("refuses `../` traversal out of the scope", () => {
    expect(() => resolveFileInsideScope(scope, "../outside")).toThrow(SandboxPolicyError);
    expect(() => resolveFileInsideScope(scope, "../outside")).toThrow(/SANDBOX_PATH_ESCAPE/);
    expect(() => resolveFileInsideScope(scope, "sub/../../outside")).toThrow(/SANDBOX_PATH_ESCAPE/);
  });

  it("refuses absolute host paths", () => {
    expect(() => resolveFileInsideScope(scope, outside)).toThrow(/SANDBOX_PATH_ESCAPE/);
    expect(() => resolveFileInsideScope(scope, "/etc/passwd")).toThrow(/SANDBOX_PATH_ESCAPE/);
  });

  it("refuses a symlink planted in the workspace that points outside (symlink escape)", () => {
    symlinkSync(outside, join(scope, "escape-link"));
    expect(() => resolveFileInsideScope(scope, "escape-link")).toThrow(/SANDBOX_PATH_ESCAPE/);
    // Even a deep path THROUGH the planted link is refused.
    expect(() => resolveFileInsideScope(scope, "escape-link/secret.txt")).toThrow(
      /SANDBOX_PATH_ESCAPE/,
    );
  });

  it("refuses a symlinked SCOPE directory component (scope itself swapped)", () => {
    // The scope root is resolved to its real path first: a caller handing a
    // symlinked root is pinned to the REAL root, and escaping THROUGH it is
    // still checked against the real location.
    const realScope = scope;
    const linkRoot = join(scope, "..", "scope-link");
    symlinkSync(realScope, linkRoot);
    const resolved = resolveFileInsideScope(linkRoot, ".");
    expect(resolved.absolute).toBe(realScope);
  });

  it("prepareDirectoryInsideScope creates a missing directory inside the scope (task subdirs)", () => {
    const prepared = prepareDirectoryInsideScope(scope, "tasks/run-1/workdir");
    expect(prepared.absolute).toBe(join(scope, "tasks/run-1/workdir"));
    expect(prepared.exists()).toBe(true);
    // And the fresh directory is checked by the same rules afterwards.
    const resolved = resolveFileInsideScope(scope, "tasks/run-1/workdir");
    expect(resolved.absolute).toBe(prepared.absolute);
  });

  it("prepareDirectoryInsideScope refuses traversal and absolute paths", () => {
    expect(() => prepareDirectoryInsideScope(scope, "../evil")).toThrow(/SANDBOX_PATH_ESCAPE/);
    expect(() => prepareDirectoryInsideScope(scope, "/tmp/evil")).toThrow(/SANDBOX_PATH_ESCAPE/);
  });

  it("prepareDirectoryInsideScope refuses to traverse a planted directory symlink mid-path", () => {
    symlinkSync(outside, join(scope, "evil-dir"));
    expect(() => prepareDirectoryInsideScope(scope, "evil-dir/deeper")).toThrow(
      /SANDBOX_PATH_ESCAPE/,
    );
  });

  it("refuses an empty or non-string workdir", () => {
    expect(() => resolveFileInsideScope(scope, "")).toThrow(/SANDBOX_WORKDIR_INVALID/);
  });
});

describe("sandbox policy — the child environment (D27 env-secret prevention, AC5)", () => {
  it("is a fixed allowlist: no runtime env leakage by construction", () => {
    process.env.SHERA_S26_POLICY_PLANTED_SECRET = "sk-test-plant-9876543210";
    try {
      const env = buildSandboxEnv("/tmp/workdir");
      expect(env["SHERA_S26_POLICY_PLANTED_SECRET"]).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM", "TMPDIR"]);
      expect(env["HOME"]).toBe("/tmp/workdir");
      expect(env["TMPDIR"]).toBe("/tmp/workdir/.tmp");
      expect(env["PATH"]).not.toContain(process.env["PATH"] ?? "");
    } finally {
      delete process.env.SHERA_S26_POLICY_PLANTED_SECRET;
    }
  });

  it("never carries more env than the allowlist, whatever the caller passes", () => {
    // The v1 posture: no caller-supplied environment at all. The signature
    // accepts none — every runtime-env key OUTSIDE the fixed allowlist is
    // invisible to the child.
    const allowlist = new Set(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);
    const env = buildSandboxEnv("/w");
    for (const key of Object.keys(process.env)) {
      if (allowlist.has(key)) continue;
      expect(env[key]).toBeUndefined();
    }
  });
});
