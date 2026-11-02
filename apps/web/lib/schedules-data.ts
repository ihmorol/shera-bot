"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createTrigger,
  editTrigger,
  fetchTriggers,
  pauseTrigger,
  resumeTrigger,
  type CreateTriggerInput,
  type EditTriggerBody,
  type TriggerView,
} from "@/lib/schedules-api";
import type { UseMutationResult } from "@tanstack/react-query";
import { RuntimeApiError } from "@/lib/runtime-client";
import { presenceRefetchInterval } from "@/lib/session-presence";

/**
 * Real schedules data hooks (S28) — the truthful trigger records through
 * TanStack Query, reading the runtime scheduler's OWN record via the
 * same-origin proxy. The idiom mirrors the provider hooks
 * (lib/provider-data.ts): failures ARE states — the queries never retry
 * behind the user's back and never fall back to fixtures or fabricated
 * schedule state (G4; AC9's truth source is the scheduler, never the UI).
 */

const GENERIC_SCHEDULES_ERROR_MESSAGE = "The schedules could not be loaded.";

export function safeSchedulesMessage(
  error: unknown,
  fallback = GENERIC_SCHEDULES_ERROR_MESSAGE,
): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

export function useTriggers(workspaceId: string): {
  state: "loading" | "ready" | "error";
  triggers: TriggerView[];
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["schedules", workspaceId],
    queryFn: () => fetchTriggers(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    // The scheduler's own bookkeeping moves on fire events; the poll keeps
    // the readout honest without socket wiring (the tools-panel cadence).
    refetchInterval: () => presenceRefetchInterval(),
  });
  if (query.isPending) {
    return {
      state: "loading" as const,
      triggers: [] as TriggerView[],
      safeErrorMessage: undefined,
      refetch: () => query.refetch(),
    };
  }
  if (query.isError) {
    return {
      state: "error" as const,
      triggers: [] as TriggerView[],
      safeErrorMessage: safeSchedulesMessage(query.error),
      refetch: () => query.refetch(),
    };
  }
  const ready: TriggerView[] = query.data;
  return {
    state: "ready" as const,
    triggers: ready,
    safeErrorMessage: undefined,
    refetch: () => query.refetch(),
  };
}

export interface TriggerActions {
  create: UseMutationResult<
    { trigger_id: string; next_occurrence_at: string | null },
    Error,
    CreateTriggerInput
  >;
  pause: UseMutationResult<{ trigger_id: string; state: "active" | "paused" }, Error, string>;
  resume: UseMutationResult<{ trigger_id: string; state: "active" | "paused" }, Error, string>;
  edit: UseMutationResult<
    { next_occurrence_at: string | null },
    Error,
    { triggerId: string; body: EditTriggerBody }
  >;
}

export function useTriggerActions(workspaceId: string): TriggerActions {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["schedules", workspaceId] });
  };
  const create = useMutation({
    mutationFn: (input: CreateTriggerInput) => createTrigger(input),
    onSuccess: invalidate,
  });
  const pause = useMutation({
    mutationFn: (triggerId: string) => pauseTrigger(workspaceId, triggerId),
    onSuccess: invalidate,
  });
  const resume = useMutation({
    mutationFn: (triggerId: string) => resumeTrigger(workspaceId, triggerId),
    onSuccess: invalidate,
  });
  const edit = useMutation({
    mutationFn: ({ triggerId, body }: { triggerId: string; body: EditTriggerBody }) =>
      editTrigger(workspaceId, triggerId, body),
    onSuccess: invalidate,
  });
  return { create, pause, resume, edit };
}
