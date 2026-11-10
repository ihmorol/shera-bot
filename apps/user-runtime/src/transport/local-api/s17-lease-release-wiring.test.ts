/**
 * The D6 lease force-release COMPOSE wiring — the stress-scenario review
 * round's conditions C1, C2a, and C2b.
 *
 * The stress suites (tests/stress/gateway-concurrent-operations.test.ts,
 * tests/stress/cancellation-storm.test.ts) construct
 * RunFlowOperationsService directly and re-declare onRunExecutionEnded by
 * hand — they MIRROR the compose.ts wiring, they do not test it. These
 * suites drive runs to terminal states through the ACTUAL product
 * composition (composeRuntime — the same wire() main.ts composes) and pin
 * the release through the composed write-leases repository, observed on the
 * workspace HTTP surface (GET /v1/workspace/leases).
 *
 * C1: the harness composition's runFlow wiring (compose.ts, inside the
 *     workers system) fires releaseLeasesForTask when a COMMITTED transition
 *     ends the run's execution — a lease NEVER outlives its task (D6).
 *
 * Scope honesty (post C2a/C2b): the claim these suites pin is "every
 * terminal path that composes the flow-wired seam AND the two
 * formerly-bypassed paths" — the approvals-decision cancel (C2a) and the
 * no-harness composition the scheduler walk terminates runs through (C2b).
 *
 * Governing records: D6, D32, D8; E29 (the recorded gateway-wiring deferral
 * this closes); the stress-scenario review round on branch stress-wave-1.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "./compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const WS = DEFAULT_WORKSPACE_ID;
const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

/**
 * The committed fake task worker child as the CONFIGURED harness command —
 * the production spawn adapter launches it exactly as it would launch a real
 * worker. This variant hangs right after ready (`hangAfterStep` 0): the run
 * stays RUNNING until the test's own terminal write, so the release the test
 * pins is the COMPOSE wiring's, never the worker's own done aftermath.
 */
const HANGING_WORKER_HARNESS = {
  file: process.execPath,
  args: [
    resolve(here, "../../modules/workers/fake-task-worker-child.ts"),
    "--run-id",
    "{run_id}",
    "--worker-id",
    "{worker_id}",
    "--heartbeat-ms",
    "{heartbeat_interval_ms}",
    "--hang-after-step",
    "0",
  ],
};

const runtimes: Array<RuntimeHandle> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.close();
  }
});

afterAll(async () => {
  await cleanupTempResources();
});

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Acquire one agent-held task-scoped lease through the workspace HTTP surface. */
async function acquireLease(origin: string, path: string, taskId: string) {
  return postJson(origin, "/v1/workspace/leases", {
    workspace_id: WS,
    path,
    task_id: taskId,
    actor: { type: "agent", id: RESEARCHER },
    ttl_ms: 60_000,
  });
}

/** The workspace's ACTIVE leases as the API answers them (the D6 read). */
async function activeLeases(origin: string): Promise<Array<Record<string, unknown>>> {
  const listed = await getJson(origin, `/v1/workspace/leases?workspace_id=${WS}`);
  expect(listed.status).toBe(200);
  return (listed.body["leases"] ?? []) as Array<Record<string, unknown>>;
}

describe("C1 — the harness composition's task-finish seam releases the run's leases", () => {
  it("a run driven to FAILED through the composed runtime takes its write lease with it (D6)", async () => {
    const dbPath = join(makeTempDir("shera-s17-lease-wiring-"), "runtime.db");
    const runtime = composeRuntime({
      dbPath,
      packsRoot: PACKS_ROOT,
      workerHarness: HANGING_WORKER_HARNESS,
    });
    trackConnection(runtime);
    runtimes.push(runtime);
    await new Promise<void>((resolveListen) =>
      runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const origin = `http://127.0.0.1:${(runtime.httpServer.address() as { port: number }).port}`;

    // The run is created and driven through the composed operations seam —
    // the RunFlowOperationsService instance compose.ts wires, reached the
    // same way the product reaches it (the harness, the scheduler walk, and
    // the routes all hold this ONE instance).
    const operation = runtime.operations.createOperation(WS, {
      definition_ref: null,
      name: "S17 lease-wiring op",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: GENERAL,
    });
    const runId = "run_lease_wiring_c1";
    runtime.operations.createRun(WS, operation.operation_id, { run_id: runId });

    const lease = await acquireLease(origin, "workspace://docs/c1-release-wiring.md", runId);
    expect(lease.status).toBe(201);
    expect(await activeLeases(origin)).toHaveLength(1);

    runtime.operations.applyRunState(WS, operation.operation_id, runId, "QUEUED");
    // RUNNING spawns the hanging worker through the composed runFlow wiring
    // (fire-and-forget); the run stays RUNNING until the test's own write.
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "RUNNING");
    expect(runtime.operations.getRun(WS, operation.operation_id, runId).state).toBe("RUNNING");
    // The lease survives the non-terminal transitions — only execution's END
    // releases it.
    expect(await activeLeases(origin)).toHaveLength(1);

    // The terminal transition THROUGH the composition: the committed FAILED
    // state fires the wired onRunExecutionEnded → releaseLeasesForTask.
    runtime.operations.applyRunState(WS, operation.operation_id, runId, "FAILED");
    expect(runtime.operations.getRun(WS, operation.operation_id, runId).state).toBe("FAILED");

    expect(await activeLeases(origin)).toHaveLength(0);
  });
});
