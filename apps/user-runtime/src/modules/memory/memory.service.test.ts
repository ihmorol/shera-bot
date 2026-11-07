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
  const journal = new EventJournalRepository(tx);
  const service = new MemoryService({
    memory,
    operations: new OperationsRepository(tx),
    receipts: new CommandReceiptsRepository(tx),
    tx,
    journal,
    events: new EventsService(journal, tx),
  });
  const suite: Suite = {
    service,
    memory,
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
        agentCommand({ type: "memory.set_agent_auto_memory", agent_id: "agent_researcher", enabled: false }),
      ),
    ).rejects.toMatchObject({ code: "MEMORY_COMMAND_ACTOR_FORBIDDEN" });

    // Nothing happened: the user's entry is untouched (content, history, and
    // the settings tables).
    const entries = suite.memory.listEntries(WORKSPACE);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe("The workspace note's content.");
    expect(suite.memory.listVersions(WORKSPACE, memoryId).map((v) => v.version)).toEqual([1]);
    expect(suite.memory.findSettings(WORKSPACE)).toBeUndefined();
    expect(suite.memory.findAgentSettings(WORKSPACE, "agent_researcher")).toBeUndefined();
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
