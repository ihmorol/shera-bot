/**
 * SessionReplyBridge (S12 chunk 3) — the send-path integration between
 * conversation turns and the supervised Agent session (D32 layer 2 wiring).
 *
 * Structurally the sibling of the ScriptedReplyStreamer: a post-commit hook
 * over committed `message.appended` events. When a USER message commits in a
 * conversation that is some Agent's direct chat AND the session supervisor is
 * enabled, the bridge addresses the session on demand (`prompt` →
 * `ensureStarted` internally — the child starts on the FIRST message, never
 * at boot) and publishes the session's completed reply as ONE durable agent
 * message through the SAME command path every other reply uses (D26: the
 * reply is a real journal event with a receipt, so the replay machinery
 * returns it after a refresh — nothing client-side is fabricated).
 *
 * Ordering: prompts for one conversation are serialized (a turn answers in
 * order; the fake-Pi harness processes one prompt at a time). Concurrent
 * user messages for DIFFERENT conversations address their sessions
 * independently.
 *
 * Containment (B4): the bridge runs inside the composition's post-commit
 * fanout — it NEVER throws into the broadcaster. Every failure (terminal
 * session, interrupted reply, publish rejection) is recorded through the
 * injected fault sink with an explicit field allowlist; prompt and reply
 * TEXT never enter logs (G3). The user's committed message is untouched by a
 * reply failure — no durable data is ever lost to a session fault, and the
 * next message transparently continues on the supervised restart.
 *
 * The idempotency key of the reply derives from the triggering user event's
 * id (`session-reply-<event_id>`), so a redelivered trigger can never
 * double-reply — the same discipline as the ScriptedReplyStreamer.
 *
 * G4: the bridge exists ONLY when the composition enabled the session
 * supervisor (a harness command configured); the default composition has no
 * bridge and the send path behaves exactly as before this slice.
 *
 * Governing records: D14, D15, D26, D32; the start-latency AC.
 */
import type { EventEnvelope, MessageAppendedPayload } from "../events/events.types.ts";
import type { ConversationsService } from "../conversations/conversations.service.ts";
import type { SessionFaultLog, SessionSupervisor } from "./session-supervisor.service.ts";

export interface SessionReplyBridgeDeps {
  /** The supervised session seam (prompt starts/reuses the child). */
  supervisor: Pick<SessionSupervisor, "prompt">;
  /** The ONLY append path for the durable reply (D26: commands mutate). */
  conversations: Pick<ConversationsService, "executeCommand">;
  /**
   * conversation_id → the Agent whose direct chat it is, or null when the
   * conversation is NOT an Agent direct chat (plain chats never spawn
   * sessions). compose.ts resolves through the agents repository.
   */
  resolveDirectChatAgent: (workspaceId: string, conversationId: string) => string | null;
  /** Contained fault sink (B-1/B4). Default: discard. */
  onFault?: SessionFaultLog | undefined;
}

export class SessionReplyBridge {
  /** Per-conversation reply chains — one turn answers at a time, in order. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: SessionReplyBridgeDeps) {}

  /**
   * Post-commit hook: reacts to durable USER messages in Agent direct chats.
   * Safe to call for every committed envelope of any stream — non-message
   * events, agent-authored messages (the bridge never loops on its own
   * replies), and non-direct-chat conversations are ignored.
   */
  handleCommittedEvent(event: EventEnvelope): void {
    if (event.type !== "message.appended") {
      return;
    }
    // The append boundary registry-validated this payload (G2); the broad
    // envelope union does not discriminate, so the narrow is by construction.
    const payload = event.payload as MessageAppendedPayload;
    if (payload.sender.kind !== "user") {
      return;
    }
    const agentId = this.deps.resolveDirectChatAgent(event.workspace_id, payload.conversation_id);
    if (agentId === null) {
      return;
    }

    const chainKey = `${event.workspace_id}:${payload.conversation_id}`;
    const run = this.chains.get(chainKey) ?? Promise.resolve();
    const next = run
      .then(() => this.replyAndPublish(event, payload, agentId))
      .catch((error: unknown) => {
        // Contained (B4): the committed user message and the journal are
        // untouched; the fault is recorded with an allowlisted field set —
        // never the prompt or reply text (G3).
        this.deps.onFault?.("agent_session_reply_failed", {
          workspace_id: event.workspace_id,
          conversation_id: payload.conversation_id,
          agent_id: agentId,
          trigger_event_id: event.event_id,
          name: error instanceof Error ? error.name : "Error",
          code:
            error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code)
              : null,
        });
      })
      .finally(() => {
        if (this.chains.get(chainKey) === next) {
          this.chains.delete(chainKey);
        }
      });
    this.chains.set(chainKey, next);
  }

  /** True while a reply chain for this conversation is still in flight. */
  hasPendingReply(workspaceId: string, conversationId: string): boolean {
    return this.chains.has(`${workspaceId}:${conversationId}`);
  }

  private async replyAndPublish(
    event: EventEnvelope,
    payload: MessageAppendedPayload,
    agentId: string,
  ): Promise<void> {
    // On-demand address: prompt() ensures the session is started (fresh on
    // the first message, warm while active, transparent restart after an
    // idle hibernation or crash — the supervisor owns that lifecycle).
    const reply = await this.deps.supervisor.prompt(event.workspace_id, agentId, payload.text);
    this.deps.conversations.executeCommand({
      type: "message.send",
      workspace_id: event.workspace_id,
      // Derived from the trigger's event id: idempotent by construction.
      idempotency_key: `session-reply-${event.event_id}`,
      payload: {
        conversation_id: payload.conversation_id,
        text: reply.text,
        sender: { kind: "agent", agent_id: agentId },
      },
    });
  }
}
