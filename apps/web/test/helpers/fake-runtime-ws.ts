import { createHash } from "node:crypto";
import { createServer, type Server as HTTPServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";

/**
 * Fake runtime WS endpoint (S09 chunk 2 test helper) — a minimal RFC6455
 * WebSocket SERVER speaking the same engine.io/Socket.IO v4 wire subset the
 * S07 gateway speaks, in-process with no extra dependency. The production
 * RuntimeSocket client is tested against it end to end: handshake, acked
 * requests (stream.subscribe / replay.request), server events, transient
 * frames, and close detection.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface DecodedFrame {
  opcode: number;
  text: string | null;
}

function decodeClientFrame(buffer: Buffer): { frame: DecodedFrame; consumed: number } {
  if (buffer.length < 2) {
    return { frame: { opcode: -1, text: null }, consumed: 0 };
  }
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + (masked ? 4 : 0) + length) {
    return { frame: { opcode: -1, text: null }, consumed: 0 };
  }
  let payload = buffer.subarray(offset + (masked ? 4 : 0), offset + (masked ? 4 : 0) + length);
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = payload[index]! ^ mask[index % 4]!;
    }
  }
  return {
    frame: { opcode, text: opcode === 0x1 ? payload.toString("utf8") : null },
    consumed: offset + (masked ? 4 : 0) + length,
  };
}

function encodeServerFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface FakeRuntimeWsOptions {
  /** Called for every replay.request; the return value is the ack payload. */
  replay?: (body: Record<string, unknown>) => unknown;
  /** Called for every stream.subscribe; the return value is the ack payload. */
  subscribe?: (selector: Record<string, unknown>) => unknown;
}

export interface FakeRuntimeWs {
  url: string;
  /** Inbound frames received from the client (after handshake). */
  readonly inbound: string[];
  /** Send a server event frame (`42["name",payload]`). */
  emitEvent(name: string, payload: unknown): void;
  /** Send a transient stream.frame (`42["stream.frame",payload]`). */
  emitFrame(payload: unknown): void;
  closeClient(): void;
  close(): Promise<void>;
}

export function startFakeRuntimeWs(options: FakeRuntimeWsOptions = {}): Promise<FakeRuntimeWs> {
  return new Promise((resolveServer) => {
    const httpServer: HTTPServer = createServer();
    let socket: Duplex | null = null;
    const inbound: string[] = [];
    const sendRaw = (text: string) => {
      socket?.write(encodeServerFrame(text));
    };

    const handleFrameText = (text: string) => {
      inbound.push(text);
      if (text === "40") {
        sendRaw(`40{"sid":"fake-runtime-ws"}`);
        return;
      }
      if (text === "2") {
        sendRaw("3");
        return;
      }
      const ackMatch = /^42(\d+)(.*)$/s.exec(text);
      if (ackMatch) {
        const id = Number(ackMatch[1]);
        const parsed = JSON.parse(ackMatch[2] ?? "[]") as [string, Record<string, unknown>];
        const [name, payload] = parsed;
        let result: unknown = { ok: true };
        if (name === "stream.subscribe") {
          result = options.subscribe?.(payload) ?? { subscribed: true, ...payload };
        } else if (name === "replay.request") {
          result = options.replay?.(payload) ?? {
            kind: "events",
            stream_id: payload["stream_id"],
            workspace_id: payload["workspace_id"],
            events: [],
            next_cursor: 0,
            replayed: true,
          };
        }
        sendRaw(`43${id}${JSON.stringify([result])}`);
      }
    };

    let frameBuffer = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);
      for (;;) {
        const { frame, consumed } = decodeClientFrame(frameBuffer);
        if (consumed === 0) {
          return;
        }
        frameBuffer = frameBuffer.subarray(consumed);
        if (frame.opcode === 0x8) {
          socket?.end();
          return;
        }
        if (frame.opcode === 0x1 && frame.text !== null) {
          handleFrameText(frame.text);
        }
      }
    };

    httpServer.on("upgrade", (request: IncomingMessage, duplex: Duplex) => {
      socket = duplex;
      // Node's HTTP parser consumed the upgrade request (that is how this
      // event fired), so the 101 answer is written here from the parsed
      // headers — no request bytes appear on the socket stream.
      const key = request.headers["sec-websocket-key"] ?? "";
      const accept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      duplex.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      duplex.on("data", onData);
      duplex.on("error", () => undefined);
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      const url = `ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`;
      resolveServer({
        url,
        inbound,
        emitEvent(name, payload) {
          sendRaw(`42${JSON.stringify([name, payload])}`);
        },
        emitFrame(payload) {
          sendRaw(`42${JSON.stringify(["stream.frame", payload])}`);
        },
        closeClient() {
          // A server-initiated close: an empty close frame (opcode 0x8).
          socket?.write(Buffer.from([0x88, 0x00]));
        },
        close: () =>
          new Promise((resolve) => {
            httpServer.close(() => resolve());
          }),
      });
    });
  });
}
