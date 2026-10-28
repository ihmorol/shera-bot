/**
 * S19 chunk 2 — the credential-authenticated clone/fetch end-to-end (issue
 * #20; PRD §10, D22, E9, G3). Red-first: these tests pin the behaviors before
 * the wiring exists.
 *
 * WHAT IS PROVEN HERE (loopback-only, no network, E8): a real git clone and a
 * real git fetch over an HTTPS origin that REQUIRES basic authentication, with
 * the credential injected through the vault's buildAuthenticatedUrl seam —
 * the same call-time injection a GitHub private-clone would ride. The origin
 * is a real bare repository served by a loopback https server carrying a
 * committed self-signed TEST certificate (127.0.0.1 SAN; the key is a
 * throwaway fixture, not a secret — nothing in it authenticates anything
 * beyond this test's own server). The clone disables certificate VERIFICATION
 * for the loopback call via the process-env switch git honors; the setting is
 * never written into any repository config.
 *
 *   1. Clone WITH the credential succeeds end to end: the project row is
 *      registered, the secret is sealed into a project_credential row, and a
 *      byte scan over the SQLite file, the vault key, the clone's .git
 *      directory, the typed failure surface, and the fault log finds the
 *      secret NOWHERE (G3 at rest).
 *   2. Clone WITHOUT the credential fails (the origin demands auth), and the
 *      failure registers nothing (atomicity).
 *   3. refreshProject fetches new origin commits through the stored
 *      credential at call time.
 *   4. A REVOKED credential fails safely: the typed refusal fires BEFORE any
 *      git call (the origin server sees no request), nothing is fetched, and
 *      no secret crosses any surface (D22: revoke is revocation, not removal
 *      of responsibility).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpsServer, type Server, type ServerOptions } from "node:https";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { ProjectsRepository } from "../../adapters/sqlite/projects-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { EventsService } from "../events/events.service.ts";
import { ApprovalsService } from "../approvals/approvals.service.ts";
import { CredentialVault } from "../projects/credential-vault.ts";
import { GitService, GitServiceError } from "./git.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WS = "ws_s19_credential";
const USER = { type: "user", id: "user_001" } as const;
const AGENT_ID = "agent_general_assistant";
const NOW = "2026-10-29T12:00:00.000Z";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The loopback https origin: dumb HTTP protocol + basic auth
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(here, "..", "..", "..", "test", "fixtures");

/** A bare repository served over loopback https with basic auth (dumb protocol). */
interface LoopbackOrigin {
  url: string;
  close(): Promise<void>;
  /** Every path the server answered (for the no-request-after-revoke proof). */
  requests: string[];
  /** Push new commits from a seed worktree and refresh the dumb-protocol index. */
  pushCommit(relPath: string, content: string): Promise<void>;
}

async function startLoopbackOrigin(username: string, password: string): Promise<LoopbackOrigin> {
  const dir = makeTempDir("shera-s19-origin-https-");
  // A seed work repository with one commit, cloned bare as the served origin.
  const seed = join(dir, "seed");
  mkdirSync(seed, { recursive: true });
  const seedGit = simpleGit(seed);
  await seedGit.init(["-b", "main"]);
  await seedGit.addConfig("user.email", "origin@example.invalid");
  await seedGit.addConfig("user.name", "Origin Fixture");
  writeFileSync(join(seed, "README.md"), "# private origin\n");
  await seedGit.add(["-A"]);
  await seedGit.commit("initial commit");
  const bare = join(dir, "origin.git");
  await seedGit.clone(seed, bare, ["--bare"]);
  await simpleGit(bare).raw(["update-server-info"]);

  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const requests: string[] = [];
  const serverOptions: ServerOptions = {
    key: readFileSync(join(FIXTURE_DIR, "loopback-key.pem")),
    cert: readFileSync(join(FIXTURE_DIR, "loopback-cert.pem")),
  };
  const server: Server = createHttpsServer(serverOptions, (req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    requests.push(path);
    if (req.headers.authorization !== expected) {
      res.statusCode = 401;
      res.setHeader("www-authenticate", 'Basic realm="shera-test-origin"');
      res.end("authentication required");
      return;
    }
    // Serve the directory CONTAINING the bare repository (the URL path names
    // origin.git), guarded to that directory (test infra).
    const base = join(dir, path);
    if (!base.startsWith(dir)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    try {
      const body = readFileSync(base);
      res.statusCode = 200;
      if (path.endsWith("/info/refs") || path === "/HEAD") {
        res.setHeader("content-type", "text/plain");
      } else if (path.includes("/objects/pack/") && path.endsWith(".pack")) {
        res.setHeader("content-type", "application/x-git-packed-objects");
      } else if (path.includes("/objects/pack/") && path.endsWith(".idx")) {
        res.setHeader("content-type", "application/x-git-packed-objects-toc");
      } else if (path.startsWith("/objects/")) {
        res.setHeader("content-type", "application/x-git-loose-object");
      } else {
        res.setHeader("content-type", "text/plain");
      }
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const seedWorktree = join(dir, "push-work");
  await simpleGit(dir).clone(seed, seedWorktree);
  const pushGit = simpleGit(seedWorktree);

  return {
    url: `https://127.0.0.1:${port}/origin.git`,
    requests,
    async pushCommit(relPath, content) {
      mkdirSync(dirname(join(seedWorktree, relPath)), { recursive: true });
      writeFileSync(join(seedWorktree, relPath), content);
      await pushGit.add(["-A"]);
      await pushGit.commit(`origin update: ${relPath}`);
      await pushGit.push(["../origin.git", "main"]);
      await simpleGit(bare).raw(["update-server-info"]);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// The runtime environment
// ---------------------------------------------------------------------------

interface TestEnv {
  dir: string;
  conn: SqliteConnection;
  projects: ProjectsRepository;
  git: GitService;
  projectsRoot: string;
  faults: Array<{ event: string; fields: Record<string, unknown> }>;
}

function newEnv(): TestEnv {
  const dir = makeTempDir("shera-runtime-s19-cred-");
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const journal = new EventJournalRepository(tx);
  const events = new EventsService(journal, tx);
  const approvalsRepository = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepository,
    operations: new OperationsRepository(tx),
    clock: () => NOW,
  });
  const projects = new ProjectsRepository(tx);
  const projectsRoot = join(dir, "projects");
  mkdirSync(projectsRoot, { recursive: true });
  const faults: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const git = new GitService({
    projects,
    vault: new CredentialVault(join(dir, "project-credentials.key")),
    approvals,
    approvalsRepository,
    tx,
    projectsRoot,
    // The loopback fixture's self-signed test certificate: wired as the
    // service's git ENVIRONMENT (simple-git's allowEnvironment seam), the
    // same seam a production deployment would use for a corporate CA bundle.
    // Nothing is persisted into any repository's config.
    gitEnvironment: { GIT_SSL_NO_VERIFY: "1" },
    clock: () => NOW,
    logFault: (event, fields) => faults.push({ event, fields }),
  });
  return { dir, conn, projects, git, projectsRoot, faults };
}

const openEnvs: TestEnv[] = [];

function trackedEnv(): TestEnv {
  const env = newEnv();
  openEnvs.push(env);
  return env;
}

const openServers: LoopbackOrigin[] = [];

afterEach(() => {
  for (const env of openEnvs.splice(0)) {
    env.conn.close();
  }
});

const SECRET = "tok_loopback_e2e_9f8e7d6c";
const USERNAME = "git-user";

describe("credential-authenticated clone end to end", () => {
  it("clones through buildAuthenticatedUrl, seals the secret, and leaks it nowhere (G3)", async () => {
    const env = trackedEnv();
    const origin = await startLoopbackOrigin(USERNAME, SECRET);
    openServers.push(origin);

    const project = await env.git.importProject({
      workspace_id: WS,
      name: "private-repo",
      actor: USER,
      source: {
        kind: "git_url",
        url: origin.url,
        credential: { username: USERNAME, secret: SECRET },
      },
    });

    // The clone really happened over https: the file landed, the remote is
    // stored credential-free.
    expect(existsSync(join(project.repo_path, "README.md"))).toBe(true);
    expect(project.source_url).not.toContain("@");
    expect(project.source_url).not.toContain(SECRET);
    const config = readFileSync(join(project.repo_path, ".git", "config"), "utf8");
    expect(config).not.toContain(SECRET);
    expect(config).not.toContain(`${USERNAME}:`);

    // The secret was sealed as the project's token credential at import time.
    const credentials = env.git.listCredentials(WS, project.project_id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.credential_kind).toBe("token");
    expect(credentials[0]?.masked_hint).not.toContain(SECRET);

    // G3 at rest: the raw secret appears NOWHERE in durable state — the
    // database (every row AND every journalled event), the vault key file,
    // EVERY file under the clone's .git directory, and the fault log.
    const dbBytes = readFileSync(join(env.dir, "runtime.db"));
    expect(dbBytes.includes(Buffer.from(SECRET, "utf8"))).toBe(false);
    expect(
      readFileSync(join(env.dir, "project-credentials.key")).includes(Buffer.from(SECRET, "utf8")),
    ).toBe(false);
    const gitDir = join(project.repo_path, ".git");
    const gitFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          gitFiles.push(full);
        }
      }
    };
    walk(gitDir);
    for (const file of gitFiles) {
      expect(readFileSync(file).includes(Buffer.from(SECRET, "utf8"))).toBe(false);
    }
    expect(JSON.stringify(env.faults)).not.toContain(SECRET);
  });

  it("fails the clone against an auth-required origin without a credential, registering nothing", async () => {
    const env = trackedEnv();
    const origin = await startLoopbackOrigin(USERNAME, SECRET);
    openServers.push(origin);

    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "locked-out",
        actor: USER,
        source: { kind: "git_url", url: origin.url },
      }),
    ).rejects.toThrow(GitServiceError);
    expect(env.projects.listProjects(WS)).toEqual([]);
    expect(readdirSync(env.projectsRoot)).toEqual([]);
    expect(JSON.stringify(env.faults)).not.toContain(SECRET);
  });

  it("refuses a credential on a non-https URL typed (the vault seam's own guard)", async () => {
    const env = trackedEnv();
    await expect(
      env.git.importProject({
        workspace_id: WS,
        name: "wrong-scheme",
        actor: USER,
        source: {
          kind: "git_url",
          url: "file:///tmp/not-a-remote",
          credential: { username: USERNAME, secret: SECRET },
        },
      }),
    ).rejects.toThrow(/https/i);
    expect(env.projects.listProjects(WS)).toEqual([]);
  });
});

describe("credential-authenticated fetch end to end", () => {
  it("fetches new origin commits through the stored credential at call time", async () => {
    const env = trackedEnv();
    const origin = await startLoopbackOrigin(USERNAME, SECRET);
    openServers.push(origin);
    const project = await env.git.importProject({
      workspace_id: WS,
      name: "private-repo",
      actor: USER,
      source: {
        kind: "git_url",
        url: origin.url,
        credential: { username: USERNAME, secret: SECRET },
      },
    });
    const before = String(await simpleGit(project.repo_path).revparse(["origin/main"])).trim();

    await origin.pushCommit("docs/new-note.md", "fetched later\n");
    const refreshed = await env.git.refreshProject(WS, project.project_id);
    expect(refetched(origin)).toBe(true);
    const after = String(await simpleGit(project.repo_path).revparse(["origin/main"])).trim();
    expect(after).not.toBe(before);
    expect(refreshed.fetched).toBe(true);
    // The .git directory still carries no credential material after the fetch.
    expect(readFileSync(join(project.repo_path, ".git", "FETCH_HEAD"), "utf8")).not.toContain(
      SECRET,
    );
  });

  it("fails safely on a revoked credential: typed refusal before any git call", async () => {
    const env = trackedEnv();
    const origin = await startLoopbackOrigin(USERNAME, SECRET);
    openServers.push(origin);
    const project = await env.git.importProject({
      workspace_id: WS,
      name: "private-repo",
      actor: USER,
      source: {
        kind: "git_url",
        url: origin.url,
        credential: { username: USERNAME, secret: SECRET },
      },
    });
    const stored = env.git.listCredentials(WS, project.project_id)[0];
    if (!stored) throw new Error("expected the sealed credential");
    await origin.pushCommit("docs/after-revoke.md", "must not be fetched\n");
    await env.git.revokeCredential(WS, project.project_id, stored.credential_id);
    // The import itself fetched refs; snapshot the count so the assertion
    // below proves the REVOKED refresh made no request of its own.
    const requestsAtRevoke = origin.requests.length;
    await expect(env.git.refreshProject(WS, project.project_id)).rejects.toThrow(/revoked/i);
    // The origin saw NO new request: the refusal fired before any network call.
    expect(origin.requests.length).toBe(requestsAtRevoke);
    // The typed refusal carries no secret; the fault log neither.
    expect(JSON.stringify(env.faults)).not.toContain(SECRET);
    expect(existsSync(join(project.repo_path, "docs"))).toBe(false);
  });
});

/** True when the origin served a dumb-protocol ref advertisement since its start. */
function refetched(origin: LoopbackOrigin): boolean {
  return origin.requests.some((path) => path.endsWith("/info/refs"));
}
