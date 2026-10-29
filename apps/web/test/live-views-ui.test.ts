import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { BrowserTabView } from "../components/workspace/browser-tab";
import { TerminalTabView, type TerminalTabViewProps } from "../components/workspace/terminal-tab";
import { WorkspacePanelBody } from "../components/workspace/workspace-panel";
import { WORKSPACE_TABS } from "../components/workspace/panel-tabs";
import type { BrowserTabState } from "../lib/live-views-api";
import {
  INITIAL_TERMINAL_STATE,
  applyTerminalStreamEvent,
  type TerminalExecutionView,
} from "../lib/terminal-live";

/**
 * S18 chunk 3 — the terminal and browser live-view panels (issue #19,
 * UI_DESIGN §4 S7; G4 honest states, G6 read-only). The suites follow the
 * apps/web test convention: node-environment static markup for the view
 * components, and the panel body rendered through the real tab wiring.
 *
 * The READ-ONLY rule is asserted on the markup itself: no input, textarea,
 * form, or editable region may exist in either panel — the only control a
 * live-view panel ever offers is a read retry.
 */

const WORKSPACE = "workspace_demo";
const AGENT = "agent_researcher";

const render = (element: ReactElement): string => renderToStaticMarkup(element);

function makeExecution(overrides: Partial<TerminalExecutionView> = {}): TerminalExecutionView {
  return {
    terminalId: "term_1",
    sessionId: null,
    command: "pytest -q tests/",
    workdir: "/workspace/project",
    resourcePolicy: { heartbeat_interval_ms: 15000, watchdog_window_ms: 45000 },
    approvalState: "not_required",
    status: "running",
    startedAt: "2026-10-29T10:00:00.000Z",
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
    chunks: [
      { stream: "stdout", text: "3 passed in 0.4s" },
      { stream: "stderr", text: "1 warning" },
    ],
    ...overrides,
  };
}

function startedExecution(): TerminalExecutionView {
  return applyTerminalStreamEvent(INITIAL_TERMINAL_STATE, {
    event_id: "evt_1",
    sequence: 1,
    type: "terminal.started",
    occurred_at: "2026-10-29T10:00:00.000Z",
    payload: {
      workspace_id: WORKSPACE,
      agent_id: AGENT,
      terminal_id: "term_1",
      session_id: null,
      command: "pytest -q tests/",
      workdir: "/workspace/project",
      resource_policy: { heartbeat_interval_ms: 15000 },
      approval_state: "not_required",
    },
  }).executions[0]!;
}

// ---------------------------------------------------------------------------
// Terminal panel
// ---------------------------------------------------------------------------

function terminalViewProps(overrides: Partial<TerminalTabViewProps> = {}): TerminalTabViewProps {
  return { phase: "live", executions: [], loading: false, error: null, ...overrides };
}

describe("terminal panel (read-only live view)", () => {
  it("shows the live marker and the read-only tag while streaming", () => {
    const markup = render(createElement(TerminalTabView, terminalViewProps()));
    expect(markup).toContain("Live");
    expect(markup).toContain("Read-only");
    expect(markup).toContain(`data-read-only="true"`);
  });

  it("renders the current execution truthfully (D35 fields, G4)", () => {
    const markup = render(
      createElement(TerminalTabView, terminalViewProps({ executions: [startedExecution()] })),
    );
    expect(markup).toContain("pytest -q tests/");
    expect(markup).toContain("/workspace/project");
    expect(markup).toContain("heartbeat_interval_ms");
    expect(markup).toContain("15000");
    expect(markup).toContain("No approval required");
    expect(markup).toContain("Running");
    expect(markup).toContain(`data-testid="terminal-command"`);
    expect(markup).toContain(`data-testid="terminal-workdir"`);
  });

  it("maps every approval state to an honest badge", () => {
    const expected: Record<string, string> = {
      not_required: "No approval required",
      pending: "Waiting for approval",
      approved: "Approved",
      rejected: "Rejected",
    };
    for (const [approvalState, label] of Object.entries(expected)) {
      const markup = render(
        createElement(
          TerminalTabView,
          terminalViewProps({
            executions: [makeExecution({ approvalState: approvalState as never })],
          }),
        ),
      );
      expect(markup, approvalState).toContain(label);
    }
  });

  it("reports an exited execution with its code and keeps the earlier one listed", () => {
    const markup = render(
      createElement(
        TerminalTabView,
        terminalViewProps({
          executions: [
            makeExecution({ status: "exited", exitCode: 0, exitedAt: "2026-10-29T10:01:00Z" }),
            makeExecution({ terminalId: "term_0", command: "npm install" }),
          ],
        }),
      ),
    );
    expect(markup).toContain("Exited");
    expect(markup).toContain("code 0");
    expect(markup).toContain("npm install");
  });

  it("teaches the empty state instead of faking activity (G4)", () => {
    const markup = render(createElement(TerminalTabView, terminalViewProps()));
    expect(markup).toContain("No terminal activity yet");
  });

  it("shows the honest states: connecting skeleton, reconnecting, offline, error", () => {
    expect(
      render(
        createElement(TerminalTabView, terminalViewProps({ phase: "connecting", loading: true })),
      ),
    ).toContain(`data-testid="terminal-skeleton"`);
    expect(
      render(createElement(TerminalTabView, terminalViewProps({ phase: "reconnecting" }))),
    ).toContain("Reconnecting");
    expect(
      render(createElement(TerminalTabView, terminalViewProps({ phase: "offline" }))),
    ).toContain("Offline");
    const errored = render(
      createElement(
        TerminalTabView,
        terminalViewProps({
          error: "The connection to Shera failed. You can try again.",
          onRetry: () => undefined,
        }),
      ),
    );
    expect(errored).toContain('role="alert"');
    expect(errored).toContain("The connection to Shera failed");
    expect(errored).toContain("Retry");
  });

  it("says what a deep-linked panel without an Agent binding can show", () => {
    const markup = render(createElement(TerminalTabView, terminalViewProps({ phase: "disabled" })));
    expect(markup).toContain("from an Agent chat");
  });

  it("never renders a terminal input path (G6)", () => {
    const markup = render(
      createElement(TerminalTabView, terminalViewProps({ executions: [startedExecution()] })),
    );
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("contenteditable");
  });
});

// ---------------------------------------------------------------------------
// Browser panel
// ---------------------------------------------------------------------------

const LIVE_TAB: BrowserTabState = {
  kind: "live",
  url: "https://example.com/research",
  title: "Research page",
  screenshotBase64: "anEtatWFyZXR1cm5lZA==",
  capturedAt: "2026-10-29T10:00:01.000Z",
};

describe("browser panel (read-only live view)", () => {
  it("renders the ACTUAL page: screenshot, URL, and title with a Live badge (G4)", () => {
    const markup = render(createElement(BrowserTabView, { state: LIVE_TAB }));
    expect(markup).toContain(`data-testid="browser-screenshot"`);
    expect(markup).toContain("data:image/jpeg;base64,anEtatWFyZXR1cm5lZA==");
    expect(markup).toContain("https://example.com/research");
    expect(markup).toContain("Research page");
    expect(markup).toContain("Live");
    expect(markup).toContain(`data-read-only="true"`);
  });

  it("answers idle, starting, and crashed with their true lifecycle and no image", () => {
    const idle = render(
      createElement(BrowserTabView, { state: { kind: "browser-state", lifecycle: "stopped" } }),
    );
    expect(idle).toContain("idle");
    expect(idle).not.toContain("<img");
    const starting = render(
      createElement(BrowserTabView, { state: { kind: "browser-state", lifecycle: "starting" } }),
    );
    expect(starting).toContain("starting");
    const crashed = render(
      createElement(BrowserTabView, { state: { kind: "browser-state", lifecycle: "crashed" } }),
    );
    expect(crashed).toContain("crashed");
    expect(crashed).not.toContain("<img");
  });

  it("answers unconfigured honestly when the runtime has no browser service", () => {
    const markup = render(createElement(BrowserTabView, { state: { kind: "unconfigured" } }));
    expect(markup).toContain("not configured");
  });

  it("renders loading and error states", () => {
    expect(render(createElement(BrowserTabView, { state: { kind: "loading" } }))).toContain(
      `data-testid="browser-skeleton"`,
    );
    const errored = render(
      createElement(BrowserTabView, {
        state: {
          kind: "error",
          message: "The browser live view is temporarily unavailable.",
          retryable: true,
        },
        onRetry: () => undefined,
      }),
    );
    expect(errored).toContain('role="alert"');
    expect(errored).toContain("temporarily unavailable");
    expect(errored).toContain("Retry");
  });

  it("never renders a navigation or takeover affordance (G6)", () => {
    for (const state of [
      LIVE_TAB,
      { kind: "browser-state", lifecycle: "stopped" } as BrowserTabState,
      { kind: "unconfigured" } as BrowserTabState,
    ]) {
      const markup = render(createElement(BrowserTabView, { state }));
      expect(markup).not.toContain("<input");
      expect(markup).not.toContain("<textarea");
      expect(markup).not.toContain("<form");
      expect(markup).not.toContain("contenteditable");
      expect(markup).not.toContain('contenteditable="true"');
    }
  });
});

// ---------------------------------------------------------------------------
// Panel wiring — the tabs join the workspace panel's tab strip
// ---------------------------------------------------------------------------

describe("workspace panel tab wiring", () => {
  it("lists Terminal and Browser in the S7 order", () => {
    expect(WORKSPACE_TABS.map((tab) => tab.id)).toEqual([
      "files",
      "editor",
      "terminal",
      "browser",
      "private",
      "artifacts",
      "tools",
    ]);
  });

  it("mounts the terminal and browser tabs through the real panel body", () => {
    const client = new QueryClient();
    const renderBody = (initialTab: "terminal" | "browser") =>
      render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(WorkspacePanelBody, { workspaceId: WORKSPACE, initialTab }),
        ),
      );
    expect(renderBody("terminal")).toContain(`data-testid="terminal-panel"`);
    expect(renderBody("browser")).toContain(`data-testid="browser-panel"`);
  });
});
