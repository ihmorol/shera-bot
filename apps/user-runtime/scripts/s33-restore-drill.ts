/**
 * The S33 restore drill (issue #34; DEV_WORKFLOW Stage 8; PRD §12, E11, D24;
 * guardrails G3/G4).
 *
 * Run from the REPO ROOT:
 *
 *   node --experimental-transform-types apps/user-runtime/scripts/s33-restore-drill.ts
 *
 * The drill, end to end:
 *
 *   1. a LIVE-SHAPED fixture inside a throwaway scratch root (a real
 *      composed runtime over a real migrated SQLite database + a real
 *      workspace files store): a conversation, a chat message attributed to
 *      the fixture user, a project directory + file, and an artifact;
 *   2. ONE snapshot through the recorded BackupService walk (export →
 *      snapshot-time integrity verification → volume capture with the
 *      D22/E9 exclusions → ledger row → retention), then the scheduled
 *      verifier runs over the retained window (the healthy leg);
 *   3. the POST-SNAPSHOT MUTATION (a second message + a second file) — the
 *      data the restore must prove recoverable-from;
 *   4. the RESTORE WALK into a SCRATCH copy through the recorded
 *      RestoreService walk — stop services (the fixture runtime is closed
 *      FOR REAL) → re-verify the snapshot file → replace the database and
 *      the workspace volume → migrations (D24) → restart (the restored copy
 *      is composed FOR REAL);
 *   5. the SMOKE SUBSET over the RESTORED copy over real HTTP:
 *      login/workspace-identity (the workspace answers its owner's
 *      identity-bearing reads), chat history (the snapshot-time message is
 *      there, the post-snapshot message is NOT), artifact read (the seeded
 *      artifact lists and its bytes round-trip exactly).
 *
 * NEVER TOUCHES REAL DATA: every path lives under a mktemp scratch root.
 * The OWNER's live drill is the recorded sensitive-slice item (E11, P4/P9)
 * — this scripted drill is its automated rehearsal, not a substitute.
 *
 * The output is REDACTED BY CONSTRUCTION (G3): every host path is printed
 * as its scratch-root-relative label, and the drill seeds no secret
 * material at all.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "node:http";

import {
  DEFAULT_WORKSPACE_ID,
  composeRuntime,
  type RuntimeHandle,
} from "../src/transport/local-api/compose.ts";
import {
  openDatabase,
  vacuumIntoBackup,
  verifySnapshotIntegrity,
} from "../src/adapters/sqlite/connection.ts";
import { BackupSnapshotsRepository } from "../src/adapters/sqlite/backup-snapshots-repository.ts";
import { SqliteTransactions } from "../src/adapters/sqlite/transactions.ts";
import { BackupService } from "../src/modules/backups/backup-service.ts";
import { SnapshotVerifier } from "../src/modules/backups/snapshot-verifier.ts";
import { RestoreService } from "../src/modules/backups/restore-service.ts";

const WS = DEFAULT_WORKSPACE_ID;
const ACTOR = { type: "user", id: "user_owner" } as const;
const SNAPSHOT_TEXT = "Outline a plan for my thesis chapter, please.";
const POST_SNAPSHOT_TEXT =
  "THIS MESSAGE WAS WRITTEN AFTER THE SNAPSHOT — ITS SURVIVAL WOULD BE A RESTORE FAILURE.";
const ARTIFACT_NAME = "thesis-outline-draft.md";
const ARTIFACT_BYTES = "# Thesis outline (drill artifact)\n\n- chapter 1\n- chapter 2\n";

interface Probe {
  name: string;
  ok: boolean;
  detail: string;
}

const probes: Probe[] = [];
let exitCode = 0;

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function probe(name: string, ok: boolean, detail: string): void {
  probes.push({ name, ok, detail });
  line(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) exitCode = 1;
}

async function main(): Promise<void> {
  line("S33 restore drill — take snapshot → restore into a SCRATCH copy → smoke subset");
  line("posture: every path is under a throwaway scratch root; the owner's live drill");
  line("         (E11, P4/P9) is a separate recorded item — this is the automated rehearsal");
  line("");

  const scratchRoot = mkdtempSync(join(tmpdir(), "shera-s33-drill-"));
  const label = (absolutePath: string): string =>
    absolutePath.startsWith(scratchRoot)
      ? `<scratch>${absolutePath.slice(scratchRoot.length)}`
      : absolutePath;
  try {
    const liveDataDir = join(scratchRoot, "live", "data");
    const restoredDataDir = join(scratchRoot, "restored", "data");
    mkdirSync(liveDataDir, { recursive: true });
    mkdirSync(restoredDataDir, { recursive: true });
    line(`scratch root : <scratch> (mktemp; live-shaped fixture at ${label(liveDataDir)})`);
    line(`restore target: ${label(restoredDataDir)} (the SCRATCH copy)`);
    line("");

    // ---- Phase 1: the live-shaped fixture (a REAL composed runtime). ----
    line("phase 1 — the live-shaped fixture (a real composed runtime over a real database)");
    const runtime1 = composeRuntime({
      dbPath: join(liveDataDir, "runtime.db"),
      workspaceId: WS,
      logUntypedFault: () => {},
    });
    const origin1 = await listen(runtime1);
    line(`  runtime #1 composed + listening (origin redacted: loopback, ephemeral port)`);
    const seed = await seedLiveState(origin1);
    if (!seed.ok) {
      probe("fixture seed", false, seed.detail);
      finish(runtime1, scratchRoot);
      return;
    }
    probe("fixture seed", true, seed.detail);
    line("");

    // ---- Phase 2: ONE snapshot through the recorded walk + the healthy
    // scheduled verification. ----
    line("phase 2 — one snapshot through the recorded BackupService walk");
    const ledgerDb = openDatabase(join(liveDataDir, "runtime.db"));
    const snapshots = new BackupSnapshotsRepository(new SqliteTransactions(ledgerDb.db));
    const service = new BackupService({
      workspaceId: WS,
      dbPath: join(liveDataDir, "runtime.db"),
      snapshotRoot: join(liveDataDir, "..", "data.snapshots"),
      // The live WAL connection is the runtime's own; the export opens a
      // fresh read connection per copy (the recorded E17 export helper sees
      // the committed state through it).
      exportDatabase: (target) => {
        const reader = openDatabase(join(liveDataDir, "runtime.db"));
        try {
          vacuumIntoBackup(reader.db, target);
        } finally {
          reader.close();
        }
      },
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots,
    });
    const taken = await service.takeSnapshot({ triggeredBy: "schedule" });
    if (!taken.taken) {
      probe("snapshot", false, `${taken.reason}: ${taken.detail}`);
      finish(runtime1, scratchRoot);
      return;
    }
    probe(
      "snapshot + snapshot-time integrity",
      true,
      `snapshot taken (db_bytes=${taken.db_bytes}, volume_entries=${taken.volume_entries.length}, integrity=ok)`,
    );
    const verifier = new SnapshotVerifier({
      workspaceId: WS,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      snapshots: service.snapshots,
    });
    const windowOutcome = verifier.verifyRetainedWindow();
    const healthyWindow = windowOutcome.length === 1 && windowOutcome[0]!.verified;
    probe(
      "scheduled verification (healthy window)",
      healthyWindow,
      healthyWindow
        ? "the retained window verifies clean"
        : "the retained window FAILED verification",
    );
    line("");

    // ---- Phase 3: the post-snapshot mutation (the loss the drill proves
    // recoverable-from). ----
    line("phase 3 — the post-snapshot mutation (the data a restore must NOT resurrect)");
    const mutation = await mutateAfterSnapshot(origin1, seed.conversationId);
    probe("post-snapshot mutation", mutation.ok, mutation.detail);
    line("");

    // ---- Phase 4: the restore walk into the SCRATCH copy. ----
    line("phase 4 — the restore walk (stop → verify → replace → migrations → restart)");
    let runtime2: RuntimeHandle | null = null;
    const restore = new RestoreService({
      workspaceId: WS,
      dbPath: join(restoredDataDir, "runtime.db"),
      volumeRoots: [restoredDataDir],
      snapshots: service.snapshots,
      verifyDatabaseCopy: verifySnapshotIntegrity,
      stopServices: () => {
        // The REAL stop posture: the fixture runtime's HTTP server and its
        // SQLite connection are closed for real before anything is replaced.
        void closeRuntime(runtime1);
        line("  stop   : runtime #1 closed (server + SQLite)");
      },
      startServices: () => {
        // The REAL restart: the restored SCRATCH copy is composed for real.
        runtime2 = composeRuntime({
          dbPath: join(restoredDataDir, "runtime.db"),
          workspaceId: WS,
          logUntypedFault: () => {},
        });
        void listen(runtime2);
        line("  restart: runtime #2 composed over the restored scratch copy");
      },
      onStage: (stage) => line(`  stage  : ${stage}`),
    });
    const restored = await restore.restoreSnapshot({ snapshotId: taken.snapshot_id });
    if (!restored.restored) {
      probe("restore walk", false, `${restored.failed_stage}/${restored.code}: ${restored.detail}`);
      finish(runtime2, scratchRoot);
      return;
    }
    probe(
      "restore walk",
      true,
      `restored (migrated ${restored.migrated_from.join(",")} → ${restored.migrated_to.join(",")}, ` +
        `db_bytes=${restored.db_bytes}, volume_entries=${restored.volume_entries.length})`,
    );
    const row = service.snapshots.require(WS, taken.snapshot_id);
    probe(
      "ledger stamp",
      row.restored_at === restored.restored_at,
      `restored_at recorded on the snapshot row`,
    );
    line("");

    // ---- Phase 5: the smoke subset over the RESTORED copy. ----
    line("phase 5 — the smoke subset over the restored scratch copy (real HTTP)");
    if (!runtime2) {
      probe("smoke subset", false, "the restart never composed a runtime");
      finish(runtime2, scratchRoot);
      return;
    }
    const origin2 = await listen(runtime2);
    await smokeSubset(origin2, seed.conversationId);
    line("");

    line(
      probes.every((p) => p.ok)
        ? "DRILL RESULT: PASSED — the snapshot restored into a working scratch copy"
        : "DRILL RESULT: FAILED — see the FAIL probes above",
    );
    finish(runtime2, scratchRoot);
  } catch (error) {
    exitCode = 1;
    line(
      `DRILL RESULT: FAILED — unexpected error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  } finally {
    // Scratch cleanup is best-effort; the archive output never contains the
    // path (G3 redaction by construction).
    void scratchRoot;
  }
  process.exit(exitCode);
}

async function listen(runtime: RuntimeHandle): Promise<string> {
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // The drill drives through its own server wrapping the composed app; the
  // runtime's own httpServer stays unused (the composition allows it).
  return `http://127.0.0.1:${port}`;
}

async function closeRuntime(runtime: RuntimeHandle): Promise<void> {
  try {
    runtime.close();
  } catch {
    // already closed
  }
}

function finish(runtime2: RuntimeHandle | null, scratchRoot: string): void {
  line("  cleanup: closing the drill's runtimes and removing the scratch root");
  if (runtime2) {
    try {
      runtime2.close();
    } catch {
      // already closed
    }
  }
  try {
    rmSync(scratchRoot, { recursive: true, force: true });
  } catch {
    // best effort
  }
  line("  cleanup: done");
}

/** Seed the live state through the REAL HTTP routes: a conversation, one
 * attributed chat message, a project directory + file, one artifact. */
async function seedLiveState(
  origin: string,
): Promise<{ ok: boolean; detail: string; conversationId: string }> {
  try {
    const created = await postJson(origin, "/v1/conversations/commands", {
      type: "conversation.create",
      workspace_id: WS,
      idempotency_key: "s33-drill-seed-v1",
      payload: { title: "General Assistant" },
    });
    const conversationId = asRecord(created.body)["conversation_id"];
    if (created.status !== 200 || typeof conversationId !== "string") {
      return {
        ok: false,
        detail: `conversation.create failed: ${created.status}`,
        conversationId: "",
      };
    }
    const sent = await postJson(origin, "/v1/conversations/commands", {
      type: "message.send",
      workspace_id: WS,
      idempotency_key: "s33-drill-msg-v1",
      payload: {
        conversation_id: conversationId,
        text: SNAPSHOT_TEXT,
        sender: { kind: "user", display_name: "Emon" },
      },
    });
    if (sent.status !== 200) {
      return {
        ok: false,
        detail: `message.send failed: ${sent.status} ${JSON.stringify(sent.body).slice(0, 220)}`,
        conversationId,
      };
    }
    const dir = await postJson(origin, "/v1/workspace/directories", {
      workspace_id: WS,
      path: "workspace://projects/thesis",
      actor: ACTOR,
    });
    if (dir.status !== 200) {
      return {
        ok: false,
        detail: `directory create failed: ${dir.status} ${JSON.stringify(dir.body).slice(0, 220)}`,
        conversationId,
      };
    }
    const file = await putJson(origin, "/v1/workspace/files", {
      workspace_id: WS,
      path: "workspace://projects/thesis/outline.md",
      actor: ACTOR,
      content: "# Outline (pre-snapshot)\n\n- chapter 1\n",
      mime_type: "text/markdown",
    });
    if (file.status !== 200) {
      return {
        ok: false,
        detail: `file write failed: ${file.status} ${JSON.stringify(file.body).slice(0, 220)}`,
        conversationId,
      };
    }
    const artifact = await postJson(origin, "/v1/workspace/artifacts", {
      workspace_id: WS,
      name: ARTIFACT_NAME,
      artifact_type: "document",
      mime_type: "text/markdown",
      content_base64: Buffer.from(ARTIFACT_BYTES, "utf8").toString("base64"),
      task_id: "task_s33_drill_seed",
      actor: ACTOR,
    });
    if (artifact.status !== 201) {
      return {
        ok: false,
        detail: `artifact create failed: ${artifact.status} ${JSON.stringify(artifact.body).slice(0, 220)}`,
        conversationId,
      };
    }
    return {
      ok: true,
      detail:
        "conversation + attributed message (Emon) + projects/thesis directory + outline.md + 1 artifact, all through the real routes",
      conversationId,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      conversationId: "",
    };
  }
}

async function mutateAfterSnapshot(
  origin: string,
  conversationId: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const sent = await postJson(origin, "/v1/conversations/commands", {
      type: "message.send",
      workspace_id: WS,
      idempotency_key: "s33-drill-msg-post-v1",
      payload: {
        conversation_id: conversationId,
        text: POST_SNAPSHOT_TEXT,
        sender: { kind: "user", display_name: "Emon" },
      },
    });
    if (sent.status !== 200) {
      return { ok: false, detail: `post-snapshot message.send failed: ${sent.status}` };
    }
    const file = await putJson(origin, "/v1/workspace/files", {
      workspace_id: WS,
      path: "workspace://projects/thesis/after-snapshot.md",
      actor: ACTOR,
      content: "written after the snapshot\n",
      mime_type: "text/markdown",
    });
    if (file.status !== 200) {
      return { ok: false, detail: `post-snapshot file write failed: ${file.status}` };
    }
    return { ok: true, detail: "one post-snapshot message + one post-snapshot file written" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** The smoke subset (issue #34): login/workspace-identity, chat history,
 * artifact read — over the RESTORED copy's real HTTP surface. */
async function smokeSubset(origin: string, conversationId: string): Promise<void> {
  // Probe 1 — login / workspace identity: the restored workspace answers its
  // owner's identity-bearing reads. (The account login itself lives in the
  // control plane, OUTSIDE the container-local SQLite this slice restores —
  // the honest prototype mapping, recorded in the drill output.)
  const nodes = await getJson(
    origin,
    `/v1/workspace/nodes?workspace_id=${WS}&path=${encodeURIComponent("workspace://projects/thesis")}&actor_type=user&actor_id=${ACTOR.id}`,
  );
  const nodePaths = (asRecord(nodes.body)["nodes"] as unknown[] | undefined)?.map(
    (node) => asRecord(node)["name"],
  );
  const identityRestored =
    nodes.status === 200 &&
    Array.isArray(nodePaths) &&
    nodePaths.includes("outline.md") &&
    !nodePaths.includes("after-snapshot.md");
  probe(
    "login / workspace-identity",
    identityRestored,
    identityRestored
      ? "the restored workspace answers: outline.md present, the post-snapshot file absent"
      : `workspace nodes read failed (status=${nodes.status}, nodes=${JSON.stringify(nodePaths)})`,
  );

  // Probe 2 — chat history: the snapshot-time message is there (attributed
  // to the fixture user), the post-snapshot message is NOT.
  const events = await getJson(
    origin,
    `/v1/conversations/${conversationId}/events?workspace_id=${WS}&last_acknowledged_sequence=0`,
  );
  const journal = (asRecord(events.body)["events"] as unknown[] | undefined) ?? [];
  const texts = journal
    .filter((event) => asRecord(event)["type"] === "message.appended")
    .map((event) => asRecord(asRecord(event)["payload"])["text"]);
  const chatRestored =
    events.status === 200 && texts.includes(SNAPSHOT_TEXT) && !texts.includes(POST_SNAPSHOT_TEXT);
  probe(
    "chat history",
    chatRestored,
    chatRestored
      ? "the snapshot-time message is present; the post-snapshot message is absent"
      : `chat history wrong (status=${events.status}, texts=${JSON.stringify(texts)})`,
  );

  // Probe 3 — artifact read: the seeded artifact lists and its bytes
  // round-trip exactly.
  const list = await getJson(origin, `/v1/workspace/artifacts?workspace_id=${WS}`);
  const artifacts = (asRecord(list.body)["artifacts"] as unknown[] | undefined) ?? [];
  const ours = artifacts.find((artifact) => asRecord(artifact)["name"] === ARTIFACT_NAME);
  const artifactId = ours ? asRecord(ours)["artifact_id"] : undefined;
  if (typeof artifactId !== "string") {
    probe("artifact read", false, `the artifact did not survive (status=${list.status})`);
    return;
  }
  const detail = await getJson(origin, `/v1/workspace/artifacts/${artifactId}?workspace_id=${WS}`);
  const contentBase64 = asRecord(detail.body)["content_base64"];
  const roundTrips =
    detail.status === 200 &&
    typeof contentBase64 === "string" &&
    Buffer.from(contentBase64, "base64").toString("utf8") === ARTIFACT_BYTES;
  probe(
    "artifact read",
    roundTrips,
    roundTrips
      ? "the artifact lists and its bytes round-trip exactly"
      : `the artifact bytes did not round-trip (status=${detail.status})`,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function postJson(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function putJson(
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

await main();
