/**
 * ScriptedReplyStreamer (S09 chunk 2) — the deterministic reply producer for
 * the mock/E2E path ("demo stream equivalent").
 *
 * When the composition enables scripted replies, every committed USER message
 * triggers a scripted agent reply: a short burst of TRANSIENT text-delta
 * frames on the stream-frame channel (never journaled, never replayed),
 * followed by ONE durable agent message appended through the SAME command
 * path (message.send; D26 — the reply is a real journal event with a receipt,
 * not a client-side fabrication). The reply's idempotency key derives from the
 * triggering user event's id, so a redelivered trigger can never double-reply.
 *
 * G2/D34: the reply is a plain conversation turn — no task run is created, no
 * task.* events exist, and the adapter harness is untouched. G4: without this
 * producer wired (the default composition), a user message simply receives no
 * reply; nothing fabricates one.
 *
 * Deltas are fire-and-forget presentation: a client that misses them (offline,
 * reconnecting) sees the reply appear once, durably, from the journal.
 */
import type { EventEnvelope } from "../events/events.types.ts";
import type { MessageAppendedPayload } from "../events/events.types.ts";
import type { ConversationsService } from "./conversations.service.ts";

/** The single transient frame kind this producer emits. */
export const MESSAGE_DELTA_FRAME = "message.delta";

export interface MessageDeltaFrame {
  frame: typeof MESSAGE_DELTA_FRAME;
  /** The reply identity: the durable message's idempotency key. */
  stream_key: string;
  conversation_id: string;
  text_delta: string;
}

export interface ScriptedReplyOptions {
  /** The agent identity the reply is authored as (pack fixture attribution). */
  agentId: string;
  /** Delay between delta frames (ms). Deterministic content, timed delivery. */
  deltaIntervalMs: number;
  /** The scripted reply body. Deterministic in the mock mode. */
  replyText: string;
}

export const DEFAULT_SCRIPTED_REPLY: ScriptedReplyOptions = {
  agentId: "agent_general_assistant",
  deltaIntervalMs: 30,
  replyText:
    "Here is my initial take: I would scope the chapter around one clear question, gather a handful of strong sources, and draft section by section. Tell me which part to expand and I will go deeper.",
};

/** Word-chunk splitting, mirroring the fixture stream's token-ish cadence. */
export function splitReplyChunks(text: string): string[] {
  const words = text.split(" ").filter((word) => word.length > 0);
  return words.map((word, index) => (index === words.length - 1 ? word : `${word} `));
}

export interface ReplyStreamerDeps {
  /** The ONLY append path for the durable reply (D26: commands mutate). */
  conversations: Pick<ConversationsService, "executeCommand">;
  /** The transient frame fanout (gateway room broadcast). */
  broadcastFrame: (workspaceId: string, streamId: string, payload: unknown) => void;
  options: ScriptedReplyOptions;
  /** Contained fault sink: a streaming fault never kills the runtime (B3/B4). */
  onFault?: (fault: unknown) => void;
  /** Timer controls for tests; defaults to the global timers. */
  schedule?: (callback: () => void, intervalMs: number) => () => void;
}

export class ScriptedReplyStreamer {
  private readonly activeTimers = new Set<() => void>();
  /** User event ids already streamed — a redelivered post-commit hook must not duplicate a reply. */
  private readonly handledUserEvents = new Set<string>();

  constructor(private readonly deps: ReplyStreamerDeps) {}

  /**
   * Post-commit hook: reacts to durable USER messages. Safe to call for every
   * committed envelope of any stream — non-message events and agent messages
   * are ignored (the streamer never loops on its own replies) and each user
   * event is handled exactly once.
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
    if (this.handledUserEvents.has(event.event_id)) {
      return;
    }
    this.handledUserEvents.add(event.event_id);

    const replyKey = `reply-${event.event_id}`;
    const chunks = splitReplyChunks(this.deps.options.replyText);
    const workspaceId = event.workspace_id;
    const streamId = event.stream_id;
    let index = 0;

    const schedule =
      this.deps.schedule ??
      ((callback: () => void, intervalMs: number) => {
        const timer = setInterval(callback, intervalMs);
        return () => clearInterval(timer);
      });

    const cancel = schedule(() => {
      try {
        if (index < chunks.length) {
          const frame: MessageDeltaFrame = {
            frame: MESSAGE_DELTA_FRAME,
            stream_key: replyKey,
            conversation_id: payload.conversation_id,
            text_delta: chunks[index]!,
          };
          index += 1;
          this.deps.broadcastFrame(workspaceId, streamId, frame);
          return;
        }
        this.cancel(cancel);
        // The durable truth: ONE journaled agent message through the command
        // path. The reply key derives from the user event id — idempotent by
        // construction (a redelivered trigger replays the recorded receipt).
        this.deps.conversations.executeCommand({
          type: "message.send",
          workspace_id: workspaceId,
          idempotency_key: replyKey,
          payload: {
            conversation_id: payload.conversation_id,
            text: this.deps.options.replyText,
            sender: { kind: "agent", agent_id: this.deps.options.agentId },
          },
        });
      } catch (error) {
        this.cancel(cancel);
        this.deps.onFault?.(error);
      }
    }, this.deps.options.deltaIntervalMs);
    this.activeTimers.add(cancel);
  }

  /** Cancel every in-flight reply stream (tests, shutdown). */
  stopAll(): void {
    for (const cancel of [...this.activeTimers]) {
      cancel();
    }
    this.activeTimers.clear();
  }

  private cancel(cancel: () => void): void {
    cancel();
    this.activeTimers.delete(cancel);
  }
}
