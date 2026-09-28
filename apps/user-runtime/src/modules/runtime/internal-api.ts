/**
 * The runtime gateway's internal API (S06; D11, D2, PRD §16).
 *
 * The ONLY control-plane-reachable surface of the container. It has no
 * inbound public access: in local development it binds loopback, and in the
 * deployment topology (single-VM Compose, S35) it is reachable only on the
 * management network the control plane joins. Every endpoint sits behind the
 * per-container bearer token; the deterministic credential check runs BEFORE
 * any command is processed (G2), rejections are recorded as security events,
 * and the credential value never appears in any response, event, or log (G3).
 *
 * This surface is transport-generic and infrastructure-neutral: the same
 * Express app runs in the local container and would run unchanged in a
 * remote/cloud backend's runtime image (PRD §6.1).
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import {
  RuntimeCredentialCommitRequest,
  RuntimeCredentialCommitResponse,
  RuntimeCredentialRotationRequest,
  RuntimeCredentialRotationResponse,
  RuntimeRegistrationRequest,
  RuntimeRegistrationResponse,
  RUNTIME_CREDENTIALS_COMMIT_PATH,
  RUNTIME_CREDENTIALS_PATH,
  RUNTIME_REGISTRATION_PATH,
  type SheraError,
} from "@shera-bot/contracts";

import { ChannelCredentialStore } from "./channel-credentials.ts";
import {
  InMemorySecurityEventRecorder,
  type InternalSecurityEventRecorder,
} from "./channel-security-events.ts";
import { RuntimeRegistrationRegistry } from "./runtime-registration.ts";

export { ChannelCredentialStore, InMemorySecurityEventRecorder };
export type { RuntimeRegistration } from "./runtime-registration.ts";

function internalChannelError(
  code: "INTERNAL_CHANNEL_UNAUTHORIZED" | "CONTRACT_VALIDATION_FAILED",
  safe_message: string,
): SheraError {
  return {
    code,
    category: code === "INTERNAL_CHANNEL_UNAUTHORIZED" ? "unauthorized" : "validation",
    safe_message,
    retryable: false,
    user_action: null,
    internal_details: null,
    correlation_id: crypto.randomUUID(),
  };
}

function bearerOf(
  header: string | undefined,
): { ok: true; token: string } | { ok: false; reason: "missing_bearer" | "malformed_bearer" } {
  if (!header) return { ok: false, reason: "missing_bearer" };
  const match = /^Bearer (.+)$/s.exec(header);
  if (!match || !match[1]) return { ok: false, reason: "malformed_bearer" };
  return { ok: true, token: match[1] };
}

export interface InternalApiDeps {
  credentials: ChannelCredentialStore;
  securityEvents?: InternalSecurityEventRecorder;
  registrations?: RuntimeRegistrationRegistry;
}

export interface InternalApi {
  app: Express;
  registrations: RuntimeRegistrationRegistry;
}

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const credentials = deps.credentials;
  const securityEvents = deps.securityEvents ?? new InMemorySecurityEventRecorder();
  const registrations = deps.registrations ?? new RuntimeRegistrationRegistry();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  // Deterministic credential check BEFORE any command (G2): the bearer is
  // verified in constant time; a failure is recorded as a security event
  // (reason only — never the presented value) and answered with the typed 401.
  function requireChannelCredential(req: Request, res: Response, next: NextFunction): void {
    const bearer = bearerOf(req.headers.authorization);
    if (!bearer.ok) {
      securityEvents.record({
        event: "internal_channel_rejected",
        reason: bearer.reason,
        path: req.path,
        occurred_at: new Date().toISOString(),
      });
      res
        .status(401)
        .json(
          internalChannelError(
            "INTERNAL_CHANNEL_UNAUTHORIZED",
            "A valid runtime channel credential is required.",
          ),
        );
      return;
    }
    if (!credentials.verifies(bearer.token)) {
      securityEvents.record({
        event: "internal_channel_rejected",
        reason: "invalid_credential",
        path: req.path,
        occurred_at: new Date().toISOString(),
      });
      res
        .status(401)
        .json(
          internalChannelError(
            "INTERNAL_CHANNEL_UNAUTHORIZED",
            "A valid runtime channel credential is required.",
          ),
        );
      return;
    }
    res.locals.channelCredential = bearer.token;
    next();
  }

  /**
   * Registration: binds this gateway to its owning account (idempotent).
   * The response is the typed contract; nothing about the credential or the
   * host environment is included.
   */
  app.post(RUNTIME_REGISTRATION_PATH, requireChannelCredential, (req, res) => {
    const parsed = RuntimeRegistrationRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "The registration payload is not a valid RuntimeRegistrationRequest.",
          ),
        );
      return;
    }
    const registration = registrations.register(parsed.data);
    const response: RuntimeRegistrationResponse = {
      registered: true,
      runtime_handle: registration.runtime_handle,
      registered_at: registration.registered_at,
    };
    res.status(200).json(response);
  });

  /**
   * Rotation staging (authenticated with the CURRENT credential): admit the
   * new digest alongside the current one. Only a digest crosses the wire.
   */
  app.put(RUNTIME_CREDENTIALS_PATH, requireChannelCredential, (req, res) => {
    const parsed = RuntimeCredentialRotationRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "The rotation payload is not a valid RuntimeCredentialRotationRequest.",
          ),
        );
      return;
    }
    try {
      credentials.stage(parsed.data.credential_sha256);
    } catch {
      res
        .status(409)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "Credential rotation cannot be staged right now.",
          ),
        );
      return;
    }
    const response: RuntimeCredentialRotationResponse = { staged: true };
    res.status(200).json(response);
  });

  /**
   * Rotation commit (authenticated with the NEW credential): keep only the
   * presenter's digest; the previous credential stops verifying immediately.
   */
  app.post(RUNTIME_CREDENTIALS_COMMIT_PATH, requireChannelCredential, (req, res) => {
    const parsed = RuntimeCredentialCommitRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "The commit payload is not a valid RuntimeCredentialCommitRequest.",
          ),
        );
      return;
    }
    const presented = res.locals.channelCredential as string;
    credentials.commitTo(credentials.digestOf(presented));
    const response: RuntimeCredentialCommitResponse = { committed: true };
    res.status(200).json(response);
  });

  /** Health probe for the same authenticated channel (used by backend readiness). */
  app.get("/internal/v1/health", requireChannelCredential, (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return { app, registrations };
}
