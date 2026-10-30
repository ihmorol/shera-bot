/**
 * Minimal composition root for the typed local API and its WebSocket gateway
 * (S07).
 *
 * Wires the container-local SQLite database (WAL, foreign keys, committed
 * migrations) through the repositories into the chunk-2 services, the Express
 * app factory, and — for the full runtime — a Socket.IO gateway mounted on
 * the SAME HTTP server. This is the wiring the container entrypoint will
 * reuse; here it exists so tests exercise the REAL stack — real SQLite, real
 * transactions, real HTTP and WS — not a mock transport.
 *
 * The replay snapshot loader is the conversation aggregate read through its
 * repository (workspace-scoped, E12); the retention horizon defaults to the
 * journal's lowest held sequence minus one (no compaction in this slice —
 * E10 hook), and can be overridden where a future compactor raises it.
 *
 * The publish hook is late-bound: the gateway does not exist when the
 * conversations service is constructed, but the D26/AC8 discipline holds —
 * the hook fires strictly AFTER the committing transaction, whichever
 * subscriber(s) are bound by then.
 *
 * S12 (D32 layer 2): when a session harness command is configured, the
 * composition ALSO wires the SessionSupervisor (spawn seam in
 * adapters/process) and the SessionReplyBridge on the same post-commit
 * fanout — Agent direct-chat messages address warm sessions on demand and
 * session replies land as durable conversation messages. Without a harness
 * command the supervisor is disabled and the composition behaves exactly as
 * before (G4).
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { FileAgentFolderStore } from "../../adapters/fs/agent-folder-store.ts";
import { createServer, type Server as HTTPServer } from "node:http";

import type { Express } from "express";
import type { PackSnapshot } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { AgentsRepository } from "../../adapters/sqlite/agents-repository.ts";
import type { PackAgentSeed } from "../../adapters/sqlite/agents-repository.ts";
import { ArtifactsRepository } from "../../adapters/sqlite/artifacts-repository.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { ProjectsRepository } from "../../adapters/sqlite/projects-repository.ts";
import { ToolsRepository } from "../../adapters/sqlite/tools-repository.ts";
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
import { TerminalEventsRepository } from "../../adapters/sqlite/terminal-events-repository.ts";
import { WorkspaceFilesRepository } from "../../adapters/sqlite/workspace-files-repository.ts";
import { WriteLeasesRepository } from "../../adapters/sqlite/write-leases-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { HarnessAdapter } from "../../adapters/process/harness-adapter.ts";
import { FakeHarnessAdapter } from "../../adapters/process/fake-harness-adapter.ts";
import {
  createSessionProcessSpawn,
  type SessionHarnessConfig,
} from "../../adapters/process/session-process-spawn.ts";
import { EventsService } from "../../modules/events/events.service.ts";
import { ReplayService } from "../../modules/events/replay.service.ts";
import type { EventEnvelope } from "../../modules/events/events.types.ts";
import { AgentsService } from "../../modules/agents/agents.service.ts";
import { AgentFoldersService } from "../../modules/agents/agent-folders.service.ts";
import {
  ConversationsService,
  type ConversationPublisher,
} from "../../modules/conversations/conversations.service.ts";
import {
  ScriptedReplyStreamer,
  type ScriptedReplyOptions,
} from "../../modules/conversations/reply-streamer.ts";
import {
  OperationsService,
  type OperationPackCatalog,
} from "../../modules/operations/operations.service.ts";
import { ApprovalsService } from "../../modules/approvals/approvals.service.ts";
import { CredentialVault } from "../../modules/projects/credential-vault.ts";
import { GitService } from "../../modules/git/git.service.ts";
import { ValidationRunner } from "../../modules/git/validation-runner.ts";
import { ToolRegistry } from "../../modules/tools/tool-registry.ts";
import { ToolsInventoryService } from "../../modules/tools/tools-inventory.service.ts";
import { ToolExecutor } from "../../modules/tools/tool-executor.service.ts";
import { makeNoteBindings, makeScriptedNoopBinding } from "../../modules/tools/tool-binding.ts";
import {
  SCRIPTED_TOOL_MAX_RESPONSE_BYTES,
  scriptedToolDefinitionRecord,
} from "./s20-approvals-api.ts";
import {
  buildToolsApiHandle,
  registerBuiltinNoteTools,
  type ToolsApiHandle,
} from "./s21-tools-api.ts";
import { HarnessRunService } from "../../modules/runtime/harness-run-service.ts";
import { ProviderCredentialVault } from "../../modules/providers/provider-credential-vault.ts";
import { ProviderCredentialsService } from "../../modules/providers/provider-credentials.ts";
import { ProviderCredentialsRepository } from "../../adapters/sqlite/provider-credentials-repository.ts";
import { ProvidersRepository } from "../../adapters/sqlite/providers-repository.ts";
import {
  ProviderService,
  type AgentProviderDefaultsLookup,
} from "../../modules/providers/provider-service.ts";
import { ProviderGate, ProviderGateError } from "../../modules/providers/provider-gate.ts";
import { loadWorkspacePack, type WorkspacePack } from "../../modules/runtime/pack-pin.ts";
import { seedAgentsFromPack } from "../../adapters/sqlite/agents-repository.ts";
import { WorkspacesRepository } from "../../adapters/sqlite/workspaces-repository.ts";
import {
  DEFAULT_SESSION_POLICY,
  SessionSupervisor,
  type SessionSupervisorPolicy,
} from "../../modules/sessions/session-supervisor.service.ts";
import { SessionReplyBridge } from "../../modules/sessions/session-reply-bridge.ts";
import { TerminalRecorder } from "../../modules/terminals/terminal-recorder.service.ts";
import { observeSessionSpawnWithTerminalRecorder } from "../../modules/terminals/session-terminal-recorder.ts";
import { BrowserService } from "../../modules/browser/browser.service.ts";
import { buildLiveViewsApiHandle, type BrowserLiveViewHandle } from "./s18-live-views-api.ts";
import {
  TaskWorkerAdmissionGate,
  DEFAULT_WORKER_ADMISSION_POLICY,
  type AdmissionGate,
  type AdmissionPolicy,
} from "../../modules/workers/admission.ts";
import { OperationsRunSeam } from "../../modules/workers/operations-run-seam.ts";
import { RunFlowOperationsService } from "../../modules/workers/task-run-flow.ts";
import {
  TaskWorkerSupervisor,
  type TaskWorkerSupervisorPolicy,
  type WorkerAdmissionReadout,
} from "../../modules/workers/task-worker-supervisor.service.ts";
import {
  createTaskWorkerSpawn,
  resolvePrlimitBinary,
  type TaskWorkerHarnessConfig,
} from "../../modules/workers/worker-process-spawn.ts";
import {
  reconcileTaskWorkersAfterRestart,
  type WorkerReconciliationReport,
} from "../../modules/workers/worker-reconciliation.ts";
import { RetryCoordinator } from "../../modules/tasks/retry-coordinator.service.ts";
import { RunCancellationService } from "../../modules/tasks/run-cancellation.service.ts";
import {
  buildRunControlApiHandle,
  type RunControlApiHandle,
} from "./s22-run-control-api.ts";
import { createLocalApi } from "./app.ts";
import {
  applyScriptedToolProposal,
  buildApprovalsApiHandle,
  type ScriptedToolProposalConfig,
} from "./s20-approvals-api.ts";
import { buildProjectsApiHandle, type ProjectsApiHandle } from "./s19-projects-api.ts";
import { consoleRedactedLogger, type RedactedLogger } from "../http/typed-errors.ts";
import { attachWebSocketGateway, type WebSocketGatewayHandle } from "../websocket/gateway.ts";

/**
 * The container's default workspace (E12: every product-state record carries
 * workspace_id; the prototype container has exactly one). PROTOTYPE DEFAULT —
 * owner-confirmable: production wiring supersedes this via the
 * RUNTIME_DEFAULT_WORKSPACE_ID environment variable (main.ts).
 */
export const DEFAULT_WORKSPACE_ID = "ws-local-default";

/** The prototype's pinned pack (D28): a fixed snapshot, no pack store yet. */
const DEFAULT_PACK: PackSnapshot = {
  pack_id: "pack_default",
  pack_version: "0.1.0",
  pack_hash: "0".repeat(64),
};

export interface ComposeLocalApiOptions {
  /**
   * S21: late-bound pack allow-list hook — the composition calls it once the
   * pinned pack loads (the D38 pack layer resolves from it; fail-closed
   * empty until then).
   */
  toolsInventoryHook?: (allowList: ReadonlyArray<{ tool_id: string; version: string }>) => void;
  /** Path of the container-local SQLite database file. */
  dbPath: string;
  /** Post-commit live fanout hook (HTTP-only composition; tests). */
  publish?: ConversationPublisher;
  /**
   * E10 hook: cursors strictly below the returned sequence are not replayable.
   * Default: the journal's lowest held sequence minus one (nothing compacted).
   */
  retentionHorizon?: (workspaceId: string, streamId: string) => number;
  /** B-1: the redacted sink untyped HTTP faults are recorded to. Default: console.error JSON line. */
  logUntypedFault?: RedactedLogger;
  /**
   * Deterministic clock for the runtime's written timestamps — harness-run
   * journal envelopes (composeRuntime) AND the approvals boundary's request,
   * decision, reminder, and revoke stamps (both compositions). Default: wall
   * clock; the E8 mock mode pins it so runs are byte-comparable.
   */
  now?: () => string;
  /**
   * S18 chunk 2 (G4 opt-in): the container's shared browser profile service —
   * ONE Chromium profile per user container (PRD §6) in a container-local
   * directory, started on demand by the Agent's browser driver, idle-closed
   * after `idleTimeoutMs` (default 120000), and persistent across restarts
   * (AC19; the profile dir is the D22 custody store). When it is NOT set the
   * composition has NO browser service: no browser process ever spawns and
   * the /v1/browser routes answer the honest `configured: false` — the same
   * optional-seam shape as the session supervisor and the worker system (G4).
   */
  browser?: {
    profileDir: string;
    idleTimeoutMs?: number;
  };
  /**
   * S23 (D17/G4): enforce provider custody at the turn and run-start
   * boundaries — a message.send whose conversation has no usable provider is
   * refused with the typed configuration state, and a task run whose
   * provider credential was revoked fails safely instead of spawning a
   * worker. Default: FALSE — the E2E mock and the test compositions keep
   * their standing behavior (the FakeHarnessAdapter consumes no provider;
   * D51 dual-harness). The REAL runtime (main.ts) turns this on; the
   * recorded rationale lives in the slice's engineering record. The mock
   * reply producer and enforcement are mutually exclusive (typed startup
   * failure — the scripted producer fabricates completions, which
   * enforcement exists to prevent).
   */
  providerEnforcement?: boolean;
}

export interface LocalApiHandle {
  /**
   * S21: the runtime tool executor + registry — the ONE execution path every
   * capability goes through (AC1), exposed for the tools API surface.
   */
  tools: ToolExecutor;
  toolRegistry: ToolRegistry;
  toolsApi: ToolsApiHandle;
  app: Express;
  /**
   * S20 chunk 4: the approvals service seam — the boundary the API routes
   * relay into; tests and operators may consult the AC26 gate directly.
   */
  approvals: ApprovalsService;
  /** S23: the provider registry seam — configuration, custody, resolution. */
  providers: ProviderService;
  /**
   * S18 chunk 2: the shared browser profile service seam when configured;
   * undefined otherwise (G4 — no browser process ever spawns without it).
   */
  browser: BrowserService | undefined;
  /** Closes the SQLite connection. The caller owns the database file. */
  close(): void;
}

export interface ComposeRuntimeOptions extends ComposeLocalApiOptions {
  /** Transport heartbeats (engine.io ping/pong); defaults documented in the gateway. */
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** D51 seam: the harness adapter to drive task runs. Default: the deterministic fake. */
  harnessAdapter?: HarnessAdapter;
  /** E12: the container's default workspace. Default: DEFAULT_WORKSPACE_ID. */
  workspaceId?: string;
  /** D28: the pinned pack recorded on harness-created runs. Default: DEFAULT_PACK. */
  pinnedPack?: PackSnapshot;
  /**
   * S10 (D19/D28): when set, the runtime loads the REAL pack from this
   * directory through the agent-pack-sdk at composition time — verifies its
   * `runtime_compatibility` against RUNTIME_VERSION (typed startup failure on
   * mismatch, G4), pins it on the workspace (first install or upgrade; the
   * pin upgrade affects NEW tasks only, D19), and the loaded manifest becomes
   * the harness's pinned pack (overriding `pinnedPack`). Default: unset —
   * the fixed DEFAULT_PACK snapshot, so existing compositions and tests do
   * no filesystem pack loads.
   */
  packsRoot?: string;
  /** S10: the pack id to load from `packsRoot`. Default: "student". */
  packId?: string;
  /** S10: the pack version to load from `packsRoot`. Default: latest in the tree. */
  packVersion?: string;
  /**
   * S20 chunk 4: the scripted lifecycle trigger (G4 opt-in). When set, the
   * composed FakeHarnessAdapter's script proposes ONE typed `tool.proposed`
   * journal event per run while the run is RUNNING, and the gateway runs the
   * approvals boundary over it with the execute callback withheld: any GATED
   * risk class (every D9 class except the ladder's READ_ONLY) pauses the run
   * (WAITING_FOR_APPROVAL) and files a pending approval; READ_ONLY runs
   * automatically (G6). The tool definition is runtime-authored typed
   * configuration (D38) — never a classification of proposal text (G2).
   * Default: unset — the scripted runs behave exactly as before S20 (G4).
   */
  scriptedToolProposal?: ScriptedToolProposalConfig;
  /**
   * S09 chunk 2: enable the scripted reply producer for conversation turns
   * (the mock/E2E "demo stream equivalent"). When set, every durable USER
   * message triggers transient message.delta frames followed by ONE durable
   * agent reply through the command path. Default: undefined — NO replies are
   * produced (G4: nothing fabricates a response without configuration).
   */
  scriptedReplies?: ScriptedReplyOptions;
  /**
   * S12 (D32 layer 2): the configured session harness command. When set, the
   * runtime composes the supervised warm Agent session — on-demand starts on
   * the FIRST direct-chat message, presence on the agent API, and session
   * replies landed as durable conversation messages. When it is NOT set (the
   * default), the runtime composes with the supervisor DISABLED: presence
   * reads "none" everywhere, no process ever spawns, and the send path
   * behaves exactly as before this slice (G4 — the same optional-seam shape
   * as the ScriptedReplyStreamer; the S09 E2E keeps running on the scripted
   * streamer, never through the supervisor).
   */
  sessionHarness?: SessionHarnessConfig;
  /**
   * S12: ms-scale overrides for the supervisor's documented policy defaults
   * (idle hibernation, heartbeat window, handshake timeout, restart and
   * protocol caps). The composition passes them through verbatim — the
   * policy semantics live in the supervisor.
   */
  sessionPolicy?: Partial<SessionSupervisorPolicy>;
  /**
   * S16 (D32 layer 3, E1): the configured task-worker harness command. When
   * set, the runtime composes the supervised per-run worker system — the run
   * flow starts a worker per run on the RUNNING transition, the E1 admission
   * gate queues runs when limits are hit, and boot reconciliation reaps
   * dead-pid worker rows and re-drives QUEUED runs. When it is NOT set (the
   * default), the composition has NO worker system: runs behave exactly as
   * before this slice, no worker process ever spawns, and the admission
   * readout honestly reports "not configured" (G4). The committed demo worker
   * (fake-task-worker-child.ts) is the harness command for tests and preview;
   * production real workers arrive with the tools slice.
   */
  workerHarness?: TaskWorkerHarnessConfig;
  /**
   * S16: programmatic overrides for the admission policy, merged over
   * DEFAULT_WORKER_ADMISSION_POLICY (the same seam rule as sessionPolicy).
   * Without a worker harness this is ignored (no gate is built).
   */
  workerAdmissionPolicy?: Partial<AdmissionPolicy>;
  /**
   * S16: ms-scale overrides for the task-worker supervisor's policy defaults
   * (heartbeat window, handshake timeout, escalation graces) — verbatim
   * passthrough, the policy semantics live in the supervisor.
   */
  workerPolicy?: Partial<TaskWorkerSupervisorPolicy>;
  /**
   * S22: the transient-failure retry policy override (the attempt bound and
   * the bounded backoff schedule). Default: the recorded PRD §8 policy —
   * at most three attempts, 1s/2s/4s. Tests pass a fast schedule; the
   * semantics live in the retry policy module.
   */
  retryPolicy?: { maxAttempts: number; backoffScheduleMs: readonly number[] };
}

/**
 * The composed worker supervision system (S16): the supervisor, its E1
 * admission gate, and the boot reconciliation. Present on a RuntimeHandle
 * when (and only when) a worker harness is configured (G4).
 */
export interface TaskWorkerSystem {
  supervisor: TaskWorkerSupervisor;
  admission: AdmissionGate;
  /**
   * The restart reconciliation (dead-pid rows reaped, QUEUED runs re-driven
   * into the admission queue, RECOVERY_REQUIRED left for the recovery slice).
   * Idempotent; the composition runs it once at boot (fire-and-forget) and
   * tests/operators may drive it again explicitly.
   */
  reconcile(): Promise<WorkerReconciliationReport>;
}

export interface RuntimeHandle {
  app: Express;
  /** The one HTTP server serving BOTH the local API and the WS gateway. */
  httpServer: HTTPServer;
  gateway: WebSocketGatewayHandle;
  /** The harness seam: later slices (and tests) start runs; the fake is default. */
  harness: HarnessRunService;
  /** S10: the loaded workspace pack when `packsRoot` was given; undefined otherwise. */
  pack: WorkspacePack | undefined;
  /**
   * S11: the agents seam — direct-chat resolution and the user-owned field
   * updates. The identities themselves are seeded at composition time from
   * the pinned pack; the agent API routes sit on top of this service.
   */
  agents: AgentsService;
  /** S11: durable private-folder storage behind the Agent access guard. */
  folders: AgentFoldersService;
  /**
   * S13: the operations seam — the Operation chat record, roster commands,
   * coordinator lifecycle, runs, D7 events, the journaled chat binding, the
   * addressed message send, and the merged thread read model.
   */
  operations: OperationsService;
  /** The scripted reply producer when enabled; undefined otherwise (G4). */
  replyStreamer: ScriptedReplyStreamer | undefined;
  /**
   * S12: the supervised warm Agent session seam when a harness command is
   * configured; undefined otherwise (G4) — presence reads "none" everywhere
   * and no session process ever spawns.
   */
  sessions: SessionSupervisor | undefined;
  /**
   * S16: the supervised task-worker system when a harness command is
   * configured; undefined otherwise (G4) — runs behave exactly as before,
   * no worker process ever spawns, and the admission readout reports
   * "not configured".
   */
  workers: TaskWorkerSystem | undefined;
  /**
   * S20 chunk 4: the approvals service seam — pause, decisions, the AC26
   * gate, reminders, and mutes; the HTTP surface relays into it.
   */
  approvals: ApprovalsService;
  /**
   * S21: the runtime tool executor — the ONE execution path every capability
   * goes through (registry + the D35 ladder + the approval machinery's first
   * production caller), and the registry the composition registered the
   * built-in/scripted definitions into.
   */
  tools: ToolExecutor;
  toolRegistry: ToolRegistry;
  toolsApi: ToolsApiHandle;
  /**
   * S18 chunk 1: the terminal recorder seam — the ONLY writer of
   * terminal_events and the terminal.* journal vocabulary. The session spawn
   * seam is already wired through it when a session harness is configured;
   * tests and later slices (the S26 execution tools) drive it directly.
   */
  terminals: TerminalRecorder;
  /**
   * S18 chunk 2: the shared browser profile service seam — the browser's
   * lifecycle, its D6 single-owner control boundary, and the driver seam the
   * Agent's browser work runs through. Undefined when no browser is
   * configured (G4); the read-only /v1/browser routes then answer honestly.
   */
  browser: BrowserService | undefined;
  /**
   * S19 chunk 1: the git coordination seam — project import/clone, per-
   * repository credentials, the task-scoped worktrees with their conflict
   * queue, and the approval-gated merges. The HTTP surface relays into it.
   */
  projects: ProjectsApiHandle;
  /**
   * S22: the runtime-owned retry coordinator — the bounded transient-failure
   * policy (at most three attempts, then the run pauses and notifies), the
   * supervisor's worker-failure decision seam, and the backoff clock owner.
   */
  retryCoordinator: RetryCoordinator;
  /**
   * S22: the run-control HTTP surface (the user cancel command + the run
   * journal read). The routes live on the app; the handle is the test and
   * operator seam.
   */
  runControl: RunControlApiHandle;
  /** S23: the provider registry seam — configuration, custody, resolution. */
  providers: ProviderService;
  /** Closes the gateway (and with it the HTTP server), then SQLite. */
  close(): Promise<void>;
}

interface Wired {
  conn: SqliteConnection;
  app: Express;
  replay: ReplayService;
  tx: SqliteTransactions;
  journal: EventJournalRepository;
  events: EventsService;
  conversations: ConversationsService;
  agents: AgentsService;
  folders: AgentFoldersService;
  sessions: SessionSupervisor | undefined;
  sessionBridge: SessionReplyBridge | undefined;
  operations: OperationsService;
  workers: TaskWorkerSystem | undefined;
  approvals: ApprovalsService;
  tools: ToolExecutor;
  toolRegistry: ToolRegistry;
  toolsApi: ToolsApiHandle;
  toolsInventoryHook: (allowList: ReadonlyArray<{ tool_id: string; version: string }>) => void;
  terminals: TerminalRecorder;
  browser: BrowserService | undefined;
  projects: ProjectsApiHandle;
  retryCoordinator: RetryCoordinator;
  runCancellation: RunCancellationService;
  runControl: RunControlApiHandle;
  providers: ProviderService;
  setPublisher(publisher: ConversationPublisher): void;
}

/**
 * S13 (D36): the pack catalog the operations service validates against — the
 * SAME loaded workspace pack the agents seeding consumes (one pinned pack,
 * D28). `locateAgentPack` lets the runtime tell a foreign pack's Agent
 * (`foreign-pack-refused`) from an id no installed pack claims
 * (`agent-not-in-pack`). S14 (S6/F6): the manifest's skill and connector
 * catalogs ride along verbatim — the pack summary renders what the pack
 * declares, and the service owns the honest "Not configured" connector status.
 */
function operationPackCatalog(pack: WorkspacePack): OperationPackCatalog {
  const agents = pack.manifest.agents as readonly PackAgentSeed[];
  return {
    pack_id: pack.manifest.pack_id,
    pack_version: pack.manifest.version,
    agents,
    skills: pack.manifest.skills.map((skill) => ({
      skill_id: skill.skill_id,
      title: skill.title,
    })),
    connectors: pack.manifest.connectors.map((connector) => ({
      connector_id: connector.connector_id,
      title: connector.title,
      version: connector.version,
    })),
    // S15 (D30): the definitions the launch preview reads — verbatim from the
    // pinned manifest, the same source the agents seeding consumes (D28).
    default_coordinator_agent_id: pack.manifest.default_coordinator_agent_id,
    operation_definitions: pack.manifest.operations.map((operation) => ({
      operation_id: operation.operation_id,
      version: operation.version,
      title: operation.title,
      purpose: operation.purpose,
      roster: operation.roster,
      ...(operation.coordinator !== undefined ? { coordinator: operation.coordinator } : {}),
      skills: operation.skills,
      connectors: operation.connectors,
    })),
    locateAgentPack(agentId: string): string | null {
      return agents.some((agent) => agent.agent_id === agentId) ? pack.manifest.pack_id : null;
    },
  };
}

/**
 * S18 chunk 1: the supervision facts recorded with every session-seam
 * terminal execution — the bounds the runtime ACTUALLY enforces on the child,
 * merged from the composition's policy overrides the same way the supervisor
 * merges them. `os_resource_limits` is recorded as null by the observer (no
 * OS-level limits exist on session children in this slice) — the policy
 * never claims a limit that is not enforced (G4).
 */
function supervisionRecordFrom(
  overrides: Partial<SessionSupervisorPolicy> | undefined,
): SessionSupervisionRecordShape {
  const policy = { ...DEFAULT_SESSION_POLICY, ...overrides };
  return {
    heartbeat_interval_ms: policy.heartbeatIntervalMs,
    watchdog_window_ms: policy.heartbeatIntervalMs * policy.missedHeartbeatLimit,
    stderr_max_bytes: policy.stderrMaxBytes,
    escalation: "shutdown_frame_then_sigterm_then_sigkill",
  };
}

/** The supervision record shape the session spawn observer records. */
interface SessionSupervisionRecordShape {
  heartbeat_interval_ms: number;
  watchdog_window_ms: number;
  stderr_max_bytes: number;
  escalation: "shutdown_frame_then_sigterm_then_sigkill";
}

/**
 * Fanout containment (B4/AC8): the publish hook fires strictly AFTER commit —
 * a subscriber's failure (the WS broadcast, any future transport) must never
 * fail an already-committed command or run. Errors are contained at THIS
 * wiring and recorded through the composition's redacted sink; the committed
 * result and the journal row are untouched by the fanout's fate.
 */
function containFanout<E extends EventEnvelope>(
  publisher: (event: E) => void,
  logFault: RedactedLogger,
): (event: E) => void {
  return (event) => {
    try {
      publisher(event);
    } catch (error) {
      logFault("fanout_failed", {
        stream_id: event.stream_id,
        workspace_id: event.workspace_id,
        sequence: event.sequence,
        event_type: event.type,
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      });
    }
  };
}

function wire(
  options: ComposeLocalApiOptions & {
    sessionHarness?: SessionHarnessConfig | undefined;
    sessionPolicy?: Partial<SessionSupervisorPolicy> | undefined;
    workerHarness?: TaskWorkerHarnessConfig | undefined;
    workerAdmissionPolicy?: Partial<AdmissionPolicy> | undefined;
    scriptedToolProposal?: ScriptedToolProposalConfig | undefined;
    workspaceId?: string | undefined;
    workerPolicy?: Partial<TaskWorkerSupervisorPolicy> | undefined;
    retryPolicy?: { maxAttempts: number; backoffScheduleMs: readonly number[] } | undefined;
  },
): Wired {
  const logFault = options.logUntypedFault ?? consoleRedactedLogger;
  const wireWorkspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const conn = openDatabase(options.dbPath);
  applyMigrations(conn.db);

  const tx = new SqliteTransactions(conn.db);
  const conversationsRepository = new ConversationsRepository(tx);
  const journal = new EventJournalRepository(tx);
  const receipts = new CommandReceiptsRepository(tx);
  const events = new EventsService(journal, tx);

  // Late-bound fanout: subscribers bind after construction (the WS gateway
  // mounts later); the post-commit discipline lives in the service, and the
  // subscriber's failures are contained HERE (B4) — never at the command.
  let publisher: ConversationPublisher = options.publish ?? (() => {});
  // S23: the provider gate is late-bound the same way (built below, after the
  // operations repository exists). Under enforcement the conversations
  // service consults it on every message.send.
  let turnGateRef: ProviderGate | null = null;
  const conversations = new ConversationsService({
    journal: events,
    conversations: conversationsRepository,
    receipts,
    tx,
    publish: containFanout((event) => publisher(event), logFault),
    // S23: the gate is late-bound (the provider stack builds below, after the
    // operations repository); enforcement wires it the moment it exists —
    // the closure dereferences it only when a send arrives, by which time the
    // composition has long finished wiring.
    ...(options.providerEnforcement
      ? {
          turnGate: {
            assertTurnAllowed: (workspaceId: string, conversationId: string): void => {
              if (turnGateRef === null) {
                throw new Error("the provider gate was not composed");
              }
              turnGateRef.assertTurnAllowed(workspaceId, conversationId);
            },
          },
        }
      : {}),
  });

  // S11: the agents seam shares the SAME late-bound post-commit fanout — a
  // newly created direct chat publishes its conversation.created event through
  // the identical containment (B4) as every other conversation creation.
  const agentsRepository = new AgentsRepository(tx);
  const agents = new AgentsService({
    agents: agentsRepository,
    conversations: conversationsRepository,
    journal: events,
    tx,
    publish: containFanout((event) => publisher(event), logFault),
  });

  // S18 chunk 1: the terminal recorder — the one writer of terminal_events
  // and the terminal.* journal vocabulary, over the SAME transaction and
  // journal every other writer uses (D10: each row and its entry commit in
  // one transaction; the recorder owns that composition). Always composed:
  // the read-only API surface exists on every stack and reads honestly empty
  // until an execution is recorded (G4).
  const terminalEvents = new TerminalEventsRepository(tx);
  const terminals = new TerminalRecorder({
    tx,
    terminals: terminalEvents,
    events,
  });

  // S18 chunk 2: the shared browser profile service — opt-in (G4). One
  // Chromium profile per user container in a container-local directory; the
  // browser starts on demand, idles out per its policy, and keeps cookies in
  // the profile dir across restarts (AC19; D22 custody). The service owns
  // the D6 single-owner control boundary and the D27 capability posture; the
  // HTTP surface gets ONLY the read-only handle below. Without the option
  // nothing browser-shaped exists and the routes answer configured:false.
  const browser = options.browser
    ? new BrowserService({
        profileDir: options.browser.profileDir,
        ...(options.browser.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: options.browser.idleTimeoutMs }
          : {}),
        logFault: (event, fields) => logFault(event, fields),
      })
    : undefined;
  const browserHandle: BrowserLiveViewHandle | undefined = browser
    ? {
        state: (workspaceId) => browser.stateReadout(workspaceId),
        view: (workspaceId) => browser.snapshotView(workspaceId),
      }
    : undefined;

  // S12 (D32 layer 2): the supervised warm Agent session when a harness
  // command IS configured; when it is NOT, the runtime composes with the
  // supervisor DISABLED — presence "none" everywhere, no process ever spawns,
  // and the send path behaves exactly as today (G4). The D15 context is
  // re-fetched through the agents module's public read on EVERY (re)start;
  // the supervisor never caches it.
  const sessions = options.sessionHarness
    ? new SessionSupervisor({
        events,
        // S18 chunk 1: the spawn seam is observed by the terminal recorder —
        // every session child the runtime launches is recorded (command,
        // workdir, resource policy, approval state), its stderr streams
        // through the redaction boundary, and its exit closes the record.
        // Contained: a recording failure never costs the Agent its session.
        spawnChild: observeSessionSpawnWithTerminalRecorder(
          {
            recorder: terminals,
            harness: options.sessionHarness,
            supervision: supervisionRecordFrom(options.sessionPolicy),
            logFault: (event, fields) => logFault(event, fields),
          },
          createSessionProcessSpawn(options.sessionHarness),
        ),
        contextProvider: (workspaceId, agentId) => {
          const agent = agents.getAgent(workspaceId, agentId);
          return {
            workspace_id: workspaceId,
            agent_id: agentId,
            display_name: agent.display_name,
            instructions: agent.user_instructions,
            pack_profile: agent.role_description,
          };
        },
        stderrSink: {
          // G3: child stderr is diagnostic — bounded per incarnation by the
          // supervisor, and reduced HERE to a classified digest (byte count
          // plus a conservative message-like first-line shape) so raw
          // harness bytes never reach the operator log even though the
          // conduit itself is redaction-based. Never journaled, never in
          // any API response; anything that does not read as a plain
          // message is summarized, not quoted.
          write: (chunk) => {
            const bytes = Buffer.byteLength(chunk, "utf8");
            const firstLine = chunk.split("\n", 1)[0] ?? "";
            const shape = /^[A-Za-z0-9 .:'-]{1,60}$/.test(firstLine)
              ? firstLine
              : `${firstLine.length} chars, non-message`;
            logFault("agent_session_stderr", { bytes, shape });
          },
        },
        logFault: (event, fields) => logFault(event, fields),
        ...(options.sessionPolicy ? { policy: options.sessionPolicy } : {}),
      })
    : undefined;

  // S12: the send-path bridge — a user message in an Agent direct chat
  // addresses the session on demand and lands the reply as a durable
  // conversation message through the SAME command path (D26). Direct-chat
  // resolution reads the agents repository (the binding's owner); plain
  // conversations never spawn a session.
  const sessionBridge =
    sessions !== undefined
      ? new SessionReplyBridge({
          supervisor: sessions,
          conversations,
          resolveDirectChatAgent: (workspaceId, conversationId) => {
            for (const agent of agentsRepository.listAgents(workspaceId)) {
              if (agentsRepository.findDirectChat(workspaceId, agent.agent_id) === conversationId) {
                return agent.agent_id;
              }
            }
            return null;
          },
          onFault: (event, fields) => logFault(event, fields),
        })
      : undefined;

  const folders = new AgentFoldersService({
    agents: agentsRepository,
    store: new FileAgentFolderStore(join(dirname(options.dbPath), "agent-files")),
  });

  // S17: the workspace panel storage (chunk-1/2 surfaces) — files, write
  // leases, and artifacts share the ONE SqliteTransactions instance (chunk-2
  // note 3), and the lease-conflict tooltip resolves Agent display names
  // through the agents repository's lookup (chunk-2 note 2; an unknown Agent
  // falls back to its id inside the repository). Wired into the local API
  // below as the `workspace` deps.
  const writeLeases = new WriteLeasesRepository(tx, {
    agentNameResolver: (workspaceId, agentId) =>
      agentsRepository.getAgent(workspaceId, agentId)?.display_name ?? null,
  });
  const workspaceFiles = new WorkspaceFilesRepository(tx, writeLeases);
  const workspaceArtifacts = new ArtifactsRepository(tx);

  // S13: the operations seam shares the SAME late-bound post-commit fanout —
  // the chat binding's conversation.created and a thread message.appended
  // publish through the identical containment (B4) as every other stream.
  // The pack catalog is late-bound by composeRuntime after the pack loads
  // (the agents-seed discipline); without a pack every roster validation is
  // refused typed and nothing Operation-shaped can be created.
  const operationsRepository = new OperationsRepository(tx);

  // S23: the provider registry stack (PRD §9, D17, D20, D22, E9). The vault
  // key lives beside the database (the container-local volume is the D22
  // trust boundary); the credentials repository owns the ONLY secret-shaped
  // storage; the service masks every view. The agent-defaults lookup adapts
  // the agents repository (the user-owned default pair) for the effective
  // resolution; the Operation-turn gate adapts the chat binding + the
  // coordinator Agent's default pair.
  const providersRepository = new ProvidersRepository(tx);
  const providerCredentials = new ProviderCredentialsService({
    vault: new ProviderCredentialVault(join(dirname(options.dbPath), "provider-credentials.key")),
    credentials: new ProviderCredentialsRepository(tx),
  });
  const agentDefaults: AgentProviderDefaultsLookup = {
    findAgentForDirectChat: (workspaceId, conversationId) => {
      for (const agent of agentsRepository.listAgents(workspaceId)) {
        if (agentsRepository.findDirectChat(workspaceId, agent.agent_id) === conversationId) {
          return agent.agent_id;
        }
      }
      return null;
    },
    getDefaultProvider: (workspaceId, agentId) => {
      const agent = agentsRepository.getAgent(workspaceId, agentId);
      if (!agent || !agent.default_provider_id || !agent.default_provider_model) {
        return null;
      }
      return { provider_id: agent.default_provider_id, model: agent.default_provider_model };
    },
  };
  const providers = new ProviderService({
    providers: providersRepository,
    credentials: providerCredentials,
    agentDefaults,
    ...(options.now ? { now: options.now } : {}),
  });
  // S23 chunk 5 (D17/G4): the gate exists ONLY under enforcement; without it
  // the composition behaves exactly as before (the optional-seam shape).
  const providerGate = options.providerEnforcement ? new ProviderGate({ providers }) : undefined;
  turnGateRef = providerGate ?? null;
  const operationTurnGate =
    providerGate === undefined
      ? undefined
      : {
          assertOperationTurnAllowed: (workspaceId: string, operationId: string): void => {
            const conversationId = operationsRepository.findChat(workspaceId, operationId);
            if (conversationId !== null) {
              providerGate.assertTurnAllowed(workspaceId, conversationId);
              return;
            }
            // No chat binding yet: the turn would run on the coordinator
            // Agent's default pair (the D42 synthesis role).
            const record = operationsRepository.getOperation(workspaceId, operationId);
            if (!record || record.coordinator_agent_id === "none") {
              throw new ProviderGateError(
                "PROVIDER_NOT_CONFIGURED",
                "No provider is configured for this Operation yet. Configure one in Settings → Providers & models.",
              );
            }
            providerGate.assertAgentTurnAllowed(workspaceId, record.coordinator_agent_id);
          },
        };

  // S16 (D32 layer 3): when a worker harness is configured the composed
  // operations service is the RUN-FLOW variant — applyRunState stays exactly
  // the D8-validated write and additionally drives the worker lifecycle
  // (RUNNING starts a worker, CANCELLING/terminal stops it). Without the
  // harness the plain service is composed and transitions behave exactly as
  // before (G4).
  const operations: OperationsService = options.workerHarness
    ? new RunFlowOperationsService({
        operations: operationsRepository,
        conversations: conversationsRepository,
        events,
        journal,
        agents: agentsRepository,
        tx,
        publish: containFanout((event) => publisher(event), logFault),
        ...(operationTurnGate ? { turnGate: operationTurnGate } : {}),
      })
    : new OperationsService({
        operations: operationsRepository,
        conversations: conversationsRepository,
        events,
        journal,
        agents: agentsRepository,
        tx,
        publish: containFanout((event) => publisher(event), logFault),
        ...(operationTurnGate ? { turnGate: operationTurnGate } : {}),
      });

  // S22: the runtime-owned retry coordinator — the bounded transient-failure
  // policy (PRD §8: at most three attempts, then the run pauses and notifies).
  // Built at EVERY composition (the policy is a runtime concern, not a
  // worker-harness concern); the supervisor's worker-error seam consults it
  // when a worker harness exists, and the E27 crash/protocol classes stay
  // RECOVERY_REQUIRED — only worker-REPORTED failures route to the policy.
  const retryCoordinator = new RetryCoordinator({
    events,
    journal,
    operations: operationsRepository,
    tx,
    runControl: new OperationsRunSeam(operations),
    ...(options.retryPolicy ? { policy: options.retryPolicy } : {}),
    logFault: (event, fields) => logFault(event, fields),
  });

  // S16: the supervised task-worker system (supervisor + E1 admission gate +
  // run-flow wiring + boot reconciliation). Built ONLY when a worker harness
  // command is configured — no harness, no worker system, no spawns (G4).
  // prlimit is resolved ONCE at startup (G4 typed failure naming the missing
  // binary — never a silent fall-back to unlimited workers at spawn time),
  // and the admission gate counts the DURABLE live worker rows with the
  // supervisor's per-provider attribution late-bound (the same shape as the
  // chunk-2 suites).
  const workers: TaskWorkerSystem | undefined = (() => {
    const harness = options.workerHarness;
    if (!harness) {
      return undefined;
    }
    const prlimitPath = resolvePrlimitBinary();
    const taskWorkers = new TaskWorkersRepository(tx);
    // Late-bound: the supervisor is constructed right after the gate, and the
    // per-provider counter only reads it once workers are live.
    let supervisorRef: TaskWorkerSupervisor | null = null;
    const admission = new TaskWorkerAdmissionGate(
      { ...DEFAULT_WORKER_ADMISSION_POLICY, ...(options.workerAdmissionPolicy ?? {}) },
      {
        liveWorkerCount: () => taskWorkers.listLiveAll().length,
        liveWorkerCountForProvider: (providerId) =>
          supervisorRef?.liveWorkerCountByProvider(providerId) ?? 0,
      },
      // The disk floor (when a policy configures one) measures the runtime
      // data dir — the directory the database file lives in.
      { dataDir: dirname(options.dbPath) },
    );
    const supervisor = new TaskWorkerSupervisor({
      events,
      tx,
      taskWorkers,
      runControl: new OperationsRunSeam(operations),
      admission,
      spawnChild: createTaskWorkerSpawn(harness, { prlimitPath }),
      onWorkerReportedFailure: (info) => {
        retryCoordinator.handleRunFailure({
          workspaceId: info.workspaceId,
          runId: info.runId,
          failureCode: info.failureClass,
          failureEventId: info.failureEventId,
        });
      },
      stderrSink: {
        // G3: child stderr is diagnostic — bounded per incarnation by the
        // supervisor, reduced HERE to a classified digest exactly like the
        // session harness's sink. Never journaled, never in any response.
        write: (chunk) => {
          const bytes = Buffer.byteLength(chunk, "utf8");
          const firstLine = chunk.split("\n", 1)[0] ?? "";
          const shape = /^[A-Za-z0-9 .:'-]{1,60}$/.test(firstLine)
            ? firstLine
            : `${firstLine.length} chars, non-message`;
          logFault("task_worker_stderr", { bytes, shape });
        },
      },
      logFault: (event, fields) => logFault(event, fields),
      ...(options.workerPolicy ? { policy: options.workerPolicy } : {}),
    });
    supervisorRef = supervisor;

    // The run flow (chunk 3's wiring half): committed RUNNING transitions
    // start the run's worker (fire-and-forget — a spawn never blocks a
    // state write); CANCELLING/terminal transitions stop it. The spec carries
    // the run row's provider snapshot so the E1 per-provider limit sees the
    // run's attribution.
    const specForRun = (workspaceId: string, runId: string) => {
      const operationId = operationsRepository.findRunOperation(workspaceId, runId);
      const run =
        operationId === null ? null : operationsRepository.getRun(workspaceId, operationId, runId);
      return run?.provider_snapshot
        ? {
            providerSnapshot: {
              provider_id: run.provider_snapshot.provider_id,
              model: run.provider_snapshot.model,
            },
          }
        : {};
    };
    if (operations instanceof RunFlowOperationsService) {
      operations.runFlow = {
        startRunWorker: (workspaceId, runId) => {
          // S23 (D20/D22, enforcement only): the run-start custody check. A
          // run whose provider snapshot references a missing, disabled, or
          // revoked-credential provider NEVER spawns a worker: the run is
          // driven to FAILED with a typed refusal on its own stream (no
          // credential material — G3), the fail-safe D22 names for revoked
          // credentials. Without enforcement the hook behaves exactly as
          // before (the fake workers consume no provider).
          if (providerGate) {
            const spec = specForRun(workspaceId, runId);
            const providerId = spec.providerSnapshot?.provider_id ?? null;
            const custody =
              providerId === null
                ? {
                    ok: false as const,
                    code: "PROVIDER_NOT_CONFIGURED",
                    safe_message:
                      "The run has no provider snapshot. Configure a provider and start a new run.",
                  }
                : providerGate.checkRunStart(workspaceId, providerId);
            if (!custody.ok) {
              const operationId = operationsRepository.findRunOperation(workspaceId, runId);
              logFault("task_run_provider_refused", {
                workspace_id: workspaceId,
                run_id: runId,
                code: custody.code,
              });
              if (operationId !== null) {
                try {
                  operations.applyRunState(workspaceId, operationId, runId, "FAILED");
                  events.appendEvent({
                    event_id: randomUUID(),
                    stream_id: runId,
                    type: "provider.configuration_refused",
                    payload: {
                      provider_id: providerId,
                      code: custody.code as
                        | "PROVIDER_NOT_CONFIGURED"
                        | "PROVIDER_DISABLED"
                        | "PROVIDER_CREDENTIAL_REVOKED",
                    },
                    workspace_id: workspaceId,
                    correlation_id: runId,
                  });
                } catch (error: unknown) {
                  logFault("task_run_provider_refuse_journal_failed", {
                    workspace_id: workspaceId,
                    run_id: runId,
                    name: error instanceof Error ? error.name : "Error",
                    message: error instanceof Error ? error.message : String(error),
                  });
                }
              }
              return;
            }
          }
          void supervisor
            .startWorker(workspaceId, runId, specForRun(workspaceId, runId))
            .catch((error: unknown) => {
              logFault("task_run_worker_start_failed", {
                workspace_id: workspaceId,
                run_id: runId,
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              });
            });
        },
        stopRunWorker: (workspaceId, runId) => {
          void supervisor.stopWorker(workspaceId, runId, "requested").catch((error: unknown) => {
            logFault("task_run_worker_stop_failed", {
              workspace_id: workspaceId,
              run_id: runId,
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        },
        logFault: (event, fields) => logFault(event, fields),
      };
    }

    const reconcile = (): Promise<WorkerReconciliationReport> =>
      reconcileTaskWorkersAfterRestart({
        taskWorkers,
        events,
        runs: operationsRepository,
        supervisor,
        logFault: (event, fields) => logFault(event, fields),
      });

    return { supervisor, admission, reconcile };
  })();

  // S16: the admission readout behind GET /v1/workers/admission — the
  // configured limits, the live count, and the queued runs with their
  // verbatim refusal, scoped to the reading workspace. Without a worker
  // system the endpoint answers the honest not-configured shape (the route
  // owns that default).
  const workerAdmission: ((workspaceId: string) => WorkerAdmissionReadout) | undefined = workers
    ? (workspaceId) => {
        const pressure = workers.supervisor.admissionPressure();
        return {
          configured: pressure.configured,
          limits: pressure.limits,
          live_workers: pressure.liveWorkers,
          queued_runs: workers.supervisor
            .queuedRuns()
            .filter((entry) => entry.workspace_id === workspaceId),
        };
      }
    : undefined;

  // S20 chunk 4: the approvals boundary over the SAME transaction, journal,
  // event machinery, and operations repository every other writer uses — the
  // pause, the five decisions, the AC26 gate, the reminder scan, and the
  // mutes. The clock is the composition's injected one (tests pin it; the
  // E3 reminder due times and every stamp agree with the journal). The HTTP
  // facade is a pure relay into this service — no rule lives in the routes.
  const approvalsRepository = new ApprovalsRepository(tx);
  const approvals = new ApprovalsService({
    tx,
    journal,
    events,
    approvals: approvalsRepository,
    operations: operationsRepository,
    ...(options.now ? { clock: options.now } : {}),
  });

  // S19 chunk 1: the git coordination seam over the SAME transaction and
  // repositories every other writer uses. The credential vault's key file
  // and every project clone live beside the database in the container's data
  // directory (the same layout rule as the agent folders).
  const projectsRepository = new ProjectsRepository(tx);
  const projectsRoot = join(dirname(options.dbPath), "projects");
  const gitService = new GitService({
    projects: projectsRepository,
    vault: new CredentialVault(join(dirname(options.dbPath), "project-credentials.key")),
    approvals,
    approvalsRepository,
    tx,
    projectsRoot,
    ...(options.now ? { clock: options.now } : {}),
    logFault,
  });

  // The S20 approval executor gains its real action here: an approval whose
  // request resolves to a merge request executes THAT merge through the git
  // service — after the decision transaction commits (the S20 rule), never
  // before. Any other approval keeps the no-op scripted execution (G4).

  // S21 (the P0): the runtime tool executor — checkExecutionAllowed's first
  // production caller. The composition registers the built-in/scripted tool
  // definitions into the runtime registry (authored configuration — never a
  // classification of proposal text, G2) and hands the executor the same
  // transaction every other writer uses. The scripted no-op binding keeps the
  // S20 demo posture: its effect is the run's own continuation, now recorded
  // in the tool history like every real tool.
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerBinding("scripted-noop", makeScriptedNoopBinding());
  // S21: the platform's own built-in tools (the prototype's REAL demo
  // family): the workspace note store the S21 tools operate on — read
  // (READ_ONLY, auto) and append (LOCAL_MUTATION, preview-gated). Their
  // capabilities sit inside the pinned pack's union so the D38 intersection
  // admits agent-created tools in the same families. The scripted no-op
  // binding stays the S20 demo posture (no external effect, honest result).
  const noteBindings = makeNoteBindings();
  toolRegistry.registerBinding("notes-read", noteBindings.read);
  toolRegistry.registerBinding("notes-append", noteBindings.append);
  const toolsRepository = new ToolsRepository(conn.db);
  // S21: the agent-created inventory (E4) — late-bound pack allow-list (the
  // pack loads after the wiring; the default is fail-closed empty).
  const toolsInventory = new ToolsInventoryService({
    tx,
    tools: toolsRepository,
    registry: toolRegistry,
    packToolAllowList: [],
  });
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    tools: toolsRepository,
    tx,
    approvals,
    ...(options.now ? { now: options.now } : {}),
  });
  if (options.scriptedToolProposal) {
    toolRegistry.registerBuiltinTool({
      definition: scriptedToolDefinitionRecord(options.scriptedToolProposal, wireWorkspaceId),
      enabled: true,
      max_response_bytes: SCRIPTED_TOOL_MAX_RESPONSE_BYTES,
      bindingName: "scripted-noop",
    });
  }
  registerBuiltinNoteTools(toolRegistry, wireWorkspaceId);
  const approvalsApi = buildApprovalsApiHandle({
    approvals,
    approvalsRepository,
    journal,
    now: options.now ?? (() => new Date().toISOString()),
    executeForApproval: (request) => {
      const mergeRequest = projectsRepository.findMergeRequestByApproval(
        request.workspace_id,
        request.approval_id,
      );
      if (mergeRequest === null) {
        return undefined;
      }
      return () => {
        void gitService
          .performMerge({
            workspace_id: request.workspace_id,
            project_id: mergeRequest.project_id,
            merge_request_id: mergeRequest.merge_request_id,
          })
          .catch(() => {}); // the row records the failure (G5)
      };
    },
    // S21: the approved TOOL execution IS the executor's withheld one —
    // runWithheld runs only here, after the decision transaction commits.
    // Precedence: the S19 per-request hook (merge-request approvals), then
    // the executor, then the S20 no-op (fail-closed).
    decideExecute: (approvalId) => {
      toolExecutor.runWithheld(approvalId);
    },
  });
  // S21: the tools API facade over the registry + inventory + history.
  const toolsApi = buildToolsApiHandle({
    registry: toolRegistry,
    tools: toolsRepository,
    inventory: toolsInventory,
  });
  const projectsApi = buildProjectsApiHandle({
    git: gitService,
    approvals: approvalsApi,
    journal,
    // S19 chunk 2: the runtime's validation runner over the SAME repository
    // (G2: the runtime validates what the Agent proposed to merge).
    validation: new ValidationRunner({
      projects: projectsRepository,
      ...(options.now ? { clock: options.now } : {}),
    }),
    now: options.now ?? (() => new Date().toISOString()),
  });

  // S22: the run cancellation service — the user cancel path tears down
  // EVERYTHING the run holds (worker through the supervisor port, in-flight
  // tool executions through the executor seam, queued children, write
  // leases, the S24 credit-reservation seam, pending approvals) and walks
  // the recorded D8 two-step cancellation. The reservation port is the
  // HONEST S24 seam: the credit ledger is slice S24 — the composition
  // records the release request through the redacted fault log and nothing
  // else (never a fake ledger, G4).
  const runCancellation = new RunCancellationService({
    tx,
    journal,
    events,
    operations: operationsRepository,
    runControl: new OperationsRunSeam(operations),
    ...(workers ? { workers: { stopWorker: (workspaceId, runId, reason) => workers.supervisor.stopWorker(workspaceId, runId, reason as "requested" | "shutdown") } } : {}),
    executor: { cancelForTask: (workspaceId, taskId) => toolExecutor.cancelForTask(workspaceId, taskId) },
    leases: writeLeases,
    reservations: {
      releaseForRun: (workspaceId, runId) => {
        logFault("credit_reservation_release_requested", {
          workspace_id: workspaceId,
          run_id: runId,
          seam: "s24-credit-ledger-not-built",
        });
      },
    },
    approvals,
    retryCoordinator,
    logFault: (event, fields) => logFault(event, fields),
  });
  const runControlApi = buildRunControlApiHandle({
    runCancellation,
    journal,
  });

  const replay = new ReplayService({
    journal,
    loadSnapshot: (workspaceId, streamId) => {
      const conversationId = streamId.replace(/^conversation:/, "");
      const row = conversationsRepository.findById(workspaceId, conversationId, conn.db);
      if (!row) {
        return null;
      }
      return {
        kind: "conversation",
        conversation_id: row.id,
        workspace_id: row.workspace_id,
        title: row.title,
        revision: row.revision,
        up_to_sequence: journal.maxSequence(workspaceId, streamId, conn.db),
      };
    },
    retentionHorizon:
      options.retentionHorizon ??
      ((workspaceId, streamId) =>
        Math.max(0, journal.minSequence(workspaceId, streamId, conn.db) - 1)),
  });

  const app = createLocalApi({
    conversations,
    replay,
    agents,
    folders,
    // S12: the presence read model — live when the supervisor is enabled,
    // absent (→ every agent reports "none") when it is disabled (G4).
    ...(sessions
      ? {
          sessionPresence: (workspaceId: string, agentId: string) =>
            sessions.presenceState(workspaceId, agentId),
        }
      : {}),
    operations,
    ...(workerAdmission ? { workerAdmission } : {}),
    // S17: the workspace panel surface — files, write leases, artifacts
    // (the route module owns the HTTP shapes; the repositories own the rules).
    workspace: {
      files: workspaceFiles,
      leases: writeLeases,
      artifacts: workspaceArtifacts,
    },
    approvals: approvalsApi,
    tools: toolsApi,
    // S23: the provider surface — the masked catalog CRUD, the credential
    // custody routes, the connection test, the override, and the effective
    // readout. Every rule lives in the service; the routes relay (G2).
    providers: { providers },
    // S18 chunk 1: the read-only terminal live-views surface — durable
    // replay, one execution's record, and the current session terminal
    // state. Three GET routes; the no-takeover criterion is the inventory.
    terminals: buildLiveViewsApiHandle({
      terminals: terminalEvents,
      journal,
    }),
    // S18 chunk 2: the read-only browser live-view surface when a browser is
    // configured (two GET routes; the routes relay into the service).
    ...(browserHandle ? { browser: browserHandle } : {}),
    projects: projectsApi,
    runControl: runControlApi,
    ...(options.logUntypedFault ? { logUntypedFault: options.logUntypedFault } : {}),
  });
  return {
    conn,
    app,
    replay,
    tx,
    journal,
    events,
    conversations,
    agents,
    folders,
    sessions,
    sessionBridge,
    operations,
    workers,
    approvals,
    tools: toolExecutor,
    toolRegistry,
    toolsApi,
    toolsInventoryHook: (allowList) => toolsInventory.setPackToolAllowList(allowList),
    terminals,
    browser,
    projects: projectsApi,
    retryCoordinator,
    runCancellation,
    runControl: runControlApi,
    providers,
    setPublisher(next) {
      publisher = next;
    },
  };
}

export function composeLocalApi(options: ComposeLocalApiOptions): LocalApiHandle {
  const wired = wire(options);
  return {
    app: wired.app,
    approvals: wired.approvals,
    tools: wired.tools,
    toolRegistry: wired.toolRegistry,
    toolsApi: wired.toolsApi,
    providers: wired.providers,
    browser: wired.browser,
    close: () => wired.conn.close(),
  };
}

/**
 * Full runtime composition: local API + WebSocket gateway on one HTTP server,
 * plus the harness seam. Live fanout flows from the post-commit publish hooks
 * (conversations AND harness runs) into the gateway's per-stream rooms; the
 * WS layer itself stays read-only (D26).
 */
export function composeRuntime(options: ComposeRuntimeOptions): RuntimeHandle {
  // S23 (G4/G5): enforcement and the scripted reply producer are mutually
  // exclusive postures — the scripted producer fabricates completions, which
  // is exactly what provider enforcement exists to prevent. The combination
  // is a typed startup failure, never a silent drop.
  if (options.providerEnforcement === true && options.scriptedReplies !== undefined) {
    throw new Error(
      "providerEnforcement and scriptedReplies are mutually exclusive: the scripted reply producer fabricates completions (G4). Use one posture or the other.",
    );
  }
  const wired = wire(options);
  const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const httpServer = createServer(wired.app);
  const gateway = attachWebSocketGateway(httpServer, {
    replay: wired.replay,
    ...(options.workspaceId ? { authorizedWorkspaceId: workspaceId } : {}),
    ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
    ...(options.pingTimeoutMs ? { pingTimeoutMs: options.pingTimeoutMs } : {}),
  });

  // S10 (D19/D28): load the REAL pack when a packsRoot is configured —
  // compatibility-checked against RUNTIME_VERSION (typed failure before any
  // task can use it) and pinned on the workspace (first install or upgrade;
  // the pin upgrade affects NEW tasks only, D19 — existing task snapshots
  // live in their task.created journal payloads).
  const pack: WorkspacePack | undefined = options.packsRoot
    ? loadWorkspacePack({
        packsRoot: options.packsRoot,
        packId: options.packId ?? "student",
        ...(options.packVersion ? { packVersion: options.packVersion } : {}),
        workspaceId,
        workspaces: new WorkspacesRepository(wired.tx),
        ...(options.now ? { now: options.now() } : {}),
      })
    : undefined;
  // S11 (D32/D39): seed the workspace's Agents from the loaded pack's roster —
  // the startup composition step, so the identities exist before anything can
  // address them. Idempotent on EVERY startup: new agents insert, pack-owned
  // fields refresh on change, and the user-owned fields (user_instructions,
  // default provider pair) are never clobbered by a re-seed. A seeding failure
  // is a typed startup failure like the pack load above it (G4). The loaded
  // seeds are ALSO the D16 recommended-default source for the settings
  // surface (S11 chunk 3) — late-bound onto the service like the publish hook.
  if (pack) {
    // S21: the D38 pack layer resolves from the pinned manifest's allow-list.
    wired.toolsInventoryHook?.(pack.manifest.tool_allow_list);
    seedAgentsFromPack(wired.tx, workspaceId, pack.manifest);
    wired.agents.setPackAgents(pack.manifest.agents);
    // S13 (D36): the operations service validates rosters and coordinators
    // against the SAME loaded pack — late-bound here, after the load, before
    // any request can reach the operations routes.
    wired.operations.setPackCatalog(operationPackCatalog(pack));
  }
  // Every fanout route (conversation commands AND harness runs) flows through
  // the same containment (B4): a broadcast failure is recorded, never fatal.
  const logFault = options.logUntypedFault ?? consoleRedactedLogger;
  // S09 chunk 2: the scripted reply producer (mock/E2E) reacts to committed
  // user messages with delta frames + ONE durable agent reply through the
  // command path. Default: absent — a turn simply receives no reply (G4).
  const replyStreamer = options.scriptedReplies
    ? new ScriptedReplyStreamer({
        conversations: wired.conversations,
        broadcastFrame: (workspaceId, streamId, payload) =>
          gateway.broadcastStreamFrame(workspaceId, streamId, payload),
        options: options.scriptedReplies,
        onFault: (fault) =>
          logFault("reply_stream_failed", {
            name: fault instanceof Error ? fault.name : "Error",
            message: fault instanceof Error ? fault.message : String(fault),
          }),
      })
    : undefined;
  const broadcast = containFanout((event) => {
    gateway.broadcastStreamEvent(event);
    replyStreamer?.handleCommittedEvent(event);
    // S12: the session bridge rides the same post-commit fanout as the
    // scripted producer — an Agent direct-chat turn addresses the supervised
    // session and lands its reply durably. Contained twice over: the bridge
    // catches its own failures AND this wrapper would (B4).
    wired.sessionBridge?.handleCommittedEvent(event);
  }, logFault);
  wired.setPublisher(broadcast);

  // D51 seam wiring: adapters propose through the sink; the service validates
  // and executes into the journal; committed envelopes fan out on the WS task
  // stream through the same gateway rooms as every other stream.
  //
  // S20 chunk 4: when the scripted tool proposal is configured, the composed
  // FakeHarnessAdapter's script carries ONE typed `tool.proposed` journal
  // event per run (proposed while the run is RUNNING), and the gateway runs
  // the approvals boundary over it through the delegate below — the SAME
  // proposal path every scripted typed event already flows through (no new
  // event path, no classification — G2/G4). Without the option both halves
  // are absent and the runs behave exactly as before S20.
  const scriptedToolProposal = options.scriptedToolProposal;
  // S20 review fix F6e: the scripted proposal is carried by the composed
  // FakeHarnessAdapter's script — a caller-supplied harnessAdapter replaces
  // that adapter wholesale, so the option would be SILENTLY dropped (the
  // proposal never fires, no approval ever pauses). Record the conflict
  // through the established redacted fault-log seam instead of dropping it
  // silently (G5); the runs then behave exactly as the custom adapter
  // dictates.
  if (scriptedToolProposal && options.harnessAdapter) {
    logFault("approval_scripted_tool_proposal_ignored", {
      reason:
        "a custom harness adapter is configured; the scripted proposal script is not attached",
      tool_id: scriptedToolProposal.tool.tool_id,
    });
  }
  const harness = new HarnessRunService({
    adapter:
      options.harnessAdapter ??
      (scriptedToolProposal
        ? new FakeHarnessAdapter({
            ...(options.now ? { now: options.now } : {}),
            toolProposal: {
              tool_id: scriptedToolProposal.tool.tool_id,
              tool_version: scriptedToolProposal.tool.tool_version,
              args_digest: scriptedToolProposal.args_digest,
              proposal_summary: scriptedToolProposal.proposal_summary,
            },
          })
        : new FakeHarnessAdapter()),
    tx: wired.tx,
    journal: wired.journal,
    events: wired.events,
    pinned_pack: pack
      ? {
          pack_id: pack.manifest.pack_id,
          pack_version: pack.manifest.version,
          pack_hash: pack.manifest_hash,
        }
      : (options.pinnedPack ?? DEFAULT_PACK),
    // S10 (D29): the loaded manifest feeds the creation-time snapshots —
    // every runtime-created run stamps the skill/connector/provider snapshots
    // it can resolve from the pinned pack's definitions.
    ...(pack ? { pack_content: pack.manifest } : {}),
    workspace_id: workspaceId,
    policy: { max_retries: 3 },
    publish: broadcast,
    ...(options.now ? { now: options.now } : {}),
    ...(scriptedToolProposal
      ? {
          approvals: {
            // The delegate runs INSIDE startRun's atomic unit: the pause and
            // its journal events commit (or not) with the run's own writes.
            // S21: the executor is the delegate — validation, the D35 ladder,
            // the grant fast-path, limits, and redaction all happen there.
            onToolProposed: (event, run) =>
              applyScriptedToolProposal(wired.tools, scriptedToolProposal, event, run, logFault),
          },
        }
      : {}),
  });

  // S16 (D32): boot-time restart reconciliation — live worker rows whose
  // process died with the previous gateway are reaped (worker.reaped), and
  // runs the durable rows left QUEUED re-enter the admission queue.
  // RECOVERY_REQUIRED stays for the recovery slice. Fire-and-forget at boot
  // (a reconciliation gap is a fault record, never a failed boot); the
  // handle's reconcile() is the explicit, awaited entry for tests/operators.
  const reconciliation = wired.workers
    ? wired.workers
        .reconcile()
        .catch((error: unknown) => {
          logFault("task_worker_reconcile_boot_failed", {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        })
        .catch(() => {})
    : undefined;
  void reconciliation;

  return {
    app: wired.app,
    httpServer,
    gateway,
    harness,
    pack,
    agents: wired.agents,
    folders: wired.folders,
    operations: wired.operations,
    replyStreamer,
    sessions: wired.sessions,
    workers: wired.workers,
    approvals: wired.approvals,
    tools: wired.tools,
    toolRegistry: wired.toolRegistry,
    toolsApi: wired.toolsApi,
    terminals: wired.terminals,
    browser: wired.browser,
    projects: wired.projects,
    retryCoordinator: wired.retryCoordinator,
    runControl: wired.runControl,
    providers: wired.providers,
    close: async () => {
      // S22: drop every pending retry backoff timer before the transport
      // goes down (a stopped runtime never fires a scheduled retry).
      wired.retryCoordinator.dispose();
      replyStreamer?.stopAll();
      // S16: drain every live worker child through the escalation BEFORE the
      // transport goes down — a stopped runtime never leaves an orphan.
      await wired.workers?.supervisor.stopAll();
      // S12: drain every live session child through the escalation BEFORE the
      // transport goes down — a stopped runtime never leaves an orphan.
      await wired.sessions?.stopAll();
      // S18 chunk 2: close the shared browser cleanly BEFORE the transport
      // goes down — the persistent profile flushes its session state (AC19)
      // and no Chromium orphan outlives the runtime.
      await wired.browser?.dispose("shutdown");
      // io.close() also closes the attached HTTP server (socket.io v4).
      await gateway.close();
      wired.conn.close();
    },
  };
}
