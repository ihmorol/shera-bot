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
  isBrowserRuntimePath,
  runtimeWorkspaceMatches,
  RuntimeAdminCancelAllRequest,
  RuntimeAdminCancelAllResponse,
  RuntimeAdminCreditTopUpRequest,
  RuntimeAdminCreditTopUpResponse,
  RuntimeAdminTaskFailuresRequest,
  RuntimeAdminTaskFailuresResponse,
  RUNTIME_ADMIN_TASK_FAILURES_PATH,
  RUNTIME_ADMIN_CREDITS_TOP_UP_PATH,
  RuntimeCredentialCommitRequest,
  RuntimeCredentialCommitResponse,
  RuntimeCredentialRotationRequest,
  RuntimeCredentialRotationResponse,
  RuntimeRegistrationRequest,
  RuntimeRegistrationResponse,
  RUNTIME_ADMIN_CANCEL_ALL_PATH,
  RUNTIME_CREDENTIALS_COMMIT_PATH,
  RUNTIME_CREDENTIALS_PATH,
  RUNTIME_REGISTRATION_PATH,
  type SheraError,
} from "@shera-bot/contracts";

import type { RuntimeAdminCommandsHandle } from "../admin/runtime-admin-commands.ts";

import { ChannelCredentialStore } from "./channel-credentials.ts";
import {
  InMemorySecurityEventRecorder,
  type InternalSecurityEventRecorder,
} from "./channel-security-events.ts";
import { RuntimeRegistrationRegistry } from "./runtime-registration.ts";
import {
  notFoundRequestHandler,
  typedErrorRequestHandler,
} from "../../transport/http/typed-errors.ts";

export { ChannelCredentialStore, InMemorySecurityEventRecorder };
export type { RuntimeRegistration } from "./runtime-registration.ts";

function internalChannelError(
  code:
    | "INTERNAL_CHANNEL_UNAUTHORIZED"
    | "CONTRACT_VALIDATION_FAILED"
    | "RUNTIME_TENANT_MISMATCH"
    | "INTERNAL_ERROR",
  safe_message: string,
): SheraError {
  return {
    code,
    category:
      code === "CONTRACT_VALIDATION_FAILED"
        ? "validation"
        : code === "INTERNAL_ERROR"
          ? "internal"
          : "unauthorized",
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
  accountId?: string;
  localApi?: Express;
  securityEvents?: InternalSecurityEventRecorder;
  registrations?: RuntimeRegistrationRegistry;
  /** S32: the admin command seam (emergency cancel-all; chunk-6/7 legs). */
  adminCommands?: RuntimeAdminCommandsHandle;
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
    if (deps.accountId !== undefined && parsed.data.account_id !== deps.accountId) {
      res
        .status(403)
        .json(
          internalChannelError(
            "RUNTIME_TENANT_MISMATCH",
            "This runtime belongs to another account.",
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

  /**
   * S32 admin commands (issue #33, D47): served over the SAME channel as
   * registration/rotation — the per-container bearer — and tenant-checked
   * against THIS runtime's account binding before any command executes. The
   * admin actor id arrives from the control plane (the admin token it acted
   * with); this surface never sees the admin token itself (G3).
   */
  app.post(RUNTIME_ADMIN_CANCEL_ALL_PATH, requireChannelCredential, (req, res) => {
    const parsed = RuntimeAdminCancelAllRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "The cancel-all payload is not a valid RuntimeAdminCancelAllRequest.",
          ),
        );
      return;
    }
    if (deps.accountId !== undefined && parsed.data.workspace_id !== `ws_${deps.accountId}`) {
      securityEvents.record({
        event: "internal_admin_command_refused",
        reason: "workspace_tenant_mismatch",
        path: RUNTIME_ADMIN_CANCEL_ALL_PATH,
        occurred_at: new Date().toISOString(),
      });
      res
        .status(403)
        .json(
          internalChannelError(
            "RUNTIME_TENANT_MISMATCH",
            "This workspace does not belong to this runtime.",
          ),
        );
      return;
    }
    if (!deps.adminCommands) {
      // The runtime composition always builds the handle; an absence is a
      // composition error, never a silent drop (G5).
      res
        .status(503)
        .json(
          internalChannelError(
            "INTERNAL_ERROR",
            "The admin command surface is not wired in this composition.",
          ),
        );
      return;
    }
    deps.adminCommands
      .cancelAllRuns({ workspaceId: parsed.data.workspace_id, actor: parsed.data.actor })
      .then((result) => {
        const response: RuntimeAdminCancelAllResponse = {
          workspace_id: result.workspace_id,
          results: result.results.map((row) => ({
            run_id: row.run_id,
            // The outcome vocabulary is contract-checked at the boundary.
            outcome: row.outcome as RuntimeAdminCancelAllResponse["results"][number]["outcome"],
          })),
        };
        res.status(200).json(response);
      })
      .catch(() => {
        res
          .status(500)
          .json(
            internalChannelError(
              "INTERNAL_ERROR",
              "The cancel-all command could not be completed.",
            ),
          );
      });
  });

  /** Credit top-up apply (D48): resume the workspace's insufficient-credit
   * pauses through the recorded resume_task transition. Same channel, same
   * tenant check. */
  app.post(RUNTIME_ADMIN_CREDITS_TOP_UP_PATH, requireChannelCredential, (req, res) => {
    const parsed = RuntimeAdminCreditTopUpRequest.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "The top-up payload is not a valid RuntimeAdminCreditTopUpRequest.",
          ),
        );
      return;
    }
    if (deps.accountId !== undefined && parsed.data.workspace_id !== `ws_${deps.accountId}`) {
      securityEvents.record({
        event: "internal_admin_command_refused",
        reason: "workspace_tenant_mismatch",
        path: RUNTIME_ADMIN_CREDITS_TOP_UP_PATH,
        occurred_at: new Date().toISOString(),
      });
      res
        .status(403)
        .json(
          internalChannelError(
            "RUNTIME_TENANT_MISMATCH",
            "This workspace does not belong to this runtime.",
          ),
        );
      return;
    }
    if (!deps.adminCommands) {
      res
        .status(503)
        .json(
          internalChannelError(
            "INTERNAL_ERROR",
            "The admin command surface is not wired in this composition.",
          ),
        );
      return;
    }
    deps.adminCommands
      .applyCreditTopUp({
        workspaceId: parsed.data.workspace_id,
        topupId: parsed.data.topup_id,
        amount: parsed.data.amount,
        ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
        actor: parsed.data.actor,
      })
      .then((result) => {
        const response: RuntimeAdminCreditTopUpResponse = {
          workspace_id: result.workspace_id,
          topup_id: result.topup_id,
          resumed_run_ids: result.resumed_run_ids,
          skipped: result.skipped,
        };
        res.status(200).json(response);
      })
      .catch(() => {
        res
          .status(500)
          .json(
            internalChannelError("INTERNAL_ERROR", "The top-up command could not be completed."),
          );
      });
  });

  /** Task-failure read (PRD §15): the journal's FAILED/RECOVERY_REQUIRED
   * runs. A read, so the channel credential still gates it. */
  app.get(RUNTIME_ADMIN_TASK_FAILURES_PATH, requireChannelCredential, (req, res) => {
    const query = RuntimeAdminTaskFailuresRequest.safeParse({
      workspace_id: req.query.workspace_id,
      ...(req.query.limit !== undefined ? { limit: Number(req.query.limit) } : {}),
    });
    if (!query.success) {
      res
        .status(400)
        .json(
          internalChannelError(
            "CONTRACT_VALIDATION_FAILED",
            "The task-failures request is not valid: a workspace_id is required.",
          ),
        );
      return;
    }
    if (deps.accountId !== undefined && query.data.workspace_id !== `ws_${deps.accountId}`) {
      securityEvents.record({
        event: "internal_admin_command_refused",
        reason: "workspace_tenant_mismatch",
        path: RUNTIME_ADMIN_TASK_FAILURES_PATH,
        occurred_at: new Date().toISOString(),
      });
      res
        .status(403)
        .json(
          internalChannelError(
            "RUNTIME_TENANT_MISMATCH",
            "This workspace does not belong to this runtime.",
          ),
        );
      return;
    }
    if (!deps.adminCommands) {
      res
        .status(503)
        .json(
          internalChannelError(
            "INTERNAL_ERROR",
            "The admin command surface is not wired in this composition.",
          ),
        );
      return;
    }
    deps.adminCommands
      .listTaskFailures({ workspaceId: query.data.workspace_id, limit: query.data.limit })
      .then((result) => {
        const response: RuntimeAdminTaskFailuresResponse = {
          workspace_id: result.workspace_id,
          failures: result.failures,
        };
        res.status(200).json(response);
      })
      .catch(() => {
        res
          .status(500)
          .json(
            internalChannelError("INTERNAL_ERROR", "The task-failure read could not be completed."),
          );
      });
  });

  /** Health probe for the same authenticated channel (used by backend readiness). */
  app.get("/internal/v1/health", requireChannelCredential, (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Typed error middleware (closes the S06 review NOTE): every thrown failure
  // and every unknown route answers with the SheraError taxonomy — never an
  // Express default page, a stack trace, or raw internals (D23 rule 4, G3).
  if (deps.localApi && deps.accountId) {
    const localApi = deps.localApi;
    const workspaceId = `ws_${deps.accountId}`;
    app.use("/internal/v1/local", requireChannelCredential, (req, res, next) => {
      if (!isBrowserRuntimePath(req.method, req.path)) {
        notFoundRequestHandler(req, res, next);
        return;
      }
      const query = new URL(req.url, "http://runtime.invalid").searchParams;
      if (!runtimeWorkspaceMatches(req.method, query, req.body, workspaceId)) {
        res
          .status(403)
          .json(
            internalChannelError(
              "RUNTIME_TENANT_MISMATCH",
              "This workspace does not belong to this runtime.",
            ),
          );
        return;
      }
      delete req.headers.authorization;
      localApi(req, res, next);
    });
  }

  app.use(notFoundRequestHandler);
  app.use(typedErrorRequestHandler);

  return { app, registrations };
}
