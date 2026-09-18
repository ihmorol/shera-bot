/**
 * ArtifactRef (S02 #8): compact references to artifacts, never copied content
 * (D6, D15). URIs are workspace-scheme URIs, not filesystem paths (D23 rule 2).
 */
import { z } from "zod";

import { Id, IsoDateTime, ResourceUri, Sha256Hex, WorkspaceId } from "./primitives.ts";

export const ArtifactRef = z.strictObject({
  artifact_id: Id,
  workspace_id: WorkspaceId,
  /** The task run that produced the artifact. */
  producer_task_id: Id,
  /** workspace:// (shared) or agent://<agent_id>/ (private) location. */
  uri: ResourceUri,
  size_bytes: z.number().int().min(0),
  content_hash: Sha256Hex,
  media_type: z.string().min(1).max(128),
  created_at: IsoDateTime,
});
export type ArtifactRef = z.infer<typeof ArtifactRef>;
