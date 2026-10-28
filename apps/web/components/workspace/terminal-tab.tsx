"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";

import "@xterm/xterm/css/xterm.css";

import { ErrorState } from "@/components/shell/states";
import { cn } from "@/lib/utils";
import type {
  TerminalApprovalStateView,
  TerminalExecutionView,
  TerminalLivePhase,
} from "@/lib/terminal-live";
import { useTerminalLive } from "@/lib/terminal-live";
import { useSameOriginRuntimeSocketUrl } from "@/lib/runtime-live";

/**
 * The Terminal tab (UI_DESIGN §4 S7, issue #19): a read-only live view of ONE
 * Agent's terminal activity — the running command, working directory, resource
 * policy, and approval state per execution (D35 fields, verbatim from the
 * journal), with the output streamed through an embedded xterm.js viewport.
 *
 * READ-ONLY IS STRUCTURAL (G6): the terminal is constructed with
 * `disableStdin` and no `onData` handler — there is no input path to remove,
 * and the component renders no control that could send anything to the
 * runtime. The only button this surface can ever show is a read Retry.
 * The status strip states the delivery class honestly (§6.2/§6.4): Live,
 * Reconnecting, or Offline — never a fabricated realtime feel.
 */

export interface TerminalTabViewProps {
  /** disabled = the panel has no Agent binding (a deep link), so there is no per-Agent stream to show. */
  phase: TerminalLivePhase | "disabled";
  executions: TerminalExecutionView[];
  loading: boolean;
  error: string | null;
  onRetry?: (() => void) | undefined;
}

/** The §2.1 approval vocabulary — color never the only signal (text badge). */
const APPROVAL_LABELS: Record<TerminalApprovalStateView, string> = {
  not_required: "No approval required",
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Rejected",
};

const APPROVAL_STYLES: Record<TerminalApprovalStateView, string> = {
  not_required: "border-line text-muted",
  pending: "border-approval/40 text-approval",
  approved: "border-live/40 text-live",
  rejected: "border-failed/40 text-failed",
};

function PolicyEntries({ policy }: { policy: Record<string, unknown> }): ReactElement | null {
  const entries = Object.entries(policy);
  if (entries.length === 0) {
    return null;
  }
  return (
    <dl data-testid="terminal-policy" className="flex flex-col gap-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2 text-xs">
          <dt className="shrink-0 text-muted">{key}</dt>
          <dd className="min-w-0 break-all font-mono text-text">
            {value === null || value === undefined
              ? "—"
              : typeof value === "object"
                ? JSON.stringify(value)
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExecutionSummary({ execution }: { execution: TerminalExecutionView }): ReactElement {
  return (
    <div
      data-testid="terminal-execution"
      className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface-elevated/60 p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <code
          data-testid="terminal-command"
          className="min-w-0 break-all font-mono text-xs text-cool-highlight"
        >
          {execution.command}
        </code>
        <span className="shrink-0 text-xs text-muted">
          {execution.status === "running"
            ? "Running"
            : execution.exitCode !== null
              ? `Exited · code ${execution.exitCode}`
              : `Exited · ${execution.exitSignal ?? "terminated"}`}
        </span>
      </div>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="shrink-0 text-muted">Workdir</span>
        <span data-testid="terminal-workdir" className="min-w-0 break-all font-mono text-text">
          {execution.workdir}
        </span>
      </div>
      <PolicyEntries policy={execution.resourcePolicy} />
      <div>
        <span
          data-testid="terminal-approval"
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-xs",
            APPROVAL_STYLES[execution.approvalState],
          )}
        >
          {APPROVAL_LABELS[execution.approvalState]}
        </span>
      </div>
    </div>
  );
}

export function TerminalTabView({
  phase,
  executions,
  loading,
  error,
  onRetry,
}: TerminalTabViewProps): ReactElement {
  const current = executions[0] ?? null;
  const earlier = executions.slice(1);
  return (
    <div
      data-testid="terminal-panel"
      data-read-only="true"
      aria-label="Agent terminal activity (read-only)"
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-2 pt-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          {phase === "live" ? (
            <span className="animate-live-pulse size-1.5 rounded-full bg-live" aria-hidden="true" />
          ) : null}
          {phase === "live"
            ? "Live"
            : phase === "connecting"
              ? "Connecting…"
              : phase === "reconnecting"
                ? "Reconnecting…"
                : phase === "offline"
                  ? "Offline — showing the last synced activity"
                  : "Read-only terminal view"}
        </span>
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-muted">
          Read-only
        </span>
      </div>

      {error !== null ? (
        <div className="px-3 pb-3">
          <ErrorState safeMessage={error} onRetry={onRetry} />
        </div>
      ) : phase === "disabled" ? (
        <p className="px-3 text-sm text-muted">
          Open this panel from an Agent chat to see that Agent&rsquo;s terminal activity.
        </p>
      ) : loading && current === null ? (
        <TerminalSkeleton />
      ) : current === null ? (
        <div className="flex flex-1 items-start px-3 pt-6">
          <p className="text-sm text-muted">
            No terminal activity yet. This view fills in when an Agent runs a command in its
            workspace.
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3">
          <ExecutionSummary execution={current} />
          <div
            data-testid="terminal-viewport"
            aria-label="Agent terminal output (read-only)"
            className="min-h-[160px] flex-1 overflow-hidden rounded-xl border border-line bg-canvas"
          >
            <TerminalViewport execution={current} />
          </div>
          {earlier.length > 0 ? (
            <section data-testid="terminal-history" className="flex flex-col gap-1.5">
              <h3 className="text-xs text-muted">Earlier executions</h3>
              {earlier.map((execution) => (
                <div key={execution.terminalId} className="flex items-baseline gap-2 text-xs">
                  <code className="min-w-0 flex-1 break-all font-mono text-muted">
                    {execution.command}
                  </code>
                  <span className="shrink-0 text-muted">
                    {execution.status === "running"
                      ? "Running"
                      : execution.exitCode !== null
                        ? `code ${execution.exitCode}`
                        : (execution.exitSignal ?? "terminated")}
                  </span>
                </div>
              ))}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** §2.4 loading: a layout-matched skeleton, never a spinner. */
function TerminalSkeleton(): ReactElement {
  return (
    <div data-testid="terminal-skeleton" aria-hidden="true" className="flex flex-col gap-3 px-3">
      <div className="h-[4.5rem] animate-pulse rounded-xl bg-surface-elevated" />
      <div className="h-40 animate-pulse rounded-xl bg-surface-elevated" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The xterm viewport — client-only, token-themed, output-only
// ---------------------------------------------------------------------------

interface TerminalHandle {
  term: import("@xterm/xterm").Terminal;
  fit: import("@xterm/addon-fit").FitAddon;
}

/**
 * The embedded read-only terminal. xterm loads dynamically (client only), is
 * themed from the token layer at mount (no color literals — the token file
 * stays the only owner of raw values), and writes chunks APPEND-ONLY: the
 * journal order is the render order, and a reconnect replay writes exactly
 * the gap (the cursor acknowledgement lives in the hook).
 */
function TerminalViewport({ execution }: { execution: TerminalExecutionView }): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handle = useRef<TerminalHandle | null>(null);
  /** What has already been written for the CURRENT execution id. */
  const written = useRef<{ terminalId: string; count: number }>({ terminalId: "", count: 0 });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    let disposed = false;
    let local: TerminalHandle | null = null;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) {
        return;
      }
      const styles = getComputedStyle(container);
      // The token layer (globals.css) is the ONLY owner of raw color values
      // (§2.1, enforced by design-tokens.test.ts): every theme entry resolves
      // from a CSS custom property, and a missing token simply leaves the
      // entry to xterm's own default — never a literal fallback.
      const token = (name: string): string | undefined => {
        const value = styles.getPropertyValue(name).trim();
        return value === "" ? undefined : value;
      };
      const theme: import("@xterm/xterm").ITheme = { cursor: "transparent" };
      type ThemedKey =
        | "background"
        | "foreground"
        | "selectionBackground"
        | "black"
        | "brightBlack"
        | "white"
        | "brightWhite"
        | "red"
        | "green"
        | "yellow"
        | "blue"
        | "cyan";
      const themeEntries: Array<[ThemedKey, string | undefined]> = [
        ["background", token("--color-canvas")],
        ["foreground", token("--color-text")],
        ["selectionBackground", token("--color-brand")],
        ["black", token("--color-canvas")],
        ["brightBlack", token("--color-muted")],
        ["white", token("--color-text")],
        ["brightWhite", token("--color-cool-highlight")],
        ["red", token("--color-failed")],
        ["green", token("--color-live")],
        ["yellow", token("--color-approval")],
        ["blue", token("--color-brand")],
        ["cyan", token("--color-sky")],
      ];
      for (const [key, value] of themeEntries) {
        if (value !== undefined) {
          theme[key] = value;
        }
      }
      const term = new Terminal({
        // READ-ONLY (G6): no stdin, no data handler, no cursor — output only.
        disableStdin: true,
        cursorBlink: false,
        convertEol: true,
        scrollback: 2000,
        fontSize: 12,
        lineHeight: 1.4,
        fontFamily: styles.fontFamily,
        allowProposedApi: true,
        theme,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(container);
      try {
        fit.fit();
      } catch {
        // A zero-size mount (collapsed panel) has nothing to fit yet; the
        // resize observer below fits once real space exists.
      }
      local = { term, fit };
      handle.current = local;
      written.current = { terminalId: "", count: 0 };
      setReady(true);
    })();
    return () => {
      disposed = true;
      handle.current = null;
      setReady(false);
      local?.term.dispose();
    };
  }, []);

  // Fit on container resize (the panel is drag-resizable; the sheet varies).
  // The platform ResizeObserver — no dependency adopted for four lines.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      try {
        handle.current?.fit.fit();
      } catch {
        // A zero-size intermediate frame cannot fit; the next report will.
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Append-only writes: the delta since the last write for THIS execution.
  useEffect(() => {
    const local = handle.current;
    if (!ready || local === null) {
      return;
    }
    if (written.current.terminalId !== execution.terminalId) {
      local.term.clear();
      written.current = { terminalId: execution.terminalId, count: 0 };
    }
    const pending = execution.chunks.slice(written.current.count);
    for (const chunk of pending) {
      local.term.write(chunk.text);
    }
    written.current.count = execution.chunks.length;
  }, [ready, execution.terminalId, execution.chunks]);

  return <div ref={containerRef} className="h-full w-full font-mono" />;
}

export function TerminalTab({
  workspaceId,
  agentId,
}: {
  workspaceId: string;
  agentId: string | null;
}): ReactElement {
  const wsUrl = useSameOriginRuntimeSocketUrl();
  const live = useTerminalLive({
    wsUrl,
    workspaceId,
    agentId,
    enabled: wsUrl !== null && agentId !== null,
  });
  return (
    <TerminalTabView
      phase={agentId === null ? "disabled" : live.phase}
      executions={live.executions}
      loading={live.loading}
      error={live.error}
    />
  );
}
