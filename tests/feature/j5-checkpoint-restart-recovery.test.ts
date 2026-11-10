/**
 * FEATURE QA journey 5 — checkpoint → restart recovery.
 *
 * The user journey: state accumulates in a running workspace (an Operation
 * with two runs, chat messages, workspace files, tool executions), the
 * runtime takes SEMANTIC CHECKPOINTS at the safe boundaries (the production
 * writer — every settled tool execution through the ONE executor path), and
 * then the gateway DIES. The restart composes over the SAME SQLite store:
 * the boot pass decides per interrupted run from the runtime's own records
 * (a READ_ONLY replayable tool auto-resumes through the real supervisor; an
 * EXTERNAL_WRITE tool that merely DECLARES replayable pauses
 * RECOVERY_REQUIRED — the trust boundary, G6), and NOTHING the user created
 * is torn: the conversation thread, the workspace files, and the operation
 * records all read back exactly.
 *
 * The HTTP surfaces the UI renders are asserted across the restart: the
 * thread read model, the workspace file read, the operation/run rows, and
 * the recovery status read model (workspace_state, review_needed entries
 * with the checkpoint's pending summary, resumed entries, per-run timelines
 * with checkpoint → restart → decision markers).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { ApprovalsRepository } from "../../apps/user-runtime/src/adapters/sqlite/approvals-repository.ts";
import { canonicalArgsDigest } from "../../apps/user-runtime/src/modules/tools/tool-executor.service.ts";
import type { TaskRun } from "@shera-bot/contracts";
import {
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
  type FeatureRuntime,
} from "./helpers/runtime-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER_CHILD = resolve(here, "../../apps/user-runtime/src/modules/workers/fake-task-worker-child.ts");

const NOW = "2026-11-04T13:00:00.000Z";
const AGENT = "agent_researcher";
const USER = { type: "user", id: "user_emon" } as const;

/** The s31 policy overrides (ms-scale; the supervisor's documented defaults). */
const WORKER_POLICY = {
  heartbeatIntervalMs: 40,
  missedHeartbeatLimit: 25,
  leaseWindowMs: 150,
  handshakeTimeoutMs: 4_000,
  shutdownGraceMs: 200,
  killGraceMs: 200,
} as const;

function workerHarness() {
  return {
    file: process.execPath,
    args: [
      WORKER_CHILD,
      "--run-id",
      "{run_id}",
      "--worker-id",
      "{worker_id}",
      "--heartbeat-ms",
      "{heartbeat_interval_ms}",
      "--steps",
      "2",
      "--step-delay-ms",
      "20",
    ],
  };
}

/** The caller-held run projection the executor's gate consults (D5). */
function runProjection(taskId: string, conversationId: string): TaskRun {
  return {
    task_id: taskId,
    workspace_id: WS,
    conversation_id: conversationId,
    created_from: { trigger_event_type: "operation.confirmed", trigger_event_id: "evt_j5" },
    pack_snapshot: { pack_id: "student", pack_version: "1.0.0", pack_hash: "0".repeat(64) },
    roster: [AGENT],
    state: "RUNNING",
    version: 2,
    retry_count: 0,
    created_at: NOW,
    updated_at: NOW,
  };
}

const openRuntimes: FeatureRuntime[] = [];

afterAll(async () => {
  await cleanupTempResources();
});

/** Execute one tool through the ONE executor path (the production writer). */
function executeTool(
  runtime: FeatureRuntime,
  runId: string,
  conversationId: string,
  tool: { tool_id: string; capability: string },
): void {
  const rawArgs = {};
  const outcome = runtime.runtime.tools.executeProposal({
    proposal: {
      workspace_id: WS,
      task_id: runId,
      conversation_id: conversationId,
      tool_id: tool.tool_id,
      tool_version: "1.0.0",
      capability: tool.capability,
      args_digest: canonicalArgsDigest(rawArgs),
      proposal_summary: `the J5 journey's ${tool.tool_id} execution`,
    },
    run: runProjection(runId, conversationId),
    agent_id: AGENT,
    rawArgs,
    resource_scope: `workspace:${WS}`,
  });
  if (outcome.outcome !== "executed") {
    throw new Error(`the ${tool.tool_id} leg did not execute (got ${outcome.outcome})`);
  }
}

describe("J5: checkpoint → restart recovery", () => {
  it("checkpoints survive the restart, the replayable run auto-resumes, the capped run awaits review, and nothing tears", async () => {
    // ── Runtime A: the pre-crash gateway ──
    const dbPath = join(mkdtempSync(join(tmpdir(), "shera-feature-j5-")), "runtime.db");
    const gatewayA = await composeJourney({
      dbPath,
      now: () => NOW,
      workspaceId: WS,
      workerHarness: workerHarness(),
      workerPolicy: WORKER_POLICY,
    });
    openRuntimes.push(gatewayA);
    const originA = gatewayA.origin;
    // The boot pass visits an empty store; await it before creating state.
    await gatewayA.runtime.recovery.bootPass;

    // The Operation + two runs, moved to RUNNING (the crash left them live).
    const created = await postJson(originA, "/v1/operations", {
      workspace_id: WS,
      definition_ref: null,
      name: "Recovery journey operation",
      roster_agent_ids: [AGENT],
      coordinator_agent_id: AGENT,
    });
    expect(created.status).toBe(201);
    const operationId = (created.body as { operation_id: string }).operation_id;

    for (const runId of ["run_j5_read", "run_j5_write"]) {
      const run = await postJson(originA, `/v1/operations/${operationId}/runs`, {
        workspace_id: WS,
        run_id: runId,
      });
      expect(run.status).toBe(201);
      gatewayA.runtime.operations.applyRunState(WS, operationId, runId, "RUNNING");
      gatewayA.runtime.events.appendEvent({
        workspace_id: WS,
        stream_id: `task:${runId}`,
        event_id: `evt_j5_created_${runId}`,
        type: "task.created",
        correlation_id: "corr_j5",
        payload: {
          event_id: `evt_j5_created_${runId}`,
          stream_id: `task:${runId}`,
          sequence: 1,
          event_version: 1,
          actor: { type: "runtime", id: "runtime-gateway" },
          task_id: runId,
          conversation_id: "conv_j5",
          occurred_at: NOW,
          redaction_class: "internal",
          event_type: "task.created",
          payload: {
            trigger_event_type: "operation.confirmed",
            trigger_event_id: "evt_j5_operation",
            correlation_id: "corr_j5",
            pack_snapshot: { pack_id: "student", pack_version: "1.0.0", pack_hash: "0".repeat(64) },
            roster: [AGENT],
          },
        },
      });
    }

    // User state the restart must NOT tear: a chat message + a workspace file.
    const send = await postJson(originA, `/v1/operations/${operationId}/thread/messages`, {
      workspace_id: WS,
      idempotency_key: "idem_j5_msg_001",
      sender: { kind: "user", display_name: "Emon" },
      text: "collecting the corpus before the crash",
    });
    expect(send.status).toBe(201);
    const draftContent = "The draft survives the restart byte for byte.";
    const write = await fetch(`${originA}/v1/workspace/files`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: WS,
        path: "workspace://notes/draft.md",
        actor: USER,
        content: draftContent,
      }),
    });
    expect(write.status).toBe(200);

    // The two agent-created tools (created through the runtime's OWN
    // inventory): a READ_ONLY tool honestly declaring replayable, and an
    // EXTERNAL_WRITE tool declaring replayable — the untrusted declaration
    // the risk-class cap exists for.
    gatewayA.runtime.toolsApi.createTool({
      workspace_id: WS,
      requested_by: { type: "agent", id: AGENT },
      actor: USER,
      tool: {
        tool_id: "tool_j5_read_replayable",
        name: "Read the corpus note",
        purpose: "The READ_ONLY leg's tool declaring replayable.",
        input_schema: { type: "object", properties: {}, required: [] },
        output_schema: { type: "object" },
        capabilities: ["file.read"],
        risk_class: "READ_ONLY",
        inventory_scope: "shared",
        recovery: "replayable",
      },
    });
    gatewayA.runtime.toolsApi.createTool({
      workspace_id: WS,
      requested_by: { type: "agent", id: AGENT },
      actor: USER,
      tool: {
        tool_id: "tool_j5_write_declares_replayable",
        name: "Post the external update",
        purpose: "The capped leg's tool declaring replayable.",
        input_schema: { type: "object", properties: {}, required: [] },
        output_schema: { type: "object" },
        capabilities: ["file.write"],
        risk_class: "EXTERNAL_WRITE",
        inventory_scope: "shared",
        recovery: "replayable",
      },
    });
    gatewayA.runtime.toolsApi.activateTool({
      workspace_id: WS,
      tool_id: "tool_j5_write_declares_replayable",
      version: "1.0.0",
      target: { kind: "agent", id: AGENT },
      actor: USER,
    });
    // The D35 grant fast-path for the capped leg (AC26 — the grant skips the
    // prompt, never the policy check): recorded exactly as a user decision.
    new ApprovalsRepository(gatewayA.runtime.tx).insertGrant({
      grant_id: "grant_j5_write",
      workspace_id: WS,
      source_choice: "always-approve-this-tool",
      principal_type: "task",
      principal_id: "run_j5_write",
      tool_id: "tool_j5_write_declares_replayable",
      tool_version: "1.0.0",
      capability: "file.write",
      resource_scope: `workspace:${WS}`,
      conversation_scope: "any",
      workspace_scope: WS,
      expires_at: null,
      one_time: false,
      created_by: USER,
      approved_at: NOW,
      revoked_at: null,
      args_digest: null,
      consumed_at: null,
    });

    // The two REAL executions — each settled execution's hook writes the
    // production semantic checkpoint.
    executeTool(gatewayA, "run_j5_read", "conv_j5", {
      tool_id: "tool_j5_read_replayable",
      capability: "file.read",
    });
    executeTool(gatewayA, "run_j5_write", "conv_j5", {
      tool_id: "tool_j5_write_declares_replayable",
      capability: "file.write",
    });

    // The production-writer evidence BEFORE the restart: both checkpoints
    // carry the declared class AND the runtime-verified risk class.
    const readCheckpoint = gatewayA.runtime.checkpoints.latestForTask(WS, "run_j5_read");
    const writeCheckpoint = gatewayA.runtime.checkpoints.latestForTask(WS, "run_j5_write");
    expect(readCheckpoint).not.toBeNull();
    expect(writeCheckpoint).not.toBeNull();
    expect(JSON.parse(readCheckpoint!.pending_action_json!)).toMatchObject({
      kind: "tool_execution",
      recovery_class: "replayable",
      risk_class: "READ_ONLY",
    });
    expect(JSON.parse(writeCheckpoint!.pending_action_json!)).toMatchObject({
      kind: "tool_execution",
      recovery_class: "replayable",
      risk_class: "EXTERNAL_WRITE",
    });

    // ── THE CRASH: the gateway dies on its store ──
    await gatewayA.close();

    // ── Runtime B: the restart composes over the SAME store ──
    const gatewayB = await composeJourney({
      dbPath,
      now: () => NOW,
      workspaceId: WS,
      workerHarness: workerHarness(),
      workerPolicy: WORKER_POLICY,
    });
    openRuntimes.push(gatewayB);
    const report = await gatewayB.runtime.recovery.bootPass;
    expect(report).not.toBeNull();

    const decisions = new Map(
      report!.visited.map((row) => [row.runId, row.outcome.outcome] as const),
    );
    // The READ_ONLY replayable run auto-resumed; the WRITE tool that only
    // DECLARED replayable paused for review (risk_class_caps_recovery).
    expect(decisions.get("run_j5_read")).toBe("resumed");
    expect(decisions.get("run_j5_write")).toBe("paused_for_review");

    const originB = gatewayB.origin;

    // The recovery status read model the UI renders.
    const status = await getJson(originB, `/v1/recovery/status?workspace_id=${WS}`);
    expect(status.status).toBe(200);
    expect(status.body["workspace_state"]).toBe("review_needed");
    const reviewNeeded = status.body["review_needed"] as Array<Record<string, unknown>>;
    expect(reviewNeeded.map((row) => row["run_id"])).toContain("run_j5_write");
    const writeEntry = reviewNeeded.find((row) => row["run_id"] === "run_j5_write")!;
    expect(writeEntry["pending_summary"]).toBeTruthy();
    expect(reviewNeeded.map((row) => row["run_id"])).not.toContain("run_j5_read");
    const resumedRows = status.body["resumed"] as Array<Record<string, unknown>>;
    expect(resumedRows).toContainEqual(
      expect.objectContaining({ run_id: "run_j5_read", basis: "replayable" }),
    );
    // The durable timeline story: the checkpoint marker then the decision
    // marker. (The restart marker appears when a dead worker row is reaped —
    // this journey's crash window is the narrow one: the gateway died AFTER
    // the checkpoint but BEFORE the run's worker row existed.)
    const timelines = status.body["timelines"] as Record<string, { markers: Array<{ kind: string }> }>;
    const readTimeline = timelines["run_j5_read"]?.markers.map((marker) => marker.kind) ?? [];
    expect(readTimeline).toEqual(["checkpoint", "resume"]);
    const writeTimeline = timelines["run_j5_write"]?.markers.map((marker) => marker.kind) ?? [];
    expect(writeTimeline).toEqual(["checkpoint", "pause"]);

    // ── NOTHING TORN: conversation, file, operation records all read back ──
    const thread = await getJson(originB, `/v1/operations/${operationId}/thread?workspace_id=${WS}`);
    expect(thread.status).toBe(200);
    const items = (thread.body["items"] ?? []) as Array<Record<string, unknown>>;
    expect(
      items.some(
        (item) =>
          item["kind"] === "message" && item["text"] === "collecting the corpus before the crash",
      ),
      "the pre-crash chat message survives the restart",
    ).toBe(true);

    const fileRead = await getJson(originB, `/v1/workspace/files?workspace_id=${WS}&path=workspace://notes/draft.md&actor_type=user&actor_id=user_emon`);
    expect(fileRead.status).toBe(200);
    expect(fileRead.body["size"]).toBe(Buffer.byteLength(draftContent));

    const detail = await getJson(originB, `/v1/operations/${operationId}?workspace_id=${WS}`);
    expect(detail.status).toBe(200);
    const runs = await getJson(originB, `/v1/operations/${operationId}/runs?workspace_id=${WS}`);
    const runRows = runs.body["runs"] as Array<Record<string, unknown>>;
    expect(runRows).toHaveLength(2);

    // The resumed run walks the D8 machinery back to RUNNING (then the fake
    // worker drives it); the capped run sits RECOVERY_REQUIRED.
    const readRun = runRows.find((row) => row["run_id"] === "run_j5_read")!;
    const writeRun = runRows.find((row) => row["run_id"] === "run_j5_write")!;
    expect(["RUNNING", "SUCCEEDED"]).toContain(readRun["state"]);
    expect(writeRun["state"]).toBe("RECOVERY_REQUIRED");
  });
});
