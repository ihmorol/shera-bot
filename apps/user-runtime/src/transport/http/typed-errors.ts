/**
 * Typed error middleware (S07) — THE pattern for runtime HTTP surfaces.
 *
 * Every thrown failure crossing an Express boundary is answered with the
 * SheraError wire taxonomy (D23 rule 4): stable code, category, safe_message,
 * retryable, user_action, internal_details, correlation_id. The chunk-2 typed
 * rejections (commands, journal) map onto stable HTTP statuses here; anything
 * unrecognized degrades to a generic INTERNAL_ERROR that carries NO internals,
 * stack traces, or storage details (G3) — the same shape the control plane
 * already serves, so S35 can point at one middleware for the whole taxonomy.
 *
 * This module maps and serializes only; it owns no business behavior and no
 * transport routing (D23 rule 2). Route-level schema mismatches reuse the
 * same response builder (contractValidationResponse) so every failure path
 * emits identical, contract-validated fields.
 *
 * Untyped faults are also RECORDED (B-1): the generic INTERNAL_ERROR carries
 * only its correlation_id to the client, while the injected redacted logger
 * receives the allowlisted operational fields (routing data, name, message,
 * stack) — making "The failure has been recorded." a true statement. The log
 * shape matches the control-plane's request-failure log so one grep covers
 * both surfaces (G3: never payloads, credentials, or SQL text beyond the
 * error's own name/message/stack).
 */
import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler, RequestHandler } from "express";

import type { SheraError } from "@shera-bot/contracts";

import {
  AgentNotFoundError,
  AgentSettingsValidationError,
} from "../../adapters/sqlite/agents-repository.ts";
import { ArtifactNotFoundError } from "../../adapters/sqlite/artifacts-repository.ts";
import {
  AgentDeleteRefusedError,
  PrivateScopeDeniedError,
  WorkspaceDirectoryNotEmptyError,
  WorkspaceNodeNotFoundError,
  WorkspaceNodeTypeError,
  WorkspacePathError,
} from "../../adapters/sqlite/workspace-files-repository.ts";
import {
  LeaseConflictError,
  LeaseExpiredError,
  LeaseNotHeldError,
  LeaseTtlInvalidError,
  WriteLeaseConflictError,
  WriteLeaseRequiredError,
} from "../../adapters/sqlite/write-leases-repository.ts";
import { ApprovalsServiceError } from "../../modules/approvals/approvals.service.ts";
import { TerminalEventsRepositoryError } from "../../adapters/sqlite/terminal-events-repository.ts";
import {
  AgentFolderAccessDeniedError,
  AgentFolderUriInvalidError,
} from "../../modules/agents/agent-folders.service.ts";
import { AgentSettingsResetUnavailableError } from "../../modules/agents/agents.service.ts";
import { ConversationsServiceError } from "../../modules/conversations/conversations.types.ts";
import { EventsServiceError } from "../../modules/events/events.service.ts";
import { OperationsServiceError } from "../../modules/operations/operations.service.ts";
import { GitServiceError } from "../../modules/git/git.service.ts";

interface HttpErrorMapping {
  status: number;
  body: SheraError;
}

/**
 * A redacted operator-log sink (G3). Sinks receive an event name plus an
 * explicit field allowlist chosen by the CALL SITE — this type is the conduit,
 * not the redaction enforcement; call sites must never pass secrets.
 */
export type RedactedLogger = (event: string, fields: Record<string, unknown>) => void;

/** Minimal default sink: one JSON line on console.error. */
export function consoleRedactedLogger(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

/**
 * Redaction-safe messages per stable code. The thrown error's own message
 * (which embeds internal context) is NEVER echoed — these strings are the
 * whole of what the client sees (G3).
 */
const CONVERSATIONS_REJECTIONS: Record<
  ConversationsServiceError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  COMMAND_PAYLOAD_INVALID: {
    status: 400,
    safe_message: "The command envelope is malformed.",
    user_action: null,
  },
  COMMAND_UNKNOWN_TYPE: {
    status: 400,
    safe_message: "The command type is not accepted by this API.",
    user_action: null,
  },
  CONVERSATION_NOT_FOUND: {
    status: 404,
    safe_message: "The conversation does not exist in this workspace.",
    user_action: null,
  },
  CONVERSATION_REVISION_CONFLICT: {
    status: 409,
    safe_message: "The conversation changed since it was read.",
    user_action: "Reload the conversation and retry with the current revision.",
  },
};

const JOURNAL_REJECTIONS: Record<
  EventsServiceError["code"],
  { status: number; safe_message: string }
> = {
  EVENT_PAYLOAD_INVALID: {
    status: 400,
    safe_message: "The event payload failed validation.",
  },
  EVENT_UNKNOWN_TYPE: {
    status: 400,
    safe_message: "The event type is not known to this runtime.",
  },
  EVENT_SEQUENCE_CONFLICT: {
    status: 409,
    safe_message: "The event sequence conflicted with an existing append.",
  },
};

/** S11: the agents boundary rejections (the repository's typed error class). */
const AGENTS_REJECTIONS: Record<
  AgentNotFoundError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  AGENT_NOT_FOUND: {
    status: 404,
    safe_message: "The agent does not exist in this workspace.",
    user_action: null,
  },
};

/**
 * S20 chunk 4: the approvals boundary rejections (the module service's typed
 * errors) — validation codes answer the 400 class, state codes the 404/409
 * classes, and the G6 actor refusals the 403 class. The typed OUTCOMES that
 * are answers rather than failures (already_decided, transition_rejected)
 * never throw — they are 200/409 response bodies mapped by the approvals
 * routes themselves.
 */
const APPROVALS_REJECTIONS: Record<
  ApprovalsServiceError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  APPROVAL_PROPOSAL_INVALID: {
    status: 400,
    safe_message: "The tool proposal is not coherent typed approval data.",
    user_action: null,
  },
  APPROVAL_PROPOSAL_RUN_MISMATCH: {
    status: 400,
    safe_message: "The proposal does not match the task run it rides on.",
    user_action: null,
  },
  APPROVAL_DECISION_INVALID: {
    status: 400,
    safe_message: "The decision choice is not one of the five approval choices.",
    user_action: null,
  },
  APPROVAL_REQUEST_NOT_FOUND: {
    status: 404,
    safe_message: "The approval request does not exist in this workspace.",
    user_action: null,
  },
  APPROVAL_REQUEST_RUN_MISMATCH: {
    status: 400,
    safe_message: "The approval request does not match the task run it is decided on.",
    user_action: null,
  },
  APPROVAL_ALREADY_RESOLVED: {
    status: 409,
    safe_message: "This approval request was already decided; decisions are immutable.",
    user_action: "Reload the approval to see the recorded resolution.",
  },
  APPROVAL_RECHECK_INVALID: {
    status: 400,
    safe_message: "The execution recheck input is not coherent typed policy data.",
    user_action: null,
  },
  APPROVAL_MUTE_INVALID: {
    status: 400,
    safe_message:
      "The mute request is not coherent typed data for its scope, or its actor is not a user.",
    user_action: null,
  },
  APPROVAL_GRANT_NOT_FOUND: {
    status: 404,
    safe_message: "The grant does not exist in this workspace.",
    user_action: null,
  },
  AGENT_CANNOT_SELF_APPROVE: {
    status: 403,
    safe_message: "An Agent cannot approve its own request.",
    user_action: null,
  },
  AGENT_CANNOT_DECIDE_APPROVAL: {
    status: 403,
    safe_message: "Only user actors decide approvals.",
    user_action: null,
  },
};

/**
 * S19: the git boundary rejections (the module service's typed errors).
 * Import failures answer 400 (nothing was registered — the caller may retry),
 * unknown entities the 404 class, queue and merge-state conflicts the 409
 * class, and the G6 refusals (unapproved merge, unauthorized Agent) the 403
 * policy class. The safe messages are authored UI copy; no git error text —
 * which can quote credential-bearing URLs — ever crosses (G3).
 */
const GIT_REJECTIONS: Record<
  GitServiceError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  GIT_PROJECT_IMPORT_FAILED: {
    status: 400,
    safe_message: "The project import failed; nothing was registered.",
    user_action: "Check the source and retry the import.",
  },
  GIT_PROJECT_NOT_FOUND: {
    status: 404,
    safe_message: "The project does not exist in this workspace.",
    user_action: null,
  },
  GIT_AGENT_NOT_AUTHORIZED: {
    status: 403,
    safe_message: "This project is restricted and this Agent is not on its access list.",
    user_action: null,
  },
  GIT_WORKTREE_ALLOCATION_FAILED: {
    status: 409,
    safe_message: "The worktree allocation failed; the repository state was left unchanged.",
    user_action: "Retry the allocation.",
  },
  GIT_WORKTREE_NOT_FOUND: {
    status: 404,
    safe_message: "The worktree does not exist for this project.",
    user_action: null,
  },
  GIT_WORKTREE_RELEASE_FAILED: {
    status: 409,
    safe_message: "The worktree release failed; the project slot is unchanged.",
    user_action: null,
  },
  GIT_CREDENTIAL_NOT_FOUND: {
    status: 404,
    safe_message: "The credential does not exist for this project.",
    user_action: null,
  },
  GIT_CREDENTIAL_REVOKED: {
    status: 409,
    safe_message: "This credential has been revoked and can no longer be used.",
    user_action: "Store a replacement credential to continue.",
  },
  GIT_CREDENTIAL_ACTIVE_EXISTS: {
    status: 409,
    safe_message:
      "An active credential of this kind already exists; revoke it before storing a replacement.",
    user_action: "Revoke the current credential first, or replace it directly.",
  },
  GIT_URL_INVALID: {
    status: 400,
    safe_message: "The git URL is not usable in this form.",
    user_action: null,
  },
  GIT_CREDENTIAL_INVALID: {
    status: 400,
    safe_message: "The credential is not usable in this form.",
    user_action: "Provide a non-empty secret.",
  },
  GIT_ARCHIVE_INVALID: {
    status: 400,
    safe_message: "The archive import was refused; nothing was registered.",
    user_action: "Check the archive and retry the import.",
  },
  GIT_FETCH_FAILED: {
    status: 400,
    safe_message: "The origin fetch failed; the local clone is unchanged.",
    user_action: "Check the project's credential and remote, then retry.",
  },
  GIT_VALIDATION_TARGET_INVALID: {
    status: 409,
    safe_message: "The validation has no worktree to run against.",
    user_action: "The task's worktree must be active to run validation.",
  },
  GIT_MERGE_REQUEST_NOT_FOUND: {
    status: 404,
    safe_message: "The merge request does not exist for this project.",
    user_action: null,
  },
  GIT_MERGE_REQUEST_INVALID: {
    status: 409,
    safe_message: "The merge request cannot move in its current state.",
    user_action: "Reload the merge request and retry.",
  },
  GIT_MERGE_NOT_APPROVED: {
    status: 403,
    safe_message: "The merge is not approved; the runtime never merges without a valid approval.",
    user_action: null,
  },
  GIT_MERGE_CONFLICT: {
    status: 409,
    safe_message: "The merge conflicted at execution time; the target branch was left untouched.",
    user_action: "Revise the change set and prepare a new merge request.",
  },
  GIT_REPO_DIRTY: {
    status: 409,
    safe_message: "The target working copy has uncommitted changes.",
    user_action: "Resolve the uncommitted changes before merging.",
  },
};

/**
 * S13: the operations boundary rejections (the module service's typed
 * errors). NOT_FOUND* codes answer the 404-class, *_INVALID the 400
 * validation class, and OPERATION_ROSTER_REFUSED the 403 policy class —
 * with the typed D36 RosterRefusal in the body: its safe_message is the
 * refusal's own fixed UI copy, and the full refusal rides in
 * internal_details (ids + fixed copy only — authored for display, G3).
 */
const OPERATIONS_REJECTIONS: Record<
  OperationsServiceError["code"],
  { status: number; safe_message: string; user_action: string | null }
> = {
  OPERATION_NOT_FOUND: {
    status: 404,
    safe_message: "The Operation does not exist in this workspace.",
    user_action: null,
  },
  OPERATION_RUN_NOT_FOUND: {
    status: 404,
    safe_message: "The run does not exist in this Operation.",
    user_action: null,
  },
  OPERATION_ROSTER_AGENT_NOT_FOUND: {
    status: 404,
    safe_message: "That Agent is not in this Operation's roster.",
    user_action: null,
  },
  OPERATION_COORDINATOR_NOT_FOUND: {
    status: 404,
    safe_message: "The coordinator Agent does not exist in the pinned pack.",
    user_action: null,
  },
  OPERATION_ROSTER_REFUSED: {
    status: 403,
    safe_message: "This roster change was refused.",
    user_action: null,
  },
  OPERATION_COMMAND_INVALID: {
    status: 400,
    safe_message: "The Operation request is malformed.",
    user_action: null,
  },
  OPERATION_EVENT_INVALID: {
    status: 400,
    safe_message: "The collaboration event failed validation.",
    user_action: null,
  },
  OPERATION_RUN_STATE_INVALID: {
    status: 400,
    safe_message: "The run state is not a known state.",
    user_action: null,
  },
  // S14 (D41 ad-hoc creation rules): both stay in the 400 validation class.
  OPERATION_ROSTER_EMPTY: {
    status: 400,
    safe_message: "An Operation needs at least one Agent.",
    user_action: null,
  },
  OPERATION_NAME_REQUIRED: {
    status: 400,
    safe_message: "A pack-defined Operation needs a name.",
    user_action: null,
  },
  // S15 (D30 launch preview): an unknown definition in the pinned pack is the
  // 404 state class — the preview is read-only, so nothing was touched.
  OPERATION_DEFINITION_NOT_FOUND: {
    status: 404,
    safe_message: "That Operation definition does not exist in the pinned pack.",
    user_action: null,
  },
};

function bodyParserType(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type?: unknown }).type;
    if (typeof type === "string") {
      return type;
    }
  }
  return null;
}

/** Map any thrown failure to a stable HTTP status + contract-validated body. */
export function toSheraErrorResponse(error: unknown, correlationId?: string): HttpErrorMapping {
  const correlation_id = correlationId ?? randomUUID();

  if (error instanceof ConversationsServiceError) {
    const mapping = CONVERSATIONS_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: null,
        correlation_id,
      },
    };
  }

  if (error instanceof EventsServiceError) {
    const mapping = JOURNAL_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }

  if (error instanceof ApprovalsServiceError) {
    const mapping = APPROVALS_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        // The service's "forbidden" (G6 refusals) is the wire taxonomy's
        // "policy" — a permission rule, not an authentication failure.
        category: error.category === "forbidden" ? "policy" : error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: null,
        correlation_id,
      },
    };
  }

  if (error instanceof GitServiceError) {
    const mapping = GIT_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        // The git boundary's "forbidden" refusals (an unapproved merge, a
        // restricted project) are the wire taxonomy's "policy".
        category: error.category === "forbidden" ? "policy" : error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: null,
        correlation_id,
      },
    };
  }

  if (error instanceof OperationsServiceError) {
    const mapping = OPERATIONS_REJECTIONS[error.code];
    const refusal = error.code === "OPERATION_ROSTER_REFUSED" ? error.refusal : null;
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        // The refusal's own fixed UI copy is the safe message the UI renders
        // verbatim (authored for display — never a zod or storage detail).
        safe_message: refusal?.message ?? mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: refusal ? { roster_refusal: refusal } : null,
        correlation_id,
      },
    };
  }

  if (error instanceof AgentNotFoundError) {
    const mapping = AGENTS_REJECTIONS[error.code];
    return {
      status: mapping.status,
      body: {
        code: error.code,
        category: error.category,
        safe_message: mapping.safe_message,
        retryable: false,
        user_action: mapping.user_action,
        internal_details: null,
        correlation_id,
      },
    };
  }

  // S11 chunk 3: settings that do not conform to the contracts overrides
  // schema answer with the contract's standard validation failure — the
  // thrown message (which names internal shapes) is never echoed (G3).
  if (error instanceof AgentSettingsValidationError) {
    return contractValidationResponse("The agent settings payload is not valid.");
  }

  // Reset-to-default needs the pinned pack's recommendation (D16 forbids
  // inventing provider picks); without it the reset is a typed conflict.
  if (error instanceof AgentSettingsResetUnavailableError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message:
          "Resetting this setting needs the pinned pack's recommended default, which is not loaded.",
        retryable: false,
        user_action: "Start the runtime with the pinned pack configured.",
        internal_details: null,
        correlation_id,
      },
    };
  }

  // S11: private-folder isolation — the guard's two rejections. A foreign
  // Agent's private subtree is forbidden (403): the actor was identified but
  // the access is not theirs. A traversal-shaped or non-agent:// URI never
  // resolves into an escape — it is malformed input (400), rejected before
  // any permission question is even asked.
  if (error instanceof AgentFolderAccessDeniedError) {
    return {
      status: 403,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "This private folder belongs to another Agent.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof AgentFolderUriInvalidError) {
    return {
      status: 400,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The folder path is not a safe agent:// URI.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }

  // S17 — the workspace storage boundary rejections (the chunk-1/2 typed
  // error classes), mapped onto the same taxonomy. Agent ids, task ids, and
  // pack-owned display names are identifiers/authored display data, not
  // secrets (G3); the hostile input itself is never echoed.
  if (error instanceof WorkspacePathError) {
    return {
      status: 400,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The workspace path is not a safe workspace:// or agent:// URI.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof WorkspaceNodeNotFoundError) {
    return {
      status: 404,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The workspace node does not exist in this workspace.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof WorkspaceNodeTypeError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The addressed node kind does not allow this operation.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof WorkspaceDirectoryNotEmptyError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The directory is not empty; a non-recursive delete refuses it.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof ArtifactNotFoundError) {
    return {
      status: 404,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The artifact does not exist in this workspace.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof PrivateScopeDeniedError) {
    return {
      status: 403,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "This private folder belongs to another Agent.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  if (error instanceof AgentDeleteRefusedError) {
    return {
      status: 403,
      body: {
        code: error.code,
        category: error.category,
        safe_message:
          "Agents cannot delete workspace files; deletion requires the user approval path.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }
  // D6 lease arbitration. The conflict bodies carry the structured tooltip
  // fields the panel renders (chunk-2 note 4) — holding Agent id + display
  // name + task id, and the conflicting holder for agent/lease refusals.
  if (error instanceof WriteLeaseConflictError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "Another task is editing this file.",
        retryable: false,
        user_action: null,
        internal_details: {
          write_lease_conflict: {
            holding_agent_id: error.holdingAgentId,
            holding_agent_name: error.holdingAgentName,
            task_id: error.taskId,
            path: error.path,
          },
        },
        correlation_id,
      },
    };
  }
  if (error instanceof WriteLeaseRequiredError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "This task does not hold the write lease for this path.",
        retryable: false,
        user_action: null,
        internal_details: {
          write_lease_required: {
            agent_id: error.agentId,
            path: error.path,
            conflicting_task_id: error.conflictingTaskId,
            conflicting_holder_id: error.conflictingHolderId,
          },
        },
        correlation_id,
      },
    };
  }
  if (error instanceof LeaseConflictError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The path is already leased by another task.",
        retryable: false,
        user_action: null,
        internal_details: {
          lease_conflict: {
            holder_type: error.holder_type,
            holder_id: error.holder_id,
            task_id: error.task_id,
            path: error.path,
          },
        },
        correlation_id,
      },
    };
  }
  if (error instanceof LeaseExpiredError) {
    return {
      status: 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "The lease expired; acquire the path again instead of renewing.",
        retryable: false,
        user_action: null,
        internal_details: {
          lease_expired: {
            lease_id: error.leaseId,
            task_id: error.taskId,
            expired_at: error.expiredAt,
          },
        },
        correlation_id,
      },
    };
  }
  if (error instanceof LeaseNotHeldError) {
    return {
      status: 403,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "This task does not hold that lease.",
        retryable: false,
        user_action: null,
        internal_details: {
          lease_not_held: {
            lease_id: error.leaseId,
            task_id: error.taskId,
          },
        },
        correlation_id,
      },
    };
  }
  if (error instanceof LeaseTtlInvalidError) {
    return {
      status: 400,
      body: {
        code: error.code,
        category: error.category,
        safe_message: "A lease TTL must be a positive number of milliseconds.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }

  // S18 chunk 1 — the terminal live-views boundary rejections. The READ-ONLY
  // surface throws only TERMINAL_NOT_FOUND (an unknown/foreign-workspace
  // terminal id); the write-conflict codes are typed for the recorder's
  // future writer surfaces (S26) and answer the 409 conflict class.
  if (error instanceof TerminalEventsRepositoryError) {
    const notFound = error.code === "TERMINAL_NOT_FOUND";
    return {
      status: notFound ? 404 : 409,
      body: {
        code: error.code,
        category: error.category,
        safe_message: notFound
          ? "The terminal execution record does not exist in this workspace."
          : "The terminal execution record is not in a state that allows this.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id,
      },
    };
  }

  // Body-parser failures (invalid JSON, oversized body) are client errors
  // with well-known types; answer with the contract's validation failure
  // instead of the generic 500 fallback.
  const parserType = bodyParserType(error);
  if (parserType === "entity.parse.failed") {
    return contractValidationResponse("The request body is not valid JSON.");
  }
  if (parserType === "entity.too.large") {
    return contractValidationResponse("The request body exceeds the accepted size.", 413);
  }

  // Unknown failure: the generic, already-stripped fault. No stack, no
  // message echo, no internals (G3) — the same payload the control plane
  // uses for untyped server faults.
  return {
    status: 500,
    body: {
      code: "INTERNAL_ERROR",
      category: "internal",
      safe_message: "Something went wrong. The failure has been recorded.",
      retryable: false,
      user_action: "Try again later.",
      internal_details: null,
      correlation_id,
    },
  };
}

/** Route-level schema mismatch: the same typed shape the middleware emits. */
export function contractValidationResponse(safeMessage: string, status = 400): HttpErrorMapping {
  return {
    status,
    body: {
      code: "CONTRACT_VALIDATION_FAILED",
      category: "validation",
      safe_message: safeMessage,
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: randomUUID(),
    },
  };
}

/** Typed 404 for unknown routes (matches the control-plane contract). */
export function notFoundErrorResponse(): SheraError {
  return {
    code: "ROUTE_NOT_FOUND",
    category: "validation",
    safe_message: "The requested resource does not exist.",
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: randomUUID(),
  };
}

/** True when the failure is none of the typed/parsing paths — the generic 500. */
function isUntypedFault(error: unknown): boolean {
  return (
    !(error instanceof ConversationsServiceError) &&
    !(error instanceof EventsServiceError) &&
    !(error instanceof ApprovalsServiceError) &&
    !(error instanceof GitServiceError) &&
    !(error instanceof OperationsServiceError) &&
    !(error instanceof TerminalEventsRepositoryError) &&
    !(error instanceof AgentNotFoundError) &&
    !(error instanceof AgentSettingsValidationError) &&
    !(error instanceof AgentSettingsResetUnavailableError) &&
    !(error instanceof AgentFolderAccessDeniedError) &&
    !(error instanceof AgentFolderUriInvalidError) &&
    // S17: the workspace storage boundary rejections are typed — never the
    // generic 500, never the fault log.
    !(error instanceof WorkspacePathError) &&
    !(error instanceof WorkspaceNodeNotFoundError) &&
    !(error instanceof WorkspaceNodeTypeError) &&
    !(error instanceof WorkspaceDirectoryNotEmptyError) &&
    !(error instanceof ArtifactNotFoundError) &&
    !(error instanceof PrivateScopeDeniedError) &&
    !(error instanceof AgentDeleteRefusedError) &&
    !(error instanceof WriteLeaseConflictError) &&
    !(error instanceof WriteLeaseRequiredError) &&
    !(error instanceof LeaseConflictError) &&
    !(error instanceof LeaseExpiredError) &&
    !(error instanceof LeaseNotHeldError) &&
    !(error instanceof LeaseTtlInvalidError) &&
    bodyParserType(error) === null
  );
}

/**
 * Express error middleware with an injected redacted fault log: an untyped
 * fault is answered with the generic INTERNAL_ERROR whose correlation_id is
 * ALSO the one logged (B-1) — the client can quote it, the operator can find
 * it. Typed rejections and contract-validation failures are recorded as data
 * / answered precisely and are not logged here.
 */
export function createTypedErrorRequestHandler(
  logFault: RedactedLogger = consoleRedactedLogger,
): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const untyped = isUntypedFault(error);
    const correlationId = untyped ? randomUUID() : undefined;
    const { status, body } = toSheraErrorResponse(error, correlationId);
    if (untyped && correlationId !== undefined) {
      logFault("untyped_request_fault", {
        correlation_id: correlationId,
        method: req.method,
        path: req.path,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
    }
    res.status(status).json(body);
  };
}

/** Default mount: untyped faults are recorded to the default redacted sink. */
export const typedErrorRequestHandler: ErrorRequestHandler = createTypedErrorRequestHandler();

/** Mount LAST: unknown paths answer with the typed 404, never HTML. */
export const notFoundRequestHandler: RequestHandler = (_req, res) => {
  res.status(404).json(notFoundErrorResponse());
};
