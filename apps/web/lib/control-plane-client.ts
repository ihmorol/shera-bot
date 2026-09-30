import {
  ProvisionRuntimeResult,
  ResumeRuntimeResult,
  RuntimeStatus,
  Session,
} from "@shera-bot/contracts";

import { TypedHttpError, UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * Typed browser client for the control plane (S09 chunk 1), reached through
 * the same-origin proxy (/api/control/* → CONTROL_PLANE_URL). Every failure
 * answers with the S02 typed taxonomy (D23 rule 4): the client parses the
 * proxy's SheraError body and raises it as a ControlPlaneError, so callers
 * surface safe_message + retryable — never internals (G3, §7).
 *
 * The S02 shapes are Zod-validated at this boundary (D25): a drifted payload
 * fails loudly instead of leaking a malformed session into the UI.
 */

export class ControlPlaneError extends TypedHttpError {
  constructor(sheraError: TypedHttpError["sheraError"]) {
    super(sheraError);
    this.name = "ControlPlaneError";
  }
}

function toControlPlaneError(payload: unknown): ControlPlaneError {
  const typed = typedErrorFromPayload(payload);
  return typed instanceof ControlPlaneError ? typed : new ControlPlaneError(typed.sheraError);
}

async function requestTyped<T>(
  path: string,
  parse: (payload: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    response = await fetch(path, { ...init, headers });
  } catch {
    // The proxy itself answers typed bodies for upstream failures; a thrown
    // fetch here means the app origin is unreachable — a retryable transport
    // failure, stated honestly.
    throw new ControlPlaneError(UNREACHABLE_ERROR);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw toControlPlaneError(payload);
  }
  try {
    return parse(payload);
  } catch {
    // A 2xx body that fails its contract is a server drift, not user error.
    throw toControlPlaneError(null);
  }
}

/** The S02 session projection: workspace binding + account identity. */
export function fetchSession(): Promise<Session> {
  return requestTyped("/api/control/api/session", (payload) => Session.parse(payload));
}

/** Truthful current runtime status (S06); RUNTIME_NOT_PROVISIONED is a typed error. */
export function fetchRuntimeStatus(): Promise<RuntimeStatus> {
  return requestTyped("/api/control/api/runtime/status", (payload) => RuntimeStatus.parse(payload));
}

/**
 * The EXPLICIT provisioning trigger (owner-call disclosure, S09 PR): called
 * from the "prepare your workspace" client-flow step, never from sign-in —
 * wiring it into the signIn hook would attempt real container creation inside
 * S05 auth tests on CI runners (recorded S06 NOTE).
 */
export function provisionRuntime(): Promise<ProvisionRuntimeResult> {
  return requestTyped(
    "/api/control/api/runtime/provision",
    (payload) => ProvisionRuntimeResult.parse(payload),
    { method: "POST" },
  );
}

/** Bring a stopped workspace back (S06 idempotent resume). */
export function restartRuntime(): Promise<ResumeRuntimeResult> {
  return requestTyped(
    "/api/control/api/runtime/restart",
    (payload) => ResumeRuntimeResult.parse(payload),
    { method: "POST" },
  );
}
