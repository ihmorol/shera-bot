/**
 * FEATURE QA journey 2 — approval gate integrity.
 *
 * The user journey: an Agent's tool action pauses the run, the user sees the
 * D9 card, and the decision flows. The integrity pins the automated suites
 * could miss ACROSS surfaces:
 *
 *  - approve via the ONE grant path (approve-this-execution-only) resumes
 *    the run AND mints exactly one one-time grant;
 *  - the one-time grant is CONSUMED after the approved execution completes
 *    and a later identical proposal RE-PROMPTS (one approval buys one
 *    execution — the grant fast-path must not stay hot);
 *  - reject-this-action resumes the run and leaves NO grant, no pending
 *    residue;
 *  - cancelling the run while an approval is pending resolves the request as
 *    cancelled (never rejected), and a LATER decision attempt on it is
 *    refused cleanly with the typed already-resolved conflict — no grant,
 *    no resurrection;
 *  - an Agent actor is refused everywhere on the decision path (G6), and a
 *    refused prompt resolves nothing.
 */
import { afterAll, describe, expect, it } from "vitest";

import type { TaskRun } from "@shera-bot/contracts";

import { canonicalArgsDigest } from "../../apps/user-runtime/src/modules/tools/tool-executor.service.ts";
import type { ScriptedToolProposalConfig } from "../../apps/user-runtime/src/transport/local-api/s20-approvals-api.ts";
import {
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
  type FeatureRuntime,
} from "./helpers/runtime-harness.js";

const USER = { type: "user", id: "user_emon" } as const;
const GATED_AGENT = "agent_general_assistant";
const CONVERSATION = "conv_feature_j2";


const clockNow = "2026-11-10T12:00:00.000Z";

/** The gated scripted tool (EXTERNAL_WRITE — every decision is a prompt). */
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

interface TypedTrigger {
  event_id: string;
  stream_id: string;
  sequence: number;
  event_version: number;
  actor: { type: string; id: string };
  task_id: string;
  conversation_id: string;
  occurred_at: string;
  redaction_class: string;
  event_type: string;
  payload: Record<string, unknown>;
}

let runCounter = 0;

/** A typed trigger (D34) whose task id is unique per call, same conversation. */
function scriptedTrigger(): TypedTrigger {
  runCounter += 1;
  return {
    event_id: `evt_j2_trig_${runCounter}`,
    stream_id: `conversation:${CONVERSATION}`,
    sequence: 1,
    event_version: 1,
    actor: { type: "system", id: "scheduler" },
    task_id: `task_evt_j2_trig_${runCounter}`,
    conversation_id: CONVERSATION,
    occurred_at: clockNow,
    redaction_class: "internal",
    event_type: "trigger.scheduled",
    payload: { schedule_id: "sch_j2", due_at: clockNow },
  };
}

async function pendingList(origin: string) {
  return getJson(origin, `/v1/approvals/pending?workspace_id=${WS}`);
}

async function decide(
  origin: string,
  approvalId: string,
  choice: string,
  decidedBy: { type: string; id: string } = USER,
) {
  return postJson(origin, `/v1/approvals/${approvalId}/decision`, {
    workspace_id: WS,
    choice,
    decided_by: decidedBy,
  });
}

/** Wait (bounded) until the predicate holds; the last probe's value returns. */
async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: Awaited<T>) => boolean,
  ms = 3000,
): Promise<Awaited<T>> {
  const deadline = Date.now() + ms;
  let value = (await probe()) as Awaited<T>;
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = (await probe()) as Awaited<T>;
  }
  return value;
}

/** The run projection the executor's gate consults (the caller-held D5 view). */
function runProjection(taskId: string): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: "conv_j2_cancel_leg",
    created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_j2_cancel" },
    pack_snapshot: { pack_id: "student", pack_version: "1.0.0", pack_hash: "0".repeat(64) },
    roster: [GATED_AGENT],
    state: "RUNNING",
    version: 2,
    retry_count: 0,
    created_at: clockNow,
    updated_at: clockNow,
  };
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("J2: approval gate integrity", () => {
  it("the one grant path buys exactly one execution — a consumed one-time grant re-prompts", async () => {
    const journey = await composeJourney({
      now: () => clockNow,
      scriptedToolProposal: GATED_TOOL,
    });
    const { origin, runtime } = journey;
    try {
      // ── Run 1: the gated proposal pauses with the D9 card ──
      const first = runtime.harness.startRun(scriptedTrigger() as never);
      if (!first.ok) throw new Error(`the scripted run refused to start: ${first.code}`);
      expect(first.state).toBe("WAITING_FOR_APPROVAL");

      const pending = await pendingList(origin);
      expect(pending.status).toBe(200);
      const cards = pending.body["approvals"] as Array<Record<string, unknown>>;
      expect(cards).toHaveLength(1);
      const card = cards[0]!;
      expect(card).toMatchObject({
        tool_id: "tool_repo_push",
        tool_version: "1.2.0",
        risk_class: "EXTERNAL_WRITE",
        conversation_id: CONVERSATION,
        status: "pending",
        requested_by: { type: "agent", id: GATED_AGENT },
      });

      // ── Approve via the ONE grant path: the run resumes ──
      const approvalId = card["approval_id"] as string;
      const decision = await decide(origin, approvalId, "approve-this-execution-only");
      expect(decision.status).toBe(200);
      expect(decision.body["outcome"]).toBe("approved");
      expect((decision.body["run"] as Record<string, unknown>)["state"]).toBe("RUNNING");
      const grant = decision.body["grant"] as Record<string, unknown>;
      expect(grant).toMatchObject({
        one_time: true,
        principal_type: "agent",
        principal_id: GATED_AGENT,
        tool_id: "tool_repo_push",
        conversation_scope: CONVERSATION,
        args_digest: `sha256:${"b".repeat(64)}`,
      });

      // The pending list is empty; the run completes (the scripted harness
      // drives the resumed run to its terminal state).
      expect(((await pendingList(origin)).body["approvals"] ?? [])).toHaveLength(0);

      // ── The grant is CONSUMED once the approved execution completes ──
      const grants = await waitFor(
        async () =>
          ((await getJson(origin, `/v1/approvals/grants?workspace_id=${WS}`)).body[
            "grants"
          ] ?? []) as Array<Record<string, unknown>>,
        (rows) => rows.length === 1 && rows[0]!["consumed_at"] !== null,
      );
      expect(grants[0]).toMatchObject({ one_time: true });
      expect(grants[0]!["consumed_at"]).not.toBeNull();

      // ── Run 2: the SAME tool/args/conversation must RE-PROMPT ──
      // (If the consumed grant still authorized, this run would auto-execute.)
      const second = runtime.harness.startRun(scriptedTrigger() as never);
      if (!second.ok) throw new Error(`the second run refused to start: ${second.code}`);
      expect(second.state).toBe("WAITING_FOR_APPROVAL");
      const reprompt = (await pendingList(origin)).body["approvals"] as Array<
        Record<string, unknown>
      >;
      expect(reprompt).toHaveLength(1);
      expect(reprompt[0]!["approval_id"]).not.toBe(approvalId);
      // Exactly ONE grant still exists — the re-prompt created none.
      const grantsAfterReprompt = ((await getJson(
        origin,
        `/v1/approvals/grants?workspace_id=${WS}`,
      )).body["grants"] ?? []) as Array<Record<string, unknown>>;
      expect(grantsAfterReprompt).toHaveLength(1);
    } finally {
      await journey.close();
    }
  });

  it("reject-this-action resumes the run and leaves no grant, no pending residue", async () => {
    const journey = await composeJourney({
      now: () => clockNow,
      scriptedToolProposal: GATED_TOOL,
    });
    const { origin, runtime } = journey;
    try {
      const started = runtime.harness.startRun(scriptedTrigger() as never);
      if (!started.ok) throw new Error(`the scripted run refused to start: ${started.code}`);
      const cards = ((await pendingList(origin)).body["approvals"] ?? []) as Array<
        Record<string, unknown>
      >;
      const approvalId = cards[0]!["approval_id"] as string;

      const decision = await decide(origin, approvalId, "reject-this-action");
      expect(decision.status).toBe(200);
      expect(decision.body["outcome"]).toBe("action_rejected");
      // The run RESUMES (the run is not the thing rejected — the action is).
      expect((decision.body["run"] as Record<string, unknown>)["state"]).toBe("RUNNING");
      expect(decision.body["grant"]).toBeUndefined();

      // No residue: no grant anywhere, no pending card, and the detail read
      // shows the rejected stamp for the audit trail.
      expect(((await getJson(origin, `/v1/approvals/grants?workspace_id=${WS}`)).body["grants"] ?? [])).toHaveLength(0);
      expect(((await pendingList(origin)).body["approvals"] ?? [])).toHaveLength(0);
      const detail = await getJson(origin, `/v1/approvals/${approvalId}?workspace_id=${WS}`);
      expect((detail.body["approval"] as Record<string, unknown>)["status"]).toBe("rejected");
      expect((detail.body["approval"] as Record<string, unknown>)["resolved_by_choice"]).toBe(
        "reject-this-action",
      );
    } finally {
      await journey.close();
    }
  });

  it("cancelling the run resolves the pending approval as cancelled and a later decision is refused cleanly", async () => {
    // This leg uses a REAL operation run (the scripted harness runs are not
    // operation-scoped, and the user stop control is the operation run card's
    // cancel). The gated proposal rides the ONE executor path the gateway
    // itself uses (the S31 boot tests' arrangement) — every user-visible
    // surface below is HTTP.
    const journey = await composeJourney({ now: () => clockNow });
    const { origin, runtime } = journey;
    try {
      // A gated tool the runtime owns (D38): created through the inventory,
      // activated by the USER (an agent can never activate EXTERNAL_WRITE).
      runtime.toolsApi.createTool({
        workspace_id: WS,
        requested_by: { type: "agent", id: GATED_AGENT },
        actor: { type: "user", id: "user_emon" },
        tool: {
          tool_id: "tool_j2_cancel_leg",
          name: "Push the drafted notes",
          purpose: "The cancel leg's gated tool.",
          input_schema: { type: "object", properties: {}, required: [] },
          output_schema: { type: "object" },
          capabilities: ["repo.push"],
          risk_class: "EXTERNAL_WRITE",
          inventory_scope: "shared",
          recovery: "replayable",
        },
      });
      runtime.toolsApi.activateTool({
        workspace_id: WS,
        tool_id: "tool_j2_cancel_leg",
        version: "1.0.0",
        target: { kind: "agent", id: GATED_AGENT },
        actor: { type: "user", id: "user_emon" },
      });

      // A real Operation + run through the HTTP surface, moved to RUNNING.
      const created = await postJson(origin, "/v1/operations", {
        workspace_id: WS,
        definition_ref: null,
        name: "J2 cancel-leg operation",
        roster_agent_ids: [GATED_AGENT],
        coordinator_agent_id: GATED_AGENT,
      });
      expect(created.status).toBe(201);
      const operationId = (created.body as { operation_id: string }).operation_id;
      const run = await postJson(origin, `/v1/operations/${operationId}/runs`, {
        workspace_id: WS,
        run_id: "run_j2_cancel_leg",
      });
      expect(run.status).toBe(201);
      runtime.operations.applyRunState(WS, operationId, "run_j2_cancel_leg", "RUNNING");
      // The G2 creator's journal row for the run (the durable record the
      // approval detail's projection rebuild consults — the harness-less run
      // arrangement appends it through the runtime's own typed events path).
      runtime.events.appendEvent({
        workspace_id: WS,
        stream_id: "task:run_j2_cancel_leg",
        event_id: "evt_j2_cancel_created",
        type: "task.created",
        correlation_id: "corr_j2_cancel_leg",
        // task.* journal rows store the FULL D26 contract envelope.
        payload: {
          event_id: "evt_j2_cancel_created",
          stream_id: "task:run_j2_cancel_leg",
          sequence: 1,
          event_version: 1,
          actor: { type: "runtime", id: "runtime-gateway" },
          task_id: "run_j2_cancel_leg",
          conversation_id: "conv_j2_cancel_leg",
          occurred_at: clockNow,
          redaction_class: "internal",
          event_type: "task.created",
          payload: {
            trigger_event_type: "operation.confirmed",
            trigger_event_id: "evt_j2_cancel_operation",
            correlation_id: "corr_j2_cancel_leg",
            pack_snapshot: {
              pack_id: "student",
              pack_version: "1.0.0",
              pack_hash: "0".repeat(64),
            },
            roster: [GATED_AGENT],
          },
        },
      });

      // The gated proposal through the ONE executor path → the run pauses.
      const rawArgs = {};
      const outcome = runtime.tools.executeProposal({
        proposal: {
          workspace_id: WS,
          task_id: "run_j2_cancel_leg",
          conversation_id: "conv_j2_cancel_leg",
          tool_id: "tool_j2_cancel_leg",
          tool_version: "1.0.0",
          capability: "repo.push",
          args_digest: canonicalArgsDigest(rawArgs),
          proposal_summary: "the cancel leg's gated execution",
        },
        run: runProjection("run_j2_cancel_leg"),
        agent_id: GATED_AGENT,
        rawArgs,
        resource_scope: `workspace:${WS}`,
      });
      expect(outcome.outcome).toBe("paused_for_approval");

      const cards = ((await pendingList(origin)).body["approvals"] ?? []) as Array<
        Record<string, unknown>
      >;
      expect(cards).toHaveLength(1);
      const approvalId = cards[0]!["approval_id"] as string;

      // The USER stop control cancels the waiting run (the run card's cancel).
      const cancel = await postJson(
        origin,
        `/v1/operations/${operationId}/runs/run_j2_cancel_leg/cancel`,
        { workspace_id: WS, cancelled_by: { type: "user", id: "user_emon" } },
      );
      expect(cancel.status).toBe(200);
      expect(cancel.body["outcome"]).toBe("cancelled");

      // The pending approval is resolved as CANCELLED (never rejected).
      expect(((await pendingList(origin)).body["approvals"] ?? [])).toHaveLength(0);
      const detail = await getJson(origin, `/v1/approvals/${approvalId}?workspace_id=${WS}`);
      expect((detail.body["approval"] as Record<string, unknown>)["status"]).toBe("cancelled");

      // A LATER decision attempt is refused cleanly (typed conflict).
      const late = await decide(origin, approvalId, "approve-this-execution-only");
      expect(late.status).toBe(409);
      expect(late.body["code"]).toBe("APPROVAL_ALREADY_RESOLVED");
      // No grant minted by the late attempt, nothing resurrected.
      expect(((await getJson(origin, `/v1/approvals/grants?workspace_id=${WS}`)).body["grants"] ?? [])).toHaveLength(0);
    } finally {
      await journey.close();
    }
  });

  it("an Agent actor is refused on the decision path — a refused prompt resolves nothing (G6)", async () => {
    const journey = await composeJourney({
      now: () => clockNow,
      scriptedToolProposal: GATED_TOOL,
    });
    const { origin, runtime } = journey;
    try {
      const started = runtime.harness.startRun(scriptedTrigger() as never);
      if (!started.ok) throw new Error(`the scripted run refused to start: ${started.code}`);
      const cards = ((await pendingList(origin)).body["approvals"] ?? []) as Array<
        Record<string, unknown>
      >;
      const approvalId = cards[0]!["approval_id"] as string;

      // The requesting Agent itself: self-approval refusal.
      const self = await decide(origin, approvalId, "approve-this-execution-only", {
        type: "agent",
        id: GATED_AGENT,
      });
      expect(self.status).toBe(403);
      expect(self.body["code"]).toBe("AGENT_CANNOT_SELF_APPROVE");

      // A different Agent: no decision authority at all.
      const other = await decide(origin, approvalId, "approve-this-execution-only", {
        type: "agent",
        id: "agent_researcher",
      });
      expect(other.status).toBe(403);
      expect(other.body["code"]).toBe("AGENT_CANNOT_DECIDE_APPROVAL");

      // Nothing resolved: the card is still pending, no grant exists.
      expect(((await pendingList(origin)).body["approvals"] ?? [])).toHaveLength(1);
      expect(((await getJson(origin, `/v1/approvals/grants?workspace_id=${WS}`)).body["grants"] ?? [])).toHaveLength(0);
      void runtime;
    } finally {
      await journey.close();
    }
  });
});
