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

import { conversationStreamFor } from "../../modules/conversations/conversations.events.ts";
import type { ConversationsService } from "../../modules/conversations/conversations.service.ts";
import { ConversationCommand } from "../../modules/conversations/conversations.types.ts";
import type { ReplayService } from "../../modules/events/replay.service.ts";
import {
  contractValidationResponse,
  notFoundRequestHandler,
  typedErrorRequestHandler,
} from "../http/typed-errors.ts";

export const SUBMIT_CONVERSATION_COMMAND_PATH = "/v1/conversations/commands" as const;
export const LIST_CONVERSATION_EVENTS_PATH = "/v1/conversations/:conversation_id/events" as const;

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

export interface LocalApiDeps {
  /** The only mutation path (D26) — the conversations module's command gate. */
  conversations: Pick<ConversationsService, "executeCommand">;
  /** AC4 replay resolution — always the journal's ReplayService, never re-implemented here. */
  replay: Pick<ReplayService, "resolve">;
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

  // Typed failures and unknown routes: the SheraError taxonomy, never an
  // Express default page, a stack trace, or raw internals (D23 rule 4, G3).
  app.use(notFoundRequestHandler);
  app.use(typedErrorRequestHandler);
  return app;
}
