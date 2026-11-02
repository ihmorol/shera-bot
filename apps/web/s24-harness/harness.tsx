import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "../app/globals.css";

// The REAL S24 components (the ones the slice ships), fed with the runtime
// ledger's own wire shapes.
import { CreditsSettingsView } from "@/components/settings/credits-settings";
import { CreditsPillView } from "@/components/shell/credits-pill";
import type { CreditsSummary, RunCostDrillDown } from "@/lib/credits-api";

const summary: CreditsSummary = {
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
    input_tokens: 12400,
    output_tokens: 3180,
    providers: ["prov_ollama_local", "prov_research_custom"],
  },
  recent_runs: [
    {
      task_id: "run_9f2c1e_sweep",
      charged_units: 30,
      released_units: 20,
      active_reserved_units: 0,
      last_movement_at: "2026-11-02T09:01:00.000Z",
    },
    {
      task_id: "run_7a11bb_litreview",
      charged_units: 20,
      released_units: 0,
      active_reserved_units: 25,
      last_movement_at: "2026-11-02T09:02:00.000Z",
    },
  ],
};

function drillDownFor(taskId: string): RunCostDrillDown {
  if (taskId === "run_7a11bb_litreview") {
    return {
      task_id: taskId,
      charged_units: 20,
      released_units: 0,
      active_reserved_units: 25,
      movements: [
        {
          workspace_id: "ws-local-default",
          transaction_id: "ctx_b1",
          entry_type: "reservation_hold",
          amount_units: 25,
          task_id: taskId,
          reservation_id: "res_b",
          related_id: null,
          corrects_transaction_id: null,
          created_at: "2026-11-02T09:01:30.000Z",
        },
        {
          workspace_id: "ws-local-default",
          transaction_id: "ctx_b2",
          entry_type: "settlement_charge",
          amount_units: 20,
          task_id: taskId,
          reservation_id: "res_b",
          related_id: null,
          corrects_transaction_id: null,
          created_at: "2026-11-02T09:02:00.000Z",
        },
      ],
      settlements: [
        {
          workspace_id: "ws-local-default",
          settlement_id: "cst_b",
          reservation_id: "res_b",
          task_id: taskId,
          actual_units: 20,
          settled_at: "2026-11-02T09:02:00.000Z",
        },
      ],
      releases: [],
      usage: [
        {
          workspace_id: "ws-local-default",
          usage_id: "usage_b",
          task_id: taskId,
          provider_id: "prov_platform",
          model: "platform-model",
          provider_origin: "platform",
          input_tokens: 3400,
          output_tokens: 620,
          latency_ms: 720,
          charged_units: 20,
          created_at: "2026-11-02T09:02:00.000Z",
        },
      ],
    };
  }
  return {
    task_id: taskId,
    charged_units: 30,
    released_units: 20,
    active_reserved_units: 0,
    movements: [
      {
        workspace_id: "ws-local-default",
        transaction_id: "ctx_a1",
        entry_type: "reservation_hold",
        amount_units: 50,
        task_id: taskId,
        reservation_id: "res_a",
        related_id: null,
        corrects_transaction_id: null,
        created_at: "2026-11-02T09:00:00.000Z",
      },
      {
        workspace_id: "ws-local-default",
        transaction_id: "ctx_a2",
        entry_type: "settlement_charge",
        amount_units: 30,
        task_id: taskId,
        reservation_id: "res_a",
        related_id: null,
        corrects_transaction_id: null,
        created_at: "2026-11-02T09:01:00.000Z",
      },
      {
        workspace_id: "ws-local-default",
        transaction_id: "ctx_a3",
        entry_type: "reservation_release",
        amount_units: 20,
        task_id: taskId,
        reservation_id: "res_a",
        related_id: null,
        corrects_transaction_id: null,
        created_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    settlements: [
      {
        workspace_id: "ws-local-default",
        settlement_id: "cst_a",
        reservation_id: "res_a",
        task_id: taskId,
        actual_units: 30,
        settled_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    releases: [
      {
        workspace_id: "ws-local-default",
        release_id: "rel_a",
        reservation_id: "res_a",
        task_id: taskId,
        released_units: 20,
        reason: "unused_estimate",
        released_at: "2026-11-02T09:01:00.000Z",
      },
    ],
    usage: [
      {
        workspace_id: "ws-local-default",
        usage_id: "usage_a",
        task_id: taskId,
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
  };
}

const exhaustedSummary: CreditsSummary = {
  ...summary,
  account: {
    granted_units: 10,
    charged_units: 10,
    reserved_units: 0,
    remaining_units: 0,
    used_this_month_units: 10,
    exhausted: true,
  },
};

function SettingsHarness() {
  const [selected, setSelected] = useState<string | null>("run_9f2c1e_sweep");
  return (
    <main
      className="min-h-screen bg-canvas px-6 py-8 text-text"
      style={{ fontFamily: "system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-xl py-8">
        <CreditsSettingsView
          summary={summary}
          surfaceState="ready"
          safeErrorMessage={undefined}
          onRetry={() => undefined}
          selectedRunId={selected}
          onSelectRun={setSelected}
          drillDown={selected === null ? null : drillDownFor(selected)}
          drillDownState="ready"
          pausedTriggerCount={0}
        />
      </div>
    </main>
  );
}

function ExhaustedHarness() {
  return (
    <main
      className="min-h-screen bg-canvas px-6 py-8 text-text"
      style={{ fontFamily: "system-ui, sans-serif" }}
    >
      <div className="mx-auto max-w-xl py-8">
        <CreditsSettingsView
          summary={exhaustedSummary}
          surfaceState="ready"
          safeErrorMessage={undefined}
          onRetry={() => undefined}
          selectedRunId={null}
          onSelectRun={() => undefined}
          drillDown={null}
          drillDownState="idle"
          pausedTriggerCount={1}
        />
      </div>
    </main>
  );
}

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div data-view="funded">
        <SettingsHarness />
      </div>
      <div data-view="pill-row" className="bg-canvas px-6 py-8">
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
          sidebar footer
        </p>
        <div className="flex w-64 flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <CreditsPillView account={summary.account!} />
          <CreditsPillView account={exhaustedSummary.account!} />
        </div>
      </div>
      <div data-view="exhausted">
        <ExhaustedHarness />
      </div>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
