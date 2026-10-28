"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AGENT_SETTINGS_USER_ACTOR } from "@/lib/agent-api";
import { RuntimeApiError } from "@/lib/runtime-client";
import {
  WorkspaceLeaseConflictError,
  createWorkspaceDirectory,
  deleteWorkspaceNode,
  fetchWorkspaceNodes,
  fetchWorkspaceNodesAs,
  fetchWorkspaceArtifacts,
  isTextMime,
  readWorkspaceFile,
  readWorkspaceFileAs,
  readWorkspaceArtifact,
  uploadWorkspaceFile,
  writeWorkspaceFile,
  type WorkspaceArtifact,
  type WorkspaceArtifactContent,
  type WorkspaceFileContent,
  type WorkspaceNode,
  type WorkspaceReadActor,
} from "@/lib/workspace-api";

/**
 * Real workspace data hooks (S17 chunk 4) — the shared workspace:// tree
 * through TanStack Query, reading the container's local API via the
 * same-origin proxy. The idiom mirrors the Operation hooks
 * (lib/operation-data.ts): failures ARE states — the queries never retry
 * behind the user's back and never fall back to fixtures; a real-data failure
 * renders the §2.4 error state, G4. Every mutation invalidates the directory
 * read it affected, so the rendered tree is the read-after-write truth.
 */

const GENERIC_WORKSPACE_ERROR_MESSAGE = "The workspace files could not be loaded.";

export function safeWorkspaceMessage(
  error: unknown,
  fallback = GENERIC_WORKSPACE_ERROR_MESSAGE,
): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

/**
 * The write-failure copy for the Files tab: a D6 lease conflict renders the
 * API's holder + task line (G5 — never absorbed, never invented); any other
 * failure renders its safe_message.
 */
export function safeWorkspaceWriteMessage(error: unknown): string {
  if (error instanceof WorkspaceLeaseConflictError) {
    return error.tooltip;
  }
  return safeWorkspaceWriteFallback(error);
}

function safeWorkspaceWriteFallback(error: unknown): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return "The change could not be saved. You can try again.";
}

export function useWorkspaceNodes(
  workspaceId: string,
  path: string,
): {
  nodes: WorkspaceNode[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["workspace-nodes", workspaceId, path],
    queryFn: () => fetchWorkspaceNodes(workspaceId, path),
    // A missing directory is a real error (typed 404) — the tree shows it.
    retry: false,
  });
  return {
    nodes: query.data ?? [],
    state: query.isPending ? "loading" : query.isError ? "error" : "ready",
    safeErrorMessage: query.isError ? safeWorkspaceMessage(query.error) : undefined,
    refetch: () => {
      void query.refetch();
    },
  };
}

function useInvalidateNodes(workspaceId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-nodes", workspaceId] });
  };
}

export function useUploadWorkspaceFiles(
  workspaceId: string,
  directoryUri: string,
): {
  uploadFiles: (files: File[]) => Promise<void>;
  uploadPending: boolean;
} {
  const invalidate = useInvalidateNodes(workspaceId);
  const mutation = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await uploadWorkspaceFile(
          workspaceId,
          joinWorkspaceUri(directoryUri, file.name),
          bytes,
          file.type === "" ? undefined : file.type,
        );
      }
    },
    onSuccess: invalidate,
  });
  return {
    uploadFiles: async (files: File[]) => {
      await mutation.mutateAsync(files);
    },
    uploadPending: mutation.isPending,
  };
}

export function useCreateWorkspaceDirectory(
  workspaceId: string,
  directoryUri: string,
): {
  createDirectory: (name: string) => Promise<void>;
  createPending: boolean;
} {
  const invalidate = useInvalidateNodes(workspaceId);
  const mutation = useMutation({
    mutationFn: async (name: string) => {
      await createWorkspaceDirectory(workspaceId, joinWorkspaceUri(directoryUri, name));
    },
    onSuccess: invalidate,
  });
  return {
    createDirectory: async (name: string) => {
      await mutation.mutateAsync(name);
    },
    createPending: mutation.isPending,
  };
}

export function useDeleteWorkspaceNode(workspaceId: string): {
  deleteNode: (target: { uri: string; isDirectory: boolean }) => Promise<void>;
  deletePending: boolean;
} {
  const invalidate = useInvalidateNodes(workspaceId);
  const mutation = useMutation({
    mutationFn: async (target: { uri: string; isDirectory: boolean }) => {
      await deleteWorkspaceNode(workspaceId, target.uri, {
        ...(target.isDirectory ? { recursive: true } : {}),
      });
    },
    onSuccess: invalidate,
  });
  return {
    deleteNode: async (target) => {
      await mutation.mutateAsync(target);
    },
    deletePending: mutation.isPending,
  };
}

/** Join a directory workspace:// URI with one child segment. */
export function joinWorkspaceUri(directoryUri: string, name: string): string {
  const base = directoryUri === "workspace://" ? "workspace://" : `${directoryUri}/`;
  return `${base}${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// Chunk 5 hooks — the Editor tab's read/save seam, the Private files tab's
// agent:// listing (the actor-parameterized read), and the Artifacts list.
// ---------------------------------------------------------------------------

export interface WorkspaceEditorFile {
  state: "idle" | "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
  file: WorkspaceFileContent | null;
  /** The decoded text for the editor (text mimes only; null for binary). */
  content: string | null;
  isText: boolean;
}

/** The Editor tab's file read. A null path idles — nothing open, nothing fetched. */
export function useWorkspaceEditorFile(
  workspaceId: string,
  path: string | null,
): WorkspaceEditorFile {
  const enabled = path !== null;
  const query = useQuery({
    queryKey: ["workspace-editor-file", workspaceId, path],
    queryFn: () => readWorkspaceFile(workspaceId, path as string),
    enabled,
    retry: false,
  });
  const file = query.data ?? null;
  const isText = file === null ? true : isTextMime(file.mime_type);
  return {
    state: !enabled ? "idle" : query.isPending ? "loading" : query.isError ? "error" : "ready",
    safeErrorMessage: query.isError ? safeWorkspaceMessage(query.error) : undefined,
    refetch: () => {
      void query.refetch();
    },
    file,
    // Concurrent reads stay allowed while an Agent holds the lease (D6) —
    // the editor renders the loaded content even after a conflict.
    content: file !== null && isText ? new TextDecoder().decode(file.bytes) : null,
    isText,
  };
}

/** The Editor tab's save: the user's own edit is a user action (D4 actor, D6 gate). */
export function useSaveWorkspaceFile(
  workspaceId: string,
  path: string | null,
): {
  saveFile: (content: string) => Promise<WorkspaceNode>;
  savePending: boolean;
} {
  const invalidate = useInvalidateNodes(workspaceId);
  const mutation = useMutation({
    mutationFn: async (content: string) => {
      if (path === null) throw new Error("No file is open.");
      return writeWorkspaceFile(workspaceId, path, content);
    },
    onSuccess: invalidate,
  });
  return {
    saveFile: (content: string) => mutation.mutateAsync(content),
    savePending: mutation.isPending,
  };
}

/**
 * The Private files tab's listing: the agent://<id>/ scope read AS the owning
 * Agent (D39). Null agent idles — no Agent selected, nothing fetched. The
 * path may sit deeper in the scope after navigation; it defaults to the
 * scope root.
 */
export function useAgentWorkspaceNodes(
  workspaceId: string,
  agentId: string | null,
  path?: string | null,
): {
  nodes: WorkspaceNode[];
  state: "idle" | "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const scopePath = path ?? (agentId !== null ? `agent://${agentId}/` : null);
  const enabled = agentId !== null && scopePath !== null;
  const query = useQuery({
    queryKey: ["workspace-agent-nodes", workspaceId, agentId, scopePath],
    queryFn: () =>
      fetchWorkspaceNodesAs(workspaceId, scopePath as string, {
        type: "agent",
        id: agentId as string,
      }),
    enabled,
    retry: false,
  });
  return {
    nodes: query.data ?? [],
    state: !enabled ? "idle" : query.isPending ? "loading" : query.isError ? "error" : "ready",
    safeErrorMessage: query.isError ? safeWorkspaceMessage(query.error) : undefined,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * The download handoff (bytes → Blob → the browser's save affordance) with a
 * caller-chosen read actor: the user for workspace:// files, the owning Agent
 * for agent:// files. The byte decoding is the workspace client's; only the
 * DOM handoff lives here.
 */
export function useWorkspaceFileDownload(
  workspaceId: string,
  actor: WorkspaceReadActor | null,
): {
  downloadNode: (path: string, node: WorkspaceNode) => Promise<void>;
} {
  const read = actor ?? AGENT_SETTINGS_USER_ACTOR;
  return {
    downloadNode: async (path, node) => {
      const file = await readWorkspaceFileAs(workspaceId, path, read);
      const blob = new Blob([file.bytes as BlobPart], {
        type: file.mime_type ?? "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = node.name;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  };
}

/** The Artifacts tab's E12 list (by workspace; by run when task context exists). */
export function useWorkspaceArtifacts(workspaceId: string): {
  artifacts: WorkspaceArtifact[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["workspace-artifacts", workspaceId],
    queryFn: () => fetchWorkspaceArtifacts(workspaceId),
    retry: false,
  });
  return {
    artifacts: query.data ?? [],
    state: query.isPending ? "loading" : query.isError ? "error" : "ready",
    safeErrorMessage: query.isError ? safeWorkspaceMessage(query.error) : undefined,
    refetch: () => {
      void query.refetch();
    },
  };
}

/**
 * The artifact actions: open previews the REAL bytes (the caller decides the
 * inline-vs-binary rendering); download hands the byte-exact read to the
 * browser's save affordance. Provenance is immutable — these are reads only.
 */
export function useWorkspaceArtifactActions(workspaceId: string): {
  openArtifact: (artifact: WorkspaceArtifact) => Promise<WorkspaceArtifactContent>;
  downloadArtifact: (artifact: WorkspaceArtifact) => Promise<void>;
} {
  return {
    openArtifact: (artifact) => readWorkspaceArtifact(workspaceId, artifact.artifact_id),
    downloadArtifact: async (artifact) => {
      const content = await readWorkspaceArtifact(workspaceId, artifact.artifact_id);
      const blob = new Blob([content.bytes as BlobPart], { type: content.mime_type });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = artifact.name;
      anchor.click();
      URL.revokeObjectURL(url);
    },
  };
}
