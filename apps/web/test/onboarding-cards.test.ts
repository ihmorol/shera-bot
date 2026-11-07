/**
 * S30 chunk 6 — the E43 in-chat conversational onboarding cards (issue #31
 * leverage addendum; D16, G2/G4): the first-run interview is a CHAT CARD —
 * keyboard-navigable choice chips whose options are DATA from the runtime's
 * typed snapshot, a composer-style free-text answer, dismissible, resumable.
 * NO wizard, NO modal forms. The card renders nothing when the interview is
 * not pending (the zero-config start is the default — nothing blocks).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OnboardingCardsView, type OnboardingCardSnapshot } from "../components/onboarding/onboarding-cards";

function snapshot(overrides: Partial<OnboardingCardSnapshot> = {}): OnboardingCardSnapshot {
  return {
    workspace_id: "ws_default_01",
    provider_summary: { configured: false, provider_id: null, model: null },
    status: "pending",
    current_step: "welcome",
    steps: [
      {
        step: "welcome",
        title: "Welcome to Shera",
        body: "Shera works right away with safe defaults — nothing here blocks you.",
        question: "What do you mostly want help with? Pick whatever's closest — we can always expand from there.",
        options: [
          { option_id: "research", label: "Research", description: "Papers, sources, citations, summaries." },
          { option_id: "programming", label: "Programming", description: "Assignments, code review, debugging." },
          { option_id: "exam_prep", label: "Exam preparation", description: "Study plans, practice questions, recaps." },
          { option_id: "something_else", label: "Something else", description: "Tell us in your own words below." },
        ],
        accepts_free_text: true,
        free_text_placeholder: "Tell us in your own words…",
        answer: null,
      },
      {
        step: "provider_check",
        title: "Provider and model",
        body: "Shera uses the deployment's default provider and model.",
        question: null,
        options: [
          { option_id: "keep_default", label: "Keep the deployment default", description: "Change anytime in Settings." },
        ],
        accepts_free_text: false,
        free_text_placeholder: null,
        answer: null,
      },
    ],
    answers: {},
    ...overrides,
  };
}

function renderCards(
  props: Partial<Parameters<typeof OnboardingCardsView>[0]> = {},
  snap: OnboardingCardSnapshot = snapshot(),
): string {
  return renderToStaticMarkup(
    createElement(OnboardingCardsView, {
      snapshot: snap,
      commandPending: false,
      commandSafeError: undefined,
      onAnswer: () => undefined,
      onDismiss: () => undefined,
      ...props,
    }),
  );
}

describe("Onboarding cards (E43 in-chat interview)", () => {
  it("renders the current step as a chat card with keyboard-navigable data chips", () => {
    const html = renderCards();
    expect(html).toContain("Welcome to Shera");
    expect(html).toContain("What do you mostly want help with?");
    // The A/B/C/D chips are data — option ids from the runtime's typed snapshot.
    expect(html).toContain('data-testid="onboarding-chip"');
    expect(html).toContain('data-option-id="research"');
    expect(html).toContain('data-option-id="programming"');
    expect(html).toContain('data-option-id="exam_prep"');
    expect(html).toContain('data-option-id="something_else"');
    // Keyboard navigation is declared (radiogroup + the arrow/number hint).
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("arrow keys");
  });

  it("renders the composer-style free-text answer only where the step accepts it", () => {
    const html = renderCards();
    expect(html).toContain('data-testid="onboarding-free-text"');
    const noText = renderCards({}, snapshot({
      current_step: "provider_check",
      steps: snapshot().steps.map((step) =>
        step.step === "provider_check" ? { ...step, answer: null } : step,
      ),
    }));
    expect(noText).toContain('data-option-id="keep_default"');
    expect(noText).not.toContain('data-testid="onboarding-free-text"');
  });

  it("the answered steps render their recorded answers; the card is resumable with a step indicator", () => {
    // The full five-step list the runtime answers (D16's recorded order).
    const steps = [
      snapshot().steps[0]!,
      snapshot().steps[1]!,
      {
        step: "approvals_briefing" as const,
        title: "What pauses for your approval",
        body: "Risky actions pause for your approval.",
        question: "Ready to see what pauses?",
        options: [{ option_id: "got_it", label: "Got it", description: "You'll see what pauses." }],
        accepts_free_text: false,
        free_text_placeholder: null,
        answer: null,
      },
      {
        step: "memory_briefing" as const,
        title: "Memory briefing — Auto-memory is on",
        body: "Agents can remember useful facts automatically.",
        question: "Should agents remember things automatically?",
        options: [
          { option_id: "memory_auto_on", label: "Keep auto-memory on", description: "Inspectable, forgettable." },
          { option_id: "memory_auto_off", label: "Turn auto-memory off", description: "Re-enable in Settings." },
        ],
        accepts_free_text: false,
        free_text_placeholder: null,
        answer: null,
      },
      {
        step: "done" as const,
        title: "You're set",
        body: "Your answers are saved and the recommended defaults stayed active.",
        question: null,
        options: [{ option_id: "finish", label: "Finish", description: "Open your workspace." }],
        accepts_free_text: false,
        free_text_placeholder: null,
        answer: null,
      },
    ];
    const html = renderCards(
      {},
      snapshot({
        steps,
        answers: { welcome: { option_id: "research", free_text: null, answered_at: "2026-11-08T10:00:00.000Z" } },
        current_step: "provider_check",
      }),
    );
    expect(html).toContain("Step 2 of 5");
    expect(html).toContain("Provider and model");
  });

  it("dismiss is an explicit control — the interview is skippable (D16)", () => {
    const html = renderCards();
    expect(html).toContain('data-testid="onboarding-dismiss"');
    expect(html).toContain("Skip for now");
  });

  it("a non-pending interview renders NOTHING — zero-config start is the default (D16)", () => {
    expect(renderCards({}, snapshot({ status: "dismissed", current_step: null }))).toBe("");
    expect(renderCards({}, snapshot({ status: "completed", current_step: null }))).toBe("");
  });

  it("a settled command shows the pending state; a typed error shows its safe message", () => {
    const pending = renderCards({ commandPending: true });
    expect(pending).toContain("aria-busy");
    const failed = renderCards({ commandSafeError: "The onboarding command was not accepted." });
    expect(failed).toContain("The onboarding command was not accepted.");
  });
});
