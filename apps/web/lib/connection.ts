/**
 * Connection lifecycle (UI_DESIGN §6.4, §2.4): connected → disconnected →
 * reconnecting (cursor replay with progress) → connected. Pure state machine
 * + the demo script. The banner copy is exact §6.4 copy; reading stays
 * possible while disconnected — the banner never blocks the thread.
 *
 * Demo mechanism: in the UI-first build nothing opens a socket, so this
 * machine is driven by the scripted fixture below — by the demo hook in the
 * General Assistant chat (components/chat/agent-chat-view.tsx) and by tests.
 * The real runtime stream later drives the same states from the socket — the
 * banner and the replay handoff (lib/thread-layout flushReplayed → §6.2
 * marker) are already wired for it.
 */

export const CONNECTION_STATES = ["connected", "disconnected", "reconnecting"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** §6.4 exact copy — do not paraphrase. */
export const DISCONNECTED_BANNER_COPY =
  "Connection lost — you can keep reading; work continues server-side";
/** §6.4 / §2.4 exact copy for the reconnect replay banner. */
export const RECONNECTING_BANNER_COPY = "Replaying missed events…";

export interface ConnectionMachine {
  state: ConnectionState;
  /** Replay progress during "reconnecting" (§6.4 "replay with progress"). */
  replayDone: number;
  replayTotal: number;
}

export type ConnectionEvent =
  | { type: "disconnect" }
  | { type: "reconnect_start"; total: number }
  | { type: "replay_progress"; done: number }
  | { type: "replay_complete" };

export const INITIAL_CONNECTION: ConnectionMachine = {
  state: "connected",
  replayDone: 0,
  replayTotal: 0,
};

export function advanceConnection(
  machine: ConnectionMachine,
  event: ConnectionEvent,
): ConnectionMachine {
  switch (event.type) {
    case "disconnect":
      return { ...machine, state: "disconnected", replayDone: 0, replayTotal: 0 };
    case "reconnect_start":
      return { ...machine, state: "reconnecting", replayDone: 0, replayTotal: event.total };
    case "replay_progress":
      return {
        ...machine,
        replayDone: Math.max(0, Math.min(event.done, machine.replayTotal)),
      };
    case "replay_complete":
      return { ...machine, state: "connected", replayDone: machine.replayTotal };
  }
}

/**
 * Scripted connection demo (§6.4): connected → disconnect (reading continues)
 * → reconnect with cursor replay progress → resume live. This is the
 * fixture-driven sequence the mock runtime replays; tests drive the machine
 * through exactly these steps.
 */
export const DEMO_CONNECTION_SCRIPT: readonly { event: ConnectionEvent; holdMs: number }[] = [
  { event: { type: "disconnect" }, holdMs: 2000 },
  { event: { type: "reconnect_start", total: 3 }, holdMs: 400 },
  { event: { type: "replay_progress", done: 1 }, holdMs: 400 },
  { event: { type: "replay_progress", done: 2 }, holdMs: 400 },
  { event: { type: "replay_progress", done: 3 }, holdMs: 400 },
  { event: { type: "replay_complete" }, holdMs: 0 },
];

/**
 * The replay handoff (§6.2): while disconnected the runtime queues missed
 * messages; on replay completion they enter the thread as a replayed batch
 * closed by the "N missed events replayed" marker — never silently as live.
 * This fixture queue (demo data for the General Assistant chat) is what the
 * scripted connection replays; tests use it to assert the handoff.
 */
import { ChatMessage } from "@/lib/fixtures";

export const DEMO_REPLAY_QUEUE: ChatMessage[] = [
  ChatMessage.parse({
    message_id: "msg_replay_ga_1",
    conversation_id: "conversation_agent_general_assistant",
    sender: { kind: "agent", agent_id: "agent_general_assistant" },
    text: "While the connection was down I finished the methods summary draft — it is in the workspace as methods-deep-dive.md. Nothing ran while you were away; the search proposal is still waiting on validation.",
    sent_at: "2026-09-20T10:18:00Z",
    delivery_class: "replayed",
  }),
];

/** Quiet period before the scripted disconnect fires, so the connected state is visible first (§6.4 demo). */
export const DEMO_CONNECTION_INITIAL_DELAY_MS = 2500;

/**
 * The conversation the scripted §6.4 demo runs in — the General Assistant
 * chat, matching the replay queue above (and the demo stream's home).
 */
export const DEMO_CONNECTION_CONVERSATION_ID: string | null =
  DEMO_REPLAY_QUEUE[0]?.conversation_id ?? null;
