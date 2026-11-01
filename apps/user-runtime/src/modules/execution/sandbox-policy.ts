/**
 * Sandbox policy (S26 chunk 2; D27, G3) — the path and environment rules the
 * execution tools apply BEFORE anything spawns and before every file
 * operation. D27's version-one isolation is explicit: "workspace paths are
 * resolved and checked before every file operation; working directory is
 * fixed to the task/workspace scope". This module is that check.
 *
 * Path discipline (all checks against the REAL scope root):
 *   1. the scope root is resolved to its real location first (a symlinked
 *      root pins to the real directory; escapes are judged from there);
 *   2. the requested path is REFUSED if absolute — everything inside the
 *      scope is scope-relative (absolute host paths are the AC2 shape);
 *   3. the joined path must stay inside the scope (lexical `..` refusal);
 *   4. every EXISTING path component is realpath'd and re-checked (symlink
 *      escapes — the planted-link AC2 shape — are refused at execution time);
 *   5. non-existent leaves are judged through their nearest existing ancestor
 *      plus the remaining suffix, so a future creation cannot start outside.
 *
 * Environment discipline (D27 environment-variable secret exposure, AC5): the
 * child environment is a FIXED allowlist — PATH, HOME (the resolved workdir),
 * TMPDIR (inside the workdir), LANG, TERM. The runtime's process.env is never
 * consulted and no caller-supplied environment is merged: a secret-shaped
 * variable in the runtime's environment is structurally invisible to
 * executed code.
 *
 * Governing records: D27, D23 rule 2, AC2/AC5, G3.
 */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type SandboxPolicyFailureCode =
  | "SANDBOX_PATH_ESCAPE"
  | "SANDBOX_WORKDIR_INVALID"
  | "SANDBOX_WORKDIR_MISSING"
  | "SANDBOX_INTERPRETER_MISSING";

export class SandboxPolicyError extends Error {
  readonly code: SandboxPolicyFailureCode;
  readonly category = "validation";

  constructor(code: SandboxPolicyFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SandboxPolicyError";
    this.code = code;
    this.category = "validation";
  }
}

/** One scope-resolved location: the checked absolute path and its scope-relative form. */
export interface ScopedPath {
  absolute: string;
  relative: string;
}

/**
 * Resolve the REAL scope root (the D27 workspace/task scope). A missing scope
 * is a typed failure; a symlinked root pins to its real location.
 */
function realScopeRoot(scopeRoot: string): string {
  if (!isAbsolute(scopeRoot)) {
    throw new SandboxPolicyError(
      "SANDBOX_WORKDIR_INVALID",
      `the scope root must be an absolute path (got ${scopeRoot})`,
    );
  }
  if (!existsSync(scopeRoot)) {
    throw new SandboxPolicyError(
      "SANDBOX_WORKDIR_MISSING",
      `the workspace scope root does not exist (${scopeRoot})`,
    );
  }
  try {
    return realpathSync(scopeRoot);
  } catch {
    throw new SandboxPolicyError(
      "SANDBOX_WORKDIR_MISSING",
      `the workspace scope root could not be resolved (${scopeRoot})`,
    );
  }
}

/** Lexical + realpath containment check of `candidate` against `realRoot`. */
function assertInsideScope(realRoot: string, candidate: string, requested: string): void {
  const rel = relative(realRoot, candidate);
  if (rel === "" || rel === ".") return; // the scope root itself
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new SandboxPolicyError(
      "SANDBOX_PATH_ESCAPE",
      `the requested path escapes the workspace scope (requested: ${JSON.stringify(requested)})`,
    );
  }
}

/**
 * Walk the EXISTING prefix of `candidate`, realpath-checking each component
 * against the real scope root (the symlink-escape refusal), and judge the
 * non-existent tail through its nearest existing ancestor.
 */
function assertNoSymlinkEscape(realRoot: string, candidate: string, requested: string): void {
  let existing = candidate;
  const tail: string[] = [];
  while (!existsSync(existing) && existing !== realRoot) {
    tail.unshift(existing.slice(existing.lastIndexOf(sep) + 1));
    existing = existing.slice(0, existing.lastIndexOf(sep));
  }
  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    throw new SandboxPolicyError(
      "SANDBOX_PATH_ESCAPE",
      `the requested path could not be resolved inside the scope (requested: ${JSON.stringify(requested)})`,
    );
  }
  assertInsideScope(realRoot, realExisting, requested);
  if (tail.length > 0) {
    assertInsideScope(realRoot, join(realExisting, ...tail), requested);
  }
}

/**
 * Resolve one scope-relative path and verify it stays inside the scope (D27:
 * the check before every file operation). Refuses absolute host paths, `../`
 * traversal, and any symlink escape — the AC2 shapes.
 */
export function resolveFileInsideScope(scopeRoot: string, requested: string): ScopedPath {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new SandboxPolicyError(
      "SANDBOX_WORKDIR_INVALID",
      "the requested path must be a non-empty scope-relative string",
    );
  }
  if (isAbsolute(requested)) {
    throw new SandboxPolicyError(
      "SANDBOX_PATH_ESCAPE",
      `absolute paths are refused — everything inside the scope is scope-relative (requested: ${JSON.stringify(requested)})`,
    );
  }
  const realRoot = realScopeRoot(scopeRoot);
  const candidate = resolve(realRoot, requested);
  assertInsideScope(realRoot, candidate, requested);
  assertNoSymlinkEscape(realRoot, candidate, requested);
  const rel = relative(realRoot, candidate);
  return { absolute: candidate, relative: rel === "" ? "." : rel };
}

/**
 * Resolve AND create (mkdir -p semantics) one scope-relative directory, with
 * a per-component check: each existing prefix is realpath-checked BEFORE the
 * next segment is created, so a planted directory symlink is refused before
 * anything is created through it. The final directory is re-verified after
 * creation.
 */
export function prepareDirectoryInsideScope(
  scopeRoot: string,
  requested: string,
): ScopedPath & {
  exists: () => boolean;
} {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new SandboxPolicyError(
      "SANDBOX_WORKDIR_INVALID",
      "the requested directory must be a non-empty scope-relative string",
    );
  }
  if (isAbsolute(requested)) {
    throw new SandboxPolicyError(
      "SANDBOX_PATH_ESCAPE",
      `absolute paths are refused — everything inside the scope is scope-relative (requested: ${JSON.stringify(requested)})`,
    );
  }
  const realRoot = realScopeRoot(scopeRoot);
  const segments = relative(realRoot, resolve(realRoot, requested))
    .split(sep)
    .filter((segment) => segment !== "" && segment !== ".");
  let current = realRoot;
  for (const segment of segments) {
    if (segment === "..") {
      throw new SandboxPolicyError(
        "SANDBOX_PATH_ESCAPE",
        `the requested directory escapes the workspace scope (requested: ${JSON.stringify(requested)})`,
      );
    }
    const next = join(current, segment);
    if (existsSync(next)) {
      const real = realpathSync(next);
      assertInsideScope(realRoot, real, requested);
      current = real;
    } else {
      mkdirSync(next);
      const real = realpathSync(next);
      assertInsideScope(realRoot, real, requested);
      current = real;
    }
  }
  assertInsideScope(realRoot, current, requested);
  return {
    absolute: current,
    relative: relative(realRoot, current) || ".",
    exists: () => existsSync(current),
  };
}

/**
 * The fixed child-environment allowlist (D27 env-secret prevention, AC5).
 * The runtime's process.env is never consulted; no caller environment is
 * merged. Executed code sees exactly: PATH (a fixed safe value), HOME (the
 * resolved workdir), TMPDIR (a dot-dir inside the workdir), LANG, TERM.
 */
export function buildSandboxEnv(workdir: string): Record<string, string> {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: workdir,
    TMPDIR: join(workdir, ".tmp"),
    LANG: "C.UTF-8",
    TERM: "dumb",
  };
}
