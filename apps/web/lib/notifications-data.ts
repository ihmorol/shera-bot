"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  fetchNotificationSettings,
  fetchNotifications,
  submitNotificationCommand,
  type NotificationSettings,
} from "@/lib/notifications-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import type { NotificationCommand } from "@shera-bot/contracts";
import type { NotificationView } from "@shera-bot/contracts";
import { broadcastTabEvent, openTabSyncChannel, subscribeTabEvents } from "@/lib/tab-sync";

/**
 * S30 — the notification center data hooks (the approvals-data idiom). The
 * rows POLL on the app's 5s presence cadence and the poll CONTINUES while
 * the tab is hidden (refetchIntervalInBackground) — the poll IS the delivery
 * mechanism: an arrival the tab cannot see is a browser notification it
 * never fires. Every mutation invalidates the reads its effect touches, so
 * the rendered state is the runtime's read-after-write truth. Cross-tab
 * convergence layers the S30 BroadcastChannel hint under this server truth
 * (the poll converges regardless; the hint only makes it immediate).
 */

export function safeNotificationsMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

/**
 * The derived center rows (the runtime's own records). `workspaceId: null`
 * disables the read (the pre-container states never fabricate rows, G4).
 */
export function useNotifications(workspaceId: string | null): {
  rows: NotificationView[];
  loading: boolean;
  failed: boolean;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["notifications", workspaceId],
    queryFn: () => fetchNotifications(workspaceId as string),
    enabled: workspaceId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    // The delivery cadence: arrivals must be seen while the tab is hidden
    // (the browser-notification trigger reads this query's data).
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  if (query.isPending || query.isError || !workspaceId) {
    return {
      rows: query.data ?? [],
      loading: query.isPending,
      failed: query.isError,
      safeErrorMessage: query.isError
        ? safeNotificationsMessage(query.error, "The notifications could not be loaded.")
        : undefined,
      refetch: () => void query.refetch(),
    };
  }
  return {
    rows: query.data ?? [],
    loading: false,
    failed: false,
    safeErrorMessage: undefined,
    refetch: () => void query.refetch(),
  };
}

/** The delivery toggles (PRD §14) with the recommended defaults (D16). */
export function useNotificationSettings(workspaceId: string | null): {
  settings: NotificationSettings | undefined;
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["notification-settings", workspaceId],
    queryFn: () => fetchNotificationSettings(workspaceId as string),
    enabled: workspaceId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (query.isPending || !workspaceId) {
    return {
      settings: undefined,
      state: "loading",
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (query.isError) {
    return {
      settings: undefined,
      state: "error",
      safeErrorMessage: safeNotificationsMessage(
        query.error,
        "The notification settings could not be loaded.",
      ),
      refetch: () => void query.refetch(),
    };
  }
  return {
    settings: query.data,
    state: "ready",
    safeErrorMessage: undefined,
    refetch: () => void query.refetch(),
  };
}

/**
 * The typed commands envelope (mark_read / mute / set_settings /
 * reset_settings) with the read invalidations. A mute on an approval item
 * creates the S20 approval-scope mute through the runtime (E3) — the
 * invalidations therefore cover the approvals reads too.
 */
export function useNotificationCommands(workspaceId: string | null): {
  submit: (command: NotificationCommand) => void;
  pending: boolean;
  safeError: string | undefined;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (command: NotificationCommand) =>
      submitNotificationCommand(workspaceId as string, command),
    onSuccess: (_result, command) => {
      void queryClient.invalidateQueries({ queryKey: ["notifications", workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ["notification-settings", workspaceId] });
      if (command.type === "notifications.mute") {
        // The S20 mute family is shared (E3) — the approvals reads re-derive.
        void queryClient.invalidateQueries({ queryKey: ["approval-mutes", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["approval-due-reminders", workspaceId] });
      }
      // The cross-tab hint (client convenience UNDER the server truth): the
      // other tabs' polls converge immediately instead of waiting a tick.
      // A short-lived channel per hint — stateless, no refs.
      const channel = openTabSyncChannel();
      broadcastTabEvent(channel, { kind: "notifications-changed" });
      channel?.close();
    },
  });
  return {
    submit: (command: NotificationCommand) => {
      mutation.mutate(command);
    },
    pending: mutation.isPending,
    safeError: mutation.isError
      ? safeNotificationsMessage(mutation.error, "The notification command was not accepted.")
      : undefined,
  };
}

/**
 * The receiving side of the hint layer: another tab's settled command
 * invalidates THIS tab's reads immediately (the poll remains the truth — the
 * hint only removes the wait). Never carries content; the re-read answers
 * from the runtime.
 */
export function useTabSyncNotifications(workspaceId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const channel = openTabSyncChannel();
    const unsubscribe = subscribeTabEvents(channel, (event) => {
      if (event.kind === "notifications-changed") {
        void queryClient.invalidateQueries({ queryKey: ["notifications", workspaceId] });
        void queryClient.invalidateQueries({ queryKey: ["notification-settings", workspaceId] });
      } else if (event.kind === "approvals-changed") {
        void queryClient.invalidateQueries({ queryKey: ["approval-pending", workspaceId] });
      }
    });
    return () => {
      unsubscribe();
      channel?.close();
    };
  }, [queryClient, workspaceId]);
}
