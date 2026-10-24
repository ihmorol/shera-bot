"use client";

import { AgentChatView } from "@/components/chat/agent-chat-view";
import type { Agent } from "@shera-bot/contracts";

import type { ConversationSummary, ThreadItem } from "@/lib/fixtures";
import { useContainerResolution, useSessionIdentity } from "@/lib/container-connection";
import type { ContainerResolutionState } from "@/lib/container-resolution";
import { useAgentDirectChat } from "@/lib/agent-data";
import { useLiveConversation, useSameOriginRuntimeSocketUrl } from "@/lib/runtime-live";

/**
 * An Agent direct chat's data source (S11 chunk 4) — the General Assistant
 * keeps its own S09 surface (general-assistant-surface.tsx) with its seeded
 * chat; this one serves the rest of the roster through the S11 direct-chat
 * binding: GET /v1/agents/:id get-or-creates (journaled, the SAME
 * conversation every time, D39) and the thread is the journal replayed
 * through the S07 cursor replay. The live socket pipeline is the S09 one,
 * reused against `direct_chat_id` — no chat internals are rebuilt here.
 *
 * When the container is not ready — resolving, not provisioned, preparing,
 * failed, stopped, unauthenticated — the S08 fixture demo stays, honestly
 * labeled as demo data; a real-data failure NEVER falls back to fixtures
 * (§2.4 error state instead, G4).
 */

/** Pure mode choice, so the honesty rule is directly testable. */
export function agentChatSurfaceMode(
  state: ContainerResolutionState | undefined,
): "demo" | "runtime" {
  return state?.kind === "ready" ? "runtime" : "demo";
}

export function AgentDirectChatSurface({
  agent,
  conversation,
  thread,
}: {
  agent: Agent;
  conversation: ConversationSummary;
  thread: ThreadItem[];
}) {
  const resolution = useContainerResolution();
  const mode = agentChatSurfaceMode(resolution.data);

  if (mode === "demo") {
    return <AgentChatView agent={agent} conversation={conversation} thread={thread} />;
  }

  if (resolution.data?.kind !== "ready") {
    // Unreachable (mode already checked) — kept as a type guard, honest.
    return <AgentChatView agent={agent} conversation={conversation} thread={thread} />;
  }

  return (
    <RuntimeAgentDirectChat
      workspaceId={resolution.data.workspace_id}
      agent={agent}
      conversation={conversation}
    />
  );
}

function RuntimeAgentDirectChat({
  workspaceId,
  agent,
  conversation,
}: {
  workspaceId: string;
  agent: Agent;
  conversation: ConversationSummary;
}) {
  const session = useSessionIdentity();
  const real = useAgentDirectChat(workspaceId, agent.agent_id);

  // S09 chunk 2's live pipeline, reused against the direct chat id (§6.3).
  const wsUrl = useSameOriginRuntimeSocketUrl();
  const liveEnabled =
    session.data !== undefined &&
    wsUrl !== null &&
    real.directChatId !== null &&
    real.surfaceState === "ready";
  const live = useLiveConversation({
    wsUrl,
    workspaceId,
    conversationId: real.directChatId ?? "",
    displayName: session.data?.display_name ?? "User",
    agentId: agent.agent_id,
    enabled: liveEnabled,
  });

  // Identity rides the REAL agent row (pack-seeded, D39: one identity in the
  // sidebar, the header, and the bubbles). Until it loads the fixture Agent
  // fills in — same agent_id, so nothing is attributed to a wrong identity.
  const identity = real.agentDetail
    ? {
        agent_id: agent.agent_id,
        display_name: real.agentDetail.display_name,
        role_description: real.agentDetail.role_description,
        ui_identity: {
          avatar_hue: real.agentDetail.avatar_hue,
          initial_glyph: real.agentDetail.initial_glyph,
        },
      }
    : agent;

  // The real conversation starts read: unread badges are fixture-derived in
  // the demo and real read tracking (cursor acknowledgement) is later work —
  // so real mode carries unread_count 0 instead of the demo count (G4).
  const summary: ConversationSummary = { ...conversation, unread_count: 0 };

  if (liveEnabled) {
    return (
      <AgentChatView
        agent={identity}
        conversation={summary}
        thread={[]}
        timelineOverride={live.timeline}
        connectionState={live.connectionState}
        replay={live.replay}
        liveStream={
          live.stream
            ? {
                agentId: live.stream.agentId,
                text: live.stream.text,
                announcementText: live.stream.announcementText,
              }
            : null
        }
        onRuntimeSend={live.sendMessage}
        onRuntimeRetry={live.retry}
        surfaceState={live.error ? "error" : live.loading ? "loading" : "ready"}
        safeErrorMessage={live.error ?? real.safeErrorMessage}
        mode="runtime"
      />
    );
  }

  return (
    <AgentChatView
      agent={identity}
      conversation={summary}
      thread={real.items}
      surfaceState={real.surfaceState}
      safeErrorMessage={real.safeErrorMessage}
      mode="runtime"
    />
  );
}
