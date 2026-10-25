#!/usr/bin/env node
/**
 * D23 rule 2 boundary guards (S07 5b) — static checks over shipped source.
 *
 * Guard 1 — SQL stays inside the SQLite repository adapters: across
 * apps/user-runtime/** and packages/**, SQL statements and `node:sqlite`
 * imports may appear ONLY under apps/user-runtime/src/adapters/sqlite/**
 * (the repositories + the committed migrations). Control-plane PostgreSQL
 * (drizzle) is a DIFFERENT persistence boundary owned by the central
 * database and is deliberately outside this guard's scope — the runtime's
 * container-local SQLite is what D23 rule 2 fences off here.
 *
 * Guard 2 — `child_process` stays inside the process-adapter boundary:
 * across apps/** and packages/** it may appear ONLY under
 * apps/user-runtime/src/adapters/process/**, apart from the control-plane
 * TEST-infrastructure helpers listed in PROCESS_EXCEPTIONS below. Those
 * helpers spawn postgres/openssl to run the S04/S05 integration suites —
 * removing them is a recorded owner decision, not something this guard
 * hides: every exception is named, with its reason, right here.
 *
 * Exits non-zero on any violation. Run: `pnpm boundary-guards`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCAN_ROOTS = ["apps", "packages"];
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

/** Paths (forward-slash, repo-relative) allowed to reference `child_process`. */
const PROCESS_BOUNDARY = "apps/user-runtime/src/adapters/process/";
const PROCESS_EXCEPTIONS = new Set([
  // Spawns openssl for the throwaway self-signed S05 HTTPS test certs.
  "apps/control-plane/test/helpers/test-server.ts",
  // Same HTTPS test-helper family (spawns the local mock backend tooling).
  "apps/control-plane/test/helpers/test-app.ts",
  // Spawns the ephemeral postgres cluster the S04/S05 DB suites run against.
  "apps/control-plane/test/helpers/pg-cluster.ts",
  // S09 kill -9 recovery probe: spawns the E8 mock runtime as a child process
  // so the probe can SIGKILL it mid-stream and verify restart recovery on the
  // same SQLite file (test-only; the runtime never spawns processes itself).
  "apps/user-runtime/test/helpers/mock-runtime-process.ts",
  // The D14 fake Pi test double: spawning a REAL child process is its purpose
  // — supervision suites must exercise true heartbeat silence, kill
  // escalation and crash semantics. The production Pi adapter will live in
  // the adapters/process/ seam (chunk 3 wires the spawn dependency there).
  "packages/pi-protocol/src/fake-pi.ts",
  // The S16 fake task worker test double: same rationale as the fake Pi —
  // worker supervision suites must exercise true heartbeat silence, crash
  // exit codes and the SIGTERM→SIGKILL escalation against live child
  // processes (D32 layer 3, E8). The production task-worker spawn seam will
  // live in the adapters/process/ boundary (chunk 3 wires it), and only the
  // factory spawns; the child script itself spawns nothing.
  "apps/user-runtime/src/modules/workers/fake-task-worker.ts",
]);

/** The only place SQL (and sqlite itself) may live in the runtime. */
const SQLITE_BOUNDARY = "apps/user-runtime/src/adapters/sqlite/";
/** Guard 1 scope: the runtime gateway + shared packages. Control-plane
 * PostgreSQL (drizzle) is a separate persistence boundary, not this guard's
 * subject — see the header note. */
const SQL_SCOPE_PREFIXES = ["apps/user-runtime/", "packages/"];

const SQL_PATTERNS: Array<[RegExp, string]> = [
  [/\bselect\b[^;]*\bfrom\b/i, "SELECT ... FROM"],
  [/\binsert\s+into\b/i, "INSERT INTO"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\bupdate\s+\w+\s+set\b/i, "UPDATE ... SET"],
  [/\bcreate\s+(table|index)\b/i, "CREATE TABLE/INDEX"],
  [/\bpragma\b/i, "PRAGMA"],
  [/\bbegin\s+(immediate|deferred|exclusive|transaction)\b/i, "BEGIN TRANSACTION"],
  // C-5: ATTACH DATABASE (and VACUUM INTO, which copies the database to an
  // arbitrary file) reach OUTSIDE the fenced database file — they must stay
  // inside the SQLite adapter like every other statement.
  [/\battach\s+database\b/i, "ATTACH DATABASE"],
  [/\bvacuum\b/i, "VACUUM"],
  [/node:sqlite/, "node:sqlite import"],
];

function toRepoPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split(sep).join("/");
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        files.push(...listSourceFiles(full));
      }
    } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

interface Violation {
  rule: string;
  path: string;
  line: number;
  detail: string;
}

const allFiles = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(REPO_ROOT, root))).map(
  toRepoPath,
);

const violations: Violation[] = [];

for (const path of allFiles) {
  const content = readFileSync(join(REPO_ROOT, path), "utf8");
  const lines = content.split("\n");

  const inSqliteBoundary = path.startsWith(SQLITE_BOUNDARY);
  const inProcessBoundary = path.startsWith(PROCESS_BOUNDARY);
  const processException = PROCESS_EXCEPTIONS.has(path);
  const inSqlScope = SQL_SCOPE_PREFIXES.some((prefix) => path.startsWith(prefix));

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (inSqlScope && !inSqliteBoundary) {
      for (const [pattern, label] of SQL_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            rule: `sql-outside-sqlite-adapters (${label})`,
            path,
            line: index + 1,
            detail: line.trim().slice(0, 120),
          });
        }
      }
    }
    if (!inProcessBoundary && !processException && line.includes("child_process")) {
      violations.push({
        rule: "child_process-outside-process-adapters",
        path,
        line: index + 1,
        detail: line.trim().slice(0, 120),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`boundary guards: FAIL — ${violations.length} violation(s)`);
  for (const violation of violations) {
    console.error(`  ${violation.path}:${violation.line} — ${violation.rule}`);
    console.error(`    ${violation.detail}`);
  }
  console.error(
    "SQL and node:sqlite belong only in apps/user-runtime/src/adapters/sqlite/;\n" +
      "child_process belongs only in apps/user-runtime/src/adapters/process/ (named exceptions in the script).",
  );
  process.exit(1);
}

console.log(
  `boundary guards: PASS — ${allFiles.length} source files scanned ` +
    "(SQL + sqlite only under adapters/sqlite; child_process only under adapters/process, named test-infra exceptions).",
);
