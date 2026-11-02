/**
 * S24 chunk 5 — the credits HTTP surface (issue #25; PRD §9, D20, D21, D48,
 * AC8, G3): the READ surface the S9 "Model budgets / Credits" settings
 * section and the sidebar credits pill render. Two reads, both
 * workspace-scoped (E12), both the LEDGER'S OWN numbers — the UI computes
 * nothing and falls back to nothing (G4):
 *
 * - GET /v1/credits — the account summary: remaining (the DERIVED available
 *   balance), reserved, granted, charged, used-this-month (net of
 *   corrections), custom-provider usage (calls + tokens this month — zero
 *   credit movement, D20), and the exhaustion flag the pause card reads.
 * - GET /v1/credits/runs/:run_id — the per-run drill-down: the run's OWN
 *   movement rows, usage records, settlements, and releases. Its
 *   charged_units sums EXACTLY to the ledger (AC8's pinning read).
 *
 * No mutation route exists on this surface: grants ride the recorded
 * control-plane top-up (S32), reservations/settlements ride the runtime's
 * own model-call legs (S24 chunk 3). A credit surface that took mutations
 * from the browser would be a parallel funding path — it does not exist.
 */
import type { Express } from "express";
import { z } from "zod";

import { WorkspaceId } from "@shera-bot/contracts";

import type {
  CreditLedgerService,
  RunCostDrillDown,
} from "../../modules/credits/credit-ledger.service.ts";

export const CREDITS_SUMMARY_PATH = "/v1/credits" as const;
export const CREDITS_RUN_PATH = "/v1/credits/runs/:run_id" as const;

export interface CreditsApiHandle {
  ledger: CreditLedgerService;
  /** E12: the container's workspace. */
  workspaceId: string;
}

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

function typedError(res: Express["response"], status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, safe_message: message } });
}

/** The month aggregate for the custom-provider usage read (bounded). */
function customUsageSummary(
  ledger: CreditLedgerService,
  workspaceId: string,
  now: Date,
): {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  providers: string[];
} {
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const monthEnd =
    month === 12
      ? `${year + 1}-01-01T00:00:00.000Z`
      : `${year}-${String(month + 1).padStart(2, "0")}-01T00:00:00.000Z`;
  const rows = ledger.usageForMonth(workspaceId, monthStart, monthEnd);
  const custom = rows.filter((row) => row.provider_origin === "user");
  const providers = [...new Set(custom.map((row) => row.provider_id))].sort();
  return {
    calls: custom.length,
    input_tokens: custom.reduce((sum, row) => sum + (row.input_tokens ?? 0), 0),
    output_tokens: custom.reduce((sum, row) => sum + (row.output_tokens ?? 0), 0),
    providers,
  };
}

export function registerCreditsRoutes(app: Express, deps: CreditsApiHandle): void {
  // The summary read (the pill + the S9 section's headline numbers).
  app.get(CREDITS_SUMMARY_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      typedError(
        res,
        400,
        "CONTRACT_VALIDATION_FAILED",
        "The credits request is not valid: a workspace_id is required.",
      );
      return;
    }
    if (query.data.workspace_id !== deps.workspaceId) {
      typedError(res, 403, "WORKSPACE_MISMATCH", "This workspace does not belong to this runtime.");
      return;
    }
    const state = deps.ledger.accountState(deps.workspaceId);
    if (state === null) {
      // No account yet: the honest empty read (the UI renders the
      // not-provisioned state), never a fabricated zero balance (G4).
      res.status(200).json({
        workspace_id: deps.workspaceId,
        account: null,
        custom_provider_usage: customUsageSummary(deps.ledger, deps.workspaceId, new Date()),
        recent_runs: [],
      });
      return;
    }
    res.status(200).json({
      workspace_id: deps.workspaceId,
      account: {
        granted_units: state.granted_units,
        charged_units: state.charged_units,
        reserved_units: state.reserved_units,
        remaining_units: state.available_units,
        used_this_month_units: state.used_this_month_units,
        exhausted: state.available_units <= 0,
      },
      custom_provider_usage: customUsageSummary(deps.ledger, deps.workspaceId, new Date()),
      recent_runs: deps.ledger.runsSummary(deps.workspaceId),
    });
  });

  // The per-run drill-down (the AC8 read — sums exactly to the ledger).
  app.get(CREDITS_RUN_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      typedError(
        res,
        400,
        "CONTRACT_VALIDATION_FAILED",
        "The credits request is not valid: a workspace_id is required.",
      );
      return;
    }
    if (query.data.workspace_id !== deps.workspaceId) {
      typedError(res, 403, "WORKSPACE_MISMATCH", "This workspace does not belong to this runtime.");
      return;
    }
    const runId = z.string().min(1).safeParse(req.params["run_id"]);
    if (!runId.success) {
      typedError(res, 400, "CONTRACT_VALIDATION_FAILED", "A run_id is required.");
      return;
    }
    const drillDown: RunCostDrillDown | null = deps.ledger.runCost(deps.workspaceId, runId.data);
    if (drillDown === null) {
      typedError(res, 404, "CREDITS_ACCOUNT_NOT_FOUND", "No credit account exists yet.");
      return;
    }
    if (
      drillDown.movements.length === 0 &&
      drillDown.usage.length === 0 &&
      drillDown.settlements.length === 0 &&
      drillDown.releases.length === 0
    ) {
      typedError(res, 404, "RUN_NOT_FOUND", "This run has no credit ledger records.");
      return;
    }
    res.status(200).json(drillDown);
  });
}
