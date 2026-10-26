"use client";

import { useQuery } from "@tanstack/react-query";

import { RuntimeApiError } from "@/lib/runtime-client";
import { presenceRefetchInterval } from "@/lib/session-presence";
import { fetchWorkerAdmission, type WorkerAdmissionReadout } from "@/lib/worker-api";

/**
 * Real worker data hooks (S16 chunk 3) — the Task workers admission readout
 * through TanStack Query, reading the REAL runtime gate via the local API
 * through the same-origin proxy. The idiom mirrors the agent hooks
 * (lib/agent-data.ts): failures ARE states — the query never retries behind
 * the user's back and never falls back to fixtures (a real-data failure
 * renders the §2.4 error state, G4).
 *
 * Worker events have no WS fanout in this slice, so the readout polls on the
 * S12 shared visible-tab cadence (presenceRefetchInterval): the default 5s
 * while the tab is visible, paused entirely while hidden — the same honesty
 * rule the session presence chip owns.
 */

const GENERIC_WORKER_ERROR_MESSAGE = "The worker readout could not be loaded.";

export function safeWorkerMessage(error: unknown, fallback = GENERIC_WORKER_ERROR_MESSAGE): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

export function useWorkerAdmission(workspaceId: string | null): {
  state: "loading" | "ready" | "error";
  readout: WorkerAdmissionReadout | null;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const admissionQuery = useQuery({
    queryKey: ["worker-admission", workspaceId],
    queryFn: () => fetchWorkerAdmission(workspaceId ?? ""),
    // The gate owns the lifecycle: until the workspace is resolved there is
    // no runtime to read pressure from — the query stays parked (never a
    // bogus fetch against an empty selector).
    enabled: workspaceId !== null,
    retry: false,
    refetchInterval: () => presenceRefetchInterval(),
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  if (admissionQuery.isPending) {
    return {
      state: "loading",
      readout: null,
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (admissionQuery.isError) {
    return {
      state: "error",
      readout: null,
      safeErrorMessage: safeWorkerMessage(admissionQuery.error),
      refetch: () => void admissionQuery.refetch(),
    };
  }
  return {
    state: "ready",
    readout: admissionQuery.data,
    safeErrorMessage: undefined,
    refetch: () => void admissionQuery.refetch(),
  };
}
