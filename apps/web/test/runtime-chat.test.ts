import { createElement, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentChatView } from "../components/chat/agent-chat-view";
import { gaSurfaceMode } from "../components/chat/general-assistant-surface";
import { agentById, buildThread, conversationForAgent } from "../lib/fixtures";
import type { ContainerResolutionState } from "../lib/container-resolution";
import { threadItemsFromEvents } from "../lib/runtime-thread";

/**
 * The real conversation surface (S09 chunk 1) — G4 guarantees rendered:
 * runtime mode never fabricates an assistant message (the fixture demo stream
 * never runs on real rows), the composer is a clear no-provider configuration
 * state, and no fixture-derived presence or unread state leaks onto real data.
 */

const render = (element: ReactElement): string =>
  // S21: the chat surfaces' tool cards read the runtime tool history
  // through TanStack Query — every tree renders under a fresh provider.
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, element));

const AGENT = agentById("agent_general_assistant")!;
const CONVERSATION = conversationForAgent("agent_general_assistant")!;

const REAL_SYSTEM_THREAD = threadItemsFromEvents([
  {
    event_id: "evt-1",
    stream_id: "conversation:conv-1",
    sequence: 1,
    type: "conversation.created",
    schema_version: 1,
    payload: {
      conversation_id: "conv-1",
      workspace_id: "ws_account-1",
      title: "General Assistant",
    },
    workspace_id: "ws_account-1",
    occurred_at: "2026-09-30T10:00:00Z",
    correlation_id: "corr-1",
  },
]);

function runtimeView(overrides: Record<string, unknown> = {}): string {
  return render(
    createElement(AgentChatView, {
      agent: AGENT,
      conversation: { ...CONVERSATION, unread_count: 0 },
      thread: REAL_SYSTEM_THREAD,
      mode: "runtime",
      ...overrides,
    }) as ReactElement,
  );
}

describe("runtime mode composer (G4 / D17)", () => {
  it("the composer is disabled with the no-provider explanation", () => {
    const html = runtimeView();
    expect(html).toContain("No provider is configured for this conversation yet.");
    expect(html).toContain("disabled");
    // The demo send affordance is gone: no idle-send hint on a real surface.
    expect(html).not.toContain("Enter to send");
  });

  it("no fabricated assistant message is ever produced", () => {
    const html = runtimeView();
    // The §6.1 demo stream text (fixture assistant copy) must never appear on
    // real rows, and no streaming slot renders.
    expect(html).not.toContain("spaced repetition outperforms massed practice");
    expect(html).not.toContain("Stop");
    // The thread carries only the real journal record.
    expect(html).toContain("This conversation started in your workspace");
    expect(html).not.toContain("Here is a three-pass plan");
  });

  it("no fixture-derived presence or unread state leaks onto real data", () => {
    const html = runtimeView();
    // The demo presence pill would claim "session active" from run fixtures.
    expect(html).not.toContain("session active");
    expect(html).not.toContain("Jump to unread");
  });

  it("demo mode keeps the S08 behavior unchanged", () => {
    const demo = render(
      createElement(AgentChatView, {
        agent: AGENT,
        conversation: CONVERSATION,
        thread: buildThread(CONVERSATION.conversation_id),
      }) as ReactElement,
    );
    expect(demo).toContain("Enter to send");
    expect(demo).toContain("session active");
  });
});

describe("real thread rendering", () => {
  it("the real journal record renders as a system row", () => {
    const html = runtimeView();
    expect(html).toContain("This conversation started in your workspace as “General Assistant”.");
  });

  it("a real-data failure is the §2.4 error state with the safe message", () => {
    const html = runtimeView({
      surfaceState: "error",
      safeErrorMessage: "The connection to Shera failed. You can try again.",
    });
    expect(html).toContain("The connection to Shera failed. You can try again.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("This conversation started");
  });
});

describe("surface mode choice (honest fallback rule)", () => {
  it("only a READY container switches the General Assistant chat to real rows", () => {
    const ready: ContainerResolutionState = {
      kind: "ready",
      workspace_id: "ws_account-1",
      runtime: {
        runtime_handle: `rt_${"a".repeat(32)}`,
        provisioning_status: "running",
        health: "healthy",
        resource_summary: {
          tier: "balanced",
          cpu_vcpus: 2,
          memory_bytes: 4 * 1024 ** 3,
          storage_bytes: 25 * 1024 ** 3,
        },
      },
    };
    expect(gaSurfaceMode(ready)).toBe("runtime");
    for (const state of [
      { kind: "resolving", workspace_id: null },
      { kind: "unauthenticated" },
      { kind: "not_provisioned", workspace_id: "ws_account-1" },
      { kind: "preparing", workspace_id: "ws_account-1" },
      { kind: "provisioning", workspace_id: "ws_account-1" },
      { kind: "stopped", workspace_id: "ws_account-1" },
      {
        kind: "failed",
        workspace_id: "ws_account-1",
        error: {
          code: "RUNTIME_PROVISION_FAILED",
          category: "resource",
          safe_message: "failed",
          retryable: true,
          user_action: null,
          internal_details: null,
          correlation_id: "corr-1",
        },
      },
    ] satisfies ContainerResolutionState[]) {
      expect(gaSurfaceMode(state)).toBe("demo");
    }
    expect(gaSurfaceMode(undefined)).toBe("demo");
  });
});
