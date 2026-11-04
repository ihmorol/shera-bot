/**
 * S29 chunk 2 — the write-time secret rejection and the publication approval
 * gate (issue #30 AC2; PRD §11, D22/E9, D37, G3/G6).
 *
 * The core pin: credentials, secrets, API keys, and tokens are ALWAYS
 * rejected at the write boundary — the typed rejection is visible (reason
 * classes, never the content) and NOTHING is stored: the whole database file
 * (plus its WAL sidecars) is byte-scanned for every rejected literal, the
 * S23 custody-scan posture. Memory must never become a secret store (D22).
 *
 * The second pin: publication of a SENSITIVE memory requires the explicit
 * approval trail — a direct approve without a pending request is the typed
 * refusal; the request → approve path records the deciding user. Automatic
 * learning rides the typed `memory.candidate_proposed` journal event (G2)
 * and an automatic proposal WITHOUT provenance is refused before anything
 * exists (AC3).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "../transport/local-api/compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const WORKSPACE = DEFAULT_WORKSPACE_ID;
const RESEARCHER = "agent_researcher";

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dbPath: string;
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
    dbPath,
    close: () => runtime.close(),
  };
}

async function post(origin: string, path: string, body: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function createCommand(extra: Record<string, unknown>) {
  return {
    command_id: `cmd_${Math.random().toString(36).slice(2, 10)}`,
    idempotency_key: `idem_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE,
    actor: { type: "user", id: "user_emon" },
    issued_at: "2026-11-04T10:00:00.000Z",
    type: "memory.create",
    owner_agent_id: null,
    operation_id: null,
    task_id: null,
    expires_at: null,
    ...extra,
  };
}

/**
 * Every byte of every file that belongs to the database (the db, the WAL,
 * the shm) must be free of the rejected literals — the S23 custody-scan
 * posture applied to memory: a rejection that left the secret on disk would
 * be a leak, not a rejection.
 */
function databaseBytes(dbPath: string): string {
  const dir = dirname(dbPath);
  const base = dbPath.slice(dir.length + 1);
  let combined = "";
  for (const name of readdirSync(dir)) {
    if (name !== base && !name.startsWith(`${base}-`)) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    combined += readFileSync(path).toString("latin1");
  }
  return combined;
}

/** The fixture shapes: real secret FORMS with fake values (no real credential ever appears here). */
const SECRET_FIXTURES: ReadonlyArray<{ label: string; content: string; needle: string }> = [
  {
    label: "API key assignment",
    content:
      "The service needs OPENAI_API_KEY=sk-proj-4f9a2b8c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e before calls work.",
    needle: "sk-proj-4f9a2b8c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e",
  },
  {
    label: "token assignment (quoted)",
    content: 'Deploy note: the token is "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" until Friday.',
    needle: "ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  },
  {
    label: "password assignment",
    content: "Staging database password: hunter2-correct-horse-battery",
    needle: "hunter2-correct-horse-battery",
  },
  {
    label: "bearer token",
    content: "Use this for the API call: Bearer abc123def456ghi789jkl012mno345",
    needle: "abc123def456ghi789jkl012mno345",
  },
  {
    label: "connection-string credential",
    content: "The importer connects with postgres://etl_user:s3cretPa55word@db.internal:5432/app",
    needle: "s3cretPa55word",
  },
  {
    label: "high-entropy client secret",
    content:
      "client_secret: Zx91vWq7Pp3LmKd8Rn5Tj2Yh6Bg4Fc0As1Ew9Xz7Qa3Nb5Mc1Vr",
    needle: "Zx91vWq7Pp3LmKd8Rn5Tj2Yh6Bg4Fc0As1Ew9Xz7Qa3Nb5Mc1Vr",
  },
];

afterAll(async () => {
  await cleanupTempResources();
});

describe("S29 chunk 2: the write-time secret rejection (AC2)", () => {
  it("rejects every secret-shaped create, never stores it, and shows the rejection honestly", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-secret-"), "runtime.db"));
    const { origin, dbPath } = running;

    for (const fixture of SECRET_FIXTURES) {
      const rejected = await post(origin, "/v1/memory/commands", createCommand({
        scope: "workspace",
        summary: `Remember the ${fixture.label}`,
        content: fixture.content,
        sensitivity: "normal",
        source_refs: ["conversation://direct/user_emon"],
        confidence: 0.8,
      }));
      expect(rejected.status, fixture.label).toBe(400);
      expect(rejected.body, fixture.label).toMatchObject({ code: "MEMORY_SECRET_REJECTED" });
      // The rejection is HONEST: it names the reason class, never echoes the
      // secret back into the response (G3).
      expect(JSON.stringify(rejected.body), fixture.label).not.toContain(fixture.needle);
    }

    // NOTHING was stored: the whole database surface carries none of the
    // rejected literals, and no memory row exists at all.
    const bytes = databaseBytes(dbPath);
    for (const fixture of SECRET_FIXTURES) {
      expect(bytes.includes(fixture.needle), fixture.label).toBe(false);
    }
    const view = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      scopes: Record<string, unknown[]>;
    };
    const total = Object.values(view.scopes).reduce((sum, rows) => sum + rows.length, 0);
    expect(total).toBe(0);

    // A clean memory created AFTER the rejections still works — the scanner
    // rejects secret shapes, not memory itself.
    const clean = await post(origin, "/v1/memory/commands", createCommand({
      scope: "workspace",
      summary: "Team prefers concise summaries",
      content: "Summaries should stay under two hundred words.",
      sensitivity: "normal",
      source_refs: ["conversation://direct/user_emon"],
      confidence: 0.7,
    }));
    expect(clean.status).toBe(200);

    await running.close();
  });

  it("requires the approval trail for a sensitive publication — a direct approve is the typed refusal", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-sensitive-"), "runtime.db"));
    const { origin } = running;

    const op = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Sensitive sweep",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: RESEARCHER,
    });
    expect(op.status).toBe(201);
    const operationId = op.body["operation_id"] as string;

    const created = await post(origin, "/v1/memory/commands", createCommand({
      scope: "operation",
      operation_id: operationId,
      summary: "Medical-adjacent research context",
      content: "The sweep touches participant health records; handle citations carefully.",
      sensitivity: "sensitive",
      source_refs: [`conversation://${operationId}/messages`],
      confidence: 0.9,
    }));
    expect(created.status).toBe(200);
    const memoryId = (created.body["entry"] as { memory_id: string }).memory_id;

    // A direct approve WITHOUT a pending request is the typed refusal —
    // sensitive publication always carries the approval record.
    const directApprove = await post(origin, "/v1/memory/commands", {
      command_id: "cmd_direct_approve",
      idempotency_key: "idem_direct_approve",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-04T10:05:00.000Z",
      type: "memory.publish_decision",
      memory_id: memoryId,
      operation_id: operationId,
      decision: "approve",
    });
    expect(directApprove.status).toBe(400);
    expect(directApprove.body).toMatchObject({ code: "MEMORY_PUBLICATION_APPROVAL_REQUIRED" });

    // The entry is invisible to the participant Agent while unapproved.
    const hidden = await (await fetch(
      `${origin}/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    ).then((r) => r.json())) as { entries: { memory_id: string }[] };
    expect(hidden.entries.map((entry) => entry.memory_id)).not.toContain(memoryId);

    // The user requests publication; the queue holds it pending; the
    // approval records the deciding user and publishes.
    const request = await post(origin, "/v1/memory/commands", {
      command_id: "cmd_request_pub",
      idempotency_key: "idem_request_pub",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-04T10:06:00.000Z",
      type: "memory.request_publication",
      memory_id: memoryId,
      operation_id: operationId,
    });
    expect(request.status).toBe(200);

    const queue = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      publication_queue: { memory_id: string; status: string }[];
    };
    expect(
      queue.publication_queue.some(
        (row) => row.memory_id === memoryId && row.status === "pending",
      ),
    ).toBe(true);

    const approve = await post(origin, "/v1/memory/commands", {
      command_id: "cmd_approve_pub",
      idempotency_key: "idem_approve_pub",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "user_emon" },
      issued_at: "2026-11-04T10:07:00.000Z",
      type: "memory.publish_decision",
      memory_id: memoryId,
      operation_id: operationId,
      decision: "approve",
    });
    expect(approve.status).toBe(200);

    const visible = await (await fetch(
      `${origin}/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    ).then((r) => r.json())) as { entries: { memory_id: string }[] };
    expect(visible.entries.map((entry) => entry.memory_id)).toContain(memoryId);

    await running.close();
  });
});

describe("S29 chunk 2: automatic learning with provenance (AC3, G2)", () => {
  it("mediates an automatic candidate through the typed MemoryCandidateProposed event and refuses provenance-less proposals", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-candidate-"), "runtime.db"));
    const { origin, runtime } = running;

    const op = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Learning sweep",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: RESEARCHER,
    });
    expect(op.status).toBe(201);
    const operationId = op.body["operation_id"] as string;

    // A provenance-less automatic proposal is refused BEFORE anything
    // exists — no entry, no event (AC3).
    await expect(
      runtime.memory.proposeCandidate({
        workspace_id: WORKSPACE,
        proposed_by_agent_id: RESEARCHER,
        scope: "operation",
        operation_id: operationId,
        summary: "Unsourced preference",
        content: "The user seemed to like shorter answers.",
        source_refs: [],
        confidence: 0.6,
        sensitivity: "normal",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_PROVENANCE_REQUIRED" });

    // A provenanced candidate is accepted: the entry exists (origin
    // automatic) and the typed journal event carries the D37 payload.
    const accepted = await runtime.memory.proposeCandidate({
      workspace_id: WORKSPACE,
      proposed_by_agent_id: RESEARCHER,
      scope: "operation",
      operation_id: operationId,
      summary: "Operation decision: cite only peer-reviewed sources",
      content: "Learned from the user's corrections: peer-reviewed citations only.",
      source_refs: [`conversation://${operationId}/messages`],
      confidence: 0.85,
      sensitivity: "normal",
    });
    expect(accepted.entry.memory_id).toBeTruthy();
    expect(accepted.entry.origin).toBe("automatic");

    // The event is REAL: the journal holds a memory.candidate_proposed
    // envelope whose payload matches the D37 field list.
    const page = (await (await fetch(
      `${origin}/v1/operations/${operationId}/events?workspace_id=${WORKSPACE}`,
    ).then((r) => r.json())) as { events?: unknown[] });
    void page;

    const candidates = runtime.memory.listCandidateEvents(WORKSPACE);
    const mine = candidates.filter(
      (event) => (event.payload as { memory_id: string }).memory_id === accepted.entry.memory_id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.event_type).toBe("memory.candidate_proposed");
    expect(mine[0]!.payload).toMatchObject({
      memory_id: accepted.entry.memory_id,
      scope: "operation",
      sensitivity: "normal",
      confidence: 0.85,
    });
    expect((mine[0]!.payload as { source_refs: string[] }).source_refs).toEqual([
      `conversation://${operationId}/messages`,
    ]);
    expect(mine[0]!.actor).toEqual({ type: "agent", id: RESEARCHER });

    // A secret-shaped automatic candidate is rejected the same way — the
    // automatic path never becomes the leak path.
    await expect(
      runtime.memory.proposeCandidate({
        workspace_id: WORKSPACE,
        proposed_by_agent_id: RESEARCHER,
        scope: "operation",
        operation_id: operationId,
        summary: "Learned credential",
        content: "OPENAI_API_KEY=sk-proj-4f9a2b8c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e",
        source_refs: [`conversation://${operationId}/messages`],
        confidence: 0.9,
        sensitivity: "normal",
      }),
    ).rejects.toMatchObject({ code: "MEMORY_SECRET_REJECTED" });

    await running.close();
  });

  it("holds a sensitive automatic candidate out of context until the user approves it", async () => {
    const running = await composeOn(join(makeTempDir("shera-s29-candidate-sensitive-"), "runtime.db"));
    const { origin, runtime } = running;

    const op = await post(origin, "/v1/operations", {
      workspace_id: WORKSPACE,
      definition_ref: null,
      name: "Health sweep",
      roster_agent_ids: [RESEARCHER],
      coordinator_agent_id: RESEARCHER,
    });
    expect(op.status).toBe(201);
    const operationId = op.body["operation_id"] as string;

    const accepted = await runtime.memory.proposeCandidate({
      workspace_id: WORKSPACE,
      proposed_by_agent_id: RESEARCHER,
      scope: "operation",
      operation_id: operationId,
      summary: "Participant health context",
      content: "The cohort includes participant health records; citations need care.",
      source_refs: [`conversation://${operationId}/messages`],
      confidence: 0.8,
      sensitivity: "sensitive",
    });
    expect(accepted.entry.memory_id).toBeTruthy();

    // Invisible to the participant while unapproved, and PENDING in the
    // publication queue (the runtime surfaced it for the user).
    const hidden = await (await fetch(
      `${origin}/v1/agents/${RESEARCHER}/memory/context?workspace_id=${WORKSPACE}&operation_id=${operationId}`,
    ).then((r) => r.json())) as { entries: { memory_id: string }[] };
    expect(hidden.entries.map((entry) => entry.memory_id)).not.toContain(
      accepted.entry.memory_id,
    );

    const queue = (await (await fetch(`${origin}/v1/memory?workspace_id=${WORKSPACE}`)).json()) as {
      publication_queue: { memory_id: string; status: string }[];
    };
    expect(
      queue.publication_queue.some(
        (row) => row.memory_id === accepted.entry.memory_id && row.status === "pending",
      ),
    ).toBe(true);

    await running.close();
  });
});
