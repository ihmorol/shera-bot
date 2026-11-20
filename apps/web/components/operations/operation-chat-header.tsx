"use client";

import { Pencil, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Operation definition strip (D52 wave B, E43 idea 2 — the deliverable
 * is a Pack → Operations → Agents definition strip): ONE line under the
 * Operation header that teaches the hierarchy from the runtime's own read
 * model (G4 — basis-anchored, never invented): "Operation — {pack_id} pack
 * · {N} Agents · {N_runs} runs so far — each run keeps its own task,
 * events, and cost." With zero runs it states the rule over the real pack
 * and roster and invents no run count; before the read model lands it
 * renders nothing at all rather than inventing a basis. The leading word is
 * the mono uppercase eyebrow (UI_DESIGN §2.1); the sentence is body type,
 * muted, one line. It renders in BOTH interface modes — it teaches where
 * users are.
 */
export function OperationDefinitionStrip({
  packId,
  agentCount,
  runCount,
}: {
  packId: string | null;
  agentCount: number | null;
  runCount: number;
}) {
  if (packId === null || agentCount === null) {
    // G4: the strip teaches from the runtime's own counts — with no read
    // model yet it renders nothing rather than inventing a basis.
    return null;
  }
  const agentWord = agentCount === 1 ? "Agent" : "Agents";
  const body =
    runCount > 0
      ? `${packId} pack · ${agentCount} ${agentWord} · ${runCount} ${runCount === 1 ? "run" : "runs"} so far — each run keeps its own task, events, and cost.`
      : `${packId} pack · ${agentCount} ${agentWord} — every run keeps its own task, events, and cost.`;
  return (
    <div data-testid="operation-definition-strip" className="shrink-0 bg-surface px-4 lg:px-6">
      <p className="flex min-w-0 items-baseline gap-1.5 py-2 text-sm text-muted">
        <span className="shrink-0 font-mono text-xs uppercase tracking-[0.16em]">Operation</span>
        <span className="min-w-0 truncate">— {body}</span>
      </p>
    </div>
  );
}

/**
 * The Operation chat header (UI_DESIGN §S4 + S14, D41): the title with the
 * ad-hoc identity — a small "Ad-hoc" tag for definition-less Operations, and
 * the auto-label name rendered muted/italic (a DERIVED label, never styled
 * like user-authored text) — plus the rename affordance. The rename is the
 * user-owned name write from S14 (D41/D23 rule 6): idle shows an edit action;
 * the editing state is prop-driven so the parent owns the draft, and the
 * runtime's typed validation failures render verbatim as safe copy (D23
 * rule 4 — never raw internals).
 *
 * D52 wave B (E43 idea 8): the "+ New run" affordance lives in the header
 * beside the run count, not buried in the thread. Audit (2026-11-21): the
 * runtime has NO admission rule forbidding a second concurrent run —
 * POST /v1/operations/:id/runs and OperationsService.createRun create a
 * CREATED-state run unconditionally once the Operation exists — so the
 * affordance is NOT client-disabled on a guessed rule (G2): the runtime
 * validates the create on submit and a typed refusal renders as safe copy.
 * The title reflects runtime authority, never "I will start".
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
  onCreateRun,
  createPending = false,
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
  /** The wired create-run command; absent where no real surface backs it. */
  onCreateRun?: () => void;
  createPending?: boolean;
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
      {onCreateRun ? (
        <Button
          variant="outline"
          size="sm"
          aria-label="New run"
          className="shrink-0"
          disabled={createPending}
          title={createPending ? "The runtime is starting the run" : "The runtime starts the run"}
          onClick={onCreateRun}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          New run
        </Button>
      ) : null}
    </header>
  );
}
