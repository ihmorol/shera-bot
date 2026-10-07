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
          placeholder={disabled ? disabledReason : `Message ${agentName}`}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-line bg-surface-elevated px-3 py-2.5 text-base text-text placeholder:text-muted"
        />
        <Button type="submit" size="icon" disabled={!canSend} aria-label="Send message">
          <Send className="size-4" aria-hidden="true" />
        </Button>
      </form>
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
