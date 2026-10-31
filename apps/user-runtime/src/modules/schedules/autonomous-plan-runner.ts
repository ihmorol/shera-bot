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
import { generateText } from "ai";

import type { TaskRun } from "@shera-bot/contracts";

import type { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import type { OperationsService } from "../operations/operations.service.ts";
import type { ProviderRow } from "../../adapters/sqlite/providers-repository.ts";
import type { ProviderCredentialsService } from "../providers/provider-credentials.ts";
import { ProviderAdapters } from "../providers/provider-adapters.ts";
import type { ProviderService } from "../providers/provider-service.ts";
import { canonicalArgsDigest, type ToolExecutor } from "../tools/tool-executor.service.ts";
import { taskStreamId } from "../tasks/task-events.ts";
import type { TriggerPlan } from "./schedules.types.ts";

/** The bounded model-call posture (recorded in E37): one request, no retry
 * layer, a hard abort window, capped output. */
const MODEL_CALL_MAX_OUTPUT_TOKENS = 256;
const MODEL_CALL_TIMEOUT_MS = 15_000;
/** The stream-record bound for the model's answer (G3: bounded, never a dump). */
const RESULT_SUMMARY_MAX_CHARS = 500;

export interface AutonomousPlanRunnerDeps {
  providers: Pick<ProviderService, "getProviderView">;
  credentials: Pick<ProviderCredentialsService, "decryptForCall">;
  executor: ToolExecutor;
  artifacts: Pick<ArtifactsRepository, "insertArtifact">;
  journal: EventJournalRepository;
  events: Pick<EventsService, "appendEvent">;
  tx: SqliteTransactions;
  operations: OperationsRepository;
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
}

export type AutonomousPlanOutcome =
  | { ok: true; result_summary: string }
  | { ok: false; code: string }
  | { ok: "paused"; approval_id: string };

/** One bounded line of provider text for the run's stream (G3). */
function boundedSummary(text: string): string {
  const line = text.replaceAll(/\s+/g, " ").trim();
  return line.length > RESULT_SUMMARY_MAX_CHARS ? `${line.slice(0, RESULT_SUMMARY_MAX_CHARS)}…` : line;
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
    type: "progress.reported" | "artifact.published",
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

  async runPlan(input: AutonomousPlanInput): Promise<AutonomousPlanOutcome> {
    const { workspace_id: workspaceId, run_id: runId, plan } = input;
    const summaries: string[] = [];

    // Leg 1 — the model call (a REAL request through the S23 provider stack).
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
      let credential: string | null = null;
      if (entry.api_mode === "api_key") {
        try {
          credential = this.deps.credentials.decryptForCall(workspaceId, entry.id);
        } catch {
          return { ok: false, code: "PROVIDER_CREDENTIAL_REVOKED" };
        }
      }
      let model: ReturnType<typeof ProviderAdapters.resolveLanguageModel>;
      try {
        model = ProviderAdapters.resolveLanguageModel(row, credential, input.provider.model);
      } catch {
        return { ok: false, code: "PROVIDER_CONFIG_INVALID" };
      }
      let completionText: string;
      try {
        // The bounded autonomous call (the connection-test posture: ONE real
        // request, no retry layer, a hard abort window — E34's lesson).
        const completion = await generateText({
          model,
          prompt: plan.prompt,
          maxOutputTokens: MODEL_CALL_MAX_OUTPUT_TOKENS,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS),
        });
        completionText = completion.text;
      } catch (error) {
        this.deps.logFault?.("autonomous_model_call_failed", {
          workspace_id: workspaceId,
          run_id: runId,
          provider_id: input.provider.provider_id,
          name: error instanceof Error ? error.name : "Error",
        });
        return { ok: false, code: "PROVIDER_CALL_FAILED" };
      }
      summaries.push(boundedSummary(completionText));
      this.journalOnRunStream(workspaceId, runId, input.conversation_id, "progress.reported", {
        summary: `Scheduled task model call completed: ${boundedSummary(completionText)}`,
        fraction: 0.3,
      });
    }

    // Leg 2 — the tool use through the executor (the ONE execution path).
    let toolSummary: string | null = null;
    if (plan.tool !== undefined) {
      const coordinator = this.coordinatorAgentId(workspaceId, input.operation_id);
      const args = plan.tool.args ?? {};
      const run: TaskRun = {
        task_id: runId,
        workspace_id: workspaceId,
        conversation_id: input.conversation_id,
        created_from: { trigger_event_type: "trigger.scheduled", trigger_event_id: `evt_${runId}` },
        pack_snapshot: { pack_id: "pack_default", pack_version: "0.0.0", pack_hash: "0".repeat(64) },
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
        toolSummary = boundedSummary(outcome.result_summary);
        summaries.push(`tool ${plan.tool.tool_id}: ${toolSummary}`);
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

