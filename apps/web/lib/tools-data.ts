"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Actor } from "@shera-bot/contracts";

import type { ToolHistoryEntry, ToolInventoryEntry } from "@/lib/tools-api";
import {
  activateTool,
  createTool,
  disableTool,
  enableTool,
  fetchToolHistory,
  fetchToolInventory,
  previewToolCreation,
  type ToolCreationForm,
  type ToolCreationPreview,
} from "@/lib/tools-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { useSessionIdentity } from "@/lib/container-connection";

/**
 * S21 chunk 7 — the tools data hooks (lib/approvals-data.ts idiom): the tool
 * inventory, the redacted tool history, and the user's inventory mutations
 * (create / activate / disable / enable), through TanStack Query over the
 * same-origin runtime proxy. There is no tool-event WebSocket fanout in this
 * slice, so the reads POLL on the app's established 5s visible-tab cadence;
 * failures ARE states (no fixture fallback, no retry behind the user's back).
 *
 * G6: every mutation posts the USER actor from the authenticated session —
 * and the proxy re-binds it server-side anyway, so a client-asserted identity
 * cannot reach the runtime (the S20 security pattern).
 */

/** The app's visible-tab poll cadence (the approvals/presence cadence). */
function toolsRefetchInterval(): number | false {
  if (typeof document === "undefined") {
    return false;
  }
  return document.hidden ? false : 5_000;
}

export function safeToolsMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

/** The session-bound USER actor (the mutations' authorizing identity). */
export function useToolsActor(): { actor: Actor; ready: boolean } {
  const session = useSessionIdentity();
  return {
    actor: { type: "user", id: session.data?.google_sub ?? "" },
    ready: Boolean(session.data?.google_sub),
  };
}

/** The workspace's tool inventory, polled on the visible-tab cadence. */
export function useToolInventory(workspaceId: string): {
  tools: ToolInventoryEntry[];
  loading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: ["tool-inventory", workspaceId],
    queryFn: () => fetchToolInventory(workspaceId),
    refetchOnWindowFocus: false,
    refetchInterval: () => toolsRefetchInterval(),
    refetchIntervalInBackground: false,
  });
  return {
    tools: query.data ?? [],
    loading: query.isPending,
    error: query.isError
      ? safeToolsMessage(query.error, "The tool inventory could not be read.")
      : null,
  };
}

/** The redacted tool history (optionally filtered), on the same cadence. */
export function useToolHistory(
  workspaceId: string,
  filter: { task_id?: string; tool_id?: string } = {},
): {
  history: ToolHistoryEntry[];
  loading: boolean;
  error: string | null;
} {
  const key = JSON.stringify(filter);
  const query = useQuery({
    queryKey: ["tool-history", workspaceId, key],
    queryFn: () => fetchToolHistory(workspaceId, filter),
    refetchOnWindowFocus: false,
    refetchInterval: () => toolsRefetchInterval(),
    refetchIntervalInBackground: false,
  });
  return {
    history: query.data ?? [],
    loading: query.isPending,
    error: query.isError
      ? safeToolsMessage(query.error, "The tool history could not be read.")
      : null,
  };
}

/** The pure creation preview (a read — POSTed for its typed body, D30 posture). */
export function useToolCreationPreview() {
  return useMutation({
    mutationFn: (input: { workspaceId: string; ownerAgentId: string; form: ToolCreationForm }) =>
      previewToolCreation(input.workspaceId, input.ownerAgentId, input.form),
  });
}

/** The create command (the authorizing user actor; the runtime re-validates). */
export function useCreateTool(workspaceId: string) {
  const queryClient = useQueryClient();
  const { actor } = useToolsActor();
  return useMutation({
    mutationFn: (input: { ownerAgentId: string; form: ToolCreationForm }) =>
      createTool(workspaceId, input.ownerAgentId, actor, input.form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tool-inventory", workspaceId] });
    },
  });
}

/** The runtime-grant activation (user actor; the service refuses agents). */
export function useActivateTool(workspaceId: string) {
  const queryClient = useQueryClient();
  const { actor } = useToolsActor();
  return useMutation({
    mutationFn: (input: {
      toolId: string;
      version: string;
      target: { kind: "agent" | "operation" | "workspace"; id: string };
    }) => activateTool(workspaceId, input.toolId, input.version, input.target, actor),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tool-inventory", workspaceId] });
    },
  });
}

/** The disable switch — beats any grant (the executor refuses next consult). */
export function useDisableTool(workspaceId: string) {
  const queryClient = useQueryClient();
  const { actor } = useToolsActor();
  return useMutation({
    mutationFn: (input: { toolId: string }) => disableTool(workspaceId, input.toolId, actor),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tool-inventory", workspaceId] });
    },
  });
}

/** Re-enable. */
export function useEnableTool(workspaceId: string) {
  const queryClient = useQueryClient();
  const { actor } = useToolsActor();
  return useMutation({
    mutationFn: (input: { toolId: string }) => enableTool(workspaceId, input.toolId, actor),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tool-inventory", workspaceId] });
    },
  });
}

export type { ToolCreationPreview };
