"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { RuntimeApiError } from "@/lib/runtime-client";
import {
  buildOperationRosterCommand,
  createOperation,
  createOperationRun,
  cancelOperationRun,
  fetchOperationDetail,
  fetchOperationThread,
  fetchOperations,
  listOperationRunEvents,
  newOperationCommandIds,
  renameOperationMutationOptions,
  retryAttemptsFromEvents,
  samePackAddRisk,
  sendOperationChatMessage,
  setOperationCoordinator,
  submitOperationRosterCommand,
  type CreateOperationInput,
  type OperationDetail,
  type OperationRosterAction,
  type OperationThreadPayload,
  type RosterCommandOutcome,
} from "@/lib/operation-api";

/**
 * Real Operation data hooks (S13 chunk 4) — the workspace's Operation chats
 * through TanStack Query, reading REAL container-local rows via the local API
 * through the same-origin proxy. The idiom mirrors the agent hooks
 * (lib/agent-data.ts): failures ARE states — the queries never retry behind
 * the user's back and never fall back to fixtures; a real-data failure renders
 * the §2.4 error state, G4. The thread is POLLING-free here: every mutation
 * invalidates the reads it affected, and the composer's send refetches the
 * merged thread (the live socket stream for Operations arrives in a later
 * slice; honest refresh beats a fabricated realtime feel).
 */

const GENERIC_OPERATION_ERROR_MESSAGE = "The Operation data could not be loaded.";

export function safeOperationMessage(
  error: unknown,
  fallback = GENERIC_OPERATION_ERROR_MESSAGE,
): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Operation list (GET /v1/operations)
// ---------------------------------------------------------------------------

export function useOperationsList(workspaceId: string): {
  state: "loading" | "ready" | "error";
  operations: Awaited<ReturnType<typeof fetchOperations>>;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const listQuery = useQuery({
    queryKey: ["operations", workspaceId],
    queryFn: () => fetchOperations(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (listQuery.isPending) {
    return {
      state: "loading",
      operations: [],
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (listQuery.isError) {
    return {
      state: "error",
      operations: [],
      safeErrorMessage: safeOperationMessage(
        listQuery.error,
        "The Operations could not be loaded.",
      ),
      refetch: () => void listQuery.refetch(),
    };
  }
  return {
    state: "ready",
    operations: listQuery.data,
    safeErrorMessage: undefined,
    refetch: () => void listQuery.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Operation detail (GET /v1/operations/:id — roster + runs + refusals)
// ---------------------------------------------------------------------------

export function useOperationDetail(
  workspaceId: string,
  operationId: string,
): {
  state: "loading" | "ready" | "error";
  detail: OperationDetail | null;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const detailQuery = useQuery({
    queryKey: ["operation-detail", workspaceId, operationId],
    queryFn: () => fetchOperationDetail(workspaceId, operationId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (detailQuery.isPending) {
    return {
      state: "loading",
      detail: null,
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (detailQuery.isError) {
    return {
      state: "error",
      detail: null,
      safeErrorMessage: safeOperationMessage(
        detailQuery.error,
        "The Operation could not be loaded.",
      ),
      refetch: () => void detailQuery.refetch(),
    };
  }
  return {
    state: "ready",
    detail: detailQuery.data,
    safeErrorMessage: undefined,
    refetch: () => void detailQuery.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Operation thread (GET /v1/operations/:id/thread — the merged D41 read model)
// ---------------------------------------------------------------------------

export function useOperationThread(
  workspaceId: string,
  operationId: string,
  after = 0,
): {
  state: "loading" | "ready" | "error";
  thread: OperationThreadPayload | null;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const threadQuery = useQuery({
    queryKey: ["operation-thread", workspaceId, operationId, after],
    queryFn: () => fetchOperationThread(workspaceId, operationId, after),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (threadQuery.isPending) {
    return {
      state: "loading",
      thread: null,
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (threadQuery.isError) {
    return {
      state: "error",
      thread: null,
      safeErrorMessage: safeOperationMessage(
        threadQuery.error,
        "The Operation thread could not be loaded.",
      ),
      refetch: () => void threadQuery.refetch(),
    };
  }
  return {
    state: "ready",
    thread: threadQuery.data,
    safeErrorMessage: undefined,
    refetch: () => void threadQuery.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Mutations — every one invalidates the reads its effect touches, so the
// rendered state is always the runtime's read-after-write truth, never an
// optimistic guess.
// ---------------------------------------------------------------------------

/** One D36 roster command (add with the same-pack risk, or remove). */
export function useRosterCommand(workspaceId: string, operationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: OperationRosterAction): Promise<RosterCommandOutcome> =>
      submitOperationRosterCommand(
        workspaceId,
        operationId,
        buildOperationRosterCommand(action, {
          ...newOperationCommandIds(),
          workspace_id: workspaceId,
          operation_id: operationId,
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["operation-detail", workspaceId, operationId],
      });
    },
  });
}

/** D42/D49 coordinator set/remove ("none"). */
export function useCoordinatorCommand(workspaceId: string, operationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (coordinatorAgentId: string) =>
      setOperationCoordinator(workspaceId, operationId, coordinatorAgentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["operation-detail", workspaceId, operationId],
      });
    },
  });
}

/** D31 run creation; the runs summary lives in the detail read model. */
export function useCreateRun(workspaceId: string, operationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => createOperationRun(workspaceId, operationId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["operation-detail", workspaceId, operationId],
      });
    },
  });
}

/**
 * D41 addressed message send. The CALLER owns the idempotency key — minted
 * per draft (newMessageDraftKey) and reused across retries of the same send,
 * so an ambiguous failure can never duplicate the turn.
 */
export function useSendOperationMessage(workspaceId: string, operationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { text: string; displayName: string; idempotencyKey: string }) =>
      sendOperationChatMessage(workspaceId, operationId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["operation-thread", workspaceId, operationId],
      });
    },
  });
}

/**
 * S22 (PRD §8, AC15): the user's stop control for one run. The cancel is
 * idempotent server-side (a replay answers already_cancelled), so the
 * mutation's success is the outcome either way; the detail + list reads
 * invalidate so the settled D8 state replaces the optimistic one.
 */
export function useCancelRun(workspaceId: string, operationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; cancelledBy: { type: "user" | "admin"; id: string } }) =>
      cancelOperationRun(workspaceId, operationId, input.runId, input.cancelledBy),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["operation-detail", workspaceId, operationId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["operations", workspaceId],
      });
    },
  });
}

/**
 * S22 (AC3): the TRUE retry attempt counts of the panel's runs, read from
 * each run's journal (the task.retry_scheduled envelopes — the runtime's own
 * ledger). One query for the runs whose cards render a count (RETRYING and
 * the settled states a retry walk can end in); a run whose fetch fails maps
 * to null — the card then renders no number at all rather than a guessed
 * one. The counts are journal-derived, so they can never disagree with the
 * stream the UI claims to render.
 */
export function useRunRetryAttempts(
  workspaceId: string,
  operationId: string,
  runIds: readonly string[],
): UseQueryResult<Record<string, number | null>, Error> {
  const key = runIds.join(",");
  return useQuery({
    queryKey: ["run-retry-attempts", workspaceId, operationId, key],
    enabled: runIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        runIds.map(async (runId) => {
          try {
            const events = await listOperationRunEvents(workspaceId, operationId, runId);
            return [runId, retryAttemptsFromEvents(events)] as const;
          } catch {
            return [runId, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries) as Record<string, number | null>;
    },
    staleTime: 5_000,
  });
}

/** Ad-hoc creation (D29/D41); the list read model picks the record up. */
export function useCreateOperation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOperationInput) => createOperation(workspaceId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["operations", workspaceId] });
    },
  });
}

/**
 * S14 rename (D41/D23 rule 6): the user-owned name write. The mutation
 * invalidates BOTH the detail read model and the workspace list, so the
 * chat header and the sidebar show the runtime's read-after-write truth.
 * Validation failures (empty, >120 chars) surface typed with safe copy.
 */
export function useRenameOperation(workspaceId: string, operationId: string) {
  const queryClient = useQueryClient();
  return useMutation(renameOperationMutationOptions(queryClient, workspaceId, operationId));
}

export { samePackAddRisk };
