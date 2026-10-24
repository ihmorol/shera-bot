/**
 * Runtime node bootstrap tests (S07 5a).
 *
 * Light, per the slice scope: the module exports a start/stop pair; a node
 * starts on an ephemeral loopback port over a temp SQLite file, serves the
 * health probe, and stops cleanly (the port refuses after stop). Signal
 * handling is wired but not exercised here — signal delivery belongs to
 * process supervision in a later slice.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    const defaults = runtimeConfigFromEnv({});
    expect(defaults).toEqual({
      host: "127.0.0.1",
      port: 8080,
      dbPath: join("data", "runtime.db"),
      defaultWorkspaceId: "ws-local-default",
      // S10: the default packs root is the repository's own agent-packs tree.
      packsRoot: join(import.meta.dirname, "../../../agent-packs"),
      // S12: no harness command configured → the supervisor is disabled (G4);
      // no policy knobs set → the programmatic constants apply (chunk 4).
      sessionHarness: null,
      sessionPolicy: {},
    });
    expect(
      runtimeConfigFromEnv(
        {
          RUNTIME_HOST: "127.0.0.1",
          RUNTIME_PORT: "5099",
          RUNTIME_DB_PATH: "/tmp/runtime.db",
          RUNTIME_PACKS_ROOT: "/tmp/packs",
        },
        { port: 0 },
      ),
    ).toEqual({
      host: "127.0.0.1",
      port: 0,
      dbPath: "/tmp/runtime.db",
      defaultWorkspaceId: "ws-local-default",
      packsRoot: "/tmp/packs",
      sessionHarness: null,
      sessionPolicy: {},
    });
  });

  it("takes the default workspace from RUNTIME_DEFAULT_WORKSPACE_ID (E12)", () => {
    expect(
      runtimeConfigFromEnv({ RUNTIME_DEFAULT_WORKSPACE_ID: "ws-provisioned-1" }),
    ).toMatchObject({ defaultWorkspaceId: "ws-provisioned-1" });
    expect(
      runtimeConfigFromEnv(
        { RUNTIME_DEFAULT_WORKSPACE_ID: "ws-provisioned-1" },
        { defaultWorkspaceId: "ws-explicit" },
      ),
    ).toMatchObject({ defaultWorkspaceId: "ws-explicit" });
  });

  it("fails on an invalid port instead of silently falling back (G4)", () => {
    expect(() => runtimeConfigFromEnv({ RUNTIME_PORT: "not-a-port" })).toThrow(
      /RUNTIME_PORT is not a valid port/,
    );
    expect(() => runtimeConfigFromEnv({ RUNTIME_PORT: "99999" })).toThrow(
      /RUNTIME_PORT is not a valid port/,
    );
  });

  it("accepts loopback RUNTIME_HOST values without any opt-in (C-6)", () => {
    expect(runtimeConfigFromEnv({ RUNTIME_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
    expect(runtimeConfigFromEnv({ RUNTIME_HOST: "localhost" }).host).toBe("localhost");
    expect(runtimeConfigFromEnv({ RUNTIME_HOST: "127.9.9.9" }).host).toBe("127.9.9.9");
    expect(runtimeConfigFromEnv({ RUNTIME_HOST: "::1" }).host).toBe("::1");
  });

  it("refuses a non-loopback RUNTIME_HOST unless RUNTIME_ALLOW_NON_LOOPBACK_BIND=1 (G4, C-6)", () => {
    expect(() => runtimeConfigFromEnv({ RUNTIME_HOST: "0.0.0.0" })).toThrow(
      /RUNTIME_ALLOW_NON_LOOPBACK_BIND/,
    );
    expect(() => runtimeConfigFromEnv({ RUNTIME_HOST: "192.168.1.10" })).toThrow(
      /RUNTIME_ALLOW_NON_LOOPBACK_BIND/,
    );
    const optedIn = runtimeConfigFromEnv({
      RUNTIME_HOST: "0.0.0.0",
      RUNTIME_ALLOW_NON_LOOPBACK_BIND: "1",
    });
    expect(optedIn.host).toBe("0.0.0.0");
  });

  it("binds a non-loopback host end-to-end only when the environment opt-in is set (C-6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-runtime-node-"));
    tempDirs.push(dir);

    // Without the opt-in in process.env, startRuntimeNode refuses before any
    // socket is opened or the database file is created.
    await expect(
      startRuntimeNode({ host: "0.0.0.0", port: 0, dbPath: join(dir, "refused.db") }),
    ).rejects.toThrow(/RUNTIME_ALLOW_NON_LOOPBACK_BIND/);
    expect(existsSync(join(dir, "refused.db"))).toBe(false);

    // With the opt-in, the node binds and serves (reachability on loopback).
    process.env["RUNTIME_ALLOW_NON_LOOPBACK_BIND"] = "1";
    try {
      const node = await startRuntimeNode({
        host: "0.0.0.0",
        port: 0,
        dbPath: join(dir, "bound.db"),
      });
      expect(node.host).toBe("0.0.0.0");
      const health = await fetch(`http://127.0.0.1:${node.port}/internal/v1/health`);
      expect(health.status).toBe(200);
      await node.stop();
    } finally {
      delete process.env["RUNTIME_ALLOW_NON_LOOPBACK_BIND"];
    }
  });
});

/**
 * S12 chunk 4 — the supervisor policy env knobs, parsed in the SAME config
 * seam as the harness command. Programmatic constants (DEFAULT_SESSION_POLICY)
 * stay the defaults; the knobs exist so test-scale hibernation timings are
 * demonstrable in the browser and deployments can tune honestly. Garbage is a
 * typed failure at startup (G4), never a silent fallback.
 */
describe("session supervisor policy env knobs (S12 chunk 4)", () => {
  it("defaults to an empty policy partial — the programmatic constants apply", () => {
    expect(runtimeConfigFromEnv({}).sessionPolicy).toEqual({});
  });

  it("parses the four policy knobs into the supervisor's policy keys", () => {
    expect(
      runtimeConfigFromEnv({
        SHERA_SESSION_IDLE_HIBERNATE_MS: "15000",
        SHERA_SESSION_HEARTBEAT_INTERVAL_MS: "1000",
        SHERA_SESSION_MISSED_HEARTBEAT_LIMIT: "2",
        SHERA_SESSION_HANDSHAKE_TIMEOUT_MS: "4000",
      }).sessionPolicy,
    ).toEqual({
      idleHibernateMs: 15_000,
      heartbeatIntervalMs: 1_000,
      missedHeartbeatLimit: 2,
      handshakeTimeoutMs: 4_000,
    });
  });

  it("keeps unset knobs out of the partial — only explicit keys are overridden", () => {
    expect(
      runtimeConfigFromEnv({ SHERA_SESSION_IDLE_HIBERNATE_MS: "15000" }).sessionPolicy,
    ).toEqual({ idleHibernateMs: 15_000 });
  });

  it("accepts the documented sane range edges", () => {
    expect(
      runtimeConfigFromEnv({
        SHERA_SESSION_IDLE_HIBERNATE_MS: "1000",
        SHERA_SESSION_HEARTBEAT_INTERVAL_MS: "250",
        SHERA_SESSION_MISSED_HEARTBEAT_LIMIT: "1",
        SHERA_SESSION_HANDSHAKE_TIMEOUT_MS: "1000",
      }).sessionPolicy,
    ).toEqual({
      idleHibernateMs: 1000,
      heartbeatIntervalMs: 250,
      missedHeartbeatLimit: 1,
      handshakeTimeoutMs: 1000,
    });
  });

  it.each([
    ["SHERA_SESSION_IDLE_HIBERNATE_MS", "soon"],
    ["SHERA_SESSION_IDLE_HIBERNATE_MS", "500"], // below the 1s floor
    ["SHERA_SESSION_IDLE_HIBERNATE_MS", "0"],
    ["SHERA_SESSION_IDLE_HIBERNATE_MS", "-5"],
    ["SHERA_SESSION_IDLE_HIBERNATE_MS", "1.5"],
    ["SHERA_SESSION_HEARTBEAT_INTERVAL_MS", "0"],
    ["SHERA_SESSION_MISSED_HEARTBEAT_LIMIT", "0"],
    ["SHERA_SESSION_MISSED_HEARTBEAT_LIMIT", "2.5"],
    ["SHERA_SESSION_HANDSHAKE_TIMEOUT_MS", "abc"],
  ])("fails typed on garbage %s=%s instead of silently falling back (G4)", (name, value) => {
    expect(() => runtimeConfigFromEnv({ [name]: value })).toThrow(new RegExp(name));
  });

  it("an explicit programmatic sessionPolicy wins over the environment", () => {
    expect(
      runtimeConfigFromEnv(
        { SHERA_SESSION_IDLE_HIBERNATE_MS: "15000" },
        { sessionPolicy: { idleHibernateMs: 9000 } },
      ).sessionPolicy,
    ).toEqual({ idleHibernateMs: 9000 });
  });
});
