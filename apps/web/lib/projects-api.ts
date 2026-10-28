import { z } from "zod";

import type { Actor } from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * S19 chunk 2 — the typed browser client for the projects HTTP surface
 * (chunk 1's /v1/projects routes), reached through the same-origin runtime
 * proxy (/api/runtime/* → the container's local API). Every failure arrives
 * as the S02 taxonomy through the shared typed-error parser, so surfaces show
 * safe_message only (G3).
 *
 * G3 SHAPES: the project read model's source_url is the SANITIZED label the
 * runtime persists (never credential-bearing); credentials surface as masked
 * hints only, and there is deliberately NO read-back route to parse. The
 * merge request read model is exactly the minimal PRD §10 view plus approval
 * state — change summary, changed files, validation status, conflict status,
 * target branch — the fields the merge review renders verbatim.
 */

export const ProjectView = z.strictObject({
  workspace_id: z.string(),
  project_id: z.string(),
  name: z.string(),
  source_kind: z.enum(["git_url", "directory", "archive"]),
  source_url: z.string(),
  repo_path: z.string(),
  default_branch: z.string(),
  access_mode: z.enum(["shared", "restricted"]),
  created_by: z.strictObject({ type: z.string(), id: z.string() }),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProjectView = z.infer<typeof ProjectView>;

export const WorktreeView = z.strictObject({
  workspace_id: z.string(),
  project_id: z.string(),
  worktree_id: z.string(),
  task_id: z.string(),
  agent_id: z.string().nullable(),
  branch_name: z.string(),
  worktree_path: z.string(),
  status: z.enum(["active", "queued", "admitted", "released", "merged"]),
  queue_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type WorktreeView = z.infer<typeof WorktreeView>;

export const CredentialView = z.strictObject({
  workspace_id: z.string(),
  project_id: z.string(),
  credential_id: z.string(),
  credential_kind: z.enum(["token", "password", "ssh_key"]),
  username: z.string().nullable(),
  /** Masked display value — the secret itself has no read-back surface (D22). */
  masked_hint: z.string(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});
export type CredentialView = z.infer<typeof CredentialView>;

export const MergeRequestView = z.strictObject({
  workspace_id: z.string(),
  project_id: z.string(),
  merge_request_id: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
  change_summary: z.string(),
  changed_files: z.array(z.string()),
  validation_status: z.enum(["not_run", "passed", "failed"]),
  validation_note: z.string().nullable(),
  conflict_status: z.enum(["unknown", "clean", "conflict"]),
  conflict_files: z.array(z.string()),
  approval_id: z.string().nullable(),
  status: z.enum([
    "awaiting_approval",
    "queued",
    "approved",
    "merged",
    "rejected",
    "changes_requested",
    "failed",
  ]),
  status_reason: z.string().nullable(),
  merged_commit: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MergeRequestView = z.infer<typeof MergeRequestView>;

export const ProjectDetail = z.strictObject({
  project: ProjectView,
  worktrees: z.array(WorktreeView),
  merge_requests: z.array(MergeRequestView),
  credentials: z.array(CredentialView),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

/** One PRD §10 merge-review decision, relayed into the S20 approval machinery. */
export type MergeDecisionChoice = "approve" | "reject" | "request_changes";

export const MergeDecisionResult = z.strictObject({
  decision: z.string(),
  merge_request: MergeRequestView,
});
export type MergeDecisionResult = z.infer<typeof MergeDecisionResult>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchProjects(workspaceId: string): Promise<ProjectView[]> {
  const payload = await requestRuntime(
    `/api/runtime/v1/projects?workspace_id=${encodeURIComponent(workspaceId)}`,
    z.strictObject({ projects: z.array(ProjectView) }).parse,
  );
  return payload.projects;
}

export async function fetchProjectDetail(
  workspaceId: string,
  projectId: string,
): Promise<ProjectDetail> {
  return requestRuntime(
    `/api/runtime/v1/projects/${encodeURIComponent(projectId)}?workspace_id=${encodeURIComponent(workspaceId)}`,
    ProjectDetail.parse,
  );
}

export async function fetchWorkspaceMergeRequests(
  workspaceId: string,
): Promise<Array<MergeRequestView & { project_id: string }>> {
  // The merge-review queue across the workspace's projects: one detail read
  // per project (the prototype's project count is tiny), merged client-side.
  const projects = await fetchProjects(workspaceId);
  const details = await Promise.all(
    projects.map((project) => fetchProjectDetail(workspaceId, project.project_id)),
  );
  return details.flatMap((detail) =>
    detail.merge_requests.map((mergeRequest) => ({
      ...mergeRequest,
      project_id: detail.project.project_id,
    })),
  );
}

// ---------------------------------------------------------------------------
// Git-aware run-card linkage (S19 chunk 2)
// ---------------------------------------------------------------------------

/**
 * What the runtime can prove about ONE task's git work, joined from the
 * project ledger on id equality (a task run id that holds a worktree or a
 * merge request). Absent for a run: the run has no git work — the card stays
 * quiet rather than inventing a branch.
 */
export interface GitRunLinkage {
  project_id: string;
  project_name: string;
  branch_name: string | null;
  worktree_status: WorktreeView["status"] | null;
  queue_reason: string | null;
  validation_status: MergeRequestView["validation_status"] | null;
  merge_request_id: string | null;
}

export async function fetchGitLinkage(workspaceId: string): Promise<Record<string, GitRunLinkage>> {
  const projects = await fetchProjects(workspaceId);
  const details = await Promise.all(
    projects.map((project) => fetchProjectDetail(workspaceId, project.project_id)),
  );
  const linkage: Record<string, GitRunLinkage> = {};
  for (const detail of details) {
    const base: GitRunLinkage = {
      project_id: detail.project.project_id,
      project_name: detail.project.name,
      branch_name: null,
      worktree_status: null,
      queue_reason: null,
      validation_status: null,
      merge_request_id: null,
    };
    for (const worktree of detail.worktrees) {
      linkage[worktree.task_id] = {
        ...(linkage[worktree.task_id] ?? base),
        branch_name: worktree.branch_name,
        worktree_status: worktree.status,
        queue_reason: worktree.queue_reason,
      };
    }
    for (const mergeRequest of detail.merge_requests) {
      linkage[mergeRequest.task_id] = {
        ...(linkage[mergeRequest.task_id] ?? base),
        validation_status: mergeRequest.validation_status,
        merge_request_id: mergeRequest.merge_request_id,
      };
    }
  }
  return linkage;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function runMergeRequestValidation(
  workspaceId: string,
  projectId: string,
  mergeRequestId: string,
): Promise<MergeRequestView> {
  return requestRuntime(
    `/api/runtime/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mergeRequestId)}/validation`,
    MergeRequestView.parse,
    { method: "POST", body: JSON.stringify({ workspace_id: workspaceId }) },
  );
}

export async function submitMergeDecision(
  workspaceId: string,
  projectId: string,
  mergeRequestId: string,
  choice: MergeDecisionChoice,
  decidedBy: Actor,
): Promise<MergeDecisionResult> {
  return requestRuntime(
    `/api/runtime/v1/projects/${encodeURIComponent(projectId)}/merge-requests/${encodeURIComponent(mergeRequestId)}/decision`,
    MergeDecisionResult.parse,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        choice,
        decided_by: decidedBy,
      }),
    },
  );
}
