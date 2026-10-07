/**
 * Agent-to-agent communication surface (D7 `CollaborationMessage`, G2).
 *
 * The typed collaboration protocol has existed in `packages/contracts/src/
 * collaboration.ts` since S02: eleven message types (`TaskProposed`,
 * `TaskDelegated`, `QuestionRaised`, `HandoffRequested`, `TaskBlocked`, …) with
 * mandatory `sender_agent` / `recipient_agent` / `goal_or_summary`. Nothing in
 * the UI rendered any of it. In a multi-Agent product whose whole point is
 * watching Agents collaborate, the user could see Agents talk to *them* and
 * never saw Agents talk to *each other*.
 *
 * Pinned here: the handoff is legible (who → who); the type comes from the
 * closed enum and is never inferred from prose (G2); a proposal never renders as
 * finished work (G2/G4); an unknown Agent degrades instead of crashing; and the
 * surface announces both Agents (§2.3).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  COLLABORATION_MESSAGE_TYPES,
  CollaborationMessage,
  type CollaborationMessageType,
} from "@shera-bot/contracts";

import {
  COLLABORATION_LABELS,
  describeCollaboration,
  renderCollaborationSummary,
} from "../lib/collaboration";

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

/** A valid collaboration message; overrides are merged over the required fields. */
function message(overrides: Partial<CollaborationMessage> = {}): CollaborationMessage {
  return CollaborationMessage.parse({
    workspace_id: "ws-11111111-1111-4111-8111-111111111111",
    task_id: "task_run_research_paper",
    parent_task_id: null,
    conversation_id: "conversation_research_paper",
    sender_agent: "agent_general_assistant",
    recipient_agent: "agent_researcher",
    message_type: "TaskDelegated",
    goal_or_summary:
      "Find five peer-reviewed sources on spaced repetition for the methods section.",
    artifact_refs: [],
    required_capabilities: [],
    risk_class: "READ_ONLY",
    status: "proposed",
    confidence: null,
    unresolved_questions: [],
    created_at: "2026-09-20T10:12:00Z",
    idempotency_key: "collab-key-1",
    ...overrides,
  });
}

describe("D7 typed collaboration messages", () => {
  it("gives every protocol message type a human label", () => {
    // A type added to the contract without a label would render as raw
    // "SomeNewType", so this fails loudly at the contract boundary.
    for (const type of COLLABORATION_MESSAGE_TYPES) {
      expect(COLLABORATION_LABELS[type], `label for ${type}`).toBeTruthy();
      expect(COLLABORATION_LABELS[type]).not.toBe(type);
    }
    expect(Object.keys(COLLABORATION_LABELS).sort()).toEqual(
      [...COLLABORATION_MESSAGE_TYPES].sort(),
    );
  });

  it("describes a delegation as sender → recipient", () => {
    const described = describeCollaboration(message());
    expect(described.kind).toBe("delegation");
    expect(described.from).toBe("agent_general_assistant");
    expect(described.to).toBe("agent_researcher");
  });

  it("treats a null recipient as a broadcast, not a broken record", () => {
    const described = describeCollaboration(message({ recipient_agent: null }));
    expect(described.kind).toBe("broadcast");
    expect(described.from).toBe("agent_general_assistant");
  });

  it("marks a proposed delegation as NOT completed (G2/G4)", () => {
    // The most dangerous failure here: rendering a proposal as finished work.
    const html = render(
      createElement(renderCollaborationSummary, { message: message({ status: "proposed" }) }),
    );
    expect(html.toLowerCase()).not.toContain("completed");
    expect(html.toLowerCase()).not.toContain("done");
  });

  it("reflects a completed status distinctly from a proposal", () => {
    const proposed = render(
      createElement(renderCollaborationSummary, { message: message({ status: "proposed" }) }),
    );
    const completed = render(
      createElement(renderCollaborationSummary, { message: message({ status: "completed" }) }),
    );
    expect(proposed).not.toBe(completed);
  });

  it("keeps typed fidelity: the type is never inferred from the summary", () => {
    // G2/D7: the label comes from the closed enum, so prose can never change how
    // a message is classified.
    //
    // The first version of this test compared two full renderings with different
    // summaries and expected them EQUAL — which can only pass because the prose is
    // ignored, i.e. it asserts the very thing it should forbid, and a real
    // regression would still sail through. This version asserts the inverse
    // precisely: the summaries render differently, the typed framing does not.
    const headerOf = (html: string) => html.slice(0, html.indexOf("Delegated work"));
    const questionSummary = message({ goal_or_summary: "Can you check this?" });
    const statementSummary = message({ goal_or_summary: "Sources collected and indexed." });

    // The prose IS rendered (so the two differ)...
    expect(
      render(createElement(renderCollaborationSummary, { message: questionSummary })),
    ).not.toBe(render(createElement(renderCollaborationSummary, { message: statementSummary })));
    // ...but everything before it — type, icon, sender, recipient, status — is
    // identical, which is only true if classification ignores the prose.
    expect(
      headerOf(render(createElement(renderCollaborationSummary, { message: questionSummary }))),
    ).toBe(
      headerOf(render(createElement(renderCollaborationSummary, { message: statementSummary }))),
    );
    // And a summary that reads like a different protocol type does not relabel it.
    expect(
      render(
        createElement(renderCollaborationSummary, {
          message: message({ goal_or_summary: "I am blocked." }),
        }),
      ),
    ).toContain("Delegated work");
  });

  it("renders every protocol message type without throwing", () => {
    for (const messageType of COLLABORATION_MESSAGE_TYPES) {
      const html = render(
        createElement(renderCollaborationSummary, {
          message: message({ message_type: messageType as CollaborationMessageType }),
        }),
      );
      expect(html.length, `renders ${messageType}`).toBeGreaterThan(0);
      expect(html).toContain("General Assistant");
    }
  });

  it("renders an unknown Agent id gracefully instead of crashing", () => {
    const html = render(
      createElement(renderCollaborationSummary, {
        message: message({ sender_agent: "agent_from_a_future_pack" }),
      }),
    );
    expect(html).toContain("agent_from_a_future_pack");
  });

  it("announces both Agents so a screen reader conveys the handoff", () => {
    const html = render(createElement(renderCollaborationSummary, { message: message() }));
    expect(html).toContain("General Assistant");
    expect(html).toContain("Researcher");
  });

  it("carries no raw color literals (token layer, §2.1)", () => {
    const html = render(createElement(renderCollaborationSummary, { message: message() }));
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\brgba?\(/);
    expect(html).not.toMatch(/\bhsla?\(/);
  });

  it("keeps the handoff readable by assistive tech", () => {
    const html = render(createElement(renderCollaborationSummary, { message: message() }));
    // The row itself must be announced: it carries the only account of who is
    // talking to whom. (Decorative ICONS inside it do carry aria-hidden — that is
    // correct, so this asserts on the row's own opening tag, not the subtree.)
    const rowTag = html.slice(0, html.indexOf(">") + 1);
    expect(rowTag).toContain('data-collaboration-message=""');
    expect(rowTag).not.toContain("aria-hidden");
    // The separator icon between sender and recipient is decorative.
    expect(html).toContain("aria-hidden");
  });
});
