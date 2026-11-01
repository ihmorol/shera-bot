/**
 * S28 schedules surface suite (UI_DESIGN §S9 "Schedules & watchers"; AC9,
 * AC10, D48): the truthful readout — state, pause reason, last firing, and
 * next occurrence render EXACTLY what the runtime scheduler's record says
 * (the view model here is the runtime's own wire shape; the UI computes no
 * schedule math of its own) — the AC10 pause/resume/edit controls, the D48
 * insufficient-credits pause copy, and the run cards naming their trigger.
 *
 * The no-local-schedule-math guard lives here too: the web app never
 * imports a cron library or derives an occurrence — the only truthful
 * source is the runtime scheduler (the same fixture-truthfulness discipline
 * as the S22 attempt-count grep).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SchedulesSettingsView } from "../components/settings/schedules-settings";
import type { TriggerView } from "../lib/schedules-api";

const here = dirname(fileURLToPath(import.meta.url));

/** The runtime's own wire shape, verbatim (what GET /v1/schedules returns). */
function trigger(overrides: Partial<TriggerView> = {}): TriggerView {
  return {
    trigger_id: "trg_s28_a",
    name: "weekly literature sweep",
    kind: "schedule",
    target_operation_id: "op_s28",
    config: { cron: "0 9 * * 1", plan: { prompt: "Compile the weekly sweep." } },
    catch_up_policy: "skip",
    state: "active",
    pause_reason: null,
    last_fired_at: "2026-11-02T09:00:04.000Z",
    last_occurrence_at: "2026-11-02T09:00:00.000Z",
    next_occurrence_at: "2026-11-09T09:00:00.000Z",
    created_at: "2026-10-31T12:00:00.000Z",
    updated_at: "2026-11-02T09:00:04.000Z",
    recent_firings: [
      {
        idempotency_key: "schedule:trg_s28_a:2026-11-02T09:00:00.000Z",
        run_id: "run_s28_1",
        outcome: "fired",
        detail: { due_at: "2026-11-02T09:00:00.000Z" },
        fired_at: "2026-11-02T09:00:04.000Z",
      },
    ],
    ...overrides,
  };
}

function renderView(
  triggers: TriggerView[],
  props: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(SchedulesSettingsView, {
      operations: [{ operation_id: "op_s28", name: "Research Paper" }],
      triggers,
      surfaceState: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      createPending: false,
      createSafeError: undefined,
      busyTriggerId: null,
      onCreate: () => undefined,
      onPause: () => undefined,
      onResume: () => undefined,
      onEdit: () => undefined,
      ...props,
    }),
  );
}

describe("S28 — the truthful readout (AC9)", () => {
  it("renders the scheduler's own state, last firing, and next occurrence verbatim-shaped", () => {
    const html = renderView([trigger()]);
    expect(html).toContain("weekly literature sweep");
    expect(html).toContain("cron 0 9 * * 1 (UTC)");
    expect(html).toContain("Last firing:");
    expect(html).toContain("Next occurrence:");
    // The truthful VALUES from the runtime record (formatted for display in
    // UTC — the date parts come from the record, never local math).
    expect(html).toContain("2 Nov 2026, 09:00");
    expect(html).toContain("9 Nov 2026, 09:00");
    expect(html).toContain("Active");
  });

  it("a trigger that has never fired says so instead of guessing", () => {
    const html = renderView([trigger({ last_fired_at: null, recent_firings: [] })]);
    expect(html).toContain("never fired yet");
    expect(html).not.toContain("9 Nov 2026, 09:00".replace("9 Nov", "2 Nov"));
  });

  it("run cards name the trigger that created them (AC10)", () => {
    const html = renderView([trigger()]);
    expect(html).toContain('data-testid="schedule-run-card"');
    expect(html).toContain("from schedule:");
    expect(html).toContain("weekly literature sweep");
    expect(html).toContain("run_s28_1");
  });

  it("the insufficient-credits pause is visible with its unblocking path (AC8/D48)", () => {
    const html = renderView([
      trigger({
        state: "paused",
        pause_reason: "insufficient_credits",
        recent_firings: [
          {
            idempotency_key: "schedule:trg_s28_a:2026-11-09T09:00:00.000Z",
            run_id: null,
            outcome: "paused_credits",
            detail: null,
            fired_at: "2026-11-09T09:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(html).toContain("Paused — credits");
    expect(html).toContain("could not reserve credits");
    expect(html).toContain("resumes automatically after a top-up");
    // The firing ledger's outcome vocabulary renders honestly.
    expect(html).toContain("Paused — insufficient credits");
  });

  it("a paused trigger offers Resume; an active one offers Pause (AC10)", () => {
    const active = renderView([trigger()]);
    expect(active).toContain("Pause");
    expect(active).not.toContain("Resume</span>");
    const paused = renderView([trigger({ state: "paused", pause_reason: null })]);
    expect(paused).toContain("Resume");
  });
});

describe("S28 — the no-local-schedule-math guard (AC9's truth source)", () => {
  const webRoot = resolve(here, "..");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules" || entry === ".next" || entry === ".impeccable") continue;
        walk(path);
        continue;
      }
      if (!/\.(tsx?|ts)$/.test(entry) || entry.endsWith(".test.ts")) continue;
      const text = readFileSync(path, "utf8");
      if (/cron-parser|\bcron-parser\b|from ["']cron-parser["']/.test(text)) {
        offenders.push(relative(webRoot, path));
      }
    }
  };
  walk(join(webRoot, "components"));
  walk(join(webRoot, "lib"));

  it("no web component or lib imports a cron library — the scheduler owns occurrence math", () => {
    expect(offenders, `cron math outside the runtime: ${offenders.join(", ")}`).toEqual([]);
  });
});
