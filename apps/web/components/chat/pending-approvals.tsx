"use client";

import { useState } from "react";

import { ApprovalCard, ApprovalDecisionModal } from "@/components/chat/approval-card";
import { useAgentRoster as useWorkspaceRoster } from "@/lib/agent-data";
import type { AgentRosterSummary } from "@/lib/agent-api";
import type {
  ApprovalCardData,
  ApprovalChoice,
  ApprovalRunReadModel,
  ReminderSlotRow,
} from "@/lib/approvals-api";
import {
  safeApprovalsMessage,
  useApprovalDecision,
  useApprovalDetails,
  useApprovalsMute,
  useDueReminders,
  usePendingApprovals,
} from "@/lib/approvals-data";
import { useSessionIdentity } from "@/lib/container-connection";

/**
 * The in-thread pending approvals region (UI_DESIGN §S8): the workspace's
 * pending D9 cards rendered in the chat message flow, plus the E3 reminder
 * scan poll. Owns the decision modal and the mute commands; the polls run on
 * the app's 5s cadence (lib/approvals-data.ts) and pause while the tab is
 * hidden — a decision made in another tab resolves the card here on the next
 * visible tick (cross-tab propagation is the poll, honestly stated).
 *
 * With nothing pending the region renders NOTHING: an empty approvals region
 * is the absence of a pause, not a data surface that owes an empty state (G4).
 */

/** The honest quiet line for surfaces that show the region's scope. */
export const pendingApprovalsEmptyNotice =
  "No approvals are waiting — risky work runs only after you decide.";

export interface PendingApprovalsRowsProps {
  approvals: ApprovalCardData[];
  /** Decisions settled THIS session — rendered as their quiet resolved cards. */
  resolvedLocally: ApprovalCardData[];
  remindersByApproval: Record<string, ReminderSlotRow[] | undefined>;
  runByApproval: Record<string, ApprovalRunReadModel | undefined>;
  identities: AgentRosterSummary[];
  /** Whether the deciding user actor (the session's google_sub) is loaded. */
  decidedByReady: boolean;
  openApprovalId: string | null;
  chosenChoice: ApprovalChoice | null;
  decisionPending: boolean;
  decisionSafeError: string | null;
  mutePending: boolean;
  onOpenChange: (open: boolean, approvalId: string | null) => void;
  onChoose: (approvalId: string, choice: ApprovalChoice) => void;
  onMute: (approval: ApprovalCardData, scope: "approval" | "task" | "all") => void;
}

/** Presentational: one card row per pending approval + the open decision modal. */
export function PendingApprovalsRows({
  approvals,
  resolvedLocally,
  remindersByApproval,
  runByApproval,
  identities,
  decidedByReady,
  openApprovalId,
  chosenChoice,
  decisionPending,
  decisionSafeError,
  mutePending,
  onOpenChange,
  onChoose,
  onMute,
}: PendingApprovalsRowsProps) {
  const openApproval = approvals.find((approval) => approval.approval_id === openApprovalId) ?? null;

  return (
    <>
      {approvals.map((approval) => (
        <li key={approval.approval_id} className="flex justify-start">
          <ApprovalCard
            approval={approval}
            identities={identities}
            reminders={remindersByApproval[approval.approval_id]}
            reviewPending={decisionPending}
            mutePending={mutePending}
            onReview={() => onOpenChange(true, approval.approval_id)}
            onMute={(scope) => onMute(approval, scope)}
          />
        </li>
      ))}
      {resolvedLocally.map((approval) => (
        <li key={approval.approval_id} className="flex justify-start">
          <ApprovalCard approval={approval} identities={identities} />
        </li>
      ))}
      {openApproval ? (
        <ApprovalDecisionModal
          approval={openApproval}
          identities={identities}
          run={runByApproval[openApproval.approval_id] ?? null}
          open={openApprovalId !== null}
          onOpenChange={(open) => onOpenChange(open, open ? openApproval.approval_id : null)}
          onChoose={(choice) => onChoose(openApproval.approval_id, choice)}
          chosenChoice={chosenChoice}
          // The choices wait for the deciding actor too: a decision never
          // posts without its user identity (G6), even briefly.
          pending={decisionPending || !decidedByReady}
          safeErrorMessage={decisionSafeError}
        />
      ) : null}
    </>
  );
}

/** The runtime chat mount: polls + commands over the presentational rows. */
export function PendingApprovals({ workspaceId }: { workspaceId: string }) {
  const pending = usePendingApprovals(workspaceId);
  const details = useApprovalDetails(
    workspaceId,
    pending.approvals.map((approval) => approval.approval_id),
  );
  // The E3 scan: polling it stamps due reminders server-side; the detail
  // reads above pick the delivered markers up on their next tick.
  useDueReminders(workspaceId);
  const session = useSessionIdentity();
  const roster = useWorkspaceRoster(workspaceId);
  const decision = useApprovalDecision(workspaceId);
  const mute = useApprovalsMute(workspaceId);

  const [openApprovalId, setOpenApprovalId] = useState<string | null>(null);
  const [chosenChoice, setChosenChoice] = useState<ApprovalChoice | null>(null);
  const [decisionSafeError, setDecisionSafeError] = useState<string | null>(null);
  // Decisions settled in THIS tab keep their quiet resolved cards in the
  // thread (the decision response carries the resolved request). A decision
  // made in ANOTHER tab propagates through the poll: the pending list simply
  // stops returning the card (its status moved off pending) — the same
  // read-after-write truth, no local invention.
  const [resolvedLocally, setResolvedLocally] = useState<ApprovalCardData[]>([]);

  const decidedByReady = session.data !== undefined;

  return (
    <PendingApprovalsRows
      approvals={pending.approvals}
      resolvedLocally={resolvedLocally}
      remindersByApproval={Object.fromEntries(
        Object.entries(details).map(([approvalId, detail]) => [
          approvalId,
          detail?.reminders as ReminderSlotRow[] | undefined,
        ]),
      )}
      runByApproval={Object.fromEntries(
        Object.entries(details).map(([approvalId, detail]) => [
          approvalId,
          detail?.run as ApprovalRunReadModel | undefined,
        ]),
      )}
      identities={roster.agents}
      decidedByReady={decidedByReady}
      openApprovalId={openApprovalId}
      chosenChoice={chosenChoice}
      decisionPending={decision.isPending}
      decisionSafeError={decisionSafeError}
      mutePending={mute.isPending}
      onOpenChange={(open, approvalId) => {
        if (!open) {
          setOpenApprovalId(null);
          setChosenChoice(null);
          setDecisionSafeError(null);
          return;
        }
        setDecisionSafeError(null);
        setChosenChoice(null);
        setOpenApprovalId(approvalId);
      }}
      onChoose={(approvalId, choice) => {
        if (!decidedByReady || decision.isPending) {
          return;
        }
        setChosenChoice(choice);
        setDecisionSafeError(null);
        decision.mutate(
          {
            approvalId,
            choice,
            decidedBy: { type: "user", id: session.data?.google_sub ?? "" },
          },
          {
            onSuccess: (outcome) => {
              // Terminal or already_decided alike: the response's request IS
              // the stored resolution — keep the quiet card, close the modal.
              // already_decided (a raced decision in another tab) resolves
              // exactly the same way, honestly, with the STORED choice.
              setResolvedLocally((resolved) =>
                resolved.some((entry) => entry.approval_id === outcome.request.approval_id)
                  ? resolved
                  : [...resolved, outcome.request],
              );
              setOpenApprovalId(null);
              setChosenChoice(null);
              setDecisionSafeError(null);
            },
            onError: (error) => {
              setDecisionSafeError(
                safeApprovalsMessage(error, "The decision was not accepted. Try again."),
              );
              setChosenChoice(null);
            },
          },
        );
      }}
      onMute={(approval, scope) => {
        mute.mutate({ scope, approval });
      }}
    />
  );
}
