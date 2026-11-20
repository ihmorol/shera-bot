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

import {
  OnboardingCardsView,
  chipKeyAction,
  freeTextSubmitKey,
  type OnboardingCardSnapshot,
} from "../components/onboarding/onboarding-cards";

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
        question:
          "What do you mostly want help with? Pick whatever's closest — we can always expand from there.",
        options: [
          {
            option_id: "research",
            label: "Research",
            description: "Papers, sources, citations, summaries.",
          },
          {
            option_id: "programming",
            label: "Programming",
            description: "Assignments, code review, debugging.",
          },
          {
            option_id: "exam_prep",
            label: "Exam preparation",
            description: "Study plans, practice questions, recaps.",
          },
          {
            option_id: "something_else",
            label: "Something else",
            description: "Tell us in your own words below.",
          },
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
          {
            option_id: "keep_default",
            label: "Keep the deployment default",
            description: "Change anytime in Settings.",
          },
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
    const noText = renderCards(
      {},
      snapshot({
        current_step: "provider_check",
        steps: snapshot().steps.map((step) =>
          step.step === "provider_check" ? { ...step, answer: null } : step,
        ),
      }),
    );
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
          {
            option_id: "memory_auto_on",
            label: "Keep auto-memory on",
            description: "Inspectable, forgettable.",
          },
          {
            option_id: "memory_auto_off",
            label: "Turn auto-memory off",
            description: "Re-enable in Settings.",
          },
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
        answers: {
          welcome: {
            option_id: "research",
            free_text: null,
            answered_at: "2026-11-08T10:00:00.000Z",
          },
        },
        current_step: "provider_check",
      }),
    );
    expect(html).toContain("Step 2 of 5");
    expect(html).toContain("Provider and model");
  });

  it("dismiss is an explicit control — the interview is skippable (D16)", () => {
    const html = renderCards();
    expect(html).toContain('data-testid="onboarding-dismiss"');
    // D52 wave C refines the affordance to the quiet "Not now" style
    // (the pattern's dismissal vocabulary) — the control stays explicit,
    // the persistence promise stays spelled out in the footer.
    expect(html).toContain("Not now");
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

  it("the radiogroup's aria-checked mirrors the RECORDED answer, never the roving focus (a11y)", () => {
    const chipTag = (html: string, optionId: string): string =>
      html.match(new RegExp(`<button[^>]*data-option-id="${optionId}"[^>]*>`))?.[0] ?? "";

    // The recorded answer (programming, NOT the first chip) is the checked
    // radio — a screen reader announces what was answered, not where focus
    // happens to sit (the review round's P3). The fixture records it the way
    // the runtime delivers it: on the step's own answer view.
    const answeredAt = "2026-11-08T10:00:00.000Z";
    const answered = renderCards(
      {},
      snapshot({
        answers: {
          welcome: { option_id: "programming", free_text: null, answered_at: answeredAt },
        },
        steps: snapshot().steps.map((step) =>
          step.step === "welcome"
            ? {
                ...step,
                answer: { option_id: "programming", free_text: null, answered_at: answeredAt },
              }
            : step,
        ),
      }),
    );
    expect(chipTag(answered, "programming")).toContain('aria-checked="true"');
    expect(chipTag(answered, "research")).toContain('aria-checked="false"');
    expect(chipTag(answered, "exam_prep")).toContain('aria-checked="false"');

    // No answer yet: NOTHING announces checked — focus is not selection.
    const fresh = renderCards();
    expect(chipTag(fresh, "research")).toContain('aria-checked="false"');
    expect(fresh).not.toContain('aria-checked="true"');
  });
});

// ---------------------------------------------------------------------------
// D52 wave C — interview-card mechanics (the OpenMausBot §4 adoption, E43
// addendum + owner-decision-d52). Red-first for the gaps the audit found;
// the satisfied mechanics (one-tap single send, runtime-recorded dismissal
// persistence, declarative copy voice) are covered by the contracts above.
// ---------------------------------------------------------------------------

/** The opening tag of one chip (where the class and aria attributes live). */
function chipTag(html: string, optionId: string): string {
  return html.match(new RegExp(`<button[^>]*data-option-id="${optionId}"[^>]*>`))?.[0] ?? "";
}

/** The full chip element for one option (the chips carry no nested buttons). */
function chipBlock(html: string, optionId: string): string {
  return (
    html.match(new RegExp(`<button[^>]*data-option-id="${optionId}"[\\s\\S]*?</button>`))?.[0] ?? ""
  );
}

describe("D52 wave C — interview-card mechanics", () => {
  const answeredAt = "2026-11-08T10:00:00.000Z";
  const withWelcomeAnswer = (optionId: string, freeText: string | null = null) =>
    snapshot({
      steps: snapshot().steps.map((step) =>
        step.step === "welcome"
          ? { ...step, answer: { option_id: optionId, free_text: freeText, answered_at: answeredAt } }
          : step,
      ),
    });

  // Mechanic 1 — asker header. Audit: the header named nobody ("Step N of M"
  // only), and the runtime's typed snapshot carries no asker field — the
  // interview's voice is the runtime's own ("Shera", as its step copy says),
  // never a pack Agent's identity (no misattribution).
  it("the asker header names the runtime's voice — 'Shera asks' — with the asker avatar", () => {
    const html = renderCards();
    expect(html).toContain("Shera asks");
    expect(html).toContain('data-testid="onboarding-asker-avatar"');
  });

  // Mechanic 2 — chips. Audit: stacked full-width radios with roving
  // ↑/↓ existed; Home/End, the RTL-aware arrows, the 40px row floor and the
  // recorded-pick check glyph did not.
  it("choice chips are 40px-tall rows and the recorded pick carries the accent check glyph", () => {
    // A contract-legal snapshot whose CURRENT step carries its recorded
    // answer: the radiogroup renders (the a11y contract above) with the
    // pick marked — the runtime's resume edges can deliver exactly this.
    const html = renderCards({}, withWelcomeAnswer("research"));
    expect(chipTag(html, "research")).toContain("min-h-10");
    const picked = chipBlock(html, "research");
    expect(picked).toContain('data-testid="onboarding-chip-check"');
    const unpicked = chipBlock(html, "programming");
    expect(unpicked).not.toContain("onboarding-chip-check");
  });

  it("chip keyboard mechanics cover Home, End, and RTL-aware arrows (pure contract)", () => {
    // Wrap-around.
    expect(chipKeyAction("ArrowDown", 3, 4, false)).toEqual({ kind: "move", to: 0 });
    expect(chipKeyAction("ArrowUp", 0, 4, false)).toEqual({ kind: "move", to: 3 });
    // Home/End jump to the first/last row.
    expect(chipKeyAction("Home", 2, 4, false)).toEqual({ kind: "move", to: 0 });
    expect(chipKeyAction("End", 2, 4, false)).toEqual({ kind: "move", to: 3 });
    // Left/Right follow reading order: LTR forward is Right; RTL flips it.
    expect(chipKeyAction("ArrowRight", 1, 4, false)).toEqual({ kind: "move", to: 2 });
    expect(chipKeyAction("ArrowRight", 1, 4, true)).toEqual({ kind: "move", to: 0 });
    expect(chipKeyAction("ArrowLeft", 1, 4, true)).toEqual({ kind: "move", to: 2 });
    expect(chipKeyAction("ArrowLeft", 1, 4, false)).toEqual({ kind: "move", to: 0 });
    // Enter/Space answer the focused row; digits answer by position.
    expect(chipKeyAction("Enter", 2, 4, false)).toEqual({ kind: "answer", at: 2 });
    expect(chipKeyAction(" ", 2, 4, false)).toEqual({ kind: "answer", at: 2 });
    expect(chipKeyAction("1", 2, 4, false)).toEqual({ kind: "answer", at: 0 });
    // A digit past the last row answers nothing; other keys pass through.
    expect(chipKeyAction("9", 2, 4, false)).toEqual({ kind: "none" });
    expect(chipKeyAction("Escape", 2, 4, false)).toEqual({ kind: "none" });
  });

  // Mechanic 3 — free text. Audit: the free-text answer already rides where
  // the runtime accepts it (G4 — accepts_free_text is runtime DATA; the
  // contract above pins that), but it was a single-line input: no newline,
  // no pill shape, and the fallback placeholder ignored the choices.
  it("the free-text answer is a newline-capable composer pill falling back to 'Something else…'", () => {
    const html = renderCards(
      {},
      snapshot({
        steps: snapshot().steps.map((step) =>
          step.step === "welcome" ? { ...step, free_text_placeholder: null } : step,
        ),
      }),
    );
    // A textarea carries Shift+Enter newlines; a single-line input cannot.
    expect(html).toMatch(/<textarea[^>]*data-testid="onboarding-free-text"/);
    // Choices exist and the runtime provides no placeholder: the composer
    // offers "Something else…" (the pattern's own vocabulary).
    expect(html).toContain("Something else…");
    // Enter sends; Shift+Enter is a newline (the composer idiom).
    expect(freeTextSubmitKey("Enter", false)).toBe(true);
    expect(freeTextSubmitKey("Enter", true)).toBe(false);
    expect(freeTextSubmitKey("Escape", false)).toBe(false);
  });

  // Mechanic 4 — one-tap. Audit: SATISFIED (every pick sends immediately —
  // click, Enter, and the number keys all call onAnswer) and the runtime's
  // typed contract has no multi-select question (one answer record per
  // step), so the multi hint + explicit submit has no runtime data to
  // render (G4) — no code, and no test, invents one.

  // Mechanic 5 — recede-but-answerable. Audit: MISSING — the card never
  // receded. The view takes the typing signal as a prop; the composer-side
  // wiring has no signal to read yet (the tab-sync vocabulary is closed and
  // the composer is outside this wave's files) — recorded as the wave's
  // honest wiring limit.
  it("typedPast quiet-recedes the card — de-emphasized, still answerable, still reachable", () => {
    const quiet = renderCards({ typedPast: true });
    expect(quiet).toContain('data-quiet="true"');
    // Never blocked, never removed: every chip stays rendered and enabled.
    expect(quiet).toContain('data-option-id="research"');
    expect(quiet).not.toMatch(/<button[^>]*data-option-id="research"[^>]*disabled/);
    // The reachable name survives the recede.
    expect(quiet).toContain("Welcome interview");
    // And the recede is quiet by default — typing has not happened.
    const loud = renderCards();
    expect(loud).not.toContain("data-quiet");
  });

  // Mechanic 6 — settle. Audit: MISSING — an answered step kept its full
  // chip UI forever; nothing collapsed to the one-line receipt.
  it("the just-answered step settles to one line from the runtime's recorded value", () => {
    const html = renderCards(
      {},
      snapshot({
        ...withWelcomeAnswer("research"),
        current_step: "provider_check",
      }),
    );
    expect(html).toContain('data-testid="onboarding-settled"');
    expect(html).toContain("You chose: Research");
    // The settled step collapsed: its own chips are gone; the current
    // step's chips render below the receipt.
    expect(html).not.toContain('data-option-id="research"');
    expect(html).toContain('data-option-id="keep_default"');
  });

  it("a free-text answer settles as 'You answered:' plus the recorded words", () => {
    const html = renderCards(
      {},
      snapshot({
        ...withWelcomeAnswer("something_else", "Mostly papers and study plans"),
        current_step: "provider_check",
      }),
    );
    expect(html).toContain("You answered: Mostly papers and study plans");
    expect(html).not.toContain("You chose:");
  });

  // Mechanic 7 — dismiss. Audit: persistence SATISFIED (the runtime records
  // status "dismissed" and the card stops rendering; reopen lives in
  // Settings → Account); the affordance was a bare X icon — refined to the
  // quiet "Not now" text control.
  // Mechanic 8 — copy voice. Audit: declarative chrome copy already; the
  // settle/asker copy joins it, and no exclamation mark ships anywhere.
  it("the dismissal affordance is the quiet 'Not now' control and no exclamation ships", () => {
    const html = renderCards();
    expect(html).toContain('data-testid="onboarding-dismiss"');
    expect(html).toContain("Not now");
    expect(html).not.toContain("!");
  });
});
