import { Check, CircleAlert, Clock, FileText, Play, ShieldCheck, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ArtifactRef, RunState, TaskRun, TypedExecutionEvent } from "@shera-bot/contracts";

import { agentById, RUNS, toolInfoById } from "@/lib/fixtures";
import { useContainerResolution } from "@/lib/container-connection";
import { fetchToolHistory, type ToolHistoryEntry } from "@/lib/tools-api";
import { cn } from "@/lib/utils";

/**
 * Inline cards for the chat thread (UI_DESIGN §5, S3): tool-call cards,
 * artifact cards, run cards, and the §6.2 replayed-batch marker. Everything
 * renders from typed fixture records — proposals stay visibly pending (G2:
 * nothing renders an agent action as done, and a proposal is never shown as
 * executed), and artifact downloads stay disabled until the runtime serves
 * files.
 */

/** §5 risk-class badge colors — token classes only. */
function riskClassClass(riskClass: string): string {
  switch (riskClass) {
    case "READ_ONLY":
      return "text-muted";
    case "LOCAL_MUTATION":
      return "text-sky";
    case "EXTERNAL_WRITE":
      return "text-approval";
    case "DESTRUCTIVE_LOCAL":
      return "text-failed";
    default:
      return "text-muted";
  }
}

/**
 * §5 risk-class badge — token classes only. Exported so the S20 approval card
 * renders the exact same vocabulary (same shape, same colors, one affordance).
 */
export function RiskBadge({ riskClass }: { riskClass: string }) {
  return (
    <span
      className={cn(
        "rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]",
        riskClassClass(riskClass),
      )}
    >
      {riskClass}
    </span>
  );
}

/**
 * Card shell. `live="assertive"` marks tool/approval event cards as
 * assertive live regions (§2.3: "tool/approval events use aria-live=
 * 'assertive'") — static markup is not announced; insertions are.
 */
function CardShell({ children, live }: { children: ReactNode; live?: "assertive" | undefined }) {
  return (
    <div
      aria-live={live}
      aria-atomic={live ? true : undefined}
      className="w-full max-w-xl rounded-xl border border-line bg-surface p-3"
    >
      {children}
    </div>
  );
}

function CardHeader({
  icon,
  title,
  meta,
  badge,
}: {
  icon: ReactNode;
  title: string;
  meta?: string;
  badge?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{title}</span>
      {meta ? <span className="shrink-0 font-mono text-[11px] text-muted">v{meta}</span> : null}
      {badge}
    </div>
  );
}

/**
 * The executor-recorded status of one proposal, joined by (task, tool,
 * args_digest) — the digest IS the arguments identity both surfaces carry
 * (G3). Null when the runtime holds no history row (the fixtures, or a run
 * whose execution has not been recorded yet): the card then shows the
 * EVENT-only truth, never a guess (G2).
 */
function useRuntimeToolStatus(event: TypedExecutionEvent): ToolHistoryEntry | null | undefined {
  const resolution = useContainerResolution();
  const workspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;
  const taskId = "task_id" in event ? String(event.task_id) : null;
  const digest =
    event.event_type === "tool.proposed" || event.event_type === "approval.requested"
      ? String(event.payload.args_digest ?? "")
      : "";
  const enabled = workspaceId !== null && taskId !== null && digest !== "";
  const query = useQuery({
    queryKey: ["tool-history", workspaceId, taskId],
    queryFn: () => fetchToolHistory(workspaceId ?? "", { task_id: taskId ?? "" }),
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: () => (typeof document !== "undefined" && document.hidden ? false : 5_000),
    refetchIntervalInBackground: false,
  });
  if (!enabled || !query.data) {
    return query.data === undefined ? undefined : null;
  }
  return (
    query.data.find(
      (row) =>
        row.task_id === taskId &&
        row.tool_id === String((event.payload as { tool_id?: string }).tool_id ?? "") &&
        row.args_digest === digest,
    ) ?? null
  );
}

/** The live status line vocabulary (§5: proposed → validated → running → …). */
function statusPresentation(status: ToolHistoryEntry["status"]): {
  label: string;
  icon: ReactNode;
  className: string;
} {
  switch (status) {
    case "succeeded":
      return {
        label: "Succeeded",
        icon: <Check className="size-3.5" aria-hidden="true" />,
        className: "text-success",
      };
    case "failed":
      return {
        label: "Failed",
        icon: <X className="size-3.5" aria-hidden="true" />,
        className: "text-failed",
      };
    case "blocked":
      return {
        label: "Blocked by policy",
        icon: <CircleAlert className="size-3.5" aria-hidden="true" />,
        className: "text-failed",
      };
    case "awaiting_approval":
      return {
        label: "Pausing for your approval",
        icon: <ShieldCheck className="size-3.5" aria-hidden="true" />,
        className: "text-approval",
      };
    case "running":
      return {
        label: "Running",
        icon: <Clock className="size-3.5" aria-hidden="true" />,
        className: "text-sky",
      };
    default:
      return {
        label: "Proposed · awaiting runtime validation",
        icon: <CircleDashedIcon />,
        className: "text-muted",
      };
  }
}

function CircleDashedIcon(): ReactNode {
  return <Clock className="size-3.5" aria-hidden="true" />;
}

/**
 * Tool-call card. `proposed` = the runtime has not validated anything yet;
 * when the executor has recorded the execution, the card shows the RUNTIME's
 * status + the approval linkage (G2: never "done" before the runtime says
 * so — the status is the history row's, polled on the visible-tab cadence).
 * The five-choice approval dialog lands with the approvals surface — this
 * card never offers decisions.
 */
export function ToolCallCard({ event }: { event: TypedExecutionEvent }) {
  // Rules of hooks: the status lookup runs on EVERY render (it is a no-op
  // query for non-proposal events — disabled by its own guard below).
  const runtimeStatus = useRuntimeToolStatus(event);
  if (event.event_type === "tool.proposed") {
    const payload = event.payload;
    const info = toolInfoById(payload.tool_id);
    const live = runtimeStatus ?? null;
    return (
      <CardShell live="assertive">
        <CardHeader
          icon={<Wrench className="size-4 shrink-0 text-sky" aria-hidden="true" />}
          title={info?.name ?? payload.tool_id}
          meta={payload.tool_version}
          badge={<RiskBadge riskClass={info?.risk_class ?? live?.risk_class ?? "READ_ONLY"} />}
        />
        <p className="mt-2 text-sm text-muted">{payload.proposal_summary}</p>
        {live ? (
          <div className="mt-2 space-y-1.5">
            <p
              className={`flex items-center gap-1.5 font-mono text-[11px] ${statusPresentation(live.status).className}`}
            >
              {statusPresentation(live.status).icon}
              {statusPresentation(live.status).label}
            </p>
            {live.approval_id ? (
              <p className="font-mono text-[11px] text-approval">
                approval linked — decided from its own card
              </p>
            ) : null}
            {live.result_summary ? (
              <p className="text-[13px] text-muted">{live.result_summary}</p>
            ) : null}
            {live.error_code ? (
              <p className="font-mono text-[11px] text-failed">{live.error_code}</p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <span className="size-1.5 rounded-full bg-sky" aria-hidden="true" />
            Proposed · awaiting runtime validation
            <span className="sr-only">— nothing has run yet</span>
          </p>
        )}
      </CardShell>
    );
  }

  if (event.event_type === "approval.requested") {
    const payload = event.payload;
    const info = toolInfoById(payload.tool_id);
    return (
      <CardShell live="assertive">
        <CardHeader
          icon={<Wrench className="size-4 shrink-0 text-approval" aria-hidden="true" />}
          title={info?.name ?? payload.tool_id}
          meta={payload.tool_version}
          badge={<RiskBadge riskClass={payload.risk_class} />}
        />
        <p className="mt-2 text-sm text-muted">
          {payload.capability} · target {payload.resource_scope}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-approval">
          <span className="size-1.5 rounded-full bg-approval" aria-hidden="true" />
          Pausing for your approval
          <span className="font-sans text-[11px] text-muted">
            — demo data; real approvals decide from their own cards in the thread
          </span>
        </p>
      </CardShell>
    );
  }

  return null;
}

function artifactName(uri: string): string {
  const last = uri.split("/").at(-1);
  return last && last.length > 0 ? last : uri;
}

function artifactSize(sizeBytes: number): string {
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** Artifact card (§5): name, size, producer Agent, run provenance. */
export function ArtifactCard({ artifact }: { artifact: ArtifactRef }) {
  const producerRun = RUNS.find((run) => run.task_id === artifact.producer_task_id);
  const producerAgent = producerRun?.roster
    .map((agentId) => agentById(agentId))
    .find((agent) => agent !== undefined);
  return (
    <CardShell>
      <CardHeader
        icon={<FileText className="size-4 shrink-0 text-sky" aria-hidden="true" />}
        title={artifactName(artifact.uri)}
      />
      <p className="mt-2 font-mono text-[11px] text-muted">
        {artifact.media_type} · {artifactSize(artifact.size_bytes)}
        {producerAgent ? ` · produced by ${producerAgent.display_name}` : ""}
        {producerRun ? ` · from run ${producerRun.task_id.replace("task_run_", "")}` : ""}
      </p>
      <div className="mt-2 flex items-center gap-2">
        {/* aria-disabled (not disabled): stays keyboard-reachable and
            announced as dimmed, while the demo explains why it is inert
            (§2.3 reachability; G2: no fake file serving). */}
        <button
          type="button"
          aria-disabled="true"
          title="Demo data — file serving arrives with the runtime"
          className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted opacity-60"
        >
          Download
        </button>
        <span className="text-[11px] text-muted">In the demo workspace only</span>
      </div>
    </CardShell>
  );
}

/**
 * Run-card state chip. SUCCEEDED/FAILED are the fixture run's own D8 states
 * rendered as data (§9 requires a SUCCEEDED-with-artifacts demo); terminal
 * states deliberately get no celebratory styling, and the header meta marks
 * the whole surface as demo fixtures.
 */
function runStateClass(state: RunState): string {
  switch (state) {
    case "RUNNING":
    case "RETRYING":
      return "text-sky";
    case "WAITING_FOR_APPROVAL":
      return "text-approval";
    case "FAILED":
    case "PAUSED":
    case "RECOVERY_REQUIRED":
      return "text-failed";
    default:
      return "text-muted";
  }
}

function pauseReasonLabel(reason: string): string {
  return reason.replace(/_/g, " ");
}

export function RunCard({ run }: { run: TaskRun }) {
  const shortId = run.task_id.replace("task_run_", "");
  return (
    <CardShell>
      <div className="flex items-center gap-2">
        <Play className="size-4 shrink-0 text-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
          Task run {shortId}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[11px] uppercase tracking-[0.08em]",
            runStateClass(run.state),
          )}
        >
          {run.state}
        </span>
      </div>
      {run.pause_reason ? (
        <p className="mt-2 text-sm text-muted">Paused · {pauseReasonLabel(run.pause_reason)}</p>
      ) : null}
      {run.retry_count > 0 ? (
        // S22 (AC3): the count is the run's own journal-derived number — no
        // hardcoded total. The bound lives in the runtime's policy, not in
        // UI copy; a fixed " of N" here would outlive any policy change.
        <p className="mt-2 font-mono text-[11px] text-muted">retries used: {run.retry_count}</p>
      ) : null}
    </CardShell>
  );
}

/**
 * §6.2 replayed-batch boundary: the exact marker copy ("N missed events
 * replayed") rendered where live delivery resumes — replayed batches are
 * never silently interleaved as live.
 */
export function ReplayBoundary({ count }: { count: number }) {
  const label = `${count} missed events replayed`;
  return (
    <p
      role="note"
      aria-label={label}
      className="my-3 flex items-center gap-3"
      data-replay-marker={label}
    >
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
      <span className="rounded-full border border-line bg-surface px-3 py-0.5 font-mono text-[11px] tracking-[0.08em] text-muted">
        {label}
      </span>
      <span className="h-px flex-1 bg-line" aria-hidden="true" />
    </p>
  );
}
