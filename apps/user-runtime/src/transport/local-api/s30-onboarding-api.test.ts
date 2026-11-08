/**
 * S30 chunk 2 — the D16 onboarding state machine through the typed local API
 * (issue #31; D16, E43, G2/G4/G6).
 *
 * The recorded shape:
 *
 *   - zero-config start is the DEFAULT: a fresh account's onboarding is
 *     pending and every recommended default is ALREADY active (notification
 *     toggles at their defaults, auto-memory on) — the product works
 *     immediately, no credential invention anywhere;
 *   - the steps are typed and ordered (welcome → provider/model check →
 *     approvals briefing → memory briefing → done); answers are DATA (the
 *     typed option ids, never prose the runtime interprets);
 *   - the provider check READS the deployment default (the providers
 *     registry's own rows) and offers no credential field — a missing
 *     provider is the honest configuration state (G4/D17), never an
 *     invention;
 *   - the memory briefing's auto-memory choice issues the SAME
 *     `memory.set_auto_memory` command the Settings → Memory surface uses
 *     (D16: onboarding and settings share commands and schemas) — a change
 *     made in onboarding is visible in settings and vice versa;
 *   - skippable (dismiss, persisted), reopenable (persisted), resumable
 *     (the answered steps and the current step survive the round trip).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");

const WORKSPACE = DEFAULT_WORKSPACE_ID;

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeOn(dbPath: string): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => runtime.close(),
  };
}

async function get(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function post(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function onboardingCommand(extra: Record<string, unknown>) {
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 10)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-08T10:00:00.000Z",
    // Only the answer command carries the optional free text — the strict
    // contracts refuse unknown keys on the other verbs.
    free_text: extra["type"] === "onboarding.answer" ? null : undefined,
    ...extra,
  };
}

interface OnboardingSnapshot {
  status: string;
  current_step: string;
  steps: Array<{
    step: string;
    title: string;
    question: string | null;
    options: Array<{ option_id: string; label: string }>;
    accepts_free_text: boolean;
    answer: { option_id: string | null; free_text: string | null } | null;
  }>;
  provider_summary: {
    configured: boolean;
    provider_id: string | null;
    model: string | null;
  } | null;
  answers: Record<string, { option_id: string | null; free_text: string | null }>;
}

const stepIds = (snapshot: OnboardingSnapshot): string[] => snapshot.steps.map((s) => s.step);

afterAll(async () => {
  await cleanupTempResources();
});

describe("S30 onboarding: the D16 state machine", () => {
  it("a fresh account is pending with every recommended default already active (zero-config, no invented credentials)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-fresh-"), "runtime.db"));
    const { origin } = running;

    const snapshotResponse = await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = snapshotResponse.body["onboarding"] as OnboardingSnapshot;
    expect(snapshot.status).toBe("pending");
    expect(snapshot.current_step).toBe("welcome");
    expect(stepIds(snapshot)).toEqual([
      "welcome",
      "provider_check",
      "approvals_briefing",
      "memory_briefing",
      "done",
    ]);
    // Every step is answered-from-data: typed options, no free-form prose
    // interpretation; the welcome interview carries the E43 A/B/C/D chips.
    const welcome = snapshot.steps[0]!;
    expect(welcome.options.map((option) => option.option_id)).toEqual([
      "research",
      "programming",
      "exam_prep",
      "something_else",
    ]);
    expect(welcome.accepts_free_text).toBe(true);
    // Zero-config: NO credential FIELD exists anywhere in the step views —
    // the provider step only ever READS the deployment default (D16/D17).
    // The check is key-shaped: the honest COPY may name the posture ("no
    // credentials are asked for"), but no field accepts one.
    for (const step of snapshot.steps) {
      expect(JSON.stringify(step)).not.toMatch(/"(api_key|credential|secret)"\s*:/);
    }

    // The recommended defaults are ALREADY active with no user action: the
    // product works immediately (D16 zero-config start).
    const noteSettings = await get(origin, `/v1/notifications/settings?workspace_id=${WORKSPACE}`);
    expect(noteSettings.body["settings"]).toMatchObject({
      in_app_enabled: true,
      browser_enabled: false,
    });
    const memoryView = await get(origin, `/v1/memory?workspace_id=${WORKSPACE}`);
    expect(memoryView.status).toBe(200);
    expect((memoryView.body["auto_memory"] as Record<string, unknown>)["global_enabled"]).toBe(
      true,
    );
  });

  it("the provider check reads the deployment default (or the honest not-configured state) and never asks for a credential", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-prov-"), "runtime.db"));
    const { origin } = running;

    // A fresh workspace has NO provider configured: the step renders the
    // honest configuration state (G4/D17), never an invented default.
    const fresh = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    const freshCheck = fresh.steps.find((step) => step.step === "provider_check")!;
    expect(fresh.provider_summary).toMatchObject({ configured: false });
    expect(freshCheck.options.map((option) => option.option_id)).toEqual(["keep_default"]);

    // Configure a provider through the REAL registry, then the check reads
    // the deployment default from the registry's own rows.
    const configure = await post(origin, "/v1/providers", {
      workspace_id: WORKSPACE,
      display_name: "Deployment OpenAI",
      protocol: "openai",
      base_url: "https://api.openai.com/v1",
      api_mode: "no_key",
      credential: null,
      default_model_id: "gpt-4o-mini",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
    });
    expect(configure.status).toBe(201);
    const after = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(after.provider_summary).toMatchObject({
      configured: true,
      provider_id: (configure.body as Record<string, unknown>)["id"],
      model: "gpt-4o-mini",
    });
  });

  it("answers are typed data that advance the steps; the memory choice issues the SAME command settings uses (D16 shared schemas)", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-steps-"), "runtime.db"));
    const { origin } = running;

    // Answer the welcome interview with a typed option.
    const welcome = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.answer", step: "welcome", option_id: "research" }),
    );
    expect(welcome.status).toBe(200);

    let snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.current_step).toBe("provider_check");
    expect(snapshot.answers["welcome"]).toMatchObject({ option_id: "research" });

    // Free text rides the same command (the E43 composer answer).
    const freeText = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({
        type: "onboarding.answer",
        step: "provider_check",
        option_id: "keep_default",
      }),
    );
    expect(freeText.status).toBe(200);
    const approvals = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({
        type: "onboarding.answer",
        step: "approvals_briefing",
        option_id: "got_it",
      }),
    );
    expect(approvals.status).toBe(200);
    snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.current_step).toBe("memory_briefing");

    // The memory briefing's auto-memory choice goes through the SAME typed
    // command surface the Memory settings surface uses — a change made in
    // onboarding is visible in settings (D16).
    const memoryOff = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({
        type: "onboarding.answer",
        step: "memory_briefing",
        option_id: "memory_auto_off",
      }),
    );
    expect(memoryOff.status).toBe(200);
    const memoryView = await get(origin, `/v1/memory?workspace_id=${WORKSPACE}`);
    expect((memoryView.body["auto_memory"] as Record<string, unknown>)["global_enabled"]).toBe(
      false,
    );

    // And the change made in SETTINGS is visible in onboarding: re-enable
    // through the memory commands envelope, then the answered step's
    // effective state reads back on.
    const memoryOn = await post(origin, "/v1/memory/commands", {
      command_id: `cmd_${Math.random().toString(36).slice(2, 10)}`,
      idempotency_key: `idem_${Math.random().toString(36).slice(2, 10)}`,
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-08T10:05:00.000Z",
      type: "memory.set_auto_memory",
      enabled: true,
    });
    expect(memoryOn.status).toBe(200);
    snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.answers["memory_briefing"]).toMatchObject({ option_id: "memory_auto_off" });
    // The step view carries the CURRENT effective auto-memory state — the
    // runtime's own record, not a stale local copy.
    const memoryStep = snapshot.steps.find((step) => step.step === "memory_briefing")!;
    expect(memoryStep.title).toContain("Auto-memory is on");

    // Complete through the done step: status completed, resumable summary.
    const done = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.answer", step: "done", option_id: "finish" }),
    );
    expect(done.status).toBe(200);
    snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.status).toBe("completed");
  });

  it("an unknown option or a step out of order is a typed refusal; dismiss is persisted and reopen resumes", async () => {
    const running = await composeOn(join(makeTempDir("shera-s30-skip-"), "runtime.db"));
    const { origin } = running;

    // An option the step does not declare is DATA the runtime refuses (G2).
    const bad = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.answer", step: "welcome", option_id: "nonsense" }),
    );
    expect(bad.status).toBe(400);

    // Answering a LATER step before the earlier ones is refused — the wizard
    // is ordered (D16).
    const skipAhead = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({
        type: "onboarding.answer",
        step: "memory_briefing",
        option_id: "memory_auto_on",
      }),
    );
    expect(skipAhead.status).toBe(400);

    // Skip: dismiss is persisted.
    const dismiss = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.dismiss" }),
    );
    expect(dismiss.status).toBe(200);
    let snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.status).toBe("dismissed");

    // Reopen: pending again, resumable at the first unanswered step.
    const reopen = await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.reopen" }),
    );
    expect(reopen.status).toBe(200);
    snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.status).toBe("pending");
    expect(snapshot.current_step).toBe("welcome");

    // Resumability: answer one step, dismiss, reopen — the answer survives.
    await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.answer", step: "welcome", option_id: "exam_prep" }),
    );
    await post(
      origin,
      "/v1/onboarding/commands",
      onboardingCommand({ type: "onboarding.dismiss" }),
    );
    await post(origin, "/v1/onboarding/commands", onboardingCommand({ type: "onboarding.reopen" }));
    snapshot = (await get(origin, `/v1/onboarding?workspace_id=${WORKSPACE}`)).body[
      "onboarding"
    ] as OnboardingSnapshot;
    expect(snapshot.current_step).toBe("provider_check");
    expect(snapshot.answers["welcome"]).toMatchObject({ option_id: "exam_prep" });
  });
});
