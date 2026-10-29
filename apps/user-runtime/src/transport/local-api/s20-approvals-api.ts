/**
 * S20 chunk 4 — the approvals HTTP API + the scripted lifecycle trigger (D9,
 * PRD §8, E3, E12, G2/G3/G6).
 *
 * ---------------------------------------------------------------------------
 * The HTTP surface
 *
 * Every route is workspace-scoped (E12): the workspace_id is required on every
 * read (query) and every mutation (body), and every underlying repository
 * call is workspace-keyed — another workspace's approval, grant, or mute is
 * invisible and its mutation is the typed 404, never a silent cross-workspace
 * write. Reads answer exactly the D9 card vocabulary (the decision record's
 * "the UI shows the exact tool, arguments summary, target resource, side
 * effect, and expiry"); the arguments surface is the sha256 args_digest only,
 * never raw arguments (G3).
 *
 * POST decision relays the five contract choices into
 * ApprovalsService.applyDecision — the ONLY path that turns a choice into
 * effects (grants are created nowhere else, G6). The route maps the typed
 * outcomes to HTTP:
 *   - approved / action_rejected / task_cancelled → 200 with the outcome, the
 *     stored request, the resulting run state (the resume visible in the run
 *     read model), and the grant / cancelled children where the outcome
 *     carries them;
 *   - already_decided → 200 with the STORED resolution (an honest retry —
 *     nothing re-applied);
 *   - transition_rejected → 409 with the typed D8 rejection (the run moved
 *     on; the caller reloads and retries);
 *   - thrown refusals (unknown choice/request, agent actor, already resolved
 *     with a different choice) map through the shared error middleware's
 *     typed taxonomy.
 *
 * The decision's run projection is rebuilt from the JOURNAL — the durable
 * record (conversations already rebuild from it; task runs have no durable
 * table and full journal-driven rebuild is S31's recovery concern). The
 * rebuild folds exactly what the approval path consults: the D8 state and the
 * optimistic version (1 + the journalled transitions). retry_count is not
 * journal-rebuildable in this vocabulary and is not consulted by any
 * approval-path transition; it is carried as 0 with that stated scope.
 *
 * The reminder tick (E3): the gateway has NO general periodic path in this
 * slice (the only intervals are the G4-conditional session/worker supervisor
 * ticks — absent without a harness command), so the scan is exposed as POST
 * due-reminders per workspace for the UI/scheduler layer (S20 review fix F3:
 * a POST, not a GET — the scan stamps delivered_at, a state mutation, so it
 * rides the command verb with the workspace in the body; the browser proxy's
 * Origin check covers it like every mutation). The scheduler deferral is
 * recorded for the review round. The scan is the chunk-3
 * dueReminders logic verbatim: delivery stamps delivered_at and NEVER
 * changes run state (D32).
 *
 * ---------------------------------------------------------------------------
 * The scripted lifecycle trigger (the G4 scripted-harness seam)
 *
 * The trigger rides the seam the scripted/fake harness's typed events already
 * flow through: the HarnessRunService proposal path. A scripted TYPED
 * `tool.proposed` journal event is journalled through the unchanged D26 path
 * and then, inside the SAME atomic unit, handed to
 * `applyScriptedToolProposal` — which resolves the runtime-owned typed tool
 * definition (D38: the runtime owns tool definitions; the pack allow-list
 * only references them) and calls createRequestFromTypedProposal with the
 * execute callback withheld (the no-op scripted execution of this slice). A
 * gated risk class pauses the run (RUNNING → WAITING_FOR_APPROVAL) and files
 * the pending approval; READ_ONLY runs automatically (G6). There is no new
 * event path, no natural-language classification (G2): a proposal whose
 * tool_id/version the configured definition does not name is recorded as a
 * fault and left un-gated rather than classified.
 */
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import { z } from "zod";

import {
  Actor,
  ApprovalChoice,
  ApprovalRequest,
  EVENT_ENVELOPES,
  Id,
  TASK_LIFECYCLE_EVENT_TYPES,
  WorkspaceId,
  type RiskClass,
  type RunState,
  type TaskCreatedPayload,
  type TaskRun,
  type TaskLifecyclePayload,
  type TypedExecutionEvent,
} from "@shera-bot/contracts";

import type {
  ApprovalGrantRecord,
  ApprovalMuteRow,
  ApprovalsRepository,
} from "../../adapters/sqlite/approvals-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { RedactedLogger } from "../http/typed-errors.ts";
import {
  ApprovalsService,
  ApprovalsServiceError,
  type ReminderScanEntry,
  type SetMuteInput,
} from "../../modules/approvals/approvals.service.ts";
import { taskStreamId } from "../../modules/tasks/task-events.ts";
import { ToolExecutor } from "../../modules/tools/tool-executor.service.ts";

// ---------------------------------------------------------------------------
// Route paths (the contracts convention: literal constants, one definition)
// ---------------------------------------------------------------------------

export const LIST_PENDING_APPROVALS_PATH = "/v1/approvals/pending" as const;
export const GET_APPROVAL_PATH = "/v1/approvals/:approval_id" as const;
export const APPROVAL_DECISION_PATH = "/v1/approvals/:approval_id/decision" as const;
export const LIST_APPROVAL_GRANTS_PATH = "/v1/approvals/grants" as const;
export const REVOKE_APPROVAL_GRANT_PATH = "/v1/approvals/grants/revoke" as const;
/** GET lists the workspace's mutes; POST records one (the command convention). */
export const APPROVAL_MUTES_PATH = "/v1/approvals/mutes" as const;
/** POST fires the workspace's due reminder slots (F3: a state-mutating scan). */
export const DUE_APPROVAL_REMINDERS_PATH = "/v1/approvals/due-reminders" as const;

// ---------------------------------------------------------------------------
// The composed handle (built by compose.ts over the chunk-1..3 service)
// ---------------------------------------------------------------------------

/** One approval's detail read model: the card, the E3 slots, the run state. */
export interface ApprovalDetailReadModel {
  approval: ReturnType<typeof approvalCard>;
  /** The five E3 slots by index, with their durable delivered_at stamps. */
  reminders: Array<{
    reminder_index: number;
    due_at: string;
    delivered_at: string | null;
  }>;
  /** The journal-rebuilt run read model (state + version only). */
  run: { task_id: string; state: RunState; version: number };
}

/**
 * The approvals API facade: the routes never touch SQL and never re-derive
 * approval rules — every answer comes from the chunk-1..3 service and its
 * repository, workspace-scoped (E12) by construction.
 */
export interface ApprovalsApiHandle {
  listPendingRequests(workspaceId: string): ApprovalRequest[];
  getApprovalDetail(workspaceId: string, approvalId: string): ApprovalDetailReadModel;
  /**
   * Apply one of the five contract choices. The deciding actor is relayed
   * verbatim — the SERVICE owns the G6 refusals (agents never decide). The
   * run projection is rebuilt from the journal (the durable record).
   */
  decide(input: {
    workspaceId: string;
    approvalId: string;
    choice: ApprovalChoice;
    decidedBy: Actor;
  }): Awaited<ReturnType<ApprovalsService["applyDecision"]>>;
  /** Active grants only: not revoked, not expired (compared on the clock). */
  listActiveGrants(workspaceId: string): ApprovalGrantRecord[];
  /** Stamp revoked_at; false when no row matched in the workspace (E12). */
  revokeGrant(workspaceId: string, grantId: string): boolean;
  listMutes(workspaceId: string): ApprovalMuteRow[];
  setMute(input: SetMuteInput): ApprovalMuteRow;
  dueReminders(workspaceId: string): ReminderScanEntry[];
}

/** The rebuild reads the whole task stream; the cap matches the S16 replay read. */
const JOURNAL_REBUILD_LIMIT = 10_000;

const LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set<string>(TASK_LIFECYCLE_EVENT_TYPES);

/**
 * Rebuild the task-run projection from the JOURNAL — the durable record. The
 * fold is exact for what the approval path consults (D8 state + optimistic
 * version: every accepted transition journals exactly one lifecycle event, so
 * version = 1 + the lifecycle count). A stream without a contract-valid
 * task.created (or without the creation-time pack pin) is not honestly
 * rebuildable — the typed mismatch refusal, never an invented projection (G4).
 *
 * Exported for the S19 projects surface, whose merge-request preparation
 * needs the same journal-rebuilt projection (one rebuild, one authority —
 * never a second projection rule).
 */
export function rebuildRunProjection(
  journal: Pick<EventJournalRepository, "readFrom">,
  workspaceId: string,
  taskId: string,
): TaskRun {
  const rows = journal.readFrom(workspaceId, taskStreamId(taskId), 0, JOURNAL_REBUILD_LIMIT);
  const createdRow = rows.find((row) => row.event_type === "task.created");
  if (!createdRow) {
    throw new ApprovalsServiceError(
      "APPROVAL_REQUEST_RUN_MISMATCH",
      "state",
      "the approval's task run is not recoverable from the journal",
    );
  }
  const created = EVENT_ENVELOPES["task.created"].safeParse(JSON.parse(createdRow.payload));
  if (!created.success) {
    throw new ApprovalsServiceError(
      "APPROVAL_REQUEST_RUN_MISMATCH",
      "state",
      "the approval's task run is not recoverable from the journal",
    );
  }
  const creation = created.data as TypedExecutionEvent & {
    payload: TaskCreatedPayload;
    conversation_id: string;
    occurred_at: string;
  };
  if (!creation.payload.pack_snapshot) {
    // The creation-time pack pin is what a TaskRun carries; without it the
    // projection would be invented. Runtime-created runs always stamp it.
    throw new ApprovalsServiceError(
      "APPROVAL_REQUEST_RUN_MISMATCH",
      "state",
      "the approval's task run is not recoverable from the journal",
    );
  }

  // Fold the accepted D8 transitions (each journalled exactly one lifecycle
  // event): the last to_state and the optimistic version. task.created is in
  // the vocabulary but is NOT a transition — it IS the version-1 creation the
  // count starts from. The registry lookup is GUARDED — a row whose type lost
  // its envelope entry (impossible for runtime-written rows, but this is a
  // re-read, not a second authority) is skipped rather than crashed on.
  let state: RunState = "CREATED";
  let version = 1;
  let updatedAt = creation.occurred_at;
  for (const row of rows) {
    if (row.event_type === "task.created" || !LIFECYCLE_EVENT_TYPES.has(row.event_type)) {
      continue;
    }
    const envelopeSchema = (EVENT_ENVELOPES as Record<string, z.ZodType | undefined>)[
      row.event_type
    ];
    if (!envelopeSchema) {
      continue;
    }
    const verdict = envelopeSchema.safeParse(JSON.parse(row.payload));
    if (!verdict.success) {
      continue;
    }
    const lifecycle = verdict.data as TypedExecutionEvent & {
      payload: TaskLifecyclePayload;
      occurred_at: string;
    };
    state = lifecycle.payload.to_state;
    version += 1;
    updatedAt = lifecycle.occurred_at;
  }

  return {
    task_id: taskId,
    workspace_id: workspaceId,
    conversation_id: creation.conversation_id,
    ...(creation.payload.operation_snapshot
      ? { operation_snapshot: creation.payload.operation_snapshot }
      : {}),
    created_from: {
      trigger_event_type: creation.payload.trigger_event_type,
      trigger_event_id: creation.payload.trigger_event_id,
    },
    pack_snapshot: creation.payload.pack_snapshot,
    roster: creation.payload.roster ?? [],
    ...(creation.payload.provider_snapshot
      ? { provider_snapshot: creation.payload.provider_snapshot }
      : {}),
    state,
    version,
    // Not journal-rebuildable in this payload vocabulary and NOT consulted by
    // any approval-path transition (only retry-class commands read it): the
    // honest zero for this read model's stated scope.
    retry_count: 0,
    created_at: creation.occurred_at,
    updated_at: updatedAt,
  };
}

/**
 * Compose-built handle over the approvals service + repository + journal.
 * `executeForApproval` (S19) lets the composition attach the REAL gated
 * action to an approval whose recorded resource names a merge request: the
 * callback runs ONLY after the decision transaction commits (the S20 rule),
 * so the merge can never precede its durable grant. When it returns
 * undefined the withheld execution stays the no-op scripted one — the S20
 * behavior, unchanged.
 */
export function buildApprovalsApiHandle(deps: {
  approvals: ApprovalsService;
  approvalsRepository: ApprovalsRepository;
  journal: Pick<EventJournalRepository, "readFrom">;
  now: () => string;
  /** S19: the per-request execute for approvals that name a merge request. */
  executeForApproval?: (request: ApprovalRequest) => (() => void) | undefined;
  /**
   * S21 (the P0): the withheld gated execution's post-commit callback — the
   * runtime tool executor's runWithheld for this approval. Absent (legacy
   * callers): the S20 no-op posture (the approval still resolves; nothing
   * executes — fail-closed, never a silent effect).
   */
  decideExecute?: (approvalId: string) => void;
}): ApprovalsApiHandle {
  const { approvals, approvalsRepository, journal } = deps;
  return {
    listPendingRequests(workspaceId) {
      return approvalsRepository.listRequestsByStatus(workspaceId, "pending");
    },

    getApprovalDetail(workspaceId, approvalId) {
      const request = approvalsRepository.getRequest(workspaceId, approvalId);
      if (!request) {
        throw new ApprovalsServiceError(
          "APPROVAL_REQUEST_NOT_FOUND",
          "state",
          "no approval request with this id exists in the workspace",
        );
      }
      return {
        approval: approvalCard(request),
        reminders: approvalsRepository
          .listRemindersByApproval(workspaceId, approvalId)
          .map((row) => ({
            reminder_index: row.reminder_index,
            due_at: row.due_at,
            delivered_at: row.delivered_at,
          })),
        run: rebuildRunProjection(journal, workspaceId, request.task_id),
      };
    },

    decide(input) {
      const request = approvalsRepository.getRequest(input.workspaceId, input.approvalId);
      if (!request) {
        throw new ApprovalsServiceError(
          "APPROVAL_REQUEST_NOT_FOUND",
          "state",
          "no approval request with this id exists in the workspace",
        );
      }
      // The run projection comes from the journal (the durable record) — the
      // caller-held projection of earlier chunks is the harness's in-memory
      // one, gone once startRun returns.
      const run = rebuildRunProjection(journal, input.workspaceId, request.task_id);
      return approvals.applyDecision({
        approval_id: input.approvalId,
        choice: input.choice,
        decided_by: input.decidedBy,
        run,
        // The gated action's real execution: the composition's executor for
        // approvals that name a merge request (S19), else the S21 runtime
        // tool executor's withheld one — runWithheld runs ONLY here, after
        // the decision transaction commits (AC3's decision side). Without
        // either hook the S20 posture stands: the approval resolves and
        // NOTHING executes (fail-closed, never a silent effect).
        execute:
          deps.executeForApproval?.(request) ??
          (deps.decideExecute
            ? () => {
                deps.decideExecute?.(input.approvalId);
              }
            : () => {}),
      });
    },

    listActiveGrants(workspaceId) {
      const nowMs = new Date(deps.now()).getTime();
      return approvalsRepository.listGrants(workspaceId).filter((grant) => {
        if (grant.revoked_at !== null) {
          return false;
        }
        if (grant.expires_at !== null && new Date(grant.expires_at).getTime() <= nowMs) {
          return false;
        }
        return true;
      });
    },

    revokeGrant(workspaceId, grantId) {
      return approvalsRepository.revokeGrant(workspaceId, grantId, deps.now());
    },

    listMutes(workspaceId) {
      return approvalsRepository.listMutes(workspaceId);
    },

    setMute(input) {
      return approvals.setMute(input);
    },

    dueReminders(workspaceId) {
      return approvals.dueReminders(workspaceId);
    },
  };
}

// ---------------------------------------------------------------------------
// Payload mappers (the D9 card vocabulary; digest-only — G3)
// ---------------------------------------------------------------------------

/**
 * The D9 approval card: "the exact tool, arguments summary, target resource,
 * side effect, and expiry" plus the requesting Agent and the conversation/
 * task scope. `expires_at` is the card's expiry slot — the prototype's
 * requests do not expire (bounded by container lifetime, like grants with a
 * null expiry), so it answers null rather than an invented date.
 */
function approvalCard(request: ApprovalRequest) {
  return {
    approval_id: request.approval_id,
    workspace_id: request.workspace_id,
    task_id: request.task_id,
    conversation_id: request.conversation_id,
    tool_id: request.tool_id,
    tool_version: request.tool_version,
    capability: request.capability,
    risk_class: request.risk_class,
    resource_scope: request.resource_scope,
    args_digest: request.args_digest,
    side_effect_summary: request.side_effect_summary,
    requested_by: request.requested_by,
    requested_at: request.requested_at,
    status: request.status,
    expires_at: null,
    ...(request.resolved_at !== undefined ? { resolved_at: request.resolved_at } : {}),
    ...(request.resolved_by_choice !== undefined
      ? { resolved_by_choice: request.resolved_by_choice }
      : {}),
  };
}

/** The run read model exposed beside an approval: state + version only. */
function runReadModel(run: { task_id: string; state: RunState; version: number }) {
  return { task_id: run.task_id, state: run.state, version: run.version };
}

// ---------------------------------------------------------------------------
// The routes (registered into the shared app; the typed error middleware
// upstream maps the service's thrown refusals to the SheraError taxonomy)
// ---------------------------------------------------------------------------

/** E12: every read takes the workspace from the query, every mutation from the body. */
const ApprovalWorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

/** E12: the workspace selector of the POST mutations that carry only it. */
const ApprovalWorkspaceBody = z.strictObject({ workspace_id: WorkspaceId });

const ApprovalDecisionBody = z.strictObject({
  workspace_id: WorkspaceId,
  choice: ApprovalChoice,
  /** Relayed verbatim; the service refuses any non-user actor (G6). */
  decided_by: Actor,
});

const RevokeGrantBody = z.strictObject({
  workspace_id: WorkspaceId,
  grant_id: Id,
});

const CreateMuteBody = z.strictObject({
  workspace_id: WorkspaceId,
  scope: z.enum(["approval", "task", "all"]),
  /** The service owns the scope/target coherence ('task'/'approval' need one). */
  target_id: z.string().min(1).max(256).nullish(),
  /**
   * The deciding USER actor (S20 review fix F2) — required, recorded on the
   * mute row as its audit creator; the service refuses any non-user actor.
   * Direct API callers relay the body actor; the BROWSER path is bound
   * server-side by the web proxy from the authenticated session (F1/F2), so a
   * client-asserted value never survives to the runtime there.
   */
  created_by: Actor,
});

const SetMuteInputFrom = (body: z.infer<typeof CreateMuteBody>): SetMuteInput => ({
  workspace_id: body.workspace_id,
  scope: body.scope,
  created_by: body.created_by,
  ...(body.target_id !== undefined && body.target_id !== null ? { target_id: body.target_id } : {}),
});

/**
 * Register the approvals routes. ORDER MATTERS: the literal-segment paths are
 * registered BEFORE the :approval_id capture (Express matches in registration
 * order — the same discipline as the S15 /v1/operation-definitions prefix).
 */
export function registerApprovalsRoutes(app: Express, deps: ApprovalsApiHandle): void {
  // GET /v1/approvals/pending — the workspace's pending D9 cards, oldest first.
  app.get(LIST_PENDING_APPROVALS_PATH, (req, res) => {
    const query = ApprovalWorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({
        code: "CONTRACT_VALIDATION_FAILED",
        category: "validation",
        safe_message: "The approvals request is not valid: a workspace_id is required.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: randomUUID(),
      });
      return;
    }
    res.status(200).json({
      approvals: deps.listPendingRequests(query.data.workspace_id).map(approvalCard),
    });
  });

  // GET /v1/approvals/grants — the workspace's ACTIVE grants (not revoked,
  // not expired): principal scope, conversation scope, tool+version, expiry,
  // creator. Revoked rows are history, not active authority — excluded.
  app.get(LIST_APPROVAL_GRANTS_PATH, (req, res) => {
    const query = ApprovalWorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json(validationFailure("The grants request is not valid: a workspace_id is required."));
      return;
    }
    res.status(200).json({ grants: deps.listActiveGrants(query.data.workspace_id) });
  });

  // F3: the old GET scan route is GONE — no compat shim. The literal segment
  // registers BEFORE the :approval_id capture (the module's ordering
  // discipline) so the retired verb answers the typed 404 — never a mistyped
  // "unknown approval id" 400, and never a state-mutating read.
  app.get(DUE_APPROVAL_REMINDERS_PATH, (_req, res) => {
    res.status(404).json({
      code: "ROUTE_NOT_FOUND",
      category: "validation",
      safe_message: "The requested resource does not exist.",
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: randomUUID(),
    });
  });

  // POST /v1/approvals/due-reminders — fire the due E3 slots of one
  // workspace (S20 review fix F3: a POST, not a GET — the scan stamps
  // delivered_at, a state mutation, so it rides the command verb like every
  // other mutation and the workspace arrives in the body). Delivery NEVER
  // changes run state (E3/D32). Muted slots answer `muted` and stay
  // undelivered for audit.
  app.post(DUE_APPROVAL_REMINDERS_PATH, (req, res) => {
    const body = ApprovalWorkspaceBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json(validationFailure("The reminder request is not valid: a workspace_id is required."));
      return;
    }
    res.status(200).json({ reminders: deps.dueReminders(body.data.workspace_id) });
  });

  // GET /v1/approvals/mutes — the workspace's reminder mutes, oldest first.
  app.get(APPROVAL_MUTES_PATH, (req, res) => {
    const query = ApprovalWorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      res
        .status(400)
        .json(validationFailure("The mutes request is not valid: a workspace_id is required."));
      return;
    }
    res.status(200).json({ mutes: deps.listMutes(query.data.workspace_id) });
  });

  // POST /v1/approvals/mutes — record one reminder-silencing mute (E3). The
  // body requires the deciding USER actor (F2 — the row's audit creator; the
  // browser path binds it server-side in the web proxy). The service owns the
  // typed scope/target coherence (400 on violation) and muting never touches
  // requests, runs, or grants.
  app.post(APPROVAL_MUTES_PATH, (req, res) => {
    const body = CreateMuteBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The mute request is not valid: a workspace_id, a scope, and a user actor are required.",
          ),
        );
      return;
    }
    res.status(201).json(deps.setMute(SetMuteInputFrom(body.data)));
  });

  // POST /v1/approvals/grants/revoke — stamp revoked_at (write-once). The
  // next execution consult refuses (AC26): the revoke takes effect on the
  // gate immediately, and no public path can un-revoke or re-create a grant.
  app.post(REVOKE_APPROVAL_GRANT_PATH, (req, res) => {
    const body = RevokeGrantBody.safeParse(req.body);
    if (!body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The revoke request is not valid: a workspace_id and a grant_id are required.",
          ),
        );
      return;
    }
    if (!deps.revokeGrant(body.data.workspace_id, body.data.grant_id)) {
      throw new ApprovalsServiceError(
        "APPROVAL_GRANT_NOT_FOUND",
        "state",
        "no grant with this id exists in the workspace",
      );
    }
    res.status(200).json({ revoked: true, grant_id: body.data.grant_id });
  });

  // GET /v1/approvals/:id — one card plus its five E3 reminder slots (with
  // their delivered_at stamps — what the UI reads for delivery state) and the
  // journal-rebuilt run read model. Unknown id in the workspace: typed 404.
  app.get(GET_APPROVAL_PATH, (req, res) => {
    const approvalId = Id.safeParse(req.params.approval_id);
    const query = ApprovalWorkspaceQuery.safeParse(req.query);
    if (!approvalId.success || !query.success) {
      res
        .status(400)
        .json(validationFailure("The approval request is not valid: a workspace_id is required."));
      return;
    }
    const detail = deps.getApprovalDetail(query.data.workspace_id, approvalId.data);
    res.status(200).json({
      approval: detail.approval,
      reminders: detail.reminders,
      run: runReadModel(detail.run),
    });
  });

  // POST /v1/approvals/:id/decision — the five contract choices through the
  // service's applyDecision (the only effects path; G6 refusals are the
  // service's). The typed outcomes map to HTTP exactly as the module doc
  // records: 200 for the four decision outcomes, 409 for a D8 rejection.
  app.post(APPROVAL_DECISION_PATH, (req, res) => {
    const approvalId = Id.safeParse(req.params.approval_id);
    const body = ApprovalDecisionBody.safeParse(req.body);
    if (!approvalId.success || !body.success) {
      res
        .status(400)
        .json(
          validationFailure(
            "The decision request is not valid: a workspace_id, one of the five choices, and a user decided_by are required.",
          ),
        );
      return;
    }
    const result = deps.decide({
      workspaceId: body.data.workspace_id,
      approvalId: approvalId.data,
      choice: body.data.choice,
      decidedBy: body.data.decided_by,
    });
    if (result.outcome === "transition_rejected") {
      res.status(409).json({ outcome: result.outcome, rejection: result.rejection });
      return;
    }
    if (result.outcome === "already_decided") {
      res.status(200).json({
        outcome: result.outcome,
        approval_id: result.approval_id,
        choice: result.choice,
        request: approvalCard(result.request),
      });
      return;
    }
    res.status(200).json({
      outcome: result.outcome,
      approval_id: result.approval_id,
      request: approvalCard(result.request),
      run: runReadModel(result.run),
      ...(result.outcome === "approved" ? { grant: result.grant } : {}),
      ...(result.outcome === "task_cancelled"
        ? { cancelled_child_run_ids: result.cancelled_child_run_ids }
        : {}),
    });
  });
}

/** The route-level schema-mismatch body (the same shape the middleware emits). */
function validationFailure(safeMessage: string) {
  return {
    code: "CONTRACT_VALIDATION_FAILED",
    category: "validation",
    safe_message: safeMessage,
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// The scripted lifecycle trigger (the G4 scripted-harness seam)
// ---------------------------------------------------------------------------

/**
 * The runtime-owned typed tool definition of the scripted demo proposal
 * (D38: the RUNTIME owns tool definitions; the pack allow-list references
 * them). Authored configuration — the same typed source the chunk-1 boundary
 * names for side-effect text — never a classification of the proposal text.
 */
export interface ScriptedToolDefinition {
  tool_id: string;
  tool_version: string;
  capability: string;
  risk_class: RiskClass;
  resource_scope: string;
  side_effect_summary: string;
}

/**
 * The scripted tools' response budget (the executor's AC5 check for the
 * no-op family; the real per-tool budgets are each record's own field).
 */
export const SCRIPTED_TOOL_MAX_RESPONSE_BYTES = 65_536;

/**
 * The runtime-owned ToolDefinition record a scripted configuration registers
 * into the tool registry (D38: the RUNTIME owns tool definitions). The
 * scripted definition names identity, capability, risk class, and scope; the
 * runtime supplies the structural defaults (schemas, limits, policies) —
 * authored configuration, never a classification of proposal text (G2).
 */
export function scriptedToolDefinitionRecord(
  config: ScriptedToolProposalConfig,
  workspaceId: string,
): unknown {
  return {
    tool_id: config.tool.tool_id,
    workspace_id: workspaceId,
    version: config.tool.tool_version,
    name: config.tool.tool_id,
    purpose: config.proposal_summary,
    owner: { kind: "platform" },
    inventory_scope: "shared",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    capabilities: [config.tool.capability],
    risk_class: config.tool.risk_class,
    timeout_ms: 30_000,
    resource_limits: {
      max_memory_mb: 256,
      max_cpu_seconds: 30,
      max_processes: 4,
      max_disk_mb: 64,
    },
    redaction_policy: "standard",
    approval_policy:
      config.tool.risk_class === "READ_ONLY" ? "auto_read_only" : "approval_required",
    created_at: new Date().toISOString(),
  };
}

/**
 * The composition's scripted tool-proposal configuration: the proposing
 * Agent (the scripted fixture attribution), the typed tool definition, the
 * sha256 arguments digest (G3: the digest IS the arguments surface), and the
 * D26 proposal payload's summary text.
 */
export interface ScriptedToolProposalConfig {
  agent_id: string;
  tool: ScriptedToolDefinition;
  args_digest: string;
  proposal_summary: string;
  /**
   * S21: the raw arguments the runtime holds in memory for the scripted
   * execution (NEVER persisted; the executor digests and verifies them
   * against the journalled digest). Absent -> the executor executes with {}
   * and trusts the journalled digest (the digest-only scripted posture).
   */
  args?: Record<string, unknown>;
}

/**
 * The gateway-side handler for one scripted TYPED tool.proposed envelope
 * (S21 — the P0): resolve the typed definition through the runtime tool
 * REGISTRY (registered at composition from the same configuration), and run
 * the RUNTIME EXECUTOR — the one validation/gating/limits/redaction path —
 * over the proposal. Gated risk class -> the run pauses through the S20
 * machinery and the executor withholds the real execution until the decision
 * machinery calls runWithheld; READ_ONLY -> the tool executes automatically
 * (G6). A proposal the configuration does not name is fault-logged and left
 * un-gated — a proposal is never classified into a risk class (G2). Runs
 * inside the harness's atomic unit, so the pause and its journal events
 * commit or not as one.
 */
export function applyScriptedToolProposal(
  executor: ToolExecutor,
  config: ScriptedToolProposalConfig,
  event: TypedExecutionEvent & {
    payload: { tool_id: string; tool_version: string; args_digest: string };
  },
  run: TaskRun,
  logFault: RedactedLogger,
): TaskRun {
  const { tool } = config;
  if (event.payload.tool_id !== tool.tool_id || event.payload.tool_version !== tool.tool_version) {
    logFault("approval_scripted_tool_definition_mismatch", {
      workspace_id: run.workspace_id,
      task_id: run.task_id,
      tool_id: event.payload.tool_id,
    });
    return run;
  }
  const result = executor.executeProposal({
    proposal: {
      workspace_id: run.workspace_id,
      task_id: run.task_id,
      conversation_id: run.conversation_id,
      tool_id: tool.tool_id,
      tool_version: tool.tool_version,
      capability: tool.capability,
      args_digest: event.payload.args_digest,
      proposal_summary: config.proposal_summary,
    },
    run,
    agent_id: config.agent_id,
    // The scripted definition's explicit D9 resource scope and authored
    // side-effect text (G3: the free-text surfaces pass the approvals
    // boundary's own redaction pass).
    resource_scope: tool.resource_scope,
    side_effect_summary: tool.side_effect_summary,
    ...(config.args !== undefined ? { rawArgs: config.args } : {}),
  });
  if (result.outcome === "transition_rejected") {
    logFault("approval_scripted_pause_rejected", {
      workspace_id: run.workspace_id,
      task_id: run.task_id,
      code: result.rejection.code,
    });
  }
  return result.run;
}
