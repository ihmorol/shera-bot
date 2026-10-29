/**
 * The validation-command spawn seam (S19 review round; D23 rule 2) — the ONE
 * place the merge-request validation runner touches `node:child_process`,
 * inside the adapters/process boundary exactly like the session spawn seam
 * (S12) and the worker-process-spawn adapter (S16). The boundary test
 * (tests/contract/user-runtime-boundary.test.ts) and scripts/boundary-guards.ts
 * enforce this placement; nothing else in the git module spawns.
 *
 * The script names are from the fixed allowlist in the validation runner —
 * no shell interpolation of user input (the runner validates the plan; this
 * seam executes it).
 */
import { spawn } from "node:child_process";

/** The validation limits the runner passes down (structural subset). */
export interface ValidationSpawnLimits {
  /** One command's wall-clock ceiling. */
  perCommandTimeoutMs: number;
  /** The output tail window kept while the command runs (characters). */
  maxOutputChars: number;
}

export interface ValidationCommandResult {
  ok: boolean;
  timedOut: boolean;
  exitCode: number | null;
  output: string;
}

/** The fixed allowlist resolves to one package-manager invocation shape. */
export function validationCommandLine(
  manager: "npm" | "pnpm" | "yarn",
  scriptName: string,
): string[] {
  if (manager === "pnpm") {
    return ["pnpm", "run", scriptName];
  }
  if (manager === "yarn") {
    return ["yarn", scriptName];
  }
  return ["npm", "run", scriptName];
}

export function runValidationCommand(
  manager: "npm" | "pnpm" | "yarn",
  scriptName: string,
  cwd: string,
  limits: ValidationSpawnLimits,
): Promise<ValidationCommandResult> {
  const [binary, ...args] = validationCommandLine(manager, scriptName);
  return new Promise((resolve) => {
    // shell: true resolves the .cmd shim on Windows; every interpolated token
    // is from the fixed allowlist above, never from user input.
    const child = spawn([binary, ...args].join(" "), {
      cwd,
      shell: true,
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const collect = (chunk: Buffer | string) => {
      output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (output.length > limits.maxOutputChars * 4) {
        output = output.slice(-limits.maxOutputChars * 4);
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        // Kill the whole tree: the shell shim is not the process holding the
        // script's node child alive.
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        // Recorded limitation: on POSIX this SIGKILLs the shell, so a script
        // that spawned its own children may leave them running after the
        // typed timeout — the runner stops WAITING either way. A
        // process-group kill is the follow-up hardening.
        child.kill("SIGKILL");
      }
    }, limits.perCommandTimeoutMs);
    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && exitCode === 0, timedOut, exitCode, output });
    };
    child.on("close", (code) => finish(code));
    child.on("error", () => {
      // The package manager binary itself could not run.
      output += "\n(the validation command could not be started)";
      finish(1);
    });
  });
}
