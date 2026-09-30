"use client";

import { AgentChatView } from "@/components/chat/agent-chat-view";
import type { Agent } from "@shera-bot/contracts";

import type { ConversationSummary, ThreadItem } from "@/lib/fixtures";
import { useContainerResolution } from "@/lib/container-connection";
import type { ContainerResolutionState } from "@/lib/container-resolution";
import { useRealConversationThread } from "@/lib/runtime-data";

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
  const real = useRealConversationThread(workspaceId);

  // The real conversation starts read: unread badges are fixture-derived in
  // the demo and the real read tracking (cursor acknowledgement) is chunk 2/3
  // — so real mode carries unread_count 0 instead of the demo count (G4).
  const summary: ConversationSummary = { ...conversation, unread_count: 0 };

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
