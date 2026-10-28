"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { BellOff, Loader2, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";

import { RiskBadge } from "@/components/chat/cards";
import { Button } from "@/components/ui/button";
import type { AgentRosterSummary } from "@/lib/agent-api";
import {
  APPROVAL_CHOICE_LABELS,
  APPROVAL_CHOICE_ORDER,
  digestFingerprint,
  formatExpiry,
  formatResolution,
  reminderSlots,
  utcTimeLabel,
  type ApprovalCardData,
  type ApprovalRunReadModel,
  type ReminderSlotRow,
} from "@/lib/approvals-api";
import { cn } from "@/lib/utils";

/**
 * The in-thread approval card + the five-choice decision modal (UI_DESIGN §S8,
 * D9, PRD §8) — the product's safety centerpiece. Copy discipline:
 *
 * - The five choice labels are VERBATIM PRD §8 (UI_DESIGN §7: do not paraphrase
 *   safety copy) and appear in the contract's order.
 * - The card shows exactly the D9 vocabulary the S20 API answers: exact tool +
 *   version, capability, target resource, side effect, the arguments DIGEST
 *   (raw arguments never render — G3), risk class, the requesting Agent, the
 *   task/conversation scope, the expiry slot, and the E3 reminder timeline
 *   whose delivered markers come only from the runtime's stamps.
 * - Mutes are notifications-only (E3): the copy says so — the task stays
 *   paused and the approval stays visible.
 * - The UI never implies an Agent can approve (G6): only the user decides,
 *   through the modal, which posts the user actor.
 *
 * Presentational only: data and callbacks arrive from the pending-approvals
 * region (lib/approvals-data.ts), which owns the polls and the mutations.
 */

/** The muted-slot label's sr text: a muted slot is quieter, not gone. */
const MUTE_NOTE =
  "Mutes stop reminder notifications only — the task stays paused and this approval stays visible.";

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-x-3 gap-y-0.5 max-sm:flex-col">
      <dt className="w-28 shrink-0 font-mono text-[11px] uppercase tracking-[0.16em] text-muted max-sm:w-auto">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-sm text-text">{children}</dd>
    </div>
  );
}

function ReminderTimeline({ slots }: { slots: ReturnType<typeof reminderSlots> }) {
  return (
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Reminders</p>
      <ol className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {slots.map((slot) => {
          const delivered = slot.deliveredAt !== null;
          return (
            <li key={slot.index} className="flex items-center gap-1.5 font-mono text-[11px]">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  delivered ? "bg-approval" : "border border-line",
                )}
              />
              <span className={delivered ? "text-approval" : "text-muted"}>{slot.label}</span>
              <span className="text-muted">{slot.dueLabel}</span>
              {delivered ? (
                <span className="text-muted">
                  delivered
                  <span className="sr-only"> — reminder {slot.index + 1} of 5 was delivered</span>
                </span>
              ) : (
                <span className="sr-only">
                  reminder {slot.index + 1} of 5, due {slot.dueLabel} UTC, not yet delivered
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="sr-only">
        The reminder sequence is immediate, 15 minutes, 45 minutes, 3 hours, 24 hours — none after.
      </p>
    </div>
  );
}

export function ApprovalCard({
  approval,
  identities,
  reminders,
  onReview,
  onMute,
  reviewPending,
  mutePending,
}: {
  approval: ApprovalCardData;
  /** Workspace roster identities for resolving the requesting Agent's name. */
  identities: AgentRosterSummary[];
  /** The detail read's reminder rows when available (delivered markers). */
  reminders?: ReminderSlotRow[] | undefined;
  /** Decision + mute affordances: pending cards only (resolved cards stay quiet). */
  onReview?: () => void;
  onMute?: (scope: "approval" | "task" | "all") => void;
  reviewPending?: boolean;
  mutePending?: boolean;
}) {
  const pending = approval.status === "pending";
  const requesterName =
    approval.requested_by.type === "agent"
      ? (identities.find((identity) => identity.agent_id === approval.requested_by.id)
          ?.display_name ?? approval.requested_by.id)
      : approval.requested_by.id;
  const resolution = formatResolution(approval);
  const slots = reminderSlots(approval.requested_at, reminders);

  return (
    <article
      aria-live={pending ? "assertive" : undefined}
      aria-atomic={pending || undefined}
      data-approval-id={approval.approval_id}
      data-approval-status={approval.status}
      className={cn(
        "w-full max-w-xl rounded-xl border bg-surface p-4",
        pending
          ? "border-approval/40 shadow-lg shadow-canvas/50"
          : "border-line shadow-sm shadow-canvas/40",
      )}
    >
      <header className="flex items-start gap-2.5">
        {pending ? (
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-approval" aria-hidden="true" />
        ) : (
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="truncate font-mono text-sm text-text">{approval.tool_id}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted">
              v{approval.tool_version}
            </span>
            <RiskBadge riskClass={approval.risk_class} />
          </div>
          <p
            className={cn(
              "mt-0.5 font-mono text-[11px] uppercase tracking-[0.08em]",
              pending ? "text-approval" : "text-muted",
            )}
          >
            {pending ? "Pausing for your approval" : "Decision recorded"}
            <span className="sr-only">
              {pending
                ? " — the task run is paused until you decide. Only you can decide; Agents cannot approve."
                : undefined}
            </span>
          </p>
        </div>
      </header>

      <p className="mt-3 text-sm text-text">{approval.side_effect_summary}</p>

      <dl className="mt-3 space-y-1.5">
        <FieldRow label="Requested by">
          <span>{requesterName}</span>
        </FieldRow>
        <FieldRow label="Capability">
          <span className="font-mono text-[13px]">{approval.capability}</span>
        </FieldRow>
        <FieldRow label="Target">
          <span className="break-all font-mono text-[13px]">{approval.resource_scope}</span>
        </FieldRow>
        <FieldRow label="Task scope">
          <span className="break-all font-mono text-[13px]">{approval.task_id}</span>
        </FieldRow>
        <FieldRow label="Conversation">
          <span className="break-all font-mono text-[13px]">{approval.conversation_id}</span>
        </FieldRow>
        <FieldRow label="Arguments">
          <span className="font-mono text-[13px]">
            digest {digestFingerprint(approval.args_digest)}…
          </span>
          <span className="text-muted"> — raw arguments are not stored</span>
        </FieldRow>
        <FieldRow label="Requested">
          <span className="font-mono text-[13px]">{utcTimeLabel(approval.requested_at)} UTC</span>
        </FieldRow>
        <FieldRow label="Expiry">
          <span>{formatExpiry(approval.expires_at)}</span>
        </FieldRow>
      </dl>

      <div className="mt-3 border-t border-line pt-3">
        <ReminderTimeline slots={slots} />
      </div>

      {pending ? (
        <Fragment>
          <div className="mt-3 border-t border-line pt-3">
            <p className="flex flex-wrap items-center gap-1.5">
              <BellOff className="size-3.5 text-muted" aria-hidden="true" />
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Mute reminders
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutePending}
                  onClick={() => onMute?.("approval")}
                >
                  Mute this approval
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutePending}
                  onClick={() => onMute?.("task")}
                >
                  Mute this task
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={mutePending}
                  onClick={() => onMute?.("all")}
                >
                  Mute all reminders
                </Button>
              </span>
            </p>
            <p className="mt-1.5 text-[13px] text-muted">{MUTE_NOTE}</p>
          </div>

          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <Button onClick={onReview} disabled={reviewPending}>
              Review decision
            </Button>
            <p className="text-[13px] text-muted">The run stays paused until you decide.</p>
          </div>
        </Fragment>
      ) : (
        <p className="mt-3 border-t border-line pt-3 text-sm text-muted">{resolution}</p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The decision modal
// ---------------------------------------------------------------------------

/**
 * The decision PANEL — everything inside the dialog box, presentational so
 * the five-choice contract is directly testable in the node suites. The
 * Radix wrapper (ApprovalDecisionModal) supplies the modal semantics: the
 * focus trap, Escape-to-close, aria-modal, and the portal (§2.3).
 *
 * Focus contract (§2.3 "the approval choices are the only initially-focusable
 * actions"): the first choice carries `data-autofocus` (the wrapper focuses it
 * on open, having redirected Radix's default), and the panel's only other
 * affordance — close — is out of the initial tab order (tabIndex -1). Enter
 * activates the focused choice natively; Escape closes via Radix.
 */
export function ApprovalDecisionContent({
  approval,
  identities,
  run,
  onChoose,
  onDismiss,
  chosenChoice,
  pending,
  safeErrorMessage,
}: {
  approval: ApprovalCardData;
  identities: AgentRosterSummary[];
  run: ApprovalRunReadModel | null;
  onChoose: (choice: (typeof APPROVAL_CHOICE_ORDER)[number]) => void;
  /** The wrapper's close path (Radix onOpenChange(false)); Escape also closes. */
  onDismiss: () => void;
  chosenChoice: string | null;
  pending: boolean;
  safeErrorMessage: string | null;
}) {
  const requesterName =
    approval.requested_by.type === "agent"
      ? (identities.find((identity) => identity.agent_id === approval.requested_by.id)
          ?.display_name ?? approval.requested_by.id)
      : approval.requested_by.id;
  const announcement = `Approval requested: ${requesterName} asks to run ${approval.tool_id} version ${approval.tool_version} — ${approval.side_effect_summary} The task is paused until you decide.`;
  const titleId = `approval-decision-title-${approval.approval_id}`;
  const descriptionId = `approval-decision-description-${approval.approval_id}`;

  // §2.3 focus contract: the FIRST CHOICE takes initial focus. This effect
  // lives HERE — inside the dialog content — because Radix's portal mounts
  // one commit after its wrapper (the SSR-safe mount gate); a wrapper-level
  // effect runs before the dialog exists and would silently no-op.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, []);

  return (
    <div ref={panelRef} className="relative">
      <h2 id={titleId} className="font-display text-lg font-semibold tracking-tight text-text">
        Approval required
      </h2>
      <p id={descriptionId} className="mt-1 text-sm text-muted">
        {requesterName} asks to run{" "}
        <span className="font-mono text-[13px] text-text">
          {approval.tool_id} v{approval.tool_version}
        </span>
        . Decide below — the run stays paused until you do.
      </p>
      {/* §2.3: tool/approval events announce assertively — the request does too. */}
      <p className="sr-only" aria-live="assertive">
        {announcement}
      </p>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        onClick={onDismiss}
        className="absolute right-0 top-0 rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-text"
      >
        <X className="size-4" aria-hidden="true" />
      </button>

      <div className="mt-4 space-y-1.5 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm text-text">{approval.side_effect_summary}</p>
        <p className="font-mono text-[11px] text-muted">
          {approval.capability} · {approval.resource_scope}
        </p>
        {run ? (
          <p className="flex items-center gap-1.5 font-mono text-[11px] text-approval">
            <span className="size-1.5 rounded-full bg-approval" aria-hidden="true" />
            Task state {run.state}
            <span className="sr-only">— the task is paused for your decision</span>
          </p>
        ) : null}
      </div>

      {safeErrorMessage ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-failed">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {safeErrorMessage}
        </p>
      ) : null}

      <div
        role="group"
        aria-label="The five approval choices"
        aria-busy={pending || undefined}
        className="mt-4 flex flex-col gap-2"
      >
        {APPROVAL_CHOICE_ORDER.map((choice, index) => {
          const isChosen = chosenChoice === choice;
          const label = APPROVAL_CHOICE_LABELS[choice];
          const danger = choice === "reject-this-action";
          const quiet = choice === "cancel-the-task";
          return (
            <Button
              key={choice}
              variant={danger || quiet ? "outline" : index === 0 ? "default" : "outline"}
              className={cn(
                "h-11 justify-start",
                danger && "border-failed/40 text-failed hover:border-failed hover:bg-surface",
                quiet && "text-muted",
              )}
              data-autofocus={index === 0 ? "true" : undefined}
              disabled={pending}
              onClick={() => onChoose(choice)}
            >
              {isChosen ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {/* The label stays verbatim in every state — the spinner, not
                  the copy, carries the recording state. */}
              {label}
            </Button>
          );
        })}
      </div>
      <p className="mt-3 text-[13px] text-muted">
        Approve choices create a visible, revocable grant in Settings → Permissions &amp; approvals.
        Only you can decide — Agents cannot.
      </p>
    </div>
  );
}

/**
 * The Radix dialog wrapper — the modal semantics live here (the sheet.tsx
 * precedent): the portal, the focus trap, Escape-to-close, and the entrance
 * animation (the token layer's one authored moment for the safety
 * centerpiece). Radix's default open-focus is redirected so the FIRST CHOICE
 * takes initial focus (§2.3), not the dialog container.
 */
export function ApprovalDecisionModal({
  approval,
  identities,
  run,
  open,
  onOpenChange,
  onChoose,
  chosenChoice,
  pending,
  safeErrorMessage,
}: {
  approval: ApprovalCardData;
  identities: AgentRosterSummary[];
  run: ApprovalRunReadModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChoose: (choice: (typeof APPROVAL_CHOICE_ORDER)[number]) => void;
  chosenChoice: string | null;
  pending: boolean;
  safeErrorMessage: string | null;
}) {
  const titleId = `approval-decision-title-${approval.approval_id}`;
  const descriptionId = `approval-decision-description-${approval.approval_id}`;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="animate-overlay-in fixed inset-0 z-50 bg-canvas/70 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-live="assertive"
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="animate-dialog-in fixed inset-x-0 top-[8vh] z-50 mx-auto max-h-[80vh] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface-elevated p-5 shadow-2xl shadow-canvas/60"
        >
          <ApprovalDecisionContent
            approval={approval}
            identities={identities}
            run={run}
            onChoose={onChoose}
            onDismiss={() => onOpenChange(false)}
            chosenChoice={chosenChoice}
            pending={pending}
            safeErrorMessage={safeErrorMessage}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
