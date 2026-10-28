import type { Metadata } from "next";

import { WorkspaceFullSurface } from "@/components/workspace/workspace-routes";

interface WorkspacePageProps {
  params: Promise<{ chatId: string }>;
}

export const metadata: Metadata = {
  title: "Workspace",
};

/**
 * S7 workspace panel, full-page variant (UI_DESIGN §4 S7): the same tabs at
 * full-page width, deep-linkable at /app/chat/[chatId]/workspace/full. The
 * "Back to chat" affordance (in-app history back, dashboard fallback) lives
 * in the client surface — the per-conversation panel state is persisted
 * either way, so returning to the chat restores the prior width.
 */
export default async function WorkspaceFullPage({ params }: WorkspacePageProps) {
  const { chatId } = await params;

  return <WorkspaceFullSurface chatId={chatId} />;
}
