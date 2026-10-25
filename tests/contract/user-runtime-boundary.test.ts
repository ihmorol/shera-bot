/**
 * user-runtime boundary contract (S07; AC7, D23 rule 2, E12).
 *
 * The container-local gateway keeps its persistence and process boundaries
 * structural, not aspirational:
 * - SQL may exist ONLY under apps/user-runtime/src/adapters/sqlite/ — no
 *   module, service, or transport file speaks SQL.
 * - node:sqlite is imported ONLY by the sqlite adapter.
 * - child_process lives ONLY under adapters/process/ (the production spawn
 *   seams) plus the NAMED test-double exceptions below — each one is also a
 *   named PROCESS_EXCEPTIONS entry in scripts/boundary-guards.ts, so no
 *   exception exists in only one of the two guard surfaces.
 * - Every SQL statement in the repositories is workspace-scoped (E12): each
 *   statement string that reads or writes rows must mention workspace_id.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const USER_RUNTIME_SRC = join(process.cwd(), "apps/user-runtime/src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const allFiles = walk(USER_RUNTIME_SRC);
const relative = (p: string) => p.slice(USER_RUNTIME_SRC.length + 1);

describe("user-runtime SQL boundary (AC7, D23 rule 2)", () => {
  it("keeps every SQL statement inside adapters/sqlite", () => {
    const offenders: string[] = [];
    for (const file of allFiles) {
      if (file.includes(join("src", "adapters", "sqlite"))) {
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (
        /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|PRAGMA)\b/.test(
          text,
        )
      ) {
        offenders.push(relative(file));
      }
    }
    expect(offenders, `SQL outside adapters/sqlite: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps RUNTIME node:sqlite imports inside adapters/sqlite", () => {
    // `import type` lines are compile-time only (no runtime dependency) and
    // are allowed; a runtime import anywhere outside the adapter is not.
    const offenders = allFiles
      .filter((file) => !file.includes(join("src", "adapters", "sqlite")))
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some((line) => line.includes(`"node:sqlite"`) && !/^\s*import\s+type\b/.test(line)),
      )
      .map(relative);
    expect(offenders, `node:sqlite outside the adapter: ${offenders.join(", ")}`).toEqual([]);
  });

  it("keeps child_process out of user-runtime (production seams + named test-double exceptions only)", () => {
    // The fake process test doubles spawn REAL children on purpose —
    // supervision suites must exercise true heartbeat silence, crash exit
    // codes and kill escalation against live processes (D14 for fake Pi,
    // D32/E8 for the fake task worker). Each exception is mirrored in
    // scripts/boundary-guards.ts PROCESS_EXCEPTIONS with its rationale; the
    // production spawn seams live under adapters/process/.
    const childProcessExceptions = new Set([join("modules", "workers", "fake-task-worker.ts")]);
    const offenders = allFiles
      .filter((file) => !file.includes(join("src", "adapters", "process")))
      .filter((file) => !childProcessExceptions.has(relative(file)))
      .filter((file) => /child_process/.test(readFileSync(file, "utf8")))
      .map(relative);
    expect(offenders, `child_process outside adapters/process: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("actually scans the load-bearing surface (no vacuous pass)", () => {
    const scanned = allFiles.map(relative);
    expect(scanned.length).toBeGreaterThan(10);
    expect(scanned).toContain(join("adapters", "sqlite", "event-journal-repository.ts"));
    expect(scanned).toContain(join("adapters", "sqlite", "conversations-repository.ts"));
    expect(scanned).toContain(join("adapters", "sqlite", "connection.ts"));
    expect(scanned).toContain(join("modules", "events", "events.service.ts"));
    expect(scanned).toContain(join("modules", "runtime", "internal-api.ts"));
  });
});

describe("workspace scoping by construction (E12)", () => {
  // Extract string SQL from the repository files; every statement that reads
  // or writes rows must carry the workspace predicate or column.
  const repositoryFiles = [
    join(USER_RUNTIME_SRC, "adapters", "sqlite", "event-journal-repository.ts"),
    join(USER_RUNTIME_SRC, "adapters", "sqlite", "conversations-repository.ts"),
    join(USER_RUNTIME_SRC, "adapters", "sqlite", "command-receipts-repository.ts"),
    join(USER_RUNTIME_SRC, "adapters", "sqlite", "migrations.ts"),
  ];

  function sqlStatements(text: string): string[] {
    const chunks: string[] = [];
    for (const match of text.matchAll(/`([^`]*)`/g)) {
      chunks.push(match[1] ?? "");
    }
    for (const match of text.matchAll(/"([^"\n]*)"/g)) {
      chunks.push(match[1] ?? "");
    }
    return (
      chunks
        // schema_migrations is infrastructure bookkeeping (no product rows); the
        // E12 rule is about product data.
        .filter((chunk) => !chunk.includes("schema_migrations"))
        .filter((chunk) =>
          /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/.test(chunk),
        )
    );
  }

  it("every repository SQL statement is workspace-scoped", () => {
    const unscoped: string[] = [];
    for (const file of repositoryFiles) {
      for (const statement of sqlStatements(readFileSync(file, "utf8"))) {
        if (!statement.includes("workspace_id")) {
          unscoped.push(`${relative(file)}: ${statement.slice(0, 80)}`);
        }
      }
    }
    expect(unscoped, `statements without workspace scoping:\n${unscoped.join("\n")}`).toEqual([]);
  });

  it("the schema carries workspace_id on every product table", () => {
    const schema = readFileSync(
      join(USER_RUNTIME_SRC, "adapters", "sqlite", "migrations.ts"),
      "utf8",
    );
    for (const table of ["event_journal", "conversations", "command_receipts"]) {
      const tableSql = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      if (!tableSql.includes("workspace_id")) {
        throw new Error(`${table} schema does not declare workspace_id`);
      }
    }
  });
});
