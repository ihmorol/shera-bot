import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { AgentSettingsSurface } from "@/components/settings/agent-settings";
import { GitSettingsSurface } from "@/components/settings/git-settings";
import { PermissionsSettingsSurface } from "@/components/settings/permissions-settings";
import { ToolsSettingsSurface } from "@/components/settings/tools-settings";
import { ProvidersSettingsSurface } from "@/components/settings/providers-settings";
import { WorkersSettingsSurface } from "@/components/settings/worker-admission-readout";
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
 * S9 settings shell. Two sections are REAL: /app/settings/agents/<agent>
 * renders the D16 per-Agent settings surface (display label, current value,
 * recommended default, why it matters, risk note, reset-to-default,
 * read-only pack-owned entries — through the ONE D16 commands endpoint), and
 * /app/settings/workers renders the S16 Task workers admission readout
 * (UI_DESIGN S9 "Runtime & resources" queue state, E1). Other sections are
 * named here as pending labels, not links — each becomes a real route with
 * its own slice, so the shell never links to a section that cannot render
 * yet (G4).
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

  if (section?.length === 1 && section[0] === "workers") {
    return (
      <SurfaceFrame title="Settings" meta="Workers">
        <div className="mx-auto max-w-xl">
          <WorkersSettingsSurface />
        </div>
      </SurfaceFrame>
    );
  }

  // S21 (§S9, PRD §7, E4): the tool inventory — built-ins + agent-created
  // tools with owner/scope/risk/permissions/version, the preview-gated
  // creation flow, the runtime-grant activation, and the disable switch that
  // actually prevents execution (AC6).
  if (section?.length === 1 && section[0] === "tools") {
    return (
      <SurfaceFrame title="Settings" meta="Tools">
        <ToolsSettingsSurface />
      </SurfaceFrame>
    );
  }

  // S23 (§S9, PRD §9, AC10, D17/D22): the masked provider catalog — masked
  // credentials with revoke/replace only, the full custom-provider form, the
  // honest connection test, enable/disable.
  if (section?.length === 1 && section[0] === "providers") {
    return (
      <SurfaceFrame title="Settings" meta="Providers & models">
        <div className="mx-auto max-w-xl">
          <ProvidersSettingsSurface />
        </div>
      </SurfaceFrame>
    );
  }

  // S20 (§S9, D9/D35): the grants review — every active grant with scope,
  // tool + version, expiry, creator, and revoke, plus the reminder mutes.
  if (section?.length === 1 && section[0] === "permissions") {
    return (
      <SurfaceFrame title="Settings" meta="Permissions & approvals">
        <div className="mx-auto max-w-xl">
          <PermissionsSettingsSurface />
        </div>
      </SurfaceFrame>
    );
  }

  // S19 (§S9 "Git & repositories", PRD §10, E6): the merge review — the
  // minimal PRD §10 fields per merge request with the three decisions, the
  // worktree ledger with the visible queue, and the validation runs.
  if (section?.length === 1 && section[0] === "git") {
    return (
      <SurfaceFrame title="Settings" meta="Git & repositories">
        <GitSettingsSurface />
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
          <li className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
            <Link
              href={routes.settings("workers")}
              className="text-sm text-text underline underline-offset-4 hover:text-cool-highlight"
            >
              Workers
            </Link>
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">open</span>
          </li>
          <li className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
            <Link
              href={routes.settings("permissions")}
              className="text-sm text-text underline underline-offset-4 hover:text-cool-highlight"
            >
              Permissions &amp; approvals
            </Link>
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">open</span>
          </li>
          <li className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
            <Link
              href={routes.settings("git")}
              className="text-sm text-text underline underline-offset-4 hover:text-cool-highlight"
            >
              Git
            </Link>
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">open</span>
          </li>
          <li className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3">
            <Link
              href={routes.settings("providers")}
              className="text-sm text-text underline underline-offset-4 hover:text-cool-highlight"
            >
              Providers &amp; models
            </Link>
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">open</span>
          </li>
          {["Profile", "Memory", "Credits", "Workspace"].map((item) => (
            <li
              key={item}
              className="flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3"
            >
              <span className="text-sm text-text">{item}</span>
              <span className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
                pending
              </span>
            </li>
          ))}
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
