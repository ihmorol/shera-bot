"use client";

import {
  Archive,
  ArrowDownToLine,
  Braces,
  ClipboardList,
  FileBox,
  FileText,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { useState, type ReactElement } from "react";

import { ErrorState } from "@/components/shell/states";
import {
  ARTIFACT_PREVIEW_MAX_BYTES,
  formatBytes,
  formatNodeDate,
  isTextMime,
  type WorkspaceArtifact,
} from "@/lib/workspace-api";
import {
  safeWorkspaceMessage,
  useWorkspaceArtifactActions,
  useWorkspaceArtifacts,
} from "@/lib/workspace-data";
import { useAgentRoster } from "@/lib/agent-data";

/**
 * The Artifacts tab (UI_DESIGN §4 S7 + §5 artifact card): a run's durable
 * outputs listed by workspace (E12) — or by producing run when the task
 * context exists — with their real provenance: the producing Agent (resolved
 * through the roster, never invented) and the producing run id. Open previews
 * SMALL text artifacts inline and answer binary artifacts honestly; download
 * fetches the REAL bytes through the artifact read (byte-exact, §4.3). The
 * card count IS the API list's length (E12: countable outputs).
 */

export interface ArtifactPreview {
  artifactId: string;
  kind: "loading" | "text" | "binary" | "error";
  text?: string | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  safeErrorMessage?: string | undefined;
}

export interface ArtifactsTabViewProps {
  workspaceId: string;
  artifacts: WorkspaceArtifact[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry?: (() => void) | undefined;
  /** agent_id → display name from the roster (provenance resolution). */
  agentNames: Record<string, string>;
  preview: ArtifactPreview | null;
  onOpen: (artifact: WorkspaceArtifact) => void;
  onDownload: (artifact: WorkspaceArtifact) => void;
}

/**
 * The §5 card's type icon — one drawn glyph per artifact family, resolved by
 * direct JSX branches (no dynamic component binding during render).
 */
function ArtifactTypeIcon({ type, className }: { type: string; className?: string }): ReactElement {
  const normalized = type.toLowerCase();
  if (normalized.includes("image")) {
    return <ImageIcon className={className} aria-hidden="true" />;
  }
  if (normalized.includes("code") || normalized.includes("script")) {
    return <Braces className={className} aria-hidden="true" />;
  }
  if (normalized.includes("archive") || normalized.includes("zip")) {
    return <Archive className={className} aria-hidden="true" />;
  }
  if (normalized.includes("document") || normalized.includes("text")) {
    return <FileText className={className} aria-hidden="true" />;
  }
  return <FileBox className={className} aria-hidden="true" />;
}

export function ArtifactsTabView(props: ArtifactsTabViewProps): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 pb-2 pt-3">
        <h3 className="min-w-0 truncate font-mono text-xs uppercase tracking-[0.16em] text-muted">
          Artifacts
        </h3>
        <p
          data-testid="artifact-count"
          className="shrink-0 font-mono text-xs text-muted"
          aria-live="polite"
        >
          {props.artifacts.length} {props.artifacts.length === 1 ? "artifact" : "artifacts"}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {props.state === "loading" ? (
          <ArtifactsSkeleton />
        ) : props.state === "error" ? (
          <ErrorState
            safeMessage={props.safeErrorMessage ?? "The artifacts could not be loaded."}
            onRetry={props.onRetry}
          />
        ) : props.artifacts.length === 0 ? (
          <ArtifactsEmptyState />
        ) : (
          <ul className="flex flex-col gap-2">
            {props.artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.artifact_id}
                artifact={artifact}
                agentNames={props.agentNames}
                preview={
                  props.preview !== null && props.preview.artifactId === artifact.artifact_id
                    ? props.preview
                    : null
                }
                onOpen={props.onOpen}
                onDownload={props.onDownload}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ArtifactCard({
  artifact,
  agentNames,
  preview,
  onOpen,
  onDownload,
}: {
  artifact: WorkspaceArtifact;
  agentNames: Record<string, string>;
  preview: ArtifactPreview | null;
  onOpen: (artifact: WorkspaceArtifact) => void;
  onDownload: (artifact: WorkspaceArtifact) => void;
}): ReactElement {
  const producerName =
    artifact.producer_agent_id !== null
      ? (agentNames[artifact.producer_agent_id] ?? artifact.producer_agent_id)
      : null;
  return (
    <li data-testid="artifact-card">
      <div className="rounded-xl border border-line bg-surface-elevated p-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface">
            <ArtifactTypeIcon type={artifact.artifact_type} className="size-4 text-sky" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">{artifact.name}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-muted">
              {producerName ?? "No producing Agent"} · from run {artifact.producer_task_id}
            </p>
            <p className="mt-0.5 font-mono text-xs text-muted">
              {formatBytes(artifact.size)} · {artifact.mime_type} ·{" "}
              {formatNodeDate(artifact.created_at)}
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              aria-label={`Open ${artifact.name}`}
              title={`Open ${artifact.name}`}
              onClick={() => onOpen(artifact)}
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <FileText className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`Download ${artifact.name}`}
              title={`Download ${artifact.name}`}
              onClick={() => onDownload(artifact)}
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        </div>
        {preview !== null ? <ArtifactPreviewPanel preview={preview} name={artifact.name} /> : null}
      </div>
    </li>
  );
}

/** The inline preview: small text renders; binary answers honestly. */
function ArtifactPreviewPanel({
  preview,
  name,
}: {
  preview: ArtifactPreview;
  name: string;
}): ReactElement {
  return (
    <div
      data-testid="artifact-preview"
      className="mt-2.5 rounded-lg border border-line bg-surface p-2.5"
    >
      {preview.kind === "loading" ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Reading {name}…
        </p>
      ) : preview.kind === "error" ? (
        <p role="alert" className="text-xs text-failed">
          {preview.safeErrorMessage ?? "The artifact could not be read."}
        </p>
      ) : preview.kind === "binary" ? (
        <p className="text-xs text-muted">
          This is a binary file ({preview.mimeType ?? "unknown type"},{" "}
          {formatBytes(preview.size ?? 0)}) — no inline preview. Download it to open outside the
          panel.
        </p>
      ) : (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text">
          {preview.text ?? ""}
        </pre>
      )}
    </div>
  );
}

/** §2.4 loading: skeleton cards matching the final layout. */
function ArtifactsSkeleton(): ReactElement {
  return (
    <div aria-busy="true" data-testid="artifacts-skeleton" className="flex flex-col gap-2">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="flex h-[4.5rem] animate-pulse items-center gap-2.5 rounded-xl bg-surface-elevated px-3"
        >
          <div className="size-8 rounded-lg bg-surface" />
          <div className="flex-1">
            <div className="h-2.5 w-1/3 rounded bg-surface" />
            <div className="mt-1.5 h-2 w-1/2 rounded bg-surface" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** §2.4 empty: provenance explained, not a blank box. */
function ArtifactsEmptyState(): ReactElement {
  return (
    <div
      data-testid="artifacts-empty"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
        <ClipboardList className="size-5 text-sky" aria-hidden="true" />
      </div>
      <p className="max-w-[40ch] text-sm text-muted">
        No artifacts yet — outputs Agents produce in this workspace land here with the run that made
        them.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stateful Artifacts tab (list + open/download actions + roster names)
// ---------------------------------------------------------------------------

export function ArtifactsTab({ workspaceId }: { workspaceId: string }): ReactElement {
  const listing = useWorkspaceArtifacts(workspaceId);
  const roster = useAgentRoster(workspaceId);
  const { openArtifact, downloadArtifact } = useWorkspaceArtifactActions(workspaceId);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);

  const agentNames: Record<string, string> = {};
  for (const agent of roster.agents) {
    agentNames[agent.agent_id] = agent.display_name;
  }

  return (
    <ArtifactsTabView
      workspaceId={workspaceId}
      artifacts={listing.artifacts}
      state={listing.state}
      safeErrorMessage={listing.safeErrorMessage}
      onRetry={listing.refetch}
      agentNames={agentNames}
      preview={preview}
      onOpen={(artifact) => {
        // Binary artifacts answer honestly without a byte fetch; small text
        // artifacts preview inline from the real bytes.
        if (!isTextMime(artifact.mime_type) || artifact.size > ARTIFACT_PREVIEW_MAX_BYTES) {
          setPreview({
            artifactId: artifact.artifact_id,
            kind: "binary",
            mimeType: artifact.mime_type,
            size: artifact.size,
          });
          return;
        }
        setPreview({ artifactId: artifact.artifact_id, kind: "loading" });
        void openArtifact(artifact).then(
          (content) =>
            setPreview({
              artifactId: artifact.artifact_id,
              kind: "text",
              text: new TextDecoder().decode(content.bytes),
              mimeType: content.mime_type,
              size: content.size,
            }),
          (error: unknown) =>
            setPreview({
              artifactId: artifact.artifact_id,
              kind: "error",
              safeErrorMessage: safeWorkspaceMessage(error, "The artifact could not be read."),
            }),
        );
      }}
      onDownload={(artifact) => {
        void downloadArtifact(artifact);
      }}
    />
  );
}
