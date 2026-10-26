import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeApiError } from "../lib/runtime-client";
import {
  fetchWorkerAdmission,
  WORKER_QUEUED_REASON_CODES,
  type WorkerAdmissionReadout as WorkerAdmissionReadoutData,
} from "../lib/worker-api";
import {
  WorkerAdmissionReadout,
  formatMemoryCeiling,
} from "../components/settings/worker-admission-readout";

/**
 * S16 chunk 3 — the Task workers readout (UI_DESIGN S11 resource states, E1):
 * the workspace's admission pressure rendered honestly — configured limits,
 * the live worker count, and the queued runs with their reason VERBATIM (the
 * machine-readable code is the contract; G4: a not-configured runtime renders
 * "not configured", never zeros dressed up as policy). The read rides the ONE
 * allowlisted browser surface (GET /v1/workers/admission) through the
 * same-origin proxy; fetch is stubbed at that boundary, and the real round
 * trip is proven in apps/user-runtime.
 */

const render = (element: ReactElement): string => renderToStaticMarkup(element);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The runtime's configured readout, exactly as GET /v1/workers/admission answers. */
const CONFIGURED_READOUT: WorkerAdmissionReadoutData = {
  configured: true,
  limits: {
    maxConcurrentWorkers: 4,
    maxWorkerMemoryBytes: 2 * 1024 * 1024 * 1024,
    maxTotalWorkersMemoryBytes: 8 * 1024 * 1024 * 1024,
    minFreeDiskBytes: 0,
    maxConcurrentRunsPerProvider: 2,
    maxWorkerProcesses: 4096,
  },
  live_workers: 1,
  queued_runs: [
    {
      workspace_id: "ws_1",
      run_id: "run-queue-second",
      reason: { code: "worker_limit_reached", limit: 1, current: 1 },
      message: "worker limit reached: 1 of 1 concurrent workers in use; run queued",
    },
  ],
};

const NOT_CONFIGURED: WorkerAdmissionReadoutData = {
  configured: false,
  limits: null,
  live_workers: 0,
  queued_runs: [],
};

describe("worker admission client (GET /v1/workers/admission)", () => {
  it("rides the same-origin proxy with the workspace selector", async () => {
    const calls: Array<string | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        calls.push(String(input));
        return Promise.resolve(
          Response.json(JSON.parse(JSON.stringify(CONFIGURED_READOUT)) as unknown),
        );
      }),
    );

    const readout = await fetchWorkerAdmission("ws_account-1");

    expect(readout).toMatchObject({ configured: true, live_workers: 1 });
    expect(calls[0]).toBe("/v1/workers/admission?workspace_id=ws_account-1");
  });

  it("parses the not-configured shape verbatim (G4 honesty)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json(NOT_CONFIGURED))),
    );

    const readout = await fetchWorkerAdmission("ws_1");

    expect(readout).toEqual(NOT_CONFIGURED);
  });

  it("rejects a 2xx body off the readout contract as server drift", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ hello: true }))),
    );

    await expect(fetchWorkerAdmission("ws_1")).rejects.toBeInstanceOf(RuntimeApiError);
  });

  it("exposes the four machine-readable reason codes the runtime emits", () => {
    expect([...WORKER_QUEUED_REASON_CODES]).toEqual([
      "worker_limit_reached",
      "memory_limit",
      "disk_pressure",
      "provider_concurrency",
    ]);
  });
});

describe("formatMemoryCeiling", () => {
  it("renders whole GiB without decimals", () => {
    expect(formatMemoryCeiling(2 * 1024 * 1024 * 1024)).toBe("2 GiB");
    expect(formatMemoryCeiling(8 * 1024 * 1024 * 1024)).toBe("8 GiB");
  });

  it("keeps sub-GiB values honest with one decimal", () => {
    expect(formatMemoryCeiling(1_073_741_824 + 536_870_912)).toBe("1.5 GiB");
  });
});

describe("WorkerAdmissionReadout (the Task workers section)", () => {
  function renderReadout(
    overrides: Partial<Parameters<typeof WorkerAdmissionReadout>[0]> = {},
  ): string {
    return render(
      createElement(WorkerAdmissionReadout, {
        state: "ready",
        readout: CONFIGURED_READOUT,
        onRetry: () => {},
        ...overrides,
      }),
    );
  }

  it("labels the section Task workers", () => {
    const markup = renderReadout();
    expect(markup).toContain("Task workers");
    expect(markup).toContain('aria-label="Task workers"');
  });

  it("renders the configured limits and the live count honestly", () => {
    const markup = renderReadout();
    expect(markup).toContain('data-configured="true"');
    expect(markup).toContain("1 of 4");
    expect(markup).toContain("2 GiB");
    expect(markup).toContain("8 GiB");
  });

  it("renders queued runs with their reason code and message VERBATIM", () => {
    const markup = renderReadout();
    expect(markup).toContain('data-reason-code="worker_limit_reached"');
    expect(markup).toContain("run-queue-second");
    expect(markup).toContain("worker limit reached: 1 of 1 concurrent workers in use; run queued");
  });

  it("says when nothing is waiting instead of rendering an empty box", () => {
    const markup = renderReadout({
      readout: { ...CONFIGURED_READOUT, queued_runs: [], live_workers: 0 },
    });
    expect(markup).toContain("No runs waiting");
  });

  it("renders a not-configured runtime as not configured — never fabricated zeros", () => {
    const markup = renderReadout({ readout: NOT_CONFIGURED });
    expect(markup).toContain('data-configured="false"');
    expect(markup).toContain("not configured");
    // G4: no limits table dressed up as policy when the runtime has none.
    expect(markup).not.toContain('data-testid="workers-limits"');
  });

  it("renders the §2.4 error state with the safe message and retry", () => {
    const markup = renderReadout({
      state: "error",
      readout: null,
      safeErrorMessage: "The worker readout could not be loaded.",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("The worker readout could not be loaded.");
    expect(markup).toContain("Retry");
  });

  it("renders a layout-matched skeleton while loading", () => {
    const markup = renderReadout({ state: "loading", readout: null });
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("animate-pulse");
  });
});
