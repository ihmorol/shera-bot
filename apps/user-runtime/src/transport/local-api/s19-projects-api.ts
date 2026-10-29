/**
 * S19 chunk 1 — the projects HTTP API (issue #20; PRD §10, E6, D6, D22, D35,
 * D9, E12, G2/G3/G5/G6).
 *
 * The typed local surface for project import/clone, per-repository
 * credentials, task-scoped worktrees (with the conflict queue), and merge
 * requests. The routes VALIDATE and DELEGATE (G2) — every rule lives in the
 * git service and its repositories; nothing here re-derives git or approval
 * policy.
 *
 * MERGE DECISIONS RELAY INTO THE S20 APPROVAL MACHINERY — there is no
 * parallel approval path. The three PRD §10 choices map onto the D9 decision
 * vocabulary exactly:
 *   - approve            → approve-this-execution-only (the S20 service's
 *                          grant + resume; the composition's executor then
 *                          runs the approved merge);
 *   - reject             → reject-this-action (the action is denied; the run
 *                          continues; the target branch untouched);
 *   - request_changes    → reject-this-action on the D9 record (this merge
 *                          AS PROPOSED is not approved), with the merge
 *                          request row recording the PRD §10
 *                          `changes_requested` state so the coordinating
 *                          Agent revises. The row is the PRD view; the
 *                          approval record keeps its own contract vocabulary.
 * An AGENT actor is refused by the S20 service itself (never self-approve —
 * G6); this surface relays the refusal untouched.
 *
 * CREDENTIAL SURFACES NEVER CARRY SECRET MATERIAL (G3/D22): create/list/revoke
 * answer metadata only — credential id, kind, username, masked hint, and
 * lifecycle stamps. There is deliberately NO read-back route: decryption is
 * the git service's call-time seam only.
 *
 * ACTOR ATTRIBUTION follows the loopback convention (s17): reads carry the
 * actor in the query when needed; mutations carry it in the body. The S05/S06
 * authenticated transport binds the workspace; nothing here invents auth.
 */
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import { z } from "zod";

import { Actor, Id, WorkspaceId } from "@shera-bot/contracts";

import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type {
  CredentialView,
  GitService,
  MergeRequestView,
  ProjectView,
  WorktreeAllocation,
  WorktreeView,
} from "../../modules/git/git.service.ts";
import { GitServiceError } from "../../modules/git/git.service.ts";
import type { ValidationRunner } from "../../modules/git/validation-runner.ts";
import { rebuildRunProjection, type ApprovalsApiHandle } from "./s20-approvals-api.ts";

// ---------------------------------------------------------------------------
// Route paths (the contracts convention: literal constants, one definition)
// ---------------------------------------------------------------------------

export const CREATE_PROJECT_PATH = "/v1/projects" as const;
export const LIST_PROJECTS_PATH = "/v1/projects" as const;
export const GET_PROJECT_PATH = "/v1/projects/:project_id" as const;
export const LIST_PROJECT_WORKTREES_PATH = "/v1/projects/:project_id/worktrees" as const;
export const ALLOCATE_PROJECT_WORKTREE_PATH = "/v1/projects/:project_id/worktrees" as const;
export const RELEASE_PROJECT_WORKTREE_PATH =
  "/v1/projects/:project_id/worktrees/:worktree_id/release" as const;
export const LIST_PROJECT_CREDENTIALS_PATH = "/v1/projects/:project_id/credentials" as const;
export const CREATE_PROJECT_CREDENTIAL_PATH = "/v1/projects/:project_id/credentials" as const;
export const REVOKE_PROJECT_CREDENTIAL_PATH =
  "/v1/projects/:project_id/credentials/:credential_id/revoke" as const;
export const LIST_PROJECT_MERGE_REQUESTS_PATH = "/v1/projects/:project_id/merge-requests" as const;
export const CREATE_PROJECT_MERGE_REQUEST_PATH = "/v1/projects/:project_id/merge-requests" as const;
export const GET_PROJECT_MERGE_REQUEST_PATH =
  "/v1/projects/:project_id/merge-requests/:merge_request_id" as const;
export const MERGE_REQUEST_DECISION_PATH =
  "/v1/projects/:project_id/merge-requests/:merge_request_id/decision" as const;
export const RUN_MERGE_REQUEST_VALIDATION_PATH =
  "/v1/projects/:project_id/merge-requests/:merge_request_id/validation" as const;

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

/** The loopback actor attribution (the s17 convention; never implicit). */
const RequestActor = Actor;

const ProjectSource = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("git_url"),
    url: z.string().min(1).max(2048),
    /**
     * The D22 import credential: provided ONCE, used for THIS clone, and
     * sealed into the project's credential custody on success. It is never
     * echoed back — the response carries metadata only (G3).
     */
    credential: z
      .strictObject({
        username: z.string().min(1).max(256).nullish(),
        secret: z.string().min(1).max(4096),
      })
      .optional(),
  }),
  z.strictObject({ kind: z.literal("directory"), path: z.string().min(1).max(2048) }),
  z.strictObject({ kind: z.literal("archive"), path: z.string().min(1).max(2048) }),
]);

const CreateProjectBody = z.strictObject({
  workspace_id: WorkspaceId,
  name: z.string().min(1).max(255),
  actor: RequestActor,
  source: ProjectSource,
});

const AllocateWorktreeBody = z.strictObject({
  workspace_id: WorkspaceId,
  task_id: Id,
  agent_id: Id,
});

const ReleaseWorktreeBody = z.strictObject({ workspace_id: WorkspaceId });

const CreateCredentialBody = z.strictObject({
  workspace_id: WorkspaceId,
  actor: RequestActor,
  credential_kind: z.enum(["token", "password", "ssh_key"]),
  username: z.string().min(1).max(256).nullish(),
  /** The secret rides the body ONCE; it is encrypted and never echoed (G3). */
  secret: z.string().min(1).max(4096),
});

const PrepareMergeRequestBody = z.strictObject({
  workspace_id: WorkspaceId,
  task_id: Id,
  agent_id: Id,
  conversation_id: Id,
  change_summary: z.string().min(1).max(2000),
});

const MergeDecisionBody = z.strictObject({
  workspace_id: WorkspaceId,
  choice: z.enum(["approve", "reject", "request_changes"]),
  decided_by: Actor,
});

// ---------------------------------------------------------------------------
// The composed handle
// ---------------------------------------------------------------------------

/**
 * The projects API facade: built over the git service, the S20 approvals
 * handle (the decision relay), and the journal (the run projection rebuild).
 * The routes never touch SQL and never re-derive policy.
 */
export interface ProjectsApiHandle {
  importProject(input: Parameters<GitService["importProject"]>[0]): Promise<ProjectView>;
  listProjects(workspaceId: string): ProjectView[];
  getProjectDetail(
    workspaceId: string,
    projectId: string,
  ): {
    project: ProjectView;
    worktrees: WorktreeView[];
    merge_requests: MergeRequestView[];
    credentials: CredentialView[];
  };
  listWorktrees(workspaceId: string, projectId: string): WorktreeView[];
  allocateWorktree(input: {
    workspace_id: string;
    project_id: string;
    task_id: string;
    agent_id: string;
  }): Promise<WorktreeAllocation>;
  releaseWorktree(input: {
    workspace_id: string;
    project_id: string;
    worktree_id: string;
    outcome: "released" | "merged";
  }): Promise<WorktreeView>;
  storeCredential(input: {
    workspace_id: string;
    project_id: string;
    actor: { type: string; id: string };
    credential_kind: "token" | "password" | "ssh_key";
    username?: string | null;
    secret: string;
  }): Promise<CredentialView>;
  listCredentials(workspaceId: string, projectId: string): CredentialView[];
  revokeCredential(workspaceId: string, projectId: string, credentialId: string): Promise<void>;
  prepareMergeRequest(input: {
    workspace_id: string;
    project_id: string;
    task_id: string;
    agent_id: string;
    conversation_id: string;
    change_summary: string;
  }): Promise<{ merge_request: MergeRequestView; approval_id: string }>;
  listMergeRequests(workspaceId: string, projectId: string): MergeRequestView[];
  getMergeRequest(workspaceId: string, projectId: string, mergeRequestId: string): MergeRequestView;
  /**
   * The runtime's validation run (G2): executes the project's declared
   * validation inside the task worktree and attaches the result to the
   * merge request row. The answer is the post-run view.
   */
  runValidation(
    workspaceId: string,
    projectId: string,
    mergeRequestId: string,
  ): Promise<MergeRequestView>;
  /**
   * The PRD §10 decision, relayed through the S20 approval machinery. The
   * approve path awaits the executor-started merge so the answer carries the
   * honest post-merge row.
   */
  decideMergeRequest(input: {
    workspace_id: string;
    project_id: string;
    merge_request_id: string;
    choice: "approve" | "reject" | "request_changes";
    decided_by: Actor;
  }): Promise<{ decision: string; merge_request: MergeRequestView }>;
}

export function buildProjectsApiHandle(deps: {
  git: GitService;
  /** The S20 decision surface (the ONLY approval path — G6). */
  approvals: Pick<ApprovalsApiHandle, "decide">;
  journal: Pick<EventJournalRepository, "readFrom">;
  /** The runtime's validation runner (G2: the runtime validates). */
  validation: Pick<ValidationRunner, "runForMergeRequest">;
  now: () => string;
}): ProjectsApiHandle {
  const { git } = deps;
  return {
    importProject: (input) => git.importProject(input),
    listProjects: (workspaceId) => git.listProjects(workspaceId),

    getProjectDetail(workspaceId, projectId) {
      const project = git.getProject(workspaceId, projectId);
      return {
        project,
        worktrees: git.listWorktrees(workspaceId, projectId),
        merge_requests: git.listMergeRequests(workspaceId, projectId),
        credentials: git.listCredentials(workspaceId, projectId),
      };
    },

    listWorktrees: (workspaceId, projectId) => git.listWorktrees(workspaceId, projectId),
    allocateWorktree: (input) => git.allocateWorktree(input),
    releaseWorktree: (input) => git.releaseWorktree(input),

    storeCredential: (input) => git.storeCredential(input),
    listCredentials: (workspaceId, projectId) => git.listCredentials(workspaceId, projectId),
    revokeCredential: (workspaceId, projectId, credentialId) =>
      git.revokeCredential(workspaceId, projectId, credentialId),

    async prepareMergeRequest(input) {
      // The run projection is rebuilt from the JOURNAL (the durable record) —
      // the same authority the decision path uses; a run the journal cannot
      // rebuild refuses here before anything is written (G4).
      const run = rebuildRunProjection(deps.journal, input.workspace_id, input.task_id);
      const prepared = await git.prepareMergeRequest({ ...input, run });
      return {
        merge_request: prepared.merge_request,
        approval_id: prepared.approval_id,
      };
    },

    listMergeRequests: (workspaceId, projectId) => git.listMergeRequests(workspaceId, projectId),
    getMergeRequest: (workspaceId, projectId, mergeRequestId) =>
      git.getMergeRequest(workspaceId, projectId, mergeRequestId),

    runValidation: (workspaceId, projectId, mergeRequestId) =>
      deps.validation.runForMergeRequest(workspaceId, projectId, mergeRequestId),

    async decideMergeRequest(input) {
      const mergeRequest = git.getMergeRequest(
        input.workspace_id,
        input.project_id,
        input.merge_request_id,
      );
      if (mergeRequest.approval_id === null) {
        throw new GitServiceError(
          "GIT_MERGE_REQUEST_INVALID",
          "state",
          "the merge request has no linked approval to decide",
        );
      }
      // The three PRD §10 choices relay onto the D9 decision vocabulary (the
      // module doc records the mapping; the S20 service owns every rule).
      const approvalChoice =
        input.choice === "approve" ? "approve-this-execution-only" : "reject-this-action";
      const result = deps.approvals.decide({
        workspaceId: input.workspace_id,
        approvalId: mergeRequest.approval_id,
        choice: approvalChoice,
        decidedBy: input.decided_by,
      });
      const outcome = result.outcome;

      if (outcome === "transition_rejected") {
        // The D8 machinery refused the decision's transition — surfaced as
        // the typed 409 by the route (the caller reloads and retries).
        throw new GitServiceError(
          "GIT_MERGE_REQUEST_INVALID",
          "state",
          "the approval's task run cannot transition; reload the run and retry",
        );
      }

      if (outcome === "approved") {
        // The composition's executor started the merge synchronously inside
        // the decision; await its recorded outcome so the answer is the
        // post-merge row (a failed merge is recorded on the row — G5).
        const pending = git.takeMergeOutcome(mergeRequest.merge_request_id);
        if (pending !== null) {
          await pending.catch(() => {});
        }
        return {
          decision: "approved",
          merge_request: git.getMergeRequest(
            input.workspace_id,
            input.project_id,
            input.merge_request_id,
          ),
        };
      }

      if (outcome === "action_rejected") {
        const decision = input.choice === "reject" ? "rejected" : "changes_requested";
        return {
          decision,
          merge_request: git.recordMergeDecision(
            input.workspace_id,
            input.project_id,
            input.merge_request_id,
            decision,
          ),
        };
      }

      // already_decided: the honest replay — the row's current state answers.
      return {
        decision: input.choice,
        merge_request: git.getMergeRequest(
          input.workspace_id,
          input.project_id,
          input.merge_request_id,
        ),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

function validationFailure(safeMessage: string) {
  return {
    code: "CONTRACT_VALIDATION_FAILED",
    category: "validation" as const,
    safe_message: safeMessage,
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: randomUUID(),
  };
}

export function registerProjectsRoutes(app: Express, deps: ProjectsApiHandle): void {
  // POST /v1/projects — import or clone one repository. A FAILED import
  // answers the typed failure and registers NOTHING (the atomicity AC).
  app.post(CREATE_PROJECT_PATH, async (req, res) => {
    const body = CreateProjectBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The project request is not valid: a workspace_id, a name, an actor, and a source are required.",
          ),
        );
      return;
    }
    // The zod credential shape (optional username) normalizes onto the
    // service input's exact shape (username: string | null) before the call.
    const source = body.data.source;
    const normalizedSource =
      source.kind === "git_url"
        ? {
            kind: "git_url" as const,
            url: source.url,
            ...(source.credential !== undefined
              ? {
                  credential: {
                    username: source.credential.username ?? null,
                    secret: source.credential.secret,
                  },
                }
              : {}),
          }
        : source;
    const project = await deps.importProject({
      workspace_id: body.data.workspace_id,
      name: body.data.name,
      actor: body.data.actor,
      source: normalizedSource,
    });
    res.status(201).json(project);
  });

  // GET /v1/projects — the workspace's projects (E12).
  app.get(LIST_PROJECTS_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json(
          validationFailure("The project list request is not valid: a workspace_id is required."),
        );
      return;
    }
    res.status(200).json({ projects: deps.listProjects(query.data.workspace_id) });
  });

  // GET /v1/projects/:id — the detail: project + worktrees + merge requests +
  // credential metadata. Unknown id in the workspace: typed 404.
  app.get(GET_PROJECT_PATH, (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const query = WorkspaceQuery.safeParse(req.query);
    if (!projectId.success || !query.success) {
      res
        .status(400)
        .json(validationFailure("The project request is not valid: a workspace_id is required."));
      return;
    }
    res.status(200).json(deps.getProjectDetail(query.data.workspace_id, projectId.data));
  });

  // GET /v1/projects/:id/worktrees — the allocation ledger including the
  // queue entries with their reasons (G5: the wait is visible).
  app.get(LIST_PROJECT_WORKTREES_PATH, (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const query = WorkspaceQuery.safeParse(req.query);
    if (!projectId.success || !query.success) {
      res
        .status(400)
        .json(
          validationFailure("The worktree list request is not valid: a workspace_id is required."),
        );
      return;
    }
    res
      .status(200)
      .json({ worktrees: deps.listWorktrees(query.data.workspace_id, projectId.data) });
  });

  // POST /v1/projects/:id/worktrees — allocate this task's branch + worktree.
  // 201 allocated; 200 queued (the RECORDED refusal with its reason — G5);
  // 200 reacquired (idempotent re-request).
  app.post(ALLOCATE_PROJECT_WORKTREE_PATH, async (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const body = AllocateWorktreeBody.safeParse(req.body);
    if (!projectId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The worktree request is not valid: a workspace_id, a task_id, and an agent_id are required.",
          ),
        );
      return;
    }
    const allocation = await deps.allocateWorktree({
      workspace_id: body.data.workspace_id,
      project_id: projectId.data,
      task_id: body.data.task_id,
      agent_id: body.data.agent_id,
    });
    if (allocation.outcome === "allocated") {
      res.status(201).json(allocation);
      return;
    }
    res.status(200).json(allocation);
  });

  // POST .../worktrees/:worktree_id/release — release the slot (the
  // runtime calls this when a task finishes without merging).
  app.post(RELEASE_PROJECT_WORKTREE_PATH, async (req, res) => {
    const worktreeId = Id.safeParse(req.params.worktree_id);
    const body = ReleaseWorktreeBody.safeParse(req.body);
    if (!worktreeId.success || !body.success) {
      res
        .status(400)
        .json(validationFailure("The release request is not valid: a workspace_id is required."));
      return;
    }
    const worktree = await deps.releaseWorktree({
      workspace_id: body.data.workspace_id,
      project_id: req.params.project_id,
      worktree_id: worktreeId.data,
      outcome: "released",
    });
    res.status(200).json({ worktree });
  });

  // POST /v1/projects/:id/credentials — store one per-repository secret.
  // The answer is metadata only: the value is encrypted and never echoed (D22/G3).
  app.post(CREATE_PROJECT_CREDENTIAL_PATH, async (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const body = CreateCredentialBody.safeParse(req.body);
    if (!projectId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The credential request is not valid: a workspace_id, an actor, a kind, and a secret are required.",
          ),
        );
      return;
    }
    const credential = await deps.storeCredential({
      workspace_id: body.data.workspace_id,
      project_id: projectId.data,
      actor: body.data.actor,
      credential_kind: body.data.credential_kind,
      username: body.data.username ?? null,
      secret: body.data.secret,
    });
    res.status(201).json(credential);
  });

  // GET /v1/projects/:id/credentials — metadata only; no read-back exists (D22).
  app.get(LIST_PROJECT_CREDENTIALS_PATH, (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const query = WorkspaceQuery.safeParse(req.query);
    if (!projectId.success || !query.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The credential list request is not valid: a workspace_id is required.",
          ),
        );
      return;
    }
    res
      .status(200)
      .json({ credentials: deps.listCredentials(query.data.workspace_id, projectId.data) });
  });

  // POST .../credentials/:credential_id/revoke — the D22 revocation; the next
  // call-time resolution fails safely.
  app.post(REVOKE_PROJECT_CREDENTIAL_PATH, async (req, res) => {
    const credentialId = Id.safeParse(req.params.credential_id);
    const body = ReleaseWorktreeBody.safeParse(req.body);
    if (!credentialId.success || !body.success) {
      res
        .status(400)
        .json(validationFailure("The revoke request is not valid: a workspace_id is required."));
      return;
    }
    await deps.revokeCredential(body.data.workspace_id, req.params.project_id, credentialId.data);
    res.status(200).json({ revoked: true, credential_id: credentialId.data });
  });

  // GET /v1/projects/:id/merge-requests — the merge-review queue.
  app.get(LIST_PROJECT_MERGE_REQUESTS_PATH, (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const query = WorkspaceQuery.safeParse(req.query);
    if (!projectId.success || !query.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The merge request list request is not valid: a workspace_id is required.",
          ),
        );
      return;
    }
    res
      .status(200)
      .json({ merge_requests: deps.listMergeRequests(query.data.workspace_id, projectId.data) });
  });

  // POST /v1/projects/:id/merge-requests — the coordinating Agent prepares
  // one merge request; the runtime computes the PRD §10 fields from the real
  // repository and files the D9 approval (the run pauses — G2/G6).
  app.post(CREATE_PROJECT_MERGE_REQUEST_PATH, async (req, res) => {
    const projectId = Id.safeParse(req.params.project_id);
    const body = PrepareMergeRequestBody.safeParse(req.body);
    if (!projectId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The merge request is not valid: a workspace_id, a task_id, an agent_id, a conversation_id, and a change summary are required.",
          ),
        );
      return;
    }
    const prepared = await deps.prepareMergeRequest({
      workspace_id: body.data.workspace_id,
      project_id: projectId.data,
      task_id: body.data.task_id,
      agent_id: body.data.agent_id,
      conversation_id: body.data.conversation_id,
      change_summary: body.data.change_summary,
    });
    res.status(201).json(prepared.merge_request);
  });

  // GET .../merge-requests/:id — the minimal PRD §10 view plus approval state.
  app.get(GET_PROJECT_MERGE_REQUEST_PATH, (req, res) => {
    const mergeRequestId = Id.safeParse(req.params.merge_request_id);
    const query = WorkspaceQuery.safeParse(req.query);
    if (!mergeRequestId.success || !query.success) {
      res
        .status(400)
        .json(
          validationFailure("The merge request read is not valid: a workspace_id is required."),
        );
      return;
    }
    res
      .status(200)
      .json(
        deps.getMergeRequest(query.data.workspace_id, req.params.project_id, mergeRequestId.data),
      );
  });

  // POST .../merge-requests/:id/validation — the runtime runs the project's
  // declared validation inside the task worktree and attaches the result to
  // the merge request (G2: agents propose; the runtime validates). The
  // recorded result never blocks on its own: the merge stays approval-gated.
  app.post(RUN_MERGE_REQUEST_VALIDATION_PATH, async (req, res) => {
    const mergeRequestId = Id.safeParse(req.params.merge_request_id);
    const body = ReleaseWorktreeBody.safeParse(req.body);
    if (!mergeRequestId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure("The validation request is not valid: a workspace_id is required."),
        );
      return;
    }
    const mergeRequest = await deps.runValidation(
      body.data.workspace_id,
      req.params.project_id,
      mergeRequestId.data,
    );
    res.status(200).json(mergeRequest);
  });

  // POST .../merge-requests/:id/decision — the three PRD §10 choices through
  // the S20 approval machinery. Agent actors are refused by the service
  // (403 — agents never decide, never self-approve: G6).
  app.post(MERGE_REQUEST_DECISION_PATH, async (req, res) => {
    const mergeRequestId = Id.safeParse(req.params.merge_request_id);
    const body = MergeDecisionBody.safeParse(req.body);
    if (!mergeRequestId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The merge decision is not valid: a workspace_id, one of approve/reject/request_changes, and a user decided_by are required.",
          ),
        );
      return;
    }
    const result = await deps.decideMergeRequest({
      workspace_id: body.data.workspace_id,
      project_id: req.params.project_id,
      merge_request_id: mergeRequestId.data,
      choice: body.data.choice,
      decided_by: body.data.decided_by,
    });
    res.status(200).json(result);
  });
}
