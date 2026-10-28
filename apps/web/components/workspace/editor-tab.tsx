"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { keymap, lineNumbers } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { FileText, Save } from "lucide-react";
import { useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import { CodeMirrorSurface } from "@/components/workspace/codemirror-editor";
import {
  WorkspaceLeaseConflictError,
  formatBytes,
  type WorkspaceFileContent,
} from "@/lib/workspace-api";
import {
  safeWorkspaceMessage,
  useSaveWorkspaceFile,
  useWorkspaceEditorFile,
} from "@/lib/workspace-data";

/**
 * The Editor tab (UI_DESIGN §4 S7): CodeMirror 6 text editing for files in
 * the workspace scope. The user's own save is a USER action — a PUT through
 * writeWorkspaceFile with the D4 user actor, gated by the runtime's D6 lease
 * check. There is no agent-requested mutation surface here (the S20 approval
 * path owns that); what this tab renders of the Agent's presence is the D6
 * conflict ONLY: when a WRITE_LEASE_CONFLICT 409 arrives, editing of that
 * path is DISABLED with the API's holder + task line verbatim (G5), while the
 * loaded content keeps rendering — concurrent reads stay allowed.
 *
 * Files open by path (inline open-by-path; the honest scope-qualified URI is
 * the input's contract). Binary files answer with an honest read-only notice
 * carrying mime + size instead of pretending to edit bytes (§2.4 honesty).
 */

export interface EditorTabViewProps {
  workspaceId: string;
  /** The open file's workspace:// URI, or null while nothing is open. */
  openPath: string | null;
  loadState: "idle" | "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry?: (() => void) | undefined;
  onOpenPath: (path: string) => void;
  content: string | null;
  size: number;
  mimeType: string | null;
  isText: boolean;
  dirty: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
  saveSafeError: string | undefined;
  onSave: () => void;
  /** The D6 lock: true while an Agent's write lease refuses this path. */
  leaseLocked: boolean;
  /** The API's conflict tooltip verbatim (G5) — holder Agent + task. */
  conflictTooltip: string | null;
  /** The client-only CodeMirror mount (browser render only). */
  editorSlot: ReactNode;
}

export function EditorTabView(props: EditorTabViewProps): ReactElement {
  const [draftPath, setDraftPath] = useState("");
  const openDisabled = draftPath.trim() === "";
  const saveDisabled =
    !props.isText || props.leaseLocked || props.saveState === "saving" || !props.dirty;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorToolbar
        draftPath={draftPath}
        onDraftPathChange={setDraftPath}
        onOpen={() => props.onOpenPath(normalizeWorkspacePath(draftPath))}
        openDisabled={openDisabled}
      />
      {props.openPath === null ? (
        props.loadState === "idle" ? (
          <EditorEmptyState />
        ) : null
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2">
            <p className="min-w-0 truncate font-mono text-xs text-sky">{props.openPath}</p>
            <p className="shrink-0 font-mono text-xs text-muted">
              {props.mimeType ?? "unknown type"} · {formatBytes(props.size)}
            </p>
            <SaveStatus dirty={props.dirty} saveState={props.saveState} />
          </div>
          {props.conflictTooltip ? (
            <p
              role="alert"
              data-testid="editor-lease-lock"
              className="mx-3 mt-2 rounded-lg border border-line-accent bg-surface-elevated px-3 py-2 text-xs text-approval"
            >
              {props.conflictTooltip}
            </p>
          ) : null}
          {props.saveState === "error" && props.saveSafeError ? (
            <p role="alert" className="mx-3 mt-2 text-xs text-failed">
              {props.saveSafeError}
            </p>
          ) : null}
          {props.loadState === "ready" && props.isText ? (
            <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-2">
              <div
                data-testid="workspace-editor-surface"
                data-lease-locked={props.leaseLocked ? "true" : "false"}
                className={
                  props.leaseLocked
                    ? "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line-accent opacity-80"
                    : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line"
                }
              >
                {props.editorSlot}
              </div>
            </div>
          ) : props.loadState === "ready" ? (
            <div
              data-testid="editor-binary-notice"
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center"
            >
              <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
                <FileText className="size-5 text-muted" aria-hidden="true" />
              </div>
              <p className="max-w-[42ch] text-sm text-muted">
                This is a binary file ({props.mimeType ?? "unknown type"}, {formatBytes(props.size)}
                ) — the editor handles text only. Download it from the Files tab to work with the
                bytes.
              </p>
            </div>
          ) : props.loadState === "loading" ? (
            <EditorSkeleton />
          ) : (
            <div className="min-h-0 flex-1 px-3 pb-3 pt-2">
              <ErrorState
                safeMessage={props.safeErrorMessage ?? "The file could not be read."}
                onRetry={props.onRetry}
              />
            </div>
          )}
          {props.isText && props.loadState === "ready" ? (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-3 py-2">
              <Button
                size="sm"
                data-testid="editor-save"
                disabled={saveDisabled}
                onClick={props.onSave}
              >
                <Save className="size-3.5" aria-hidden="true" />
                {props.saveState === "saving" ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function EditorToolbar({
  draftPath,
  onDraftPathChange,
  onOpen,
  openDisabled,
}: {
  draftPath: string;
  onDraftPathChange: (value: string) => void;
  onOpen: () => void;
  openDisabled: boolean;
}): ReactElement {
  return (
    <form
      className="flex shrink-0 items-center gap-2 border-b border-line px-3 pb-2 pt-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!openDisabled) onOpen();
      }}
    >
      <h3 className="min-w-0 shrink-0 font-mono text-xs uppercase tracking-[0.16em] text-muted">
        Editor
      </h3>
      <input
        type="text"
        value={draftPath}
        onChange={(event) => onDraftPathChange(event.target.value)}
        placeholder="workspace://notes.md"
        aria-label="File path"
        className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface-elevated px-2.5 font-mono text-xs text-text placeholder:text-muted focus-visible:border-line-accent"
      />
      <Button type="submit" size="sm" variant="outline" disabled={openDisabled}>
        Open
      </Button>
    </form>
  );
}

function SaveStatus({
  dirty,
  saveState,
}: {
  dirty: boolean;
  saveState: "idle" | "saving" | "saved" | "error";
}): ReactElement | null {
  if (saveState === "saving") {
    return (
      <p aria-live="polite" className="shrink-0 text-xs text-muted">
        Saving…
      </p>
    );
  }
  if (saveState === "saved") {
    return (
      <p aria-live="polite" className="shrink-0 text-xs text-live">
        Saved
      </p>
    );
  }
  if (dirty) {
    return (
      <p data-testid="editor-dirty" className="shrink-0 text-xs text-approval">
        Unsaved changes
      </p>
    );
  }
  return null;
}

/** §2.4 loading: a skeleton matching the editor frame, never a spinner. */
function EditorSkeleton(): ReactElement {
  return (
    <div aria-busy="true" className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-2">
      <div className="flex min-h-0 flex-1 animate-pulse flex-col gap-1.5 rounded-xl border border-line bg-surface-elevated p-3">
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="h-2.5 rounded bg-surface"
            style={{ width: `${88 - (index % 4) * 14}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** §2.4 idle: one-line explanation of how a file opens here. */
function EditorEmptyState(): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl border border-line bg-surface-elevated">
        <FileText className="size-5 text-sky" aria-hidden="true" />
      </div>
      <p className="max-w-[40ch] text-sm text-muted">
        No file open. Enter a workspace:// path above to start editing — your save is your own edit,
        applied directly.
      </p>
    </div>
  );
}

/** Accept bare paths ("notes.md") but keep the scope explicit on the wire. */
export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("workspace://")) return trimmed;
  return `workspace://${trimmed.replace(/^\/+/, "")}`;
}

// ---------------------------------------------------------------------------
// The stateful Editor tab (hooks + edit bookkeeping + the D6 lock)
// ---------------------------------------------------------------------------

/** The per-open-file session: bookkeeping that resets when the path changes. */
interface EditorSession {
  path: string | null;
  file: WorkspaceFileContent | null;
  /** The last loaded/saved doc — the dirty baseline. */
  baseline: string | null;
  /** The doc CodeMirror reports (per keystroke). */
  currentDoc: string | null;
  lock: { tooltip: string } | null;
  saveState: "idle" | "saving" | "saved" | "error";
  saveSafeError: string | undefined;
}

const IDLE_SESSION: EditorSession = {
  path: null,
  file: null,
  baseline: null,
  currentDoc: null,
  lock: null,
  saveState: "idle",
  saveSafeError: undefined,
};

export function EditorTab({ workspaceId }: { workspaceId: string }): ReactElement {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [session, setSession] = useState<EditorSession>(IDLE_SESSION);

  const file = useWorkspaceEditorFile(workspaceId, openPath);
  const { saveFile, savePending } = useSaveWorkspaceFile(workspaceId, openPath);

  // Adjust state during render when the open file (or its data) changes — the
  // React-documented alternative to a reset effect. The lock, the save
  // bookkeeping, and the dirty baseline are PER-FILE: a new path (or a
  // refetch of the same path) starts a fresh session.
  if (session.path !== openPath || session.file !== file.file) {
    const readyContent =
      file.state === "ready" && file.isText && file.content !== null ? file.content : null;
    setSession({
      path: openPath,
      file: file.file,
      baseline: readyContent,
      currentDoc: readyContent,
      lock: null,
      saveState: "idle",
      saveSafeError: undefined,
    });
  }

  const save = useCallback(
    async (content: string) => {
      setSession((prev) => ({ ...prev, saveState: "saving", saveSafeError: undefined }));
      try {
        await saveFile(content);
        setSession((prev) => ({ ...prev, baseline: content, saveState: "saved" }));
      } catch (error) {
        if (error instanceof WorkspaceLeaseConflictError) {
          // G5: the API's holder + task line verbatim. The lock DISABLES
          // editing of this path; the loaded content keeps rendering —
          // concurrent reads stay allowed while the Agent writes (D6).
          setSession((prev) => ({
            ...prev,
            lock: { tooltip: error.tooltip },
            saveState: "idle",
          }));
        } else {
          setSession((prev) => ({
            ...prev,
            saveSafeError: safeWorkspaceMessage(
              error,
              "The change could not be saved. You can try again.",
            ),
            saveState: "error",
          }));
        }
      }
    },
    [saveFile],
  );

  const extensions = useMemo<Extension[]>(
    () => [
      lineNumbers(),
      history(),
      keymap.of([
        {
          key: "Mod-s",
          run: (view) => {
            void save(view.state.doc.toString());
            return true;
          },
          preventDefault: true,
        },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
    ],
    [save],
  );

  const dirty =
    session.currentDoc !== null &&
    session.baseline !== null &&
    session.currentDoc !== session.baseline;

  return (
    <EditorTabView
      workspaceId={workspaceId}
      openPath={openPath}
      loadState={file.state}
      safeErrorMessage={file.safeErrorMessage}
      onRetry={file.refetch}
      onOpenPath={setOpenPath}
      content={file.content}
      size={file.file?.size ?? 0}
      mimeType={file.file?.mime_type ?? null}
      isText={file.isText}
      dirty={dirty}
      saveState={savePending ? "saving" : session.saveState}
      saveSafeError={session.saveSafeError}
      onSave={() => {
        if (session.currentDoc !== null) void save(session.currentDoc);
      }}
      leaseLocked={session.lock !== null}
      conflictTooltip={session.lock?.tooltip ?? null}
      editorSlot={
        file.state === "ready" && file.isText && file.content !== null ? (
          <CodeMirrorSurface
            content={file.content}
            locked={session.lock !== null}
            extensions={extensions}
            onDocChange={(doc) => {
              setSession((prev) => ({ ...prev, currentDoc: doc }));
            }}
          />
        ) : null
      }
    />
  );
}
