/**
 * Tool executor (S21; PRD §7, D35, D38, E4, E13, G2/G3/G6, AC1–AC6, AC9) —
 * the ONE runtime-owned execution path every capability goes through. Agents
 * propose (a typed `tool.proposed` envelope, digest-only — G3); this service
 * validates the proposal, resolves the risk class from DATA (the D35 ladder),
 * applies the approval policy through the S20 machinery, enforces the tool's
 * OWN per-tool limits, executes through the resolved binding, and records the
 * REDACTED, bounded result. There is no second path: bindings refuse to run
 * without the execution authority minted here (AC1), and the adapter seam
 * exposes proposal only (G2).
 *
 * Order of checks (fail-closed, cheapest refusals first):
 *   1. registry resolution       — unknown tool: typed refusal, no history row
 *                                  (the run's typed rejection carries it, G2)
 *   2. disablement               — a disabled tool refuses BEFORE any grant
 *                                  consult (AC6: disabling beats a grant)
 *   3. args validation           — the tool's own input schema (typed JSON
 *                                  Schema subset; never eval, never shells out)
 *   4. digest tie                — when the runtime holds raw args, the
 *                                  executed arguments must hash to the
 *                                  journalled digest (G3: execution is tied
 *                                  to the proposal; no args -> the journalled
 *                                  digest is trusted, the scripted demo path)
 *   5. risk ladder               — READ_ONLY executes automatically (G6);
 *                                  every other class is gated: a matching
 *                                  active grant (deterministic AC26 recheck)
 *                                  executes without a new prompt; otherwise
 *                                  the S20 approval machinery pauses the run
 *                                  and NOTHING executes pre-decision (AC3)
 *   6. per-tool limits           — timeout_ms and max_response_bytes are
 *                                  enforced per tool (AC5), typed errors
 *   7. redaction                 — results are redacted and bounded BEFORE
 *                                  any history write (G3/AC9)
 *
 * Recovery class (E13, AC4): the class is the definition's stored field
 * (defaulted to needs_human at the contracts/storage layer); the executor
 * stores it on every history row and never invents another.
 *
 * The executor runs INSIDE the caller's transaction for the gating decision
 * and the history writes (joining the harness's atomic unit, exactly like the
 * S20 pause); the in-process binding family executes synchronously within the
 * same unit (the demo tools' effects are in-memory). Process-backed bindings
 * (S26) arrive through the same interface and own their execution/supervision
 * posture; the cancel seam (ctx.signal) is the S22 escalation hook.
 */
import { createHash, randomUUID } from "node:crypto";

import type { ResourceLimits, TaskRun, TaskRejection } from "@shera-bot/contracts";

import type {
  ApprovalPauseResult,
  CreateRequestFromTypedProposalInput,
  ExecutionRecheckInput,
  ExecutionRecheckResult,
} from "../approvals/approvals.service.ts";
import type { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { RISK_CLASS_LADDER, resolvePreviewKind } from "./risk-ladder.ts";
import {
  makeExecutionAuthority,
  type ExecutionAuthority,
  type ToolBindingResult,
  type ToolExecutionContext,
  type ToolPreview,
} from "./tool-binding.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { redactAndBound, summarizeArgs } from "./tool-redaction.ts";

/** Stable failure codes for the executor boundary (SCREAMING_SNAKE). */
export type ToolExecutorFailureCode =
  | "TOOL_NOT_REGISTERED"
  | "TOOL_DISABLED"
  | "TOOL_ARGS_INVALID"
  | "TOOL_ARGS_DIGEST_MISMATCH"
  | "TOOL_EXECUTION_TIMEOUT"
  | "TOOL_RESPONSE_TOO_LARGE"
  | "TOOL_BINDING_FAILED"
  | "TOOL_APPROVAL_UNAVAILABLE"
  | "TOOL_NOT_ACTIVATED"
  | "TOOL_NOT_SHARED"
  | "EXECUTION_AUTHORITY_MISSING"
  /** S26: the sandbox policy refused the execution (path/symlink escape). */
  | "SANDBOX_PATH_ESCAPE"
  /** S26: the sandbox could not launch (interpreter/enforcement missing). */
  | "SANDBOX_LAUNCH_FAILED"
  /** S26: the kernel or wall clock ended the process at an enforced limit. */
  | "SANDBOX_LIMIT_EXCEEDED"
  /** S26: the cancel seam fired and the process tree was terminated. */
  | "TOOL_EXECUTION_CANCELLED";

/**
 * The slice of the S20 approvals boundary the executor consumes. The real
 * ApprovalsService satisfies it; tests may double it. `consumeOneTimeGrant`
 * is the AC26 consumption writer for grant-driven executions (the approval
 * path's consumption stays inside applyDecision).
 */
export interface ExecutorApprovalsPort {
  checkExecutionAllowed(input: ExecutionRecheckInput): ExecutionRecheckResult;
  createRequestFromTypedProposal(input: CreateRequestFromTypedProposalInput): ApprovalPauseResult;
  consumeOneTimeGrant(workspaceId: string, grantId: string): boolean;
}

export class ToolExecutorError extends Error {
  readonly code: ToolExecutorFailureCode;
  readonly category: "validation" | "state" | "forbidden" | "execution";

  constructor(
    code: ToolExecutorFailureCode,
    category: "validation" | "state" | "forbidden" | "execution",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ToolExecutorError";
    this.code = code;
    this.category = category;
  }
}

/** The proposal input: the journalled envelope's identity fields (G2 — typed). */
export interface ToolProposalInput {
  proposal: {
    workspace_id: string;
    task_id: string;
    conversation_id: string;
    tool_id: string;
    tool_version: string;
    capability: string;
    args_digest: string;
    proposal_summary: string;
  };
  /** The proposing run's live projection (held by the caller, D5). */
  run: TaskRun;
  /** The proposing Agent (recorded on the history row; never the approver). */
  agent_id: string;
  /**
   * The raw arguments the runtime holds in memory for this execution. NEVER
   * persisted — only the digest and the redacted summary are recorded (G3).
   * Absent on the scripted demo path (digest-only trust, documented).
   */
  rawArgs?: Record<string, unknown>;
  /**
   * The explicit D9 resource scope (D9: resource scope must be explicit).
   * Callers that own a typed definition supply it verbatim (the scripted
   * composition path); the default is the honest task scope.
   */
  resource_scope?: string;
  /**
   * The typed definition's authored side-effect text (what the approval card
   * shows). Authored configuration — never tool arguments (G3); the
   * approvals boundary redacts it before any record or journal write.
   */
  side_effect_summary?: string;
}

export type ToolProposalOutcome =
  | {
      outcome: "executed";
      execution_id: string;
      result_summary: string;
      run: TaskRun;
    }
  | {
      outcome: "execution_failed";
      execution_id: string;
      error_code: ToolExecutorFailureCode;
      run: TaskRun;
    }
  | {
      outcome: "blocked";
      execution_id: string;
      error_code: ToolExecutorFailureCode;
      run: TaskRun;
    }
  | {
      outcome: "paused_for_approval";
      execution_id: string;
      approval_id: string;
      run: TaskRun;
    }
  | {
      outcome: "transition_rejected";
      execution_id: string;
      rejection: TaskRejection;
      run: TaskRun;
    }
  /**
   * S26 process-backed dispatch: the effect was dispatched as a child
   * process OUTSIDE the caller's transaction; the history row is `running`
   * and `completion` settles it to its terminal state (redacted, bounded,
   * exit code and duration recorded) when the process exits. `cancel` is
   * the D27 process-tree termination seam (SIGKILL to the whole group).
   */
  | {
      outcome: "dispatched";
      execution_id: string;
      run: TaskRun;
      completion: Promise<ToolProposalOutcome>;
      cancel: () => void;
    };

export interface ToolExecutorDeps {
  registry: ToolRegistry;
  tools: ToolsRepository;
  tx: SqliteTransactions;
  /** The S20 approval machinery (chunk 3 wires the composed service). */
  approvals?: ExecutorApprovalsPort;
  /** Injected millisecond clock (deterministic in tests). */
  nowMs?: () => number;
  /** Injected ISO clock for history rows. */
  now?: () => string;
}

/** The ArgsDigest format contracts enforce (sha256:<hex> over canonical JSON). */
export function canonicalArgsDigest(args: unknown): string {
  const canonical = canonicalJson(args ?? {});
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Sorted-key, no-whitespace JSON (digests are stable across key order). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const ARGS_SUMMARY_BUDGET_BYTES = 512;
const RESULT_SUMMARY_BUDGET_BYTES = 2_048;
const PREVIEW_BUDGET_BYTES = 2_048;
const SIDE_EFFECT_BUDGET_BYTES = 500;
const RESOURCE_SCOPE_BUDGET_BYTES = 512;

/** One withheld gated execution, keyed by its approval id until decided. */
interface WithheldExecution {
  input: ToolProposalInput;
  execution_id: string;
  resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>;
  rawArgs: Record<string, unknown>;
  argsSummary: string;
  preview: ToolPreview | null;
  startedAt: string;
}

export class ToolExecutor {
  /**
   * The withheld gated executions (AC3): stored at pause time, popped and
   * run ONLY by the approval machinery's post-commit callback — nowhere else
   * can reach an effect. In-memory by design: the pause and its decision live
   * within one gateway lifetime (the S20 prototype posture; a restart leaves
   * the approval pending and nothing executes — fail-closed).
   */
  private readonly withheld = new Map<string, WithheldExecution>();

  /**
   * The IN-FLIGHT dispatched executions (S26 process-backed family): the
   * execution id and its cancel seam (the executor-owned AbortController).
   * S22's run-cancellation fires these (D27: the child tree terminates with
   * the task); the dispatch's settlement deregisters.
   */
  private readonly inFlight = new Map<
    string,
    { workspace_id: string; task_id: string; cancel: () => void }
  >();

  constructor(private readonly deps: ToolExecutorDeps) {}

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /** The approvals boundary, typed to the port the executor consumes. */
  private approvalsPort(): ExecutorApprovalsPort | undefined {
    const approvals = this.deps.approvals;
    return approvals ?? undefined;
  }

  /**
   * Mint the execution authority for one execution. The ONLY producer of the
   * token (AC1): bindings refuse to run without it, and it is never handed
   * to any proposing surface.
   */
  mintExecutionAuthority(): ExecutionAuthority {
    return makeExecutionAuthority();
  }

  /**
   * The production entry: validate, gate, execute, record. One proposal, one
   * outcome — every path leaves the history row in an honest terminal state.
   */
  executeProposal(input: ToolProposalInput): ToolProposalOutcome {
    const { proposal, run } = input;
    const execution_id = `exe_${randomUUID()}`;
    const startedAt = this.now();

    const resolved = this.deps.registry.resolve(
      run.workspace_id,
      proposal.tool_id,
      proposal.tool_version,
    );
    if (resolved === null) {
      // Unknown tool: typed refusal, NO history row (there is no honest risk
      // class to store — inventing one would be prose classification). The
      // refusal surfaces as the caller's typed outcome / run rejection (G2).
      return {
        outcome: "blocked",
        execution_id,
        error_code: "TOOL_NOT_REGISTERED",
        run,
      };
    }
    const { definition, binding } = resolved;
    const ladder = RISK_CLASS_LADDER[definition.risk_class];
    const previewKind = resolvePreviewKind(definition.risk_class, definition.capabilities);

    // AC6: a disabled tool refuses BEFORE any grant consult.
    if (!resolved.enabled || this.deps.tools.isDisabled(run.workspace_id, definition.tool_id)) {
      this.recordBlockedRow(input, execution_id, resolved, startedAt, "TOOL_DISABLED", null);
      return { outcome: "blocked", execution_id, error_code: "TOOL_DISABLED", run };
    }

    // E4/AC8: agent-created tools execute only through their lifecycle — the
    // proposing Agent needs an activation grant targeting them (or a
    // workspace-wide one), and a private-scope tool refuses every other
    // Agent outright. No grant or state below can bypass this (the D38
    // intersection: a toolset membership is itself a runtime grant).
    if (resolved.origin === "agent_created") {
      const owner = definition.owner.kind === "agent" ? definition.owner.agent_id : null;
      const isOwner = owner !== null && owner === input.agent_id;
      if (definition.inventory_scope === "private" && !isOwner) {
        this.recordBlockedRow(input, execution_id, resolved, startedAt, "TOOL_NOT_SHARED", null);
        return { outcome: "blocked", execution_id, error_code: "TOOL_NOT_SHARED", run };
      }
      const activatedForAgent = this.deps.tools.hasActivationGrant(
        run.workspace_id,
        definition.tool_id,
        definition.version,
        "agent",
        input.agent_id,
      );
      const activatedForWorkspace = this.deps.tools.hasActivationGrant(
        run.workspace_id,
        definition.tool_id,
        definition.version,
        "workspace",
        run.workspace_id,
      );
      if (!activatedForAgent && !activatedForWorkspace) {
        this.recordBlockedRow(input, execution_id, resolved, startedAt, "TOOL_NOT_ACTIVATED", null);
        return { outcome: "blocked", execution_id, error_code: "TOOL_NOT_ACTIVATED", run };
      }
    }

    // Typed args validation against the tool's own input schema.
    const rawArgs = input.rawArgs ?? {};
    if (!validateAgainstSchema(rawArgs, definition.input_schema)) {
      this.recordBlockedRow(input, execution_id, resolved, startedAt, "TOOL_ARGS_INVALID", null);
      return { outcome: "blocked", execution_id, error_code: "TOOL_ARGS_INVALID", run };
    }

    // G3 tie: when the runtime holds raw args they must hash to the
    // journalled digest; without raw args the journalled digest is the only
    // argument surface (the scripted demo path — documented posture).
    const hasRawArgs = input.rawArgs !== undefined;
    if (hasRawArgs && canonicalArgsDigest(rawArgs) !== proposal.args_digest) {
      this.recordBlockedRow(
        input,
        execution_id,
        resolved,
        startedAt,
        "TOOL_ARGS_DIGEST_MISMATCH",
        null,
      );
      return { outcome: "blocked", execution_id, error_code: "TOOL_ARGS_DIGEST_MISMATCH", run };
    }

    const argsSummary = summarizeArgs(hasRawArgs ? rawArgs : null, ARGS_SUMMARY_BUDGET_BYTES);

    // The D35 ladder: READ_ONLY auto-executes; every other class is gated.
    if (ladder.execution === "automatic") {
      return this.executeNow({
        input,
        execution_id,
        resolved,
        binding,
        rawArgs,
        argsSummary,
        preview: null,
        previewKind,
        startedAt,
        grantId: null,
        approvalId: null,
      });
    }

    // Gated: consult the S20 approval machinery (chunk 3 wires the delegate).
    return this.executeGated({
      input,
      execution_id,
      resolved,
      binding,
      rawArgs,
      argsSummary,
      previewKind,
      startedAt,
    });
  }

  /**
   * The gated branch (S20 machinery): a matching active grant executes
   * without a new prompt (AC26 — the grant skips the prompt, never the
   * policy check); otherwise a paused approval request and NOTHING executes
   * pre-decision (AC3).
   */
  private executeGated(args: {
    input: ToolProposalInput;
    execution_id: string;
    resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>;
    binding: NonNullable<ReturnType<ToolRegistry["resolve"]>>["binding"];
    rawArgs: Record<string, unknown>;
    argsSummary: string;
    previewKind: ReturnType<typeof resolvePreviewKind>;
    startedAt: string;
  }): ToolProposalOutcome {
    const { input, execution_id, resolved, startedAt } = args;
    const { run } = input;
    const { definition } = resolved;

    // The pure pre-execution preview (D35) — recorded BEFORE the approval
    // request exists, so the card can show what WOULD happen (AC2) with zero
    // side effects taken. G3/AC9: the preview text passes the redaction
    // boundary — binding previews are tool-authored text and may carry
    // secret-shaped or oversized material; they are redacted and bounded
    // like every other recorded surface, before any row is written.
    const rawPreview: ToolPreview | null =
      resolved.binding.preview(args.rawArgs) ??
      (args.previewKind !== "none"
        ? { kind: args.previewKind, text: input.proposal.proposal_summary }
        : null);
    const preview: ToolPreview | null = rawPreview
      ? {
          kind: rawPreview.kind,
          text: redactAndBound(rawPreview.text, PREVIEW_BUDGET_BYTES),
        }
      : null;

    // Grant fast-path: the proposing run's task-principal grant first (the
    // "always approve this tool" choice), then the agent-principal grant
    // ("... for this agent" and one-time execution grants). Deterministic
    // order — the first ACTIVE match wins, and a miss is a typed reason.
    const grants = this.approvalsPort();
    let grantId: string | null = null;
    if (grants !== undefined) {
      const recheckInputs = [
        { type: "task" as const, id: run.task_id },
        { type: "agent" as const, id: input.agent_id },
      ];
      for (const principal of recheckInputs) {
        const verdict = grants.checkExecutionAllowed({
          workspace_id: run.workspace_id,
          principal,
          tool_id: definition.tool_id,
          tool_version: definition.version,
          capability: input.proposal.capability,
          resource_scope: resourceScopeOf(input),
          args_digest: input.proposal.args_digest,
          acting_conversation_id: run.conversation_id,
        });
        if (verdict.allowed) {
          grantId = verdict.grant_id;
          break;
        }
      }
      if (grantId !== null) {
        const executed = this.executeNow({
          input,
          execution_id,
          resolved,
          binding: args.binding,
          rawArgs: args.rawArgs,
          argsSummary: args.argsSummary,
          preview,
          previewKind: args.previewKind,
          startedAt,
          grantId,
          approvalId: null,
        });
        // AC26: a consumed one-time grant never authorizes a second run —
        // consumption stays POST-EFFECT, which for the S26 dispatched family
        // means when the child's completion settles as executed.
        const matchedGrantId: string = grantId;
        if (executed.outcome === "executed") {
          grants.consumeOneTimeGrant(run.workspace_id, matchedGrantId);
        } else if (executed.outcome === "dispatched") {
          void executed.completion.then((settled) => {
            if (settled.outcome === "executed") {
              grants.consumeOneTimeGrant(run.workspace_id, matchedGrantId);
            }
          });
        }
        return executed;
      }
      return this.pauseForApproval({
        input,
        execution_id,
        resolved,
        rawArgs: args.rawArgs,
        argsSummary: args.argsSummary,
        preview,
        startedAt,
      });
    }

    if (grantId !== null) {
      return this.executeNow({
        input,
        execution_id,
        resolved,
        binding: args.binding,
        rawArgs: args.rawArgs,
        argsSummary: args.argsSummary,
        preview,
        previewKind: args.previewKind,
        startedAt,
        grantId,
        approvalId: null,
      });
    }

    if (grants === undefined) {
      // No approval machinery wired (composition gap): fail CLOSED — a gated
      // tool never executes un-gated (G6/AC3), the typed refusal is the answer.
      this.recordBlockedRow(
        input,
        execution_id,
        resolved,
        startedAt,
        "TOOL_APPROVAL_UNAVAILABLE",
        null,
      );
      return {
        outcome: "blocked",
        execution_id,
        error_code: "TOOL_APPROVAL_UNAVAILABLE",
        run,
      };
    }
    // A grant was found above and executed via executeNow; unreachable here.
    return { outcome: "blocked", execution_id, error_code: "TOOL_BINDING_FAILED", run };
  }

  /**
   * Pause through the S20 boundary: the approval request + D8 pause commit in
   * the caller's transaction; the execute callback (this executor, with the
   * authority minted per execution) runs ONLY after an approve decision
   * commits (AC3's zero-side-effects-before-decision, on the decision side).
   */
  private pauseForApproval(args: {
    input: ToolProposalInput;
    execution_id: string;
    resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>;
    rawArgs: Record<string, unknown>;
    argsSummary: string;
    preview: ToolPreview | null;
    startedAt: string;
  }): ToolProposalOutcome {
    const { input, execution_id, resolved, argsSummary, preview, startedAt } = args;
    const { proposal, run } = input;
    const { definition } = resolved;
    const approvals = this.approvalsPort();
    if (approvals === undefined) {
      throw new ToolExecutorError(
        "TOOL_BINDING_FAILED",
        "state",
        "the approval machinery is not wired; a gated tool cannot pause",
      );
    }

    const withheld: WithheldExecution = {
      input,
      execution_id,
      resolved,
      rawArgs: args.rawArgs,
      argsSummary: args.argsSummary,
      preview,
      startedAt,
    };
    // G3: the free-text surfaces pass the tool redaction layer BEFORE the
    // approvals boundary (whose own deterministic pass still runs — defense
    // in depth; the S20 pass predates the S18 quoted-key/cookie vocabulary,
    // and the executor closes that gap at its boundary).
    const result = approvals.createRequestFromTypedProposal({
      proposal: {
        workspace_id: run.workspace_id,
        task_id: run.task_id,
        conversation_id: run.conversation_id,
        agent_id: input.agent_id,
        tool_id: definition.tool_id,
        tool_version: definition.version,
        capability: proposal.capability,
        risk_class: definition.risk_class,
        resource_scope: resourceScopeOf(input),
        args_digest: proposal.args_digest,
        side_effect_summary: redactAndBound(
          input.side_effect_summary ?? preview?.text ?? proposal.proposal_summary,
          SIDE_EFFECT_BUDGET_BYTES,
        ),
      },
      run,
      // The gated action is WITHHELD (AC3): the S20 pause never executes
      // pre-decision, so this callback (the pause path's auto-execute hook)
      // is a deliberate no-op — the real effect runs only through
      // runWithheld, which the decision machinery's post-commit callback
      // invokes. The authority is minted THERE, per execution (AC1).
      execute: () => {},
    });

    if (result.outcome === "paused_for_approval") {
      // Withhold the gated execution until the decision machinery calls
      // runWithheld (the post-commit callback); the history row lands as
      // awaiting_approval with the linkage.
      this.withheld.set(result.approval_id, withheld);
      this.recordAwaitingRow({
        input,
        execution_id,
        resolved,
        argsSummary,
        preview,
        startedAt,
        approvalId: result.approval_id,
      });
      return {
        outcome: "paused_for_approval",
        execution_id,
        approval_id: result.approval_id,
        run: result.run,
      };
    }
    if (result.outcome === "transition_rejected") {
      return {
        outcome: "transition_rejected",
        execution_id,
        rejection: result.rejection,
        run,
      };
    }
    // executed_automatically cannot occur for a gated class (the ladder said
    // gated); treat it defensively as the typed refusal it would be.
    return { outcome: "blocked", execution_id, error_code: "TOOL_BINDING_FAILED", run };
  }

  /** Execute through the binding under the tool's own limits, and record. */
  private executeNow(args: {
    input: ToolProposalInput;
    execution_id: string;
    resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>;
    binding: NonNullable<ReturnType<ToolRegistry["resolve"]>>["binding"];
    rawArgs: Record<string, unknown>;
    argsSummary: string;
    preview: ToolPreview | null;
    previewKind: ReturnType<typeof resolvePreviewKind>;
    startedAt: string;
    grantId: string | null;
    approvalId: string | null;
    /** False when the row already exists (the approved-callback resume). */
    resumeRow?: boolean;
  }): ToolProposalOutcome {
    const { input, execution_id, resolved, rawArgs, argsSummary, preview, startedAt } = args;
    const { run } = input;
    const { definition, max_response_bytes } = resolved;
    const deadline = this.nowMs() + definition.timeout_ms;

    if (args.resumeRow !== false) {
      this.deps.tools.insertExecution(
        {
          workspace_id: run.workspace_id,
          execution_id,
          task_id: run.task_id,
          conversation_id: run.conversation_id,
          agent_id: input.agent_id,
          tool_id: definition.tool_id,
          tool_version: definition.version,
          capability: input.proposal.capability,
          risk_class: definition.risk_class,
          recovery: definition.recovery,
          args_digest: input.proposal.args_digest,
          args_summary: argsSummary,
          preview: preview ? { kind: preview.kind, text: preview.text } : null,
          status: "running",
          approval_id: args.approvalId,
          grant_id: args.grantId,
          error_code: null,
          result_summary: null,
          timeout_ms: definition.timeout_ms,
          max_response_bytes,
          resource_limits: definition.resource_limits,
          started_at: startedAt,
          finished_at: null,
        },
        this.exec(),
      );
    } else {
      this.deps.tools.updateExecutionResult(
        run.workspace_id,
        execution_id,
        {
          status: "running",
          result_summary: null,
          finished_at: null,
          error_code: null,
          preview: preview ? { kind: preview.kind, text: preview.text } : null,
        },
        this.exec(),
      );
    }

    // The cancel seam: the executor owns the controller; the dispatched
    // outcome exposes cancel() (S22's escalation hook), and aborting it is
    // the process-backed family's process-tree termination signal (D27).
    const cancelController = new AbortController();

    const ctx: ToolExecutionContext = {
      authority: this.mintExecutionAuthority(),
      deadline,
      nowMs: () => this.nowMs(),
      maxResponseBytes: max_response_bytes,
      resourceLimits: definition.resource_limits,
      signal: cancelController.signal,
      execution: {
        execution_id,
        workspace_id: run.workspace_id,
        task_id: run.task_id,
        conversation_id: run.conversation_id,
        agent_id: input.agent_id,
        capability: input.proposal.capability,
        approval_id: args.approvalId,
        grant_id: args.grantId,
      },
    };

    // S26 process-backed family: the OPTIONAL async seam (E33's recorded
    // arrival). The child runs OUTSIDE the caller's transaction; the
    // continuation settles the history row when the process exits. The
    // wall-clock post-check below is deliberately not applied here — the
    // binding owns the deadline by killing its process tree.
    if (typeof args.binding.executeAsync === "function") {
      const executionContext = ctx;
      const completion = args.binding.executeAsync
        .call(args.binding, rawArgs, executionContext)
        .then((result) =>
          this.settleDispatched({
            input,
            execution_id,
            resolved,
            startedAt,
            grantId: args.grantId,
            approvalId: args.approvalId,
            result,
          }),
        )
        .catch((error: unknown): ToolProposalOutcome => {
          // A binding-level refusal (sandbox policy, missing interpreter,
          // authority) settles the row to failed — the dispatch already
          // created it, so the row must never hang in `running`.
          const code =
            error instanceof Error && error.name === "ToolBindingError"
              ? ((error.message.split(":")[0] ??
                  "SANDBOX_LAUNCH_FAILED") as ToolExecutorFailureCode)
              : "SANDBOX_LAUNCH_FAILED";
          this.settleFailedRow(run.workspace_id, run.task_id, execution_id, code);
          return { outcome: "execution_failed", execution_id, error_code: code, run };
        });
      this.inFlight.set(execution_id, {
        workspace_id: run.workspace_id,
        task_id: run.task_id,
        cancel: () => cancelController.abort(),
      });
      return {
        outcome: "dispatched",
        execution_id,
        run,
        completion: completion.finally(() => {
          this.inFlight.delete(execution_id);
        }),
        cancel: () => cancelController.abort(),
      };
    }

    let result: ToolBindingResult;
    try {
      result = args.binding.execute(rawArgs, ctx);
    } catch (error) {
      const code =
        error instanceof Error && error.name === "ToolBindingError"
          ? ((error.message.split(":")[0] ?? "TOOL_BINDING_FAILED") as ToolExecutorFailureCode)
          : "TOOL_BINDING_FAILED";
      this.finishFailed(run.workspace_id, execution_id, code, startedAt);
      return { outcome: "execution_failed", execution_id, error_code: code, run };
    }

    if (!result.ok) {
      const code = normalizeBindingCode(result.errorCode);
      this.finishFailed(run.workspace_id, execution_id, code, startedAt);
      return { outcome: "execution_failed", execution_id, error_code: code, run };
    }

    // AC5 (response size): the tool's own budget, enforced by the executor.
    if (Buffer.byteLength(result.text, "utf8") > max_response_bytes) {
      this.finishFailed(run.workspace_id, execution_id, "TOOL_RESPONSE_TOO_LARGE", startedAt);
      return {
        outcome: "execution_failed",
        execution_id,
        error_code: "TOOL_RESPONSE_TOO_LARGE",
        run,
      };
    }

    // Wall-clock post-check (clock drift beyond the binding's cooperation).
    if (this.nowMs() > deadline) {
      this.finishFailed(run.workspace_id, execution_id, "TOOL_EXECUTION_TIMEOUT", startedAt);
      return {
        outcome: "execution_failed",
        execution_id,
        error_code: "TOOL_EXECUTION_TIMEOUT",
        run,
      };
    }

    // G3/AC9: redact and bound BEFORE any history write.
    const resultSummary = redactAndBound(
      result.text,
      Math.min(max_response_bytes, RESULT_SUMMARY_BUDGET_BYTES),
    );
    const finishedAt = this.now();
    this.deps.tools.updateExecutionResult(
      run.workspace_id,
      execution_id,
      {
        status: "succeeded",
        result_summary: resultSummary,
        finished_at: finishedAt,
        error_code: null,
        grant_id: args.grantId,
        approval_id: args.approvalId,
      },
      this.exec(),
    );
    return { outcome: "executed", execution_id, result_summary: resultSummary, run };
  }

  /**
   * Run one withheld execution (the approval machinery's post-commit callback
   * — AC3's decision side). The authority is minted HERE; the row created at
   * pause time advances awaiting_approval -> running -> terminal. Absent id:
   * a typed false (nothing was withheld — e.g. an idempotent replay), never a
   * silent execution. A process-backed (S26) withheld execution returns the
   * dispatched completion's promise, which settles to the final outcome when
   * the process exits — the decision has already committed; the settlement
   * only records it.
   */
  runWithheld(approvalId: string): boolean | Promise<ToolProposalOutcome> {
    const withheld = this.withheld.get(approvalId);
    if (withheld === undefined) {
      return false;
    }
    this.withheld.delete(approvalId);
    const outcome = this.executeNow({
      input: withheld.input,
      execution_id: withheld.execution_id,
      resolved: withheld.resolved,
      binding: withheld.resolved.binding,
      rawArgs: withheld.rawArgs,
      argsSummary: withheld.argsSummary,
      preview: withheld.preview,
      previewKind: resolvePreviewKind(
        withheld.resolved.definition.risk_class,
        withheld.resolved.definition.capabilities,
      ),
      startedAt: withheld.startedAt,
      grantId: null,
      approvalId,
      resumeRow: false,
    });
    if (outcome.outcome === "dispatched") {
      return outcome.completion;
    }
    return outcome.outcome === "executed";
  }

  /**
   * Settle one dispatched (process-backed) execution when its child exits:
   * the mirror of the sync tail, in a NEW short transaction (the dispatching
   * caller's transaction has long committed). Redact and bound BEFORE the
   * write (G3); the response budget stays executor-enforced. A row the S22
   * run-cancellation sweep already terminalized is never rewritten (G5: a
   * recorded end stays recorded) — the outcome still answers honestly.
   */
  private settleDispatched(args: {
    input: ToolProposalInput;
    execution_id: string;
    resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>;
    startedAt: string;
    grantId: string | null;
    approvalId: string | null;
    result: ToolBindingResult;
  }): ToolProposalOutcome {
    const { input, execution_id, result } = args;
    const { run } = input;
    const { max_response_bytes } = args.resolved;
    void args.startedAt;

    if (!result.ok) {
      const code = normalizeBindingCode(result.errorCode);
      this.settleFailedRow(run.workspace_id, run.task_id, execution_id, code);
      return { outcome: "execution_failed", execution_id, error_code: code, run };
    }
    // AC5 (response size): the tool's own budget, enforced by the executor.
    if (Buffer.byteLength(result.text, "utf8") > max_response_bytes) {
      this.settleFailedRow(run.workspace_id, run.task_id, execution_id, "TOOL_RESPONSE_TOO_LARGE");
      return {
        outcome: "execution_failed",
        execution_id,
        error_code: "TOOL_RESPONSE_TOO_LARGE",
        run,
      };
    }
    if (this.rowIsTerminal(run.workspace_id, run.task_id, execution_id)) {
      return {
        outcome: "execution_failed",
        execution_id,
        error_code: "TOOL_EXECUTION_CANCELLED",
        run,
      };
    }
    // G3/AC9: redact and bound BEFORE any history write.
    const resultSummary = redactAndBound(
      result.text,
      Math.min(max_response_bytes, RESULT_SUMMARY_BUDGET_BYTES),
    );
    this.deps.tx.transaction((exec) => {
      this.deps.tools.updateExecutionResult(
        run.workspace_id,
        execution_id,
        {
          status: "succeeded",
          result_summary: resultSummary,
          finished_at: this.now(),
          error_code: null,
          grant_id: args.grantId,
          approval_id: args.approvalId,
        },
        exec,
      );
    });
    return { outcome: "executed", execution_id, result_summary: resultSummary, run };
  }

  /** The dispatched path's failure writer (its own short transaction). */
  private settleFailedRow(
    workspaceId: string,
    taskId: string,
    executionId: string,
    code: ToolExecutorFailureCode,
  ): void {
    if (this.rowIsTerminal(workspaceId, taskId, executionId)) {
      return;
    }
    this.deps.tx.transaction((exec) => {
      this.deps.tools.updateExecutionResult(
        workspaceId,
        executionId,
        {
          status: "failed",
          result_summary: null,
          finished_at: this.now(),
          error_code: code,
        },
        exec,
      );
    });
  }

  /** True when the row already reached a terminal state (never rewritten). */
  private rowIsTerminal(workspaceId: string, taskId: string, executionId: string): boolean {
    try {
      const row = this.deps.tools
        .listExecutionsByTask(workspaceId, taskId)
        .find((entry) => entry.execution_id === executionId);
      if (row === undefined) return false;
      return (
        row.status === "succeeded" ||
        row.status === "failed" ||
        row.status === "blocked" ||
        row.status === "cancelled"
      );
    } catch {
      return false;
    }
  }

  /**
   * Cancel one task's tool work through the executor seam (S22; AC5, D32).
   * Three honest effects, in order:
   *
   *   1. every WITHHELD gated execution of the task is dropped — the effect
   *      NEVER runs after the cancel (fail-closed; a post-cancel runWithheld
   *      answers the typed false), and its history row reads `cancelled`
   *      (D9: a cancelled approval never leaves a grant or an execution);
   *   2. the task's IN-FLIGHT dispatched executions (the S26 process-backed
   *      family — E35 recorded this hook and the S26 integration closed it)
   *      have their cancel seam fired: the child process tree is terminated
   *      (D27) and the settlement path leaves the row to this sweep;
   *   3. non-terminal history rows of the task (`running`,
   *      `awaiting_approval` — the crash-era orphans) sweep to `cancelled`;
   *      terminal rows keep their outcome (nothing is rewritten — G5).
   *
   * The cancelled execution ids are returned (the cancellation evidence the
   * run-cancel response lists). Idempotent: a second call finds nothing
   * non-terminal and returns [].
   */
  cancelForTask(workspaceId: string, taskId: string): string[] {
    const cancelled: string[] = [];

    // 1. Drop the task's withheld executions — never execute post-cancel.
    for (const [approvalId, withheld] of [...this.withheld.entries()]) {
      const run = withheld.input.run;
      if (run.workspace_id !== workspaceId || run.task_id !== taskId) continue;
      this.withheld.delete(approvalId);
      try {
        this.deps.tools.updateExecutionResult(
          workspaceId,
          withheld.execution_id,
          {
            status: "cancelled",
            result_summary: null,
            finished_at: this.now(),
            error_code: null,
          },
          this.exec(),
        );
        cancelled.push(withheld.execution_id);
      } catch {
        // Contained: the withheld entry is dropped regardless (fail-closed
        // on the effect); the row sweep below still terminalizes the row.
      }
    }

    // 2. Fire the in-flight process-backed cancel seams (the D27 termination):
    // the children die; their settlement skips the already-swept rows (G5).
    for (const [executionId, inFlight] of [...this.inFlight.entries()]) {
      if (inFlight.workspace_id !== workspaceId || inFlight.task_id !== taskId) continue;
      this.inFlight.delete(executionId);
      try {
        inFlight.cancel();
        cancelled.push(executionId);
      } catch {
        // Contained: the row sweep below still terminalizes the row.
      }
    }

    // 3. Sweep the task's non-terminal rows to `cancelled` (terminal rows
    // keep their outcome — a finished execution is not rewritten).
    let rows: Array<{ execution_id: string; status: string }>;
    try {
      rows = this.deps.tools
        .listExecutionsByTask(workspaceId, taskId)
        .map((row) => ({ execution_id: row.execution_id, status: row.status }));
    } catch {
      return cancelled;
    }
    for (const row of rows) {
      if (row.status !== "running" && row.status !== "awaiting_approval") continue;
      const updated = this.deps.tools.updateExecutionResult(
        workspaceId,
        row.execution_id,
        {
          status: "cancelled",
          result_summary: null,
          finished_at: this.now(),
          error_code: null,
        },
        this.exec(),
      );
      if (updated) cancelled.push(row.execution_id);
    }
    return cancelled;
  }

  // -------------------------------------------------------------------------
  // History-row helpers (all inside the caller's transaction)
  // -------------------------------------------------------------------------

  private exec(): SqliteExec {
    return this.deps.tx.connection();
  }

  private recordBlockedRow(
    input: ToolProposalInput,
    execution_id: string,
    resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>,
    startedAt: string,
    errorCode: ToolExecutorFailureCode,
    preview: ToolPreview | null,
  ): void {
    const { run } = input;
    const { definition, max_response_bytes } = resolved;
    this.deps.tools.insertExecution(
      {
        workspace_id: run.workspace_id,
        execution_id,
        task_id: run.task_id,
        conversation_id: run.conversation_id,
        agent_id: input.agent_id,
        tool_id: definition.tool_id,
        tool_version: definition.version,
        capability: input.proposal.capability,
        risk_class: definition.risk_class,
        recovery: definition.recovery,
        args_digest: input.proposal.args_digest,
        args_summary: summarizeArgs(input.rawArgs ?? null, ARGS_SUMMARY_BUDGET_BYTES),
        preview: preview ? { kind: preview.kind, text: preview.text } : null,
        status: "blocked",
        approval_id: null,
        grant_id: null,
        error_code: errorCode,
        result_summary: null,
        timeout_ms: definition.timeout_ms,
        max_response_bytes,
        resource_limits: definition.resource_limits,
        started_at: startedAt,
        finished_at: this.now(),
      },
      this.exec(),
    );
  }

  private recordAwaitingRow(args: {
    input: ToolProposalInput;
    execution_id: string;
    resolved: NonNullable<ReturnType<ToolRegistry["resolve"]>>;
    argsSummary: string;
    preview: ToolPreview | null;
    startedAt: string;
    approvalId: string;
  }): void {
    const { input, execution_id, resolved, argsSummary, preview, startedAt, approvalId } = args;
    const { run } = input;
    const { definition, max_response_bytes } = resolved;
    this.deps.tools.insertExecution(
      {
        workspace_id: run.workspace_id,
        execution_id,
        task_id: run.task_id,
        conversation_id: run.conversation_id,
        agent_id: input.agent_id,
        tool_id: definition.tool_id,
        tool_version: definition.version,
        capability: input.proposal.capability,
        risk_class: definition.risk_class,
        recovery: definition.recovery,
        args_digest: input.proposal.args_digest,
        args_summary: argsSummary,
        preview: preview ? { kind: preview.kind, text: preview.text } : null,
        status: "awaiting_approval",
        approval_id: approvalId,
        grant_id: null,
        error_code: null,
        result_summary: null,
        timeout_ms: definition.timeout_ms,
        max_response_bytes,
        resource_limits: definition.resource_limits,
        started_at: startedAt,
        finished_at: null,
      },
      this.exec(),
    );
  }

  private finishFailed(
    workspaceId: string,
    executionId: string,
    code: ToolExecutorFailureCode,
    startedAt: string,
  ): void {
    this.deps.tools.updateExecutionResult(
      workspaceId,
      executionId,
      {
        status: "failed",
        result_summary: null,
        finished_at: this.now(),
        error_code: code,
      },
      this.exec(),
    );
    void startedAt;
  }
}

/** Map a binding's typed failure to the executor's code vocabulary. */
function normalizeBindingCode(code: string): ToolExecutorFailureCode {
  if (
    code === "TOOL_EXECUTION_TIMEOUT" ||
    code === "TOOL_RESPONSE_TOO_LARGE" ||
    code === "SANDBOX_PATH_ESCAPE" ||
    code === "SANDBOX_LAUNCH_FAILED" ||
    code === "SANDBOX_LIMIT_EXCEEDED" ||
    code === "TOOL_EXECUTION_CANCELLED"
  ) {
    return code;
  }
  return "TOOL_BINDING_FAILED";
}

/**
 * Minimal typed JSON Schema validation for tool inputs (D38): object typing,
 * required properties, and declared property types. The subset the contracts
 * JsonSchema primitive carries; unknown keywords are ignored (JSON Schema
 * semantics), additional properties are allowed unless the schema says
 * otherwise. Never eval, never a shell (D24).
 */
function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (
    schema.type !== "object" ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (!(key in record)) {
      return false;
    }
  }
  const properties =
    typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in record)) {
      continue;
    }
    if (!matchesType(record[key], propertySchema)) {
      return false;
    }
  }
  return true;
}

function matchesType(value: unknown, propertySchema: Record<string, unknown>): boolean {
  const expected = propertySchema.type;
  if (typeof expected !== "string") {
    return true; // no type constraint declared
  }
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * The D9 resource scope of one proposal (explicit — never inferred widely),
 * passed through the redaction boundary ONCE: the recorded scope and the
 * grant-recheck scope are the SAME deterministic value (the S20 gate compares
 * exactly; a raw secret-bearing scope fails closed as a typed miss rather
 * than over-matching a redacted grant).
 */
function resourceScopeOf(input: ToolProposalInput): string {
  return redactAndBound(
    input.resource_scope ?? `task:${input.run.task_id}`,
    RESOURCE_SCOPE_BUDGET_BYTES,
  );
}

/** Re-export for the resource-limits type (contracts-only data, no logic). */
export type { ResourceLimits };
