"use client";

import { Layers, Lock } from "lucide-react";

/**
 * The S9 "Workspace" settings surface (S30; D19/D40, UI_DESIGN §S9): the
 * pinned pack shown ONCE as a label, not a control (D40), and the tenancy
 * posture stated in the decision's own words. Read-only BY RECORDED
 * DECISION — no switcher exists to build, and no fake control is invented
 * (G4/G5).
 */
export function WorkspaceSettingsView() {
  return (
    <div className="space-y-4">
      <section aria-label="Pinned pack" className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <Layers className="size-4 text-sky" aria-hidden="true" />
          <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Pinned pack</h3>
        </div>
        <p className="mt-2 text-sm font-medium text-text">student pack v1</p>
        <p className="mt-1 text-xs text-muted">
          Every Agent and Operation in this workspace comes from this versioned pack. Tasks keep the
          pack version that created them; upgrades are explicit and compatibility-checked (D19,
          D40).
        </p>
      </section>

      <section
        aria-label="Workspace policy"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <div className="flex items-center gap-3">
          <Lock className="size-4 text-muted" aria-hidden="true" />
          <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
            Tenancy posture
          </h3>
        </div>
        <p className="mt-2 text-sm text-text">
          One workspace per account, one pinned pack per workspace — read-only by decision: there is
          no workspace or pack switcher to build (D40, D19).
        </p>
        <p className="mt-1 text-xs text-muted">
          Agents from different packs never silently collaborate; cross-pack work needs an explicit
          bridge policy (D19).
        </p>
      </section>
    </div>
  );
}
