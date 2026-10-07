import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import { routes } from "@/lib/routes";

export const metadata: Metadata = {
  title: "New Operation",
};

/**
 * S6 ad-hoc Operation creation. The roster editor arrives with the §9 pack
 * fixtures; this chunk proves the route and keeps the entry point honest.
 */
export default function NewOperationPage() {
  return (
    <SurfaceFrame title="New ad-hoc Operation" meta="Pack: student v1">
      <EmptyState
        explanation="Pick Agents from the student pack and launch. Ad-hoc Operation creation lands with the pack fixtures."
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
