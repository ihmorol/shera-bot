/**
 * Watcher signatures (S28 chunk 5; E5, D6, G3) — the change signature each
 * event-driven watcher compares per tick. The signature IS the dedup
 * authority: the same observed state never fires twice (restart-safe: the
 * signature persists in the trigger row; flood-safe: one tick sees the net
 * signature once, never the intermediate writes).
 *
 * Bounded everywhere: a workspace-subtree scan walks at most MAX_NODES rows
 * metadata (no content bytes), an agent-folder scan walks at most MAX_NODES
 * entries' stat data, and a git signature is one rev-parse. Signatures hash
 * metadata only — never file content and never credential material (G3).
 */
import { createHash } from "node:crypto";

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { agentFolderDir } from "../../adapters/fs/agent-folder-store.ts";
import { gitRevParseHead } from "../../adapters/process/git-rev-parse.ts";
import type { ProjectRow } from "../../adapters/sqlite/projects-repository.ts";
import type {
  WorkspaceFilesRepository,
  WorkspaceNode,
  WorkspaceStorageActor,
} from "../../adapters/sqlite/workspace-files-repository.ts";

const MAX_NODES = 500;

function hashOf(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

/**
 * The workspace/agent ROW-scope signature: a bounded walk of the subtree's
 * metadata (id, updated_at, size, kind) through the SAME repository surface
 * every reader uses (the D6 scope guard included — a runtime actor may read
 * both scopes; an agent-scope watcher URI was already bound to its own
 * agent at create time). A missing subtree signs as "absent".
 */
export function workspaceSubtreeSignature(
  files: Pick<WorkspaceFilesRepository, "resolve" | "list">,
  workspaceId: string,
  uri: string,
): string {
  const actor: WorkspaceStorageActor = { type: "runtime", id: "scheduler" };
  const parts: string[] = [];
  const walk = (dirUri: string, depth: number): void => {
    if (parts.length >= MAX_NODES || depth > 12) return;
    let children: WorkspaceNode[] = [];
    try {
      children = files.list(workspaceId, dirUri, actor);
    } catch {
      return;
    }
    for (const child of children) {
      if (parts.length >= MAX_NODES) return;
      parts.push(child.id, child.updated_at, String(child.size), child.is_directory ? "d" : "f");
      if (child.is_directory) walk(`${dirUri}/${child.name}`, depth + 1);
    }
  };
  try {
    const root = files.resolve(workspaceId, uri, actor);
    if (root === null) return "absent";
    if (root.is_directory !== 1) {
      return hashOf([root.id, root.updated_at, String(root.size)]);
    }
    walk(uri, 0);
    return hashOf(parts);
  } catch {
    return "absent";
  }
}

/**
 * The agent-folder FS signature: a bounded stat walk of the folder the
 * FileAgentFolderStore lays out (the SAME tree — one layout rule). Missing
 * folder signs as "absent".
 */
export function agentFolderSignature(
  agentFilesRoot: string,
  workspaceId: string,
  agentId: string,
): string {
  const folder = agentFolderDir(agentFilesRoot, workspaceId, agentId);
  const parts: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (parts.length >= MAX_NODES || depth > 12) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (parts.length >= MAX_NODES) return;
      try {
        const info = statSync(join(dir, entry));
        parts.push(entry, String(info.mtimeMs), String(info.size), info.isDirectory() ? "d" : "f");
        if (info.isDirectory()) walk(join(dir, entry), depth + 1);
      } catch {
        // A vanished entry contributes nothing; the next tick settles it.
      }
    }
  };
  walk(folder, 0);
  return parts.length === 0 ? "absent" : hashOf(parts);
}

/**
 * The git signature: the watched branch's HEAD sha (one `git rev-parse`).
 * A missing branch or repo signs as "absent". The sha carries no credential
 * material (G3). Synchronous by design: the runtime tick stays
 * deterministic (the same binary S19's simple-git shells out to; one local,
 * bounded call — recorded in E37).
 */
export function gitBranchSignature(
  project: Pick<ProjectRow, "repo_path">,
  branch: string,
): string {
  return gitRevParseHead(project.repo_path, branch) ?? "absent";
}
