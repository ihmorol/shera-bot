"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createApprovalMute,
  fetchApprovalDetail,
  fetchApprovalGrants,
  fetchApprovalMutes,
  fetchDueReminders,
  fetchPendingApprovals,
  muteTargetFor,
  revokeApprovalGrant,
  submitApprovalDecision,
  approvalsRefetchInterval,
  type ApprovalCardData,
  type ApprovalChoice,
} from "@/lib/approvals-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { useSessionIdentity } from "@/lib/container-connection";
import type { Actor } from "@shera-bot/contracts";

/**
 * S20 chunk 5 — the approvals data hooks (lib/operation-data.ts idiom): the
 * workspace's pending approvals, per-approval detail reads, the E3 due-
 * reminder scan, and the decision/mute/revoke mutations, through TanStack
 * Query over the same-origin runtime proxy.
 *
 * There is NO approval-event WebSocket fanout in this slice, so the reads POLL
 * on the app's established 5s cadence (presence, D32) and pause while the tab
 * is hidden — a decision made in another tab (or by another surface) lands on
 * the next visible tick. Cross-tab propagation is the poll, honestly stated.
 * Failures ARE states: no retry behind the user's back, no fixture fallback.
 */

export function safeApprovalsMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The workspace's pending D9 cards, polled on the presence cadence. */
export function usePendingApprovals(workspaceId: string): {
  approvals: ApprovalCardData[];
  loading: boolean;
  failed: boolean;
} {
  const query = useQuery({
    queryKey: ["approval-pending", workspaceId],
    queryFn: () => fetchPendingApprovals(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: () => approvalsRefetchInterval(),
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return {
    approvals: query.data ?? [],
    loading: query.isPending,
    failed: query.isError,
  };
}

/**
 * Each pending approval's detail read — the delivered reminder stamps and the
 * run state — polled on the same cadence while the approval pends. One query
 * per pending id (the prototype's pending set is tiny); a resolved approval's
 * detail query disables itself via the `enabled` gate.
 */
export function useApprovalDetails(
  workspaceId: string,
  approvalIds: readonly string[],
): Record<string, Awaited<ReturnType<typeof fetchApprovalDetail>> | undefined> {
  const queries = useQueries({
    queries: approvalIds.map((approvalId) => ({
      queryKey: ["approval-detail", workspaceId, approvalId],
      queryFn: () => fetchApprovalDetail(workspaceId, approvalId),
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: () => approvalsRefetchInterval(),
      refetchIntervalInBackground: false,
      staleTime: 0,
    })),
  });
  const details: Record<string, Awaited<ReturnType<typeof fetchApprovalDetail>>> = {};
  approvalIds.forEach((approvalId, index) => {
    const detail = queries[index]?.data;
    if (detail) {
      details[approvalId] = detail;
    }
  });
  return details;
}

/**
 * The E3 reminder scan: polling it IS the delivery mechanism — the runtime
 * stamps due slots delivered (or muted) server-side, and the card timelines
 * pick the stamps up from their detail reads. Never changes run state.
 */
export function useDueReminders(workspaceId: string): {
  reminders: Awaited<ReturnType<typeof fetchDueReminders>>;
  loading: boolean;
} {
  const query = useQuery({
    queryKey: ["approval-due-reminders", workspaceId],
    queryFn: () => fetchDueReminders(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: () => approvalsRefetchInterval(),
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return { reminders: query.data ?? [], loading: query.isPending };
}

/** The workspace's reminder mutes (the settings list read). */
export function useApprovalMutes(workspaceId: string): {
  mutes: Awaited<ReturnType<typeof fetchApprovalMutes>>;
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["approval-mutes", workspaceId],
    queryFn: () => fetchApprovalMutes(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (query.isPending) {
    return { mutes: [], state: "loading", safeErrorMessage: undefined, refetch: () => undefined };
  }
  if (query.isError) {
    return {
      mutes: [],
      state: "error",
      safeErrorMessage: safeApprovalsMessage(query.error, "The mutes list could not be loaded."),
      refetch: () => void query.refetch(),
    };
  }
  return { mutes: query.data, state: "ready", safeErrorMessage: undefined, refetch: () => void query.refetch() };
}

/** The workspace's ACTIVE grants (the settings list read). */
export function useApprovalGrants(workspaceId: string): {
  grants: Awaited<ReturnType<typeof fetchApprovalGrants>>;
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["approval-grants", workspaceId],
    queryFn: () => fetchApprovalGrants(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (query.isPending) {
    return { grants: [], state: "loading", safeErrorMessage: undefined, refetch: () => undefined };
  }
  if (query.isError) {
    return {
      grants: [],
      state: "error",
      safeErrorMessage: safeApprovalsMessage(query.error, "The grants list could not be loaded."),
      refetch: () => void query.refetch(),
    };
  }
  return { grants: query.data, state: "ready", safeErrorMessage: undefined, refetch: () => void query.refetch() };
}

// ---------------------------------------------------------------------------
// Mutations — every one invalidates the reads its effect touches, so the
// rendered state is the runtime's read-after-write truth (never optimistic).
// ---------------------------------------------------------------------------

/** One of the five decisions, posted with the USER actor (G6: only users decide). */
export function useApprovalDecision(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { approvalId: string; choice: ApprovalChoice; decidedBy: Actor }) =>
      submitApprovalDecision({
        workspaceId,
        approvalId: input.approvalId,
        choice: input.choice,
        decidedBy: input.decidedBy,
      }),
    onSuccess: () => {
      // The decision's effects (request status, run state, grants, mutes
      // untouched) land through the invalidated reads — including the OTHER
      // tabs' polls, which pick the same rows up on their next tick.
      void queryClient.invalidateQueries({ queryKey: ["approval-pending", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["approval-detail", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["approval-grants", workspaceId] });
    },
  });
}

/**
 * One reminder-silencing mute (E3: notifications only). The mutation sends
 * the session's user identity as the mute's `created_by` (F2); the web proxy
 * binds the same identity server-side, so the audit row is the session's
 * truth. The button is only reachable in a signed-in session.
 */
export function useApprovalsMute(workspaceId: string) {
  const queryClient = useQueryClient();
  const session = useSessionIdentity();
  return useMutation({
    mutationFn: (input: {
      scope: "approval" | "task" | "all";
      approval: Pick<ApprovalCardData, "approval_id" | "task_id">;
    }) =>
      createApprovalMute(
        workspaceId,
        muteTargetFor(input.scope, input.approval),
        { type: "user", id: session.data?.google_sub ?? "" },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approval-mutes", workspaceId] });
    },
  });
}

/** D9 grant revoke — the next execution consult re-refuses (AC26). */
export function useRevokeApprovalGrant(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => revokeApprovalGrant(workspaceId, grantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["approval-grants", workspaceId] });
    },
  });
}
