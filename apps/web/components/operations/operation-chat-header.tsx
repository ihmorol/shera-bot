"use client";

import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Operation chat header (UI_DESIGN §S4 + S14, D41): the title with the
 * ad-hoc identity — a small "Ad-hoc" tag for definition-less Operations, and
 * the auto-label name rendered muted/italic (a DERIVED label, never styled
 * like user-authored text) — plus the rename affordance. The rename is the
 * user-owned name write from S14 (D41/D23 rule 6): idle shows an edit action;
 * the editing state is prop-driven so the parent owns the draft, and the
 * runtime's typed validation failures render verbatim as safe copy (D23
 * rule 4 — never raw internals).
 */
export function OperationChatHeader({
  name,
  isAdhoc,
  autoLabel,
  packLabel,
  runCount,
  renameEditing,
  renameDraft,
  renamePending,
  renameErrorMessage,
  onRenameStart,
  onRenameCancel,
  onRenameDraftChange,
  onRenameSubmit,
}: {
  name: string;
  /** S14: the Operation has no pack definition behind it (D41). */
  isAdhoc: boolean;
  /** S14: the current name is the server-derived `Ad-hoc · N Agents` label. */
  autoLabel: boolean;
  /** The pinned pack label ("student v1.0.0"), or null before the record loads. */
  packLabel: string | null;
  runCount: number;
  renameEditing: boolean;
  renameDraft: string;
  renamePending: boolean;
  /** The rename command's typed failure, as its safe message. */
  renameErrorMessage: string | null;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameDraftChange: (value: string) => void;
  onRenameSubmit: () => void;
}) {
  const validDraft = renameDraft.trim().length > 0;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 lg:px-6">
      <div className="min-w-0 flex-1">
        {renameEditing ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Operation name"
              value={renameDraft}
              onChange={(event) => onRenameDraftChange(event.target.value)}
              maxLength={120}
              autoFocus
              disabled={renamePending}
              className="w-64 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-text"
            />
            <Button
              size="sm"
              aria-label="Save name"
              disabled={!validDraft || renamePending}
              onClick={onRenameSubmit}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Cancel rename"
              disabled={renamePending}
              onClick={onRenameCancel}
            >
              Cancel
            </Button>
            {renameErrorMessage ? (
              <p
                role="alert"
                className="rounded-lg border border-line bg-surface-elevated px-2 py-1 text-xs text-text"
              >
                {renameErrorMessage}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <h1
              data-testid={autoLabel ? "operation-auto-label" : undefined}
              className={cn(
                "min-w-0 truncate font-display text-lg font-semibold tracking-tight",
                autoLabel ? "font-normal italic text-muted" : "text-text",
              )}
            >
              {name}
            </h1>
            {isAdhoc ? (
              <span
                title="Created without a pack definition"
                className="shrink-0 rounded-full border border-line px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.08em] text-muted"
              >
                Ad-hoc
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Rename Operation"
              className="size-7 shrink-0"
              onClick={onRenameStart}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        )}
        <p className="truncate font-mono text-xs tracking-[0.08em] text-muted">
          {packLabel
            ? `pack ${packLabel} · ${runCount} ${runCount === 1 ? "run" : "runs"}`
            : "Operation chat"}
        </p>
      </div>
    </header>
  );
}
