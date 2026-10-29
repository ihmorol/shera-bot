/**
 * Provider service (S23 chunk 4; PRD §9, §19 AC10/AC11, D17, D20, D22, E9,
 * G3, G4) — the registry boundary that owns provider configuration, credential
 * custody calls, and EFFECTIVE provider resolution.
 *
 * Boundary rules:
 *  - everything crossing this boundary is MASKED (G3): views carry the
 *    store-time credential hint only; the plaintext exists exclusively
 *    between `resolveCredentialForCall` and the adapter's outgoing request;
 *  - configuration is validated with typed errors BEFORE any call exists
 *    (AC "invalid configuration is rejected with a typed error before any
 *    call"), including the G3 header scan;
 *  - effective resolution is an HONEST union (AC11): the conversation
 *    override wins, then the conversation Agent's default pair; anything
 *    else is a named configuration state — never a fabricated fallback (D17).
 *
 * The Agent-defaults lookup is an injected seam so this service stays
 * provider-domain-only: the composition adapts it from the agents repository
 * (direct-chat binding + the user-owned default provider pair).
 */
import { randomUUID } from "node:crypto";

import type {
  EffectiveProvider,
  ProviderApiMode,
  ProviderConnectionTestResult,
  ProviderOrigin,
  ProviderProtocol,
  ProviderView,
} from "@shera-bot/contracts";

import type { ProvidersRepository } from "../../adapters/sqlite/providers-repository.ts";
import { runConnectionTest } from "./connection-test.ts";
import { assertCustomHeadersSafe } from "./provider-adapters.ts";
import { ProviderCredentialsService, ProviderCredentialError } from "./provider-credentials.ts";

export class ProviderServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`provider service: ${message}`);
    this.name = "ProviderServiceError";
    this.code = code;
  }
}

/** The agent-defaults seam (adapted from the agents repository at composition). */
export interface AgentProviderDefaultsLookup {
  /** The direct-chat binding: which Agent's chat is this conversation. */
  findAgentForDirectChat(workspaceId: string, conversationId: string): string | null;
  /** The user-owned default provider pair (D16) for one Agent. */
  getDefaultProvider(
    workspaceId: string,
    agentId: string,
  ): { provider_id: string; model: string } | null;
}

export interface ProviderConfigureInput {
  workspace_id: string;
  /** Optional stable id (the platform-provisioning route pins one for top-ups). */
  id?: string;
  display_name: string;
  protocol: ProviderProtocol;
  /** Null for the native adapters; http(s) required otherwise. */
  base_url: string | null;
  api_mode: ProviderApiMode;
  /** Required for api_key mode; forbidden for no_key mode. */
  credential: string | null;
  default_model_id: string;
  organization: string | null;
  project: string | null;
  headers: Record<string, string>;
  request_params: Record<string, string | number | boolean>;
  origin: ProviderOrigin;
}

export class ProviderService {
  constructor(
    private readonly deps: {
      providers: ProvidersRepository;
      credentials: ProviderCredentialsService;
      agentDefaults: AgentProviderDefaultsLookup;
      now?: () => string;
    },
  ) {}

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private mapError(error: unknown): never {
    if (error instanceof ProviderCredentialError) {
      throw new ProviderServiceError(error.code, error.message);
    }
    throw error;
  }

  // ---------------------------------------------------------------------------
  // Configuration (masked at the boundary, G3)
  // ---------------------------------------------------------------------------

  /** Create one provider entry, storing its credential in the same unit. */
  configure(input: ProviderConfigureInput): ProviderView {
    // Validate BEFORE any row exists (typed rejections precede writes).
    if (
      input.api_mode === "api_key" &&
      (input.credential === null || input.credential.trim() === "")
    ) {
      throw new ProviderServiceError(
        "PROVIDER_CONFIG_INVALID",
        "api_key mode requires a credential — store it, masked display only",
      );
    }
    if (input.api_mode === "no_key" && input.credential !== null) {
      throw new ProviderServiceError(
        "PROVIDER_CONFIG_INVALID",
        "no_key mode does not take a credential",
      );
    }
    const headersJson = JSON.stringify(input.headers);
    try {
      assertCustomHeadersSafe(headersJson);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : "PROVIDER_CONFIG_INVALID";
      throw new ProviderServiceError(code ?? "PROVIDER_CONFIG_INVALID", (error as Error).message);
    }

    const id = input.id ?? `prov_${randomUUID()}`;
    try {
      this.deps.providers.create({
        id,
        workspace_id: input.workspace_id,
        display_name: input.display_name,
        protocol: input.protocol,
        base_url: input.base_url,
        api_mode: input.api_mode,
        default_model_id: input.default_model_id,
        organization: input.organization,
        project: input.project,
        headers_json: headersJson,
        request_params_json: JSON.stringify(input.request_params),
        origin: input.origin,
        created_at: this.now(),
      });
      if (input.credential !== null) {
        this.setCredential(input.workspace_id, id, input.credential);
      }
    } catch (error) {
      this.mapError(error);
    }
    return this.getProviderView(input.workspace_id, id)!;
  }

  /** Replace or revoke the credential of one entry. */
  setCredential(workspaceId: string, providerId: string, secret: string): void {
    const row = this.deps.providers.get(workspaceId, providerId);
    if (!row) {
      throw new ProviderServiceError(
        "PROVIDER_NOT_FOUND",
        `provider ${providerId} does not exist in this workspace`,
      );
    }
    if (row.api_mode === "no_key") {
      throw new ProviderServiceError(
        "PROVIDER_CONFIG_INVALID",
        "no_key mode does not take a credential",
      );
    }
    try {
      this.deps.credentials.store(workspaceId, providerId, secret, this.now());
    } catch (error) {
      this.mapError(error);
    }
  }

  revokeCredential(workspaceId: string, providerId: string): boolean {
    return this.deps.credentials.revoke(workspaceId, providerId);
  }

  /**
   * Update one entry's mutable configuration fields (the platform top-up
   * path keeps a stable id and refreshes the config with it).
   */
  updateConfig(
    workspaceId: string,
    providerId: string,
    patch: {
      display_name?: string;
      base_url?: string | null;
      default_model_id?: string;
      organization?: string | null;
      project?: string | null;
      headers?: Record<string, string>;
      request_params?: Record<string, string | number | boolean>;
    },
  ): ProviderView {
    const updated = this.deps.providers.updateConfig(workspaceId, providerId, {
      ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
      ...(patch.base_url !== undefined ? { base_url: patch.base_url } : {}),
      ...(patch.default_model_id !== undefined ? { default_model_id: patch.default_model_id } : {}),
      ...(patch.organization !== undefined ? { organization: patch.organization } : {}),
      ...(patch.project !== undefined ? { project: patch.project } : {}),
      ...(patch.headers !== undefined ? { headers_json: JSON.stringify(patch.headers) } : {}),
      ...(patch.request_params !== undefined
        ? { request_params_json: JSON.stringify(patch.request_params) }
        : {}),
      updated_at: this.now(),
    });
    return this.toView(workspaceId, updated);
  }

  /** Enable/disable (PRD §9). */
  setStatus(workspaceId: string, providerId: string, enabled: boolean): ProviderView {
    const updated = this.deps.providers.setStatus(
      workspaceId,
      providerId,
      enabled ? "enabled" : "disabled",
      this.now(),
    );
    return this.toView(workspaceId, updated);
  }

  /** List a workspace's entries, masked (G3). */
  listProviders(workspaceId: string): ProviderView[] {
    return this.deps.providers.list(workspaceId).map((row) => this.toView(workspaceId, row));
  }

  getProviderView(workspaceId: string, providerId: string): ProviderView | null {
    const row = this.deps.providers.get(workspaceId, providerId);
    return row ? this.toView(workspaceId, row) : null;
  }

  /** The effective provider for one conversation (AC11). */
  resolveEffective(workspaceId: string, conversationId: string): EffectiveProvider {
    const override = this.deps.providers.getOverride(workspaceId, conversationId);
    if (override) {
      return this.resolveEntry(
        workspaceId,
        override.provider_id,
        override.model,
        "conversation_override",
      );
    }
    const agentId = this.deps.agentDefaults.findAgentForDirectChat(workspaceId, conversationId);
    if (agentId) {
      const pair = this.deps.agentDefaults.getDefaultProvider(workspaceId, agentId);
      if (pair) {
        return this.resolveEntry(workspaceId, pair.provider_id, pair.model, "agent_default");
      }
    }
    return {
      configured: false,
      code: "PROVIDER_NOT_CONFIGURED",
      safe_message:
        "No provider is configured for this conversation yet. Configure one in Settings → Providers & models, or set the Agent's default.",
    };
  }

  /**
   * Resolve ONE provider entry to its usable state: enabled + (for api_key
   * mode) a stored credential. Each failure is a named configuration state
   * (D17) — never a fallback.
   */
  private resolveEntry(
    workspaceId: string,
    providerId: string,
    model: string | null,
    source: "conversation_override" | "agent_default",
  ): EffectiveProvider {
    const row = this.deps.providers.get(workspaceId, providerId);
    if (!row) {
      return {
        configured: false,
        code: "PROVIDER_NOT_CONFIGURED",
        safe_message:
          "The configured provider no longer exists. Configure a provider in Settings → Providers & models.",
      };
    }
    if (row.status !== "enabled") {
      return {
        configured: false,
        code: "PROVIDER_DISABLED",
        safe_message: `The provider "${row.display_name}" is disabled. Enable it in Settings → Providers & models.`,
      };
    }
    if (row.api_mode === "api_key" && !this.deps.credentials.hasCredential(workspaceId, row.id)) {
      return {
        configured: false,
        code: "PROVIDER_CREDENTIAL_REVOKED",
        safe_message: `The provider "${row.display_name}" has no stored credential. Add a key in Settings → Providers & models.`,
      };
    }
    const resolvedModel = model ?? row.default_model_id;
    return {
      configured: true,
      provider_id: row.id,
      display_name: row.display_name,
      protocol: row.protocol,
      model: resolvedModel,
      source,
    };
  }

  /** Whether one provider entry has a stored credential (custody read-only). */
  hasCredential(workspaceId: string, providerId: string): boolean {
    return this.deps.credentials.hasCredential(workspaceId, providerId);
  }

  /**
   * The effective provider for one Agent's DEFAULT pair (no conversation
   * exists yet — the Operation-coordinator path). Same honest union.
   */
  resolveForAgent(workspaceId: string, agentId: string): EffectiveProvider {
    const pair = this.deps.agentDefaults.getDefaultProvider(workspaceId, agentId);
    if (!pair) {
      return {
        configured: false,
        code: "PROVIDER_NOT_CONFIGURED",
        safe_message:
          "No provider is configured for this Agent yet. Set the Agent's default in Settings → Agents.",
      };
    }
    return this.resolveEntry(workspaceId, pair.provider_id, pair.model, "agent_default");
  }

  /**
   * The per-conversation override (AC11): a later turn uses it; the Agent's
   * default is never rewritten. `providerId = null` clears the override.
   */
  setConversationOverride(
    workspaceId: string,
    conversationId: string,
    providerId: string,
    model: string | null,
  ): void {
    if (!this.deps.providers.get(workspaceId, providerId)) {
      throw new ProviderServiceError(
        "PROVIDER_NOT_FOUND",
        `provider ${providerId} does not exist in this workspace`,
      );
    }
    try {
      this.deps.providers.setOverride({
        workspace_id: workspaceId,
        conversation_id: conversationId,
        provider_id: providerId,
        model,
        updated_at: this.now(),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("CONVERSATION_NOT_FOUND")) {
        throw new ProviderServiceError(
          "PROVIDER_OVERRIDE_CONVERSATION_NOT_FOUND",
          `conversation ${conversationId} does not exist in this workspace`,
        );
      }
      throw error;
    }
  }

  clearConversationOverride(workspaceId: string, conversationId: string): boolean {
    const existing = this.deps.providers.getOverride(workspaceId, conversationId);
    if (!existing) {
      throw new ProviderServiceError(
        "PROVIDER_OVERRIDE_CONVERSATION_NOT_FOUND",
        `conversation ${conversationId} has no provider override to clear`,
      );
    }
    return this.deps.providers.clearOverride(workspaceId, conversationId);
  }

  // ---------------------------------------------------------------------------
  // Call-time + test-time custody (the ONLY plaintext consumers)
  // ---------------------------------------------------------------------------

  /** The call-time decryption — consumed by the adapter, never persisted. */
  resolveCredentialForCall(workspaceId: string, providerId: string): string | null {
    const row = this.deps.providers.get(workspaceId, providerId);
    if (!row) {
      throw new ProviderServiceError(
        "PROVIDER_NOT_FOUND",
        `provider ${providerId} does not exist in this workspace`,
      );
    }
    if (row.api_mode === "no_key") {
      return null;
    }
    try {
      return this.deps.credentials.decryptForCall(workspaceId, providerId);
    } catch (error) {
      this.mapError(error);
    }
  }

  /** The connection test (one real minimal request; honest + redacted). */
  async runConnectionTest(
    workspaceId: string,
    providerId: string,
  ): Promise<ProviderConnectionTestResult> {
    const row = this.deps.providers.get(workspaceId, providerId);
    if (!row) {
      return {
        ok: false,
        code: "PROVIDER_CONFIG_INVALID",
        safe_message: "This provider entry no longer exists.",
        http_status: null,
      };
    }
    let credential: string | null = null;
    if (row.api_mode === "api_key") {
      try {
        credential = this.resolveCredentialForCall(workspaceId, providerId);
      } catch (error) {
        this.mapError(error);
      }
    }
    return runConnectionTest(row, credential);
  }

  // ---------------------------------------------------------------------------

  /** The masked view (G3): the plaintext never crosses this line. */
  private toView(
    workspaceId: string,
    row: ReturnType<ProvidersRepository["get"]> &
      NonNullable<ReturnType<ProvidersRepository["get"]>>,
  ): ProviderView {
    void workspaceId;
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      display_name: row.display_name,
      protocol: row.protocol,
      base_url: row.base_url,
      api_mode: row.api_mode,
      default_model_id: row.default_model_id,
      organization: row.organization,
      project: row.project,
      headers: safeParseObject(row.headers_json),
      request_params: safeParseObject(row.request_params_json),
      origin: row.origin,
      status: row.status,
      credential_hint: this.deps.credentials.credentialHint(row.workspace_id, row.id),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}

function safeParseObject(json: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}
