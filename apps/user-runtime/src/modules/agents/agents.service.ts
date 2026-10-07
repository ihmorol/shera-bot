/**
 * Agents module service (S11 chunks 2–3; D32 layer 1, D39, D16, D23 module
 * shape).
 *
 * The Agent identities themselves are seeded by the startup composition
 * (compose.ts → seedAgentsFromPack); THIS service owns the agent-domain
 * operations that happen at request time: resolving an Agent together with
 * its direct chat, updating the user-owned fields, and — chunk 3 — the typed
 * D16 settings surface (getSettings + applySettingsCommand).
 *
 * D16 settings read model: getSettings composes every setting entry from
 * three sources — the agents row (pack-owned fields, the user-owned columns),
 * the validated overrides blob (tool defaults), and the pinned pack's agent
 * seeds, which are the source of the provider/model RECOMMENDED default (D16:
 * recommended defaults come from the pack where the pack carries the value;
 * module-level documented defaults only where it does not). applySettingsCommand
 * applies the contracts' command union — the SAME commands and schemas S30
 * onboarding will use — and returns the read-after-write snapshot. Commands
 * are naturally idempotent (last-write-wins of a validated value), so no
 * receipt store is needed here; settings mutations are NOT journaled in this
 * slice (the runtime has no agent-domain event stream yet).
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
  AgentCapabilities,
  AgentSettingsSnapshot,
  type AgentSettingEntry,
  type AgentSettingsCommand,
  type AgentSettingsOverrides,
  type EditableAgentSettingKey,
} from "@shera-bot/contracts";

import {
  AgentNotFoundError,
  AgentSettingsValidationError,
  isDirectChatConflict,
  type AgentRow,
  type AgentsRepository,
  type PackAgentSeed,
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

/**
 * Reset-to-default needs the pack's recommended provider/model, and the pack
 * is the ONLY honest source (D16 forbids inventing provider picks). When no
 * seed carries it (composition without a pinned pack), the reset is the typed
 * rejection below — not a silently hardcoded value.
 */
export class AgentSettingsResetUnavailableError extends Error {
  readonly code = "AGENT_SETTINGS_RESET_UNAVAILABLE" as const;
  readonly category = "state" as const;

  constructor(workspaceId: string, agentId: string) {
    super(
      `no pack-supplied recommended default for agent ${agentId} in workspace ${workspaceId}`,
    );
    this.name = "AgentSettingsResetUnavailableError";
  }
}

export interface AgentsServiceDeps {
  agents: AgentsRepository;
  conversations: ConversationsRepository;
  journal: EventsService;
  tx: SqliteTransactions;
  /** Post-commit live fanout; optional in tests. */
  publish?: AgentDirectChatPublisher;
  /**
   * The pinned pack's agent seeds — the source of recommended defaults (D16).
   * Optional: composeRuntime sets them once the pack has loaded (late-bound,
   * like the publish hook); tests and packless compositions run without them,
   * in which case provider recommendations are null and provider resets are
   * the typed unavailable rejection.
   */
  packAgents?: readonly PackAgentSeed[];
}

export interface DirectChatResolution {
  agent: AgentRow;
  conversation_id: string;
  /** True when THIS call created the chat; false when an existing binding resolved. */
  created: boolean;
}

export class AgentsService {
  private packSeeds: readonly PackAgentSeed[];

  constructor(private readonly deps: AgentsServiceDeps) {
    this.packSeeds = deps.packAgents ?? [];
  }

  /**
   * Late-bind the pinned pack's seeds (composeRuntime calls this right after
   * loadWorkspacePack — the same late-binding discipline as the publish hook).
   */
  setPackAgents(seeds: readonly PackAgentSeed[]): void {
    this.packSeeds = seeds;
  }

  private packSeed(agentId: string): PackAgentSeed | undefined {
    return this.packSeeds.find((seed) => seed.agent_id === agentId);
  }

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
   * The D16 settings read model (S11 chunk 3): every setting as a typed entry
   * with the metadata the settings UI must surface — display label, current
   * value, recommended default, why it matters, risk/cost impact, editability,
   * and the reset-to-default command. Validated through the contracts'
   * snapshot schema before it leaves the module.
   */
  getSettings(workspaceId: string, agentId: string): AgentSettingsSnapshot {
    const agent = this.getAgent(workspaceId, agentId);
    return this.buildSettingsSnapshot(
      workspaceId,
      agent,
      this.deps.agents.getSettings(workspaceId, agentId),
    );
  }

  /**
   * Apply one D16 settings command (the contracts' AgentSettingsCommand union
   * — the SAME commands S30 onboarding submits) and return the read-after-
   * write snapshot. Unknown agents fail with the typed 404-class rejection
   * before anything is written; provider resets fail typed when no pack seed
   * carries the recommended default (never a hardcoded provider pick).
   */
  applySettingsCommand(command: AgentSettingsCommand): AgentSettingsSnapshot {
    const { workspace_id: workspaceId, agent_id: agentId } = command;
    switch (command.type) {
      case "agent_settings.update_instructions":
        this.deps.agents.updateUserInstructions(workspaceId, agentId, command.user_instructions);
        break;
      case "agent_settings.update_default_provider":
        this.deps.agents.updateDefaultProvider(
          workspaceId,
          agentId,
          command.default_provider.provider_id,
          command.default_provider.model,
        );
        break;
      case "agent_settings.update_tool_defaults":
        this.deps.agents.updateSettings(workspaceId, agentId, {
          tool_defaults: command.tool_defaults,
        });
        break;
      case "agent_settings.reset_setting":
        this.resetSetting(workspaceId, agentId, command.setting_key);
        break;
      case "agent_settings.reset_all":
        this.deps.agents.updateUserInstructions(workspaceId, agentId, null);
        this.resetProviderToRecommended(workspaceId, agentId);
        this.deps.agents.updateSettings(workspaceId, agentId, {});
        break;
    }
    return this.getSettings(workspaceId, agentId);
  }

  private resetSetting(
    workspaceId: string,
    agentId: string,
    key: EditableAgentSettingKey,
  ): void {
    switch (key) {
      case "user_instructions":
        this.deps.agents.updateUserInstructions(workspaceId, agentId, null);
        return;
      case "default_provider":
        this.resetProviderToRecommended(workspaceId, agentId);
        return;
      case "tool_defaults":
        this.deps.agents.updateSettings(workspaceId, agentId, { tool_defaults: [] });
        return;
    }
  }

  private resetProviderToRecommended(workspaceId: string, agentId: string): void {
    const seed = this.packSeed(agentId);
    if (seed === undefined) {
      throw new AgentSettingsResetUnavailableError(workspaceId, agentId);
    }
    this.deps.agents.updateDefaultProvider(
      workspaceId,
      agentId,
      seed.default_provider.provider_id,
      seed.default_provider.model,
    );
  }

  private buildSettingsSnapshot(
    workspaceId: string,
    agent: AgentRow,
    overrides: AgentSettingsOverrides,
  ): AgentSettingsSnapshot {
    const seed = this.packSeed(agent.agent_id);
    const entries: AgentSettingEntry[] = [
      {
        key: "role",
        display_label: "Role",
        description:
          "The fixed role the pack declared for this Agent; your instructions layer above it.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: agent.role_description,
        recommended_default: null,
      },
      {
        key: "user_instructions",
        display_label: "Your instructions",
        description:
          "Personal guidance layered above the pack role. Clearing it returns to pack-only behavior.",
        risk_note: "",
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: agent.user_instructions,
        recommended_default: null,
      },
      {
        key: "memory_link",
        display_label: "Memory",
        description:
          "This Agent's private memory folder. Publication rules arrive with the memory slice.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: agent.private_folder_path,
        recommended_default: null,
      },
      {
        key: "default_provider",
        display_label: "Default provider and model",
        description: "Which provider and model answer by default for this Agent.",
        risk_note:
          "Providers differ in privacy and cost behavior; the pack's recommendation avoids surprises.",
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: {
          provider_id: agent.default_provider_id,
          model: agent.default_provider_model,
        },
        recommended_default: seed ? { ...seed.default_provider } : null,
      },
      {
        key: "tool_defaults",
        display_label: "Tool defaults",
        description: "Per-tool default configuration used whenever this Agent runs a tool.",
        risk_note: "Tool configuration changes what the Agent can do; defaults stay conservative.",
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: overrides.tool_defaults ?? [],
        recommended_default: [],
      },
      {
        key: "capabilities",
        display_label: "Capabilities",
        description: "The skills, tools, and connectors the pack gave this Agent.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: this.parseCapabilities(agent),
        recommended_default: null,
      },
      {
        key: "ui_identity",
        display_label: "Appearance",
        description:
          "Authored visual identity (hue and glyph); presentation only, never a capability.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: { avatar_hue: agent.avatar_hue, initial_glyph: agent.initial_glyph },
        recommended_default: null,
      },
    ];
    return AgentSettingsSnapshot.parse({
      workspace_id: workspaceId,
      agent_id: agent.agent_id,
      entries,
    });
  }

  private parseCapabilities(agent: AgentRow): AgentCapabilities {
    let raw: unknown;
    try {
      raw = JSON.parse(agent.capabilities_json);
    } catch {
      throw new AgentSettingsValidationError("stored agent capabilities JSON");
    }
    const parsed = AgentCapabilities.safeParse(raw);
    if (!parsed.success) {
      throw new AgentSettingsValidationError("stored agent capabilities JSON");
    }
    return parsed.data;
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
