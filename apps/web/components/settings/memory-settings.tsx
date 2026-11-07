"use client";

import { Clock, Eye, EyeOff, History, Lock, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { useContainerResolution } from "@/lib/container-connection";
import { useOperationsList } from "@/lib/operation-data";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shell/states";
import {
  memoryErrorCode,
  safeMemoryMessage,
  useMemoryActions,
  useMemoryView,
} from "@/lib/memory-data";
import {
  memoryScopeLabel,
  type MemoryEntryView,
  type MemoryScope,
  type MemoryUserView,
} from "@/lib/memory-api";
import type { MemoryEditBody } from "@/lib/memory-api";
import { cn } from "@/lib/utils";

/**
 * The S29 Memory settings surface (UI_DESIGN §S9 Memory row; PRD §11, D37,
 * AC27, G3/G6). Every card renders the runtime's OWN memory record — the
 * per-scope breakdown, the publication queue, the version histories, the
 * provenance lines — never a fixture and never locally recomputed state
 * (G4). The controls are the D37 user controls: edit, restore, permanently
 * forget, publish, and the auto-memory switches. A rejected write is shown
 * honestly: the typed refusal (its safe message) renders where the action
 * happened — secrets are never stored, and the surface never pretends a
 * refused write landed.
 */

export type MemorySurfaceState = "ready" | "loading" | "error";

interface OperationOption {
  operation_id: string;
  name: string;
}

const CHANGE_KIND_LABELS: Record<MemoryEntryView["versions"][number]["change_kind"], string> = {
  created: "Created",
  edited: "Edited",
  published: "Published",
  restored: "Restored",
  auto_updated: "Updated automatically",
};

function formatWhen(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
}

/** Who the actor was, in the product's own words (ids stay ids when the
 * viewer's roster names nobody — the runtime's record is the truth). */
function actorLabel(actorId: string): string {
  if (actorId === "user_emon" || actorId === "session-user") return "you";
  if (actorId.startsWith("agent_")) {
    const name = actorId.replace(/^agent_/, "").replaceAll("_", " ");
    return name;
  }
  return actorId;
}

/** The provenance line — "remembered from …" — the D37 display rule. */
function provenanceLine(entry: MemoryEntryView): string {
  const source = entry.source_refs[0] ?? "an unnamed source";
  const rest = entry.source_refs.length > 1 ? ` +${entry.source_refs.length - 1} more` : "";
  const verb = entry.origin === "automatic" ? "Remembered from" : "Added from";
  return `${verb} ${source}${rest}`;
}

function ScopeChip({ entry }: { entry: MemoryEntryView }) {
  const sensitive = entry.sensitivity === "sensitive";
  const published = entry.publication.published;
  return (
    <span
      data-testid="memory-visibility-chip"
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        sensitive
          ? "bg-amber-950/60 text-amber-300"
          : published
            ? "bg-sky-950/60 text-sky-300"
            : "bg-surface-muted text-muted",
      )}
    >
      {sensitive ? <ShieldAlert aria-hidden className="h-3 w-3" /> : null}
      {sensitive
        ? published
          ? "Sensitive · shared"
          : "Sensitive · private until you approve sharing"
        : entry.scope === "agent_private"
          ? published
            ? "Shared into an Operation"
            : "Private to this Agent"
          : memoryScopeLabel(entry.scope)}
    </span>
  );
}

function ProvenanceLine({ entry }: { entry: MemoryEntryView }) {
  return (
    <p
      data-testid="memory-provenance"
      className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
    >
      <span className="inline-flex items-center gap-1">
        <Clock aria-hidden className="h-3 w-3" />
        {provenanceLine(entry)}
      </span>
      <span aria-hidden>·</span>
      <span>{Math.round(entry.confidence * 100)}% confidence</span>
      <span aria-hidden>·</span>
      <span>
        {entry.origin === "automatic" ? "learned" : "added"} by {actorLabel(entry.created_by)}
      </span>
      <span aria-hidden>·</span>
      <span>{formatWhen(entry.created_at)}</span>
    </p>
  );
}

function RejectionBanner({ code, safeMessage }: { code: string | null; safeMessage: string }) {
  return (
    <p
      role="alert"
      data-testid="memory-rejection"
      className="mt-2 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs leading-relaxed text-red-200"
    >
      {code === "MEMORY_SECRET_REJECTED"
        ? "Not saved — this looks like a credential or secret. Secrets are never stored in memory."
        : safeMessage}
    </p>
  );
}

function VersionHistory({
  entry,
  busy,
  onRestore,
}: {
  entry: MemoryEntryView;
  busy: boolean;
  onRestore: (version: number) => void;
}) {
  // History starts open once the memory has MORE than its creation version —
  // an edited memory shows its history without a second click; a fresh
  // memory stays quiet.
  const [open, setOpen] = useState(entry.versions.length > 1);
  return (
    <div className="mt-3" data-testid="memory-version-history">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 text-xs font-medium text-sky underline underline-offset-4 hover:text-cool-highlight"
        aria-expanded={open}
      >
        <History aria-hidden className="h-3 w-3" />
        {open ? `Hide history (${entry.versions.length})` : `History (${entry.versions.length})`}
      </button>
      {open ? (
        <ul className="mt-2 space-y-1.5">
          {entry.versions.map((version) => (
            <li
              key={version.version}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-muted/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-text">
                  v{version.version} · {CHANGE_KIND_LABELS[version.change_kind]} ·{" "}
                  {formatWhen(version.created_at)} · by {actorLabel(version.changed_by)}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted">{version.content}</p>
              </div>
              {version.version !== entry.versions.at(-1)?.version ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onRestore(version.version)}
                  data-testid="memory-restore-button"
                >
                  <RotateCcw aria-hidden className="mr-1 h-3 w-3" />
                  Restore
                </Button>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                  current
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EditForm({
  entry,
  busy,
  safeError,
  errorCode,
  onSave,
  onCancel,
}: {
  entry: MemoryEntryView;
  busy: boolean;
  safeError: string | undefined;
  errorCode: string | null;
  onSave: (body: { summary: string; content: string }) => void;
  onCancel: () => void;
}) {
  const summaryId = useId();
  const contentId = useId();
  const [summary, setSummary] = useState(entry.summary);
  const [content, setContent] = useState(entry.content);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ summary, content });
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-2" data-testid="memory-edit-form">
      <div>
        <label htmlFor={summaryId} className="mb-1 block text-xs font-medium text-text">
          Summary
        </label>
        <input
          id={summaryId}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          disabled={busy}
          maxLength={500}
          className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
        />
      </div>
      <div>
        <label htmlFor={contentId} className="mb-1 block text-xs font-medium text-text">
          Content
        </label>
        <textarea
          id={contentId}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          disabled={busy}
          rows={3}
          maxLength={20000}
          className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
        />
      </div>
      {safeError !== undefined ? (
        <RejectionBanner code={errorCode} safeMessage={safeError} />
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={busy || summary.length === 0 || content.length === 0}
        >
          Save changes
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function PublicationControls({
  entry,
  operations,
  busy,
  safeError,
  errorCode,
  onRequest,
  onDecide,
}: {
  entry: MemoryEntryView;
  operations: OperationOption[];
  busy: boolean;
  safeError: string | undefined;
  errorCode: string | null;
  onRequest: (operationId: string) => void;
  onDecide: (operationId: string, decision: "approve" | "dismiss") => void;
}) {
  const [operationId, setOperationId] = useState(operations[0]?.operation_id ?? "");
  const isPrivate = entry.scope === "agent_private";
  const needsApproval = entry.sensitivity === "sensitive";
  // Publication is the private→Operation step (and the sensitive approval
  // gate). A shared-scope, non-sensitive memory has nothing to publish —
  // showing controls there would dilute the boundary they exist to gate.
  if (!isPrivate && !needsApproval) return null;
  if (operations.length === 0) return null;
  return (
    <div
      className="mt-3 rounded-xl border border-line bg-surface-muted/60 px-3 py-2"
      data-testid="memory-publication-controls"
    >
      <p className="text-xs leading-relaxed text-muted">
        {isPrivate
          ? "This memory is private to its Agent. Sharing it into an Operation is your explicit decision — nothing copies it automatically."
          : needsApproval
            ? "This memory is sensitive. Sharing it needs your approval before any Agent sees it in the Operation."
            : "Publish a copy of this memory's visibility into an Operation."}
      </p>
      {safeError !== undefined ? (
        <RejectionBanner code={errorCode} safeMessage={safeError} />
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`memory-publish-target-${entry.memory_id}`}>
          Target Operation
        </label>
        <select
          id={`memory-publish-target-${entry.memory_id}`}
          value={operationId}
          onChange={(event) => setOperationId(event.target.value)}
          disabled={busy}
          className="rounded-xl border border-line bg-surface px-2 py-1.5 text-xs text-text"
        >
          {operations.map((operation) => (
            <option key={operation.operation_id} value={operation.operation_id}>
              {operation.name}
            </option>
          ))}
        </select>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || operationId === ""}
          onClick={() => onRequest(operationId)}
          data-testid="memory-request-publication"
        >
          <Eye aria-hidden className="mr-1 h-3 w-3" />
          Request publication
        </Button>
        {entry.publication.published && entry.publication.published_into_operation_id ? (
          // The withdraw control names the target: what is being undone.
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onDecide(entry.publication.published_into_operation_id!, "dismiss")}
            data-testid="memory-withdraw-publication"
          >
            <EyeOff aria-hidden className="mr-1 h-3 w-3" />
            Withdraw from Operation
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ForgetControls({
  entry,
  busy,
  safeError,
  errorCode,
  onForget,
}: {
  entry: MemoryEntryView;
  busy: boolean;
  safeError: string | undefined;
  errorCode: string | null;
  onForget: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <div className="mt-3">
        {safeError !== undefined ? (
          <RejectionBanner code={errorCode} safeMessage={safeError} />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(true)}
          data-testid="memory-forget-button"
          className="text-red-300 hover:text-red-200"
        >
          <Trash2 aria-hidden className="mr-1 h-3 w-3" />
          Permanently forget
        </Button>
      </div>
    );
  }
  return (
    <div
      className="mt-3 rounded-xl border border-red-900/60 bg-red-950/40 px-3 py-2"
      data-testid="memory-forget-confirm"
    >
      <p className="text-xs leading-relaxed text-red-100">
        Permanently forget removes this memory and its {entry.versions.length}{" "}
        {entry.versions.length === 1 ? "version" : "versions"}. This cannot be undone — there is no
        restorable copy afterwards.
      </p>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={onForget}
          data-testid="memory-forget-confirm-button"
        >
          <Trash2 aria-hidden className="mr-1 h-3 w-3" />
          Forget permanently
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          Keep it
        </Button>
      </div>
    </div>
  );
}

function MemoryEntryCard({
  entry,
  operations,
  busy,
  editSafeError,
  editErrorCode,
  publishSafeError,
  publishErrorCode,
  forgetSafeError,
  forgetErrorCode,
  onEdit,
  onRestore,
  onRequestPublication,
  onPublishDecision,
  onForget,
}: {
  entry: MemoryEntryView;
  operations: OperationOption[];
  busy: boolean;
  editSafeError: string | undefined;
  editErrorCode: string | null;
  publishSafeError: string | undefined;
  publishErrorCode: string | null;
  forgetSafeError: string | undefined;
  forgetErrorCode: string | null;
  onEdit: (memoryId: string, body: { summary: string; content: string }) => void;
  onRestore: (memoryId: string, version: number) => void;
  onRequestPublication: (memoryId: string, operationId: string) => void;
  onPublishDecision: (
    memoryId: string,
    operationId: string,
    decision: "approve" | "dismiss",
  ) => void;
  onForget: (memoryId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li
      className="rounded-2xl border border-line bg-surface px-4 py-3"
      data-testid="memory-entry-card"
      data-memory-id={entry.memory_id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">{entry.summary}</p>
          <ScopeChip entry={entry} />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setEditing((value) => !value)}
          data-testid="memory-edit-toggle"
        >
          {editing ? "Close" : "Edit"}
        </Button>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-text/90">{entry.content}</p>
      <ProvenanceLine entry={entry} />
      {editing ? (
        <EditForm
          entry={entry}
          busy={busy}
          safeError={editSafeError}
          errorCode={editErrorCode}
          onSave={(body) => onEdit(entry.memory_id, body)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        editSafeError !== undefined && (
          <RejectionBanner code={editErrorCode} safeMessage={editSafeError} />
        )
      )}
      <PublicationControls
        entry={entry}
        operations={operations}
        busy={busy}
        safeError={publishSafeError}
        errorCode={publishErrorCode}
        onRequest={(operationId) => onRequestPublication(entry.memory_id, operationId)}
        onDecide={(operationId, decision) =>
          onPublishDecision(entry.memory_id, operationId, decision)
        }
      />
      <VersionHistory
        entry={entry}
        busy={busy}
        onRestore={(version) => onRestore(entry.memory_id, version)}
      />
      <ForgetControls
        entry={entry}
        busy={busy}
        safeError={forgetSafeError}
        errorCode={forgetErrorCode}
        onForget={() => onForget(entry.memory_id)}
      />
    </li>
  );
}

function PublicationQueueCard({
  queue,
  entries,
  operations,
  busy,
  safeError,
  errorCode,
  onDecide,
}: {
  queue: MemoryUserView["publication_queue"];
  entries: MemoryEntryView[];
  operations: OperationOption[];
  busy: boolean;
  safeError: string | undefined;
  errorCode: string | null;
  onDecide: (memoryId: string, operationId: string, decision: "approve" | "dismiss") => void;
}) {
  const operationName = (operationId: string): string =>
    operations.find((operation) => operation.operation_id === operationId)?.name ??
    "an unnamed Operation";
  if (queue.length === 0) {
    return (
      <section
        className="rounded-2xl border border-line bg-surface px-4 py-3"
        data-testid="memory-publication-queue"
      >
        <h2 className="text-sm font-semibold text-text">Publication queue</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Nothing is waiting for your decision. Private and sensitive memories land here when an
          Agent proposes one or when you request a publication — nothing is shared until you approve
          it.
        </p>
      </section>
    );
  }
  return (
    <section
      className="rounded-2xl border border-line bg-surface px-4 py-3"
      data-testid="memory-publication-queue"
    >
      <h2 className="text-sm font-semibold text-text">Publication queue</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Memories waiting for your decision. Approving shares the entry into that Operation&apos;s
        context; dismissing keeps it private.
      </p>
      {safeError !== undefined ? (
        <RejectionBanner code={errorCode} safeMessage={safeError} />
      ) : null}
      <ul className="mt-3 space-y-2">
        {queue.map((request) => {
          const entry = entries.find((candidate) => candidate.memory_id === request.memory_id);
          return (
            <li
              key={request.request_id}
              className="rounded-xl border border-line bg-surface-muted/60 px-3 py-2"
              data-testid="memory-queue-item"
            >
              <p className="text-sm font-medium text-text">
                {entry?.summary ?? "A memory that has since been removed"}
              </p>
              {entry ? (
                <p className="mt-0.5 text-xs text-muted" data-testid="memory-queue-item-scope">
                  {memoryScopeLabel(entry.scope)}
                  {entry.sensitivity === "sensitive" ? (
                    <span className="ml-1 font-medium text-amber-300">· sensitive</span>
                  ) : null}
                </p>
              ) : null}
              <p className="mt-0.5 text-xs text-muted">
                Proposed by {actorLabel(request.requested_by)} · {formatWhen(request.created_at)} ·
                into {operationName(request.operation_id)}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(request.memory_id, request.operation_id, "approve")}
                  data-testid="memory-approve-publication"
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => onDecide(request.memory_id, request.operation_id, "dismiss")}
                  data-testid="memory-dismiss-publication"
                >
                  Dismiss
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AutoMemoryCard({
  autoMemory,
  busy,
  safeError,
  errorCode,
  onSetGlobal,
  onSetAgent,
}: {
  autoMemory: MemoryUserView["auto_memory"];
  busy: boolean;
  safeError: string | undefined;
  errorCode: string | null;
  onSetGlobal: (enabled: boolean) => void;
  onSetAgent: (agentId: string, enabled: boolean) => void;
}) {
  return (
    <section
      className="rounded-2xl border border-line bg-surface px-4 py-3"
      data-testid="memory-auto-card"
    >
      <h2 className="text-sm font-semibold text-text">Automatic memory</h2>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-text">Learn automatically across the workspace</p>
          <p className="text-xs leading-relaxed text-muted">
            Agents propose memories from conversations, tasks, and corrections; the runtime checks
            each one (secrets are always refused) before anything is stored.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => onSetGlobal(!autoMemory.global_enabled)}
          data-testid="memory-auto-global-toggle"
          aria-pressed={autoMemory.global_enabled}
        >
          <Lock aria-hidden className="mr-1 h-3 w-3" />
          {autoMemory.global_enabled ? "Enabled" : "Disabled"}
        </Button>
      </div>
      {autoMemory.agents.length > 0 ? (
        <ul className="mt-3 space-y-1.5" data-testid="memory-auto-agents">
          {autoMemory.agents.map((agent) => (
            <li key={agent.agent_id} className="flex items-center justify-between gap-2">
              <span className="text-xs text-text">{actorLabel(agent.agent_id)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onSetAgent(agent.agent_id, !agent.enabled)}
                data-testid="memory-auto-agent-toggle"
                aria-pressed={agent.enabled}
              >
                {agent.enabled ? "Automatic on" : "Automatic off"}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-muted">
          Per-Agent switches appear here once an Agent has proposed a memory.
        </p>
      )}
      {safeError !== undefined ? (
        <RejectionBanner code={errorCode} safeMessage={safeError} />
      ) : null}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Turning this off stops new automatic memories. You can still add, edit, and restore memories
        yourself.
      </p>
    </section>
  );
}

export interface MemorySettingsViewProps {
  memory: MemoryUserView;
  operations: OperationOption[];
  surfaceState: MemorySurfaceState;
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  busy: boolean;
  editSafeError: string | undefined;
  editErrorCode: string | null;
  publishSafeError: string | undefined;
  publishErrorCode: string | null;
  forgetSafeError: string | undefined;
  forgetErrorCode: string | null;
  autoSafeError: string | undefined;
  autoErrorCode: string | null;
  onEdit: (memoryId: string, body: { summary: string; content: string }) => void;
  onRestore: (memoryId: string, version: number) => void;
  onRequestPublication: (memoryId: string, operationId: string) => void;
  onPublishDecision: (
    memoryId: string,
    operationId: string,
    decision: "approve" | "dismiss",
  ) => void;
  onForget: (memoryId: string) => void;
  onSetGlobal: (enabled: boolean) => void;
  onSetAgent: (agentId: string, enabled: boolean) => void;
}

function LoadingState() {
  return (
    <div className="space-y-3" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="h-24 animate-pulse rounded-2xl border border-line bg-surface" />
      ))}
    </div>
  );
}

/** The pure view (the test seam — renders exactly the props it is given). */
export function MemorySettingsView(props: MemorySettingsViewProps) {
  const { memory } = props;
  const sharedScopes: MemoryScope[] = ["workspace", "account", "operation", "task"];
  const scopeGroups: MemoryScope[] = [...sharedScopes, "agent_private"];
  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted">
        One shared workspace memory and one private memory per Agent. Private memories never enter
        an Operation&apos;s context on their own — sharing is your explicit decision, sensitive
        memories need your approval, and secrets are refused outright.
      </p>

      <AutoMemoryCard
        autoMemory={memory.auto_memory}
        busy={props.busy}
        safeError={props.autoSafeError}
        errorCode={props.autoErrorCode}
        onSetGlobal={props.onSetGlobal}
        onSetAgent={props.onSetAgent}
      />

      <PublicationQueueCard
        queue={memory.publication_queue}
        entries={scopeGroups.flatMap((scope) => memory.scopes[scope] ?? [])}
        operations={props.operations}
        busy={props.busy}
        safeError={props.publishSafeError}
        errorCode={props.publishErrorCode}
        onDecide={props.onPublishDecision}
      />

      {scopeGroups.map((scope) => {
        const entries = memory.scopes[scope] ?? [];
        return (
          <section
            key={scope}
            data-testid="memory-scope-group"
            data-scope={scope}
            aria-label={`${memoryScopeLabel(scope)} memories`}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-text">{memoryScopeLabel(scope)} memory</h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
                {entries.length} {entries.length === 1 ? "entry" : "entries"}
              </span>
            </div>
            {entries.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-xs leading-relaxed text-muted">
                {scope === "agent_private"
                  ? "No Agent has a private memory yet. When one learns from your work, it appears here — visible only to that Agent until you share it."
                  : scope === "workspace"
                    ? "Nothing is remembered for this workspace yet. Agents remember what matters as you work with them."
                    : "Nothing in this scope yet."}
              </p>
            ) : (
              <ul className="space-y-2">
                {entries.map((entry) => (
                  <MemoryEntryCard
                    key={entry.memory_id}
                    entry={entry}
                    operations={props.operations}
                    busy={props.busy}
                    editSafeError={props.editSafeError}
                    editErrorCode={props.editErrorCode}
                    publishSafeError={props.publishSafeError}
                    publishErrorCode={props.publishErrorCode}
                    forgetSafeError={props.forgetSafeError}
                    forgetErrorCode={props.forgetErrorCode}
                    onEdit={props.onEdit}
                    onRestore={props.onRestore}
                    onRequestPublication={props.onRequestPublication}
                    onPublishDecision={props.onPublishDecision}
                    onForget={props.onForget}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <p className="text-xs leading-relaxed text-muted">
        Provenance is kept for every entry — where it was remembered from, how confident the Agent
        was, and when. Pack upgrades never rewrite what is already remembered here.
      </p>
    </div>
  );
}

/** The wired surface: the container resolution + the real data hooks. */
export function MemorySettingsSurface() {
  const resolution = useContainerResolution();
  if (resolution.isPending || resolution.data === undefined) {
    if (resolution.isError) {
      return (
        <ErrorState
          safeMessage="Memory reads its truth from the runtime; the runtime is not answering right now."
          onRetry={() => resolution.refetch()}
        />
      );
    }
    return <LoadingState />;
  }
  if (resolution.data?.kind !== "ready") {
    return (
      <ErrorState
        safeMessage="Memory lives in the user container; it is still preparing."
        onRetry={() => resolution.refetch()}
      />
    );
  }
  return <RuntimeMemorySettings workspaceId={resolution.data.workspace_id} />;
}

function RuntimeMemorySettings({ workspaceId }: { workspaceId: string }) {
  const catalog = useMemoryView(workspaceId);
  const actions = useMemoryActions(workspaceId);
  const operationsList = useOperationsList(workspaceId);
  const operations =
    operationsList.state === "ready"
      ? operationsList.operations.map((operation) => ({
          operation_id: operation.operation_id,
          name: operation.name,
        }))
      : [];

  if (catalog.state !== "ready" || catalog.memory === null) {
    if (catalog.state === "error") {
      return (
        <ErrorState
          safeMessage={catalog.safeErrorMessage ?? "Memory could not be loaded."}
          onRetry={catalog.refetch}
        />
      );
    }
    return <LoadingState />;
  }
  const memory = catalog.memory;

  const busy =
    actions.edit.isPending ||
    actions.restore.isPending ||
    actions.forget.isPending ||
    actions.requestPublication.isPending ||
    actions.publishDecision.isPending ||
    actions.setAutoMemory.isPending ||
    actions.setAgentAutoMemory.isPending;

  const errorOf = (error: unknown): { safeError: string | undefined; code: string | null } => ({
    safeError: error === null ? undefined : safeMemoryMessage(error, "The change was not saved."),
    code: memoryErrorCode(error),
  });
  const edit = errorOf(actions.edit.error);
  const publish = errorOf(actions.publishDecision.error ?? actions.requestPublication.error);
  const forget = errorOf(actions.forget.error);
  const auto = errorOf(actions.setAutoMemory.error ?? actions.setAgentAutoMemory.error);

  return (
    <MemorySettingsView
      memory={catalog.memory}
      operations={operations}
      surfaceState="ready"
      safeErrorMessage={undefined}
      onRetry={catalog.refetch}
      busy={busy}
      editSafeError={edit.safeError}
      editErrorCode={edit.code}
      publishSafeError={publish.safeError}
      publishErrorCode={publish.code}
      forgetSafeError={forget.safeError}
      forgetErrorCode={forget.code}
      autoSafeError={auto.safeError}
      autoErrorCode={auto.code}
      onEdit={(memoryId, body) => {
        // The edit re-sends the entry's OWN provenance (an edit never
        // rewrites where a memory came from — the source refs, confidence,
        // and expiry ride along unchanged).
        const entry = Object.values(memory.scopes)
          .flat()
          .find((candidate) => candidate.memory_id === memoryId);
        const editBody: MemoryEditBody = {
          summary: body.summary,
          content: body.content,
          sensitivity: entry?.sensitivity ?? "normal",
          source_refs: entry?.source_refs ?? [],
          confidence: entry?.confidence ?? 0.7,
          expires_at: entry?.expires_at ?? null,
        };
        actions.edit.mutate({ memoryId, body: editBody });
      }}
      onRestore={(memoryId, version) => actions.restore.mutate({ memoryId, version })}
      onRequestPublication={(memoryId, operationId) =>
        actions.requestPublication.mutate({ memoryId, operationId })
      }
      onPublishDecision={(memoryId, operationId, decision) =>
        actions.publishDecision.mutate({ memoryId, operationId, decision })
      }
      onForget={(memoryId) => actions.forget.mutate({ memoryId })}
      onSetGlobal={(enabled) => actions.setAutoMemory.mutate({ enabled })}
      onSetAgent={(agentId, enabled) => actions.setAgentAutoMemory.mutate({ agentId, enabled })}
    />
  );
}
