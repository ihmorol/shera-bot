import type { Metadata } from "next";
import Link from "next/link";

import { SurfaceFrame } from "@/components/shell/surface-frame";
import { routes } from "@/lib/routes";

interface SettingsPageProps {
  params: Promise<{ section?: string[] }>;
}

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * S9 settings shell. Sections are named here as pending labels, not links —
 * each section (profile, providers, tools, git, memory, credits, workspace)
 * becomes a real route with its own slice, so the shell never links to a
 * section that cannot render yet (G4).
 */
export default async function SettingsPage({ params }: SettingsPageProps) {
  const { section } = await params;
  const sectionLabel = section?.length ? section.join(" / ") : "Overview";

  return (
    <SurfaceFrame title="Settings" meta={sectionLabel}>
      <div className="mx-auto max-w-xl">
        <p className="text-sm text-muted">
          Settings sections land one surface at a time. Nothing here renders secrets: provider keys
          stay masked with revoke/replace only, and memory rejects secrets outright.
        </p>
        <ul className="mt-6 space-y-2">
          {["Profile", "Providers", "Tools", "Git", "Memory", "Credits", "Workspace"].map(
            (item) => (
              <li
                key={item}
                className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3"
              >
                <span className="text-sm text-text">{item}</span>
                <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
                  pending
                </span>
              </li>
            ),
          )}
        </ul>
        <p className="mt-6">
          <Link
            href={routes.app()}
            className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
          >
            Back to conversations
          </Link>
        </p>
      </div>
    </SurfaceFrame>
  );
}
