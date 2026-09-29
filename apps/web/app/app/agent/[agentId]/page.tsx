import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { findAgent } from "@/lib/navigation";
import { routes } from "@/lib/routes";

interface AgentChatPageProps {
  params: Promise<{ agentId: string }>;
}

export async function generateMetadata({ params }: AgentChatPageProps): Promise<Metadata> {
  const { agentId } = await params;
  const agent = findAgent(agentId);
  return { title: agent ? agent.name : "Agent chat" };
}

/**
 * S3 Agent direct chat. One persistent identity per Agent (D39): this route
 * is the single direct conversation for the Agent across the whole app.
 * Unknown slugs 404 — the six pack Agents are the enumerable roster.
 */
export default async function AgentChatPage({ params }: AgentChatPageProps) {
  const { agentId } = await params;
  const agent = findAgent(agentId);
  if (!agent) {
    notFound();
  }

  return (
    <SurfaceFrame title={agent.name} meta="Agent · direct chat">
      <EmptyState
        explanation={`No messages yet. Sending messages to ${agent.name} lands with the first runtime pass — this build wires the shell and navigation.`}
        action={
          <Link
            href={routes.app()}
            className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
          >
            Back to conversations
          </Link>
        }
      />
    </SurfaceFrame>
  );
}
