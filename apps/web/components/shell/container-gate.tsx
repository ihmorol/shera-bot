"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shell/states";
import {
  INITIAL_CONTAINER_RESOLUTION,
  PREPARE_WORKSPACE_ACTION,
  PREPARE_WORKSPACE_COPY,
  PREPARE_WORKSPACE_TITLE,
  PREPARING_WORKSPACE_COPY,
  PREPARING_WORKSPACE_TITLE,
  SIGN_IN_REQUIRED_COPY,
  SIGN_IN_REQUIRED_TITLE,
  WORKSPACE_STOPPED_ACTION,
  WORKSPACE_STOPPED_COPY,
  WORKSPACE_STOPPED_TITLE,
  type ContainerResolutionState,
} from "@/lib/container-resolution";
import {
  useContainerResolution,
  useProvisionWorkspace,
  useRetryResolution,
  useStartStoppedWorkspace,
} from "@/lib/container-connection";

/**
 * Container gate (S09 chunk 1): the /app entry resolves the signed-in user's
 * workspace → container BEFORE the dashboard renders, and surfaces the
 * lifecycle honestly — including the one-time "prepare your workspace" step,
 * which is an EXPLICIT user action here and never part of sign-in (recorded
 * S06 NOTE; disclosed for the S09 PR). A ready workspace renders children
 * unchanged; every other state is a §2.4 surface with the single most likely
 * next action.
 */

function GatePanel({ title, copy, action }: { title: string; copy: string; action?: ReactNode }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center text-center">
      <h2 className="font-display text-lg font-semibold tracking-tight text-text">{title}</h2>
      <p className="mt-2 text-sm text-muted">{copy}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ContainerGateSurface({
  state,
  children,
  onPrepare,
  onStart,
  onRetry,
}: {
  state: ContainerResolutionState;
  children: ReactNode;
  onPrepare?: (() => void) | undefined;
  onStart?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
}) {
  switch (state.kind) {
    case "resolving":
      return (
        <div aria-busy="true" className="mx-auto flex h-full max-w-md items-center justify-center">
          <p className="animate-pulse text-sm text-muted">Resolving your workspace…</p>
        </div>
      );
    case "unauthenticated":
      return (
        <GatePanel
          title={SIGN_IN_REQUIRED_TITLE}
          copy={SIGN_IN_REQUIRED_COPY}
          action={
            // The Auth.js sign-in surface belongs to the control plane; the
            // proxy exposes it on this origin. After signing in, returning to
            // /app re-runs resolution.
            <Button asChild>
              <a href="/api/control/api/auth/signin/google">Continue with Google</a>
            </Button>
          }
        />
      );
    case "not_provisioned":
      return (
        <GatePanel
          title={PREPARE_WORKSPACE_TITLE}
          copy={PREPARE_WORKSPACE_COPY}
          action={
            <Button onClick={onPrepare} disabled={onPrepare === undefined}>
              {PREPARE_WORKSPACE_ACTION}
            </Button>
          }
        />
      );
    case "preparing":
    case "provisioning":
      return (
        <div aria-busy="true">
          <GatePanel title={PREPARING_WORKSPACE_TITLE} copy={PREPARING_WORKSPACE_COPY} />
        </div>
      );
    case "stopped":
      return (
        <GatePanel
          title={WORKSPACE_STOPPED_TITLE}
          copy={WORKSPACE_STOPPED_COPY}
          action={
            <Button onClick={onStart} disabled={onStart === undefined}>
              {WORKSPACE_STOPPED_ACTION}
            </Button>
          }
        />
      );
    case "failed":
      return (
        <ErrorState
          safeMessage={state.error.safe_message}
          onRetry={state.error.retryable ? onRetry : undefined}
        />
      );
    case "ready":
      return <>{children}</>;
  }
}

export function ContainerGate({ children }: { children: ReactNode }) {
  const resolution = useContainerResolution();
  const provision = useProvisionWorkspace();
  const start = useStartStoppedWorkspace();
  const retryResolution = useRetryResolution();
  const state = resolution.data ?? INITIAL_CONTAINER_RESOLUTION;

  return (
    <ContainerGateSurface
      state={state}
      onPrepare={provision.isPending ? undefined : () => provision.mutate()}
      onStart={start.isPending ? undefined : () => start.mutate()}
      onRetry={retryResolution}
    >
      {children}
    </ContainerGateSurface>
  );
}
