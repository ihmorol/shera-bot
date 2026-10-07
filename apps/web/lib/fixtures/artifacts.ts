import { ArtifactRef } from "@shera-bot/contracts";

import { fixtureHash } from "./fixture-hash";

/**
 * MOCK DATA — ArtifactRef fixtures (§5 artifact card; §9 "SUCCEEDED with
 * artifacts"). Typed with the real `ArtifactRef` contract. Download/open
 * actions stay disabled in the UI until the runtime serves files.
 */
const sha = fixtureHash;

export const FIXTURE_ARTIFACTS = [
  ArtifactRef.parse({
    artifact_id: "artifact_sources_digest",
    workspace_id: "workspace_demo",
    producer_task_id: "task_run_res_digest",
    uri: "workspace://research/sources-digest.md",
    size_bytes: 9216,
    content_hash: sha("artifact_sources_digest"),
    media_type: "text/markdown",
    created_at: "2026-09-20T09:45:00Z",
  }),
  ArtifactRef.parse({
    artifact_id: "artifact_bibliography_draft",
    workspace_id: "workspace_demo",
    producer_task_id: "task_run_rp_bibliography",
    uri: "workspace://research-paper/bibliography-draft.md",
    size_bytes: 18432,
    content_hash: sha("artifact_bibliography_draft"),
    media_type: "text/markdown",
    created_at: "2026-09-18T09:40:00Z",
  }),
];

export function artifactsForTask(taskId: string) {
  return FIXTURE_ARTIFACTS.filter((artifact) => artifact.producer_task_id === taskId);
}
