"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuntimeApiError } from "@/lib/runtime-client";
import {
  buildOperationRosterCommand,
  createOperation,
  createOperationRun,
  fetchOperationDetail,
  fetchOperationThread,
  fetchOperations,
  newOperationCommandIds,
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

export { samePackAddRisk };
