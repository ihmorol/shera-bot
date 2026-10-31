/**
 * S17 chunk 3 — the workspace panel API (PRD §4.3, D6, D39, G6, E12, AC16).
 *
 * Typed routes exposing the chunk-1/2 storage surfaces to the authenticated
 * local API: the workspace_nodes file tree (shared workspace:// scope plus
 * every Agent's private agent://<agent_id>/ folder), the task-scoped write
 * leases, and the artifact_refs. The routes VALIDATE and DELEGATE (G2) —
 * every rule lives in the repositories: the URI parser owns path safety, the
 * storage layer owns D39 scope denials and the G6 delete refusal, and the
 * lease gate owns D6 write arbitration. Thrown typed errors answer through
 * the shared typed-error middleware (D23 rule 4).
 *
 * ACTOR ATTRIBUTION (the transport's established convention): the loopback
 * local API has no per-request user identity object — the S05/S06
 * authenticated transport binds the WORKSPACE (the internal mount checks
 * workspace_id), and the existing command routes carry the actor in the
 * request itself (D4 envelopes, s13/s15). These routes follow the same
 * convention: reads take actor_type/actor_id in the query, writes take the
 * actor in the body — an actor-less request is a typed 400, never an
 * implicit user (G4). When the authenticated user-context wiring lands, the
 * user id is substituted server-side; nothing here invents auth.
 *
 * BINARY BODIES (prototype note): the transport has no established binary
 * upload/download pattern (express.json only), so file upload and artifact
 * insert take base64 JSON bodies and file/artifact reads answer base64 JSON
 * — byte-exact through the base64 round trip. A streaming/binary surface is
 * a transport upgrade, not a storage change.
 *
 * Lease conflict responses serialize the structured tooltip fields (chunk-2
 * note 4) in internal_details: WRITE_LEASE_CONFLICT carries the holding
 * Agent id + display name + task id; WRITE_LEASE_REQUIRED and
 * LEASE_CONFLICT name the conflicting holder + task (G5: never absorbed).
 *
 * Browser allowlist (E26): these are normal authenticated routes. The
 * browser allowlist lives in packages/contracts (isBrowserRuntimePath) and
 * is OUT of this chunk's edit boundary — until the panel chunk extends it,
 * the workspace routes are reachable on the local API and runtime-internal
 * surfaces, not through the browser proxy mount (noted for chunk 4).
 */
import { z } from "zod";

import type { Express } from "express";

import { WorkspaceId } from "@shera-bot/contracts";

import type {
  WorkspaceFileContent,
  WorkspaceNode,
  WorkspaceStorageActor,
} from "../../adapters/sqlite/workspace-files-repository.ts";
import type { WriteLease } from "../../adapters/sqlite/write-leases-repository.ts";
import type {
  ArtifactRef,
  ArtifactsRepository,
} from "../../adapters/sqlite/artifacts-repository.ts";
import type { WorkspaceFilesRepository } from "../../adapters/sqlite/workspace-files-repository.ts";
import type { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { ArtifactNotFoundError } from "../../adapters/sqlite/artifacts-repository.ts";
import { contractValidationResponse } from "../http/typed-errors.ts";

// S17 — the workspace panel surface (D6, D39, G6, E12, AC16).
export const LIST_WORKSPACE_NODES_PATH = "/v1/workspace/nodes" as const;
export const READ_WORKSPACE_FILE_PATH = "/v1/workspace/files" as const;
export const WRITE_WORKSPACE_FILE_PATH = "/v1/workspace/files" as const;
export const UPLOAD_WORKSPACE_FILE_PATH = "/v1/workspace/files/upload" as const;
export const CREATE_WORKSPACE_DIRECTORY_PATH = "/v1/workspace/directories" as const;
export const DELETE_WORKSPACE_NODE_PATH = "/v1/workspace/delete" as const;
export const LIST_WORKSPACE_LEASES_PATH = "/v1/workspace/leases" as const;
export const ACQUIRE_WORKSPACE_LEASE_PATH = "/v1/workspace/leases" as const;
export const RENEW_WORKSPACE_LEASE_PATH = "/v1/workspace/leases/:lease_id/renew" as const;
export const RELEASE_WORKSPACE_LEASE_PATH = "/v1/workspace/leases/:lease_id" as const;
export const RELEASE_WORKSPACE_LEASES_FOR_TASK_PATH =
  "/v1/workspace/leases/release-for-task" as const;
export const LIST_WORKSPACE_ARTIFACTS_PATH = "/v1/workspace/artifacts" as const;
export const GET_WORKSPACE_ARTIFACT_PATH = "/v1/workspace/artifacts/:artifact_id" as const;
export const CREATE_WORKSPACE_ARTIFACT_PATH = "/v1/workspace/artifacts" as const;

/**
 * The D4 Actor subset the storage layer distinguishes (D39 denials and the
 * G6 delete refusal hang on exactly user-vs-agent). The runtime/admin/system
 * kinds never address the workspace tree directly (the repositories own that
 * rule) — accepting them here would promise a surface that does not exist.
 */
const WorkspaceActor = z.strictObject({
  type: z.enum(["user", "agent"]),
  id: z.string().min(1).max(256),
});

/** Read scoping (E12): workspace + the addressed URI + the reading actor. */
const WorkspaceScopeQuery = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(4096),
  actor_type: z.enum(["user", "agent"]),
  actor_id: z.string().min(1).max(256),
});

/** The gated write (D6): agent writes carry their task; the gate enforces. */
const WorkspaceWriteBody = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(4096),
  actor: WorkspaceActor,
  content: z.string().max(2_000_000),
  mime_type: z.string().min(1).max(255).nullish(),
  task_id: z.string().min(1).max(256).optional(),
});

/** The binary write (prototype base64 body — see the module header). */
const WorkspaceUploadBody = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(4096),
  actor: WorkspaceActor,
  content_base64: z
    .string()
    .max(4_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  mime_type: z.string().min(1).max(255).nullish(),
  task_id: z.string().min(1).max(256).optional(),
});

/** mkdir (structural, ungated — chunk-2 pinned behavior). */
const WorkspaceMkdirBody = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(4096),
  actor: WorkspaceActor,
});

/** User-path delete (G6: the agent refusal lives in the repository). */
const WorkspaceDeleteBody = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(4096),
  actor: WorkspaceActor,
  recursive: z.boolean().optional(),
});

/** Lease acquire (D6): task-scoped, holder user or Agent. */
const LeaseAcquireBody = z.strictObject({
  workspace_id: WorkspaceId,
  path: z.string().min(1).max(4096),
  task_id: z.string().min(1).max(256),
  actor: WorkspaceActor,
  ttl_ms: z.number().int().positive(),
});

/**
 * Lease renew/release: workspace_id rides the body so the browser-proxy
 * mount's workspace binding check (runtimeWorkspaceMatches) holds for these
 * mutations too; the repositories key the lease itself by lease_id + task.
 */
const LeaseRenewBody = z.strictObject({
  workspace_id: WorkspaceId,
  task_id: z.string().min(1).max(256),
  ttl_ms: z.number().int().positive(),
});

const LeaseReleaseBody = z.strictObject({
  workspace_id: WorkspaceId,
  task_id: z.string().min(1).max(256),
});

/**
 * The runtime-internal task-terminal force-release (D6: a lease never
 * outlives its task). The gateway calls this when a task reaches a terminal
 * state; it is deliberately NOT a browser path. Task ids are runtime-minted
 * UUIDs, so the release is unambiguous without a workspace selector.
 */
const ReleaseLeasesForTaskBody = z.strictObject({
  task_id: z.string().min(1).max(256),
});

/** Artifact list scoping: the workspace (E12), optionally one run. */
const ArtifactListQuery = z.strictObject({
  workspace_id: WorkspaceId,
  task_id: z.string().min(1).max(256).optional(),
});

/** Artifact insert: the producer is the authenticated actor + the run. */
const ArtifactCreateBody = z.strictObject({
  workspace_id: WorkspaceId,
  name: z.string().min(1).max(255),
  artifact_type: z.string().min(1).max(128),
  mime_type: z.string().min(1).max(255),
  content_base64: z
    .string()
    .max(8_000_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  task_id: z.string().min(1).max(256),
  actor: WorkspaceActor,
});

export interface WorkspaceApiDeps {
  files: Pick<WorkspaceFilesRepository, "list" | "read" | "write" | "mkdir" | "delete">;
  leases: Pick<
    WriteLeasesRepository,
    "listActiveLeases" | "acquireLease" | "renewLease" | "releaseLease" | "releaseLeasesForTask"
  >;
  artifacts: Pick<
    ArtifactsRepository,
    "insertArtifact" | "getArtifact" | "listArtifactsByRun" | "listArtifactsByWorkspace"
  >;
}

/** The storage actor from a parsed query/body pair (the D4 subset). */
function actorOf(type: "user" | "agent", id: string): { type: "user" | "agent"; id: string } {
  return { type, id };
}

/** The node metadata shape (content NEVER rides a node payload). */
function nodeJson(node: WorkspaceNode): WorkspaceNode {
  return {
    id: node.id,
    workspace_id: node.workspace_id,
    scope: node.scope,
    agent_id: node.agent_id,
    parent_id: node.parent_id,
    name: node.name,
    is_directory: node.is_directory,
    size: node.size,
    mime_type: node.mime_type,
    created_by_type: node.created_by_type,
    created_by_id: node.created_by_id,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}

function fileJson(file: WorkspaceFileContent): WorkspaceNode {
  return nodeJson(file);
}

/** The artifact ref shape (content travels only through the download). */
function artifactJson(artifact: ArtifactRef): ArtifactRef {
  return {
    artifact_id: artifact.artifact_id,
    workspace_id: artifact.workspace_id,
    name: artifact.name,
    artifact_type: artifact.artifact_type,
    size: artifact.size,
    mime_type: artifact.mime_type,
    producer_agent_id: artifact.producer_agent_id,
    producer_task_id: artifact.producer_task_id,
    created_at: artifact.created_at,
  };
}

/**
 * Register the S17 workspace routes on the composed local API. Called by the
 * app factory BEFORE the typed-failure middleware, like every other surface.
 */
export function registerWorkspaceApiRoutes(app: Express, deps: WorkspaceApiDeps): void {
  const scopeQuery = WorkspaceScopeQuery;

  /** GET /v1/workspace/nodes — one directory's children (typed nodes). */
  app.get(LIST_WORKSPACE_NODES_PATH, (req, res) => {
    const query = scopeQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The workspace node list request is not valid: a workspace_id, a path, and an actor are required.",
      );
      res.status(status).json(body);
      return;
    }
    const nodes = deps.files.list(
      query.data.workspace_id,
      query.data.path,
      actorOf(query.data.actor_type, query.data.actor_id),
    );
    res.status(200).json({ nodes: nodes.map(nodeJson) });
  });

  /** GET /v1/workspace/files — one file's bytes (base64) + metadata. */
  app.get(READ_WORKSPACE_FILE_PATH, (req, res) => {
    const query = scopeQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The file read request is not valid: a workspace_id, a path, and an actor are required.",
      );
      res.status(status).json(body);
      return;
    }
    const file = deps.files.read(
      query.data.workspace_id,
      query.data.path,
      actorOf(query.data.actor_type, query.data.actor_id),
    );
    res.status(200).json({
      node: fileJson(file),
      mime_type: file.mime_type,
      size: file.size,
      content_base64: Buffer.from(file.content).toString("base64"),
    });
  });

  /**
   * PUT /v1/workspace/files — create/overwrite one file (text content,
   * UTF-8). The D6 lease gate runs inside the repository write; a refused
   * write mutates nothing and answers the typed conflict.
   */
  app.put(WRITE_WORKSPACE_FILE_PATH, (req, res) => {
    const body = WorkspaceWriteBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The file write request is not valid: a workspace_id, a path, an actor, and content are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const written = deps.files.write(
      body.data.workspace_id,
      body.data.path,
      actorOf(body.data.actor.type, body.data.actor.id),
      new Uint8Array(Buffer.from(body.data.content, "utf8")),
      body.data.mime_type ?? null,
      { ...(body.data.task_id !== undefined ? { task_id: body.data.task_id } : {}) },
    );
    res.status(200).json({ node: fileJson(written) });
  });

  /** POST /v1/workspace/files/upload — the binary write (base64 body). */
  app.post(UPLOAD_WORKSPACE_FILE_PATH, (req, res) => {
    const body = WorkspaceUploadBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The file upload request is not valid: a workspace_id, a path, an actor, and base64 content are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const written = deps.files.write(
      body.data.workspace_id,
      body.data.path,
      actorOf(body.data.actor.type, body.data.actor.id),
      new Uint8Array(Buffer.from(body.data.content_base64, "base64")),
      body.data.mime_type ?? null,
      { ...(body.data.task_id !== undefined ? { task_id: body.data.task_id } : {}) },
    );
    res.status(200).json({ node: fileJson(written) });
  });

  /** POST /v1/workspace/directories — mkdir (idempotent, structural). */
  app.post(CREATE_WORKSPACE_DIRECTORY_PATH, (req, res) => {
    const body = WorkspaceMkdirBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The directory request is not valid: a workspace_id, a path, and an actor are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const node = deps.files.mkdir(
      body.data.workspace_id,
      body.data.path,
      actorOf(body.data.actor.type, body.data.actor.id),
    );
    res.status(200).json({ node: nodeJson(node) });
  });

  /**
   * POST /v1/workspace/delete — the USER-path delete (G6/D6: an Agent actor
   * is refused by the repository in every scope; the UI's user confirmation
   * is a web concern on top of this typed delete). recursive deletes the
   * whole subtree of a non-empty directory.
   */
  app.post(DELETE_WORKSPACE_NODE_PATH, (req, res) => {
    const body = WorkspaceDeleteBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The delete request is not valid: a workspace_id, a path, and an actor are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    deps.files.delete(
      body.data.workspace_id,
      body.data.path,
      actorOf(body.data.actor.type, body.data.actor.id),
      { ...(body.data.recursive !== undefined ? { recursive: body.data.recursive } : {}) },
    );
    res.status(200).json({ deleted: true });
  });

  /** GET /v1/workspace/leases — the workspace's ACTIVE leases (D6). */
  app.get(LIST_WORKSPACE_LEASES_PATH, (req, res) => {
    const query = z.strictObject({ workspace_id: WorkspaceId }).safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The lease list request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    const leases: WriteLease[] = deps.leases.listActiveLeases(query.data.workspace_id);
    res.status(200).json({ leases });
  });

  /** POST /v1/workspace/leases — acquire one task-scoped lease (D6). */
  app.post(ACQUIRE_WORKSPACE_LEASE_PATH, (req, res) => {
    const body = LeaseAcquireBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The lease acquire request is not valid: a workspace_id, a path, a task_id, an actor, and a positive ttl_ms are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const lease = deps.leases.acquireLease(
      body.data.workspace_id,
      body.data.path,
      body.data.task_id,
      actorOf(body.data.actor.type, body.data.actor.id),
      body.data.ttl_ms,
    );
    res.status(201).json({ lease });
  });

  /** POST /v1/workspace/leases/:lease_id/renew — holder-task-only (D6). */
  app.post(RENEW_WORKSPACE_LEASE_PATH, (req, res) => {
    const leaseId = z.string().min(1).max(256).safeParse(req.params.lease_id);
    const body = LeaseRenewBody.safeParse(req.body);
    if (!leaseId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The lease renew request is not valid: a task_id, a positive ttl_ms, and a workspace_id are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const lease = deps.leases.renewLease(leaseId.data, body.data.task_id, body.data.ttl_ms);
    res.status(200).json({ lease });
  });

  /** DELETE /v1/workspace/leases/:lease_id — holder-task-only release (D6). */
  app.delete(RELEASE_WORKSPACE_LEASE_PATH, (req, res) => {
    const leaseId = z.string().min(1).max(256).safeParse(req.params.lease_id);
    const body = LeaseReleaseBody.safeParse(req.body);
    if (!leaseId.success || !body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The lease release request is not valid: a task_id and a workspace_id are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    deps.leases.releaseLease(leaseId.data, body.data.task_id);
    res.status(200).json({ released: true });
  });

  /**
   * POST /v1/workspace/leases/release-for-task — the RUNTIME-INTERNAL
   * task-terminal force-release (D6). This is the seam the gateway calls
   * when a task reaches a terminal state (completion, cancellation, failure,
   * process death); the automatic call inside the task-transition modules is
   * the deferred half of the wiring (the compose layer has no terminal hook
   * that covers all four paths). Not a browser path.
   */
  app.post(RELEASE_WORKSPACE_LEASES_FOR_TASK_PATH, (req, res) => {
    const body = ReleaseLeasesForTaskBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The release-for-task request is not valid: a task_id is required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    res.status(200).json({ released: deps.leases.releaseLeasesForTask(body.data.task_id) });
  });

  /** GET /v1/workspace/artifacts — by workspace (E12), or by run. */
  app.get(LIST_WORKSPACE_ARTIFACTS_PATH, (req, res) => {
    const query = ArtifactListQuery.safeParse(req.query);
    if (!query.success) {
      const { status, body } = contractValidationResponse(
        "The artifact list request is not valid: a workspace_id is required; task_id narrows to one run.",
      );
      res.status(status).json(body);
      return;
    }
    const artifacts: ArtifactRef[] = query.data.task_id
      ? deps.artifacts.listArtifactsByRun(query.data.task_id)
      : deps.artifacts.listArtifactsByWorkspace(query.data.workspace_id);
    res.status(200).json({ artifacts: artifacts.map(artifactJson) });
  });

  /** GET /v1/workspace/artifacts/:artifact_id — the byte-exact download. */
  app.get(GET_WORKSPACE_ARTIFACT_PATH, (req, res) => {
    const artifactId = z.string().min(1).max(256).safeParse(req.params.artifact_id);
    const query = z.strictObject({ workspace_id: WorkspaceId }).safeParse(req.query);
    if (!artifactId.success || !query.success) {
      const { status, body } = contractValidationResponse(
        "The artifact download request is not valid: a workspace_id is required.",
      );
      res.status(status).json(body);
      return;
    }
    const artifact = deps.artifacts.getArtifact(query.data.workspace_id, artifactId.data);
    if (artifact === null) {
      throw new ArtifactNotFoundError(query.data.workspace_id, artifactId.data);
    }
    res.status(200).json({
      artifact: artifactJson(artifact),
      mime_type: artifact.mime_type,
      size: artifact.size,
      content_base64: Buffer.from(artifact.content).toString("base64"),
    });
  });

  /**
   * POST /v1/workspace/artifacts — insert with provenance: the producing
   * Agent is the acting actor (null for the user/runtime), the producing run
   * is the task_id (NOT NULL — the run is the lifecycle boundary, AC16).
   * Provenance is immutable after insert; the id is runtime-minted.
   */
  app.post(CREATE_WORKSPACE_ARTIFACT_PATH, (req, res) => {
    const body = ArtifactCreateBody.safeParse(req.body);
    if (!body.success) {
      const { status, body: errorBody } = contractValidationResponse(
        "The artifact request is not valid: a workspace_id, a name, an artifact_type, a mime_type, base64 content, a task_id, and an actor are required.",
      );
      res.status(status).json(errorBody);
      return;
    }
    const inserted = deps.artifacts.insertArtifact({
      workspace_id: body.data.workspace_id,
      name: body.data.name,
      artifact_type: body.data.artifact_type,
      mime_type: body.data.mime_type,
      content: new Uint8Array(Buffer.from(body.data.content_base64, "base64")),
      producer_agent_id: body.data.actor.type === "agent" ? body.data.actor.id : null,
      producer_task_id: body.data.task_id,
    });
    res.status(201).json({ artifact: artifactJson(inserted) });
  });
}
