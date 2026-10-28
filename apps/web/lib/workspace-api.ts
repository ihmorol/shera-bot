import { z } from "zod";

import type { SheraError } from "@shera-bot/contracts";

import { AGENT_SETTINGS_USER_ACTOR } from "@/lib/agent-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import { UNREACHABLE_ERROR, typedErrorFromPayload } from "@/lib/typed-error";

/**
 * Typed browser client for the S17 workspace panel (chunk 4), reached through
 * the same-origin runtime proxy exactly like the conversation/agent/operation
 * clients (lib/runtime-client.ts, lib/agent-api.ts, lib/operation-api.ts — the
 * same transport idiom and typed failures). The routes are the chunk-3
 * surface on the container's local API:
 *
 *   GET   /v1/workspace/nodes          one directory's children (typed nodes)
 *   GET   /v1/workspace/files          one file's bytes (base64 prototype body)
 *   PUT   /v1/workspace/files          gated text write (D6)
 *   POST  /v1/workspace/files/upload   gated binary write (base64 body)
 *   POST  /v1/workspace/directories    mkdir (structural, ungated)
 *   POST  /v1/workspace/delete         user-only delete (G6: the UI confirms)
 *   GET   /v1/workspace/leases         the workspace's active write leases (D6)
 *
 * The actor is the S01 fixture user, the established D4 convention for the
 * request-carried actor (AGENT_SETTINGS_USER_ACTOR — no invented auth, G4).
 * Private agent:// denials answer as typed 403s from the storage layer (D39).
 *
 * G5: a WRITE_LEASE_CONFLICT 409 carries the structured tooltip fields
 * (holding Agent id + display name + task id + path) in internal_details —
 * they are parsed HERE and rendered verbatim by the Files tab. The conflict
 * data is the API's, never invented client-side.
 */

/** One workspace_nodes row (the route's nodeJson shape, content never rides it). */
export const WorkspaceNodeSchema = z.strictObject({
  id: z.string().min(1),
  workspace_id: z.string().min(1),
  scope: z.enum(["workspace", "agent"]),
  agent_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  name: z.string().min(1),
  is_directory: z.boolean(),
  size: z.number().int().min(0),
  mime_type: z.string().nullable(),
  created_by_type: z.string().min(1),
  created_by_id: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type WorkspaceNode = z.infer<typeof WorkspaceNodeSchema>;

const WorkspaceNodesResponse = z.strictObject({ nodes: z.array(WorkspaceNodeSchema) });

const WorkspaceFileResponse = z.strictObject({
  node: WorkspaceNodeSchema,
  mime_type: z.string().nullable(),
  size: z.number().int().min(0),
  content_base64: z.string().min(1),
});

/** One active write lease (D6) — the chunk-5 conflict tooltip's data source. */
export const WorkspaceLeaseSchema = z.strictObject({
  lease_id: z.string().min(1),
  workspace_id: z.string().min(1),
  path: z.string().min(1),
  task_id: z.string().min(1),
  holder: z.strictObject({ type: z.enum(["user", "agent"]), id: z.string().min(1) }),
  expires_at: z.string().min(1),
});
export type WorkspaceLease = z.infer<typeof WorkspaceLeaseSchema>;

const WorkspaceLeasesResponse = z.strictObject({ leases: z.array(WorkspaceLeaseSchema) });

/**
 * The D6 conflict, parsed from the typed failure's internal_details — exactly
 * what the API serialized, no client-side reconstruction.
 */
const WriteLeaseConflictDetails = z.strictObject({
  holding_agent_id: z.string().min(1),
  holding_agent_name: z.string().min(1),
  task_id: z.string().min(1),
  path: z.string().min(1),
});

export class WorkspaceLeaseConflictError extends RuntimeApiError {
  readonly holding_agent_id: string;
  readonly holding_agent_name: string;
  readonly task_id: string;
  readonly path: string;

  constructor(sheraError: SheraError, conflict: z.infer<typeof WriteLeaseConflictDetails>) {
    super(sheraError);
    this.name = "WorkspaceLeaseConflictError";
    this.holding_agent_id = conflict.holding_agent_id;
    this.holding_agent_name = conflict.holding_agent_name;
    this.task_id = conflict.task_id;
    this.path = conflict.path;
  }

  /** The G5 tooltip line — the API's holder + task, verbatim. */
  get tooltip(): string {
    return `${this.holding_agent_name} is editing this file · task ${this.task_id}`;
  }

  /** The §2.4-safe message (the API's safe_message, never internals). */
  get safeMessage(): string {
    return this.sheraError.safe_message;
  }
}

// ---------------------------------------------------------------------------
// Transport — the shared runtime idiom (lib/operation-api.ts)
// ---------------------------------------------------------------------------

async function fetchRuntimeResponse(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  try {
    return await fetch(path, { ...init, headers });
  } catch {
    throw new RuntimeApiError(UNREACHABLE_ERROR);
  }
}

/**
 * G5: the shared typed parser nulls internal_details by design (internals
 * never render), but the 409 conflict tooltip fields are PRODUCT data the
 * API deliberately serialized — parse them from the RAW payload before
 * falling back to the generic typed error.
 */
function errorFromPayload(payload: unknown): RuntimeApiError {
  const typed = typedErrorFromPayload(payload);
  if (
    payload !== null &&
    typeof payload === "object" &&
    typed.sheraError.code === "WRITE_LEASE_CONFLICT"
  ) {
    const raw = payload as Record<string, unknown>;
    const internal = raw["internal_details"];
    if (internal !== null && typeof internal === "object") {
      const parsed = WriteLeaseConflictDetails.safeParse(
        (internal as Record<string, unknown>)["write_lease_conflict"],
      );
      if (parsed.success) {
        return new WorkspaceLeaseConflictError(typed.sheraError, parsed.data);
      }
    }
  }
  return typed;
}

async function requestWorkspace<T>(
  path: string,
  parse: (payload: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchRuntimeResponse(path, init);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw errorFromPayload(payload);
  }
  try {
    return parse(payload);
  } catch {
    // A 2xx body that fails its contract is a server drift, not user error.
    throw new RuntimeApiError(typedErrorFromPayload(null).sheraError);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function fetchWorkspaceNodes(workspaceId: string, path: string): Promise<WorkspaceNode[]> {
  const query = new URLSearchParams({
    workspace_id: workspaceId,
    path,
    actor_type: AGENT_SETTINGS_USER_ACTOR.type,
    actor_id: AGENT_SETTINGS_USER_ACTOR.id,
  });
  return requestWorkspace(
    `/api/runtime/v1/workspace/nodes?${query.toString()}`,
    (payload) => WorkspaceNodesResponse.parse(payload).nodes,
  );
}

export interface WorkspaceFileContent {
  node: WorkspaceNode;
  mime_type: string | null;
  size: number;
  bytes: Uint8Array;
}

export function readWorkspaceFile(
  workspaceId: string,
  path: string,
): Promise<WorkspaceFileContent> {
  const query = new URLSearchParams({
    workspace_id: workspaceId,
    path,
    actor_type: AGENT_SETTINGS_USER_ACTOR.type,
    actor_id: AGENT_SETTINGS_USER_ACTOR.id,
  });
  return requestWorkspace(`/api/runtime/v1/workspace/files?${query.toString()}`, (payload) => {
    const parsed = WorkspaceFileResponse.parse(payload);
    return {
      node: parsed.node,
      mime_type: parsed.mime_type,
      size: parsed.size,
      bytes: base64ToBytes(parsed.content_base64),
    };
  });
}

export function listWorkspaceLeases(workspaceId: string): Promise<WorkspaceLease[]> {
  const query = new URLSearchParams({ workspace_id: workspaceId });
  return requestWorkspace(
    `/api/runtime/v1/workspace/leases?${query.toString()}`,
    (payload) => WorkspaceLeasesResponse.parse(payload).leases,
  );
}

// ---------------------------------------------------------------------------
// Writes (the D4 user actor rides every body — request-carried convention)
// ---------------------------------------------------------------------------

export function writeWorkspaceFile(
  workspaceId: string,
  path: string,
  content: string,
  mimeType?: string,
): Promise<WorkspaceNode> {
  return requestWorkspace(
    "/api/runtime/v1/workspace/files",
    (payload) => z.strictObject({ node: WorkspaceNodeSchema }).parse(payload).node,
    {
      method: "PUT",
      body: JSON.stringify({
        workspace_id: workspaceId,
        path,
        actor: AGENT_SETTINGS_USER_ACTOR,
        content,
        ...(mimeType !== undefined ? { mime_type: mimeType } : {}),
      }),
    },
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function uploadWorkspaceFile(
  workspaceId: string,
  path: string,
  bytes: Uint8Array,
  mimeType?: string,
): Promise<WorkspaceNode> {
  return requestWorkspace(
    "/api/runtime/v1/workspace/files/upload",
    (payload) => z.strictObject({ node: WorkspaceNodeSchema }).parse(payload).node,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        path,
        actor: AGENT_SETTINGS_USER_ACTOR,
        content_base64: bytesToBase64(bytes),
        ...(mimeType !== undefined ? { mime_type: mimeType } : {}),
      }),
    },
  );
}

export function createWorkspaceDirectory(
  workspaceId: string,
  path: string,
): Promise<WorkspaceNode> {
  return requestWorkspace(
    "/api/runtime/v1/workspace/directories",
    (payload) => z.strictObject({ node: WorkspaceNodeSchema }).parse(payload).node,
    {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        path,
        actor: AGENT_SETTINGS_USER_ACTOR,
      }),
    },
  );
}

export function deleteWorkspaceNode(
  workspaceId: string,
  path: string,
  options?: { recursive?: boolean },
): Promise<void> {
  return requestWorkspace("/api/runtime/v1/workspace/delete", () => undefined, {
    method: "POST",
    body: JSON.stringify({
      workspace_id: workspaceId,
      path,
      actor: AGENT_SETTINGS_USER_ACTOR,
      ...(options?.recursive !== undefined ? { recursive: options.recursive } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Pure tree helpers — the workspace:// scope display (the Files tab shows the
// shared scope only this chunk; agent:// listing is chunk 5)
// ---------------------------------------------------------------------------

/** The workspace:// URI for a segment path (root keeps the // marker). */
export function workspaceUriForPath(segments: string[]): string {
  if (segments.length === 0) return "workspace://";
  return `workspace://${segments.map(encodeURIComponent).join("/")}`;
}

/** The display segments of a workspace:// URI (decoded). */
export function workspaceUriSegments(uri: string): string[] {
  if (!uri.startsWith("workspace://")) return [];
  const raw = uri.slice("workspace://".length);
  if (raw === "" || raw === "/") return [];
  return raw.replace(/\/$/, "").split("/").map(decodeURIComponent);
}

/** Child rows for one directory: folders first, then files, each by name. */
export function childrenOf(nodes: WorkspaceNode[]): WorkspaceNode[] {
  return [...nodes].sort((a, b) => {
    if (a.is_directory !== b.is_directory) return a.is_directory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The §2.1-friendly byte formatter for file rows (folders show —). */
export function formatBytes(size: number): string {
  if (size === 0) return "0 B";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Short absolute-ish date for a node row (the row's updated_at). */
export function formatNodeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
