/**
 * Provider gate (S23 chunk 5; D17, D20, D22, G3, G4) — the enforcement seam
 * that keeps a provider-less runtime honest at the two boundaries where a
 * model call would happen:
 *
 *   1. TURNS (message.send): a conversation whose effective provider does not
 *      resolve is refused BEFORE anything is written — the composer's
 *      explanatory state has a runtime backstop, and nothing fabricates a
 *      completion (G4; the AC test pins the empty stream).
 *   2. RUN STARTS: a run whose provider snapshot references a missing,
 *      disabled, or revoked-credential provider is refused — the run fails
 *      safely with a typed journal refusal on its own stream (D20/D22), and
 *      no worker ever spawns.
 *
 * The gate is composed ONLY when the composition asks for enforcement
 * (`providerEnforcement: true` — the real runtime posture). The E2E mock
 * harness does not enforce: the scripted producer is the explicitly selected
 * D51 mock harness, not a fallback, and the composition refuses to combine
 * the two (typed startup failure — G4/G5). The recorded rationale lives in
 * the slice's engineering record.
 */
import type { EffectiveProvider } from "@shera-bot/contracts";

import type { ProviderService } from "./provider-service.ts";

export class ProviderGateError extends Error {
  readonly code: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_DISABLED" | "PROVIDER_CREDENTIAL_REVOKED";
  /** The display-safe reason (authored copy from the resolution union — G3). */
  readonly safe_message: string;

  constructor(code: (typeof ProviderGateError.prototype)["code"], safe_message: string) {
    super(`${code}: ${safe_message}`);
    this.name = "ProviderGateError";
    this.code = code;
    this.safe_message = safe_message;
  }
}

function refusalFor(effective: EffectiveProvider): ProviderGateError | null {
  return effective.configured
    ? null
    : new ProviderGateError(effective.code, effective.safe_message);
}

export class ProviderGate {
  constructor(private readonly deps: { providers: ProviderService }) {}

  /** Typed refusal for a turn whose conversation has no usable provider. */
  assertTurnAllowed(workspaceId: string, conversationId: string): void {
    const refusal = refusalFor(this.deps.providers.resolveEffective(workspaceId, conversationId));
    if (refusal) {
      throw refusal;
    }
  }

  /** Typed refusal for a turn on one Agent's default (no conversation yet). */
  assertAgentTurnAllowed(workspaceId: string, agentId: string): void {
    const refusal = refusalFor(this.deps.providers.resolveForAgent(workspaceId, agentId));
    if (refusal) {
      throw refusal;
    }
  }

  /**
   * The run-start custody check (D20/D22): a run may start only when its
   * provider snapshot references an enabled provider whose credential is
   * stored. Every refusal is a named configuration state — never a fallback.
   */
  checkRunStart(
    workspaceId: string,
    providerId: string,
  ): { ok: true } | { ok: false; code: string; safe_message: string } {
    const row = this.deps.providers.getProviderView(workspaceId, providerId);
    if (!row) {
      return {
        ok: false,
        code: "PROVIDER_NOT_CONFIGURED",
        safe_message:
          "The run's provider no longer exists. Configure a provider in Settings → Providers & models.",
      };
    }
    if (row.status !== "enabled") {
      return {
        ok: false,
        code: "PROVIDER_DISABLED",
        safe_message: `The provider "${row.display_name}" is disabled. Enable it in Settings → Providers & models.`,
      };
    }
    if (row.api_mode === "api_key" && !this.deps.providers.hasCredential(workspaceId, providerId)) {
      return {
        ok: false,
        code: "PROVIDER_CREDENTIAL_REVOKED",
        safe_message: `The provider "${row.display_name}" has no stored credential. Add a key in Settings → Providers & models.`,
      };
    }
    return { ok: true };
  }
}
