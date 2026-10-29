"use client";

import { Check, CircleAlert, CircleDashed, Clock, ShieldCheck, Wrench, X } from "lucide-react";
import type { ReactElement } from "react";

import { ErrorState } from "@/components/shell/states";
import { RiskBadge } from "@/components/chat/cards";
import { useAgentRoster } from "@/lib/agent-data";
import { safeToolsMessage, useToolHistory } from "@/lib/tools-data";
import type { ToolHistoryEntry } from "@/lib/tools-api";

/**
 * The Tool history tab (UI_DESIGN §4 S7 + §5 tool card): the workspace's
 * tool executions as the EXECUTOR recorded them — name, version, arguments
 * summary, result status, risk class, and the approval/grant linkage, all
 * REDACTED at the executor boundary (G3/AC9: raw arguments exist nowhere).
 * The statuses are the runtime's vocabulary (proposed → validated → running
 * → succeeded/failed/blocked) — never the UI's guess (G2: nothing renders as
 * done before the runtime says so; an awaiting row says it is waiting).
 */

const STATUS_PRESENTATION: Record<
  ToolHistoryEntry["status"],
  { label: string; icon: ReactElement; className: string }
> = {
  proposed: {
    label: "Proposed",
    icon: <CircleDashed className="size-3.5" aria-hidden="true" />,
    className: "text-muted",
  },
  validated: {
    label: "Validated",
    icon: <CircleDashed className="size-3.5" aria-hidden="true" />,
    className: "text-muted",
  },
  running: {
    label: "Running",
    icon: <Clock className="size-3.5" aria-hidden="true" />,
    className: "text-sky",
  },
  awaiting_approval: {
    label: "Pausing for your approval",
    icon: <ShieldCheck className="size-3.5" aria-hidden="true" />,
    className: "text-approval",
  },
  succeeded: {
    label: "Succeeded",
    icon: <Check className="size-3.5" aria-hidden="true" />,
    className: "text-success",
  },
  failed: {
    label: "Failed",
    icon: <X className="size-3.5" aria-hidden="true" />,
    className: "text-failed",
  },
  blocked: {
    label: "Blocked by policy",
    icon: <CircleAlert className="size-3.5" aria-hidden="true" />,
    className: "text-failed",
  },
  cancelled: {
    label: "Cancelled",
    icon: <X className="size-3.5" aria-hidden="true" />,
    className: "text-muted",
  },
};

function HistoryRow({
  entry,
  agentNames,
}: {
  entry: ToolHistoryEntry;
  agentNames: Record<string, string>;
}) {
  const presentation = STATUS_PRESENTATION[entry.status];
  const finished = entry.finished_at ? new Date(entry.finished_at).toLocaleTimeString() : null;
  return (
    <li
      data-execution-id={entry.execution_id}
      className="rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Wrench className="size-4 shrink-0 self-center text-sky" aria-hidden="true" />
        <span className="truncate font-mono text-sm text-text">{entry.tool_id}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">v{entry.tool_version}</span>
        <RiskBadge riskClass={entry.risk_class} />
      </div>
      <dl className="mt-2 space-y-1 text-[13px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Status</dt>
          <dd className={`flex items-center gap-1.5 ${presentation.className}`}>
            {presentation.icon}
            {presentation.label}
          </dd>
          {finished ? (
            <>
              <dt className="ml-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Finished
              </dt>
              <dd className="font-mono text-[11px] text-muted">{finished}</dd>
            </>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Requested by
          </dt>
          <dd className="text-text">{agentNames[entry.agent_id] ?? entry.agent_id}</dd>
          <dt className="ml-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Arguments
          </dt>
          <dd
            className="min-w-0 truncate font-mono text-[11px] text-muted"
            title={entry.args_summary}
          >
            {entry.args_summary}
          </dd>
        </div>
        {entry.preview ? (
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              Preview ({String((entry.preview as Record<string, unknown>).kind ?? "diff")})
            </dt>
            <dd>
              <pre className="max-h-40 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-[11px] leading-relaxed text-muted">
                {String((entry.preview as Record<string, unknown>).text ?? "")}
              </pre>
            </dd>
          </div>
        ) : null}
        {entry.result_summary ? (
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Result</dt>
            <dd className="text-[13px] text-text">{entry.result_summary}</dd>
          </div>
        ) : null}
        {entry.error_code ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Reason</dt>
            <dd className="font-mono text-[11px] text-failed">{entry.error_code}</dd>
          </div>
        ) : null}
        {entry.approval_id ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              Approval
            </dt>
            <dd className="font-mono text-[11px] text-muted">
              linked — decided from its own card in the thread
            </dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}

export function ToolsTab({ workspaceId }: { workspaceId: string }): ReactElement {
  const { history, loading, error } = useToolHistory(workspaceId);
  const roster = useAgentRoster(workspaceId);
  const agentNames = Object.fromEntries(
    roster.agents.map((identity) => [identity.agent_id, identity.display_name]),
  );

  if (error) {
    return (
      <div className="p-4">
        <ErrorState safeMessage={error} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      {loading ? (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1].map((key) => (
            <div
              key={key}
              className="h-28 animate-pulse rounded-xl border border-line bg-surface"
            />
          ))}
          <span className="sr-only">Loading tool history…</span>
        </div>
      ) : history.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <Wrench className="mx-auto size-6 text-muted" aria-hidden="true" />
          <p className="mt-2 text-sm text-text">No tool runs yet.</p>
          <p className="mt-1 text-[13px] text-muted">
            Every tool an Agent proposes executes through the runtime executor — read-only tools run
            automatically, local changes show their preview first, and anything risky pauses for
            your approval. Each run lands here, redacted.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {history.map((entry) => (
            <HistoryRow key={entry.execution_id} entry={entry} agentNames={agentNames} />
          ))}
        </ul>
      )}
    </div>
  );
}

export { safeToolsMessage };
