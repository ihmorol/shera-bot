import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { findOperationTemplate } from "@/lib/navigation";
import { routes } from "@/lib/routes";

interface OperationChatPageProps {
  params: Promise<{ operationId: string }>;
}

export async function generateMetadata({
  params,
}: OperationChatPageProps): Promise<Metadata> {
  const { operationId } = await params;
  const template = findOperationTemplate(operationId);
  return { title: template ? template.name : "Operation chat" };
}

/**
 * S4 Operation chat. Operation chat instances (pack-defined runs, ad-hoc
 * rosters) are enumerated by the §9 fixtures; until that chunk lands any id
 * renders the shell with an honest empty state rather than a fake run (G4).
 */
export default async function OperationChatPage({ params }: OperationChatPageProps) {
  const { operationId } = await params;
  const template = findOperationTemplate(operationId);
  const title = template ? template.name : "Operation";

  return (
    <SurfaceFrame title={title} meta="Operation chat">
      <EmptyState
        explanation="Operation runs and their live event streams land with the mock runtime. Nothing has run in this Operation yet."
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
