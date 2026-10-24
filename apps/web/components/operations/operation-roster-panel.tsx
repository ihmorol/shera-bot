import { UserPlus, Users } from "lucide-react";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { AgentRosterSummary } from "@/lib/agent-api";
import { agentIdentityFromSummary, type OperationRosterMember } from "@/lib/operation-api";
import { cn } from "@/lib/utils";

/**
 * Operation roster panel (UI_DESIGN §S4, D36/D42/D49): one chip per roster
 * Agent with the pack-authored identity, the coordinator chip carrying the
 * "Coordinator" badge and its remove action (sets "none" — D49: removal is
 * allowed at any time; work continues peer-to-peer), and the add affordance
 * listing the same-pack Agents NOT yet on the roster.
 *
 * D36 discipline in the UI: an add is NEVER silent — picking a candidate arms
 * an explicit confirm step, and a refused command renders the runtime's fixed
 * safe copy verbatim, inline (never a generic error, never raw internals).
 * Per-Agent cost metadata arrives with the provider/credits slices; until then
 * every add passes the confirm step, which is the conservative superset of the
 * D36 approval requirement.
 */

export function OperationRosterPanel({
  roster,
  identities,
  coordinatorAgentId,
  state,
  safeErrorMessage,
  onRetry,
  candidates,
  confirmingAdd,
  pending,
  refusalMessage,
  persistedRefusalMessage,
  onAddClick,
  onConfirmAdd,
  onCancelAdd,
  onRemove,
  onCoordinatorChange,
  className,
}: {
  roster: OperationRosterMember[];
  identities: AgentRosterSummary[];
  /** The Operation's coordinator: an Agent id, or the literal "none" (D49). */
  coordinatorAgentId: string;
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  candidates: AgentRosterSummary[];
  /** The candidate whose add is armed for explicit confirmation (D36). */
  confirmingAdd: AgentRosterSummary | null;
  pending: boolean;
  /** The refused command's fixed safe message, rendered verbatim (D36/G3). */
  refusalMessage: string | null;
  /**
   * The detail read model's most recent persisted refusal (the backend keeps
   * the D36 "why" evidence). A live refusal from THIS session wins; the
   * persisted one explains the latest refusal across reloads.
   */
  persistedRefusalMessage: string | null;
  onAddClick: (candidate: AgentRosterSummary) => void;
  onConfirmAdd: () => void;
  onCancelAdd: () => void;
  onRemove: (agentId: string) => void;
  onCoordinatorChange: (coordinatorAgentId: string) => void;
  className?: string;
}) {
  if (state === "loading") {
    return (
      <div
        aria-busy="true"
        data-testid="operation-roster-skeleton"
        className={cn("flex items-center gap-2 px-4 py-3", className)}
      >
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="animate-pulse rounded-full bg-surface-elevated size-8" />
        ))}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className={cn("px-4 py-3", className)}>
        <ErrorState
          safeMessage={safeErrorMessage ?? "The Operation could not be loaded."}
          onRetry={onRetry}
        />
      </div>
    );
  }

  const identityFor = (agentId: string): AgentRosterSummary | undefined =>
    identities.find((identity) => identity.agent_id === agentId);
  const effectiveRefusalMessage = refusalMessage ?? persistedRefusalMessage;

  return (
    <section
      data-testid="operation-roster-panel"
      aria-label="Operation roster"
      className={cn("shrink-0 border-b border-line bg-surface px-4 py-3 lg:px-6", className)}
    >
      <div className="flex items-center gap-2">
        <Users className="size-4 text-muted" aria-hidden="true" />
        <h2 className="font-mono text-xs uppercase tracking-[0.16em] text-muted">Roster</h2>
      </div>

      {effectiveRefusalMessage ? (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-text"
        >
          {effectiveRefusalMessage}
        </p>
      ) : null}

      {coordinatorAgentId === "none" ? (
        // D49: after coordinator removal the quiet note keeps the model honest —
        // peer-to-peer coordination, runtime still authoritative.
        <p className="mt-2 text-xs text-muted">
          No coordinator right now — work continues peer-to-peer; the runtime stays authoritative.
        </p>
      ) : null}

      <ul className="mt-2 flex flex-wrap items-stretch gap-2">
        {roster.map((member) => {
          const identity = identityFor(member.agent_id);
          const displayName = member.display_name ?? identity?.display_name ?? member.agent_id;
          const role = identity?.role_description;
          const isCoordinator = member.agent_id === coordinatorAgentId;
          return (
            <li
              key={member.agent_id}
              data-testid="operation-roster-chip"
              data-coordinator={isCoordinator ? "true" : undefined}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-xl border bg-surface-elevated px-3 py-2",
                isCoordinator ? "border-line-accent" : "border-line",
              )}
            >
              {identity ? (
                <AgentAvatar agent={agentIdentityFromSummary(identity)} size="sm" />
              ) : (
                // No seeded identity: render the id honestly — never a
                // fabricated name or avatar (G4).
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface font-mono text-[10px] text-muted"
                >
                  ?
                </span>
              )}
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-text">{displayName}</span>
                  {isCoordinator ? (
                    <span className="rounded-full bg-brand px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text">
                      Coordinator
                    </span>
                  ) : null}
                </span>
                {role ? <span className="block truncate text-xs text-muted">{role}</span> : null}
              </span>
              {isCoordinator ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-my-1"
                  disabled={pending}
                  onClick={() => onCoordinatorChange("none")}
                  aria-label="Remove the coordinator role"
                >
                  Remove
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-my-1"
                  disabled={pending}
                  onClick={() => onRemove(member.agent_id)}
                  aria-label={`Remove ${displayName} from this Operation`}
                >
                  Remove
                </Button>
              )}
            </li>
          );
        })}
        {coordinatorAgentId !== "none" &&
        !roster.some((member) => member.agent_id === coordinatorAgentId)
          ? // D46: the coordinator is present in every Operation BY ROLE, not by
            // roster assignment — when the coordinating Agent holds no membership
            // the chip still renders (identity from the workspace roster), with
            // the coordinator-remove action only (nothing to remove from the
            // roster it is not on).
            (() => {
              const identity = identityFor(coordinatorAgentId);
              const displayName = identity?.display_name ?? coordinatorAgentId;
              return (
                <li
                  data-testid="operation-roster-chip"
                  data-coordinator="true"
                  className="flex min-w-0 items-center gap-2 rounded-xl border border-line-accent bg-surface-elevated px-3 py-2"
                >
                  {identity ? (
                    <AgentAvatar agent={agentIdentityFromSummary(identity)} size="sm" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface font-mono text-[10px] text-muted"
                    >
                      ?
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-text">{displayName}</span>
                      <span className="rounded-full bg-brand px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text">
                        Coordinator
                      </span>
                    </span>
                    {identity?.role_description ? (
                      <span className="block truncate text-xs text-muted">
                        {identity.role_description}
                      </span>
                    ) : null}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="-my-1"
                    disabled={pending}
                    onClick={() => onCoordinatorChange("none")}
                    aria-label="Remove the coordinator role"
                  >
                    Remove
                  </Button>
                </li>
              );
            })()
          : null}
      </ul>

      {confirmingAdd && !pending ? (
        // The D36 confirm step: no add command is sent until the user confirms
        // here. A refusal above always outranks an armed confirmation.
        <div className="mt-3 rounded-xl border border-line bg-surface-elevated px-3 py-2">
          <p className="text-sm text-text">Add {confirmingAdd.display_name} to this Operation?</p>
          <p className="mt-1 text-xs text-muted">
            {confirmingAdd.display_name} joins the roster for this Operation only; the runtime
            validates pack membership and policy.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={onConfirmAdd}>
              Confirm add
            </Button>
            <Button variant="outline" size="sm" onClick={onCancelAdd}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-[0.16em] text-muted">
            <UserPlus className="size-3.5" aria-hidden="true" />
            Add an Agent
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {candidates.map((candidate) => (
              <li key={candidate.agent_id}>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => onAddClick(candidate)}
                  aria-label={`Add ${candidate.display_name} to this Operation`}
                  title={candidate.role_description}
                >
                  <AgentAvatar agent={agentIdentityFromSummary(candidate)} size="sm" />
                  {candidate.display_name}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
