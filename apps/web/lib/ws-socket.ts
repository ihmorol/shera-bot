/**
 * Minimal Socket.IO v4 client over the browser's built-in WebSocket (S09
 * chunk 2). The S07 gateway speaks engine.io/Socket.IO v4; the S07 tests
 * proved the wire protocol with the same minimal approach — this is its
 * production counterpart, so the web app needs NO socket.io-client dependency
 * (chunk-2 constraint: no new dependencies).
 *
 * Protocol subset (direct websocket transport, no polling upgrade):
 * - client sends `40` (namespace connect) on ws open; server answers
 *   `40{"sid":...}` — the socket is then established;
 * - acked request: `42<id>["name",payload]`, server answers `43<id>[result]`;
 * - server events arrive as `42["name",payload]`;
 * - engine.io ping `2` is answered with pong `3` (transport keepalive only —
 *   never a business event, D26).
 *
 * Reconnection is NOT automatic here: the connection lifecycle (§6.4) is
 * owned by the live-thread layer, which drives reconnect + durable replay
 * (replay.request with the last acknowledged sequence) explicitly.
 */

export class RuntimeSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSocketError";
  }
}

export type SocketFrameHandler = (name: string, payload: unknown) => void;

/** Parse one engine.io/Socket.IO text frame into a discriminated result. */
export function parseSocketFrame(
  data: string,
):
  | { kind: "namespace_connected" }
  | { kind: "ping" }
  | { kind: "open" }
  | { kind: "ack"; id: number; payload: unknown }
  | { kind: "event"; name: string; payload: unknown }
  | { kind: "unknown" } {
  if (data === "0") {
    return { kind: "open" };
  }
  if (data === "2") {
    return { kind: "ping" };
  }
  if (data === "40" || data.startsWith("40{")) {
    return { kind: "namespace_connected" };
  }
  const ackMatch = /^43(\d+)(.*)$/s.exec(data);
  if (ackMatch) {
    let payload: unknown;
    try {
      payload = JSON.parse(ackMatch[2] ?? "[]");
    } catch {
      // A corrupt frame is junk on the wire, not an exception into the
      // socket's message handler — the discriminated result absorbs it.
      return { kind: "unknown" };
    }
    return {
      kind: "ack",
      id: Number(ackMatch[1]),
      payload: Array.isArray(payload) ? payload[0] : payload,
    };
  }
  const eventMatch = /^42(\d+)?(.*)$/s.exec(data);
  if (eventMatch) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(eventMatch[2] ?? "[]");
    } catch {
      return { kind: "unknown" };
    }
    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
      return { kind: "event", name: parsed[0], payload: parsed[1] };
    }
  }
  return { kind: "unknown" };
}

/** Build one acked-request frame (`42<id>["name",payload]`). */
export function buildRequestFrame(id: number, name: string, payload: unknown): string {
  return `42${id}${JSON.stringify([name, payload])}`;
}

interface RawWebSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface PendingAck {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RuntimeSocket {
  private nextAckId = 1;
  private readonly acks = new Map<number, PendingAck>();
  private readonly frameHandlers = new Set<SocketFrameHandler>();
  private readonly closeHandlers = new Set<() => void>();
  private readonly ws: RawWebSocket;
  private closedByUs = false;
  private dead = false;

  private constructor(ws: RawWebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const frame = parseSocketFrame(event.data);
      switch (frame.kind) {
        case "ping":
          ws.send("3");
          return;
        case "ack": {
          const pending = this.acks.get(frame.id);
          if (pending) {
            this.acks.delete(frame.id);
            clearTimeout(pending.timer);
            pending.resolve(frame.payload);
          }
          return;
        }
        case "event":
          for (const handler of this.frameHandlers) {
            handler(frame.name, frame.payload);
          }
          return;
        default:
          return;
      }
    };
    ws.onclose = () => {
      this.handleWsClose();
    };
  }

  /**
   * The single close path: every pending request rejects immediately (the
   * request() contract — "rejects if the socket closes before the answer"),
   * then close subscribers hear it. Both the handshake-phase onclose (set by
   * open()) and the post-handshake onclose land here.
   */
  private handleWsClose(): void {
    this.dead = true;
    const pending = [...this.acks.values()];
    this.acks.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(new RuntimeSocketError("The socket closed before the request was answered."));
    }
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  /** Connect and establish the Socket.IO namespace; resolves when ready. */
  static open(url: string): Promise<RuntimeSocket> {
    return new Promise((resolve, reject) => {
      // Browser and Node ≥22 both expose the WHATWG WebSocket global.
      const ws = new WebSocket(url) as unknown as RawWebSocket;
      let settled = false;
      const socket = new RuntimeSocket(ws);
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new RuntimeSocketError(String(error)));
        }
      };
      ws.onerror = (event) => fail(event);
      ws.onclose = () => {
        fail(new RuntimeSocketError("The socket closed before the namespace was established."));
        socket.handleWsClose();
      };
      ws.onopen = () => {
        // The engine.io OPEN packet arrives as a message; the namespace
        // connect is initiated by the client immediately on open.
        ws.send("40");
      };
      // Wrap onmessage to additionally resolve the handshake.
      const previousMessage = ws.onmessage;
      ws.onmessage = (event) => {
        if (
          !settled &&
          typeof event.data === "string" &&
          parseSocketFrame(event.data).kind === "namespace_connected"
        ) {
          settled = true;
          // Restore the production handler chain.
          ws.onmessage = previousMessage;
          resolve(socket);
          return;
        }
        previousMessage?.(event);
      };
    });
  }

  /** One acked request; rejects if the socket closes before the answer. */
  request<T = unknown>(name: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closedByUs || this.dead) {
        reject(new RuntimeSocketError("The socket is closed."));
        return;
      }
      const id = this.nextAckId;
      this.nextAckId += 1;
      const pending: PendingAck = {
        resolve: (value) => {
          clearTimeout(pending.timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(pending.timer);
          reject(error instanceof Error ? error : new RuntimeSocketError(String(error)));
        },
        timer: setTimeout(() => {
          if (this.acks.delete(id)) {
            reject(new RuntimeSocketError(`The ${name} request timed out.`));
          }
        }, 10_000),
      };
      this.acks.set(id, pending);
      try {
        this.ws.send(buildRequestFrame(id, name, payload));
      } catch (error) {
        this.acks.delete(id);
        clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new RuntimeSocketError(String(error)));
      }
    });
  }

  /** Subscribe to server-emitted events; returns an unsubscribe function. */
  onEvent(handler: SocketFrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  /** Subscribe to socket-close notifications; returns an unsubscribe function. */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(): void {
    this.closedByUs = true;
    this.ws.close();
  }
}
