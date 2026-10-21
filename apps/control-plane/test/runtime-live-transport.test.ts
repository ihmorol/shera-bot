import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startRuntimeNode, type RuntimeNode } from "../../user-runtime/src/main.ts";
import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts, controlSessions } from "../src/db/schema.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";

const ACCOUNT_ID = "a1b2c3d4-0000-4000-8000-000000000001";
const WORKSPACE_ID = `ws_${ACCOUNT_ID}`;
const WEB_ORIGIN = "https://shera.test";
const SESSION_TOKEN = randomBytes(32).toString("hex");
const CHANNEL_TOKEN = randomBytes(32).toString("hex");

function encodeClientText(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const header =
    payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.alloc(4);
  if (payload.length >= 126) {
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index]! ^= mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

function decodeServerText(buffer: Buffer): { text: string | null; consumed: number } {
  if (buffer.length < 2) return { text: null, consumed: 0 };
  const opcode = buffer[0]! & 0x0f;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return { text: null, consumed: 0 };
    length = buffer.readUInt16BE(2);
    offset = 4;
  }
  if (buffer.length < offset + length) return { text: null, consumed: 0 };
  return {
    text: opcode === 1 ? buffer.subarray(offset, offset + length).toString("utf8") : null,
    consumed: offset + length,
  };
}

class RawWebSocket {
  private buffer = Buffer.alloc(0);
  private readonly texts: string[] = [];
  private readonly waiters: Array<(text: string) => void> = [];

  constructor(
    readonly socket: Socket,
    initial: Buffer,
  ) {
    this.push(initial);
    socket.on("data", (chunk) => this.push(chunk));
    socket.on("error", () => undefined);
  }

  private push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = decodeServerText(this.buffer);
      if (frame.consumed === 0) return;
      this.buffer = this.buffer.subarray(frame.consumed);
      if (frame.text !== null) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame.text);
        else this.texts.push(frame.text);
      }
    }
  }

  send(text: string): void {
    this.socket.write(encodeClientText(text));
  }

  nextText(): Promise<string> {
    const existing = this.texts.shift();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for websocket frame")),
        5000,
      );
      this.waiters.push((text) => {
        clearTimeout(timer);
        resolve(text);
      });
    });
  }

  closed(): Promise<void> {
    if (this.socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for socket close")), 5000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

async function upgrade(args: {
  port: number;
  origin?: string;
  cookie?: string;
  path?: string;
}): Promise<{ status: number; websocket: RawWebSocket | null }> {
  const socket = connect(args.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      `GET ${args.path ?? "/api/runtime/live?EIO=4&transport=websocket"} HTTP/1.1`,
      `Host: 127.0.0.1:${args.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      `Sec-WebSocket-Key: ${key}`,
      ...(args.origin ? [`Origin: ${args.origin}`] : []),
      ...(args.cookie ? [`Cookie: ${args.cookie}`] : []),
      "",
      "",
    ].join("\r\n"),
  );
  const response = await new Promise<Buffer>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("timed out waiting for upgrade")), 5000);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.indexOf("\r\n\r\n") >= 0) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(received);
      }
    };
    socket.on("data", onData);
  });
  const headerEnd = response.indexOf("\r\n\r\n");
  const status = Number(/^HTTP\/1\.1 (\d+)/.exec(response.subarray(0, headerEnd).toString())?.[1]);
  if (status !== 101) {
    socket.destroy();
    return { status, websocket: null };
  }
  return { status, websocket: new RawWebSocket(socket, response.subarray(headerEnd + 4)) };
}

let cluster: TestCluster;
let runtime: RuntimeNode;
let controlPlane: ControlPlaneApp;
let server: Server;
let port: number;
let tempDir: string;
const routedAccounts: string[] = [];

beforeAll(async () => {
  cluster = await startTestCluster("runtime-live");
  tempDir = mkdtempSync(join(tmpdir(), "shera-runtime-live-"));
  runtime = await startRuntimeNode({
    port: 0,
    dbPath: join(tempDir, "runtime.db"),
    management: {
      host: "127.0.0.1",
      port: 0,
      accountId: ACCOUNT_ID,
      credentialSha256: createHash("sha256").update(CHANNEL_TOKEN).digest("hex"),
    },
  });
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {
      AUTH_SECRET: randomBytes(32).toString("hex"),
      AUTH_URL: WEB_ORIGIN,
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
      SHERA_WEB_ORIGIN: WEB_ORIGIN,
    },
    liveSessionValidationIntervalMs: 20,
    runtimeTargetForAccount: async (accountId) => {
      routedAccounts.push(accountId);
      return {
        endpoint: `http://127.0.0.1:${runtime.managementPort}`,
        bearer: CHANNEL_TOKEN,
      };
    },
  });
  await controlPlane.db.insert(controlAccounts).values({
    id: ACCOUNT_ID,
    name: "Live User",
    email: "live@example.com",
  });
  await controlPlane.db.insert(controlSessions).values({
    sessionToken: SESSION_TOKEN,
    userId: ACCOUNT_ID,
    expires: new Date(Date.now() + 60_000),
  });
  server = createServer(controlPlane.app);
  controlPlane.liveTransport.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
}, 180_000);

afterAll(async () => {
  controlPlane?.liveTransport.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await controlPlane?.close();
  await runtime?.stop();
  await cluster?.stop();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}, 180_000);

describe("authenticated live runtime transport", () => {
  it("rejects foreign origins, missing sessions and non-live upgrade paths", async () => {
    expect(
      (
        await upgrade({
          port,
          origin: "https://foreign.test",
          cookie: `__Secure-authjs.session-token=${SESSION_TOKEN}`,
        })
      ).status,
    ).toBe(403);
    expect((await upgrade({ port, origin: WEB_ORIGIN })).status).toBe(401);
    expect(
      (
        await upgrade({
          port,
          origin: WEB_ORIGIN,
          cookie: `__Secure-authjs.session-token=${SESSION_TOKEN}`,
          path: "/api/runtime/live?EIO=4&transport=polling",
        })
      ).status,
    ).toBe(404);
  });

  it("routes the authenticated account and carries subscribe/replay frames both ways", async () => {
    const result = await upgrade({
      port,
      origin: WEB_ORIGIN,
      cookie: `__Secure-authjs.session-token=${SESSION_TOKEN}`,
    });
    expect(result.status).toBe(101);
    const ws = result.websocket!;
    expect(await ws.nextText()).toMatch(/^0/);
    ws.send("40");
    expect(await ws.nextText()).toMatch(/^40/);
    ws.send(
      `420${JSON.stringify(["stream.subscribe", { workspace_id: WORKSPACE_ID, stream_id: "conversation:live" }])}`,
    );
    expect(await ws.nextText()).toContain('"subscribed":true');
    ws.send(
      `421${JSON.stringify(["replay.request", { workspace_id: WORKSPACE_ID, stream_id: "conversation:live", last_acknowledged_sequence: 0 }])}`,
    );
    expect(await ws.nextText()).toContain('"kind":"events"');
    expect(routedAccounts.at(-1)).toBe(ACCOUNT_ID);
    ws.socket.destroy();
  });

  it("parses and forwards authenticated JSON commands through the real app", async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/runtime/local/v1/conversations/commands`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `authjs.session-token=${SESSION_TOKEN}`,
          origin: WEB_ORIGIN,
        },
        body: JSON.stringify({
          type: "conversation.create",
          workspace_id: WORKSPACE_ID,
          idempotency_key: "real-app-json-parser",
          payload: { title: "Real app proxy" },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { kind: string; title: string }).toMatchObject({
      kind: "created",
      title: "Real app proxy",
    });
    expect(routedAccounts.at(-1)).toBe(ACCOUNT_ID);
  });

  it("fails closed when the database session is directly revoked", async () => {
    const result = await upgrade({
      port,
      origin: WEB_ORIGIN,
      cookie: `__Secure-authjs.session-token=${SESSION_TOKEN}`,
    });
    expect(result.status).toBe(101);
    const ws = result.websocket!;
    await controlPlane.db
      .delete(controlSessions)
      .where(eq(controlSessions.sessionToken, SESSION_TOKEN));
    await expect(ws.closed()).resolves.toBeUndefined();
  });
});
