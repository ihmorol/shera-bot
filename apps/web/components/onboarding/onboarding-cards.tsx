"use client";

import { Check } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { useSessionIdentity } from "@/lib/container-connection";
import { useOnboardingCommands } from "@/lib/onboarding-data";
import type { OnboardingSnapshotView } from "@/lib/onboarding-api";
import { cn } from "@/lib/utils";

/**
 * The E43 in-chat conversational onboarding cards (S30; issue #31 leverage
 * addendum, D16), refined by the D52 migration wave C into the OpenMausBot
 * interview-card mechanics (docs/research/openmausbot-ui-patterns-2026-11-21
 * §4/§9/§10): the first-run interview is a CHAT CARD docked in the
 * conversation area — an asker header naming the runtime's voice ("Shera
 * asks"), keyboard-navigable choice chips (40px rows, recorded pick marked
 * with an accent check, Home/End + RTL-aware roving), a composer pill for
 * the free-text answer (Enter sends, Shift+Enter is a newline), a one-line
 * settle receipt for the step the runtime just recorded, and a quiet
 * "Not now" dismissal. The options are DATA from the runtime's typed
 * snapshot (never prompt text); dismissal stays runtime-recorded and the
 * interview reopens from Settings → Account. NO wizard, NO modal forms.
 *
 * Zero-config start is the default (D16): a non-pending interview renders
 * NOTHING — the card never blocks the product. Recede-but-answerable: the
 * optional `typedPast` signal quiet-recedes the card once the human types a
 * normal message — choices de-emphasize under `data-quiet`, nothing is
 * blocked or removed while the step is unanswered. (The composer side of
 * that signal has no broadcaster yet — the tab-sync vocabulary is closed
 * and the composer is outside this wave's files — so the dock accepts the
 * prop for its future wiring.)
 */

export type OnboardingCardSnapshot = OnboardingSnapshotView;

export interface OnboardingCardsViewProps {
  snapshot: OnboardingCardSnapshot;
  commandPending: boolean;
  commandSafeError?: string | undefined;
  /**
   * True once the human has typed a normal message past this card (the
   * pattern's `typedPast`): the card quiet-recedes — choices go secondary,
   * everything stays answerable and reachable. Nothing is invented here:
   * the prop carries an interaction fact, the state below stays the
   * runtime's.
   */
  typedPast?: boolean;
  /** The typed answer: the option id is DATA; free text rides where accepted. */
  onAnswer: (step: string, optionId: string, freeText: string | null) => void;
  onDismiss: () => void;
}

const CHIP_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H"];

/** One resolved keyboard action for the choice radiogroup. */
export type ChipKeyAction =
  { kind: "move"; to: number } | { kind: "answer"; at: number } | { kind: "none" };

/**
 * The radiogroup's keyboard contract, pure so it stays directly testable:
 * ↑/↓ rove with wrap-around, Home/End jump to the first/last row, Left/
 * Right follow READING order (RTL flips them), Enter/Space answer the
 * focused row, and the digit keys answer by position.
 */
export function chipKeyAction(
  key: string,
  index: number,
  count: number,
  rtl: boolean,
): ChipKeyAction {
  if (count <= 0) return { kind: "none" };
  if (key === "ArrowDown") return { kind: "move", to: (index + 1) % count };
  if (key === "ArrowUp") return { kind: "move", to: (index - 1 + count) % count };
  if (key === "ArrowRight") {
    return { kind: "move", to: rtl ? (index - 1 + count) % count : (index + 1) % count };
  }
  if (key === "ArrowLeft") {
    return { kind: "move", to: rtl ? (index + 1) % count : (index - 1 + count) % count };
  }
  if (key === "Home") return { kind: "move", to: 0 };
  if (key === "End") return { kind: "move", to: count - 1 };
  if (key === "Enter" || key === " ") return { kind: "answer", at: index };
  if (/^[1-9]$/.test(key)) {
    const at = Number(key) - 1;
    return at < count ? { kind: "answer", at } : { kind: "none" };
  }
  return { kind: "none" };
}

/**
 * Enter sends the free-text answer; Shift+Enter is a newline (the composer
 * idiom — a newline-capable textarea, never a single-line input).
 */
export function freeTextSubmitKey(key: string, shiftKey: boolean): boolean {
  return key === "Enter" && !shiftKey;
}

type StepView = OnboardingSnapshotView["steps"][number];

/**
 * The one-line settle receipt for the step the runtime just recorded (G4:
 * the text is the runtime's OWN record — the option's label or the free
 * text; nothing is derived beyond it). The just-answered step collapses to
 * this line while the interview continues; the current step's own answer,
 * when a contract-legal snapshot carries one, stays in the radiogroup below
 * (the a11y contract: aria-checked mirrors the recorded answer).
 */
function settledLineFor(snapshot: OnboardingCardSnapshot, current: StepView): string | null {
  const answered = snapshot.steps.filter(
    (step) => step.answer !== null && step.step !== current.step,
  );
  const last = answered[answered.length - 1];
  const record = last?.answer ?? null;
  if (!record) return null;
  if (record.free_text) return `You answered: ${record.free_text}`;
  if (!record.option_id) return null;
  const label = last?.options.find((option) => option.option_id === record.option_id)?.label;
  return `You chose: ${label ?? record.option_id}`;
}

/** The asker header: the runtime's voice ("Shera asks" — the snapshot
 * carries no asker field and the interview is never a pack Agent's voice)
 * with the asker avatar, the step position, and the quiet dismissal. */
function AskerHeader({
  stepNumber,
  total,
  title,
  onDismiss,
}: {
  stepNumber: number;
  total: number;
  title: string;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        data-testid="onboarding-asker-avatar"
        className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line-accent bg-brand/15 font-display text-xs font-semibold text-sky"
      >
        S
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">{`Shera asks · Step ${stepNumber} of ${total}`}</p>
        <h2 className="mt-0.5 truncate font-display text-sm font-semibold tracking-tight text-text">
          {title}
        </h2>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        data-testid="onboarding-dismiss"
        aria-label="Not now — reopen the interview anytime from Settings"
        onClick={onDismiss}
      >
        Not now
      </Button>
    </div>
  );
}

/**
 * One step's interactive body. It is KEYED to the step (the key at the use
 * site), so advancing the step remounts it and the draft, the roving focus,
 * and the picked chip reset — no synchronous setState-in-effect cascade
 * (the react-hooks rule).
 *
 * The roving focus STARTS at the recorded answer (the radiogroup pattern:
 * the tab stop lands on the checked radio) and stays independent of
 * aria-checked below — aria-checked mirrors the step's STORED answer, never
 * focus or the in-flight pick (the review round's P3: a screen reader
 * announces what was answered). The picked chip is interaction feedback for
 * the command in flight; the recorded answer stays the runtime's.
 */
function OnboardingStepBody({
  current,
  typedPast,
  commandSafeError,
  onAnswer,
}: {
  current: StepView;
  typedPast: boolean;
  commandSafeError?: string | undefined;
  onAnswer: (step: string, optionId: string, freeText: string | null) => void;
}) {
  const answeredIndex = current.options.findIndex(
    (option) => option.option_id === current.answer?.option_id,
  );
  const [focusedChip, setFocusedChip] = useState(answeredIndex >= 0 ? answeredIndex : 0);
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // A refused answer is NOT a recorded one: while the safe error stands, the
  // picked tint drops (derived — no effect cascade). The step does not advance
  // on failure, so without this the chip would read as recorded indefinitely.
  const pickedEffective = commandSafeError ? null : picked;

  const answer = (optionId: string) => {
    setPicked(optionId);
    onAnswer(current.step, optionId, null);
  };

  const onChipKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Reading order, not physical order: under RTL the Left/Right arrows
    // flip (the pattern's RTL-aware roving).
    const rtl = window.getComputedStyle(event.currentTarget).direction === "rtl";
    const action = chipKeyAction(event.key, focusedChip, current.options.length, rtl);
    if (action.kind === "move") {
      event.preventDefault();
      setFocusedChip(action.to);
    } else if (action.kind === "answer") {
      event.preventDefault();
      const option = current.options[action.at];
      if (option) answer(option.option_id);
    }
  };

  const submitFreeText = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    // The free-text answer rides the step's own open option (the E43
    // composer path): the option id stays DATA, the text is the attachment.
    const openOption =
      current.options.find((option) => option.option_id === "something_else") ??
      current.options[current.options.length - 1];
    if (openOption) {
      setPicked(openOption.option_id);
      onAnswer(current.step, openOption.option_id, trimmed);
    }
  };

  return (
    <>
      <div
        role="radiogroup"
        aria-label={current.question ?? current.title}
        onKeyDown={onChipKeyDown}
        className="mt-3 grid gap-1.5"
      >
        {current.options.map((option, index) => {
          const recorded = current.answer?.option_id === option.option_id;
          const marked = pickedEffective === option.option_id || recorded;
          return (
            <button
              key={option.option_id}
              type="button"
              role="radio"
              aria-checked={recorded}
              data-testid="onboarding-chip"
              data-option-id={option.option_id}
              tabIndex={focusedChip === index ? 0 : -1}
              onFocus={() => setFocusedChip(index)}
              onMouseEnter={() => setFocusedChip(index)}
              onClick={() => answer(option.option_id)}
              className={cn(
                "flex min-h-10 items-start gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors",
                marked
                  ? "border-line-accent bg-brand/10 text-text"
                  : focusedChip === index && !typedPast
                    ? "border-line-accent bg-surface text-text"
                    : "border-line bg-surface text-muted hover:bg-surface hover:text-text",
              )}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-line font-mono text-[10px] text-muted"
              >
                {CHIP_KEYS[index]}
              </span>
              <span className="min-w-0">
                <span className="block text-sm">{option.label}</span>
                <span className="block text-xs text-muted">{option.description}</span>
              </span>
              {marked ? (
                <Check
                  data-testid="onboarding-chip-check"
                  aria-hidden="true"
                  className="ml-auto mt-0.5 size-4 shrink-0 text-sky"
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[11px] text-muted">
        Choose with the arrow keys and Enter, or press 1–{current.options.length}.
      </p>

      {current.accepts_free_text ? (
        <div className="mt-3 flex items-end gap-2">
          <textarea
            data-testid="onboarding-free-text"
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (freeTextSubmitKey(event.key, event.shiftKey)) {
                event.preventDefault();
                submitFreeText();
              }
            }}
            placeholder={
              current.free_text_placeholder ??
              (current.options.length > 0 ? "Something else…" : "Type your answer…")
            }
            aria-label="Your answer in your own words"
            className="min-h-10 w-full resize-none rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-sm text-text placeholder:text-muted focus:border-line-accent"
          />
          <Button
            size="sm"
            onClick={submitFreeText}
            disabled={!draft.trim()}
            title="Type your answer first"
          >
            Send
          </Button>
        </div>
      ) : null}
    </>
  );
}

export function OnboardingCardsView({
  snapshot,
  commandPending,
  commandSafeError,
  typedPast = false,
  onAnswer,
  onDismiss,
}: OnboardingCardsViewProps) {
  const current = snapshot.steps.find((step) => step.step === snapshot.current_step);

  if (snapshot.status !== "pending" || !current) {
    // Zero-config start: nothing blocks the product (D16). The interview
    // reopens from Settings → Account.
    return null;
  }

  const stepNumber = snapshot.steps.findIndex((step) => step.step === current.step) + 1;
  const settledLine = settledLineFor(snapshot, current);

  return (
    <section
      aria-label={`Welcome interview, step ${stepNumber} of ${snapshot.steps.length}`}
      data-testid="onboarding-card"
      data-quiet={typedPast ? "true" : undefined}
      className={cn(
        "pointer-events-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-line",
        "bg-surface-elevated p-4 shadow-[0_8px_32px_rgba(0,0,0,0.45)]",
        commandPending && "opacity-80",
        typedPast && "opacity-90",
      )}
      aria-busy={commandPending || undefined}
    >
      <AskerHeader
        stepNumber={stepNumber}
        total={snapshot.steps.length}
        title={current.title}
        onDismiss={onDismiss}
      />

      <p className="mt-2 text-sm text-muted">{current.body}</p>
      {current.question ? (
        <p className="mt-2 text-sm font-medium text-text">{current.question}</p>
      ) : null}

      {commandSafeError ? (
        <p role="alert" className="mt-2 text-xs text-failed">
          {commandSafeError}
        </p>
      ) : null}

      {settledLine ? (
        <p data-testid="onboarding-settled" className="mt-3 truncate text-sm text-text">
          {settledLine}
        </p>
      ) : null}

      <OnboardingStepBody
        key={current.step}
        current={current}
        typedPast={typedPast}
        commandSafeError={commandSafeError}
        onAnswer={onAnswer}
      />

      <p className="mt-2 text-[11px] text-muted">
        Not now keeps your answers — reopen it anytime from Settings → Account.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live wiring: the dock (a chat-bubble card, never a modal)
// ---------------------------------------------------------------------------

/**
 * The docked host: a fixed chat-bubble card in the conversation corner —
 * in-chat by shape, never a modal, never a wizard. Renders NOTHING until
 * the interview is pending (zero-config start, D16); the container-less
 * states stay silent too (the interview reads the runtime). `typedPast`
 * rides through for the composer-side wiring once a signal exists (the
 * closed tab-sync vocabulary keeps that a recorded-slice change).
 */
export function OnboardingDock({ typedPast = false }: { typedPast?: boolean }) {
  const session = useSessionIdentity();
  const workspaceId = session.data?.workspace_id ?? null;
  const commands = useOnboardingCommands(workspaceId);

  if (!workspaceId || !commands.snapshot) {
    return null;
  }

  const answer = (step: string, optionId: string, freeText: string | null) => {
    commands.submit({
      command_id: `cmd_${crypto.randomUUID()}`,
      idempotency_key: `idem_${crypto.randomUUID()}`,
      workspace_id: workspaceId,
      actor: { type: "user", id: session.data?.google_sub ?? "" },
      issued_at: new Date().toISOString(),
      type: "onboarding.answer",
      step: step as "welcome",
      option_id: optionId,
      free_text: freeText,
    });
  };

  return (
    <div
      aria-label="Welcome interview"
      className="pointer-events-none fixed bottom-4 right-4 z-40 max-lg:left-4 lg:bottom-6 lg:right-6"
    >
      <OnboardingCardsView
        snapshot={commands.snapshot}
        commandPending={commands.pending}
        commandSafeError={commands.safeError}
        typedPast={typedPast}
        onAnswer={answer}
        onDismiss={() => {
          commands.submitDismiss();
        }}
      />
    </div>
  );
}
