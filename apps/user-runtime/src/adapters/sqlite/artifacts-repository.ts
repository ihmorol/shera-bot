/**
 * Artifacts repository (S17 chunk 2; PRD §4.3, AC16) — the only place
 * artifact_refs SQL lives.
 *
 * An ArtifactRef is a run's durable output record: the BYTES live in the row
 * (STRICT BLOB — artifacts open/download for real, byte-exact), and the
 * PROVENANCE is the producing Agent (nullable — the user/runtime can produce
 * artifacts too) plus the producing run (producer_task_id NOT NULL — the run,
 * not the chat, is the lifecycle boundary). size is computed from the content
 * bytes by the repository; the caller never supplies it.
 *
 * PROVENANCE IS IMMUTABLE AFTER INSERT: the repository exposes no mutation
 * surface at all — no update, no delete, no overwrite. Artifact ids are
 * runtime-minted (`artifact_` + UUID), so a re-insert can never rewrite an
 * existing row's provenance.
 *
 * WORKSPACE SCOPING IS NOT OPTIONAL (E12): rows key on (workspace_id,
 * artifact_id); getArtifact is workspace-scoped, and listArtifactsByWorkspace
 * never leaks across workspaces. listArtifactsByRun walks by producer_task_id
 * — task ids are runtime-minted UUIDs, unique across workspaces in practice.
 *
 * Lists return metadata-only refs (the "run's artifact count matches
 * reality" read); bytes travel only through getArtifact.
 */
import { randomUUID } from "node:crypto";

import type { SqliteTransactions } from "./transactions.ts";

/** One artifact_refs row WITHOUT content (list/ref shape). */
export interface ArtifactRef {
  artifact_id: string;
  workspace_id: string;
  name: string;
  artifact_type: string;
  size: number;
  mime_type: string;
  /** The producing Agent, or null when the user/runtime produced it. */
  producer_agent_id: string | null;
  /** The producing run (task id) — always present; a run's outputs are countable. */
  producer_task_id: string;
  created_at: string;
}

/** An artifact WITH its bytes (insert/get shape). */
export interface ArtifactRefWithContent extends ArtifactRef {
  content: Uint8Array;
}

/** The insert input: everything except the minted id, computed size, and clock stamp. */
export interface ArtifactInsert {
  workspace_id: string;
  name: string;
  artifact_type: string;
  mime_type: string;
  content: Uint8Array;
  producer_agent_id: string | null;
  producer_task_id: string;
}

const ARTIFACT_COLUMNS = `
  artifact_id,
  workspace_id,
  name,
  artifact_type,
  size,
  mime_type,
  producer_agent_id,
  producer_task_id,
  created_at`;

type ArtifactRow = Omit<ArtifactRef, "size"> & { size: number | bigint };

function toRef(row: ArtifactRow): ArtifactRef {
  return { ...row, size: Number(row.size) };
}

export class ArtifactsRepository {
  constructor(
    private readonly tx: SqliteTransactions,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private readonly now: () => Date;

  /**
   * Insert one artifact with its provenance. The id is minted, the size is
   * computed from the bytes, created_at comes from the (injectable) clock.
   * Runs in one short transaction; a call inside an open transaction joins it.
   * There is deliberately no update path: provenance is immutable.
   */
  insertArtifact(input: ArtifactInsert): ArtifactRefWithContent {
    return this.tx.transaction((db) => {
      const ref: ArtifactRefWithContent = {
        artifact_id: `artifact_${randomUUID()}`,
        workspace_id: input.workspace_id,
        name: input.name,
        artifact_type: input.artifact_type,
        size: input.content.byteLength,
        mime_type: input.mime_type,
        producer_agent_id: input.producer_agent_id,
        producer_task_id: input.producer_task_id,
        created_at: this.now().toISOString(),
        content: input.content,
      };
      db.prepare(
        `INSERT INTO artifact_refs (
           artifact_id, workspace_id, name, artifact_type, size, mime_type,
           content, producer_agent_id, producer_task_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ref.artifact_id,
        ref.workspace_id,
        ref.name,
        ref.artifact_type,
        ref.size,
        ref.mime_type,
        ref.content,
        ref.producer_agent_id,
        ref.producer_task_id,
        ref.created_at,
      );
      return ref;
    });
  }

  /**
   * One artifact's metadata plus its bytes, or null when the artifact does
   * not exist in THIS workspace (E12: the same id in another workspace is
   * another artifact).
   */
  getArtifact(workspaceId: string, artifactId: string): ArtifactRefWithContent | null {
    const row = this.tx
      .connection()
      .prepare(
        `SELECT ${ARTIFACT_COLUMNS}, content FROM artifact_refs
         WHERE workspace_id = ? AND artifact_id = ?`,
      )
      .get(workspaceId, artifactId) as (ArtifactRow & { content: Uint8Array }) | undefined;
    return row === undefined ? null : { ...toRef(row), content: row.content };
  }

  /** Every artifact of one run (the "count matches reality" read), oldest first. */
  listArtifactsByRun(taskId: string): ArtifactRef[] {
    return (
      this.tx
        .connection()
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifact_refs
           WHERE producer_task_id = ?
           ORDER BY created_at ASC, artifact_id ASC`,
        )
        .all(taskId) as unknown as ArtifactRow[]
    ).map(toRef);
  }

  /** Every artifact of one workspace (E12-scoped), oldest first. */
  listArtifactsByWorkspace(workspaceId: string): ArtifactRef[] {
    return (
      this.tx
        .connection()
        .prepare(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifact_refs
           WHERE workspace_id = ?
           ORDER BY created_at ASC, artifact_id ASC`,
        )
        .all(workspaceId) as unknown as ArtifactRow[]
    ).map(toRef);
  }
}
