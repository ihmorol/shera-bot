/**
 * Runtime node bootstrap tests (S07 5a).
 *
 * Light, per the slice scope: the module exports a start/stop pair; a node
 * starts on an ephemeral loopback port over a temp SQLite file, serves the
 * health probe, and stops cleanly (the port refuses after stop). Signal
 * handling is wired but not exercised here — signal delivery belongs to
 * process supervision in a later slice.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { runtimeConfigFromEnv, startRuntimeNode } from "./main.ts";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime node bootstrap", () => {
  it("starts on an ephemeral port, serves health, and stops cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-runtime-node-"));
    tempDirs.push(dir);

    const node = await startRuntimeNode({
      host: "127.0.0.1",
      port: 0,
      dbPath: join(dir, "runtime.db"),
    });
    expect(node.host).toBe("127.0.0.1");
    expect(node.port).toBeGreaterThan(0);

    // HTTP + WS on one server: the health probe answers.
    const health = await fetch(`http://127.0.0.1:${node.port}/internal/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // Clean shutdown: the port refuses once the node has stopped.
    await node.stop();
    await expect(fetch(`http://127.0.0.1:${node.port}/internal/v1/health`)).rejects.toThrow();
  });

  it("stop is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-runtime-node-"));
    tempDirs.push(dir);

    const node = await startRuntimeNode({ host: "127.0.0.1", port: 0, dbPath: join(dir, "r.db") });
    await node.stop();
    await expect(node.stop()).resolves.toBeUndefined();
  });
});

describe("runtime node config from environment (no secrets cross this path, G3)", () => {
  it("applies loopback-safe defaults and honours explicit overrides", () => {
    expect(runtimeConfigFromEnv({})).toEqual({
      host: "127.0.0.1",
      port: 8080,
      dbPath: join("data", "runtime.db"),
    });
    expect(
      runtimeConfigFromEnv(
        { RUNTIME_HOST: "127.0.0.1", RUNTIME_PORT: "5099", RUNTIME_DB_PATH: "/tmp/runtime.db" },
        { port: 0 },
      ),
    ).toEqual({ host: "127.0.0.1", port: 0, dbPath: "/tmp/runtime.db" });
  });

  it("fails on an invalid port instead of silently falling back (G4)", () => {
    expect(() => runtimeConfigFromEnv({ RUNTIME_PORT: "not-a-port" })).toThrow(
      /RUNTIME_PORT is not a valid port/,
    );
    expect(() => runtimeConfigFromEnv({ RUNTIME_PORT: "99999" })).toThrow(
      /RUNTIME_PORT is not a valid port/,
    );
  });
});
