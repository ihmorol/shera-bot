import { useState } from "react";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { AgentRosterSummary } from "@/lib/agent-api";
import { agentIdentityFromSummary } from "@/lib/operation-api";
import { cn } from "@/lib/utils";

/**
 * Ad-hoc Operation creation form (UI_DESIGN §S6, D41/D42): an OPTIONAL name
 * (left empty, the runtime auto-labels the Operation `Ad-hoc · N Agents` —
 * the hint says so), a multi-select same-Pack roster (minimum one Agent —
 * zero selected disables Create with the inline refusal copy mirroring the
 * server's typed OPERATION_ROSTER_EMPTY message), and a coordinator choice
 * that defaults to the General Assistant, is NAMED in the copy (never
 * silently chosen, D42), and allows explicit "No coordinator" — work
 * continues peer-to-peer (D42/D49). The runtime validates the roster against
 * the pinned pack; a typed refusal or failure renders its safe message here.
 */
export function NewOperationForm({
  identities,
  state,
  safeErrorMessage,
  onRetry,
  pending,
  errorMessage,
  defaultCoordinatorId,
  initialSelectedAgentIds = [],
  onSubmit,
  className,
}: {
  identities: AgentRosterSummary[];
  state: "loading" | "ready" | "error";
  safeErrorMessage: string | undefined;
  onRetry: () => void;
  pending: boolean;
  /** The creation command's typed failure, as its safe message. */
  errorMessage: string | null;
  defaultCoordinatorId: string;
  /** Agents checked on first render (none by default — an honest start). */
  initialSelectedAgentIds?: string[];
  onSubmit: (input: {
    /** Null when left unnamed — the server auto-labels (D41). */
    name: string | null;
    rosterAgentIds: string[];
    /** An Agent id, or the literal "none" for peer-to-peer (D42/D49). */
    coordinatorAgentId: string;
  }) => void;
  className?: string;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedAgentIds));
  const [coordinatorId, setCoordinatorId] = useState(defaultCoordinatorId);
  const coordinator = identities.find((identity) => identity.agent_id === defaultCoordinatorId);

  if (state === "loading") {
    return (
      <div aria-busy="true" data-testid="new-operation-skeleton" className={cn("px-4", className)}>
        <div className="mx-auto flex max-w-md flex-col gap-3 py-8">
          <div className="animate-pulse rounded bg-surface-elevated h-10 w-full" />
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="animate-pulse rounded bg-surface-elevated h-10 w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className={className}>
        <ErrorState
          safeMessage={safeErrorMessage ?? "The Agent roster could not be loaded."}
          onRetry={onRetry}
        />
      </div>
    );
  }

  // D41: the NAME is optional — only an empty roster blocks the submit, and
  // the UI refuses it with the same copy the server's typed refusal carries.
  const canSubmit = selected.size > 0 && !pending;

  return (
    <div className={className}>
      <form
        className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            const trimmed = name.trim();
            onSubmit({
              name: trimmed.length > 0 ? trimmed : null,
              rosterAgentIds: [...selected],
              coordinatorAgentId: coordinatorId,
            });
          }
        }}
      >
        <div>
          <label htmlFor="operation-name" className="text-sm font-medium text-text">
            Name <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="operation-name"
            aria-label="Operation name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Literature sweep"
            maxLength={200}
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text placeholder:text-muted"
          />
          <p className="mt-1.5 text-xs text-muted">Leave unnamed to label it automatically.</p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-text">Initial Agents</legend>
          <ul className="mt-2 flex flex-col gap-1.5">
            {identities.map((identity) => (
              <li key={identity.agent_id}>
                <label className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(identity.agent_id)}
                    onChange={(event) => {
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (event.target.checked) {
                          next.add(identity.agent_id);
                        } else {
                          next.delete(identity.agent_id);
                        }
                        return next;
                      });
                    }}
                    aria-label={`Include ${identity.display_name}`}
                    className="size-4"
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
            ))}
          </ul>
          {selected.size === 0 ? (
            <p role="status" className="mt-2 text-xs text-muted">
              An Operation needs at least one Agent. Select at least one Agent above.
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-text">Coordinator</legend>
          <div role="radiogroup" aria-label="Coordinator" className="mt-2 flex flex-col gap-1.5">
            {identities.map((identity) => (
              <label
                key={identity.agent_id}
                className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2"
              >
                <input
                  type="radio"
                  name="operation-coordinator"
                  value={identity.agent_id}
                  checked={coordinatorId === identity.agent_id}
                  onChange={() => setCoordinatorId(identity.agent_id)}
                  aria-label={`Coordinator: ${identity.display_name}`}
                  className="size-4"
                />
                <span className="min-w-0 truncate text-sm text-text">{identity.display_name}</span>
              </label>
            ))}
            <label className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2">
              <input
                type="radio"
                name="operation-coordinator"
                value="none"
                checked={coordinatorId === "none"}
                onChange={() => setCoordinatorId("none")}
                aria-label="No coordinator (peer-to-peer)"
                className="size-4"
              />
              <span className="min-w-0 text-sm text-text">No coordinator (peer-to-peer)</span>
            </label>
          </div>
          {coordinator ? (
            <p className="mt-1.5 text-xs text-muted">
              {coordinator.display_name} coordinates by default; the coordinator role is not a
              roster assignment (D46) and can be changed on the Operation later. Removing it later
              never pauses work — the Operation continues peer-to-peer (D49).
            </p>
          ) : null}
        </fieldset>

        {errorMessage ? (
          <p
            role="alert"
            className="rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-text"
          >
            {errorMessage}
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={!canSubmit}>
            Create Operation
          </Button>
        </div>
      </form>
    </div>
  );
}
