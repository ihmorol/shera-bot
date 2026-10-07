/**
 * Agents module service (S11 chunk 2; D32 layer 1, D39, D23 module shape).
 *
 * The Agent identities themselves are seeded by the startup composition
 * (compose.ts → seedAgentsFromPack); THIS service owns the agent-domain
 * operations that happen at request time: resolving an Agent together with
 * its direct chat, and updating the user-owned fields.
 *
 * Direct chats (D39 — one identity everywhere): getOrCreateDirectChat binds
 * exactly one conversation per (workspace, agent), and the binding references
 * the SAME agent_id as the agents row — never a duplicate identity. Creation
 * runs like every conversation creation (S07 discipline): the conversation
 * row, its `conversation.created` journal append, AND the binding row commit
 * in ONE transaction, and the post-commit publish hook fires only after
 * COMMIT so live subscribers never see a rolled-back event (AC2, B4).
 *
 * Get-or-create race containment (B5): two concurrent first calls can both
 * miss the read; the loser's binding insert hits the winner's committed
 * (workspace_id, agent_id) primary key, which rolls THIS unit back atomically
 * (no orphan conversation, no journal row) and re-reads the winner's binding
 * — the exact contract of the non-race path.
 */
import { randomUUID } from "node:crypto";

import {
  AgentNotFoundError,
  isDirectChatConflict,
  type AgentRow,
  type AgentsRepository,
} from "../../adapters/sqlite/agents-repository.ts";
import type {
  ConversationsRepository,
} from "../../adapters/sqlite/conversations-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { EventsService } from "../events/events.service.ts";
import {
  conversationStreamFor,
  type ConversationCreatedEvent,
} from "../conversations/conversations.events.ts";

/**
 * Post-commit live fanout for a newly created direct chat (the WebSocket
 * layer implements it; the same containment rules as every other stream).
 */
export type AgentDirectChatPublisher = (event: ConversationCreatedEvent) => void;

export interface AgentsServiceDeps {
  agents: AgentsRepository;
  conversations: ConversationsRepository;
  journal: EventsService;
  tx: SqliteTransactions;
  /** Post-commit live fanout; optional in tests. */
  publish?: AgentDirectChatPublisher;
}

export interface DirectChatResolution {
  agent: AgentRow;
  conversation_id: string;
  /** True when THIS call created the chat; false when an existing binding resolved. */
  created: boolean;
}

export class AgentsService {
  constructor(private readonly deps: AgentsServiceDeps) {}

  /** The workspace's Agent identities, workspace-scoped (E12). */
  listAgents(workspaceId: string): AgentRow[] {
    return this.deps.agents.listAgents(workspaceId);
  }

  /** One Agent of THIS workspace; a foreign workspace's Agent is unreachable. */
  getAgent(workspaceId: string, agentId: string): AgentRow {
    const agent = this.deps.agents.getAgent(workspaceId, agentId);
    if (agent === null) {
      throw new AgentNotFoundError(workspaceId, agentId);
    }
    return agent;
  }

  /**
   * The Agent PLUS its direct chat id (what the UI opens): get-or-create
   * semantics — the first call creates and journals the chat, every later
   * call resolves the SAME conversation.
   */
  getAgentWithDirectChat(workspaceId: string, agentId: string): {
    agent: AgentRow;
    conversation_id: string;
  } {
    const chat = this.getOrCreateDirectChat(workspaceId, agentId);
    return { agent: chat.agent, conversation_id: chat.conversation_id };
  }

  /** Update the user-owned instructions layer above the pack's role description. */
  updateUserInstructions(
    workspaceId: string,
    agentId: string,
    instructions: string | null,
  ): AgentRow {
    // Throws AgentNotFoundError for an unknown agent — nothing is written.
    this.deps.agents.updateUserInstructions(workspaceId, agentId, instructions);
    return this.getAgent(workspaceId, agentId);
  }

  /** Update the user-owned default provider pair (placeholder values until the providers slice). */
  updateDefaultProvider(
    workspaceId: string,
    agentId: string,
    providerId: string,
    model: string,
  ): AgentRow {
    this.deps.agents.updateDefaultProvider(workspaceId, agentId, providerId, model);
    return this.getAgent(workspaceId, agentId);
  }

  /**
   * Resolve the Agent's direct chat, creating it (atomically, journaled,
   * published after commit) when no binding exists yet. The chat's title is
   * the Agent's display name; a later pack re-seed that renames the Agent
   * does not rewrite chat history — the journal is immutable (D26).
   */
  getOrCreateDirectChat(workspaceId: string, agentId: string): DirectChatResolution {
    const agent = this.getAgent(workspaceId, agentId);

    const existing = this.deps.agents.findDirectChat(workspaceId, agentId);
    if (existing !== null) {
      return { agent, conversation_id: existing, created: false };
    }

    let committed: { conversation_id: string; event: ConversationCreatedEvent };
    try {
      committed = this.deps.tx.transaction((exec: SqliteExec) => {
        const conversationId = randomUUID();
        const now = new Date().toISOString();
        this.deps.conversations.create(
          {
            id: conversationId,
            workspace_id: workspaceId,
            title: agent.display_name,
            revision: 1,
            created_at: now,
            updated_at: now,
          },
          exec,
        );
        const event = this.deps.journal.appendEvent({
          event_id: randomUUID(),
          stream_id: conversationStreamFor(conversationId),
          type: "conversation.created",
          payload: {
            conversation_id: conversationId,
            workspace_id: workspaceId,
            title: agent.display_name,
          },
          workspace_id: workspaceId,
          correlation_id: `agent-direct-chat:${workspaceId}:${agentId}`,
        });
        this.deps.agents.bindDirectChat(workspaceId, agentId, conversationId, now, exec);
        return { conversation_id: conversationId, event };
      });
    } catch (error) {
      if (isDirectChatConflict(error)) {
        const winner = this.deps.agents.findDirectChat(workspaceId, agentId);
        if (winner !== null) {
          return { agent, conversation_id: winner, created: false };
        }
      }
      throw error;
    }

    // Strictly AFTER commit (AC8): a subscriber failure is contained by the
    // composition's fanout wrapper and never fails the committed creation.
    this.deps.publish?.(committed.event);
    return { agent, conversation_id: committed.conversation_id, created: true };
  }
}
