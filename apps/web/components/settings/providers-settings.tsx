"use client";

import { AlertTriangle, Check, PlugZap, Plus, RefreshCw } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { useContainerResolution } from "@/lib/container-connection";

import type { ProviderView } from "@shera-bot/contracts";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/shell/states";
import {
  useProviderActions,
  useProviders,
  safeProviderMessage,
  type ConnectionTestState,
} from "@/lib/provider-data";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The S23 Providers & models settings surface (UI_DESIGN §S9 row; PRD §9;
 * AC10; D17, D22; G3). The catalog renders the masked wire view ONLY — the
 * credential hint is the store-time hint (at most the final four characters),
 * and a stored credential is replaceable or revocable, never re-displayed
 * (there is no read-back route and no read-back control). The add-provider
 * form carries every PRD §9 custom field; the credential field accepts the
 * secret exactly once and clears itself on submit. The connection test makes
 * ONE real minimal request and renders the honest typed result — success with
 * latency, or the runtime's redacted failure (D17: a test that cannot fail is
 * a recorded mockup defect this surface refuses to repeat).
 *
 * Mutations go through the typed provider client (lib/provider-api.ts) via
 * the useProviderActions hooks; every settled answer is the runtime's
 * read-after-write masked view. Per-Agent default assignment lives on each
 * Agent's settings surface; the per-conversation override lives in the chat
 * header — this surface links to both rather than duplicating them (D39: one
 * setting, one surface).
 */

export type ProvidersSurfaceState = "ready" | "loading" | "error";

export interface ProvidersSettingsViewProps {
  providers: ProviderView[];
  surfaceState: ProvidersSurfaceState;
  /** Redacted message for the error state (D23 rule 4). */
  safeErrorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** Armed action (id + kind) awaiting its confirm, or null. */
  pendingConfirm?: { providerId: string; kind: "revoke" } | null | undefined;
  /** Provider ids with a settled "Saved" confirmation (§6.3). */
  savedProviderIds?: readonly string[] | undefined;
  lastTestResult?: ConnectionTestState | null | undefined;
  configurePending: boolean;
  configureError?: string | undefined;
  /** Provider id currently busy with a replace/revoke/status mutation. */
  busyProviderId?: string | null | undefined;
  busyError?: string | undefined;
  onConfigure: (input: {
    display_name: string;
    protocol: ProviderView["protocol"];
    base_url: string | null;
    api_mode: "api_key" | "no_key";
    credential: string | null;
    default_model_id: string;
    organization: string | null;
    project: string | null;
    headers: Record<string, string>;
    request_params: Record<string, string | number | boolean>;
  }) => void;
  onReplaceCredential: (providerId: string, credential: string) => void;
  onRevoke: (providerId: string) => void;
  onSetStatus: (providerId: string, enabled: boolean) => void;
  onConnectionTest: (providerId: string) => void;
  onConfirmClick?: ((providerId: string) => void) | undefined;
  onConfirmCancel?: (() => void) | undefined;
  /** Test/first-render override for the add-provider disclosure. */
  defaultAddOpen?: boolean | undefined;
}

const PROTOCOLS: ProviderView["protocol"][] = [
  "openai",
  "anthropic",
  "google",
  "ollama",
  "openai-compatible",
];

/** Which protocols normally ride a local endpoint (no key needed). */
const NO_KEY_DEFAULT_PROTOCOLS: ProviderView["protocol"][] = ["ollama", "openai-compatible"];

function protocolPlaceholder(protocol: ProviderView["protocol"]): string {
  switch (protocol) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "google":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "openai-compatible":
      return "http://127.0.0.1:8000/v1";
  }
}

function protocolModelPlaceholder(protocol: ProviderView["protocol"]): string {
  switch (protocol) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-sonnet-4-5";
    case "google":
      return "gemini-2.0-flash";
    case "ollama":
      return "llama3.1:8b";
    case "openai-compatible":
      return "model-id";
  }
}

function StatusChip({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px]",
        enabled ? "border-line-accent text-sky" : "border-line text-muted",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", enabled ? "bg-sky" : "bg-muted")}
      />
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function SavedBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span role="status" className="flex items-center gap-1 text-xs text-live">
      <Check className="size-3.5" aria-hidden="true" />
      Saved
    </span>
  );
}

function TestResultNote({ result }: { result: ConnectionTestState }) {
  if (result.state === "pending") {
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-sky">
        <PlugZap className="size-3.5 motion-safe:animate-pulse" aria-hidden="true" />
        Testing — one real request is on its way…
      </p>
    );
  }
  if (result.state === "ok" && result.result.ok) {
    return (
      <p role="status" className="flex items-center gap-1.5 text-xs text-live">
        <Check className="size-3.5" aria-hidden="true" />
        Connection OK — {result.result.checked_model} answered in {result.result.latency_ms} ms.
      </p>
    );
  }
  if (!result.result.ok) {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-failed">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        {result.result.safe_message}
      </p>
    );
  }
  return null;
}

function Field({
  label,
  htmlFor,
  optional = false,
  children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted">
        {label}
        {optional ? <span className="ms-1 font-normal">— optional</span> : null}
      </label>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-text placeholder:text-muted";

/** The PRD §9 custom-provider form. Owns its draft state; resets on success. */
function AddProviderForm({
  onConfigure,
  pending,
  safeError,
  defaultOpen,
}: {
  onConfigure: ProvidersSettingsViewProps["onConfigure"];
  pending: boolean;
  safeError?: string | undefined;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [displayName, setDisplayName] = useState("");
  const [protocol, setProtocol] = useState<ProviderView["protocol"]>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [noKeyMode, setNoKeyMode] = useState(false);
  const [credentialDraft, setCredentialDraft] = useState("");
  const [modelId, setModelId] = useState("");
  const [organization, setOrganization] = useState("");
  const [project, setProject] = useState("");
  const [headersDraft, setHeadersDraft] = useState("{}");
  const [paramsDraft, setParamsDraft] = useState("{}");
  const [parseError, setParseError] = useState<string | null>(null);
  const formId = useId();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let headers: Record<string, string>;
    let requestParams: Record<string, string | number | boolean>;
    try {
      const parsedHeaders: unknown = JSON.parse(headersDraft);
      if (
        parsedHeaders === null ||
        typeof parsedHeaders !== "object" ||
        Array.isArray(parsedHeaders)
      ) {
        setParseError("Headers must be a JSON object of string values — nothing was sent.");
        return;
      }
      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (typeof value !== "string") {
          setParseError(`Header "${key}" must be a string — nothing was sent.`);
          return;
        }
      }
      headers = parsedHeaders as Record<string, string>;
      const parsedParams: unknown = JSON.parse(paramsDraft);
      if (
        parsedParams === null ||
        typeof parsedParams !== "object" ||
        Array.isArray(parsedParams)
      ) {
        setParseError(
          "Request parameters must be a JSON object of string/number/boolean values — nothing was sent.",
        );
        return;
      }
      requestParams = parsedParams as Record<string, string | number | boolean>;
    } catch {
      setParseError("Headers and request parameters must be valid JSON — nothing was sent.");
      return;
    }
    setParseError(null);
    onConfigure({
      display_name: displayName.trim(),
      protocol,
      base_url: baseUrl.trim() ? baseUrl.trim() : null,
      api_mode: noKeyMode ? "no_key" : "api_key",
      credential: credentialDraft.trim() ? credentialDraft.trim() : null,
      default_model_id: modelId.trim(),
      organization: organization.trim() ? organization.trim() : null,
      project: project.trim() ? project.trim() : null,
      headers,
      request_params: requestParams,
    });
    // The credential is cleared the moment the configure call is raised — the
    // draft never outlives the submit, whatever the runtime answers (G3).
    setCredentialDraft("");
  };

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} className="shrink-0">
        <Plus aria-hidden="true" />
        Add a custom provider
      </Button>
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Add a custom provider"
      className="space-y-4 rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          Add a custom provider
        </h3>
        <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Display name" htmlFor={`${formId}-display-name`}>
          <input
            id={`${formId}-display-name`}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="My research endpoint"
            required
            maxLength={120}
            className={inputClass}
          />
        </Field>
        <Field label="Protocol" htmlFor={`${formId}-protocol`}>
          <select
            id={`${formId}-protocol`}
            value={protocol}
            onChange={(event) => {
              const next = event.target.value as ProviderView["protocol"];
              setProtocol(next);
              if (NO_KEY_DEFAULT_PROTOCOLS.includes(next) && !noKeyMode) setNoKeyMode(true);
            }}
            className={inputClass}
          >
            {PROTOCOLS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Base URL" htmlFor={`${formId}-base-url`} optional>
          <input
            id={`${formId}-base-url`}
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={protocolPlaceholder(protocol)}
            type="url"
            className={cn(inputClass, "font-mono text-xs")}
          />
        </Field>
        <Field label="Model identifier" htmlFor={`${formId}-model`}>
          <input
            id={`${formId}-model`}
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder={protocolModelPlaceholder(protocol)}
            required
            maxLength={256}
            className={cn(inputClass, "font-mono text-xs")}
          />
        </Field>
      </div>
      <fieldset className="space-y-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-medium text-muted">Credential</legend>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name={`${formId}-api-mode`}
              checked={!noKeyMode}
              onChange={() => setNoKeyMode(false)}
              className="accent-[var(--color-sky)]"
            />
            API key
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="radio"
              name={`${formId}-api-mode`}
              checked={noKeyMode}
              onChange={() => setNoKeyMode(true)}
              className="accent-[var(--color-sky)]"
            />
            No-key mode
          </label>
          <p className="w-full text-xs text-muted">
            {noKeyMode
              ? "For local endpoints that need no credential — nothing is stored."
              : "The key is stored encrypted in this workspace's container. It is masked everywhere and never shown again — replace or revoke only."}
          </p>
          {!noKeyMode ? (
            <input
              type="password"
              value={credentialDraft}
              onChange={(event) => setCredentialDraft(event.target.value)}
              placeholder="Paste the API key"
              autoComplete="off"
              aria-label="API key"
              className={cn(inputClass, "font-mono text-xs")}
            />
          ) : null}
        </div>
      </fieldset>
      <details className="group rounded-lg border border-line p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted">
          Advanced — organization, project, headers, request parameters
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Organization" htmlFor={`${formId}-organization`} optional>
            <input
              id={`${formId}-organization`}
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
              maxLength={256}
              className={cn(inputClass, "font-mono text-xs")}
            />
          </Field>
          <Field label="Project" htmlFor={`${formId}-project`} optional>
            <input
              id={`${formId}-project`}
              value={project}
              onChange={(event) => setProject(event.target.value)}
              maxLength={256}
              className={cn(inputClass, "font-mono text-xs")}
            />
          </Field>
          <Field label="Headers (JSON)" htmlFor={`${formId}-headers`} optional>
            <textarea
              id={`${formId}-headers`}
              value={headersDraft}
              onChange={(event) => setHeadersDraft(event.target.value)}
              rows={2}
              spellCheck={false}
              aria-describedby={`${formId}-headers-hint`}
              className={cn(inputClass, "resize-y font-mono text-xs")}
            />
            <p id={`${formId}-headers-hint`} className="text-xs text-muted">
              Custom headers carry configuration only — credential-shaped values are refused.
            </p>
          </Field>
          <Field label="Request parameters (JSON)" htmlFor={`${formId}-params`} optional>
            <textarea
              id={`${formId}-params`}
              value={paramsDraft}
              onChange={(event) => setParamsDraft(event.target.value)}
              rows={2}
              spellCheck={false}
              className={cn(inputClass, "resize-y font-mono text-xs")}
            />
          </Field>
        </div>
      </details>
      {parseError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {parseError}
        </p>
      ) : null}
      {safeError ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {safeError}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save provider"}
        </Button>
      </div>
    </form>
  );
}

/** One masked catalog row with its per-row actions. */
function ProviderRow({
  provider,
  pendingConfirm,
  saved,
  lastTestResult,
  busy,
  busyError,
  onReplaceCredential,
  onRevoke,
  onSetStatus,
  onConnectionTest,
  onConfirmClick,
  onConfirmCancel,
}: {
  provider: ProviderView;
  pendingConfirm: ProvidersSettingsViewProps["pendingConfirm"];
  saved: boolean;
  lastTestResult: ConnectionTestState | null | undefined;
  busy: boolean;
  busyError?: string | undefined;
  onReplaceCredential: ProvidersSettingsViewProps["onReplaceCredential"];
  onRevoke: ProvidersSettingsViewProps["onRevoke"];
  onSetStatus: ProvidersSettingsViewProps["onSetStatus"];
  onConnectionTest: ProvidersSettingsViewProps["onConnectionTest"];
  onConfirmClick: ProvidersSettingsViewProps["onConfirmClick"];
  onConfirmCancel: ProvidersSettingsViewProps["onConfirmCancel"];
}) {
  const [replacementDraft, setReplacementDraft] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const rowId = useId();
  const testForThis =
    lastTestResult != null && lastTestResult.providerId === provider.id ? lastTestResult : null;

  const submitReplacement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!replacementDraft.trim()) return;
    onReplaceCredential(provider.id, replacementDraft.trim());
    setReplacementDraft("");
    setReplaceOpen(false);
  };

  return (
    <section
      data-provider-id={provider.id}
      aria-label={provider.display_name}
      className="rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="min-w-0 truncate text-sm font-semibold text-text">
              {provider.display_name}
            </h3>
            <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {provider.protocol}
            </span>
            <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
              {provider.origin === "platform" ? "Platform" : "Custom"}
            </span>
          </div>
          <p className="mt-1 font-mono text-xs text-muted">
            {provider.default_model_id}
            {provider.base_url ? ` · ${provider.base_url}` : ""}
          </p>
        </div>
        <StatusChip enabled={provider.status === "enabled"} />
        <SavedBadge visible={saved} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
        {provider.api_mode === "api_key" ? (
          provider.credential_hint ? (
            <p>
              Key on file —{" "}
              <span className="font-mono text-text">••••{provider.credential_hint}</span> (masked;
              never shown in full)
            </p>
          ) : (
            <p className="text-approval">no key stored — add one to make this provider usable</p>
          )
        ) : (
          <p>No-key mode — local endpoint, nothing stored.</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onConnectionTest(provider.id)}
          disabled={testForThis?.state === "pending" || busy}
        >
          <PlugZap aria-hidden="true" />
          Test connection
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onSetStatus(provider.id, provider.status !== "enabled")}
          disabled={busy}
        >
          {provider.status === "enabled" ? "Disable" : "Enable"}
        </Button>
        {provider.api_mode === "api_key" ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReplaceOpen((open) => !open)}
              aria-expanded={replaceOpen}
              disabled={busy}
            >
              <RefreshCw aria-hidden="true" />
              Replace key
            </Button>
            {pendingConfirm?.providerId === provider.id && pendingConfirm.kind === "revoke" ? (
              <span className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onRevoke(provider.id);
                    onConfirmCancel?.();
                  }}
                >
                  Confirm revoke
                </Button>
                <Button variant="ghost" size="sm" onClick={onConfirmCancel}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onConfirmClick?.(provider.id)}
                disabled={busy || !provider.credential_hint}
              >
                Revoke key
              </Button>
            )}
          </>
        ) : null}
      </div>

      {replaceOpen ? (
        <form
          onSubmit={submitReplacement}
          aria-label={`Replace the key for ${provider.display_name}`}
          className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-elevated p-3"
        >
          <label htmlFor={`${rowId}-replace`} className="sr-only">
            New API key for {provider.display_name}
          </label>
          <input
            id={`${rowId}-replace`}
            type="password"
            value={replacementDraft}
            onChange={(event) => setReplacementDraft(event.target.value)}
            placeholder="Paste the new key"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-text placeholder:text-muted"
          />
          <Button type="submit" size="sm" disabled={!replacementDraft.trim() || busy}>
            {busy ? "Replacing…" : "Save new key"}
          </Button>
          <p className="w-full text-xs text-muted">
            The new key takes effect for the next call — no restart needed.
          </p>
        </form>
      ) : null}

      {testForThis ? <div className="mt-3">{<TestResultNote result={testForThis} />}</div> : null}
      {busyError ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {busyError}
        </p>
      ) : null}
    </section>
  );
}

function ProvidersSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-4">
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="rounded-xl border border-line bg-surface p-4">
          <div className="h-3 w-40 animate-pulse rounded bg-surface-elevated" />
          <div className="mt-3 h-2.5 w-64 animate-pulse rounded bg-surface-elevated" />
          <div className="mt-3 h-8 w-52 animate-pulse rounded bg-surface-elevated" />
        </div>
      ))}
    </div>
  );
}

export function ProvidersSettingsView(props: ProvidersSettingsViewProps) {
  const {
    providers,
    surfaceState,
    safeErrorMessage,
    onRetry,
    pendingConfirm = null,
    savedProviderIds = [],
    lastTestResult = null,
    configurePending,
    configureError,
    busyProviderId,
    busyError,
    onConfigure,
    onReplaceCredential,
    onRevoke,
    onSetStatus,
    onConnectionTest,
    onConfirmClick,
    onConfirmCancel,
    defaultAddOpen = false,
  } = props;

  if (surfaceState === "loading") {
    return <ProvidersSkeleton />;
  }
  if (surfaceState === "error") {
    return (
      <div className="flex h-full items-center justify-center">
        <ErrorState
          safeMessage={safeErrorMessage ?? "The providers could not be loaded."}
          onRetry={onRetry}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Keys are stored encrypted in your workspace&apos;s container, masked everywhere, and never
        shown again after saving. A replaced key takes effect for the next call — no restart.
      </p>

      {providers.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <p className="text-sm text-text">No providers configured yet.</p>
          <p className="mt-1 text-sm text-muted">
            The administrator provisions the platform providers; you can add a custom provider below
            — a local Ollama endpoint needs no key at all.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              pendingConfirm={pendingConfirm?.providerId === provider.id ? pendingConfirm : null}
              saved={savedProviderIds.includes(provider.id)}
              lastTestResult={lastTestResult}
              busy={busyProviderId === provider.id}
              busyError={busyProviderId === provider.id ? busyError : undefined}
              onReplaceCredential={onReplaceCredential}
              onRevoke={onRevoke}
              onSetStatus={onSetStatus}
              onConnectionTest={onConnectionTest}
              onConfirmClick={onConfirmClick}
              onConfirmCancel={onConfirmCancel}
            />
          ))}
        </div>
      )}

      <div className="pt-2">
        <AddProviderForm
          onConfigure={onConfigure}
          pending={configurePending}
          safeError={configureError}
          defaultOpen={defaultAddOpen}
        />
      </div>

      <p className="text-xs text-muted">
        Per-Agent defaults live in each Agent&apos;s settings; the per-conversation override lives
        in the chat header.{" "}
        <a
          href={routes.settings()}
          className="text-sky underline underline-offset-4 hover:text-cool-highlight"
        >
          Open Agent settings
        </a>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live wiring: container resolution + queries + the typed provider mutations
// ---------------------------------------------------------------------------

/**
 * The settings surface reads REAL provider rows, so it needs the workspace
 * container (the same posture as the Agent settings surface).
 */
function ContainerUnavailableState() {
  return (
    <div
      role="status"
      className="mx-auto my-8 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center"
    >
      <p className="text-sm text-text">
        Providers &amp; models reads your workspace&apos;s real provider rows, so the workspace
        container must be running. Start your workspace and come back.
      </p>
    </div>
  );
}

export function ProvidersSettingsSurface() {
  const resolution = useContainerResolution();
  if (resolution.data?.kind !== "ready") {
    return <ContainerUnavailableState />;
  }
  return <RuntimeProvidersSettings workspaceId={resolution.data.workspace_id} />;
}

function RuntimeProvidersSettings({ workspaceId }: { workspaceId: string }) {
  const catalog = useProviders(workspaceId);
  const actions = useProviderActions(workspaceId);
  const [pendingConfirm, setPendingConfirm] = useState<{
    providerId: string;
    kind: "revoke";
  } | null>(null);
  // §6.3 visible command feedback: the row a settled mutation affected shows
  // a brief "Saved", cleared after a moment (the agent-settings pattern).
  const [savedIds, setSavedIds] = useState<readonly string[]>([]);
  const savedTimerRef = useRef<number | null>(null);

  const markSaved = (providerId: string) => {
    setSavedIds((previous) => [...previous, providerId]);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      setSavedIds([]);
    }, 2500);
  };

  const surfaceState: ProvidersSurfaceState = catalog.state;
  const busyProviderId = actions.replace.isPending
    ? (actions.replace.variables?.providerId ?? null)
    : actions.revoke.isPending
      ? (actions.revoke.variables?.providerId ?? null)
      : actions.setStatus.isPending
        ? (actions.setStatus.variables?.providerId ?? null)
        : null;
  const busyError = actions.replace.isError
    ? safeProviderMessage(actions.replace.error, "The key was not replaced.")
    : actions.revoke.isError
      ? safeProviderMessage(actions.revoke.error, "The key was not revoked.")
      : actions.setStatus.isError
        ? safeProviderMessage(actions.setStatus.error, "The provider status was not saved.")
        : undefined;

  return (
    <ProvidersSettingsView
      providers={catalog.providers}
      surfaceState={surfaceState}
      safeErrorMessage={catalog.safeErrorMessage}
      onRetry={catalog.refetch}
      pendingConfirm={pendingConfirm}
      savedProviderIds={savedIds}
      lastTestResult={
        actions.test.isPending && actions.test.variables
          ? { providerId: actions.test.variables.providerId, state: "pending", result: null }
          : actions.test.data
            ? {
                providerId: actions.test.variables?.providerId ?? "",
                state: actions.test.data.ok ? "ok" : "failed",
                result: actions.test.data,
              }
            : null
      }
      configurePending={actions.configure.isPending}
      configureError={
        actions.configure.isError
          ? safeProviderMessage(actions.configure.error, "The provider was not saved.")
          : undefined
      }
      busyProviderId={busyProviderId}
      busyError={busyError}
      onConfigure={(input) =>
        actions.configure.mutate(
          {
            workspaceId,
            displayName: input.display_name,
            protocol: input.protocol,
            baseUrl: input.base_url,
            apiMode: input.api_mode,
            credential: input.credential,
            defaultModelId: input.default_model_id,
            organization: input.organization,
            project: input.project,
            headers: input.headers,
            requestParams: input.request_params,
          },
          { onSuccess: (provider) => markSaved(provider.id) },
        )
      }
      onReplaceCredential={(providerId, credential) =>
        actions.replace.mutate(
          { providerId, credential },
          { onSuccess: (provider) => markSaved(provider.id) },
        )
      }
      onRevoke={(providerId) =>
        actions.revoke.mutate({ providerId }, { onSuccess: (provider) => markSaved(provider.id) })
      }
      onSetStatus={(providerId, enabled) =>
        actions.setStatus.mutate(
          { providerId, enabled },
          { onSuccess: (provider) => markSaved(provider.id) },
        )
      }
      onConnectionTest={(providerId) => actions.test.mutate({ providerId })}
      onConfirmClick={(providerId) => {
        if (pendingConfirm?.providerId === providerId) {
          setPendingConfirm(null);
          actions.revoke.mutate(
            { providerId },
            { onSuccess: (provider) => markSaved(provider.id) },
          );
        } else {
          setPendingConfirm({ providerId, kind: "revoke" });
        }
      }}
      onConfirmCancel={() => setPendingConfirm(null)}
      defaultAddOpen={catalog.providers.length === 0}
    />
  );
}
