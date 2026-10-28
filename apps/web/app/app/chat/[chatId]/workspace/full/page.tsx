import type { Metadata } from "next";

import { WorkspaceFullSurface } from "@/components/workspace/workspace-routes";
import { workspaceTabFromParam } from "@/lib/workspace-panel";

interface WorkspacePageProps {
  params: Promise<{ chatId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}

export const metadata: Metadata = {
  title: "Workspace",
};

/**
 * S7 workspace panel, full-page variant (UI_DESIGN §4 S7): the same tabs at
 * full-page width, deep-linkable at /app/chat/[chatId]/workspace/full — the
 * active tab rides the ?tab= query param (F3 review fix), validated against
 * the four S7 tabs server-side (anything else lands on Files). The "Back to
 * chat" affordance (in-app history back, dashboard fallback) lives in the
 * client surface — the per-conversation panel state is persisted either way,
 * so returning to the chat restores the prior width.
 */
export default async function WorkspaceFullPage({ params, searchParams }: WorkspacePageProps) {
  const { chatId } = await params;
  const { tab } = await searchParams;

  return <WorkspaceFullSurface chatId={chatId} initialTab={workspaceTabFromParam(tab)} />;
}
