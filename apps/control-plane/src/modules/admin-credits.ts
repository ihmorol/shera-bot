/**
 * Admin credit top-up service (S32, issue #33, AC9; D48, D47).
 *
 * The top-up is the recorded unblocking path for a run paused with
 * `insufficient_credits` (D48: "The task resumes only after an admin top-up
 * (D47) or the user cancels"). This slice's honest seam shape (the S24 credit
 * ledger is NOT built yet — G4, never a fake balance):
 *
 * - the GRANT is a durable control-plane record (`control_credit_topups`,
 *   integer accounting units, always positive) plus the AC6 audit event —
 *   this is the credit record the seam consults until S24's runtime-local
 *   ledger lands (the integration point is pinned in E38);
 * - the RESUME is applied by the runtime over the recorded internal channel
 *   through the recorded D8 `resume_task` row (PAUSED → QUEUED, admin actor)
 *   — the runtime's own machinery, never a parallel path.
 *
 * Sequencing (truthful under failure): the runtime target resolves FIRST
 * (a stopped/unreachable runtime is the typed unavailable error — nothing is
 * written), then the grant commits, then the apply call runs. If the apply
 * fails after the grant committed, the caller sees the typed failure (the
 * admin_action_failed event records it) and can re-issue: applying is
 * idempotent in effect (only insufficient-credit-paused runs are touched).
 * The committed-grant/failed-apply window is recorded in E38.
 */
import { randomUUID } from "node:crypto";

import type { ControlPlaneDb } from "../db/client.ts";
import { controlCreditTopups } from "../db/schema.ts";
import { RuntimeOperationError, runtimeUnavailableError } from "../errors.ts";
import type { RuntimeChannelClient } from "../runtime/channel-client.ts";
import type { SecretRegistry } from "../redaction.ts";

export interface AdminCreditTopUpOutcome {
  topup_id: string;
  amount: number;
  resumed_run_ids: string[];
  skipped: Array<{ run_id: string; reason: string }>;
}

export interface AdminCreditTopUpDeps {
  db: ControlPlaneDb;
  channel: RuntimeChannelClient;
  registry: SecretRegistry;
  runtimeTargetForAccount: (accountId: string) => Promise<{ endpoint: string; bearer: string }>;
}

export class AdminCreditsService {
  constructor(private readonly deps: AdminCreditTopUpDeps) {}

  async topUp(args: {
    accountId: string;
    amount: number;
    reason?: string | undefined;
    tokenId: string;
  }): Promise<AdminCreditTopUpOutcome> {
    // 1) The runtime must be reachable — a typed 503 before anything commits.
    let target: { endpoint: string; bearer: string };
    try {
      target = await this.deps.runtimeTargetForAccount(args.accountId);
    } catch (error) {
      if (error instanceof RuntimeOperationError) throw error;
      throw runtimeUnavailableError();
    }

    const correlationId = randomUUID();
    // 2) The durable grant record (central, append-only accounting evidence).
    const inserted = await this.deps.db
      .insert(controlCreditTopups)
      .values({
        accountId: args.accountId,
        amount: args.amount,
        ...(args.reason !== undefined
          ? { reason: this.deps.registry.scrubString(args.reason) }
          : {}),
        correlationId,
      })
      .returning();
    const grant = inserted[0];
    if (!grant) throw new Error("top-up insert returned no row");

    // 3) The runtime applies the resume through the recorded D8 path.
    const applied = await this.deps.channel.applyCreditTopUp(target.endpoint, target.bearer, {
      workspace_id: `ws_${args.accountId}`,
      topup_id: grant.id,
      amount: args.amount,
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
      actor: { type: "admin", id: `admin-token:${args.tokenId}` },
    });
    return {
      topup_id: grant.id,
      amount: grant.amount,
      resumed_run_ids: applied.resumed_run_ids,
      skipped: applied.skipped,
    };
  }
}
