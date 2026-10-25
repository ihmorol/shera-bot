"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { NewOperationForm } from "@/components/operations/new-operation-form";
import { OperationChatHeader } from "@/components/operations/operation-chat-header";
import { OperationPackSummary } from "@/components/operations/operation-pack-summary";
import { OperationRosterPanel } from "@/components/operations/operation-roster-panel";
import { OperationRunsPanel } from "@/components/operations/operation-runs-panel";
import { OperationThreadView } from "@/components/operations/operation-thread";
import { ContainerGate } from "@/components/shell/container-gate";
import { EmptyState, SurfaceFrame } from "@/components/shell/surface-frame";
import type { AgentRosterSummary } from "@/lib/agent-api";
import { useAgentRoster as useWorkspaceRoster } from "@/lib/agent-data";
import { useContainerResolution, useSessionIdentity } from "@/lib/container-connection";
import { operationInstanceById, rosterSubtitle } from "@/lib/fixtures";
import { findOperationTemplate } from "@/lib/navigation";
import {
  candidateAgentsForOperation,
  createOperationOutcomeMessage,
  newMessageDraftKey,
  samePackAddRisk,
  type OperationRosterMember,
} from "@/lib/operation-api";
import {
  safeOperationMessage,
  useCoordinatorCommand,
  useCreateOperation,
  useCreateRun,
  useOperationDetail,
  useOperationThread,
  useRenameOperation,
  useRosterCommand,
  useSendOperationMessage,
} from "@/lib/operation-data";
import { routes } from "@/lib/routes";

/**
 * The Operation chat surface (S13 chunk 4, UI_DESIGN §S4) and the ad-hoc
 * creation surface (§S6), wired to the REAL S13 local-API reads and writes
 * through the same-origin proxy.
 *
 * Two honest data sources (the S11 discipline):
 * - the §9 fixture Operation ids keep their labeled demo surface — the demo
 *   dataset's Operation chats do not exist in the real workspace, so a live
 *   read for them would be a guaranteed 404 pretending to be app state (G4);
 * - any other id is a REAL Operation: the container gate owns the lifecycle
 *   states, and the live surface renders the detail read model, the merged
 *   thread, and the runs panel with the D36/D42 mutation affordances.
 *
 * Every mutation invalidates the reads it affected (lib/operation-data.ts), so
 * the rendered state is the runtime's read-after-write truth. The thread
 * refreshes on send (no live socket for Operations in this slice — honest
 * refresh, never a fabricated realtime feel).
 */

export function OperationChatSurface({ operationId }: { operationId: string }) {
  const instance = operationInstanceById(operationId);
  const template = findOperationTemplate(operationId);
  const resolution = useContainerResolution();
  const readyWorkspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;

  if (instance || template) {
    return <DemoOperationChat instance={instance} templateId={template ? operationId : null} />;
  }
  if (!readyWorkspaceId) {
    // Lifecycle states (resolving, sign-in, prepare, stopped, failed) render
    // inside the gate; children only appear once the workspace is ready.
    return <ContainerGate>{null}</ContainerGate>;
  }
  return <RuntimeOperationChat workspaceId={readyWorkspaceId} operationId={operationId} />;
}

/** The §9 fixture Operation chats stay a labeled demo (§2.4 honesty, G4). */
function DemoOperationChat({
  instance,
  templateId,
}: {
  instance: ReturnType<typeof operationInstanceById>;
  templateId: string | null;
}) {
  const title = instance ? instance.title : "Operation";
  const meta = instance ? rosterSubtitle(instance) : "Operation chat";
  return (
    <SurfaceFrame title={title} meta={meta}>
      <EmptyState
        explanation={
          instance
            ? "This is a demo Operation chat — demo data, not your workspace. Use + New in the sidebar to start a real Operation."
            : "Operation runs and their live event streams land with the mock runtime. Nothing has run in this Operation yet."
        }
        action={
          templateId ? (
            <Link
              href={routes.operationPreview(templateId)}
              className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
            >
              Open the launch preview
            </Link>
          ) : (
            <Link
              href={routes.app()}
              className="text-sm text-sky underline underline-offset-4 hover:text-cool-highlight"
            >
              Back to conversations
            </Link>
          )
        }
      />
    </SurfaceFrame>
  );
}

function RuntimeOperationChat({
  workspaceId,
  operationId,
}: {
  workspaceId: string;
  operationId: string;
}) {
  const detail = useOperationDetail(workspaceId, operationId);
  const workspaceRoster = useWorkspaceRoster(workspaceId);
  const thread = useOperationThread(workspaceId, operationId);
  const session = useSessionIdentity();

  const rosterCommand = useRosterCommand(workspaceId, operationId);
  const coordinatorCommand = useCoordinatorCommand(workspaceId, operationId);
  const createRun = useCreateRun(workspaceId, operationId);
  const sendMessage = useSendOperationMessage(workspaceId, operationId);
  // S14 (D41/D23 rule 6): the user-owned rename, wired to the header affordance.
  const renameOperation = useRenameOperation(workspaceId, operationId);

  const [composerValue, setComposerValue] = useState("");
  const [confirmingAdd, setConfirmingAdd] = useState<AgentRosterSummary | null>(null);
  const [refusalMessage, setRefusalMessage] = useState<string | null>(null);
  const [renameEditing, setRenameEditing] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameErrorMessage, setRenameErrorMessage] = useState<string | null>(null);
  const [packSummaryOpen, setPackSummaryOpen] = useState(false);
  // One idempotency key per draft: a retry of the SAME send reuses it (never a
  // duplicated turn); the key rotates only after a send settles successfully.
  const [draftKey, setDraftKey] = useState(() => newMessageDraftKey());

  const operation = detail.detail?.operation ?? null;
  const runs = detail.detail?.runs ?? [];
  const pending =
    rosterCommand.isPending || coordinatorCommand.isPending || renameOperation.isPending;

  const rosterMembers: OperationRosterMember[] = useMemo(
    () => detail.detail?.roster ?? [],
    [detail.detail?.roster],
  );
  const candidates = useMemo(
    () =>
      candidateAgentsForOperation(
        workspaceRoster.agents,
        rosterMembers.map((member) => member.agent_id),
      ),
    [workspaceRoster.agents, rosterMembers],
  );

  if (detail.state === "error") {
    return (
      <SurfaceFrame title="Operation" meta="Operation chat">
        <div className="flex h-full items-start justify-center px-4 pt-10">
          <div className="w-full max-w-md">
            <OperationRosterPanel
              roster={[]}
              identities={[]}
              coordinatorAgentId="none"
              state="error"
              safeErrorMessage={detail.safeErrorMessage}
              onRetry={detail.refetch}
              candidates={[]}
              confirmingAdd={null}
              pending={false}
              refusalMessage={null}
              persistedRefusalMessage={null}
              onAddClick={() => undefined}
              onConfirmAdd={() => undefined}
              onCancelAdd={() => undefined}
              onRemove={() => undefined}
              onCoordinatorChange={() => undefined}
            />
          </div>
        </div>
      </SurfaceFrame>
    );
  }

  const packPinning = operation
    ? `${operation.pinning.pack_id} v${operation.pinning.pack_version}`
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperationChatHeader
        name={operation ? operation.name : "Operation"}
        isAdhoc={detail.detail?.is_adhoc ?? false}
        autoLabel={detail.detail?.auto_label ?? false}
        packLabel={packPinning}
        runCount={runs.length}
        renameEditing={renameEditing}
        renameDraft={renameDraft}
        renamePending={renameOperation.isPending}
        renameErrorMessage={renameErrorMessage}
        onRenameStart={() => {
          setRenameErrorMessage(null);
          setRenameDraft(operation?.name ?? "");
          setRenameEditing(true);
        }}
        onRenameCancel={() => setRenameEditing(false)}
        onRenameDraftChange={setRenameDraft}
        onRenameSubmit={() => {
          const name = renameDraft.trim();
          if (!name || renameOperation.isPending) return;
          renameOperation.mutate(name, {
            // The editor closes only on the runtime's read-after-write truth
            // (the hook invalidates the detail + list reads); a typed failure
            // keeps the editor open with its safe copy (D23 rule 4).
            onSuccess: () => {
              setRenameEditing(false);
              setRenameErrorMessage(null);
            },
            onError: (error) =>
              setRenameErrorMessage(safeOperationMessage(error, "The rename was not accepted.")),
          });
        }}
      />

      {/* S14 (UI_DESIGN S6/F6): the collapsible roster + pack skills/connectors
          summary — connectors render the runtime's honest not-configured
          status (D38), never an invented connection. */}
      <OperationPackSummary
        packSummary={detail.detail?.pack_summary ?? null}
        rosterCount={rosterMembers.length}
        open={packSummaryOpen}
        onOpenChange={setPackSummaryOpen}
        state={detail.state === "ready" ? "ready" : detail.state}
        safeErrorMessage={detail.safeErrorMessage}
        onRetry={detail.refetch}
      />

      <OperationRosterPanel
        roster={rosterMembers}
        identities={workspaceRoster.agents}
        coordinatorAgentId={operation?.coordinator_agent_id ?? "none"}
        state={detail.state === "ready" ? "ready" : detail.state}
        safeErrorMessage={detail.safeErrorMessage ?? workspaceRoster.safeErrorMessage}
        onRetry={detail.refetch}
        candidates={candidates}
        confirmingAdd={confirmingAdd}
        pending={pending}
        refusalMessage={refusalMessage}
        persistedRefusalMessage={detail.detail?.recent_refusals[0]?.message ?? null}
        onAddClick={(candidate) => {
          setRefusalMessage(null);
          setConfirmingAdd(candidate);
        }}
        onConfirmAdd={() => {
          if (!confirmingAdd) return;
          const candidate = confirmingAdd;
          setConfirmingAdd(null);
          rosterCommand.mutate(
            {
              type: "operation.add_roster_agent",
              agent_id: candidate.agent_id,
              pack_id: operation?.pinning.pack_id ?? "student",
              pack_version: operation?.pinning.pack_version ?? "1.0.0",
              risk: samePackAddRisk(),
            },
            {
              onSuccess: (outcome) => {
                if (outcome.outcome === "refused") {
                  // The runtime's fixed safe copy renders verbatim (D36/G3).
                  setRefusalMessage(outcome.refusal.message);
                }
              },
              onError: (error) =>
                // A typed failure (e.g. a raced removal) surfaces its safe
                // message — never silently swallowed, never raw internals.
                setRefusalMessage(
                  safeOperationMessage(error, "The roster command was not accepted."),
                ),
            },
          );
        }}
        onCancelAdd={() => setConfirmingAdd(null)}
        onRemove={(agentId) => {
          setRefusalMessage(null);
          rosterCommand.mutate(
            { type: "operation.remove_roster_agent", agent_id: agentId },
            {
              onSuccess: (outcome) => {
                if (outcome.outcome === "refused") {
                  setRefusalMessage(outcome.refusal.message);
                }
              },
              onError: (error) =>
                setRefusalMessage(
                  safeOperationMessage(error, "The roster command was not accepted."),
                ),
            },
          );
        }}
        onCoordinatorChange={(coordinatorAgentId) => {
          setRefusalMessage(null);
          coordinatorCommand.mutate(coordinatorAgentId);
        }}
      />

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_19rem] lg:grid-rows-1">
        <OperationThreadView
          className="min-h-0"
          items={thread.thread?.items ?? []}
          identities={workspaceRoster.agents}
          state={thread.state}
          safeErrorMessage={thread.safeErrorMessage}
          onRetry={thread.refetch}
          composerValue={composerValue}
          onComposerChange={setComposerValue}
          sendPending={sendMessage.isPending}
          onSend={() => {
            const text = composerValue.trim();
            if (!text || sendMessage.isPending) return;
            sendMessage.mutate(
              {
                text,
                displayName: session.data?.display_name ?? "User",
                idempotencyKey: draftKey,
              },
              {
                onSuccess: () => {
                  setComposerValue("");
                  setDraftKey(newMessageDraftKey());
                },
              },
            );
          }}
        />
        <aside className="min-h-0 overflow-y-auto border-t border-line bg-surface lg:border-t-0 lg:border-l">
          <OperationRunsPanel
            runs={runs}
            state={detail.state}
            safeErrorMessage={detail.safeErrorMessage}
            onRetry={detail.refetch}
            createPending={createRun.isPending}
            onCreateRun={() => createRun.mutate()}
          />
        </aside>
      </div>
    </div>
  );
}

/** The §S6 ad-hoc creation surface: the form over the live workspace roster. */
export function NewOperationSurface() {
  const resolution = useContainerResolution();
  const readyWorkspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;
  if (!readyWorkspaceId) {
    return <ContainerGate>{null}</ContainerGate>;
  }
  return <RuntimeNewOperation workspaceId={readyWorkspaceId} />;
}

/** The pack's default coordinator (D42) — the student pack's pinned value. */
const DEFAULT_COORDINATOR_ID = "agent_general_assistant";

function RuntimeNewOperation({ workspaceId }: { workspaceId: string }) {
  const roster = useWorkspaceRoster(workspaceId);
  const createOperation = useCreateOperation(workspaceId);
  const router = useRouter();

  return (
    <SurfaceFrame title="New ad-hoc Operation" meta="Pack: student v1">
      <NewOperationForm
        identities={roster.agents}
        state={roster.state}
        safeErrorMessage={roster.safeErrorMessage ?? "The Agent roster could not be loaded."}
        onRetry={roster.refetch}
        pending={createOperation.isPending}
        errorMessage={
          createOperation.isError
            ? // The typed refusal as ONE safe message: the server's safe copy
              // first, the S14 refusal codes mapped to friendly copy (G3).
              createOperationOutcomeMessage(createOperation.error)
            : null
        }
        defaultCoordinatorId={DEFAULT_COORDINATOR_ID}
        onSubmit={({ name, rosterAgentIds, coordinatorAgentId }) => {
          createOperation.mutate(
            {
              // Null when left unnamed — the server auto-labels `Ad-hoc · N
              // Agents` (D41); the coordinator may be an Agent or "none" (D42).
              name,
              roster_agent_ids: rosterAgentIds,
              coordinator_agent_id: coordinatorAgentId,
            },
            {
              onSuccess: (record) => {
                // Navigate only on the runtime's 201 record; the chat page
                // then reads the SAME record from the detail route.
                router.push(routes.operation(record.operation_id));
              },
            },
          );
        }}
      />
    </SurfaceFrame>
  );
}
