"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuntimeApiError, fetchConversationEvents } from "@/lib/runtime-client";
import {
  agentSettingsCommand,
  fetchAgentDetail,
  fetchAgentRoster,
  fetchAgentSettings,
  submitAgentSettingsCommand,
  type AgentDetail,
  type AgentRosterSummary,
  type AgentSettingsAction,
} from "@/lib/agent-api";
import type { ThreadItem } from "@/lib/fixtures";
import { threadItemsFromEvents } from "@/lib/runtime-thread";
import {
  presenceRefetchInterval,
  type AgentSessionPresence,
} from "@/lib/session-presence";

/**
 * Real agent data hooks (S11 chunk 4) — the workspace's Agent identities
 * through TanStack Query, reading REAL container-local rows via the local API
 * through the same-origin proxy. The idiom mirrors the conversation hooks
 * (lib/runtime-data.ts): failures ARE states — the queries never retry behind
 * the user's back and never fall back to fixtures (the demo stays a labeled,
 * separate state; a real-data failure renders the §2.4 error state, G4).
 */

const GENERIC_RUNTIME_ERROR_MESSAGE = "The Agent data could not be loaded.";
export const AGENT_SNAPSHOT_REQUIRED_MESSAGE = "This Agent's data could not be read right now.";

export function safeRuntimeMessage(
  error: unknown,
  fallback = GENERIC_RUNTIME_ERROR_MESSAGE,
): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Sidebar roster (GET /v1/agents)
// ---------------------------------------------------------------------------

export function useAgentRoster(workspaceId: string): {
  state: "loading" | "ready" | "error";
  agents: AgentRosterSummary[];
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const rosterQuery = useQuery({
    queryKey: ["agent-roster", workspaceId],
    queryFn: () => fetchAgentRoster(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (rosterQuery.isPending) {
    return { state: "loading", agents: [], safeErrorMessage: undefined, refetch: () => undefined };
  }
  if (rosterQuery.isError) {
    return {
      state: "error",
      agents: [],
      safeErrorMessage: safeRuntimeMessage(
        rosterQuery.error,
        "The Agent roster could not be loaded.",
      ),
      refetch: () => void rosterQuery.refetch(),
    };
  }
  return {
    state: "ready",
    agents: rosterQuery.data,
    safeErrorMessage: undefined,
    refetch: () => void rosterQuery.refetch(),
  };
}

// ---------------------------------------------------------------------------
// Agent direct chat (GET /v1/agents/:id → get-or-create direct_chat_id)
// ---------------------------------------------------------------------------

export interface AgentDirectChat {
  surfaceState: "ready" | "loading" | "error";
  items: ThreadItem[];
  safeErrorMessage: string | undefined;
  /** The get-or-create direct chat id once known (null while loading/failed). */
  directChatId: string | null;
  /** The Agent's identity row once known (null while loading/failed). */
  agentDetail: AgentDetail | null;
}

/**
 * One Agent's persistent direct chat (D39): the detail read get-or-creates the
 * direct chat binding (journaled, the SAME conversation every time) and the
 * thread is the journal replayed through the cursor replay endpoint — exactly
 * the S07 discipline the General Assistant chat uses, parameterized by Agent.
 */
export function useAgentDirectChat(workspaceId: string, agentId: string): AgentDirectChat {
  const detailQuery = useQuery({
    queryKey: ["agent-detail", workspaceId, agentId],
    queryFn: () => fetchAgentDetail(workspaceId, agentId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const directChatId = detailQuery.data?.direct_chat_id ?? null;
  const eventsQuery = useQuery({
    queryKey: ["agent-direct-thread", workspaceId, directChatId],
    queryFn: () => fetchConversationEvents(directChatId as string, workspaceId),
    enabled: directChatId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  if (detailQuery.isPending) {
    return {
      surfaceState: "loading",
      items: [],
      safeErrorMessage: undefined,
      directChatId: null,
      agentDetail: null,
    };
  }
  if (detailQuery.isError) {
    return {
      surfaceState: "error",
      items: [],
      safeErrorMessage: safeRuntimeMessage(detailQuery.error),
      directChatId: null,
      agentDetail: null,
    };
  }
  if (eventsQuery.isPending) {
    return {
      surfaceState: "loading",
      items: [],
      safeErrorMessage: undefined,
      directChatId,
      agentDetail: detailQuery.data,
    };
  }
  if (eventsQuery.isError) {
    return {
      surfaceState: "error",
      items: [],
      safeErrorMessage: safeRuntimeMessage(eventsQuery.error),
      directChatId,
      agentDetail: detailQuery.data,
    };
  }

  const replay = eventsQuery.data;
  if (replay.kind === "snapshot_required") {
    // E10 honesty: never render fabricated history in place of a replay.
    return {
      surfaceState: "error",
      items: [],
      safeErrorMessage: AGENT_SNAPSHOT_REQUIRED_MESSAGE,
      directChatId,
      agentDetail: detailQuery.data,
    };
  }
  return {
    surfaceState: "ready",
    items: threadItemsFromEvents(replay.events),
    safeErrorMessage: undefined,
    directChatId,
    agentDetail: detailQuery.data,
  };
}

// ---------------------------------------------------------------------------
// S12 chunk 4: the Agent's session presence (polled agent detail read)
// ---------------------------------------------------------------------------

export interface AgentSessionPresenceState {
  /** The runtime-reported presence, or null while nothing is known yet. */
  presence: AgentSessionPresence | null;
  /**
   * True when the presence read failed — the header SILENCES the chip (a
   * presence indicator never becomes an error surface, G4); the chat's own
   * surfaces keep their §2.4 error states.
   */
  failed: boolean;
}

/**
 * One Agent's session presence (D32), polled through the agent detail read —
 * the runtime has NO session-event WebSocket fanout in this slice, so polling
 * IS the honest mechanism. The detail endpoint get-or-creates the direct chat
 * binding (journaled, idempotent), so the poll adds no new side effect to the
 * surface the user is already in. Failures are states, never retries behind
 * the user's back — and they only ever silence the chip.
 */
export function useAgentSessionPresence(
  workspaceId: string,
  agentId: string,
): AgentSessionPresenceState {
  const query = useQuery({
    queryKey: ["agent-session-presence", workspaceId, agentId],
    queryFn: () => fetchAgentDetail(workspaceId, agentId),
    select: (detail) => detail.session.presence,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
    // 5s cadence, paused entirely while the tab is hidden (the decision is
    // pinned in lib/session-presence.ts).
    refetchInterval: () => presenceRefetchInterval(),
    refetchIntervalInBackground: false,
  });

  if (query.isError) {
    return { presence: null, failed: true };
  }
  return { presence: query.data ?? null, failed: false };
}

// ---------------------------------------------------------------------------
// D16 settings surface (GET snapshot + POST commands)
// ---------------------------------------------------------------------------

export type AgentSettingsSurfaceState = "ready" | "loading" | "error";

/**
 * The D16 read model for one Agent, plus the command surface: every mutation
 * is a contracts-valid settings command POSTed to the ONE commands endpoint
 * (D16/D26); the snapshot is refetched after each accepted command — the
 * runtime's read-after-write result is journal-free last-write-wins state, so
 * a refetch (the same idiom as the start-stopped-workspace flow) is the
 * truthful update, never an optimistic guess.
 */
export function useAgentSettings(workspaceId: string, agentId: string) {
  const queryClient = useQueryClient();

  const detailQuery = useQuery({
    queryKey: ["agent-detail", workspaceId, agentId],
    queryFn: () => fetchAgentDetail(workspaceId, agentId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const settingsQuery = useQuery({
    queryKey: ["agent-settings", workspaceId, agentId],
    queryFn: () => fetchAgentSettings(workspaceId, agentId),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const commandMutation = useMutation({
    mutationFn: (action: AgentSettingsAction) =>
      submitAgentSettingsCommand(
        workspaceId,
        agentId,
        agentSettingsCommand(workspaceId, agentId, action),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-settings", workspaceId, agentId] });
      void queryClient.invalidateQueries({ queryKey: ["agent-detail", workspaceId, agentId] });
    },
  });

  return {
    detailQuery,
    settingsQuery,
    commandMutation,
  };
}
