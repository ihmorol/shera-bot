import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import { AgentSettingsSurface } from "@/components/settings/agent-settings";
import { GitSettingsSurface } from "@/components/settings/git-settings";
import { PermissionsSettingsSurface } from "@/components/settings/permissions-settings";
import { ToolsSettingsSurface } from "@/components/settings/tools-settings";
import { ProvidersSettingsSurface } from "@/components/settings/providers-settings";
import { SchedulesSettingsSurface } from "@/components/settings/schedules-settings";
import { CreditsSettingsSurface } from "@/components/settings/credits-settings";
import { MemorySettingsSurface } from "@/components/settings/memory-settings";
import { NotificationsSettingsSurface } from "@/components/settings/notifications-settings";
import { AccountSettingsSurface } from "@/components/settings/account-settings";
import { WorkspaceSettingsView } from "@/components/settings/workspace-settings";
import { FilesSettingsSurface } from "@/components/settings/files-settings";
import { PrivacySettingsView } from "@/components/settings/privacy-settings";
import { BackupsSettingsSurface } from "@/components/settings/backups-settings";
import { SettingsOverview } from "@/components/settings/settings-overview";
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

  // S24 (§S9, D20/D21/D48, AC8): the Model budgets / Credits surface — the
  // ledger's own numbers (remaining, reserved, used this month), the
  // per-run drill-down that sums exactly to the ledger, custom-provider
  // usage with its zero credit movement, and the exhausted-credit pause
  // card with its unblocking paths.
  if (section?.length === 1 && section[0] === "credits") {
    return (
      <SurfaceFrame title="Settings" meta="Model budgets / Credits">
        <div className="mx-auto max-w-xl">
          <CreditsSettingsSurface />
        </div>
      </SurfaceFrame>
    );
  }

  // S29 (§S9 Memory, PRD §11, D37, AC27): the memory surface — the shared
  // workspace memory and each Agent's private memory in the per-scope
  // breakdown, the publication queue (approve/dismiss), the "remembered
  // from …" provenance lines, version restore, and the auto-memory
  // switches. Secrets are never stored, and a refused write shows its
  // typed rejection honestly.
  if (section?.length === 1 && section[0] === "memory") {
    return (
      <SurfaceFrame title="Settings" meta="Memory">
        <MemorySettingsSurface />
      </SurfaceFrame>
    );
  }

  // S30 (§S9 Account, D16): the session identity, tier, the honest storage
  // statement, and the reopen-onboarding control (the typed onboarding.reopen
  // — D16: reopenable; onboarding and settings share the command surface).
  if (section?.length === 1 && section[0] === "account") {
    return (
      <SurfaceFrame title="Settings" meta="Account">
        <AccountSettingsSurface />
      </SurfaceFrame>
    );
  }

  // S30 (§S9 Workspace, D19/D40): the pinned pack shown once as a label, not
  // a control, and the tenancy posture — read-only BY RECORDED DECISION.
  if (section?.length === 1 && section[0] === "workspace") {
    return (
      <SurfaceFrame title="Settings" meta="Workspace">
        <div className="mx-auto max-w-xl">
          <WorkspaceSettingsView />
        </div>
      </SurfaceFrame>
    );
  }

  // S30 (§S9 "Files & projects", PRD §10): the workspace's connected
  // projects — the runtime's own rows — with the git surface deep link.
  if (section?.length === 1 && section[0] === "files") {
    return (
      <SurfaceFrame title="Settings" meta="Files & projects">
        <FilesSettingsSurface />
      </SurfaceFrame>
    );
  }

  // S30 (§S9 "Notifications", PRD §14, D16): the delivery toggles as REAL
  // command targets — in-app + browser (unfocused tab, explicit permission),
  // reset-to-default, and the honest denied-permission state.
  if (section?.length === 1 && section[0] === "notifications") {
    return (
      <SurfaceFrame title="Settings" meta="Notifications">
        <NotificationsSettingsSurface />
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

  // S28 (§S9 "Schedules & watchers", PRD §8/§13, E5): the autonomous
  // trigger records — schedules, file/Git watchers, webhooks, task
  // completions, conditions — with their truthful state, last firing, and
  // next occurrence from the runtime scheduler, the pause/edit controls,
  // and the run cards naming their trigger.
  if (section?.length === 1 && section[0] === "schedules") {
    return (
      <SurfaceFrame title="Settings" meta="Schedules & watchers">
        <SchedulesSettingsSurface />
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

  // S30 (§S9 "Privacy & retention", PRD §12, D2): the redaction and
  // data-location statements — read-only BY RECORDED DECISION (files are
  // never automatically deleted; nothing to configure).
  if (section?.length === 1 && section[0] === "privacy") {
    return (
      <SurfaceFrame title="Settings" meta="Privacy & retention">
        <div className="mx-auto max-w-xl">
          <PrivacySettingsView />
        </div>
      </SurfaceFrame>
    );
  }

  // S30 (§S9 "Runtime & resources", PRD §3.3, E1): the tier table + the
  // admission readout — the runtime owns admission (read-only by E1).
  if (section?.length === 1 && section[0] === "runtime") {
    return (
      <SurfaceFrame title="Settings" meta="Runtime & resources">
        <div className="mx-auto max-w-xl">
          <WorkersSettingsSurface />
        </div>
      </SurfaceFrame>
    );
  }

  // S30 (§S9 "Backups & recovery", PRD §12/§13): the snapshot posture and
  // the runtime's own recovery status — read-only by the admin-triggered
  // restore decision.
  if (section?.length === 1 && section[0] === "backups") {
    return (
      <SurfaceFrame title="Settings" meta="Backups & recovery">
        <BackupsSettingsSurface />
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

  // The D16 overview: ALL FIFTEEN categories (the register is the single
  // source), each linking its real section — no pending placeholders remain.
  return (
    <SurfaceFrame title="Settings" meta="Overview">
      <SettingsOverview />
      <p className="mt-8">
        <Link
          href={routes.app()}
          className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
        >
          Back to conversations
        </Link>
      </p>
    </SurfaceFrame>
  );
}
