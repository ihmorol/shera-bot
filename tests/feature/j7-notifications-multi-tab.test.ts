/**
 * FEATURE QA journey 7 — the notification center + multi-tab sync.
 *
 * The user journey: the account accumulates REAL activity (a scheduled run
 * that completes, an Agent proposal that waits on approval), the two open
 * tabs on the SAME account read the SAME notification list (the read model
 * is server-side, never per-tab), one tab's mark-read and mute are visible
 * to the other tab immediately (with the idempotent replay staying a no-op),
 * the delivery toggles one tab flips are what the other tab reads back, and
 * the unread badge both tabs derive drops coherently.
 *
 * The events are NOT seeded rows: the completion notification derives from a
 * REAL scheduled run driven to SUCCEEDED through the runtime's own fire
 * seam, and the approval_required notification from the REAL scripted
 * proposal pause (the S20 machinery).
 */
import { afterAll, describe, expect, it } from "vitest";

import type { ScriptedToolProposalConfig } from "../../apps/user-runtime/src/transport/local-api/s20-approvals-api.ts";
import {
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
} from "./helpers/runtime-harness.js";

const USER = { type: "user", id: "user_emon" } as const;
const GATED_AGENT = "agent_general_assistant";
const clockNow = "2026-11-10T12:00:00.000Z";

const GATED_TOOL: ScriptedToolProposalConfig = {
  agent_id: GATED_AGENT,
  tool: {
    tool_id: "tool_repo_push",
    tool_version: "1.2.0",
    capability: "repo.push",
    risk_class: "EXTERNAL_WRITE",
    resource_scope: "workspace://notes/draft.md",
    side_effect_summary: "Pushes local commits to the configured remote repository.",
  },
  args_digest: `sha256:${"b".repeat(64)}`,
  proposal_summary: "Scripted demo proposal: push the drafted notes.",
};

interface NotificationView {
  notification_id: string;
  kind: string;
  title: string;
  summary: string;
  read_at: string | null;
  muted: boolean;
  approval_id: string | null;
  occurred_at: string;
}

function command(extra: Record<string, unknown>) {
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 12)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 12)}`,
    workspace_id: WS,
    actor: USER,
    issued_at: "2026-11-10T12:10:00.000Z",
    ...extra,
  };
}

/** Wait (bounded) until the predicate holds; the last probe's value returns. */
async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: Awaited<T>) => boolean,
  ms = 5000,
): Promise<Awaited<T>> {
  const deadline = Date.now() + ms;
  let value = (await probe()) as Awaited<T>;
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = (await probe()) as Awaited<T>;
  }
  return value;
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("J7: notification center + multi-tab sync", () => {
  it("two tabs on the same account share the list, the read/mute state, and the toggles", async () => {
    const journey = await composeJourney({
      now: () => clockNow,
      scriptedToolProposal: GATED_TOOL,
    });
    const { origin, runtime } = journey;
    try {
      // ── Real activity 1: a scheduled run driven to SUCCEEDED ──
      const created = await postJson(origin, "/v1/operations", {
        workspace_id: WS,
        definition_ref: null,
        name: "J7 notification operation",
        roster_agent_ids: ["agent_researcher"],
        coordinator_agent_id: GATED_AGENT,
      });
      expect(created.status).toBe(201);
      const operationId = (created.body as { operation_id: string }).operation_id;
      const schedule = await postJson(origin, "/v1/schedules", {
        workspace_id: WS,
        kind: "schedule",
        name: "J7 schedule",
        target_operation_id: operationId,
        config: { cron: "0 9 * * 1", plan: { prompt: "Compile the sweep." } },
        catch_up_policy: "skip",
        actor: USER,
      });
      expect(schedule.status).toBe(201);
      const triggerId = (schedule.body as { trigger_id: string }).trigger_id;
      const fire = await runtime.scheduler.fireOccurrence(WS, triggerId, {
        idempotencyKey: `schedule:${triggerId}:2026-11-02T09:00:00.000Z`,
        dueAt: "2026-11-02T09:00:00.000Z",
        detail: { due_at: "2026-11-02T09:00:00.000Z" },
      });
      expect(fire.outcome).toBe("fired");

      // ── Real activity 2: the gated proposal waits on approval ──
      const started = runtime.harness.startRun({
        event_id: "evt_j7_trig_1",
        stream_id: "conversation:conv_j7",
        sequence: 1,
        event_version: 1,
        actor: { type: "system", id: "scheduler" },
        task_id: "task_evt_j7_trig_1",
        conversation_id: "conv_j7",
        occurred_at: clockNow,
        redaction_class: "internal",
        event_type: "trigger.scheduled",
        payload: { schedule_id: triggerId, due_at: clockNow },
      } as never);
      if (!started.ok) throw new Error(`the scripted run refused to start: ${started.code}`);
      expect(started.state).toBe("WAITING_FOR_APPROVAL");

      // ── TAB A reads the center: both real records are there ──
      const tabA = await waitFor(
        async () =>
          ((
            await getJson(origin, `/v1/notifications?workspace_id=${WS}`)
          ).body["notifications"] ?? []) as NotificationView[],
        (rows) =>
          rows.some((row) => row.kind === "completion") &&
          rows.some((row) => row.kind === "approval_required"),
      );
      const completionRow = tabA.find((row) => row.kind === "completion")!;
      const approvalRow = tabA.find((row) => row.kind === "approval_required")!;
      expect(completionRow.read_at).toBeNull();
      expect(approvalRow.muted).toBe(false);
      expect(approvalRow.approval_id).toBeTruthy();
      // Newest first (the center reads top-down); bounded summaries (G3).
      const occurredAt = tabA.map((row) => row.occurred_at);
      expect([...occurredAt].sort().reverse()).toEqual(occurredAt);
      for (const row of tabA) {
        expect(row.summary.length).toBeLessThanOrEqual(200);
      }

      // ── TAB B reads the SAME center: the same ids, the same state ──
      const tabB = ((await getJson(origin, `/v1/notifications?workspace_id=${WS}`)).body[
        "notifications"
      ] ?? []) as NotificationView[];
      expect(tabB.map((row) => row.notification_id)).toEqual(
        tabA.map((row) => row.notification_id),
      );
      expect(tabB.map((row) => row.read_at)).toEqual(tabA.map((row) => row.read_at));

      // The unread badge both tabs derive (read_at IS the server truth).
      const unreadOf = (rows: NotificationView[]) =>
        rows.filter((row) => row.read_at === null && !row.muted).length;
      expect(unreadOf(tabA)).toBe(unreadOf(tabB));
      const unreadBefore = unreadOf(tabA);
      expect(unreadBefore).toBeGreaterThanOrEqual(2);

      // ── TAB A marks the completion read; the replay is a no-op ──
      const markRead = command({ type: "notifications.mark_read", notification_id: completionRow.notification_id });
      expect((await postJson(origin, "/v1/notifications/commands", markRead)).status).toBe(200);
      expect((await postJson(origin, "/v1/notifications/commands", markRead)).status).toBe(200);

      // ── TAB B sees the read state immediately; the badge drops ──
      const tabBAfter = ((await getJson(origin, `/v1/notifications?workspace_id=${WS}`)).body[
        "notifications"
      ] ?? []) as NotificationView[];
      const readRowB = tabBAfter.find((row) => row.notification_id === completionRow.notification_id)!;
      expect(readRowB.read_at).not.toBeNull();
      expect(unreadOf(tabBAfter)).toBe(unreadBefore - 1);

      // ── TAB A mutes the approval item (the S20 mute family) ──
      const mute = command({ type: "notifications.mute", notification_id: approvalRow.notification_id });
      expect((await postJson(origin, "/v1/notifications/commands", mute)).status).toBe(200);

      // TAB B sees the mute; the approval STAYS pending (delivery is
      // suppressed, the row is never hidden).
      const tabBAfterMute = ((await getJson(origin, `/v1/notifications?workspace_id=${WS}`)).body[
        "notifications"
      ] ?? []) as NotificationView[];
      expect(
        tabBAfterMute.find((row) => row.notification_id === approvalRow.notification_id),
      ).toMatchObject({ muted: true });
      const pending = await getJson(origin, `/v1/approvals/pending?workspace_id=${WS}`);
      expect(
        ((pending.body["approvals"] ?? []) as Array<{ approval_id: string }>).some(
          (row) => row.approval_id === approvalRow.approval_id,
        ),
      ).toBe(true);

      // ── TAB A flips the delivery toggles; TAB B reads them back ──
      const set = await postJson(origin, "/v1/notifications/settings/commands", command({
        type: "notifications.set_settings",
        in_app_enabled: false,
        browser_enabled: true,
      }));
      expect(set.status).toBe(200);
      const tabBSettings = await getJson(origin, `/v1/notifications/settings?workspace_id=${WS}`);
      expect(tabBSettings.body["settings"]).toMatchObject({
        in_app_enabled: false,
        browser_enabled: true,
      });

      // The foreign workspace is a typed 403 on both tabs' routes.
      const foreign = await getJson(origin, `/v1/notifications?workspace_id=ws-someone-else-0002`);
      expect(foreign.status).toBe(403);
    } finally {
      await journey.close();
    }
  });
});
