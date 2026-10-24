import type { Metadata } from "next";

import { OperationChatSurface } from "@/components/operations/operation-chat-surface";
import { operationInstanceById } from "@/lib/fixtures";
import { findOperationTemplate } from "@/lib/navigation";

interface OperationChatPageProps {
  params: Promise<{ operationId: string }>;
}

export async function generateMetadata({ params }: OperationChatPageProps): Promise<Metadata> {
  const { operationId } = await params;
  const instance = operationInstanceById(operationId);
  const template = findOperationTemplate(operationId);
  return { title: instance ? instance.title : template ? template.name : "Operation chat" };
}

/**
 * S4 Operation chat (UI_DESIGN §3.1, §4 S4, D31/D41). S13 chunk 4 wires the
 * REAL surface: the fixture §9 Operation ids keep their labeled demo surface,
 * every other id opens the live Operation (roster bar, merged thread with
 * @-addressing, runs rail) against the container's local API through the
 * same-origin proxy. The container gate owns the lifecycle states.
 */
export default async function OperationChatPage({ params }: OperationChatPageProps) {
  const { operationId } = await params;
  return <OperationChatSurface operationId={operationId} />;
}
