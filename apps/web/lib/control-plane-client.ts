import {
  ProvisionRuntimeResult,
  ResumeRuntimeResult,
  RuntimeStatus,
  Session,
  type SheraError,
} from "@shera-bot/contracts";

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

export class ControlPlaneError extends Error {
  readonly sheraError: SheraError;

  constructor(sheraError: SheraError) {
    super(sheraError.safe_message);
    this.name = "ControlPlaneError";
    this.sheraError = sheraError;
  }
}

/** A body that is not the typed taxonomy (transport noise) maps to honest fallback copy. */
const FALLBACK_ERROR: SheraError = {
  code: "INTERNAL_ERROR",
  category: "internal",
  safe_message: "Something went wrong. The failure has been recorded.",
  retryable: false,
  user_action: "Try again later.",
  internal_details: null,
  correlation_id: "client-fallback",
};

/** The app origin itself was unreachable — a transport failure, retryable. */
const UNREACHABLE_ERROR: SheraError = {
  code: "RESOURCE_UNAVAILABLE",
  category: "resource",
  safe_message: "The connection to Shera failed. You can try again.",
  retryable: true,
  user_action: "Try again shortly.",
  internal_details: null,
  correlation_id: "client-unreachable",
};

function typedErrorFromPayload(payload: unknown): ControlPlaneError {
  if (
    payload !== null &&
    typeof payload === "object" &&
    typeof (payload as Record<string, unknown>)["safe_message"] === "string" &&
    typeof (payload as Record<string, unknown>)["retryable"] === "boolean"
  ) {
    const candidate = payload as Record<string, unknown>;
    return new ControlPlaneError({
      code: typeof candidate["code"] === "string" ? candidate["code"] : FALLBACK_ERROR.code,
      category: "internal",
      safe_message: candidate["safe_message"] as string,
      retryable: candidate["retryable"] as boolean,
      user_action:
        typeof candidate["user_action"] === "string" ? (candidate["user_action"] as string) : null,
      internal_details: null,
      correlation_id:
        typeof candidate["correlation_id"] === "string"
          ? (candidate["correlation_id"] as string)
          : FALLBACK_ERROR.correlation_id,
    });
  }
  return new ControlPlaneError(FALLBACK_ERROR);
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
    throw typedErrorFromPayload(payload);
  }
  try {
    return parse(payload);
  } catch {
    // A 2xx body that fails its contract is a server drift, not user error.
    throw typedErrorFromPayload(null);
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
