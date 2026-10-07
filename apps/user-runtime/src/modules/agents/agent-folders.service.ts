/**
 * Private-folder isolation (S11 final chunk) — the authoritative access-guard
 * seam for `agent://<agent_id>/` URIs.
 *
 * Every Agent owns one private folder subtree, addressed by the URI the
 * memory_link setting already surfaces (`agent://<agent_id>/`, the value the
 * seeding writes into `agents.private_folder_path`). There is NO filesystem
 * layer yet: this module is the seam the future file/terminal slices (S17
 * workspace panel, S22 terminal/file tools) MUST route every private-folder
 * access through BEFORE any byte moves. The store behind the seam is a
 * minimal in-memory placeholder for tests — never real disk writes; a later
 * slice swaps the store implementation without touching the guard.
 *
 * Three layers, each independently testable:
 *
 * 1. `parseAgentFolderUri` (pure) — resolves a raw URI into
 *    { agent_id, path }. Percent-decoding happens BEFORE the traversal check,
 *    so `%2e%2e` is caught exactly like `..`; every traversal-shaped input is
 *    the typed `AgentFolderUriInvalidError`, never a normalized escape.
 * 2. `decideAgentFolderAccess` (pure) — the guard's decision: an Agent may
 *    access its OWN subtree (root and nested paths, read AND write); ANY
 *    other Agent's private subtree is denied. This is the product rule the
 *    memory slice will extend with publication rules; nothing else may.
 * 3. `AgentFoldersService` — resolves URIs against a WORKSPACE's Agent
 *    records (E12: records are (workspace_id, agent_id)-scoped, so an unknown
 *    agent, an unknown actor, or an unknown/foreign workspace are all the
 *    typed `AgentNotFoundError` — nothing resolves outside this workspace),
 *    applies the guard, and only then touches the store. Denials are the
 *    typed `AgentFolderAccessDeniedError`; the store is never reached.
 *
 * Scope honesty (S17 owns the full permission model): shared workspace paths
 * (`workspace://...`) are NOT governed here — the parser rejects them rather
 * than guessing at permissions that do not exist yet. When a workspace
 * permission convention arrives, it extends this module behind the same seam.
 */
import { AgentNotFoundError, type AgentsRepository } from "../../adapters/sqlite/agents-repository.ts";

/** The AgentFolderUri host charset (packages/contracts agent.ts) — same rule. */
const AGENT_ID_CHARSET = /^[a-z0-9_-]+$/;

/** The parsed shape of an `agent://<agent_id>/<path>` URI. */
export interface ParsedAgentFolderUri {
  agent_id: string;
  /**
   * Normalized relative path INSIDE the agent's subtree, no leading or
   * trailing slash; "" is the folder root. Never contains `.`/`..` segments,
   * backslashes, or empty segments.
   */
  path: string;
}

/**
 * The typed rejection for a URI that is not a safe agent-folder address.
 * Validation-category: malformed INPUT, not a permission failure.
 */
export class AgentFolderUriInvalidError extends Error {
  readonly code = "AGENT_FOLDER_URI_INVALID" as const;
  readonly category = "validation" as const;

  constructor() {
    super("the folder URI is not a safe agent://<agent_id>/<path> address");
    this.name = "AgentFolderUriInvalidError";
  }
}

/**
 * The typed rejection for a forbidden private-folder access. Carries the
 * stable code/category pair so the transport's typed error middleware maps it
 * onto the SheraError taxonomy (403) without special-casing — and its message
 * is never echoed to a client (G3).
 */
export class AgentFolderAccessDeniedError extends Error {
  readonly code = "AGENT_FOLDER_ACCESS_DENIED" as const;
  readonly category = "unauthorized" as const;

  constructor(actorAgentId: string, ownerAgentId: string) {
    super(`agent ${actorAgentId} may not access agent ${ownerAgentId}'s private folder`);
    this.name = "AgentFolderAccessDeniedError";
  }
}

/**
 * Parse and normalize one `agent://<agent_id>/<path>` URI, or reject it as
 * the typed `AgentFolderUriInvalidError`. Safety rules, in order:
 *
 * - the scheme must be exactly `agent://` (shared `workspace://` paths are
 *   S17's model, not this module's guess);
 * - the host must match the contracts' AgentFolderUri charset;
 * - every path segment is percent-DECODED first, then checked — `%2e%2e`
 *   cannot smuggle a traversal past a raw-string check;
 * - a decoded segment must not be `.` or `..`, must not contain `/` or `\`,
 *   and must not be empty (no double slashes, no backslash separators).
 *
 * A URI either parses to a path confined to the host's subtree or fails —
 * there is no normalization step that could widen it into an escape.
 */
export function parseAgentFolderUri(uri: string): ParsedAgentFolderUri {
  const fail = (): never => {
    throw new AgentFolderUriInvalidError();
  };
  if (!uri.startsWith("agent://")) fail();
  if (/[\u0000-\u001f\u007f]/.test(uri)) fail();

  const afterScheme = uri.slice("agent://".length);
  const hostEnd = afterScheme.indexOf("/");
  // The folder ROOT itself is `agent://<id>/` — the host must be followed by
  // a slash, per the contracts' AgentFolderUri shape.
  if (hostEnd < 0) fail();
  const agentId = afterScheme.slice(0, hostEnd);
  if (!AGENT_ID_CHARSET.test(agentId)) fail();

  const rawPath = afterScheme.slice(hostEnd + 1);
  const segments = rawPath.split("/");
  // A trailing slash yields one final empty segment — the root marker — and
  // is dropped; every OTHER empty segment (double slash) is invalid.
  if (segments[segments.length - 1] === "") segments.pop();
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      fail(); // malformed escape (%zz), not a decodable path
    }
    if (value === "" || value === "." || value === "..") fail();
    if (value.includes("/") || value.includes("\\")) fail();
    if (/[\u0000-\u001f\u007f]/.test(value)) fail();
    decoded.push(value);
  }
  return { agent_id: agentId, path: decoded.join("/") };
}

/**
 * The guard's decision as a typed result (pure — no I/O, no agent-record
 * lookup; the SERVICE resolves existence before consulting this). An Agent
 * may access ONLY its own subtree; `reason` names the denial for callers
 * that want the decision shape without the thrown error.
 */
export type AgentFolderAccessDecision =
  | { allowed: true; agent_id: string; path: string }
  | {
      allowed: false;
      reason: "foreign_private_folder";
      agent_id: string;
      path: string;
    };

export function decideAgentFolderAccess(
  actorAgentId: string,
  target: ParsedAgentFolderUri,
): AgentFolderAccessDecision {
  if (actorAgentId === target.agent_id) {
    return { allowed: true, agent_id: target.agent_id, path: target.path };
  }
  return {
    allowed: false,
    reason: "foreign_private_folder",
    agent_id: target.agent_id,
    path: target.path,
  };
}

/**
 * The storage seam. The prototype ships `InMemoryAgentFolderStore` (tests and
 * wiring prove the guard end-to-end without touching a disk); the file slice
 * replaces the implementation — the guard and its callers do not change.
 */
export interface AgentFolderStore {
  /** The content at `path` inside this agent's subtree, or null when absent. */
  read(workspaceId: string, agentId: string, path: string): string | null;
  /** Write (create or replace) the content at `path`. */
  write(workspaceId: string, agentId: string, path: string, content: string): void;
}

/** Placeholder storage: per-(workspace, agent) maps. No persistence, no disk. */
export class InMemoryAgentFolderStore implements AgentFolderStore {
  readonly #entries = new Map<string, string>();

  read(workspaceId: string, agentId: string, path: string): string | null {
    return this.#entries.get(`${workspaceId}\u0000${agentId}\u0000${path}`) ?? null;
  }

  write(workspaceId: string, agentId: string, path: string, content: string): void {
    this.#entries.set(`${workspaceId}\u0000${agentId}\u0000${path}`, content);
  }
}

export interface AgentFoldersServiceDeps {
  /** Workspace-scoped Agent records (E12) — the resolution authority. */
  agents: Pick<AgentsRepository, "getAgent">;
  /** Storage behind the guard. Default: one in-memory store per service. */
  store?: AgentFolderStore;
}

/** What the local-API route returns for an allowed access (the decision payload). */
export interface AgentFolderAccessResolution {
  workspace_id: string;
  /** The Agent acting (the route's path identity). */
  actor_agent_id: string;
  /** The folder owner the URI resolved to (a seeded Agent of THIS workspace). */
  agent_id: string;
  /** Normalized relative path inside the owner's subtree; "" is the root. */
  path: string;
  /** Own subtree: both verbs granted. (Denials throw — they never resolve.) */
  access: { read: boolean; write: boolean };
}

export class AgentFoldersService {
  readonly #store: AgentFolderStore;

  constructor(private readonly deps: AgentFoldersServiceDeps) {
    this.#store = deps.store ?? new InMemoryAgentFolderStore();
  }

  /**
   * Resolve an agent-folder URI against THIS workspace's Agent records and
   * return the access decision. Denials, invalid URIs, and unknown agents /
   * workspaces are the typed errors — the route maps them onto 403 / 400 /
   * 404 respectively; allowed decisions answer 200 with the payload.
   */
  resolveAccess(
    workspaceId: string,
    actorAgentId: string,
    uri: string,
  ): AgentFolderAccessResolution {
    const target = this.resolveWithinWorkspace(workspaceId, actorAgentId, uri);
    return {
      workspace_id: workspaceId,
      actor_agent_id: actorAgentId,
      agent_id: target.agent_id,
      path: target.path,
      access: { read: true, write: true },
    };
  }

  /**
   * Guarded read: the seam every file/terminal slice MUST call. An Agent
   * reads its OWN subtree; anything else is the typed denial and the store
   * is never reached.
   */
  readFolder(workspaceId: string, actorAgentId: string, uri: string): string | null {
    const target = this.guard(workspaceId, actorAgentId, uri);
    return this.#store.read(workspaceId, target.agent_id, target.path);
  }

  /** Guarded write: same rules as readFolder — own subtree only. */
  writeFolder(
    workspaceId: string,
    actorAgentId: string,
    uri: string,
    content: string,
  ): void {
    const target = this.guard(workspaceId, actorAgentId, uri);
    this.#store.write(workspaceId, target.agent_id, target.path, content);
  }

  /**
   * Parse, resolve existence, enforce the guard. Both the ACTING agent and
   * the folder owner must be seeded Agents of THIS workspace (E12: records
   * are (workspace_id, agent_id)-scoped, so an unknown or foreign workspace
   * resolves nothing and answers AgentNotFoundError, exactly like every other
   * agent route).
   */
  private resolveWithinWorkspace(
    workspaceId: string,
    actorAgentId: string,
    uri: string,
  ): ParsedAgentFolderUri {
    const target = parseAgentFolderUri(uri);
    // The ACTOR must be a seeded Agent of this workspace: an access decision
    // without a known actor would authorize nothing knowable.
    if (this.deps.agents.getAgent(workspaceId, actorAgentId) === null) {
      throw new AgentNotFoundError(workspaceId, actorAgentId);
    }
    // The folder OWNER must be a seeded Agent of this workspace: a URI that
    // resolves to no record here is a miss, not an implicit grant.
    if (this.deps.agents.getAgent(workspaceId, target.agent_id) === null) {
      throw new AgentNotFoundError(workspaceId, target.agent_id);
    }
    return target;
  }

  private guard(
    workspaceId: string,
    actorAgentId: string,
    uri: string,
  ): ParsedAgentFolderUri {
    const target = this.resolveWithinWorkspace(workspaceId, actorAgentId, uri);
    const decision = decideAgentFolderAccess(actorAgentId, target);
    if (!decision.allowed) {
      throw new AgentFolderAccessDeniedError(actorAgentId, decision.agent_id);
    }
    return target;
  }
}
