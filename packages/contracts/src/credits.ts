/**
 * Credit ledger contracts (S02 #9, D20, D21, D48): internal reservation,
 * settlement, and release records over the single account-level balance.
 * Credits are prototype accounting — not real billing, and never an
 * authorization for tools or side effects (D20).
 */
import { z } from "zod";

import { Id, IsoDateTime, WorkspaceId } from "./primitives.ts";

/** Amounts are integer credit units; a zero-value record is meaningful. */
export const CreditAmount = z.number().int().min(0);

export const CreditReservation = z.strictObject({
  reservation_id: Id,
  workspace_id: WorkspaceId,
  task_id: Id,
  estimated_amount: CreditAmount,
  status: z.enum(["reserved", "settled", "released"]),
  created_at: IsoDateTime,
});
export type CreditReservation = z.infer<typeof CreditReservation>;

export const CreditSettlement = z.strictObject({
  settlement_id: Id,
  workspace_id: WorkspaceId,
  reservation_id: Id,
  task_id: Id,
  actual_amount: CreditAmount,
  settled_at: IsoDateTime,
});
export type CreditSettlement = z.infer<typeof CreditSettlement>;

/**
 * D20: provider failures release reservations unless the provider may have
 * processed the request; ambiguous outcomes are not blindly retried (the
 * recovery class governs that — E13).
 */
export const CreditRelease = z.strictObject({
  release_id: Id,
  workspace_id: WorkspaceId,
  reservation_id: Id,
  task_id: Id,
  reason: z.enum(["provider_failure", "task_cancelled", "unused_estimate"]),
  released_at: IsoDateTime,
});
export type CreditRelease = z.infer<typeof CreditRelease>;
