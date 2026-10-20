"use client";

import { AgentChatView } from "@/components/chat/agent-chat-view";
import type { Agent } from "@shera-bot/contracts";

import type { ConversationSummary, ThreadItem } from "@/lib/fixtures";
import { useContainerResolution, useSessionIdentity } from "@/lib/container-connection";
import type { ContainerResolutionState } from "@/lib/container-resolution";
import { useRealConversationThread } from "@/lib/runtime-data";
import { useLiveConversation } from "@/lib/runtime-live";

/**
 * The General Assistant direct chat's data source (S09 chunk 1).
 *
 * When the container resolution reports READY, the chat runs on REAL rows:
 * the conversation is ensured through the idempotent S07 command (the fixed
 * seed key replays the same receipt, so the same conversation every time) and
 * the thread is the journal replayed through the typed local API. In every
 * other resolution state — resolving, not provisioned, preparing, failed,
 * stopped, unauthenticated — the S08 fixture demo stays, honestly labeled as
 * demo data; a real-data failure NEVER falls back to fixtures (§2.4 error
 * state instead, G4).
 *
 * Other Agents keep the fixture demo in this slice: the container seeds one
 * real conversation (the General Assistant direct chat, the S09 thin-slice
 * path), and per-Agent provisioning of conversations is later-slice work.
 */

/** Pure mode choice, so the honesty rule is directly testable. */
export function gaSurfaceMode(state: ContainerResolutionState | undefined): "demo" | "runtime" {
  return state?.kind === "ready" ? "runtime" : "demo";
}

export function GeneralAssistantChatSurface({
  agent,
  conversation,
  thread,
}: {
  agent: Agent;
  conversation: ConversationSummary;
  thread: ThreadItem[];
}) {
  const resolution = useContainerResolution();
  const mode = gaSurfaceMode(resolution.data);

  if (mode === "demo") {
    return <AgentChatView agent={agent} conversation={conversation} thread={thread} />;
  }

  if (resolution.data?.kind !== "ready") {
    // Unreachable (mode already checked) — kept as a type guard, honest.
    return <AgentChatView agent={agent} conversation={conversation} thread={thread} />;
  }

  return (
    <RuntimeGeneralAssistantChat
      workspaceId={resolution.data.workspace_id}
      agent={agent}
      conversation={conversation}
    />
  );
}

function RuntimeGeneralAssistantChat({
  workspaceId,
  agent,
  conversation,
}: {
  workspaceId: string;
  agent: Agent;
  conversation: ConversationSummary;
}) {
  const session = useSessionIdentity();
  const real = useRealConversationThread(workspaceId);

  // S09 chunk 2: the REAL conversation surface. When the conversation id is
  // known and a WS gateway URL is configured, the thread runs on the live
  // conversation: journal events over the socket, the idempotent send, and
  // the §6.4 banner driven by the REAL connection lifecycle (never the demo
  // script). Without a WS URL the chunk-1 HTTP snapshot stays, read-only.
  const wsUrl = process.env.NEXT_PUBLIC_RUNTIME_WS_URL ?? null;
  const liveEnabled =
    session.data !== undefined &&
    wsUrl !== null &&
    real.conversationId !== null &&
    real.surfaceState === "ready";
  const live = useLiveConversation({
    wsUrl,
    workspaceId,
    conversationId: real.conversationId ?? "",
    displayName: session.data?.display_name ?? "User",
    agentId: agent.agent_id,
    enabled: liveEnabled,
  });

  // The real conversation starts read: unread badges are fixture-derived in
  // the demo and the real read tracking (cursor acknowledgement) is chunk 3
  // — so real mode carries unread_count 0 instead of the demo count (G4).
  const summary: ConversationSummary = { ...conversation, unread_count: 0 };

  if (liveEnabled) {
    return (
      <AgentChatView
        agent={agent}
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
      agent={agent}
      conversation={summary}
      thread={real.items}
      surfaceState={real.surfaceState}
      safeErrorMessage={real.safeErrorMessage}
      mode="runtime"
    />
  );
}
