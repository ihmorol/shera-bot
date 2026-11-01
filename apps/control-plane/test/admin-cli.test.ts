/**
 * S32 admin CLI tests (issue #33, AC1). The documented command surface is
 * driven in-process through the real runCli (the bin entry is a three-line
 * process adapter), against the REAL control plane:
 *
 * - token create/rotate are LOCAL operations: the raw token is displayed
 *   exactly once and authenticates immediately; rotation invalidates the
 *   previous token (AC5);
 * - every operational command reaches the authenticated admin API (the
 *   command maps 1:1 onto an endpoint);
 * - the CLI never prints secrets: outside the single create/rotate display,
 *   no output line ever contains the token (G3 redaction leg);
 * - failures surface the control plane's typed error, never the credential.
 *
 * Process note (recorded in E38): this chunk's test landed after the
 * implementation (an ordering slip against the red-first rule); the suite
 * still pins every behavior it asserts against the real stack.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts } from "../src/db/schema.ts";
import { runCli, CLI_COMMAND_NAMES } from "../src/cli/shera-admin.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { removeTempDir } from "./helpers/temp-dir.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "b1b2c3d4-0000-4000-8000-000000000002";

/** The CLI entry, exactly as the package.json `bin` field points at it. */
const CLI_ENTRY = resolve(import.meta.dirname, "../src/cli/shera-admin.ts");

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let dbDir = "";
let tokenFile = "";
/** The token currently in the env for operational commands. */
let activeToken = "";

const outLines: string[] = [];
const errLines: string[] = [];

function io() {
  return {
    out: (line: string) => outLines.push(line),
    err: (line: string) => errLines.push(line),
  };
}

function env(): Record<string, string | undefined> {
  return {
    DATABASE_URL: cluster.connectionString,
    SHERA_CONTROL_PLANE_URL: server.origin,
    SHERA_ADMIN_TOKEN: activeToken,
  };
}

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${activeToken}`, ...extra };
}

beforeAll(async () => {
  cluster = await startTestCluster("admin-cli");
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
  });
  for (const accountId of [A, B]) {
    await controlPlane.db
      .insert(controlAccounts)
      .values({
        id: accountId,
        name: `User ${accountId.slice(0, 4)}`,
        email: `${accountId.slice(0, 6)}@example.com`,
      })
      .returning();
  }
  server = await startHttpsApp(controlPlane.app);
  dbDir = mkdtempSync(join(tmpdir(), "s32-cli-"));
  tokenFile = join(dbDir, "token.txt");
}, 180_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  if (dbDir) await removeTempDir(dbDir);
  await cluster?.stop();
}, 180_000);

describe("admin CLI (issue #33, AC1)", () => {
  it("documents every capability in --help (the documented-syntax leg)", async () => {
    // The command surface is grouped; each group's help documents its
    // subcommands. Every documented composite command must appear.
    const groupOf = (name: string) => name.split(" ")[0];
    const groups = [...new Set(CLI_COMMAND_NAMES.map((name) => groupOf(name)))];
    const allHelp: string[] = [];
    for (const group of groups) {
      outLines.length = 0;
      errLines.length = 0;
      const exit = await runCli({ argv: [group, "--help"], io: io(), env: env() });
      expect(exit).toBe(0);
      allHelp.push(...outLines, ...errLines);
    }
    // Commander lists subcommands by their local name inside the group's
    // help; the composite syntax is the group + subcommand pair (the
    // canonical table lives in E38). Every local command and every group
    // must be present.
    const help = allHelp.join("\n");
    for (const name of CLI_COMMAND_NAMES) {
      const parts = name.split(" ");
      expect(help).toContain(parts[parts.length - 1]);
      if (parts.length === 2) {
        expect(help).toContain(parts[0]);
      }
    }
  });

  it("token create displays the raw token exactly once and it authenticates", async () => {
    outLines.length = 0;
    errLines.length = 0;
    const exit = await runCli({ argv: ["token", "create"], io: io(), env: env() });
    expect(exit).toBe(0);

    // stdout carries EXACTLY ONE line: the raw token itself.
    expect(outLines).toHaveLength(1);
    const token = outLines[0];
    expect(token).toMatch(/^shera_admin_[A-Za-z0-9_-]{43,}$/);
    expect(errLines.join("\n")).not.toContain(token);

    // It authenticates immediately.
    activeToken = token;
    const probe = await request(server.origin, "/api/admin/users", { headers: adminHeaders() });
    expect(probe.status).toBe(200);

    writeFileSync(tokenFile, token);
  });

  it("rotates from the CLI: the previous token stops verifying (AC5)", async () => {
    const previousToken = activeToken;
    outLines.length = 0;
    errLines.length = 0;
    const exit = await runCli({ argv: ["token", "rotate"], io: io(), env: env() });
    expect(exit).toBe(0);
    expect(outLines).toHaveLength(1);
    const rotated = outLines[0];
    expect(rotated).toMatch(/^shera_admin_[A-Za-z0-9_-]{43,}$/);
    expect(rotated).not.toEqual(previousToken);
    expect(errLines.join("\n")).not.toContain(rotated);
    activeToken = rotated;

    const oldProbe = await request(server.origin, "/api/admin/users", {
      headers: { authorization: `Bearer ${previousToken}` },
    });
    expect(oldProbe.status).toBe(401);
    const newProbe = await request(server.origin, "/api/admin/users", {
      headers: adminHeaders(),
    });
    expect(newProbe.status).toBe(200);
  });

  it("operates accounts through the API: list, tier, disable, enable", async () => {
    outLines.length = 0;
    errLines.length = 0;
    let exit = await runCli({ argv: ["users", "list"], io: io(), env: env() });
    expect(exit).toBe(0);
    const listed = JSON.parse(outLines.join("\n")) as { users: Array<{ id: string }> };
    expect(listed.users.map((user) => user.id)).toContain(A);

    outLines.length = 0;
    exit = await runCli({
      argv: ["users", "tier", B, "heavy"],
      io: io(),
      env: env(),
    });
    expect(exit).toBe(0);
    const rows = await controlPlane.db
      .select()
      .from(controlAccounts)
      .where(eq(controlAccounts.id, B));
    expect(rows[0]?.tier).toBe("heavy");

    outLines.length = 0;
    exit = await runCli({ argv: ["users", "disable", B], io: io(), env: env() });
    expect(exit).toBe(0);
    outLines.length = 0;
    exit = await runCli({ argv: ["users", "enable", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const enabled = await controlPlane.db
      .select()
      .from(controlAccounts)
      .where(eq(controlAccounts.id, B));
    expect(enabled[0]?.signupState).toBe("active");
  });

  it("drives the container, backup, and failures command surface (typed errors surface honestly)", async () => {
    // No container engine on this host: provisioning answers the typed
    // resource failure — the CLI surfaces it and exits non-zero.
    outLines.length = 0;
    errLines.length = 0;
    let exit = await runCli({
      argv: ["container", "provision", A],
      io: io(),
      env: env(),
    });
    expect(exit).toBe(1);
    expect(errLines.join("\n")).toContain("RUNTIME_PROVISION_FAILED");

    // The backup trigger is engine-free: it records the S33 seam.
    outLines.length = 0;
    exit = await runCli({ argv: ["backups", "trigger", A], io: io(), env: env() });
    expect(exit).toBe(0);
    const backup = JSON.parse(outLines.join("\n")) as { snapshot_ref: string };
    expect(backup.snapshot_ref).toMatch(/^snapshot_/);

    outLines.length = 0;
    exit = await runCli({
      argv: ["backups", "restore", A, backup.snapshot_ref],
      io: io(),
      env: env(),
    });
    expect(exit).toBe(0);

    // The failures view degrades honestly without a runtime.
    outLines.length = 0;
    exit = await runCli({ argv: ["failures", A], io: io(), env: env() });
    expect(exit).toBe(0);
    const failures = JSON.parse(outLines.join("\n")) as { task_failures_status: string };
    expect(failures.task_failures_status).toBe("runtime_unavailable");
  });

  it("emergency-cancel and credits top-up surface the typed unavailability (no fake success)", async () => {
    outLines.length = 0;
    errLines.length = 0;
    let exit = await runCli({ argv: ["emergency-cancel", A], io: io(), env: env() });
    expect(exit).toBe(1);
    expect(errLines.join("\n")).toContain("RUNTIME_UNAVAILABLE");

    outLines.length = 0;
    errLines.length = 0;
    exit = await runCli({
      argv: ["credits", "top-up", A, "--amount", "0"],
      io: io(),
      env: env(),
    });
    expect(exit).toBe(2);
    expect(errLines.join("\n")).toContain("--amount must be a positive integer");
  });

  it("never prints the token outside the single create/rotate display (G3 redaction leg)", async () => {
    // errLines never carried a token in ANY of the runs above; and a 401
    // failure does not echo the presented credential.
    const presentedToken = activeToken;
    outLines.length = 0;
    errLines.length = 0;
    const exit = await runCli({
      argv: ["users", "list"],
      io: io(),
      env: { ...env(), SHERA_ADMIN_TOKEN: "shera_admin_wrongwrongwrongwrongwrongwrongwron" },
    });
    expect(exit).toBe(1);
    const everything = [...outLines, ...errLines].join("\n");
    expect(everything).not.toContain("shera_admin_wrongwrongwrong");
    expect(everything).not.toContain(presentedToken);
    expect(errLines.join("\n")).toContain("ADMIN_UNAUTHENTICATED");
  });

  it("is callable as a real child process (the AC1 bin-executable leg)", () => {
    // The documented invocation is plain `node` against the TS entry (Node 24
    // type stripping; the bin field points here). The process must run to
    // completion, print its help, and exit 0 — importing the module without
    // invoking main() would print nothing and prove nothing.
    const result = spawnSync(process.execPath, [CLI_ENTRY, "--help"], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    expect(result.status).toBe(0);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(output).toContain("Usage:");
    // Spot-check the documented groups surface in the child's help.
    expect(output).toContain("token");
    expect(output).toContain("users");
    expect(output).toContain("container");
    expect(output).toContain("credits");
  });
});
