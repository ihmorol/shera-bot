"use client";

import { useQuery } from "@tanstack/react-query";

import {
  fetchCreditsSummary,
  fetchRunCost,
  type CreditsSummary,
  type RunCostDrillDown,
} from "@/lib/credits-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { presenceRefetchInterval } from "@/lib/session-presence";

/**
 * Real credits data hooks (S24) — the truthful ledger numbers through
 * TanStack Query, reading the runtime ledger's OWN record via the same-
 * origin proxy. The idiom mirrors the schedules hooks (lib/schedules-data.ts):
 * failures ARE states — the queries never retry behind the user's back and
 * never fall back to fixtures or fabricated balances (G4; AC8's truth source
 * is the ledger, never the UI).
 */

const GENERIC_CREDITS_ERROR_MESSAGE = "The credit ledger could not be loaded.";

export function safeCreditsMessage(
  error: unknown,
  fallback = GENERIC_CREDITS_ERROR_MESSAGE,
): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

export function useCreditsSummary(workspaceId: string): {
  state: "loading" | "ready" | "error";
  summary: CreditsSummary | null;
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["credits", workspaceId],
    queryFn: () => fetchCreditsSummary(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: () => presenceRefetchInterval(),
  });
  if (query.isPending) {
    return {
      state: "loading" as const,
      summary: null,
      safeErrorMessage: undefined,
      refetch: () => query.refetch(),
    };
  }
  if (query.isError) {
    return {
      state: "error" as const,
      summary: null,
      safeErrorMessage: safeCreditsMessage(query.error),
      refetch: () => query.refetch(),
    };
  }
  return {
    state: "ready" as const,
    summary: query.data,
    safeErrorMessage: undefined,
    refetch: () => query.refetch(),
  };
}

export function useRunCost(
  workspaceId: string,
  runId: string | null,
): {
  state: "idle" | "loading" | "ready" | "error";
  drillDown: RunCostDrillDown | null;
  safeErrorMessage: string | undefined;
} {
  const query = useQuery({
    queryKey: ["credits-run", workspaceId, runId],
    queryFn: () => fetchRunCost(workspaceId, runId as string),
    enabled: runId !== null,
    retry: false,
  });
  if (runId === null) {
    return { state: "idle" as const, drillDown: null, safeErrorMessage: undefined };
  }
  if (query.isPending) {
    return { state: "loading" as const, drillDown: null, safeErrorMessage: undefined };
  }
  if (query.isError) {
    return {
      state: "error" as const,
      drillDown: null,
      safeErrorMessage: safeCreditsMessage(query.error, "This run's credit records could not be loaded."),
    };
  }
  return { state: "ready" as const, drillDown: query.data, safeErrorMessage: undefined };
}
