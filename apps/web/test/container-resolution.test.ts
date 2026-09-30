import { describe, expect, it } from "vitest";

import type { ResourceSummary, SheraError } from "@shera-bot/contracts";

import {
  advanceContainerResolution,
  INITIAL_CONTAINER_RESOLUTION,
  PREPARE_WORKSPACE_COPY,
  PREPARE_WORKSPACE_TITLE,
  provisionFailedFallback,
  type ContainerResolutionState,
  type RuntimeSnapshot,
} from "../lib/container-resolution";

/**
 * Container resolution states (S09 chunk 1): the signed-in user's workspace →
 * container lifecycle resolves honestly — ready, provisioning-in-progress,
 * FAILED (typed safe_message + retry only when retryable), the explicit
 * "prepare your workspace" trigger, and sign-in-required. Pure machine tests;
 * the fetch layer and gate component are covered by their own suites.
 */

const WORKSPACE = "ws_account-1";

const RESOURCE_SUMMARY: ResourceSummary = {
  tier: "balanced",
  cpu_vcpus: 2,
  memory_bytes: 4 * 1024 ** 3,
  storage_bytes: 25 * 1024 ** 3,
};

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    runtime_handle: `rt_${"a".repeat(32)}`,
    provisioning_status: "running",
    health: "healthy",
    resource_summary: RESOURCE_SUMMARY,
    ...overrides,
  };
}

function typedError(overrides: Partial<SheraError> = {}): SheraError {
  return {
    code: "RUNTIME_PROVISION_FAILED",
    category: "resource",
    safe_message: "Your runtime could not be provisioned. The failure has been recorded.",
    retryable: true,
    user_action: "Try again; if it keeps failing, contact the operator.",
    internal_details: null,
    correlation_id: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function resolved(): ContainerResolutionState {
  return advanceContainerResolution(INITIAL_CONTAINER_RESOLUTION, {
    type: "session_resolved",
    workspace_id: WORKSPACE,
  });
}

describe("resolution from session + runtime status", () => {
  it("starts resolving, then carries the workspace from the session projection", () => {
    expect(INITIAL_CONTAINER_RESOLUTION).toEqual({ kind: "resolving", workspace_id: null });
    expect(resolved()).toEqual({ kind: "resolving", workspace_id: WORKSPACE });
  });

  it("an authenticated user with a running container lands in ready with the opaque runtime", () => {
    const ready = advanceContainerResolution(resolved(), {
      type: "runtime_observed",
      runtime: snapshot(),
    });
    expect(ready).toEqual({
      kind: "ready",
      workspace_id: WORKSPACE,
      runtime: snapshot(),
    });
  });

  it("a pending/provisioning record surfaces the provisioning-in-progress state", () => {
    for (const provisioning_status of ["pending", "provisioning"] as const) {
      const state = advanceContainerResolution(resolved(), {
        type: "runtime_observed",
        runtime: snapshot({ provisioning_status }),
      });
      expect(state).toEqual({ kind: "provisioning", workspace_id: WORKSPACE });
    }
  });

  it("RUNTIME_NOT_PROVISIONED surfaces the honest prepare-your-workspace state", () => {
    const state = advanceContainerResolution(resolved(), { type: "runtime_not_provisioned" });
    expect(state).toEqual({ kind: "not_provisioned", workspace_id: WORKSPACE });
  });

  it("a typed resolution failure carries the safe_message for render", () => {
    // internal_details is nulled at the server boundary (D23 rule 4); the
    // client machine carries the typed error verbatim and the gate renders
    // safe_message only.
    const error = typedError();
    const state = advanceContainerResolution(resolved(), { type: "runtime_failed", error });
    expect(state).toMatchObject({ kind: "failed", workspace_id: WORKSPACE });
    if (state.kind !== "failed") throw new Error("expected failed");
    expect(state.error.safe_message).toBe(error.safe_message);
    expect(state.error.internal_details).toBeNull();
  });

  it("an unauthenticated answer surfaces the sign-in-required state", () => {
    const state = advanceContainerResolution(INITIAL_CONTAINER_RESOLUTION, {
      type: "session_unauthenticated",
    });
    expect(state).toEqual({ kind: "unauthenticated" });
  });

  it("ignores runtime observations that arrive before the workspace is known", () => {
    const state = advanceContainerResolution(INITIAL_CONTAINER_RESOLUTION, {
      type: "runtime_observed",
      runtime: snapshot(),
    });
    expect(state).toEqual({ kind: "resolving", workspace_id: null });
  });
});

describe("the explicit prepare-your-workspace trigger (owner-call disclosure)", () => {
  it("provision runs only from an explicit start event, then prepares", () => {
    const notProvisioned = advanceContainerResolution(resolved(), {
      type: "runtime_not_provisioned",
    });
    const preparing = advanceContainerResolution(notProvisioned, { type: "provision_started" });
    expect(preparing).toEqual({ kind: "preparing", workspace_id: WORKSPACE });

    const ready = advanceContainerResolution(preparing, {
      type: "provision_accepted",
      runtime: snapshot(),
    });
    expect(ready.kind).toBe("ready");
  });

  it("an accepted provision that is still building stays in provisioning, never ready", () => {
    const preparing = advanceContainerResolution(
      advanceContainerResolution(resolved(), { type: "runtime_not_provisioned" }),
      { type: "provision_started" },
    );
    const state = advanceContainerResolution(preparing, {
      type: "provision_accepted",
      runtime: snapshot({ provisioning_status: "provisioning", health: "unknown" }),
    });
    expect(state).toEqual({ kind: "provisioning", workspace_id: WORKSPACE });
  });

  it("RUNTIME_PROVISION_IN_PROGRESS lands in the provisioning state, not a failure", () => {
    const preparing = advanceContainerResolution(
      advanceContainerResolution(resolved(), { type: "runtime_not_provisioned" }),
      { type: "provision_started" },
    );
    const state = advanceContainerResolution(preparing, { type: "provision_in_progress" });
    expect(state).toEqual({ kind: "provisioning", workspace_id: WORKSPACE });
  });

  it("a failed provision surfaces the typed safe_message with retry when retryable", () => {
    const preparing = advanceContainerResolution(
      advanceContainerResolution(resolved(), { type: "runtime_not_provisioned" }),
      { type: "provision_started" },
    );
    const error = typedError({ retryable: true });
    const state = advanceContainerResolution(preparing, { type: "provision_failed", error });
    expect(state).toMatchObject({ kind: "failed", workspace_id: WORKSPACE, error });

    const retrying = advanceContainerResolution(state, { type: "retry" });
    expect(retrying).toEqual({ kind: "resolving", workspace_id: WORKSPACE });
  });
});

describe("honest states beyond the happy path", () => {
  it("a stopped container is a stopped state, and a running observation recovers it", () => {
    const stopped = advanceContainerResolution(resolved(), {
      type: "runtime_observed",
      runtime: snapshot({ provisioning_status: "stopped", health: "unknown" }),
    });
    expect(stopped).toEqual({ kind: "stopped", workspace_id: WORKSPACE });

    const recovered = advanceContainerResolution(stopped, {
      type: "runtime_observed",
      runtime: snapshot(),
    });
    expect(recovered.kind).toBe("ready");
  });

  it("a failed status record (no typed payload on a 200) uses the truthful fallback", () => {
    const state = advanceContainerResolution(resolved(), {
      type: "runtime_observed",
      runtime: snapshot({ provisioning_status: "failed" }),
    });
    if (state.kind !== "failed") throw new Error("expected failed");
    expect(state.error).toEqual(provisionFailedFallback());
    expect(state.error.retryable).toBe(true);
  });

  it("a session failure carries no workspace; retry re-enters resolution", () => {
    const state = advanceContainerResolution(INITIAL_CONTAINER_RESOLUTION, {
      type: "session_failed",
      error: typedError(),
    });
    expect(state).toMatchObject({ kind: "failed", workspace_id: null });
    expect(advanceContainerResolution(state, { type: "retry" })).toEqual({
      kind: "resolving",
      workspace_id: null,
    });
  });
});

describe("honest copy", () => {
  it("the prepare state explains the one-time step without promising execution", () => {
    expect(PREPARE_WORKSPACE_TITLE).toBe("Prepare your workspace");
    expect(PREPARE_WORKSPACE_COPY).toContain("one-time step");
    expect(PREPARE_WORKSPACE_COPY).toMatch(/nothing runs until it is ready/);
  });
});
