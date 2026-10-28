"use client";

import { useState } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  FlaskConical,
  GitBranch,
  GitMerge,
} from "lucide-react";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { MergeRequestView, ProjectDetail } from "@/lib/projects-api";
import {
  safeProjectsMessage,
  useMergeDecision,
  useProjectDetail,
  useProjects,
  useRunMergeRequestValidation,
} from "@/lib/projects-data";
import { useContainerResolution, useSessionIdentity } from "@/lib/container-connection";
import { cn } from "@/lib/utils";

/**
 * Settings → Git (UI_DESIGN §S9 "Git & repositories" + the §8 resolution map's
 * merge-review surface; PRD §10, E6, D35, G2/G3/G5/G6). The surface renders
 * EXACTLY the recorded minimal fields per merge request — change summary,
 * changed files, validation status, conflict status, target branch — plus the
 * worktree ledger (the G5 queue is visible with its reason). The three PRD
 * §10 decisions relay into the S20 approval machinery through the runtime
 * API; decisions are immutable, so a decided request renders its recorded
 * state instead of the buttons. There is no force-push affordance anywhere,
 * and no secret material ever renders (credential rows answer masked hints
 * only — D22; this surface does not even list them).
 */

/** The validation chip's §2.1 status vocabulary — text, never color alone. */
function ValidationChip({ mergeRequest }: { mergeRequest: MergeRequestView }) {
  if (mergeRequest.validation_status === "passed") {
    return (
      <span
        data-testid="merge-validation"
        data-validation-status="passed"
        className="inline-flex items-center gap-1.5 text-xs text-live"
      >
        <CircleCheck className="size-3.5" aria-hidden="true" />
        Validation passed
      </span>
    );
  }
  if (mergeRequest.validation_status === "failed") {
    return (
      <span
        data-testid="merge-validation"
        data-validation-status="failed"
        className="inline-flex items-center gap-1.5 text-xs text-failed"
      >
        <CircleX className="size-3.5" aria-hidden="true" />
        Validation failed
      </span>
    );
  }
  return (
    <span
      data-testid="merge-validation"
      data-validation-status="not_run"
      className="inline-flex items-center gap-1.5 text-xs text-muted"
    >
      <CircleDashed className="size-3.5" aria-hidden="true" />
      Validation not run
    </span>
  );
}

function ConflictChip({ mergeRequest }: { mergeRequest: MergeRequestView }) {
  if (mergeRequest.conflict_status === "conflict") {
    return (
      <span
        data-testid="merge-conflict"
        data-conflict-status="conflict"
        className="inline-flex items-center gap-1.5 text-xs text-approval"
      >
        <CircleX className="size-3.5" aria-hidden="true" />
        Conflicts with {mergeRequest.target_branch}
      </span>
    );
  }
  return (
    <span
      data-testid="merge-conflict"
      data-conflict-status={mergeRequest.conflict_status}
      className="inline-flex items-center gap-1.5 text-xs text-muted"
    >
      <CircleCheck className="size-3.5" aria-hidden="true" />
      No conflicts with {mergeRequest.target_branch}
    </span>
  );
}

/** The mono field row: one label, one value — the review's density rhythm. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className="w-32 shrink-0 font-mono text-xs uppercase tracking-[0.16em] text-muted">
        {label}
      </dt>
      <dd className="min-w-0 text-sm text-text">{children}</dd>
    </div>
  );
}

/**
 * The post-decision copy (exported: the tests pin the exact honest wording —
 * decisions are immutable, the target branch untouched on reject/changes).
 */
export function mergeRequestStatusCopy(mergeRequest: MergeRequestView): string {
  switch (mergeRequest.status) {
    case "merged":
      return "Merged. The target branch carries this change set.";
    case "rejected":
      return "Rejected. The target branch is untouched.";
    case "changes_requested":
      return "Changes requested. The Agent revises before proposing again.";
    case "failed":
      return "The merge could not complete; the target branch was left untouched.";
    case "awaiting_approval":
      return "Waiting for your review. The merge runs only after your approval.";
    case "queued":
      return "Queued behind the task that holds the repository.";
    default:
      return "This merge request has been decided.";
  }
}

export interface MergeRequestCardProps {
  mergeRequest: MergeRequestView;
  projectName: string;
  /** True while the decision or validation mutation is in flight. */
  decisionPending: boolean;
  validationPending: boolean;
  /** False while the session identity is unresolved: decisions wait (G6). */
  sessionReady: boolean;
  decisionError: string | null;
  onDecide: (choice: "approve" | "reject" | "request_changes") => void;
  onRunValidation: () => void;
}

/**
 * The S8-pattern merge review card (presentational): exactly the minimal PRD
 * §10 fields, the three decisions while awaiting review, the recorded state
 * after. Decisions are immutable — the buttons never return.
 */
export function MergeRequestCard({
  mergeRequest,
  projectName,
  decisionPending,
  validationPending,
  sessionReady,
  decisionError,
  onDecide,
  onRunValidation,
}: MergeRequestCardProps) {
  const decided = mergeRequest.status !== "awaiting_approval" && mergeRequest.status !== "queued";
  const decisionsDisabled = decisionPending || !sessionReady;

  return (
    <article
      data-testid="merge-request-card"
      data-mr-status={mergeRequest.status}
      aria-label={`Merge request for ${projectName}: ${mergeRequest.change_summary}`}
      className="rounded-xl border border-line bg-surface-elevated p-4 shadow-[0_1px_2px_rgba(2,6,17,0.5),0_8px_24px_rgba(2,6,17,0.35)] sm:p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 font-display text-base font-semibold tracking-tight text-text">
          <GitMerge className="size-4 shrink-0 text-brand" aria-hidden="true" />
          <span className="truncate">{mergeRequest.change_summary}</span>
        </h3>
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          {mergeRequest.status.replace(/_/g, " ")}
        </span>
      </header>

      <dl className="mt-4 flex flex-col gap-3">
        <Field label="Branch">
          <span className="font-mono text-xs text-sky">{mergeRequest.source_branch}</span>
          <span className="text-muted"> → </span>
          <span className="font-mono text-xs text-text">{mergeRequest.target_branch}</span>
        </Field>
        <Field label="Changed files">
          {mergeRequest.changed_files.length === 0 ? (
            <span className="text-muted">No file changes recorded.</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {mergeRequest.changed_files.map((file) => (
                <li key={file} className="font-mono text-xs text-text">
                  {file}
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Checks">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <ValidationChip mergeRequest={mergeRequest} />
            <ConflictChip mergeRequest={mergeRequest} />
          </span>
        </Field>
      </dl>

      {mergeRequest.validation_note !== null ? (
        <p
          data-testid="merge-validation-note"
          className="mt-3 whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-muted"
        >
          {mergeRequest.validation_note}
        </p>
      ) : null}

      {mergeRequest.conflict_files.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 rounded-lg bg-surface px-3 py-2">
          {mergeRequest.conflict_files.map((file) => (
            <li key={file} className="font-mono text-xs text-approval">
              {file}
            </li>
          ))}
        </ul>
      ) : null}

      {decided ? (
        <p data-testid="merge-decided" className="mt-4 text-sm text-muted">
          {mergeRequestStatusCopy(mergeRequest)} Decisions are recorded and cannot be undone from
          here.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-xs text-muted">
            The coordinating Agent prepares the merge; the runtime merges only after your approval —
            never on its own, never with rewritten history.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="merge-approve"
              disabled={decisionsDisabled}
              onClick={() => onDecide("approve")}
            >
              Approve merge
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="merge-request-changes"
              disabled={decisionsDisabled}
              onClick={() => onDecide("request_changes")}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              data-testid="merge-reject"
              disabled={decisionsDisabled}
              onClick={() => onDecide("reject")}
            >
              Reject
            </Button>
            {mergeRequest.validation_status === "not_run" ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="merge-run-validation"
                disabled={validationPending}
                onClick={onRunValidation}
              >
                <FlaskConical className="size-3.5" aria-hidden="true" />
                {validationPending ? "Validating…" : "Run validation"}
              </Button>
            ) : null}
          </div>
          {decisionError !== null ? (
            <p role="alert" className="text-xs text-failed">
              {decisionError}
            </p>
          ) : null}
        </div>
      )}
    </article>
  );
}

/** The hookful container: wires the session identity, the decision, and the validation run. */
function MergeRequestContainer({
  mergeRequest,
  projectName,
  projectId,
  workspaceId,
}: {
  mergeRequest: MergeRequestView;
  projectName: string;
  projectId: string;
  workspaceId: string;
}) {
  const session = useSessionIdentity();
  const decision = useMergeDecision(workspaceId, projectId);
  const validation = useRunMergeRequestValidation(workspaceId, projectId);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  return (
    <MergeRequestCard
      mergeRequest={mergeRequest}
      projectName={projectName}
      decisionPending={decision.isPending}
      validationPending={validation.isPending}
      sessionReady={session.data !== undefined}
      decisionError={decisionError}
      onDecide={(choice) => {
        setDecisionError(null);
        decision.mutate(
          {
            mergeRequestId: mergeRequest.merge_request_id,
            choice,
            decidedBy: { type: "user", id: session.data?.google_sub ?? "" },
          },
          {
            onError: (error) =>
              setDecisionError(safeProjectsMessage(error, "The decision could not be recorded.")),
          },
        );
      }}
      onRunValidation={() => validation.mutate(mergeRequest.merge_request_id)}
    />
  );
}

/** The worktree ledger: one active slot per project, the queue visible with its reason (G5). */
function WorktreeLedger({ detail }: { detail: ProjectDetail }) {
  const ledger = detail.worktrees.filter(
    (worktree) => worktree.status === "active" || worktree.status === "queued",
  );
  if (ledger.length === 0) {
    return (
      <p className="text-sm text-muted" data-testid="worktree-empty">
        No task is working in this repository right now.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2" data-testid="worktree-ledger">
      {ledger.map((worktree) => (
        <li
          key={worktree.worktree_id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2"
        >
          <GitBranch className="size-3.5 self-center text-muted" aria-hidden="true" />
          <span className="font-mono text-xs text-text">{worktree.branch_name}</span>
          <span
            className={cn(
              "font-mono text-xs uppercase tracking-[0.16em]",
              worktree.status === "active" ? "text-live" : "text-approval",
            )}
          >
            {worktree.status}
          </span>
          {worktree.queue_reason !== null ? (
            <span className="min-w-0 basis-full text-xs text-muted">{worktree.queue_reason}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ProjectSection({ detail, workspaceId }: { detail: ProjectDetail; workspaceId: string }) {
  const pending = detail.merge_requests.filter(
    (mergeRequest) => mergeRequest.status === "awaiting_approval",
  );
  const decided = detail.merge_requests.filter(
    (mergeRequest) => mergeRequest.status !== "awaiting_approval",
  );
  return (
    <section
      aria-label={`Repository ${detail.project.name}`}
      className="flex flex-col gap-4"
      data-testid="git-project"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold tracking-tight text-text">
          {detail.project.name}
        </h2>
        <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          default {detail.project.default_branch} · {detail.project.source_kind}
        </span>
      </header>
      <WorktreeLedger detail={detail} />
      {pending.length === 0 ? (
        <p className="text-sm text-muted" data-testid="merge-queue-empty">
          No merge is waiting for your review. When an Agent proposes one, it pauses here.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {pending.map((mergeRequest) => (
            <MergeRequestContainer
              key={mergeRequest.merge_request_id}
              mergeRequest={mergeRequest}
              projectName={detail.project.name}
              projectId={detail.project.project_id}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      )}
      {decided.length > 0 ? (
        <details className="rounded-xl border border-line bg-surface px-4 py-3">
          <summary className="cursor-pointer text-sm text-muted">
            {decided.length === 1
              ? "1 decided merge request"
              : `${decided.length} decided merge requests`}
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            {decided.map((mergeRequest) => (
              <MergeRequestContainer
                key={mergeRequest.merge_request_id}
                mergeRequest={mergeRequest}
                projectName={detail.project.name}
                projectId={detail.project.project_id}
                workspaceId={workspaceId}
              />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

function ProjectsSkeleton() {
  return (
    <div aria-busy="true" data-testid="git-settings-skeleton" className="flex flex-col gap-4">
      <div className="h-6 w-40 animate-pulse rounded bg-surface-elevated" />
      <div className="h-24 animate-pulse rounded-xl bg-surface-elevated" />
      <div className="h-40 animate-pulse rounded-xl bg-surface-elevated" />
    </div>
  );
}

/** The Settings → Git surface body (the frame and route live in the settings page). */
export function GitSettingsReadout({ workspaceId }: { workspaceId: string }) {
  const projects = useProjects(workspaceId);

  if (projects.loading) {
    return <ProjectsSkeleton />;
  }
  if (projects.failed) {
    return (
      <ErrorState
        safeMessage={projects.safeErrorMessage ?? "The projects list could not be loaded."}
        onRetry={projects.refetch}
      />
    );
  }
  if (projects.projects.length === 0) {
    return (
      <div data-testid="git-settings-empty" className="flex flex-col gap-3">
        <p className="text-sm text-text">No repositories are connected to your workspace yet.</p>
        <p className="text-sm text-muted">
          When an Operation works on a repository, it appears here with its task branches, its
          worktree queue, and every merge request that waits for your review.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10">
      {projects.projects.map((project) => (
        <ProjectDetailSection
          key={project.project_id}
          workspaceId={workspaceId}
          projectId={project.project_id}
        />
      ))}
    </div>
  );
}

function ProjectDetailSection({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const detail = useProjectDetail(workspaceId, projectId);
  if (detail.loading) {
    return <ProjectsSkeleton />;
  }
  if (detail.failed || detail.detail === null) {
    return (
      <ErrorState
        safeMessage={detail.safeErrorMessage ?? "The project could not be loaded."}
        onRetry={detail.refetch}
      />
    );
  }
  return <ProjectSection detail={detail.detail} workspaceId={workspaceId} />;
}

/**
 * The route-level surface: the workspace comes from the container resolution,
 * and an unavailable container is an honest state (these are real reads).
 */
export function GitSettingsSurface() {
  const resolution = useContainerResolution();
  if (resolution.data?.kind !== "ready") {
    return (
      <div
        role="status"
        className="mx-auto my-8 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center"
      >
        <p className="text-sm text-text">
          The Git surface reads your workspace&apos;s real repositories, so the workspace container
          must be running. Start your workspace and come back.
        </p>
      </div>
    );
  }
  return <GitSettingsReadout workspaceId={resolution.data.workspace_id} />;
}
