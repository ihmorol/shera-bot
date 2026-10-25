"use client";

import { Layers } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import type { OperationListRow } from "@/lib/operation-api";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The sidebar's REAL Operation chats (S14, §3.2 "Active chats"): the
 * workspace's Operations read from GET /v1/operations, each row carrying the
 * S14 ad-hoc identity (D41) — a small "Ad-hoc" tag for definition-less
 * Operations and the auto-label name muted/italic, the same marking the chat
 * header shows. The fixture demo rows stay rendered beside this section
 * (labeled demo data, G4) — the sidebar never hides them, and this section
 * fabricates no state: live rows render quiet (real read tracking arrives in
 * a later slice), color is never the only signal (§2.1).
 */
export function LiveOperationChatsSection({
  operations,
  state,
  safeErrorMessage,
  onRetry,
  pathname,
  onNavigate,
}: {
  operations: OperationListRow[];
  state: "loading" | "ready" | "error";
  /** Redacted message for the error state (D23 rule 4). */
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  /** The active route, passed in by the shell so this section stays pure. */
  pathname?: string | undefined;
  /** Close the mobile drawer on navigation (the shell owns the sheet). */
  onNavigate?: (() => void) | undefined;
}) {
  const linkProps = onNavigate ? { onClick: onNavigate } : {};

  if (state === "loading") {
    return (
      <div aria-busy="true" data-testid="operation-chats-skeleton">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-3 py-2">
            <span className="size-4 animate-pulse rounded bg-surface-elevated" />
            <span className="h-3 w-36 animate-pulse rounded bg-surface-elevated" />
          </div>
        ))}
      </div>
    );
  }

  if (state === "error") {
    return (
      <div role="alert" className="mx-1 flex flex-col gap-2 rounded-lg px-2 py-2">
        <p className="flex items-start gap-2 text-sm text-text">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-failed" aria-hidden="true" />
          {safeErrorMessage ?? "The Operations could not be loaded."}
        </p>
        <Button variant="outline" size="sm" className="self-start" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  if (operations.length === 0) {
    return (
      <p role="status" className="px-3 py-1 text-xs text-muted">
        No Operations yet — use + New to start one.
      </p>
    );
  }

  return (
    <ul>
      {operations.map((operation) => {
        const href = routes.operation(operation.operation_id);
        const active =
          pathname !== undefined && (pathname === href || pathname.startsWith(`${href}/`));
        return (
          <li key={operation.operation_id}>
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-surface-elevated text-text"
                  : "text-muted hover:bg-surface-elevated hover:text-text",
              )}
              {...linkProps}
            >
              <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-1.5",
                    operation.auto_label && "italic text-muted",
                  )}
                  data-testid={
                    operation.auto_label
                      ? `operation-auto-label-${operation.operation_id}`
                      : undefined
                  }
                >
                  <span className="truncate">{operation.name}</span>
                  {operation.is_adhoc ? (
                    <span
                      title="Created without a pack definition"
                      className="shrink-0 rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted"
                    >
                      Ad-hoc
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted">
                  pack {operation.pinning.pack_id} v{operation.pinning.pack_version}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
