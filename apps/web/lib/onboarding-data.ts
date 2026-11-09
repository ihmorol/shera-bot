"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  fetchOnboarding,
  submitOnboardingCommand,
  type OnboardingSnapshotView,
} from "@/lib/onboarding-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import type { OnboardingCommand } from "@shera-bot/contracts";
import { broadcastTabEvent, openTabSyncChannel, subscribeTabEvents } from "@/lib/tab-sync";

/**
 * S30 — the onboarding data hooks (the notifications-data idiom): the
 * resumable D16 snapshot and the typed commands (answer / dismiss / reopen)
 * over the same-origin proxy. A settled command broadcasts the settings
 * hint so other tabs re-read immediately (the hint layer under the server
 * truth — the poll/refetch remains the convergence mechanism).
 */

export function safeOnboardingMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

/** The resumable interview snapshot (the runtime's own state). */
export function useOnboarding(workspaceId: string | null): {
  snapshot: OnboardingSnapshotView | undefined;
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["onboarding", workspaceId],
    queryFn: () => fetchOnboarding(workspaceId as string),
    enabled: workspaceId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (query.isPending || !workspaceId) {
    return {
      snapshot: undefined,
      state: "loading",
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (query.isError) {
    return {
      snapshot: undefined,
      state: "error",
      safeErrorMessage: safeOnboardingMessage(
        query.error,
        "The onboarding state could not be loaded.",
      ),
      refetch: () => void query.refetch(),
    };
  }
  return {
    snapshot: query.data,
    state: "ready",
    safeErrorMessage: undefined,
    refetch: () => void query.refetch(),
  };
}

/**
 * The receiving side of the settings half of the hint vocabulary (the review
 * round's P3 — `settings-changed` was broadcast here but no surface
 * subscribed): another tab's settled onboarding/settings command (the D16
 * shared surface — the memory briefing's choice is a memory change too)
 * invalidates THIS tab's onboarding and memory reads immediately. The
 * poll/refetch remains the truth; the hint only removes the wait. A tab
 * never hears itself (BroadcastChannel does not echo), so the broadcaster in
 * useOnboardingCommands never self-invalidates. Never carries content; the
 * re-read answers from the runtime.
 */
export function useTabSyncSettings(workspaceId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const channel = openTabSyncChannel();
    const unsubscribe = subscribeTabEvents(channel, (event) => {
      if (event.kind === "settings-changed") {
        void queryClient.invalidateQueries({ queryKey: ["onboarding", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
      }
    });
    return () => {
      unsubscribe();
      channel?.close();
    };
  }, [queryClient, workspaceId]);
}

export interface OnboardingCommands {
  submit: (command: OnboardingCommand) => void;
  submitReopen: () => void;
  submitDismiss: () => void;
  pending: boolean;
  state: "loading" | "ready" | "error";
  safeError: string | undefined;
  snapshot: OnboardingSnapshotView | undefined;
  refetch: () => void;
}

/**
 * The typed commands envelope with the refetch-after-write (the runtime's
 * snapshot is the truth — never an optimistic guess) and the cross-tab hint.
 */
export function useOnboardingCommands(workspaceId: string | null): OnboardingCommands {
  const queryClient = useQueryClient();
  const snapshot = useOnboarding(workspaceId);
  // Every consumer of the onboarding commands also RECEIVES the settings
  // hints (the vocabulary's subscriber half lives with its broadcaster).
  useTabSyncSettings(workspaceId);

  const mutation = useMutation({
    mutationFn: (command: OnboardingCommand) =>
      submitOnboardingCommand(workspaceId as string, command),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["onboarding", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
      // D16: onboarding and settings share commands — a memory choice here
      // changed the settings surface's data too. The hint reaches other tabs
      // (a short-lived channel per hint — stateless, no refs).
      const channel = openTabSyncChannel();
      broadcastTabEvent(channel, { kind: "settings-changed", section: "onboarding" });
      channel?.close();
    },
  });

  return {
    submit: (command: OnboardingCommand) => {
      mutation.mutate(command);
    },
    submitReopen: () => {
      if (!workspaceId) return;
      mutation.mutate({
        command_id: `cmd_${crypto.randomUUID()}`,
        idempotency_key: `idem_${crypto.randomUUID()}`,
        workspace_id: workspaceId,
        actor: { type: "user", id: "" },
        issued_at: new Date().toISOString(),
        type: "onboarding.reopen",
      });
    },
    submitDismiss: () => {
      if (!workspaceId) return;
      mutation.mutate({
        command_id: `cmd_${crypto.randomUUID()}`,
        idempotency_key: `idem_${crypto.randomUUID()}`,
        workspace_id: workspaceId,
        actor: { type: "user", id: "" },
        issued_at: new Date().toISOString(),
        type: "onboarding.dismiss",
      });
    },
    pending: mutation.isPending,
    state: snapshot.state,
    safeError: mutation.isError
      ? safeOnboardingMessage(mutation.error, "The onboarding command was not accepted.")
      : snapshot.safeErrorMessage,
    snapshot: snapshot.snapshot,
    refetch: snapshot.refetch,
  };
}
