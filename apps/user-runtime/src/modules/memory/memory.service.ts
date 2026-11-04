/**
 * Memory service (S29 chunk 1; issue #30; PRD §11, D37, AC27, G2/G3/G6) —
 * the runtime's validation point for memory. Every memory write goes through
 * this service (G2: agents propose, the runtime validates and executes —
 * automatic updates are runtime-mediated events, never agent-side writes),
 * and every read is filtered through the D37 visibility TABLE:
 *
 *   | Memory type   | Visible to                                |
 *   |---------------|-------------------------------------------|
 *   | Agent-private | That Agent only                            |
 *   | Operation     | User and participating Agents              |
 *   | Task          | Task participants and the runtime          |
 *   | Workspace     | Agents allowed by workspace policy         |
 *   | Account       | User and explicitly authorized services    |
 *
 * The publication boundary (AC27) is structural: a private entry's
 * Operation-context visibility is a COLUMN on the row
 * (published_into_operation_id), set only by the user's explicit
 * memory.publish_decision command (G6 — agents never self-approve).
 * Publication shares into ONE Operation; it never opens the private scope.
 *
 * Every command is one short transaction (D10) with a command receipt (D23
 * rule 6): a replayed idempotency_key returns the recorded result. Typed
 * rejections carry SCREAMING_SNAKE codes; messages never echo content (G3).
 */
import { randomUUID } from "node:crypto";

import type { MemoryCommand } from "@shera-bot/contracts";

import type {
  MemoryEntryRow,
  MemoryRepository,
  MemoryScopeValue,
} from "../../adapters/sqlite/memory-repository.ts";
import { MemoryRepositoryError } from "../../adapters/sqlite/memory-repository.ts";
import type { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";

export type MemoryFailureCode =
  | "MEMORY_COMMAND_INVALID"
  | "MEMORY_PROVENANCE_REQUIRED"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_OPERATION_NOT_FOUND"
  | "AGENT_MEMORY_ACCESS_DENIED"
  | "MEMORY_PUBLICATION_NOT_REQUESTED"
  | "MEMORY_COMMAND_ACTOR_FORBIDDEN";

export class MemoryServiceError extends Error {
  readonly code: MemoryFailureCode;
  readonly category: "validation" | "policy" | "state" | "conflict";

  constructor(
    code: MemoryFailureCode,
    category: "validation" | "policy" | "state" | "conflict",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "MemoryServiceError";
    this.code = code;
    this.category = category;
  }
}

export interface MemoryServiceDeps {
  memory: MemoryRepository;
  operations: Pick<OperationsRepository, "getOperation" | "listRoster">;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  now?: (() => string) | undefined;
}

/** The provenance pair every entry carries (D37; AC3). */
export interface MemoryProvenance {
  origin: "user" | "automatic";
  created_by: string;
  source_refs: string[];
  confidence: number;
}

/** The read model one entry serializes to (the contract shape + provenance). */
export interface MemoryEntryView extends MemoryProvenance {
  memory_id: string;
  workspace_id: string;
  scope: MemoryScopeValue;
  owner_agent_id: string | null;
  operation_id: string | null;
  task_id: string | null;
  summary: string;
  content: string;
  sensitivity: "normal" | "sensitive";
  publication: {
    published: boolean;
    published_into_operation_id: string | null;
    published_at: string | null;
  };
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface MemoryPublicationRequestView {
  request_id: string;
  memory_id: string;
  operation_id: string;
  requested_by: string;
  status: "pending" | "approved" | "dismissed";
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

export interface MemoryUserView {
  workspace_id: string;
  /** The per-scope breakdown (the S9 surface's groups; every D37 scope present). */
  scopes: Record<MemoryScopeValue, MemoryEntryView[]>;
  publication_queue: MemoryPublicationRequestView[];
  auto_memory: {
    global_enabled: boolean;
    agents: { agent_id: string; enabled: boolean }[];
  };
}

function parseSourceRefs(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const SCOPES: MemoryScopeValue[] = ["account", "workspace", "operation", "task", "agent_private"];

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  // ── Commands (the typed user-command surface) ─────────────────────────────

  /**
   * Apply one typed memory command. The workspace_id is validated by the
   * transport (it must be THIS runtime's workspace); the actor is bound by
   * the caller. Returns the command's recorded result; a replayed
   * idempotency_key replays the recorded result (D23 rule 6).
   */
  applyCommand(command: MemoryCommand): unknown {
    const existing = this.deps.receipts.findById(command.workspace_id, command.idempotency_key);
    if (existing) {
      return JSON.parse(existing.result_json) as unknown;
    }
    // The command's effects AND its receipt commit in ONE atomic unit (D23
    // rule 6): the inner transaction() calls join this open unit instead of
    // nesting, so a crash leaves neither an effect without its receipt nor a
    // receipt without its effect.
    let result: unknown;
    this.deps.tx.transaction((exec) => {
      result =
        command.type === "memory.create"
          ? this.createEntry(command)
          : this.decidePublication(command);
      this.deps.receipts.create(
        {
          workspace_id: command.workspace_id,
          idempotency_key: command.idempotency_key,
          command_type: command.type,
          result_json: JSON.stringify(result),
          created_at: this.now(),
        },
        exec,
      );
    });
    return result;
  }

  /**
   * Create one entry from an explicit user write. Scope/owner shape is
   * validated (agent_private REQUIRES its owner; shared scopes refuse one);
   * provenance is required for EVERY entry (AC3: an entry without provenance
   * cannot be auto-created — the user's own writes name their source too);
   * the entry lands with version 1 in its history.
   */
  private createEntry(command: Extract<MemoryCommand, { type: "memory.create" }>): {
    entry: MemoryEntryView;
  } {
    const { scope } = command;
    if (scope === "agent_private" && !command.owner_agent_id) {
      throw new MemoryServiceError(
        "MEMORY_COMMAND_INVALID",
        "validation",
        "an agent_private memory requires its owner Agent",
      );
    }
    if (scope !== "agent_private" && command.owner_agent_id !== null) {
      throw new MemoryServiceError(
        "MEMORY_COMMAND_INVALID",
        "validation",
        "only an agent_private memory carries an owner Agent",
      );
    }
    if (scope === "operation" && !command.operation_id) {
      throw new MemoryServiceError(
        "MEMORY_COMMAND_INVALID",
        "validation",
        "an operation-scoped memory requires its Operation id",
      );
    }
    if (scope === "account" && (command.operation_id !== null || command.task_id !== null)) {
      throw new MemoryServiceError(
        "MEMORY_COMMAND_INVALID",
        "validation",
        "an account-scoped memory carries no Operation or task binding",
      );
    }
    if (command.source_refs.length === 0) {
      throw new MemoryServiceError(
        "MEMORY_PROVENANCE_REQUIRED",
        "validation",
        "memory requires at least one source reference",
      );
    }

    if (command.operation_id !== null) {
      const operation = this.deps.operations.getOperation(command.workspace_id, command.operation_id);
      if (!operation) {
        throw new MemoryServiceError(
          "MEMORY_OPERATION_NOT_FOUND",
          "state",
          "the referenced Operation does not exist in this workspace",
        );
      }
    }

    const actorIsUser = command.actor.type === "user";
    const now = this.now();
    const memoryId = `mem_${randomUUID()}`;
    const sourceRefs = JSON.stringify(command.source_refs);

    this.deps.tx.transaction((exec) => {
      this.deps.memory.insertEntry(
        {
          workspace_id: command.workspace_id,
          memory_id: memoryId,
          scope,
          owner_agent_id: command.owner_agent_id,
          operation_id: command.operation_id,
          task_id: command.task_id,
          summary: command.summary,
          content: command.content,
          sensitivity: command.sensitivity,
          source_refs: sourceRefs,
          confidence: command.confidence,
          created_by: command.actor.id,
          origin: actorIsUser ? "user" : "automatic",
          created_at: now,
          expires_at: command.expires_at,
        },
        exec,
      );
      this.deps.memory.insertVersion(
        {
          workspace_id: command.workspace_id,
          memory_id: memoryId,
          version: 1,
          summary: command.summary,
          content: command.content,
          sensitivity: command.sensitivity,
          source_refs: sourceRefs,
          confidence: command.confidence,
          change_kind: "created",
          changed_by: command.actor.id,
          created_at: now,
        },
        exec,
      );
    });

    const entry = this.deps.memory.findEntry(command.workspace_id, memoryId);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the created memory row could not be read back",
      );
    }
    return { entry: this.toView(entry) };
  }

  /**
   * The AC27 publication decision — an explicit USER action (G6: an agent
   * actor is the typed 403, agents never self-approve). Approve records the
   * decision row (who decided, when) and sets the entry's publication
   * columns INTO the named Operation; dismiss withdraws an active
   * publication into that Operation or dismisses a pending request.
   */
  private decidePublication(
    command: Extract<MemoryCommand, { type: "memory.publish_decision" }>,
  ): { entry: MemoryEntryView; decision: "approved" | "dismissed" } {
    if (command.actor.type !== "user") {
      throw new MemoryServiceError(
        "MEMORY_COMMAND_ACTOR_FORBIDDEN",
        "policy",
        "publication is an explicit user decision",
      );
    }
    const entry = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the memory does not exist in this workspace",
      );
    }
    const operation = this.deps.operations.getOperation(command.workspace_id, command.operation_id);
    if (!operation) {
      throw new MemoryServiceError(
        "MEMORY_OPERATION_NOT_FOUND",
        "state",
        "the target Operation does not exist in this workspace",
      );
    }

    const now = this.now();
    const approving = command.decision === "approve";

    if (approving) {
      const requestId = `pubreq_${randomUUID()}`;
      this.deps.tx.transaction((exec) => {
        // The decision record is born pending and decided in the SAME
        // transaction: requested_by and decided_by are both on the row (the
        // user initiated and approved — one actor, both roles recorded).
        this.deps.memory.insertPublicationRequest(
          {
            workspace_id: command.workspace_id,
            request_id: requestId,
            memory_id: command.memory_id,
            operation_id: command.operation_id,
            requested_by: command.actor.id,
            status: "pending",
            created_at: now,
          },
          exec,
        );
        this.deps.memory.decidePublicationRequest(
          command.workspace_id,
          requestId,
          "approved",
          command.actor.id,
          now,
          exec,
        );
        this.deps.memory.applyPublication(
          command.workspace_id,
          command.memory_id,
          true,
          command.operation_id,
          now,
          now,
          exec,
        );
      });
    } else {
      const pending = this.deps.memory.findPendingPublicationRequest(
        command.workspace_id,
        command.memory_id,
      );
      const activelyPublishedHere =
        entry.published === 1 && entry.published_into_operation_id === command.operation_id;
      if (!pending && !activelyPublishedHere) {
        throw new MemoryServiceError(
          "MEMORY_PUBLICATION_NOT_REQUESTED",
          "validation",
          "there is no pending publication request or active publication to dismiss",
        );
      }
      this.deps.tx.transaction((exec) => {
        if (pending) {
          this.deps.memory.decidePublicationRequest(
            command.workspace_id,
            pending.request_id,
            "dismissed",
            command.actor.id,
            now,
            exec,
          );
        }
        if (activelyPublishedHere) {
          this.deps.memory.applyPublication(
            command.workspace_id,
            command.memory_id,
            false,
            null,
            null,
            now,
            exec,
          );
        }
      });
    }

    const updated = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!updated) {
      throw new MemoryServiceError("MEMORY_NOT_FOUND", "state", "the memory disappeared");
    }
    return {
      entry: this.toView(updated),
      decision: command.decision === "approve" ? "approved" : "dismissed",
    };
  }

  // ── Reads (the D37 visibility table) ──────────────────────────────────────

  /**
   * The USER's management read: every scope, every active entry (the D37
   * inspect power), the publication queue, and the auto-memory settings.
   */
  userView(workspaceId: string): MemoryUserView {
    const entries = this.deps.memory.listEntries(workspaceId);
    const views = entries.map((entry) => this.toView(entry));
    const scopes = Object.fromEntries(
      SCOPES.map((scope) => [scope, views.filter((view) => view.scope === scope)]),
    ) as Record<MemoryScopeValue, MemoryEntryView[]>;
    const settings = this.deps.memory.findSettings(workspaceId);
    const agentSettings = this.deps.memory.listAgentSettings(workspaceId);
    return {
      workspace_id: workspaceId,
      scopes,
      publication_queue: this.deps.memory.listPublicationRequests(workspaceId).map((row) => ({
        request_id: row.request_id,
        memory_id: row.memory_id,
        operation_id: row.operation_id,
        requested_by: row.requested_by,
        status: row.status,
        created_at: row.created_at,
        decided_by: row.decided_by,
        decided_at: row.decided_at,
      })),
      auto_memory: {
        global_enabled: settings ? settings.auto_memory_enabled === 1 : true,
        agents: agentSettings.map((row) => ({
          agent_id: row.agent_id,
          enabled: row.auto_memory_enabled === 1,
        })),
      },
    };
  }

  /**
   * ONE Agent's visible set (the context-assembly projection). The path
   * identity is the acting Agent (the S11 folder-route posture): the result
   * can only ever contain entries the D37 table grants THIS agent — another
   * Agent's private rows are unrepresentable here by construction.
   */
  agentContext(workspaceId: string, agentId: string, operationId?: string): MemoryEntryView[] {
    return this.visibleEntries(workspaceId, agentId, operationId ?? null).map((entry) =>
      this.toView(entry),
    );
  }

  /**
   * The Operation context projection: what THIS Operation's context holds —
   * entries published into it (AC27: the ONLY path a private entry takes
   * here), its operation-scope entries, and its task-scope entries. Another
   * Agent's unpublished private memory is invisible here.
   */
  operationContext(workspaceId: string, operationId: string): MemoryEntryView[] {
    const operation = this.deps.operations.getOperation(workspaceId, operationId);
    if (!operation) {
      throw new MemoryServiceError(
        "MEMORY_OPERATION_NOT_FOUND",
        "state",
        "the Operation does not exist in this workspace",
      );
    }
    const now = this.now();
    return this.deps.memory
      .listEntries(workspaceId)
      .filter((entry) => !this.isExpired(entry, now))
      .filter((entry) => {
        if (
          entry.scope === "agent_private" &&
          entry.published === 1 &&
          entry.published_into_operation_id === operationId
        ) {
          return true;
        }
        if (entry.scope === "operation" && entry.operation_id === operationId) {
          return true;
        }
        if (entry.scope === "task" && entry.operation_id === operationId) {
          return true;
        }
        return false;
      })
      .map((entry) => this.toView(entry));
  }

  /**
   * One entry's detail AS AN AGENT viewer — the boundary the denial test
   * drives. Another Agent's private entry is the typed
   * AGENT_MEMORY_ACCESS_DENIED (403 through the transport); account-scope
   * entries never answer an Agent viewer (the D37 account row's visibility
   * set is the user and explicitly authorized services).
   */
  readEntryAsAgent(workspaceId: string, agentId: string, memoryId: string): MemoryEntryView {
    const entry = this.deps.memory.findEntry(workspaceId, memoryId);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the memory does not exist in this workspace",
      );
    }
    if (entry.scope === "agent_private" && entry.owner_agent_id !== agentId) {
      throw new MemoryServiceError(
        "AGENT_MEMORY_ACCESS_DENIED",
        "policy",
        "this private memory belongs to another Agent",
      );
    }
    if (entry.scope === "account") {
      throw new MemoryServiceError(
        "AGENT_MEMORY_ACCESS_DENIED",
        "policy",
        "account memory is not visible to Agents",
      );
    }
    return this.toView(entry);
  }

  /**
   * The visible set for ONE agent viewer, per the D37 table. Workspace
   * policy default (recorded): every Agent of the workspace sees workspace
   * memory. Account memory NEVER reaches an Agent. Operation memory reaches
   * participating Agents (in that Operation's context). Task memory reaches
   * the task's participants through the same Operation linkage.
   */
  private visibleEntries(
    workspaceId: string,
    agentId: string,
    operationId: string | null,
  ): MemoryEntryRow[] {
    const now = this.now();
    const rosterCache = new Map<string, boolean>();
    const participates = (opId: string): boolean => {
      const cached = rosterCache.get(opId);
      if (cached !== undefined) return cached;
      const operation = this.deps.operations.getOperation(workspaceId, opId);
      const member = operation
        ? this.deps.operations
            .listRoster(workspaceId, opId)
            .some((member) => member.agent_id === agentId)
        : false;
      rosterCache.set(opId, member);
      return member;
    };

    return this.deps.memory
      .listEntries(workspaceId)
      .filter((entry) => !this.isExpired(entry, now))
      .filter((entry) => {
        switch (entry.scope) {
          case "agent_private":
            // The owner always sees it. Another Agent sees it ONLY through
            // the AC27 publication: published into an Operation that viewer
            // participates in, and only when the read is THAT Operation's
            // context (publication shares into the Operation, never the
            // private scope at large).
            return (
              entry.owner_agent_id === agentId ||
              (entry.published === 1 &&
                operationId !== null &&
                entry.published_into_operation_id === operationId &&
                participates(operationId))
            );
          case "workspace":
            return true;
          case "account":
            return false;
          case "operation":
            return (
              entry.operation_id !== null &&
              (operationId === null || entry.operation_id === operationId) &&
              participates(entry.operation_id)
            );
          case "task":
            return (
              entry.operation_id !== null &&
              (operationId === null || entry.operation_id === operationId) &&
              participates(entry.operation_id)
            );
        }
      });
  }

  private isExpired(entry: MemoryEntryRow, now: string): boolean {
    return entry.expires_at !== null && entry.expires_at <= now;
  }

  private toView(entry: MemoryEntryRow): MemoryEntryView {
    return {
      memory_id: entry.memory_id,
      workspace_id: entry.workspace_id,
      scope: entry.scope,
      owner_agent_id: entry.owner_agent_id,
      operation_id: entry.operation_id,
      task_id: entry.task_id,
      summary: entry.summary,
      content: entry.content,
      sensitivity: entry.sensitivity,
      publication: {
        published: entry.published === 1,
        published_into_operation_id: entry.published_into_operation_id,
        published_at: entry.published_at,
      },
      origin: entry.origin,
      created_by: entry.created_by,
      source_refs: parseSourceRefs(entry.source_refs),
      confidence: entry.confidence,
      created_at: entry.created_at,
      updated_at: entry.updated_at,
      expires_at: entry.expires_at,
    };
  }
}

export { MemoryRepositoryError };
