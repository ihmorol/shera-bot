import { z } from "zod";

import { OnboardingCommand, OnboardingSnapshot } from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * S30 — the typed browser client for the D16 onboarding surface (E43 chat
 * cards client-side), through the same-origin runtime proxy. The snapshot is
 * the runtime's resumable state; the commands (answer / dismiss / reopen)
 * ride the ONE typed envelope, the actor bound SERVER-SIDE by the proxy (G6).
 */

const OnboardingPayload = z.strictObject({ onboarding: OnboardingSnapshot });

export type OnboardingSnapshotView = z.infer<typeof OnboardingSnapshot>;
export type OnboardingStepView = OnboardingSnapshotView["steps"][number];

/** The resumable interview snapshot (status, steps, answers, provider read). */
export function fetchOnboarding(workspaceId: string): Promise<OnboardingSnapshotView> {
  return requestRuntime(
    `/api/runtime/v1/onboarding?workspace_id=${encodeURIComponent(workspaceId)}`,
    (payload) => OnboardingPayload.parse(payload).onboarding,
  );
}

/** One typed onboarding command (answer / dismiss / reopen). */
export function submitOnboardingCommand(
  workspaceId: string,
  command: z.infer<typeof OnboardingCommand>,
): Promise<unknown> {
  return requestRuntime("/api/runtime/v1/onboarding/commands", (payload) => payload, {
    method: "POST",
    body: JSON.stringify(command),
  });
}
