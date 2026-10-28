import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserTabState,
  fetchBrowserState,
  fetchBrowserView,
  fetchTerminalEvents,
  fetchTerminalState,
  type BrowserStatePayload,
  type BrowserViewPayload,
} from "../lib/live-views-api";
import {
  INITIAL_TERMINAL_STATE,
  applyTerminalStreamEvent,
  terminalStreamIdFor,
  type TerminalStreamEvent,
} from "../lib/terminal-live";
import { workspaceTabFromParam } from "../lib/workspace-panel";

/**
 * S18 chunk 3 — the live-views client and the terminal stream reducer
 * (issue #19; UI_DESIGN §4 S7 Terminal/Browser tabs, §6.2 event honesty,
 * G4/G6). The client reads the chunk-1/2 GET routes through the same-origin
 * runtime proxy exactly like the S17 workspace client; the reducer folds the
 * `terminal.started/output/exited` journal envelopes into per-execution view
 * state. The WS hook wiring is exercised by the real-browser pass; these
 * suites pin the pure logic and the wire shapes.
 */

const WORKSPACE = "workspace_demo";
const AGENT = "agent_researcher";

function envelope(
  overrides: Partial<TerminalStreamEvent> & {
    type: string;
    payload: Record<string, unknown>;
  },
): TerminalStreamEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    sequence: 1,
    occurred_at: "2026-10-29T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Client — the five GET routes through /api/runtime
// ---------------------------------------------------------------------------

describe("live-views client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the terminal replay page with cursor paging", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        `/api/runtime/v1/terminals/events?workspace_id=${WORKSPACE}&agent_id=${AGENT}&after_sequence=7&limit=50`,
      );
      return new Response(
        JSON.stringify({
          events: [
            {
              event_id: "evt_1",
              sequence: 8,
              type: "terminal.output",
              occurred_at: "2026-10-29T10:00:00.000Z",
              payload: { workspace_id: WORKSPACE, agent_id: AGENT, text: "ok" },
            },
          ],
          next_after_sequence: 8,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchTerminalEvents(WORKSPACE, AGENT, { afterSequence: 7, limit: 50 });
    expect(page.nextAfterSequence).toBe(8);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.type).toBe("terminal.output");
    expect(page.events[0]?.payload["text"]).toBe("ok");
  });

  it("fetches one Agent's terminal state (latest + recent)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        `/api/runtime/v1/terminals/state?workspace_id=${WORKSPACE}&agent_id=${AGENT}`,
      );
      return new Response(
        JSON.stringify({
          agent_id: AGENT,
          current: {
            workspace_id: WORKSPACE,
            terminal_id: "term_1",
            agent_id: AGENT,
            session_id: "sess_1",
            command: "pytest -q",
            workdir: "/workspace",
            resource_policy: { heartbeat_interval_ms: 15000 },
            approval_state: "not_required",
            state: "running",
            started_at: "2026-10-29T10:00:00.000Z",
            exited_at: null,
            exit_code: null,
            exit_signal: null,
            output: [],
          },
          recent: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await fetchTerminalState(WORKSPACE, AGENT);
    expect(state.agentId).toBe(AGENT);
    expect(state.current?.command).toBe("pytest -q");
    expect(state.current?.approvalState).toBe("not_required");
  });

  it("parses both browser state arms (unconfigured + configured readout)", async () => {
    const unconfigured: unknown = { configured: false, workspace_id: WORKSPACE };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(unconfigured), { status: 200 })),
    );
    expect(await fetchBrowserState(WORKSPACE)).toMatchObject({ configured: false });

    const configured: BrowserStatePayload = {
      configured: true,
      workspace_id: WORKSPACE,
      lifecycle_state: "running",
      owner: {
        workspace_id: WORKSPACE,
        owner_id: "agent_researcher",
        claimed_at: "2026-10-29T10:00:00.000Z",
      },
      idle_timeout_ms: 120000,
      inbound_listen: "none",
      profile_dir: "/container/.shera/browser-profile",
      required_capability: "browser-research",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(configured), { status: 200 })),
    );
    const state = await fetchBrowserState(WORKSPACE);
    expect(state.configured).toBe(true);
    if (state.configured) {
      expect(state.lifecycle_state).toBe("running");
      expect(state.owner?.owner_id).toBe("agent_researcher");
      expect(state.inbound_listen).toBe("none");
    }
  });

  it("parses both browser view arms (running page + honest no-image state)", async () => {
    const running: BrowserViewPayload = {
      configured: true,
      workspace_id: WORKSPACE,
      state: "running",
      url: "https://example.com/research",
      title: "Research page",
      screenshot_base64: "anEtatWFyZXR1cm5lZA==",
      screenshot_format: "jpeg",
      captured_at: "2026-10-29T10:00:01.000Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(running), { status: 200 })),
    );
    const view = await fetchBrowserView(WORKSPACE);
    expect("state" in view && view.state).toBe("running");
    if ("state" in view && view.state === "running") {
      expect(view.screenshot_base64).not.toBe("");
      expect(view.url).toContain("https://");
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              configured: true,
              workspace_id: WORKSPACE,
              state: "stopped",
              captured_at: "2026-10-29T10:00:02.000Z",
            }),
            { status: 200 },
          ),
      ),
    );
    const stopped = await fetchBrowserView(WORKSPACE);
    expect("state" in stopped && stopped.state).toBe("stopped");
    expect("url" in stopped).toBe(false);
    expect("screenshot_base64" in stopped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// browserTabState — folding the two reads into the panel's state union
// ---------------------------------------------------------------------------

describe("browserTabState mapping", () => {
  it("answers unconfigured when the runtime has no browser service", () => {
    expect(
      browserTabState(
        { configured: false, workspace_id: WORKSPACE },
        { configured: false, workspace_id: WORKSPACE },
      ),
    ).toEqual({ kind: "unconfigured" });
  });

  it("answers live with the ACTUAL page when the browser is running", () => {
    const tab = browserTabState(
      {
        configured: true,
        workspace_id: WORKSPACE,
        state: "running",
        url: "https://example.com/",
        title: "Example",
        screenshot_base64: "img==",
        screenshot_format: "jpeg",
        captured_at: "2026-10-29T10:00:01.000Z",
      },
      {
        configured: true,
        workspace_id: WORKSPACE,
        lifecycle_state: "running",
        owner: null,
        idle_timeout_ms: 120000,
        inbound_listen: "none",
        profile_dir: "/p",
        required_capability: "browser-research",
      },
    );
    expect(tab).toMatchObject({
      kind: "live",
      url: "https://example.com/",
      title: "Example",
      screenshotBase64: "img==",
    });
  });

  it("answers idle/starting/crashed with the true lifecycle and NO image", () => {
    for (const lifecycle of ["stopped", "starting", "crashed"] as const) {
      const tab = browserTabState(
        {
          configured: true,
          workspace_id: WORKSPACE,
          state: lifecycle,
          captured_at: "2026-10-29T10:00:01.000Z",
        },
        {
          configured: true,
          workspace_id: WORKSPACE,
          lifecycle_state: lifecycle,
          owner: null,
          idle_timeout_ms: 120000,
          inbound_listen: "none",
          profile_dir: "/p",
          required_capability: "browser-research",
        },
      );
      expect(tab).toEqual({ kind: "browser-state", lifecycle });
    }
  });
});

// ---------------------------------------------------------------------------
// Terminal stream reducer — terminal.started / output / exited folding
// ---------------------------------------------------------------------------

describe("terminal stream id", () => {
  it("matches the runtime's per-Agent terminal stream convention", () => {
    expect(terminalStreamIdFor(WORKSPACE, AGENT)).toBe(`terminal:${WORKSPACE}:${AGENT}`);
  });
});

describe("applyTerminalStreamEvent", () => {
  const started = envelope({
    type: "terminal.started",
    sequence: 1,
    payload: {
      workspace_id: WORKSPACE,
      agent_id: AGENT,
      terminal_id: "term_1",
      session_id: "sess_1",
      command: "pytest -q tests/",
      workdir: "/workspace/project",
      resource_policy: { heartbeat_interval_ms: 15000, watchdog_window_ms: 45000 },
      approval_state: "not_required",
    },
  });

  it("starts a running execution with the truthful metadata (newest first)", () => {
    const state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, started);
    expect(state.executions).toHaveLength(1);
    const execution = state.executions[0]!;
    expect(execution.terminalId).toBe("term_1");
    expect(execution.command).toBe("pytest -q tests/");
    expect(execution.workdir).toBe("/workspace/project");
    expect(execution.resourcePolicy).toEqual({
      heartbeat_interval_ms: 15000,
      watchdog_window_ms: 45000,
    });
    expect(execution.approvalState).toBe("not_required");
    expect(execution.status).toBe("running");
    expect(execution.chunks).toEqual([]);
    expect(state.cursor).toBe(1);
  });

  it("appends output chunks to their execution in journal order", () => {
    let state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, started);
    state = applyTerminalStreamEvent(state, {
      ...started,
      sequence: 2,
      type: "terminal.output",
      payload: {
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        terminal_id: "term_1",
        stream: "stderr",
        text: "warning: deprecated",
      },
    });
    state = applyTerminalStreamEvent(state, {
      ...started,
      sequence: 3,
      type: "terminal.output",
      payload: {
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        terminal_id: "term_1",
        stream: "stdout",
        text: "3 passed",
      },
    });
    const execution = state.executions[0]!;
    expect(execution.chunks).toEqual([
      { stream: "stderr", text: "warning: deprecated" },
      { stream: "stdout", text: "3 passed" },
    ]);
    expect(execution.status).toBe("running");
  });

  it("closes the execution on exit with code, signal, and time", () => {
    let state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, started);
    state = applyTerminalStreamEvent(state, {
      ...started,
      sequence: 2,
      type: "terminal.exited",
      occurred_at: "2026-10-29T10:01:30.000Z",
      payload: {
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        terminal_id: "term_1",
        exit_code: 0,
        exit_signal: null,
      },
    });
    const execution = state.executions[0]!;
    expect(execution.status).toBe("exited");
    expect(execution.exitCode).toBe(0);
    expect(execution.exitSignal).toBeNull();
    expect(execution.exitedAt).toBe("2026-10-29T10:01:30.000Z");
  });

  it("keeps the newest execution first as a second one starts", () => {
    let state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, started);
    state = applyTerminalStreamEvent(state, {
      ...started,
      sequence: 5,
      payload: {
        ...started.payload,
        terminal_id: "term_2",
        command: "npm test",
      },
    });
    expect(state.executions.map((execution) => execution.terminalId)).toEqual(["term_2", "term_1"]);
    expect(state.executions[1]?.status).toBe("running");
  });

  it("ignores output for an unknown terminal instead of fabricating a record (G4)", () => {
    const state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, {
      ...started,
      type: "terminal.output",
      payload: {
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        terminal_id: "term_unknown",
        stream: "stdout",
        text: "orphan",
      },
    });
    expect(state.executions).toHaveLength(0);
  });

  it("absorbs duplicate deliveries below the cursor (exactly-once, D26)", () => {
    let state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, started);
    state = applyTerminalStreamEvent(state, { ...started, sequence: 1 });
    expect(state.executions).toHaveLength(1);
  });

  it("ignores non-terminal journal types on the stream", () => {
    const state = applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, {
      ...started,
      type: "message.appended",
      payload: { text: "unrelated" },
    });
    expect(state.executions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deep-link tab validation (F3): terminal and browser join the panel tabs
// ---------------------------------------------------------------------------

describe("workspace tab deep links", () => {
  it("accepts the terminal and browser tabs", () => {
    expect(workspaceTabFromParam("terminal")).toBe("terminal");
    expect(workspaceTabFromParam("browser")).toBe("browser");
  });

  it("still lands unknown params on Files", () => {
    expect(workspaceTabFromParam("takeover")).toBe("files");
    expect(workspaceTabFromParam(undefined)).toBe("files");
  });
});
