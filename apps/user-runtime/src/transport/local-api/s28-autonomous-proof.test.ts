/**
 * The AC12 end-to-end autonomous proof (issue #29; PRD §8, §13, §19 AC12,
 * E5, D17, D34, D35, G2, G6): ONE scheduled task completes with NO user
 * action, including its model call (a REAL request through the S23 provider
 * stack against a LOCAL fake endpoint — never a fabricated completion, and
 * never mocked around: the run must be CONFIGURED for the D17 gate to
 * allow it), its tool use (through the S21 executor — the ONE execution
 * path), and its artifact (the run's own output, provenance-stamped).
 *
 * This is the test the slice's title names: an autonomous task that
 * actually fires — and never fires twice.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "./compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = import.meta.dirname;
const PACKS_ROOT = join(here, "../../../../../agent-packs");
const WS = DEFAULT_WORKSPACE_ID;
const FIXTURE_KEY = "sk-fixture-0123456789abcdefSECRET";
const USER = { type: "user", id: "emon" };

// The LOCAL fake OpenAI-compatible endpoint (the S23 fixture pattern): it
// answers ONE fixed completion for the right key and counts every request —
// the model-call leg's proof is the counter, not a mock.
const FIXTURE_COMPLETION = "Weekly literature sweep compiled: 12 new papers indexed.";
let server: Server;
let baseUrl = "";
let requests = 0;

beforeAllFake();

function beforeAllFake(): void {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests += 1;
      const auth = req.headers["authorization"] ?? "";
      if (auth !== `Bearer ${FIXTURE_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad key", type: "auth" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-s28",
          object: "chat.completion",
          created: 0,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: FIXTURE_COMPLETION },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  });
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const openConnections: SqliteConnection[] = [];

interface ProofRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

async function composeProof(): Promise<ProofRuntime> {
  const dbPath = join(makeTempDir("shera-s28-proof-"), "runtime.db");
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    providerEnforcement: true,
  });
  trackConnection(runtime);
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dbPath,
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

const openRuntimes: ProofRuntime[] = [];

afterEach(async () => {
  for (const runtime of openRuntimes.splice(0)) {
    await runtime.close();
  }
  await cleanupTempResources();
});

describe("AC12: one autonomous scheduled task completes with no user action", () => {
  it("fires end to end: model call, tool use, and artifact — with zero user input", async () => {
    const proof = await composeProof();
    openRuntimes.push(proof);
    const { runtime, origin } = proof;
    requests = 0;

    // The provider is CONFIGURED through the recorded catalog (the D17 gate
    // would refuse an unconfigured run — the proof is not mocked around).
    const provider = runtime.providers.configure({
      workspace_id: WS,
      display_name: "Local fake endpoint",
      protocol: "openai-compatible",
      base_url: baseUrl,
      api_mode: "api_key",
      credential: FIXTURE_KEY,
      default_model_id: "fixture-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "user",
    });

    // The tool's real storage is seeded (the note the task reads).
    runtime.noteStore.set("datasets/literature.md", "Seed papers: A, B, C.");

    // The target Operation + the schedule trigger, through the real routes.
    const operation = await postJson(origin, "/v1/operations", {
      workspace_id: WS,
      definition_ref: null,
      name: "Literature sweep",
      roster_agent_ids: ["agent_researcher"],
      coordinator_agent_id: "agent_general_assistant",
    });
    expect(operation.status).toBe(201);
    const operationId = (operation.body as { operation_id: string }).operation_id;

    const created = await postJson(origin, "/v1/schedules", {
      workspace_id: WS,
      kind: "schedule",
      name: "weekly literature sweep",
      target_operation_id: operationId,
      config: {
        cron: "0 9 * * 1",
        plan: {
          prompt: "Compile the weekly literature sweep from the seeded note.",
          tool: {
            tool_id: "tool_note_read",
            tool_version: "1.0.0",
            capability: "file.read",
            args: { path: "datasets/literature.md" },
          },
          artifact: {
            name: "weekly-sweep.md",
            artifact_type: "document",
            mime_type: "text/markdown",
          },
        },
        provider: { provider_id: provider.id, model: "fixture-model" },
      },
      catch_up_policy: "catch_up",
      actor: USER,
    });
    expect(created.status).toBe(201);
    const triggerId = created.body.trigger_id as string;

    // THE FIRING: the scheduler fires the occurrence — no user action
    // anywhere in this chain.
    const dueAt = "2026-11-02T09:00:00.000Z";
    const outcome = await runtime.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: `schedule:${triggerId}:${dueAt}`,
      dueAt,
      detail: { due_at: dueAt },
    });
    expect(outcome).toMatchObject({ outcome: "fired" });
    if (outcome.outcome !== "fired") return;
    const runId = outcome.runId;

    // The run settled SUCCEEDED with the provider snapshot it was
    // configured with.
    const run = runtime.operations.getRun(WS, operationId, runId);
    expect(run.state).toBe("SUCCEEDED");
    expect(run.provider_snapshot).toMatchObject({ provider_id: provider.id, model: "fixture-model" });

    // THE MODEL CALL: the fake endpoint received the request (the counter
    // is the proof — the leg is real, never fabricated).
    expect(requests).toBeGreaterThanOrEqual(1);

    // The run stream carries the whole typed story: the trigger event, the
    // D8 walk, the model-call progress, and the artifact publication.
    const conn = openDatabase(proof.dbPath);
    openConnections.push(conn);
    const journal = new EventJournalRepository(new SqliteTransactions(conn.db));
    const stream = journal.readFrom(WS, `task:${runId}`, 0, 100);
    const types = stream.map((row) => row.event_type);
    expect(types[0]).toBe("trigger.scheduled");
    expect(types).toContain("task.queued");
    expect(types).toContain("task.started");
    expect(types).toContain("progress.reported");
    expect(types).toContain("artifact.published");
    expect(types).toContain("task.succeeded");
    // NO user input anywhere: nothing classified prose into this run (G2).
    expect(types).not.toContain("message.appended");
    const progress = stream.find((row) => row.event_type === "progress.reported");
    expect(JSON.stringify(progress?.payload)).toContain("Scheduled task model call completed");

    // THE TOOL USE: through the executor's history (the ONE execution path).
    const tools = new ToolsRepository(conn.db);
    const history = tools.listExecutionsByTask(WS, runId);
    const toolRow = history.find((row) => row.tool_id === "tool_note_read");
    expect(toolRow).toBeTruthy();
    expect(toolRow?.status).toBe("succeeded");

    // THE ARTIFACT: the run's own output, provenance-stamped, byte-real.
    const artifacts = new ArtifactsRepository(new SqliteTransactions(conn.db));
    const runArtifacts = artifacts.listArtifactsByRun(runId);
    expect(runArtifacts).toHaveLength(1);
    expect(runArtifacts[0]?.name).toBe("weekly-sweep.md");
    const content = artifacts.getArtifact(WS, runArtifacts[0]?.artifact_id ?? "");
    expect(content?.content.length).toBeGreaterThan(0);
    expect(Buffer.from(content?.content ?? "").toString("utf8")).toContain(FIXTURE_COMPLETION);

    // NEVER FIRES TWICE: replaying the occurrence answers deduplicated and
    // no second run, model call, tool execution, or artifact appears.
    const replay = await runtime.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: `schedule:${triggerId}:${dueAt}`,
      dueAt,
      detail: { due_at: dueAt },
    });
    expect(replay).toMatchObject({ outcome: "deduplicated" });
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(1);
    const requestsAfterReplay = requests;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    expect(requests).toBe(requestsAfterReplay);

    // The trigger's bookkeeping is truthful (the UI renders THIS).
    const view = runtime.schedules.getTriggerView(WS, triggerId);
    expect(view?.last_fired_at).toBeTruthy();
    expect(view?.next_occurrence_at).toBe("2026-11-09T09:00:00.000Z");
    expect(view?.recent_firings[0]).toMatchObject({ outcome: "fired", run_id: runId });
  });

  it("refuses an unconfigured trigger through the D17 gate and records the state", async () => {
    const proof = await composeProof();
    openRuntimes.push(proof);
    const { runtime, origin } = proof;
    const operation = await postJson(origin, "/v1/operations", {
      workspace_id: WS,
      definition_ref: null,
      name: "Unconfigured op",
      roster_agent_ids: ["agent_researcher"],
      coordinator_agent_id: "agent_general_assistant",
    });
    const operationId = (operation.body as { operation_id: string }).operation_id;
    const created = await postJson(origin, "/v1/schedules", {
      workspace_id: WS,
      kind: "schedule",
      name: "no provider declared",
      target_operation_id: operationId,
      config: { cron: "0 9 * * 1", plan: { prompt: "Sweep." } },
      catch_up_policy: "skip",
      actor: USER,
    });
    const triggerId = created.body.trigger_id as string;
    const outcome = await runtime.scheduler.fireOccurrence(WS, triggerId, {
      idempotencyKey: "schedule:unconfigured:2026-11-02T09:00:00.000Z",
      dueAt: "2026-11-02T09:00:00.000Z",
      detail: {},
    });
    // The D17 posture: an unconfigured run refuses with the typed state —
    // nothing fabricates a completion (G4).
    expect(outcome).toMatchObject({ outcome: "refused_provider", code: "PROVIDER_NOT_CONFIGURED" });
    expect(runtime.operations.listRuns(WS, operationId)).toHaveLength(0);
  });
});
