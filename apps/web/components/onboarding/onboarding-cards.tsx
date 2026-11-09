"use client";

import { X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { useSessionIdentity } from "@/lib/container-connection";
import { useOnboardingCommands } from "@/lib/onboarding-data";
import type { OnboardingSnapshotView } from "@/lib/onboarding-api";
import { cn } from "@/lib/utils";

/**
 * The E43 in-chat conversational onboarding cards (S30; issue #31 leverage
 * addendum, D16): the first-run interview is a CHAT CARD docked in the
 * conversation area — keyboard-navigable choice chips whose options are DATA
 * from the runtime's typed snapshot (never prompt text), a composer-style
 * free-text answer where the step accepts one, dismissible (skippable),
 * resumable (the runtime's own state). NO wizard, NO modal forms.
 *
 * Zero-config start is the default (D16): a non-pending interview renders
 * NOTHING — the card never blocks the product.
 */

export type OnboardingCardSnapshot = OnboardingSnapshotView;

export interface OnboardingCardsViewProps {
  snapshot: OnboardingCardSnapshot;
  commandPending: boolean;
  commandSafeError?: string | undefined;
  /** The typed answer: the option id is DATA; free text rides where accepted. */
  onAnswer: (step: string, optionId: string, freeText: string | null) => void;
  onDismiss: () => void;
}

const CHIP_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export function OnboardingCardsView({
  snapshot,
  commandPending,
  commandSafeError,
  onAnswer,
  onDismiss,
}: OnboardingCardsViewProps) {
  const current = snapshot.steps.find((step) => step.step === snapshot.current_step);
  // The roving focus STARTS at the recorded answer (the radiogroup pattern:
  // the tab stop lands on the checked radio) and stays independent of the
  // selection below — aria-checked mirrors the step's STORED answer, never
  // focus (the review round's P3: a screen reader announces what was
  // answered). The chip focus + draft are KEYED to the current step:
  // advancing the step remounts the card body (the key below), which resets
  // both — no synchronous setState-in-effect cascade (the react-hooks rule).
  const answeredIndex = current
    ? current.options.findIndex((option) => option.option_id === current.answer?.option_id)
    : -1;
  const [focusedChip, setFocusedChip] = useState(answeredIndex >= 0 ? answeredIndex : 0);
  const [draft, setDraft] = useState("");

  if (snapshot.status !== "pending" || !current) {
    // Zero-config start: nothing blocks the product (D16). The interview
    // reopens from Settings → Account.
    return null;
  }

  const stepNumber = snapshot.steps.findIndex((step) => step.step === current.step) + 1;

  const moveChip = (delta: number) => {
    setFocusedChip((index) => {
      const next = (index + delta + current.options.length) % current.options.length;
      return next;
    });
  };

  const onChipKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      moveChip(1);
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveChip(-1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = current.options[focusedChip];
      if (option) {
        onAnswer(current.step, option.option_id, null);
      }
    } else if (/^[1-9]$/.test(event.key)) {
      const option = current.options[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        onAnswer(current.step, option.option_id, null);
      }
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
      onAnswer(current.step, openOption.option_id, trimmed);
    }
  };

  return (
    <section
      aria-label={`Welcome interview, step ${stepNumber} of ${snapshot.steps.length}`}
      data-testid="onboarding-card"
      className={cn(
        "pointer-events-auto w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-line",
        "bg-surface-elevated p-4 shadow-[0_8px_32px_rgba(0,0,0,0.45)]",
        commandPending && "opacity-80",
      )}
      aria-busy={commandPending || undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Step {stepNumber} of {snapshot.steps.length}
          </p>
          <h2 className="mt-0.5 truncate font-display text-sm font-semibold tracking-tight text-text">
            {current.title}
          </h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          data-testid="onboarding-dismiss"
          aria-label="Skip the interview for now"
          onClick={onDismiss}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <p className="mt-2 text-sm text-muted">{current.body}</p>
      {current.question ? (
        <p className="mt-2 text-sm font-medium text-text">{current.question}</p>
      ) : null}

      {commandSafeError ? (
        <p role="alert" className="mt-2 text-xs text-failed">
          {commandSafeError}
        </p>
      ) : null}

      <div
        key={current.step}
        role="radiogroup"
        aria-label={current.question ?? current.title}
        onKeyDown={onChipKeyDown}
        className="mt-3 grid gap-1.5"
      >
        {current.options.map((option, index) => (
          <button
            key={option.option_id}
            type="button"
            role="radio"
            aria-checked={current.answer?.option_id === option.option_id}
            data-testid="onboarding-chip"
            data-option-id={option.option_id}
            tabIndex={focusedChip === index ? 0 : -1}
            onFocus={() => setFocusedChip(index)}
            onMouseEnter={() => setFocusedChip(index)}
            onClick={() => onAnswer(current.step, option.option_id, null)}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
              focusedChip === index
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
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] text-muted">
        Choose with the arrow keys and Enter, or press 1–{current.options.length}.
      </p>

      {current.accepts_free_text ? (
        <div className="mt-3 flex items-center gap-2">
          <input
            data-testid="onboarding-free-text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitFreeText();
              }
            }}
            placeholder={current.free_text_placeholder ?? "Type your answer…"}
            aria-label="Your answer in your own words"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
          />
          <Button size="sm" onClick={submitFreeText} disabled={!draft.trim()}>
            Send
          </Button>
        </div>
      ) : null}

      <p className="mt-2 text-[11px] text-muted">
        Skip for now keeps your answers — reopen it anytime from Settings → Account.
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
 * states stay silent too (the interview reads the runtime).
 */
export function OnboardingDock() {
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
        onAnswer={answer}
        onDismiss={() => {
          commands.submitDismiss();
        }}
      />
    </div>
  );
}
