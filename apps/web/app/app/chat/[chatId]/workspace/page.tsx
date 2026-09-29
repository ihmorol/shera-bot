import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { routes } from "@/lib/routes";

interface WorkspacePageProps {
  params: Promise<{ chatId: string }>;
}

export const metadata: Metadata = {
  title: "Workspace",
};

/**
 * S7 workspace panel, inline variant. In the desktop shell this surface mounts
 * in the reserved workspace panel; as a direct route it renders standalone
 * until the panel hosting lands with the workspace chunk.
 */
export default async function WorkspacePage({ params }: WorkspacePageProps) {
  const { chatId } = await params;

  return (
    <SurfaceFrame
      title="Workspace"
      meta={`Conversation ${chatId}`}
      actions={
        <Link
          href={routes.workspaceFull(chatId)}
          className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
        >
          Open full page
        </Link>
      }
    >
      <EmptyState
        explanation="Files, editor, live views, task runs, and tool history mount here with the mock runtime."
        action={
          <Link
            href={routes.workspaceFull(chatId)}
            className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
          >
            Open the full-page workspace
          </Link>
        }
      />
    </SurfaceFrame>
  );
}
