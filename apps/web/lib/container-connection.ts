"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ProvisionRuntimeResult, RuntimeStatus } from "@shera-bot/contracts";

import {
  advanceContainerResolution,
  INITIAL_CONTAINER_RESOLUTION,
  type ContainerResolutionState,
  type RuntimeSnapshot,
} from "@/lib/container-resolution";
import {
  ControlPlaneError,
  fetchRuntimeStatus,
  fetchSession,
  provisionRuntime,
  restartRuntime,
} from "@/lib/control-plane-client";

/**
 * Container connection hooks (S09 chunk 1): the resolution machine
 * (lib/container-resolution.ts) driven by real control-plane answers through
 * TanStack Query. Failures ARE states here — the query never retries behind
 * the user's back; the gate's retry affordance re-runs resolution (§2.4).
 *
 * The provision trigger is the EXPLICIT client-flow step (owner-call
 * disclosure, S09 PR): never wired into sign-in (recorded S06 NOTE).
 */

export const CONTAINER_RESOLUTION_QUERY_KEY = ["container-resolution"] as const;

/** The web-facing fields both lifecycle answers (status, provision) carry. */
function snapshotOf(
  runtime: RuntimeStatus | ProvisionRuntimeResult | Pick<RuntimeSnapshot, keyof RuntimeSnapshot>,
): RuntimeSnapshot {
  return {
    runtime_handle: runtime.runtime_handle,
    provisioning_status: runtime.provisioning_status,
    health: runtime.health,
    resource_summary: runtime.resource_summary,
  };
}

/** One resolution pass: session → runtime status, mapped through the machine. */
export async function resolveContainerState(): Promise<ContainerResolutionState> {
  let state = INITIAL_CONTAINER_RESOLUTION;

  try {
    const session = await fetchSession();
    state = advanceContainerResolution(state, {
      type: "session_resolved",
      workspace_id: session.workspace_id,
    });
  } catch (error) {
    return error instanceof ControlPlaneError && error.sheraError.code === "UNAUTHENTICATED"
      ? advanceContainerResolution(state, { type: "session_unauthenticated" })
      : advanceContainerResolution(state, {
          type: "session_failed",
          error: error instanceof ControlPlaneError ? error.sheraError : fallbackError(error),
        });
  }

  try {
    const status = await fetchRuntimeStatus();
    return advanceContainerResolution(state, {
      type: "runtime_observed",
      runtime: snapshotOf(status),
    });
  } catch (error) {
    if (error instanceof ControlPlaneError && error.sheraError.code === "RUNTIME_NOT_PROVISIONED") {
      return advanceContainerResolution(state, { type: "runtime_not_provisioned" });
    }
    return advanceContainerResolution(state, {
      type: "runtime_failed",
      error: error instanceof ControlPlaneError ? error.sheraError : fallbackError(error),
    });
  }
}

function fallbackError(error: unknown) {
  return {
    code: "INTERNAL_ERROR",
    category: "internal",
    safe_message: "Something went wrong. The failure has been recorded.",
    retryable: true,
    user_action: "Try again later.",
    internal_details: null,
    correlation_id: `client-${error instanceof Error ? error.name : "unknown"}`,
  } as const;
}

export function useContainerResolution() {
  return useQuery({
    queryKey: CONTAINER_RESOLUTION_QUERY_KEY,
    queryFn: resolveContainerState,
    retry: false,
    // Resolution is a lifecycle read, not a polling loop; the gate's states
    // tell the truth about the moment it resolved and retry is user-driven.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

function applyResolutionEvent(
  queryClient: ReturnType<typeof useQueryClient>,
  event: Parameters<typeof advanceContainerResolution>[1],
) {
  queryClient.setQueryData<ContainerResolutionState>(CONTAINER_RESOLUTION_QUERY_KEY, (state) =>
    state ? advanceContainerResolution(state, event) : state,
  );
}

/** The explicit "prepare your workspace" action (one-time, idempotent upstream). */
export function useProvisionWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: provisionRuntime,
    onMutate: () => applyResolutionEvent(queryClient, { type: "provision_started" }),
    onSuccess: (result) =>
      applyResolutionEvent(queryClient, {
        type: "provision_accepted",
        runtime: snapshotOf(result),
      }),
    onError: (error) =>
      applyResolutionEvent(
        queryClient,
        error instanceof ControlPlaneError &&
          error.sheraError.code === "RUNTIME_PROVISION_IN_PROGRESS"
          ? { type: "provision_in_progress" }
          : {
              type: "provision_failed",
              error: error instanceof ControlPlaneError ? error.sheraError : fallbackError(error),
            },
      ),
  });
}

/** Start a stopped workspace; success re-runs resolution for the truthful state. */
export function useStartStoppedWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: restartRuntime,
    // The OPTIMISTIC state is "starting" — a stopped container booting is not
    // a container being created, and the gate copy says exactly that.
    onMutate: () => applyResolutionEvent(queryClient, { type: "start_started" }),
    onSuccess: () => {
      void queryClient.refetchQueries({ queryKey: CONTAINER_RESOLUTION_QUERY_KEY });
    },
    onError: (error) =>
      applyResolutionEvent(queryClient, {
        type: "provision_failed",
        error: error instanceof ControlPlaneError ? error.sheraError : fallbackError(error),
      }),
  });
}

/** Retry resolution after a failure: reset through the machine, then re-run. */
export function useRetryResolution() {
  const queryClient = useQueryClient();
  return () => {
    applyResolutionEvent(queryClient, { type: "retry" });
    void queryClient.refetchQueries({ queryKey: CONTAINER_RESOLUTION_QUERY_KEY });
  };
}
