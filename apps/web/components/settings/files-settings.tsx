"use client";

import { FolderGit2, Lock } from "lucide-react";
import Link from "next/link";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import { useContainerResolution } from "@/lib/container-connection";
import { useProjects } from "@/lib/projects-data";
import { routes } from "@/lib/routes";
import type { ProjectView } from "@/lib/projects-api";

/**
 * The S9 "Files & projects" settings surface (S30; PRD §10, UI_DESIGN §S9):
 * the workspace's connected projects — the runtime's own rows — each with
 * its default branch, access mode, and the deep link into the git surface's
 * merge-review queue. Credentials stay masked metadata in the git surface
 * (D22: never re-displayed); this surface renders no credential material at
 * all (G3). The empty state carries the E43 pattern: what will appear, plus
 * a single primary CTA.
 */

export interface FilesSettingsViewProps {
  projects: readonly ProjectView[];
  surfaceState: "loading" | "ready" | "error";
  safeErrorMessage?: string | undefined;
}

export function FilesSettingsView({ projects, surfaceState, safeErrorMessage }: FilesSettingsViewProps) {
  if (surfaceState === "loading") {
    return (
      <div aria-busy="true" aria-hidden="true" className="space-y-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="h-16 animate-pulse rounded-xl bg-surface-elevated" />
        ))}
      </div>
    );
  }
  if (surfaceState === "error") {
    return (
      <ErrorState safeMessage={safeErrorMessage ?? "The projects list could not be loaded."} />
    );
  }
  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-xl border border-line bg-surface p-8 text-center">
        <FolderGit2 className="size-8 text-muted" aria-hidden="true" />
        <p className="max-w-xs text-sm text-text">
          Connected projects will appear here with their branches and merge-review queues — each
          added from the workspace panel when a coding task needs one.
        </p>
        <Button asChild data-testid="files-empty-cta">
          <Link href={routes.app()}>Open a conversation</Link>
        </Button>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {projects.map((project) => (
        <li key={project.project_id} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-sm font-medium text-text">
                <FolderGit2 className="size-4 shrink-0 text-sky" aria-hidden="true" />
                {project.name}
              </p>
              <p className="mt-0.5 truncate font-mono text-xs text-muted">
                {project.default_branch} · {project.source_kind}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {project.access_mode === "restricted" ? (
                <>
                  <Lock className="size-3" aria-hidden="true" />
                  restricted
                </>
              ) : (
                "shared"
              )}
            </span>
          </div>
          <p className="mt-2 text-xs">
            <Link
              href={routes.settings("git")}
              className="text-sky underline-offset-4 hover:underline"
            >
              Worktrees and merge reviews
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function FilesSettingsSurface() {
  const resolution = useContainerResolution();
  const workspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;
  const projects = useProjects(workspaceId ?? "");
  if (!workspaceId) {
    return (
      <div
        role="status"
        className="mx-auto my-8 max-w-md rounded-xl border border-line bg-surface p-6 text-center text-sm text-text"
      >
        Projects live in your workspace container. Start your workspace and come back.
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl">
      <FilesSettingsView
        projects={projects.projects}
        surfaceState={projects.loading ? "loading" : projects.failed ? "error" : "ready"}
        safeErrorMessage={projects.safeErrorMessage}
      />
    </div>
  );
}
