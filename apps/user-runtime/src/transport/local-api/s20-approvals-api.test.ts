/**
 * S20 chunk 4 — the approvals HTTP API contract (issue #21; D9, PRD §8, E12,
 * E3, G2/G3/G6). Red-first: these tests pin the chunk-4 behaviors before the
 * API module exists.
 *
 * The composed runtime exposes the approvals service through the local API:
 *
 *   1. The pending list answers the D9 approval card exactly (tool+version,
 *      args digest, side-effect summary, target resource, risk class, expiry,
 *      requesting Agent, conversation/task scope) — digest-only, never raw
 *      arguments (G3).
 *   2. The scripted lifecycle trigger rides the G4 scripted-harness seam: a
 *      TYPED tool.proposed proposal whose risk class is gated pauses the run
 *      (WAITING_FOR_APPROVAL) and files a pending approval; a read-only
 *      proposal runs automatically and pauses nothing (G6).
 *   3. The five PRD §8 choices each go through POST decision; the resume is
 *      visible in the run state (RUNNING again via the D8 machinery).
 *   4. The SAME decision replayed is idempotent (200 already_decided with the
 *      stored resolution); a DIFFERENT choice on a resolved request is the
 *      typed 409 (decisions are immutable — D9).
 *   5. An Agent actor is refused (403): agents never decide approvals — and
 *      never self-approve (G6; a prompt-shaped input creates NO grant).
 *   6. Revoking a grant through the API refuses the NEXT recheck (AC26) — the
 *      grant never skips the deterministic policy check.
 *   7. Every route is workspace-scoped (E12): another workspace's approval is
 *      invisible and its decision is refused (404), never silently applied.
 *   8. The approval detail carries the five E3 reminder slots with their
 *      delivered_at stamps; GET due-reminders fires the due slots (delivery
 *      NEVER changes run state — D32/E3) and mutes suppress notifications
 *      only.
 */
import { join, resolve as resolvePath } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { TypedExecutionEvent } from "@shera-bot/contracts";

import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { openDatabase } from "../../adapters/sqlite/connection.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import type { ScriptedToolProposalConfig } from "./s20-approvals-api.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The pinned student pack: the cancel-cascade test rosters a REAL pack Agent. */
const PACKS_ROOT = resolvePath(here, "../../../../../agent-packs");

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const FOREIGN_WORKSPACE = "ws-other-0000";
const USER = { type: "user", id: "user_001" } as const;
const GATED_AGENT = "agent_general_assistant";

/** The scripted demo tool definition (runtime-owned, D38) — GATED class. */
const GATED_TOOL = {
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
} as const;

/** The read-only demo tool — the ladder's only automatic class (G6). */
const READ_ONLY_TOOL = {
  ...GATED_TOOL,
  tool: {
    ...GATED_TOOL.tool,
    tool_id: "tool_file_read",
    tool_version: "1.2.0",
    capability: "file.read",
    risk_class: "READ_ONLY",
    resource_scope: "workspace://notes/draft.md",
    side_effect_summary: "Reads the draft notes from the workspace.",
  },
} as const;

let clockNow = "2026-10-28T12:00:00.000Z";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

async function composeOn(
  scriptedToolProposal: ScriptedToolProposalConfig | undefined,
): Promise<RunningRuntime> {
  const dir = makeTempDir("shera-s20-approvals-api-");
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    packsRoot: PACKS_ROOT,
    now: () => clockNow,
    ...(scriptedToolProposal !== undefined ? { scriptedToolProposal } : {}),
  });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) => runtime.httpServer.listen(0, "127.0.0.1", resolveListen));
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dbPath: join(dir, "runtime.db"),
    close: () => runtime.close(),
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A typed trigger (D34/G2) whose derived task id is unique per call. */
function scriptedTrigger(n: number): TypedExecutionEvent {
  return {
    event_id: `evt_s20_trig_${n}`,
    stream_id: "conversation:conv_s20_001",
    sequence: 1,
    event_version: 1,
    actor: { type: "system", id: "scheduler" },
    task_id: `task_evt_s20_trig_${n}`,
    conversation_id: "conv_s20_001",
    occurred_at: clockNow,
    redaction_class: "internal",
    event_type: "trigger.scheduled",
    payload: { schedule_id: "sch_s20_001", due_at: clockNow },
  };
}

let runCounter = 0;

/** Start one scripted run; it ends WAITING_FOR_APPROVAL on the gated tool. */
function startScriptedRun(runtime: RuntimeHandle): { taskId: string; state: string; version: number } {
  runCounter += 1;
  const result = runtime.harness.startRun(scriptedTrigger(runCounter));
  if (!result.ok) {
    throw new Error(`the scripted run refused to start: ${result.code}`);
  }
  return { taskId: result.task_id, state: result.state, version: result.version };
}

async function pendingList(origin: string, workspaceId: string = WORKSPACE) {
  return getJson(origin, `/v1/approvals/pending?workspace_id=${workspaceId}`);
}

async function decide(
  origin: string,
  approvalId: string,
  choice: string,
  decidedBy: Record<string, unknown> = USER,
  workspaceId: string = WORKSPACE,
) {
  return postJson(origin, `/v1/approvals/${approvalId}/decision`, {
    workspace_id: workspaceId,
    choice,
    decided_by: decidedBy,
  });
}

/**
 * Seed one task-scoped child run through the operations REPOSITORY on a
 * second connection (the chunk-2 arrangement; arrangement writes stay inside
 * the repository — no SQL here). Returns the seeded row.
 */
function seedChildRun(dbPath: string, parentTaskId: string, runId: string) {
  const conn = openDatabase(dbPath);
  try {
    const row = {
      run_id: runId,
      workspace_id: WORKSPACE,
      operation_id: "op_s20_children",
      parent_task_id: parentTaskId,
      state: "RUNNING" as const,
      events_seq_cursor: 0,
      credits: {} as Record<string, unknown>,
      artifacts: [] as string[],
      created_at: clockNow,
      updated_at: clockNow,
    };
    new OperationsRepository(new SqliteTransactions(conn.db)).createRun(WORKSPACE, row);
    return row;
  } finally {
    conn.close();
  }
}

/** Re-read one child run through the repository on a second connection. */
function readChildRun(dbPath: string, parentTaskId: string, runId: string) {
  const conn = openDatabase(dbPath);
  try {
    return new OperationsRepository(new SqliteTransactions(conn.db))
      .listRunsByParentTaskId(WORKSPACE, parentTaskId)
      .find((row) => row.run_id === runId);
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// 1 + 2. The scripted trigger pauses a gated proposal; the card is exact
// ---------------------------------------------------------------------------

describe("S20 approvals API: the scripted trigger and the D9 card", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
  });

  it("pauses a gated scripted proposal and answers the exact D9 card fields", async () => {
    env = await composeOn(GATED_TOOL);
    const run = startScriptedRun(env.runtime);

    // The pause went through the D8 machinery: RUNNING -> WAITING_FOR_APPROVAL.
    expect(run.state).toBe("WAITING_FOR_APPROVAL");
    expect(run.version).toBe(4);

    const list = await pendingList(env.origin);
    expect(list.status).toBe(200);
    const approvals = list.body["approvals"] as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    const card = approvals[0]!;
    // Exactly the D9 card fields: tool+version, args digest (presence + value,
    // digest-only — G3), side effect, target resource, risk class, expiry,
    // requesting Agent, and the conversation/task scope.
    expect(card).toMatchObject({
      approval_id: expect.stringMatching(/^apr_/),
      workspace_id: WORKSPACE,
      task_id: run.taskId,
      conversation_id: "conv_s20_001",
      tool_id: "tool_repo_push",
      tool_version: "1.2.0",
      capability: "repo.push",
      risk_class: "EXTERNAL_WRITE",
      resource_scope: "workspace://notes/draft.md",
      args_digest: `sha256:${"b".repeat(64)}`,
      side_effect_summary: "Pushes local commits to the configured remote repository.",
      requested_by: { type: "agent", id: GATED_AGENT },
      status: "pending",
      expires_at: null,
    });
    expect("resolved_at" in card).toBe(false);

    // The detail answers the same card plus the reminder slots and the run.
    const approvalId = card["approval_id"] as string;
    const detail = await getJson(
      env.origin,
      `/v1/approvals/${approvalId}?workspace_id=${WORKSPACE}`,
    );
    expect(detail.status).toBe(200);
    expect((detail.body["approval"] as Record<string, unknown>)["tool_id"]).toBe("tool_repo_push");
    const reminders = detail.body["reminders"] as Array<Record<string, unknown>>;
    expect(reminders).toHaveLength(5);
    expect(reminders.map((row) => row["reminder_index"])).toEqual([0, 1, 2, 3, 4]);
    for (const row of reminders) {
      expect(row["delivered_at"]).toBeNull();
    }
    // The run read model comes from the journal (the durable record).
    expect(detail.body["run"]).toMatchObject({
      task_id: run.taskId,
      state: "WAITING_FOR_APPROVAL",
      version: 4,
    });
  });

  it("runs a read-only scripted proposal automatically and pauses nothing (G6)", async () => {
    env = await composeOn(READ_ONLY_TOOL);
    const run = startScriptedRun(env.runtime);

    // The scripted tool proposal ran automatically; the fake script completes.
    expect(run.state).toBe("SUCCEEDED");
    const list = await pendingList(env.origin);
    expect(list.body["approvals"]).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4 + 5. The five choices via API; idempotency; agent actors refused
// ---------------------------------------------------------------------------

describe("S20 approvals API: decisions", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
  });

  it("approve-this-execution-only resumes the run and creates the one-time grant", async () => {
    env = await composeOn(GATED_TOOL);
    const run = startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ??
      []) as Array<Record<string, unknown>>;
    const approvalId = approvals[0]!["approval_id"] as string;

    const decision = await decide(env.origin, approvalId, "approve-this-execution-only");
    expect(decision.status).toBe(200);
    expect(decision.body["outcome"]).toBe("approved");
    // The resume is visible in the run state (the D8 machinery advanced it).
    expect(decision.body["run"]).toMatchObject({ task_id: run.taskId, state: "RUNNING" });
    const grant = decision.body["grant"] as Record<string, unknown>;
    expect(grant).toMatchObject({
      one_time: true,
      principal_type: "agent",
      principal_id: GATED_AGENT,
      tool_id: "tool_repo_push",
      tool_version: "1.2.0",
      conversation_scope: "conv_s20_001",
      args_digest: `sha256:${"b".repeat(64)}`,
    });
    // The pending list no longer carries the request.
    expect(((await pendingList(env.origin)).body["approvals"] ?? [])).toHaveLength(0);
    // The resolved detail still answers, with the stamp and the RUNNING run.
    const detail = await getJson(env.origin, `/v1/approvals/${approvalId}?workspace_id=${WORKSPACE}`);
    expect((detail.body["approval"] as Record<string, unknown>)["status"]).toBe("approved");
    expect((detail.body["run"] as Record<string, unknown>)["state"]).toBe("RUNNING");
  });

  it("always-approve-this-tool creates the reusable task-principal grant", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const decision = await decide(env.origin, approvalId, "always-approve-this-tool");
    expect(decision.status).toBe(200);
    expect(decision.body["outcome"]).toBe("approved");
    const grant = decision.body["grant"] as Record<string, unknown>;
    expect(grant).toMatchObject({
      one_time: false,
      principal_type: "task",
      args_digest: null,
    });
    expect((decision.body["run"] as Record<string, unknown>)["state"]).toBe("RUNNING");

    // The active-grants list carries it with scope, tool+version, and creator.
    const grants = await getJson(env.origin, `/v1/approvals/grants?workspace_id=${WORKSPACE}`);
    expect(grants.status).toBe(200);
    const listed = grants.body["grants"] as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      grant_id: grant["grant_id"],
      principal_type: "task",
      conversation_scope: "conv_s20_001",
      workspace_scope: WORKSPACE,
      revoked_at: null,
      created_by: USER,
    });
  });

  it("always-approve-this-tool-for-this-agent creates the agent-bound reusable grant", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const decision = await decide(env.origin, approvalId, "always-approve-this-tool-for-this-agent");
    expect(decision.status).toBe(200);
    expect(decision.body["outcome"]).toBe("approved");
    expect(decision.body["grant"]).toMatchObject({
      one_time: false,
      principal_type: "agent",
      principal_id: GATED_AGENT,
    });
  });

  it("reject-this-action denies the action, resumes the run, and creates NO grant", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const decision = await decide(env.origin, approvalId, "reject-this-action");
    expect(decision.status).toBe(200);
    expect(decision.body["outcome"]).toBe("action_rejected");
    expect((decision.body["run"] as Record<string, unknown>)["state"]).toBe("RUNNING");
    expect(decision.body["grant"]).toBeUndefined();
    expect(((await getJson(env.origin, `/v1/approvals/grants?workspace_id=${WORKSPACE}`)).body["grants"] ?? [])).toHaveLength(0);
  });

  it("cancel-the-task cancels the run and its child run in the same unit", async () => {
    env = await composeOn(GATED_TOOL);
    const run = startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    // One child run (D34/D46 delegation link, parent_task_id = the TASK's id)
    // seeded at the repository level — the S13 run route scopes its parent
    // link to Operation runs, while the approval cascade is task-scoped (the
    // same arrangement the chunk-2 service suite uses).
    const child = seedChildRun(env.dbPath, run.taskId, "run_s20_child");
    expect(child.state).toBe("RUNNING");

    const decision = await decide(env.origin, approvalId, "cancel-the-task");
    expect(decision.status).toBe(200);
    expect(decision.body["outcome"]).toBe("task_cancelled");
    expect(decision.body["run"]).toMatchObject({ task_id: run.taskId, state: "CANCELLED" });
    expect(decision.body["cancelled_child_run_ids"]).toEqual(["run_s20_child"]);

    // The child row is CANCELLED durably (read on a second connection — the
    // honest cross-connection check, no SQL outside the repository).
    const reread = readChildRun(env.dbPath, run.taskId, "run_s20_child");
    expect(reread?.state).toBe("CANCELLED");
  });

  it("replays the SAME decision idempotently (200 already_decided, stored resolution) and refuses a DIFFERENT choice", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const first = await decide(env.origin, approvalId, "approve-this-execution-only");
    expect(first.status).toBe(200);
    const grantsAfterFirst = ((await getJson(env.origin, `/v1/approvals/grants?workspace_id=${WORKSPACE}`)).body["grants"] ?? []) as Array<Record<string, unknown>>;
    expect(grantsAfterFirst).toHaveLength(1);

    // Two tabs / a retried call: the stored resolution is returned, nothing
    // re-applied — no second grant, no second journal event.
    const replay = await decide(env.origin, approvalId, "approve-this-execution-only");
    expect(replay.status).toBe(200);
    expect(replay.body["outcome"]).toBe("already_decided");
    expect(replay.body["choice"]).toBe("approve-this-execution-only");
    expect((replay.body["request"] as Record<string, unknown>)["status"]).toBe("approved");
    const grantsAfterReplay = ((await getJson(env.origin, `/v1/approvals/grants?workspace_id=${WORKSPACE}`)).body["grants"] ?? []) as Array<Record<string, unknown>>;
    expect(grantsAfterReplay).toHaveLength(1);

    // A different choice on the resolved request is the typed immutable refusal.
    const conflict = await decide(env.origin, approvalId, "reject-this-action");
    expect(conflict.status).toBe(409);
    expect(conflict.body["code"]).toBe("APPROVAL_ALREADY_RESOLVED");
  });

  it("refuses an Agent actor with the typed 403 — agents never decide, never self-approve (G6)", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const self = await decide(env.origin, approvalId, "approve-this-execution-only", {
      type: "agent",
      id: GATED_AGENT,
    });
    expect(self.status).toBe(403);
    expect(self.body["code"]).toBe("AGENT_CANNOT_SELF_APPROVE");

    const other = await decide(env.origin, approvalId, "approve-this-execution-only", {
      type: "agent",
      id: "agent_other_observer",
    });
    expect(other.status).toBe(403);
    expect(other.body["code"]).toBe("AGENT_CANNOT_DECIDE_APPROVAL");

    // A prompt-shaped input created NO grant and resolved NOTHING (G6).
    expect(((await getJson(env.origin, `/v1/approvals/grants?workspace_id=${WORKSPACE}`)).body["grants"] ?? [])).toHaveLength(0);
    expect(((await pendingList(env.origin)).body["approvals"] ?? [])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Revoke through the API refuses the next recheck (AC26)
// ---------------------------------------------------------------------------

describe("S20 approvals API: grants and revocation", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
  });

  it("revokes the grant and the NEXT recheck is refused — a grant never skips the policy check", async () => {
    env = await composeOn(GATED_TOOL);
    const run = startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const decision = await decide(env.origin, approvalId, "always-approve-this-tool");
    expect(decision.status).toBe(200);
    const grantId = (decision.body["grant"] as Record<string, unknown>)["grant_id"] as string;

    // Before revocation the recheck passes on the granted principal.
    const before = env.runtime.approvals!.checkExecutionAllowed({
      workspace_id: WORKSPACE,
      principal: { type: "task", id: run.taskId },
      tool_id: "tool_repo_push",
      tool_version: "1.2.0",
      capability: "repo.push",
      resource_scope: "workspace://notes/draft.md",
      args_digest: `sha256:${"b".repeat(64)}`,
      acting_conversation_id: "conv_s20_001",
    });
    expect(before).toMatchObject({ allowed: true, grant_id: grantId });

    const revoke = await postJson(env.origin, "/v1/approvals/grants/revoke", {
      workspace_id: WORKSPACE,
      grant_id: grantId,
    });
    expect(revoke.status).toBe(200);
    expect(revoke.body["revoked"]).toBe(true);

    // The revoked grant no longer appears in the active list.
    const grants = ((await getJson(env.origin, `/v1/approvals/grants?workspace_id=${WORKSPACE}`)).body["grants"] ?? []) as Array<Record<string, unknown>>;
    expect(grants).toHaveLength(0);

    // AC26: the next execution consult refuses — fail-closed.
    const after = env.runtime.approvals!.checkExecutionAllowed({
      workspace_id: WORKSPACE,
      principal: { type: "task", id: run.taskId },
      tool_id: "tool_repo_push",
      tool_version: "1.2.0",
      capability: "repo.push",
      resource_scope: "workspace://notes/draft.md",
      args_digest: `sha256:${"b".repeat(64)}`,
      acting_conversation_id: "conv_s20_001",
    });
    expect(after).toMatchObject({ allowed: false, reason: "no_active_grant" });

    // An unknown grant id is a typed 404, not a silent success.
    const missing = await postJson(env.origin, "/v1/approvals/grants/revoke", {
      workspace_id: WORKSPACE,
      grant_id: "grt_does_not_exist",
    });
    expect(missing.status).toBe(404);
    expect(missing.body["code"]).toBe("APPROVAL_GRANT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// 7. Workspace scoping (E12) on every route
// ---------------------------------------------------------------------------

describe("S20 approvals API: workspace scoping (E12)", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
  });

  it("hides the approval from another workspace and refuses its decision", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    // The foreign workspace's reads see nothing of this approval.
    expect(((await pendingList(env.origin, FOREIGN_WORKSPACE)).body["approvals"] ?? [])).toHaveLength(0);
    const foreignDetail = await getJson(
      env.origin,
      `/v1/approvals/${approvalId}?workspace_id=${FOREIGN_WORKSPACE}`,
    );
    expect(foreignDetail.status).toBe(404);

    // The decision from the foreign workspace is refused typed, and the
    // request stays pending in its OWN workspace.
    const foreignDecision = await decide(
      env.origin,
      approvalId,
      "approve-this-execution-only",
      USER,
      FOREIGN_WORKSPACE,
    );
    expect(foreignDecision.status).toBe(404);
    expect(foreignDecision.body["code"]).toBe("APPROVAL_REQUEST_NOT_FOUND");
    expect(((await pendingList(env.origin)).body["approvals"] ?? [])).toHaveLength(1);

    // Grants and mutes are equally scoped: nothing leaks across.
    expect(((await getJson(env.origin, `/v1/approvals/grants?workspace_id=${FOREIGN_WORKSPACE}`)).body["grants"] ?? [])).toHaveLength(0);
    const foreignRevoke = await postJson(env.origin, "/v1/approvals/grants/revoke", {
      workspace_id: FOREIGN_WORKSPACE,
      grant_id: "grt_whatever",
    });
    expect(foreignRevoke.status).toBe(404);
  });

  it("requires a workspace_id on every route", async () => {
    env = await composeOn(GATED_TOOL);
    expect((await getJson(env.origin, "/v1/approvals/pending")).status).toBe(400);
    expect((await postJson(env.origin, "/v1/approvals/mutes", { scope: "all" })).status).toBe(400);
    expect((await getJson(env.origin, "/v1/approvals/due-reminders")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 8. Mutes + the reminder tick (E3; delivery never changes run state)
// ---------------------------------------------------------------------------

describe("S20 approvals API: mutes and due reminders", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
  });

  it("records and lists mutes per workspace, with their creating user actor (S20 review fix F2)", async () => {
    env = await composeOn(GATED_TOOL);
    const mute = await postJson(env.origin, "/v1/approvals/mutes", {
      workspace_id: WORKSPACE,
      scope: "task",
      target_id: "task_evt_s20_trig_1",
      created_by: USER,
    });
    expect(mute.status).toBe(201);
    expect(mute.body).toMatchObject({
      workspace_id: WORKSPACE,
      scope: "task",
      target_id: "task_evt_s20_trig_1",
      created_by: "user_001",
    });

    const all = await postJson(env.origin, "/v1/approvals/mutes", {
      workspace_id: WORKSPACE,
      scope: "all",
      created_by: USER,
    });
    expect(all.status).toBe(201);
    expect(all.body["target_id"]).toBeNull();

    // A task-scope mute without its target id is the typed 400.
    expect(
      (await postJson(env.origin, "/v1/approvals/mutes", { workspace_id: WORKSPACE, scope: "task", created_by: USER }))
        .status,
    ).toBe(400);

    const list = await getJson(env.origin, `/v1/approvals/mutes?workspace_id=${WORKSPACE}`);
    expect(list.status).toBe(200);
    const mutes = list.body["mutes"] as Array<Record<string, unknown>>;
    expect(mutes).toHaveLength(2);
    // The audit record: every mute row names the user actor that created it.
    expect(mutes.every((row) => row["created_by"] === "user_001")).toBe(true);
  });

  it("refuses a mute without a user actor (typed 400) — the browser path binds it server-side from the session", async () => {
    env = await composeOn(GATED_TOOL);

    // No actor at all.
    const actorless = await postJson(env.origin, "/v1/approvals/mutes", {
      workspace_id: WORKSPACE,
      scope: "all",
    });
    expect(actorless.status).toBe(400);
    expect(actorless.body["code"]).toBe("CONTRACT_VALIDATION_FAILED");

    // An Agent actor is refused by the service (only users mute — G6 family).
    const agent = await postJson(env.origin, "/v1/approvals/mutes", {
      workspace_id: WORKSPACE,
      scope: "all",
      created_by: { type: "agent", id: GATED_AGENT },
    });
    expect(agent.status).toBe(400);
    expect(agent.body["code"]).toBe("APPROVAL_MUTE_INVALID");

    expect(((await getJson(env.origin, `/v1/approvals/mutes?workspace_id=${WORKSPACE}`)).body["mutes"] ?? [])).toHaveLength(0);
  });

  it("fires due reminders (delivered_at stamped), enforces mutes, and NEVER changes run state", async () => {
    env = await composeOn(GATED_TOOL);
    const run = startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    // Mute the TASK first: notifications suppressed, the approval stays pending.
    await postJson(env.origin, "/v1/approvals/mutes", {
      workspace_id: WORKSPACE,
      scope: "task",
      target_id: run.taskId,
      created_by: USER,
    });

    // The immediate slot (0) is due at the pause time; the scan answers it.
    const tick = await getJson(env.origin, `/v1/approvals/due-reminders?workspace_id=${WORKSPACE}`);
    expect(tick.status).toBe(200);
    const entries = tick.body["reminders"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      workspace_id: WORKSPACE,
      approval_id: approvalId,
      reminder_index: 0,
      outcome: "muted",
      delivered_at: null,
    });

    // The detail's reminder rows stay UNDELIVERED for audit; the run is
    // untouched (no transition, no journal event — D32/E3).
    const detail = await getJson(env.origin, `/v1/approvals/${approvalId}?workspace_id=${WORKSPACE}`);
    const reminders = detail.body["reminders"] as Array<Record<string, unknown>>;
    expect(reminders[0]!["delivered_at"]).toBeNull();
    expect(detail.body["run"]).toMatchObject({ state: "WAITING_FOR_APPROVAL", version: 4 });
  });

  it("delivers unmuted slots once and never re-delivers them", async () => {
    env = await composeOn(GATED_TOOL);
    startScriptedRun(env.runtime);
    const approvals = ((await pendingList(env.origin)).body["approvals"] ?? []) as Array<
      Record<string, unknown>
    >;
    const approvalId = approvals[0]!["approval_id"] as string;

    const first = (await getJson(env.origin, `/v1/approvals/due-reminders?workspace_id=${WORKSPACE}`)).body["reminders"] as Array<Record<string, unknown>>;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ reminder_index: 0, outcome: "delivered" });
    expect(first[0]!["delivered_at"]).not.toBeNull();

    // The delivered slot does not resurface; the later slots are not yet due.
    expect(
      ((await getJson(env.origin, `/v1/approvals/due-reminders?workspace_id=${WORKSPACE}`)).body["reminders"] ?? []),
    ).toHaveLength(0);

    // The delivery stamp landed on the detail read.
    const detail = await getJson(env.origin, `/v1/approvals/${approvalId}?workspace_id=${WORKSPACE}`);
    expect((detail.body["reminders"] as Array<Record<string, unknown>>)[0]!["delivered_at"]).not.toBeNull();
  });
});

afterAll(async () => {
  await cleanupTempResources();
});
