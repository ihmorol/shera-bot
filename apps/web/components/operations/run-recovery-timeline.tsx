import { BookmarkCheck, Power, CircleCheck, ShieldAlert } from "lucide-react";

import {
  CHECKPOINT_MARKER_COPY,
  RESTART_MARKER_COPY,
  pauseMarkerCopy,
  resumeMarkerCopy,
  type RunRecoveryMarkerData,
  type RunRecoveryTimelineData,
} from "@/lib/recovery-copy";
import { cn } from "@/lib/utils";

/**
 * Run recovery timeline (S31 chunk 4; UI_DESIGN S11 — "in task timelines,
 * checkpoint → restart → resume markers") — the ordered recovery story of
 * one run, rendered inside the run card from the runtime's recovery record
 * (the recovery.decided + checkpoint.taken journal markers; the mock world
 * mirrors the same shapes).
 *
 * The copy is the basis-anchored builders' output ONLY: the resume marker
 * says "resumed from last safe step" and names the checkpoint version + step
 * the basis actually is; the pause marker names what could not be proven
 * safe. No marker ever claims exact resume — the module-level test holds
 * that line against the source itself.
 *
 * §2.3: each marker pairs an icon with its text (color never the only
 * signal); the rail is 1px — the line, not a colored border, is the
 * structure.
 */

function markerPresentation(marker: RunRecoveryMarkerData): {
  icon: React.ReactNode;
  text: string;
  className: string;
} {
  switch (marker.kind) {
    case "checkpoint":
      return {
        icon: <BookmarkCheck className="size-3.5 shrink-0 text-sky" aria-hidden="true" />,
        text: `${CHECKPOINT_MARKER_COPY} — ${marker.stepId} (v${marker.checkpointVersion})`,
        className: "text-muted",
      };
    case "restart":
      return {
        icon: <Power className="size-3.5 shrink-0 text-muted" aria-hidden="true" />,
        text: RESTART_MARKER_COPY,
        className: "text-muted",
      };
    case "resume":
      return {
        icon: <CircleCheck className="size-3.5 shrink-0 text-live" aria-hidden="true" />,
        // An unanchored version renders the class disclosure only — the
        // claim shrinks to what the runtime actually recorded.
        text:
          marker.checkpointVersion !== null && marker.stepId !== null
            ? resumeMarkerCopy({
                basis: marker.basis,
                checkpointVersion: marker.checkpointVersion,
                stepId: marker.stepId,
              })
            : `Resumed from last safe step; auto-resumed by the ${marker.basis} recovery class.`,
        className: "text-live",
      };
    case "pause":
      return {
        icon: <ShieldAlert className="size-3.5 shrink-0 text-approval" aria-hidden="true" />,
        text: pauseMarkerCopy({ pendingSummary: marker.pendingSummary }),
        className: "text-approval",
      };
  }
}

export function RunRecoveryTimeline({ timeline }: { timeline: RunRecoveryTimelineData }) {
  if (timeline.markers.length === 0) return null;
  return (
    <div
      data-testid="run-recovery-timeline"
      data-run-id={timeline.runId}
      aria-label={`Recovery timeline for ${timeline.runId}`}
      className="mt-1.5 rounded-md border border-line bg-surface px-2.5 py-2"
    >
      <ol className="flex flex-col gap-1.5">
        {timeline.markers.map((marker, index) => {
          const presentation = markerPresentation(marker);
          return (
            <li
              key={`${marker.kind}-${index}`}
              data-marker-kind={marker.kind}
              className={cn("flex items-start gap-1.5 text-[11px]", presentation.className)}
            >
              <span className="mt-0.5">{presentation.icon}</span>
              <span className="min-w-0">
                {presentation.text}
                <span className="sr-only"> — {marker.at}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
