import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { operationInstanceById, rosterSubtitle } from "@/lib/fixtures";
import { findOperationTemplate } from "@/lib/navigation";
import { routes } from "@/lib/routes";

interface OperationChatPageProps {
  params: Promise<{ operationId: string }>;
}

export async function generateMetadata({
  params,
}: OperationChatPageProps): Promise<Metadata> {
  const { operationId } = await params;
  const instance = operationInstanceById(operationId);
  const template = findOperationTemplate(operationId);
  return { title: instance ? instance.title : template ? template.name : "Operation chat" };
}

/**
 * S4 Operation chat (UI_DESIGN §3.1, §4 S4). The full surface — roster bar,
 * runs rail, @-addressing — lands with the Operation slice. Seeded §9
 * Operation instances (sidebar "active chats" links) show their identity and
 * an honest placeholder; unknown ids keep the chunk-1 shell empty state
 * (G4: nothing here pretends runs that are not in the fixture record).
 */
export default async function OperationChatPage({ params }: OperationChatPageProps) {
  const { operationId } = await params;
  const instance = operationInstanceById(operationId);
  const template = findOperationTemplate(operationId);
  const title = instance ? instance.title : template ? template.name : "Operation";
  const meta = instance ? rosterSubtitle(instance) : "Operation chat";

  return (
    <SurfaceFrame title={title} meta={meta}>
      <EmptyState
        explanation={
          instance
            ? "The Operation chat surface arrives with the Operation slice. This demo conversation has seeded runs — their states show in the sidebar."
            : "Operation runs and their live event streams land with the mock runtime. Nothing has run in this Operation yet."
        }
        action={
          template ? (
            <Link
              href={routes.operationPreview(operationId)}
              className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
            >
              Open the launch preview
            </Link>
          ) : (
            <Link
              href={routes.app()}
              className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
            >
              Back to conversations
            </Link>
          )
        }
      />
    </SurfaceFrame>
  );
}
