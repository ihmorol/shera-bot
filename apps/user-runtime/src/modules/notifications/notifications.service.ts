/**
 * S30 — the notification center service (issue #31; PRD §14, D16, E3, G2/G3).
 *
 * The center's rows DERIVE from the runtime's own records at read time (the
 * AC9 truth posture — the browser never invents state, and no parallel
 * notification store can drift from the truth):
 *
 *   - completion / failure / recovery from the durable journal's
 *     task-lifecycle events (task.succeeded / task.failed /
 *     task.recovery_required), deterministic notification ids minted from
 *     the event ids (`note-<event_id>`);
 *   - approval_required from the approvals module's PENDING D9 requests,
 *     deterministic ids (`note-apr-<approval_id>`).
 *
 * Read/mute state lives in the v23 notification_state table, keyed by those
 * deterministic ids. Mutting an approval item creates the S20 approval-scope
 * mute through the approvals service — ONE mute record family (E3); muting
 * any other item writes the notification's own durable mute. A muted row
 * stays listed: muting affects delivery only, never state (E3).
 *
 * Every summary is a bounded runtime-computed line naming the record (G3 —
 * no message content, no secret-shaped material). Commands are typed
 * contracts (G2), receipted like every other D16-adjacent command surface.
 */
import { randomUUID } from "node:crypto";

import {
  NotificationCommand,
  type NotificationSettingsView,
  type NotificationView,
} from "@shera-bot/contracts";

import type {
  ApprovalsRepository,
  ApprovalMuteRow,
} from "../../adapters/sqlite/approvals-repository.ts";
import type { EventJournalRepository, EventJournalRow } from "../../adapters/sqlite/event-journal-repository.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { NotificationsRepository } from "../../adapters/sqlite/notifications-repository.ts";
import type { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";

/** The journal event types the completion/failure/recovery kinds derive from. */
const LIFECYCLE_EVENT_TYPES = [
  "task.succeeded",
  "task.failed",
  "task.recovery_required",
] as const;

const TASK_STREAM_PREFIX = "task:";

/** The bounded derived summaries (G3): record-naming lines, nothing else. */
const KIND_TITLES: Record<string, string> = {
  completion: "Task completed",
  failure: "Task failed",
  recovery: "Recovery review needed",
  approval_required: "Approval required",
};

export class NotificationsServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "NotificationsServiceError";
  }
}

export interface NotificationsServiceDeps {
  journal: EventJournalRepository;
  notifications: NotificationsRepository;
  approvals: ApprovalsRepository;
  operations: OperationsRepository;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  /** Injected clock (D23 testing strategy); defaults to wall time. */
  now?: () => string;
}

export class NotificationsService {
  constructor(private readonly deps: NotificationsServiceDeps) {}

  private nowIso(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Derivation (the read model)
  // -------------------------------------------------------------------------

  /** The workspace's notification rows, newest first, bounded (200). */
  list(workspaceId: string): NotificationView[] {
    const stateRows = new Map(
      this.deps.notifications.listStates(workspaceId).map((row) => [row.notification_id, row]),
    );
    const approvalMutes = this.deps.approvals.listMutes(workspaceId);

    const rows: NotificationView[] = [];

    // The journal-derived kinds (completion / failure / recovery).
    const events = this.deps.journal.listByTypes(
      workspaceId,
      LIFECYCLE_EVENT_TYPES,
      200,
    );
    for (const event of events) {
      rows.push(this.viewFromJournalEvent(workspaceId, event, stateRows));
    }

    // The approval kind: the approvals module's own PENDING rows (E3/D9 —
    // the decision state is the approvals module's truth; a resolved or
    // muted approval keeps its pending visibility here).
    for (const request of this.deps.approvals.listRequestsByStatus(workspaceId, "pending")) {
      const notificationId = `note-apr-${request.approval_id}`;
      const state = stateRows.get(notificationId);
      rows.push({
        notification_id: notificationId,
        workspace_id: workspaceId,
        kind: "approval_required",
        title: KIND_TITLES["approval_required"]!,
        summary: `${request.capability} on ${request.resource_scope} — ${request.tool_id}@${request.tool_version}`.slice(
          0,
          200,
        ),
        conversation_id: request.conversation_id,
        task_id: request.task_id,
        approval_id: request.approval_id,
        occurred_at: request.requested_at,
        read_at: state?.read_at ?? null,
        muted: approvalMutedFor(approvalMutes, request.approval_id, request.task_id),
        deep_link: `/app/operation/${request.conversation_id}`,
      });
    }

    return rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, 200);
  }

  /** One journal lifecycle event → one derived view (honest nulls where the
   * conversation binding does not exist yet). */
  private viewFromJournalEvent(
    workspaceId: string,
    event: EventJournalRow,
    stateRows: Map<string, { read_at: string | null; muted_at: string | null }>,
  ): NotificationView {
    const notificationId = `note-${event.event_id}`;
    const state = stateRows.get(notificationId);
    const kind: NotificationView["kind"] =
      event.event_type === "task.succeeded"
        ? "completion"
        : event.event_type === "task.failed"
          ? "failure"
          : "recovery";
    const taskId = event.stream_id.startsWith(TASK_STREAM_PREFIX)
      ? event.stream_id.slice(TASK_STREAM_PREFIX.length)
      : null;

    // The conversation deep link resolves through the run's Operation chat
    // binding; an unbound run keeps an honest null and falls back to /app.
    const operationId = taskId ? this.deps.operations.findRunOperation(workspaceId, taskId) : null;
    const conversationId = operationId
      ? this.deps.operations.findChat(workspaceId, operationId)
      : null;
    const deepLink = conversationId
      ? `/app/operation/${operationId}`
      : "/app";

    const summary =
      kind === "completion"
        ? `Task run ${taskId ?? event.event_id} completed`
        : kind === "failure"
          ? `Task run ${taskId ?? event.event_id} failed — review the run timeline`
          : `Task run ${taskId ?? event.event_id} needs a recovery review`;

    return {
      notification_id: notificationId,
      workspace_id: workspaceId,
      kind,
      title: KIND_TITLES[kind]!,
      summary: summary.slice(0, 200),
      conversation_id: conversationId,
      task_id: taskId,
      approval_id: null,
      occurred_at: event.occurred_at,
      read_at: state?.read_at ?? null,
      muted: state?.muted_at !== null && state?.muted_at !== undefined,
      deep_link: deepLink,
    };
  }

  // -------------------------------------------------------------------------
  // Settings (the delivery toggles)
  // -------------------------------------------------------------------------

  /** The recommended defaults (D16): in-app on, browser OFF (permission-gated). */
  static readonly RECOMMENDED_DEFAULT = { in_app_enabled: true, browser_enabled: false } as const;

  settings(workspaceId: string): NotificationSettingsView {
    const row = this.deps.notifications.getSettings(workspaceId);
    return {
      in_app_enabled: row ? row.in_app_enabled : NotificationsService.RECOMMENDED_DEFAULT.in_app_enabled,
      browser_enabled: row
        ? row.browser_enabled
        : NotificationsService.RECOMMENDED_DEFAULT.browser_enabled,
      recommended_default: { in_app_enabled: true, browser_enabled: false },
    };
  }

  // -------------------------------------------------------------------------
  // Commands (G2: typed, receipted; the actor is the session-bound user)
  // -------------------------------------------------------------------------

  submitCommand(workspaceId: string, command: unknown): { accepted: true } {
    const parsed = NotificationCommand.safeParse(command);
    if (!parsed.success) {
      throw new NotificationsServiceError(
        "NOTIFICATION_COMMAND_INVALID",
        "validation",
        "The notification command is not valid: the body must be a notification command whose workspace_id matches the path.",
      );
    }
    const typed = parsed.data;
    if (typed.workspace_id !== workspaceId) {
      throw new NotificationsServiceError(
        "NOTIFICATION_WORKSPACE_MISMATCH",
        "validation",
        "The notification command's workspace does not match the request.",
        403,
      );
    }

    // D23 rule 6: the receipt replays — the SAME idempotency key answers the
    // original outcome without re-applying.
    const existing = this.deps.receipts.findById(workspaceId, typed.idempotency_key);
    if (existing) {
      return { accepted: true };
    }

    const now = this.nowIso();
    // The command's effects AND its receipt commit in ONE atomic unit (D23
    // rule 6), exactly the memory-service pattern.
    this.deps.tx.transaction((exec) => {
      switch (typed.type) {
        case "notifications.mark_read": {
          this.deps.notifications.stampRead(workspaceId, typed.notification_id, now, exec);
          break;
        }
        case "notifications.mute": {
          if (typed.notification_id.startsWith("note-apr-")) {
            // The approval item's mute IS the S20 approval-scope mute (E3 —
            // one mute record family). The approval stays pending and listed;
            // only the reminder delivery is suppressed.
            const approvalId = typed.notification_id.slice("note-apr-".length);
            const request = this.deps.approvals.getRequest(workspaceId, approvalId, exec);
            if (!request) {
              throw new NotificationsServiceError(
                "NOTIFICATION_NOT_FOUND",
                "state",
                "The notification's approval record does not exist.",
                404,
              );
            }
            const mutes = this.deps.approvals.listMutes(workspaceId, exec);
            if (!approvalMutedFor(mutes, approvalId, request.task_id)) {
              this.deps.approvals.insertMute(
                {
                  workspace_id: workspaceId,
                  mute_id: `mut_${randomUUID()}`,
                  scope: "approval",
                  target_id: approvalId,
                  created_at: now,
                  // The v12 audit field is the creating USER's id (the proxy
                  // binds the session identity; the typed actor is always a
                  // user on this path — G6).
                  created_by: typed.actor.type === "user" ? typed.actor.id : null,
                },
                exec,
              );
            }
          } else {
            this.deps.notifications.stampMuted(workspaceId, typed.notification_id, now, exec);
          }
          break;
        }
        case "notifications.set_settings": {
          this.deps.notifications.putSettings(
            workspaceId,
            { in_app_enabled: typed.in_app_enabled, browser_enabled: typed.browser_enabled },
            now,
            exec,
          );
          break;
        }
        case "notifications.reset_settings": {
          this.deps.notifications.putSettings(
            workspaceId,
            { ...NotificationsService.RECOMMENDED_DEFAULT },
            now,
            exec,
          );
          break;
        }
      }
      this.deps.receipts.create(
        {
          workspace_id: workspaceId,
          idempotency_key: typed.idempotency_key,
          command_type: typed.type,
          result_json: JSON.stringify({ accepted: true }),
          created_at: now,
        },
        exec,
      );
    });

    return { accepted: true };
  }
}

/** The S20 mute precedence (approval > task > all) as a row predicate. */
function approvalMutedFor(
  mutes: ApprovalMuteRow[],
  approvalId: string,
  taskId: string,
): boolean {
  return mutes.some(
    (mute) =>
      (mute.scope === "approval" && mute.target_id === approvalId) ||
      (mute.scope === "task" && mute.target_id === taskId) ||
      mute.scope === "all",
  );
}
