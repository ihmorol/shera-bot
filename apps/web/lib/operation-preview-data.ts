"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { OperationLaunchPreview } from "@shera-bot/contracts";

import { RuntimeApiError } from "@/lib/runtime-client";
import {
  fetchOperationDefinitions,
  fetchOperationLaunchPreview,
  type OperationDefinitionSummary,
  type OperationPreviewOverrides,
} from "@/lib/operation-preview-api";

/**
 * Real launch-preview data hooks (S15 chunk 2) — the D30 preview gate through
 * TanStack Query, reading the REAL S15 read model via the local API through
 * the same-origin proxy. The idiom mirrors the Operation hooks
 * (lib/operation-data.ts): failures ARE states — the queries never retry
 * behind the user's back and never fall back to fixtures.
 *
 * Roster/coordinator edits are NOT local mutations: an edit changes the
 * override params and REFETCHES the same cached read (the server recomputes
 * all eight groups — the preview never writes anything). While that refetch
 * is in flight the last good preview stays on screen with its editing
 * controls disabled, and a refused override (the runtime's typed 400 for
 * out-of-pack Agents or an emptied roster) surfaces as an alert next to the
 * STILL-VISIBLE preview — a 400 must never blank the gate.
 */

const GENERIC_PREVIEW_ERROR_MESSAGE = "The launch preview could not be loaded.";
const GENERIC_DEFINITIONS_ERROR_MESSAGE = "The pack's Operations could not be loaded.";

export function safePreviewMessage(error: unknown, fallback?: string): string {
  const generic = fallback ?? GENERIC_PREVIEW_ERROR_MESSAGE;
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return generic;
}

export function safeDefinitionsMessage(error: unknown, fallback?: string): string {
  const generic = fallback ?? GENERIC_DEFINITIONS_ERROR_MESSAGE;
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return generic;
}

// ---------------------------------------------------------------------------
// The hook state contract, extracted so the suite can pin it without a React
// renderer (the S13 suite's discipline): the tri-state surface plus the
// override-failure distinction.
// ---------------------------------------------------------------------------

export type PreviewSurfaceState = "loading" | "ready" | "error";

/**
 * The modal's surface state: pending wins; an error WITHOUT data is the
 * error state; an error WITH data is a failed REFETCH (an override the
 * runtime refused) — the last good preview stays up and the failure rides
 * the override alert instead of blanking the gate.
 */
export function previewSurfaceState(
  isPending: boolean,
  isError: boolean,
  hasData: boolean,
): PreviewSurfaceState {
  if (isPending) return "loading";
  if (isError && !hasData) return "error";
  return "ready";
}

/** True when an in-flight-or-settled refetch failed while a preview shows. */
export function isPreviewOverrideFailure(isError: boolean, hasData: boolean): boolean {
  return isError && hasData;
}

// ---------------------------------------------------------------------------
// Definitions list (GET /v1/operation-definitions) — the launch menu
// ---------------------------------------------------------------------------

export function operationDefinitionsQueryOptions(workspaceId: string) {
  return {
    queryKey: ["operation-definitions", workspaceId] as const,
    queryFn: () => fetchOperationDefinitions(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  };
}

export function useOperationDefinitions(workspaceId: string): {
  state: PreviewSurfaceState;
  definitions: OperationDefinitionSummary[];
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const listQuery = useQuery(operationDefinitionsQueryOptions(workspaceId));

  if (listQuery.isPending) {
    return {
      state: "loading",
      definitions: [],
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (listQuery.isError) {
    return {
      state: "error",
      definitions: [],
      safeErrorMessage: safeDefinitionsMessage(listQuery.error),
      refetch: () => void listQuery.refetch(),
    };
  }
  return {
    state: "ready",
    definitions: listQuery.data,
    safeErrorMessage: undefined,
    refetch: () => void listQuery.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Launch preview (GET /v1/operation-definitions/:id/preview) — the gate
// ---------------------------------------------------------------------------

export function operationLaunchPreviewQueryOptions(workspaceId: string, definitionId: string) {
  return {
    queryKey: ["operation-launch-preview", workspaceId, definitionId] as const,
    queryFn: () => fetchOperationLaunchPreview(workspaceId, definitionId),
    enabled: definitionId.length > 0,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  };
}

/**
 * One cached read per definition. The override params deliberately do NOT
 * ride the query key: an edit mints no new cache entry — it updates the
 * params (through a ref, so the refetch always reads the latest) and
 * refetches THE read, exactly the "the server recomputes" contract. The
 * refetch keeps the previous data on screen (TanStack keeps the last good
 * data on a failed refetch), which is what the override-failure path relies
 * on above.
 */
export function useOperationLaunchPreview(
  workspaceId: string,
  definitionId: string,
): {
  state: PreviewSurfaceState;
  preview: OperationLaunchPreview | null;
  safeErrorMessage: string | undefined;
  refetch: () => void;
  /** The override params the NEXT refetch will carry ({} = pack default). */
  overrides: OperationPreviewOverrides;
  /** True while a fetch (first load or an override refetch) is in flight. */
  overridePending: boolean;
  /** The safe copy of a refused override, while the last good preview shows. */
  overrideErrorMessage: string | null;
  /** Set the override params and refetch the read-only preview. */
  applyOverrides: (next: OperationPreviewOverrides) => void;
  /** Drop every override and refetch — back to the pack's recommendation. */
  resetOverrides: () => void;
} {
  const [overrides, setOverrides] = useState<OperationPreviewOverrides>({});
  // The ref, not the state, feeds the queryFn: applyOverrides sets it BEFORE
  // refetching, so a rapid second edit can never send a stale roster.
  const overridesRef = useRef<OperationPreviewOverrides>({});

  const previewQuery = useQuery({
    queryKey: ["operation-launch-preview", workspaceId, definitionId],
    queryFn: () => fetchOperationLaunchPreview(workspaceId, definitionId, overridesRef.current),
    enabled: definitionId.length > 0,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const refetch = previewQuery.refetch;

  const applyOverrides = useCallback(
    (next: OperationPreviewOverrides) => {
      overridesRef.current = next;
      setOverrides(next);
      void refetch();
    },
    [refetch],
  );

  const hasData = previewQuery.data !== undefined;
  const state = previewSurfaceState(previewQuery.isPending, previewQuery.isError, hasData);
  const overrideFailure = isPreviewOverrideFailure(previewQuery.isError, hasData);

  return {
    state,
    preview: previewQuery.data ?? null,
    safeErrorMessage: state === "error" ? safePreviewMessage(previewQuery.error) : undefined,
    refetch: () => void refetch(),
    overrides,
    overridePending: previewQuery.isFetching,
    overrideErrorMessage: overrideFailure
      ? safePreviewMessage(previewQuery.error, "The roster override was not accepted.")
      : null,
    applyOverrides,
    resetOverrides: () => applyOverrides({}),
  };
}
