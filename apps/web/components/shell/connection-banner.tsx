import { Loader2, WifiOff } from "lucide-react";

import {
  DISCONNECTED_BANNER_COPY,
  RECONNECTING_BANNER_COPY,
  type ConnectionState,
} from "@/lib/connection";

/**
 * Connection banner (UI_DESIGN §6.4, §2.4). Rendered above the thread while
 * disconnected/reconnecting — a strip, never a modal: reading stays possible
 * while disconnected. Copy is the exact §6.4 text. Disconnected announces
 * assertively (role="alert"); reconnecting is a polite status with the replay
 * progress. Color never carries the signal alone — each state pairs an icon
 * with its text (§2.3).
 */
export function ConnectionBanner({
  state,
  replay,
}: {
  state: Exclude<ConnectionState, "connected">;
  /** Replay progress while reconnecting ("Replaying missed events…"). */
  replay?: { done: number; total: number } | undefined;
}) {
  if (state === "disconnected") {
    return (
      <div
        role="alert"
        data-connection-banner="disconnected"
        className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-failed lg:px-6"
      >
        <WifiOff className="size-4 shrink-0" aria-hidden="true" />
        <p>{DISCONNECTED_BANNER_COPY}</p>
      </div>
    );
  }

  const progress =
    replay && replay.total > 0 ? ` ${Math.min(replay.done, replay.total)} of ${replay.total}` : "";
  return (
    <div
      role="status"
      data-connection-banner="reconnecting"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2 text-sm text-approval lg:px-6"
    >
      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
      {/* sr-only tail: progress digits alone are not a self-describing update */}
      <p aria-live="polite">
        {RECONNECTING_BANNER_COPY}
        {progress}
        <span className="sr-only">{progress ? " — replay in progress" : ""}</span>
      </p>
    </div>
  );
}
