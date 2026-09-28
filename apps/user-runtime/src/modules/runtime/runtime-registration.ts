/**
 * Runtime registration records (S06; D2, D11).
 *
 * Registration binds the container's runtime gateway to its owning account:
 * the control plane calls the registration endpoint over the authenticated
 * internal channel right after provisioning. The gateway keeps the binding as
 * its first control-plane-provided record; S07 persists it in the
 * container-local database when persistence lands. Re-registration for the
 * same account is idempotent (it updates the same binding).
 */
import { z } from "zod";

import { RuntimeRegistrationRequest } from "@shera-bot/contracts";

export interface RuntimeRegistration {
  account_id: string;
  runtime_handle: string;
  tier: "light" | "balanced" | "heavy";
  registered_at: string;
}

export class RuntimeRegistrationRegistry {
  private readonly byAccount = new Map<string, RuntimeRegistration>();

  /** Idempotent: re-registration for an account updates the same binding. */
  register(request: z.infer<typeof RuntimeRegistrationRequest>): RuntimeRegistration {
    const registration: RuntimeRegistration = {
      account_id: request.account_id,
      runtime_handle: request.runtime_handle,
      tier: request.tier,
      registered_at: new Date().toISOString(),
    };
    this.byAccount.set(request.account_id, registration);
    return registration;
  }

  list(): RuntimeRegistration[] {
    return [...this.byAccount.values()];
  }
}
