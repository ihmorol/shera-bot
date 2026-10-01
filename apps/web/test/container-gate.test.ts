import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SheraError } from "@shera-bot/contracts";

import { ContainerGateSurface } from "../components/shell/container-gate";
import {
  PREPARE_WORKSPACE_ACTION,
  PREPARE_WORKSPACE_COPY,
  PREPARE_WORKSPACE_TITLE,
  PREPARING_WORKSPACE_COPY,
  SIGN_IN_REQUIRED_COPY,
  STARTING_WORKSPACE_COPY,
  WORKSPACE_STOPPED_COPY,
  type ContainerResolutionState,
  type RuntimeSnapshot,
} from "../lib/container-resolution";

/**
 * The container gate renders every §2.4 resolution state honestly: the
 * explicit prepare-your-workspace step, provisioning-in-progress, typed
 * failures with retry only when retryable, sign-in-required, stopped, and —
 * only when the container is ready — the dashboard children. Static markup
 * rendering (node environment, no DOM), like the other component suites.
 */

const WORKSPACE = "ws_account-1";

const READY_RUNTIME: RuntimeSnapshot = {
  runtime_handle: `rt_${"a".repeat(32)}`,
  provisioning_status: "running",
  health: "healthy",
  resource_summary: {
    tier: "balanced",
    cpu_vcpus: 2,
    memory_bytes: 4 * 1024 ** 3,
    storage_bytes: 25 * 1024 ** 3,
  },
};

function render(state: ContainerResolutionState, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ContainerGateSurface, {
      state,
      children: createElement("p", null, "DASHBOARD-CONTENT"),
      onPrepare: () => undefined,
      onStart: () => undefined,
      onRetry: () => undefined,
      ...props,
    }) as ReactElement,
  );
}

function typedError(overrides: Partial<SheraError> = {}): SheraError {
  return {
    code: "RUNTIME_PROVISION_FAILED",
    category: "resource",
    safe_message: "Your workspace could not be prepared. The failure has been recorded.",
    retryable: true,
    user_action: "Try again; if it keeps failing, contact the operator.",
    internal_details: null,
    correlation_id: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("gate states", () => {
  it("resolving is an aria-busy state without fabricated content", () => {
    const html = render({ kind: "resolving", workspace_id: null });
    expect(html).toContain("Resolving your workspace");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("DASHBOARD-CONTENT");
  });

  it("unauthenticated asks for sign-in with the proxied Google surface", () => {
    const html = render({ kind: "unauthenticated" });
    expect(html).toContain(SIGN_IN_REQUIRED_COPY);
    expect(html).toContain('href="/api/control/api/auth/signin/google"');
    expect(html).not.toContain("DASHBOARD-CONTENT");
  });

  it("not provisioned shows the honest one-time prepare step as an explicit action", () => {
    const html = render({ kind: "not_provisioned", workspace_id: WORKSPACE });
    expect(html).toContain(PREPARE_WORKSPACE_TITLE);
    expect(html).toContain(PREPARE_WORKSPACE_COPY);
    expect(html).toContain(PREPARE_WORKSPACE_ACTION);
    expect(html).not.toContain("DASHBOARD-CONTENT");
  });

  it("preparing and provisioning states never offer a second trigger", () => {
    for (const kind of ["preparing", "provisioning"] as const) {
      const html = render(
        kind === "preparing"
          ? { kind, workspace_id: WORKSPACE }
          : { kind, workspace_id: WORKSPACE },
      );
      expect(html).toContain(PREPARING_WORKSPACE_COPY);
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain("Prepare my workspace");
    }
  });

  it("stopped offers the start action", () => {
    const html = render({ kind: "stopped", workspace_id: WORKSPACE });
    expect(html).toContain(WORKSPACE_STOPPED_COPY);
    expect(html).toContain("Start my workspace");
  });

  it("starting is its own busy state — a booting container is not a container being created", () => {
    const html = render({ kind: "starting", workspace_id: WORKSPACE });
    expect(html).toContain(STARTING_WORKSPACE_COPY);
    expect(html).toContain('aria-busy="true"');
    // Distinct from the creation copy, and no second start trigger.
    expect(html).not.toContain(PREPARING_WORKSPACE_COPY);
    expect(html).not.toContain("Start my workspace");
  });

  it("failed renders the safe_message with retry only when retryable", () => {
    const retryable = render({ kind: "failed", workspace_id: WORKSPACE, error: typedError() });
    expect(retryable).toContain("Your workspace could not be prepared.");
    expect(retryable).toContain("Retry");

    const terminal = render({
      kind: "failed",
      workspace_id: WORKSPACE,
      error: typedError({ retryable: false }),
    });
    expect(terminal).toContain("Your workspace could not be prepared.");
    expect(terminal).not.toContain("Retry");
    // Internal details never render (D23 rule 4).
    expect(terminal).not.toMatch(/stack|correlation/i);
  });

  it("a ready container renders the dashboard children unchanged", () => {
    const html = render({ kind: "ready", workspace_id: WORKSPACE, runtime: READY_RUNTIME });
    expect(html).toContain("DASHBOARD-CONTENT");
    expect(html).not.toContain("Prepare your workspace");
  });
});
