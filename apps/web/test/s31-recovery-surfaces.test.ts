/**
 * S31 chunk 4 — the honest recovery surfaces (UI_DESIGN S11, PRD §13, AC19;
 * issue #32's copy gate).
 *
 * The copy is asserted against the ACTUAL resume basis — the runtime's
 * recovery.decided record — never against a claim the runtime cannot make:
 *
 *  - the resume marker says "resumed from last safe step" and names the
 *    checkpoint version + step id the basis actually is;
 *  - the pause marker names what could not be proven safe (the pending
 *    action), and asks for the review — it never promises an outcome;
 *  - the banner copy is the exact S11 text ("Restoring your workspace…",
 *    "A task needs your review");
 *  - NO surface ever renders an exact-resume claim: the copy builders refuse
 *    to emit "resumed exactly"/"continuing where it left off"-shaped text,
 *    and the resume marker always carries the checkpoint anchor.
 *
 * The components render through renderToStaticMarkup (the web suite's SSR
 * pattern — no DOM), with the S11 §2.3 rule pinned: color never the only
 * signal (each banner state pairs an icon with its text and a role).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import {
  RECOVERY_BANNER_COPY,
  RESUMED_BANNER_COPY,
  pauseMarkerCopy,
  resumeMarkerCopy,
  resumeMarkerCopyUnanchored,
} from "../lib/recovery-copy";
import { RecoveryBanner } from "../components/shell/recovery-banner";
import { RunRecoveryTimeline } from "../components/operations/run-recovery-timeline";
import type { RunRecoveryTimelineData } from "../lib/recovery-copy";

const here = join(import.meta.dirname, "..");

describe("S31 recovery copy — the basis-anchored builders", () => {
  it("the resume marker names the checkpoint version the basis actually is — the step id stays data", () => {
    const copy = resumeMarkerCopy({
      basis: "replayable",
      checkpointVersion: 2,
      stepId: "step_fetch_1",
    });
    expect(copy.toLowerCase()).toContain("resumed from last safe step");
    expect(copy).toContain("checkpoint v2");
    // The step id is mechanism data — it renders ONLY in the marker's
    // data-step-id attribute, never in product copy (the G1 bar).
    expect(copy).not.toContain("step_fetch_1");
  });

  it("the resume marker maps the E13 class token to product language — the raw token never renders", () => {
    const replayable = resumeMarkerCopy({
      basis: "replayable",
      checkpointVersion: 1,
      stepId: "step_parse_1",
    });
    expect(replayable).toContain("safe to re-run");
    expect(replayable).not.toContain("replayable");
    const idempotent = resumeMarkerCopy({
      basis: "idempotent_retry",
      checkpointVersion: 3,
      stepId: "step_post_1",
    });
    expect(idempotent).toContain("safe to retry without repeating its effect");
    expect(idempotent).not.toContain("idempotent_retry");
  });

  it("the unanchored variant keeps the product-language class disclosure and claims no version", () => {
    const copy = resumeMarkerCopyUnanchored("idempotent_retry");
    expect(copy.toLowerCase()).toContain("resumed from last safe step");
    expect(copy).toContain("safe to retry without repeating its effect");
    expect(copy).not.toContain("checkpoint v");
    expect(copy).not.toContain("idempotent_retry");
  });

  it("the pause marker names what could not be proven safe and asks for review — no outcome promise", () => {
    const copy = pauseMarkerCopy({ pendingSummary: "send the external request" });
    expect(copy).toContain("could not be proven safe");
    expect(copy).toContain("send the external request");
    expect(copy).toMatch(/review/i);
    expect(copy).not.toMatch(/will (complete|finish|resume|succeed)/i);
  });

  it("no builder emits an exact-resume claim", () => {
    const strings = [
      resumeMarkerCopy({ basis: "replayable", checkpointVersion: 9, stepId: "step_x" }),
      resumeMarkerCopy({ basis: "idempotent_retry", checkpointVersion: 9, stepId: "step_y" }),
      pauseMarkerCopy({ pendingSummary: "anything" }),
      ...Object.values(RECOVERY_BANNER_COPY),
      RESUMED_BANNER_COPY,
    ];
    for (const text of strings) {
      expect(text.toLowerCase()).not.toContain("exactly where");
      expect(text.toLowerCase()).not.toContain("right where it left off");
      expect(text.toLowerCase()).not.toContain("continued exactly");
    }
  });

  it("the banner copy is the S11 text verbatim", () => {
    expect(RECOVERY_BANNER_COPY.recovering).toBe("Restoring your workspace…");
    expect(RECOVERY_BANNER_COPY.review).toBe("A task needs your review");
    expect(RESUMED_BANNER_COPY).toContain("resumed");
    expect(RESUMED_BANNER_COPY).toContain("last safe step");
  });
});

describe("S31 recovery banner — the S11 states", () => {
  it("renders RECOVERING politely with the icon+text pairing (color never the only signal)", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryBanner, { state: "recovering", reviewCount: 0 }),
    );
    expect(html).toContain("Restoring your workspace…");
    expect(html).toContain('role="status"');
    expect(html).toContain('data-recovery-banner="recovering"');
    expect(html).toMatch(/<svg/); // the icon rides with the text (§2.3)
  });

  it("renders RESUMED as the transient confirmation naming the last-safe-step basis", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryBanner, { state: "resumed", resumedCount: 2 }),
    );
    expect(html).toContain(RESUMED_BANNER_COPY);
    expect(html).toContain("2");
  });

  it("renders RECOVERY_REQUIRED with the deep link and the review count", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryBanner, {
        state: "review_needed",
        reviewCount: 1,
        reviewHref: "/app/operation/operation_chat_research_paper",
      }),
    );
    expect(html).toContain("A task needs your review");
    expect(html).toContain('href="/app/operation/operation_chat_research_paper"');
    expect(html).toContain("Review the task");
  });

  it("renders nothing when the workspace is idle", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryBanner, { state: "idle", reviewCount: 0 }),
    );
    expect(html).toBe("");
  });
});

describe("S31 run recovery timeline — checkpoint → restart → resume markers", () => {
  const resumed: RunRecoveryTimelineData = {
    runId: "task_run_dev_recover",
    markers: [
      {
        kind: "checkpoint",
        at: "2026-09-19T14:02:00Z",
        checkpointVersion: 1,
        stepId: "step_parse_1",
      },
      { kind: "restart", at: "2026-09-19T14:20:00Z" },
      {
        kind: "resume",
        at: "2026-09-19T14:20:05Z",
        basis: "replayable",
        checkpointVersion: 1,
        stepId: "step_parse_1",
      },
    ],
  };

  const paused: RunRecoveryTimelineData = {
    runId: "task_run_tutor_backup",
    markers: [
      {
        kind: "checkpoint",
        at: "2026-09-19T13:58:00Z",
        checkpointVersion: 2,
        stepId: "step_request_1",
      },
      { kind: "restart", at: "2026-09-19T14:20:00Z" },
      {
        kind: "pause",
        at: "2026-09-19T14:20:05Z",
        pendingSummary: "send the external request",
      },
    ],
  };

  it("renders the three markers in order with the honest resume copy and the ids as data", () => {
    const html = renderToStaticMarkup(createElement(RunRecoveryTimeline, { timeline: resumed }));
    expect(html).toContain("Checkpoint taken");
    expect(html).toContain("Runtime restarted");
    expect(html.toLowerCase()).toContain("resumed from last safe step");
    expect(html).toContain("checkpoint v1");
    // The mechanism ids ride the data attributes, never product copy.
    expect(html).toContain('data-step-id="step_parse_1"');
    expect(html).toContain('data-recovery-basis="replayable"');
    // The step id appears ONLY as attribute data — not rendered as copy
    // (the copy text carries the version anchor, the attribute carries the id).
    const copyText = html.replace(/data-[a-z-]+="[^"]*"/g, "");
    expect(copyText).not.toContain("step_parse_1");
    expect(copyText).not.toContain("replayable");
    // The DOM order carries the story: checkpoint → restart → resume.
    const checkpointAt = html.indexOf("Checkpoint taken");
    const restartAt = html.indexOf("Runtime restarted");
    const resumeAt = html.toLowerCase().indexOf("resumed from last safe step");
    expect(checkpointAt).toBeGreaterThan(-1);
    expect(restartAt).toBeGreaterThan(checkpointAt);
    expect(resumeAt).toBeGreaterThan(restartAt);
  });

  it("renders the pause marker with what could not be proven safe", () => {
    const html = renderToStaticMarkup(createElement(RunRecoveryTimeline, { timeline: paused }));
    expect(html).toContain("could not be proven safe");
    expect(html).toContain("send the external request");
    expect(html).not.toContain("worker.started");
  });

  it("renders nothing for a timeline without markers", () => {
    const html = renderToStaticMarkup(
      createElement(RunRecoveryTimeline, { timeline: { runId: "task_x", markers: [] } }),
    );
    expect(html).toBe("");
  });
});

describe("S31 — the timeline module carries no exact-resume claim anywhere", () => {
  it("the source of the recovery surfaces never contains the banned claims", () => {
    for (const relative of [
      "lib/recovery-copy.ts",
      "components/shell/recovery-banner.tsx",
      "components/operations/run-recovery-timeline.tsx",
    ]) {
      const source = readFileSync(join(here, relative), "utf8").toLowerCase();
      expect(source).not.toContain("exactly where it left off");
      expect(source).not.toContain("continued exactly");
      expect(source).not.toContain("resumed exactly");
    }
  });
});
