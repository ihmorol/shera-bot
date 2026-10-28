"use client";

import { ArrowDownToLine, FileText, Folder, FolderPlus, Trash2, Upload } from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useRef, useState, type ReactElement } from "react";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import {
  childrenOf,
  formatBytes,
  formatNodeDate,
  readWorkspaceFile,
  workspaceUriForPath,
  workspaceUriSegments,
  type WorkspaceNode,
} from "@/lib/workspace-api";
import {
  joinWorkspaceUri,
  safeWorkspaceWriteMessage,
  useCreateWorkspaceDirectory,
  useDeleteWorkspaceNode,
  useUploadWorkspaceFiles,
  useWorkspaceNodes,
} from "@/lib/workspace-data";

/**
 * The Files tab (UI_DESIGN §4 S7, PRD §4.3): the shared workspace:// tree on
 * the REAL local API through the same-origin proxy. Breadcrumb navigation,
 * upload, download, folder creation, and delete — the delete is NEVER
 * automatic (G6, PRD §12): every delete passes the named confirmation dialog.
 * A D6 lease conflict on write renders the API's holder + task line verbatim
 * (G5). The private agent:// scopes are chunk 5 — this tab shows the shared
 * scope only.
 *
 * FilesTabView is the controlled presentational surface (the apps/web test
 * convention renders it as static markup); FilesTab owns the interaction
 * state and the mutations.
 */

export interface FilesTabViewProps {
  workspaceId: string;
  state: "loading" | "ready" | "error";
  nodes: WorkspaceNode[];
  currentUri: string;
  safeErrorMessage: string | undefined;
  onRetry?: (() => void) | undefined;
  onNavigate: (uri: string) => void;
  onDownload: (node: WorkspaceNode) => void;
  onRequestDelete: (node: WorkspaceNode) => void;
  deleteTarget: { uri: string; name: string; isDirectory: boolean } | null;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  deletePending: boolean;
  onCreateDirectory: (name: string) => void;
  createPending: boolean;
  onUploadFiles: (files: File[]) => void;
  uploadPending: boolean;
  /** The D6 conflict line from the API (G5) — surfaced verbatim, or null. */
  conflictMessage: string | null;
}

export function FilesTabView(props: FilesTabViewProps): ReactElement {
  const segments = workspaceUriSegments(props.currentUri);
  const uploadInput = useRef<HTMLInputElement>(null);
  const pickFiles = () => uploadInput.current?.click();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <input
        ref={uploadInput}
        type="file"
        multiple
        className="sr-only"
        aria-label="Choose files to upload"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) props.onUploadFiles(files);
          event.target.value = "";
        }}
      />
      <FilesToolbar
        uploadPending={props.uploadPending}
        createPending={props.createPending}
        onPickFiles={pickFiles}
        onCreateDirectory={props.onCreateDirectory}
      />
      {props.conflictMessage ? (
        <p
          role="alert"
          data-testid="workspace-conflict"
          className="mx-3 mt-2 rounded-lg border border-line-accent bg-surface-elevated px-3 py-2 text-xs text-approval"
        >
          {props.conflictMessage}
        </p>
      ) : null}
      <nav aria-label="Workspace path" className="min-w-0 px-3 pt-3">
        <ol className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 font-mono text-xs text-muted">
          <li className="min-w-0">
            <button
              type="button"
              onClick={() => props.onNavigate("workspace://")}
              className="rounded px-0.5 py-0.5 text-sky transition-colors hover:text-cool-highlight"
            >
              workspace://
            </button>
          </li>
          {segments.map((segment, index) => {
            const uri = workspaceUriForPath(segments.slice(0, index + 1));
            const last = index === segments.length - 1;
            return (
              <li key={uri} className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true" className="text-muted">
                  /
                </span>
                {last ? (
                  <span className="truncate text-text">{segment}</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => props.onNavigate(uri)}
                    className="truncate rounded px-0.5 py-0.5 text-sky transition-colors hover:text-cool-highlight"
                  >
                    {segment}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {props.state === "loading" ? (
          <FilesSkeleton />
        ) : props.state === "error" ? (
          <ErrorState
            safeMessage={props.safeErrorMessage ?? "The workspace files could not be loaded."}
            onRetry={props.onRetry}
          />
        ) : props.nodes.length === 0 ? (
          <FilesEmptyState onUpload={pickFiles} />
        ) : (
          <ul data-testid="workspace-node-list" className="flex flex-col gap-0.5">
            {childrenOf(props.nodes).map((node) => (
              <NodeRow
                key={node.id}
                node={node}
                openUri={joinWorkspaceUri(props.currentUri, node.name)}
                onNavigate={props.onNavigate}
                onDownload={props.onDownload}
                onRequestDelete={props.onRequestDelete}
              />
            ))}
          </ul>
        )}
      </div>
      {props.deleteTarget ? (
        <DeleteConfirmDialog
          target={props.deleteTarget}
          onCancel={props.onCancelDelete}
          onConfirm={props.onConfirmDelete}
          pending={props.deletePending}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar — upload (the shared file picker) + new folder (inline row,
// operate.md: progressive before modal)
// ---------------------------------------------------------------------------

function FilesToolbar({
  uploadPending,
  createPending,
  onPickFiles,
  onCreateDirectory,
}: {
  uploadPending: boolean;
  createPending: boolean;
  onPickFiles: () => void;
  onCreateDirectory: (name: string) => void;
}): ReactElement {
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  return (
    <div className="shrink-0 border-b border-line px-3 pb-2 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate font-mono text-xs uppercase tracking-[0.16em] text-muted">
          Shared workspace
        </h3>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={uploadPending} onClick={onPickFiles}>
            <Upload className="size-3.5" aria-hidden="true" />
            {uploadPending ? "Uploading…" : "Upload a file"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={createPending}
            aria-label="New folder"
            onClick={() => setCreating((value) => !value)}
          >
            <FolderPlus className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {creating ? (
        <form
          className="mt-2.5 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = folderName.trim();
            if (name === "") return;
            onCreateDirectory(name);
            setFolderName("");
            setCreating(false);
          }}
        >
          <input
            autoFocus
            type="text"
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="Folder name"
            aria-label="New folder name"
            className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-elevated px-2.5 text-sm text-text placeholder:text-muted focus-visible:border-line-accent"
          />
          <Button type="submit" size="sm" disabled={createPending || folderName.trim() === ""}>
            Create
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCreating(false);
              setFolderName("");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** §2.4 loading: skeleton rows matching the final layout, never a spinner. */
function FilesSkeleton(): ReactElement {
  return (
    <div aria-busy="true" data-testid="workspace-nodes-skeleton" className="flex flex-col gap-1.5">
      {Array.from({ length: 5 }, (_, index) => (
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

/** §2.4 empty: one-line explanation + the most likely next action. */
export function FilesEmptyState({ onUpload }: { onUpload: () => void }): ReactElement {
  return (
    <div
      data-testid="workspace-empty"
      className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
        <Folder className="size-5 text-sky" aria-hidden="true" />
      </div>
      <p className="max-w-[36ch] text-sm text-muted">
        No files yet — everything you and the Agents put in the shared workspace shows up here.
      </p>
      <Button size="sm" variant="outline" onClick={onUpload}>
        <Upload className="size-3.5" aria-hidden="true" />
        Upload a file
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node rows — hover/focus-revealed actions, every control named (§2.3)
// ---------------------------------------------------------------------------

function NodeRow({
  node,
  openUri,
  onNavigate,
  onDownload,
  onRequestDelete,
}: {
  node: WorkspaceNode;
  openUri: string;
  onNavigate: (uri: string) => void;
  onDownload: (node: WorkspaceNode) => void;
  onRequestDelete: (node: WorkspaceNode) => void;
}): ReactElement {
  return (
    <li>
      <div className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface-elevated">
        {node.is_directory ? (
          <Folder className="size-4 shrink-0 text-sky" aria-hidden="true" />
        ) : (
          <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
        )}
        {node.is_directory ? (
          <button
            type="button"
            aria-label={`Open folder ${node.name}`}
            onClick={() => onNavigate(openUri)}
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
        <RowActions node={node} onDownload={onDownload} onRequestDelete={onRequestDelete} />
      </div>
    </li>
  );
}

function RowActions({
  node,
  onDownload,
  onRequestDelete,
}: {
  node: WorkspaceNode;
  onDownload: (node: WorkspaceNode) => void;
  onRequestDelete: (node: WorkspaceNode) => void;
}): ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
      {!node.is_directory ? (
        <button
          type="button"
          aria-label={`Download ${node.name}`}
          title={`Download ${node.name}`}
          onClick={() => onDownload(node)}
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-text"
        >
          <ArrowDownToLine className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Delete ${node.name}`}
        title={`Delete ${node.name}`}
        onClick={() => onRequestDelete(node)}
        className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-failed"
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The G6 gate: delete NEVER fires without this dialog (PRD §12)
// ---------------------------------------------------------------------------

export function DeleteConfirmDialog({
  target,
  onCancel,
  onConfirm,
  pending,
}: {
  target: { uri: string; name: string; isDirectory: boolean };
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}): ReactElement {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => open === false && onCancel()}>
      {/* Inline (no Portal) on purpose: the confirm renders within the Files
          tab subtree so it exists in every render surface; the fixed overlay
          still covers the viewport, and focus stays trapped by Radix. */}
      <DialogPrimitive.Overlay className="animate-overlay-in fixed inset-0 z-50 bg-canvas/70 backdrop-blur-sm" />
      <DialogPrimitive.Content
        data-testid="delete-confirm"
        className="animate-overlay-in fixed left-1/2 top-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line bg-surface-elevated p-5 shadow-[0_24px_64px_rgba(0,0,0,0.45)]"
      >
        <DialogPrimitive.Title className="font-display text-base font-semibold tracking-tight text-text">
          Delete {target.name}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="mt-2 text-sm text-muted">
          This permanently removes {target.name}
          {target.isDirectory ? " and everything inside it" : ""} from the shared workspace. Agents
          lose access to it immediately.
        </DialogPrimitive.Description>
        <div className="mt-4 flex items-center justify-end gap-2">
          <DialogPrimitive.Close asChild>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </DialogPrimitive.Close>
          <Button
            size="sm"
            data-testid="delete-confirm-action"
            disabled={pending}
            onClick={onConfirm}
            className="bg-failed text-canvas hover:bg-failed/90"
          >
            {pending ? "Deleting…" : "Delete file"}
          </Button>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// The stateful Files tab (hooks + interaction state)
// ---------------------------------------------------------------------------

export function FilesTab({ workspaceId }: { workspaceId: string }): ReactElement {
  const [currentUri, setCurrentUri] = useState("workspace://");
  const [deleteTarget, setDeleteTarget] = useState<{
    uri: string;
    name: string;
    isDirectory: boolean;
  } | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const listing = useWorkspaceNodes(workspaceId, currentUri);
  const { uploadFiles, uploadPending } = useUploadWorkspaceFiles(workspaceId, currentUri);
  const { createDirectory, createPending } = useCreateWorkspaceDirectory(workspaceId, currentUri);
  const { deleteNode, deletePending } = useDeleteWorkspaceNode(workspaceId);

  return (
    <FilesTabView
      workspaceId={workspaceId}
      state={listing.state}
      nodes={listing.nodes}
      currentUri={currentUri}
      safeErrorMessage={listing.safeErrorMessage}
      onRetry={listing.refetch}
      onNavigate={setCurrentUri}
      onDownload={(node) => {
        void downloadNodeToBrowser(workspaceId, joinWorkspaceUri(currentUri, node.name), node);
      }}
      onRequestDelete={(node) => {
        setConflictMessage(null);
        setDeleteTarget({
          uri: joinWorkspaceUri(currentUri, node.name),
          name: node.name,
          isDirectory: node.is_directory,
        });
      }}
      deleteTarget={deleteTarget}
      onCancelDelete={() => setDeleteTarget(null)}
      onConfirmDelete={() => {
        const target = deleteTarget;
        setDeleteTarget(null);
        if (target) {
          void deleteNode({ uri: target.uri, isDirectory: target.isDirectory }).catch(
            (error: unknown) => {
              setConflictMessage(safeWorkspaceWriteMessage(error));
            },
          );
        }
      }}
      deletePending={deletePending}
      onCreateDirectory={(name) => {
        void createDirectory(name).catch((error: unknown) => {
          setConflictMessage(safeWorkspaceWriteMessage(error));
        });
      }}
      createPending={createPending}
      onUploadFiles={(files) => {
        setConflictMessage(null);
        void uploadFiles(files).catch((error: unknown) => {
          setConflictMessage(safeWorkspaceWriteMessage(error));
        });
      }}
      uploadPending={uploadPending}
      conflictMessage={conflictMessage}
    />
  );
}

// ---------------------------------------------------------------------------
// Download: fetch bytes → Blob → the browser's save affordance. The byte
// decoding is the workspace client's (tested); only the DOM handoff lives here.
// ---------------------------------------------------------------------------

async function downloadNodeToBrowser(
  workspaceId: string,
  uri: string,
  node: WorkspaceNode,
): Promise<void> {
  const file = await readWorkspaceFile(workspaceId, uri);
  const blob = new Blob([file.bytes as BlobPart], {
    type: file.mime_type ?? "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = node.name;
  anchor.click();
  URL.revokeObjectURL(url);
}
