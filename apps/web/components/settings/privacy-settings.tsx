"use client";

import { EyeOff, HardDrive, ShieldCheck } from "lucide-react";

/**
 * The S9 "Privacy & retention" settings surface (S30; PRD §12, D2,
 * UI_DESIGN §S9): the redaction explanation and the local-first data
 * location statement — the recorded postures in their own words. Read-only
 * BY RECORDED DECISION (PRD §12: user files are never automatically
 * deleted — there is nothing to configure), stated plainly (G4/G5).
 */
export function PrivacySettingsView() {
  return (
    <div className="space-y-4">
      <section aria-label="Redaction" className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <EyeOff className="size-4 text-sky" aria-hidden="true" />
          <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
            Redaction
          </h3>
        </div>
        <p className="mt-2 text-sm text-text">
          Secret-shaped material is redacted before it is stored or shown: credentials never enter
          prompts, events, logs, memory, artifacts, or transcripts. Provider keys are write-only —
          the UI sees a masked &quot;configured&quot; flag, never the value (D22).
        </p>
        <p className="mt-1 text-xs text-muted">
          Memory rejects secret-shaped content outright at the write boundary (AC27&apos;s sibling
          posture).
        </p>
      </section>

      <section aria-label="Data location" className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <HardDrive className="size-4 text-sky" aria-hidden="true" />
          <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
            Where your data lives
          </h3>
        </div>
        <p className="mt-2 text-sm text-text">
          Conversations, files, projects, memories, browser state, tasks, and artifacts live inside
          your workspace container (D2, local-first). The central service stores only account
          identity and minimal operational metadata.
        </p>
      </section>

      <section aria-label="Retention" className="rounded-xl border border-line bg-surface p-4">
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-4 text-sky" aria-hidden="true" />
          <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Retention</h3>
        </div>
        <p className="mt-2 text-sm text-text">
          Your files are never automatically deleted (PRD §12) — deletion is always an explicit
          action you take, and this surface has no retention switch by that recorded decision.
        </p>
        <p className="mt-1 text-xs text-muted">
          At 80% storage a warning appears; at 100% actions that create or expand data pause while
          chat, reading, deletion, export, and cleanup remain available.
        </p>
      </section>
    </div>
  );
}
