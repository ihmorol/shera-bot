import type { Metadata } from "next";
import Link from "next/link";

import { SurfaceFrame } from "@/components/shell/surface-frame";
import { Button } from "@/components/ui/button";
import { findOperationTemplate } from "@/lib/navigation";
import { routes } from "@/lib/routes";

interface LaunchPreviewPageProps {
  params: Promise<{ operationId: string }>;
}

export async function generateMetadata({
  params,
}: LaunchPreviewPageProps): Promise<Metadata> {
  const { operationId } = await params;
  const template = findOperationTemplate(operationId);
  return { title: template ? `Launch: ${template.name}` : "Launch preview" };
}

const PREVIEW_SECTIONS = [
  "Purpose",
  "Agents",
  "Skills",
  "Connectors",
  "Provider and model",
  "Estimated credits",
  "Approval requirements",
  "Expected outputs",
] as const;

/**
 * S5 launch preview — the preview gate (D30, AC23): nothing executes before
 * the user confirms this preview. The §2.4-state contract for the launch
 * action is "disabled until the preview has real content": the confirm button
 * stays disabled rather than pretending a launchable payload exists (G4).
 */
export default async function LaunchPreviewPage({ params }: LaunchPreviewPageProps) {
  const { operationId } = await params;
  const template = findOperationTemplate(operationId);
  const title = template ? `Launch ${template.name}` : "Launch preview";

  return (
    <SurfaceFrame
      title={title}
      meta="Launch preview · nothing runs until you confirm"
      actions={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={routes.app()}>Cancel</Link>
          </Button>
          <Button size="sm" disabled>
            Confirm launch
          </Button>
        </div>
      }
    >
      <div className="mx-auto max-w-xl">
        <p className="text-sm text-muted">
          This preview shows what the Operation will run with, before anything
          executes. The sections below fill in from the pack definition when the pack
          fixtures land.
        </p>
        <ul className="mt-6 space-y-2">
          {PREVIEW_SECTIONS.map((section) => (
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
