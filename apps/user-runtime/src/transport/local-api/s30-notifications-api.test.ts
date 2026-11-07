/**
 * S30 chunk 1 — the notification center's runtime foundation (issue #31;
 * PRD §14, D16, E3, G2/G3/G6).
 *
 * The center renders the RUNTIME's own records (the AC9 truth posture — the
 * browser never invents state):
 *
 *   - completion / failure / recovery notifications derive from the durable
 *     journal's task-lifecycle events (task.succeeded / task.failed /
 *     task.recovery_required) — deterministic ids from the event ids;
 *   - approval_required notifications derive from the approvals module's own
 *     PENDING rows (the D9 requests), conversation-deep-linkable;
 *   - read/mute state is workspace-scoped durable state (v23);
 *   - muting an approval rides the S20 mute machinery EXACTLY (E3 — one mute
 *     record family, delivery suppressed, the approval stays pending and
 *     visible);
 *   - the notification settings (in-app / browser toggles, PRD §14) are a
 *     typed commands surface with reset-to-default (D16).
 *
 * Every answer is workspace-scoped (E12) and every summary is a bounded
 * derived line — no message content, no secrets (G3).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const OTHER_WORKSPACE = "ws_someone_else";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

async function composeOn(dbPath: string): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dbPath,
    close: () => runtime.close(),
  };
}

async function get(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Seed one durable journal row through the runtime's own journal. */
function seedLifecycleEvent(
  runtime: RuntimeHandle,
  fields: {
    eventId: string;
    eventType: "task.succeeded" | "task.failed" | "task.recovery_required";
    taskId: string;
    occurredAt: string;
    toState: string;
  },
): void {
  runtime.journal.append({
    stream_id: `task:${fields.taskId}`,
    sequence: 1,
    event_id: fields.eventId,
    event_type: fields.eventType,
    schema_version: 1,
    payload: JSON.stringify({
      from_state: "RUNNING",
      to_state: fields.toState,
      reason: "test_reason",
      correlation_id: `corr_${fields.eventId}`,
    }),
    workspace_id: WORKSPACE,
    occurred_at: fields.occurredAt,
    correlation_id: `corr_${fields.eventId}`,
  });
}

/** One notifications command with fresh ids (the caller overrides to retry). */
function notificationCommand(extra: Record<string, unknown>) {
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 10)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-08T10:00:00.000Z",
    ...extra,
  };
}

/**
 * Seed one PENDING approval request through the approvals repository on a
 * second connection (the S20 test's arrangement pattern — writes stay inside
 * the repository, no SQL here).
 */
function seedPendingApproval(dbPath: string, fields: {
  approval_id: string;
  task_id: string;
  conversation_id: string;
}): void {
  const conn = openDatabase(dbPath);
  try {
    new ApprovalsRepository(new SqliteTransactions(conn.db)).insertRequest({
      workspace_id: WORKSPACE,
      approval_id: fields.approval_id,
      task_id: fields.task_id,
      conversation_id: fields.conversation_id,
      tool_id: "tool_repo_push",
      tool_version: "1.2.0",
      capability: "repo.push",
      risk_class: "EXTERNAL_WRITE",
      resource_scope: "workspace://notes/draft.md",
      args_digest: `sha256:${"b".repeat(64)}`,
      side_effect_summary: "Pushes local commits to the configured remote repository.",
      requested_by: { type: "agent", id: "agent_developer" },
      requested_at: "2026-11-08T09:20:00.000Z",
      status: "pending",
      resolved_at: null,
      resolved_by_choice: null,
    });
  } finally {
    conn.close();
  }
}

interface NotificationView {
  notification_id: string;
  kind: string;
  title: string;
  summary: string;
  conversation_id: string | null;
  task_id: string | null;
  approval_id: string | null;
  occurred_at: string;
  read_at: string | null;
  muted: boolean;
  deep_link: string;
}

const ids = (body: Record<string, unknown>): string[] =>
  ((body["notifications"] as NotificationView[]) ?? []).map((row) => row.notification_id);

afterAll(async () => {
  await cleanupTempResources();
});

describe("S30 notifications: the runtime-derived center records", () => {
  it("derives the four kinds from the runtime's own records — journal lifecycles and the pending approvals", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-notes-"), "runtime.db"));
    const { origin, runtime } = running;

    seedLifecycleEvent(runtime, {
      eventId: "evt_succeeded_1",
      eventType: "task.succeeded",
      taskId: "task_success_1",
      occurredAt: "2026-11-08T09:00:00.000Z",
      toState: "SUCCEEDED",
    });
    seedLifecycleEvent(runtime, {
      eventId: "evt_failed_1",
      eventType: "task.failed",
      taskId: "task_failed_1",
      occurredAt: "2026-11-08T09:05:00.000Z",
      toState: "FAILED",
    });
    seedLifecycleEvent(runtime, {
      eventId: "evt_recovery_1",
      eventType: "task.recovery_required",
      taskId: "task_recovery_1",
      occurredAt: "2026-11-08T09:10:00.000Z",
      toState: "RECOVERY_REQUIRED",
    });

    const list = await get(origin, `/v1/notifications?workspace_id=${WORKSPACE}`);
    expect(list.status).toBe(200);
    const rows = list.body["notifications"] as NotificationView[];
    expect(rows).toHaveLength(3);

    const byKind = new Map(rows.map((row) => [row.kind, row]));
    expect(byKind.get("completion")).toMatchObject({
      notification_id: "note-evt_succeeded_1",
      task_id: "task_success_1",
      read_at: null,
      muted: false,
      deep_link: expect.stringContaining("/app"),
    });
    expect(byKind.get("failure")).toMatchObject({
      notification_id: "note-evt_failed_1",
      task_id: "task_failed_1",
    });
    expect(byKind.get("recovery")).toMatchObject({
      notification_id: "note-evt_recovery_1",
      task_id: "task_recovery_1",
    });
    // Newest first — the center reads top-down.
    expect(rows.map((row) => row.occurred_at)).toEqual([
      "2026-11-08T09:10:00.000Z",
      "2026-11-08T09:05:00.000Z",
      "2026-11-08T09:00:00.000Z",
    ]);
    // Bounded derived summaries only (G3): no payload text beyond the record.
    for (const row of rows) {
      expect(row.summary.length).toBeLessThanOrEqual(200);
    }

    // A pending approval arrives as approval_required with its deep link —
    // derived from the approvals module's own pending rows.
    seedPendingApproval(running.dbPath, {
      approval_id: "apr_note_1",
      task_id: "task_apr_1",
      conversation_id: "conv_apr_1",
    });
    const withApproval = await get(origin, `/v1/notifications?workspace_id=${WORKSPACE}`);
    const approvalRow = (withApproval.body["notifications"] as NotificationView[]).find(
      (row) => row.kind === "approval_required",
    );
    expect(approvalRow).toMatchObject({
      notification_id: "note-apr-apr_note_1",
      approval_id: "apr_note_1",
      conversation_id: "conv_apr_1",
      task_id: "task_apr_1",
      read_at: null,
      muted: false,
    });

    // Workspace scoping (E12): the runtime serves ITS container's workspace
    // only — a foreign workspace is a typed 403, and the rows never cross.
    const otherList = await get(origin, `/v1/notifications?workspace_id=${OTHER_WORKSPACE}`);
    expect(otherList.status).toBe(403);
  });

  it("mark-read persists through the typed command and survives re-reads; the command is idempotent", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-read-"), "runtime.db"));
    const { origin, runtime } = running;

    seedLifecycleEvent(runtime, {
      eventId: "evt_read_1",
      eventType: "task.succeeded",
      taskId: "task_read_1",
      occurredAt: "2026-11-08T09:00:00.000Z",
      toState: "SUCCEEDED",
    });

    const command = notificationCommand({
      type: "notifications.mark_read",
      notification_id: "note-evt_read_1",
    });
    const first = await post(origin, "/v1/notifications/commands", command);
    expect(first.status).toBe(200);

    const after = await get(origin, `/v1/notifications?workspace_id=${WORKSPACE}`);
    const row = (after.body["notifications"] as NotificationView[])[0]!;
    expect(row.read_at).not.toBeNull();

    // D23 rule 6: the SAME idempotency key replays the receipt — the read
    // state is stable and the command answers 200 again.
    const replay = await post(origin, "/v1/notifications/commands", command);
    expect(replay.status).toBe(200);
    const afterReplay = await get(origin, `/v1/notifications?workspace_id=${WORKSPACE}`);
    expect(((afterReplay.body["notifications"] as NotificationView[])[0]!).read_at).not.toBeNull();
  });

  it("the in-app/browser toggles persist through the settings command and reset to the recommended defaults (D16)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-set-"), "runtime.db"));
    const { origin } = running;

    // The recommended defaults (D16 auto-created notification settings):
    // in-app on; browser OFF (browser notifications ride an explicit
    // permission decision — PRD §14).
    const defaults = await get(origin, `/v1/notifications/settings?workspace_id=${WORKSPACE}`);
    expect(defaults.status).toBe(200);
    expect(defaults.body["settings"]).toMatchObject({
      in_app_enabled: true,
      browser_enabled: false,
      recommended_default: { in_app_enabled: true, browser_enabled: false },
    });

    const set = await post(
      origin,
      "/v1/notifications/settings/commands",
      notificationCommand({
        type: "notifications.set_settings",
        in_app_enabled: false,
        browser_enabled: true,
      }),
    );
    expect(set.status).toBe(200);
    const changed = await get(origin, `/v1/notifications/settings?workspace_id=${WORKSPACE}`);
    expect(changed.body["settings"]).toMatchObject({
      in_app_enabled: false,
      browser_enabled: true,
    });

    const reset = await post(
      origin,
      "/v1/notifications/settings/commands",
      notificationCommand({ type: "notifications.reset_settings" }),
    );
    expect(reset.status).toBe(200);
    const restored = await get(origin, `/v1/notifications/settings?workspace_id=${WORKSPACE}`);
    expect(restored.body["settings"]).toMatchObject({
      in_app_enabled: true,
      browser_enabled: false,
    });
  });

  it("muting an approval rides the S20 mute machinery: the approval stays pending and listed, delivery is suppressed (E3)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-mute-"), "runtime.db"));
    const { origin, runtime } = running;

    seedPendingApproval(running.dbPath, {
      approval_id: "apr_mute_1",
      task_id: "task_mute_1",
      conversation_id: "conv_mute_1",
    });

    // The notification center's per-item mute on an approval item issues the
    // S20 approval-scope mute (E3: one mute record family).
    const mute = await post(
      origin,
      "/v1/notifications/commands",
      notificationCommand({
        type: "notifications.mute",
        notification_id: "note-apr-apr_mute_1",
      }),
    );
    expect(mute.status).toBe(200);

    // The notification LIST keeps the item, now marked muted (delivery
    // suppressed — the row is never hidden).
    const list = await get(origin, `/v1/notifications?workspace_id=${WORKSPACE}`);
    const rows = list.body["notifications"] as NotificationView[];
    const approvalRow = rows.find((row) => row.kind === "approval_required");
    expect(approvalRow).toMatchObject({
      approval_id: "apr_mute_1",
      muted: true,
    });

    // The APPROVAL state is unchanged: still pending in the approvals module.
    const pending = await get(origin, `/v1/approvals/pending?workspace_id=${WORKSPACE}`);
    expect(pending.status).toBe(200);
    const pendingRows = pending.body["approvals"] as Array<{ approval_id: string }>;
    expect(pendingRows.some((row) => row.approval_id === "apr_mute_1")).toBe(true);

    // The S20 mutes list carries the approval-scope mute (one family).
    const mutes = await get(origin, `/v1/approvals/mutes?workspace_id=${WORKSPACE}`);
    expect(mutes.status).toBe(200);
    const muteRows = mutes.body["mutes"] as Array<{ scope: string; target_id: string | null }>;
    expect(muteRows.some((row) => row.scope === "approval" && row.target_id === "apr_mute_1")).toBe(
      true,
    );

    // Muting a non-approval item writes the notification's own durable state.
    seedLifecycleEvent(runtime, {
      eventId: "evt_mute_1",
      eventType: "task.succeeded",
      taskId: "task_mute_evt",
      occurredAt: "2026-11-08T09:30:00.000Z",
      toState: "SUCCEEDED",
    });
    const muteRun = await post(
      origin,
      "/v1/notifications/commands",
      notificationCommand({ type: "notifications.mute", notification_id: "note-evt_mute_1" }),
    );
    expect(muteRun.status).toBe(200);
    const after = await get(origin, `/v1/notifications?workspace_id=${WORKSPACE}`);
    const runRow = (after.body["notifications"] as NotificationView[]).find(
      (row) => row.notification_id === "note-evt_mute_1",
    );
    expect(runRow).toMatchObject({ muted: true });
  });

  it("refuses malformed commands with typed validation failures", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-bad-"), "runtime.db"));
    const { origin } = running;

    const bad = await post(origin, "/v1/notifications/commands", {
      type: "notifications.mark_read",
      workspace_id: WORKSPACE,
    });
    expect(bad.status).toBe(400);
    expect(String((bad.body as Record<string, unknown>)["safe_message"] ?? "")).toContain(
      "notification",
    );

    const missing = await get(origin, "/v1/notifications");
    expect(missing.status).toBe(400);
  });
});
