/**
 * Schedules service (S28 chunk 2; PRD §8, E5, D11, G2, G3) — the runtime's
 * validation point for the declarative trigger records. The runtime, never
 * an Agent, owns this surface (D11/G2): a trigger exists only through a
 * typed create command whose per-kind configuration parses against its Zod
 * schema; a prose-only body is a typed refusal, never a trigger.
 *
 * Responsibilities here (the FIRING engine lives in scheduler.service.ts):
 *   - create: per-kind config validation (typed), the target Operation
 *     validated in the same workspace (writer-validates, no FOREIGN KEY), a
 *     webhook secret reduced to its sha256 digest BEFORE persistence (G3),
 *     the schedule cron validated + the next occurrence computed from the
 *     injected clock (the record's bookkeeping is truthful from the first
 *     read — AC9);
 *   - list/view: the truthful read model the UI renders (state, pause
 *     reason, last firing, next occurrence, recent firings);
 *   - pause/resume: the AC10 user controls; resume recomputes the next
 *     occurrence;
 *   - edit: name/config/policy replacement, revalidated, next occurrence
 *     recomputed.
 *
 * Every mutation is one short transaction unit (D10). Typed rejections
 * carry the SCREAMING_SNAKE codes; messages never echo config content (G3).
 */
import { createHash, randomUUID } from "node:crypto";

import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type {
  TriggerFiringRow,
  TriggerRecordRow,
  TriggersRepository,
} from "../../adapters/sqlite/triggers-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { nextOccurrence, validateCronExpression } from "./schedule-clock.ts";
import {
  ConditionConfigSchema,
  ExternalEventConfigSchema,
  FileWatchConfigSchema,
  GitWatchConfigSchema,
  ScheduleConfigSchema,
  TaskCompletionConfigSchema,
  WebhookConfigSchema,
  type FileWatchConfig,
  type TriggerCreateInput,
  type TriggerEditInput,
  type TriggerFiringView,
  type TriggerKindValue,
  type TriggerView,
  type WebhookStoredConfig,
} from "./schedules.types.ts";

export type SchedulesFailureCode =
  | "TRIGGER_CONFIG_INVALID"
  | "TRIGGER_TARGET_OPERATION_NOT_FOUND"
  | "TRIGGER_NOT_FOUND"
  | "SCHEDULE_CRON_INVALID";

export class SchedulesServiceError extends Error {
  readonly code: SchedulesFailureCode;
  readonly category: "validation" | "state";

  constructor(code: SchedulesFailureCode, category: "validation" | "state", message: string) {
    super(`${code}: ${message}`);
    this.name = "SchedulesServiceError";
    this.code = code;
    this.category = category;
  }
}

export interface SchedulesServiceDeps {
  triggers: TriggersRepository;
  operations: Pick<OperationsRepository, "getOperation" | "findChat">;
  tx: SqliteTransactions;
  now?: (() => string) | undefined;
}

/**
 * One typed parse: the schema's success payload, or the typed refusal (G2).
 * An explicit function declaration — the never-returning narrowing TS
 * honors at every call site.
 */
function parseOrRefuse<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, config: unknown): T {
  const verdict = schema.safeParse(config);
  if (!verdict.success || verdict.data === undefined) {
    throw new SchedulesServiceError(
      "TRIGGER_CONFIG_INVALID",
      "validation",
      "the trigger configuration does not match its kind's typed schema",
    );
  }
  return verdict.data;
}

export class SchedulesService {
  constructor(private readonly deps: SchedulesServiceDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  /**
   * Create one declarative trigger record. The per-kind config parses
   * against its schema (G2: typed data only); the target Operation must
   * exist in the same workspace; schedules validate their cron and compute
   * the next occurrence; webhook secrets become digests before any row
   * exists (G3).
   */
  createTrigger(
    workspaceId: string,
    input: TriggerCreateInput,
  ): { trigger_id: string; next_occurrence_at: string | null } {
    if (this.deps.operations.getOperation(workspaceId, input.target_operation_id) === null) {
      throw new SchedulesServiceError(
        "TRIGGER_TARGET_OPERATION_NOT_FOUND",
        "state",
        "the trigger's target Operation does not exist in this workspace",
      );
    }
    const storedConfig = this.validateAndStoreConfig(input.kind, input.config);
    let nextOccurrenceAt: string | null = null;
    if (input.kind === "schedule") {
      const config = storedConfig as { cron: string };
      const verdict = validateCronExpression(config.cron);
      if (!verdict.ok) {
        throw new SchedulesServiceError(verdict.code, "validation", verdict.safe_message);
      }
      nextOccurrenceAt = nextOccurrence(config.cron, new Date(this.now()))?.toISOString() ?? null;
    }
    const triggerId = `trg_${randomUUID()}`;
    const now = this.now();
    this.deps.tx.transaction((exec) => {
      this.deps.triggers.createTrigger(
        {
          workspace_id: workspaceId,
          trigger_id: triggerId,
          name: input.name,
          kind: input.kind,
          target_operation_id: input.target_operation_id,
          config_json: JSON.stringify(storedConfig),
          catch_up_policy: input.catch_up_policy,
          state: "active",
          pause_reason: null,
          next_occurrence_at: nextOccurrenceAt,
          created_by_type: input.actor.type,
          created_by_id: input.actor.id,
          created_at: now,
          updated_at: now,
        },
        exec,
      );
    });
    return { trigger_id: triggerId, next_occurrence_at: nextOccurrenceAt };
  }

  listTriggers(workspaceId: string): TriggerView[] {
    return this.deps.triggers.listTriggers(workspaceId).map((row) => this.toView(workspaceId, row));
  }

  getTriggerView(workspaceId: string, triggerId: string): TriggerView | null {
    const row = this.deps.triggers.getTrigger(workspaceId, triggerId);
    return row === null ? null : this.toView(workspaceId, row);
  }

  /** The AC10 pause control: the user's explicit pause (no pause reason —
   * the reason vocabulary is reserved for the D48 credit pause). */
  pauseTrigger(workspaceId: string, triggerId: string, actor: { type: string; id: string }): void {
    const row = this.requireTrigger(workspaceId, triggerId);
    if (row.state === "paused") {
      return; // Idempotent: pausing a paused trigger is the no-op.
    }
    this.deps.triggers.updateTriggerState(workspaceId, triggerId, {
      state: "paused",
      pause_reason: null,
      updated_at: this.now(),
    });
  }

  /** Resume: clears any pause (user or credit) and recomputes the next
   * occurrence from the injected clock (AC8's resume-after-top-up path and
   * the AC10 control share this write). */
  resumeTrigger(workspaceId: string, triggerId: string, actor: { type: string; id: string }): void {
    const row = this.requireTrigger(workspaceId, triggerId);
    let nextOccurrenceAt = row.next_occurrence_at;
    if (row.kind === "schedule") {
      const config = JSON.parse(row.config_json) as { cron: string };
      nextOccurrenceAt =
        nextOccurrence(config.cron, new Date(this.now()))?.toISOString() ?? null;
    }
    this.deps.triggers.updateTriggerState(workspaceId, triggerId, {
      state: "active",
      pause_reason: null,
      updated_at: this.now(),
    });
    this.deps.triggers.updateTriggerFields(workspaceId, triggerId, {
      next_occurrence_at: nextOccurrenceAt,
      updated_at: this.now(),
    });
  }

  /** Edit (AC10): name and/or config replacement, fully revalidated; a
   * schedule's next occurrence recomputes from the edited expression. */
  editTrigger(
    workspaceId: string,
    triggerId: string,
    input: TriggerEditInput,
  ): { next_occurrence_at: string | null } {
    const row = this.requireTrigger(workspaceId, triggerId);
    const kind = row.kind as TriggerKindValue;
    const storedConfig =
      input.config !== undefined
        ? this.validateAndStoreConfig(kind, input.config)
        : (JSON.parse(row.config_json) as Record<string, unknown>);
    let nextOccurrenceAt = row.next_occurrence_at;
    if (kind === "schedule") {
      const config = storedConfig as { cron: string };
      const verdict = validateCronExpression(config.cron);
      if (!verdict.ok) {
        throw new SchedulesServiceError(verdict.code, "validation", verdict.safe_message);
      }
      nextOccurrenceAt = nextOccurrence(config.cron, new Date(this.now()))?.toISOString() ?? null;
    }
    this.deps.triggers.updateTriggerFields(workspaceId, triggerId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.config !== undefined ? { config_json: JSON.stringify(storedConfig) } : {}),
      ...(input.catch_up_policy !== undefined
        ? { catch_up_policy: input.catch_up_policy }
        : {}),
      next_occurrence_at: nextOccurrenceAt,
      updated_at: this.now(),
    });
    return { next_occurrence_at: nextOccurrenceAt };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private requireTrigger(workspaceId: string, triggerId: string): TriggerRecordRow {
    const row = this.deps.triggers.getTrigger(workspaceId, triggerId);
    if (row === null) {
      throw new SchedulesServiceError(
        "TRIGGER_NOT_FOUND",
        "state",
        `trigger ${triggerId} not found in this workspace`,
      );
    }
    return row;
  }

  /**
   * Parse + normalize the per-kind configuration. Returns the STORED shape
   * (a webhook's plaintext secret becomes its sha256 digest here — G3) and
   * refuses everything else with the typed validation refusal (G2).
   */
  private validateAndStoreConfig(
    kind: TriggerKindValue,
    config: unknown,
  ): Record<string, unknown> {
    if (kind === "schedule") {
      return parseOrRefuse(ScheduleConfigSchema, config) as Record<string, unknown>;
    }
    if (kind === "file_watch") {
      const value = parseOrRefuse(FileWatchConfigSchema, config);
      // D6 scope consistency: an agent-scope watcher watches ONE Agent's
      // own folder — the URI's agent segment and the declared agent_id
      // must agree (a workspace URI is refused on the agent scope and
      // vice versa at the schema level).
      if (value.scope === "agent") {
        const agentId = value.agent_id ?? /^agent:\/\/([^/]+)\//.exec(value.path_uri)?.[1];
        if (agentId === undefined || !value.path_uri.startsWith(`agent://${agentId}/`)) {
          throw new SchedulesServiceError(
            "TRIGGER_CONFIG_INVALID",
            "validation",
            "an agent-scope watcher must name its own agent folder",
          );
        }
        return { scope: value.scope, path_uri: value.path_uri, agent_id: agentId };
      }
      if (value.agent_id !== undefined) {
        throw new SchedulesServiceError(
          "TRIGGER_CONFIG_INVALID",
          "validation",
          "a workspace-scope watcher does not take an agent_id",
        );
      }
      return { scope: value.scope, path_uri: value.path_uri };
    }
    if (kind === "git_watch") {
      return parseOrRefuse(GitWatchConfigSchema, config) as Record<string, unknown>;
    }
    if (kind === "webhook") {
      const parsed = parseOrRefuse(WebhookConfigSchema, config);
      // G3: the plaintext secret exists ONLY in this call frame. The
      // stored config carries the digest; nothing else ever sees it.
      const stored: WebhookStoredConfig = { source: parsed.source };
      if (parsed.secret !== undefined) {
        stored.secret_digest = `sha256:${createHash("sha256").update(parsed.secret).digest("hex")}`;
      }
      return stored as Record<string, unknown>;
    }
    if (kind === "task_completion") {
      return parseOrRefuse(TaskCompletionConfigSchema, config) as Record<string, unknown>;
    }
    if (kind === "condition") {
      return parseOrRefuse(ConditionConfigSchema, config) as Record<string, unknown>;
    }
    if (kind === "external_event") {
      return parseOrRefuse(ExternalEventConfigSchema, config) as Record<string, unknown>;
    }
    throw new SchedulesServiceError(
      "TRIGGER_CONFIG_INVALID",
      "validation",
      "unknown trigger kind",
    );
  }

  private toView(workspaceId: string, row: TriggerRecordRow): TriggerView {
    const firings = this.deps.triggers.listRecentFirings(workspaceId, row.trigger_id, 10);
    return {
      trigger_id: row.trigger_id,
      name: row.name,
      kind: row.kind as TriggerKindValue,
      target_operation_id: row.target_operation_id,
      config: JSON.parse(row.config_json) as Record<string, unknown>,
      catch_up_policy: row.catch_up_policy,
      state: row.state,
      pause_reason: row.pause_reason,
      last_fired_at: row.last_fired_at,
      last_occurrence_at: row.last_occurrence_at,
      next_occurrence_at: row.next_occurrence_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      recent_firings: firings.map((firing) => this.toFiringView(firing)),
    };
  }

  private toFiringView(firing: TriggerFiringRow): TriggerFiringView {
    return {
      idempotency_key: firing.idempotency_key,
      run_id: firing.run_id,
      outcome: firing.outcome,
      detail: firing.detail_json === null ? null : (JSON.parse(firing.detail_json) as Record<string, unknown>),
      fired_at: firing.fired_at,
    };
  }
}
