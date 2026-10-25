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

import {
  AgentSettingsCommand,
  Id,
  OperationCollaborationEvent,
  OperationCoordinatorRef,
  type OperationRecord,
  type OperationRun,
  WorkspaceId,
} from "@shera-bot/contracts";

import type { AgentRow } from "../../adapters/sqlite/agents-repository.ts";
import type {
  OperationRosterMemberRow,
  OperationRosterRefusalRow,
} from "../../adapters/sqlite/operations-repository.ts";
import { conversationStreamFor } from "../../modules/conversations/conversations.events.ts";
import type { AgentFoldersService } from "../../modules/agents/agent-folders.service.ts";
import type { AgentsService } from "../../modules/agents/agents.service.ts";
import type { ConversationsService } from "../../modules/conversations/conversations.service.ts";
import { ConversationCommand } from "../../modules/conversations/conversations.types.ts";
import type { AgentSessionPresence } from "../../modules/sessions/session-supervisor.service.ts";
import type { ReplayService } from "../../modules/events/replay.service.ts";
import { MessageSender } from "../../modules/events/events.types.ts";
import type { OperationsService } from "../../modules/operations/operations.service.ts";
import { ADHOC_AUTO_LABEL_PATTERN } from "../../modules/operations/operations.service.ts";
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
export const GET_AGENT_SETTINGS_PATH = "/v1/agents/:agent_id/settings" as const;
export const SUBMIT_AGENT_SETTINGS_COMMAND_PATH = "/v1/agents/:agent_id/settings/commands" as const;
export const GET_AGENT_FOLDER_ACCESS_PATH = "/v1/agents/:agent_id/folder" as const;
// S13 — the Operation chat surface (D31, D36, D34/D46, D7, D41).
export const CREATE_OPERATION_PATH = "/v1/operations" as const;
export const LIST_OPERATIONS_PATH = "/v1/operations" as const;
export const GET_OPERATION_PATH = "/v1/operations/:operation_id" as const;
export const OPERATION_ROSTER_COMMANDS_PATH =
  "/v1/operations/:operation_id/roster/commands" as const;
export const OPERATION_COORDINATOR_PATH = "/v1/operations/:operation_id/coordinator" as const;
export const OPERATION_RENAME_PATH = "/v1/operations/:operation_id/rename" as const;
export const OPERATION_RUNS_PATH = "/v1/operations/:operation_id/runs" as const;
export const OPERATION_RUN_PATH = "/v1/operations/:operation_id/runs/:run_id" as const;
export const OPERATION_EVENTS_PATH = "/v1/operations/:operation_id/events" as const;
export const OPERATION_THREAD_PATH = "/v1/operations/:operation_id/thread" as const;
export const OPERATION_THREAD_MESSAGES_PATH =
  "/v1/operations/:operation_id/thread/messages" as const;

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
 * S13: every operation route is workspace-scoped the SAME way (E12) — the
 * loopback local API accepts the workspace from the query (reads) or the
 * command envelope (commands); the browser-facing surface is the web client
 * proxy's concern and keeps this same trust boundary.
 */
const OperationWorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

/** POST /v1/operations — create one Operation chat record (D31, D29 pinning). */
const CreateOperationBody = z.strictObject({
  workspace_id: WorkspaceId,
  /** Null for ad-hoc Operations (D41, D29). */
  definition_ref: z.string().min(1).max(512).nullable(),
  /**
   * S14 (D41): optional for ad-hoc creates — omitted/empty/null names the
   * Operation `Ad-hoc · N Agents` at the service; a pack-defined create
   * without one is the typed OPERATION_NAME_REQUIRED (400) from the service.
   */
  name: z.string().max(200).nullish(),
  /**
   * The EMPTY roster is admitted to the service on purpose: the typed
   * OPERATION_ROSTER_EMPTY refusal (400) is the service's D41 rule, not a
   * route-schema shape error — the client gets the real refusal code.
   */
  roster_agent_ids: z.array(z.string().min(1).max(256)).min(0).max(50),
  coordinator_agent_id: OperationCoordinatorRef,
});

/** POST /v1/operations/:id/coordinator — set an Agent or "none" (D42/D49). */
const OperationCoordinatorBody = z.strictObject({
  workspace_id: WorkspaceId,
  coordinator_agent_id: OperationCoordinatorRef,
});

/** POST /v1/operations/:id/runs — create one run (D31; typed creation, D34). */
const OperationRunCreateBody = z.strictObject({
  workspace_id: WorkspaceId,
  run_id: z.string().min(1).max(256).optional(),
  /** The D34/D46 delegation link: the parent RUN's id. */
  parent_task_id: z.string().min(1).max(256).optional(),
});

/** GET /v1/operations/:id/events — the D26 cursor read for the runs panel. */
const OperationEventsQuery = z.strictObject({
  workspace_id: WorkspaceId,
  /** Absent = every stream of the Operation; present = that run's stream. */
  run_id: z.string().min(1).max(256).optional(),
  after_sequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

/** GET /v1/operations/:id/thread — the merged thread read model. */
const OperationThreadQuery = z.strictObject({
  workspace_id: WorkspaceId,
  /** Journal-sequence cursor for the MESSAGE leg (exclusive); events come in full. */
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

/** POST /v1/operations/:id/thread/messages — one addressed chat message (D41). */
const OperationThreadMessageBody = z.strictObject({
  workspace_id: WorkspaceId,
  idempotency_key: z.string().min(8).max(200),
  sender: MessageSender,
  text: z.string().min(1).max(4000),
});

/**
 * S11 private-folder access check: the target is an `agent://<agent_id>/<path>`
 * URI (the shape the memory_link setting surfaces); the acting Agent is the
 * path identity. Only agent:// URIs are governed here — shared workspace
 * paths are S17's permission model, not this route's guess.
 */
const AgentFolderAccessQuery = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(2048),
});

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

/**
 * The allowlisted Agent summary payload — identity fields only, no memory.
 * `session` is the S12 presence read: the supervised session's state for this
 * Agent, read live from the supervisor ("none" when the supervisor is
 * disabled). Presence is NOT identity — it never reveals memory, provider
 * internals, or child process details (G3).
 */
interface AgentSummaryPayload {
  agent_id: string;
  display_name: string;
  role_description: string;
  avatar_hue: number;
  initial_glyph: string;
  has_user_instructions: boolean;
  session: { presence: AgentSessionPresence };
}

function agentSummary(row: AgentRow, presence: AgentSessionPresence): AgentSummaryPayload {
  return {
    agent_id: row.agent_id,
    display_name: row.display_name,
    role_description: row.role_description,
    avatar_hue: row.avatar_hue,
    initial_glyph: row.initial_glyph,
    has_user_instructions: row.user_instructions !== null,
    session: { presence },
  };
}

/** The detail payload: the summary plus what the settings UI edits and the direct chat id. */
function agentDetail(row: AgentRow, directChatId: string, presence: AgentSessionPresence) {
  return {
    ...agentSummary(row, presence),
    user_instructions: row.user_instructions,
    default_provider: {
      provider_id: row.default_provider_id,
      model: row.default_provider_model,
    },
    direct_chat_id: directChatId,
  };
}

/**
 * S14 — the derived ad-hoc read-model fields (D41), pure derivation with no
 * extra column: `is_adhoc` is `definition_ref === null`; `auto_label` is the
 * current name matching the auto-label pattern (a user renaming an Operation
 * TO the auto-label shape reads auto_label again — an accepted, documented
 * tradeoff; the pattern lives in the service module as its single source).
 */
function operationReadFields(operation: OperationRecord) {
  return {
    is_adhoc: operation.definition_ref === null,
    auto_label: ADHOC_AUTO_LABEL_PATTERN.test(operation.name),
  };
}

/**
 * S13 — the Operation detail read model: the record, the roster with its
 * requires_approval flags and display names, the runs summary, and the
 * recent persisted D36 refusals (the UI's "why"). The chat binding id is
 * reported WITHOUT creating it — the binding is created lazily on first
 * thread access (D41), never by a detail read. S14 adds the derived
 * `is_adhoc`/`auto_label` fields (additive).
 */
function operationDetail(
  operation: OperationRecord,
  roster: OperationRosterMemberRow[],
  runs: OperationRun[],
  refusals: OperationRosterRefusalRow[],
  chatConversationId: string | null,
  agentNames: ReadonlyMap<string, string>,
) {
  return {
    operation,
    ...operationReadFields(operation),
    roster: roster.map((member) => ({
      agent_id: member.agent_id,
      display_name: agentNames.get(member.agent_id) ?? null,
      requires_approval: member.requires_approval === 1,
      pack_id: member.pack_id,
      pack_version: member.pack_version,
      added_at: member.added_at,
    })),
    runs,
    recent_refusals: refusals.map((refusal) => ({
      refusal_code: refusal.refusal_code,
      agent_id: refusal.agent_id,
      pack_id: refusal.pack_id,
      message: refusal.message,
      created_at: refusal.created_at,
    })),
    chat_conversation_id: chatConversationId,
  };
}

export interface LocalApiDeps {
  /** The only mutation path (D26) — the conversations module's command gate. */
  conversations: Pick<ConversationsService, "executeCommand">;
  /** AC4 replay resolution — always the journal's ReplayService, never re-implemented here. */
  replay: Pick<ReplayService, "resolve">;
  /**
   * S11: the agents seam. Identity reads, the user-owned field updates, and
   * the D16 settings surface go through the agents module's service — the
   * transport never touches SQL and never validates settings itself.
   */
  agents: Pick<
    AgentsService,
    | "listAgents"
    | "getAgentWithDirectChat"
    | "updateUserInstructions"
    | "updateDefaultProvider"
    | "getSettings"
    | "applySettingsCommand"
  >;
  /**
   * S11: the private-folder guard seam. The transport only relays the access
   * decision — resolution, the isolation rule, and traversal safety live in
   * the agents module; the future file/terminal slices call the SAME service
   * (never a second guard).
   */
  folders: Pick<AgentFoldersService, "resolveAccess">;
  /**
   * S12: the session presence read model — the supervised session's live
   * presence for one (workspace, agent). Absent when the composition has no
   * session harness configured (supervisor disabled): every agent then
   * reports "none" (G4 — the transport never guesses a presence).
   */
  sessionPresence?: (workspaceId: string, agentId: string) => AgentSessionPresence;
  /**
   * S13: the operations seam — the whole Operation chat surface goes through
   * the operations module's service (records, roster commands, coordinator,
   * runs, D7 events, chat binding, addressed messages, thread read model).
   * The transport never touches SQL and never validates Operation shapes
   * itself beyond the route schemas below.
   */
  operations: Pick<
    OperationsService,
    | "createOperation"
    | "getOperation"
    | "listOperations"
    | "listRoster"
    | "listRosterRefusals"
    | "findChat"
    | "addRosterAgent"
    | "removeRosterAgent"
    | "setCoordinator"
    | "renameOperation"
    | "createRun"
    | "getRun"
    | "listRuns"
    | "appendCollaborationEvent"
    | "applyDelegation"
    | "listCollaborationEvents"
    | "getThread"
    | "sendOperationMessage"
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

  // S12: with the supervisor disabled every agent reports "none" — the same
  // field shape either way, so clients never branch on the configuration.
  const presenceOf = deps.sessionPresence ?? ((): AgentSessionPresence => "none");

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
      agents: deps.agents
        .listAgents(query.data.workspace_id)
        .map((row) => agentSummary(row, presenceOf(query.data.workspace_id, row.agent_id))),
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
    res
      .status(200)
      .json(agentDetail(agent, conversation_id, presenceOf(query.data.workspace_id, agentId.data)));
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
    res.status(200).json(agentSummary(agent, presenceOf(body.data.workspace_id, agentId.data)));
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
    res.status(200).json(agentSummary(agent, presenceOf(body.data.workspace_id, agentId.data)));
  });

  /**
   * S11 chunk 3: the D16 settings read model — every setting with its
   * recommended default, current value, why it matters, risk/cost note,
   * editability, and reset command (D16's settings-editor contract). Unknown
   * Agent → the typed 404; the snapshot is validated through the contracts
   * schema inside the service.
   */
  app.get(GET_AGENT_SETTINGS_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const query = AgentWorkspaceQuery.safeParse(req.query);
    if (!agentId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The settings request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json(deps.agents.getSettings(query.data.workspace_id, agentId.data));
  });

  /**
   * S11 chunk 3: submit one D16 settings command — the SAME contracts command
   * union S30 onboarding will submit (D16: one configuration command surface).
   * The body's agent_id must agree with the path (a mismatch is the typed 400,
   * not a silent retarget). Commands are naturally idempotent (validated
   * last-write-wins) and are NOT journaled in this slice — consistent with the
   * existing agent field mutations, which predate any agent-domain event
   * stream. Unknown Agent → typed 404; schema mismatch → typed 400.
   */
  app.post(SUBMIT_AGENT_SETTINGS_COMMAND_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const parsed = AgentSettingsCommand.safeParse(req.body);
    if (!agentId.success || !parsed.success || parsed.data.agent_id !== agentId.data) {
      const { status, body } = contractValidationResponse(
        "The settings command is not valid: the command body must be an agent settings command whose agent_id matches the path.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json(deps.agents.applySettingsCommand(parsed.data));
  });

  /**
   * S11: the private-folder access decision — the guard proven end-to-end.
   * The path identity is the ACTING Agent; the query's `path` is the target
   * `agent://<agent_id>/<path>` URI. An Agent's OWN subtree answers 200 with
   * the resolved decision (both verbs granted); ANY other Agent's private
   * subtree is the typed 403 (AGENT_FOLDER_ACCESS_DENIED); a traversal-shaped
   * or non-agent:// URI is the typed 400 (AGENT_FOLDER_URI_INVALID); unknown
   * actor/owner/workspace is the typed 404 (AGENT_NOT_FOUND). No storage is
   * touched — the file/terminal slices (S17/S22) go through the same guard
   * service with a real store behind the identical seam.
   */
  app.get(GET_AGENT_FOLDER_ACCESS_PATH, (req, res) => {
    const agentId = Id.safeParse(req.params.agent_id);
    const query = AgentFolderAccessQuery.safeParse(req.query);
    if (!agentId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The folder access request is not valid: a workspace_id and an agent:// path are required.",
      );
      res.status(status).json(body);
      return;
    }
    res
      .status(200)
      .json(deps.folders.resolveAccess(query.data.workspace_id, agentId.data, query.data.path));
  });

  /**
   * S13/S14 — create one Operation chat record (D31): the service
   * runtime-validates the roster against the PINNED pack catalog (D36) and
   * builds the D29 pinning snapshot. A refused roster is the typed 403
   * (OPERATION_ROSTER_REFUSED, the RosterRefusal in the body) and an empty
   * roster the typed 400 (OPERATION_ROSTER_EMPTY); both leave NOTHING
   * behind. A nameless ad-hoc create auto-labels `Ad-hoc · N Agents` (D41);
   * a nameless pack-defined create is the typed 400
   * (OPERATION_NAME_REQUIRED). The chat binding is created lazily on first
   * thread access (D41), never here.
   */
  app.post(CREATE_OPERATION_PATH, (req, res) => {
    const body = CreateOperationBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The create request is not valid: a workspace_id, a roster, and a coordinator are required; a name is optional for ad-hoc creates.",
      );
      res.status(status).json(errorBody);
      return;
    }
    res.status(201).json(
      deps.operations.createOperation(body.data.workspace_id, {
        definition_ref: body.data.definition_ref,
        name: body.data.name ?? null,
        roster_agent_ids: body.data.roster_agent_ids,
        coordinator_agent_id: body.data.coordinator_agent_id,
      }),
    );
  });

  /** S13/S14 — the workspace's Operations (E12), each row with the derived is_adhoc/auto_label fields. */
  app.get(LIST_OPERATIONS_PATH, (req, res) => {
    const query = OperationWorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The operation list request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json({
      operations: deps.operations
        .listOperations(query.data.workspace_id)
        .map((operation) => ({ ...operation, ...operationReadFields(operation) })),
    });
  });

  /**
   * S13 — one Operation's detail: record + roster (requires_approval flags) +
   * runs summary + recent refusals + the chat binding id when one exists.
   */
  app.get(GET_OPERATION_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const query = OperationWorkspaceQuery.safeParse(req.query);
    if (!operationId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The operation request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    const workspaceId = query.data.workspace_id;
    const operation = deps.operations.getOperation(workspaceId, operationId.data);
    // Display names resolve from the seeded Agent identities; a roster member
    // without a seeded identity renders its id (never a fabricated name).
    const agentNames = new Map(
      deps.agents.listAgents(workspaceId).map((agent) => [agent.agent_id, agent.display_name]),
    );
    res
      .status(200)
      .json(
        operationDetail(
          operation,
          deps.operations.listRoster(workspaceId, operationId.data),
          deps.operations.listRuns(workspaceId, operationId.data),
          deps.operations.listRosterRefusals(workspaceId, operationId.data),
          deps.operations.findChat(workspaceId, operationId.data),
          agentNames,
        ),
      );
  });

  /**
   * S13 — apply one D36 roster command (the contracts envelope, validated):
   * applied → 200 with the updated Operation; refused → 403 with the typed
   * RosterRefusal (the refusal is PERSISTED so the UI can show WHY). The
   * envelope's workspace_id scopes the command (E12) and its operation_id
   * must agree with the path — a mismatch is the typed 400, never a silent
   * retarget.
   */
  app.post(OPERATION_ROSTER_COMMANDS_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const raw =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const envelopeWorkspace = typeof raw["workspace_id"] === "string" ? raw["workspace_id"] : null;
    const envelopeOperation = typeof raw["operation_id"] === "string" ? raw["operation_id"] : null;
    if (
      !operationId.success ||
      envelopeWorkspace === null ||
      envelopeOperation !== operationId.data
    ) {
      const { status, body } = contractValidationResponse(
        "The roster command is not valid: the envelope must carry a workspace_id and the operation_id of the path.",
      );
      res.status(status).json(body);
      return;
    }
    const type = raw["type"];
    if (type === "operation.add_roster_agent") {
      const outcome = deps.operations.addRosterAgent(raw);
      if (outcome.outcome === "applied") {
        res.status(200).json({ outcome: "applied", operation: outcome.operation });
      } else {
        res.status(403).json({ outcome: "refused", refusal: outcome.refusal });
      }
      return;
    }
    if (type === "operation.remove_roster_agent") {
      const outcome = deps.operations.removeRosterAgent(raw);
      if (outcome.outcome === "applied") {
        res.status(200).json({ outcome: "applied", operation: outcome.operation });
      } else {
        res.status(403).json({ outcome: "refused", refusal: outcome.refusal });
      }
      return;
    }
    const { status, body } = contractValidationResponse(
      "The roster command type is not accepted by this API.",
    );
    res.status(status).json(body);
  });

  /**
   * S13 — set the coordinator to an Agent or "none" (D42/D49): allowed at ANY
   * time including mid-run; in-flight runs are never cancelled or paused.
   */
  app.post(OPERATION_COORDINATOR_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const body = OperationCoordinatorBody.safeParse(req.body);
    if (!operationId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        'The coordinator request is not valid: a workspace_id and a coordinator_agent_id (Agent id or "none") are required.',
      );
      res.status(status).json(errorBody);
      return;
    }
    res
      .status(200)
      .json(
        deps.operations.setCoordinator(
          body.data.workspace_id,
          operationId.data,
          body.data.coordinator_agent_id,
        ),
      );
  });

  /**
   * S14 — rename one Operation (POST-command convention): the body is the
   * raw operation.rename_operation envelope; the service parses it, applies
   * the rename as a durable row update, and answers the record (a replayed
   * command_id answers the record again through its receipt — D23 rule 6).
   * The envelope's workspace_id scopes the command (E12) and its
   * operation_id must agree with the path — a mismatch is the typed 400,
   * never a silent retarget.
   */
  app.post(OPERATION_RENAME_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const raw =
      typeof req.body === "object" && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const envelopeWorkspace = typeof raw["workspace_id"] === "string" ? raw["workspace_id"] : null;
    const envelopeOperation = typeof raw["operation_id"] === "string" ? raw["operation_id"] : null;
    if (
      !operationId.success ||
      envelopeWorkspace === null ||
      envelopeOperation !== operationId.data
    ) {
      const { status, body } = contractValidationResponse(
        "The rename command is not valid: the envelope must carry a workspace_id and the operation_id of the path.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json(deps.operations.renameOperation(envelopeWorkspace, operationId.data, raw));
  });

  /**
   * S13 — create one run (D31/AC24): D8 state CREATED, D26 cursor 0, empty
   * credits, no artifacts. Runs are created only by typed creation (D34).
   */
  app.post(OPERATION_RUNS_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const body = OperationRunCreateBody.safeParse(req.body);
    if (!operationId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The run request is not valid: a workspace_id is required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    res.status(201).json(
      deps.operations.createRun(body.data.workspace_id, operationId.data, {
        ...(body.data.run_id !== undefined ? { run_id: body.data.run_id } : {}),
        ...(body.data.parent_task_id !== undefined
          ? { parent_task_id: body.data.parent_task_id }
          : {}),
      }),
    );
  });

  /** S13 — the Operation's runs (the runs summary leg of the read model). */
  app.get(OPERATION_RUNS_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const query = OperationWorkspaceQuery.safeParse(req.query);
    if (!operationId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The runs request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res
      .status(200)
      .json({ runs: deps.operations.listRuns(query.data.workspace_id, operationId.data) });
  });

  /** S13 — one run's detail, including its D26 events cursor. */
  app.get(OPERATION_RUN_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const runId = Id.safeParse(req.params.run_id);
    const query = OperationWorkspaceQuery.safeParse(req.query);
    if (!operationId.success || !runId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The run request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res
      .status(200)
      .json(deps.operations.getRun(query.data.workspace_id, operationId.data, runId.data));
  });

  /**
   * S13 — append one D7 collaboration event (validated through the contracts
   * union; the body's operation_id must agree with the path). A TaskDelegated
   * event additionally triggers applyDelegation's EXACTLY-ONE-CHILD-RUN
   * semantics (D34/D46): the event is appended AND one child run is created
   * with parent_task_id = the delegating run's id, idempotent on the
   * event_id, in ONE transaction — a replay returns the original child run.
   */
  app.post(OPERATION_EVENTS_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const parsed = OperationCollaborationEvent.safeParse(req.body);
    if (!operationId.success || !parsed.success || parsed.data.operation_id !== operationId.data) {
      const { status, body } = contractValidationResponse(
        "The collaboration event is not valid: the event body must be a D7 operation event whose operation_id matches the path.",
      );
      res.status(status).json(body);
      return;
    }
    const event = parsed.data;
    if (event.type === "TaskDelegated") {
      const result = deps.operations.applyDelegation(event);
      res.status(201).json({
        sequence: result.sequence,
        stream_id: result.stream_id,
        event_id: event.event_id,
        created: result.created,
        operation_id: event.operation_id,
        run_id: event.run_id,
        type: event.type,
        child_run_id: result.child_run.run_id,
      });
      return;
    }
    const appended = deps.operations.appendCollaborationEvent(event);
    res.status(201).json({
      sequence: appended.sequence,
      stream_id: appended.stream_id,
      event_id: appended.event.event_id,
      created: appended.created,
      operation_id: appended.event.operation_id,
      run_id: appended.event.run_id,
      type: appended.event.type,
    });
  });

  /**
   * S13 — the D26 cursor read for the runs panel/timelines: the Operation's
   * collaboration events, narrowed with run_id (present = that run's stream,
   * absent = every stream) and after_sequence (exclusive).
   */
  app.get(OPERATION_EVENTS_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const query = OperationEventsQuery.safeParse(req.query);
    if (!operationId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The events request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json({
      events: deps.operations.listCollaborationEvents(query.data.workspace_id, operationId.data, {
        after_sequence: query.data.after_sequence,
        ...(query.data.run_id !== undefined ? { run_id: query.data.run_id } : {}),
      }),
    });
  });

  /**
   * S13 — the merged Operation-chat thread (D41): durable conversation
   * messages with sender attribution and their resolved @-addressing, plus
   * every D7 collaboration event as a typed item. The `after` cursor pages
   * the message leg (journal sequence, exclusive). First access get-or-creates
   * the chat binding (lazy, journaled).
   */
  app.get(OPERATION_THREAD_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const query = OperationThreadQuery.safeParse(req.query);
    if (!operationId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The thread request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    res.status(200).json(
      deps.operations.getThread(query.data.workspace_id, operationId.data, {
        after_sequence: query.data.after,
      }),
    );
  });

  /**
   * S13 — send one message INTO the Operation chat (D41) with @-addressing:
   * @mentions resolve against the Operation roster at send time and the
   * resolved recipient Agent ids are stored with the message (D7 recipient
   * semantics); an unresolvable mention keeps its literal text and resolves
   * to [] — the send never fails on it. Unaddressed messages are
   * Operation-wide ([]).
   */
  app.post(OPERATION_THREAD_MESSAGES_PATH, (req, res) => {
    const operationId = Id.safeParse(req.params.operation_id);
    const body = OperationThreadMessageBody.safeParse(req.body);
    if (!operationId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The message request is not valid: a workspace_id, an idempotency_key, a sender, and text are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    res.status(201).json(
      deps.operations.sendOperationMessage(body.data.workspace_id, operationId.data, {
        idempotency_key: body.data.idempotency_key,
        sender: body.data.sender,
        text: body.data.text,
      }),
    );
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
