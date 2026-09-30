import type { Metadata } from "next";
import Link from "next/link";

import { SurfaceFrame } from "@/components/shell/surface-frame";
import { routes } from "@/lib/routes";

interface WorkspacePageProps {
  params: Promise<{ chatId: string }>;
}

export const metadata: Metadata = {
  title: "Workspace",
};

const WORKSPACE_SECTIONS = [
  "Files",
  "Editor",
  "Terminal (read-only live view)",
  "Browser (read-only live view)",
  "Task runs",
  "Tool history",
  "Private Agent files",
] as const;

/**
 * S7 workspace panel, full-page variant. The inline variant renders in the
 * reserved workspace panel; both share the section set (D6). Panel contents
 * mount with the mock runtime — this page proves the route and the section
 * map without faking live views (G4).
 */
export default async function WorkspaceFullPage({ params }: WorkspacePageProps) {
  const { chatId } = await params;

  return (
    <SurfaceFrame
      title="Workspace"
      meta={`Conversation ${chatId} · full page`}
      actions={
        <Link
          href={routes.app()}
          className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
        >
          Back to conversations
        </Link>
      }
    >
      <div className="mx-auto max-w-xl">
        <p className="text-sm text-muted">
          Files, the editor, read-only live views, task runs, and tool history for this conversation
          mount here. Write access is lease-controlled — conflicts are prevented, never merged by
          hand.
        </p>
        <ul className="mt-6 space-y-2">
          {WORKSPACE_SECTIONS.map((section) => (
            <li
              key={section}
              className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3"
            >
              <span className="text-sm text-text">{section}</span>
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
                pending
              </span>
            </li>
          ))}
        </ul>
      </div>
    </SurfaceFrame>
  );
}
