import { z } from "zod";

import {
  EffectiveProvider,
  ProviderView,
  type ProviderConnectionTestResult,
  type ProviderView as ProviderViewType,
} from "@shera-bot/contracts";

import { requestRuntime } from "@/lib/runtime-client";

/**
 * Typed browser client for the S23 provider surface (PRD §9, AC10/AC11,
 * D17, D22, E9, G3), reached through the same-origin runtime proxy exactly
 * like every other client (lib/runtime-client.ts — the same transport idiom
 * and typed failures).
 *
 * Custody shape (G3/D22): the credential crosses this module exactly ONCE —
 * accepted in a request body, never read back. Every read returns the masked
 * wire view (the store-time hint at most), so the UI has nothing to leak.
 * The platform provisioning route is deliberately absent: admin provisioning
 * writes through the internal channel only (E9), never from the browser.
 *
 * The connection test is a POST (it makes one real minimal request); the
 * answer is the honest typed union — success or a redacted failure. Live
 * providers are the opt-in suite (G7); default CI answers against local
 * fakes.
 */

const ProvidersResponse = z.strictObject({
  providers: z.array(ProviderView),
});

const OverrideResponse = z.strictObject({
  override: z.unknown().nullable(),
  effective: EffectiveProvider,
});

export function fetchProviders(workspaceId: string): Promise<ProviderViewType[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestRuntime(
    `/api/runtime/v1/providers?${query.toString()}`,
    (payload) => ProvidersResponse.parse(payload).providers,
  );
}

/** The PRD §9 custom-provider configuration payload (the one credential write). */
export interface ConfigureProviderInput {
  workspaceId: string;
  displayName: string;
  protocol: ProviderViewType["protocol"];
  baseUrl: string | null;
  apiMode: "api_key" | "no_key";
  /** Accepted once; only the masked view comes back. */
  credential: string | null;
  defaultModelId: string;
  organization: string | null;
  project: string | null;
  headers: Record<string, string>;
  requestParams: Record<string, string | number | boolean>;
}

export function configureProvider(input: ConfigureProviderInput): Promise<ProviderViewType> {
  return requestRuntime("/api/runtime/v1/providers", (payload) => ProviderView.parse(payload), {
    method: "POST",
    body: JSON.stringify({
      workspace_id: input.workspaceId,
      display_name: input.displayName,
      protocol: input.protocol,
      base_url: input.baseUrl,
      api_mode: input.apiMode,
      credential: input.credential,
      default_model_id: input.defaultModelId,
      organization: input.organization,
      project: input.project,
      headers: input.headers,
      request_params: input.requestParams,
    }),
  });
}

export function replaceCredential(
  workspaceId: string,
  providerId: string,
  credential: string,
): Promise<ProviderViewType> {
  return requestRuntime(
    `/api/runtime/v1/providers/${encodeURIComponent(providerId)}/credential`,
    (payload) => ProviderView.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, credential }),
    },
  );
}

export function revokeCredential(
  workspaceId: string,
  providerId: string,
): Promise<ProviderViewType> {
  return requestRuntime(
    `/api/runtime/v1/providers/${encodeURIComponent(providerId)}/revoke`,
    (payload) => ProviderView.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    },
  );
}

export function setProviderStatus(
  workspaceId: string,
  providerId: string,
  enabled: boolean,
): Promise<ProviderViewType> {
  return requestRuntime(
    `/api/runtime/v1/providers/${encodeURIComponent(providerId)}/status`,
    (payload) => ProviderView.parse(payload),
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, enabled }),
    },
  );
}

export function runConnectionTest(
  workspaceId: string,
  providerId: string,
): Promise<ProviderConnectionTestResult> {
  return requestRuntime(
    `/api/runtime/v1/providers/${encodeURIComponent(providerId)}/test`,
    (payload) => payload,
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    },
  ) as Promise<ProviderConnectionTestResult>;
}

export function fetchEffectiveProvider(
  workspaceId: string,
  conversationId: string,
): Promise<z.infer<typeof EffectiveProvider>> {
  const query = new URLSearchParams({ workspace_id: workspaceId, conversation_id: conversationId });
  return requestRuntime(`/api/runtime/v1/providers/effective?${query.toString()}`, (payload) =>
    EffectiveProvider.parse(payload),
  );
}

/**
 * Set (providerId non-null) or clear (providerId null) the AC11
 * per-conversation override. The response's effective resolution is the
 * header's next truth — the runtime's read-after-write answer, never a
 * client-side guess.
 */
export function setConversationOverride(args: {
  workspaceId: string;
  conversationId: string;
  providerId: string | null;
  model: string | null;
}): Promise<z.infer<typeof EffectiveProvider>> {
  return requestRuntime(
    "/api/runtime/v1/providers/overrides",
    (payload) => OverrideResponse.parse(payload).effective,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: args.workspaceId,
        conversation_id: args.conversationId,
        provider_id: args.providerId,
        model: args.model,
      }),
    },
  );
}
