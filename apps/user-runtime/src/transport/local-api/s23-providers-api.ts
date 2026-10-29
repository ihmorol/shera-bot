/**
 * S23 chunk 7 — the provider HTTP surface (PRD §9, §19 AC10/AC11, D17, D20,
 * D22, E9, E12, G3, G7).
 *
 * Every route is workspace-scoped (E12): workspace_id is required on every
 * read (query) and every mutation (body), and every underlying service call
 * is workspace-keyed. The CREDENTIAL crosses exactly ONE route in each
 * direction: `POST /v1/providers` and `POST .../credential` accept it in the
 * request body and return ONLY the masked view; no route ever echoes a
 * credential (G3). The platform provisioning route (`PUT /v1/providers/platform`,
 * E9: admin provisioning writes at provisioning/top-up time) is deliberately
 * NOT on the browser allowlist — it is reachable through the loopback surface
 * and the authenticated internal channel, never from the browser.
 *
 * The connection test is a POST (it makes a real request — a state-touching
 * operation, not a cached read); default CI answers it against LOCAL fake
 * endpoints only (the honest unreachable failure). Live-provider checks are
 * the separately documented opt-in suite (G7).
 */
import { randomUUID } from "node:crypto";

import type { Express } from "express";
import { z } from "zod";

import { Id, WorkspaceId } from "@shera-bot/contracts";

import type { ProviderService } from "../../modules/providers/provider-service.ts";
import { ProviderServiceError } from "../../modules/providers/provider-service.ts";
import type { ProviderConnectionTestResult, ProviderView } from "@shera-bot/contracts";

export const LIST_PROVIDERS_PATH = "/v1/providers" as const;
export const CREATE_PROVIDER_PATH = "/v1/providers" as const;
export const PROVIDER_CREDENTIAL_PATH = "/v1/providers/:provider_id/credential" as const;
export const PROVIDER_REVOKE_PATH = "/v1/providers/:provider_id/revoke" as const;
export const PROVIDER_STATUS_PATH = "/v1/providers/:provider_id/status" as const;
export const PROVIDER_TEST_PATH = "/v1/providers/:provider_id/test" as const;
export const PROVIDER_OVERRIDES_PATH = "/v1/providers/overrides" as const;
export const PROVIDER_EFFECTIVE_PATH = "/v1/providers/effective" as const;
export const PLATFORM_PROVIDER_PATH = "/v1/providers/platform" as const;

export interface ProvidersApiHandle {
  providers: ProviderService;
}

const WorkspaceQuery = z.strictObject({ workspace_id: WorkspaceId });

/** The PRD §9 custom-provider field list, as one typed request body. */
const CreateProviderBody = z.strictObject({
  workspace_id: WorkspaceId,
  display_name: z.string().min(1).max(120),
  protocol: z.enum(["openai", "anthropic", "google", "ollama", "openai-compatible"]),
  base_url: z.string().max(2048).nullable(),
  api_mode: z.enum(["api_key", "no_key"]),
  credential: z.string().min(1).max(8192).nullable(),
  default_model_id: z.string().min(1).max(256),
  organization: z.string().max(256).nullable(),
  project: z.string().max(256).nullable(),
  headers: z.record(z.string(), z.string()),
  request_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

const CredentialBody = z.strictObject({
  workspace_id: WorkspaceId,
  credential: z.string().min(1).max(8192),
});

const RevokeBody = z.strictObject({ workspace_id: WorkspaceId });

const StatusBody = z.strictObject({
  workspace_id: WorkspaceId,
  enabled: z.boolean(),
});

const OverrideBody = z.strictObject({
  workspace_id: WorkspaceId,
  conversation_id: Id,
  /** Null clears the override (AC11: back to the Agent default). */
  provider_id: Id.nullable(),
  model: z.string().min(1).max(256).nullable(),
});

const EffectiveQuery = z.strictObject({
  workspace_id: WorkspaceId,
  conversation_id: Id,
});

/**
 * The platform provisioning body (E9): the admin-funded provider + credential,
 * written at provisioning/top-up time. origin is ALWAYS 'platform' here — the
 * route is the only platform-entry writer.
 */
const PlatformProviderBody = z.strictObject({
  workspace_id: WorkspaceId,
  /** A stable id so top-ups REPLACE the credential instead of duplicating. */
  provider_id: Id,
  display_name: z.string().min(1).max(120),
  protocol: z.enum(["openai", "anthropic", "google", "ollama", "openai-compatible"]),
  base_url: z.string().max(2048).nullable(),
  api_mode: z.enum(["api_key", "no_key"]),
  credential: z.string().min(1).max(8192).nullable(),
  default_model_id: z.string().min(1).max(256),
  organization: z.string().max(256).nullable(),
  project: z.string().max(256).nullable(),
  headers: z.record(z.string(), z.string()),
  request_params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});

/** Map the service's typed errors onto the SheraError taxonomy (409 state / 400 validation). */
function providerServiceErrorResponse(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} | null {
  if (error instanceof ProviderServiceError) {
    const status = error.code === "PROVIDER_NOT_FOUND" ? 404 : 400;
    return {
      status,
      body: {
        code: error.code,
        category: status === 404 ? "state" : "validation",
        safe_message:
          error.code === "PROVIDER_NOT_FOUND"
            ? "That provider entry does not exist in this workspace."
            : "The provider configuration is not valid. Check the fields and try again.",
        retryable: false,
        user_action: null,
        internal_details: null,
        correlation_id: randomUUID(),
      },
    };
  }
  return null;
}

function validationResponse(message: string): {
  status: number;
  body: Record<string, unknown>;
} {
  return {
    status: 400,
    body: {
      code: "CONTRACT_VALIDATION_FAILED",
      category: "validation",
      safe_message: message,
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: randomUUID(),
    },
  };
}

/** Register the provider routes on the local API. */
export function registerProvidersRoutes(app: Express, deps: ProvidersApiHandle): void {
  // GET /v1/providers — the masked list (G3: hints only).
  app.get(LIST_PROVIDERS_PATH, (req, res) => {
    const query = WorkspaceQuery.safeParse(req.query);
    if (!query.success) {
      const mapped = validationResponse(
        "The providers request is not valid: a workspace_id is required.",
      );
      res.status(mapped.status).json(mapped.body);
      return;
    }
    res.status(200).json({ providers: deps.providers.listProviders(query.data.workspace_id) });
  });

  // POST /v1/providers — configure one custom provider (credential accepted
  // once, masked view returned).
  app.post(CREATE_PROVIDER_PATH, (req, res) => {
    const parsed = CreateProviderBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse("The provider configuration is not valid.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      const view = deps.providers.configure({
        workspace_id: parsed.data.workspace_id,
        display_name: parsed.data.display_name,
        protocol: parsed.data.protocol,
        base_url: parsed.data.base_url,
        api_mode: parsed.data.api_mode,
        credential: parsed.data.credential,
        default_model_id: parsed.data.default_model_id,
        organization: parsed.data.organization,
        project: parsed.data.project,
        headers: parsed.data.headers,
        request_params: parsed.data.request_params,
        origin: "user",
      });
      res.status(201).json(view);
    } catch (error) {
      const mapped = providerServiceErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // POST .../credential — replace the credential (masked view returned).
  app.post(PROVIDER_CREDENTIAL_PATH, (req, res) => {
    const parsed = CredentialBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse("The credential request is not valid.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      deps.providers.setCredential(
        parsed.data.workspace_id,
        req.params.provider_id,
        parsed.data.credential,
      );
      const view = deps.providers.getProviderView(parsed.data.workspace_id, req.params.provider_id);
      if (!view) {
        throw new ProviderServiceError(
          "PROVIDER_NOT_FOUND",
          `provider ${req.params.provider_id} does not exist`,
        );
      }
      res.status(200).json(view);
    } catch (error) {
      const mapped = providerServiceErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // POST .../revoke — the sealed payload is deleted (D22).
  app.post(PROVIDER_REVOKE_PATH, (req, res) => {
    const parsed = RevokeBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse(
        "The revoke request is not valid: a workspace_id is required.",
      );
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      deps.providers.revokeCredential(parsed.data.workspace_id, req.params.provider_id);
      const view = deps.providers.getProviderView(parsed.data.workspace_id, req.params.provider_id);
      if (!view) {
        throw new ProviderServiceError(
          "PROVIDER_NOT_FOUND",
          `provider ${req.params.provider_id} does not exist`,
        );
      }
      res.status(200).json(view);
    } catch (error) {
      const mapped = providerServiceErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // POST .../status — enable/disable (PRD §9).
  app.post(PROVIDER_STATUS_PATH, (req, res) => {
    const parsed = StatusBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse("The status request is not valid.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      res
        .status(200)
        .json(
          deps.providers.setStatus(
            parsed.data.workspace_id,
            req.params.provider_id,
            parsed.data.enabled,
          ),
        );
    } catch (error) {
      const mapped = providerServiceErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // POST .../test — ONE real minimal request; honest + redacted (G7: local
  // fakes in CI; live providers are the opt-in suite).
  app.post(PROVIDER_TEST_PATH, (req, res) => {
    const parsed = RevokeBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse(
        "The connection test request is not valid: a workspace_id is required.",
      );
      res.status(mapped.status).json(mapped.body);
      return;
    }
    deps.providers
      .runConnectionTest(parsed.data.workspace_id, req.params.provider_id)
      .then((result: ProviderConnectionTestResult) => {
        res.status(200).json(result);
      })
      .catch((error: unknown) => {
        const mapped = providerServiceErrorResponse(error);
        if (mapped) {
          res.status(mapped.status).json(mapped.body);
          return;
        }
        throw error;
      });
  });

  // POST /v1/providers/overrides — set (or clear, provider_id null) the AC11
  // per-conversation override.
  app.post(PROVIDER_OVERRIDES_PATH, (req, res) => {
    const parsed = OverrideBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse("The override request is not valid.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    try {
      if (parsed.data.provider_id === null) {
        deps.providers.clearConversationOverride(
          parsed.data.workspace_id,
          parsed.data.conversation_id,
        );
      } else {
        deps.providers.setConversationOverride(
          parsed.data.workspace_id,
          parsed.data.conversation_id,
          parsed.data.provider_id,
          parsed.data.model,
        );
      }
      const effective = deps.providers.resolveEffective(
        parsed.data.workspace_id,
        parsed.data.conversation_id,
      );
      res
        .status(200)
        .json({ override: parsed.data.provider_id === null ? null : parsed.data, effective });
    } catch (error) {
      const mapped = providerServiceErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });

  // GET /v1/providers/effective — the chat header's data source (AC11): the
  // honest union (configured resolution or the named configuration state).
  app.get(PROVIDER_EFFECTIVE_PATH, (req, res) => {
    const parsed = EffectiveQuery.safeParse(req.query);
    if (!parsed.success) {
      const mapped = validationResponse(
        "The effective-provider request is not valid: workspace_id and conversation_id are required.",
      );
      res.status(mapped.status).json(mapped.body);
      return;
    }
    res
      .status(200)
      .json(deps.providers.resolveEffective(parsed.data.workspace_id, parsed.data.conversation_id));
  });

  // PUT /v1/providers/platform — the E9 admin provisioning path (write-only;
  // NOT browser-allowlisted). A repeated provider_id REPLACES the credential
  // (top-up time), matching the recorded custody lifecycle.
  app.put(PLATFORM_PROVIDER_PATH, (req, res) => {
    const parsed = PlatformProviderBody.safeParse(req.body);
    if (!parsed.success) {
      const mapped = validationResponse("The platform provisioning request is not valid.");
      res.status(mapped.status).json(mapped.body);
      return;
    }
    const { workspace_id, provider_id, credential, ...config } = parsed.data;
    try {
      const existing = deps.providers.getProviderView(workspace_id, provider_id);
      if (existing) {
        // Top-up (E9: provisioning/top-up time): refresh the configuration
        // under the STABLE id and replace the credential. Write-only.
        deps.providers.updateConfig(workspace_id, provider_id, {
          display_name: config.display_name,
          ...(config.base_url !== undefined ? { base_url: config.base_url } : {}),
          default_model_id: config.default_model_id,
          organization: config.organization,
          project: config.project,
          headers: config.headers,
          request_params: config.request_params,
        });
        deps.providers.setStatus(workspace_id, provider_id, true);
        if (credential !== null) {
          deps.providers.setCredential(workspace_id, provider_id, credential);
        }
        res.status(200).json(deps.providers.getProviderView(workspace_id, provider_id));
        return;
      }
      const view = deps.providers.configure({
        workspace_id,
        id: provider_id,
        display_name: config.display_name,
        protocol: config.protocol,
        base_url: config.base_url,
        api_mode: config.api_mode,
        credential,
        default_model_id: config.default_model_id,
        organization: config.organization,
        project: config.project,
        headers: config.headers,
        request_params: config.request_params,
        origin: "platform",
      });
      res.status(201).json(view);
    } catch (error) {
      const mapped = providerServiceErrorResponse(error);
      if (mapped) {
        res.status(mapped.status).json(mapped.body);
        return;
      }
      throw error;
    }
  });
}

/** The masked wire view helper (routes never hand-build provider JSON). */
export type { ProviderView };
