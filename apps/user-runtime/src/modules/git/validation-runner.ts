/**
 * Validation runner (S19 chunk 2; issue #20, PRD §10, G2) — the runtime side
 * of "agents propose; the runtime validates" for merge requests. The
 * coordinating Agent prepares a merge request; THIS module executes the
 * project's DECLARED validation inside the task's own worktree and attaches
 * the result to the merge request row (validation_status + validation_note).
 *
 * THE DETECTION HEURISTIC (this slice, documented): a repository declares its
 * validation through its package.json scripts — the Node ecosystem's own
 * declaration surface. From a fixed priority list (`test`, then `lint`, then
 * `typecheck`) the runner runs every script the package.json actually
 * declares, sequentially, with the repository's lockfile choosing the package
 * manager (pnpm-lock.yaml → pnpm, yarn.lock → yarn, otherwise npm). A
 * repository without a readable package.json, or one whose scripts name none
 * of the priority list, declares NOTHING: validation_status stays `not_run`
 * with an honest note — commands are never invented. Other ecosystems
 * (Makefiles, tox.ini, cargo, …) are future work and deliberately out of this
 * heuristic.
 *
 * FAIRNESS AND BOUNDS: one command at a time, inside the task's worktree (the
 * exact tree the merge would land), each with a per-command timeout; output
 * is condensed to the tail and pushed through the SAME deterministic secret
 * redaction pass the approval boundary uses — the note is durable product
 * state and must never carry secret-shaped material (G3). The failure note
 * names the failing command and its exit code; a timeout names the timeout.
 *
 * A validation failure is RECORDED, never swallowed — and never blocking on
 * its own: the merge itself stays approval-gated (G6). The runner mutates
 * only the merge request's validation fields.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MergeRequestNotFoundError,
  type ProjectsRepository,
} from "../../adapters/sqlite/projects-repository.ts";
import {
  runValidationCommand,
  validationCommandLine,
} from "../../adapters/process/validation-command-spawn.ts";
import { redactSecrets } from "../approvals/approvals.service.ts";
import { GitServiceError, toMergeRequestView, type MergeRequestView } from "./git.service.ts";

/** The fixed priority order (the documented heuristic). */
export const VALIDATION_SCRIPT_PRIORITY = ["test", "lint", "typecheck"] as const;

export interface ValidationLimits {
  /** One command's wall-clock ceiling. */
  perCommandTimeoutMs: number;
  /** The note's output tail size (characters). */
  maxOutputChars: number;
}

export const DEFAULT_VALIDATION_LIMITS: ValidationLimits = {
  perCommandTimeoutMs: 120_000,
  maxOutputChars: 4000,
};

export type ValidationManager = "npm" | "pnpm" | "yarn";

/** The detected plan: the manager and the declared scripts in priority order. */
export interface ValidationPlan {
  manager: ValidationManager;
  commands: string[];
}

type PackageJsonScripts = Record<string, unknown>;

function readScripts(packageJsonPath: string): PackageJsonScripts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    // An unreadable or malformed package.json declares nothing.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return null;
  }
  return scripts as PackageJsonScripts;
}

/**
 * The documented detection heuristic. Reads the repository root's
 * package.json and the lockfiles; answers null when nothing is declared.
 */
export function detectValidationPlan(worktreePath: string): ValidationPlan | null {
  const scripts = readScripts(join(worktreePath, "package.json"));
  if (scripts === null) {
    return null;
  }
  const commands = VALIDATION_SCRIPT_PRIORITY.filter((name) => typeof scripts[name] === "string");
  if (commands.length === 0) {
    return null;
  }
  let manager: ValidationManager = "npm";
  try {
    readFileSync(join(worktreePath, "pnpm-lock.yaml"));
    manager = "pnpm";
  } catch {
    try {
      readFileSync(join(worktreePath, "yarn.lock"));
      manager = "yarn";
    } catch {
      // npm remains the default.
    }
  }
  return { manager, commands };
}

// The command-line construction and the spawn itself live in the process
// adapter seam (adapters/process/validation-command-spawn.ts — D23 rule 2);
// this module owns detection, sequencing, and the recorded result.

function condense(text: string, limits: ValidationLimits): string {
  const flat = text.replace(/\r\n/g, "\n").trim();
  if (flat.length <= limits.maxOutputChars) {
    return flat;
  }
  return `…${flat.slice(-limits.maxOutputChars)}`;
}

export interface ValidationRunnerDeps {
  projects: ProjectsRepository;
  /** Injected clock (ISO strings); defaults to the system clock. */
  clock?: () => string;
  limits?: Partial<ValidationLimits>;
}

export class ValidationRunner {
  private readonly limits: ValidationLimits;

  constructor(private readonly deps: ValidationRunnerDeps) {
    this.limits = { ...DEFAULT_VALIDATION_LIMITS, ...deps.limits };
  }

  private now(): string {
    return (this.deps.clock ?? (() => new Date().toISOString()))();
  }

  /**
   * Run the project's declared validation inside the merge request's task
   * worktree and attach the result to the merge request row. The answer is
   * the post-run view.
   */
  async runForMergeRequest(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
  ): Promise<MergeRequestView> {
    const readRow = (): ReturnType<ProjectsRepository["requireMergeRequest"]> =>
      this.deps.projects.requireMergeRequest(workspaceId, projectId, mergeRequestId);
    let row: ReturnType<ProjectsRepository["requireMergeRequest"]>;
    try {
      row = this.deps.projects.requireMergeRequest(workspaceId, projectId, mergeRequestId);
    } catch (error) {
      if (error instanceof MergeRequestNotFoundError) {
        throw new GitServiceError(
          "GIT_MERGE_REQUEST_NOT_FOUND",
          "state",
          "no merge request with this id exists for the project",
        );
      }
      throw error;
    }
    const worktree = this.deps.projects.findActiveWorktreeByTask(
      workspaceId,
      projectId,
      row.task_id,
    );
    if (worktree === null) {
      throw new GitServiceError(
        "GIT_VALIDATION_TARGET_INVALID",
        "state",
        "the task holds no active worktree; there is nothing to validate against",
      );
    }

    const plan = detectValidationPlan(worktree.worktree_path);
    if (plan === null) {
      const note =
        "No declared validation found: the repository's package.json declares none of the " +
        "known validation scripts (test, lint, typecheck). Nothing was run.";
      this.deps.projects.updateMergeRequest(workspaceId, projectId, mergeRequestId, {
        validation_status: "not_run",
        validation_note: note,
        updated_at: this.now(),
      });
      return toMergeRequestView(readRow());
    }

    const summary: string[] = [];
    let failed: string | null = null;
    for (const scriptName of plan.commands) {
      const [binary, ...args] = validationCommandLine(plan.manager, scriptName);
      const label = `${binary} ${args.join(" ")}`;
      const result = await runValidationCommand(
        plan.manager,
        scriptName,
        worktree.worktree_path,
        this.limits,
      );
      if (result.timedOut) {
        failed =
          `${label} timed out after ${this.limits.perCommandTimeoutMs} ms` +
          (result.output.trim().length > 0
            ? `. Output (condensed):\n${condense(redactSecrets(result.output), this.limits)}`
            : ".");
        break;
      }
      if (!result.ok || result.exitCode !== 0) {
        failed =
          `${label} failed with exit code ${result.exitCode ?? "unknown"}.` +
          (result.output.trim().length > 0
            ? ` Output (condensed):\n${condense(redactSecrets(result.output), this.limits)}`
            : "");
        break;
      }
      summary.push(`${label} (exit 0)`);
    }

    if (failed !== null) {
      this.deps.projects.updateMergeRequest(workspaceId, projectId, mergeRequestId, {
        validation_status: "failed",
        validation_note: `Validation failed: ${failed}`,
        updated_at: this.now(),
      });
    } else {
      this.deps.projects.updateMergeRequest(workspaceId, projectId, mergeRequestId, {
        validation_status: "passed",
        validation_note: `Validation passed in the task worktree: ${summary.join(", ")}.`,
        updated_at: this.now(),
      });
    }
    return toMergeRequestView(readRow());
  }
}
