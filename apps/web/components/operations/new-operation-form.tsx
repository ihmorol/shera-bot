import { useState } from "react";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { ErrorState } from "@/components/shell/states";
import { Button } from "@/components/ui/button";
import type { AgentRosterSummary } from "@/lib/agent-api";
import { agentIdentityFromSummary } from "@/lib/operation-api";
import { cn } from "@/lib/utils";

/**
 * Ad-hoc Operation creation form (UI_DESIGN §S6, D29/D41): a name and an
 * initial same-pack roster, submitted to POST /v1/operations. The default
 * coordinator is NAMED in the copy, never silently chosen (D42); the runtime
 * validates the roster against the pinned pack and the minimum-roster rule —
 * a refusal or typed failure renders its safe message here.
 */
export function NewOperationForm({
  identities,
  state,
  safeErrorMessage,
  onRetry,
  pending,
  errorMessage,
  defaultCoordinatorId,
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
  onSubmit: (name: string, rosterAgentIds: string[]) => void;
  className?: string;
}) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  const canSubmit = name.trim().length > 0 && selected.size > 0 && !pending;

  return (
    <div className={className}>
      <form
        className="mx-auto flex max-w-md flex-col gap-4 px-4 py-8"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onSubmit(name.trim(), [...selected]);
          }
        }}
      >
        <div>
          <label htmlFor="operation-name" className="text-sm font-medium text-text">
            Name
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
        </fieldset>

        {coordinator ? (
          <p className="text-xs text-muted">
            {coordinator.display_name} coordinates by default; the coordinator role is not a roster
            assignment (D46) and can be changed on the Operation later.
          </p>
        ) : null}

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
