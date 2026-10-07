import type { ResourceSummary, SheraError } from "@shera-bot/contracts";
import type { ProvisioningStatus, RuntimeHealthState } from "@shera-bot/contracts";

/**
 * Container resolution state machine (S09 chunk 1; issue #10, D23 Phase 1).
 *
 * Resolves the signed-in user's workspace → container from the control plane
 * (S05 session projection + S06 provisioning records) and surfaces the
 * lifecycle honestly: provisioning in progress, provisioning FAILED (typed
 * `safe_message` + retry only when retryable, §2.4), and ready. Pure logic —
 * the fetch layer (lib/control-plane-client.ts) drives it; the gate component
 * renders it.
 *
 * Provisioning trigger disclosure (recorded for the S09 PR, do not silently
 * change): provisioning is deliberately NOT wired into the sign-in hook —
 * that would attempt real container creation inside S05 auth tests on CI
 * runners (recorded S06 NOTE). The trigger is an EXPLICIT client-flow step:
 * on first entry to /app with no container the gate shows the honest
 * "prepare your workspace" state and calls provision once, on user action.
 *
 * Everything web-facing here stays opaque (D12): an opaque runtime handle, a
 * resource summary, and lifecycle states — never a container id, host path,
 * internal port, or credential (G3). No state fabricates health: "unknown"
 * health and absent runtimes are states, not guesses (G4).
 */

/** The web-facing runtime snapshot the control plane may return (D12 surface). */
export interface RuntimeSnapshot {
  runtime_handle: string;
  provisioning_status: ProvisioningStatus;
  health: RuntimeHealthState;
  resource_summary: ResourceSummary;
}

export type ContainerResolutionState =
  | { kind: "resolving"; workspace_id: string | null }
  | { kind: "unauthenticated" }
  | { kind: "not_provisioned"; workspace_id: string }
  | { kind: "preparing"; workspace_id: string }
  | { kind: "provisioning"; workspace_id: string }
  | { kind: "stopped"; workspace_id: string }
  | { kind: "starting"; workspace_id: string }
  | { kind: "failed"; workspace_id: string | null; error: SheraError }
  | {
      kind: "ready";
      workspace_id: string;
      runtime: RuntimeSnapshot;
    };

export type ContainerResolutionEvent =
  | { type: "session_unauthenticated" }
  | { type: "session_resolved"; workspace_id: string }
  | { type: "session_failed"; error: SheraError }
  /** A runtime status observation (status poll or provision answer body). */
  | { type: "runtime_observed"; runtime: RuntimeSnapshot }
  /** The control plane answered RUNTIME_NOT_PROVISIONED (no container yet). */
  | { type: "runtime_not_provisioned" }
  /** Resolving the runtime failed with a typed control-plane error. */
  | { type: "runtime_failed"; error: SheraError }
  /** The EXPLICIT trigger: the user asked for the workspace to be prepared. */
  | { type: "provision_started" }
  /** The EXPLICIT trigger: the user asked a STOPPED workspace to start. */
  | { type: "start_started" }
  | { type: "provision_accepted"; runtime: RuntimeSnapshot }
  /** RUNTIME_PROVISION_IN_PROGRESS — the control plane is already on it. */
  | { type: "provision_in_progress" }
  | { type: "provision_failed"; error: SheraError }
  /** Re-run resolution (retry after a failure; re-fetches session + status). */
  | { type: "retry" };

export const INITIAL_CONTAINER_RESOLUTION: ContainerResolutionState = {
  kind: "resolving",
  workspace_id: null,
};

/**
 * Map a runtime status observation onto the honest resolution state. "failed"
 * as a STATUS (the record says the last provisioning attempt failed) is a
 * failed workspace with a truthful client-owned message — no error payload
 * exists on a 200 status response, so the copy states exactly what is known.
 */
function stateForRuntime(workspaceId: string, runtime: RuntimeSnapshot): ContainerResolutionState {
  switch (runtime.provisioning_status) {
    case "running":
      return { kind: "ready", workspace_id: workspaceId, runtime };
    case "pending":
    case "provisioning":
      return { kind: "provisioning", workspace_id: workspaceId };
    case "stopped":
      return { kind: "stopped", workspace_id: workspaceId };
    case "failed":
      return { kind: "failed", workspace_id: workspaceId, error: provisionFailedFallback() };
  }
}

function withWorkspace(state: ContainerResolutionState): string | null {
  if (state.kind === "resolving") return state.workspace_id;
  if (state.kind === "unauthenticated" || state.kind === "failed") {
    return state.kind === "failed" ? state.workspace_id : null;
  }
  return state.workspace_id;
}

export function advanceContainerResolution(
  state: ContainerResolutionState,
  event: ContainerResolutionEvent,
): ContainerResolutionState {
  const workspaceId = withWorkspace(state);

  switch (event.type) {
    case "session_unauthenticated":
      return { kind: "unauthenticated" };
    case "session_resolved":
      return { kind: "resolving", workspace_id: event.workspace_id };
    case "session_failed":
      return { kind: "failed", workspace_id: null, error: event.error };
    case "runtime_observed":
      if (workspaceId === null) {
        return state;
      }
      return stateForRuntime(workspaceId, event.runtime);
    case "runtime_not_provisioned":
      return workspaceId === null ? state : { kind: "not_provisioned", workspace_id: workspaceId };
    case "runtime_failed":
      return { kind: "failed", workspace_id: workspaceId, error: event.error };
    case "provision_started":
      return workspaceId === null ? state : { kind: "preparing", workspace_id: workspaceId };
    case "start_started":
      // A STOPPED container starting is a distinct lifecycle moment from a
      // container being created for the first time — the gate says so.
      return workspaceId === null ? state : { kind: "starting", workspace_id: workspaceId };
    case "provision_accepted":
      if (workspaceId === null) {
        return state;
      }
      return stateForRuntime(workspaceId, event.runtime);
    case "provision_in_progress":
      return workspaceId === null ? state : { kind: "provisioning", workspace_id: workspaceId };
    case "provision_failed":
      return {
        kind: "failed",
        workspace_id: workspaceId,
        error: event.error,
      };
    case "retry":
      return { kind: "resolving", workspace_id: workspaceId };
  }
}

// ---------------------------------------------------------------------------
// Honest copy (§2.4 states; client-owned — the typed error's safe_message is
// rendered verbatim wherever one exists, and these constants cover only the
// states where no typed error crosses the wire).
// ---------------------------------------------------------------------------

export const PREPARE_WORKSPACE_TITLE = "Prepare your workspace";
export const PREPARE_WORKSPACE_COPY =
  "Your private workspace has not been created yet. Preparing it is a one-time step — nothing runs until it is ready.";
export const PREPARE_WORKSPACE_ACTION = "Prepare my workspace";
export const PREPARING_WORKSPACE_TITLE = "Preparing your workspace…";
export const PREPARING_WORKSPACE_COPY =
  "The workspace container is being created. This runs once; your conversations unlock when it is ready.";
export const STARTING_WORKSPACE_TITLE = "Starting your workspace…";
export const STARTING_WORKSPACE_COPY =
  "Your workspace container is starting — it already exists, so this usually takes only a moment. Your conversations unlock when it is running.";
export const WORKSPACE_STOPPED_TITLE = "Your workspace is stopped";
export const WORKSPACE_STOPPED_COPY =
  "The workspace container is not running right now. Start it to continue where you left off.";
export const WORKSPACE_STOPPED_ACTION = "Start my workspace";
export const SIGN_IN_REQUIRED_TITLE = "Sign in to continue";
export const SIGN_IN_REQUIRED_COPY =
  "Your workspace resolves from your account, so sign-in comes first.";

/**
 * Truthful fallback error for a status record that says "failed": no typed
 * payload crosses the wire on a 200 status read, so the client states exactly
 * what the record shows and offers the retry the lifecycle allows.
 */
export function provisionFailedFallback(): SheraError {
  return {
    code: "RUNTIME_PROVISION_FAILED",
    category: "resource",
    safe_message: "Your workspace could not be prepared. The failure has been recorded.",
    retryable: true,
    user_action: "Try again; if it keeps failing, contact the operator.",
    internal_details: null,
    correlation_id: "client-runtime-failed-status",
  };
}
