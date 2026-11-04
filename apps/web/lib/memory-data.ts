"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchMemoryView,
  submitMemoryCommand,
  type MemoryCommandBody,
  type MemoryEditBody,
  type MemoryUserView,
} from "@/lib/memory-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { presenceRefetchInterval } from "@/lib/session-presence";

/**
 * Real memory data hooks (S29) — the truthful memory record through TanStack
 * Query, reading the runtime's own record via the same-origin proxy. The
 * idiom mirrors the schedules hooks (lib/schedules-data.ts): failures ARE
 * states — the queries never retry behind the user's back and never fall
 * back to fixtures or fabricated memory (G4; D37's truth source is the
 * runtime, never the UI).
 */

const GENERIC_MEMORY_ERROR_MESSAGE = "Memory could not be loaded.";

export function safeMemoryMessage(error: unknown, fallback = GENERIC_MEMORY_ERROR_MESSAGE): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

/** The typed failure code a memory command was refused with (the honest
 * rejection banner reads this — e.g. the secret rejection). */
export function memoryErrorCode(error: unknown): string | null {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.code;
  }
  return null;
}

export function useMemoryView(workspaceId: string): {
  state: "loading" | "ready" | "error";
  memory: MemoryUserView | null;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  type QueryData = Awaited<ReturnType<typeof fetchMemoryView>>;
  const query = useQuery<QueryData>({
    queryKey: ["memory", workspaceId],
    queryFn: () => fetchMemoryView(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    // The runtime's record moves on publications and auto-learning; the poll
    // keeps the readout honest without socket wiring (the schedules cadence).
    refetchInterval: () => presenceRefetchInterval(),
  });
  if (query.isPending) {
    return {
      state: "loading" as const,
      memory: null,
      safeErrorMessage: undefined,
      refetch: () => query.refetch(),
    };
  }
  if (query.isError) {
    return {
      state: "error" as const,
      memory: null,
      safeErrorMessage: safeMemoryMessage(query.error),
      refetch: () => query.refetch(),
    };
  }
  return {
    state: "ready" as const,
    memory: query.data,
    safeErrorMessage: undefined,
    refetch: () => query.refetch(),
  };
}

export interface MemoryActions {
  edit: UseMutationResultWrapper<{ memoryId: string; body: MemoryEditBody }>;
  restore: UseMutationResultWrapper<{ memoryId: string; version: number }>;
  forget: UseMutationResultWrapper<{ memoryId: string }>;
  requestPublication: UseMutationResultWrapper<{ memoryId: string; operationId: string }>;
  publishDecision: UseMutationResultWrapper<{
    memoryId: string;
    operationId: string;
    decision: "approve" | "dismiss";
  }>;
  setAutoMemory: UseMutationResultWrapper<{ enabled: boolean }>;
  setAgentAutoMemory: UseMutationResultWrapper<{ agentId: string; enabled: boolean }>;
}

/**
 * The command envelope fields the client supplies (the S14 rename/D16
 * convention): a fresh idempotency key per attempt. The ACTING actor is
 * rebuilt server-side by the proxy's session binding — the browser never
 * asserts the identity.
 */
function envelope() {
  const id = `cmd_${globalThis.crypto.randomUUID()}`;
  return { command_id: id, idempotency_key: id, issued_at: new Date().toISOString() };
}

/** The narrow mutation surface the view consumes (pending + error + reset). */
export interface UseMutationResultWrapper<TVariables> {
  isPending: boolean;
  variables: TVariables | undefined;
  error: unknown;
  reset: () => void;
  mutate: (variables: TVariables) => void;
}

export function useMemoryActions(workspaceId: string): MemoryActions {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["memory", workspaceId] });
  };

  const useMemoryMutation = <TVariables>(build: (variables: TVariables) => MemoryCommandBody) =>
    useMutation({
      mutationFn: async (variables: TVariables) =>
        submitMemoryCommand(workspaceId, build(variables)),
      onSuccess: invalidate,
      // Failures ARE states: the query cache is untouched, the refusal
      // renders where the action happened (the view reads error + code).
      retry: false,
    });

  return {
    edit: useMemoryMutation<{ memoryId: string; body: MemoryEditBody }>(({ memoryId, body }) => ({
      ...envelope(),
      ...body,
      // The command type is authoritative — a caller-supplied body never
      // retargets the command.
      type: "memory.edit",
      memory_id: memoryId,
    })),
    restore: useMemoryMutation<{ memoryId: string; version: number }>(({ memoryId, version }) => ({
      ...envelope(),
      type: "memory.restore",
      memory_id: memoryId,
      version,
    })),
    forget: useMemoryMutation<{ memoryId: string }>(({ memoryId }) => ({
      ...envelope(),
      type: "memory.forget",
      memory_id: memoryId,
    })),
    requestPublication: useMemoryMutation<{ memoryId: string; operationId: string }>(
      ({ memoryId, operationId }) => ({
        ...envelope(),
        type: "memory.request_publication",
        memory_id: memoryId,
        operation_id: operationId,
      }),
    ),
    publishDecision: useMemoryMutation<{
      memoryId: string;
      operationId: string;
      decision: "approve" | "dismiss";
    }>(({ memoryId, operationId, decision }) => ({
      ...envelope(),
      type: "memory.publish_decision",
      memory_id: memoryId,
      operation_id: operationId,
      decision,
    })),
    setAutoMemory: useMemoryMutation<{ enabled: boolean }>(({ enabled }) => ({
      ...envelope(),
      type: "memory.set_auto_memory",
      enabled,
    })),
    setAgentAutoMemory: useMemoryMutation<{ agentId: string; enabled: boolean }>(
      ({ agentId, enabled }) => ({
        ...envelope(),
        type: "memory.set_agent_auto_memory",
        agent_id: agentId,
        enabled,
      }),
    ),
  };
}
