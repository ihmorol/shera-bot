/**
 * Conversations service (S07; AC2, AC6, D23 module shape, D26).
 *
 * Commands are the only mutation path: executeCommand validates the command
 * (G2 — the gateway validates what it executes), replays a recorded receipt
 * for a repeated idempotency key instead of duplicating effects, and runs the
 * state transition, its event append, AND the receipt inside ONE transaction
 * (AC2 + D23 rule 6): a failure anywhere rolls back all three. The event
 * payload is validated against the journal's registry before append, so a
 * validation failure after the row update demonstrates the rollback honestly.
 *
 * Live fanout happens strictly AFTER the transaction commits (never for a
 * rolled-back event) through the injected `publish` hook — the WebSocket
 * layer implements it and owns no mutation path (D26, AC8).
 */
import { randomUUID } from "node:crypto";

import type { DatabaseSync } from "node:sqlite";

import type { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import type {
  ConversationsRepository,
  ConversationRow,
} from "../../adapters/sqlite/conversations-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import type { EventEnvelope } from "../events/events.types.ts";
import { conversationStreamFor, type ConversationEvent } from "./conversations.events.ts";
import {
  ConversationsServiceError,
  type ConversationCommand,
  type ConversationCommandResult,
} from "./conversations.types.ts";

export type ConversationPublisher = (event: ConversationEvent) => void;

export interface ConversationsServiceDeps {
  journal: EventsService;
  conversations: ConversationsRepository;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  /** Post-commit live fanout (WebSocket layer); optional in tests. */
  publish?: ConversationPublisher;
}

interface StoredReceipt {
  kind: "created" | "renamed";
  conversation_id: string;
  title: string;
  revision: number;
  event_id: string;
}

export class ConversationsService {
  constructor(private readonly deps: ConversationsServiceDeps) {}

  /**
   * The only mutation entry point for conversations (D26): idempotent by
   * idempotency_key, optimistic by expected_revision, atomic by transaction.
   */
  executeCommand(command: ConversationCommand): ConversationCommandResult {
    // Structural guard BEFORE any storage access: a malformed envelope must
    // surface as a typed rejection, never as a raw SQLite binding error
    // leaking out of the receipt lookup (G2 — the gateway validates what it
    // executes; the transport schema is the first gate, this is the second).
    if (
      typeof command.workspace_id !== "string" ||
      command.workspace_id.length === 0 ||
      typeof command.idempotency_key !== "string" ||
      command.idempotency_key.length === 0
    ) {
      throw new ConversationsServiceError(
        "COMMAND_PAYLOAD_INVALID",
        "validation",
        "command envelope is malformed: workspace_id and idempotency_key are required",
      );
    }

    const receipt = this.deps.receipts.findById(command.workspace_id, command.idempotency_key);
    if (receipt) {
      const stored = JSON.parse(receipt.result_json) as StoredReceipt;
      return {
        kind: stored.kind,
        conversation_id: stored.conversation_id,
        title: stored.title,
        revision: stored.revision,
        event_id: stored.event_id,
      };
    }

    switch (command.type) {
      case "conversation.create":
        return this.executeCreate(command);
      case "conversation.rename":
        return this.executeRename(command);
      default: {
        // The discriminated union makes this unreachable; a bad type arriving
        // here means the transport skipped validation (G2 — fail loudly).
        throw new ConversationsServiceError(
          "COMMAND_UNKNOWN_TYPE",
          "validation",
          `command type ${(command as { type?: string }).type ?? "unknown"} is not accepted`,
        );
      }
    }
  }

  private executeCreate(
    command: Extract<ConversationCommand, { type: "conversation.create" }>,
  ): ConversationCommandResult {
    return this.runWithReceipt(command, (exec) => {
      const conversationId = randomUUID();
      const now = new Date().toISOString();
      const conversation: ConversationRow = {
        id: conversationId,
        workspace_id: command.workspace_id,
        title: command.payload.title,
        revision: 1,
        created_at: now,
        updated_at: now,
      };
      this.deps.conversations.create(conversation, exec);

      const event = this.deps.journal.appendEvent({
        event_id: randomUUID(),
        stream_id: conversationStreamFor(conversationId),
        type: "conversation.created",
        payload: {
          conversation_id: conversationId,
          workspace_id: command.workspace_id,
          title: command.payload.title,
        },
        workspace_id: command.workspace_id,
        correlation_id: command.idempotency_key,
      });

      return {
        stored: {
          kind: "created",
          conversation_id: conversationId,
          title: command.payload.title,
          revision: 1,
          event_id: event.event_id,
        },
        event,
      };
    });
  }

  private executeRename(
    command: Extract<ConversationCommand, { type: "conversation.rename" }>,
  ): ConversationCommandResult {
    return this.runWithReceipt(command, (exec) => {
      const existing = this.deps.conversations.findById(
        command.workspace_id,
        command.payload.conversation_id,
        exec,
      );
      if (!existing) {
        throw new ConversationsServiceError(
          "CONVERSATION_NOT_FOUND",
          "state",
          `conversation ${command.payload.conversation_id} does not exist in this workspace`,
        );
      }
      if (existing.revision !== command.payload.expected_revision) {
        throw new ConversationsServiceError(
          "CONVERSATION_REVISION_CONFLICT",
          "conflict",
          `expected revision ${command.payload.expected_revision}, current revision is ${existing.revision}`,
        );
      }

      const now = new Date().toISOString();
      const renamed = this.deps.conversations.rename(
        command.workspace_id,
        command.payload.conversation_id,
        command.payload.expected_revision,
        command.payload.title,
        now,
        exec,
      );
      if (!renamed) {
        throw new ConversationsServiceError(
          "CONVERSATION_REVISION_CONFLICT",
          "conflict",
          "rename matched no row at the expected revision",
        );
      }

      const event = this.deps.journal.appendEvent({
        event_id: randomUUID(),
        stream_id: conversationStreamFor(command.payload.conversation_id),
        type: "conversation.renamed",
        payload: {
          conversation_id: command.payload.conversation_id,
          workspace_id: command.workspace_id,
          title: command.payload.title,
          previous_revision: command.payload.expected_revision,
          new_revision: renamed.revision,
        },
        workspace_id: command.workspace_id,
        correlation_id: command.idempotency_key,
      });

      return {
        stored: {
          kind: "renamed",
          conversation_id: command.payload.conversation_id,
          title: command.payload.title,
          revision: renamed.revision,
          event_id: event.event_id,
        },
        event,
      };
    });
  }

  /**
   * One transaction wraps the transition, the event append, and the receipt
   * write; the publish hook fires strictly after COMMIT so live subscribers
   * never see a rolled-back event (AC2, D26).
   */
  private runWithReceipt(
    command: ConversationCommand,
    unit: (exec: DatabaseSync) => { stored: StoredReceipt; event: ConversationEvent },
  ): ConversationCommandResult {
    const { stored, event } = this.deps.tx.transaction((exec) => {
      const result = unit(exec);
      this.deps.receipts.create(
        {
          workspace_id: command.workspace_id,
          idempotency_key: command.idempotency_key,
          command_type: command.type,
          result_json: JSON.stringify(result.stored),
          created_at: new Date().toISOString(),
        },
        exec,
      );
      return result;
    });

    this.deps.publish?.(event);
    return {
      kind: stored.kind,
      conversation_id: stored.conversation_id,
      title: stored.title,
      revision: stored.revision,
      event_id: stored.event_id,
    };
  }
}

/** Re-export for transport mapping without widening the service surface. */
export type { EventEnvelope };
