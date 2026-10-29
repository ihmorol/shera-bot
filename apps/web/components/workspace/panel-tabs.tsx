"use client";

import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * The workspace panel's tab strip (UI_DESIGN §4 S7). The S17 tabs (Files,
 * Editor, Private files, Artifacts) are joined by the S18 read-only live
 * views — Terminal and Browser sit after Editor in the S7 order — and by the
 * S21 tool history (the executor's redacted execution records), which closes
 * that line of the S7 list.
 */

export type WorkspaceTabId =
  "files" | "editor" | "terminal" | "browser" | "private" | "artifacts" | "tools";

export const WORKSPACE_TABS: ReadonlyArray<{ id: WorkspaceTabId; label: string }> = [
  { id: "files", label: "Files" },
  { id: "editor", label: "Editor" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "private", label: "Private files" },
  { id: "artifacts", label: "Artifacts" },
  { id: "tools", label: "Tool history" },
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
