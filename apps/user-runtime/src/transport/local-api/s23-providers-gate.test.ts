/**
 * S23 chunk 5 — the D17/G4 provider gate at the composition boundary.
 *
 * With `providerEnforcement: true` (the REAL runtime posture — main.ts;
 * the E2E mock harness does NOT enforce, D51 dual-harness), a turn whose
 * conversation has no usable provider is REFUSED with a typed configuration
 * state before anything is written, and a task run whose provider credential
 * was revoked FAILS SAFELY (typed journal refusal, no worker ever spawns, no
 * fabricated output — G4). Without the option the composition behaves exactly
 * as before (the standing optional-seam shape; the recorded rationale lives
 * in the slice's engineering record).
 *
 * The G4 assertion: after every refused turn, the conversation stream carries
 * NO assistant message — nothing fabricates a completion.
 *
 * Governing records: D17, D20, D22, G3, G4, D51; AC6, AC7.
 */
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type { RuntimeHandle } from "./compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "./compose.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = import.meta.dirname;
const PACKS_ROOT = join(here, "../../../..", "agent-packs");
const WORKSPACE = DEFAULT_WORKSPACE_ID;

const openConnections: SqliteConnection[] = [];

afterEach(() => {
  cleanupTempResources();
});

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
});

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
  close(): Promise<void>;
}

async function composeEnforced(): Promise<RunningRuntime> {
  const dbPath = join(makeTempDir("shera-s23-gate-"), "runtime.db");
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

async function createConversation(origin: string): Promise<string> {
  const created = await postJson(origin, "/v1/conversations/commands", {
    workspace_id: WORKSPACE,
    idempotency_key: `idem_${Math.random().toString(36).slice(2)}`,
    type: "conversation.create",
    payload: { title: "Gate fixture" },
  });
  expect(created.status).toBe(201);
  return (created.body as { conversation_id: string }).conversation_id;
}

async function send(
  origin: string,
  conversationId: string,
  text = "hello",
): Promise<{ status: number; body: Record<string, unknown> }> {
  return postJson(origin, "/v1/conversations/commands", {
    workspace_id: WORKSPACE,
    idempotency_key: `idem_send_${Math.random().toString(36).slice(2)}`,
    type: "message.send",
    payload: { conversation_id: conversationId, sender: { kind: "user", display_name: "Emon" }, text },
  });
}

describe("the provider gate on message.send (D17/G4, enforcement on)", () => {
  it("refuses a send with the typed no-provider state and fabricates nothing", async () => {
    const { runtime, origin, close } = await composeEnforced();
    try {
      const conversationId = await createConversation(origin);
      const refused = await send(origin, conversationId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
      // G4: no fabricated assistant message anywhere on the stream.
      const events = await fetch(
        `${origin}/v1/conversations/${conversationId}/events?workspace_id=${WORKSPACE}&last_acknowledged_sequence=0`,
      ).then((r) => r.json() as Promise<{ events: Array<{ type: string; payload: { sender?: { kind?: string } } }> }>);
      const agentMessages = events.events.filter(
        (event) =>
          event.type === "message.appended" && event.payload.sender?.kind === "agent",
      );
      expect(agentMessages).toEqual([]);
    } finally {
      await close();
    }
  });

  it("accepts a send whose conversation override resolves to an enabled no-key provider", async () => {
    const { runtime, origin, close } = await composeEnforced();
    try {
      const conversationId = await createConversation(origin);
      const provider = runtime.providers.configure({
        workspace_id: WORKSPACE,
        display_name: "Local Ollama",
        protocol: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        api_mode: "no_key",
        credential: null,
        default_model_id: "llama3.2",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      });
      runtime.providers.setConversationOverride(WORKSPACE, conversationId, provider.id, null);
      const accepted = await send(origin, conversationId);
      expect(accepted.status).toBe(201);
    } finally {
      await close();
    }
  });

  it("refuses a disabled provider with its own typed state", async () => {
    const { runtime, origin, close } = await composeEnforced();
    try {
      const conversationId = await createConversation(origin);
      const provider = runtime.providers.configure({
        workspace_id: WORKSPACE,
        display_name: "Disabled Ollama",
        protocol: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        api_mode: "no_key",
        credential: null,
        default_model_id: "llama3.2",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      });
      runtime.providers.setStatus(WORKSPACE, provider.id, false);
      const refused = await send(origin, conversationId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "PROVIDER_DISABLED" });
    } finally {
      await close();
    }
  });

  it("refuses a key-mode provider whose credential was revoked (D22 fail-safe)", async () => {
    const { runtime, origin, close } = await composeEnforced();
    try {
      const conversationId = await createConversation(origin);
      const provider = runtime.providers.configure({
        workspace_id: WORKSPACE,
        display_name: "Revoked endpoint",
        protocol: "openai-compatible",
        base_url: "https://proxy.example.invalid/v1",
        api_mode: "api_key",
        credential: "sk-fixture-0123456789abcdef",
        default_model_id: "m",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      });
      runtime.providers.revokeCredential(WORKSPACE, provider.id);
      const refused = await send(origin, conversationId);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: "PROVIDER_CREDENTIAL_REVOKED" });
    } finally {
      await close();
    }
  });

  it("refuses the enforcement + scripted-replies combination at startup (typed, G4/G5)", async () => {
    expect(() =>
      composeRuntime({
        dbPath: join(makeTempDir("shera-s23-gate-"), "conflict.db"),
        providerEnforcement: true,
        scriptedReplies: { script: [{ text: "fabricated" }] } as never,
      }),
    ).toThrowError(/providerEnforcement/);
  });
});

describe("the provider gate on run start (D20/D22 fail-safe)", () => {
  it("drives a run whose credential was revoked to FAILED with no worker ever spawned", async () => {
    const dbPath = join(makeTempDir("shera-s23-gate-"), "run-gate.db");
    const runtime = composeRuntime({
      dbPath,
      packsRoot: PACKS_ROOT,
      providerEnforcement: true,
      workerHarness: {
        file: process.execPath,
        args: [
          join(here, "../../modules/workers/fake-task-worker-child.ts"),
          "--run-id",
          "{run_id}",
          "--worker-id",
          "{worker_id}",
          "--heartbeat-ms",
          "{heartbeat_interval_ms}",
          "--steps",
          "2",
          "--step-delay-ms",
          "20",
        ],
      },
    });
    trackConnection(runtime);
    await new Promise<void>((resolveListen) =>
      runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
    );
    const origin = `http://127.0.0.1:${(runtime.httpServer.address() as { port: number }).port}`;
    try {
      const provider = runtime.providers.configure({
        workspace_id: WORKSPACE,
        display_name: "Run endpoint",
        protocol: "openai-compatible",
        base_url: "https://proxy.example.invalid/v1",
        api_mode: "api_key",
        credential: "sk-fixture-0123456789abcdef",
        default_model_id: "m",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      });
      const operation = await postJson(origin, "/v1/operations", {
        workspace_id: WORKSPACE,
        definition_ref: null,
        name: "Gate run op",
        roster_agent_ids: ["agent_researcher"],
        coordinator_agent_id: "agent_general_assistant",
      });
      expect(operation.status).toBe(201);
      const operationId = (operation.body as { operation_id: string }).operation_id;
      const run = runtime.operations.createRun(WORKSPACE, operationId, {
        run_id: "run_revoked_gate",
        provider_snapshot: { provider_id: provider.id, model: "m" },
      });
      expect(run.state).toBe("CREATED");
      // Revoke BEFORE the run starts.
      runtime.providers.revokeCredential(WORKSPACE, provider.id);
      // The RUNNING transition is accepted (D8 write commits), and the flow
      // refuses the worker start: the run fails safely.
      runtime.operations.applyRunState(WORKSPACE, operationId, "run_revoked_gate", "RUNNING");
      // Bounded settle for the fire-and-forget hook.
      for (let i = 0; i < 100; i += 1) {
        const state = runtime.operations.getRun(WORKSPACE, operationId, "run_revoked_gate").state;
        if (state === "FAILED") break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(runtime.operations.getRun(WORKSPACE, operationId, "run_revoked_gate").state).toBe(
        "FAILED",
      );
      // No worker row was ever created; the typed refusal is on the stream.
      const conn = openDatabase(dbPath);
      openConnections.push(conn);
      const tx = new SqliteTransactions(conn.db);
      const workers = new TaskWorkersRepository(tx);
      expect(workers.listLiveAll()).toEqual([]);
      const journal = new EventJournalRepository(tx);
      const refusal = journal
        .listStream("run_revoked_gate", WORKSPACE)
        .find((row) => row.event_type === "provider.configuration_refused");
      expect(refusal).toBeTruthy();
      // The refusal carries the typed state, never credential material (G3).
      expect(JSON.stringify(refusal?.payload)).not.toContain("sk-fixture");
    } finally {
      await runtime.close();
    }
  });

  it("keeps an existing run's provider snapshot when the default changes (D20)", async () => {
    const dbPath = join(makeTempDir("shera-s23-gate-"), "snapshot.db");
    const runtime = composeRuntime({
      dbPath,
      packsRoot: PACKS_ROOT,
      providerEnforcement: true,
    });
    trackConnection(runtime);
    try {
      const providerA = runtime.providers.configure({
        workspace_id: WORKSPACE,
        display_name: "Snapshot A",
        protocol: "openai-compatible",
        base_url: "https://a.example.invalid/v1",
        api_mode: "api_key",
        credential: "sk-fixture-aaaaaaaaaaaaaaaa",
        default_model_id: "m-a",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      });
      const operation = runtime.operations.createOperation(WORKSPACE, {
        definition_ref: null,
        name: null,
        roster_agent_ids: ["agent_researcher"],
        coordinator_agent_id: "none",
      });
      const run = runtime.operations.createRun(WORKSPACE, operation.operation_id, {
        run_id: "run_snapshot_keeps",
        provider_snapshot: { provider_id: providerA.id, model: "m-a" },
      });
      expect(run.provider_snapshot).toEqual({ provider_id: providerA.id, model: "m-a" });
      // The catalog changes afterwards — the run's creation-time snapshot is
      // immutable history (D19/D20).
      runtime.providers.setStatus(WORKSPACE, providerA.id, false);
      expect(
        runtime.operations.getRun(WORKSPACE, operation.operation_id, "run_snapshot_keeps")
          .provider_snapshot,
      ).toEqual({ provider_id: providerA.id, model: "m-a" });
    } finally {
      await runtime.close();
    }
  });
});
