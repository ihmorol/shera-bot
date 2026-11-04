/**
 * Recovery copy (S31 chunk 4; UI_DESIGN S11, PRD §13, D32/D33) — the SINGLE
 * source for every recovery string the surfaces render. The copy is asserted
 * by test against the ACTUAL resume basis: a resume marker always names the
 * checkpoint version the basis is (the step id and the raw E13 class token
 * ride data attributes, never product copy — the G1 bar), and NEVER claims
 * exact resume (the runtime cannot prove the harness replayed every
 * intermediate token — it can prove the last safe semantic boundary, so that
 * is all the copy says).
 *
 * The builders are pure: they take the runtime's recorded data (the
 * recovery.decided payload fields) and return the strings — no surface
 * composes recovery copy by hand, so an exact-resume claim cannot leak in
 * through one render path while the tests check another.
 */

/** The S11 banner copy — verbatim from the design spec. */
export const RECOVERY_BANNER_COPY = {
  /** The boot recovery pass in flight. */
  recovering: "Restoring your workspace…",
  /** A run needs the user's review — the deep link is the surface's job. */
  review: "A task needs your review",
} as const;

/** The transient RESUMED confirmation (S11: transient; names the basis class). */
export const RESUMED_BANNER_COPY =
  "Workspace restored — your tasks resumed from their last safe steps.";

/** The E13 basis vocabulary, rendered as data (never paraphrased). */
export type RecoveryBasis = "replayable" | "idempotent_retry";

/**
 * The E13 class token → product language (the G1 bar: the mechanism token
 * never renders in copy — the raw token rides the marker's
 * `data-recovery-basis` attribute for the tests and the tooling).
 */
export const RECOVERY_BASIS_COPY: Record<RecoveryBasis, string> = {
  replayable: "the step was verified safe to re-run",
  idempotent_retry: "the step was verified safe to retry without repeating its effect",
};

export interface ResumeBasis {
  basis: RecoveryBasis;
  checkpointVersion: number;
  /**
   * The step id the basis is — rendered ONLY as data (the `data-step-id`
   * attribute), never in product copy.
   */
  stepId: string;
}

/**
 * The resume marker's copy: the honest claim IS the anchor — the checkpoint
 * version names the last safe step IN WORDS, the class is product language,
 * and the step id stays data. Rendered in the run timeline (and reused
 * anywhere a resume is reported).
 */
export function resumeMarkerCopy(basis: ResumeBasis): string {
  return `Resumed from last safe step — checkpoint v${basis.checkpointVersion}; ${RECOVERY_BASIS_COPY[basis.basis]}.`;
}

/** The unanchored variant (the runtime recorded no version to name). */
export function resumeMarkerCopyUnanchored(basis: RecoveryBasis): string {
  return `Resumed from last safe step; ${RECOVERY_BASIS_COPY[basis]}.`;
}

/** What the pause marker names: the pending action that could not be proven safe. */
export interface PauseBasis {
  /**
   * The checkpoint's pending action summary (the unprovable step); null when
   * the runtime has no checkpoint to name — the pause still asks for review.
   */
  pendingSummary: string | null;
}

/**
 * The pause marker's copy: names what could not be proven safe, asks for the
 * review, and promises no outcome (the review decides — D32). An unnamed
 * step stays honest about the gap instead of inventing one.
 */
export function pauseMarkerCopy(basis: PauseBasis): string {
  return basis.pendingSummary === null
    ? "Recovery paused for your review — the next step could not be proven safe to replay. Your review decides what happens next."
    : `Recovery paused for your review — resuming "${basis.pendingSummary}" could not be proven safe. Your review decides what happens next.`;
}

/** The restart marker's copy (the boot the run was interrupted by). */
export const RESTART_MARKER_COPY = "Runtime restarted";
/** The checkpoint marker's prefix (the step id + version follow as data). */
export const CHECKPOINT_MARKER_COPY = "Checkpoint taken";

/**
 * The run-timeline marker read model — the shape the runtime's
 * /v1/recovery/status answers per run and the mock fixtures mirror. The
 * markers are the ordered story (oldest first): checkpoint(s) → restart →
 * resume or pause.
 */
export type RunRecoveryMarkerData =
  | { kind: "checkpoint"; at: string; checkpointVersion: number; stepId: string }
  | { kind: "restart"; at: string }
  | {
      kind: "resume";
      at: string;
      basis: RecoveryBasis;
      /** Null when the runtime could not anchor the version (still honest). */
      checkpointVersion: number | null;
      stepId: string | null;
    }
  | ({ kind: "pause"; at: string } & PauseBasis);

export interface RunRecoveryTimelineData {
  runId: string;
  markers: readonly RunRecoveryMarkerData[];
}
