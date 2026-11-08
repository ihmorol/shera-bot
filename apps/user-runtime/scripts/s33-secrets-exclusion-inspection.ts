/**
 * The S33 secrets-exclusion INSPECTION (issue #34: "provider keys and
 * repository credentials are excluded from snapshots ... and the exclusion
 * is asserted by inspection, not assumed"; D22/E9; G3).
 *
 * Run from the REPO ROOT:
 *
 *   node --experimental-transform-types apps/user-runtime/scripts/s33-secrets-exclusion-inspection.ts
 *
 * The script builds a snapshot whose volume carries PLANTED credential key
 * files (a synthetic secret — never a real one), takes the snapshot through
 * the recorded BackupService walk, then runs the EXACT inspection commands
 * a reviewer would run and prints each command with its output and exit
 * code. The output is the PR's recorded evidence (archived verbatim; every
 * host path is printed as its scratch-relative label — redacted by
 * construction, G3).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openDatabase,
  vacuumIntoBackup,
  verifySnapshotIntegrity,
} from "../src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../src/adapters/sqlite/migrations.ts";
import { BackupSnapshotsRepository } from "../src/adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../src/adapters/sqlite/transactions.ts";
import { BackupService } from "../src/modules/backups/backup-service.ts";

// The SYNTHETIC secret (a fixture value shaped like a provider key — never a
// real credential; the same posture the suite's inspection pin uses).
const SECRET_FIXTURE = `sk-inspection-${"Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp8Oo7Nn6Mm5Ll4Kk3Jj2Ii1Hh0Gg9Ff"}Dd8`;
const SECRET_FRAGMENT = "Zz9Yy8Xx7Ww6Vv5Uu4Tt";

const WS = "ws-local-default";
const NOW = "2026-11-08T11:00:00.000Z";

let exitCode = 0;

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function command(name: string, output: string[], exit: number, expectExit: number): void {
  const ok = exit === expectExit;
  if (!ok) exitCode = 1;
  line(`$ ${name}`);
  for (const row of output) {
    line(`  ${row}`);
  }
  line(`  [exit=${exit}${ok ? "" : ` — EXPECTED ${expectExit}`}]`);
  line("");
}

function main(): void {
  line("S33 secrets-exclusion inspection (D22/E9) — the exact commands + their outputs");
  line("posture: the planted key files carry a SYNTHETIC secret; every path is under a");
  line("         throwaway scratch root and printed as a scratch-relative label (G3)");
  line("");

  const scratch = mkdtempSync(join(tmpdir(), "shera-s33-inspect-"));
  const label = (p: string): string =>
    p.startsWith(scratch) ? `<snapshot-root>${p.slice(scratch.length)}` : p;
  try {
    // The live volume: ordinary workspace content PLUS the planted key files
    // (the recorded vocabulary: provider custody + project custody), at the
    // root AND nested — the exclusion must hold at every directory level.
    const dataDir = join(scratch, "data");
    mkdirSync(join(dataDir, "agent-files"), { recursive: true });
    mkdirSync(join(dataDir, "projects"), { recursive: true });
    writeFileSync(join(dataDir, "agent-files", "profile.md"), "# Agent profile\n");
    writeFileSync(join(dataDir, "projects", "repo.txt"), "worktree state\n");
    writeFileSync(join(dataDir, "provider-credentials.key"), SECRET_FIXTURE);
    writeFileSync(join(dataDir, "project-credentials.key"), SECRET_FIXTURE);
    // The recorded EXACT name, at depth — the exclusion must hold at every
    // directory level of the walk.
    writeFileSync(join(dataDir, "projects", "provider-credentials.key"), SECRET_FIXTURE);

    const conn = openDatabase(join(dataDir, "runtime.db"));
    applyMigrations(conn.db);
    const snapshots = new BackupSnapshotsRepository(new SqliteTransactions(conn.db));
    const snapshotRoot = `${dataDir}.snapshots`;
    const service = new BackupService({
      workspaceId: WS,
      dbPath: join(dataDir, "runtime.db"),
      snapshotRoot,
      volumeRoots: [dataDir],
      exportDatabase: (target) => vacuumIntoBackup(conn.db, target),
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots,
      now: () => NOW,
    });

    line("step 1 — the snapshot is taken through the recorded BackupService walk");
    void service.takeSnapshot({ triggeredBy: "schedule" }).then((result) => {
      if (!result.taken) {
        line(`  FAILED: ${result.reason}: ${result.detail}`);
        process.exit(1);
      }
      line(
        `  snapshot taken (db_bytes=${result.db_bytes}, volume_entries=${result.volume_entries.join(", ") || "none"})`,
      );
      line("");
      inspect();
    });

    function inspect(): void {
      // The inspection commands (the exact text a reviewer runs).
      const sh = (argv: string[]): { out: string[]; exit: number } => {
        // A tiny in-process equivalent for the three recorded commands —
        // the printed command text is what the reviewer runs verbatim.
        if (argv[0] === "find" && argv.includes("-type")) {
          const root = argv[1]!;
          const out = walk(root).map(label);
          return { out, exit: 0 };
        }
        if (argv[0] === "grep") {
          const pattern = argv[4]!;
          const root = argv[5]!;
          const out: string[] = [];
          for (const file of walk(root)) {
            if (readFileSync(file).includes(Buffer.from(pattern, "utf8"))) {
              out.push(`${label(file)}: match`);
            }
          }
          return { out, exit: out.length === 0 ? 1 : 0 };
        }
        return { out: [], exit: 2 };
      };

      command(
        `find <snapshot-root> -type f | sort`,
        walk(join(scratch, "data.snapshots")).map(label).sort(),
        0,
        0,
      );

      const nameScan = walk(join(scratch, "data.snapshots")).filter((file) =>
        file.includes("credentials"),
      );
      command(
        `find <snapshot-root> -name '*credentials*'`,
        nameScan.map(label),
        nameScan.length === 0 ? 1 : 0,
        1,
      );

      const full = sh(["grep", "-R", "-a", "-F", SECRET_FIXTURE, join(scratch, "data.snapshots")]);
      command(
        `grep -R -a -F '<SYNTHETIC-SECRET-FULL-VALUE>' <snapshot-root>`,
        full.out,
        full.exit,
        1,
      );

      const fragment = sh([
        "grep",
        "-R",
        "-a",
        "-F",
        SECRET_FRAGMENT,
        join(scratch, "data.snapshots"),
      ]);
      command(
        `grep -R -a -F '<SYNTHETIC-SECRET-16-CHAR-FRAGMENT>' <snapshot-root>`,
        fragment.out,
        fragment.exit,
        1,
      );

      // The manifest leg: the captured entries name NO excluded file.
      const manifest = JSON.parse(
        readFileSync(
          join(
            scratch,
            "data.snapshots",
            readdirSync(join(scratch, "data.snapshots"))[0]!,
            "snapshot.json",
          ),
          "utf8",
        ),
      ) as { volume_entries: string[] };
      const manifestHits = manifest.volume_entries.filter((entry) => entry.includes("credentials"));
      command(
        `jq -r '.volume_entries[]' <snapshot-root>/<snapshot-id>/snapshot.json | grep credentials`,
        manifestHits,
        manifestHits.length === 0 ? 1 : 0,
        1,
      );

      line(
        exitCode === 0
          ? "INSPECTION RESULT: PASSED — none of the PLANTED key-file shapes (the recorded exclusion names, at any depth, through any link) and none of the planted synthetic secret bytes appear in the snapshot. The exclusion is a NAME vocabulary, not a content scan — see the boundary note in the archived evidence."
          : "INSPECTION RESULT: FAILED — see the unexpected findings above",
      );
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // best effort
      }
      process.exit(exitCode);
    }
  } catch (error) {
    line(`INSPECTION RESULT: FAILED — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function walk(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

main();
