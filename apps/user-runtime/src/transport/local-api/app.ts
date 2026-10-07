/**
 * The typed local API (S07; D11, D26, D23 module shape).
 *
 * Express 5 app factory for the container's loopback surface. Commands are
 * the ONLY mutation path (D26): the request body is the chunk-2 command
 * envelope (`ConversationCommand` — the same Zod schema the conversations
 * module owns; no second envelope format), and every failure answers with
 * the SheraError taxonomy through the shared typed error middleware.
 *
 * Versioning follows the @shera-bot/contracts convention (see
 * SUBMIT_TASK_COMMAND_PATH): literal `/v1/...` path constants exported from
 * the transport module so tests and later clients share one definition.
 *
 * No WebSocket, health, or heartbeat surface lives here (later chunks).
 */
import express, { type Express } from "express";
import { z } from "zod";

import { Id, WorkspaceId } from "@shera-bot/contracts";

import type { AgentRow } from "../../adapters/sqlite/agents-repository.ts";
import { conversationStreamFor } from "../../modules/conversations/conversations.events.ts";
import type { AgentsService } from "../../modules/agents/agents.service.ts";
import type { ConversationsService } from "../../modules/conversations/conversations.service.ts";
import { ConversationCommand } from "../../modules/conversations/conversations.types.ts";
import type { ReplayService } from "../../modules/events/replay.service.ts";
import {
  contractValidationResponse,
  createTypedErrorRequestHandler,
  notFoundRequestHandler,
  type RedactedLogger,
} from "../http/typed-errors.ts";

export const SUBMIT_CONVERSATION_COMMAND_PATH = "/v1/conversations/commands" as const;
export const LIST_CONVERSATION_EVENTS_PATH = "/v1/conversations/:conversation_id/events" as const;
export const LIST_AGENTS_PATH = "/v1/agents" as const;
export const GET_AGENT_PATH = "/v1/agents/:agent_id" as const;
export const PATCH_AGENT_INSTRUCTIONS_PATH = "/v1/agents/:agent_id/instructions" as const;
export const PATCH_AGENT_PROVIDER_PATH = "/v1/agents/:agent_id/provider" as const;

/**
 * Replay query (D26): the client's last acknowledged sequence drives exactly
 * which durable events are missed. `workspace_id` scopes every read (E12);
 * the principal-to-workspace binding arrives with the authenticated transport
 * wiring in a later chunk — the prototype takes it from the query.
 */
const ConversationEventsQuery = z.strictObject({
  workspace_id: WorkspaceId,
  last_acknowledged_sequence: z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
});

/** S11: every agent route is workspace-scoped (E12) — by query on reads. */
const AgentWorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

/**
 * S11 PATCH bodies. The user_instructions cap mirrors the message size class
 * (it is prose, not a document; typed D16 settings schemas refine this later).
 * `null` clears the instructions back to pack-only behavior.
 */
const AgentInstructionsPatchBody = z.strictObject({
  workspace_id: WorkspaceId,
  user_instructions: z.string().min(1).max(8000).nullable(),
});

/** Placeholder provider values until the providers slice owns real catalogs. */
const AgentProviderPatchBody = z.strictObject({
  workspace_id: WorkspaceId,
  default_provider: z.strictObject({
    provider_id: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
  }),
});

/** The allowlisted Agent summary payload — identity fields only, no memory. */
interface AgentSummaryPayload {
  agent_id: string;
  display_name: string;
  role_description: string;
  avatar_hue: number;
  initial_glyph: string;
  has_user_instructions: boolean;
}

function agentSummary(row: AgentRow): AgentSummaryPayload {
  return {
    agent_id: row.agent_id,
    display_name: row.display_name,
    role_description: row.role_description,
    avatar_hue: row.avatar_hue,
    initial_glyph: row.initial_glyph,
    has_user_instructions: row.user_instructions !== null,
  };
}

/** The detail payload: the summary plus what the settings UI edits and the direct chat id. */
function agentDetail(row: AgentRow, directChatId: string) {
  return {
    ...agentSummary(row),
    user_instructions: row.user_instructions,
    default_provider: {
      provider_id: row.default_provider_id,
      model: row.default_provider_model,
    },
    direct_chat_id: directChatId,
  };
}

export interface LocalApiDeps {
  /** The only mutation path (D26) — the conversations module's command gate. */
  conversations: Pick<ConversationsService, "executeCommand">;
  /** AC4 replay resolution — always the journal's ReplayService, never re-implemented here. */
  replay: Pick<ReplayService, "resolve">;
  /**
   * S11: the agents seam. Identity reads and the user-owned field updates go
   * through the agents module's service — the transport never touches SQL.
   */
  agents: Pick<
    AgentsService,
    "listAgents" | "getAgentWithDirectChat" | "updateUserInstructions" | "updateDefaultProvider"
  >;
  /**
   * B-1: the redacted sink untyped HTTP faults are recorded to — the generic
   * INTERNAL_ERROR's correlation_id is logged with it, so "The failure has
   * been recorded." is true. Default: a single JSON line on console.error.
   */
  logUntypedFault?: RedactedLogger;
}

export function createLocalApi(deps: LocalApiDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  /**
   * Submit one command. Transport-level schema mismatches are the contract's
   * typed 400; module-level typed rejections (unknown conversation, revision
   * conflict, journal failures) are thrown and mapped by the error middleware
   * to their stable statuses.
   */
  app.post(SUBMIT_CONVERSATION_COMMAND_PATH, (req, res) => {
    const parsed = ConversationCommand.safeParse(req.body);
    if (!parsed.success) {
      const { status, body } = contractValidationResponse(
        "The command body is not a valid conversation command.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json(deps.conversations.executeCommand(parsed.data));
  });

  /**
   * Replay a conversation's stream from the client's cursor (AC4/E10): the
   * response replays exactly the missed durable events in order once, or —
   * below the retention horizon — a snapshot plus a fresh cursor. The result
   * IS the ReplayService's discriminated union, unmodified.
   */
  app.get(LIST_CONVERSATION_EVENTS_PATH, (req, res) => {
    const conversationId = Id.safeParse(req.params.conversation_id);
    const query = ConversationEventsQuery.safeParse(req.query);
    if (!conversationId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The replay request is not valid: a workspace_id and a last_acknowledged_sequence are required.",
      );
      res.status(status).json(body);
      return;
    }
    const result = deps.replay.resolve(
      query.data.workspace_id,
      conversationStreamFor(conversationId.data),
      query.data.last_acknowledged_sequence,
    );
    res.status(200).json(result);
  });

  /**
   * S11: the workspace's Agent identities (Pack → Operations → Agents). The
   * summary payload is strictly allowlisted — identity fields only; no other
   * agent's memory, capabilities blobs, or provider internals (G3).
   */
  app.get(LIST_AGENTS_PATH, (req, res) => {
    const query = AgentWorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The agent list request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json({
      agents: deps.agents.listAgents(query.data.workspace_id).map(agentSummary),
    });
  });

  /**
   * S11: one Agent plus its direct chat id — the id the UI opens the chat
   * with. The binding is get-or-create: the first read creates the chat with
   * full conversation-creation discipline (journaled, published after
   * commit) and every later read resolves the SAME conversation (D39). An
   * unknown Agent (or another workspace's) throws the typed 404.
   */
  app.get(GET_AGENT_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const query = AgentWorkspaceQuery.safeParse(req.query);
    if (!agentId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The agent request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    const { agent, conversation_id } = deps.agents.getAgentWithDirectChat(
      query.data.workspace_id,
      agentId.data,
    );
    res.status(200).json(agentDetail(agent, conversation_id));
  });

  /**
   * S11: update the user-owned instructions layer (PATCH, not PUT — only
   * this field moves). Unknown Agent → typed 404; schema mismatch → the
   * contract's typed 400. `null` clears back to pack-only behavior.
   */
  app.patch(PATCH_AGENT_INSTRUCTIONS_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const body = AgentInstructionsPatchBody.safeParse(req.body);
    if (!agentId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The instructions request is not valid: a workspace_id and user_instructions are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const agent = deps.agents.updateUserInstructions(
      body.data.workspace_id,
      agentId.data,
      body.data.user_instructions,
    );
    res.status(200).json(agentSummary(agent));
  });

  /**
   * S11: update the user-owned default provider pair (placeholder values
   * until the providers slice). Unknown Agent → typed 404.
   */
  app.patch(PATCH_AGENT_PROVIDER_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const body = AgentProviderPatchBody.safeParse(req.body);
    if (!agentId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The provider request is not valid: a workspace_id and a default_provider pair are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const agent = deps.agents.updateDefaultProvider(
      body.data.workspace_id,
      agentId.data,
      body.data.default_provider.provider_id,
      body.data.default_provider.model,
    );
    res.status(200).json(agentSummary(agent));
  });

  /**
   * Health probe (transport status only, never a business event). Same path
   * and response shape as the S06 internal API's probe; the local surface is
   * loopback-only in the prototype, so it carries no credential gate here.
   */
  app.get("/internal/v1/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Typed failures and unknown routes: the SheraError taxonomy, never an
  // Express default page, a stack trace, or raw internals (D23 rule 4, G3).
  // Untyped faults are additionally recorded through the injected redacted
  // sink (B-1) — the correlation_id the client receives is the one logged.
  app.use(notFoundRequestHandler);
  app.use(createTypedErrorRequestHandler(deps.logUntypedFault));
  return app;
}
