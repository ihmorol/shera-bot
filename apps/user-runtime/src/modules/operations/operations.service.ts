/**
 * Operations module service (S13 chunk 2; D31, D34, D36, D46, D49) — pure
 * orchestration over the operations repository, the command receipts, and the
 * injected pack catalog. No HTTP routes and no compose wiring in this chunk
 * (chunk 3 owns routes, wiring, and the @-addressing read model).
 *
 * Agents propose; the runtime validates and executes (D4/D36). THIS service is
 * the runtime's validation point for the Operation chat:
 *
 * - createOperation runtime-validates the roster against the PINNED pack
 *   catalog (D36): a candidate no installed pack claims is refused as
 *   `agent-not-in-pack`; a candidate claimed by a DIFFERENT pack is refused
 *   as `foreign-pack-refused`. The pinning snapshot (D29) is built at
 *   creation: pack id/version, roster, the roster's reachable capabilities
 *   (the D38 layered intersection starts here), and a placeholder provider
 *   snapshot.
 * - Roster commands (D36): the contract boundary already refuses
 *   foreign-pack and cost-without-approval envelopes at parse time; THIS
 *   service converts those parse refusals into PERSISTED RosterRefusals (the
 *   UI can show WHY) and additionally re-checks the pack catalog, which the
 *   contract cannot know. Same-pack low-risk additions proceed;
 *   approval-declared additions proceed with requires_approval recorded on
 *   the membership row (the real approval-artifact gate arrives with the
 *   approvals slice).
 * - Coordinator (D42/D49): set to an Agent or "none" at ANY time, including
 *   mid-run. Removal records a typed CoordinatorRemoved lifecycle event and
 *   NEVER cancels or pauses in-flight runs — the run continues peer-to-peer
 *   (D7); the coordinator is a synthesis role, not lifecycle machinery.
 * - Runs (D31/AC24): each run owns its state (the D8 vocabulary — never a
 *   second state machine), its D26 events_seq_cursor, its credits, and its
 *   artifacts. applyRunState is the persistence-level state write validated
 *   against the D8 vocabulary; transition LEGALITY belongs to the runtime
 *   gateway, which owns authoritative transitions.
 * - Delegation (D34/D46): a TaskDelegated D7 event creates EXACTLY ONE child
 *   run with parent_task_id = the delegating run's id. Idempotent on the
 *   event_id through a command receipt written in the SAME transaction as the
 *   child run (D23 rule 6): a replay returns the original child run. A
 *   child's failure never touches the parent run.
 * - Collaboration events (D7/D26): every append validates through the
 *   contracts union, enforces the gapless per-stream sequence, persists the
 *   sender attribution fields, and advances the run cursor for run-scoped
 *   events. Malformed events are typed-rejected — never silently dropped.
 *
 * Every mutation commits as ONE atomic transaction unit (AC2): a mid-unit
 * failure applies NOTHING. Unknown operations/runs answer with typed
 * 404-class (state-category) rejections; malformed input with validation
 * rejections — messages never echo internals (G3).
 */
import { randomUUID } from "node:crypto";

import {
  AddRosterAgentCommand,
  Id,
  JsonObject,
  OperationCollaborationEvent,
  OperationCoordinatorRef,
  OperationRecord,
  OperationRun,
  ProviderSnapshot,
  RemoveRosterAgentCommand,
  RunState,
  type RosterRefusal,
} from "@shera-bot/contracts";

import type { PackAgentSeed } from "../../adapters/sqlite/agents-repository.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import {
  OPERATION_CHAT_STREAM_PREFIX,
  OperationRecordCorruptError,
  OperationsRepository,
  type OperationCoordinatorEventRow,
  type OperationRosterRefusalRow,
} from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";

/** Stable failure codes for the operations boundary (SCREAMING_SNAKE). */
export type OperationsServiceFailureCode =
  | "OPERATION_NOT_FOUND"
  | "OPERATION_RUN_NOT_FOUND"
  | "OPERATION_ROSTER_AGENT_NOT_FOUND"
  | "OPERATION_COORDINATOR_NOT_FOUND"
  | "OPERATION_ROSTER_REFUSED"
  | "OPERATION_COMMAND_INVALID"
  | "OPERATION_EVENT_INVALID"
  | "OPERATION_RUN_STATE_INVALID";

export class OperationsServiceError extends Error {
  readonly code: OperationsServiceFailureCode;
  readonly category: "validation" | "conflict" | "state" | "policy";
  /** The typed D36 refusal when (and only when) the code is OPERATION_ROSTER_REFUSED. */
  readonly refusal: RosterRefusal | null;

  constructor(
    code: OperationsServiceFailureCode,
    category: "validation" | "conflict" | "state" | "policy",
    message: string,
    refusal: RosterRefusal | null = null,
  ) {
    super(`${code}: ${message}`);
    this.name = "OperationsServiceError";
    this.code = code;
    this.category = category;
    this.refusal = refusal;
  }
}

/**
 * The pack catalog dependency (chunk 3 wires the loaded workspace pack over
 * this interface, the same late-binding discipline as the agents service's
 * pack seeds). `locateAgentPack` lets the runtime distinguish a FOREIGN
 * pack's agent (`foreign-pack-refused`) from an id no installed pack claims
 * (`agent-not-in-pack`) — the contract boundary cannot know runtime pack
 * data, so this check lives here (D36).
 */
export interface OperationPackCatalog {
  /** The workspace's pinned pack identity (D28/D29). */
  readonly pack_id: string;
  readonly pack_version: string;
  /** The pinned pack's agent roster (the seed source). */
  readonly agents: readonly PackAgentSeed[];
  /** Which installed pack owns an agent id; null when no pack claims it. */
  locateAgentPack(agentId: string): string | null;
}

export interface CreateOperationInput {
  /** Null for ad-hoc Operations (D41, D29). */
  definition_ref: string | null;
  name: string;
  roster_agent_ids: string[];
  coordinator_agent_id: OperationCoordinatorRef;
}

export interface CreateOperationRunInput {
  /** Generated when omitted; must not use the reserved operation-chat stream prefix. */
  run_id?: string;
  /** The D34/D46 delegation link: the parent RUN's id, validated to exist. */
  parent_task_id?: string | null;
  provider_snapshot?: ProviderSnapshot;
}

/** The result of applying a D36 roster command: applied, or refused with the persisted refusal. */
export type ApplyRosterOutcome =
  | { outcome: "applied"; operation: OperationRecord }
  | { outcome: "refused"; refusal: RosterRefusal; refusal_row: OperationRosterRefusalRow };

/** One appended D7 collaboration event with its stream position. */
export interface AppendedCollaborationEvent {
  sequence: number;
  stream_id: string;
  /** False when the event_id already existed (idempotent no-op — the original). */
  created: boolean;
  event: OperationCollaborationEvent;
}

/** The exactly-one child run a TaskDelegated event creates (D34/D46). */
export interface DelegationResult {
  event: OperationCollaborationEvent;
  child_run: OperationRun;
  /** False when the event_id already applied (idempotent replay of the original child). */
  created: boolean;
}

export interface OperationsServiceDeps {
  operations: OperationsRepository;
  packCatalog: OperationPackCatalog;
  tx: SqliteTransactions;
  /** Injected clock (ISO strings); defaults to the system clock. */
  clock?: () => string;
}

/** Fixed, UI-safe refusal copy (never zod internals — G3). */
const REFUSAL_MESSAGES: Record<RosterRefusal["refusal_code"], string> = {
  "agent-not-in-pack": "This Agent is not a member of the Operation's pinned Pack.",
  "foreign-pack-refused": "This Agent belongs to a pack other than the Operation's pinned Pack.",
  "cost-increase-needs-approval":
    "Adding this Agent increases cost or access and needs your approval first.",
};

export class OperationsService {
  private readonly receipts: CommandReceiptsRepository;
  private readonly clock: () => string;

  constructor(private readonly deps: OperationsServiceDeps) {
    this.receipts = new CommandReceiptsRepository(deps.tx);
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  private now(): string {
    return this.clock();
  }

  private get catalog(): OperationPackCatalog {
    return this.deps.packCatalog;
  }

  // -------------------------------------------------------------------------
  // Operations (D31 workspace/chat record)
  // -------------------------------------------------------------------------

  /**
   * Create the Operation chat record: runtime-validate the roster against the
   * PINNED pack catalog, build the D29 pinning snapshot, and persist the
   * record plus its roster membership rows in ONE transaction. A refused
   * roster leaves NOTHING behind.
   */
  createOperation(workspaceId: string, input: CreateOperationInput): OperationRecord {
    if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 200) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "operation name must be 1-200 characters",
      );
    }
    if (
      input.definition_ref !== null &&
      (typeof input.definition_ref !== "string" ||
        input.definition_ref.length < 1 ||
        input.definition_ref.length > 512)
    ) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "definition_ref must be null or 1-512 characters",
      );
    }
    const roster = this.validatedRoster(input.roster_agent_ids);
    const coordinator = this.validatedCoordinator(input.coordinator_agent_id);
    this.validatedRosterMembership(roster);

    const now = this.now();
    const record = OperationRecord.parse({
      operation_id: randomUUID(),
      workspace_id: workspaceId,
      definition_ref: input.definition_ref,
      name: input.name,
      status: "active",
      coordinator_agent_id: coordinator,
      pinning: {
        pack_id: this.catalog.pack_id,
        pack_version: this.catalog.pack_version,
        roster_agent_ids: roster,
        capabilities: this.pinningCapabilities(roster),
        provider_snapshot: {},
      },
      created_at: now,
      updated_at: now,
    });

    this.deps.tx.transaction((exec) => {
      this.deps.operations.createOperation(workspaceId, record, exec);
      for (const agentId of roster) {
        this.deps.operations.addRosterMember(
          {
            workspace_id: workspaceId,
            operation_id: record.operation_id,
            agent_id: agentId,
            pack_id: this.catalog.pack_id,
            pack_version: this.catalog.pack_version,
            requires_approval: 0,
            added_at: now,
          },
          exec,
        );
      }
    });
    return record;
  }

  /** One Operation of THIS workspace; a foreign workspace's Operation is unreachable. */
  getOperation(workspaceId: string, operationId: string): OperationRecord {
    return this.requireOperation(workspaceId, operationId);
  }

  listOperations(workspaceId: string): OperationRecord[] {
    return this.deps.operations.listOperations(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Roster commands (D36)
  // -------------------------------------------------------------------------

  /**
   * Apply an operation.add_roster_agent envelope. The contract parse refuses
   * foreign-pack and cost-without-approval envelopes outright; their refusal
   * codes are converted here into PERSISTED RosterRefusals. The service
   * additionally re-checks the pack catalog (runtime data the contract cannot
   * know). Same-pack additions proceed; the membership row records whether
   * the addition was approval-declared.
   */
  addRosterAgent(command: unknown): ApplyRosterOutcome {
    const scope = this.commandScope(command);
    const workspaceId = scope.workspace_id;
    const operationId = scope.operation_id;
    this.requireOperation(workspaceId, operationId);

    const parsed = AddRosterAgentCommand.safeParse(command);
    if (!parsed.success) {
      const refusal = this.refusalFromParseIssues(parsed.error.issues, scope.raw);
      if (refusal !== null) {
        return { outcome: "refused", refusal, refusal_row: this.persistRefusal(workspaceId, operationId, refusal, scope.raw) };
      }
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "add-roster command does not conform to AddRosterAgentCommand",
      );
    }

    // Service-level pack-catalog defense (D36): the envelope's pack claim and
    // the runtime's own pack resolution must BOTH agree on the pinned pack.
    if (parsed.data.pack_id !== this.catalog.pack_id) {
      return this.refusedAdd(workspaceId, operationId, "foreign-pack-refused", {
        agent_id: parsed.data.agent_id,
        pack_id: parsed.data.pack_id,
      });
    }
    const located = this.catalog.locateAgentPack(parsed.data.agent_id);
    if (located === null) {
      return this.refusedAdd(workspaceId, operationId, "agent-not-in-pack", {
        agent_id: parsed.data.agent_id,
        pack_id: parsed.data.pack_id,
      });
    }
    if (located !== this.catalog.pack_id) {
      return this.refusedAdd(workspaceId, operationId, "foreign-pack-refused", {
        agent_id: parsed.data.agent_id,
        pack_id: located,
      });
    }

    const now = this.now();
    return this.deps.tx.transaction((exec) => {
      // Idempotent: an existing membership is left untouched (D23 rule 6).
      this.deps.operations.addRosterMember(
        {
          workspace_id: workspaceId,
          operation_id: operationId,
          agent_id: parsed.data.agent_id,
          pack_id: parsed.data.pack_id,
          pack_version: parsed.data.pack_version,
          requires_approval: parsed.data.risk.requires_approval ? 1 : 0,
          added_at: now,
        },
        exec,
      );
      const operation = this.deps.operations.getOperation(workspaceId, operationId, exec);
      if (operation === null) {
        throw new OperationsServiceError(
          "OPERATION_NOT_FOUND",
          "state",
          `operation ${operationId} not found in workspace ${workspaceId}`,
        );
      }
      return { outcome: "applied" as const, operation };
    });
  }

  /**
   * Apply an operation.remove_roster_agent envelope. Coordinator membership
   * is unaffected: the coordinator role is not a roster assignment (D46).
   */
  removeRosterAgent(command: unknown): ApplyRosterOutcome {
    const scope = this.commandScope(command);
    this.requireOperation(scope.workspace_id, scope.operation_id);

    const parsed = RemoveRosterAgentCommand.safeParse(command);
    if (!parsed.success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "remove-roster command does not conform to RemoveRosterAgentCommand",
      );
    }

    const roster = this.deps.operations.listRoster(scope.workspace_id, scope.operation_id);
    if (!roster.some((member) => member.agent_id === parsed.data.agent_id)) {
      throw new OperationsServiceError(
        "OPERATION_ROSTER_AGENT_NOT_FOUND",
        "state",
        `agent ${parsed.data.agent_id} is not in the roster of operation ${scope.operation_id}`,
      );
    }

    return this.deps.tx.transaction((exec) => {
      this.deps.operations.removeRosterMember(
        scope.workspace_id,
        scope.operation_id,
        parsed.data.agent_id,
        exec,
      );
      const operation = this.deps.operations.getOperation(scope.workspace_id, scope.operation_id, exec);
      if (operation === null) {
        throw new OperationsServiceError(
          "OPERATION_NOT_FOUND",
          "state",
          `operation ${scope.operation_id} not found in workspace ${scope.workspace_id}`,
        );
      }
      return { outcome: "applied" as const, operation };
    });
  }

  /** The persisted D36 refusals of one operation — the UI's "why" evidence. */
  listRosterRefusals(workspaceId: string, operationId: string): OperationRosterRefusalRow[] {
    this.requireOperation(workspaceId, operationId);
    return this.deps.operations.listRosterRefusals(workspaceId, operationId);
  }

  // -------------------------------------------------------------------------
  // Coordinator lifecycle (D42/D49)
  // -------------------------------------------------------------------------

  /**
   * Set the coordinator to an Agent id or remove it ("none") at ANY time,
   * including mid-run. The change and its D49 lifecycle event commit in ONE
   * transaction; in-flight runs are NEVER cancelled or paused by this path.
   * Setting the SAME coordinator again is a no-op that records nothing.
   */
  setCoordinator(
    workspaceId: string,
    operationId: string,
    coordinator: OperationCoordinatorRef,
  ): OperationRecord {
    const record = this.requireOperation(workspaceId, operationId);
    const next = this.validatedCoordinator(coordinator);
    if (record.coordinator_agent_id === next) {
      return record;
    }

    const eventType = next === "none" ? "CoordinatorRemoved" : "CoordinatorSet";
    const eventAgentId = next === "none" ? record.coordinator_agent_id : next;
    const now = this.now();
    return this.deps.tx.transaction((exec) => {
      this.deps.operations.updateCoordinator(workspaceId, operationId, next, now, exec);
      this.deps.operations.recordCoordinatorEvent(
        workspaceId,
        {
          operation_id: operationId,
          event_id: randomUUID(),
          event_type: eventType,
          agent_id: eventAgentId === "none" ? null : eventAgentId,
          created_at: now,
        },
        exec,
      );
      const updated = this.deps.operations.getOperation(workspaceId, operationId, exec);
      if (updated === null) {
        throw new OperationsServiceError(
          "OPERATION_NOT_FOUND",
          "state",
          `operation ${operationId} not found in workspace ${workspaceId}`,
        );
      }
      return updated;
    });
  }

  /** The D49 coordinator lifecycle events of one operation, oldest first. */
  listCoordinatorEvents(workspaceId: string, operationId: string): OperationCoordinatorEventRow[] {
    this.requireOperation(workspaceId, operationId);
    return this.deps.operations.listCoordinatorEvents(workspaceId, operationId);
  }

  // -------------------------------------------------------------------------
  // Runs (D31/AC24 — per-run state, cursor, credits, artifacts)
  // -------------------------------------------------------------------------

  /**
   * Create one top-level or delegated run: D8 state CREATED, D26 cursor 0
   * ("none yet"), empty credits, no artifacts. Typed creation only (D34) —
   * the runtime gateway, never an agent, decides that a run exists.
   */
  createRun(workspaceId: string, operationId: string, input: CreateOperationRunInput = {}): OperationRun {
    this.requireOperation(workspaceId, operationId);

    const runId = input.run_id ?? randomUUID();
    if (!Id.safeParse(runId).success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "run_id must be a stable id (1-256 characters)",
      );
    }
    if (runId.startsWith(OPERATION_CHAT_STREAM_PREFIX)) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "run_id uses the reserved operation-chat stream prefix",
      );
    }

    let parentTaskId: string | null = null;
    if (input.parent_task_id !== undefined && input.parent_task_id !== null) {
      if (!Id.safeParse(input.parent_task_id).success) {
        throw new OperationsServiceError(
          "OPERATION_COMMAND_INVALID",
          "validation",
          "parent_task_id must be a stable id (1-256 characters)",
        );
      }
      parentTaskId = input.parent_task_id;
      // The D34/D46 parent link points at an existing run of the SAME
      // operation in the SAME workspace (E12) — the writer validates it (no
      // FOREIGN KEY is declared, v6 migration note).
      this.requireRunRow(workspaceId, operationId, parentTaskId);
    }

    const extras: { provider_snapshot?: ProviderSnapshot } = {};
    if (input.provider_snapshot !== undefined) {
      const snapshot = ProviderSnapshot.safeParse(input.provider_snapshot);
      if (!snapshot.success) {
        throw new OperationsServiceError(
          "OPERATION_COMMAND_INVALID",
          "validation",
          "provider_snapshot does not conform to ProviderSnapshot",
        );
      }
      extras.provider_snapshot = snapshot.data;
    }

    const now = this.now();
    const run = OperationRun.parse({
      run_id: runId,
      workspace_id: workspaceId,
      operation_id: operationId,
      parent_task_id: parentTaskId,
      state: "CREATED",
      events_seq_cursor: 0,
      ...extras,
      credits: {},
      artifacts: [],
      created_at: now,
      updated_at: now,
    });
    this.deps.operations.createRun(workspaceId, run);
    return run;
  }

  /** One run of THIS operation; a foreign workspace's run is unreachable. */
  getRun(workspaceId: string, operationId: string, runId: string): OperationRun {
    this.requireOperation(workspaceId, operationId);
    return this.requireRunRow(workspaceId, operationId, runId);
  }

  listRuns(workspaceId: string, operationId: string): OperationRun[] {
    this.requireOperation(workspaceId, operationId);
    return this.deps.operations.listRuns(workspaceId, operationId);
  }

  /**
   * Persistence-level D8 state write, validated against the RunState
   * vocabulary. Transition LEGALITY (which state may follow which) belongs to
   * the runtime gateway — this never invents a second state machine.
   */
  applyRunState(workspaceId: string, operationId: string, runId: string, state: string): OperationRun {
    this.requireOperation(workspaceId, operationId);
    this.requireRunRow(workspaceId, operationId, runId);
    const parsed = RunState.safeParse(state);
    if (!parsed.success) {
      throw new OperationsServiceError(
        "OPERATION_RUN_STATE_INVALID",
        "validation",
        "state is not a D8 RunState",
      );
    }
    this.deps.operations.updateRunState(workspaceId, operationId, runId, parsed.data, this.now());
    return this.requireRunRow(workspaceId, operationId, runId);
  }

  /** Replace the run's credits placeholder (D20/D22 shape arrives with the credits slice). */
  recordRunCredits(workspaceId: string, operationId: string, runId: string, credits: unknown): OperationRun {
    this.requireOperation(workspaceId, operationId);
    this.requireRunRow(workspaceId, operationId, runId);
    const parsed = JsonObject.safeParse(credits);
    if (!parsed.success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "credits must be a JSON object",
      );
    }
    this.deps.operations.updateRunCredits(workspaceId, operationId, runId, parsed.data, this.now());
    return this.requireRunRow(workspaceId, operationId, runId);
  }

  /** Publish one artifact id onto the run (idempotent; contract cap 100). */
  publishRunArtifact(workspaceId: string, operationId: string, runId: string, artifactId: string): OperationRun {
    this.requireOperation(workspaceId, operationId);
    const run = this.requireRunRow(workspaceId, operationId, runId);
    if (!Id.safeParse(artifactId).success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "artifact id must be a stable id (1-256 characters)",
      );
    }
    if (!run.artifacts.includes(artifactId) && run.artifacts.length >= 100) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "run artifact cap (100) reached",
      );
    }
    this.deps.operations.addRunArtifact(workspaceId, operationId, runId, artifactId, this.now());
    return this.requireRunRow(workspaceId, operationId, runId);
  }

  // -------------------------------------------------------------------------
  // Delegation (D34/D46) and collaboration events (D7/D26)
  // -------------------------------------------------------------------------

  /**
   * Apply a TaskDelegated D7 event: create EXACTLY ONE child run with
   * parent_task_id = the delegating run's id, idempotent on the event_id via
   * a command receipt written in the SAME transaction as the child run (D23
   * rule 6). The event itself is appended to the parent run's collaboration
   * stream in that transaction, so the delegation is visible in the chat and
   * the child-run creation is atomic with it. A child's later failure never
   * touches the parent run.
   */
  applyDelegation(event: unknown): DelegationResult {
    const parsed = OperationCollaborationEvent.safeParse(event);
    if (!parsed.success) {
      throw new OperationsServiceError(
        "OPERATION_EVENT_INVALID",
        "validation",
        "delegation event does not conform to the D7 collaboration union",
      );
    }
    const delegated = parsed.data;
    if (delegated.type !== "TaskDelegated") {
      throw new OperationsServiceError(
        "OPERATION_EVENT_INVALID",
        "validation",
        "only TaskDelegated events create delegated runs",
      );
    }
    if (delegated.run_id === null) {
      throw new OperationsServiceError(
        "OPERATION_EVENT_INVALID",
        "validation",
        "a delegated run needs the D34/D46 parent link: the TaskDelegated event must carry run_id",
      );
    }
    const workspaceId = delegated.workspace_id;
    const operationId = delegated.operation_id;
    this.requireOperation(workspaceId, operationId);
    const parent = this.requireRunRow(workspaceId, operationId, delegated.run_id);

    const receiptKey = `operation-task-delegated:${delegated.event_id}`;
    return this.deps.tx.transaction((exec) => {
      const receipt = this.receipts.findById(workspaceId, receiptKey, exec);
      if (receipt !== null) {
        return { event: delegated, child_run: this.replayDelegatedRun(workspaceId, operationId, receipt.result_json, exec), created: false };
      }

      const appended = this.deps.operations.appendCollaborationEvent(workspaceId, delegated, exec);
      if (!appended.created) {
        // Lost a delegation race: the winner committed the receipt.
        const winner = this.receipts.findById(workspaceId, receiptKey, exec);
        if (winner !== null) {
          return { event: delegated, child_run: this.replayDelegatedRun(workspaceId, operationId, winner.result_json, exec), created: false };
        }
        // The event was already in the stream without a delegation receipt
        // (appended bare): this path applies the delegation once — the
        // receipt keeps "exactly one child run per event_id" true.
      }

      const now = this.now();
      const child = OperationRun.parse({
        run_id: randomUUID(),
        workspace_id: workspaceId,
        operation_id: operationId,
        parent_task_id: parent.run_id,
        state: "CREATED",
        events_seq_cursor: 0,
        credits: {},
        artifacts: [],
        created_at: now,
        updated_at: now,
      });
      this.deps.operations.createRun(workspaceId, child, exec);
      this.receipts.create(
        {
          workspace_id: workspaceId,
          idempotency_key: receiptKey,
          command_type: "operation.task_delegated",
          result_json: JSON.stringify({ run_id: child.run_id }),
          created_at: now,
        },
        exec,
      );
      return { event: delegated, child_run: child, created: true };
    });
  }

  /**
   * Append one D7 collaboration event: validate through the contracts union,
   * enforce the gapless per-stream sequence, persist the sender attribution
   * fields, advance the run cursor for run-scoped events — all in the
   * repository's one transaction. Malformed events are typed-rejected and
   * nothing is persisted.
   */
  appendCollaborationEvent(event: unknown): AppendedCollaborationEvent {
    const parsed = OperationCollaborationEvent.safeParse(event);
    if (!parsed.success) {
      throw new OperationsServiceError(
        "OPERATION_EVENT_INVALID",
        "validation",
        "collaboration event does not conform to the D7 collaboration union",
      );
    }
    const validated = parsed.data;
    this.requireOperation(validated.workspace_id, validated.operation_id);
    if (validated.run_id !== null) {
      this.requireRunRow(validated.workspace_id, validated.operation_id, validated.run_id);
    }
    const { persisted, created } = this.deps.operations.appendCollaborationEvent(
      validated.workspace_id,
      validated,
    );
    return {
      sequence: persisted.sequence,
      stream_id: persisted.stream_id,
      created,
      event: persisted.event,
    };
  }

  /**
   * Cursor reads (D26): the collaboration events of one operation, narrowed
   * with `run_id` (string = that run's stream; null = the Operation-chat
   * stream; undefined = every stream) and `after_sequence` (exclusive).
   */
  listCollaborationEvents(
    workspaceId: string,
    operationId: string,
    options: { run_id?: string | null; after_sequence?: number } = {},
  ): ReturnType<OperationsRepository["listCollaborationEvents"]> {
    this.requireOperation(workspaceId, operationId);
    return this.deps.operations.listCollaborationEvents(workspaceId, operationId, {
      runId: options.run_id,
      afterSequence: options.after_sequence,
    });
  }

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  private requireOperation(workspaceId: string, operationId: string): OperationRecord {
    const record = this.deps.operations.getOperation(workspaceId, operationId);
    if (record === null) {
      throw new OperationsServiceError(
        "OPERATION_NOT_FOUND",
        "state",
        `operation ${operationId} not found in workspace ${workspaceId}`,
      );
    }
    return record;
  }

  private requireRunRow(workspaceId: string, operationId: string, runId: string): OperationRun {
    const run = this.deps.operations.getRun(workspaceId, operationId, runId);
    if (run === null) {
      throw new OperationsServiceError(
        "OPERATION_RUN_NOT_FOUND",
        "state",
        `run ${runId} not found in operation ${operationId} (workspace ${workspaceId})`,
      );
    }
    return run;
  }

  private validatedRoster(rosterAgentIds: string[]): string[] {
    if (!Array.isArray(rosterAgentIds) || rosterAgentIds.length < 1 || rosterAgentIds.length > 50) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "roster_agent_ids must be an array of 1-50 agent ids",
      );
    }
    const seen = new Set<string>();
    for (const agentId of rosterAgentIds) {
      if (!Id.safeParse(agentId).success) {
        throw new OperationsServiceError(
          "OPERATION_COMMAND_INVALID",
          "validation",
          "every roster id must be a stable id (1-256 characters)",
        );
      }
      if (seen.has(agentId)) {
        throw new OperationsServiceError(
          "OPERATION_COMMAND_INVALID",
          "validation",
          `roster names agent ${agentId} more than once`,
        );
      }
      seen.add(agentId);
    }
    return rosterAgentIds;
  }

  private validatedCoordinator(coordinator: OperationCoordinatorRef): OperationCoordinatorRef {
    if (!OperationCoordinatorRef.safeParse(coordinator).success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "coordinator_agent_id must be an Agent id or \"none\"",
      );
    }
    if (coordinator !== "none" && !this.catalog.agents.some((agent) => agent.agent_id === coordinator)) {
      throw new OperationsServiceError(
        "OPERATION_COORDINATOR_NOT_FOUND",
        "state",
        `agent ${coordinator} is not an Agent of the pinned pack`,
      );
    }
    return coordinator;
  }

  /** D36 runtime validation at creation: every roster id belongs to the pinned pack. */
  private validatedRosterMembership(roster: string[]): void {
    for (const agentId of roster) {
      const located = this.catalog.locateAgentPack(agentId);
      if (located === null) {
        throw this.rosterRefused("agent-not-in-pack", { agent_id: agentId });
      }
      if (located !== this.catalog.pack_id) {
        throw this.rosterRefused("foreign-pack-refused", { agent_id: agentId, pack_id: located });
      }
    }
  }

  /** The D38 capability snapshot placeholder: the roster's reachable capabilities. */
  private pinningCapabilities(roster: string[]): string[] {
    const capabilities = new Set<string>();
    for (const agentId of roster) {
      const seed = this.catalog.agents.find((agent) => agent.agent_id === agentId);
      if (seed === undefined) {
        continue; // unreachable: membership is validated first
      }
      for (const skill of seed.skills) {
        capabilities.add(skill);
      }
      for (const tool of seed.tools) {
        capabilities.add(`${tool.tool_id}@${tool.version}`);
      }
      for (const connector of seed.connectors) {
        capabilities.add(connector);
      }
    }
    return [...capabilities].sort().slice(0, 200);
  }

  private commandScope(command: unknown): {
    raw: Record<string, unknown> | null;
    workspace_id: string;
    operation_id: string;
  } {
    const raw = typeof command === "object" && command !== null ? (command as Record<string, unknown>) : null;
    const workspaceId = raw !== null && typeof raw.workspace_id === "string" ? raw.workspace_id : null;
    const operationId = raw !== null && typeof raw.operation_id === "string" ? raw.operation_id : null;
    if (workspaceId === null || operationId === null) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "roster command must carry workspace_id and operation_id",
      );
    }
    return { raw, workspace_id: workspaceId, operation_id: operationId };
  }

  /**
   * Extract the D36 refusal code a contract superRefine attached to the parse
   * failure (the contracts' `params.refusal_code` is the contract between the
   * schema boundary and this service). The issue union's static shape is not
   * stable across zod majors, so the lookup is structural by design.
   */
  private refusalFromParseIssues(
    issues: readonly unknown[],
    raw: Record<string, unknown> | null,
  ): RosterRefusal | null {
    for (const issue of issues) {
      const code = (issue as { params?: { refusal_code?: unknown } }).params?.refusal_code;
      if (code !== "foreign-pack-refused" && code !== "cost-increase-needs-approval") {
        continue;
      }
      return {
        refusal_code: code,
        message: REFUSAL_MESSAGES[code],
        ...(raw !== null && typeof raw.agent_id === "string" ? { agent_id: raw.agent_id } : {}),
        ...(raw !== null && typeof raw.pack_id === "string" ? { pack_id: raw.pack_id } : {}),
      };
    }
    return null;
  }

  private refusedAdd(
    workspaceId: string,
    operationId: string,
    refusalCode: RosterRefusal["refusal_code"],
    partial: { agent_id?: string; pack_id?: string },
  ): { outcome: "refused"; refusal: RosterRefusal; refusal_row: OperationRosterRefusalRow } {
    const refusal = this.rosterRefusal(refusalCode, partial);
    return {
      outcome: "refused",
      refusal,
      refusal_row: this.persistRefusal(workspaceId, operationId, refusal, null),
    };
  }

  private rosterRefusal(
    refusalCode: RosterRefusal["refusal_code"],
    partial: { agent_id?: string; pack_id?: string },
  ): RosterRefusal {
    return {
      refusal_code: refusalCode,
      message: REFUSAL_MESSAGES[refusalCode],
      ...(partial.agent_id !== undefined ? { agent_id: partial.agent_id } : {}),
      ...(partial.pack_id !== undefined ? { pack_id: partial.pack_id } : {}),
    };
  }

  private rosterRefused(
    refusalCode: RosterRefusal["refusal_code"],
    partial: { agent_id?: string; pack_id?: string },
  ): OperationsServiceError {
    return new OperationsServiceError(
      "OPERATION_ROSTER_REFUSED",
      "policy",
      REFUSAL_MESSAGES[refusalCode],
      this.rosterRefusal(refusalCode, partial),
    );
  }

  private persistRefusal(
    workspaceId: string,
    operationId: string,
    refusal: RosterRefusal,
    rawCommand: Record<string, unknown> | null,
  ): OperationRosterRefusalRow {
    let commandJson = "null";
    if (rawCommand !== null) {
      try {
        commandJson = JSON.stringify(rawCommand) ?? "null";
      } catch {
        commandJson = JSON.stringify({ unserializable_command: true });
      }
    }
    return this.deps.operations.recordRosterRefusal(workspaceId, {
      operation_id: operationId,
      agent_id: refusal.agent_id ?? null,
      pack_id: refusal.pack_id ?? null,
      refusal_code: refusal.refusal_code,
      message: refusal.message,
      command_json: commandJson,
      created_at: this.now(),
    });
  }

  private replayDelegatedRun(
    workspaceId: string,
    operationId: string,
    receiptResultJson: string,
    exec: SqliteExec,
  ): OperationRun {
    let recorded: { run_id?: unknown };
    try {
      recorded = JSON.parse(receiptResultJson) as { run_id?: unknown };
    } catch {
      throw new OperationRecordCorruptError("delegation receipt result JSON");
    }
    if (typeof recorded.run_id !== "string") {
      throw new OperationRecordCorruptError("delegation receipt result run_id");
    }
    const child = this.deps.operations.getRun(workspaceId, operationId, recorded.run_id, exec);
    if (child === null) {
      throw new OperationRecordCorruptError("delegation receipt references a missing run");
    }
    return child;
  }
}
