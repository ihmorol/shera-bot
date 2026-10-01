"use client";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { agentById } from "@/lib/fixtures";

/**
 * The streaming Assistant message (UI_DESIGN §6.1): incremental text with a
 * typing cursor, full §21.5 sender attribution, aria-live="polite" (§2.3 —
 * the DOM itself is throttled to the 30fps budget, which also throttles the
 * polite announcement). DEMO STREAMING: the text comes from the scripted
 * fixture stream, the footer labels the mechanism, and the Stop control
 * stops only this local demo stream — real cancellation is a typed runtime
 * command (D32). The cursor is a CSS animation, so the global
 * prefers-reduced-motion rule in globals.css stills it (§2.3).
 */
export function StreamingMessage({
  agentId,
  visibleText,
  done,
  stopped,
  onStop,
  variant = "demo",
}: {
  agentId: string;
  /** Text visible so far (throttled frame from lib/streaming). */
  visibleText: string;
  done: boolean;
  stopped: boolean;
  onStop: () => void;
  /**
   * S09 chunk 2: "demo" is the scripted fixture stream (labeled as demo, with
   * the local Stop control); "live" is the real runtime's transient delta
   * bubble — never demo copy, and no Stop (a real stop is a runtime command
   * that arrives with a later slice).
   */
  variant?: "demo" | "live";
}) {
  const agent = agentById(agentId);
  const name = agent?.display_name ?? agentId;
  const streaming = !done && !stopped;

  return (
    <div className="flex flex-col items-start" aria-live="polite">
      {/* min-w-0 max-w-full: constrain the row inside the items-start column
          so the nowrap role line cannot overflow at 360px (§2.2). */}
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <AgentAvatar agentId={agentId} name={name} size="sm" />
        <span className="text-sm font-medium text-text">{name}</span>
        {agent ? (
          <span className="min-w-0 truncate text-xs text-muted">{agent.role_description}</span>
        ) : null}
      </div>
      <div className="ml-8 max-w-[78%] rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-2.5 text-base">
        <p className="whitespace-pre-wrap">
          <span className="sr-only">{name} said: </span>
          {visibleText}
          {streaming ? (
            <span
              aria-hidden="true"
              data-streaming-cursor=""
              className="ml-0.5 inline-block h-4 w-2 animate-pulse rounded-[2px] bg-sky align-text-bottom"
            />
          ) : null}
        </p>
        <p className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted">
          {streaming && variant === "demo" ? (
            <>
              <span aria-hidden="true">demo stream · typing</span>
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop streaming"
                title="Stops the demo stream in this browser — a real stop is a runtime command (D32)"
                className="rounded px-1 text-sky underline underline-offset-2"
              >
                Stop
              </button>
            </>
          ) : null}
          {streaming && variant === "live" ? <span aria-hidden="true">replying…</span> : null}
          {stopped && variant === "demo" ? (
            <span aria-hidden="true">
              demo stream · stopped locally (D32: a real stop is a runtime command)
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
