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
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  MemoryService,
  MemoryServiceError,
} from "./memory.service.ts";
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
  const service = new MemoryService({
    memory,
    operations: new OperationsRepository(tx),
    receipts: new CommandReceiptsRepository(tx),
    tx,
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
  it("refuses an agent_private create without its owner — the shape rule a programmatic caller cannot bypass", () => {
    const suite = makeSuite();
    const command = createCommand({ scope: "agent_private", owner_agent_id: null });
    expect(() => suite.service.applyCommand(command)).toThrowError(MemoryServiceError);
    try {
      suite.service.applyCommand(command);
    } catch (error) {
      expect((error as MemoryServiceError).code).toBe("MEMORY_COMMAND_INVALID");
    }
  });

  it("refuses a create without provenance — AC3's boundary holds for user and automatic writes alike", () => {
    const suite = makeSuite();
    const command = createCommand({ source_refs: [] });
    expect(() => suite.service.applyCommand(command)).toThrowError(MemoryServiceError);
    try {
      suite.service.applyCommand(command);
    } catch (error) {
      expect((error as MemoryServiceError).code).toBe("MEMORY_PROVENANCE_REQUIRED");
    }
  });

  it("refuses an agent-actor publication decision — agents never self-approve (G6)", async () => {
    const suite = makeSuite();
    const created = suite.service.applyCommand(
      createCommand({ scope: "workspace" }),
    ) as { entry: { memory_id: string } };
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
    expect(() => suite.service.applyCommand(decision)).toThrowError(MemoryServiceError);
    try {
      suite.service.applyCommand(decision);
    } catch (error) {
      expect((error as MemoryServiceError).code).toBe("MEMORY_COMMAND_ACTOR_FORBIDDEN");
    }
  });

  it("records version 1 at creation and keeps history append-only across an edit", () => {
    const suite = makeSuite();
    const created = suite.service.applyCommand(createCommand()) as {
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

  it("replays a command's recorded result on a repeated idempotency key (D23 rule 6)", () => {
    const suite = makeSuite();
    const command = createCommand();
    const first = suite.service.applyCommand(command) as { entry: { memory_id: string } };
    const replay = suite.service.applyCommand(command) as { entry: { memory_id: string } };
    expect(replay.entry.memory_id).toBe(first.entry.memory_id);
    expect(suite.memory.listEntries(WORKSPACE)).toHaveLength(1);
  });
});
