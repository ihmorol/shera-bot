"use client";

import { ArrowDownToLine, FileText, Folder, Lock } from "lucide-react";
import { useState, type ReactElement } from "react";

import { ErrorState } from "@/components/shell/states";
import {
  childrenOf,
  formatBytes,
  formatNodeDate,
  joinAgentUri,
  type WorkspaceNode,
} from "@/lib/workspace-api";
import { useAgentWorkspaceNodes, useWorkspaceFileDownload } from "@/lib/workspace-data";
import { useAgentRoster } from "@/lib/agent-data";

/**
 * The Private files tab (UI_DESIGN §4 S7, D39): per-Agent private folder
 * viewer over the REAL agent://<id>/ scopes. The listing reads AS the owning
 * Agent (actor_type=agent&actor_id=<id> — the storage layer's D39 rule is the
 * authority; the user's read of the private folder is this viewer's purpose).
 * READ ONLY this slice: browse + download; no upload, no delete, no mkdir.
 * The tab is labelled PRIVATE everywhere it renders (D39: the folder belongs
 * to one Agent identity and never appears in the shared workspace).
 *
 * PrivateFilesTabView is the controlled presentational surface; the stateful
 * tab owns the selection + reads.
 */

export interface PrivateAgentOption {
  agent_id: string;
  display_name: string;
}

export interface PrivateFilesTabViewProps {
  workspaceId: string;
  agents: PrivateAgentOption[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  state: "idle" | "loading" | "ready" | "error";
  nodes: WorkspaceNode[];
  safeErrorMessage: string | undefined;
  onRetry?: (() => void) | undefined;
  onNavigate: (path: string) => void;
  onDownload: (node: WorkspaceNode) => void;
}

export function PrivateFilesTabView(props: PrivateFilesTabViewProps): ReactElement {
  const selected = props.agents.find((agent) => agent.agent_id === props.selectedAgentId) ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-line px-3 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate font-mono text-xs uppercase tracking-[0.16em] text-muted">
            Private files
          </h3>
          <span
            data-testid="private-badge"
            className="flex shrink-0 items-center gap-1 rounded-full border border-line-accent bg-surface-elevated px-2 py-0.5 text-xs font-medium text-approval"
          >
            <Lock className="size-3" aria-hidden="true" />
            Private
          </span>
        </div>
        {selected !== null ? (
          <p className="mt-1.5 text-xs text-muted">
            Private to {selected.display_name} — other Agents never see this folder, and it never
            appears in the shared workspace.
          </p>
        ) : null}
        <select
          data-testid="private-agent-selector"
          aria-label="Choose an Agent"
          value={props.selectedAgentId ?? ""}
          onChange={(event) => props.onSelectAgent(event.target.value)}
          className="mt-2 h-8 w-full rounded-lg border border-line bg-surface-elevated px-2 text-sm text-text focus-visible:border-line-accent"
        >
          {props.agents.length === 0 ? <option value="">No Agent available</option> : null}
          {props.agents.map((agent) => (
            <option key={agent.agent_id} value={agent.agent_id}>
              {agent.display_name}
            </option>
          ))}
        </select>
      </div>
      {props.selectedAgentId !== null ? (
        <p className="min-w-0 truncate px-3 pt-2 font-mono text-xs text-muted">
          agent://{props.selectedAgentId}/
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {props.state === "idle" ? (
          <PrivateEmptyAgentState />
        ) : props.state === "loading" ? (
          <PrivateSkeleton />
        ) : props.state === "error" ? (
          <ErrorState
            safeMessage={
              props.safeErrorMessage ?? "This Agent's private folder could not be loaded."
            }
            onRetry={props.onRetry}
          />
        ) : props.nodes.length === 0 ? (
          <PrivateEmptyFolderState agentName={selected?.display_name ?? "this Agent"} />
        ) : (
          <ul data-testid="workspace-private-node-list" className="flex flex-col gap-0.5">
            {childrenOf(props.nodes).map((node) => (
              <PrivateNodeRow
                key={node.id}
                node={node}
                openPath={joinAgentUri(`agent://${props.selectedAgentId ?? ""}/`, node.name)}
                onNavigate={props.onNavigate}
                onDownload={props.onDownload}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PrivateNodeRow({
  node,
  openPath,
  onNavigate,
  onDownload,
}: {
  node: WorkspaceNode;
  openPath: string;
  onNavigate: (path: string) => void;
  onDownload: (node: WorkspaceNode) => void;
}): ReactElement {
  return (
    <li>
      <div className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface-elevated">
        {node.is_directory ? (
          <Folder className="size-4 shrink-0 text-approval" aria-hidden="true" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
        )}
        {node.is_directory ? (
          <button
            type="button"
            aria-label={`Open folder ${node.name}`}
            onClick={() => onNavigate(openPath)}
            className="min-w-0 flex-1 truncate text-left text-sm text-text"
          >
            {node.name}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-text">{node.name}</span>
        )}
        <span className="shrink-0 font-mono text-xs text-muted">
          {node.is_directory ? "—" : formatBytes(node.size)}
        </span>
        {!node.is_directory ? (
          <span className="hidden shrink-0 font-mono text-xs text-muted sm:inline">
            {formatNodeDate(node.updated_at)}
          </span>
        ) : null}
        {!node.is_directory ? (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
            <button
              type="button"
              aria-label={`Download ${node.name}`}
              title={`Download ${node.name}`}
              onClick={() => onDownload(node)}
              className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <ArrowDownToLine className="size-3.5" aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function PrivateSkeleton(): ReactElement {
  return (
    <div
      aria-busy="true"
      data-testid="workspace-private-skeleton"
      className="flex flex-col gap-1.5"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="flex h-11 animate-pulse items-center gap-3 rounded-lg bg-surface-elevated px-3"
        >
          <div className="size-4 rounded bg-surface" />
          <div className="h-2.5 flex-1 rounded bg-surface" />
        </div>
      ))}
    </div>
  );
}

function PrivateEmptyAgentState(): ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
        <Lock className="size-5 text-approval" aria-hidden="true" />
      </div>
      <p className="max-w-[38ch] text-sm text-muted">
        Choose an Agent above to see its private folder. Each folder belongs to that one Agent.
      </p>
    </div>
  );
}

function PrivateEmptyFolderState({ agentName }: { agentName: string }): ReactElement {
  return (
    <div
      data-testid="workspace-private-empty"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
        <Folder className="size-5 text-approval" aria-hidden="true" />
      </div>
      <p className="max-w-[38ch] text-sm text-muted">
        No private files yet — this folder is {agentName}&apos;s own scratch space.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The stateful Private tab (roster + agent-scoped reads, download only)
// ---------------------------------------------------------------------------

export function PrivateFilesTab({ workspaceId }: { workspaceId: string }): ReactElement {
  const roster = useAgentRoster(workspaceId);
  const agents: PrivateAgentOption[] = roster.agents.map((agent) => ({
    agent_id: agent.agent_id,
    display_name: agent.display_name,
  }));
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  // The first rostered Agent is the honest default — the tab opens usable.
  const activeAgentId =
    selectedAgentId !== null && agents.some((agent) => agent.agent_id === selectedAgentId)
      ? selectedAgentId
      : (agents[0]?.agent_id ?? null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const scopePath = activeAgentId !== null ? `agent://${activeAgentId}/` : null;
  const listing = useAgentWorkspaceNodes(workspaceId, activeAgentId, currentPath ?? scopePath);

  const { downloadNode } = useWorkspaceFileDownload(
    workspaceId,
    activeAgentId !== null ? { type: "agent", id: activeAgentId } : null,
  );

  // The roster failing IS the tab's error state — a selector without Agents
  // cannot honestly render anything else.
  const state =
    roster.state === "loading" ? "loading" : roster.state === "error" ? "error" : listing.state;

  return (
    <PrivateFilesTabView
      workspaceId={workspaceId}
      agents={agents}
      selectedAgentId={activeAgentId}
      onSelectAgent={(agentId) => {
        setSelectedAgentId(agentId);
        setCurrentPath(null);
      }}
      state={state}
      nodes={listing.nodes}
      safeErrorMessage={
        roster.state === "error" ? roster.safeErrorMessage : listing.safeErrorMessage
      }
      onRetry={roster.state === "error" ? roster.refetch : listing.refetch}
      onNavigate={setCurrentPath}
      onDownload={(node) => {
        const base = currentPath ?? scopePath;
        if (base !== null) void downloadNode(joinAgentUri(base, node.name), node);
      }}
    />
  );
}
