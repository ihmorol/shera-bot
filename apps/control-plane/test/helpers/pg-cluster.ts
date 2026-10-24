/**
 * Disposable PostgreSQL 16 test cluster (S05 test harness).
 *
 * Docker is NOT usable on this machine (socket permission denied, no sudo),
 * so the harness drives the installed PostgreSQL 16 server binaries directly:
 * initdb creates a throwaway, user-owned data directory under /tmp and pg_ctl
 * starts it on a random localhost port with trust auth. Compose-based
 * infrastructure arrives in S35; this helper is the swappable seam for it
 * (recorded as an E-note in the S05 evidence pack).
 *
 * Every call creates an isolated cluster; tests stop it in afterAll.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * PostgreSQL server binary directory (cross-platform).
 *
 * The original S05 harness hardcoded the Debian path `/usr/lib/postgresql/16/bin`,
 * which made every control-plane and integration suite fail to even load on
 * Windows/macOS with `spawnSync ... ENOENT` (G4: a missing prerequisite must be a
 * clear configuration state, never a fake pass or a raw spawn error).
 *
 * Resolution order, first existing directory wins:
 *   1. `SHERA_PG_BIN` — explicit override (any platform).
 *   2. The platform's conventional install locations.
 *   3. `initdb` on PATH (covers Homebrew, chocolatey, and version-manager installs).
 *
 * When none resolve, `resolvePgBin` throws a typed, actionable message naming
 * every path that was probed, so the failure explains itself instead of
 * surfacing an opaque ENOENT from deep inside execFileSync.
 */
const PG_VERSION = "16";

const PG_BIN_CANDIDATES: readonly string[] = [
  // Debian/Ubuntu packaged installs.
  `/usr/lib/postgresql/${PG_VERSION}/bin`,
  `/usr/pgsql-${PG_VERSION}/bin`,
  // Red Hat/Fedora packaged installs.
  `/usr/pgsql/${PG_VERSION}/bin`,
  // Homebrew (Apple Silicon and Intel).
  `/opt/homebrew/opt/postgresql@${PG_VERSION}/bin`,
  `/usr/local/opt/postgresql@${PG_VERSION}/bin`,
  // Windows: the official EDB installer and the PostgreSQL zip/ chocolatey layout.
  `C:\\Program Files\\PostgreSQL\\${PG_VERSION}\\bin`,
  `C:\\Program Files (x86)\\PostgreSQL\\${PG_VERSION}\\bin`,
];

/**
 * Locate the PostgreSQL server binaries, or throw an actionable configuration
 * error. Exported so the resolution itself is unit-testable without a cluster.
 */
export function resolvePgBin(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const override = env.SHERA_PG_BIN;
  // `.exe` matters on Windows: `existsSync` is case- and extension-sensitive, so
  // checking only "initdb" would miss a perfectly good Windows install (review
  // finding F2 — the override branch originally had this gap, so SHERA_PG_BIN
  // could not work at all on Windows, the platform this fix targets).
  if (override && (exists(join(override, "initdb")) || exists(join(override, "initdb.exe")))) {
    return override;
  }

  const probed: string[] = [];
  for (const candidate of PG_BIN_CANDIDATES) {
    probed.push(candidate);
    if (exists(join(candidate, "initdb")) || exists(join(candidate, "initdb.exe"))) {
      return candidate;
    }
  }

  // PATH lookup: the directory containing a resolvable `initdb`. Uses the injected
  // `exists` (not the real filesystem) so the resolution contract is testable on
  // any host, exactly like the override and candidate branches above.
  const pathEntries = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    if (exists(join(entry, "initdb")) || exists(join(entry, "initdb.exe"))) {
      return entry;
    }
  }

  throw new Error(
    [
      `PostgreSQL ${PG_VERSION} server binaries were not found (G4: no fake pass).`,
      `Set SHERA_PG_BIN to the directory containing initdb, or put initdb on PATH.`,
      `Probed SHERA_PG_BIN=${override ?? "(unset)"};`,
      `directories: ${probed.join(", ")};`,
      `PATH entries: ${pathEntries.length} checked.`,
    ].join(" "),
  );
}

export interface TestCluster {
  /** postgres:// connection string (superuser "shera", trust auth). */
  connectionString: string;
  port: number;
  dataDir: string;
  socketDir: string;
  /** Stop PostgreSQL and remove the data directory. */
  stop(): Promise<void>;
}

/** Pick a free localhost port (best-effort; pg_ctl start retries on collision). */
async function tryFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    // The error handler is attached BEFORE listen(): a bind failure (EADDRNOTAVAIL,
    // EACCES) can be emitted during listen, and an unhandled 'error' event would
    // crash the worker instead of rejecting (review finding F12).
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (port > 0) resolve(port);
        else reject(new Error("no free port"));
      });
    });
  });
}

export async function startTestCluster(label: string): Promise<TestCluster> {
  // Resolved (and validated) before any temp directory is created, so a missing
  // PostgreSQL leaves no orphaned temp dirs behind.
  const pgBin = resolvePgBin();
  const root = mkdtempSync(join(tmpdir(), `shera-cp-${label}-`));
  const dataDir = join(root, "data");
  const socketDir = join(root, "socket");
  // PostgreSQL creates its unix-socket lock file inside -k <dir>: the
  // directory must exist before pg_ctl start (found on first run — the
  // masked original error was a missing socket directory).
  mkdirSync(socketDir, { recursive: true });
  const logFile = join(root, "postgres.log");
  const superuser = "shera";

  execFileSync(
    join(pgBin, "initdb"),
    [
      "-D",
      dataDir,
      "--no-locale",
      "--encoding=UTF8",
      `--username=${superuser}`,
      "--auth=trust",
      "--no-instructions",
    ],
    { stdio: "pipe" },
  );

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await tryFreePort();
    try {
      execFileSync(
        join(pgBin, "pg_ctl"),
        [
          "-D",
          dataDir,
          "-l",
          logFile,
          "-w",
          "-t",
          "30",
          "-o",
          `-p ${port} -k ${socketDir} -c listen_addresses=127.0.0.1`,
          "start",
        ],
        // On Windows, the server process can inherit pg_ctl's captured pipe
        // handles, so execFileSync waits for EOF until PostgreSQL exits.
        { stdio: "ignore" },
      );
      return {
        connectionString: `postgres://${superuser}@127.0.0.1:${port}/postgres`,
        port,
        dataDir,
        socketDir,
        async stop() {
          try {
            execFileSync(join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], {
              stdio: "pipe",
            });
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      lastError = error;
      // Best-effort cleanup for the retry; must not mask the original error.
      try {
        execFileSync(join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
          stdio: "ignore",
        });
      } catch {
        // Server never started — nothing to stop.
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
  throw new Error(`failed to start test cluster: ${String(lastError)}`);
}
