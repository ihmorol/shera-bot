/**
 * S27 ST-01 — path traversal and symlink escape (threat model §5 ST-01;
 * TM-5.1; D27 "workspace paths are resolved and checked before every file
 * operation; working directory is fixed to the task/workspace scope").
 *
 * The S27 suite is the ADVERSARIAL dynamic layer on top of the static
 * boundary guards (scripts/boundary-guards.ts) and the S26 unit pins: here
 * the hostile inputs are actually fired at the REAL controls and every
 * refusal is paired with an outside-the-scope sentinel proving nothing
 * escaped — "the control exists" is not evidence; the sentinel is.
 *
 * Two surfaces, because the product has two file worlds:
 *   1. the FILESYSTEM surface (S26 execution workspaces — real directories):
 *      traversal, absolute paths, planted file/directory symlinks, and a
 *      symlinked scope root are refused by the sandbox policy before anything
 *      spawns, and the terminal-execution binding surfaces the same refusal
 *      without ever reaching its spawn seam;
 *   2. the ROW-BASED surface (S17 workspace files — content in SQLite rows):
 *      hostile URIs (raw and percent-encoded traversal, encoded separators,
 *      null bytes, malformed escapes) are typed refusals and materialize no
 *      node anywhere.
 *
 * RED-FIRST evidence (the recorded loop): the sandbox-policy containment
 * checks and the URI-parser segment checks were each disabled in turn, the
 * suite FAILED, the control was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st01-{red,green}.txt.
 *
 * Honest scope note (G5, recorded — not a silence): the sandbox's user+net
 * namespace does NOT isolate mounts (no mount namespace; D27's own recorded
 * residual — "explicitly not a hardened microVM"). The policy layer governs
 * TOOL-ARGUMENT paths (workdir, payload paths, the row store); a raw payload
 * reading the host filesystem as the container uid is the recorded residual
 * the compose deployment (S35) owns, covered by the second-container
 * procedure in THREAT-COVERAGE.md §4. Nothing here dresses that up.
 *
 * Governing records: THREAT_MODEL §5 ST-01, D27, D23 rule 2 (the spawn seam),
 * E36, G3/G5.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SandboxPolicyError,
  prepareDirectoryInsideScope,
  resolveFileInsideScope,
} from "../../apps/user-runtime/src/modules/execution/sandbox-policy.ts";
import {
  makeTerminalExecutionBinding,
  type ExecutionToolDeps,
} from "../../apps/user-runtime/src/modules/execution/execution-tool-binding.ts";
import {
  makeExecutionAuthority,
  ToolBindingError,
  type ToolExecutionContext,
} from "../../apps/user-runtime/src/modules/tools/tool-binding.ts";
import { openDatabase } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import {
  WorkspaceFilesRepository,
  WorkspacePathError,
} from "../../apps/user-runtime/src/adapters/sqlite/workspace-files-repository.ts";
import { WriteLeasesRepository } from "../../apps/user-runtime/src/adapters/sqlite/write-leases-repository.ts";

const tempDirs: string[] = [];

function newTempRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `shera-s27-st01-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** The process-backed family always dispatches async; narrow it once (TS). */
function requireDispatch(binding: { executeAsync?: unknown }) {
  if (typeof binding.executeAsync !== "function") {
    throw new Error("the terminal-execution binding must dispatch through executeAsync");
  }
  return binding.executeAsync as (
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => Promise<{ ok: true; text: string } | { ok: false; errorCode: string; message: string }>;
}

/** An adversarial execution binding whose spawn seam refuses to be reached. */
function bindingThatMustNeverSpawn(workspaceRoot: string): {
  binding: ReturnType<typeof makeTerminalExecutionBinding>;
  spawnSpy: ReturnType<typeof vi.fn>;
} {
  const spawnSpy = vi.fn(() => {
    throw new Error("SPAWN REACHED — the sandbox policy must refuse before anything spawns");
  });
  const deps: ExecutionToolDeps = {
    spawn: spawnSpy as unknown as ExecutionToolDeps["spawn"],
    workspaceRoots: { ws_s27: workspaceRoot },
    terminalRecorder: null,
    artifacts: null,
    logFault: () => {},
  };
  return { binding: makeTerminalExecutionBinding(deps), spawnSpy };
}

function executionContext(workspaceId = "ws_s27"): ToolExecutionContext {
  return {
    authority: makeExecutionAuthority(),
    deadline: Date.now() + 5_000,
    nowMs: () => Date.now(),
    maxResponseBytes: 4_096,
    resourceLimits: {
      max_memory_mb: 1024,
      max_cpu_seconds: 5,
      max_processes: 32,
      max_disk_mb: 64,
    },
    signal: new AbortController().signal,
    execution: {
      execution_id: "exe_s27_st01",
      workspace_id: workspaceId,
      task_id: "task_s27_st01",
      conversation_id: "conv_s27_st01",
      agent_id: "agent_dev",
      capability: "code.exec",
      approval_id: null,
      grant_id: null,
    },
  };
}

describe("S27 ST-01 — filesystem scope: traversal and symlink escape (D27)", () => {
  let workspaceRoot: string;
  let outside: string;

  beforeEach(() => {
    const parent = newTempRoot("fs");
    workspaceRoot = join(parent, "workspace");
    outside = join(parent, "outside");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "canary.txt"), "OUTSIDE-SCOPE-SENTINEL", "utf8");
  });

  it("refuses a ../ traversal workdir and creates NOTHING outside the scope", () => {
    expect(() => prepareDirectoryInsideScope(workspaceRoot, "../../outside")).toThrow(
      SandboxPolicyError,
    );
    // The sentinel proves the refusal was real: nothing was created or
    // touched outside the workspace.
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(join(outside, "canary.txt"), "utf8")).toBe("OUTSIDE-SCOPE-SENTINEL");
    expect(existsSync(join(outside, "shera-escape"))).toBe(false);
  });

  it("refuses an absolute host path workdir (everything is scope-relative)", () => {
    expect(() => resolveFileInsideScope(workspaceRoot, outside)).toThrow(SandboxPolicyError);
  });

  it("refuses a planted FILE symlink pointing outside; the target is never read", () => {
    symlinkSync(join(outside, "canary.txt"), join(workspaceRoot, "innocent.txt"));
    expect(() => resolveFileInsideScope(workspaceRoot, "innocent.txt")).toThrow(SandboxPolicyError);
    // The planted link itself is untouched (the runtime never deletes hostile
    // material to make a check pass).
    expect(existsSync(join(workspaceRoot, "innocent.txt"))).toBe(true);
  });

  it("refuses a planted DIRECTORY symlink mid-path (escape through a created prefix)", () => {
    mkdirSync(join(outside, "deepr"), { recursive: true });
    mkdirSync(join(workspaceRoot, "sub"), { recursive: true });
    symlinkSync(join(outside, "deepr"), join(workspaceRoot, "sub", "link"));
    expect(() => prepareDirectoryInsideScope(workspaceRoot, "sub/link/escape.txt")).toThrow(
      SandboxPolicyError,
    );
    expect(existsSync(join(outside, "deepr", "escape.txt"))).toBe(false);
  });

  it("refuses a traversal that walks out through a symlinked scope root's REAL location", () => {
    const realDir = join(newTempRoot("pin"), "real");
    mkdirSync(realDir, { recursive: true });
    const linkRoot = join(newTempRoot("pin"), "link");
    symlinkSync(realDir, linkRoot);
    // A symlinked scope root pins to its real directory; escapes are judged
    // from there — so `..` out of the LINK is judged against the REAL root.
    expect(() => prepareDirectoryInsideScope(linkRoot, "../outside-escape")).toThrow(
      SandboxPolicyError,
    );
    expect(existsSync(join(realDir, "..", "outside-escape"))).toBe(false);
    // Positive control: the pinned root still serves in-scope paths.
    const resolved = resolveFileInsideScope(linkRoot, "inside.txt");
    expect(resolved.absolute.startsWith(realDir)).toBe(true);
  });
});

describe("S27 ST-01 — the terminal-execution binding refuses before its spawn seam", () => {
  it("a traversal workdir is the typed SANDBOX_PATH_ESCAPE and NOTHING spawns", async () => {
    const parent = newTempRoot("binding");
    const workspaceRoot = join(parent, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const { binding, spawnSpy } = bindingThatMustNeverSpawn(workspaceRoot);
    const dispatch = requireDispatch(binding);

    await expect(
      dispatch({ command: "echo pwned", workdir: "../../../outside" }, executionContext()),
    ).rejects.toThrow(ToolBindingError);
    await expect(
      dispatch({ command: "echo pwned", workdir: "../../../outside" }, executionContext()),
    ).rejects.toThrow(/SANDBOX_PATH_ESCAPE/);

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(existsSync(join(parent, "outside"))).toBe(false);
  });

  it("an absolute host-path workdir never reaches the spawn seam", async () => {
    const parent = newTempRoot("binding-abs");
    const workspaceRoot = join(parent, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const { binding, spawnSpy } = bindingThatMustNeverSpawn(workspaceRoot);
    const dispatch = requireDispatch(binding);

    await expect(
      dispatch({ command: "echo pwned", workdir: parent }, executionContext()),
    ).rejects.toThrow(/SANDBOX_PATH_ESCAPE/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe("S27 ST-01 — the row-based file store refuses hostile URIs (S17 surface)", () => {
  let dbPath: string;
  let files: WorkspaceFilesRepository;

  beforeEach(() => {
    dbPath = join(newTempRoot("store"), "runtime.db");
    const conn = openDatabase(dbPath);
    applyMigrations(conn.db);
    const tx = new SqliteTransactions(conn.db);
    files = new WorkspaceFilesRepository(tx, new WriteLeasesRepository(tx));
  });

  /** Every hostile shape the threat model names, raw and percent-encoded. */
  const HOSTILE_URIS: ReadonlyArray<[string, string]> = [
    ["raw traversal", "workspace://../../etc/passwd"],
    ["mid-path traversal", "workspace://folder/../../etc"],
    ["encoded traversal (%2e%2e)", "workspace://%2e%2e/%2e%2e/etc/passwd"],
    ["mixed-encoded traversal", "workspace://a/%2e%2e/%2E%2E/etc"],
    ["encoded separator (%2F)", "workspace://etc%2Fpasswd"],
    ["encoded backslash (%5C)", "workspace://a%5Cb"],
    ["encoded null (%00)", "workspace://x%00y"],
    ["agent-scope traversal", "agent://agent_dev/../../escape"],
    ["malformed escape (%ZZ)", "workspace://%ZZnotanescape"],
    ["foreign scheme", "ftp://host/path"],
    ["absolute-ish root escape", "workspace:////etc/passwd"],
  ];

  for (const [label, uri] of HOSTILE_URIS) {
    it(`refuses and materializes NOTHING: ${label}`, () => {
      expect(() =>
        files.write("ws_s27", uri, { type: "user", id: "user_alice" }, Buffer.from("x"), null),
      ).toThrow(WorkspacePathError);
      // The hostile URI is equally unresolvable: both the write and the read
      // surface are typed refusals — the URI can never address anything.
      expect(() => files.resolve("ws_s27", uri, { type: "user", id: "user_alice" })).toThrow(
        WorkspacePathError,
      );
    });
  }

  it("positive control: an in-scope percent-encoded name still works (the parser refuses escape, not encoding)", () => {
    const written = files.write(
      "ws_s27",
      "workspace://reports/a%20b.txt",
      { type: "user", id: "user_alice" },
      Buffer.from("legit"),
      "text/plain",
    );
    expect(Buffer.from(written.content).toString("utf8")).toBe("legit");
    const reread = files.read("ws_s27", "workspace://reports/a b.txt", {
      type: "user",
      id: "user_alice",
    });
    expect(Buffer.from(reread.content).toString("utf8")).toBe("legit");
  });

  it("a refused write leaves the database with no smuggled row (byte-level count unchanged)", () => {
    files.write(
      "ws_s27",
      "workspace://keep.txt",
      { type: "user", id: "user_alice" },
      Buffer.from("ok"),
      null,
    );
    const nodesBefore = countNodes(dbPath);
    try {
      files.write(
        "ws_s27",
        "workspace://../escape.txt",
        { type: "user", id: "user_alice" },
        Buffer.from("x"),
        null,
      );
      expect.unreachable("the hostile URI must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
    }
    expect(countNodes(dbPath)).toBe(nodesBefore);
  });
});

/** Count workspace_nodes rows by scanning the raw database bytes' sqlite
 * schema — a lightweight row counter via a second connection. */
function countNodes(dbPath: string): number {
  const conn = openDatabase(dbPath);
  const row = conn.db.prepare("SELECT COUNT(*) AS n FROM workspace_nodes").get() as {
    n: number;
  };
  conn.close();
  return row.n;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
