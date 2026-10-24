"use client";

import { AlertTriangle, Check, RotateCcw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type {
  AgentSettingEntry,
  AgentSettingsSnapshot,
  EditableAgentSettingKey,
  AgentCapabilities,
  AgentToolDefault,
  ProviderDefault,
} from "@shera-bot/contracts";
import { EDITABLE_AGENT_SETTING_KEYS } from "@shera-bot/contracts";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { AgentSettingsAction } from "@/lib/agent-api";
import { safeRuntimeMessage, useAgentSettings } from "@/lib/agent-data";
import { useContainerResolution } from "@/lib/container-connection";
import { cn } from "@/lib/utils";

/**
 * The D16 Agent settings surface (S11 chunk 4; §S9 "Agents" row, D16: the
 * settings editor and S30 onboarding share the SAME commands and schemas).
 *
 * Every entry renders exactly what D16 demands — display label, current
 * value, recommended default where the pack carries one, why it matters,
 * risk/cost impact, and reset-to-default for the resettable keys — read from
 * the typed snapshot, never re-derived in the UI. Pack-owned entries render
 * read-only with no controls (they are never command targets); advanced
 * entries (the placeholder-typed tool defaults) are progressively disclosed.
 *
 * Mutations go through the ONE D16 command surface
 * (POST /v1/agents/:id/settings/commands): the view raises semantic actions,
 * the hook completes the contracts envelope (fresh command_id +
 * idempotency_key per submit) and refetches the snapshot after each accepted
 * command — the runtime's read-after-write result is the truthful update,
 * never an optimistic guess. Settled commands confirm inline: the edited card
 * shows a brief "Saved" status (§6.3 visible command feedback), cleared
 * automatically after a moment. Because the refetched snapshot is the truth,
 * every editor REMOUNTS from its entry's value (`settingsEditorKey`) — after
 * a reset or a save the draft field always reflects the server value, never
 * a pre-command local leftover. Resets arm a confirm first: no destructive
 * command fires from a single click.
 */

export type AgentSettingsSurfaceState = "ready" | "loading" | "error";

export type PendingResetKey = EditableAgentSettingKey | "all" | null;

/**
 * Stable identity for an editor mount, derived from the AUTHORITATIVE entry
 * value: when the runtime snapshot changes (save, reset, refetch), the key
 * changes and React replaces the editor — the draft re-syncs to the server
 * value. Unchanged entries keep their key, so unrelated commands never wipe
 * an in-progress draft.
 */
export function settingsEditorKey(entry: AgentSettingEntry): string {
  return `${entry.key}:${JSON.stringify(entry.value)}`;
}

export interface AgentSettingsViewProps {
  agentName: string;
  snapshot: AgentSettingsSnapshot | null;
  surfaceState: AgentSettingsSurfaceState;
  /** Redacted message for the error state (D23 rule 4). */
  safeErrorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** The armed reset (per key or all), or null when nothing is armed. */
  pendingResetKey: PendingResetKey;
  commandPending: boolean;
  commandError?: string | undefined;
  /** Test/first-render override for the advanced disclosure (D16). */
  defaultAdvancedOpen?: boolean | undefined;
  /**
   * Setting keys the last SETTLED command affected — the edited cards show a
   * brief inline "Saved" confirmation (§6.3). Empty/undefined = nothing to
   * confirm (idle, pending, or the confirmation already cleared).
   */
  savedKeys?: readonly string[] | undefined;
  onUpdateInstructions: (value: string | null) => void;
  onUpdateDefaultProvider: (provider: ProviderDefault) => void;
  onUpdateToolDefaults: (defaults: AgentToolDefault[]) => void;
  /** Arm (or re-arm) a reset; nothing fires until onResetConfirm. */
  onResetClick: (key: PendingResetKey) => void;
  onResetConfirm: () => void;
  onResetCancel: () => void;
}

function SettingsSkeleton() {
  return (
    <div aria-hidden="true" className="mx-auto max-w-xl space-y-4">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-xl border border-line bg-surface p-4">
          <div className="h-3 w-32 animate-pulse rounded bg-surface-elevated" />
          <div className="mt-3 h-2.5 w-full animate-pulse rounded bg-surface-elevated" />
          <div className="mt-1.5 h-2.5 w-2/3 animate-pulse rounded bg-surface-elevated" />
        </div>
      ))}
    </div>
  );
}

function EntryBadge({ editable }: { editable: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
        editable ? "border-line-accent text-sky" : "border-line text-muted",
      )}
    >
      {editable ? "Editable" : "Read-only"}
    </span>
  );
}

function RiskNote({ note }: { note: string }) {
  if (!note) return null;
  return (
    <p className="flex items-start gap-2 text-xs text-approval">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      {note}
    </p>
  );
}

function ResetControls({
  entryKey,
  resettable,
  pendingResetKey,
  onResetClick,
  onResetConfirm,
  onResetCancel,
}: {
  entryKey: EditableAgentSettingKey;
  resettable: boolean;
  pendingResetKey: PendingResetKey;
  onResetClick: AgentSettingsViewProps["onResetClick"];
  onResetConfirm: AgentSettingsViewProps["onResetConfirm"];
  onResetCancel: AgentSettingsViewProps["onResetCancel"];
}) {
  if (!resettable) return null;
  if (pendingResetKey === entryKey) {
    return (
      <span className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onResetConfirm}>
          Confirm reset
        </Button>
        <Button variant="ghost" size="sm" onClick={onResetCancel}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button variant="ghost" size="sm" onClick={() => onResetClick(entryKey)}>
      <RotateCcw aria-hidden="true" />
      Reset to default
    </Button>
  );
}

function EntryCard({
  entry,
  children,
  pendingResetKey,
  onResetClick,
  onResetConfirm,
  onResetCancel,
  footer,
}: {
  entry: AgentSettingEntry;
  children: ReactNode;
  pendingResetKey: PendingResetKey;
  onResetClick: AgentSettingsViewProps["onResetClick"];
  onResetConfirm: AgentSettingsViewProps["onResetConfirm"];
  onResetCancel: AgentSettingsViewProps["onResetCancel"];
  /** Extra row under the value: reset controls, recommended default, etc. */
  footer?: React.ReactNode;
}) {
  return (
    <section
      data-setting-key={entry.key}
      aria-label={entry.display_label}
      className="rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          {entry.display_label}
        </h3>
        <EntryBadge editable={entry.editable} />
      </div>
      <p className="mt-2 text-sm text-muted">{entry.description}</p>
      <div className="mt-3">{children}</div>
      <RiskNote note={entry.risk_note} />
      {footer ? <div className="mt-3 flex flex-wrap items-center gap-3">{footer}</div> : null}
      <div className="mt-3">
        {/* Only the editable keys are command targets (D16) — the runtime
            guard mirrors EDITABLE_AGENT_SETTING_KEYS so TS and the contract
            agree that a pack-owned key never reaches a reset control. */}
        {entry.editable &&
        (EDITABLE_AGENT_SETTING_KEYS as readonly string[]).includes(entry.key) ? (
          <ResetControls
            entryKey={entry.key as EditableAgentSettingKey}
            resettable={entry.resettable}
            pendingResetKey={pendingResetKey}
            onResetClick={onResetClick}
            onResetConfirm={onResetConfirm}
            onResetCancel={onResetCancel}
          />
        ) : null}
      </div>
    </section>
  );
}

function RecommendedDefaultLine({ children }: { children: ReactNode }) {
  return (
    <p className="text-xs text-muted">
      Recommended default: <span className="font-mono text-sky">{children}</span>
    </p>
  );
}

/** Mono rendering of a provider/model pair. */
function ProviderValue({ provider }: { provider: ProviderDefault }) {
  return (
    <span className="font-mono text-sm text-text">
      {provider.provider_id} · {provider.model}
    </span>
  );
}

function CapabilitiesValue({ value }: { value: AgentCapabilities }) {
  return (
    <div className="space-y-1 text-sm text-text">
      <p>
        <span className="text-muted">Skills:</span>{" "}
        <span className="font-mono text-xs">
          {value.skills.length ? value.skills.join(", ") : "none"}
        </span>
      </p>
      <p>
        <span className="text-muted">Tools:</span>{" "}
        <span className="font-mono text-xs">
          {value.tools.length
            ? value.tools.map((tool) => `${tool.tool_id}@${tool.version}`).join(", ")
            : "none"}
        </span>
      </p>
      <p>
        <span className="text-muted">Connectors:</span>{" "}
        <span className="font-mono text-xs">
          {value.connectors.length ? value.connectors.join(", ") : "none"}
        </span>
      </p>
    </div>
  );
}

/**
 * The value + editor renderings per typed entry. Read-only entries render
 * their value as data and NOTHING interactive; editable entries render their
 * editor inline (the D16 snapshot decides, not the UI).
 */
function EntryValue({
  entry,
  agentName,
  saved,
  onUpdateInstructions,
  onUpdateDefaultProvider,
  onUpdateToolDefaults,
}: {
  entry: AgentSettingEntry;
  agentName: string;
  /** True when the last settled command targeted THIS entry (inline "Saved"). */
  saved: boolean;
  onUpdateInstructions: AgentSettingsViewProps["onUpdateInstructions"];
  onUpdateDefaultProvider: AgentSettingsViewProps["onUpdateDefaultProvider"];
  onUpdateToolDefaults: AgentSettingsViewProps["onUpdateToolDefaults"];
}) {
  switch (entry.key) {
    case "role":
      return <p className="text-sm text-text">{entry.value}</p>;
    case "memory_link":
      return (
        <p
          className="break-all font-mono text-xs text-text"
          title="The Agent's private folder root"
        >
          {entry.value}
        </p>
      );
    case "capabilities":
      return <CapabilitiesValue value={entry.value} />;
    case "ui_identity":
      return (
        <p className="flex items-center gap-3 text-sm text-text">
          <AgentAvatar
            agent={{
              agent_id: "agent_identity_preview",
              display_name: agentName,
              ui_identity: entry.value,
            }}
            size="md"
          />
          <span className="font-mono text-xs">
            hue {entry.value.avatar_hue} · glyph {entry.value.initial_glyph}
          </span>
        </p>
      );
    case "user_instructions": {
      // The key is the authoritative value: a save/reset remounts this editor
      // from the refetched snapshot, so the draft never goes stale.
      return (
        <UserInstructionsEditor
          key={settingsEditorKey(entry)}
          entry={entry}
          saved={saved}
          onUpdateInstructions={onUpdateInstructions}
        />
      );
    }
    case "default_provider": {
      return (
        <DefaultProviderEditor
          key={settingsEditorKey(entry)}
          entry={entry}
          saved={saved}
          onUpdateDefaultProvider={onUpdateDefaultProvider}
        />
      );
    }
    case "tool_defaults": {
      return (
        <ToolDefaultsEditor
          key={settingsEditorKey(entry)}
          entry={entry}
          saved={saved}
          onUpdateToolDefaults={onUpdateToolDefaults}
        />
      );
    }
  }
}

/** The brief inline confirmation a settled command leaves on its card (§6.3). */
function SavedBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span role="status" className="flex items-center gap-1 text-xs text-live">
      <Check className="size-3.5" aria-hidden="true" />
      Saved
    </span>
  );
}

function UserInstructionsEditor({
  entry,
  saved,
  onUpdateInstructions,
}: {
  entry: Extract<AgentSettingEntry, { key: "user_instructions" }>;
  saved: boolean;
  onUpdateInstructions: AgentSettingsViewProps["onUpdateInstructions"];
}) {
  const [draft, setDraft] = useState(entry.value ?? "");
  return (
    <div className="space-y-2">
      {entry.value === null ? (
        <p className="text-xs text-muted">Not set — the pack role runs alone.</p>
      ) : null}
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={3}
        aria-label="Your instructions"
        placeholder="Personal guidance layered above the pack role"
        className="w-full resize-y rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-text placeholder:text-muted"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onUpdateInstructions(draft.trim() ? draft.trim() : null)}>
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft("");
            onUpdateInstructions(null);
          }}
        >
          Clear
        </Button>
        <SavedBadge visible={saved} />
      </div>
    </div>
  );
}

function DefaultProviderEditor({
  entry,
  saved,
  onUpdateDefaultProvider,
}: {
  entry: Extract<AgentSettingEntry, { key: "default_provider" }>;
  saved: boolean;
  onUpdateDefaultProvider: AgentSettingsViewProps["onUpdateDefaultProvider"];
}) {
  const [providerId, setProviderId] = useState(entry.value.provider_id);
  const [model, setModel] = useState(entry.value.model);
  return (
    <div className="space-y-2">
      <p>
        <ProviderValue provider={entry.value} />
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          aria-label="Default provider id"
          placeholder="provider id"
          className="w-full rounded-lg border border-line bg-surface-elevated px-3 py-2 font-mono text-xs text-text placeholder:text-muted"
        />
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          aria-label="Default model"
          placeholder="model id"
          className="w-full rounded-lg border border-line bg-surface-elevated px-3 py-2 font-mono text-xs text-text placeholder:text-muted"
        />
      </div>
      {entry.recommended_default ? (
        <RecommendedDefaultLine>
          {entry.recommended_default.provider_id} · {entry.recommended_default.model}
        </RecommendedDefaultLine>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!providerId.trim() || !model.trim()}
          onClick={() =>
            onUpdateDefaultProvider({ provider_id: providerId.trim(), model: model.trim() })
          }
        >
          Save
        </Button>
        <SavedBadge visible={saved} />
      </div>
    </div>
  );
}

function ToolDefaultsEditor({
  entry,
  saved,
  onUpdateToolDefaults,
}: {
  entry: Extract<AgentSettingEntry, { key: "tool_defaults" }>;
  saved: boolean;
  onUpdateToolDefaults: AgentSettingsViewProps["onUpdateToolDefaults"];
}) {
  const [draft, setDraft] = useState(() => JSON.stringify(entry.value, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const apply = () => {
    try {
      const parsed: unknown = JSON.parse(draft);
      if (!Array.isArray(parsed)) {
        setParseError("Tool defaults are a JSON array of { tool_id, config } objects.");
        return;
      }
      setParseError(null);
      onUpdateToolDefaults(parsed as AgentToolDefault[]);
    } catch {
      setParseError("That is not valid JSON — nothing was sent.");
    }
  };
  return (
    <div className="space-y-2">
      <p className="font-mono text-xs text-muted">
        {entry.value.length ? `${entry.value.length} tool default(s)` : "no tool defaults"}
      </p>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={4}
        aria-label="Tool defaults JSON"
        spellCheck={false}
        className="w-full resize-y rounded-lg border border-line bg-surface-elevated px-3 py-2 font-mono text-xs text-text"
      />
      {parseError ? <p className="text-xs text-failed">{parseError}</p> : null}
      {entry.recommended_default && entry.recommended_default.length === 0 ? (
        <RecommendedDefaultLine>no tool defaults</RecommendedDefaultLine>
      ) : null}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={apply}>
          Save
        </Button>
        <SavedBadge visible={saved} />
      </div>
    </div>
  );
}

/** The ready-state editor: owns the disclosure + draft state for one snapshot. */
function AgentSettingsEditor({
  agentName,
  snapshot,
  pendingResetKey,
  defaultAdvancedOpen,
  savedKeys,
  onUpdateInstructions,
  onUpdateDefaultProvider,
  onUpdateToolDefaults,
  onResetClick,
  onResetConfirm,
  onResetCancel,
}: {
  agentName: string;
  snapshot: AgentSettingsSnapshot;
  pendingResetKey: PendingResetKey;
  defaultAdvancedOpen: boolean;
  savedKeys: readonly string[];
  onUpdateInstructions: AgentSettingsViewProps["onUpdateInstructions"];
  onUpdateDefaultProvider: AgentSettingsViewProps["onUpdateDefaultProvider"];
  onUpdateToolDefaults: AgentSettingsViewProps["onUpdateToolDefaults"];
  onResetClick: AgentSettingsViewProps["onResetClick"];
  onResetConfirm: AgentSettingsViewProps["onResetConfirm"];
  onResetCancel: AgentSettingsViewProps["onResetCancel"];
}) {
  const [advancedOpen, setAdvancedOpen] = useState(defaultAdvancedOpen);

  const visible: AgentSettingEntry[] = [];
  const advanced: AgentSettingEntry[] = [];
  for (const entry of snapshot.entries) {
    // D16 progressive disclosure: the placeholder-typed tool defaults (real
    // config arrives with the tool slices, S21+) sit behind the toggle.
    if (entry.key === "tool_defaults") {
      advanced.push(entry);
    } else {
      visible.push(entry);
    }
  }
  const saved = (entry: AgentSettingEntry) => savedKeys.includes(entry.key);

  return (
    <div className="space-y-4">
      {visible.map((entry) => (
        <EntryCard
          key={entry.key}
          entry={entry}
          pendingResetKey={pendingResetKey}
          onResetClick={onResetClick}
          onResetConfirm={onResetConfirm}
          onResetCancel={onResetCancel}
        >
          <EntryValue
            entry={entry}
            agentName={agentName}
            saved={saved(entry)}
            onUpdateInstructions={onUpdateInstructions}
            onUpdateDefaultProvider={onUpdateDefaultProvider}
            onUpdateToolDefaults={onUpdateToolDefaults}
          />
        </EntryCard>
      ))}

      {advanced.length > 0 ? (
        <div className="space-y-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "Hide advanced settings" : "Show advanced settings"}
          </Button>
          {advancedOpen
            ? advanced.map((entry) => (
                <EntryCard
                  key={entry.key}
                  entry={entry}
                  pendingResetKey={pendingResetKey}
                  onResetClick={onResetClick}
                  onResetConfirm={onResetConfirm}
                  onResetCancel={onResetCancel}
                  footer={
                    <p className="text-xs text-muted">
                      Placeholder — real tool configuration arrives with the tool slices (S21+).
                    </p>
                  }
                >
                  <EntryValue
                    entry={entry}
                    agentName={agentName}
                    saved={saved(entry)}
                    onUpdateInstructions={onUpdateInstructions}
                    onUpdateDefaultProvider={onUpdateDefaultProvider}
                    onUpdateToolDefaults={onUpdateToolDefaults}
                  />
                </EntryCard>
              ))
            : null}
        </div>
      ) : null}
    </div>
  );
}

export function AgentSettingsView(props: AgentSettingsViewProps) {
  const {
    agentName,
    snapshot,
    surfaceState,
    safeErrorMessage,
    onRetry,
    pendingResetKey,
    commandPending,
    commandError,
    defaultAdvancedOpen = false,
    savedKeys = [],
    onResetClick,
    onResetConfirm,
    onResetCancel,
  } = props;

  if (surfaceState === "loading") {
    return <SettingsSkeleton />;
  }
  if (surfaceState === "error" || !snapshot) {
    return (
      <div className="flex h-full items-center justify-center">
        <ErrorState
          safeMessage={safeErrorMessage ?? "The Agent settings could not be loaded."}
          onRetry={onRetry}
        />
      </div>
    );
  }

  // D39: the header avatar carries the SAME authored identity the snapshot's
  // ui_identity entry holds — one identity everywhere.
  const identityEntry = snapshot.entries.find((entry) => entry.key === "ui_identity");
  const identityForHeader = {
    agent_id: snapshot.agent_id,
    display_name: agentName,
    role_description: "Agent settings",
    ...(identityEntry?.key === "ui_identity" ? { ui_identity: identityEntry.value } : {}),
  };

  return (
    <div className="mx-auto max-w-xl">
      <div className="flex items-center gap-3">
        <AgentAvatar agent={identityForHeader} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg font-semibold tracking-tight text-text">
            {agentName}
          </h2>
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.16em] text-muted">
            <Settings2 className="size-3.5" aria-hidden="true" />
            Agent settings
          </p>
        </div>
        {/* Snapshot-level reset — armed and confirmed like the per-entry ones. */}
        {pendingResetKey === "all" ? (
          <span className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={onResetConfirm}>
              Confirm reset
            </Button>
            <Button variant="ghost" size="sm" onClick={onResetCancel}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => onResetClick("all")}
          >
            <RotateCcw aria-hidden="true" />
            Reset all settings
          </Button>
        )}
      </div>

      {commandPending ? (
        <p role="status" className="mt-4 text-sm text-sky">
          Saving…
        </p>
      ) : null}
      {commandError ? (
        <p role="alert" className="mt-4 flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {commandError}
        </p>
      ) : null}

      <div className="mt-6">
        <AgentSettingsEditor
          agentName={agentName}
          snapshot={snapshot}
          pendingResetKey={pendingResetKey}
          defaultAdvancedOpen={defaultAdvancedOpen}
          savedKeys={savedKeys}
          onUpdateInstructions={props.onUpdateInstructions}
          onUpdateDefaultProvider={props.onUpdateDefaultProvider}
          onUpdateToolDefaults={props.onUpdateToolDefaults}
          onResetClick={onResetClick}
          onResetConfirm={onResetConfirm}
          onResetCancel={onResetCancel}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live wiring: container resolution + queries + the D16 command surface
// ---------------------------------------------------------------------------

/** Honest configuration state: the D16 surface reads REAL rows, so it needs the container. */
function ContainerUnavailableState() {
  return (
    <div
      role="status"
      className="mx-auto my-8 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center"
    >
      <p className="text-sm text-text">
        Agent settings read your workspace's real Agent rows, so the workspace container must be
        running. Start your workspace and come back.
      </p>
    </div>
  );
}

export function AgentSettingsSurface({ agentId }: { agentId: string }) {
  const resolution = useContainerResolution();
  if (resolution.data?.kind !== "ready") {
    return <ContainerUnavailableState />;
  }
  return <RuntimeAgentSettings workspaceId={resolution.data.workspace_id} agentId={agentId} />;
}

/** The setting keys a settled command affected — the inline "Saved" targets. */
function commandTargetKeys(action: AgentSettingsAction): readonly string[] {
  switch (action.type) {
    case "agent_settings.update_instructions":
      return ["user_instructions"];
    case "agent_settings.update_default_provider":
      return ["default_provider"];
    case "agent_settings.update_tool_defaults":
      return ["tool_defaults"];
    case "agent_settings.reset_setting":
      return [action.setting_key];
    case "agent_settings.reset_all":
      return [...EDITABLE_AGENT_SETTING_KEYS];
  }
}

function RuntimeAgentSettings({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const { detailQuery, settingsQuery, commandMutation } = useAgentSettings(workspaceId, agentId);
  const [pendingResetKey, setPendingResetKey] = useState<PendingResetKey>(null);
  // §6.3 visible command feedback: the cards a settled command affected show a
  // brief "Saved" confirmation, cleared after a moment (and immediately when a
  // new command starts). The confirmation is driven by the SUBMIT handler and
  // the command's own settle callback — never by an effect — so a settled
  // command raises it once, and the next submit drops it.
  const [savedKeys, setSavedKeys] = useState<readonly string[]>([]);
  const savedTimerRef = useRef<number | null>(null);

  const clearSavedConfirmation = () => {
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
    setSavedKeys([]);
  };

  // Unmount cleanup ONLY (no state update in the effect body): the pending
  // confirmation timer must not outlive the surface.
  useEffect(
    () => () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    },
    [],
  );

  const pending = detailQuery.isPending || settingsQuery.isPending;
  const failed = detailQuery.isError || settingsQuery.isError;
  const surfaceState: AgentSettingsSurfaceState = pending ? "loading" : failed ? "error" : "ready";
  const safeErrorMessage = failed
    ? safeRuntimeMessage(
        detailQuery.error ?? settingsQuery.error,
        "The Agent settings could not be loaded.",
      )
    : undefined;
  const retry = () => {
    setPendingResetKey(null);
    void detailQuery.refetch();
    void settingsQuery.refetch();
  };

  const submit = (action: Parameters<typeof commandMutation.mutate>[0]) => {
    // A new command starts: the previous confirmation goes away immediately.
    clearSavedConfirmation();
    commandMutation.mutate(action, {
      onSuccess: () => {
        // The command SETTLED successfully — show the confirmation on the cards
        // it affected, for a moment.
        setSavedKeys(commandTargetKeys(action));
        if (savedTimerRef.current !== null) {
          window.clearTimeout(savedTimerRef.current);
        }
        savedTimerRef.current = window.setTimeout(() => {
          savedTimerRef.current = null;
          setSavedKeys([]);
        }, 2500);
      },
    });
  };

  return (
    <AgentSettingsView
      agentName={detailQuery.data?.display_name ?? agentId}
      snapshot={settingsQuery.data ?? null}
      surfaceState={surfaceState}
      safeErrorMessage={safeErrorMessage}
      onRetry={retry}
      pendingResetKey={pendingResetKey}
      commandPending={commandMutation.isPending}
      savedKeys={savedKeys}
      commandError={
        commandMutation.isError
          ? safeRuntimeMessage(commandMutation.error, "The settings command was not accepted.")
          : undefined
      }
      onUpdateInstructions={(value) =>
        submit({ type: "agent_settings.update_instructions", user_instructions: value })
      }
      onUpdateDefaultProvider={(provider) =>
        submit({ type: "agent_settings.update_default_provider", default_provider: provider })
      }
      onUpdateToolDefaults={(tool_defaults) =>
        submit({ type: "agent_settings.update_tool_defaults", tool_defaults })
      }
      onResetClick={setPendingResetKey}
      onResetConfirm={() => {
        const armed = pendingResetKey;
        setPendingResetKey(null);
        if (armed === "all") {
          submit({ type: "agent_settings.reset_all" });
        } else if (armed) {
          submit({ type: "agent_settings.reset_setting", setting_key: armed });
        }
      }}
      onResetCancel={() => setPendingResetKey(null)}
    />
  );
}
