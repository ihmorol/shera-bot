"use client";

import { useState } from "react";
import { CircleSlash, Power, Wrench } from "lucide-react";

import { RiskBadge } from "@/components/chat/cards";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import { useAgentRoster } from "@/lib/agent-data";
import { useContainerResolution } from "@/lib/container-connection";
import type { AgentRosterSummary } from "@/lib/agent-api";
import {
  safeToolsMessage,
  useActivateTool,
  useCreateTool,
  useDisableTool,
  useEnableTool,
  useToolCreationPreview,
  useToolInventory,
  type ToolCreationPreview,
} from "@/lib/tools-data";
import type { ToolInventoryEntry } from "@/lib/tools-api";

/**
 * Settings → Tools (UI_DESIGN §S9, PRD §7, E4, D38): the tool inventory —
 * built-in + agent-created, with owner, scope, risk class, permissions,
 * version, and the creation/activation states (preview → approval → runtime
 * grant) — plus the disable switch that actually prevents execution (AC6:
 * the executor refuses before any grant consult; the switch is not
 * decorative).
 *
 * Creation is preview-gated (D30/D35): the preview resolves what creation
 * WOULD do and names the refusing D38 layer on a refusal; the create command
 * re-validates everything (the preview answer is never trusted). Copy never
 * promises outcomes (§7): a created tool "may run automatically" only through
 * the runtime's own ladder.
 */

const stateCopy: Record<ToolInventoryEntry["state"], string> = {
  active: "Active",
  created: "Awaiting activation",
  disabled: "Disabled",
};

function ownerLabel(owner: ToolInventoryEntry["owner"], identities: AgentRosterSummary[]): string {
  if (owner.kind === "platform") {
    return "Platform";
  }
  return (
    identities.find((identity) => identity.agent_id === owner.agent_id)?.display_name ??
    owner.agent_id ??
    "Agent"
  );
}

function InventoryRow({
  tool,
  identities,
  pending,
  onActivate,
  onToggleDisabled,
}: {
  tool: ToolInventoryEntry;
  identities: AgentRosterSummary[];
  pending: boolean;
  onActivate: (toolId: string) => void;
  onToggleDisabled: (toolId: string, disabled: boolean) => void;
}) {
  const activateVisible = tool.state === "created" && !tool.disabled;
  return (
    <li data-tool-id={tool.tool_id} className="rounded-xl border border-line bg-surface p-4">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <Wrench className="size-4 shrink-0 self-center text-sky" aria-hidden="true" />
        <span className="truncate font-mono text-sm text-text">{tool.name}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">v{tool.version}</span>
        <RiskBadge riskClass={tool.risk_class} />
        {tool.disabled ? (
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            disabled
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] text-muted">{tool.purpose}</p>
      <dl className="mt-2 space-y-1 text-[13px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Owner</dt>
          <dd className="text-text">{ownerLabel(tool.owner, identities)}</dd>
          <dt className="ml-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Scope
          </dt>
          <dd className="text-text">{tool.inventory_scope ?? "—"}</dd>
          <dt className="ml-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            State
          </dt>
          <dd className="text-text">{stateCopy[tool.state]}</dd>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Permissions
          </dt>
          <dd className="min-w-0 font-mono text-[11px] text-muted">
            {tool.capabilities.join(", ")}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex items-center justify-between gap-3">
        {activateVisible ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => onActivate(tool.tool_id)}
          >
            Activate for its owner
          </Button>
        ) : (
          <span className="text-[12px] text-muted">
            {tool.origin === "agent_created"
              ? tool.risk_class === "READ_ONLY"
                ? "Activated for its creator on creation."
                : "Activation is a runtime grant — a user decision."
              : "Platform tool — managed by the runtime."}
          </span>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={!tool.disabled}
          aria-label={`${tool.disabled ? "Enable" : "Disable"} ${tool.name}`}
          disabled={pending}
          onClick={() => onToggleDisabled(tool.tool_id, tool.disabled)}
          className={`relative h-6 w-10 shrink-0 rounded-full border transition-colors duration-150 disabled:opacity-50 ${
            tool.disabled ? "border-line bg-surface-elevated" : "border-line bg-brand"
          }`}
        >
          <span
            className={`absolute top-1/2 size-4 -translate-y-1/2 rounded-full bg-text transition-[left] duration-150 ${
              tool.disabled ? "left-1" : "left-5"
            }`}
            aria-hidden="true"
          />
        </button>
      </div>
    </li>
  );
}

const RISK_CLASSES = [
  "READ_ONLY",
  "LOCAL_MUTATION",
  "EXTERNAL_WRITE",
  "DESTRUCTIVE_LOCAL",
  "CREDENTIAL_ACCESS",
  "DEPLOYMENT",
  "FINANCIAL_OR_IRREVERSIBLE",
] as const;

function CreateToolSection({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [ownerAgentId, setOwnerAgentId] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [capabilities, setCapabilities] = useState("file.read");
  const [riskClass, setRiskClass] = useState<(typeof RISK_CLASSES)[number]>("READ_ONLY");
  const [scope, setScope] = useState<"private" | "shared">("shared");
  const [preview, setPreview] = useState<ToolCreationPreview | null>(null);

  const previewMutation = useToolCreationPreview();
  const createMutation = useCreateTool(workspaceId);
  const identities = useAgentRoster(workspaceId).agents;

  const form = {
    tool_id: name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, ""),
    name: name.trim(),
    purpose: purpose.trim(),
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    capabilities: capabilities
      .split(",")
      .map((capability) => capability.trim())
      .filter(Boolean),
    risk_class: riskClass,
    inventory_scope: scope,
  };
  const formReady = form.name.length > 0 && form.purpose.length > 0 && ownerAgentId !== "";

  return (
    <section aria-labelledby="create-tool-heading" className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 id="create-tool-heading" className="text-sm font-semibold text-text">
          Agent-created tools
        </h2>
        <Button size="sm" variant="outline" onClick={() => setOpen((value) => !value)}>
          {open ? "Close" : "Create a tool"}
        </Button>
      </div>
      <p className="mt-1 text-[13px] text-muted">
        Creation is preview-gated: nothing is created before you confirm the preview, and a tool
        that claims a capability the platform or the pack does not allow is refused with the layer
        named. Risky tools stay unexecutable until you activate them — activation is a runtime
        grant, and the creating Agent cannot grant itself.
      </p>
      {open ? (
        <div className="mt-3 space-y-3 rounded-xl border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[13px] text-muted">
              Name
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setPreview(null);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text"
                placeholder="Digest builder"
              />
            </label>
            <label className="block text-[13px] text-muted">
              Owner Agent
              <select
                value={ownerAgentId}
                onChange={(event) => {
                  setOwnerAgentId(event.target.value);
                  setPreview(null);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text"
              >
                <option value="">Choose an Agent…</option>
                {identities.map((identity) => (
                  <option key={identity.agent_id} value={identity.agent_id}>
                    {identity.display_name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-[13px] text-muted">
            Purpose
            <input
              value={purpose}
              onChange={(event) => {
                setPurpose(event.target.value);
                setPreview(null);
              }}
              className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text"
              placeholder="What the tool does, in one line"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-[13px] text-muted">
              Capabilities
              <input
                value={capabilities}
                onChange={(event) => {
                  setCapabilities(event.target.value);
                  setPreview(null);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-text"
              />
            </label>
            <label className="block text-[13px] text-muted">
              Risk class
              <select
                value={riskClass}
                onChange={(event) => {
                  setRiskClass(event.target.value as (typeof RISK_CLASSES)[number]);
                  setPreview(null);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text"
              >
                {RISK_CLASSES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[13px] text-muted">
              Scope
              <select
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as "private" | "shared");
                  setPreview(null);
                }}
                className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-text"
              >
                <option value="shared">Shared</option>
                <option value="private">Private</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!formReady || previewMutation.isPending}
              onClick={() =>
                previewMutation.mutate(
                  { workspaceId, ownerAgentId, form },
                  { onSuccess: (result) => setPreview(result) },
                )
              }
            >
              {previewMutation.isPending ? "Checking…" : "Preview"}
            </Button>
            <Button
              size="sm"
              disabled={preview?.ok !== true || createMutation.isPending}
              onClick={() =>
                preview &&
                createMutation.mutate(
                  { ownerAgentId, form },
                  {
                    onSuccess: () => {
                      setPreview(null);
                      setOpen(false);
                      setName("");
                      setPurpose("");
                    },
                  },
                )
              }
            >
              {createMutation.isPending ? "Creating…" : "Confirm creation"}
            </Button>
          </div>
          {preview ? (
            preview.ok ? (
              <div className="rounded-lg border border-line bg-surface-elevated p-3 text-[13px] text-text">
                <p className="font-medium">{preview.tool_id}</p>
                <p className="mt-1 text-muted">
                  {preview.ladder_label} ·{" "}
                  {preview.auto_activates
                    ? "activates for its creator on creation."
                    : "awaits your activation decision after creation."}
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-failed/40 bg-surface-elevated p-3 text-[13px] text-text">
                <p className="font-medium uppercase tracking-[0.08em] text-failed">
                  {preview.layer} limit
                </p>
                <p className="mt-1 text-muted">{preview.detail}</p>
              </div>
            )
          ) : null}
          {createMutation.isError ? (
            <p className="text-[13px] text-failed">
              {safeToolsMessage(createMutation.error, "The creation was refused.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** The route entry: resolves the session's workspace (E12) then reads live. */
export function ToolsSettingsSurface() {
  const resolution = useContainerResolution();
  if (resolution.data?.kind !== "ready") {
    return (
      <ErrorState safeMessage="Your workspace is not available right now. Reopen Settings once the container is connected." />
    );
  }
  return <RuntimeToolsSettings workspaceId={resolution.data.workspace_id} />;
}

function RuntimeToolsSettings({ workspaceId }: { workspaceId: string }) {
  const { tools, loading, error } = useToolInventory(workspaceId);
  const identities = useAgentRoster(workspaceId).agents;
  const activateMutation = useActivateTool(workspaceId);
  const disableMutation = useDisableTool(workspaceId);
  const enableMutation = useEnableTool(workspaceId);
  const pending =
    activateMutation.isPending || disableMutation.isPending || enableMutation.isPending;

  if (error) {
    return <ErrorState safeMessage={error} />;
  }

  return (
    <div>
      {loading ? (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1].map((key) => (
            <div
              key={key}
              className="h-24 animate-pulse rounded-xl border border-line bg-surface"
            />
          ))}
          <span className="sr-only">Loading the tool inventory…</span>
        </div>
      ) : tools.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-6 text-center">
          <CircleSlash className="mx-auto size-6 text-muted" aria-hidden="true" />
          <p className="mt-2 text-sm text-text">No tools in this workspace yet.</p>
          <p className="mt-1 text-[13px] text-muted">
            The runtime registers platform tools here; Agents can create their own below — every one
            of them executes through the runtime executor, under its risk class and limits.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {tools.map((tool) => (
            <InventoryRow
              key={`${tool.tool_id}@${tool.version}`}
              tool={tool}
              identities={identities}
              pending={pending}
              onActivate={(toolId) =>
                activateMutation.mutate({
                  toolId,
                  version: tools.find((entry) => entry.tool_id === toolId)?.version ?? "1.0.0",
                  target: { kind: "agent", id: tool.owner.agent_id ?? "" },
                })
              }
              onToggleDisabled={(toolId, disabled) =>
                disabled ? enableMutation.mutate({ toolId }) : disableMutation.mutate({ toolId })
              }
            />
          ))}
        </ul>
      )}
      {activateMutation.isError ? (
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-failed">
          <Power className="size-3.5" aria-hidden="true" />
          {safeToolsMessage(activateMutation.error, "The activation was refused.")}
        </p>
      ) : null}
      <CreateToolSection workspaceId={workspaceId} />
    </div>
  );
}
