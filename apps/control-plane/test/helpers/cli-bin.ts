/**
 * The shera-admin bin-executable probe (S32, issue #33, AC1) and the
 * direct-TS run-path probes.
 *
 * Spawning real child processes is this helper's entire purpose: the
 * in-process runCli tests prove the command surface, but AC1's "callable"
 * claim needs the bin to run to completion as node's entry point (the
 * guarded main() self-invocation fires only there), and the documented
 * start path (`node src/main.ts`) needs the app's whole import closure to
 * survive plain node's strip-only TS mode. The production control plane
 * never spawns processes — this is a named test-infra exception in
 * scripts/boundary-guards.ts, same family as the HTTPS/pg-cluster helpers.
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

function spawnRaw(argv: string[], timeoutMs: number): CliBinResult {
  const result = spawnSync(process.execPath, argv, {
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

/** Run the CLI as a child process with the given argv; returns raw streams. */
export function runCliBin(argv: string[], timeoutMs = 60_000): CliBinResult {
  return spawnRaw([CLI_BIN_ENTRY, ...argv], timeoutMs);
}

/**
 * Import a control-plane TS module in a PLAIN node child (default strip-only
 * mode — no --experimental-transform-types). Exits 0 when the module graph
 * loads; the child prints the failure reason and exits 1 otherwise.
 */
export function runPlainNodeImport(moduleUrl: string, timeoutMs = 60_000): CliBinResult {
  const script =
    `import(${JSON.stringify(moduleUrl)}).then(() => process.exit(0), ` +
    `(e) => { console.error("IMPORT FAILED: " + ((e && e.message) || String(e))); process.exit(1); });`;
  return spawnRaw(["-e", script], timeoutMs);
}
