/**
 * S29 chunk 1 — the AC27 publication boundary proven end-to-end through the
 * typed local API (issue #30; PRD §11, D37, AC27, G2/G6).
 *
 * The pin: an Agent-private memory is invisible in Operation context to the
 * OTHER participating Agents AND to the Operation context projection until
 * the explicit user-approved publication step runs. After publication the
 * entry is visible in that Operation's context — and ONLY there: the other
 * Agents still hold no private-memory access (publication shares into the
 * Operation, it never opens the private scope), and the private content
 * never appears in the Operation thread of its own accord.
 *
 * The D37 scope table is enforced at the service boundary and pinned here
 * through the REAL composed stack (real SQLite, real migrations v21, real
 * HTTP) per house convention:
 *
 *   | Memory type  | Visible to                              |
 *   |--------------|-----------------------------------------|
 *   | Agent-private| That Agent only                         |
 *   | Operation    | User and participating Agents           |
 *   | Task         | Task participants and runtime           |
 *   | Workspace    | Agents allowed by workspace policy      |
 *   | Account      | User and explicitly authorized services |
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

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
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

/** One memory.create command through the typed commands envelope. */
function createCommand(extra: Record<string, unknown>) {
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 10)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-04T10:00:00.000Z",
    type: "memory.create",
    owner_agent_id: null,
    operation_id: null,
    task_id: null,
    expires_at: null,
    ...extra,
  };
}

interface MemoryEntryView {
  memory_id: string;
  scope: string;
  owner_agent_id: string | null;
  summary: string;
  content: string;
  sensitivity: string;
  publication: { published: boolean; published_into_operation_id: string | null };
  source_refs: string[];
  confidence: number;
}

const contextIds = (body: Record<string, unknown>): string[] =>
  ((body["entries"] as MemoryEntryView[]) ?? []).map((entry) => entry.memory_id);

afterAll(async () => {
  await cleanupTempResources();
});

describe("S29 memory: the AC27 publication boundary (integration)", () => {
  it("keeps an Agent-private memory invisible to other Agents and the Operation context until the user publishes it", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-ac27-"), "runtime.db"));
    const { origin } = running;

    // A real Operation whose roster holds BOTH Agents: any of them may read
    // the Operation context, so the private memory must be excluded by the
    // boundary, not by roster luck.
    const created = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Literature sweep",
      roster_agent_ids: [RESEARCHER, GENERAL],
      coordinator_agent_id: GENERAL,
    });
    expect(created.status).toBe(201);
    const operationId = created.body["operation_id"] as string;
    expect(operationId).toBeTruthy();

    // The researcher's PRIVATE memory — created through the runtime's own
    // typed command (G2: the runtime mediates every memory write).
    const create = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "agent_private",
        owner_agent_id: RESEARCHER,
        operation_id: operationId,
        summary: "Failed extraction heuristic for corpus 3",
        content:
          "The regex-based extraction heuristic loses table rows when the PDF uses spanned cells; use the layout parser instead.",
        sensitivity: "normal",
        source_refs: [`conversation://${operationId}/messages`],
        confidence: 0.8,
      }),
    );
    expect(create.status).toBe(200);
    const memoryId = (create.body["entry"] as MemoryEntryView).memory_id;
    expect(memoryId).toBeTruthy();

    // The owner Agent sees its own private memory in its context.
    const ownContext = await get(
      origin,
      `/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WORKSPACE}`,
    );
    expect(ownContext.status).toBe(200);
    expect(contextIds(ownContext.body)).toContain(memoryId);

    // The OTHER participating Agent sees nothing of it — neither in its
    // plain agent context nor in the Operation context it participates in.
    const otherContext = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}`,
    );
    expect(otherContext.status).toBe(200);
    expect(contextIds(otherContext.body)).not.toContain(memoryId);

    const otherOperationContext = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    );
    expect(otherOperationContext.status).toBe(200);
    expect(contextIds(otherOperationContext.body)).not.toContain(memoryId);

    // The Operation context projection (the thread/user side) excludes it too.
    const operationContext = await get(
      origin,
      `/v1/operations/${operationId}/memory-context?workspace_id=${WORKSPACE}`,
    );
    expect(operationContext.status).toBe(200);
    expect(contextIds(operationContext.body)).not.toContain(memoryId);

    // A direct read of the private entry as the OTHER Agent is the typed
    // runtime denial (the S11 private-folder analogue) — not an empty 200.
    const denied = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/entries/${memoryId}?workspace_id=${WORKSPACE}`,
    );
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });

    // Publication is an explicit USER action (G6): the user approves the
    // entry into THIS Operation's context.
    const publish = await post(origin, "/v1/memory/commands", {
      command_id: "cmd_publish_001",
      idempotency_key: "idem_publish_001",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-04T10:05:00.000Z",
      type: "memory.publish_decision",
      memory_id: memoryId,
      operation_id: operationId,
      decision: "approve",
    });
    expect(publish.status).toBe(200);

    // NOW the other Agent sees it in the Operation context — and still not
    // outside it: publication shares into the Operation, never the private
    // scope.
    const publishedOtherContext = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    );
    expect(publishedOtherContext.status).toBe(200);
    expect(contextIds(publishedOtherContext.body)).toContain(memoryId);

    const stillPrivateOutside = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}`,
    );
    expect(contextIds(stillPrivateOutside.body)).not.toContain(memoryId);

    // The direct cross-Agent read stays denied after publication too.
    const stillDenied = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/entries/${memoryId}?workspace_id=${WORKSPACE}`,
    );
    expect(stillDenied.status).toBe(403);

    // The private content never entered the Operation thread of its own
    // accord (the publication notice names the memory, it never carries the
    // private content — proven by the exact-content absence here).
    const thread = await get(
      origin,
      `/v1/operations/${operationId}/thread?workspace_id=${WORKSPACE}`,
    );
    expect(thread.status).toBe(200);
    expect(JSON.stringify(thread.body)).not.toContain("spanned cells");

    await running.close();
  });

  it("enforces the D37 scope table: Operation memory is for participants and the user; account memory never reaches Agents", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-scopes-"), "runtime.db"));
    const { origin } = running;

    const created = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Scoped sweep",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: RESEARCHER,
    });
    expect(created.status).toBe(201);
    const operationId = created.body["operation_id"] as string;

    // Operation-scoped memory: visible to the participating Agent in that
    // Operation's context.
    const opMemory = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "operation",
        operation_id: operationId,
        summary: "Operation decision: cite only peer-reviewed sources",
        content: "The user asked for peer-reviewed citations only for this sweep.",
        sensitivity: "normal",
        source_refs: [`conversation://${operationId}/messages`],
        confidence: 0.9,
      }),
    );
    expect(opMemory.status).toBe(200);
    const opMemoryId = (opMemory.body["entry"] as MemoryEntryView).memory_id;

    const participantContext = await get(
      origin,
      `/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    );
    expect(contextIds(participantContext.body)).toContain(opMemoryId);

    // ...but a non-participant Agent reading a DIFFERENT operation's context
    // does not receive it.
    const otherOperation = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Unrelated operation",
      roster_agent_ids: [GENERAL],
      coordinator_agent_id: GENERAL,
    });
    expect(otherOperation.status).toBe(201);
    const otherOperationId = otherOperation.body["operation_id"] as string;
    const nonParticipantContext = await get(
      origin,
      `/v1/agents/${GENERAL}/memory/context?workspace_id=${WORKSPACE}&operation_id=${otherOperationId}`,
    );
    expect(contextIds(nonParticipantContext.body)).not.toContain(opMemoryId);

    // Account-scoped memory: the user reads it in the management surface;
    // it NEVER reaches an Agent's context (the user and explicitly
    // authorized runtime services are the D37 visibility set).
    const accountMemory = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "account",
        summary: "User prefers concise summaries",
        content: "Across workspaces, the user asks for shorter executive summaries.",
        sensitivity: "normal",
        source_refs: ["conversation://direct/user_emon"],
        confidence: 0.7,
      }),
    );
    expect(accountMemory.status).toBe(200);
    const accountMemoryId = (accountMemory.body["entry"] as MemoryEntryView).memory_id;

    const userRead = await get(origin, `/v1/memory?workspace_id=${WORKSPACE}`);
    expect(userRead.status).toBe(200);
    const scopes = userRead.body["scopes"] as Record<string, MemoryEntryView[]>;
    expect(scopes["account"]!.map((entry) => entry.memory_id)).toContain(accountMemoryId);
    // The per-scope breakdown is the read model the S9 surface renders —
    // every D37 scope is present as a group even when empty.
    expect(Object.keys(scopes).sort()).toEqual(
      ["account", "agent_private", "operation", "task", "workspace"].sort(),
    );

    const agentViewOfAccount = await get(
      origin,
      `/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WORKSPACE}`,
    );
    expect(contextIds(agentViewOfAccount.body)).not.toContain(accountMemoryId);

    await running.close();
  });

  it("routes the detail read through the D37 visibility gate — the four leak probes are typed denials (fix-round F1)", async () => {
    // The detail read must answer through the SAME predicate the context
    // projection uses (expiry + the sensitive gate + participation + the D37
    // table) — a hand-rolled ownership check is how a NON-participant Agent
    // could read an unpublished sensitive entry, an expired entry, another
    // Operation's entry, or a sensitive workspace entry. Every probe below
    // expects the typed runtime denial (403 AGENT_MEMORY_ACCESS_DENIED).
    const running = await composeOn(join(makeTempDir("shera-s29-f1gate-"), "runtime.db"));
    const { origin } = running;

    // opA holds the researcher only; the general assistant is rostered
    // elsewhere, so any opA-entry read as the general assistant is a
    // non-participant read.
    const opA = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Roster A",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: RESEARCHER,
    });
    expect(opA.status).toBe(201);
    const opAId = opA.body["operation_id"] as string;

    const detail = async (agentId: string, memoryId: string) =>
      get(origin, `/v1/agents/${agentId}/memory/entries/${memoryId}?workspace_id=${WORKSPACE}`);

    // Probe (a): an UNPUBLISHED SENSITIVE operation-scope entry — no
    // publication ever happened, so no Agent may read it, participant or not.
    const sensitive = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "operation",
        operation_id: opAId,
        summary: "Unpublished sensitive context",
        content: "The sensitive sweep touches participant records and is not approved yet.",
        sensitivity: "sensitive",
        source_refs: [`conversation://${opAId}/messages`],
        confidence: 0.8,
      }),
    );
    expect(sensitive.status).toBe(200);
    const sensitiveId = (sensitive.body["entry"] as MemoryEntryView).memory_id;
    for (const viewer of [GENERAL, RESEARCHER]) {
      const denied = await detail(viewer, sensitiveId);
      expect(denied.status, `unpublished sensitive entry read as ${viewer}`).toBe(403);
      expect(denied.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });
      expect(JSON.stringify(denied.body)).not.toContain("participant records");
    }

    // Probe (b): an EXPIRED entry — expiry is a visibleEntries dimension, so
    // the detail read denies it even to a workspace viewer.
    const expired = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "workspace",
        summary: "A note that expired",
        content: "This workspace note expired before anyone read it.",
        sensitivity: "normal",
        source_refs: ["conversation://direct/user_emon"],
        confidence: 0.6,
        expires_at: "2026-11-01T00:00:00.000Z",
      }),
    );
    expect(expired.status).toBe(200);
    const expiredId = (expired.body["entry"] as MemoryEntryView).memory_id;
    const expiredRead = await detail(RESEARCHER, expiredId);
    expect(expiredRead.status).toBe(403);
    expect(expiredRead.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });
    expect(JSON.stringify(expiredRead.body)).not.toContain("expired before anyone");

    // Probe (c): an Operation-scope entry of an Operation the viewer is NOT
    // rostered on — participation is the D37 operation row's gate.
    const opMemory = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "operation",
        operation_id: opAId,
        summary: "Roster A decision",
        content: "Only roster A participants may read this operation decision.",
        sensitivity: "normal",
        source_refs: [`conversation://${opAId}/messages`],
        confidence: 0.7,
      }),
    );
    expect(opMemory.status).toBe(200);
    const opMemoryId = (opMemory.body["entry"] as MemoryEntryView).memory_id;
    const nonParticipant = await detail(GENERAL, opMemoryId);
    expect(nonParticipant.status).toBe(403);
    expect(nonParticipant.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });
    expect(JSON.stringify(nonParticipant.body)).not.toContain("roster A participants");
    // The participant still reads it — the gate denies the NON-participant,
    // never the D37-granted viewer.
    const participant = await detail(RESEARCHER, opMemoryId);
    expect(participant.status).toBe(200);
    expect((participant.body as MemoryEntryView).memory_id).toBe(opMemoryId);

    // Probe (d): a WORKSPACE-scope SENSITIVE entry — the sensitive gate holds
    // it from every Agent until the user's approval publishes it.
    const sensitiveWorkspace = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "workspace",
        summary: "Sensitive workspace note",
        content: "A workspace-scoped sensitive note no Agent may read yet.",
        sensitivity: "sensitive",
        source_refs: ["conversation://direct/user_emon"],
        confidence: 0.7,
      }),
    );
    expect(sensitiveWorkspace.status).toBe(200);
    const sensitiveWorkspaceId = (sensitiveWorkspace.body["entry"] as MemoryEntryView).memory_id;
    for (const viewer of [GENERAL, RESEARCHER]) {
      const denied = await detail(viewer, sensitiveWorkspaceId);
      expect(denied.status, `workspace sensitive entry read as ${viewer}`).toBe(403);
      expect(denied.body).toMatchObject({ code: "AGENT_MEMORY_ACCESS_DENIED" });
      expect(JSON.stringify(denied.body)).not.toContain("no Agent may read yet");
    }

    await running.close();
  });

  it("requires provenance and a scope owner shape: an agent_private create without its owner is the typed 400; provenance rides every entry", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-shape-"), "runtime.db"));
    const { origin } = running;

    // The envelope omits owner_agent_id entirely: the contracts command
    // schema refuses the ownerless private create at the boundary (typed
    // 400). The service's own MEMORY_COMMAND_INVALID backstop is pinned in
    // the memory service suite (a programmatic caller cannot bypass it).
    const { owner_agent_id: _omitted, ...ownerlessEnvelope } = createCommand({
      scope: "agent_private",
      summary: "Ownerless private memory",
      content: "This private memory names no owner Agent.",
      sensitivity: "normal",
      source_refs: ["conversation://x"],
      confidence: 0.5,
    });
    void _omitted;
    const missingOwner = await post(origin, "/v1/memory/commands", ownerlessEnvelope);
    expect(missingOwner.status).toBe(400);
    expect(missingOwner.body).toMatchObject({ code: "CONTRACT_VALIDATION_FAILED" });

    const noProvenance = await post(
      origin,
      "/v1/memory/commands",
      createCommand({
        scope: "workspace",
        summary: "Memory without provenance",
        content: "A user-created memory still carries where it came from.",
        sensitivity: "normal",
        source_refs: [],
        confidence: 0.5,
      }),
    );
    // Every entry exposes provenance (AC3): an entry without ANY source ref
    // is not creatable — the user's own writes name their source too.
    expect(noProvenance.status).toBe(400);
    expect(noProvenance.body).toMatchObject({ code: "MEMORY_PROVENANCE_REQUIRED" });

    await running.close();
  });
});
