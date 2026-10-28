/**
 * S17 chunk 2: artifact_refs contract (PRD §4.3, AC16 partial).
 *
 * RED-FIRST: this suite was committed failing, then implemented against.
 *
 * What is pinned here:
 * - insertArtifact mints the artifact id, computes size from the content
 *   bytes, stamps created_at from the (injectable) clock, and returns the
 *   stored row. Provenance (producing Agent + run) is immutable after insert:
 *   the repository exposes no mutation surface at all.
 * - getArtifact returns metadata plus BYTE-IDENTICAL content (STRICT BLOB
 *   round-trip, including NUL and 0xFF bytes) — artifacts open/download for
 *   real. Unknown ids, and the same id in another workspace (E12), read as
 *   null.
 * - listArtifactsByRun returns exactly the run's artifacts — "the run's
 *   artifact count matches reality" — as metadata-only refs (bytes travel only
 *   through getArtifact).
 * - listArtifactsByWorkspace is workspace-scoped (E12): no cross-workspace
 *   leakage.
 */
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.ts";
import { applyMigrations } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";
import { ArtifactsRepository, type ArtifactInsert } from "./artifacts-repository.ts";

const tempDirs: string[] = [];

function newTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s17-artifacts-"));
  tempDirs.push(dir);
  return join(dir, "runtime.db");
}

function openMigratedDb(path: string) {
  const conn = openDatabase(path);
  applyMigrations(conn.db);
  return conn;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeClock(startIso = "2026-10-28T10:00:00.000Z") {
  let currentMs = Date.parse(startIso);
  return {
    now: (): Date => new Date(currentMs),
    tick: (): string => {
      currentMs += 1_000;
      return new Date(currentMs).toISOString();
    },
    iso: (): string => new Date(currentMs).toISOString(),
  };
}

function makeArtifacts() {
  const conn = openMigratedDb(newTempDbPath());
  const clock = makeClock();
  const repo = new ArtifactsRepository(new SqliteTransactions(conn.db), { now: clock.now });
  return { conn, clock, repo };
}

function insert(input: Partial<ArtifactInsert> = {}): ArtifactInsert {
  return {
    workspace_id: "ws_default",
    name: "report.pdf",
    artifact_type: "file",
    mime_type: "application/pdf",
    content: new Uint8Array([1, 2, 3]),
    producer_agent_id: "alice",
    producer_task_id: "task-4",
    ...input,
  };
}

describe("insertArtifact / getArtifact", () => {
  it("mints the id, computes size from the bytes, stamps the clock instant, and echoes provenance", () => {
    const { conn, clock, repo } = makeArtifacts();
    try {
      const stored = repo.insertArtifact(
        insert({ content: new Uint8Array([1, 2, 3, 4, 5]), name: "q4.bin" }),
      );

      expect(stored.artifact_id.startsWith("artifact_")).toBe(true);
      expect(stored.workspace_id).toBe("ws_default");
      expect(stored.name).toBe("q4.bin");
      expect(stored.artifact_type).toBe("file");
      expect(stored.size).toBe(5);
      expect(stored.mime_type).toBe("application/pdf");
      expect(stored.producer_agent_id).toBe("alice");
      expect(stored.producer_task_id).toBe("task-4");
      expect(stored.created_at).toBe(clock.iso());
    } finally {
      conn.close();
    }
  });

  it("round-trips binary content byte-exact, including NUL and 0xFF bytes", () => {
    const { conn, repo } = makeArtifacts();
    try {
      const bytes = new Uint8Array(Buffer.from([0x00, 0x01, 0xff, 0x00, 0xfe, 0x80]));
      const stored = repo.insertArtifact(
        insert({ content: bytes, mime_type: "application/octet-stream" }),
      );

      const loaded = repo.getArtifact("ws_default", stored.artifact_id);
      expect(loaded).not.toBeNull();
      expect(Buffer.compare(Buffer.from(loaded!.content), Buffer.from(bytes))).toBe(0);
      expect(loaded!.size).toBe(bytes.byteLength);
    } finally {
      conn.close();
    }
  });

  it("returns null for an unknown artifact, and for the same id in another workspace (E12)", () => {
    const { conn, repo } = makeArtifacts();
    try {
      const stored = repo.insertArtifact(insert());
      expect(repo.getArtifact("ws_default", "artifact_missing")).toBeNull();
      expect(repo.getArtifact("ws_other", stored.artifact_id)).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("keeps provenance immutable after insert; later inserts never touch earlier rows", () => {
    const { conn, clock, repo } = makeArtifacts();
    try {
      const first = repo.insertArtifact(
        insert({ producer_agent_id: "alice", producer_task_id: "task-4" }),
      );
      const firstCreatedAt = first.created_at;

      clock.tick();
      repo.insertArtifact(insert({ producer_agent_id: "bob", producer_task_id: "task-5" }));

      const reloaded = repo.getArtifact("ws_default", first.artifact_id);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.producer_agent_id).toBe("alice");
      expect(reloaded!.producer_task_id).toBe("task-4");
      expect(reloaded!.created_at).toBe(firstCreatedAt);
    } finally {
      conn.close();
    }
  });

  it("stores a null producing Agent (user/runtime-produced artifacts) without losing provenance", () => {
    const { conn, repo } = makeArtifacts();
    try {
      const stored = repo.insertArtifact(insert({ producer_agent_id: null }));
      const loaded = repo.getArtifact("ws_default", stored.artifact_id);
      expect(loaded).not.toBeNull();
      expect(loaded!.producer_agent_id).toBeNull();
      expect(loaded!.producer_task_id).toBe("task-4");
    } finally {
      conn.close();
    }
  });
});

describe("listArtifactsByRun — the run's artifact count matches reality", () => {
  it("returns exactly the inserted count for the run, and only that run's artifacts", () => {
    const { conn, repo } = makeArtifacts();
    try {
      const runFour = [
        repo.insertArtifact(insert({ name: "a.pdf", producer_task_id: "task-4" })),
        repo.insertArtifact(
          insert({ name: "b.pdf", producer_task_id: "task-4", producer_agent_id: "bob" }),
        ),
        repo.insertArtifact(
          insert({ name: "c.bin", producer_task_id: "task-4", producer_agent_id: null }),
        ),
      ];
      repo.insertArtifact(insert({ name: "d.pdf", producer_task_id: "task-5" }));

      const listed = repo.listArtifactsByRun("task-4");
      expect(listed).toHaveLength(3);
      expect(new Set(listed.map((row) => row.artifact_id))).toEqual(
        new Set(runFour.map((row) => row.artifact_id)),
      );
      expect(listed.every((row) => row.producer_task_id === "task-4")).toBe(true);

      expect(repo.listArtifactsByRun("task-5")).toHaveLength(1);
      expect(repo.listArtifactsByRun("task-missing")).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it("returns metadata-only refs; bytes travel only through getArtifact", () => {
    const { conn, repo } = makeArtifacts();
    try {
      repo.insertArtifact(insert());
      const listed = repo.listArtifactsByRun("task-4");
      expect(listed).toHaveLength(1);
      expect(listed[0]).not.toHaveProperty("content");
      expect(listed[0]?.size).toBe(3);
    } finally {
      conn.close();
    }
  });
});

describe("listArtifactsByWorkspace — scoped correctly (E12)", () => {
  it("keeps each workspace's artifacts independent", () => {
    const { conn, repo } = makeArtifacts();
    try {
      const wsA = [
        repo.insertArtifact(insert({ workspace_id: "ws_a", name: "one.pdf" })),
        repo.insertArtifact(insert({ workspace_id: "ws_a", name: "two.pdf" })),
      ];
      const wsB = [repo.insertArtifact(insert({ workspace_id: "ws_b", name: "three.pdf" }))];

      const listedA = repo.listArtifactsByWorkspace("ws_a");
      const listedB = repo.listArtifactsByWorkspace("ws_b");
      expect(listedA).toHaveLength(2);
      expect(listedB).toHaveLength(1);
      expect(new Set(listedA.map((row) => row.artifact_id))).toEqual(
        new Set(wsA.map((row) => row.artifact_id)),
      );
      expect(new Set(listedB.map((row) => row.artifact_id))).toEqual(
        new Set(wsB.map((row) => row.artifact_id)),
      );
      expect(repo.listArtifactsByWorkspace("ws_missing")).toHaveLength(0);
    } finally {
      conn.close();
    }
  });
});
