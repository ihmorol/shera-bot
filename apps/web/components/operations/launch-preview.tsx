"use client";

import { RotateCcw, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { OperationLaunchPreview, OperationPreviewRosterSource } from "@shera-bot/contracts";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { AgentRosterSummary } from "@/lib/agent-api";
import { useAgentRoster } from "@/lib/agent-data";
import { agentIdentityFromSummary } from "@/lib/operation-api";
import type { OperationDefinitionSummary } from "@/lib/operation-preview-api";
import {
  useOperationDefinitions,
  useOperationLaunchPreview,
  type PreviewSurfaceState,
} from "@/lib/operation-preview-data";
import { cn } from "@/lib/utils";

/**
 * The D30 Operation launch preview surfaces (S15 chunk 2, UI_DESIGN §S5):
 *
 *  - `OperationLaunchMenu` — the "From the pack…" launcher on the Operations
 *    surface: one entry per pinned-pack definition, each opening the preview
 *    (D30: templates launch → preview, never straight to a chat).
 *  - `OperationLaunchPreviewModal` — the gate itself: ALL EIGHT groups
 *    rendered from the runtime's read model (purpose, agents, skills,
 *    connectors, provider/model, estimated credits, approval requirements,
 *    expected outputs), presented as a full-screen modal on desktop and a
 *    full page on mobile (D30). Roster edits drive the read-only override
 *    params — the server recomputes; nothing here writes anything.
 *  - `OperationPackLauncher` — the wired composition (definitions + roster
 *    + preview hooks + modal state) the S6 creation surface mounts beside
 *    S14's untouched ad-hoc form.
 *
 * CHUNK 3 CONTRACT — the footer: Cancel closes the modal (side-effect free);
 * Launch is rendered INERT on purpose, marked `data-testid="launch-inert"`
 * with its title naming the follow-up. The launch/confirm behavior, the
 * captures, and the gates land with chunk 3, which replaces the inert
 * marker. Nothing in this component issues a command — the only network
 * traffic until chunk 3 is the GET pair behind the read model (D30/AC6: the
 * preview is a safety gate where NOTHING executes before confirmation).
 *
 * Honesty rules carried from the payload (G2/G3/G4): connectors render the
 * fixed "Not configured" status and the word "Connected" never appears; the
 * runtime's provenance notes render verbatim (never paraphrased); a missing
 * title falls back to the pack id; expected outputs render the honest null
 * rather than an invented artifact; no copy promises an outcome ("will
 * execute"-class phrasing is regex-audited in the suite).
 */

/** The honest one-line provenance of the previewed roster (D30 co-planning). */
const ROSTER_SOURCE_NOTES: Record<OperationPreviewRosterSource, string> = {
  pack_default: "The pack's recommended roster.",
  definition_override: "The pack definition adjusts the recommended roster.",
  request_override:
    "Adjusted in this preview — the server recomputed every section from your edits; nothing is saved.",
};

function PreviewSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="rounded-xl border border-line bg-surface p-4">
      <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">{label}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function PreviewSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-testid="launch-preview-skeleton"
      className="flex flex-col gap-4 px-4 py-4 lg:px-6"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="rounded-xl border border-line bg-surface p-4">
          <div className="h-3 w-28 animate-pulse rounded bg-surface-elevated" />
          <div className="mt-3 h-2.5 w-full animate-pulse rounded bg-surface-elevated" />
          <div className="mt-1.5 h-2.5 w-2/3 animate-pulse rounded bg-surface-elevated" />
        </div>
      ))}
    </div>
  );
}

export interface OperationLaunchPreviewModalProps {
  /** The read model; null while loading or after a first-load failure. */
  preview: OperationLaunchPreview | null;
  state: PreviewSurfaceState;
  safeErrorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** The workspace's pack identities — the SAME picker the S14 form uses. */
  identities: AgentRosterSummary[];
  /** True while an override refetch is in flight — editing controls disable. */
  overridePending: boolean;
  /** The safe copy of a refused override, shown beside the last good preview. */
  overrideErrorMessage: string | null;
  onRosterToggle: (agentId: string, include: boolean) => void;
  /** An Agent id, or the literal "none" (D49 peer-to-peer). */
  onCoordinatorChange: (coordinatorAgentId: string) => void;
  onResetOverrides: () => void;
  /** Cancel/Close/Escape — side-effect free (D30: nothing has started). */
  onClose: () => void;
}

export function OperationLaunchPreviewModal({
  preview,
  state,
  safeErrorMessage,
  onRetry,
  identities,
  overridePending,
  overrideErrorMessage,
  onRosterToggle,
  onCoordinatorChange,
  onResetOverrides,
  onClose,
}: OperationLaunchPreviewModalProps) {
  const title = preview ? `Launch ${preview.definition.title}` : "Launch preview";
  const rosterIds = new Set(preview?.roster.agents.map((agent) => agent.agent_id) ?? []);
  const nameOf = (agentId: string): string =>
    preview?.roster.agents.find((agent) => agent.agent_id === agentId)?.display_name ?? agentId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Operation launch preview"
      data-testid="launch-preview-modal"
      tabIndex={-1}
      autoFocus
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 overflow-y-auto bg-black/50 lg:p-8"
    >
      {/* Full page on mobile; the desktop modal panel is centered over the
          backdrop only from lg up (D30 presentation). */}
      <div
        className={cn(
          "mx-auto flex min-h-dvh w-full max-w-3xl flex-col bg-canvas shadow-xl",
          "lg:my-8 lg:min-h-0 lg:rounded-2xl lg:border lg:border-line",
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-4 lg:px-6">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-semibold tracking-tight text-text">
              {title}
            </h2>
            <p className="mt-0.5 font-mono text-xs uppercase tracking-[0.16em] text-muted">
              {preview
                ? `v${preview.definition.version} · pack ${preview.pack.pack_id} v${preview.pack.pack_version} · `
                : null}
              Nothing runs until you confirm
            </p>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close preview" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </header>

        {state === "loading" ? (
          <PreviewSkeleton />
        ) : state === "error" || !preview ? (
          <div className="px-4 py-10 lg:px-6">
            <ErrorState
              safeMessage={safeErrorMessage ?? "The launch preview could not be loaded."}
              onRetry={onRetry}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4 lg:px-6">
            {/* 1. Purpose — pack-authored, verbatim (D30 group 1). */}
            <PreviewSection label="Purpose">
              <p className="text-sm text-text">{preview.definition.purpose}</p>
            </PreviewSection>

            {/* 2. Agents — the recommended roster with the coordinator marked,
                edited through the S14 identities picker; every edit is an
                override the SERVER recomputes (D30/D42/D46, D36 same-pack). */}
            <PreviewSection label="Agents">
              <p data-testid="roster-source" className="text-xs text-muted">
                {ROSTER_SOURCE_NOTES[preview.roster.source]}
              </p>
              {preview.roster.source === "request_override" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-1"
                  aria-label="Back to the pack-recommended roster"
                  disabled={overridePending}
                  onClick={onResetOverrides}
                >
                  <RotateCcw aria-hidden="true" />
                  Back to the pack's recommendation
                </Button>
              ) : null}

              <ul className="mt-3 flex flex-col gap-2">
                {preview.roster.agents.map((agent) => {
                  const identity = identities.find(
                    (candidate) => candidate.agent_id === agent.agent_id,
                  );
                  return (
                    <li key={agent.agent_id} className="flex items-start gap-3">
                      {identity ? (
                        <AgentAvatar
                          agent={{
                            ...agentIdentityFromSummary(identity),
                            // The read model's name is authoritative; the
                            // identity only supplies the authored avatar.
                            agent_id: agent.agent_id,
                            display_name: agent.display_name,
                          }}
                          size="sm"
                        />
                      ) : null}
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm text-text">
                          <span className="truncate">{agent.display_name}</span>
                          {agent.is_coordinator ? (
                            <span className="shrink-0 rounded-full border border-line-accent px-1.5 py-0.5 text-[11px] text-sky">
                              Coordinator
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted">{agent.role}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {overrideErrorMessage ? (
                <p
                  role="alert"
                  data-testid="override-error"
                  className="mt-3 rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-failed"
                >
                  {overrideErrorMessage}
                </p>
              ) : null}

              {identities.length === 0 ? (
                <p className="mt-3 text-xs text-muted">
                  The workspace roster could not be loaded, so roster editing is unavailable.
                </p>
              ) : (
                <>
                  <fieldset className="mt-4">
                    <legend className="text-sm font-medium text-text">
                      Agents on this preview
                    </legend>
                    <p className="mt-1 text-xs text-muted">
                      Edits refetch the preview — the runtime recomputes every group; nothing is
                      saved.
                    </p>
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {identities.map((identity) => {
                        const onRoster = rosterIds.has(identity.agent_id);
                        // The runtime's min-1 rule, enforced client-side too:
                        // the last roster Agent can never be unchecked (the
                        // emptied override is a typed 400 at the backend).
                        const lastMember = onRoster && rosterIds.size === 1;
                        return (
                          <li key={identity.agent_id}>
                            <label className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2">
                              <input
                                type="checkbox"
                                className="size-4"
                                aria-label={`Include ${identity.display_name}`}
                                checked={onRoster}
                                aria-checked={onRoster}
                                disabled={overridePending || lastMember}
                                title={
                                  lastMember ? "An Operation needs at least one Agent." : undefined
                                }
                                onChange={(event) =>
                                  onRosterToggle(identity.agent_id, event.target.checked)
                                }
                              />
                              <AgentAvatar agent={agentIdentityFromSummary(identity)} size="sm" />
                              <span className="min-w-0">
                                <span className="block truncate text-sm text-text">
                                  {identity.display_name}
                                </span>
                                <span className="block truncate text-xs text-muted">
                                  {identity.role_description}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>

                  <fieldset className="mt-4">
                    <legend className="text-sm font-medium text-text">
                      Coordinator for this preview
                    </legend>
                    <div
                      role="radiogroup"
                      aria-label="Coordinator for this preview"
                      className="mt-2 flex flex-col gap-1.5"
                    >
                      {identities.map((identity) => {
                        const checked = preview.roster.coordinator_agent_id === identity.agent_id;
                        return (
                          <label
                            key={identity.agent_id}
                            className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2"
                          >
                            <input
                              type="radio"
                              name="preview-coordinator"
                              className="size-4"
                              aria-label={`Coordinator: ${identity.display_name}`}
                              checked={checked}
                              aria-checked={checked}
                              disabled={overridePending}
                              onChange={() => onCoordinatorChange(identity.agent_id)}
                            />
                            <span className="min-w-0 truncate text-sm text-text">
                              {identity.display_name}
                            </span>
                          </label>
                        );
                      })}
                      <label className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2">
                        <input
                          type="radio"
                          name="preview-coordinator"
                          className="size-4"
                          aria-label="No coordinator (peer-to-peer)"
                          checked={preview.roster.coordinator_agent_id === "none"}
                          aria-checked={preview.roster.coordinator_agent_id === "none"}
                          disabled={overridePending}
                          onChange={() => onCoordinatorChange("none")}
                        />
                        <span className="text-sm text-text">No coordinator (peer-to-peer)</span>
                      </label>
                    </div>
                    <p className="mt-1.5 text-xs text-muted">
                      The coordinator role is not a roster assignment (D46) and can be changed on
                      the Operation later.
                    </p>
                  </fieldset>
                </>
              )}
            </PreviewSection>

            {/* 3. Skills — per Agent, from the pinned pack (D38); a missing
                catalog title falls back to the pack id, never a made-up name. */}
            <PreviewSection label="Skills">
              <ul className="flex flex-col gap-3">
                {preview.skills.agents.map((entry) => (
                  <li key={entry.agent_id}>
                    <p className="text-sm text-text">{nameOf(entry.agent_id)}</p>
                    {entry.skills.length === 0 ? (
                      <p className="text-xs text-muted">none</p>
                    ) : (
                      <ul className="mt-1 flex flex-wrap gap-1.5">
                        {entry.skills.map((skill) => (
                          <li
                            key={skill.skill_id}
                            className="rounded-full border border-line px-2 py-0.5 text-xs text-text"
                          >
                            {skill.title ?? skill.skill_id}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">From the pinned pack only.</p>
            </PreviewSection>

            {/* 4. Connectors — recommended, never auto-installed (D38); the
                payload cannot express a connected connector, and this surface
                never introduces the claim. */}
            <PreviewSection label="Connectors">
              {preview.connectors.items.length === 0 ? (
                <p className="text-sm text-muted">The pack recommends no connectors.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {preview.connectors.items.map((connector) => (
                    <li
                      key={connector.connector_id}
                      className="flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-text">
                          {connector.title ?? connector.connector_id}
                          {connector.version ? (
                            <span className="ml-1.5 font-mono text-xs text-muted">
                              v{connector.version}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted">{connector.note}</p>
                      </div>
                      <span
                        data-testid="connector-status"
                        className="shrink-0 rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted"
                      >
                        Not configured
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </PreviewSection>

            {/* 5. Provider and model — the effective saved default per Agent
                with the runtime's honest note verbatim (configured is
                literally false until S23; never a credential, G3). */}
            <PreviewSection label="Provider and model">
              <ul className="flex flex-col gap-2">
                {preview.providers.agents.map((provider) => (
                  <li key={provider.agent_id}>
                    <p className="text-sm text-text">{nameOf(provider.agent_id)}</p>
                    <p className="font-mono text-xs text-text">
                      {provider.provider_id} · {provider.model}
                    </p>
                    <p className="text-xs text-muted">
                      {provider.source === "agent_settings"
                        ? "from Agent settings"
                        : "from the pack default"}{" "}
                      — {provider.note}
                    </p>
                  </li>
                ))}
              </ul>
            </PreviewSection>

            {/* 6. Estimated credits — a BOUNDED RANGE with the D20 settlement
                note verbatim; custom-provider Agents consume no Shera credits. */}
            <PreviewSection label="Estimated credits">
              <p data-testid="credits-range" className="text-sm text-text">
                {preview.estimated_credits.min_credits}–{preview.estimated_credits.max_credits}{" "}
                Shera credits
              </p>
              <p className="mt-1 text-xs text-muted">{preview.estimated_credits.formula}</p>
              <p data-testid="settlement-note" className="mt-2 text-xs text-muted">
                {preview.estimated_credits.settlement_note}
              </p>
              {preview.estimated_credits.custom_provider_agents.length > 0 ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {preview.estimated_credits.custom_provider_agents.map((agentId) => (
                    <li
                      key={agentId}
                      data-testid="custom-provider-note"
                      className="text-xs text-text"
                    >
                      {nameOf(agentId)} runs on a custom provider — no Shera credits.
                    </li>
                  ))}
                </ul>
              ) : null}
            </PreviewSection>

            {/* 7. Approval requirements — the D35 classes named, the mapping
                note verbatim; classes are NAMED, never promised outcomes. */}
            <PreviewSection label="Approval requirements">
              <ul className="flex flex-col gap-2">
                {preview.approval_requirements.mapping.map((entry) => (
                  <li key={entry.risk_class} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-text">{entry.risk_class}</p>
                      <p className="text-xs text-muted">{entry.tool_ids.join(", ")}</p>
                    </div>
                    <span
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 text-[11px]",
                        entry.behavior === "approval_required"
                          ? "border-approval text-approval"
                          : "border-line text-muted",
                      )}
                    >
                      {entry.behavior === "approval_required"
                        ? "pauses for your approval"
                        : "no approval needed"}
                    </span>
                  </li>
                ))}
              </ul>
              <p data-testid="mapping-note" className="mt-2 text-xs text-muted">
                {preview.approval_requirements.mapping_note}
              </p>
            </PreviewSection>

            {/* 8. Expected outputs — the statement with its honest source, or
                the honest null. Never invented (G4). */}
            <PreviewSection label="Expected outputs">
              {preview.expected_outputs === null ? (
                <p data-testid="expected-outputs-null" className="text-sm text-muted">
                  The pack does not declare expected outputs for this Operation.
                </p>
              ) : (
                <div>
                  <p data-testid="expected-outputs-statement" className="text-sm text-text">
                    {preview.expected_outputs.statement}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {preview.expected_outputs.source === "definition"
                      ? "from the definition"
                      : "derived from the purpose"}
                    {preview.expected_outputs.reason
                      ? ` — ${preview.expected_outputs.reason}`
                      : null}
                  </p>
                </div>
              )}
            </PreviewSection>
          </div>
        )}

        {/* Footer — Cancel is the only live action in chunk 2 (side-effect
            free close). Launch is the chunk-3 contract marker: see the header
            comment; chunk 3 replaces the inert marker with the confirm flow. */}
        <footer className="mt-auto flex items-center justify-between gap-4 border-t border-line bg-surface px-4 py-3 lg:px-6">
          <p className="text-xs text-muted">Nothing runs until you confirm.</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button data-testid="launch-inert" title="Launch wiring lands with the confirm flow">
              Launch Operation
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The "From the pack…" launcher (the §S5 entry point on the Operations surface)
// ---------------------------------------------------------------------------

export interface OperationLaunchMenuProps {
  definitions: OperationDefinitionSummary[];
  state: PreviewSurfaceState;
  safeErrorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  onPick: (operationDefinitionId: string) => void;
  className?: string;
}

export function OperationLaunchMenu({
  definitions,
  state,
  safeErrorMessage,
  onRetry,
  onPick,
  className,
}: OperationLaunchMenuProps) {
  return (
    <section aria-label="From the pack" className={className}>
      <h3 className="font-display text-base font-semibold tracking-tight text-text">
        From the pack…
      </h3>
      <p className="mt-0.5 text-xs text-muted">
        Nothing runs until you confirm — every launch opens the preview gate first.
      </p>

      {state === "loading" ? (
        <div
          aria-hidden="true"
          data-testid="launch-menu-skeleton"
          className="mt-3 flex flex-col gap-2"
        >
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-xl border border-line bg-surface"
            />
          ))}
        </div>
      ) : state === "error" ? (
        <div className="mt-3">
          <ErrorState
            safeMessage={safeErrorMessage ?? "The pack's Operations could not be loaded."}
            onRetry={onRetry}
          />
        </div>
      ) : definitions.length === 0 ? (
        <p className="mt-3 text-sm text-muted">The pinned pack declares no Operations.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {definitions.map((definition) => (
            <li key={definition.operation_definition_id}>
              <button
                type="button"
                aria-label={`Launch ${definition.title} from the pack`}
                onClick={() => onPick(definition.operation_definition_id)}
                className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-accent hover:bg-surface-elevated"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-sm font-medium text-text">{definition.title}</span>
                  <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                    v{definition.version}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted">
                  {definition.purpose_summary}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The wired composition the S6 creation surface mounts (S14's ad-hoc form
// stays untouched beside it)
// ---------------------------------------------------------------------------

export function OperationPackLauncher({ workspaceId }: { workspaceId: string }) {
  const menu = useOperationDefinitions(workspaceId);
  const roster = useAgentRoster(workspaceId);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(null);
  const preview = useOperationLaunchPreview(workspaceId, selectedDefinitionId ?? "");

  return (
    <div>
      <OperationLaunchMenu
        definitions={menu.definitions}
        state={menu.state}
        safeErrorMessage={menu.safeErrorMessage}
        onRetry={menu.refetch}
        onPick={setSelectedDefinitionId}
        className="mx-auto w-full max-w-md px-4 pt-8"
      />
      {selectedDefinitionId !== null ? (
        <OperationLaunchPreviewModal
          preview={preview.preview}
          state={preview.state}
          safeErrorMessage={preview.safeErrorMessage}
          onRetry={preview.refetch}
          identities={roster.agents}
          overridePending={preview.overridePending}
          overrideErrorMessage={preview.overrideErrorMessage}
          onRosterToggle={(agentId, include) => {
            if (!preview.preview) return;
            const current = preview.preview.roster.agents.map((agent) => agent.agent_id);
            const next = include
              ? [...new Set([...current, agentId])]
              : current.filter((id) => id !== agentId);
            // Never send an emptied override — the runtime's min-1 rule is a
            // typed 400; the UI keeps the last roster Agent unremovable.
            if (next.length === 0) return;
            preview.applyOverrides({ ...preview.overrides, roster_agent_ids: next });
          }}
          onCoordinatorChange={(coordinatorAgentId) =>
            preview.applyOverrides({
              ...preview.overrides,
              coordinator_agent_id: coordinatorAgentId,
            })
          }
          onResetOverrides={() => preview.resetOverrides()}
          onClose={() => setSelectedDefinitionId(null)}
        />
      ) : null}
    </div>
  );
}
