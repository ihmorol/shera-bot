import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageList } from "../components/chat/message-list";
import { ArtifactCard, ReplayBoundary, RunCard, ToolCallCard } from "../components/chat/cards";
import { Composer } from "../components/chat/composer";
import { EmptyThread, ThreadSkeleton } from "../components/chat/thread-states";
import { ErrorState } from "../components/shell/states";
import {
  EVENT_GA_WEB_SEARCH,
  EVENT_TUTOR_APPROVAL,
  FIXTURE_ARTIFACTS,
  RUNS,
  buildThread,
  ChatMessage,
} from "../lib/fixtures";
import type { ThreadItem } from "../lib/fixtures";
import { insertDaySeparators, withSentMessages, type TimelineItem } from "../lib/thread-layout";

/**
 * Component tests for the S3 chat surfaces (rendered to static markup — the
 * suite runs in the node environment, so no DOM). Covers PRD §21.5 sender
 * attribution, §S3 day separators and jump-to-unread, the §6.2 replayed
 * marker, the §2.4 state language, and the G2 honesty of the inline cards.
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

function messageItem(message: ChatMessage): ThreadItem {
  return { kind: "message", at: message.sent_at, message };
}

function makeMessage(overrides: Partial<ChatMessage> & { message_id: string }): ChatMessage {
  return ChatMessage.parse({
    conversation_id: "conversation_agent_general_assistant",
    sender: { kind: "user", display_name: "Emon" },
    text: "test message",
    sent_at: "2026-09-30T09:00:00Z",
    ...overrides,
  });
}

const GA_TIMELINE: TimelineItem[] = insertDaySeparators(
  buildThread("conversation_agent_general_assistant"),
);
const RESEARCHER_TIMELINE: TimelineItem[] = insertDaySeparators(
  buildThread("conversation_agent_researcher"),
);

describe("sender attribution (PRD §21.5)", () => {
  it("renders Agent messages with avatar + name + role", () => {
    const html = render(
      createElement(MessageList, { items: GA_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(html).toContain("General Assistant");
    expect(html).toContain("Default coordinator of every Operation");
  });

  it("renders user messages right-aligned with a status tick", () => {
    const html = render(
      createElement(MessageList, { items: GA_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(html).toContain("Sent");
    expect(html).toContain('aria-label="Conversation messages"');
  });

  it("shows sending / failed ticks with retry for user bubbles", () => {
    const items = [
      messageItem(makeMessage({ message_id: "msg_t1", delivery: "sending" })),
      messageItem(makeMessage({ message_id: "msg_t2", delivery: "failed" })),
    ];
    const html = render(
      createElement(MessageList, {
        items: insertDaySeparators(items),
        jumpTargetId: null,
        unreadCount: 0,
        onRetry: () => undefined,
      }),
    );
    expect(html).toContain("Sending…");
    expect(html).toContain("Failed");
    expect(html).toContain("Retry");
  });
});

describe("day separators (§S3 scrollback)", () => {
  it("inserts a separator wherever the calendar day changes", () => {
    const html = render(
      createElement(MessageList, { items: GA_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(html).toContain("September 19, 2026");
    expect(html).toContain("September 20, 2026");
  });
});

describe("replayed-batch honesty (§6.2)", () => {
  it("renders the exact boundary marker copy after the replayed batch", () => {
    const html = render(
      createElement(MessageList, { items: GA_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(html).toContain("3 missed events replayed");
  });

  it("marks replayed rows with a subtle left border — never silently live", () => {
    const html = render(
      createElement(MessageList, { items: GA_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    const replayedRows = html.match(/border-l-2 border-line-accent/g) ?? [];
    expect(replayedRows).toHaveLength(3);
  });

  it("exposes the boundary as a note for assistive tech", () => {
    const html = render(createElement(ReplayBoundary, { count: 7 }));
    expect(html).toContain('aria-label="7 missed events replayed"');
    expect(html).toContain("7 missed events replayed");
  });
});

describe("inline cards (G2 honest placeholders)", () => {
  it("renders a read-only tool proposal as pending, never executed", () => {
    const html = render(
      createElement(ToolCallCard, { event: EVENT_GA_WEB_SEARCH, status: "proposed" }),
    );
    expect(html).toContain("Web search");
    expect(html).toContain("1.4.0");
    expect(html).toContain("READ_ONLY");
    expect(html).toContain("Proposed · awaiting runtime validation");
    expect(html).not.toMatch(/ran automatically/i);
    expect(html).not.toContain("succeeded");
  });

  it("renders an external write as pausing for approval without decision buttons", () => {
    const html = render(
      createElement(ToolCallCard, {
        event: EVENT_TUTOR_APPROVAL,
        status: "pausing_for_approval",
      }),
    );
    expect(html).toContain("Pausing for your approval");
    expect(html).toContain("EXTERNAL_WRITE");
    // The five-choice dialog belongs to the approvals surface (S8) — the
    // card never offers decisions, and nothing here claims a grant (D9).
    expect(html).not.toContain("Approve this execution only");
    expect(html).not.toContain("Always approve");
  });

  it("renders artifact cards with provenance and a disabled download", () => {
    const html = render(createElement(ArtifactCard, { artifact: FIXTURE_ARTIFACTS[0]! }));
    expect(html).toContain("sources-digest.md");
    expect(html).toContain("9 KB");
    expect(html).toContain("produced by Researcher");
    expect(html).toContain("from run res_digest");
    expect(html).toContain("disabled");
    expect(html).toContain("In the demo workspace only");
  });

  it("renders run cards with the D8 state vocabulary", () => {
    const run = RUNS.find((candidate) => candidate.task_id === "task_run_ga_summary")!;
    const html = render(createElement(RunCard, { run }));
    expect(html).toContain("Task run ga_summary");
    expect(html).toContain("RUNNING");
  });

  it("renders pause reasons and retry counts as data", () => {
    const paused = RUNS.find((candidate) => candidate.state === "PAUSED")!;
    const html = render(createElement(RunCard, { run: paused }));
    expect(html).toContain("Paused · insufficient credits");
    const retrying = RUNS.find((candidate) => candidate.state === "RETRYING")!;
    expect(render(createElement(RunCard, { run: retrying }))).toContain("retries: 2 of 3");
  });
});

describe("jump-to-unread (§S3)", () => {
  it("offers the jump pill on the anchored message", () => {
    const thread = buildThread("conversation_agent_general_assistant");
    const anchorId = thread
      .filter((item) => item.kind === "message")
      .at(-2)!.message.message_id;
    const html = render(
      createElement(MessageList, {
        items: withSentMessages(thread, []),
        jumpTargetId: anchorId,
        unreadCount: 2,
      }),
    );
    expect(html).toContain("Jump to unread · 2 new");
  });

  it("renders no pill when everything is read", () => {
    const html = render(
      createElement(MessageList, { items: RESEARCHER_TIMELINE, jumpTargetId: null, unreadCount: 0 }),
    );
    expect(html).not.toContain("Jump to unread");
  });
});

describe("§2.4 state language", () => {
  it("thread loading state is a layout-matched skeleton without spinners", () => {
    const html = render(createElement(ThreadSkeleton));
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("<svg");
  });

  it("thread empty state greets with the §S3 copy", () => {
    const html = render(createElement(EmptyThread, { agentName: "Researcher" }));
    expect(html).toContain("Say hello — Researcher is ready.");
  });

  it("error state carries the safe_message only, retry only when retryable", () => {
    const retryable = render(
      createElement(ErrorState, {
        safeMessage: "This conversation could not be loaded.",
        onRetry: () => undefined,
      }),
    );
    expect(retryable).toContain('role="alert"');
    expect(retryable).toContain("This conversation could not be loaded.");
    expect(retryable).toContain("Retry");
    // Internal details never render (D23 rule 4).
    expect(retryable).not.toMatch(/stack|exception|error:/i);

    const terminal = render(
      createElement(ErrorState, { safeMessage: "Something went wrong." }),
    );
    expect(terminal).toContain("Something went wrong.");
    expect(terminal).not.toContain("Retry");
  });
});

describe("composer (§S3)", () => {
  it("renders the input with hint copy for the idle state", () => {
    const html = render(
      createElement(Composer, { agentName: "Researcher", onSend: () => undefined }),
    );
    expect(html).toContain('aria-label="Message Researcher"');
    expect(html).toContain("Enter to send · Shift+Enter for a new line");
  });

  it("renders the disabled state with the explanatory reason (D17)", () => {
    const html = render(
      createElement(Composer, {
        agentName: "Researcher",
        onSend: () => undefined,
        disabled: true,
        disabledReason: "No provider is configured for this conversation yet.",
      }),
    );
    expect(html).toContain("No provider is configured for this conversation yet.");
    expect(html).toContain("disabled");
  });
});
