"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  EffectiveProvider,
  ProviderConnectionTestResult,
  ProviderView,
} from "@shera-bot/contracts";

import {
  configureProvider,
  fetchEffectiveProvider,
  fetchProviders,
  replaceCredential,
  revokeCredential,
  runConnectionTest,
  setConversationOverride,
  setProviderStatus,
  type ConfigureProviderInput,
} from "@/lib/provider-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { presenceRefetchInterval } from "@/lib/session-presence";

/**
 * Real provider data hooks (S23) — the masked catalog and the AC11 effective
 * readout through TanStack Query, reading REAL container-local rows via the
 * local API through the same-origin proxy. The idiom mirrors the agent hooks
 * (lib/agent-data.ts): failures ARE states — the queries never retry behind
 * the user's back and never fall back to fixtures or fabricated providers
 * (G4: an absent runtime is never rendered as a configured provider).
 */

const GENERIC_PROVIDER_ERROR_MESSAGE = "The providers could not be loaded.";

export function safeProviderMessage(
  error: unknown,
  fallback = GENERIC_PROVIDER_ERROR_MESSAGE,
): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// The masked catalog (GET /v1/providers)
// ---------------------------------------------------------------------------

export function useProviders(workspaceId: string): {
  state: "loading" | "ready" | "error";
  providers: ProviderView[];
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["providers", workspaceId],
    queryFn: () => fetchProviders(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (query.isPending) {
    return {
      state: "loading",
      providers: [],
      safeErrorMessage: undefined,
      refetch: () => undefined,
    };
  }
  if (query.isError) {
    return {
      state: "error",
      providers: [],
      safeErrorMessage: safeProviderMessage(query.error),
      refetch: () => void query.refetch(),
    };
  }
  return {
    state: "ready",
    providers: query.data,
    safeErrorMessage: undefined,
    refetch: () => void query.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Mutations — each settled answer is the runtime's read-after-write truth
// ---------------------------------------------------------------------------

export interface ProviderActionResult {
  /** The masked view the mutation returned (the catalog refetch also runs). */
  provider: ProviderView | null;
}

/**
 * The settings surface's mutations, keyed by provider id so a busy/error
 * state stays attached to the row that caused it (several rows can act at
 * once without one row's spinner bleeding into its neighbors).
 */
export function useProviderActions(workspaceId: string) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["providers", workspaceId] });
    // The effective readout depends on the catalog + credentials; a revoke or
    // a status flip must reach the chat header without waiting for its poll.
    void queryClient.invalidateQueries({ queryKey: ["effective-provider", workspaceId] });
  };

  const configure = useMutation({
    mutationFn: (input: ConfigureProviderInput) => configureProvider(input),
    onSuccess: invalidate,
  });
  const replace = useMutation({
    mutationFn: ({ providerId, credential }: { providerId: string; credential: string }) =>
      replaceCredential(workspaceId, providerId, credential),
    onSuccess: invalidate,
  });
  const revoke = useMutation({
    mutationFn: ({ providerId }: { providerId: string }) =>
      revokeCredential(workspaceId, providerId),
    onSuccess: invalidate,
  });
  const setStatus = useMutation({
    mutationFn: ({ providerId, enabled }: { providerId: string; enabled: boolean }) =>
      setProviderStatus(workspaceId, providerId, enabled),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: ({ providerId }: { providerId: string }) =>
      runConnectionTest(workspaceId, providerId),
  });

  return { configure, replace, revoke, setStatus, test, invalidate };
}

export type ConnectionTestState =
  | { providerId: string; state: "pending"; result: null }
  | { providerId: string; state: "failed"; result: ProviderConnectionTestResult }
  | { providerId: string; state: "ok"; result: ProviderConnectionTestResult };

// ---------------------------------------------------------------------------
// The AC11 effective readout (the chat header + composer's data source)
// ---------------------------------------------------------------------------

/**
 * The honest union the chat surfaces consume:
 * - `unknown` — the readout has not settled yet (still resolving, or the
 *   surface is not wired to a conversation id). The composer stays disabled:
 *   an unresolved provider is never a sendable one (G4).
 * - `unconfigured` — the runtime's named configuration state (D17), shown
 *   verbatim; sending is disabled.
 * - `configured` — the effective provider/model + where it came from (AC11).
 */
export type EffectiveProviderState =
  | { kind: "unknown" }
  | {
      kind: "unconfigured";
      code: Extract<EffectiveProvider, { configured: false }>["code"];
      safeMessage: string;
    }
  | {
      kind: "configured";
      providerId: string;
      displayName: string;
      model: string;
      source: "conversation_override" | "agent_default";
    };

export function effectiveProviderState(effective: EffectiveProvider): EffectiveProviderState {
  if (effective.configured) {
    return {
      kind: "configured",
      providerId: effective.provider_id,
      displayName: effective.display_name,
      model: effective.model,
      source: effective.source,
    };
  }
  return { kind: "unconfigured", code: effective.code, safeMessage: effective.safe_message };
}

/**
 * The conversation's effective provider (AC11): a 5s visible-tab poll (the
 * established posture — presence and admission read on the same cadence),
 * paused while the tab is hidden. Disabled until the conversation id exists;
 * an unmounted/unknown conversation stays "unknown" rather than guessing.
 */
export function useEffectiveProvider(
  workspaceId: string,
  conversationId: string | null,
  options: { enabled?: boolean } = {},
): {
  state: EffectiveProviderState;
  refetch: () => void;
  isReady: boolean;
} {
  const enabled = (options.enabled ?? true) && conversationId !== null && conversationId !== "";
  const query = useQuery({
    queryKey: ["effective-provider", workspaceId, conversationId],
    queryFn: () => fetchEffectiveProvider(workspaceId, conversationId ?? ""),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: presenceRefetchInterval(),
    staleTime: 0,
  });

  if (!enabled || query.isPending || query.isError) {
    return { state: { kind: "unknown" }, refetch: () => void query.refetch(), isReady: false };
  }
  return {
    state: effectiveProviderState(query.data),
    refetch: () => void query.refetch(),
    isReady: true,
  };
}

// ---------------------------------------------------------------------------
// The AC11 override mutation (the header model control's write)
// ---------------------------------------------------------------------------

export function useConversationOverride(workspaceId: string, conversationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { providerId: string | null; model: string | null }) => {
      if (conversationId === null) {
        return Promise.reject(
          new RuntimeApiError({
            code: "CONVERSATION_NOT_READY",
            category: "state",
            safe_message: "The conversation is still connecting — try again in a moment.",
            retryable: true,
            user_action: null,
            internal_details: null,
            correlation_id: "client",
          }),
        );
      }
      return setConversationOverride({
        workspaceId,
        conversationId,
        providerId: args.providerId,
        model: args.model,
      });
    },
    onSuccess: (effective) => {
      queryClient.setQueryData(
        ["effective-provider", workspaceId, conversationId],
        effective satisfies EffectiveProvider,
      );
      void queryClient.invalidateQueries({ queryKey: ["effective-provider", workspaceId] });
    },
  });
}
