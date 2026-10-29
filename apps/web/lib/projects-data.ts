"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Actor } from "@shera-bot/contracts";

import {
  fetchGitLinkage,
  fetchProjectDetail,
  fetchProjects,
  runMergeRequestValidation,
  submitMergeDecision,
  type GitRunLinkage,
  type MergeDecisionChoice,
  type MergeRequestView,
  type ProjectDetail,
  type ProjectView,
} from "@/lib/projects-api";
import { RuntimeApiError } from "@/lib/runtime-client";

/**
 * S19 chunk 2 — the projects data hooks (lib/approvals-data.ts idiom): the
 * workspace's project list, per-project detail reads (worktrees, merge
 * requests, credential metadata), the validation run, and the three PRD §10
 * merge decisions — through TanStack Query over the same-origin runtime
 * proxy. Reads poll on the app's presence cadence; failures ARE states: no
 * retry behind the user's back, no fixture fallback.
 *
 * The decision mutation relays into the S20 approval machinery (the runtime
 * owns every rule — G6): the answer's merge request is the honest
 * post-decision row, and the project detail is invalidated so every surface
 * (including the git-aware run cards) re-reads it.
 */

export function safeProjectsMessage(error: unknown, fallback: string): string {
  if (error instanceof RuntimeApiError) {
    return error.sheraError.safe_message;
  }
  return fallback;
}

/** The workspace's connected projects (E12 workspace-scoped reads). */
export function useProjects(workspaceId: string): {
  projects: ProjectView[];
  loading: boolean;
  failed: boolean;
  safeErrorMessage?: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["projects", workspaceId],
    queryFn: () => fetchProjects(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return {
    projects: query.data ?? [],
    loading: query.isPending,
    failed: query.isError,
    safeErrorMessage: query.isError
      ? safeProjectsMessage(query.error, "The projects list could not be loaded.")
      : undefined,
    refetch: () => void query.refetch(),
  };
}

/** One project's detail: worktrees (the G5 queue is visible), merge requests, credential metadata. */
export function useProjectDetail(
  workspaceId: string,
  projectId: string | null,
): {
  detail: ProjectDetail | null;
  loading: boolean;
  failed: boolean;
  safeErrorMessage?: string | undefined;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: ["project-detail", workspaceId, projectId],
    queryFn: () => fetchProjectDetail(workspaceId, projectId as string),
    enabled: projectId !== null,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  if (projectId === null) {
    return {
      detail: null,
      loading: false,
      failed: false,
      refetch: () => undefined,
    };
  }
  return {
    detail: query.data ?? null,
    loading: query.isPending,
    failed: query.isError,
    safeErrorMessage: query.isError
      ? safeProjectsMessage(query.error, "The project could not be loaded.")
      : undefined,
    refetch: () => void query.refetch(),
  };
}

/**
 * The runtime's validation run for one merge request (G2). The answer is the
 * post-run row; the project detail invalidation refreshes every reader.
 */
export function useRunMergeRequestValidation(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mergeRequestId: string) =>
      runMergeRequestValidation(workspaceId, projectId, mergeRequestId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-detail", workspaceId, projectId] });
    },
  });
}

/** The git-linkage join for the git-aware run cards (S19 chunk 2). */
export function useGitLinkage(workspaceId: string): {
  linkage: Record<string, GitRunLinkage>;
  loading: boolean;
  failed: boolean;
} {
  const query = useQuery({
    queryKey: ["git-linkage", workspaceId],
    queryFn: () => fetchGitLinkage(workspaceId),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });
  return {
    linkage: query.data ?? {},
    loading: query.isPending,
    failed: query.isError,
  };
}

/**
 * One PRD §10 decision — approve / reject / request-changes — relayed into
 * the S20 approval machinery. The mutation sends the session's user identity
 * (agents never decide: G6); the API refuses any other actor untouched.
 */
export function useMergeDecision(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      mergeRequestId: string;
      choice: MergeDecisionChoice;
      decidedBy: Actor;
    }): Promise<MergeRequestView> =>
      submitMergeDecision(
        workspaceId,
        projectId,
        input.mergeRequestId,
        input.choice,
        input.decidedBy,
      ).then((result) => result.merge_request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project-detail", workspaceId, projectId] });
      void queryClient.invalidateQueries({ queryKey: ["projects", workspaceId] });
    },
  });
}
