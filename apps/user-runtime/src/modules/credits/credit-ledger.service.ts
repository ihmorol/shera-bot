/**
 * CreditLedgerService (S24; D20, D21, D48, AC3, AC4, AC9, G3, G4) — the ONE
 * service over the v20 credit ledger. Credits are PROTOTYPE ACCOUNTING:
 * they meter platform-provider model usage and gate nothing else — never an
 * authorization for tools, filesystem writes, deployment, or external
 * actions (D20; the AC7 tests pin that an exhausted account changes no
 * capability).
 *
 * The model (D21): THE single account-level balance per workspace. The
 * account row holds three non-negative counters (granted, charged,
 * reserved); the AVAILABLE balance is derived (granted − charged −
 * reserved) and never stored. Reserve → settle → release for
 * platform-provider requests:
 *
 *   - RESERVE a bounded estimate before the call (a refusal is the typed
 *     `insufficient_credits` — the caller writes the D48 pause; this service
 *     never touches run state);
 *   - SETTLE against actual usage (the unused remainder releases back; an
 *     under-estimate charges the actual and may overdraw the derived
 *     balance — the honest state the next refusal reads);
 *   - RELEASE on cancellation or provider failure (ambiguity is NOT a
 *     release — the provider may have processed the request; E13).
 *
 * Every movement lands in the append-only credit_transaction ledger (AC9):
 * corrections are new 'adjustment' rows, never in-place edits. Custom-
 * provider calls record usage with zero credit movement (D20).
 */
import { randomUUID } from "node:crypto";

import type {
  CreditAccountRow,
  CreditLedgerRepository,
  CreditTransactionRow,
  CreditUsageInsert,
  CostEstimateRow,
} from "../../adapters/sqlite/credit-ledger-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";

/** The prototype metering rate: credit units per 1K tokens (recorded here —
 * the ledger's own constant, visible in every estimate's basis note). */
export const CREDIT_UNITS_PER_1K_TOKENS = 10;

/** Chars-per-token for the prompt-side of the bounded estimate (the same
 * rough constant the platform docs use; the estimate is a BOUND, not a
 * quote — the settlement is the truth). */
const CHARS_PER_INPUT_TOKEN = 4;

export interface CreditLedgerDeps {
  repository: CreditLedgerRepository;
  /** The ONE shared transaction primitive (the repository joins the same
   * open atomic unit — never a second connection). */
  tx: SqliteTransactions;
  now?: (() => string) | undefined;
  /** The id source (tests pin deterministic ids); default randomUUID. */
  newId?: (() => string) | undefined;
}

export type ReserveResult =
  | { ok: true; reservation_id: string; estimate: CostEstimateRow }
  | { ok: false; code: "insufficient_credits"; available_units: number; requested_units: number };

/** The derived, user-visible account state (the credits pill's numbers). */
export interface CreditAccountState {
  workspace_id: string;
  granted_units: number;
  charged_units: number;
  reserved_units: number;
  available_units: number;
  used_this_month_units: number;
}

/** The bounded-estimate inputs for one model call. */
export interface EstimateInput {
  workspace_id: string;
  task_id: string;
  provider_id: string;
  model: string;
  prompt_chars: number;
  max_output_tokens: number;
}

/** The actual-usage inputs for one settled call (nullable when the provider
 * reported no metering — recorded as unknown, never fabricated, G4). */
export interface UsageInput {
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
}

export class CreditLedgerService {
  constructor(private readonly deps: CreditLedgerDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private newId(prefix: string): string {
    return `${prefix}_${this.deps.newId ? this.deps.newId() : randomUUID()}`;
  }

  /** The derived available balance of an account row. */
  static availableUnits(account: Pick<
    CreditAccountRow,
    "granted_units" | "charged_units" | "reserved_units"
  >): number {
    return account.granted_units - account.charged_units - account.reserved_units;
  }

  /** The bounded estimate for one model call (integer units, min 1 for a
   * real request — a zero estimate is reserved only by the recorded
   * pre-flight consult, which passes estimate_units 0 explicitly). */
  static estimateUnits(input: { prompt_chars: number; max_output_tokens: number }): number {
    const inputTokens = Math.ceil(input.prompt_chars / CHARS_PER_INPUT_TOKEN);
    const totalTokens = inputTokens + input.max_output_tokens;
    const units = Math.ceil((totalTokens * CREDIT_UNITS_PER_1K_TOKENS) / 1000);
    return Math.max(1, units);
  }

  /** The actual charge for one settled call (integer units; zero usage
   * metering falls back to the reservation's bounded estimate — the call
   * happened, the hold was taken, and charging the hold is the honest
   * prototype settlement when the provider reports no usage). */
  static usageUnits(
    usage: { input_tokens: number | null; output_tokens: number | null },
    fallbackUnits: number,
  ): number {
    if (usage.input_tokens === null && usage.output_tokens === null) {
      return fallbackUnits;
    }
    const totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    return Math.max(0, Math.ceil((totalTokens * CREDIT_UNITS_PER_1K_TOKENS) / 1000));
  }

  /** Idempotently create the workspace's account (the D21 singleton). */
  ensureAccount(workspaceId: string): CreditAccountRow {
    return this.deps.repository.insertAccount({ workspace_id: workspaceId, created_at: this.now() });
  }

  /**
   * Append a GRANT (the admin top-up seam; D20 "admin grants credits through
   * the control plane" — the control plane's durable topup record is the
   * authority, this is the runtime-local ledger movement it applies).
   * Amounts are positive integer units.
   */
  grant(input: {
    workspace_id: string;
    amount_units: number;
    related_id: string | null;
  }): { transaction_id: string; account: CreditAccountRow } {
    if (!Number.isInteger(input.amount_units) || input.amount_units <= 0) {
      throw new Error("grant amount must be a positive integer number of units");
    }
    const now = this.now();
    const transactionId = this.newId("ctx");
    const account = this.deps.tx.transaction((exec) => {
      const ensured = this.deps.repository.insertAccount(
        { workspace_id: input.workspace_id, created_at: now },
        exec,
      );
      this.deps.repository.insertTransaction(
        {
          workspace_id: input.workspace_id,
          transaction_id: transactionId,
          entry_type: "grant",
          amount_units: input.amount_units,
          task_id: null,
          reservation_id: null,
          related_id: input.related_id,
          corrects_transaction_id: null,
          created_at: now,
        },
        exec,
      );
      this.deps.repository.applyAccountDelta(
        input.workspace_id,
        { granted: input.amount_units },
        now,
        exec,
      );
      const updated = this.deps.repository.findAccount(input.workspace_id, exec);
      if (!updated) throw new Error("account vanished inside the grant transaction");
      return updated;
    });
    return { transaction_id: transactionId, account };
  }

  /**
   * RESERVE a bounded estimate before a platform-provider call. The gate is
   * the derived available balance: available < estimate is the typed
   * `insufficient_credits` refusal — NO hold is taken, NO movement is
   * recorded, and the caller writes the D48 pause (this service never
   * touches run state). A zero estimate consult (the recorded S28
   * pre-flight shape) holds nothing and always records its reservation row.
   */
  reserveForRun(input: {
    workspace_id: string;
    task_id: string;
    trigger_id?: string | null;
    estimate_units: number;
    estimate_basis?: string | null;
    provider_id?: string | null;
    model?: string | null;
  }): ReserveResult {
    if (!Number.isInteger(input.estimate_units) || input.estimate_units < 0) {
      throw new Error("estimate_units must be a non-negative integer");
    }
    const now = this.now();
    return this.deps.tx.transaction((exec) => {
      const account = this.deps.repository.insertAccount(
        { workspace_id: input.workspace_id, created_at: now },
        exec,
      );
      const available = CreditLedgerService.availableUnits(account);
      if (available < input.estimate_units) {
        return {
          ok: false as const,
          code: "insufficient_credits" as const,
          available_units: available,
          requested_units: input.estimate_units,
        };
      }
      const estimate: CostEstimateRow | null =
        input.estimate_units > 0 && input.provider_id && input.model
          ? {
              workspace_id: input.workspace_id,
              estimate_id: this.newId("cest"),
              task_id: input.task_id,
              provider_id: input.provider_id,
              model: input.model,
              estimated_units: input.estimate_units,
              basis:
                input.estimate_basis ??
                `bounded_estimate:${CREDIT_UNITS_PER_1K_TOKENS} units per 1K tokens`,
              created_at: now,
            }
          : null;
      const reservationId = this.newId("res");
      const reservation = this.deps.repository.insertReservation(
        {
          workspace_id: input.workspace_id,
          reservation_id: reservationId,
          task_id: input.task_id,
          trigger_id: input.trigger_id ?? null,
          estimate,
          created_at: now,
        },
        exec,
      );
      if (reservation.estimated_units > 0) {
        this.deps.repository.insertTransaction(
          {
            workspace_id: input.workspace_id,
            transaction_id: this.newId("ctx"),
            entry_type: "reservation_hold",
            amount_units: reservation.estimated_units,
            task_id: input.task_id,
            reservation_id: reservation.reservation_id,
            related_id: null,
            corrects_transaction_id: null,
            created_at: now,
          },
          exec,
        );
        this.deps.repository.applyAccountDelta(
          input.workspace_id,
          { reserved: reservation.estimated_units },
          now,
          exec,
        );
      }
      return {
        ok: true as const,
        reservation_id: reservation.reservation_id,
        estimate: estimate ?? {
          workspace_id: input.workspace_id,
          estimate_id: "consult_only",
          task_id: input.task_id,
          provider_id: input.provider_id ?? "unknown",
          model: input.model ?? "unknown",
          estimated_units: 0,
          basis: "pre_flight_consult_zero_estimate",
          created_at: now,
        },
      };
    });
  }

  /** The user-visible account state (remaining = available; the pill). */
  accountState(workspaceId: string): CreditAccountState | null {
    const account = this.deps.repository.findAccount(workspaceId);
    if (!account) return null;
    const now = this.now();
    const monthStart = `${now.slice(0, 7)}-01T00:00:00.000Z`;
    const monthEnd = nextMonthStart(now);
    const usedThisMonth = this.deps.repository
      .listTransactions(workspaceId)
      .filter(
        (row: CreditTransactionRow) =>
          row.entry_type === "settlement_charge" && row.created_at >= monthStart && row.created_at < monthEnd,
      )
      .reduce((sum, row) => sum + row.amount_units, 0);
    return {
      workspace_id: account.workspace_id,
      granted_units: account.granted_units,
      charged_units: account.charged_units,
      reserved_units: account.reserved_units,
      available_units: CreditLedgerService.availableUnits(account),
      used_this_month_units: usedThisMonth,
    };
  }

  /** Record one model call's usage (D20: custom providers charge 0 — the
   * zero movement IS the record; platform calls carry their charge). */
  recordUsage(input: Omit<CreditUsageInsert, "created_at">): void {
    this.deps.repository.insertUsageRecord({ ...input, created_at: this.now() });
  }
}

/** The first instant of the month after the one `at` belongs to (UTC). */
function nextMonthStart(at: string): string {
  const year = Number(at.slice(0, 4));
  const month = Number(at.slice(5, 7));
  return month === 12 ? `${year + 1}-01-01T00:00:00.000Z` : `${year}-${String(month + 1).padStart(2, "0")}-01T00:00:00.000Z`;
}
