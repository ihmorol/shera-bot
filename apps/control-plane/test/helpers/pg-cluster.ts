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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PG_BIN = "/usr/lib/postgresql/16/bin";

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
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
    probe.on("error", reject);
  });
}

export async function startTestCluster(label: string): Promise<TestCluster> {
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
    join(PG_BIN, "initdb"),
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
        join(PG_BIN, "pg_ctl"),
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
        { stdio: "pipe" },
      );
      return {
        connectionString: `postgres://${superuser}@127.0.0.1:${port}/postgres`,
        port,
        dataDir,
        socketDir,
        async stop() {
          try {
            execFileSync(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], {
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
        execFileSync(join(PG_BIN, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
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
