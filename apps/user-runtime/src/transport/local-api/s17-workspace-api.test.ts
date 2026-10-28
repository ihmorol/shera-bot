/**
 * S17 chunk 3 — the workspace panel API: typed routes over the REAL composed
 * stack (real SQLite, real migrations, real HTTP), exposing the chunk-1/2
 * storage surfaces (workspace_nodes, write_leases, artifact_refs).
 *
 * The contract under test:
 *
 *  1. File routes on both scopes (D39): the user actor lists, reads, writes,
 *     uploads, makes directories, and deletes in the shared workspace:// tree
 *     AND in any Agent's private agent://<agent_id>/ folder; an Agent actor
 *     reaches only its OWN private scope and the shared scope.
 *  2. Delete is NEVER agent-triggered (G6/D6): AGENT_DELETE_REQUIRES_APPROVAL
 *     in every scope; a cross-private agent delete reads as the D39 denial
 *     (checked first).
 *  3. Agent writes are task-scoped and lease-gated (D6): without the task's
 *     own active lease the gate refuses (WRITE_LEASE_REQUIRED); a user write
 *     blocked by an ACTIVE agent lease answers WRITE_LEASE_CONFLICT with the
 *     tooltip fields serialized (holding agent id + display name + task id).
 *  4. The lease surface: acquire / list / renew / release, plus the
 *     runtime-internal release-for-task force-release (the task-terminal
 *     seam, D6: a lease never outlives its task).
 *  5. Artifacts (AC16): insert with actor+run provenance, list by workspace
 *     and by run, and a byte-exact download.
 *  6. E12 everywhere: reads without an actor are refused (the loopback API's
 *     actor-less request is malformed input, not an implicit user), and the
 *     same path/id in another workspace is another, empty world.
 *
 * Every failure answers the SheraError taxonomy (D23 rule 4) — never a
 * strings-only error.
 *
 * Governing records: D6, D39, G6, E12, AC16, D23 rule 4; chunk-2 notes.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKSPACE_ID, composeRuntime, type RuntimeHandle } from "./compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(resolve(PACKS_ROOT, "student/v1/manifest.json"), "utf8"),
) as {
  agents: Array<{ agent_id: string; display_name: string }>;
};

const WORKSPACE = DEFAULT_WORKSPACE_ID;
const OTHER_WORKSPACE = "ws-s17-other";
const USER_ID = "user_emon";
const RESEARCHER = "agent_researcher";
const CITATION = "agent_citation_manager";

const displayNameOf = (agentId: string): string =>
  STUDENT_MANIFEST.agents.find((agent) => agent.agent_id === agentId)!.display_name;

const USER = { type: "user", id: USER_ID } as const;
const RESEARCHER_ACTOR = { type: "agent", id: RESEARCHER } as const;

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  close(): Promise<void>;
}

async function composeOn(dbPath: string): Promise<RunningRuntime> {
  const runtime = composeRuntime({ dbPath, packsRoot: PACKS_ROOT, workspaceId: WORKSPACE });
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

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function getJson(origin: string, path: string): Promise<JsonResponse> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function sendJson(
  origin: string,
  method: "PUT" | "POST" | "DELETE",
  path: string,
  body: unknown,
): Promise<JsonResponse> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const putJson = (origin: string, path: string, body: unknown) =>
  sendJson(origin, "PUT", path, body);
const postJson = (origin: string, path: string, body: unknown) =>
  sendJson(origin, "POST", path, body);
const deleteJson = (origin: string, path: string, body: unknown) =>
  sendJson(origin, "DELETE", path, body);

/** A user file write body against one scope URI. */
function writeBody(uri: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    workspace_id: WORKSPACE,
    path: uri,
    actor: USER,
    content,
    mime_type: "text/markdown",
    ...extra,
  };
}

/** Acquire one lease for an agent holder (the D6 agent-actor shape). */
async function acquireLease(
  origin: string,
  uri: string,
  taskId: string,
  actor: { type: "user" | "agent"; id: string } = RESEARCHER_ACTOR,
  ttlMs = 60_000,
): Promise<JsonResponse> {
  return postJson(origin, "/v1/workspace/leases", {
    workspace_id: WORKSPACE,
    path: uri,
    task_id: taskId,
    actor,
    ttl_ms: ttlMs,
  });
}

const ERROR_CODE = "code";
const ERROR_DETAILS = "internal_details";

// ---------------------------------------------------------------------------
// 1. Shared-scope file routes, user actor (the panel path)
// ---------------------------------------------------------------------------

describe("S17 workspace file routes (shared scope, user actor)", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("writes, lists, reads, overwrites, and deletes with typed node fields", async () => {
    env = await composeOn(joinDb("s17-shared-"));

    const written = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://docs/report.md",
      "# hello",
    ));
    expect(written.status).toBe(200);
    const node = written.body["node"] as Record<string, unknown>;
    expect(node).toMatchObject({
      name: "report.md",
      is_directory: 0,
      size: 7,
      mime_type: "text/markdown",
      scope: "workspace",
      agent_id: null,
    });
    expect(typeof node["id"]).toBe("string");
    expect(typeof node["updated_at"]).toBe("string");

    const listed = await getJson(
      env.origin,
      `/v1/workspace/nodes?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://docs")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(listed.status).toBe(200);
    const nodes = listed.body["nodes"] as Array<Record<string, unknown>>;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: "report.md", is_directory: 0, scope: "workspace" });
    for (const field of ["id", "name", "is_directory", "size", "mime_type", "updated_at", "scope"]) {
      expect(field in nodes[0]!).toBe(true);
    }

    const read = await getJson(
      env.origin,
      `/v1/workspace/files?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://docs/report.md")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(read.status).toBe(200);
    expect(read.body["mime_type"]).toBe("text/markdown");
    expect(read.body["size"]).toBe(7);
    expect(Buffer.from(read.body["content_base64"] as string, "base64").toString("utf8")).toBe(
      "# hello",
    );

    // Overwrite: same node id, new content/size (the upsert keeps provenance).
    const rewritten = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://docs/report.md",
      "# hello world",
    ));
    expect(rewritten.status).toBe(200);
    expect((rewritten.body["node"] as Record<string, unknown>)["id"]).toBe(node["id"]);
    expect((rewritten.body["node"] as Record<string, unknown>)["size"]).toBe(13);

    const deleted = await postJson(env.origin, "/v1/workspace/delete", {
      workspace_id: WORKSPACE,
      path: "workspace://docs/report.md",
      actor: USER,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true });
    const reread = await getJson(
      env.origin,
      `/v1/workspace/files?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://docs/report.md")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(reread.status).toBe(404);
    expect(reread.body[ERROR_CODE]).toBe("WORKSPACE_NODE_NOT_FOUND");
  });

  it("uploads binary bytes base64 and reads them back byte-exact", async () => {
    env = await composeOn(joinDb("s17-upload-"));
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 255, 65, 66, 10]);
    const uploaded = await postJson(env.origin, "/v1/workspace/files/upload", {
      workspace_id: WORKSPACE,
      path: "workspace://data/blob.bin",
      actor: USER,
      content_base64: Buffer.from(bytes).toString("base64"),
      mime_type: "application/octet-stream",
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body["node"]).toMatchObject({ size: bytes.byteLength, name: "blob.bin" });

    const read = await getJson(
      env.origin,
      `/v1/workspace/files?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://data/blob.bin")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(Buffer.from(read.body["content_base64"] as string, "base64")).toEqual(
      Buffer.from(bytes),
    );
  });

  it("makes directories (idempotent), auto-creates parents on nested writes, and enforces the recursive delete rule", async () => {
    env = await composeOn(joinDb("s17-mkdir-"));

    const made = await postJson(env.origin, "/v1/workspace/directories", {
      workspace_id: WORKSPACE,
      path: "workspace://docs/sub",
      actor: USER,
    });
    expect(made.status).toBe(200);
    expect(made.body["node"]).toMatchObject({ name: "sub", is_directory: 1 });

    const remade = await postJson(env.origin, "/v1/workspace/directories", {
      workspace_id: WORKSPACE,
      path: "workspace://docs/sub",
      actor: USER,
    });
    expect(remade.status).toBe(200);
    expect((remade.body["node"] as Record<string, unknown>)["id"]).toBe(
      (made.body["node"] as Record<string, unknown>)["id"],
    );

    const nested = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://docs/sub/deep/nested.txt",
      "deep",
    ));
    expect(nested.status).toBe(200);

    // Non-empty directory without recursive: the typed state conflict.
    const shallow = await postJson(env.origin, "/v1/workspace/delete", {
      workspace_id: WORKSPACE,
      path: "workspace://docs/sub",
      actor: USER,
    });
    expect(shallow.status).toBe(409);
    expect(shallow.body[ERROR_CODE]).toBe("WORKSPACE_DIRECTORY_NOT_EMPTY");

    const recursive = await postJson(env.origin, "/v1/workspace/delete", {
      workspace_id: WORKSPACE,
      path: "workspace://docs/sub",
      actor: USER,
      recursive: true,
    });
    expect(recursive.status).toBe(200);
    const after = await getJson(
      env.origin,
      `/v1/workspace/nodes?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://docs")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(after.body["nodes"]).toEqual([]);
  });

  it("refuses hostile paths and actor-less reads as typed validation errors", async () => {
    env = await composeOn(joinDb("s17-hostile-"));

    const traversal = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://%2e%2e/escape.txt",
      "nope",
    ));
    expect(traversal.status).toBe(400);
    expect(traversal.body[ERROR_CODE]).toBe("WORKSPACE_PATH_INVALID");

    const actorless = await getJson(
      env.origin,
      `/v1/workspace/nodes?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://")}`,
    );
    expect(actorless.status).toBe(400);
    expect(actorless.body[ERROR_CODE]).toBe("CONTRACT_VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// 2. Private Agent scopes (D39) and the agent delete refusal (G6)
// ---------------------------------------------------------------------------

describe("S17 private scopes (D39) and the agent delete refusal (G6)", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("lets the user read and write every Agent's private scope", async () => {
    env = await composeOn(joinDb("s17-private-user-"));

    const written = await putJson(env.origin, "/v1/workspace/files", writeBody(
      `agent://${RESEARCHER}/notes.md`,
      "private notes",
    ));
    expect(written.status).toBe(200);
    expect(written.body["node"]).toMatchObject({ scope: "agent", agent_id: RESEARCHER });

    const listed = await getJson(
      env.origin,
      `/v1/workspace/nodes?workspace_id=${WORKSPACE}&path=${encodeURIComponent(`agent://${RESEARCHER}/`)}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body["nodes"]).toHaveLength(1);

    const read = await getJson(
      env.origin,
      `/v1/workspace/files?workspace_id=${WORKSPACE}&path=${encodeURIComponent(`agent://${RESEARCHER}/notes.md`)}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(read.status).toBe(200);
    expect(Buffer.from(read.body["content_base64"] as string, "base64").toString("utf8")).toBe(
      "private notes",
    );
  });

  it("denies an Agent another Agent's private scope on reads and writes (D39)", async () => {
    env = await composeOn(joinDb("s17-private-denial-"));

    // Seed a file in Citation Manager's folder (user path).
    await putJson(env.origin, "/v1/workspace/files", writeBody(
      `agent://${CITATION}/sources.md`,
      "sources",
    ));

    const denial = `PRIVATE_SCOPE_DENIED`;
    const read = await getJson(
      env.origin,
      `/v1/workspace/files?workspace_id=${WORKSPACE}&path=${encodeURIComponent(`agent://${CITATION}/sources.md`)}&actor_type=agent&actor_id=${RESEARCHER}`,
    );
    expect(read.status).toBe(403);
    expect(read.body[ERROR_CODE]).toBe(denial);

    const listed = await getJson(
      env.origin,
      `/v1/workspace/nodes?workspace_id=${WORKSPACE}&path=${encodeURIComponent(`agent://${CITATION}/`)}&actor_type=agent&actor_id=${RESEARCHER}`,
    );
    expect(listed.status).toBe(403);
    expect(listed.body[ERROR_CODE]).toBe(denial);

    const written = await putJson(env.origin, "/v1/workspace/files", writeBody(
      `agent://${CITATION}/intrusion.md`,
      "no",
      { actor: RESEARCHER_ACTOR, task_id: "task-sneak" },
    ));
    expect(written.status).toBe(403);
    expect(written.body[ERROR_CODE]).toBe(denial);
  });

  it("refuses agent deletes in its own scope and reads the cross-private delete as the D39 denial", async () => {
    env = await composeOn(joinDb("s17-agent-delete-"));

    await putJson(env.origin, "/v1/workspace/files", writeBody(
      `agent://${RESEARCHER}/own.md`,
      "own",
    ));
    await putJson(env.origin, "/v1/workspace/files", writeBody(
      `agent://${CITATION}/foreign.md`,
      "foreign",
    ));

    // Own scope: still refused — delete is never agent-triggered (G6/D6).
    const own = await postJson(env.origin, "/v1/workspace/delete", {
      workspace_id: WORKSPACE,
      path: `agent://${RESEARCHER}/own.md`,
      actor: RESEARCHER_ACTOR,
    });
    expect(own.status).toBe(403);
    expect(own.body[ERROR_CODE]).toBe("AGENT_DELETE_REQUIRES_APPROVAL");

    // Another Agent's folder: the scope denial is checked FIRST.
    const foreign = await postJson(env.origin, "/v1/workspace/delete", {
      workspace_id: WORKSPACE,
      path: `agent://${CITATION}/foreign.md`,
      actor: RESEARCHER_ACTOR,
    });
    expect(foreign.status).toBe(403);
    expect(foreign.body[ERROR_CODE]).toBe("PRIVATE_SCOPE_DENIED");

    // The shared scope is refused the same way.
    await putJson(env.origin, "/v1/workspace/files", writeBody("workspace://shared.md", "s"));
    const shared = await postJson(env.origin, "/v1/workspace/delete", {
      workspace_id: WORKSPACE,
      path: "workspace://shared.md",
      actor: RESEARCHER_ACTOR,
    });
    expect(shared.status).toBe(403);
    expect(shared.body[ERROR_CODE]).toBe("AGENT_DELETE_REQUIRES_APPROVAL");
  });

  it("lets an Agent write its own scope and the shared scope ONLY through its task's lease (D6)", async () => {
    env = await composeOn(joinDb("s17-agent-write-"));

    // No lease: the gate refuses with the typed conflict (no task_id at all is
    // the same refusal — the gate enforces, not the route schema).
    const unleased = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://draft.md",
      "draft",
      { actor: RESEARCHER_ACTOR },
    ));
    expect(unleased.status).toBe(409);
    expect(unleased.body[ERROR_CODE]).toBe("WRITE_LEASE_REQUIRED");

    const privateLease = await acquireLease(
      env.origin,
      `agent://${RESEARCHER}/notes.md`,
      "task-agent-write",
    );
    expect(privateLease.status).toBe(201);
    const privateWrite = await putJson(env.origin, "/v1/workspace/files", writeBody(
      `agent://${RESEARCHER}/notes.md`,
      "agent notes",
      { actor: RESEARCHER_ACTOR, task_id: "task-agent-write", mime_type: "text/plain" },
    ));
    expect(privateWrite.status).toBe(200);

    const sharedLease = await acquireLease(env.origin, "workspace://draft.md", "task-agent-write");
    expect(sharedLease.status).toBe(201);
    const sharedWrite = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://draft.md",
      "agent draft",
      { actor: RESEARCHER_ACTOR, task_id: "task-agent-write" },
    ));
    expect(sharedWrite.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. The lease surface: acquire / list / renew / release / release-for-task
// ---------------------------------------------------------------------------

describe("S17 write-lease routes (D6)", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("acquires, lists, renews, and releases; a foreign task cannot renew or release", async () => {
    env = await composeOn(joinDb("s17-lease-lifecycle-"));

    const acquired = await acquireLease(
      env.origin,
      "workspace://spec.md",
      "task_1",
      USER,
      60_000,
    );
    expect(acquired.status).toBe(201);
    const lease = acquired.body["lease"] as Record<string, unknown>;
    expect(lease).toMatchObject({
      workspace_id: WORKSPACE,
      scope: "workspace",
      task_id: "task_1",
      path: "workspace://spec.md",
      holder_type: "user",
      holder_id: USER_ID,
    });
    const leaseId = lease["lease_id"] as string;

    const listed = await getJson(env.origin, `/v1/workspace/leases?workspace_id=${WORKSPACE}`);
    expect(listed.status).toBe(200);
    expect(listed.body["leases"]).toHaveLength(1);

    const renewed = await postJson(env.origin, `/v1/workspace/leases/${leaseId}/renew`, {
      workspace_id: WORKSPACE,
      task_id: "task_1",
      ttl_ms: 60_000,
    });
    expect(renewed.status).toBe(200);
    expect((renewed.body["lease"] as Record<string, unknown>)["renewed_at"]).not.toBeNull();

    const foreignRenew = await postJson(env.origin, `/v1/workspace/leases/${leaseId}/renew`, {
      workspace_id: WORKSPACE,
      task_id: "task_foreign",
      ttl_ms: 60_000,
    });
    expect(foreignRenew.status).toBe(403);
    expect(foreignRenew.body[ERROR_CODE]).toBe("LEASE_NOT_HELD");

    const foreignRelease = await deleteJson(env.origin, `/v1/workspace/leases/${leaseId}`, {
      workspace_id: WORKSPACE,
      task_id: "task_foreign",
    });
    expect(foreignRelease.status).toBe(403);
    expect(foreignRelease.body[ERROR_CODE]).toBe("LEASE_NOT_HELD");

    // The lease survived the foreign attempts.
    expect(
      (await getJson(env.origin, `/v1/workspace/leases?workspace_id=${WORKSPACE}`)).body["leases"],
    ).toHaveLength(1);

    const released = await deleteJson(env.origin, `/v1/workspace/leases/${leaseId}`, {
      workspace_id: WORKSPACE,
      task_id: "task_1",
    });
    expect(released.status).toBe(200);
    expect(
      (await getJson(env.origin, `/v1/workspace/leases?workspace_id=${WORKSPACE}`)).body["leases"],
    ).toEqual([]);
  });

  it("refuses a second active lease on the same path with the typed conflict", async () => {
    env = await composeOn(joinDb("s17-lease-conflict-"));

    expect((await acquireLease(env.origin, "workspace://spec.md", "task_1", USER)).status).toBe(
      201,
    );
    const second = await acquireLease(env.origin, "workspace://spec.md", "task_2");
    expect(second.status).toBe(409);
    expect(second.body[ERROR_CODE]).toBe("LEASE_CONFLICT");
    const details = second.body[ERROR_DETAILS] as Record<string, Record<string, unknown>>;
    expect(details["lease_conflict"]).toMatchObject({
      holder_type: "user",
      holder_id: USER_ID,
      task_id: "task_1",
      path: "workspace://spec.md",
    });
  });

  it("serializes WRITE_LEASE_CONFLICT tooltip fields (holding agent id + display name + task) on a blocked user write", async () => {
    env = await composeOn(joinDb("s17-lease-tooltip-"));

    expect(
      (await acquireLease(env.origin, "workspace://report.md", "task_agent", RESEARCHER_ACTOR))
        .status,
    ).toBe(201);

    const blocked = await putJson(env.origin, "/v1/workspace/files", writeBody(
      "workspace://report.md",
      "user edit",
    ));
    expect(blocked.status).toBe(409);
    expect(blocked.body[ERROR_CODE]).toBe("WRITE_LEASE_CONFLICT");
    const details = blocked.body[ERROR_DETAILS] as Record<string, Record<string, unknown>>;
    expect(details["write_lease_conflict"]).toMatchObject({
      holding_agent_id: RESEARCHER,
      holding_agent_name: displayNameOf(RESEARCHER),
      task_id: "task_agent",
      path: "workspace://report.md",
    });
  });

  it("force-releases every lease of one task (the runtime-internal task-terminal seam, D6)", async () => {
    env = await composeOn(joinDb("s17-release-for-task-"));

    expect(
      (await acquireLease(env.origin, "workspace://a.md", "task_end", RESEARCHER_ACTOR)).status,
    ).toBe(201);
    expect(
      (
        await acquireLease(
          env.origin,
          `agent://${RESEARCHER}/b.md`,
          "task_end",
          RESEARCHER_ACTOR,
        )
      ).status,
    ).toBe(201);

    const released = await postJson(env.origin, "/v1/workspace/leases/release-for-task", {
      task_id: "task_end",
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ released: 2 });
    expect(
      (await getJson(env.origin, `/v1/workspace/leases?workspace_id=${WORKSPACE}`)).body["leases"],
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Artifacts (AC16): provenance, lists, byte-exact download
// ---------------------------------------------------------------------------

describe("S17 artifact routes (AC16)", () => {
  const ARTIFACT_BYTES = Uint8Array.from([0, 1, 2, 250, 251, 255, 65, 66, 10, 13]);

  function artifactBody(extra: Record<string, unknown> = {}) {
    return {
      workspace_id: WORKSPACE,
      name: "result.bin",
      artifact_type: "binary",
      mime_type: "application/octet-stream",
      content_base64: Buffer.from(ARTIFACT_BYTES).toString("base64"),
      task_id: "run-artifact-1",
      actor: RESEARCHER_ACTOR,
      ...extra,
    };
  }

  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("inserts with actor+run provenance, lists by workspace and by run, and downloads byte-exact", async () => {
    env = await composeOn(joinDb("s17-artifacts-"));

    const created = await postJson(env.origin, "/v1/workspace/artifacts", artifactBody());
    expect(created.status).toBe(201);
    const artifact = created.body["artifact"] as Record<string, unknown>;
    expect(artifact).toMatchObject({
      workspace_id: WORKSPACE,
      name: "result.bin",
      artifact_type: "binary",
      mime_type: "application/octet-stream",
      size: ARTIFACT_BYTES.byteLength,
      producer_agent_id: RESEARCHER,
      producer_task_id: "run-artifact-1",
    });
    const artifactId = artifact["artifact_id"] as string;

    const byWorkspace = await getJson(
      env.origin,
      `/v1/workspace/artifacts?workspace_id=${WORKSPACE}`,
    );
    expect(byWorkspace.status).toBe(200);
    expect(byWorkspace.body["artifacts"]).toHaveLength(1);

    const byRun = await getJson(
      env.origin,
      `/v1/workspace/artifacts?workspace_id=${WORKSPACE}&task_id=run-artifact-1`,
    );
    expect(byRun.status).toBe(200);
    expect(byRun.body["artifacts"]).toHaveLength(1);

    const otherRun = await getJson(
      env.origin,
      `/v1/workspace/artifacts?workspace_id=${WORKSPACE}&task_id=run-other`,
    );
    expect(otherRun.body["artifacts"]).toEqual([]);

    const download = await getJson(
      env.origin,
      `/v1/workspace/artifacts/${artifactId}?workspace_id=${WORKSPACE}`,
    );
    expect(download.status).toBe(200);
    expect(download.body["mime_type"]).toBe("application/octet-stream");
    expect(download.body["size"]).toBe(ARTIFACT_BYTES.byteLength);
    expect(Buffer.from(download.body["content_base64"] as string, "base64")).toEqual(
      Buffer.from(ARTIFACT_BYTES),
    );

    const unknown = await getJson(
      env.origin,
      `/v1/workspace/artifacts/artifact_missing?workspace_id=${WORKSPACE}`,
    );
    expect(unknown.status).toBe(404);
  });

  it("records null producer_agent_id for user-produced artifacts", async () => {
    env = await composeOn(joinDb("s17-artifacts-user-"));
    const created = await postJson(env.origin, "/v1/workspace/artifacts", artifactBody({
      actor: USER,
    }));
    expect(created.status).toBe(201);
    expect((created.body["artifact"] as Record<string, unknown>)["producer_agent_id"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. E12: the same path/id in another workspace is another, empty world
// ---------------------------------------------------------------------------

describe("S17 workspace scoping (E12)", () => {
  let env: RunningRuntime;

  afterEach(async () => {
    if (env) {
      await env.close();
      env = undefined as unknown as RunningRuntime;
    }
    await cleanupTempResources();
  });

  it("never leaks nodes, leases, or artifacts across workspaces", async () => {
    env = await composeOn(joinDb("s17-e12-"));

    await putJson(env.origin, "/v1/workspace/files", writeBody("workspace://scoped.md", "mine"));
    const artifact = await postJson(env.origin, "/v1/workspace/artifacts", {
      workspace_id: WORKSPACE,
      name: "a.bin",
      artifact_type: "binary",
      mime_type: "application/octet-stream",
      content_base64: Buffer.from([1, 2, 3]).toString("base64"),
      task_id: "run-e12",
      actor: USER,
    });
    const artifactId = (artifact.body["artifact"] as Record<string, unknown>)["artifact_id"];
    await acquireLease(env.origin, "workspace://scoped.md", "task_e12", USER);

    const crossRead = await getJson(
      env.origin,
      `/v1/workspace/files?workspace_id=${OTHER_WORKSPACE}&path=${encodeURIComponent("workspace://scoped.md")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(crossRead.status).toBe(404);
    expect(crossRead.body[ERROR_CODE]).toBe("WORKSPACE_NODE_NOT_FOUND");

    const crossList = await getJson(
      env.origin,
      `/v1/workspace/nodes?workspace_id=${OTHER_WORKSPACE}&path=${encodeURIComponent("workspace://")}&actor_type=user&actor_id=${USER_ID}`,
    );
    expect(crossList.status).toBe(200);
    expect(crossList.body["nodes"]).toEqual([]);

    const crossLeases = await getJson(
      env.origin,
      `/v1/workspace/leases?workspace_id=${OTHER_WORKSPACE}`,
    );
    expect(crossLeases.body["leases"]).toEqual([]);

    const crossArtifactList = await getJson(
      env.origin,
      `/v1/workspace/artifacts?workspace_id=${OTHER_WORKSPACE}`,
    );
    expect(crossArtifactList.body["artifacts"]).toEqual([]);

    const crossArtifactGet = await getJson(
      env.origin,
      `/v1/workspace/artifacts/${artifactId as string}?workspace_id=${OTHER_WORKSPACE}`,
    );
    expect(crossArtifactGet.status).toBe(404);

    // The originating workspace still sees everything.
    expect(
      (
        await getJson(
          env.origin,
          `/v1/workspace/nodes?workspace_id=${WORKSPACE}&path=${encodeURIComponent("workspace://")}&actor_type=user&actor_id=${USER_ID}`,
        )
      ).body["nodes"],
    ).toHaveLength(1);
  });
});

function joinDb(prefix: string): string {
  return join(makeTempDir(prefix), "runtime.db");
}

afterAll(async () => {
  await cleanupTempResources();
});
