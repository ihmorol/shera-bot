import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AgentChatView } from "@/components/chat/agent-chat-view";
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
 * enumerable roster. The thread is seeded from the §9 fixtures and rendered
 * by AgentChatView (the composer demo appends to local fixture state only).
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

  return (
    <AgentChatView
      agent={agent}
      conversation={conversation}
      thread={buildThread(conversation.conversation_id)}
    />
  );
}
