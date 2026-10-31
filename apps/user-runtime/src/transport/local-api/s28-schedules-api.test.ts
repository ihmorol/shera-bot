/**
 * S28 HTTP surface tests (issue #29; PRD §8, E5, G2, G3): the schedules
 * routes — the typed create/list/pause/resume/edit surface and the webhook
 * receiver — over the REAL composed app (real SQLite, real routes).
 *
 * G2: a prose-only body is a typed validation refusal, never a trigger and
 * never a run. G3: a webhook secret crosses exactly one route in each
 * direction (accepted once at create, digest-compared at delivery) and a
 * delivery body NEVER enters the journal, the ledger detail, or a log —
 * only the bounded derived summary the typed trigger payload carries.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "./compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import { cleanupTempResources, makeTempDir, trackConnection } from "../../../test/helpers/temp-resources.ts";

const here = import.meta.dirname;
const PACKS_ROOT = join(here, "../../../../../agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const USER = { type: "user", id: "emon" };

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function compose(): Promise<RunningRuntime> {
  const dbPath = join(makeTempDir("shera-s28-api-"), "runtime.db");
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) => runtime.httpServer.listen(0, "127.0.0.1", resolveListen));
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

async function postJson(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createOperation(origin: string, name: string): Promise<string> {
  const created = await postJson(origin, "/v1/operations", {
    workspace_id: WS,
    definition_ref: null,
    name,
    roster_agent_ids: ["agent_researcher"],
    coordinator_agent_id: "agent_general_assistant",
  });
  expect(created.status).toBe(201);
  return (created.body as { operation_id: string }).operation_id;
}

const openHarnesses: RunningRuntime[] = [];

afterEach(async () => {
  for (const harness of openHarnesses.splice(0)) {
    await harness.close();
  }
  await cleanupTempResources();
});

describe("the schedules HTTP surface (typed declarative records)", () => {
  it("creates, lists, pauses, resumes, and edits a trigger through the routes", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const operationId = await createOperation(origin, "Sweep Op");
    const created = await postJson(origin, "/v1/schedules", {
      workspace_id: WS,
      kind: "schedule",
      name: "weekly literature sweep",
      target_operation_id: operationId,
      config: { cron: "0 9 * * 1", plan: { prompt: "Compile the weekly sweep." } },
      catch_up_policy: "catch_up",
      actor: USER,
    });
    expect(created.status).toBe(201);
    const triggerId = created.body.trigger_id as string;
    expect(triggerId).toMatch(/^trg_/);

    const list = await getJson(origin, `/v1/schedules?workspace_id=${WS}`);
    expect(list.status).toBe(200);
    const triggers = list.body.triggers as Array<Record<string, unknown>>;
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      trigger_id: triggerId,
      kind: "schedule",
      state: "active",
      next_occurrence_at: "2026-11-02T09:00:00.000Z",
    });

    const paused = await postJson(origin, `/v1/schedules/${triggerId}/pause`, {
      workspace_id: WS,
      actor: USER,
    });
    expect(paused.status).toBe(200);
    const resumed = await postJson(origin, `/v1/schedules/${triggerId}/resume`, {
      workspace_id: WS,
      actor: USER,
    });
    expect(resumed.status).toBe(200);
    const edited = await fetch(`${origin}/v1/schedules/${triggerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: WS,
        name: "weekly sweep (renamed)",
        config: { cron: "30 10 * * 1", plan: { prompt: "Sweep later." } },
        actor: USER,
      }),
    });
    expect(edited.status).toBe(200);
    const view = await getJson(origin, `/v1/schedules?workspace_id=${WS}`);
    const row = (view.body.triggers as Array<Record<string, unknown>>)[0];
    expect(row?.name).toBe("weekly sweep (renamed)");
    expect(row?.next_occurrence_at).toBe("2026-11-02T10:30:00.000Z");
  });

  it("refuses a prose-only body with the typed validation refusal (G2) and creates nothing", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const operationId = await createOperation(origin, "Prose Op");
    const refused = await postJson(origin, "/v1/schedules", {
      workspace_id: WS,
      prose: "please sweep the literature every monday morning",
      target_operation_id: operationId,
      actor: USER,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("CONTRACT_VALIDATION_FAILED");
    // Nothing was created: no trigger, no run (G2).
    const list = await getJson(origin, `/v1/schedules?workspace_id=${WS}`);
    expect(list.body.triggers).toHaveLength(0);
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(0);
  });

  it("answers a missing workspace_id and an unknown trigger with typed states", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const missing = await getJson(origin, "/v1/schedules");
    expect(missing.status).toBe(400);
    const unknown = await postJson(origin, "/v1/schedules/trg_missing/pause", {
      workspace_id: WS,
      actor: USER,
    });
    expect(unknown.status).toBe(404);
  });
});

describe("the webhook receiver (AC2: a duplicate delivery fires exactly one run)", () => {
  async function webhookTrigger(origin: string, operationId: string) {
    const created = await postJson(origin, "/v1/schedules", {
      workspace_id: WS,
      kind: "webhook",
      name: "intake hook",
      target_operation_id: operationId,
      config: { source: "form-service", secret: "shera-hook-secret-0123456789" },
      catch_up_policy: "skip",
      actor: USER,
    });
    expect(created.status).toBe(201);
    return created.body.trigger_id as string;
  }

  it("fires once for a delivery; the replayed delivery answers deduplicated", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const operationId = await createOperation(origin, "Hook Op");
    const triggerId = await webhookTrigger(origin, operationId);

    const first = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shera-secret": "shera-hook-secret-0123456789",
        "x-shera-delivery-id": "delivery-0001",
      },
      body: JSON.stringify({ event: "form.submitted", form_id: "F-1" }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { status: string };
    expect(firstBody.status).toBe("fired");
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(1);

    // The duplicate delivery: the ledger claim dedups — exactly one run.
    const duplicate = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shera-secret": "shera-hook-secret-0123456789",
        "x-shera-delivery-id": "delivery-0001",
      },
      body: JSON.stringify({ event: "form.submitted", form_id: "F-1" }),
    });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { status: string }).status).toBe("deduplicated");
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(1);
  });

  it("digests the body when no delivery id header exists (the dedup key is data)", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const operationId = await createOperation(origin, "Digest Op");
    const triggerId = await webhookTrigger(origin, operationId);
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shera-secret": "shera-hook-secret-0123456789",
        },
        body: JSON.stringify({ event: "same.body" }),
      });
      expect(response.status).toBe(200);
    }
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(1);
  });

  it("refuses a wrong secret with 401 and never creates a run", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const operationId = await createOperation(origin, "Secret Op");
    const triggerId = await webhookTrigger(origin, operationId);
    const refused = await fetch(`${origin}/v1/webhooks/${triggerId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shera-secret": "wrong-secret-value",
        "x-shera-delivery-id": "delivery-bad",
      },
      body: JSON.stringify({ event: "intrusion" }),
    });
    expect(refused.status).toBe(401);
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(0);
  });

  it("answers an unknown trigger with 404 and never echoes the delivery body (G3)", async () => {
    const { origin, close, runtime } = await compose();
    openHarnesses.push({ origin, close, runtime });
    const missing = await fetch(`${origin}/v1/webhooks/trg_missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret_value: "abcdef" }),
    });
    expect(missing.status).toBe(404);
    const text = await missing.text();
    expect(text).not.toContain("abcdef");
    void runtime;
  });
});
