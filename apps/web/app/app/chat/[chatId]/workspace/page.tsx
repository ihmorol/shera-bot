import type { Metadata } from "next";
import Link from "next/link";

import { WorkspaceInlineSurface } from "@/components/workspace/workspace-routes";
import { routes } from "@/lib/routes";

interface WorkspacePageProps {
  params: Promise<{ chatId: string }>;
}

export const metadata: Metadata = {
  title: "Workspace",
};

/**
 * S7 workspace panel, inline variant (UI_DESIGN §3.1): the per-conversation
 * workspace panel rendered standalone at its full height — the deep-linkable
 * inline surface keyed by the conversation id. The docked composition (panel
 * beside the chat with the header toggle) lives in the chat surfaces; this
 * route renders the SAME panel body and links to the full-page variant.
 */
export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { chatId } = await params;

  return (
    <div className="mx-auto flex h-dvh max-w-5xl flex-col px-4 py-4 lg:px-6">
      <div className="flex items-center justify-between gap-3 pb-3">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          Conversation {chatId}
        </p>
        <Link
          href={routes.workspaceFull(chatId)}
          className="shrink-0 text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
        >
          Open full page
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface">
        <WorkspaceInlineSurface chatId={chatId} />
      </div>
    </div>
  );
}
