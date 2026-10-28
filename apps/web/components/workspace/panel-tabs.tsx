"use client";

import { ClipboardList, FolderLock, SquareCode } from "lucide-react";
import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/**
 * The workspace panel's tab strip and the honest "lands in the next build
 * increment" states (UI_DESIGN §4 S7, chunk-4 scope). This chunk ships the
 * Files tab for real; Editor, Private files, and Artifacts render DESIGNED
 * empty states — never a stub gray box, never fake content (G4).
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
}) {
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

const COMING_SOON_ICONS: Partial<Record<WorkspaceTabId, typeof SquareCode>> = {
  editor: SquareCode,
  private: FolderLock,
  artifacts: ClipboardList,
};

/**
 * The not-yet tab state: a designed surface with the tab's own identity and
 * one honest line — the panel grows tab by tab, and the interface says so in
 * product language instead of a stub box or fake content (G4).
 */
export function TabComingSoon({ tabLabel }: { tabLabel: string }): ReactElement {
  const tab = WORKSPACE_TABS.find((candidate) => candidate.label === tabLabel);
  const Icon = (tab ? COMING_SOON_ICONS[tab.id] : undefined) ?? SquareCode;
  const description = tab ? (TAB_COMING_SOON_DESCRIPTION[tab.id] ?? null) : null;
  return (
    <div
      data-testid="tab-coming-soon"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
        <Icon className="size-5 text-sky" aria-hidden="true" />
      </div>
      <div>
        <h3 className="font-display text-base font-semibold tracking-tight text-text">
          {tabLabel}
        </h3>
        <p className="mx-auto mt-1.5 max-w-[38ch] text-sm text-muted">
          The {tabLabel.toLowerCase()} view lands in the next build increment.
          {description ? ` ${description}` : ""}
        </p>
      </div>
    </div>
  );
}

const TAB_COMING_SOON_DESCRIPTION: Partial<Record<WorkspaceTabId, string>> = {
  editor: "Direct file editing, with the write lease guarding every save.",
  private: "Each Agent's private folder, labeled private and kept that way.",
  artifacts: "Run outputs with their producer and provenance, ready to download.",
};
