"use client";

import { Send } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";

/**
 * Composer (UI_DESIGN S3): Enter sends, Shift+Enter newline, visible send
 * state (idle → sending → sent; failed renders on the message tick with a
 * retry). §6.3: a real send is an idempotent typed command with a ≈500 ms ack
 * target — this demo appends to local fixture state only and never calls the
 * runtime. `disabled` + `disabledReason` covers the no-provider case (D17:
 * a clear configuration state, never fake completion).
 */
export const NO_PROVIDER_COMPOSER_COPY = "No provider is configured for this conversation yet.";

/**
 * The send button's title, in the audited priority order (D52 wave B): a
 * disabled control carries its REASON (the D17 no-provider/container copy;
 * craft rule — every disabled control carries its reason in title/aria), an
 * in-flight send carries the status word, an empty draft names what is
 * missing, and only a real draft names the action. Extracted as a pure
 * function so the priority is order-pinned by test, like mergeChatsByRecency.
 */
export function sendButtonTitle(input: {
  disabled: boolean;
  sending: boolean;
  hasDraft: boolean;
  disabledReason?: string;
}): string {
  if (input.disabled) {
    return input.disabledReason ?? "Sending is unavailable right now.";
  }
  if (input.sending) {
    return "Sending…";
  }
  if (!input.hasDraft) {
    return "Type a message to send";
  }
  return "Send message";
}

/**
 * The placeholder priority (D52 wave B, audited 2026-11-21 — first match
 * wins, and after the audit only two states remain):
 *   a. disabled with disabledReason → the placeholder stays NEUTRAL; the
 *      reason renders in the hint line below (D17 — the reason never appears
 *      twice on the same surface).
 *   b. approval pending → NO placeholder state: the runtime allows sends
 *      while an approval waits — sendOperationMessage
 *      (apps/user-runtime/src/modules/operations/operations.service.ts)
 *      gates only on the S23 provider turn gate, the idempotency key, and
 *      message validation; there is NO approval-pending send block. The
 *      composer stays enabled (honesty over drama).
 *   c. disconnected → the surface's banner owns that state (lib/connection);
 *      the placeholder is unchanged.
 *   d. default → "Message {name}". The Operation chat's default
 *      ("Message the Operation (@ to address an Agent)") lives on the
 *      Operation thread's own composer (components/operations/
 *      operation-thread.tsx).
 * No queue/steer semantics: Shera's runtime has no steer-while-running
 * command — inventing one would be a G2 violation (future-runtime item).
 */
export function Composer({
  agentName,
  onSend,
  disabled = false,
  disabledReason = "Sending is unavailable right now.",
}: {
  agentName: string;
  onSend: (text: string) => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const trimmed = value.trim();
  const canSend = !disabled && !sending && trimmed.length > 0;

  const submit = () => {
    if (!canSend) {
      return;
    }
    onSend(trimmed);
    setValue("");
    setSending(true);
    timerRef.current = window.setTimeout(() => setSending(false), 500);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  };

  return (
    <div className="shrink-0 border-t border-line bg-surface px-4 py-3 lg:px-6">
      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <textarea
          aria-label={`Message ${agentName}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={`Message ${agentName}`}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-line bg-surface-elevated px-3 py-2.5 text-base text-text placeholder:text-muted disabled:opacity-60 disabled:cursor-not-allowed"
        />
        <Button
          type="submit"
          size="icon"
          disabled={!canSend}
          aria-label="Send message"
          title={sendButtonTitle({
            disabled,
            sending,
            hasDraft: trimmed.length > 0,
            disabledReason,
          })}
        >
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </form>
      {/* The hint is the ONE place the disabled reason renders (D17): the
          placeholder stays the neutral prompt, so the explanation never
          appears twice on the same surface. */}
      <p className="mt-1.5 px-1 font-mono text-[11px] text-muted" role="status">
        {disabled
          ? disabledReason
          : sending
            ? "Sending…"
            : "Enter to send · Shift+Enter for a new line"}
      </p>
    </div>
  );
}
