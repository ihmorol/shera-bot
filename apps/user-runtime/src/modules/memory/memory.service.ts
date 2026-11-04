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

import type {
  MemoryCommand,
  MemoryCandidateProposedPayload,
  TypedExecutionEvent,
} from "@shera-bot/contracts";

import type {
  MemoryEntryRow,
  MemoryRepository,
  MemoryScopeValue,
} from "../../adapters/sqlite/memory-repository.ts";
import { MemoryRepositoryError } from "../../adapters/sqlite/memory-repository.ts";
import type { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import type { EventsService } from "../events/events.service.ts";
import { scanForSecrets } from "./secret-scanner.ts";

export type MemoryFailureCode =
  | "MEMORY_COMMAND_INVALID"
  | "MEMORY_PROVENANCE_REQUIRED"
  | "MEMORY_SECRET_REJECTED"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_VERSION_NOT_FOUND"
  | "MEMORY_OPERATION_NOT_FOUND"
  | "AGENT_MEMORY_ACCESS_DENIED"
  | "MEMORY_PUBLICATION_NOT_REQUESTED"
  | "MEMORY_PUBLICATION_APPROVAL_REQUIRED"
  | "MEMORY_AUTOMATIC_DISABLED"
  | "MEMORY_COMMAND_ACTOR_FORBIDDEN";

export class MemoryServiceError extends Error {
  readonly code: MemoryFailureCode;
  readonly category: "validation" | "policy" | "state" | "conflict";
  /**
   * Structured detail for the REDACTED fault log and typed responses — the
   * rejection's RULE classes, never the matched content (G3).
   */
  readonly details: Record<string, unknown> | null;

  constructor(
    code: MemoryFailureCode,
    category: "validation" | "policy" | "state" | "conflict",
    message: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = "MemoryServiceError";
    this.code = code;
    this.category = category;
    this.details = details;
  }
}

export interface MemoryServiceDeps {
  memory: MemoryRepository;
  operations: Pick<OperationsRepository, "getOperation" | "listRoster">;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  /** The journal (per-stream sequence allocation for the candidate events). */
  journal: Pick<EventJournalRepository, "nextSequence" | "listStream">;
  /** The typed journal-append authority (G2 — the proposal IS an event). */
  events: Pick<EventsService, "appendEvent">;
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
export interface MemoryVersionView {
  version: number;
  summary: string;
  content: string;
  sensitivity: "normal" | "sensitive";
  source_refs: string[];
  confidence: number;
  change_kind: "created" | "edited" | "published" | "restored" | "auto_updated";
  changed_by: string;
  created_at: string;
}

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
  /** The version history (the restore surface's data; empty for context reads). */
  versions: MemoryVersionView[];
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
  async applyCommand(command: MemoryCommand): Promise<unknown> {
    // The write-time secret scan (AC2) runs BEFORE anything is validated
    // into storage: the scan sees the summary and the content; a rejection
    // leaves no receipt, no row, no version, no event — and the response
    // names the RULE classes, never the matched content (G3).
    if (command.type === "memory.create" || command.type === "memory.edit") {
      // The write-time secret scan (AC2) covers CREATES and EDITS alike —
      // an edit is exactly as much a write as a create is. A rejection
      // leaves no receipt, no row, no version, no event — and the response
      // names the RULE classes, never the matched content (G3).
      const scan = await scanForSecrets(command.summary, command.content);
      if (scan.rejected) {
        throw new MemoryServiceError(
          "MEMORY_SECRET_REJECTED",
          "validation",
          "this memory looks like a credential or secret; secrets are never stored in memory",
          { rules: scan.rejections.map((rejection) => rejection.rule) },
        );
      }
    }
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
      if (command.type === "memory.create") {
        result = this.createEntry(command);
      } else if (command.type === "memory.request_publication") {
        result = this.requestPublication(command);
      } else if (command.type === "memory.publish_decision") {
        result = this.decidePublication(command);
      } else if (command.type === "memory.edit") {
        result = this.editEntry(command);
      } else if (command.type === "memory.restore") {
        result = this.restoreVersion(command);
      } else if (command.type === "memory.forget") {
        result = this.forgetEntry(command);
      } else if (command.type === "memory.set_auto_memory") {
        result = this.setAutoMemory(command);
      } else {
        result = this.setAgentAutoMemory(command);
      }
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
   * Open one publication request for the queue (the S9 surface's pending
   * rows). Idempotent per (memory, operation): an existing PENDING request
   * for the pair is returned unchanged, never duplicated.
   */
  private requestPublication(
    command: Extract<MemoryCommand, { type: "memory.request_publication" }>,
  ): { request_id: string; status: "pending" | "approved" | "dismissed" } {
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
    const existing = this.deps.memory
      .listPublicationRequests(command.workspace_id)
      .find(
        (row) => row.memory_id === command.memory_id && row.operation_id === command.operation_id,
      );
    if (existing) {
      return { request_id: existing.request_id, status: existing.status };
    }
    const requestId = `pubreq_${randomUUID()}`;
    this.deps.tx.transaction((exec) => {
      this.deps.memory.insertPublicationRequest(
        {
          workspace_id: command.workspace_id,
          request_id: requestId,
          memory_id: command.memory_id,
          operation_id: command.operation_id,
          requested_by: command.actor.id,
          status: "pending",
          created_at: this.now(),
        },
        exec,
      );
    });
    return { request_id: requestId, status: "pending" };
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
      const operation = this.deps.operations.getOperation(
        command.workspace_id,
        command.operation_id,
      );
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
  private decidePublication(command: Extract<MemoryCommand, { type: "memory.publish_decision" }>): {
    entry: MemoryEntryView;
    decision: "approved" | "dismissed";
  } {
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

    // The sensitive-approval gate (AC2): a SENSITIVE entry's publication
    // always carries the approval record — a direct approve without a
    // pending request is the typed refusal, no matter who asks.
    if (approving && entry.sensitivity === "sensitive") {
      const pending = this.deps.memory.findPendingPublicationRequest(
        command.workspace_id,
        command.memory_id,
      );
      if (!pending) {
        throw new MemoryServiceError(
          "MEMORY_PUBLICATION_APPROVAL_REQUIRED",
          "policy",
          "a sensitive memory needs a publication request before it can be approved",
        );
      }
    }

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

  // ── Automatic learning (the runtime-mediated candidate path, G2) ──────────

  /**
   * Propose one memory candidate from an Agent's automatic learning
   * (conversations, tasks, files, outcomes, corrections). The RUNTIME
   * mediates the whole path (G2 — the event is the proposal, never an
   * agent-side write):
   *
   *   1. provenance first (AC3): zero source refs is the typed refusal —
   *      no entry, no event, nothing stored;
   *   2. the write-time secret scan (AC2/D22): a credential-shaped candidate
   *      is refused before anything exists — the automatic path never
   *      becomes the leak path;
   *   3. the entry lands (origin 'automatic') with version 1;
   *   4. a SENSITIVE candidate surfaces in the publication queue as PENDING
   *      (the user's approval is required before any Agent sees it); private
   *      candidates are never copied automatically (D37) — publication is
   *      the user's explicit decision;
   *   5. the typed `memory.candidate_proposed` journal event carries the
   *      D37 payload; the envelope's actor IS the proposing Agent.
   */
  async proposeCandidate(input: {
    workspace_id: string;
    proposed_by_agent_id: string;
    scope: MemoryScopeValue;
    summary: string;
    content: string;
    source_refs: string[];
    confidence: number;
    sensitivity: "normal" | "sensitive";
    operation_id?: string | null;
    task_id?: string | null;
    expires_at?: string | null;
  }): Promise<{ entry: MemoryEntryView; publication_requested: boolean }> {
    // 0. The AC5 gate: automatic memory disabled GLOBALLY, or for THIS
    //    Agent, stops the automatic write here — before provenance, before
    //    the scan, before anything exists. Explicit user writes never
    //    consult these switches.
    const settings = this.deps.memory.findSettings(input.workspace_id);
    if (settings && settings.auto_memory_enabled === 0) {
      throw new MemoryServiceError(
        "MEMORY_AUTOMATIC_DISABLED",
        "policy",
        "automatic memory is disabled for this workspace",
      );
    }
    const agentSettings = this.deps.memory.findAgentSettings(
      input.workspace_id,
      input.proposed_by_agent_id,
    );
    if (agentSettings && agentSettings.auto_memory_enabled === 0) {
      throw new MemoryServiceError(
        "MEMORY_AUTOMATIC_DISABLED",
        "policy",
        "automatic memory is disabled for this Agent",
      );
    }
    // 1. Provenance (AC3) — before anything else.
    if (input.source_refs.length === 0) {
      throw new MemoryServiceError(
        "MEMORY_PROVENANCE_REQUIRED",
        "validation",
        "an automatic memory candidate requires at least one source reference",
      );
    }
    // 2. The write-time secret scan (AC2/D22) — the automatic path never
    //    becomes the leak path.
    const scan = await scanForSecrets(input.summary, input.content);
    if (scan.rejected) {
      throw new MemoryServiceError(
        "MEMORY_SECRET_REJECTED",
        "validation",
        "this memory candidate looks like a credential or secret; secrets are never stored in memory",
        { rules: scan.rejections.map((rejection) => rejection.rule) },
      );
    }
    if (input.operation_id) {
      const operation = this.deps.operations.getOperation(input.workspace_id, input.operation_id);
      if (!operation) {
        throw new MemoryServiceError(
          "MEMORY_OPERATION_NOT_FOUND",
          "state",
          "the referenced Operation does not exist in this workspace",
        );
      }
    }

    const now = this.now();
    const memoryId = `mem_${randomUUID()}`;
    const sourceRefs = JSON.stringify(input.source_refs);

    this.deps.tx.transaction((exec) => {
      // 3. The entry + its creation version.
      this.deps.memory.insertEntry(
        {
          workspace_id: input.workspace_id,
          memory_id: memoryId,
          scope: input.scope,
          owner_agent_id: input.scope === "agent_private" ? input.proposed_by_agent_id : null,
          operation_id: input.operation_id ?? null,
          task_id: input.task_id ?? null,
          summary: input.summary,
          content: input.content,
          sensitivity: input.sensitivity,
          source_refs: sourceRefs,
          confidence: input.confidence,
          created_by: input.proposed_by_agent_id,
          origin: "automatic",
          created_at: now,
          expires_at: input.expires_at ?? null,
        },
        exec,
      );
      this.deps.memory.insertVersion(
        {
          workspace_id: input.workspace_id,
          memory_id: memoryId,
          version: 1,
          summary: input.summary,
          content: input.content,
          sensitivity: input.sensitivity,
          source_refs: sourceRefs,
          confidence: input.confidence,
          change_kind: "created",
          changed_by: input.proposed_by_agent_id,
          created_at: now,
        },
        exec,
      );

      // 4. A sensitive candidate surfaces in the publication queue — the
      //    user's approval gate before ANY Agent sees it.
      if (input.sensitivity === "sensitive" && input.operation_id) {
        this.deps.memory.insertPublicationRequest(
          {
            workspace_id: input.workspace_id,
            request_id: `pubreq_${randomUUID()}`,
            memory_id: memoryId,
            operation_id: input.operation_id,
            requested_by: input.proposed_by_agent_id,
            status: "pending",
            created_at: now,
          },
          exec,
        );
      }

      // 5. The typed proposal event (G2): D37's payload, the proposing
      //    Agent as the envelope's actor, the scan already passed — the
      //    journal never receives a secret-shaped summary.
      const streamId = `memory:${input.workspace_id}`;
      const sequence = this.deps.journal.nextSequence(streamId, input.workspace_id, exec);
      const event: TypedExecutionEvent = {
        event_id: `evt_memory_candidate_${randomUUID()}`,
        stream_id: streamId,
        sequence,
        event_version: 1,
        actor: { type: "agent", id: input.proposed_by_agent_id },
        task_id: input.task_id ?? "memory",
        conversation_id: input.operation_id ?? "memory",
        occurred_at: now,
        redaction_class: "internal",
        event_type: "memory.candidate_proposed",
        payload: {
          memory_id: memoryId,
          scope: input.scope,
          summary: input.summary,
          source_refs: input.source_refs,
          confidence: input.confidence,
          sensitivity: input.sensitivity,
          expires_at: input.expires_at ?? null,
        } satisfies MemoryCandidateProposedPayload,
      };
      this.deps.events.appendEvent({
        event_id: event.event_id,
        stream_id: event.stream_id,
        type: event.event_type,
        payload: event,
        workspace_id: input.workspace_id,
        correlation_id: memoryId,
      });
    });

    const entry = this.deps.memory.findEntry(input.workspace_id, memoryId);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the created memory row could not be read back",
      );
    }
    return {
      entry: this.toView(entry),
      publication_requested:
        input.sensitivity === "sensitive" &&
        input.operation_id !== undefined &&
        input.operation_id !== null,
    };
  }

  /**
   * The candidate proposals' journal rows for one workspace (the memory
   * stream) — the read the tests and the S9 provenance display consult.
   */
  listCandidateEvents(workspaceId: string): {
    event_id: string;
    event_type: "memory.candidate_proposed";
    actor: { type: string; id: string };
    payload: MemoryCandidateProposedPayload;
    occurred_at: string;
  }[] {
    const rows = this.deps.journal.listStream(`memory:${workspaceId}`, workspaceId);
    return rows
      .filter((row) => row.event_type === "memory.candidate_proposed")
      .map((row) => {
        const envelope = JSON.parse(row.payload) as TypedExecutionEvent;
        return {
          event_id: envelope.event_id,
          event_type: "memory.candidate_proposed" as const,
          actor: envelope.actor,
          payload: envelope.payload as MemoryCandidateProposedPayload,
          occurred_at: envelope.occurred_at,
        };
      });
  }

  // ── The user controls (PRD §11; AC4–AC6) ─────────────────────────────────

  /**
   * Edit one entry's content (AC4's first half): the CURRENT state changes,
   * the history APPENDS — the pre-edit content stays exactly where it was.
   * The write-time secret scan already ran for this command.
   */
  private editEntry(command: Extract<MemoryCommand, { type: "memory.edit" }>): {
    entry: MemoryEntryView;
  } {
    const entry = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the memory does not exist in this workspace",
      );
    }
    const now = this.now();
    const sourceRefs = JSON.stringify(command.source_refs);
    this.deps.tx.transaction((exec) => {
      this.deps.memory.updateEntry(
        command.workspace_id,
        command.memory_id,
        {
          summary: command.summary,
          content: command.content,
          sensitivity: command.sensitivity,
          source_refs: sourceRefs,
          confidence: command.confidence,
          updated_at: now,
          expires_at: command.expires_at,
        },
        exec,
      );
      this.deps.memory.insertVersion(
        {
          workspace_id: command.workspace_id,
          memory_id: command.memory_id,
          version: this.deps.memory.nextVersion(command.workspace_id, command.memory_id, exec),
          summary: command.summary,
          content: command.content,
          sensitivity: command.sensitivity,
          source_refs: sourceRefs,
          confidence: command.confidence,
          change_kind: "edited",
          changed_by: command.actor.id,
          created_at: now,
        },
        exec,
      );
    });
    const updated = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!updated) {
      throw new MemoryServiceError("MEMORY_NOT_FOUND", "state", "the memory disappeared");
    }
    return { entry: this.toView(updated) };
  }

  /**
   * Restore one earlier version (AC4): the entry's CURRENT content becomes
   * the version's content and the restore APPENDS a version row — the
   * history is preserved in full (the restored-from rows stay untouched,
   * including the edited one being discarded).
   */
  private restoreVersion(command: Extract<MemoryCommand, { type: "memory.restore" }>): {
    entry: MemoryEntryView;
  } {
    const entry = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the memory does not exist in this workspace",
      );
    }
    const version = this.deps.memory.findVersion(
      command.workspace_id,
      command.memory_id,
      command.version,
    );
    if (!version) {
      throw new MemoryServiceError(
        "MEMORY_VERSION_NOT_FOUND",
        "state",
        "that version does not exist in this memory's history",
      );
    }
    const now = this.now();
    this.deps.tx.transaction((exec) => {
      this.deps.memory.updateEntry(
        command.workspace_id,
        command.memory_id,
        {
          summary: version.summary,
          content: version.content,
          sensitivity: version.sensitivity,
          source_refs: version.source_refs,
          confidence: version.confidence,
          updated_at: now,
          expires_at: entry.expires_at,
        },
        exec,
      );
      this.deps.memory.insertVersion(
        {
          workspace_id: command.workspace_id,
          memory_id: command.memory_id,
          version: this.deps.memory.nextVersion(command.workspace_id, command.memory_id, exec),
          summary: version.summary,
          content: version.content,
          sensitivity: version.sensitivity,
          source_refs: version.source_refs,
          confidence: version.confidence,
          change_kind: "restored",
          changed_by: command.actor.id,
          created_at: now,
        },
        exec,
      );
    });
    const updated = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!updated) {
      throw new MemoryServiceError("MEMORY_NOT_FOUND", "state", "the memory disappeared");
    }
    return { entry: this.toView(updated) };
  }

  /**
   * Permanently forget (AC6): the entry, its versions, and its publication
   * requests leave ACTIVE storage — deleted rows, not a soft flag. The
   * honest copy says exactly that: there is nothing left to restore.
   */
  private forgetEntry(command: Extract<MemoryCommand, { type: "memory.forget" }>): {
    forgotten: true;
    memory_id: string;
  } {
    const entry = this.deps.memory.findEntry(command.workspace_id, command.memory_id);
    if (!entry) {
      throw new MemoryServiceError(
        "MEMORY_NOT_FOUND",
        "state",
        "the memory does not exist in this workspace",
      );
    }
    this.deps.tx.transaction((exec) => {
      this.deps.memory.forgetEntry(command.workspace_id, command.memory_id, exec);
    });
    return { forgotten: true, memory_id: command.memory_id };
  }

  /**
   * The forget preview (the S9 surface's honest confirmation copy): what a
   * permanent forget would remove — the entry AND how many version rows go
   * with it. Nothing here implies restorability.
   */
  forgetPreview(workspaceId: string, memoryId: string): { entries: number; versions: number } {
    const entry = this.deps.memory.findEntry(workspaceId, memoryId);
    return {
      entries: entry ? 1 : 0,
      versions: this.deps.memory.listVersions(workspaceId, memoryId).length,
    };
  }

  /** The global auto-memory switch (AC5): off stops EVERY automatic write. */
  private setAutoMemory(command: Extract<MemoryCommand, { type: "memory.set_auto_memory" }>): {
    global_enabled: boolean;
  } {
    this.deps.tx.transaction((exec) => {
      this.deps.memory.upsertSettings(command.workspace_id, command.enabled, this.now(), exec);
    });
    return { global_enabled: command.enabled };
  }

  /** One Agent's auto-memory switch (AC5): off stops THAT Agent's automatic writes. */
  private setAgentAutoMemory(
    command: Extract<MemoryCommand, { type: "memory.set_agent_auto_memory" }>,
  ): { agent_id: string; enabled: boolean } {
    this.deps.tx.transaction((exec) => {
      this.deps.memory.upsertAgentSettings(
        command.workspace_id,
        command.agent_id,
        command.enabled,
        this.now(),
        exec,
      );
    });
    return { agent_id: command.agent_id, enabled: command.enabled };
  }

  // ── Reads (the D37 visibility table) ──────────────────────────────────────

  /**
   * The USER's management read: every scope, every active entry (the D37
   * inspect power), the publication queue, and the auto-memory settings.
   */
  userView(workspaceId: string): MemoryUserView {
    const entries = this.deps.memory.listEntries(workspaceId);
    const views = entries.map((entry) => this.toView(entry, true));
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
        // The sensitive gate: a SENSITIVE entry enters the Operation context
        // only through the user's approval (published into THIS operation).
        if (entry.sensitivity === "sensitive") {
          return entry.published === 1 && entry.published_into_operation_id === operationId;
        }
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
        // The sensitive gate (D37: sensitive memories require user
        // approval): a SENSITIVE entry never reaches an Agent's context
        // until the user's approval published it — the owner's own private
        // rows excepted (they are theirs).
        if (entry.sensitivity === "sensitive") {
          if (entry.scope === "agent_private" && entry.owner_agent_id === agentId) {
            return true;
          }
          return entry.published === 1 && entry.published_into_operation_id === operationId;
        }
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

  private toView(entry: MemoryEntryRow, includeVersions = false): MemoryEntryView {
    const versions: MemoryVersionView[] = includeVersions
      ? this.deps.memory.listVersions(entry.workspace_id, entry.memory_id).map((version) => ({
          version: version.version,
          summary: version.summary,
          content: version.content,
          sensitivity: version.sensitivity,
          source_refs: parseSourceRefs(version.source_refs),
          confidence: version.confidence,
          change_kind: version.change_kind,
          changed_by: version.changed_by,
          created_at: version.created_at,
        }))
      : [];
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
      versions,
    };
  }
}

export { MemoryRepositoryError };
