"use client";

import { useEffect, useMemo, useReducer, useRef } from "react";

import { RuntimeSocket } from "@/lib/ws-socket";

/**
 * The terminal live-view state machine (S18 chunk 3, issue #19) — the web
 * counterpart of the runtime's per-Agent terminal journal stream.
 *
 * STREAM: terminal events journal on `terminal:<workspace_id>:<agent_id>`
 * (apps/user-runtime terminals.events.ts — the single naming definition), so
 * this module mirrors that convention for the WS subscription. The SAME
 * pipeline the S09 conversation thread uses carries the events: the gateway's
 * general `stream.subscribe` / `replay.request` read-only acks plus
 * `stream.event` fanout — no new transport surface, and the redaction
 * invariant rides along for free (chunk 1 redacted every payload before the
 * journal append, so everything this reducer ever sees is already clean, G3).
 *
 * REPLAY/RECONNECT (D26/§6.4): durable history is answered by replay.request
 * from the acknowledged cursor; live events dedupe on the per-stream sequence
 * (exactly-once). The cursor acknowledgement trails the render exactly like
 * the thread layer (E10): applied is not rendered, so a hard refresh mid-
 * output replays any applied-but-unseen chunk instead of skipping it.
 *
 * STATE SHAPE: executions, newest first. `terminal.started` opens one with
 * the truthful D35 fields (command, working directory, resource policy,
 * approval state); `terminal.output` appends its chunk; `terminal.exited`
 * closes it with code/signal/time. Output for an unknown terminal is REFUSED,
 * never fabricated into a record (G4). Non-terminal event types never arrive
 * on this stream, and are ignored if they ever do — the cursor still advances
 * so a future vocabulary cannot wedge the replay.
 */

export type TerminalApprovalStateView = "not_required" | "pending" | "approved" | "rejected";
export type TerminalExecutionStatus = "running" | "exited";

export interface TerminalOutputChunkView {
  stream: "stdout" | "stderr";
  text: string;
}

/** One terminal execution as the panel renders it — the journal's truth. */
export interface TerminalExecutionView {
  terminalId: string;
  sessionId: string | null;
  command: string;
  workdir: string;
  resourcePolicy: Record<string, unknown>;
  approvalState: TerminalApprovalStateView;
  status: TerminalExecutionStatus;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  chunks: TerminalOutputChunkView[];
}

export type TerminalLivePhase = "connecting" | "live" | "reconnecting" | "offline";

export interface TerminalLiveState {
  phase: TerminalLivePhase;
  /** The highest APPLIED per-stream sequence (the exactly-once boundary). */
  cursor: number;
  /**
   * The highest ACKNOWLEDGED sequence — what replay.request carries on
   * reconnect (E10/D26). Trails `cursor` on purpose; the hook acknowledges
   * only after the render that includes the events commits.
   */
  acknowledged: number;
  /** Executions, newest first (the current one leads). */
  executions: TerminalExecutionView[];
  /** A typed transport-level failure worth a §2.4 error surface (redacted). */
  error: string | null;
}

export const INITIAL_TERMINAL_STATE: TerminalLiveState = {
  phase: "connecting",
  cursor: 0,
  acknowledged: 0,
  executions: [],
  error: null,
};

/** The loose envelope the WS fanout and the HTTP replay both carry. */
export interface TerminalStreamEvent {
  event_id: string;
  sequence: number;
  type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
}

/** The per-Agent terminal stream id — mirrors terminals.events.ts verbatim. */
export function terminalStreamIdFor(workspaceId: string, agentId: string): string {
  return `terminal:${workspaceId}:${agentId}`;
}

const APPROVAL_STATES: ReadonlySet<string> = new Set([
  "not_required",
  "pending",
  "approved",
  "rejected",
]);

function payloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : "";
}

/** Apply one journal envelope; pure, exactly-once by sequence (D26). */
export function applyTerminalStreamEvent(
  state: TerminalLiveState,
  event: TerminalStreamEvent,
): TerminalLiveState {
  if (event.sequence <= state.cursor) {
    return state;
  }

  const payload = event.payload;
  let executions = state.executions;

  if (event.type === "terminal.started") {
    const approvalState = payloadString(payload, "approval_state");
    const terminalId = payloadString(payload, "terminal_id");
    // A repeated start for a known terminal is a duplicate delivery, not a
    // second execution — the sequence dedupe above catches honest replays;
    // this guards a same-id redelivery above the cursor.
    const known = executions.some((execution) => execution.terminalId === terminalId);
    if (!known && terminalId !== "") {
      executions = [
        {
          terminalId,
          sessionId: typeof payload["session_id"] === "string" ? payload["session_id"] : null,
          command: payloadString(payload, "command"),
          workdir: payloadString(payload, "workdir"),
          resourcePolicy:
            typeof payload["resource_policy"] === "object" && payload["resource_policy"] !== null
              ? (payload["resource_policy"] as Record<string, unknown>)
              : {},
          approvalState: (APPROVAL_STATES.has(approvalState)
            ? approvalState
            : "not_required") as TerminalApprovalStateView,
          status: "running",
          startedAt: event.occurred_at,
          exitedAt: null,
          exitCode: null,
          exitSignal: null,
          chunks: [],
        },
        ...executions,
      ];
    }
  } else if (event.type === "terminal.output") {
    const terminalId = payloadString(payload, "terminal_id");
    const text = typeof payload["text"] === "string" ? payload["text"] : "";
    const stream = payload["stream"] === "stderr" ? "stderr" : "stdout";
    executions = executions.map((execution) =>
      execution.terminalId === terminalId && text !== ""
        ? { ...execution, chunks: [...execution.chunks, { stream, text }] }
        : execution,
    );
  } else if (event.type === "terminal.exited") {
    const terminalId = payloadString(payload, "terminal_id");
    executions = executions.map((execution) =>
      execution.terminalId === terminalId
        ? {
            ...execution,
            status: "exited" as const,
            exitCode: typeof payload["exit_code"] === "number" ? payload["exit_code"] : null,
            exitSignal: typeof payload["exit_signal"] === "string" ? payload["exit_signal"] : null,
            exitedAt: event.occurred_at,
          }
        : execution,
    );
  }

  return { ...state, cursor: event.sequence, executions };
}

export type TerminalLiveEvent =
  | { type: "connecting" }
  | { type: "subscribed" }
  | { type: "disconnected" }
  | { type: "reconnecting" }
  | { type: "stream_event"; event: TerminalStreamEvent }
  | { type: "cursor_acknowledged"; sequence: number }
  | { type: "transport_error"; message: string };

export function advanceTerminalLive(
  state: TerminalLiveState,
  event: TerminalLiveEvent,
): TerminalLiveState {
  switch (event.type) {
    case "connecting":
      return { ...state, phase: "connecting" };
    case "subscribed":
      return { ...state, phase: "live", error: null };
    case "disconnected":
      return { ...state, phase: "offline" };
    case "reconnecting":
      return { ...state, phase: "reconnecting" };
    case "stream_event":
      return applyTerminalStreamEvent(state, event.event);
    case "cursor_acknowledged":
      // The acknowledgement can never run ahead of what is applied: it is
      // clamped to the applied cursor (E10/D26).
      return {
        ...state,
        acknowledged: Math.max(state.acknowledged, Math.min(event.sequence, state.cursor)),
      };
    case "transport_error":
      return { ...state, error: event.message };
  }
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 3000;

export interface UseTerminalLiveArgs {
  /** The same-origin managed runtime websocket URL; null disables live. */
  wsUrl: string | null;
  workspaceId: string;
  /** The chat's Agent — the terminal stream is per-Agent; null disables. */
  agentId: string | null;
  enabled: boolean;
}

export interface TerminalLive {
  phase: TerminalLivePhase;
  executions: TerminalExecutionView[];
  loading: boolean;
  error: string | null;
}

/**
 * The terminal live hook: RuntimeSocket subscription to the Agent's terminal
 * stream + durable replay, on the S09 conversation hook's proven lifecycle
 * (register fanout handlers before the replay round-trip, exactly-once
 * dedupe, one reconnect scheduler per episode, bounded backoff). Read-only by
 * construction: the only outbound frames are the two read-only subscriptions
 * (D26) — there is no write path to the terminal from this hook at all.
 */
export function useTerminalLive(args: UseTerminalLiveArgs): TerminalLive {
  const [state, dispatch] = useReducer(advanceTerminalLive, INITIAL_TERMINAL_STATE);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Applied → rendered acknowledgement (E10): runs after each committed render.
  useEffect(() => {
    if (state.acknowledged < state.cursor) {
      dispatch({ type: "cursor_acknowledged", sequence: state.cursor });
    }
  });

  const { wsUrl, workspaceId, agentId, enabled } = args;
  const streamId = useMemo(
    () => (agentId !== null ? terminalStreamIdFor(workspaceId, agentId) : null),
    [workspaceId, agentId],
  );

  useEffect(() => {
    if (!enabled || !wsUrl || !streamId) {
      return;
    }
    let cancelled = false;
    let socket: RuntimeSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) {
        return;
      }
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      const isReconnect = reconnectAttempt > 0;
      if (isReconnect) {
        dispatch({ type: "reconnecting" });
      }
      void (async () => {
        try {
          const opened = await RuntimeSocket.open(wsUrl);
          if (cancelled) {
            opened.close();
            return;
          }
          socket = opened;
          // Live fanout handlers registered BEFORE the replay round-trips:
          // events fanned out while the replay await is in flight dispatch
          // too, and the sequence dedupe absorbs the overlap (D26).
          socket.onEvent((name, payload) => {
            if (name === "stream.event" && payload && typeof payload === "object") {
              dispatch({ type: "stream_event", event: payload as TerminalStreamEvent });
            }
          });
          socket.onClose(() => {
            if (cancelled) {
              return;
            }
            dispatch({ type: "disconnected" });
            scheduleReconnect();
          });

          await socket.request("stream.subscribe", {
            workspace_id: workspaceId,
            stream_id: streamId,
          });
          if (cancelled) {
            return;
          }

          // Durable history from the acknowledged cursor; initial load (0)
          // renders the whole session, a reconnect renders only the gap.
          const replay = await socket.request("replay.request", {
            workspace_id: workspaceId,
            stream_id: streamId,
            last_acknowledged_sequence: stateRef.current.acknowledged,
          });
          if (cancelled) {
            return;
          }
          const replayResult = replay as { kind?: string; events?: unknown[] } | null;
          if (
            replayResult &&
            replayResult.kind === "events" &&
            Array.isArray(replayResult.events)
          ) {
            for (const event of replayResult.events) {
              if (cancelled) {
                return;
              }
              dispatch({ type: "stream_event", event: event as TerminalStreamEvent });
            }
          }
          dispatch({ type: "subscribed" });
          reconnectAttempt = 0;
        } catch {
          // The attempt died: close this attempt's socket so no zombie
          // connection lingers alongside the retry loop (the S09 discipline).
          socket?.close();
          socket = null;
          if (cancelled) {
            return;
          }
          dispatch({ type: "disconnected" });
          scheduleReconnect();
        }
      })();
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [enabled, wsUrl, workspaceId, streamId]);

  return {
    phase: state.phase,
    executions: state.executions,
    loading: state.executions.length === 0 && state.cursor === 0,
    error: state.error,
  };
}
