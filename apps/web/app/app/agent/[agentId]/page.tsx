import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AgentDirectChatSurface } from "@/components/chat/agent-direct-chat-surface";
import { GeneralAssistantChatSurface } from "@/components/chat/general-assistant-surface";
import { agentById, buildThread, conversationForAgent } from "@/lib/fixtures";
import { findAgent } from "@/lib/navigation";

interface AgentChatPageProps {
  params: Promise<{ agentId: string }>;
}

function agentIdForSlug(slug: string): string {
  return `agent_${slug.replace(/-/g, "_")}`;
}

export async function generateMetadata({ params }: AgentChatPageProps): Promise<Metadata> {
  const { agentId } = await params;
  const agent = agentById(agentIdForSlug(agentId));
  return { title: agent ? agent.display_name : "Agent chat" };
}

/**
 * S3 Agent direct chat (UI_DESIGN §3.1, §4 S3). One persistent identity per
 * Agent (D39): this route is the single direct conversation for the Agent
 * across the whole app. Unknown slugs 404 — the six pack Agents are the
 * enumerable roster.
 *
 * S09 chunk 1: the General Assistant chat switches to REAL rows when the
 * container is connected (idempotent seed command + journal replay through
 * the S07 local API); every other Agent — and the GA chat itself whenever the
 * container is not ready — keeps the S08 fixture demo, honestly labeled.
 */
export default async function AgentChatPage({ params }: AgentChatPageProps) {
  const { agentId: slug } = await params;
  const knownSlug = findAgent(slug);
  const agent = knownSlug ? agentById(agentIdForSlug(slug)) : undefined;
  if (!agent) {
    notFound();
  }
  const conversation = conversationForAgent(agent.agent_id);
  if (!conversation) {
    notFound();
  }
  const thread = buildThread(conversation.conversation_id);

  if (agent.agent_id === "agent_general_assistant") {
    return (
      <GeneralAssistantChatSurface agent={agent} conversation={conversation} thread={thread} />
    );
  }

  // S11: the rest of the roster opens the REAL direct chat through the
  // get-or-create binding (direct_chat_id from the detail read) when the
  // container is ready; the fixture demo otherwise.
  return <AgentDirectChatSurface agent={agent} conversation={conversation} thread={thread} />;
}
