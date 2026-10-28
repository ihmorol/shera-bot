"use client";

import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * The workspace panel's tab strip (UI_DESIGN §4 S7). All four S7 tabs are
 * shipped as of chunk 5 — Files, Editor, Private files, and Artifacts each
 * render their real surface, so the designed "lands in the next build
 * increment" states retired with the last tab.
 */

export type WorkspaceTabId = "files" | "editor" | "private" | "artifacts";

export const WORKSPACE_TABS: ReadonlyArray<{ id: WorkspaceTabId; label: string }> = [
  { id: "files", label: "Files" },
  { id: "editor", label: "Editor" },
  { id: "private", label: "Private files" },
  { id: "artifacts", label: "Artifacts" },
];

export function TabStrip({
  active,
  onChange,
  className,
}: {
  active: WorkspaceTabId;
  onChange: (id: WorkspaceTabId) => void;
  className?: string | undefined;
}): ReactElement {
  return (
    <div
      role="tablist"
      aria-label="Workspace sections"
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-x-auto border-b border-line px-2 py-1.5",
        className,
      )}
    >
      {WORKSPACE_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={`${tab.label} tab`}
            onClick={() => onChange(tab.id)}
            className={cn(
              "shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors duration-150",
              selected
                ? "bg-surface-elevated text-text"
                : "text-muted hover:bg-surface-elevated hover:text-text",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
