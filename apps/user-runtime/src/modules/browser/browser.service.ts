/**
 * The shared browser profile service (S18 chunk 2; issue #19; PRD §4.3, §6,
 * §14, §16, §19 AC19/AC21, D6, D11, D22, D27, G2/G3/G4/G6).
 *
 * ---------------------------------------------------------------------------
 * What this service is
 *
 * ONE shared Chromium profile per user container (PRD §6: the container holds
 * "one shared browser profile"). The profile lives in a container-local
 * directory and is opened through Playwright's `launchPersistentContext`, so
 * cookies and session state survive the service — and the runtime — restarting
 * (AC19: "restart recovery restores ... browser profile"; the browser profile
 * directory is the custody store, D22). The Agent's browser driver works
 * through this service; the user's workspace panel reads it.
 *
 * Lifecycle: the browser STARTS ON DEMAND — only when a driver with the
 * research capability asks for browser work (G4: nothing spawns without
 * configuration and demand). An idle timeout closes it (configurable; a clean
 * idle close reports `stopped`). A browser death the service did not request
 * is detected (the context's close event outside our own dispose) and reports
 * `crashed`; the next demand restarts cleanly on the SAME profile dir — the
 * persistent context is relaunched, never faked.
 *
 * ---------------------------------------------------------------------------
 * The read-only view and the control boundary (D6, PRD §4.3, §20)
 *
 * The user's panel gets `snapshotView`: the ACTUAL current page — its URL,
 * its title, and a fresh screenshot — captured on demand. There is no
 * placeholder image and no fabricated state (G4): a stopped/starting/crashed
 * browser answers its true state with no image at all. The view carries NO
 * control: it cannot navigate, click, or type, and it never starts or stops
 * the browser — a viewer only reads. Control is D6 single-owner: the Agent's
 * browser driver claims control once (`claimControl`); a SECOND control claim
 * is refused with the typed BROWSER_CONTROL_CONFLICT and the first owner is
 * untouched (G5: never silently resolve a recorded conflict). Navigation and
 * raw context access are owner-only operations at this seam.
 *
 * The HTTP surface (s18-live-views-api.ts) exposes ONLY the two GET reads;
 * no control route exists — the no-takeover criterion is the route inventory
 * itself, exactly like the terminal surface in chunk 1. Everything control-
 * shaped lives at THIS seam for the Agent's driver, which is runtime code,
 * not the API.
 *
 * ---------------------------------------------------------------------------
 * Capability and isolation posture (D27, G6)
 *
 * Browser operations are capability-based and admitted ONLY for the research
 * posture (`kind: "browser-research"`): the browser is a research tool, NOT a
 * general network bypass for code execution — a capability-less call, or a
 * call carrying any other capability kind, is refused with the typed
 * BROWSER_CAPABILITY_REFUSED before anything launches. The service opens NO
 * inbound socket of its own (the Chromium process is driven over a local
 * pipe, not a listening port); the only HTTP surface is the runtime's own
 * loopback-bound local API. The prototype runs everything container-local
 * (D27); stronger isolation remains the runtime backend's concern.
 *
 * WHAT REMAINS FOR S26 (recorded, not silently dropped): the real capability
 * manifest check (per-Agent/per-task grants from the pack), approval-gated
 * external writes performed IN the browser, restricted-child-process
 * enforcement for browser-spawned work, and the network policy layer. This
 * chunk encodes the posture and the typed refusals; S26 owns the full
 * enforcement machinery.
 *
 * ---------------------------------------------------------------------------
 * G3 redaction
 *
 * Cookie and credential VALUES never enter API payloads, events, journal
 * rows, logs, or the runtime database. The structured view fields (url,
 * title) pass through the chunk-1 secret-redaction layer before leaving the
 * service (a credential embedded in a URL or title collapses to [REDACTED]);
 * screenshots are served as captured and are never persisted anywhere by
 * this module; the fault sink receives event names and owner ids only. The
 * browser profile directory is the ONLY place session state is kept (D22).
 *
 * This module RECORDS and SERVES browser state; it never classifies proposal
 * text and never executes Agent proposals itself (G2: the driver proposes
 * navigations through this seam; the runtime-owned service validates the
 * capability and the ownership before acting).
 */
import { chromium, type BrowserContext, type Page } from "playwright";

import { redactSecrets } from "../terminals/secret-redaction.ts";

// ---------------------------------------------------------------------------
// Typed vocabulary
// ---------------------------------------------------------------------------

/** The capability kinds this seam's signature admits; only research runs. */
export type BrowserCapability = { readonly kind: "browser-research" | "code-execution" };

/** The one capability posture admitted by every browser operation (D27). */
export const BROWSER_REQUIRED_CAPABILITY_KIND = "browser-research" as const;

export type BrowserLifecycleState = "stopped" | "starting" | "running" | "crashed";

/** D6: the one control grant. One owner at a time, per browser session. */
export interface BrowserControlGrant {
  workspace_id: string;
  owner_id: string;
  claimed_at: string;
}

/** The state route's readout: the honest lifecycle + ownership + posture. */
export interface BrowserStateReadout {
  workspace_id: string;
  lifecycle_state: BrowserLifecycleState;
  owner: BrowserControlGrant | null;
  idle_timeout_ms: number;
  /**
   * D27, reported: the browser service opens NO inbound socket. The Chromium
   * process is driven over a local pipe; the only HTTP surface is the
   * runtime's loopback-bound local API.
   */
  inbound_listen: "none";
  /** The container-local profile directory (the D22 custody store). */
  profile_dir: string;
  /** The capability posture every browser operation must carry. */
  required_capability: typeof BROWSER_REQUIRED_CAPABILITY_KIND;
}

/**
 * The view route's readout: a discriminated union on the true lifecycle. The
 * running arm carries the ACTUAL current page; every other arm carries NO
 * image and NO url — a stopped or crashed browser never renders a placeholder
 * (G4).
 */
export type BrowserViewReadout =
  | {
      workspace_id: string;
      state: Exclude<BrowserLifecycleState, "running">;
      captured_at: string;
    }
  | {
      workspace_id: string;
      state: "running";
      /** The open page's URL (secret-bearing fragments redacted, G3). */
      url: string;
      /** The open page's title (redacted, G3). */
      title: string;
      /** A fresh screenshot of the open page, base64 JPEG. */
      screenshot_base64: string;
      screenshot_format: "jpeg";
      captured_at: string;
    };

export type BrowserServiceErrorCode =
  | "BROWSER_CAPABILITY_REFUSED"
  | "BROWSER_CONTROL_CONFLICT"
  | "BROWSER_CONTROL_REQUIRED"
  | "BROWSER_VIEW_UNAVAILABLE"
  | "BROWSER_START_FAILED";

/** The browser boundary's typed error (stable codes; no internals echoed). */
export class BrowserServiceError extends Error {
  constructor(
    readonly code: BrowserServiceErrorCode,
    readonly category: "policy" | "conflict" | "state",
    message: string,
  ) {
    super(message);
    this.name = "BrowserServiceError";
  }
}

/** The redacted operator-fault sink shape (the transport's RedactedLogger). */
export type BrowserFaultLog = (event: string, fields: Record<string, unknown>) => void;

export interface BrowserServiceDeps {
  /** The container-local shared profile directory (the D22 custody store). */
  profileDir: string;
  /** Idle ms before the browser is closed cleanly. Default 120000 (2 min). */
  idleTimeoutMs?: number;
  /** Contained operator-fault sink (call sites own the redaction discipline). */
  logFault?: BrowserFaultLog | undefined;
  /** Injectable clock for ownership stamps and view captures; default wall. */
  now?: (() => string) | undefined;
}

/** The live-view thumbnail format (small payloads over the loopback API). */
const SCREENSHOT_FORMAT = "jpeg" as const;
const SCREENSHOT_QUALITY = 70;

export class BrowserService {
  private context: BrowserContext | null = null;
  private lifecycle: BrowserLifecycleState = "stopped";
  private owner: BrowserControlGrant | null = null;
  private currentPage: Page | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;
  /** True while THIS service is closing the context (crash detection flag). */
  private expectedClose = false;

  constructor(private readonly deps: BrowserServiceDeps) {}

  // -------------------------------------------------------------------------

  /** The state readout: honest lifecycle, ownership, and D27 posture. */
  stateReadout(workspaceId: string): BrowserStateReadout {
    return {
      workspace_id: workspaceId,
      lifecycle_state: this.lifecycle,
      owner: this.owner,
      idle_timeout_ms: this.idleTimeoutMs,
      inbound_listen: "none",
      profile_dir: this.deps.profileDir,
      required_capability: BROWSER_REQUIRED_CAPABILITY_KIND,
    };
  }

  /**
   * The read-only live view: the ACTUAL current page (url, title, fresh
   * screenshot) when the browser is running; the true lifecycle state with NO
   * image otherwise. A viewer poll counts as activity for the idle timeout —
   * a watched browser is not idle.
   */
  async snapshotView(workspaceId: string): Promise<BrowserViewReadout> {
    this.touchIdle();
    const capturedAt = this.now();

    const state = this.lifecycle;
    const context = this.context;
    if (state !== "running" || context === null) {
      // Honest state, no placeholder (G4). A "running" read with a vanished
      // context (only observable mid-teardown) reports the truth — the
      // browser is gone.
      const reported: Exclude<BrowserLifecycleState, "running"> =
        state === "running" ? "crashed" : state;
      return { workspace_id: workspaceId, state: reported, captured_at: capturedAt };
    }

    const page = this.activePage();
    if (page === undefined) {
      // A running context with no open page cannot honestly be captured.
      throw new BrowserServiceError(
        "BROWSER_VIEW_UNAVAILABLE",
        "state",
        "the running browser has no open page to capture",
      );
    }
    try {
      const rawUrl = page.url();
      const rawTitle = await page.title();
      const shot = await page.screenshot({ type: SCREENSHOT_FORMAT, quality: SCREENSHOT_QUALITY });
      return {
        workspace_id: workspaceId,
        state: "running",
        // G3: the structured fields cross the redaction boundary — a
        // credential embedded in the URL or title never leaves the service.
        url: redactSecrets(rawUrl),
        title: redactSecrets(rawTitle),
        screenshot_base64: shot.toString("base64"),
        screenshot_format: SCREENSHOT_FORMAT,
        captured_at: capturedAt,
      };
    } catch (error) {
      const stateAfter = this.lifecycle;
      if (stateAfter !== "running" || this.context === null) {
        // The browser died mid-capture; the close handler owns the state.
        const reported: Exclude<BrowserLifecycleState, "running"> =
          stateAfter === "running" ? "crashed" : stateAfter;
        return { workspace_id: workspaceId, state: reported, captured_at: capturedAt };
      }
      throw new BrowserServiceError(
        "BROWSER_VIEW_UNAVAILABLE",
        "state",
        `the live view capture failed: ${error instanceof Error ? error.name : "Error"}`,
      );
    }
  }

  // -- the control boundary (D6) ---------------------------------------------

  /**
   * Claim browser control. The FIRST claimant owns the session; a second,
   * different claimant is refused with the typed BROWSER_CONTROL_CONFLICT and
   * the first owner is untouched (D6, G5). A re-assert by the SAME owner is
   * idempotent (a restarting driver re-claims its own session). Refused for
   * any caller without the research capability (D27).
   */
  claimControl(input: {
    workspace_id: string;
    owner_id: string;
    capability: BrowserCapability | undefined;
  }): BrowserControlGrant {
    this.assertCapability(input.capability);
    if (this.owner && this.owner.owner_id !== input.owner_id) {
      throw new BrowserServiceError(
        "BROWSER_CONTROL_CONFLICT",
        "conflict",
        `browser control is already held by another owner (${this.owner.owner_id})`,
      );
    }
    if (this.owner) {
      return this.owner; // same-owner re-assert
    }
    this.owner = {
      workspace_id: input.workspace_id,
      owner_id: input.owner_id,
      claimed_at: this.now(),
    };
    this.touchIdle();
    return this.owner;
  }

  /** Release control. Only the current owner can release (D6). */
  releaseControl(input: { workspace_id: string; owner_id: string }): void {
    if (this.owner === null || this.owner.owner_id !== input.owner_id) {
      throw new BrowserServiceError(
        "BROWSER_CONTROL_REQUIRED",
        "policy",
        "only the current control owner can release the browser session",
      );
    }
    this.owner = null;
  }

  /**
   * Navigate the browser (the Agent's driver seam — never an HTTP route).
   * Requires the research capability AND current control ownership; starts
   * the browser on demand when it is stopped or crashed.
   */
  async navigateTo(input: {
    workspace_id: string;
    owner_id: string;
    capability: BrowserCapability | undefined;
    url: string;
  }): Promise<{ url: string; title: string }> {
    this.assertCapability(input.capability);
    if (this.owner === null || this.owner.owner_id !== input.owner_id) {
      throw new BrowserServiceError(
        "BROWSER_CONTROL_REQUIRED",
        "policy",
        "browser navigation requires the current control owner",
      );
    }
    await this.ensureStarted({ capability: input.capability });
    const context = this.requireContextInternal();
    const page = await this.resolveDriverPage(context);
    await page.goto(input.url);
    this.currentPage = page;
    this.touchIdle();
    // G3: the same redaction boundary as the view readout.
    return { url: redactSecrets(page.url()), title: redactSecrets(await page.title()) };
  }

  /**
   * The driver's raw-context seam: browser work beyond navigation (the
   * driver's own Playwright power). NEVER reached by the HTTP surface. Also
   * the seam the tests use to exercise browser death from outside the
   * service. Requires the research capability; starts on demand.
   */
  async requireContext(input: {
    capability: BrowserCapability | undefined;
  }): Promise<BrowserContext> {
    this.assertCapability(input.capability);
    await this.ensureStarted({ capability: input.capability });
    return this.requireContextInternal();
  }

  /**
   * Start the shared browser on demand: fresh launch when stopped, clean
   * relaunch on the SAME profile dir after a crash, and a no-op reuse when
   * already running (concurrent demands share one launch promise).
   */
  async ensureStarted(input: { capability: BrowserCapability | undefined }): Promise<{
    lifecycle_state: "running";
  }> {
    this.assertCapability(input.capability);
    if (this.lifecycle === "running" && this.context !== null) {
      this.touchIdle();
      return { lifecycle_state: "running" };
    }
    if (this.startPromise !== null) {
      await this.startPromise;
      return { lifecycle_state: "running" };
    }
    this.startPromise = this.launch().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
    return { lifecycle_state: "running" };
  }

  /**
   * Close the browser. `idle` is the timer's clean close; `shutdown` is the
   * composition's teardown. Both are EXPECTED closes — a close event outside
   * this method is how a crash is detected.
   */
  async dispose(reason: "idle" | "shutdown"): Promise<void> {
    this.clearIdleTimer();
    if (this.context === null) {
      this.lifecycle = this.lifecycle === "crashed" ? "crashed" : "stopped";
      return;
    }
    this.expectedClose = true;
    try {
      await this.context.close();
      this.deps.logFault?.("browser_closed", { reason, owner_id: this.owner?.owner_id ?? null });
    } catch (error) {
      this.deps.logFault?.("browser_close_failed", {
        reason,
        name: error instanceof Error ? error.name : "Error",
      });
    } finally {
      this.context = null;
      this.currentPage = null;
      this.lifecycle = "stopped";
    }
  }

  // -- internals --------------------------------------------------------------

  private async launch(): Promise<void> {
    const wasCrashed = this.lifecycle === "crashed";
    this.lifecycle = "starting";
    try {
      const context = await chromium.launchPersistentContext(this.deps.profileDir, {
        headless: true,
      });
      this.context = context;
      this.currentPage = null;
      this.lifecycle = "running";
      // Crash detection: a close THIS service did not request is a crash. The
      // expectedClose flag is set only by dispose() and reset HERE when the
      // close event arrives, so a LATER unexpected death is still detected.
      context.on("close", () => {
        this.context = null;
        this.currentPage = null;
        this.clearIdleTimer();
        if (this.expectedClose) {
          this.expectedClose = false;
          this.lifecycle = "stopped";
          return;
        }
        this.lifecycle = "crashed";
        this.deps.logFault?.("browser_crashed", {
          owner_id: this.owner?.owner_id ?? null,
          restartable: true,
        });
      });
      this.touchIdle();
      this.deps.logFault?.("browser_started", {
        owner_id: this.owner?.owner_id ?? null,
        ...(wasCrashed ? { after_crash: true } : {}),
      });
    } catch (error) {
      this.lifecycle = wasCrashed ? "crashed" : "stopped";
      this.deps.logFault?.("browser_launch_failed", {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw new BrowserServiceError(
        "BROWSER_START_FAILED",
        "state",
        "the shared browser could not be started on the container-local profile",
      );
    }
  }

  private requireContextInternal(): BrowserContext {
    if (this.context === null || this.lifecycle !== "running") {
      throw new BrowserServiceError(
        "BROWSER_START_FAILED",
        "state",
        "the shared browser is not running",
      );
    }
    return this.context;
  }

  /** The page the driver last navigated, else the context's newest page. */
  private activePage(): Page | undefined {
    const pages = this.context?.pages() ?? [];
    if (this.currentPage && pages.includes(this.currentPage)) {
      return this.currentPage;
    }
    return pages[pages.length - 1];
  }

  /** The driver works on its current page, or a fresh one when none fits. */
  private async resolveDriverPage(context: BrowserContext): Promise<Page> {
    const page = this.activePage();
    if (page !== undefined) {
      return page;
    }
    return context.newPage();
  }

  private assertCapability(capability: BrowserCapability | undefined): void {
    // D27: capability-based, research-only. The browser is NOT a general
    // network bypass for code execution — any other capability kind (and a
    // missing capability) is refused before anything launches. S26 owns the
    // full per-task capability-manifest enforcement behind this check.
    if (capability?.kind !== BROWSER_REQUIRED_CAPABILITY_KIND) {
      throw new BrowserServiceError(
        "BROWSER_CAPABILITY_REFUSED",
        "policy",
        "browser operations require the browser-research capability",
      );
    }
  }

  private touchIdle(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.dispose("idle").catch(() => {});
    }, this.idleTimeoutMs);
    // Never hold the process open for an idle timer.
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private get idleTimeoutMs(): number {
    return this.deps.idleTimeoutMs ?? 120_000;
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }
}
