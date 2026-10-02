/**
 * Workspace pack pinning (S10; D19/D28/D29): load the workspace's pinned pack
 * through the agent-pack-sdk, verify it against THIS runtime's version, and
 * record (or upgrade) the workspace's pin. The pin is the only mutation path
 * for the workspace's pack identity; task runs snapshot their creation-time
 * configuration into the task.created journal payload (D29), so a pack
 * upgrade affects NEW tasks only — existing tasks read their snapshots back
 * verbatim from the journal (D19).
 */
import { join } from "node:path";

import {
  BuiltInPackLoader,
  checkCompatibility,
  type PackManifest,
  type PackRecord,
} from "@shera-bot/agent-pack-sdk";

import { WorkspacesRepository, type WorkspacePackPin } from "../../adapters/sqlite/workspaces-repository.ts";
import { RUNTIME_VERSION } from "../../version.ts";

export interface LoadWorkspacePackOptions {
  /** Directory containing `student/v1/...` style pack trees. */
  packsRoot: string;
  packId: string;
  packVersion?: string;
  workspaceId: string;
  workspaces: WorkspacesRepository;
  /** Injected clock for the pin's installed_at stamp (tests use a fake). */
  now?: string;
}

export interface WorkspacePack {
  manifest: PackManifest;
  manifest_hash: string;
  /** The workspace's pin AFTER this load (first install or upgrade). */
  pin: WorkspacePackPin;
}

/**
 * Resolve the pack, enforce runtime compatibility (typed failure before any
 * task can use it — G4), and pin it on the workspace. Loading is idempotent
 * for an identical pin; a different version or hash on the same pack id is an
 * UPGRADE: the pin moves forward, existing task snapshots do not (D19).
 */
export function loadWorkspacePack(options: LoadWorkspacePackOptions): WorkspacePack {
  const loader = new BuiltInPackLoader({ packsRoot: options.packsRoot });
  const record: PackRecord = loader.resolve(options.packId, options.packVersion);
  checkCompatibility(record.manifest, RUNTIME_VERSION);

  const pin: WorkspacePackPin = {
    agent_pack_id: record.manifest.pack_id,
    agent_pack_version: record.manifest.version,
    manifest_hash: record.manifest_hash,
    installed_at: options.now ?? new Date().toISOString(),
  };
  options.workspaces.ensureWorkspace(options.workspaceId);
  options.workspaces.pinPack(options.workspaceId, pin);
  return { manifest: record.manifest, manifest_hash: record.manifest_hash, pin };
}

/** The default packs root: the repository's own agent-packs tree. */
export function defaultPacksRoot(fromDir: string): string {
  return join(fromDir, "../../../agent-packs");
}
