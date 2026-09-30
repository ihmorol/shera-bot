import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentChatView } from "../components/chat/agent-chat-view";
import { ConnectionBanner } from "../components/shell/connection-banner";
import {
  CONNECTION_STATES,
  DEMO_CONNECTION_SCRIPT,
  DEMO_REPLAY_QUEUE,
  INITIAL_CONNECTION,
  RECONNECTING_BANNER_COPY,
  advanceConnection,
  type ConnectionEvent,
  type ConnectionMachine,
} from "../lib/connection";
import { agentById, buildThread, conversationForAgent } from "../lib/fixtures";

/**
 * §6.4 connection lifecycle (scripted demo): the banner carries the exact
 * §6.4 copy, reading stays possible while disconnected (the banner is a
 * strip, never a modal), reconnecting shows the replay progress, and the
 * replay handoff flushes the missed messages as a §6.2 replayed batch.
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

const GA_CONVERSATION = conversationForAgent("agent_general_assistant")!;
const GA_AGENT = agentById("agent_general_assistant")!;
const GA_THREAD = buildThread(GA_CONVERSATION.conversation_id);

function renderView(connectionProps: {
  connectionState?: "connected" | "disconnected" | "reconnecting";
  replay?: { done: number; total: number };
  pendingReplay?: typeof DEMO_REPLAY_QUEUE;
}): string {
  return render(
    createElement(AgentChatView, {
      agent: GA_AGENT,
      conversation: GA_CONVERSATION,
      thread: GA_THREAD,
      ...connectionProps,
    }),
  );
}

describe("connection state machine (§6.4)", () => {
  it("cycles connected → disconnected → reconnecting → connected", () => {
    let machine: ConnectionMachine = INITIAL_CONNECTION;
    const events: ConnectionEvent[] = [
      { type: "disconnect" },
      { type: "reconnect_start", total: 3 },
      { type: "replay_complete" },
    ];
    const states: string[] = [machine.state];
    for (const event of events) {
      machine = advanceConnection(machine, event);
      states.push(machine.state);
    }
    expect(states).toEqual(["connected", "disconnected", "reconnecting", "connected"]);
  });

  it("tracks replay progress toward the total and completes only at it", () => {
    let machine = advanceConnection(INITIAL_CONNECTION, { type: "reconnect_start", total: 3 });
    machine = advanceConnection(machine, { type: "replay_progress", done: 1 });
    expect(machine.replayDone).toBe(1);
    expect(machine.state).toBe("reconnecting");
    machine = advanceConnection(machine, { type: "replay_progress", done: 9 });
    // Progress never overshoots the total.
    expect(machine.replayDone).toBe(3);
    machine = advanceConnection(machine, { type: "replay_complete" });
    expect(machine.state).toBe("connected");
    expect(machine.replayDone).toBe(machine.replayTotal);
  });

  it("reset replay counters on a fresh disconnect", () => {
    let machine = advanceConnection(INITIAL_CONNECTION, { type: "reconnect_start", total: 3 });
    machine = advanceConnection(machine, { type: "replay_complete" });
    machine = advanceConnection(machine, { type: "disconnect" });
    expect(machine.replayDone).toBe(0);
    expect(machine.replayTotal).toBe(0);
  });

  it("the demo script drives exactly the §6.4 sequence", () => {
    let machine = INITIAL_CONNECTION;
    for (const step of DEMO_CONNECTION_SCRIPT) {
      machine = advanceConnection(machine, step.event);
    }
    expect(machine.state).toBe("connected");
    expect(DEMO_CONNECTION_SCRIPT[0]?.event.type).toBe("disconnect");
    expect(DEMO_CONNECTION_SCRIPT[1]?.event.type).toBe("reconnect_start");
    expect(DEMO_CONNECTION_SCRIPT.at(-1)?.event.type).toBe("replay_complete");
    expect(CONNECTION_STATES).toEqual(["connected", "disconnected", "reconnecting"]);
  });
});

describe("connection banner (§6.4 exact copy)", () => {
  it("shows the disconnected banner with the exact §6.4 copy", () => {
    const html = render(createElement(ConnectionBanner, { state: "disconnected" }));
    expect(html).toContain("Connection lost — you can keep reading; work continues server-side");
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-connection-banner="disconnected"');
  });

  it("shows the reconnecting banner with progress", () => {
    const html = render(
      createElement(ConnectionBanner, { state: "reconnecting", replay: { done: 2, total: 3 } }),
    );
    expect(html).toContain(RECONNECTING_BANNER_COPY);
    expect(html).toContain("2 of 3");
    expect(html).toContain('role="status"');
    expect(html).toContain("animate-spin");
  });

  it("pairs every banner state with an icon — color is never the only signal", () => {
    const disconnected = render(createElement(ConnectionBanner, { state: "disconnected" }));
    expect(disconnected).toContain("<svg");
    const reconnecting = render(
      createElement(ConnectionBanner, { state: "reconnecting", replay: { done: 0, total: 3 } }),
    );
    expect(reconnecting).toContain("<svg");
  });
});

describe("reading stays possible while disconnected (§6.4)", () => {
  it("renders banner and the full message list together", () => {
    const html = renderView({ connectionState: "disconnected" });
    expect(html).toContain("Connection lost — you can keep reading; work continues server-side");
    // The conversation is still readable: seeded messages and cards render.
    expect(html).toContain('aria-label="Conversation messages"');
    expect(html).toContain("General Assistant");
    expect(html).toContain("Task run ga_summary");
  });

  it("keeps the composer reachable while disconnected", () => {
    const html = renderView({ connectionState: "disconnected" });
    expect(html).toContain('aria-label="Message General Assistant"');
    expect(html).toContain("Enter to send · Shift+Enter for a new line");
  });
});

describe("replay-progress handoff (§6.2 + §6.4)", () => {
  it("reconnecting banner shows the scripted replay progress", () => {
    const html = renderView({
      connectionState: "reconnecting",
      replay: { done: 2, total: 3 },
    });
    expect(html).toContain("Replaying missed events… 2 of 3");
  });

  it("queues replayed messages out of the thread until the connection resumes", () => {
    const disconnected = renderView({
      connectionState: "disconnected",
      pendingReplay: DEMO_REPLAY_QUEUE,
    });
    expect(disconnected).not.toContain("While the connection was down");

    const reconnecting = renderView({
      connectionState: "reconnecting",
      replay: { done: 1, total: 1 },
      pendingReplay: DEMO_REPLAY_QUEUE,
    });
    expect(reconnecting).not.toContain("While the connection was down");
  });

  it("flushes the queue as a replayed batch with the §6.2 marker on resume", () => {
    const html = renderView({
      connectionState: "connected",
      pendingReplay: DEMO_REPLAY_QUEUE,
    });
    // The missed message is in the thread — marked replayed, with the exact
    // §6.2 boundary copy, never silently interleaved as live.
    expect(html).toContain("While the connection was down");
    expect(html).toContain("border-l-2 border-line-accent");
    expect(html).toContain("1 missed events replayed");
  });
});
