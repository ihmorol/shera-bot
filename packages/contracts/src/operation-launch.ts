/**
 * Operation launch contract (S15 chunk 3): the typed envelope the CONFIRMED
 * launch gate submits — the one mutation the D30 preview gate leads to. The
 * launch NEVER trusts the preview: the runtime re-resolves the definition
 * from the pinned pack and re-validates the roster/coordinator against the
 * pack catalog (D36) before creating anything; this envelope only carries
 * the user's confirmation decision.
 *
 * D16-command shape: an idempotency_key, the acting principal, and the issue
 * timestamp ride every command envelope (D23 rule 6 — every side-effecting
 * command is idempotent). No command_id/expected_version here: the launch is
 * not a run-state transition — the receipt on (workspace_id, idempotency_key)
 * is the idempotency unit, and the replay returns the ORIGINAL operation,
 * run, and chat (exactly one of each is ever created, D30/AC23).
 *
 * Vocabulary: Pack → Operations → Agents. Zod-first (D25); strictObject.
 * Governing records: D30, D36, D41, D16, D23 rule 6, PRD §19 AC6/AC23.
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, WorkspaceId } from "./primitives.ts";
import { OperationCoordinatorRef } from "./operation.ts";

/** THE launch envelope: confirm = this body on POST /v1/operations/launch. */
export const OperationLaunchCommand = z.strictObject({
  workspace_id: WorkspaceId,
  /** The definition the user previewed and confirmed (re-resolved at launch). */
  operation_definition_id: Id,
  /** The confirmed roster — at least one Agent (D41; re-validated, D36). */
  roster_agent_ids: z.array(Id).min(1).max(50),
  /** The confirmed coordinator: a pack Agent id, or "none" (D42/D49). */
  coordinator_agent_id: OperationCoordinatorRef,
  idempotency_key: Id,
  actor: Actor,
  issued_at: IsoDateTime,
});
export type OperationLaunchCommand = z.infer<typeof OperationLaunchCommand>;

/**
 * The launch answer: the created Operation's ids, verbatim. The response
 * carries ONLY ids — the chat page reads the full detail from the operation
 * read model after navigation (the S14 read-after-write pattern).
 */
export const OperationLaunchReceipt = z.strictObject({
  operation_id: Id,
  run_id: Id,
  chat_conversation_id: Id,
});
export type OperationLaunchReceipt = z.infer<typeof OperationLaunchReceipt>;
