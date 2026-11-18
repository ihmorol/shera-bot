import { afterAll, describe, expect, it } from "vitest";

import {
  RuntimeSocket,
  RuntimeSocketError,
  buildRequestFrame,
  parseSocketFrame,
} from "../lib/ws-socket";
import { startFakeRuntimeWs, type FakeRuntimeWs } from "./helpers/fake-runtime-ws";

/**
 * The minimal Socket.IO v4 client (S09 chunk 2) against an in-process fake
 * runtime WS endpoint speaking the same wire subset as the S07 gateway: the
 * namespace handshake, acked requests, server events, transient frames, and
 * close detection — the no-new-dependency WS transport for the web client.
 */

const servers: FakeRuntimeWs[] = [];

afterAll(async () => {
  for (const server of servers) {
    await server.close();
  }
});

async function start() {
  const server = await startFakeRuntimeWs();
  servers.push(server);
  return server;
}

describe("socket frame codec", () => {
  it("parses the engine.io/Socket.IO v4 frame subset", () => {
    expect(parseSocketFrame("0")).toEqual({ kind: "open" });
    expect(parseSocketFrame("2")).toEqual({ kind: "ping" });
    expect(parseSocketFrame(`40{"sid":"s1"}`)).toEqual({ kind: "namespace_connected" });
    expect(parseSocketFrame(`437["x"]`)).toEqual({
      kind: "ack",
      id: 7,
      payload: "x",
    });
    expect(parseSocketFrame(`42["stream.event",{"a":1}]`)).toEqual({
      kind: "event",
      name: "stream.event",
      payload: { a: 1 },
    });
    expect(parseSocketFrame("??")).toEqual({ kind: "unknown" });
  });

  it("returns unknown (never a throw) for frames carrying malformed JSON", () => {
    // A truncated / corrupt ack or event frame is junk on the wire — the
    // codec's discriminated result must absorb it, not throw into the socket's
    // message handler.
    expect(parseSocketFrame(`43x{"broken`)).toEqual({ kind: "unknown" });
    expect(parseSocketFrame(`42["stream.event"`)).toEqual({ kind: "unknown" });
    expect(parseSocketFrame(`42notjson`)).toEqual({ kind: "unknown" });
  });

  it("builds acked request frames", () => {
    expect(buildRequestFrame(3, "stream.subscribe", { workspace_id: "ws1" })).toBe(
      `423${JSON.stringify(["stream.subscribe", { workspace_id: "ws1" }])}`,
    );
  });
});

describe("RuntimeSocket against the fake runtime endpoint", () => {
  it("handshakes, requests with acks, and receives events and frames", async () => {
    const server = await start();
    const socket = await RuntimeSocket.open(server.url);

    // Acked request: the fake answers stream.subscribe with the receipt.
    const ack = await socket.request("stream.subscribe", {
      workspace_id: "ws_account-1",
      stream_id: "conversation:conv-1",
    });
    expect(ack).toMatchObject({ subscribed: true, stream_id: "conversation:conv-1" });
    expect(server.inbound.some((frame) => frame.startsWith("421"))).toBe(true);

    // Server events and transient frames both reach the handlers.
    const received: Array<{ name: string; payload: unknown }> = [];
    socket.onEvent((name, payload) => received.push({ name, payload }));
    server.emitEvent("stream.event", { sequence: 1 });
    server.emitFrame({ frame: "message.delta", text_delta: "Hel" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.map((entry) => entry.name)).toEqual(["stream.event", "stream.frame"]);
    expect(received[1]!.payload).toMatchObject({ frame: "message.delta", text_delta: "Hel" });

    // Replay request answers with the scripted journal replay.
    const replayAck = await socket.request("replay.request", {
      workspace_id: "ws_account-1",
      stream_id: "conversation:conv-1",
      last_acknowledged_sequence: 0,
    });
    expect(replayAck).toMatchObject({ kind: "events", events: [] });
    socket.close();
  });

  it("notifies close handlers when the server closes the socket", async () => {
    const server = await start();
    const socket = await RuntimeSocket.open(server.url);
    const closed = new Promise<void>((resolve) => {
      socket.onClose(() => resolve());
    });
    server.closeClient();
    await closed;
    socket.close();
  });

  it("rejects pending requests when the socket closes before the ack", async () => {
    const server = await start();
    const socket = await RuntimeSocket.open(server.url);
    const pending = socket.request("stream.subscribe", { workspace_id: "ws_account-1" });
    server.closeClient();
    // The request() contract: "rejects if the socket closes before the
    // answer" — the rejection must ride the CLOSE itself, not the 10s ack
    // timeout, so the live-thread reconnect paths learn immediately. The
    // race pins that: if the promise were still pending 2s after the close
    // (waiting on the ack timeout), the close-driven rejection is broken.
    const outcome = await Promise.race([
      pending.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"still-pending">((resolve) => {
        setTimeout(() => resolve("still-pending"), 2_000);
      }),
    ]);
    expect(outcome).toBe("rejected");
    await expect(pending).rejects.toBeInstanceOf(RuntimeSocketError);
    socket.close();
  });
});
