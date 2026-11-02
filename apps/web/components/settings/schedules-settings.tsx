"use client";

import { AlertTriangle, CalendarClock, Pause, Play, Pencil, Plus } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { useContainerResolution } from "@/lib/container-connection";
import { useOperationsList } from "@/lib/operation-data";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shell/states";
import { useTriggers, useTriggerActions, safeSchedulesMessage } from "@/lib/schedules-data";
import type { TriggerView } from "@/lib/schedules-api";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The S28 Schedules & watchers settings surface (UI_DESIGN §S9 row; PRD §8,
 * §13; E5; AC9, AC10, D48). Every card renders the runtime scheduler's OWN
 * record — state, pause reason, last firing, next occurrence, recent runs —
 * never a fixture and never locally recomputed schedule math (AC9's truth
 * source is the scheduler). The pause/resume controls are the AC10 user
 * controls; the insufficient-credits pause reads the D48 reason and says
 * what unblocks it. Run cards name the trigger that created them ("from
 * schedule: weekly literature sweep").
 */

export type SchedulesSurfaceState = "ready" | "loading" | "error";

const KIND_LABELS: Record<TriggerView["kind"], string> = {
  schedule: "Schedule",
  file_watch: "File watcher",
  git_watch: "Git watcher",
  webhook: "Webhook",
  task_completion: "Task completion",
  condition: "Condition",
  external_event: "External event",
};

/** The missed-occurrence policy in the product's own words (the raw enum
 * never renders — the card's meta line is prose, not configuration). */
const CATCH_UP_LABELS: Record<TriggerView["catch_up_policy"], string> = {
  catch_up: "missed runs are caught up",
  skip: "missed runs are skipped",
};

/** The cron expression's display form (data, never recomputed — AC9). */
function scheduleCron(config: Record<string, unknown>): string | null {
  const cron = config["cron"];
  return typeof cron === "string" ? cron : null;
}

function describeConfig(trigger: TriggerView): string | null {
  switch (trigger.kind) {
    case "schedule": {
      const cron = scheduleCron(trigger.config);
      return cron === null ? null : `cron ${cron} (UTC)`;
    }
    case "file_watch": {
      const uri = trigger.config["path_uri"];
      const scope = trigger.config["scope"] === "agent" ? "private folder" : "workspace";
      return typeof uri === "string" ? `${scope} · ${uri}` : null;
    }
    case "git_watch": {
      const project = trigger.config["project_id"];
      const branch = trigger.config["branch"];
      return typeof project === "string" && typeof branch === "string"
        ? `${project} · ${branch}`
        : null;
    }
    case "webhook":
    case "external_event": {
      const source = trigger.config["source"];
      return typeof source === "string" ? `source: ${source}` : null;
    }
    case "condition": {
      const predicate = trigger.config["predicate"];
      if (typeof predicate !== "object" || predicate === null) return null;
      const kind = (predicate as Record<string, unknown>)["kind"];
      return typeof kind === "string" ? `predicate: ${kind}` : null;
    }
    case "task_completion":
      return "after a run of this Operation settles";
    default:
      return null;
  }
}

function formatWhen(iso: string | null, empty: string): string {
  if (iso === null) return empty;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
}

const FIRING_OUTCOME_LABELS: Record<string, string> = {
  fired: "Run completed",
  claimed: "Starting",
  deduplicated: "Duplicate — already run",
  skipped_catchup: "Skipped (catch-up policy)",
  refused_provider: "Provider not configured",
  paused_credits: "Paused — insufficient credits",
  failed: "Failed",
};

function StateChip({ trigger }: { trigger: TriggerView }) {
  const creditPaused =
    trigger.state === "paused" && trigger.pause_reason === "insufficient_credits";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]",
        trigger.state === "active"
          ? "border-line-accent text-sky"
          : creditPaused
            ? "border-line text-approval"
            : "border-line text-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          trigger.state === "active" ? "bg-sky" : creditPaused ? "bg-approval" : "bg-muted",
        )}
      />
      {trigger.state === "active" ? "Active" : creditPaused ? "Paused — credits" : "Paused"}
    </span>
  );
}

/** One recent firing rendered as a run card naming its trigger (AC10). */
function RunCard({
  trigger,
  firing,
}: {
  trigger: TriggerView;
  firing: TriggerView["recent_firings"][number];
}) {
  const outcomeLabel = FIRING_OUTCOME_LABELS[firing.outcome] ?? firing.outcome;
  const settled = firing.outcome === "fired" && firing.run_id !== null;
  return (
    <li
      data-testid="schedule-run-card"
      className="rounded-xl border border-line bg-surface-elevated px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text">
          from {KIND_LABELS[trigger.kind].toLowerCase()}:{" "}
          <span className="font-medium">{trigger.name}</span>
        </p>
        <span
          className={cn(
            "font-mono text-[11px] uppercase tracking-[0.14em]",
            firing.outcome === "fired"
              ? "text-live"
              : firing.outcome === "failed" ||
                  firing.outcome === "refused_provider" ||
                  firing.outcome === "paused_credits"
                ? "text-approval"
                : "text-muted",
          )}
        >
          {outcomeLabel}
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted">
        {firing.run_id ?? firing.idempotency_key} · {formatWhen(firing.fired_at, "—")}
      </p>
      {settled ? (
        <a
          href={`${routes.operation(trigger.target_operation_id)}#run-${firing.run_id}`}
          className="mt-1.5 inline-block text-xs text-sky underline underline-offset-4 hover:text-cool-highlight"
        >
          Open the run
        </a>
      ) : null}
    </li>
  );
}

function TriggerCard({
  trigger,
  busy,
  onPause,
  onResume,
  onEdit,
  editSlot,
}: {
  trigger: TriggerView;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  editSlot?: React.ReactNode;
}) {
  const creditPaused =
    trigger.state === "paused" && trigger.pause_reason === "insufficient_credits";
  const description = describeConfig(trigger);
  const recentRuns = trigger.recent_firings.slice(0, 3);
  return (
    <li
      className="rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5"
      data-testid="schedule-trigger-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-text">{trigger.name}</h3>
            <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted">
              {KIND_LABELS[trigger.kind]}
            </span>
            <StateChip trigger={trigger} />
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {description ?? KIND_LABELS[trigger.kind]} · {CATCH_UP_LABELS[trigger.catch_up_policy]}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trigger.state === "active" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onPause}
              disabled={busy}
              data-testid={`schedule-pause-${trigger.trigger_id}`}
            >
              <Pause className="size-3.5" aria-hidden="true" />
              Pause
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onResume}
              disabled={busy}
              data-testid={`schedule-resume-${trigger.trigger_id}`}
            >
              <Play className="size-3.5" aria-hidden="true" />
              Resume
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onEdit}
            disabled={busy}
            aria-expanded={editSlot !== undefined}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            Edit
          </Button>
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        <div className="flex gap-1.5">
          <dt className="shrink-0 text-muted">Last firing:</dt>
          <dd className="text-text" data-testid={`schedule-last-fired-${trigger.trigger_id}`}>
            {trigger.last_fired_at === null
              ? "never fired yet"
              : formatWhen(trigger.last_fired_at, "unknown")}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="shrink-0 text-muted">Next occurrence:</dt>
          <dd className="text-text" data-testid={`schedule-next-${trigger.trigger_id}`}>
            {trigger.next_occurrence_at === null
              ? "— (event-driven)"
              : formatWhen(trigger.next_occurrence_at, "unknown")}
          </dd>
        </div>
      </dl>

      {creditPaused ? (
        <p
          role="status"
          data-testid={`schedule-credit-paused-${trigger.trigger_id}`}
          className="mt-3 flex items-start gap-1.5 rounded-xl border border-line bg-surface-elevated px-3 py-2 text-xs text-approval"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Paused — the account could not reserve credits for this trigger. It resumes automatically
          after a top-up, or resume it yourself once credits are available.
        </p>
      ) : null}

      {recentRuns.length > 0 ? (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted">
            Recent runs
          </p>
          <ul className="mt-2 space-y-2">
            {recentRuns.map((firing) => (
              <RunCard key={firing.idempotency_key} trigger={trigger} firing={firing} />
            ))}
          </ul>
        </div>
      ) : null}

      {editSlot}
    </li>
  );
}

const inputClass =
  "w-full rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-text placeholder:text-muted";

const KIND_OPTIONS = Object.entries(KIND_LABELS) as Array<[TriggerView["kind"], string]>;

/** The typed create form: kind + name + target + the kind's typed config.
 * A prose-only submit is impossible by construction — every field is typed
 * data (G2). */
function AddTriggerForm({
  operations,
  onCreate,
  pending,
  safeError,
  open,
  onOpenChange,
}: {
  operations: Array<{ operation_id: string; name: string }>;
  onCreate: (input: {
    kind: TriggerView["kind"];
    name: string;
    target_operation_id: string;
    config: Record<string, unknown>;
    catch_up_policy: "catch_up" | "skip";
  }) => void;
  pending: boolean;
  safeError?: string | undefined;
  /** The form's open state is LIFTED (the empty state's call-to-action and
   * the collapsed control share it — a cancelled form is reopenable). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [kind, setKind] = useState<TriggerView["kind"]>("schedule");
  const [name, setName] = useState("");
  const [targetOperationId, setTargetOperationId] = useState(operations[0]?.operation_id ?? "");
  const [cron, setCron] = useState("0 9 * * 1");
  const [prompt, setPrompt] = useState("");
  const [artifactName, setArtifactName] = useState("");
  const [catchUpPolicy, setCatchUpPolicy] = useState<"catch_up" | "skip">("skip");
  const [parseError, setParseError] = useState<string | null>(null);
  const formId = useId();
  const nameRef = useRef<HTMLInputElement | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setParseError(null);
    if (targetOperationId === "") {
      setParseError("Choose the Operation this trigger runs in — nothing was saved.");
      return;
    }
    if (kind === "schedule") {
      onCreate({
        kind,
        name,
        target_operation_id: targetOperationId,
        config: {
          cron,
          plan: {
            prompt,
            ...(artifactName.trim() !== ""
              ? {
                  artifact: {
                    name: artifactName.trim(),
                    artifact_type: "document",
                    mime_type: "text/markdown",
                  },
                }
              : {}),
          },
        },
        catch_up_policy: catchUpPolicy,
      });
      return;
    }
    if (kind === "webhook" || kind === "external_event") {
      onCreate({
        kind,
        name,
        target_operation_id: targetOperationId,
        config: { source: name },
        catch_up_policy: "skip",
      });
      return;
    }
    setParseError(
      "This kind is created from its own surface — the schedule form covers schedules only.",
    );
  };

  if (!open) {
    return (
      <Button variant="outline" onClick={() => onOpenChange(true)} className="w-full sm:w-auto">
        <Plus className="size-4" aria-hidden="true" />
        New trigger
      </Button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-line bg-surface px-4 py-4 sm:px-5"
      aria-label="Create a trigger"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-kind`} className="block text-xs font-medium text-muted">
            Kind
          </label>
          <select
            id={`${formId}-kind`}
            value={kind}
            onChange={(event) => setKind(event.target.value as TriggerView["kind"])}
            className={inputClass}
          >
            {KIND_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-name`} className="block text-xs font-medium text-muted">
            Name
          </label>
          <input
            id={`${formId}-name`}
            ref={nameRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={200}
            placeholder="weekly literature sweep"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-target`} className="block text-xs font-medium text-muted">
            Runs in Operation
          </label>
          <select
            id={`${formId}-target`}
            value={targetOperationId}
            onChange={(event) => setTargetOperationId(event.target.value)}
            className={inputClass}
          >
            <option value="" disabled>
              Choose an Operation…
            </option>
            {operations.map((operation) => (
              <option key={operation.operation_id} value={operation.operation_id}>
                {operation.name}
              </option>
            ))}
          </select>
        </div>
        {kind === "schedule" ? (
          <>
            <div className="space-y-1.5">
              <label htmlFor={`${formId}-cron`} className="block text-xs font-medium text-muted">
                Cron expression (UTC)
              </label>
              <input
                id={`${formId}-cron`}
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                required
                maxLength={128}
                placeholder="0 9 * * 1"
                className={cn(inputClass, "font-mono")}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor={`${formId}-prompt`} className="block text-xs font-medium text-muted">
                Task instruction
                <span className="ms-1 font-normal">
                  — what the run does, in one bounded paragraph
                </span>
              </label>
              <textarea
                id={`${formId}-prompt`}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                required
                maxLength={2000}
                rows={3}
                placeholder="Compile the weekly literature sweep from the seeded note and publish the digest as an artifact."
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor={`${formId}-artifact`}
                className="block text-xs font-medium text-muted"
              >
                Artifact name
                <span className="ms-1 font-normal">— optional</span>
              </label>
              <input
                id={`${formId}-artifact`}
                value={artifactName}
                onChange={(event) => setArtifactName(event.target.value)}
                maxLength={200}
                placeholder="weekly-sweep.md"
                className={inputClass}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${formId}-catchup`} className="block text-xs font-medium text-muted">
                Missed-occurrence policy
              </label>
              <select
                id={`${formId}-catchup`}
                value={catchUpPolicy}
                onChange={(event) => setCatchUpPolicy(event.target.value as "catch_up" | "skip")}
                className={inputClass}
              >
                <option value="skip">Skip — jump to the next occurrence</option>
                <option value="catch_up">Catch up — fire each missed occurrence once</option>
              </select>
            </div>
          </>
        ) : null}
      </div>

      {parseError !== null ? (
        <p role="alert" className="mt-3 text-xs text-failed">
          {parseError}
        </p>
      ) : null}
      {safeError !== undefined ? (
        <p role="alert" className="mt-3 text-xs text-failed">
          {safeError}
        </p>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <Button type="submit" disabled={pending} className="sm:w-auto">
          <CalendarClock className="size-4" aria-hidden="true" />
          {pending ? "Creating…" : "Create trigger"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function LoadingState() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading schedules">
      {[0, 1].map((row) => (
        <div
          key={row}
          className="h-24 animate-pulse rounded-2xl border border-line bg-surface-elevated"
        />
      ))}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="rounded-2xl border border-line bg-surface px-5 py-8 text-center">
      <p className="text-sm font-medium text-text">No triggers yet</p>
      <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted">
        Schedules, file and Git watchers, webhooks, and condition triggers live here. A trigger runs
        as a task in one of your Operations — created only from typed configuration, never from
        chat.
      </p>
      <div className="mt-4 flex justify-center">
        <Button variant="outline" onClick={onNew}>
          <Plus className="size-4" aria-hidden="true" />
          Create the first trigger
        </Button>
      </div>
    </div>
  );
}

export interface SchedulesSettingsViewProps {
  operations: Array<{ operation_id: string; name: string }>;
  triggers: TriggerView[];
  surfaceState: SchedulesSurfaceState;
  safeErrorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  createPending: boolean;
  createSafeError?: string | undefined;
  busyTriggerId?: string | null | undefined;
  onCreate: (input: {
    kind: TriggerView["kind"];
    name: string;
    target_operation_id: string;
    config: Record<string, unknown>;
    catch_up_policy: "catch_up" | "skip";
  }) => void;
  onPause: (triggerId: string) => void;
  onResume: (triggerId: string) => void;
  onEdit: (triggerId: string, body: { name?: string; config?: Record<string, unknown> }) => void;
  /** Test/first-render override for the create form. */
  defaultCreateOpen?: boolean | undefined;
}

export function SchedulesSettingsView(props: SchedulesSettingsViewProps) {
  const {
    operations,
    triggers,
    surfaceState,
    safeErrorMessage,
    onRetry,
    createPending,
    createSafeError,
    busyTriggerId,
    onCreate,
    onPause,
    onResume,
    onEdit,
    defaultCreateOpen,
  } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  // The create form's open state (null = the seeded default: open on an
  // empty surface, or the surface's explicit request).
  const [createOpen, setCreateOpen] = useState<boolean | null>(null);
  const [editName, setEditName] = useState("");
  const [editCron, setEditCron] = useState("");

  if (surfaceState === "loading") {
    return <LoadingState />;
  }
  if (surfaceState === "error") {
    return (
      <ErrorState
        safeMessage={safeErrorMessage ?? "The schedules could not be loaded."}
        onRetry={onRetry}
      />
    );
  }

  return (
    <div className="space-y-5">
      <AddTriggerForm
        operations={operations}
        onCreate={onCreate}
        pending={createPending}
        safeError={createSafeError}
        open={createOpen ?? defaultCreateOpen ?? triggers.length === 0}
        onOpenChange={setCreateOpen}
      />

      {triggers.length === 0 ? (
        <EmptyState onNew={() => setCreateOpen(true)} />
      ) : (
        <ul className="space-y-4" data-testid="schedule-trigger-list">
          {triggers.map((trigger) => (
            <TriggerCard
              key={trigger.trigger_id}
              trigger={trigger}
              busy={busyTriggerId === trigger.trigger_id}
              onPause={() => onPause(trigger.trigger_id)}
              onResume={() => onResume(trigger.trigger_id)}
              onEdit={() => {
                setEditingId((current) =>
                  current === trigger.trigger_id ? null : trigger.trigger_id,
                );
                setEditName(trigger.name);
                const cron = scheduleCron(trigger.config);
                setEditCron(cron ?? "");
              }}
              editSlot={
                editingId === trigger.trigger_id ? (
                  <form
                    className="mt-4 rounded-xl border border-line bg-surface-elevated px-4 py-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      onEdit(trigger.trigger_id, {
                        name: editName,
                        ...(trigger.kind === "schedule"
                          ? {
                              config: {
                                ...trigger.config,
                                cron: editCron,
                              },
                            }
                          : {}),
                      });
                      setEditingId(null);
                    }}
                  >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <label
                          htmlFor={`edit-name-${trigger.trigger_id}`}
                          className="block text-xs font-medium text-muted"
                        >
                          Name
                        </label>
                        <input
                          id={`edit-name-${trigger.trigger_id}`}
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          required
                          maxLength={200}
                          className={inputClass}
                        />
                      </div>
                      {trigger.kind === "schedule" ? (
                        <div className="space-y-1.5">
                          <label
                            htmlFor={`edit-cron-${trigger.trigger_id}`}
                            className="block text-xs font-medium text-muted"
                          >
                            Cron expression (UTC)
                          </label>
                          <input
                            id={`edit-cron-${trigger.trigger_id}`}
                            value={editCron}
                            onChange={(event) => setEditCron(event.target.value)}
                            required
                            maxLength={128}
                            className={cn(inputClass, "font-mono")}
                          />
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        disabled={busyTriggerId === trigger.trigger_id}
                      >
                        Save changes
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingId(null)}
                        disabled={busyTriggerId === trigger.trigger_id}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : undefined
              }
            />
          ))}
        </ul>
      )}

      <p className="text-xs leading-relaxed text-muted">
        Trigger runs are created only from these typed records — chat never creates one. Missed
        schedule occurrences follow each trigger&apos;s policy while the runtime was down, and every
        decision is recorded on the trigger&apos;s own event stream.
      </p>
    </div>
  );
}

/** The wired surface: the container resolution + the real data hooks. */
export function SchedulesSettingsSurface() {
  const resolution = useContainerResolution();
  if (resolution.isPending || resolution.data === undefined) {
    if (resolution.isError) {
      return (
        <ErrorState
          safeMessage="The schedules read their truth from the runtime; the runtime is not answering right now."
          onRetry={() => resolution.refetch()}
        />
      );
    }
    return <LoadingState />;
  }
  if (resolution.data?.kind !== "ready") {
    return (
      <ErrorState
        safeMessage="Schedules live in the user container; it is still preparing."
        onRetry={() => resolution.refetch()}
      />
    );
  }
  return <RuntimeSchedulesSettings workspaceId={resolution.data.workspace_id} />;
}

function RuntimeSchedulesSettings({ workspaceId }: { workspaceId: string }) {
  const catalog = useTriggers(workspaceId);
  const actions = useTriggerActions(workspaceId);
  const operationsList = useOperationsList(workspaceId);
  const busyTriggerId = actions.pause.isPending
    ? (actions.pause.variables ?? null)
    : actions.resume.isPending
      ? (actions.resume.variables ?? null)
      : actions.edit.isPending
        ? ((actions.edit.variables as { triggerId: string } | undefined)?.triggerId ?? null)
        : null;
  const operations =
    operationsList.state === "ready"
      ? operationsList.operations.map((operation) => ({
          operation_id: operation.operation_id,
          name: operation.name,
        }))
      : [];

  return (
    <SchedulesSettingsView
      operations={operations}
      triggers={catalog.triggers}
      surfaceState={catalog.state}
      safeErrorMessage={catalog.safeErrorMessage}
      onRetry={catalog.refetch}
      createPending={actions.create.isPending}
      createSafeError={
        actions.create.isError
          ? safeSchedulesMessage(actions.create.error, "The trigger was not created.")
          : undefined
      }
      busyTriggerId={busyTriggerId}
      onCreate={(input) => actions.create.mutate({ workspace_id: workspaceId, ...input })}
      onPause={(triggerId) => actions.pause.mutate(triggerId)}
      onResume={(triggerId) => actions.resume.mutate(triggerId)}
      onEdit={(triggerId, body) => actions.edit.mutate({ triggerId, body })}
    />
  );
}
