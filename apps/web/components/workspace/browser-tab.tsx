"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ErrorState } from "@/components/shell/states";
import {
  browserTabState,
  fetchBrowserState,
  fetchBrowserView,
  type BrowserStatePayload,
  type BrowserTabState,
  type BrowserViewPayload,
} from "@/lib/live-views-api";
import { RuntimeApiError } from "@/lib/runtime-client";

/**
 * The Browser tab (UI_DESIGN §4 S7, issue #19): a read-only live view of the
 * container's shared browser session — the ACTUAL current page (fresh JPEG
 * screenshot + URL + title) polled from the chunk-2 GET routes.
 *
 * READ-ONLY IS STRUCTURAL (G6): the URL bar is a display, not an input; there
 * is no back/forward/reload control, no address entry, no click-through — the
 * panel renders the page, it never drives it. The D6 single-owner rule lives
 * in the runtime (the Agent's driver claims control or the view simply
 * reflects an ownerless browser); nothing here can contest it.
 *
 * HONESTY (G4): every state is the service's true answer — Live (running,
 * fresh capture), idle/starting/crashed (the lifecycle arm, NO image), the
 * unconfigured composition, and the typed §2.4 error with a read Retry.
 * Polling pauses while the tab is hidden (the view is stale-honest: the
 * captured_at timestamp says when the page was seen).
 */

/** The live-capture cadence (§6.1 budget: a read-only view needs no rush). */
const VIEW_POLL_MS = 4_000;
/** The lifecycle/ownership readout rides a slower cadence. */
const STATE_POLL_MS = 10_000;

function formatCapturedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function BrowserTab({ workspaceId }: { workspaceId: string }): ReactElement {
  // The view route answers the true lifecycle itself (the non-running arms
  // carry NO image), so the tab's state folds from the view read alone; the
  // state readout confirms lifecycle + posture at its own slower cadence and
  // keeps an unconfigured composition honest even before a view succeeds.
  const viewQuery = useQuery<BrowserViewPayload, RuntimeApiError>({
    queryKey: ["browser-view", workspaceId],
    queryFn: () => fetchBrowserView(workspaceId),
    refetchInterval: VIEW_POLL_MS,
    placeholderData: (previous) => previous,
    retry: false,
  });
  const stateQuery = useQuery<BrowserStatePayload, RuntimeApiError>({
    queryKey: ["browser-state", workspaceId],
    queryFn: () => fetchBrowserState(workspaceId),
    refetchInterval: STATE_POLL_MS,
    placeholderData: (previous) => previous,
    retry: false,
  });

  if (viewQuery.isPending && stateQuery.isPending) {
    return <BrowserTabView state={{ kind: "loading" }} />;
  }

  const viewError = viewQuery.error ?? stateQuery.error;
  if (viewError !== null) {
    return (
      <BrowserTabView
        state={{
          kind: "error",
          message: viewError.sheraError.safe_message,
          retryable: viewError.sheraError.retryable,
        }}
        onRetry={() => {
          void viewQuery.refetch();
          void stateQuery.refetch();
        }}
      />
    );
  }

  return (
    <BrowserTabView state={browserTabState(viewQuery.data ?? null, stateQuery.data ?? null)} />
  );
}

export function BrowserTabView({
  state,
  onRetry,
}: {
  state: BrowserTabState;
  onRetry?: (() => void) | undefined;
}): ReactElement {
  return (
    <div
      data-testid="browser-panel"
      data-read-only="true"
      aria-label="Shared browser view (read-only)"
      className="flex h-full min-h-0 flex-col"
    >
      {state.kind === "live" ? (
        <BrowserLiveView
          url={state.url}
          title={state.title}
          screenshotBase64={state.screenshotBase64}
          capturedAt={state.capturedAt}
        />
      ) : state.kind === "browser-state" ? (
        <BrowserLifecycleNote lifecycle={state.lifecycle} />
      ) : state.kind === "unconfigured" ? (
        <p className="px-3 pt-6 text-sm text-muted">
          The browser service is not configured in this runtime. When it is, Agents&rsquo; web work
          appears here — live and read-only.
        </p>
      ) : state.kind === "error" ? (
        <div className="px-3 pb-3">
          <ErrorState safeMessage={state.message} onRetry={state.retryable ? onRetry : undefined} />
        </div>
      ) : (
        <div
          data-testid="browser-skeleton"
          aria-hidden="true"
          className="flex flex-col gap-3 px-3 pt-3"
        >
          <div className="h-8 animate-pulse rounded-lg bg-surface-elevated" />
          <div className="aspect-[4/3] animate-pulse rounded-xl bg-surface-elevated" />
        </div>
      )}
    </div>
  );
}

function BrowserLiveView({
  url,
  title,
  screenshotBase64,
  capturedAt,
}: {
  url: string;
  title: string;
  screenshotBase64: string;
  capturedAt: string;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-3 pb-3 pt-3">
      <div className="flex items-center justify-between gap-2">
        <span
          data-testid="browser-live-badge"
          className="inline-flex items-center gap-1.5 text-xs text-live"
        >
          <span className="animate-live-pulse size-1.5 rounded-full bg-live" aria-hidden="true" />
          Live
        </span>
        <span className="font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-muted">
          Read-only
        </span>
      </div>
      <div className="rounded-xl border border-line bg-canvas p-2">
        {/* A display, not an input (G6): the address renders as content. */}
        <div
          data-testid="browser-url"
          className="truncate rounded-lg bg-surface-elevated px-2.5 py-1.5 font-mono text-xs text-text"
          title={url}
        >
          {url}
        </div>
        {title !== "" ? <p className="truncate px-1 pt-1.5 text-xs text-muted">{title}</p> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-line bg-canvas">
        <img
          data-testid="browser-screenshot"
          src={`data:image/jpeg;base64,${screenshotBase64}`}
          alt={`Browser page preview — ${title !== "" ? title : url}`}
          className="h-full max-h-full w-full object-contain object-top"
        />
      </div>
      {capturedAt !== "" ? (
        <p className="shrink-0 text-xs text-muted">Captured {formatCapturedAt(capturedAt)}</p>
      ) : null}
    </div>
  );
}

const LIFECYCLE_COPY: Record<"stopped" | "starting" | "crashed", string> = {
  stopped:
    "The shared browser is idle. It starts when an Agent works on a web task, and what it sees appears here — live and read-only.",
  starting: "The shared browser is starting…",
  crashed:
    "The shared browser crashed. It restarts when an Agent next needs it, and this view picks the session back up.",
};

function BrowserLifecycleNote({
  lifecycle,
}: {
  lifecycle: "stopped" | "starting" | "crashed";
}): ReactElement {
  return (
    <div
      data-testid="browser-lifecycle-note"
      className="flex flex-1 items-start px-3 pt-6 text-sm text-muted"
    >
      <p>{LIFECYCLE_COPY[lifecycle]}</p>
    </div>
  );
}
