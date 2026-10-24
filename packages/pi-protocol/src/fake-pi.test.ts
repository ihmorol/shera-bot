/**
 * S12 chunk 1 — fake Pi child-process tests: handshake, heartbeat cadence,
 * reply token streams, misbehavior classification, lifecycle. Each case runs
 * the fake Pi as a real spawned node child process speaking JSONL stdio
 * (the D14 shape, validated as variant A by E17).
 *
 * Governing records: D13, D14, E17.
 */
import { describe, expect, it } from "vitest";

import { ProtocolVersionError } from "./errors.ts";
import { spawnFakePi, type FakePiHandle } from "./fake-pi.ts";
import {
  PROTOCOL_VERSION,
  type CompletedFrame,
  type HeartbeatFrame,
  type ReadyFrame,
  type TokenFrame,
} from "./protocol.ts";

function tokenFrames(handle: FakePiHandle): TokenFrame[] {
  return handle.frames.flatMap((entry) =>
    entry.ok && entry.frame.type === "token" ? [entry.frame] : [],
  );
}

function heartbeatFrames(handle: FakePiHandle): HeartbeatFrame[] {
  return handle.frames.flatMap((entry) =>
    entry.ok && entry.frame.type === "heartbeat" ? [entry.frame] : [],
  );
}

function completedFrames(handle: FakePiHandle): CompletedFrame[] {
  return handle.frames.flatMap((entry) =>
    entry.ok && entry.frame.type === "completed" ? [entry.frame] : [],
  );
}

function readyFrame(handle: FakePiHandle): ReadyFrame | undefined {
  for (const entry of handle.frames) {
    if (entry.ok && entry.frame.type === "ready") return entry.frame;
  }
  return undefined;
}

function violations(handle: FakePiHandle) {
  return handle.frames.flatMap((entry) => (entry.ok ? [] : [entry.error]));
}

async function until<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the expected frame");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("fake Pi handshake", () => {
  it("announces hello with the current protocol version, then ready", async () => {
    const handle = spawnFakePi({ sessionId: "s-handshake" });
    try {
      const hello = await handle.hello;
      expect(hello.type).toBe("hello");
      expect(hello.protocol_version).toBe(PROTOCOL_VERSION);
      expect(hello.v).toBe(PROTOCOL_VERSION);
      const ready = await until(() => readyFrame(handle));
      expect(ready.session_id).toBe("s-handshake");
      expect(ready.pid).toBeGreaterThan(0);
      expect(ready.resumed).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });

  it("rejects the handshake with ProtocolVersionError on a version mismatch", async () => {
    const handle = spawnFakePi({ protocolVersion: PROTOCOL_VERSION + 1 });
    let error: unknown;
    try {
      await handle.hello;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolVersionError);
    const versionError = error as ProtocolVersionError;
    expect(versionError.code).toBe("PROTOCOL_VERSION_MISMATCH");
    expect(versionError.category).toBe("validation");
    expect(versionError.expected).toBe(PROTOCOL_VERSION);
    expect(versionError.received).toBe(PROTOCOL_VERSION + 1);
    handle.kill();
    await handle.waitForExit();
  });
});

describe("fake Pi heartbeats", () => {
  it("emits heartbeats on the configured cadence", async () => {
    const handle = spawnFakePi({ sessionId: "s-beat", heartbeatMs: 40 });
    try {
      const beats = await until(() => {
        const list = heartbeatFrames(handle);
        return list.length >= 3 ? list : undefined;
      });
      for (let i = 1; i < beats.length; i++) {
        expect(beats[i]!.t).toBeGreaterThanOrEqual(beats[i - 1]!.t);
      }
      expect(beats.every((beat) => beat.session_id === "s-beat")).toBe(true);
    } finally {
      await handle.shutdown();
    }
  });

  it("stays silent when heartbeats are disabled (silence misbehavior)", async () => {
    const handle = spawnFakePi({ sessionId: "s-silent", heartbeatMs: 0 });
    try {
      await handle.hello;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(heartbeatFrames(handle)).toEqual([]);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("fake Pi reply token streams", () => {
  it("streams supervised token deltas ({seq, text}) then a completed frame per prompt", async () => {
    const handle = spawnFakePi({
      sessionId: "s-tokens",
      tokens: 3,
      tokenDelayMs: 10,
      heartbeatMs: 0,
    });
    try {
      const id = handle.prompt("write a haiku");
      const tokens = await until(() => {
        const mine = tokenFrames(handle).filter((token) => token.id === id);
        return mine.length >= 3 ? mine : undefined;
      });
      expect(tokens.map((token) => token.seq)).toEqual([1, 2, 3]);
      expect(tokens.map((token) => token.text)).toEqual(["t1", "t2", "t3"]);
      expect(tokens.every((token) => token.session_id === "s-tokens")).toBe(true);
      const completed = await until(() => completedFrames(handle).find((c) => c.id === id));
      expect(completed.last_seq).toBe(3);
      expect(completed.session_id).toBe("s-tokens");
    } finally {
      await handle.shutdown();
    }
  });

  it("serves multiple sequential prompts with independent correlation ids", async () => {
    const handle = spawnFakePi({ sessionId: "s-multi", tokens: 2, tokenDelayMs: 5 });
    try {
      const id1 = handle.prompt("step one");
      const done1 = await until(() => completedFrames(handle).find((c) => c.id === id1));
      expect(done1.last_seq).toBe(2);
      const id2 = handle.prompt("step two");
      const done2 = await until(() => completedFrames(handle).find((c) => c.id === id2));
      expect(done2.last_seq).toBe(2);
      expect(id1).not.toBe(id2);
    } finally {
      await handle.shutdown();
    }
  });

  it("resumes the token sequence from the prompt's from_seq cursor", async () => {
    const handle = spawnFakePi({
      sessionId: "s-resume",
      tokens: 2,
      tokenDelayMs: 5,
      heartbeatMs: 0,
    });
    try {
      const id = handle.prompt("continue", 3);
      const tokens = await until(() => {
        const mine = tokenFrames(handle).filter((token) => token.id === id);
        return mine.length >= 2 ? mine : undefined;
      });
      expect(tokens.map((token) => token.seq)).toEqual([4, 5]);
      const completed = await until(() => completedFrames(handle).find((c) => c.id === id));
      expect(completed.last_seq).toBe(5);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("fake Pi misbehaviors", () => {
  it("classifies an invalid JSON line as ProtocolViolationError(unparseable_json_line)", async () => {
    const handle = spawnFakePi({ invalidJsonLine: true });
    try {
      const failure = await until(() => violations(handle)[0]);
      expect(failure.code).toBe("PROTOCOL_VIOLATION");
      expect(failure.category).toBe("validation");
      expect(failure.reason).toBe("unparseable_json_line");
    } finally {
      await handle.shutdown();
    }
  });

  it("classifies an unknown frame type as ProtocolViolationError(unknown_frame_type)", async () => {
    const handle = spawnFakePi({ unknownFrameType: true });
    try {
      const failure = await until(() => violations(handle)[0]);
      expect(failure.code).toBe("PROTOCOL_VIOLATION");
      expect(failure.category).toBe("validation");
      expect(failure.reason).toBe("unknown_frame_type");
    } finally {
      await handle.shutdown();
    }
  });

  it("crashes on demand and reports the exit to the harness", async () => {
    const handle = spawnFakePi({ crashOnPrompt: true, heartbeatMs: 50 });
    handle.prompt("crash");
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(137);
  });
});

describe("fake Pi lifecycle", () => {
  it("exits cleanly on the shutdown frame", async () => {
    const handle = spawnFakePi({ sessionId: "s-shutdown" });
    await handle.hello;
    const exit = await handle.shutdown();
    expect(exit.code).toBe(0);
  });
});
