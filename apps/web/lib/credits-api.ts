import { z } from "zod";

import { Id } from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * Typed browser client for the S24 credits surface (issue #25; PRD §9, D20,
 * D21, D48, AC8, G4), through the same-origin runtime proxy exactly like
 * every other client (lib/runtime-client.ts).
 *
 * Truthfulness shape (AC8): every read returns the LEDGER'S OWN numbers —
 * remaining is the derived available balance, used-this-month is the net
 * settled usage, the per-run drill-down carries the run's own movement
 * rows. This client computes nothing and falls back to nothing (G4): a
 * missing account is the typed not-provisioned state, never a fabricated
 * zero balance. Credits are prototype accounting (D20) — the surface never
 * renders them as billing.
 */

const AccountSummary = z.strictObject({
  granted_units: z.number().int().min(0),
  charged_units: z.number().int().min(0),
  reserved_units: z.number().int().min(0),
  remaining_units: z.number().int(),
  used_this_month_units: z.number().int().min(0),
  exhausted: z.boolean(),
});

const CustomProviderUsage = z.strictObject({
  calls: z.number().int().min(0),
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  providers: z.array(z.string().min(1)),
});

const RunSummaryRow = z.strictObject({
  task_id: z.string().min(1),
  charged_units: z.number().int(),
  released_units: z.number().int().min(0),
  active_reserved_units: z.number().int().min(0),
  last_movement_at: z.string().min(1),
});

export const CreditsSummarySchema = z.strictObject({
  workspace_id: z.string().min(1),
  account: AccountSummary.nullable(),
  custom_provider_usage: CustomProviderUsage,
  recent_runs: z.array(RunSummaryRow),
});
export type CreditsSummary = z.infer<typeof CreditsSummarySchema>;

const Movement = z.strictObject({
  workspace_id: z.string().min(1),
  transaction_id: z.string().min(1),
  entry_type: z.enum([
    "grant",
    "reservation_hold",
    "settlement_charge",
    "reservation_release",
    "adjustment",
  ]),
  amount_units: z.number().int().min(0),
  task_id: z.string().nullable(),
  reservation_id: z.string().nullable(),
  related_id: z.string().nullable(),
  corrects_transaction_id: z.string().nullable(),
  created_at: z.string().min(1),
});

const UsageRow = z.strictObject({
  workspace_id: z.string().min(1),
  usage_id: z.string().min(1),
  task_id: z.string().min(1),
  provider_id: z.string().min(1),
  model: z.string().min(1),
  provider_origin: z.enum(["platform", "user"]),
  input_tokens: z.number().int().min(0).nullable(),
  output_tokens: z.number().int().min(0).nullable(),
  latency_ms: z.number().int().min(0).nullable(),
  charged_units: z.number().int().min(0),
  created_at: z.string().min(1),
});

export const RunCostDrillDownSchema = z.strictObject({
  task_id: z.string().min(1),
  charged_units: z.number().int(),
  released_units: z.number().int().min(0),
  active_reserved_units: z.number().int().min(0),
  movements: z.array(Movement),
  settlements: z.array(
    z.strictObject({
      workspace_id: z.string().min(1),
      settlement_id: z.string().min(1),
      reservation_id: z.string().min(1),
      task_id: z.string().min(1),
      actual_units: z.number().int().min(0),
      settled_at: z.string().min(1),
    }),
  ),
  releases: z.array(
    z.strictObject({
      workspace_id: z.string().min(1),
      release_id: z.string().min(1),
      reservation_id: z.string().min(1),
      task_id: z.string().min(1),
      released_units: z.number().int().min(0),
      reason: z.enum(["provider_failure", "task_cancelled", "unused_estimate"]),
      released_at: z.string().min(1),
    }),
  ),
  usage: z.array(UsageRow),
});
export type RunCostDrillDown = z.infer<typeof RunCostDrillDownSchema>;

export async function fetchCreditsSummary(workspaceId: string): Promise<CreditsSummary> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(`/api/runtime/v1/credits?${query.toString()}`, (payload) =>
    CreditsSummarySchema.parse(payload),
  );
}

export async function fetchRunCost(workspaceId: string, runId: string): Promise<RunCostDrillDown> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/credits/runs/${encodeURIComponent(Id.parse(runId))}?${query.toString()}`,
    (payload) => RunCostDrillDownSchema.parse(payload),
  );
}
