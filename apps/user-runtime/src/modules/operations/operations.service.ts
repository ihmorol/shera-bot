/**
 * Operations module service (S13 chunks 2–3; D31, D34, D36, D46, D49, D41,
 * D7) — pure orchestration over the operations repository, the command
 * receipts, and the injected pack catalog. Chunk 3 adds the Operation chat
 * surface: the journaled chat binding (getOrCreateChat, D41), the addressed
 * message send (sendOperationMessage), and the merged thread read model
 * (getThread) — no HTTP routes here (the transport owns them).
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
 *   approvals slice). Removes are idempotent through a command receipt
 *   (D23 rule 6): a replayed remove answers the original applied outcome and
 *   an absent member is the no-op — never a 404 for an applied removal.
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
 * - Ad-hoc creation + naming (S14, D41): a nameless (omitted or
 *   trimmed-empty) create with a null `definition_ref` is AD-HOC and names
 *   itself `Ad-hoc · N Agents` (N = roster size); a pack-defined create
 *   (`definition_ref` set) REQUIRES a name — typed
 *   OPERATION_NAME_REQUIRED (deriving the name from the definition is
 *   deferred: no creation flow sends a definition_ref without a name today).
 *   An empty roster is refused typed (OPERATION_ROSTER_EMPTY) — an Operation
 *   needs at least one Agent (D41: ad-hoc obeys the same rules).
 * - Rename (S14, D23 rule 6): a durable row update on the record, NOT a
 *   journaled event — the Operation record has no event stream of its own
 *   beyond the D7 collaboration events (the chat conversation's journal
 *   belongs to the chat, D41), so none is invented here; idempotency rides
 *   the command receipt (`operation-rename:<command_id>`) written in the
 *   SAME transaction as the row update (ALSO on the same-name no-op, so a
 *   future replay of the command_id is inert): a replayed command answers
 *   the CURRENT record (the same re-read discipline as the remove-roster
 *   receipt).
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
  OPERATION_NAME_MAX_LENGTH,
  OperationCollaborationEvent,
  OperationCoordinatorRef,
  OperationRecord,
  OperationRenameCommand,
  OperationRun,
  ProviderSnapshot,
  RemoveRosterAgentCommand,
  RunState,
  type RosterRefusal,
} from "@shera-bot/contracts";

import type { PackAgentSeed } from "../../adapters/sqlite/agents-repository.ts";
import {
  CommandReceiptsRepository,
  isReceiptKeyConflict,
} from "../../adapters/sqlite/command-receipts-repository.ts";
import type { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import type { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import {
  OPERATION_CHAT_STREAM_PREFIX,
  OperationRecordCorruptError,
  OperationsRepository,
  isOperationChatConflict,
  type OperationCoordinatorEventRow,
  type OperationRosterRefusalRow,
} from "../../adapters/sqlite/operations-repository.ts";
import type { SqliteExec, SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { AgentsRepository } from "../../adapters/sqlite/agents-repository.ts";
import type { EventsService } from "../events/events.service.ts";
import { MessageSender } from "../events/events.types.ts";
import {
  conversationStreamFor,
  type ConversationCreatedEvent,
  type MessageAppendedEvent,
} from "../conversations/conversations.events.ts";

/** Stable failure codes for the operations boundary (SCREAMING_SNAKE). */
export type OperationsServiceFailureCode =
  | "OPERATION_NOT_FOUND"
  | "OPERATION_RUN_NOT_FOUND"
  | "OPERATION_ROSTER_AGENT_NOT_FOUND"
  | "OPERATION_COORDINATOR_NOT_FOUND"
  | "OPERATION_ROSTER_REFUSED"
  | "OPERATION_COMMAND_INVALID"
  | "OPERATION_EVENT_INVALID"
  | "OPERATION_RUN_STATE_INVALID"
  // S14 (D41 ad-hoc creation rules).
  | "OPERATION_ROSTER_EMPTY"
  | "OPERATION_NAME_REQUIRED";

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
  /**
   * S14 (UI_DESIGN S6/F6): the pinned pack's authored skill and connector
   * lists, verbatim from the manifest — the pack summary renders what the
   * pack declares; it never derives capabilities from the roster (a roster
   * subset is not the pack's capability surface).
   */
  readonly skills: readonly { skill_id: string; title?: string | null }[];
  readonly connectors: readonly { connector_id: string }[];
  /** Which installed pack owns an agent id; null when no pack claims it. */
  locateAgentPack(agentId: string): string | null;
}

/** One pinned-pack skill in the F6 summary (a pack may omit the title). */
export interface PackSummarySkill {
  skill_id: string;
  title: string | null;
}

/**
 * One pinned-pack connector in the F6 summary. D38: recommended connectors
 * are NEVER auto-installed and the prototype has no connector runtime — the
 * runtime does not pretend otherwise, so `connected` is false for every
 * connector (the UI renders "Not configured", never "Connected").
 */
export interface PackSummaryConnector {
  connector_id: string;
  connected: boolean;
}

/** The S6/F6 pack summary block on the Operation detail read model. */
export interface PackSummary {
  skills: PackSummarySkill[];
  connectors: PackSummaryConnector[];
}

export interface CreateOperationInput {
  /** Null for ad-hoc Operations (D41, D29). */
  definition_ref: string | null;
  /**
   * S14: optional for ad-hoc creates — omitted or trimmed-empty names the
   * Operation `Ad-hoc · N Agents` (the auto-label); a pack-defined create
   * (definition_ref set) REQUIRES it (typed OPERATION_NAME_REQUIRED).
   */
  name?: string | null;
  roster_agent_ids: string[];
  coordinator_agent_id: OperationCoordinatorRef;
}

/**
 * The S14 auto-label: a nameless ad-hoc Operation carries this name shape.
 * The read models derive `auto_label` by matching it (pure derivation, no
 * extra column — documented in the S14 slice); a user renaming an Operation
 * TO this exact shape reads auto_label again — an accepted, documented
 * tradeoff of derivation over state.
 */
export const ADHOC_AUTO_LABEL_PATTERN = /^Ad-hoc · \d+ Agents$/;

function adhocAutoLabel(rosterSize: number): string {
  return `Ad-hoc · ${rosterSize} Agents`;
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
  /** The appended event's gapless position on its stream (the run's stream). */
  sequence: number;
  stream_id: string;
}

export interface OperationsServiceDeps {
  operations: OperationsRepository;
  /**
   * The pack catalog. Optional at construction so chunk-2 compositions keep
   * working: without one, the EMPTY catalog refuses every roster/coordinator
   * validation (typed, nothing persists). composeRuntime late-binds the real
   * loaded pack through setPackCatalog right after the pack loads — the same
   * late-binding discipline as the agents service's pack seeds.
   */
  packCatalog?: OperationPackCatalog;
  tx: SqliteTransactions;
  /** Injected clock (ISO strings); defaults to the system clock. */
  clock?: () => string;
  /**
   * S13 chunk 3 — the Operation chat is a REAL conversation (D41): these deps
   * compose the conversation row, the journal appends, the read stream, and
   * the seeded Agent identities (thread display names). Compositions that
   * never touch the thread may omit them; a thread access without them is a
   * typed composition fault, never a silent fallback.
   */
  conversations?: Pick<ConversationsRepository, "create" | "findById">;
  events?: Pick<EventsService, "appendEvent">;
  journal?: Pick<EventJournalRepository, "listStream">;
  agents?: Pick<AgentsRepository, "getAgent">;
  /** Post-commit live fanout for chat creation and message appends; optional. */
  publish?: OperationChatPublisher;
}

/**
 * Post-commit live fanout for the Operation chat (the WebSocket layer
 * implements it; the same containment rules as every other stream).
 */
export type OperationChatPublisher = (
  event: ConversationCreatedEvent | MessageAppendedEvent,
) => void;

/**
 * The packless default: no pack claims any agent, so every roster/coordinator
 * validation is refused typed (nothing can be created against an empty pack).
 * composeRuntime replaces this with the real loaded pack via setPackCatalog.
 */
const EMPTY_PACK_CATALOG: OperationPackCatalog = {
  pack_id: "",
  pack_version: "",
  agents: [],
  skills: [],
  connectors: [],
  locateAgentPack: () => null,
};

/**
 * Resolve @mentions in one message text against the Operation roster (D7
 * recipient semantics): a token of the form `@<agent_id>` resolves when it
 * exactly matches a roster Agent's id; resolved ids are returned deduped in
 * first-appearance order. An unresolvable mention resolves to NOTHING — the
 * literal text is never rewritten and the send never fails.
 */
export function resolveMentions(text: string, rosterAgentIds: readonly string[]): string[] {
  const resolved: string[] = [];
  for (const match of text.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const token = match[1]!;
    if (rosterAgentIds.includes(token) && !resolved.includes(token)) {
      resolved.push(token);
    }
  }
  return resolved;
}

/** The chat binding of one Operation (D41 — lazy get-or-create). */
export interface OperationChatResolution {
  operation_id: string;
  conversation_id: string;
  /** True when THIS call created the chat; false when a binding resolved. */
  created: boolean;
}

export interface SendOperationMessageInput {
  idempotency_key: string;
  /** MessageSender (events.types): a user display name or an agent id. */
  sender: MessageSender;
  /** 1-4000 characters; @mentions resolve against the roster (never rewritten). */
  text: string;
}

export interface OperationMessageSendResult {
  kind: "message_sent";
  conversation_id: string;
  message_id: string;
  /** The resolved recipient Agent ids; [] = unaddressed (Operation-wide). */
  addressed_to: string[];
  event_id: string;
  /** False when the idempotency key replayed the original message. */
  created: boolean;
}

/** Sender attribution on a thread item: user display name or Agent id. */
export type OperationMessageSender =
  { kind: "user"; display_name: string } | { kind: "agent"; agent_id: string };

/**
 * One merged Operation-chat thread item (the runs panel/timeline read model):
 * (a) conversation messages with sender attribution and the resolved
 * addressing, and (b) D7 collaboration events as typed items.
 */
export type OperationThreadItem =
  | {
      kind: "message";
      message_id: string;
      conversation_id: string;
      /** The journal sequence on the conversation stream (the `after` cursor). */
      sequence: number;
      sender: OperationMessageSender;
      text: string;
      addressed_to: string[];
      occurred_at: string;
    }
  | {
      kind: "collaboration_event";
      /** The event's gapless sequence on its stream (run stream or chat sentinel). */
      sequence: number;
      stream_id: string;
      sender: { kind: "agent"; agent_id: string; display_name: string | null };
      event: OperationCollaborationEvent;
      issued_at: string;
    };

export interface OperationThread {
  operation_id: string;
  workspace_id: string;
  chat_conversation_id: string;
  items: OperationThreadItem[];
}

/** Fixed, UI-safe refusal copy (never zod internals — G3). */
const REFUSAL_MESSAGES: Record<RosterRefusal["refusal_code"], string> = {
  "agent-not-in-pack": "This Agent is not a member of the Operation's pinned Pack.",
  "foreign-pack-refused": "This Agent belongs to a pack other than the Operation's pinned Pack.",
  "cost-increase-needs-approval":
    "Adding this Agent increases cost or access and needs your approval first.",
};

/**
 * Deterministic thread order: timestamp ascending; equal timestamps keep
 * per-kind stream order (journal sequence / per-stream collaboration
 * sequence), messages before collaboration events at the same instant.
 */
function compareThreadItems(a: OperationThreadItem, b: OperationThreadItem): number {
  const at = a.kind === "message" ? a.occurred_at : a.issued_at;
  const bt = b.kind === "message" ? b.occurred_at : b.issued_at;
  if (at !== bt) {
    return at < bt ? -1 : 1;
  }
  if (a.kind !== b.kind) {
    return a.kind === "message" ? -1 : 1;
  }
  return a.sequence - b.sequence;
}

export class OperationsService {
  private readonly receipts: CommandReceiptsRepository;
  private readonly clock: () => string;
  private packCatalog: OperationPackCatalog;

  constructor(private readonly deps: OperationsServiceDeps) {
    this.receipts = new CommandReceiptsRepository(deps.tx);
    this.packCatalog = deps.packCatalog ?? EMPTY_PACK_CATALOG;
    this.clock = deps.clock ?? (() => new Date().toISOString());
  }

  /**
   * Late-bind the workspace's loaded pack (composeRuntime calls this right
   * after loadWorkspacePack — the same late-binding discipline as the agents
   * service's pack seeds and the publish hook).
   */
  setPackCatalog(catalog: OperationPackCatalog): void {
    this.packCatalog = catalog;
  }

  private now(): string {
    return this.clock();
  }

  private get catalog(): OperationPackCatalog {
    return this.packCatalog;
  }

  /**
   * S14 (UI_DESIGN S6/F6): the pinned pack's summary for the Operation detail
   * read model — the pack's authored skills (by title, null when the pack
   * omits one) and its connectors with HONEST status: D38 recommends
   * connectors but never auto-installs them, and the prototype has no
   * connector runtime, so every connector reports `connected: false` (the UI
   * renders "Not configured" — the read model never claims a live
   * connection that does not exist, G2/G3). Pure derivation over the injected
   * catalog; one Operation's pinned pack is the workspace's pinned pack
   * (D28), so no per-Operation argument is needed.
   */
  getPackSummary(): PackSummary {
    return {
      skills: this.catalog.skills.map((skill) => ({
        skill_id: skill.skill_id,
        title: skill.title ?? null,
      })),
      connectors: this.catalog.connectors.map((connector) => ({
        connector_id: connector.connector_id,
        connected: false,
      })),
    };
  }

  /**
   * The chat-composition deps (D41). A thread access without them is a
   * composition fault — surfaced typed, never a silent fallback.
   */
  private chatDeps(): {
    conversations: Pick<ConversationsRepository, "create" | "findById">;
    events: Pick<EventsService, "appendEvent">;
    journal: Pick<EventJournalRepository, "listStream">;
    agents: Pick<AgentsRepository, "getAgent"> | null;
    publish: OperationChatPublisher | null;
  } {
    if (
      this.deps.conversations === undefined ||
      this.deps.events === undefined ||
      this.deps.journal === undefined
    ) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "state",
        "the Operation chat conversation storage is not wired in this composition",
      );
    }
    return {
      conversations: this.deps.conversations,
      events: this.deps.events,
      journal: this.deps.journal,
      agents: this.deps.agents ?? null,
      publish: this.deps.publish ?? null,
    };
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
    // S14 (D41): the name is optional for AD-HOC creates — omitted or
    // trimmed-empty auto-labels from the roster size — while a pack-defined
    // create REQUIRES one (never auto-label a defined Operation; deriving
    // the name from the definition is deferred until a flow needs it).
    let name: string | null = null;
    if (typeof input.name === "string" && input.name.trim() !== "") {
      if (input.name.length > OPERATION_NAME_MAX_LENGTH) {
        throw new OperationsServiceError(
          "OPERATION_COMMAND_INVALID",
          "validation",
          "operation name must be 1-120 characters",
        );
      }
      name = input.name;
    } else if (input.definition_ref !== null) {
      throw new OperationsServiceError(
        "OPERATION_NAME_REQUIRED",
        "validation",
        "a pack-defined Operation needs a name",
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
      name: name ?? adhocAutoLabel(roster.length),
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

  /** The D36 membership rows (requires_approval flags included) of one operation. */
  listRoster(
    workspaceId: string,
    operationId: string,
  ): ReturnType<OperationsRepository["listRoster"]> {
    this.requireOperation(workspaceId, operationId);
    return this.deps.operations.listRoster(workspaceId, operationId);
  }

  /** The chat binding WITHOUT creating it (detail reads stay side-effect free). */
  findChat(workspaceId: string, operationId: string): string | null {
    this.requireOperation(workspaceId, operationId);
    return this.deps.operations.findChat(workspaceId, operationId);
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
        return {
          outcome: "refused",
          refusal,
          refusal_row: this.persistRefusal(workspaceId, operationId, refusal, scope.raw),
        };
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
   * Apply an operation.remove_roster_agent envelope. Idempotent through a
   * command receipt keyed `operation-remove-roster-agent:<command_id>`
   * (workspace-scoped), written in the SAME transaction as the removal (D23
   * rule 6 — the same seam applyDelegation and the message send use): a
   * replayed command answers the original applied outcome (re-read from the
   * CURRENT record), never a stale 404 for a removal that already committed.
   * A remove whose member is absent is the idempotent no-op — the add/remove
   * symmetry with the add's ON CONFLICT DO NOTHING — returning the current
   * record. Coordinator membership is unaffected: the coordinator role is not
   * a roster assignment (D46).
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

    const receiptKey = `operation-remove-roster-agent:${parsed.data.command_id}`;
    return this.deps.tx.transaction((exec) => {
      const receipt = this.receipts.findById(scope.workspace_id, receiptKey, exec);
      if (receipt !== null) {
        if (receipt.command_type !== "operation.remove_roster_agent") {
          throw new OperationRecordCorruptError("remove-roster receipt command type");
        }
        let stored: { removed?: unknown };
        try {
          stored = JSON.parse(receipt.result_json) as typeof stored;
        } catch {
          throw new OperationRecordCorruptError("remove-roster receipt result JSON");
        }
        if (typeof stored.removed !== "boolean") {
          throw new OperationRecordCorruptError("remove-roster receipt result shape");
        }
        const operation = this.deps.operations.getOperation(
          scope.workspace_id,
          scope.operation_id,
          exec,
        );
        if (operation === null) {
          throw new OperationsServiceError(
            "OPERATION_NOT_FOUND",
            "state",
            `operation ${scope.operation_id} not found in workspace ${scope.workspace_id}`,
          );
        }
        return { outcome: "applied" as const, operation };
      }

      // Absent member: the idempotent no-op (the DELETE matches nothing and
      // the roster is already the outcome). No receipt — the no-op is
      // naturally replayable (it re-derives the same current record).
      const removed = this.deps.operations.removeRosterMember(
        scope.workspace_id,
        scope.operation_id,
        parsed.data.agent_id,
        exec,
      );
      const operation = this.deps.operations.getOperation(
        scope.workspace_id,
        scope.operation_id,
        exec,
      );
      if (operation === null) {
        throw new OperationsServiceError(
          "OPERATION_NOT_FOUND",
          "state",
          `operation ${scope.operation_id} not found in workspace ${scope.workspace_id}`,
        );
      }
      if (removed) {
        this.receipts.create(
          {
            workspace_id: scope.workspace_id,
            idempotency_key: receiptKey,
            command_type: "operation.remove_roster_agent",
            result_json: JSON.stringify({ removed }),
            created_at: this.now(),
          },
          exec,
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
  // Rename (S14 — the user-owned Operation name; D41, D23 rule 6)
  // -------------------------------------------------------------------------

  /**
   * Apply an operation.rename_operation envelope: a DURABLE ROW UPDATE on the
   * Operation record — deliberately NOT journaled. The record has no event
   * stream of its own beyond the D7 collaboration events (the chat
   * conversation's journal belongs to the chat, D41), and inventing a
   * parallel stream for one user-owned field would be a second mutation path
   * for the same row; the agent-settings command surface already follows the
   * same not-journaled precedent for field mutations.
   *
   * Idempotency is the receipts seam (D23 rule 6), mirroring
   * removeRosterAgent: the receipt (`operation-rename:<command_id>`,
   * workspace-scoped, command type `operation.rename_operation`) commits in
   * the SAME transaction as the row update; a replay answers the CURRENT
   * record — never a duplicated effect, never a 404 for an applied rename.
   * Renaming to the SAME name (trimmed) is the naturally idempotent no-op
   * that writes no receipt: it re-derives the same answer. The name is
   * persisted trimmed (the contract guarantees 1-120 chars non-empty once
   * trimmed).
   */
  renameOperation(workspaceId: string, operationId: string, command: unknown): OperationRecord {
    const scope = this.commandScope(command);
    if (scope.workspace_id !== workspaceId || scope.operation_id !== operationId) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "rename command must target the operation named by the route",
      );
    }
    this.requireOperation(workspaceId, operationId);

    const parsed = OperationRenameCommand.safeParse(command);
    if (!parsed.success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "rename command does not conform to OperationRenameCommand",
      );
    }
    const nextName = parsed.data.name.trim();
    const receiptKey = `operation-rename:${parsed.data.command_id}`;

    return this.deps.tx.transaction((exec) => {
      const receipt = this.receipts.findById(workspaceId, receiptKey, exec);
      if (receipt !== null) {
        if (receipt.command_type !== "operation.rename_operation") {
          throw new OperationRecordCorruptError("rename receipt command type");
        }
        let stored: { name?: unknown };
        try {
          stored = JSON.parse(receipt.result_json) as typeof stored;
        } catch {
          throw new OperationRecordCorruptError("rename receipt result JSON");
        }
        if (typeof stored.name !== "string") {
          throw new OperationRecordCorruptError("rename receipt result shape");
        }
        return this.requireOperationRow(workspaceId, operationId, exec);
      }

      const operation = this.requireOperationRow(workspaceId, operationId, exec);
      const now = this.now();
      if (operation.name !== nextName) {
        this.deps.operations.updateName(workspaceId, operationId, nextName, now, exec);
      }
      // The receipt is written even for the same-name no-op: a future replay
      // of this command_id must be inert, never re-apply an old name over an
      // intervening rename (the review's replay shape).
      this.receipts.create(
        {
          workspace_id: workspaceId,
          idempotency_key: receiptKey,
          command_type: "operation.rename_operation",
          result_json: JSON.stringify({ name: nextName }),
          created_at: now,
        },
        exec,
      );
      return this.requireOperationRow(workspaceId, operationId, exec);
    });
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
  createRun(
    workspaceId: string,
    operationId: string,
    input: CreateOperationRunInput = {},
  ): OperationRun {
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

  /**
   * The operation id that owns ONE run, resolved from the run row alone (S16
   * chunk 3): the task-worker run boundary knows (workspace, run) — not the
   * operation — and this read bridges the two WITHOUT a second lookup path
   * (the same repository read the getRun routes sit on). Null when the run
   * does not exist in THIS workspace (E12: a cross-workspace run id is
   * unreachable, not an error — the caller decides what unreachable means).
   */
  findRunOperation(workspaceId: string, runId: string): string | null {
    return this.deps.operations.findRunOperation(workspaceId, runId);
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
  applyRunState(
    workspaceId: string,
    operationId: string,
    runId: string,
    state: string,
  ): OperationRun {
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
  recordRunCredits(
    workspaceId: string,
    operationId: string,
    runId: string,
    credits: unknown,
  ): OperationRun {
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
  publishRunArtifact(
    workspaceId: string,
    operationId: string,
    runId: string,
    artifactId: string,
  ): OperationRun {
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
        // The original delegation committed the event row alongside the
        // receipt: report its gapless position without re-appending.
        const original = this.deps.operations.findCollaborationEventById(
          workspaceId,
          delegated.event_id,
          exec,
        );
        if (original === null) {
          throw new OperationRecordCorruptError("delegation receipt without its stream event");
        }
        return {
          event: delegated,
          child_run: this.replayDelegatedRun(workspaceId, operationId, receipt.result_json, exec),
          created: false,
          sequence: original.sequence,
          stream_id: original.stream_id,
        };
      }

      const appended = this.deps.operations.appendCollaborationEvent(workspaceId, delegated, exec);
      if (!appended.created) {
        // Lost a delegation race: the winner committed the receipt.
        const winner = this.receipts.findById(workspaceId, receiptKey, exec);
        if (winner !== null) {
          return {
            event: delegated,
            child_run: this.replayDelegatedRun(workspaceId, operationId, winner.result_json, exec),
            created: false,
            sequence: appended.persisted.sequence,
            stream_id: appended.persisted.stream_id,
          };
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
      return {
        event: delegated,
        child_run: child,
        created: true,
        sequence: appended.persisted.sequence,
        stream_id: appended.persisted.stream_id,
      };
    });
  }

  /**
   * Append one D7 collaboration event: validate through the contracts union,
   * enforce the gapless per-stream sequence, persist the sender attribution
   * fields, advance the run cursor for run-scoped events — all in the
   * repository's one transaction. Malformed events are typed-rejected and
   * nothing is persisted. A TaskDelegated event is refused here (defense in
   * depth, D34/D46): delegation materializes its exactly-one child run ONLY
   * through applyDelegation — the HTTP route routes the type there, and the
   * plain append must never become an in-process bypass that persists the
   * event without the child run.
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
    if (validated.type === "TaskDelegated") {
      throw new OperationsServiceError(
        "OPERATION_EVENT_INVALID",
        "validation",
        "TaskDelegated events create delegated runs only through the delegation path (applyDelegation)",
      );
    }
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
  // Operation chat (D41 — the Operation chat IS a real conversation) and the
  // thread read model (S13 chunk 3)
  // -------------------------------------------------------------------------

  /**
   * Resolve the Operation chat's conversation, creating it (atomically,
   * journaled, published strictly after commit) when no binding exists yet —
   * the v5 direct-chat pattern (agents.service.ts) applied to Operations:
   * the conversation row, its `conversation.created` journal append, AND the
   * binding row commit in ONE transaction; the post-commit publish hook fires
   * only after COMMIT (AC2, B4).
   *
   * Get-or-create race containment (B5): two concurrent first calls can both
   * miss the read; the loser's binding insert hits the winner's committed
   * (workspace_id, operation_id) primary key, which rolls THIS unit back
   * atomically (no orphan conversation, no journal row) and re-reads the
   * winner's binding — the exact contract of the non-race path.
   */
  getOrCreateChat(workspaceId: string, operationId: string): OperationChatResolution {
    const operation = this.requireOperation(workspaceId, operationId);
    const deps = this.chatDeps();

    const existing = this.deps.operations.findChat(workspaceId, operationId);
    if (existing !== null) {
      return { operation_id: operationId, conversation_id: existing, created: false };
    }

    let committed: { conversation_id: string; event: ConversationCreatedEvent };
    try {
      committed = this.deps.tx.transaction((exec: SqliteExec) => {
        const conversationId = randomUUID();
        const now = this.now();
        deps.conversations.create(
          {
            id: conversationId,
            workspace_id: workspaceId,
            title: operation.name,
            revision: 1,
            created_at: now,
            updated_at: now,
          },
          exec,
        );
        const event = deps.events.appendEvent({
          event_id: randomUUID(),
          stream_id: conversationStreamFor(conversationId),
          type: "conversation.created",
          payload: {
            conversation_id: conversationId,
            workspace_id: workspaceId,
            title: operation.name,
          },
          workspace_id: workspaceId,
          correlation_id: `operation-chat:${workspaceId}:${operationId}`,
        });
        this.deps.operations.bindChat(
          workspaceId,
          { operation_id: operationId, conversation_id: conversationId, created_at: now },
          exec,
        );
        return { conversation_id: conversationId, event };
      });
    } catch (error) {
      if (isOperationChatConflict(error)) {
        const winner = this.deps.operations.findChat(workspaceId, operationId);
        if (winner !== null) {
          return { operation_id: operationId, conversation_id: winner, created: false };
        }
      }
      throw error;
    }

    // Strictly AFTER commit (AC8): a subscriber failure is contained by the
    // composition's fanout wrapper and never fails the committed creation.
    deps.publish?.(committed.event);
    return { operation_id: operationId, conversation_id: committed.conversation_id, created: true };
  }

  /**
   * Send one user/Agent message INTO the Operation chat (D41) with
   * @-addressing (D7 recipient semantics): mentions resolve against the
   * Operation roster at send time and the resolved recipient Agent ids are
   * recorded in the SAME transaction as the message append + receipt (D23
   * rule 6). Unresolvable mentions resolve to NOTHING — the literal text is
   * never rewritten and the send never fails on them; a message with no
   * resolved recipients is unaddressed ([] = Operation-wide).
   *
   * The message itself is an ordinary durable `message.appended` journal
   * event on the chat conversation's stream — the SAME stream the /v1
   * conversations command path writes, so the Operation chat's history reads
   * back through the conversations read path unchanged. One idempotency key
   * resolves to ONE message forever; a key already spent on a DIFFERENT
   * command family is a typed rejection (never a duplicated effect).
   */
  sendOperationMessage(
    workspaceId: string,
    operationId: string,
    input: SendOperationMessageInput,
  ): OperationMessageSendResult {
    this.requireOperation(workspaceId, operationId);
    if (
      typeof input.idempotency_key !== "string" ||
      input.idempotency_key.length < 8 ||
      input.idempotency_key.length > 200
    ) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "idempotency_key must be 8-200 characters",
      );
    }
    if (typeof input.text !== "string" || input.text.length < 1 || input.text.length > 4000) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "message text must be 1-4000 characters",
      );
    }
    const sender = MessageSender.safeParse(input.sender);
    if (!sender.success) {
      throw new OperationsServiceError(
        "OPERATION_COMMAND_INVALID",
        "validation",
        "sender must be a user (display name) or agent (agent id) sender",
      );
    }

    const replayed = this.replayMessageReceipt(
      this.receipts.findById(workspaceId, input.idempotency_key),
    );
    if (replayed !== null) {
      return replayed;
    }

    const deps = this.chatDeps();
    // Lazy binding: the first thread access (send or read) creates the chat.
    const chat = this.getOrCreateChat(workspaceId, operationId);
    const roster = this.deps.operations
      .listRoster(workspaceId, operationId)
      .map((member) => member.agent_id);
    const addressedTo = resolveMentions(input.text, roster);

    let committed: {
      conversation_id: string;
      message_id: string;
      addressed_to: string[];
      event_id: string;
      event: MessageAppendedEvent;
    };
    try {
      committed = this.deps.tx.transaction((exec: SqliteExec) => {
        const conversation = deps.conversations.findById(workspaceId, chat.conversation_id, exec);
        if (conversation === null) {
          throw new OperationRecordCorruptError("bound operation chat conversation is missing");
        }
        const messageId = randomUUID();
        const event = deps.events.appendEvent({
          event_id: randomUUID(),
          stream_id: conversationStreamFor(chat.conversation_id),
          type: "message.appended",
          payload: {
            conversation_id: chat.conversation_id,
            workspace_id: workspaceId,
            message_id: messageId,
            sender: sender.data,
            text: input.text,
          },
          workspace_id: workspaceId,
          correlation_id: input.idempotency_key,
        });
        this.receipts.create(
          {
            workspace_id: workspaceId,
            idempotency_key: input.idempotency_key,
            command_type: "operation.message_send",
            result_json: JSON.stringify({
              kind: "message_sent",
              conversation_id: chat.conversation_id,
              message_id: messageId,
              addressed_to: addressedTo,
              event_id: event.event_id,
            }),
            created_at: this.now(),
          },
          exec,
        );
        this.deps.operations.recordMessageRecipients(
          workspaceId,
          {
            message_id: messageId,
            operation_id: operationId,
            addressed_to: addressedTo,
            recorded_at: this.now(),
          },
          exec,
        );
        return {
          conversation_id: chat.conversation_id,
          message_id: messageId,
          addressed_to: addressedTo,
          event_id: event.event_id,
          event,
        };
      });
    } catch (error) {
      if (isReceiptKeyConflict(error)) {
        const winner = this.replayMessageReceipt(
          this.receipts.findById(workspaceId, input.idempotency_key),
        );
        if (winner !== null) {
          return winner;
        }
      }
      throw error;
    }

    // Strictly AFTER commit (AC8).
    deps.publish?.(committed.event);
    return {
      kind: "message_sent",
      conversation_id: committed.conversation_id,
      message_id: committed.message_id,
      addressed_to: committed.addressed_to,
      event_id: committed.event_id,
      created: true,
    };
  }

  /**
   * Replay a recorded operation.message_send receipt, or null when no
   * receipt (or a foreign command family's receipt) sits on the key.
   */
  private replayMessageReceipt(
    receipt: ReturnType<CommandReceiptsRepository["findById"]>,
  ): OperationMessageSendResult | null {
    if (receipt === null || receipt.command_type !== "operation.message_send") {
      if (receipt !== null) {
        throw new OperationsServiceError(
          "OPERATION_COMMAND_INVALID",
          "conflict",
          "idempotency_key was already used by a different command",
        );
      }
      return null;
    }
    let stored: {
      conversation_id?: unknown;
      message_id?: unknown;
      addressed_to?: unknown;
      event_id?: unknown;
    };
    try {
      stored = JSON.parse(receipt.result_json) as typeof stored;
    } catch {
      throw new OperationRecordCorruptError("operation.message_send receipt result JSON");
    }
    if (
      typeof stored.conversation_id !== "string" ||
      typeof stored.message_id !== "string" ||
      typeof stored.event_id !== "string" ||
      !Array.isArray(stored.addressed_to)
    ) {
      throw new OperationRecordCorruptError("operation.message_send receipt result shape");
    }
    return {
      kind: "message_sent",
      conversation_id: stored.conversation_id,
      message_id: stored.message_id,
      addressed_to: stored.addressed_to as string[],
      event_id: stored.event_id,
      created: false,
    };
  }

  /**
   * The merged Operation-chat thread (D41): (a) the chat conversation's
   * durable messages — sender attribution (user display name / Agent id) and
   * the stored @-addressing per message — and (b) every D7 collaboration
   * event of the Operation as a typed item with sender attribution. Items
   * order by timestamp (the message's journal occurred_at / the event's
   * issued_at); equal timestamps keep per-kind stream order, messages before
   * events.
   *
   * The `after_sequence` cursor pages the MESSAGE leg (the conversation
   * stream's journal sequence, exclusive); collaboration events are returned
   * in full — their own per-stream cursors live on the events read model
   * (GET /v1/operations/:id/events). First access get-or-creates the chat
   * binding (D41 — lazy).
   */
  getThread(
    workspaceId: string,
    operationId: string,
    options: { after_sequence?: number } = {},
  ): OperationThread {
    this.requireOperation(workspaceId, operationId);
    const deps = this.chatDeps();
    const chat = this.getOrCreateChat(workspaceId, operationId);
    const after = options.after_sequence ?? 0;
    const items: OperationThreadItem[] = [];

    for (const row of deps.journal.listStream(
      conversationStreamFor(chat.conversation_id),
      workspaceId,
    )) {
      if (row.sequence <= after || row.event_type !== "message.appended") {
        continue;
      }
      let payload: {
        message_id?: unknown;
        sender?: unknown;
        text?: unknown;
        conversation_id?: unknown;
      };
      try {
        payload = JSON.parse(row.payload) as typeof payload;
      } catch {
        throw new OperationRecordCorruptError("message.appended journal payload (invalid JSON)");
      }
      if (
        typeof payload.message_id !== "string" ||
        typeof payload.text !== "string" ||
        typeof payload.conversation_id !== "string" ||
        payload.sender === undefined
      ) {
        throw new OperationRecordCorruptError("message.appended journal payload");
      }
      // Re-validate the sender through the contracts union (the send path
      // validated it at write time; a journal row that no longer conforms is
      // corruption — never a silently cast thread item).
      const sender = MessageSender.safeParse(payload.sender);
      if (!sender.success) {
        throw new OperationRecordCorruptError("message.appended journal sender");
      }
      const recipients = this.deps.operations.findMessageRecipients(
        workspaceId,
        payload.message_id,
      );
      items.push({
        kind: "message",
        message_id: payload.message_id,
        conversation_id: payload.conversation_id,
        sequence: row.sequence,
        sender: sender.data,
        text: payload.text,
        addressed_to: recipients ?? [],
        occurred_at: row.occurred_at,
      });
    }

    for (const persisted of this.deps.operations.listCollaborationEvents(workspaceId, operationId, {
      runId: undefined,
    })) {
      const agent = deps.agents?.getAgent(workspaceId, persisted.event.sender_agent_id) ?? null;
      items.push({
        kind: "collaboration_event",
        sequence: persisted.sequence,
        stream_id: persisted.stream_id,
        sender: {
          kind: "agent",
          agent_id: persisted.event.sender_agent_id,
          display_name: agent?.display_name ?? null,
        },
        event: persisted.event,
        issued_at: persisted.event.issued_at,
      });
    }

    items.sort(compareThreadItems);
    return {
      operation_id: operationId,
      workspace_id: workspaceId,
      chat_conversation_id: chat.conversation_id,
      items,
    };
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

  /** Transaction-scoped requireOperation: the same typed 404 through `exec`. */
  private requireOperationRow(
    workspaceId: string,
    operationId: string,
    exec: SqliteExec,
  ): OperationRecord {
    const record = this.deps.operations.getOperation(workspaceId, operationId, exec);
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
    // S14 (D41): an Operation needs at least one Agent — the dedicated typed
    // code (400-class) instead of the generic malformed-command rejection.
    if (Array.isArray(rosterAgentIds) && rosterAgentIds.length === 0) {
      throw new OperationsServiceError(
        "OPERATION_ROSTER_EMPTY",
        "validation",
        "an Operation needs at least one Agent",
      );
    }
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
        'coordinator_agent_id must be an Agent id or "none"',
      );
    }
    if (
      coordinator !== "none" &&
      !this.catalog.agents.some((agent) => agent.agent_id === coordinator)
    ) {
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
    const raw =
      typeof command === "object" && command !== null ? (command as Record<string, unknown>) : null;
    const workspaceId =
      raw !== null && typeof raw.workspace_id === "string" ? raw.workspace_id : null;
    const operationId =
      raw !== null && typeof raw.operation_id === "string" ? raw.operation_id : null;
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
