/**
 * Tool bindings and the execution authority (S21 chunk 2; PRD §7, D38, G2,
 * AC1). A binding is the runtime-owned implementation of one tool family —
 * the ONLY code in the runtime that performs a tool's effect, and it refuses
 * to run without the executor-minted execution authority (AC1: every
 * execution goes through the executor; a direct binding call reachable from
 * agent-facing code is structurally impossible because the authority token is
 * minted in exactly one place and never handed to adapters, sessions, or any
 * other proposing surface).
 *
 * The authority is a brand check, not a cryptographic capability: the threat
 * model it answers is ARCHITECTURAL (no agent-facing code path can reach a
 * binding's effect), pinned by the executor suite's no-bypass tests.
 *
 * Bindings are SYNCHRONOUS in the in-process family (the only family this
 * slice ships): execution completes within the caller's transaction boundary,
 * which is what lets the S20 approval machinery invoke the withheld callback
 * synchronously after its decision commits — preserving S20's
 * consumption-after-effect ordering. The deadline is COOPERATIVE for this
 * family (bindings check `ctx.nowMs()` between work units and return the
 * typed timeout refusal); process-backed bindings (the S26 execution tools)
 * arrive through this same interface and enforce the deadline by killing
 * their process tree (S22 owns escalation semantics).
 *
 * MCP note (issue #22 leverage, read before designing): an MCP server's tools
 * (modelcontextprotocol.io — tools/list, tools/call, JSON Schema input/output)
 * map onto THIS seam as one binding per wrapped server, with the runtime
 * executor staying authoritative (G2): validation, limits, risk gating,
 * redaction, and history happen HERE, before any tools/call leaves the
 * runtime. The MCP TypeScript SDK embed lands with the connectors that need
 * it (S25/S26); the binding contract below is that seam.
 */
import type { ResourceLimits } from "@shera-bot/contracts";

/** Failure codes a binding (or its authority check) can raise. */
export type ToolBindingFailureCode =
  | "EXECUTION_AUTHORITY_MISSING"
  | "TOOL_EXECUTION_TIMEOUT"
  | "TOOL_BINDING_FAILED"
  /** S26 sandbox policy refusals and limit deaths (executor passthrough). */
  | "SANDBOX_PATH_ESCAPE"
  | "SANDBOX_LAUNCH_FAILED"
  | "SANDBOX_LIMIT_EXCEEDED"
  | "TOOL_EXECUTION_CANCELLED";

export class ToolBindingError extends Error {
  readonly code: ToolBindingFailureCode;

  constructor(code: ToolBindingFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ToolBindingError";
    this.code = code;
  }
}

/**
 * The executor-minted execution authority. The brand symbol is module-private:
 * nothing outside this module can construct a value that passes
 * assertExecutionAuthority — and the executor module is the only place that
 * receives one (it mints its own per execution).
 */
const AUTHORITY_BRAND = Symbol("shera.toolExecutionAuthority");

export type ExecutionAuthority = { readonly [AUTHORITY_BRAND]: true };

/** The one producer of a genuine authority token (the executor calls this). */
export function makeExecutionAuthority(): ExecutionAuthority {
  return { [AUTHORITY_BRAND]: true } as ExecutionAuthority;
}

/** AC1's structural gate: refuse anything that is not a genuine authority. */
export function assertExecutionAuthority(value: unknown): asserts value is ExecutionAuthority {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<symbol, unknown>)[AUTHORITY_BRAND] !== true
  ) {
    throw new ToolBindingError(
      "EXECUTION_AUTHORITY_MISSING",
      "tool bindings execute only through the runtime executor (AC1: no bypass path)",
    );
  }
}

/** The per-execution context a binding runs under (all per-tool data). */
export interface ToolExecutionContext {
  authority: ExecutionAuthority;
  /** Epoch-ms deadline from the tool's own timeout_ms (injected clock). */
  deadline: number;
  /** The injected millisecond clock (deterministic in tests). */
  nowMs: () => number;
  /** The tool's own response budget. */
  maxResponseBytes: number;
  /** The tool's own D27 resource limits (kernel enforcement: S26 family). */
  resourceLimits: ResourceLimits;
  /**
   * Cooperative cancel seam: in-process bindings honor it between work units;
   * the process-backed family (S26) wires it to process-tree escalation.
   */
  signal: AbortSignal;
  /**
   * The execution's runtime identity (S26): workspace/task/agent/capability
   * plus the approval linkage, so process-backed bindings can record terminal
   * output and artifacts against the right scope. The executor fills it; the
   * in-process family ignores it.
   */
  readonly execution: {
    execution_id: string;
    workspace_id: string;
    task_id: string;
    conversation_id: string;
    agent_id: string;
    capability: string;
    approval_id: string | null;
    grant_id: string | null;
  };
}

/** The pure, pre-execution preview a gated tool shows (D35 — zero side effects). */
export interface ToolPreview {
  kind: "diff" | "command" | "repo" | "target_effect";
  /** UI-safe preview text; the executor bounds and redacts it before storing. */
  text: string;
}

export type ToolBindingResult =
  { ok: true; text: string } | { ok: false; errorCode: string; message: string };

/**
 * One tool family's implementation. preview() is PURE (no side effects, safe
 * to run pre-approval); execute() performs the effect and MUST call
 * assertExecutionAuthority before anything else.
 *
 * The process-backed family (S26) implements the OPTIONAL `executeAsync`
 * seam instead: it spawns the child through the adapters/process sandbox
 * adapter and resolves when the process exits. Its sync `execute` is a typed
 * REFUSAL — a process-backed effect can only be dispatched through the
 * executor's async dispatch (which mints the authority and owns the cancel
 * seam), never run inside a caller's transaction.
 */
export interface ToolBinding {
  readonly name: string;
  preview(args: Record<string, unknown>): ToolPreview | null;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): ToolBindingResult;
  executeAsync?(
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolBindingResult>;
}

/**
 * The built-in demo note store (S21's observable prototype tools): an
 * in-memory workspace note map both demo bindings operate on. Tests read
 * `notes` directly to observe side effects (the AC3 sentinel is a REAL
 * effect, not a flag).
 */
export function makeNoteBindings(): {
  notes: Map<string, string>;
  read: ToolBinding;
  append: ToolBinding;
} {
  const notes = new Map<string, string>();

  const read: ToolBinding = {
    name: "notes-read",
    preview() {
      return null; // read-only: nothing to preview (G6)
    },
    execute(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const path = typeof args.path === "string" ? args.path : "";
      const steps = typeof args.steps === "number" ? args.steps : 1;
      for (let step = 0; step < steps; step += 1) {
        // Cooperative deadline: each simulated work unit checks the tool's
        // own timeout (AC5). The fake test clock advances per check.
        if (ctx.nowMs() > ctx.deadline) {
          return {
            ok: false,
            errorCode: "TOOL_EXECUTION_TIMEOUT",
            message: `the tool exceeded its ${ctx.deadline} ms deadline`,
          };
        }
      }
      const content = notes.get(path) ?? "";
      const payload = typeof args.payload === "string" ? args.payload : undefined;
      return { ok: true, text: payload ?? content };
    },
  };

  const append: ToolBinding = {
    name: "notes-append",
    preview(args) {
      const path = typeof args.path === "string" ? args.path : "";
      const line = typeof args.line === "string" ? args.line : "";
      const before = notes.get(path) ?? "";
      return {
        kind: "diff",
        text: [
          `--- a/${path}`,
          `+++ b/${path}`,
          ...before.split("\n").map((l) => ` ${l}`),
          `+${line}`,
        ].join("\n"),
      };
    },
    execute(args, ctx) {
      assertExecutionAuthority(ctx.authority);
      const path = typeof args.path === "string" ? args.path : "";
      const line = typeof args.line === "string" ? args.line : "";
      if (ctx.nowMs() > ctx.deadline) {
        return {
          ok: false,
          errorCode: "TOOL_EXECUTION_TIMEOUT",
          message: `the tool exceeded its ${ctx.deadline} ms deadline`,
        };
      }
      notes.set(path, `${notes.get(path) ?? ""}${notes.get(path) ? "\n" : ""}${line}`);
      return { ok: true, text: `appended 1 line to ${path}` };
    },
  };

  return { notes, read, append };
}

/**
 * The scripted demo family's no-op binding (S21 compose wiring): the S20
 * scripted tool's "effect" is the run's own continuation — recorded in the
 * tool history like every real tool, with no external effect. Keeps the S20
 * demo posture under the executor's validation, ladder, limits, and records.
 */
export function makeScriptedNoopBinding(): ToolBinding {
  return {
    name: "scripted-noop",
    preview() {
      return null; // the side-effect summary is the preview surface (S20)
    },
    execute(_args, ctx) {
      assertExecutionAuthority(ctx.authority);
      if (ctx.nowMs() > ctx.deadline) {
        return {
          ok: false,
          errorCode: "TOOL_EXECUTION_TIMEOUT",
          message: `the tool exceeded its ${ctx.deadline} ms deadline`,
        };
      }
      return { ok: true, text: "scripted execution completed" };
    },
  };
}
