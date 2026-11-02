/**
 * The autonomous plan runner (S28 chunk 7; PRD §8, AC12, D17, D20, D22, D34,
 * D35, G2, G3, G6) — the typed legs ONE fired trigger run executes between
 * its RUNNING transition and its completion: the model call through the S23
 * provider stack (a REAL request against the configured provider — never a
 * fabricated completion), the tool use through the S21 executor (the ONE
 * execution path every capability goes through; READ_ONLY auto-runs per the
 * D35 ladder — G6), and the artifact through the S17 artifacts repository
 * (the run's own output, provenance-stamped).
 *
 * Every leg is the trigger record's TYPED plan (validated at create time —
 * never prose classification, G2). The model call is bounded (maxRetries 0,
 * a hard abort window, capped output tokens) and its result lands on the
 * run's stream as a bounded progress record — never a raw provider response
 * dump (G3). A failing leg returns the typed failure code the walk turns
 * into the run's own task.failed; a gated tool pauses the run through the
 * approval machinery exactly like any other proposal (PRD §8: risky actions
 * pause for approval by default — an autonomous run is no exception).
 */
import { randomUUID } from "node:crypto";

import { generateText } from "ai";

import type { TaskRun, TaskTriggerEventType } from "@shera-bot/contracts";

import type { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import type { ProviderRow } from "../../adapters/sqlite/providers-repository.ts";
import type { ProviderCredentialsService } from "../providers/provider-credentials.ts";
import { ProviderAdapters } from "../providers/provider-adapters.ts";
import type { ProviderService } from "../providers/provider-service.ts";
import { CreditLedgerService } from "../credits/credit-ledger.service.ts";
import { canonicalArgsDigest, type ToolExecutor } from "../tools/tool-executor.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import type { TriggerPlan } from "./schedules.types.ts";

/** The bounded model-call posture (recorded in E37): one request, no retry
 * layer, a hard abort window, capped output. */
const MODEL_CALL_MAX_OUTPUT_TOKENS = 256;
const MODEL_CALL_TIMEOUT_MS = 15_000;
/** The stream-record bound for the model's answer (G3: bounded, never a dump). */
const RESULT_SUMMARY_MAX_CHARS = 500;

/**
 * The S24 credit port (the ledger service satisfies it structurally). The
 * model leg consults it ONLY for platform-origin providers (D20): a custom
 * provider never reserves, never charges — it records usage with zero
 * credit movement.
 */
export interface PlanCreditLedger {
  reserveForRun(input: {
    workspace_id: string;
    task_id: string;
    estimate_units: number;
    provider_id: string;
    model: string;
  }):
    | { ok: true; reservation_id: string }
    | { ok: false; code: "insufficient_credits"; available_units: number; requested_units: number };
  /** The run's single active hold (a recovery re-entry reuses it — an
   * ambiguous outcome kept the hold; a resumed run never takes a second
   * reservation for the same call). */
  activeReservationFor(
    workspaceId: string,
    taskId: string,
  ): { reservation_id: string; estimated_units: number } | null;
  settleReservation(input: {
    workspace_id: string;
    reservation_id: string;
    actual_units: number;
  }): { ok: true; released_units: number } | { ok: false; code: string };
  releaseReservation(input: {
    workspace_id: string;
    reservation_id: string;
    reason: "provider_failure" | "task_cancelled" | "unused_estimate";
  }): { ok: true; released_units: number } | { ok: false; code: string };
  /** Close every leftover active hold of the run (the zero-unit pre-flight
   * consult reservation) once the call's own hold is settled. */
  releaseForRun(
    workspaceId: string,
    taskId: string,
    reason: "provider_failure" | "task_cancelled" | "unused_estimate",
  ): { released_count: number; released_units: number };
  recordUsage(input: {
    workspace_id: string;
    usage_id: string;
    task_id: string;
    provider_id: string;
    model: string;
    provider_origin: "platform" | "user";
    input_tokens: number | null;
    output_tokens: number | null;
    latency_ms: number | null;
    charged_units: number;
  }): void;
}

export interface AutonomousPlanRunnerDeps {
  providers: Pick<ProviderService, "getProviderView">;
  credentials: Pick<ProviderCredentialsService, "decryptForCall">;
  executor: ToolExecutor;
  artifacts: Pick<ArtifactsRepository, "insertArtifact">;
  journal: EventJournalRepository;
  events: Pick<EventsService, "appendEvent">;
  tx: SqliteTransactions;
  operations: OperationsRepository;
  /** The S24 credit ledger; absent = the honest no-consult posture (G4 —
   * the gap is visible in the composed wiring, never a fake allow). */
  credits?: PlanCreditLedger | undefined;
  /** The hard abort window for the model call (tests shrink it; production
   * keeps the recorded default). */
  modelCallTimeoutMs?: number | undefined;
  now?: (() => string) | undefined;
  logFault?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export interface AutonomousPlanInput {
  workspace_id: string;
  operation_id: string;
  conversation_id: string;
  run_id: string;
  plan: TriggerPlan;
  /** The trigger's declared provider pair (already D17-gated by the walk). */
  provider?: { provider_id: string; model: string } | undefined;
  /** The REAL typed trigger event (the G2 origin the scheduler wrote as the
   * run stream's first event) — the executor proposal's provenance is THIS
   * event, never a fabricated id. */
  trigger_event: { event_type: TaskTriggerEventType; event_id: string };
}

export type AutonomousPlanOutcome =
  | { ok: true; result_summary: string }
  | { ok: false; code: string }
  | { ok: "paused"; approval_id: string }
  /** S24/D48: the platform-provider reservation was refused — the WALK
   * writes the D48 pause (the runner never touches run state). */
  | { ok: "paused_credits"; requested_units: number; available_units: number }
  /** S24/E13: an ambiguous provider outcome (the provider may have
   * processed the request) — no blind retry, no silent release; the hold
   * stands and the decision is recorded on the run's stream. */
  | { ok: "recovery_required"; code: string };

/** One bounded line of provider text for the run's stream (G3). */
function boundedSummary(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > RESULT_SUMMARY_MAX_CHARS
    ? `${line.slice(0, RESULT_SUMMARY_MAX_CHARS)}…`
    : line;
}

export class AutonomousPlanRunner {
  constructor(private readonly deps: AutonomousPlanRunnerDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private journalOnRunStream(
    workspaceId: string,
    runId: string,
    conversationId: string,
    type: "progress.reported" | "artifact.published" | "run.credit_outcome_ambiguous",
    payload: Record<string, unknown>,
  ): void {
    try {
      this.deps.tx.transaction((exec) => {
        const sequence = this.deps.journal.nextSequence(taskStreamId(runId), workspaceId, exec);
        this.deps.events.appendEvent({
          event_id: `evt_${type.replaceAll(".", "_")}_${runId}_${sequence}`,
          stream_id: taskStreamId(runId),
          type: type as Parameters<EventsService["appendEvent"]>[0]["type"],
          payload: {
            event_id: `evt_${type.replaceAll(".", "_")}_${runId}_${sequence}`,
            stream_id: taskStreamId(runId),
            sequence,
            event_type: type,
            event_version: 1,
            actor: { type: "system", id: "scheduler" },
            task_id: runId,
            conversation_id: conversationId,
            occurred_at: this.now(),
            redaction_class: "internal",
            payload,
          },
          workspace_id: workspaceId,
          correlation_id: runId,
        } as Parameters<EventsService["appendEvent"]>[0]);
      });
    } catch (error) {
      // Contained: a leg's journal record never breaks the leg's effect.
      this.deps.logFault?.("autonomous_leg_journal_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        type,
        name: error instanceof Error ? error.name : "Error",
      });
    }
  }

  /**
   * The ambiguity record (S24/E13): the typed, VISIBLE decision on the
   * run's own stream — the reservation stands, the outcome is unknown, a
   * human decides. Contained: the run's state is the RECOVERY_REQUIRED row;
   * this record is its companion, so a record failure is fault-logged and
   * never breaks the recovery transition.
   */
  private recordAmbiguousOutcome(
    workspaceId: string,
    runId: string,
    providerId: string,
    reservationId: string,
  ): void {
    try {
      this.deps.events.appendEvent({
        event_id: `evt_run_credit_ambiguous_${runId}_${randomUUID().slice(0, 8)}`,
        stream_id: taskStreamId(runId),
        type: "run.credit_outcome_ambiguous",
        payload: {
          workspace_id: workspaceId,
          run_id: runId,
          reason: "ambiguous_provider_outcome",
          provider_id: providerId,
          reservation_id: reservationId,
        },
        workspace_id: workspaceId,
        correlation_id: runId,
      });
    } catch (error) {
      this.deps.logFault?.("run_credit_ambiguity_record_failed", {
        workspace_id: workspaceId,
        run_id: runId,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async runPlan(input: AutonomousPlanInput): Promise<AutonomousPlanOutcome> {
    const { workspace_id: workspaceId, run_id: runId, plan } = input;
    const summaries: string[] = [];

    // Leg 1 — the model call (a REAL request through the S23 provider stack).
    // The S24 credit discipline lives here (D20/D48): a PLATFORM provider
    // reserves a bounded estimate BEFORE the call, settles against the
    // actual usage, and releases the remainder; a refusal is the typed
    // `paused_credits` outcome (the WALK writes the D48 pause). A CUSTOM
    // provider (origin 'user') never touches credits — it records usage
    // with zero credit movement. An AMBIGUOUS outcome (the provider may
    // have processed the request) neither retries nor releases: the hold
    // stands, the decision is recorded, and the run enters the E13
    // recovery class.
    if (input.provider !== undefined) {
      const entry = this.deps.providers.getProviderView(workspaceId, input.provider.provider_id);
      if (entry === null) {
        return { ok: false, code: "PROVIDER_NOT_CONFIGURED" };
      }
      const row: ProviderRow = {
        id: entry.id,
        workspace_id: entry.workspace_id,
        display_name: entry.display_name,
        protocol: entry.protocol,
        base_url: entry.base_url,
        api_mode: entry.api_mode,
        default_model_id: entry.default_model_id,
        organization: entry.organization,
        project: entry.project,
        headers_json: JSON.stringify(entry.headers),
        request_params_json: JSON.stringify(entry.request_params),
        origin: entry.origin,
        status: entry.status,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      };
      const isPlatform = entry.origin === "platform";
      const credits = this.deps.credits;
      let reservationId: string | null = null;
      let estimatedUnits = 0;
      if (isPlatform && credits) {
        // A recovery re-entry reuses the standing hold (an ambiguous
        // outcome kept it — never a second reservation for the same call).
        const standing = credits.activeReservationFor(workspaceId, runId);
        if (standing) {
          reservationId = standing.reservation_id;
          estimatedUnits = standing.estimated_units;
        } else {
          const estimateUnits = CreditLedgerService.estimateUnits({
            prompt_chars: plan.prompt.length,
            max_output_tokens: MODEL_CALL_MAX_OUTPUT_TOKENS,
          });
          const reserved = credits.reserveForRun({
            workspace_id: workspaceId,
            task_id: runId,
            estimate_units: estimateUnits,
            provider_id: entry.id,
            model: input.provider.model,
          });
          if (!reserved.ok) {
            // The D48 refusal: the typed outcome carries the refused
            // estimate and the available balance for the pause record.
            return {
              ok: "paused_credits",
              requested_units: reserved.requested_units,
              available_units: reserved.available_units,
            };
          }
          reservationId = reserved.reservation_id;
          estimatedUnits = estimateUnits;
        }
      }
      let credential: string | null = null;
      if (entry.api_mode === "api_key") {
        try {
          credential = this.deps.credentials.decryptForCall(workspaceId, entry.id);
        } catch {
          if (reservationId !== null && credits) {
            credits.releaseReservation({
              workspace_id: workspaceId,
              reservation_id: reservationId,
              reason: "provider_failure",
            });
          }
          return { ok: false, code: "PROVIDER_CREDENTIAL_REVOKED" };
        }
      }
      let model: ReturnType<typeof ProviderAdapters.resolveLanguageModel>;
      try {
        model = ProviderAdapters.resolveLanguageModel(row, credential, input.provider.model);
      } catch {
        if (reservationId !== null && credits) {
          credits.releaseReservation({
            workspace_id: workspaceId,
            reservation_id: reservationId,
            reason: "provider_failure",
          });
        }
        return { ok: false, code: "PROVIDER_CONFIG_INVALID" };
      }
      let completionText: string;
      const callStarted = Date.now();
      try {
        // The bounded autonomous call (the connection-test posture: ONE real
        // request, no retry layer, a hard abort window — E34's lesson).
        const completion = await generateText({
          model,
          prompt: plan.prompt,
          maxOutputTokens: MODEL_CALL_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(this.deps.modelCallTimeoutMs ?? MODEL_CALL_TIMEOUT_MS),
        });
        completionText = completion.text;
        const latencyMs = Date.now() - callStarted;
        const inputTokens = completion.usage?.inputTokens ?? null;
        const outputTokens = completion.usage?.outputTokens ?? null;
        if (isPlatform) {
          // SETTLE against the actual usage; the unused remainder releases
          // (the ledger's settleReservation owns the split). The zero-unit
          // pre-flight consult closed itself at consult time.
          let settledUnits = 0;
          if (reservationId !== null && credits) {
            const actual = CreditLedgerService.usageUnits(
              { input_tokens: inputTokens, output_tokens: outputTokens },
              estimatedUnits,
            );
            settledUnits = actual;
            credits.settleReservation({
              workspace_id: workspaceId,
              reservation_id: reservationId,
              actual_units: actual,
            });
          }
          credits?.recordUsage({
            workspace_id: workspaceId,
            usage_id: `usage_${runId}_${randomUUID().slice(0, 8)}`,
            task_id: runId,
            provider_id: entry.id,
            model: input.provider.model,
            provider_origin: "platform",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
            charged_units: settledUnits,
          });
        } else {
          // D20: the CUSTOM provider consumed no Shera credits — the usage
          // and latency are still measured, with zero credit movement.
          credits?.recordUsage({
            workspace_id: workspaceId,
            usage_id: `usage_${runId}_${randomUUID().slice(0, 8)}`,
            task_id: runId,
            provider_id: entry.id,
            model: input.provider.model,
            provider_origin: "user",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
            charged_units: 0,
          });
        }
      } catch (error) {
        this.deps.logFault?.("autonomous_model_call_failed", {
          workspace_id: workspaceId,
          run_id: runId,
          provider_id: input.provider.provider_id,
          name: error instanceof Error ? error.name : "Error",
        });
        const ambiguous = isAmbiguousProviderOutcome(error);
        if (isPlatform && reservationId !== null && credits) {
          if (ambiguous) {
            // AMBIGUOUS (E13): the provider may have processed the request.
            // No blind retry, no silent release — the hold stands, the
            // decision is recorded (the typed, VISIBLE record on the run's
            // stream), the run enters recovery.
            this.recordAmbiguousOutcome(workspaceId, runId, entry.id, reservationId);
            return { ok: "recovery_required", code: "AMBIGUOUS_PROVIDER_OUTCOME" };
          }
          // A clean failure (the request never landed): release the hold.
          credits.releaseReservation({
            workspace_id: workspaceId,
            reservation_id: reservationId,
            reason: "provider_failure",
          });
        }
        return { ok: false, code: "PROVIDER_CALL_FAILED" };
      }
      summaries.push(boundedSummary(completionText));
      this.journalOnRunStream(workspaceId, runId, input.conversation_id, "progress.reported", {
        summary: `Scheduled task model call completed: ${boundedSummary(completionText)}`,
        fraction: 0.3,
      });
    }

    // Leg 2 — the tool use through the executor (the ONE execution path).
    if (plan.tool !== undefined) {
      const coordinator = this.coordinatorAgentId(workspaceId, input.operation_id);
      const args = plan.tool.args ?? {};
      const run: TaskRun = {
        task_id: runId,
        workspace_id: workspaceId,
        conversation_id: input.conversation_id,
        created_from: {
          trigger_event_type: input.trigger_event.event_type,
          trigger_event_id: input.trigger_event.event_id,
        },
        pack_snapshot: {
          pack_id: "pack_default",
          pack_version: "0.0.0",
          pack_hash: "0".repeat(64),
        },
        roster: [],
        state: "RUNNING",
        version: 3,
        retry_count: 0,
        created_at: this.now(),
        updated_at: this.now(),
      };
      const outcome = this.deps.executor.executeProposal({
        proposal: {
          workspace_id: workspaceId,
          task_id: runId,
          conversation_id: input.conversation_id,
          tool_id: plan.tool.tool_id,
          tool_version: plan.tool.tool_version,
          capability: plan.tool.capability,
          args_digest: canonicalArgsDigest(args),
          proposal_summary: "Scheduled task tool use (typed plan).",
        },
        run,
        agent_id: coordinator,
        rawArgs: args,
        resource_scope: `task:${runId}`,
        side_effect_summary: "The scheduled task's typed tool step.",
      });
      if (outcome.outcome === "executed") {
        summaries.push(`tool ${plan.tool.tool_id}: ${boundedSummary(outcome.result_summary)}`);
      } else if (outcome.outcome === "paused_for_approval") {
        // The D35 ladder holds for autonomous work too: a gated tool pauses
        // the run for the user's decision (never auto-approves — G6).
        return { ok: "paused", approval_id: outcome.approval_id };
      } else if (outcome.outcome === "execution_failed") {
        return { ok: false, code: "TOOL_EXECUTION_FAILED" };
      } else if (outcome.outcome === "blocked") {
        return { ok: false, code: outcome.error_code };
      } else {
        return { ok: false, code: "TOOL_TRANSITION_REJECTED" };
      }
    }

    // Leg 3 — the artifact (the run's own output, provenance-stamped).
    if (plan.artifact !== undefined) {
      const content = summaries.length > 0 ? summaries.join("\n\n") : "";
      if (content.length === 0) {
        return { ok: false, code: "ARTIFACT_EMPTY" };
      }
      const artifact = this.deps.artifacts.insertArtifact({
        workspace_id: workspaceId,
        name: plan.artifact.name,
        artifact_type: plan.artifact.artifact_type,
        mime_type: plan.artifact.mime_type,
        content: Buffer.from(content, "utf8"),
        producer_agent_id: null,
        producer_task_id: runId,
      });
      this.journalOnRunStream(workspaceId, runId, input.conversation_id, "artifact.published", {
        artifact_id: artifact.artifact_id,
        uri: `workspace://artifacts/${artifact.artifact_id}`,
        size_bytes: artifact.size,
      });
      summaries.push(`artifact ${plan.artifact.name} (${artifact.size} bytes)`);
    }

    return {
      ok: true,
      result_summary:
        summaries.length > 0
          ? summaries.join("; ")
          : "The autonomous plan executed with no legs configured.",
    };
  }

  private coordinatorAgentId(workspaceId: string, operationId: string): string {
    const record = this.deps.operations.getOperation(workspaceId, operationId);
    return record?.coordinator_agent_id ?? "runtime-scheduler";
  }
}

/**
 * The ambiguity classification (D20/E13, recorded): the request was SENT
 * and its processing state is UNKNOWN — the abort window fired mid-flight
 * (TimeoutError/AbortError). Everything else reads as a clean failure (the
 * request never landed: connection refused, DNS, auth, config) and
 * releases the hold. The classification is deliberately narrow — ambiguity
 * keeps a hold standing, so over-classifying would strand credits.
 */
function isAmbiguousProviderOutcome(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}
