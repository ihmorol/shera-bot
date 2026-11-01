/**
 * shera-admin — the S32 admin CLI (issue #33; D47, PRD §15).
 *
 * Two transports, one tool:
 * - `token` commands are LOCAL operator operations against the control
 *   plane's PostgreSQL (DATABASE_URL): create/rotate mint the raw token,
 *   display it EXACTLY ONCE on stdout, and store only its SHA-256 digest.
 * - every operational command is an authenticated call to the admin API
 *   (--url or SHERA_CONTROL_PLANE_URL; the token from --token-file or
 *   SHERA_ADMIN_TOKEN — never an argv flag, which is world-readable).
 *
 * The CLI never prints secrets: the token appears only in the single
 * create/rotate display the owner captures; every error path prints the
 * control plane's typed error (code + safe_message) and never echoes the
 * presented credential (G3 — pinned by the redaction test).
 *
 * Every operational command maps 1:1 onto an authenticated endpoint, so the
 * CLI and the API share the audit trail (AC6) and the same tests. Exit codes:
 * 0 success, 1 API/local failure, 2 usage.
 */
import { Command } from "commander";

import { createDb } from "../db/client.ts";
import { createControlPlaneLogger } from "../logger.ts";
import { SecretRegistry } from "../redaction.ts";
import { AdminTokenService } from "../modules/admin-tokens.ts";
import { SecurityEventService } from "../modules/security-events.ts";
import {
  createAdminApiClient,
  resolveToken,
  usageError,
  type AdminApiClient,
} from "./api-client.ts";
import { CLI_EXIT_API_ERROR, CLI_EXIT_OK, CLI_EXIT_USAGE, type CliEnv, type CliIo } from "./io.ts";

export interface RunCliArgs {
  argv: string[];
  io: CliIo;
  env: CliEnv;
}

/** The documented command surface (the documented-syntax AC and the help). */
export const CLI_COMMAND_NAMES = [
  "token create",
  "token rotate",
  "token show",
  "users list",
  "users disable",
  "users enable",
  "users tier",
  "container provision",
  "container restart",
  "container stop",
  "container status",
  "container usage",
  "backups trigger",
  "backups list",
  "backups restore",
  "emergency-cancel",
  "failures",
  "credits top-up",
] as const;

interface ResolvedGlobals {
  url?: string;
  tokenFile?: string;
}

export async function runCli(args: RunCliArgs): Promise<number> {
  const program = new Command();
  // All output (results, guidance, help) flows through the injected io seam —
  // the same discipline the redaction test pins (no side channel that skips
  // it). In-process drivability: commander's help/version and usage failures
  // throw instead of process.exit-ing; the error's code maps to the CLI exit
  // convention.
  program.exitOverride();
  program.configureOutput({
    writeOut: (line) => args.io.out(line.replace(/\n$/, "")),
    writeErr: (line) => args.io.err(line.replace(/\n$/, "")),
  });
  program
    .name("shera-admin")
    .description(
      "Shera Bot admin CLI (private prototype; D47 — the console is production-gated). " +
        "Operational commands call the authenticated admin API; token lifecycle is local.",
    )
    .option("--url <origin>", "the control plane origin (or SHERA_CONTROL_PLANE_URL)")
    .option("--token-file <path>", "read the admin token from a file (or SHERA_ADMIN_TOKEN)");

  let exitCode = CLI_EXIT_OK;
  /** Actions record their exit code here (Commander actions return void). */
  const done = async (promise: Promise<number>): Promise<void> => {
    exitCode = await promise;
  };

  // Global options are readable wherever they appear: the preAction hook
  // copies program-level flags over the per-command options.
  const globals: ResolvedGlobals = {};
  program.hook("preAction", () => {
    const opts = program.opts<{ url?: string; tokenFile?: string }>();
    if (opts.url !== undefined) globals.url = opts.url;
    if (opts.tokenFile !== undefined) globals.tokenFile = opts.tokenFile;
  });

  const operational =
    (
      fn: (client: AdminApiClient, accountId: string) => Promise<number>,
    ): ((accountId: string, options: ResolvedGlobals) => Promise<number>) =>
    async (accountId, options) => {
      const url = options.url ?? globals.url ?? args.env.SHERA_CONTROL_PLANE_URL;
      if (!url) {
        usageError(args.io, "no control plane URL. Pass --url or set SHERA_CONTROL_PLANE_URL.");
        return CLI_EXIT_USAGE;
      }
      const token = resolveToken({
        env: args.env,
        tokenFile: options.tokenFile ?? globals.tokenFile,
        io: args.io,
      });
      if (token === null) return CLI_EXIT_USAGE;
      const client = createAdminApiClient({ baseUrl: url, token, io: args.io });
      return fn(client, accountId);
    };

  const callAndPrint = async (
    client: AdminApiClient,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<number> => {
    const result = await client.request({ method, path, ...(body !== undefined ? { body } : {}) });
    if (!result.ok) return result.exit;
    args.io.out(JSON.stringify(result.body, null, 2));
    return CLI_EXIT_OK;
  };

  // --- Token lifecycle (LOCAL; the raw token is displayed exactly once) ----

  const token = program.command("token").description("admin token lifecycle (local DB operations)");

  token
    .command("create")
    .description(
      "create the active admin token (revokes any previous one); the raw token is printed ONCE",
    )
    .action(() =>
      done(
        withLocalTokenService(args, async (tokens) => {
          const created = await tokens.create({ createdBy: "cli" });
          // The ONE display: stdout carries the raw token alone on its line
          // so the owner can capture it cleanly; guidance goes to stderr.
          args.io.out(created.token);
          args.io.err(
            `token created (${created.tokenDigestHint}). Store it now — it is not recoverable and is never displayed again.`,
          );
          return CLI_EXIT_OK;
        }),
      ),
    );

  token
    .command("rotate")
    .description("rotate: a new active token (printed ONCE); the previous token stops verifying")
    .action(() =>
      done(
        withLocalTokenService(args, async (tokens) => {
          const active = await tokens.activeToken();
          const rotated = await tokens.rotate({
            rotatedBy: "cli",
            ...(active ? { previousTokenId: active.id } : {}),
          });
          args.io.out(rotated.token);
          args.io.err(
            `token rotated (${rotated.tokenDigestHint}); the previous token is invalidated. Store it now — it is never displayed again.`,
          );
          return CLI_EXIT_OK;
        }),
      ),
    );

  token
    .command("show")
    .description("show the active token's NON-SECRET identity (digest hint, timestamps)")
    .action(() =>
      done(
        withLocalTokenService(args, async (tokens) => {
          const active = await tokens.activeToken();
          if (!active) {
            args.io.err("error: no active admin token. Create one: shera-admin token create");
            return CLI_EXIT_API_ERROR;
          }
          args.io.out(
            JSON.stringify(
              {
                token_digest_hint: active.tokenDigestHint,
                created_at: active.createdAt.toISOString(),
                last_used_at: active.lastUsedAt ? active.lastUsedAt.toISOString() : null,
                revoked_at: active.revokedAt ? active.revokedAt.toISOString() : null,
              },
              null,
              2,
            ),
          );
          return CLI_EXIT_OK;
        }),
      ),
    );

  // --- Users ----------------------------------------------------------------

  const users = program.command("users").description("account management");
  users
    .command("list")
    .description("list the accounts (identity, tier, state, container status)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((options: ResolvedGlobals) =>
      done(operational((client) => callAndPrint(client, "GET", "/api/admin/users"))("", options)),
    );
  users
    .command("disable <account_id>")
    .description("disable an account; its sessions are revoked immediately (AC3)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, options: ResolvedGlobals) =>
      done(
        operational((client, id) => callAndPrint(client, "POST", `/api/admin/users/${id}/disable`))(
          accountId,
          options,
        ),
      ),
    );
  users
    .command("enable <account_id>")
    .description("re-enable an account (the user signs in again)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, options: ResolvedGlobals) =>
      done(
        operational((client, id) => callAndPrint(client, "POST", `/api/admin/users/${id}/enable`))(
          accountId,
          options,
        ),
      ),
    );
  users
    .command("tier <account_id> <tier>")
    .description("assign the simulated tier: light | balanced | heavy (PRD §3.2)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, tier: string, options: ResolvedGlobals): Promise<void> => {
      if (!["light", "balanced", "heavy"].includes(tier)) {
        usageError(args.io, `unknown tier "${tier}" (light | balanced | heavy)`);
        exitCode = CLI_EXIT_USAGE;
        return Promise.resolve();
      }
      return done(
        operational((client, id) =>
          callAndPrint(client, "PUT", `/api/admin/users/${id}/tier`, { tier }),
        )(accountId, options),
      );
    });

  // --- Container lifecycle ----------------------------------------------------

  const container = program.command("container").description("a user's container lifecycle");
  for (const name of ["provision", "restart", "stop"] as const) {
    container
      .command(`${name} <account_id>`)
      .description(
        name === "provision"
          ? "provision the user's runtime (idempotent)"
          : name === "restart"
            ? "bring the user's runtime to running (idempotent)"
            : "stop the user's runtime (idempotent)",
      )
      .option("--url <origin>")
      .option("--token-file <path>")
      .action((accountId: string, options: ResolvedGlobals) =>
        done(
          operational((client, id) =>
            callAndPrint(client, "POST", `/api/admin/users/${id}/container/${name}`),
          )(accountId, options),
        ),
      );
  }
  for (const name of ["status", "usage"] as const) {
    container
      .command(`${name} <account_id>`)
      .description(
        name === "status"
          ? "the user's runtime status (backend truth, synced to the record)"
          : "the user's resource usage view (applied tier limits + health summary)",
      )
      .option("--url <origin>")
      .option("--token-file <path>")
      .action((accountId: string, options: ResolvedGlobals) =>
        done(
          operational((client, id) =>
            callAndPrint(client, "GET", `/api/admin/users/${id}/container/${name}`),
          )(accountId, options),
        ),
      );
  }

  // --- Backups (the S33 mechanism executes what this triggers) ----------------

  const backups = program.command("backups").description("backup trigger and restore request");
  backups
    .command("trigger <account_id>")
    .description("trigger a backup (recorded as `requested`; S33's mechanism executes it)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, options: ResolvedGlobals) =>
      done(
        operational((client, id) => callAndPrint(client, "POST", `/api/admin/users/${id}/backups`))(
          accountId,
          options,
        ),
      ),
    );
  backups
    .command("list <account_id>")
    .description("list the account's recorded backups")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, options: ResolvedGlobals) =>
      done(
        operational((client, id) => callAndPrint(client, "GET", `/api/admin/users/${id}/backups`))(
          accountId,
          options,
        ),
      ),
    );
  backups
    .command("restore <account_id> <snapshot_ref>")
    .description("request the restore of one recorded snapshot (S33 performs the restore)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, snapshotRef: string, options: ResolvedGlobals): Promise<void> =>
      done(
        operational((client, id) =>
          callAndPrint(client, "POST", `/api/admin/users/${id}/backups/${snapshotRef}/restore`),
        )(accountId, options),
      ),
    );

  // --- Emergency, failures, credits ------------------------------------------

  program
    .command("emergency-cancel <account_id>")
    .description("emergency-cancel ALL work for ONE user (scoped to that user, AC4)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, options: ResolvedGlobals) =>
      done(
        operational((client, id) =>
          callAndPrint(client, "POST", `/api/admin/users/${id}/emergency-cancel`),
        )(accountId, options),
      ),
    );

  program
    .command("failures <account_id>")
    .description("view recent container and task failures for one user")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action((accountId: string, options: ResolvedGlobals) =>
      done(
        operational((client, id) => callAndPrint(client, "GET", `/api/admin/users/${id}/failures`))(
          accountId,
          options,
        ),
      ),
    );

  const credits = program.command("credits").description("credit accounting (D48)");
  credits
    .command("top-up <account_id>")
    .description("top up credits for a user (the insufficient_credits unblocking path)")
    .requiredOption("--amount <n>", "positive integer amount of credit units", Number)
    .option("--reason <text>", "bounded operator note (redacted before storage)")
    .option("--url <origin>")
    .option("--token-file <path>")
    .action(
      (
        accountId: string,
        options: ResolvedGlobals & { amount: number; reason?: string },
      ): Promise<void> => {
        if (!Number.isInteger(options.amount) || options.amount <= 0) {
          usageError(args.io, "--amount must be a positive integer");
          exitCode = CLI_EXIT_USAGE;
          return Promise.resolve();
        }
        return done(
          operational((client, id) =>
            callAndPrint(client, "POST", `/api/admin/users/${id}/credits/top-up`, {
              amount: options.amount,
              ...(options.reason !== undefined ? { reason: options.reason } : {}),
            }),
          )(accountId, options),
        );
      },
    );

  try {
    await program.parseAsync(args.argv, { from: "user" });
  } catch (error) {
    // exitOverride: commander surfaces help/version and usage failures as
    // CommanderError. Help exits successfully; usage failures are exit 2.
    const code = (error as { code?: string }).code ?? "";
    if (code === "commander.helpDisplayed" || code === "commander.version") return CLI_EXIT_OK;
    if (code === "commander.help") return CLI_EXIT_OK;
    if (code === "commander.missingArgument" || code === "commander.missingMandatoryOptionValue") {
      return CLI_EXIT_USAGE;
    }
    if (code.startsWith("commander.")) return CLI_EXIT_USAGE;
    throw error;
  }
  return exitCode;
}

/** Local token service construction (the DB the control plane owns). */
async function withLocalTokenService(
  args: RunCliArgs,
  fn: (tokens: AdminTokenService) => Promise<number>,
): Promise<number> {
  const databaseUrl = args.env.DATABASE_URL;
  if (!databaseUrl) {
    args.io.err("error: DATABASE_URL is required for token lifecycle commands.");
    return CLI_EXIT_USAGE;
  }
  const registry = new SecretRegistry();
  const logger = createControlPlaneLogger({ registry });
  const { db, pool } = createDb(databaseUrl);
  try {
    const securityEvents = new SecurityEventService(db, registry, logger);
    const tokens = new AdminTokenService({ db, registry, securityEvents });
    return await fn(tokens);
  } catch (error) {
    args.io.err(
      `error: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`,
    );
    return CLI_EXIT_API_ERROR;
  } finally {
    await pool.end();
  }
}

/** The bin entry (package.json bin): process adapter only. */
export async function main(): Promise<void> {
  const exit = await runCli({
    argv: process.argv.slice(2),
    io: { out: (line) => console.log(line), err: (line) => console.error(line) },
    env: process.env,
  });
  process.exitCode = exit;
}
