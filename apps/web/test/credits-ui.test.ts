/**
 * S24 credits surface suite (UI_DESIGN §3.3 credits pill + §S9 "Model
 * budgets / Credits"; D20, D21, D48, AC8): the numbers render EXACTLY what
 * the runtime ledger's record says (the view model here is the runtime's
 * own wire shape; the UI computes no balance math of its own) — the pill's
 * remaining/reserved pair, the used-this-month headline, the per-run
 * drill-down whose rows sum to the run's charged number, the custom-
 * provider zero-credit copy, and the exhausted-credit pause card with its
 * unblocking paths.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreditsSettingsView } from "../components/settings/credits-settings";
import { CreditsPillView } from "../components/shell/credits-pill";
import { CreditsSummarySchema } from "../lib/credits-api";
import type { CreditsSummary, RunCostDrillDown } from "../lib/credits-api";

/** The runtime's own wire shape, verbatim (what GET /v1/credits returns). */
function summary(overrides: Partial<CreditsSummary> = {}): CreditsSummary {
  return {
    workspace_id: "ws-local-default",
    account: {
      granted_units: 200,
      charged_units: 50,
      reserved_units: 25,
      remaining_units: 150,
      used_this_month_units: 50,
      exhausted: false,
    },
    custom_provider_usage: {
      calls: 2,
      input_tokens: 1200,
      output_tokens: 300,
      providers: ["prov_custom_local"],
    },
    recent_runs: [
      {
        task_id: "run_credit_1",
        charged_units: 30,
        released_units: 20,
        active_reserved_units: 0,
        last_movement_at: "2026-11-02T09:01:00.000Z",
      },
      {
        task_id: "run_credit_2",
        charged_units: 20,
        released_units: 0,
        active_reserved_units: 25,
        last_movement_at: "2026-11-02T09:02:00.000Z",
      },
    ],
    ...overrides,
  };
}

function drillDown(overrides: Partial<RunCostDrillDown> = {}): RunCostDrillDown {
  return {
    task_id: "run_credit_1",
    charged_units: 30,
    released_units: 20,
    active_reserved_units: 0,
    movements: [
      {
        workspace_id: "ws-local-default",
        transaction_id: "ctx_1",
        entry_type: "reservation_hold",
        amount_units: 50,
        task_id: "run_credit_1",
        reservation_id: "res_1",
        related_id: null,
        corrects_transaction_id: null,
        created_at: "2026-11-02T09:00:00.000Z",
      },
      {
        workspace_id: "ws-local-default",
        transaction_id: "ctx_2",
        entry_type: "settlement_charge",
        amount_units: 30,
        task_id: "run_credit_1",
        reservation_id: "res_1",
        related_id: null,
        corrects_transaction_id: null,
        created_at: "2026-11-02T09:01:00.000Z",
      },
      {
        workspace_id: "ws-local-default",
        transaction_id: "ctx_3",
        entry_type: "reservation_release",
        amount_units: 20,
        task_id: "run_credit_1",
        reservation_id: "res_1",
        related_id: null,
        corrects_transaction_id: null,
        created_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    settlements: [
      {
        workspace_id: "ws-local-default",
        settlement_id: "cst_1",
        reservation_id: "res_1",
        task_id: "run_credit_1",
        actual_units: 30,
        settled_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    releases: [
      {
        workspace_id: "ws-local-default",
        release_id: "rel_1",
        reservation_id: "res_1",
        task_id: "run_credit_1",
        released_units: 20,
        reason: "unused_estimate",
        released_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    usage: [
      {
        workspace_id: "ws-local-default",
        usage_id: "usage_1",
        task_id: "run_credit_1",
        provider_id: "prov_platform",
        model: "platform-model",
        provider_origin: "platform",
        input_tokens: 5000,
        output_tokens: 2000,
        latency_ms: 410,
        charged_units: 30,
        created_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    ...overrides,
  };
}

function renderCredits(props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(CreditsSettingsView, {
      summary: summary(),
      surfaceState: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      selectedRunId: "run_credit_1",
      onSelectRun: () => undefined,
      drillDown: drillDown(),
      drillDownState: "ready",
      ...props,
    }),
  );
}

/**
 * The drill-down's rendered movement rows, parsed out of the static markup —
 * the AC8 numeric pin reads the RENDERED rows (label + amount), never the
 * fixture, so a dropped or altered row breaks the reconciliation.
 */
function renderedMovementRows(html: string): Array<{ label: string; amount: number }> {
  const rows: Array<{ label: string; amount: number }> = [];
  const rowPattern = /<li[^>]*><span[^>]*>([^<]+)<\/span><span[^>]*>([\d,]+)<\/span><\/li>/g;
  for (const match of html.matchAll(rowPattern)) {
    rows.push({
      label: match[1] ?? "",
      amount: Number((match[2] ?? "0").replace(/,/g, "")),
    });
  }
  return rows;
}

describe("S24 — the truthful credits readout (AC8, D21)", () => {
  it("renders the ledger's own numbers — remaining, reserved, used this month", () => {
    const html = renderCredits();
    expect(html).toContain('data-testid="credits-remaining"');
    expect(html).toContain('data-testid="credits-reserved"');
    expect(html).toContain('data-testid="credits-used-this-month"');
    // The VALUES from the ledger record (en-GB grouping), never recomputed.
    expect(html).toContain("150");
    expect(html).toContain("25");
    expect(html).toContain("50");
    expect(html).toContain("Remaining (not reserved)");
    expect(html).toContain("Reserved for running tasks");
    expect(html).toContain("Used this month");
    // Product-language copy: the accounting honesty without the internal
    // decision-ID references (those live in the code comments, not the UI).
    expect(html).toContain("The account-level balance.");
    expect(html).toContain("prototype accounting, not billing.");
    expect(html).not.toContain("(D20)");
    expect(html).not.toContain("(D21)");
  });

  it("the per-run drill-down renders the run's OWN movement rows, summing to the charged number", () => {
    const html = renderCredits();
    // The picker rows are the ledger's runs summary (run ids verbatim).
    expect(html).toContain("run_credit_1");
    expect(html).toContain("run_credit_2");
    // The detail's movement rows (the ledger's append-only rows, labelled).
    expect(html).toContain("Reserved for a model call");
    expect(html).toContain("Charged after the call");
    expect(html).toContain("Released (unused)");
    // The drill-down's own reconciliation copy (AC8).
    expect(html).toContain("sum exactly to its charged number");
    // The usage row (tokens + latency) is the D20 measurement record.
    expect(html).toContain("5,000 in / 2,000 out");
    expect(html).toContain("410 ms");
    // The release reason in the product's own words.
    expect(html).toContain("the estimate exceeded the actual usage");
  });

  it("the RENDERED movement rows reconcile to the charged number — the ledger's own identity (AC8 numeric pin)", () => {
    const html = renderCredits();
    const rows = renderedMovementRows(html);
    const sumWhere = (label: string) =>
      rows.filter((row) => row.label === label).reduce((sum, row) => sum + row.amount, 0);
    // Every movement row renders, verbatim, with the ledger's own amounts —
    // none dropped, none altered.
    expect(rows.map((row) => row.label)).toEqual([
      "Reserved for a model call",
      "Charged after the call",
      "Released (unused)",
    ]);
    // The ledger's identity (credit-ledger.service runCost): net charged is
    // the settlement charges minus the charge-reversing corrections.
    const netCharged = sumWhere("Charged after the call") - sumWhere("Correction (refunded)");
    expect(netCharged).toBe(30);
    // The detail header states the SAME number — the rows and the headline
    // can never disagree.
    expect(html).toMatch(/30<\/span> charged ·/);
    // The reserve→settle→release complement renders too (the honest legs):
    expect(sumWhere("Reserved for a model call")).toBe(50);
    expect(sumWhere("Released (unused)")).toBe(20);
  });

  it("an honest negative used-this-month parses the ledger's answer and renders it verbatim (review F4)", () => {
    // A this-month correction against a prior-month charge can push the
    // month's NET below zero — the client schema must accept the ledger's
    // honest answer (the surface computes nothing and refuses nothing
    // honest; the shape matches remaining_units).
    const negative = summary({
      account: { ...summary().account!, used_this_month_units: -15 },
    });
    expect(CreditsSummarySchema.parse(negative)).toMatchObject({
      account: { used_this_month_units: -15 },
    });
    // And the surface renders the negative as the number it is — never
    // clamped to a fabricated zero.
    const html = renderCredits({ summary: negative });
    expect(html).toContain('data-testid="credits-used-this-month"');
    expect(html).toContain(">-15</p>");
  });

  it("a corrected charge renders the correction row and the NET charged number the ledger recorded (AC9 meets AC8)", () => {
    const adjusted = drillDown({
      charged_units: 20,
      movements: [
        ...drillDown().movements,
        {
          workspace_id: "ws-local-default",
          transaction_id: "ctx_4",
          entry_type: "adjustment",
          amount_units: 10,
          task_id: "run_credit_1",
          reservation_id: "res_1",
          related_id: null,
          corrects_transaction_id: "ctx_2",
          created_at: "2026-11-02T10:00:00.000Z",
        },
      ],
    });
    const html = renderCredits({ drillDown: adjusted });
    const rows = renderedMovementRows(html);
    const sumWhere = (label: string) =>
      rows.filter((row) => row.label === label).reduce((sum, row) => sum + row.amount, 0);
    // The correction renders as its own appended row (append-only, AC9) and
    // names its effect in the product's words: a run-scoped correction is
    // always a charge refund (grants are account-level and never appear
    // here).
    expect(html).toContain("Correction (refunded)");
    expect(sumWhere("Correction (refunded)")).toBe(10);
    // charges − corrections == the charged number the ledger itself recorded.
    expect(sumWhere("Charged after the call") - sumWhere("Correction (refunded)")).toBe(
      adjusted.charged_units,
    );
    expect(html).toMatch(/20<\/span> charged ·/);
  });

  it("the run rows' charged numbers sum to the account's charged total — the drill-downs reconcile the ledger (AC8)", () => {
    const html = renderCredits();
    // The picker rows' charged numbers (the detail header's "charged ·"
    // suffix differs, so this matches run rows only).
    const runCharged = [...html.matchAll(/([\d,]+)<\/span> charged<\/span>/g)].map((match) =>
      Number((match[1] ?? "0").replace(/,/g, "")),
    );
    expect(runCharged).toEqual([30, 20]);
    expect(runCharged.reduce((sum, amount) => sum + amount, 0)).toBe(50);
    // The account's own charged total on the same surface.
    expect(html).toMatch(/charged 50 ·/);
  });

  it("custom-provider usage reads as measured-locally with ZERO Shera credits (D20)", () => {
    const html = renderCredits();
    expect(html).toContain("2</span> calls this month");
    expect(html).toContain("0 Shera credits");
    expect(html).toContain("prov_custom_local");
    expect(html).toContain("never consume Shera credits");
  });

  it("an exhausted account leads with the pause card naming its unblocking paths (D48)", () => {
    const html = renderCredits({
      summary: summary({
        account: {
          granted_units: 10,
          charged_units: 10,
          reserved_units: 0,
          remaining_units: 0,
          used_this_month_units: 10,
          exhausted: true,
        },
      }),
      pausedTriggerCount: 1,
    });
    expect(html).toContain('data-testid="credits-exhausted-card"');
    expect(html).toContain("Out of Shera credits");
    expect(html).toContain("administrator");
    expect(html).toContain("tops the account up");
    expect(html).toContain("cancel them from their Operation chat");
    // The D48 vocabulary verbatim: the pause reason the runtime writes.
    expect(html).toContain("insufficient credits");
    // The capability truth (D20): credits gate model calls only.
    expect(html).toContain("Credits never affect tools, files, or approvals");
    expect(html).toContain("1 scheduled trigger is paused for credits right now.");
  });

  it("a not-yet-provisioned account says so instead of fabricating a zero balance (G4)", () => {
    const html = renderCredits({ summary: null, surfaceState: "ready" });
    expect(html).toContain("No credit account exists in this workspace yet");
    // The not-provisioned state fabricates nothing — no balance, no card.
    expect(html).not.toContain('data-testid="credits-exhausted-card"');
    expect(html).not.toContain('data-testid="credits-remaining"');
  });
});

describe("S24 — the sidebar credits pill (D21)", () => {
  it("renders the remaining number with the reserved reveal for both pointer and keyboard", () => {
    const html = renderToStaticMarkup(
      createElement(CreditsPillView, { account: summary().account! }),
    );
    expect(html).toContain('data-testid="credits-pill"');
    expect(html).toContain("150");
    expect(html).toContain("credits left");
    // The reserved reveal exists AND is keyboard-reachable (group-focus-within
    // mirrors the hover path — hover is never the only way to the number).
    expect(html).toContain("25");
    expect(html).toContain("reserved for running tasks");
    expect(html).toContain("group-hover:block group-focus-within:block");
    // The screen-reader text carries both numbers (hover is never the only
    // signal — §2.1).
    expect(html).toContain("150 Shera credits remaining, 25 reserved for running tasks.");
    expect(html).toContain("sr-only");
  });

  it("an exhausted account reads amber with the unblocking path named in words", () => {
    const html = renderToStaticMarkup(
      createElement(CreditsPillView, {
        account: {
          granted_units: 10,
          charged_units: 10,
          reserved_units: 0,
          remaining_units: 0,
          used_this_month_units: 10,
          exhausted: true,
        },
      }),
    );
    expect(html).toContain("border-approval");
    expect(html).toContain(
      "No Shera credits remaining. An administrator top-up resumes paused runs.",
    );
    // The exhausted pill still links to the credits surface (the what-next).
    expect(html).toContain('href="/app/settings/credits"');
  });

  it("a funded quiet account shows the plain remaining number", () => {
    const html = renderToStaticMarkup(
      createElement(CreditsPillView, {
        account: {
          granted_units: 100,
          charged_units: 40,
          reserved_units: 0,
          remaining_units: 60,
          used_this_month_units: 40,
          exhausted: false,
        },
      }),
    );
    expect(html).toContain("60");
    expect(html).toContain("60 Shera credits remaining.");
  });
});
