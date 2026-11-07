/**
 * S29 chunk 1 — the memory service + repository unit suite (issue #30;
 * PRD §11, D37, AC27, AC3). The integration pin lives in
 * transport/local-api/s29-memory-api.test.ts; this suite pins the SERVICE
 * backstops an HTTP caller can't reach (the envelope schema refuses malformed
 * commands before the service sees them — a programmatic caller cannot):
 * the scope/owner shape rules, the provenance requirement, and the
 * publication decision machinery's recorded trail.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { MemoryRepository } from "../../adapters/sqlite/memory-repository.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { EventsService } from "../events/events.service.ts";
import { MemoryService } from "./memory.service.ts";
import type { MemoryCommand } from "@shera-bot/contracts";

const WORKSPACE = "ws-local-default";

interface Suite {
  service: MemoryService;
  memory: MemoryRepository;
  operations: OperationsRepository;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  close(): void;
}

const suites: Suite[] = [];

function makeSuite(): Suite {
  const dir = mkdtempSync(join(tmpdir(), "shera-s29-service-"));
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const memory = new MemoryRepository(tx);
  const operations = new OperationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const service = new MemoryService({
    memory,
    operations,
    receipts: new CommandReceiptsRepository(tx),
    tx,
    journal,
    events: new EventsService(journal, tx),
  });
  const suite: Suite = {
    service,
    memory,
    operations,
    conn,
    tx,
    close: () => conn.close(),
  };
  suites.push(suite);
  return suite;
}

afterEach(() => {
  for (const suite of suites.splice(0)) {
    suite.close();
  }
});

function createCommand(extra: Partial<Extract<MemoryCommand, { type: "memory.create" }>> = {}) {
  return {
    command_id: `cmd_${randomUUID()}`,
    idempotency_key: `idem_${randomUUID()}`,
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" } as const,
    issued_at: "2026-11-04T10:00:00.000Z",
    type: "memory.create",
    scope: "workspace",
    owner_agent_id: null,
    operation_id: null,
    task_id: null,
    summary: "A workspace note",
    content: "The workspace note's content.",
    sensitivity: "normal",
    source_refs: ["conversation://direct/user_emon"],
    confidence: 0.7,
    expires_at: null,
    ...extra,
  } as Extract<MemoryCommand, { type: "memory.create" }>;
}

describe("memory service backstops (S29 chunk 1)", () => {
  it("refuses an agent_private create without its owner — the shape rule a programmatic caller cannot bypass", async () => {
    const suite = makeSuite();
    const command = createCommand({ scope: "agent_private", owner_agent_id: null });
    await expect(suite.service.applyCommand(command)).rejects.toMatchObject({
      code: "MEMORY_COMMAND_INVALID",
    });
  });

  it("refuses a create without provenance — AC3's boundary holds for user and automatic writes alike", async () => {
    const suite = makeSuite();
    const command = createCommand({ source_refs: [] });
    await expect(suite.service.applyCommand(command)).rejects.toMatchObject({
      code: "MEMORY_PROVENANCE_REQUIRED",
    });
  });

  it("refuses an agent actor on the user-only commands — create, edit, restore, forget, and the auto-memory switches (fix-round F17)", async () => {
    const suite = makeSuite();
    // The user's own entry, the target for the agent-actor attempts.
    const created = (await suite.service.applyCommand(createCommand({ scope: "workspace" }))) as {
      entry: { memory_id: string };
    };
    const memoryId = created.entry.memory_id;
    const agentCommand = (overrides: Record<string, unknown>) =>
      ({
        command_id: `cmd_${randomUUID()}`,
        idempotency_key: `idem_${randomUUID()}`,
        workspace_id: WORKSPACE,
        actor: { type: "agent", id: "agent_researcher" } as const,
        issued_at: "2026-11-04T10:05:00.000Z",
        ...overrides,
      }) as unknown as MemoryCommand;

    // memory.create is the AC5-shaped hole: an agent-actor create would land
    // origin "automatic" WITHOUT consulting the auto-memory switches (their
    // gate lives only at the top of proposeCandidate). The user commands are
    // the USER's writes — the agent proposal path is the typed candidate
    // event (G2), and only the user wields the controls.
    await expect(
      suite.service.applyCommand(
        agentCommand({
          type: "memory.create",
          scope: "workspace",
          owner_agent_id: null,
          operation_id: null,
          task_id: null,
          summary: "An agent-side write",
          content: "The content an agent actor must not store directly.",
          sensitivity: "normal",
          source_refs: ["conversation://x"],
          confidence: 0.5,
          expires_at: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });
    await expect(
      suite.service.applyCommand(
        agentCommand({
          type: "memory.edit",
          memory_id: memoryId,
          summary: "A workspace note",
          content: "Edited by an agent actor.",
          sensitivity: "normal",
          source_refs: ["conversation://direct/user_emon"],
          confidence: 0.7,
          expires_at: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });
    await expect(
      suite.service.applyCommand(
        agentCommand({ type: "memory.restore", memory_id: memoryId, version: 1 }),
      ),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });
    await expect(
      suite.service.applyCommand(agentCommand({ type: "memory.forget", memory_id: memoryId })),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });
    await expect(
      suite.service.applyCommand(agentCommand({ type: "memory.set_auto_memory", enabled: false })),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });
    await expect(
      suite.service.applyCommand(
        agentCommand({
          type: "memory.set_agent_auto_memory",
          agent_id: "agent_researcher",
          enabled: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });

    // Nothing happened: the user's entry is untouched (content, history, and
    // the settings tables).
    const entries = suite.memory.listEntries(WORKSPACE);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("The workspace note's content.");
    expect(suite.memory.listVersions(WORKSPACE, memoryId).map((v) => v.version)).toEqual([1]);
    expect(suite.memory.findSettings(WORKSPACE)).toBeNull();
    expect(suite.memory.findAgentSettings(WORKSPACE, "agent_researcher")).toBeNull();
  });

  it("approving settles the pending request it approves — the proposer stays on the row, the deciding user is recorded, no duplicate trail row (fix-round F18, the storage layer)", async () => {
    const suite = makeSuite();
    // The target Operation the publication names (decidePublication
    // validates it exists in this workspace).
    suite.operations.createOperation(WORKSPACE, {
      operation_id: "op_f18",
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "F18 settle sweep",
      status: "active",
      coordinator_agent_id: "agent_researcher",
      pinning: {
        pack_id: "pack_student_v1",
        pack_version: "1.0.0",
        roster_agent_ids: ["agent_researcher"],
        capabilities: [],
        provider_snapshot: {},
      },
      created_at: "2026-11-04T09:00:00.000Z",
      updated_at: "2026-11-04T09:00:00.000Z",
    });
    // A pending request born from the Agent's proposal (the proposeCandidate
    // path inserts exactly this shape).
    const created = (await suite.service.applyCommand(createCommand({ scope: "workspace" }))) as {
      entry: { memory_id: string };
    };
    const memoryId = created.entry.memory_id;
    suite.memory.insertPublicationRequest(
      {
        workspace_id: WORKSPACE,
        request_id: "pubreq_f18_agent_request",
        memory_id: memoryId,
        operation_id: "op_f18",
        requested_by: "agent_researcher",
        status: "pending",
        created_at: "2026-11-04T10:00:00.000Z",
      },
      suite.tx.connection(),
    );

    const approved = (await suite.service.applyCommand({
      command_id: `cmd_${randomUUID()}`,
      idempotency_key: `idem_${randomUUID()}`,
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" } as const,
      issued_at: "2026-11-04T10:07:00.000Z",
      type: "memory.publish_decision",
      memory_id: memoryId,
      operation_id: "op_f18",
      decision: "approve",
    } as Extract<MemoryCommand, { type: "memory.publish_decision" }>)) as {
      decision: string;
    };
    expect(approved.decision).toBe("approved");

    // The AGENT'S request row is the one decided — status approved, its
    // requested_by preserved, decided_by the deciding user — and NO second
    // trail row was inserted beside it.
    const decided = suite.memory.findPublicationRequest(WORKSPACE, "pubreq_f18_agent_request");
    expect(decided).not.toBeNull();
    expect(decided!.status).toBe("approved");
    expect(decided!.requested_by).toBe("agent_researcher");
    expect(decided!.decided_by).toBe("user_emon");
    // NO duplicate trail row was inserted beside it: the table holds exactly
    // one row for this memory (the all-status repository read —
    // listPublicationRequests is the PENDING queue and nothing is pending
    // anymore).
    expect(suite.memory.listPublicationRequestsForMemory(WORKSPACE, memoryId)).toHaveLength(1);
    // Nothing stays pending.
    expect(suite.memory.listPublicationRequests(WORKSPACE)).toHaveLength(0);
  });

  it("the pending-request lookup is (memory, operation)-scoped — approving for B settles B's row and publishes into B while A stays pending (review C4, the storage layer)", async () => {
    const suite = makeSuite();
    // Two Operations: the SAME memory has a pending request into each. B's
    // request was created FIRST, A's SECOND — the memory-scoped lookup (the
    // review's finding) returns the NEWEST pending row regardless of which
    // Operation the decision names, so approving for B settles A's trail
    // row and B's request lingers pending forever.
    suite.operations.createOperation(WORKSPACE, {
      operation_id: "op_c4_b",
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "C4 operation B",
      status: "active",
      coordinator_agent_id: "agent_researcher",
      pinning: {
        pack_id: "pack_student_v1",
        pack_version: "1.0.0",
        roster_agent_ids: ["agent_researcher"],
        capabilities: [],
        provider_snapshot: {},
      },
      created_at: "2026-11-04T09:00:00.000Z",
      updated_at: "2026-11-04T09:00:00.000Z",
    });
    suite.operations.createOperation(WORKSPACE, {
      operation_id: "op_c4_a",
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "C4 operation A",
      status: "active",
      coordinator_agent_id: "agent_researcher",
      pinning: {
        pack_id: "pack_student_v1",
        pack_version: "1.0.0",
        roster_agent_ids: ["agent_researcher"],
        capabilities: [],
        provider_snapshot: {},
      },
      created_at: "2026-11-04T09:01:00.000Z",
      updated_at: "2026-11-04T09:01:00.000Z",
    });
    const created = (await suite.service.applyCommand(createCommand({ scope: "workspace" }))) as {
      entry: { memory_id: string };
    };
    const memoryId = created.entry.memory_id;
    // The Agent proposed the memory into B first, then into A (two pending
    // rows, A the newer one).
    suite.memory.insertPublicationRequest(
      {
        workspace_id: WORKSPACE,
        request_id: "pubreq_c4_into_b",
        memory_id: memoryId,
        operation_id: "op_c4_b",
        requested_by: "agent_researcher",
        status: "pending",
        created_at: "2026-11-04T10:00:00.000Z",
      },
      suite.tx.connection(),
    );
    suite.memory.insertPublicationRequest(
      {
        workspace_id: WORKSPACE,
        request_id: "pubreq_c4_into_a",
        memory_id: memoryId,
        operation_id: "op_c4_a",
        requested_by: "agent_researcher",
        status: "pending",
        created_at: "2026-11-04T10:01:00.000Z",
      },
      suite.tx.connection(),
    );

    // The user approves the publication into B (the S9 queue row for B).
    const approved = (await suite.service.applyCommand({
      command_id: `cmd_${randomUUID()}`,
      idempotency_key: `idem_${randomUUID()}`,
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" } as const,
      issued_at: "2026-11-04T10:07:00.000Z",
      type: "memory.publish_decision",
      memory_id: memoryId,
      operation_id: "op_c4_b",
      decision: "approve",
    } as Extract<MemoryCommand, { type: "memory.publish_decision" }>)) as { decision: string };
    expect(approved.decision).toBe("approved");

    // B's OWN row is the one decided (requested_by the proposer preserved,
    // decided_by the deciding user) — not A's newer row.
    const decidedB = suite.memory.findPublicationRequest(WORKSPACE, "pubreq_c4_into_b");
    expect(decidedB).not.toBeNull();
    expect(decidedB!.status).toBe("approved");
    expect(decidedB!.requested_by).toBe("agent_researcher");
    expect(decidedB!.decided_by).toBe("user_emon");
    // A's request stays PENDING — the user never decided it.
    const pendingA = suite.memory.findPublicationRequest(WORKSPACE, "pubreq_c4_into_a");
    expect(pendingA).not.toBeNull();
    expect(pendingA!.status).toBe("pending");
    expect(pendingA!.decided_by).toBeNull();
    // The publication went into B — the Operation the user actually
    // approved.
    const published = suite.memory.findEntry(WORKSPACE, memoryId);
    expect(published).not.toBeNull();
    expect(published!.published).toBe(1);
    expect(published!.published_into_operation_id).toBe("op_c4_b");
  });

  it("refuses an agent-actor publication decision — agents never self-approve (G6)", async () => {
    const suite = makeSuite();
    const created = (await suite.service.applyCommand(createCommand({ scope: "workspace" }))) as {
      entry: { memory_id: string };
    };
    const decision = {
      command_id: `cmd_${randomUUID()}`,
      idempotency_key: `idem_${randomUUID()}`,
      workspace_id: WORKSPACE,
      actor: { type: "agent", id: "agent_researcher" } as const,
      issued_at: "2026-11-04T10:05:00.000Z",
      type: "memory.publish_decision",
      memory_id: created.entry.memory_id,
      operation_id: "op_missing",
      decision: "approve",
    } as Extract<MemoryCommand, { type: "memory.publish_decision" }>;
    await expect(suite.service.applyCommand(decision)).rejects.toMatchObject({
      code: "MEMORY_COMMAND_ACTOR_FORBIDDEN",
    });
  });

  it("records version 1 at creation and keeps history append-only across an edit", async () => {
    const suite = makeSuite();
    const created = (await suite.service.applyCommand(createCommand())) as {
      entry: { memory_id: string };
    };
    const memoryId = created.entry.memory_id;
    const versions = suite.memory.listVersions(WORKSPACE, memoryId);
    expect(versions.map((version) => version.version)).toEqual([1]);
    expect(versions[0]!.change_kind).toBe("created");

    // An edit appends version 2; version 1's content is untouched.
    const now = "2026-11-04T11:00:00.000Z";
    suite.tx.transaction((exec) => {
      suite.memory.updateEntry(
        WORKSPACE,
        memoryId,
        {
          summary: "A workspace note",
          content: "The workspace note's amended content.",
          sensitivity: "normal",
          source_refs: JSON.stringify(["conversation://direct/user_emon"]),
          confidence: 0.7,
          updated_at: now,
          expires_at: null,
        },
        exec,
      );
      suite.memory.insertVersion(
        {
          workspace_id: WORKSPACE,
          memory_id: memoryId,
          version: suite.memory.nextVersion(WORKSPACE, memoryId, exec),
          summary: "A workspace note",
          content: "The workspace note's amended content.",
          sensitivity: "normal",
          source_refs: JSON.stringify(["conversation://direct/user_emon"]),
          confidence: 0.7,
          change_kind: "edited",
          changed_by: "user_emon",
          created_at: now,
        },
        exec,
      );
    });
    const after = suite.memory.listVersions(WORKSPACE, memoryId);
    expect(after.map((version) => version.version)).toEqual([1, 2]);
    expect(after[0]!.content).toBe("The workspace note's content.");
    expect(after[1]!.content).toBe("The workspace note's amended content.");
  });

  it("refuses an automatic candidate whose source refs leave the recorded scheme set (fix-round F2 backstop)", async () => {
    const suite = makeSuite();
    await expect(
      suite.service.proposeCandidate({
        workspace_id: WORKSPACE,
        proposed_by_agent_id: "agent_researcher",
        scope: "workspace",
        summary: "Unschemed candidate",
        content: "The candidate's only reference is not a recorded-scheme URI.",
        source_refs: ["ftp://reel/archive/tape"],
        confidence: 0.6,
        sensitivity: "normal",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_INVALID" });
    // Nothing was created.
    expect(suite.memory.listEntries(WORKSPACE)).toHaveLength(0);
  });

  it("replays a command's recorded result on a repeated idempotency key (D23 rule 6)", async () => {
    const suite = makeSuite();
    const command = createCommand();
    const first = (await suite.service.applyCommand(command)) as {
      entry: { memory_id: string };
    };
    const replay = (await suite.service.applyCommand(command)) as {
      entry: { memory_id: string };
    };
    expect(replay.entry.memory_id).toBe(first.entry.memory_id);
    expect(suite.memory.listEntries(WORKSPACE)).toHaveLength(1);
  });
});
