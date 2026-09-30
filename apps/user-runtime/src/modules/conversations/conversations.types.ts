/**
 * Conversations module types (S07; AC6, D23 module shape).
 *
 * Commands are the only mutation path (D26). Every command carries an
 * idempotency key (D23 rule 6) and, where the command targets an existing
 * aggregate, the expected revision for an optimistic transition. Failures are
 * typed with stable codes; the transport layer maps them onto the SheraError
 * wire shape without inventing new categories.
 */
import { z } from "zod";

import { MessageSender } from "../events/events.types.ts";

export const ConversationCreateCommand = z.strictObject({
  type: z.literal("conversation.create"),
  workspace_id: z.string().min(1),
  idempotency_key: z.string().min(8).max(200),
  payload: z.strictObject({
    title: z.string().min(1).max(300),
  }),
});
export type ConversationCreateCommand = z.infer<typeof ConversationCreateCommand>;

export const ConversationRenameCommand = z.strictObject({
  type: z.literal("conversation.rename"),
  workspace_id: z.string().min(1),
  idempotency_key: z.string().min(8).max(200),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    title: z.string().min(1).max(300),
    expected_revision: z.number().int().positive(),
  }),
});
export type ConversationRenameCommand = z.infer<typeof ConversationRenameCommand>;

/**
 * Send one message into a conversation (S09 chunk 2): the send is an
 * idempotent typed command like every other mutation (D26, D23 rule 6) — the
 * same idempotency_key always resolves to the SAME durable message, so a
 * client retry after an ambiguous failure can never duplicate a turn.
 * The conversation aggregate's revision guards the TITLE only; message
 * appends land on the stream without moving it.
 */
export const MessageSendCommand = z.strictObject({
  type: z.literal("message.send"),
  workspace_id: z.string().min(1),
  idempotency_key: z.string().min(8).max(200),
  payload: z.strictObject({
    conversation_id: z.string().min(1),
    text: z.string().min(1).max(4000),
    sender: MessageSender,
  }),
});
export type MessageSendCommand = z.infer<typeof MessageSendCommand>;

/** The discriminated command union the local API accepts. */
export const ConversationCommand = z.discriminatedUnion("type", [
  ConversationCreateCommand,
  ConversationRenameCommand,
  MessageSendCommand,
]);
export type ConversationCommand = z.infer<typeof ConversationCommand>;

export type ConversationCommandResult =
  | { kind: "created"; conversation_id: string; title: string; revision: number; event_id: string }
  | { kind: "renamed"; conversation_id: string; title: string; revision: number; event_id: string }
  | {
      kind: "message_sent";
      conversation_id: string;
      message_id: string;
      revision: number;
      event_id: string;
    };

/** Stable failure codes for the conversations boundary (SCREAMING_SNAKE). */
export type ConversationsFailureCode =
  | "COMMAND_UNKNOWN_TYPE"
  | "COMMAND_PAYLOAD_INVALID"
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_REVISION_CONFLICT";

export class ConversationsServiceError extends Error {
  readonly code: ConversationsFailureCode;
  readonly category: "validation" | "conflict" | "state";

  constructor(
    code: ConversationsFailureCode,
    category: "validation" | "conflict" | "state",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ConversationsServiceError";
    this.code = code;
    this.category = category;
  }
}
