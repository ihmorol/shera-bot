/**
 * S18 chunk 2 — the shared browser profile service contract (issue #19; PRD
 * §4.3, §6, §16, §19 AC19, D6, D22, D27, G3/G4/G6). Red-first: these tests pin
 * the chunk behaviors before the service module exists.
 *
 * The service owns ONE shared Chromium profile per user container
 * (launchPersistentContext into a container-local profile dir):
 *
 *   1. Lifecycle: start on demand, idle timeout closes it, a crash is
 *      detectable and a subsequent demand restarts cleanly.
 *   2. The live read-only view: the ACTUAL current page — URL, title, and a
 *      real screenshot — round-trips through the service. Never a placeholder
 *      (G4): a stopped/crashed browser answers its true state, no image.
 *   3. Cookie/profile persistence across service instances on the same
 *      profile dir (AC19 partial evidence).
 *   4. D6 single-owner control: the Agent's browser driver owns the session;
 *      a second control claim is refused with a typed error and the first
 *      owner keeps working. The read-only viewer never controls anything.
 *   5. D27 capability posture: browser operations are capability-based and
 *      allowed for research; capability-less or non-research access is
 *      refused with a typed error. The service opens NO inbound socket.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupTempResources, makeTempDir } from "../../../test/helpers/temp-resources.ts";
import { BrowserService, BrowserServiceError } from "./browser.service.ts";

/** The only capability posture this service admits (D27; asserted below). */
const RESEARCH = { kind: "browser-research" } as const;

const openServices: BrowserService[] = [];
const openServers: Server[] = [];

afterEach(async () => {
  for (const service of openServices.splice(0).reverse()) {
    await service.dispose("shutdown").catch(() => {});
  }
  for (const server of openServers.splice(0).reverse()) {
    server.closeAllConnections();
    server.close();
  }
  await cleanupTempResources();
});

function makeService(overrides: { idleTimeoutMs?: number } = {}): BrowserService {
  const service = new BrowserService({
    profileDir: makeTempDir("shera-s18-browser-profile-"),
    idleTimeoutMs: overrides.idleTimeoutMs ?? 120_000,
  });
  openServices.push(service);
  return service;
}

/** One loopback HTTP server on 127.0.0.1 (localhost, never external). */
async function startLoopbackServer(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  const server = createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.unref();
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

/** Poll a read until it satisfies the predicate (bounded, for async lifecycle). */
async function pollUntil<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  budgetMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = read();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(BrowserServiceError);
  return (error as BrowserServiceError).code;
}

// ---------------------------------------------------------------------------
// 1. Lifecycle: start on demand / idle close / crash detect + clean restart
// ---------------------------------------------------------------------------

describe("S18 browser service — lifecycle (start on demand, idle, crash)", () => {
  it("answers the honest stopped state before any demand — no fabricated view (G4)", async () => {
    const service = makeService();

    const state = service.stateReadout("ws-local-default");
    expect(state.lifecycle_state).toBe("stopped");
    expect(state.owner).toBeNull();

    const view = await service.snapshotView("ws-local-default");
    expect(view.state).toBe("stopped");
    expect("url" in view).toBe(false);
    expect("screenshot_base64" in view).toBe(false);
  });

  it("starts the shared Chromium profile on demand and reports running", async () => {
    const service = makeService();

    await service.ensureStarted({ capability: RESEARCH });
    const state = service.stateReadout("ws-local-default");
    expect(state.lifecycle_state).toBe("running");
    expect(state.inbound_listen).toBe("none");

    // A second on-demand start reuses the same incarnation (no relaunch).
    await service.ensureStarted({ capability: RESEARCH });
    expect(service.stateReadout("ws-local-default").lifecycle_state).toBe("running");
  });

  it("closes the browser after the configurable idle timeout", async () => {
    const service = makeService({ idleTimeoutMs: 250 });

    await service.ensureStarted({ capability: RESEARCH });
    expect(service.stateReadout("ws-local-default").lifecycle_state).toBe("running");

    const finalState = await pollUntil(
      () => service.stateReadout("ws-local-default"),
      (state) => state.lifecycle_state === "stopped",
    );
    expect(finalState.lifecycle_state).toBe("stopped");

    // And a fresh demand starts cleanly again after the idle close.
    await service.ensureStarted({ capability: RESEARCH });
    expect(service.stateReadout("ws-local-default").lifecycle_state).toBe("running");
  });

  it("detects a crashed browser and a subsequent demand restarts cleanly", async () => {
    const service = makeService();
    await service.ensureStarted({ capability: RESEARCH });

    // Simulate the browser process dying WITHOUT the service closing it: the
    // driver-level CDP Browser.close terminates the process outside the
    // service's own close path (exactly the crash posture it must detect).
    const context = await service.requireContext({ capability: RESEARCH });
    const browser = context.browser();
    expect(browser).not.toBeNull();
    const cdp = await browser!.newBrowserCDPSession();
    await cdp.send("Browser.close");

    const crashed = await pollUntil(
      () => service.stateReadout("ws-local-default"),
      (state) => state.lifecycle_state === "crashed",
    );
    expect(crashed.lifecycle_state).toBe("crashed");

    // The view answers the true crashed state — never a placeholder image.
    const view = await service.snapshotView("ws-local-default");
    expect(view.state).toBe("crashed");
    expect("screenshot_base64" in view).toBe(false);

    // A subsequent demand restarts cleanly on the SAME profile dir.
    await service.ensureStarted({ capability: RESEARCH });
    expect(service.stateReadout("ws-local-default").lifecycle_state).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// 2. The live read-only view: the ACTUAL current page round-trips
// ---------------------------------------------------------------------------

describe("S18 browser service — live read-only view", () => {
  it("round-trips the actual current page: URL, title, and a real screenshot", async () => {
    const origin = await startLoopbackServer((req, res) => {
      if ((req.url ?? "").startsWith("/target")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<html><head><title>S18 Panel Target Page</title></head><body><h1>shera-live-view-proof</h1></body></html>",
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>First Page</title></head><body>start</body></html>");
    });

    const service = makeService();
    const grant = await service.claimControl({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
    });
    expect(grant.owner_id).toBe("driver-a");

    // The driver navigates; the view then shows THE page that is actually open.
    await service.navigateTo({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
      url: `${origin}/first`,
    });
    await service.navigateTo({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
      url: `${origin}/target`,
    });

    const view = await service.snapshotView("ws-local-default");
    expect(view.state).toBe("running");
    if (view.state !== "running") {
      throw new Error("unreachable");
    }
    expect(view.url).toBe(`${origin}/target`);
    expect(view.title).toBe("S18 Panel Target Page");
    expect(view.screenshot_format).toBe("jpeg");
    expect(view.screenshot_base64.length).toBeGreaterThan(100);

    // The screenshot is a real JPEG image, not a placeholder payload.
    const bytes = Buffer.from(view.screenshot_base64, "base64");
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes[2]).toBe(0xff);
  });
});

// ---------------------------------------------------------------------------
// 3. Cookie/profile persistence across restart (AC19 partial evidence)
// ---------------------------------------------------------------------------

describe("S18 browser service — cookie persistence across service instances (AC19)", () => {
  it("keeps the session cookie when a NEW service instance opens the SAME profile dir", async () => {
    const COOKIE_VALUE = "shera-e2e-session-9f8b7c6d5e4a";
    const origin = await startLoopbackServer((req, res) => {
      if ((req.url ?? "").startsWith("/login")) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // Max-Age makes this a PERSISTENT cookie: Chromium (correctly) keeps
          // session cookies (no expiry) in memory only, so the profile-
          // persistence evidence needs a cookie with a lifetime.
          "set-cookie": `shera_session=${COOKIE_VALUE}; Path=/; Max-Age=86400`,
        });
        res.end("<html><head><title>login-done</title></head><body></body></html>");
        return;
      }
      if ((req.url ?? "").startsWith("/session")) {
        const cookies = req.headers.cookie ?? "";
        const carried = cookies.includes(`shera_session=${COOKIE_VALUE}`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<html><head><title>${carried ? "session-ok" : "session-missing"}</title></head><body></body></html>`,
        );
        return;
      }
      res.writeHead(404).end();
    });

    // The profile dir is the custody store (D22) — one shared dir, two
    // service incarnations, sequential like a container restart.
    const profileDir = mkdtempSync(join(tmpdir(), "shera-s18-browser-persist-"));

    const first = new BrowserService({ profileDir, idleTimeoutMs: 120_000 });
    openServices.push(first);
    await first.claimControl({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
    });
    await first.navigateTo({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
      url: `${origin}/login`,
    });
    await first.dispose("shutdown");

    const second = new BrowserService({ profileDir, idleTimeoutMs: 120_000 });
    openServices.push(second);
    await second.claimControl({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
    });
    const result = await second.navigateTo({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
      url: `${origin}/session`,
    });

    // The NEW incarnation carries the session: the persistent profile
    // preserved the cookie across the stop/start (AC19, browser profile leg).
    expect(result.title).toBe("session-ok");
    await second.dispose("shutdown");
  });
});

// ---------------------------------------------------------------------------
// 4. D6 single-owner conflict control
// ---------------------------------------------------------------------------

describe("S18 browser service — single-owner conflict control (D6)", () => {
  it("refuses a second control claim with a typed error and the first owner keeps working", async () => {
    const origin = await startLoopbackServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Owner Page</title></head><body></body></html>");
    });

    const service = makeService();
    await service.claimControl({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
    });

    // A second claimant is refused by construction — typed, never silent (G5).
    try {
      await service.claimControl({
        workspace_id: "ws-local-default",
        owner_id: "driver-b",
        capability: RESEARCH,
      });
      throw new Error("the second claim should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CONTROL_CONFLICT");
    }

    // The FIRST owner is untouched and keeps working.
    expect(service.stateReadout("ws-local-default").owner?.owner_id).toBe("driver-a");
    const navigation = await service.navigateTo({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
      url: `${origin}/owned`,
    });
    expect(navigation.title).toBe("Owner Page");

    // The refused claimant also cannot drive or release the session.
    try {
      await service.navigateTo({
        workspace_id: "ws-local-default",
        owner_id: "driver-b",
        capability: RESEARCH,
        url: `${origin}/hijack`,
      });
      throw new Error("the non-owner navigation should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CONTROL_REQUIRED");
    }
    try {
      await service.releaseControl({ workspace_id: "ws-local-default", owner_id: "driver-b" });
      throw new Error("the non-owner release should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CONTROL_REQUIRED");
    }

    // The viewer's read-only snapshot never disturbs the owner's control.
    const view = await service.snapshotView("ws-local-default");
    expect(view.state).toBe("running");
    expect(service.stateReadout("ws-local-default").owner?.owner_id).toBe("driver-a");
  });

  it("lets the owner release and a new owner claim afterwards", async () => {
    const service = makeService();
    await service.claimControl({
      workspace_id: "ws-local-default",
      owner_id: "driver-a",
      capability: RESEARCH,
    });
    await service.releaseControl({ workspace_id: "ws-local-default", owner_id: "driver-a" });
    expect(service.stateReadout("ws-local-default").owner).toBeNull();

    await service.claimControl({
      workspace_id: "ws-local-default",
      owner_id: "driver-b",
      capability: RESEARCH,
    });
    expect(service.stateReadout("ws-local-default").owner?.owner_id).toBe("driver-b");
  });
});

// ---------------------------------------------------------------------------
// 5. D27 capability posture and isolation
// ---------------------------------------------------------------------------

describe("S18 browser service — capability posture (D27)", () => {
  it("refuses capability-less browser operations with a typed error", async () => {
    const service = makeService();

    try {
      await service.ensureStarted({ capability: undefined });
      throw new Error("capability-less start should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CAPABILITY_REFUSED");
    }
    try {
      await service.claimControl({
        workspace_id: "ws-local-default",
        owner_id: "driver-a",
        capability: undefined,
      });
      throw new Error("capability-less claim should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CAPABILITY_REFUSED");
    }
    try {
      await service.requireContext({ capability: undefined });
      throw new Error("capability-less context access should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CAPABILITY_REFUSED");
    }

    // Nothing was ever launched by the refused operations.
    expect(service.stateReadout("ws-local-default").lifecycle_state).toBe("stopped");
  });

  it("refuses non-research capability kinds — the browser is not a code-execution channel", async () => {
    const service = makeService();

    try {
      await service.ensureStarted({ capability: { kind: "code-execution" } });
      throw new Error("code-execution start should have been refused");
    } catch (error) {
      expect(errorCode(error)).toBe("BROWSER_CAPABILITY_REFUSED");
    }
    expect(service.stateReadout("ws-local-default").lifecycle_state).toBe("stopped");
  });

  it("opens no inbound socket and keeps the profile container-local", async () => {
    const profileDir = makeTempDir("shera-s18-browser-profile-");
    const service = new BrowserService({ profileDir, idleTimeoutMs: 120_000 });
    openServices.push(service);

    const state = service.stateReadout("ws-local-default");
    // D27: the prototype is container-local; the browser service binds
    // nothing. The only HTTP surface is the runtime's own loopback API
    // (asserted at the transport level), and the browser process itself is
    // driven over a local pipe, not a listening port.
    expect(state.inbound_listen).toBe("none");
    expect(state.profile_dir).toBe(profileDir);
  });
});
