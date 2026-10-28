"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { RuntimeApiError } from "@/lib/runtime-client";
import {
  WorkspaceLeaseConflictError,
  createWorkspaceDirectory,
  deleteWorkspaceNode,
  fetchWorkspaceNodes,
  uploadWorkspaceFile,
  type WorkspaceNode,
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
