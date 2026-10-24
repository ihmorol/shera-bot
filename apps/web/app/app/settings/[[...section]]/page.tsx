import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { AgentSettingsSurface } from "@/components/settings/agent-settings";
import { SurfaceFrame } from "@/components/shell/surface-frame";
import { findAgent } from "@/lib/navigation";
import { routes } from "@/lib/routes";

interface SettingsPageProps {
  params: Promise<{ section?: string[] }>;
}

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * S9 settings shell. The Agents section is REAL (S11): /app/settings/agents/
 * <agent> renders the D16 per-Agent settings surface (display label, current
 * value, recommended default, why it matters, risk note, reset-to-default,
 * read-only pack-owned entries — through the ONE D16 commands endpoint).
 * Other sections are named here as pending labels, not links — each becomes a
 * real route with its own slice, so the shell never links to a section that
 * cannot render yet (G4).
 */
export default async function SettingsPage({ params }: SettingsPageProps) {
  const { section } = await params;

  if (section?.length === 2 && section[0] === "agents") {
    const slug = section[1]!;
    // Unknown Agents 404 — the six pack Agents are the enumerable roster
    // (same discipline as the Agent chat route).
    if (!findAgent(slug)) {
      notFound();
    }
    return (
      <SurfaceFrame title="Settings" meta="Agents">
        <AgentSettingsSurface agentId={`agent_${slug.replace(/-/g, "_")}`} />
      </SurfaceFrame>
    );
  }

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
