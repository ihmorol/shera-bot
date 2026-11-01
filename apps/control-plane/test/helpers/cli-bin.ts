/**
 * The shera-admin bin-executable probe (S32, issue #33, AC1).
 *
 * Spawning the CLI entry as a REAL child process is this helper's entire
 * purpose: the in-process runCli tests prove the command surface, but AC1's
 * "callable" claim needs the bin to run to completion as node's entry point
 * (the guarded main() self-invocation fires only there). The production
 * control plane never spawns processes — this is a named test-infra exception
 * in scripts/boundary-guards.ts, same family as the HTTPS/pg-cluster helpers.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The CLI entry, exactly as the package.json `bin` field points at it. */
export const CLI_BIN_ENTRY = fileURLToPath(
  new URL("../../src/cli/shera-admin.ts", import.meta.url),
);

export interface CliBinResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI as a child process with the given argv; returns raw streams. */
export function runCliBin(argv: string[], timeoutMs = 60_000): CliBinResult {
  const result = spawnSync(process.execPath, [CLI_BIN_ENTRY, ...argv], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
