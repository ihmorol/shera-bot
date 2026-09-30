"use client";

import { useQuery } from "@tanstack/react-query";

import type { ThreadItem } from "@/lib/fixtures";
import {
  RuntimeApiError,
  ensureGaConversation,
  fetchConversationEvents,
} from "@/lib/runtime-client";
import { threadItemsFromEvents } from "@/lib/runtime-thread";

/**
 * Real conversation data hooks (S09 chunk 1): the General Assistant direct
 * chat's server state through TanStack Query, reading REAL container-local
 * rows via the S07 local API. Failures are real outcomes surfaced through the
 * §2.4 states — the query never retries behind the user's back and never
 * falls back to fixtures (the demo stays a labeled, separate state).
 *
 * Chunk-1 boundary: full replay from cursor 0; the live socket stream and
 * cursor acknowledgement after render are chunk 2/3.
 */

const GENERIC_RUNTIME_ERROR_MESSAGE = "This conversation could not be loaded.";
const SNAPSHOT_REQUIRED_MESSAGE =
  "This conversation's full history could not be replayed right now.";

export interface RealConversationThread {
  surfaceState: "ready" | "loading" | "error";
  items: ThreadItem[];
  safeErrorMessage: string | undefined;
}

function safeMessageOf(error: unknown): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return GENERIC_RUNTIME_ERROR_MESSAGE;
}

export function useRealConversationThread(workspaceId: string): RealConversationThread {
  const conversationQuery = useQuery({
    queryKey: ["runtime-conversation", workspaceId],
    queryFn: () => ensureGaConversation(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const conversationId = conversationQuery.data?.conversation_id ?? null;
  const eventsQuery = useQuery({
    queryKey: ["runtime-thread", workspaceId, conversationId],
    queryFn: () => fetchConversationEvents(conversationId as string, workspaceId),
    enabled: conversationId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (conversationQuery.isPending) {
    return { surfaceState: "loading", items: [], safeErrorMessage: undefined };
  }
  if (conversationQuery.isError) {
    return {
      surfaceState: "error",
      items: [],
      safeErrorMessage: safeMessageOf(conversationQuery.error),
    };
  }
  if (eventsQuery.isPending) {
    return { surfaceState: "loading", items: [], safeErrorMessage: undefined };
  }
  if (eventsQuery.isError) {
    return {
      surfaceState: "error",
      items: [],
      safeErrorMessage: safeMessageOf(eventsQuery.error),
    };
  }

  const replay = eventsQuery.data;
  if (replay.kind === "snapshot_required") {
    // E10 honesty: the cursor is below the retention horizon (or the stream
    // is unknown) — never render fabricated history in its place.
    return { surfaceState: "error", items: [], safeErrorMessage: SNAPSHOT_REQUIRED_MESSAGE };
  }
  return {
    surfaceState: "ready",
    items: threadItemsFromEvents(replay.events),
    safeErrorMessage: undefined,
  };
}
