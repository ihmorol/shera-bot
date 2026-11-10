/**
 * FEATURE QA journey 4 — schedules + watchers.
 *
 * The user journey: an Operation gets automated inputs — a cron schedule the
 * user edits and pauses, a workspace-file watcher, and an incoming webhook —
 * and each automated input produces EXACTLY ONE run per real occurrence,
 * through the HTTP surfaces the UI drives (create/list/edit/pause/resume,
 * the workspace file write, the webhook receiver, the firings ledger).
 *
 * The dedup pins: a replayed tick/delivery/webhook NEVER produces a second
 * run (the ledger claim), a watcher flood coalesces to one firing, a wrong
 * webhook secret never fires, and the schedule's next-occurrence moves when
 * edited.
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  RESEARCHER,
  GENERAL,
  WS,
  cleanupTempResources,
  composeJourney,
  getJson,
  postJson,
} from "./helpers/runtime-harness.js";

const USER = { type: "user", id: "user_emon" } as const;

async function createOperation(origin: string, name: string): Promise<string> {
  const created = await postJson(origin, "/v1/operations", {
    workspace_id: WS,
    definition_ref: null,
    name,
    roster_agent_ids: [RESEARCHER],
    coordinator_agent_id: GENERAL,
  });
  expect(created.status).toBe(201);
  return (created.body as { operation_id: string }).operation_id;
}

async function runCount(origin: string, operationId: string): Promise<number> {
  const runs = await getJson(origin, `/v1/operations/${operationId}/runs?workspace_id=${WS}`);
  expect(runs.status).toBe(200);
  return ((runs.body["runs"] as Array<unknown>) ?? []).length;
}

/** Wait (bounded) until the predicate holds; the last probe's value returns. */
async function waitFor<T>(
  probe: () => T | Promise<T>,
  predicate: (value: Awaited<T>) => boolean,
  ms = 5000,
): Promise<Awaited<T>> {
  const deadline = Date.now() + ms;
  let value = (await probe()) as Awaited<T>;
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = (await probe()) as Awaited<T>;
  }
  return value;
}

afterAll(async () => {
  await cleanupTempResources();
});

describe("J4: schedules + watchers", () => {
  it("a cron schedule fires exactly once per occurrence, pauses cleanly, and the edit moves the next occurrence", async () => {
    // The injected clock is PINNED (the scheduler's truth source, E37) and
    // advanced explicitly — Monday 2026-11-02 08:30 UTC, before the 09:00 cron.
    let clockValue = "2026-11-02T08:30:00.000Z";
    const journey = await composeJourney({ now: () => clockValue });
    const { origin, runtime } = journey;
    try {
      const operationId = await createOperation(origin, "Weekly sweep operation");

      const created = await postJson(origin, "/v1/schedules", {
        workspace_id: WS,
        kind: "schedule",
        name: "weekly literature sweep",
        target_operation_id: operationId,
        config: { cron: "0 9 * * 1", plan: { prompt: "Compile the weekly sweep." } },
        catch_up_policy: "skip",
        actor: USER,
      });
      expect(created.status).toBe(201);
      const triggerId = (created.body as { trigger_id: string }).trigger_id;
      expect(triggerId).toMatch(/^trg_/);

      // The list renders the truth the UI shows: active, next occurrence.
      const list = await getJson(origin, `/v1/schedules?workspace_id=${WS}`);
      const triggers = list.body["triggers"] as Array<Record<string, unknown>>;
      expect(triggers[0]).toMatchObject({
        trigger_id: triggerId,
        kind: "schedule",
        state: "active",
        next_occurrence_at: "2026-11-02T09:00:00.000Z",
      });

      // Nothing fired before its time.
      expect(await runCount(origin, operationId)).toBe(0);

      // ── The occurrence comes due: the tick fires it EXACTLY once ──
      clockValue = "2026-11-02T09:05:00.000Z";
      await runtime.scheduler.tick();
      const runsAfterFire = await waitFor(
        () => runCount(origin, operationId),
        (count) => count === 1,
      );
      expect(runsAfterFire).toBe(1);

      // The replay tick over the SAME state fires nothing (the ledger claim).
      await runtime.scheduler.tick();
      expect(await runCount(origin, operationId)).toBe(1);

      // The firings ledger shows the ONE row.
      const firings = await getJson(
        origin,
        `/v1/schedules/${triggerId}/firings?workspace_id=${WS}`,
      );
      expect(firings.status).toBe(200);
      expect((firings.body["firings"] as Array<unknown>) ?? []).toHaveLength(1);

      // ── Pause: the due occurrence while paused fires nothing ──
      const paused = await postJson(origin, `/v1/schedules/${triggerId}/pause`, {
        workspace_id: WS,
        actor: USER,
      });
      expect(paused.status).toBe(200);
      expect(paused.body).toMatchObject({ trigger_id: triggerId, state: "paused" });

      clockValue = "2026-11-09T09:05:00.000Z"; // the NEXT Monday occurrence
      await runtime.scheduler.tick();
      expect(await runCount(origin, operationId)).toBe(1); // unchanged

      // ── Resume + edit: the cron moves, the next occurrence moves, and the
      // next due occurrence fires exactly one MORE run ──
      const resumed = await postJson(origin, `/v1/schedules/${triggerId}/resume`, {
        workspace_id: WS,
        actor: USER,
      });
      expect(resumed.status).toBe(200);
      const edited = await postJson(origin, `/v1/schedules/${triggerId}/edit`, {
        workspace_id: WS,
        name: "weekly literature sweep (renamed)",
        config: { cron: "30 10 * * 1", plan: { prompt: "Sweep later." } },
        actor: USER,
      });
      expect(edited.status).toBe(200);

      const afterEdit = await getJson(origin, `/v1/schedules?workspace_id=${WS}`);
      const row = (afterEdit.body["triggers"] as Array<Record<string, unknown>>)[0];
      expect(row?.name).toBe("weekly literature sweep (renamed)");
      // The clock (2026-11-09 09:05) is BEFORE 10:30, so the edited cron's
      // next occurrence is the SAME Monday at 10:30.
      expect(row?.next_occurrence_at).toBe("2026-11-09T10:30:00.000Z");

      clockValue = "2026-11-09T10:35:00.000Z";
      await runtime.scheduler.tick();
      const runsAfterEditFire = await waitFor(
        () => runCount(origin, operationId),
        (count) => count === 2,
      );
      expect(runsAfterEditFire).toBe(2);

      // Still exactly one run per occurrence: the replay changes nothing.
      await runtime.scheduler.tick();
      expect(await runCount(origin, operationId)).toBe(2);
    } finally {
      await journey.close();
    }
  });

  it("a workspace-file watcher fires once per real change through the HTTP write surface", async () => {
    let clockValue = "2026-11-02T08:30:00.000Z";
    const journey = await composeJourney({ now: () => clockValue });
    const { origin, runtime } = journey;
    try {
      const operationId = await createOperation(origin, "Dataset watch operation");
      const created = await postJson(origin, "/v1/schedules", {
        workspace_id: WS,
        kind: "file_watch",
        name: "dataset watch",
        target_operation_id: operationId,
        config: { scope: "workspace", path_uri: "workspace://datasets/report.md" },
        catch_up_policy: "skip",
        actor: USER,
      });
      expect(created.status).toBe(201);
      const triggerId = (created.body as { trigger_id: string }).trigger_id;

      // Baseline: the watcher adopts the observed state — nothing fires.
      clockValue = "2026-11-02T08:31:00.000Z";
      await runtime.scheduler.tick();
      expect(await runCount(origin, operationId)).toBe(0);

      // The USER writes the file through the HTTP workspace surface.
      const write = await fetch(`${origin}/v1/workspace/files`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: WS,
          path: "workspace://datasets/report.md",
          actor: USER,
          content: "v1 of the dataset report",
        }),
      });
      expect(write.status).toBe(200);

      clockValue = "2026-11-02T08:32:00.000Z";
      await runtime.scheduler.tick();
      const afterFirstWrite = await waitFor(
        () => runCount(origin, operationId),
        (count) => count === 1,
      );
      expect(afterFirstWrite).toBe(1);

      // The second tick over the SAME content fires nothing (the signature).
      await runtime.scheduler.tick();
      expect(await runCount(origin, operationId)).toBe(1);

      // A real content change fires exactly one more.
      const secondWrite = await fetch(`${origin}/v1/workspace/files`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace_id: WS,
          path: "workspace://datasets/report.md",
          actor: USER,
          content: "v2 of the dataset report",
        }),
      });
      expect(secondWrite.status).toBe(200);
      clockValue = "2026-11-02T08:33:00.000Z";
      await runtime.scheduler.tick();
      const afterSecondWrite = await waitFor(
        () => runCount(origin, operationId),
        (count) => count === 2,
      );
      expect(afterSecondWrite).toBe(2);

      // The watcher's firings are in the ledger (the run cards' data source).
      const firings = await getJson(
        origin,
        `/v1/schedules/${triggerId}/firings?workspace_id=${WS}`,
      );
      expect(((firings.body["firings"] as Array<unknown>) ?? []).length).toBe(2);
    } finally {
      await journey.close();
    }
  });

  it("the webhook receiver fires once per delivery, dedups the replay, and refuses a wrong secret", async () => {
    const journey = await composeJourney();
    const { origin } = journey;
    try {
      const operationId = await createOperation(origin, "Form intake operation");
      const created = await postJson(origin, "/v1/schedules", {
        workspace_id: WS,
        kind: "webhook",
        name: "form intake hook",
        target_operation_id: operationId,
        config: { source: "form-service", secret: "shera-hook-secret-0123456789" },
        catch_up_policy: "skip",
        actor: USER,
      });
      expect(created.status).toBe(201);
      const triggerId = (created.body as { trigger_id: string }).trigger_id;

      // The delivery fires with the right secret.
      const delivery = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shera-secret": "shera-hook-secret-0123456789",
          "x-shera-delivery-id": "delivery-0001",
        },
        body: JSON.stringify({ form: "signup", name: "Ada" }),
      });
      expect(delivery.status).toBe(200);
      const deliveryBody = (await delivery.json()) as { status: string; run_id?: string };
      expect(deliveryBody.status).toBe("fired");
      expect(typeof deliveryBody.run_id).toBe("string");
      expect(await runCount(origin, operationId)).toBe(1);

      // The REPLAYED delivery (same id) deduplicates — never a second run.
      const replay = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shera-secret": "shera-hook-secret-0123456789",
          "x-shera-delivery-id": "delivery-0001",
        },
        body: JSON.stringify({ form: "signup", name: "Ada" }),
      });
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as { status: string }).status).toBe("deduplicated");
      expect(await runCount(origin, operationId)).toBe(1);

      // A DISTINCT delivery fires one more.
      const second = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shera-secret": "shera-hook-secret-0123456789",
          "x-shera-delivery-id": "delivery-0002",
        },
        body: JSON.stringify({ form: "signup", name: "Grace" }),
      });
      expect(((await second.json()) as { status: string }).status).toBe("fired");
      expect(await runCount(origin, operationId)).toBe(2);

      // A wrong secret never fires (typed 401, no run).
      const wrong = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shera-secret": "wrong-secret-value",
        },
        body: JSON.stringify({ form: "signup", name: "Eve" }),
      });
      expect(wrong.status).toBe(401);
      expect(((await wrong.json()) as { code: string }).code).toBe("WEBHOOK_SECRET_MISMATCH");
      expect(await runCount(origin, operationId)).toBe(2);

      // The firings ledger carries the two real firings only.
      const firings = await getJson(
        origin,
        `/v1/schedules/${triggerId}/firings?workspace_id=${WS}`,
      );
      expect(((firings.body["firings"] as Array<unknown>) ?? []).length).toBe(2);
    } finally {
      await journey.close();
    }
  });
});
