"use client";

import { ChevronDown, ChevronUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PackSummary } from "@/lib/operation-api";
import { cn } from "@/lib/utils";

/**
 * The Operation's pack summary (UI_DESIGN §S6, the F6 conformance finding:
 * "Ad-hoc created chat lacks the collapsible roster/skills/connectors
 * summary") — a collapsible strip between the chat header and the roster
 * panel showing the roster size and the PINNED pack's skills and connectors,
 * read from the runtime's detail read model (pack_summary).
 *
 * Truthful status (D38, G2/G3): the prototype has NO connector runtime and
 * recommended connectors are never auto-installed, so the runtime reports
 * every connector `connected: false` and this surface renders the fixed
 * "Not configured" status — it NEVER claims a live connection that does not
 * exist. Skills render by title, falling back to the pack-authored id — a
 * missing title is never replaced with a fabricated name (G3).
 */
export function OperationPackSummary({
  packSummary,
  rosterCount,
  open,
  onOpenChange,
  state,
  safeErrorMessage,
  onRetry,
  className,
}: {
  packSummary: PackSummary | null;
  rosterCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <section
      aria-label="Pack details"
      className={cn("shrink-0 border-b border-line bg-surface px-4 lg:px-6", className)}
    >
      <div className="flex items-center justify-between gap-4 py-2">
        <p className="truncate text-xs text-muted" data-testid="pack-roster-count">
          {rosterCount} Agents on the roster
        </p>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {open ? (
            <ChevronUp className="size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden="true" />
          )}
          Pack details
        </Button>
      </div>

      {state === "loading" ? (
        <div aria-busy="true" data-testid="pack-summary-skeleton" className="flex gap-6 pb-4">
          <div className="h-4 w-40 animate-pulse rounded bg-surface-elevated" />
          <div className="h-4 w-40 animate-pulse rounded bg-surface-elevated" />
        </div>
      ) : state === "error" ? (
        <div role="alert" className="flex items-center gap-3 pb-3">
          <p className="text-sm text-text">{safeErrorMessage ?? "The Operation could not be loaded."}</p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : open && packSummary ? (
        <div className="grid gap-x-8 gap-y-4 pb-4 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Skills</p>
            {packSummary.skills.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted">No skills in this pack.</p>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-1">
                {packSummary.skills.map((skill) => (
                  <li key={skill.skill_id} className="text-sm text-text">
                    {skill.title ?? skill.skill_id}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              Connectors
            </p>
            {packSummary.connectors.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted">No connectors in this pack.</p>
            ) : (
              <ul className="mt-1.5 flex flex-col gap-1">
                {packSummary.connectors.map((connector) => (
                  <li
                    key={connector.connector_id}
                    className="flex items-center gap-2 text-sm text-text"
                  >
                    <span className="truncate font-mono text-xs">{connector.connector_id}</span>
                    <span className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted">
                      Not configured
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
