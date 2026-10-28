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
import { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { EventJournalRepository } from "../../adapters/sqlite/event-journal-repository.ts";
import { OperationsRepository } from "../../adapters/sqlite/operations-repository.ts";
import { TaskWorkersRepository } from "../../adapters/sqlite/task-workers-repository.ts";
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
import { HarnessRunService } from "../../modules/runtime/harness-run-service.ts";
import { loadWorkspacePack, type WorkspacePack } from "../../modules/runtime/pack-pin.ts";
import { seedAgentsFromPack } from "../../adapters/sqlite/agents-repository.ts";
import { WorkspacesRepository } from "../../adapters/sqlite/workspaces-repository.ts";
import {
  SessionSupervisor,
  type SessionSupervisorPolicy,
} from "../../modules/sessions/session-supervisor.service.ts";
import { SessionReplyBridge } from "../../modules/sessions/session-reply-bridge.ts";
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
import { createLocalApi } from "./app.ts";
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
}

export interface LocalApiHandle {
  app: Express;
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
   * Deterministic clock for harness-run journal envelopes. Default: wall
   * clock; the E8 mock mode pins it so runs are byte-comparable.
   */
  now?: () => string;
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
    workerPolicy?: Partial<TaskWorkerSupervisorPolicy> | undefined;
  },
): Wired {
  const logFault = options.logUntypedFault ?? consoleRedactedLogger;
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
  const conversations = new ConversationsService({
    journal: events,
    conversations: conversationsRepository,
    receipts,
    tx,
    publish: containFanout((event) => publisher(event), logFault),
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

  // S12 (D32 layer 2): the supervised warm Agent session when a harness
  // command IS configured; when it is NOT, the runtime composes with the
  // supervisor DISABLED — presence "none" everywhere, no process ever spawns,
  // and the send path behaves exactly as today (G4). The D15 context is
  // re-fetched through the agents module's public read on EVERY (re)start;
  // the supervisor never caches it.
  const sessions = options.sessionHarness
    ? new SessionSupervisor({
        events,
        spawnChild: createSessionProcessSpawn(options.sessionHarness),
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
      })
    : new OperationsService({
        operations: operationsRepository,
        conversations: conversationsRepository,
        events,
        journal,
        agents: agentsRepository,
        tx,
        publish: containFanout((event) => publisher(event), logFault),
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
    setPublisher(next) {
      publisher = next;
    },
  };
}

export function composeLocalApi(options: ComposeLocalApiOptions): LocalApiHandle {
  const wired = wire(options);
  return { app: wired.app, close: () => wired.conn.close() };
}

/**
 * Full runtime composition: local API + WebSocket gateway on one HTTP server,
 * plus the harness seam. Live fanout flows from the post-commit publish hooks
 * (conversations AND harness runs) into the gateway's per-stream rooms; the
 * WS layer itself stays read-only (D26).
 */
export function composeRuntime(options: ComposeRuntimeOptions): RuntimeHandle {
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
  const harness = new HarnessRunService({
    adapter: options.harnessAdapter ?? new FakeHarnessAdapter(),
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
    close: async () => {
      replyStreamer?.stopAll();
      // S16: drain every live worker child through the escalation BEFORE the
      // transport goes down — a stopped runtime never leaves an orphan.
      await wired.workers?.supervisor.stopAll();
      // S12: drain every live session child through the escalation BEFORE the
      // transport goes down — a stopped runtime never leaves an orphan.
      await wired.sessions?.stopAll();
      // io.close() also closes the attached HTTP server (socket.io v4).
      await gateway.close();
      wired.conn.close();
    },
  };
}
