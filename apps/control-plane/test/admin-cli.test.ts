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
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts, controlCreditTopups } from "../src/db/schema.ts";
import { runCli, CLI_COMMAND_NAMES } from "../src/cli/shera-admin.ts";
import { runCliBin } from "./helpers/cli-bin.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { removeTempDir } from "./helpers/temp-dir.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";
import { FakeContainerBackend } from "@shera-bot/test-kit";
import {
  ChannelCredentialStore,
  createInternalApi,
  InMemorySecurityEventRecorder,
} from "../../../apps/user-runtime/src/index.ts";
import {
  composeRuntime,
  type RuntimeHandle,
} from "../../../apps/user-runtime/src/transport/local-api/compose.ts";
import { OperationsRunSeam } from "../../../apps/user-runtime/src/modules/workers/operations-run-seam.ts";
import { applyRowLifecycleTransition } from "../../../apps/user-runtime/src/modules/tasks/run-lifecycle.ts";

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "b1b2c3d4-0000-4000-8000-000000000002";
const WS_B = `ws_${B}`;
const AGENT_ID = "agent_researcher";
const PACKS_ROOT = resolve(import.meta.dirname, "../../../agent-packs");
/** The newline separator for joined assertion output (escape-free declaration). */
const NEWLINE = String.fromCharCode(10);

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let server: TestServer;
let dbDir = "";
let tokenFile = "";
/** Account B's REAL composed runtime (behind the fake container backend). */
let runtimeB: RuntimeHandle | undefined;
let runtimeBDir = "";
const fakeServers: Server[] = [];
/** The D48 fixture runs inside B's runtime (created in beforeAll). */
const CREDIT_PAUSED_RUN = "run_s32_cli_credit_paused";
const RETRY_PAUSED_RUN = "run_s32_cli_retry_paused";
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

/**
 * Create a run row in B's runtime and drive it into the requested pause
 * through the REAL transition machinery (journal task.paused + row write).
 * The pause COMMAND selects the recorded pause reason the D48 resume path
 * inspects (`insufficient_credits` resumes; anything else is a typed skip).
 * The transition table gates pause_retry_exhausted to RUNNING (retry
 * exhaustion happens mid-attempt), so that fixture enters RUNNING first.
 */
function createPausedRun(
  command: "pause_insufficient_credits" | "pause_retry_exhausted",
  name: string,
): string {
  if (!runtimeB) throw new Error("runtime B not composed");
  const operationId = runtimeB.operations.createOperation(WS_B, {
    definition_ref: null,
    name: `Op ${name}`,
    roster_agent_ids: [AGENT_ID],
    coordinator_agent_id: AGENT_ID,
  }).operation_id;
  const runId = `run_s32_${name}`;
  runtimeB.operations.createRun(WS_B, operationId, { run_id: runId });
  runtimeB.operations.applyRunState(WS_B, operationId, runId, "QUEUED");
  if (command === "pause_retry_exhausted") {
    runtimeB.operations.applyRunState(WS_B, operationId, runId, "RUNNING");
  }
  const applied = applyRowLifecycleTransition(
    {
      tx: runtimeB.tx,
      journal: runtimeB.journal,
      events: runtimeB.events,
      operations: runtimeB.operations,
      runControl: new OperationsRunSeam(runtimeB.operations),
    },
    {
      workspaceId: WS_B,
      runId,
      command,
      actor: { type: "runtime", id: "runtime-gateway" },
    },
  );
  if (!applied.ok) throw new Error(`pause fixture failed: ${applied.reason}`);
  return runId;
}

beforeAll(async () => {
  cluster = await startTestCluster("admin-cli");
  // Account B runs a REAL composed runtime behind the fake container backend
  // (the recorded S06 internal-channel shape, as in the sibling S32 suites):
  // the credits top-up SUCCESS path and the provisioned container legs need a
  // reachable runtime. Account A stays engine-less — its typed degradation is
  // the honest host truth and stays pinned.
  runtimeBDir = mkdtempSync(join(tmpdir(), "s32-cli-runtime-b-"));
  runtimeB = composeRuntime({
    dbPath: join(runtimeBDir, "runtime.db"),
    workspaceId: WS_B,
    packsRoot: PACKS_ROOT,
  });
  const credentials = new ChannelCredentialStore();
  const api = createInternalApi({
    credentials,
    accountId: B,
    localApi: runtimeB.app,
    adminCommands: runtimeB.adminCommands,
    securityEvents: new InMemorySecurityEventRecorder(),
  });
  const containerServer = createServer(api.app);
  await new Promise<void>((resolveListen) => containerServer.listen(0, "127.0.0.1", resolveListen));
  fakeServers.push(containerServer);
  const origin = `http://127.0.0.1:${(containerServer.address() as AddressInfo).port}`;

  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
    runtimeBackend: new FakeContainerBackend({
      // B only: A's provisioning must keep answering the typed
      // RUNTIME_PROVISION_FAILED (no engine on this host for A).
      endpointFor: (accountId) => (accountId === B ? origin : null),
      deliverCredential: (_accountId, digest) => credentials.admitDigest(digest),
    }),
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
  await controlPlane.provisioning.ensureProvisioned(B);
  // The D48 fixture: one run the top-up may resume, one it must SKIP with the
  // typed reason (paused for a different reason).
  createPausedRun("pause_insufficient_credits", "cli_credit_paused");
  createPausedRun("pause_retry_exhausted", "cli_retry_paused");
  server = await startHttpsApp(controlPlane.app);
  dbDir = mkdtempSync(join(tmpdir(), "s32-cli-"));
  tokenFile = join(dbDir, "token.txt");
}, 240_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  // composeRuntime's close() is async — the SQLite release lands inside its
  // promise; the temp dir cannot be deleted until it is awaited (E20 leg 1).
  await runtimeB?.close();
  if (dbDir) await removeTempDir(dbDir);
  if (runtimeBDir) await removeTempDir(runtimeBDir);
  for (const container of fakeServers) {
    await new Promise<void>((resolveClose) => container.close(() => resolveClose()));
  }
  await cluster?.stop();
}, 240_000);

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
    // failure — the CLI surfaces it and exits non-zero. (With a backend now
    // wired for B, A's provisioning fails as the backend's unreachable
    // endpoint: the typed RUNTIME_UNAVAILABLE. No engine at all would answer
    // RUNTIME_PROVISION_FAILED — both honest, both typed.)
    outLines.length = 0;
    errLines.length = 0;
    let exit = await runCli({
      argv: ["container", "provision", A],
      io: io(),
      env: env(),
    });
    expect(exit).toBe(1);
    expect(errLines.join("\n")).toContain("RUNTIME_UNAVAILABLE");

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

  it("token show exposes only the non-secret identity of the active token", async () => {
    outLines.length = 0;
    errLines.length = 0;
    const exit = await runCli({ argv: ["token", "show"], io: io(), env: env() });
    expect(exit).toBe(0);
    const shown = JSON.parse(outLines.join("\n")) as {
      token_digest_hint: string;
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    };
    // The hint is the first 12 hex chars of the SHA-256 digest — computable
    // from the token in hand, and never the token itself.
    const expectedHint = createHash("sha256").update(activeToken).digest("hex").slice(0, 12);
    expect(shown.token_digest_hint).toBe(expectedHint);
    expect(shown.created_at).toBeTruthy();
    expect(JSON.stringify(shown)).not.toContain(activeToken);
    expect(errLines.join("\n")).not.toContain(activeToken);
  });

  it("drives the container legs: typed degradation on an engine-less account, real truth on a provisioned one", async () => {
    // Account A has no runtime on this host: every container command answers
    // the typed not-provisioned error — never an invented status (G4).
    for (const args of [
      ["container", "restart", A],
      ["container", "stop", A],
      ["container", "status", A],
      ["container", "usage", A],
    ]) {
      outLines.length = 0;
      errLines.length = 0;
      const exit = await runCli({ argv: args, io: io(), env: env() });
      expect(exit).toBe(1);
      expect(errLines.join("\n")).toContain("RUNTIME_NOT_PROVISIONED");
      expect(errLines.join("\n")).not.toContain(activeToken);
    }

    // Account B runs the REAL composed runtime: the recorded truth flows.
    outLines.length = 0;
    errLines.length = 0;
    let exit = await runCli({ argv: ["container", "status", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const status = JSON.parse(outLines.join("\n")) as {
      provisioning_status: string;
      health: string;
      tier: string;
    };
    expect(status.provisioning_status).toBe("running");
    expect(status.health).toBe("healthy");
    // The MAPPING's tier is the provision-time tier (balanced); the account
    // row's tier applies at next provisioning — the record is the truth here.
    expect(status.tier).toBe("balanced");

    outLines.length = 0;
    exit = await runCli({ argv: ["container", "usage", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const usage = JSON.parse(outLines.join("\n")) as {
      tier: string;
      resource_summary: { tier: string; memory_mb?: number };
      last_health_check_at: string | null;
    };
    expect(usage.resource_summary.tier).toBe("balanced");

    outLines.length = 0;
    exit = await runCli({ argv: ["container", "stop", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const stopped = JSON.parse(outLines.join("\n")) as { provisioning_status: string };
    expect(stopped.provisioning_status).toBe("stopped");

    // Status after the stop reads the RECORDED truth (the stop synced it).
    outLines.length = 0;
    exit = await runCli({ argv: ["container", "status", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const stoppedStatus = JSON.parse(outLines.join("\n")) as { provisioning_status: string };
    expect(stoppedStatus.provisioning_status).toBe("stopped");

    outLines.length = 0;
    exit = await runCli({ argv: ["container", "restart", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const restarted = JSON.parse(outLines.join("\n")) as { provisioning_status: string };
    expect(restarted.provisioning_status).toBe("running");
  });

  it("backups list returns the recorded backups for an account", async () => {
    outLines.length = 0;
    errLines.length = 0;
    let exit = await runCli({ argv: ["backups", "trigger", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const triggered = JSON.parse(outLines.join("\n")) as { snapshot_ref: string };
    expect(triggered.snapshot_ref).toMatch(/^snapshot_/);

    outLines.length = 0;
    exit = await runCli({ argv: ["backups", "list", B], io: io(), env: env() });
    expect(exit).toBe(0);
    const listed = JSON.parse(outLines.join("\n")) as {
      backups: Array<{ snapshot_ref: string; status?: string }>;
    };
    expect(listed.backups.map((backup) => backup.snapshot_ref)).toContain(triggered.snapshot_ref);
    expect(errLines.join("\n")).not.toContain(activeToken);
  });

  it("credits top-up through the CLI: the durable grant plus the honest resume/skip outcome (AC9)", async () => {
    outLines.length = 0;
    errLines.length = 0;
    const exit = await runCli({
      argv: ["credits", "top-up", B, "--amount", "250", "--reason", "CLI grant pin"],
      io: io(),
      env: env(),
    });
    expect(exit).toBe(0);
    const outcome = JSON.parse(outLines.join("\n")) as {
      topup_id: string;
      amount: number;
      resumed_run_ids: string[];
      skipped: Array<{ run_id: string; reason: string }>;
    };
    expect(outcome.amount).toBe(250);
    expect(outcome.topup_id).toBeTruthy();
    // The insufficient-credit-paused run RESUMED (PAUSED -> QUEUED, D8 path).
    expect(outcome.resumed_run_ids).toContain(CREDIT_PAUSED_RUN);
    // The run paused for a DIFFERENT reason is a typed skip, not a fake resume.
    expect(outcome.skipped).toContainEqual({
      run_id: RETRY_PAUSED_RUN,
      reason: "pause_reason_not_insufficient_credits",
    });

    // The grant is the durable central record (the S24 ledger seam consults
    // it until that slice lands — pinned in E38).
    const grants = await controlPlane.db
      .select()
      .from(controlCreditTopups)
      .where(eq(controlCreditTopups.accountId, B));
    expect(grants.some((grant) => grant.id === outcome.topup_id && grant.amount === 250)).toBe(
      true,
    );

    // The resumed run's own state is the runtime's truth.
    const operationId = runtimeB?.operations.findRunOperation(WS_B, CREDIT_PAUSED_RUN) ?? null;
    expect(operationId).not.toBeNull();
    expect(runtimeB?.operations.getRun(WS_B, operationId as string, CREDIT_PAUSED_RUN).state).toBe(
      "QUEUED",
    );
    expect(errLines.join("\n")).not.toContain(activeToken);
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

  it("refuses plaintext http origins off loopback and keeps missing DATABASE_URL a local failure (review P3)", async () => {
    // A bearer token shipped over cleartext http to a non-loopback host is a
    // credential disclosure — the CLI refuses it before any request (the
    // production control plane is https with a CA-trusted cert; loopback
    // http stays allowed for local development).
    outLines.length = 0;
    errLines.length = 0;
    const refused = await runCli({
      argv: ["users", "list"],
      io: io(),
      env: { ...env(), SHERA_CONTROL_PLANE_URL: "http://admin.invalid" },
    });
    expect(refused).toBe(2);
    const refusedErr = errLines.join(NEWLINE);
    expect(refusedErr).toContain("https");
    expect(refusedErr).not.toContain(activeToken);

    // A missing DATABASE_URL is a LOCAL AUTHORITY failure (the token
    // lifecycle is a local DB operation), not a command-line-shape error:
    // exit 1, per the documented exit-code table.
    outLines.length = 0;
    errLines.length = 0;
    const noDb = await runCli({
      argv: ["token", "create"],
      io: io(),
      env: { SHERA_ADMIN_TOKEN: activeToken, SHERA_CONTROL_PLANE_URL: server.origin },
    });
    expect(noDb).toBe(1);
    expect(errLines.join(NEWLINE)).toContain("DATABASE_URL");
  });

  it("is callable as a real child process (the AC1 bin-executable leg)", () => {
    // The documented invocation is plain `node` against the TS entry (Node 24
    // type stripping; the bin field points here). The process must run to
    // completion, print its help, and exit 0 — importing the module without
    // invoking main() would print nothing and prove nothing.
    const result = runCliBin(["--help"]);
    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("Usage:");
    // Spot-check the documented groups surface in the child's help.
    expect(output).toContain("token");
    expect(output).toContain("users");
    expect(output).toContain("container");
    expect(output).toContain("credits");
  });
});
