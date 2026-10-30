"use client";

import { Check, ChevronDown, Settings2, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import type { ProviderView } from "@shera-bot/contracts";

import { Button } from "@/components/ui/button";
import {
  useConversationOverride,
  useEffectiveProvider,
  useProviders,
  safeProviderMessage,
  type EffectiveProviderState,
} from "@/lib/provider-data";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The chat header's model control (UI_DESIGN §S3; AC11). Shows the
 * conversation's EFFECTIVE provider/model — the runtime's read-after-write
 * answer, with its source (the Agent default or this conversation's
 * override) — and opens an inline panel that sets or clears the
 * per-conversation override.
 *
 * Honesty rules: the collapsed button renders the effective union verbatim —
 * "No provider" when the runtime reports an unconfigured resolution, with the
 * panel carrying the runtime's own safe_message and the settings link (D17:
 * a clear configuration state, never a fabricated default). The picker lists
 * only ENABLED catalog entries; a disabled provider cannot be applied to new
 * turns. Below md the control collapses (the Agent identity keeps width
 * priority at 360px — the same breakpoint contract as the S12 presence chip).
 *
 * The panel is a plain, properly labelled disclosure (no portal needed — the
 * header is not an overflow:hidden context) closed by Escape or the toggle;
 * focus returns to the toggle on close so the keyboard pass stays intact.
 */

export interface ModelControlProps {
  state: EffectiveProviderState;
  /** The masked catalog — only enabled entries are applicable to new turns. */
  providers: ProviderView[];
  onApplyOverride: (providerId: string, model: string | null) => void;
  onClearOverride: () => void;
  overridePending?: boolean | undefined;
  overrideError?: string | undefined;
  /** Providers may still be loading when the chat renders. */
  providersState?: "loading" | "ready" | "error" | undefined;
}

const SOURCE_LABEL = {
  agent_default: "Agent default",
  conversation_override: "Conversation override",
} as const;

export function ModelControl({
  state,
  providers,
  onApplyOverride,
  onClearOverride,
  overridePending = false,
  overrideError,
  providersState = "ready",
}: ModelControlProps) {
  const [open, setOpen] = useState(false);
  const [draftProviderId, setDraftProviderId] = useState("");
  const [draftModel, setDraftModel] = useState("");
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const applicable = providers.filter((provider) => provider.status === "enabled");

  // Every close path resets the draft: a re-opened panel preselects nothing
  // until the user chooses (never a guessed override).
  const closeWithFocus = () => {
    setOpen(false);
    setDraftProviderId("");
    setDraftModel("");
    toggleRef.current?.focus();
  };

  const apply = () => {
    if (!draftProviderId) return;
    onApplyOverride(draftProviderId, draftModel.trim() ? draftModel.trim() : null);
    closeWithFocus();
  };

  const configured = state.kind === "configured";
  const label = configured ? `${state.displayName} · ${state.model}` : "No provider";

  return (
    <div className="relative hidden shrink-0 md:block">
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-controls={panelId}
        onClick={() => {
          if (open) {
            closeWithFocus();
          } else {
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            closeWithFocus();
          }
        }}
        title={
          configured
            ? `Effective provider for this conversation (${SOURCE_LABEL[state.source]}) — override it`
            : "No provider is configured for this conversation — open for details"
        }
        className={cn(
          "flex max-w-56 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-surface-elevated",
          configured ? "border-line text-muted" : "border-approval/40 text-approval",
        )}
      >
        <span className="truncate font-mono">{label}</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-label="Provider and model for this conversation"
          className="absolute end-0 top-full z-40 mt-2 w-80 rounded-xl border border-line bg-surface p-4 shadow-[0_16px_40px_-16px_rgba(2,6,17,0.9)]"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-mono text-xs text-text">{label}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                {configured
                  ? SOURCE_LABEL[state.source]
                  : "This conversation has no usable provider yet."}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={closeWithFocus} aria-label="Close">
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          </div>

          {state.kind === "unconfigured" ? (
            <p
              role="status"
              className="mt-3 rounded-lg border border-line bg-surface-elevated p-3 text-xs text-approval"
            >
              {state.safeMessage}
            </p>
          ) : null}

          <div className="mt-3 space-y-2">
            <label htmlFor={`${panelId}-provider`} className="block text-xs font-medium text-muted">
              Override for this conversation
            </label>
            <select
              id={`${panelId}-provider`}
              value={draftProviderId}
              onChange={(event) => {
                setDraftProviderId(event.target.value);
                const chosen = applicable.find((provider) => provider.id === event.target.value);
                setDraftModel(chosen ? chosen.default_model_id : "");
              }}
              className="w-full rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-text"
            >
              <option value="">Choose a provider…</option>
              {providersState === "loading" ? <option disabled>Loading providers…</option> : null}
              {applicable.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.display_name} ({provider.default_model_id})
                </option>
              ))}
            </select>
            {draftProviderId ? (
              <div className="space-y-1.5">
                <label
                  htmlFor={`${panelId}-model`}
                  className="block text-xs font-medium text-muted"
                >
                  Model
                </label>
                <input
                  id={`${panelId}-model`}
                  value={draftModel}
                  onChange={(event) => setDraftModel(event.target.value)}
                  className="w-full rounded-lg border border-line bg-surface-elevated px-3 py-2 font-mono text-xs text-text"
                />
              </div>
            ) : null}
            {providersState === "error" ? (
              <p role="alert" className="text-xs text-failed">
                The provider catalog could not be read — overrides are unavailable right now.
              </p>
            ) : null}
            {overrideError ? (
              <p role="alert" className="text-xs text-failed">
                {overrideError}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={apply} disabled={!draftProviderId || overridePending}>
                Apply override
              </Button>
              {state.kind === "configured" && state.source === "conversation_override" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onClearOverride();
                    closeWithFocus();
                  }}
                  disabled={overridePending}
                >
                  Clear override
                </Button>
              ) : null}
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-muted">
              <Check className="size-3" aria-hidden="true" />
              Applies to the next turn — the Agent&apos;s default is unchanged.
            </p>
            <p className="text-[11px] text-muted">
              <a
                href={routes.settings("providers")}
                className="inline-flex items-center gap-1 text-sky underline underline-offset-4 hover:text-cool-highlight"
              >
                <Settings2 className="size-3" aria-hidden="true" />
                Providers &amp; models settings
              </a>
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live wiring: the runtime surfaces' one-line assembly of the control
// ---------------------------------------------------------------------------

/**
 * The chat surfaces' assembly of the header model control (S23): the same
 * effective-provider readout the surface hands the composer (shared query
 * key — one poll, two consumers), the masked catalog for the picker, and the
 * AC11 override mutation through the ONE allowlisted surface. Until the
 * conversation id resolves there is no override target, so the control is
 * simply not mounted (never a half-working control, the S17 toggle rule).
 */
export function ConversationModelControl({
  workspaceId,
  conversationId,
}: {
  workspaceId: string;
  conversationId: string | null;
}) {
  const catalog = useProviders(workspaceId);
  const effective = useEffectiveProvider(workspaceId, conversationId);
  const override = useConversationOverride(workspaceId, conversationId);

  if (conversationId === null) {
    return null;
  }

  return (
    <ModelControl
      state={effective.state}
      providers={catalog.providers}
      providersState={catalog.state}
      overridePending={override.isPending}
      overrideError={
        override.isError
          ? safeProviderMessage(override.error, "The override was not accepted.")
          : undefined
      }
      onApplyOverride={(providerId, model) => override.mutate({ providerId, model })}
      onClearOverride={() => override.mutate({ providerId: null, model: null })}
    />
  );
}
