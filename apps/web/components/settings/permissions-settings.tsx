"use client";

import { useState } from "react";
import { KeyRound, BellOff } from "lucide-react";

import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import { useAgentRoster as useWorkspaceRoster } from "@/lib/agent-data";
import type { AgentRosterSummary } from "@/lib/agent-api";
import {
  formatExpiry,
  type ApprovalGrantRecord,
  type ApprovalMuteRecord,
} from "@/lib/approvals-api";
import {
  safeApprovalsMessage,
  useApprovalGrants,
  useApprovalMutes,
  useRevokeApprovalGrant,
} from "@/lib/approvals-data";
import { useContainerResolution } from "@/lib/container-connection";

/**
 * Settings → Permissions & approvals (UI_DESIGN §S9, D9/D35): every ACTIVE
 * grant — scope, tool + version, expiry, created by — with revoke, plus the
 * workspace's reminder mutes. "Full access" is never a mode: the list shows
 * only visible, revocable grants (D35). Mutes are list-only here: the S20 API
 * has no un-mute path, and the surface says so honestly instead of faking one.
 */

/** The grants empty state teaches where grants come from (§2.4). */
export const grantsEmptyCopy =
  "No active grants. Approve with “Always approve…” on a paused action and the scoped grant appears here, revocable at any time.";

function principalLabel(
  principal: { principal_type: string; principal_id: string },
  identities: AgentRosterSummary[],
): string {
  if (principal.principal_type === "agent") {
    return (
      identities.find((identity) => identity.agent_id === principal.principal_id)?.display_name ??
      principal.principal_id
    );
  }
  return principal.principal_id;
}

function GrantRow({
  grant,
  identities,
  revokePending,
  onRevoke,
}: {
  grant: ApprovalGrantRecord;
  identities: AgentRosterSummary[];
  revokePending: boolean;
  onRevoke: (grantId: string) => void;
}) {
  return (
    <li
      data-grant-id={grant.grant_id}
      className="rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <KeyRound className="size-4 shrink-0 self-center text-sky" aria-hidden="true" />
        <span className="truncate font-mono text-sm text-text">{grant.tool_id}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">v{grant.tool_version}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted">{grant.capability}</span>
      </div>
      <dl className="mt-2 space-y-1 text-[13px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Scope</dt>
          <dd className="min-w-0 text-text">
            {principalLabel(grant, identities)}
            <span className="text-muted"> · </span>
            <span className="break-all font-mono text-[12px]">{grant.resource_scope}</span>
            <span className="text-muted">
              {" "}
              · {grant.conversation_scope === "any" ? "any conversation" : grant.conversation_scope}
            </span>
          </dd>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Expiry</dt>
          <dd className="text-text">{formatExpiry(grant.expires_at)}</dd>
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Created by
          </dt>
          <dd className="text-text">
            {grant.created_by.type === "user" ? "user" : "agent"} {grant.created_by.id}
          </dd>
        </div>
        {grant.one_time ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <dt className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
              One-time
            </dt>
            <dd className="text-text">
              {grant.consumed_at
                ? `used — the approved execution consumed it`
                : `not used yet — the first approved execution consumes it`}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={revokePending}
          aria-label={`Revoke grant ${grant.grant_id}`}
          onClick={() => onRevoke(grant.grant_id)}
        >
          Revoke
        </Button>
        <p className="text-[13px] text-muted">
          Revoking takes effect immediately — the next execution needs a new approval.
        </p>
      </div>
    </li>
  );
}

function MuteRow({ mute, identities }: { mute: ApprovalMuteRecord; identities: AgentRosterSummary[] }) {
  const target =
    mute.scope === "all"
      ? "every reminder in this workspace"
      : (identities.find((identity) => identity.agent_id === mute.target_id)?.display_name ??
        mute.target_id ??
        "");
  return (
    <li data-mute-id={mute.mute_id} className="rounded-xl border border-line bg-surface px-4 py-3">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
        <BellOff className="size-4 shrink-0 self-center text-muted" aria-hidden="true" />
        <span className="text-text">
          {mute.scope === "all" ? "All reminders" : mute.scope === "task" ? "Task" : "Approval"}
        </span>
        <span className="min-w-0 break-all font-mono text-[12px] text-muted">{target}</span>
      </p>
    </li>
  );
}

export function PermissionsReadout({
  state,
  grants,
  mutes,
  identities,
  safeErrorMessage,
  onRetry,
  onRevoke,
  revokePendingGrantId,
  successNote,
  errorMessage,
}: {
  state: "loading" | "ready" | "error";
  grants: ApprovalGrantRecord[];
  mutes: ApprovalMuteRecord[];
  identities: AgentRosterSummary[];
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  onRevoke: (grantId: string) => void;
  revokePendingGrantId: string | null;
  successNote: string | null;
  errorMessage: string | null;
}) {
  if (state === "loading") {
    return (
      <div aria-busy="true" className="flex flex-col gap-3">
        {Array.from({ length: 2 }, (_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-xl bg-surface-elevated"
          />
        ))}
      </div>
    );
  }

  if (state === "error") {
    return (
      <ErrorState
        safeMessage={safeErrorMessage ?? "The grants list could not be loaded."}
        onRetry={onRetry}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {successNote ? (
        <p role="status" className="mb-4 text-sm text-sky">
          {successNote}
        </p>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="mb-4 text-sm text-failed">
          {errorMessage}
        </p>
      ) : null}

      <section aria-labelledby="active-grants-heading">
        <h2
          id="active-grants-heading"
          className="font-mono text-xs uppercase tracking-[0.16em] text-muted"
        >
          Active grants
        </h2>
        {grants.length === 0 ? (
          <p className="mt-2 rounded-xl border border-line bg-surface p-4 text-sm text-muted">
            {grantsEmptyCopy}
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {grants.map((grant) => (
              <GrantRow
                key={grant.grant_id}
                grant={grant}
                identities={identities}
                revokePending={revokePendingGrantId === grant.grant_id}
                onRevoke={onRevoke}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reminder-mutes-heading" className="mt-8">
        <h2
          id="reminder-mutes-heading"
          className="font-mono text-xs uppercase tracking-[0.16em] text-muted"
        >
          Reminder mutes
        </h2>
        {mutes.length === 0 ? (
          <p className="mt-2 rounded-xl border border-line bg-surface p-4 text-sm text-muted">
            No mutes. Reminders arrive on the approval card&apos;s schedule.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {mutes.map((mute) => (
              <MuteRow key={mute.mute_id} mute={mute} identities={identities} />
            ))}
          </ul>
        )}
        <p className="mt-2 text-[13px] text-muted">
          Mutes silence reminder notifications only — a paused task still needs your decision, and
          the approval stays visible. Mutes cannot be removed in this prototype yet.
        </p>
      </section>
    </div>
  );
}

/** Honest read: this surface reads REAL rows, so it needs the container. */
function ContainerUnavailableState() {
  return (
    <div
      role="status"
      className="mx-auto my-8 flex max-w-md flex-col items-center gap-3 rounded-xl border border-line bg-surface p-6 text-center"
    >
      <p className="text-sm text-text">
        Permissions &amp; approvals read your workspace&apos;s real grants, so the workspace
        container must be running. Start your workspace and come back.
      </p>
    </div>
  );
}

export function PermissionsSettingsSurface() {
  const resolution = useContainerResolution();
  if (resolution.data?.kind !== "ready") {
    return <ContainerUnavailableState />;
  }
  return (
    <RuntimePermissionsSettings workspaceId={resolution.data.workspace_id} />
  );
}

function RuntimePermissionsSettings({ workspaceId }: { workspaceId: string }) {
  const grants = useApprovalGrants(workspaceId);
  const mutes = useApprovalMutes(workspaceId);
  const roster = useWorkspaceRoster(workspaceId);
  const revoke = useRevokeApprovalGrant(workspaceId);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const state =
    grants.state === "error"
      ? "error"
      : grants.state === "loading"
        ? "loading"
        : mutes.state === "error"
          ? "error"
          : mutes.state === "loading"
            ? "loading"
            : "ready";

  return (
    <PermissionsReadout
      state={state}
      grants={grants.grants}
      mutes={mutes.mutes}
      identities={roster.agents}
      safeErrorMessage={grants.safeErrorMessage ?? mutes.safeErrorMessage}
      onRetry={() => {
        grants.refetch();
        mutes.refetch();
      }}
      revokePendingGrantId={revoke.isPending ? (revoke.variables ?? null) : null}
      successNote={successNote}
      errorMessage={errorMessage}
      onRevoke={(grantId) => {
        setSuccessNote(null);
        setErrorMessage(null);
        revoke.mutate(grantId, {
          onSuccess: () => {
            setSuccessNote("Grant revoked. The next execution needs a new approval.");
          },
          onError: (error) => {
            setErrorMessage(safeApprovalsMessage(error, "The revoke was not accepted."));
          },
        });
      }}
    />
  );
}
