/**
 * FEATURE QA journey 1 — signup/onboarding to the first launched Operation.
 *
 * The user journey the UI renders: a fresh account lands with onboarding
 * pending and the zero-config defaults already active, completes the D16
 * interview, browses the pack's Operation definitions, opens the launch
 * preview (the D30 gate: NOTHING executes before confirmation), launches,
 * and sends the first message in the Operation chat. Every UI-relevant API
 * state transition is asserted along the way — no stuck states, no skipped
 * gates, no duplicate creation on the replay.
 *
 * Unlike the per-slice suites (which exercise each surface in isolation),
 * this journey walks the surfaces IN SEQUENCE over one runtime, asserting
 * the state one surface leaves is exactly what the next surface reads.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  CITATION,
  RESEARCHER,
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
  type FeatureRuntime,
} from "./helpers/runtime-harness.js";

afterAll(async () => {
  await cleanupTempResources();
});

let journey: FeatureRuntime;

async function boot(): Promise<FeatureRuntime> {
  if (!journey) journey = await composeJourney();
  return journey;
}

interface OnboardingSnapshot {
  status: string;
  current_step: string;
  steps: Array<{ step: string; options: Array<{ option_id: string }> }>;
  answers: Record<string, { option_id: string | null; free_text: string | null }>;
}

function onboardingCommand(extra: Record<string, unknown>) {
  const type = (extra["type"] as string | undefined) ?? "onboarding.answer";
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 12)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 12)}`,
    workspace_id: WS,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-10T10:00:00.000Z",
    type,
    // Only the answer verb carries the optional free text (strict contracts).
    ...(type === "onboarding.answer" ? { free_text: null } : {}),
    ...extra,
  };
}

describe("J1: onboarding → first Operation", () => {
  it("walks the full first-run journey with consistent states at every surface", async () => {
    const { origin } = await boot();

    // ── 1. The fresh account: onboarding is pending, defaults already on ──
    const fresh = await getJson(origin, `/v1/onboarding?workspace_id=${WS}`);
    expect(fresh.status).toBe(200);
    const snapshot = fresh.body["onboarding"] as OnboardingSnapshot;
    expect(snapshot.status).toBe("pending");
    expect(snapshot.current_step).toBe("welcome");

    // Zero-config: the product works before any interview step.
    const noteSettings = await getJson(origin, `/v1/notifications/settings?workspace_id=${WS}`);
    expect(noteSettings.body["settings"]).toMatchObject({ in_app_enabled: true });
    const memoryView = await getJson(origin, `/v1/memory?workspace_id=${WS}`);
    expect((memoryView.body["auto_memory"] as Record<string, unknown>)["global_enabled"]).toBe(
      true,
    );

    // ── 2. Complete the interview, step by step (the wizard is ordered) ──
    const answer = (step: string, option_id: string) =>
      postJson(origin, "/v1/onboarding/commands", onboardingCommand({ step, option_id }));

    const welcomeAnswer = await answer("welcome", "research");
    expect(
      welcomeAnswer.status,
      `welcome answer failed: ${JSON.stringify(welcomeAnswer.body)}`,
    ).toBe(200);
    const afterWelcome = (await getJson(origin, `/v1/onboarding?workspace_id=${WS}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(afterWelcome.current_step).toBe("provider_check");

    expect((await answer("provider_check", "keep_default")).status).toBe(200);
    expect((await answer("approvals_briefing", "got_it")).status).toBe(200);
    expect((await answer("memory_briefing", "memory_auto_on")).status).toBe(200);
    const done = await answer("done", "finish");
    expect(done.status).toBe(200);

    const completed = (await getJson(origin, `/v1/onboarding?workspace_id=${WS}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(completed.status).toBe("completed");
    // No current step remains once the interview is completed.
    expect(completed.current_step).toBeNull();
    // No skipped gate: every step has an answer.
    for (const step of [
      "welcome",
      "provider_check",
      "approvals_briefing",
      "memory_briefing",
      "done",
    ]) {
      expect(completed.answers[step]).not.toBeNull();
    }

    // ── 3. Browse the pack's Operation definitions ──
    const definitions = await getJson(origin, `/v1/operation-definitions?workspace_id=${WS}`);
    expect(definitions.status).toBe(200);
    const rows = definitions.body["definitions"] as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const researchPaper = rows.find(
      (row) => row["operation_definition_id"] === "operation_research_paper",
    );
    expect(researchPaper).toBeDefined();

    // ── 4. The launch preview gate: read-only, zero side effects ──
    const preview = await getJson(
      origin,
      `/v1/operation-definitions/operation_research_paper/preview?workspace_id=${WS}`,
    );
    expect(preview.status).toBe(200);
    expect(typeof preview.body["definition_ref"]).toBe("string");
    expect(preview.body["definition_ref"] as string).toContain("operation_research_paper");
    // The eight D30 groups the modal renders, plus the pinned pack identity.
    expect(preview.body["pack"]).toMatchObject({ pack_id: "student", pinned: true });
    for (const group of [
      "definition",
      "roster",
      "skills",
      "connectors",
      "providers",
      "estimated_credits",
      "approval_requirements",
      "expected_outputs",
    ]) {
      expect(preview.body[group], `preview group ${group}`).toBeDefined();
    }
    // The gate is honest about approvals: the ladder is named, outcomes are not promised.
    const approvalsText = JSON.stringify(preview.body["approval_requirements"]);
    expect(approvalsText).not.toMatch(/\bwill (execute|commit|send|publish)\b/i);

    // ── 5. Confirm: the launch creates EXACTLY one operation + run + chat ──
    const launch = await postJson(origin, "/v1/operations/launch", {
      workspace_id: WS,
      operation_definition_id: "operation_research_paper",
      roster_agent_ids: [RESEARCHER, CITATION],
      coordinator_agent_id: CITATION,
      idempotency_key: "idem_feature_j1_launch_001",
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-10T10:05:00.000Z",
    });
    expect(launch.status).toBe(201);
    const launched = launch.body as Record<string, unknown>;
    const operationId = launched["operation_id"] as string;
    const runId = launched["run_id"] as string;
    const chatId = launched["chat_conversation_id"] as string;
    expect(operationId).toBeTruthy();
    expect(runId).toBeTruthy();
    expect(chatId).toBeTruthy();

    // Idempotent replay: the SAME key returns the SAME creation — never a
    // second operation (the double-click protection the UI relies on).
    const replay = await postJson(origin, "/v1/operations/launch", {
      workspace_id: WS,
      operation_definition_id: "operation_research_paper",
      roster_agent_ids: [RESEARCHER, CITATION],
      coordinator_agent_id: CITATION,
      idempotency_key: "idem_feature_j1_launch_001",
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-10T10:05:00.000Z",
    });
    // The replay answers the ORIGINAL creation (200 on replay, 201 on first).
    expect(replay.status).toBe(200);
    expect(replay.body["operation_id"]).toBe(operationId);
    expect(replay.body["run_id"]).toBe(runId);

    // ── 6. The operation detail reads back exactly what launch persisted ──
    const detail = await getJson(origin, `/v1/operations/${operationId}?workspace_id=${WS}`);
    expect(detail.status).toBe(200);
    const operation = detail.body["operation"] as Record<string, unknown>;
    expect(operation.name).toBe("Research Paper");
    expect(operation.definition_ref).toBe(preview.body["definition_ref"]);
    expect(detail.body["chat_conversation_id"]).toBe(chatId);
    const roster = detail.body["roster"] as Array<{ agent_id: string }>;
    expect(roster.map((member) => member.agent_id).sort()).toEqual([RESEARCHER, CITATION].sort());

    // The first run exists in the D8 CREATED state (a run the UI can show
    // immediately — no silent auto-start, no stuck pre-state).
    const runs = await getJson(origin, `/v1/operations/${operationId}/runs?workspace_id=${WS}`);
    expect(runs.status).toBe(200);
    const runRows = runs.body["runs"] as Array<Record<string, unknown>>;
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({ run_id: runId, state: "CREATED" });

    // ── 7. The first message lands in the Operation chat ──
    const send = await postJson(origin, `/v1/operations/${operationId}/thread/messages`, {
      workspace_id: WS,
      idempotency_key: "idem_feature_j1_msg_001",
      sender: { kind: "user", display_name: "Emon" },
      text: "@agent_researcher please start the literature sweep",
    });
    expect(send.status).toBe(201);
    expect(send.body).toMatchObject({
      kind: "message_sent",
      addressed_to: [RESEARCHER],
      conversation_id: chatId,
    });

    // The thread read model renders it (with the @-addressing resolved).
    const thread = await getJson(origin, `/v1/operations/${operationId}/thread?workspace_id=${WS}`);
    expect(thread.status).toBe(200);
    const messages = (thread.body["items"] ?? []) as Array<Record<string, unknown>>;
    const userMessages = messages.filter((item) => item["kind"] === "message");
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
    expect(userMessages[0]).toMatchObject({
      text: "@agent_researcher please start the literature sweep",
      addressed_to: [RESEARCHER],
    });

    // The conversation journal carries the durable message row.
    const events = await getJson(
      origin,
      `/v1/conversations/${chatId}/events?workspace_id=${WS}&last_acknowledged_sequence=0`,
    );
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).toContain("literature sweep");

    // ── 8. The list surfaces agree (the app's sidebar and run cards) ──
    const list = await getJson(origin, `/v1/operations?workspace_id=${WS}`);
    expect(list.status).toBe(200);
    const listed = (list.body["operations"] as Array<Record<string, unknown>>).find(
      (row) => row["operation_id"] === operationId,
    );
    expect(listed).toBeDefined();

    // The run card drill-down: the run's events are readable with a cursor.
    const runEvents = await getJson(
      origin,
      `/v1/operations/${operationId}/runs/${runId}/events?workspace_id=${WS}`,
    );
    expect(runEvents.status).toBe(200);
    expect(runEvents.body).toHaveProperty("events");
  });

  it("launching before completing onboarding is NOT refused (zero-config start) but the state surfaces stay consistent", async () => {
    // The D16 zero-config start means the product works before the
    // interview: a pending-onboarding account may still launch. The feature
    // pin: the two surfaces' states never contradict each other.
    const other = await composeJourney();
    try {
      const before = (await getJson(other.origin, `/v1/onboarding?workspace_id=${WS}`)).body[
        "onboarding"
      ] as OnboardingSnapshot;
      expect(before.status).toBe("pending");

      const launch = await postJson(other.origin, "/v1/operations/launch", {
        workspace_id: WS,
        operation_definition_id: "operation_exam_preparation",
        roster_agent_ids: [RESEARCHER],
        coordinator_agent_id: RESEARCHER,
        idempotency_key: "idem_feature_j1_launch_pending_001",
        actor: { type: "user", id: "user_emon" },
        issued_at: "2026-11-10T10:06:00.000Z",
      });
      expect(launch.status).toBe(201);

      // Onboarding state is untouched by the launch (no forced jump, no
      // completed status invented behind the user's back).
      const after = (await getJson(other.origin, `/v1/onboarding?workspace_id=${WS}`)).body[
        "onboarding"
      ] as OnboardingSnapshot;
      expect(after.status).toBe("pending");
      expect(after.current_step).toBe("welcome");
    } finally {
      await other.close();
    }
  });
});
