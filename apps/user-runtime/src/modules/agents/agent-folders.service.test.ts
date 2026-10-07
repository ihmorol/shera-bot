/**
 * Private-folder isolation tests (S11 final chunk — the guard seam).
 *
 * The Agent's private folder is addressed by its `agent://<agent_id>/` URI
 * (the memory_link setting's value). There is no filesystem layer yet: THIS
 * module is the authoritative access-guard seam the future file/terminal
 * slices (S17/S22) MUST call before any byte moves, with a minimal in-memory
 * store behind the seam for tests — never real disk writes.
 *
 * The guard is absolute for private subtrees: an Agent may read and write its
 * OWN `agent://<id>/` subtree (folder root and nested paths) and ANY other
 * Agent's private subtree is denied — reads and writes alike. Path-traversal
 * attempts (`..`, `%2e%2e`) never resolve into an escape: the URI parser
 * rejects them as invalid input before the guard even runs.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentsRepository, AgentNotFoundError } from "../../adapters/sqlite/agents-repository.ts";
import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import {
  AgentFolderAccessDeniedError,
  AgentFolderUriInvalidError,
  AgentFoldersService,
  decideAgentFolderAccess,
  InMemoryAgentFolderStore,
  parseAgentFolderUri,
} from "./agent-folders.service.ts";

const here = dirname(fileURLToPath(import.meta.url));
const studentManifestPath = resolve(
  here,
  "../../../../../agent-packs/student/v1/manifest.json",
);
const studentManifest = JSON.parse(readFileSync(studentManifestPath, "utf8")) as {
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    default_provider: { provider_id: string; model: string };
    skills: string[];
    tools: { tool_id: string; version: string }[];
    connectors: string[];
    ui_identity: { avatar_hue: number; initial_glyph: string };
    home_operation_id: string | null;
  }>;
};

const GENERAL = "agent_general_assistant";
const RESEARCHER = "agent_researcher";

const tempDirs: string[] = [];

let conn: SqliteConnection;
let service: AgentFoldersService;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-s11-folders-"));
  tempDirs.push(dir);
  conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  const repo = new AgentsRepository(new SqliteTransactions(conn.db));
  repo.upsertFromPack("ws-primary", studentManifest.agents);
  service = new AgentFoldersService({ agents: repo });
});

afterEach(() => {
  conn.close();
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseAgentFolderUri (pure URI resolution)", () => {
  it("resolves the folder root and nested paths against the agent host", () => {
    expect(parseAgentFolderUri(`agent://${GENERAL}/`)).toEqual({
      agent_id: GENERAL,
      path: "",
    });
    expect(parseAgentFolderUri(`agent://${GENERAL}/notes/ideas.txt`)).toEqual({
      agent_id: GENERAL,
      path: "notes/ideas.txt",
    });
  });

  it("rejects a non-agent:// scheme (shared workspace paths are S17's model)", () => {
    expect(() => parseAgentFolderUri("workspace://ws-primary/shared/a.txt")).toThrow(
      AgentFolderUriInvalidError,
    );
  });

  it("rejects raw .. traversal segments — a path never escapes the subtree", () => {
    expect(() => parseAgentFolderUri(`agent://${GENERAL}/../${RESEARCHER}/notes.txt`)).toThrow(
      AgentFolderUriInvalidError,
    );
    expect(() => parseAgentFolderUri(`agent://${GENERAL}/notes/../../escape.txt`)).toThrow(
      AgentFolderUriInvalidError,
    );
  });

  it("rejects percent-encoded traversal (%2e%2e) — decoding happens BEFORE the check", () => {
    expect(() => parseAgentFolderUri(`agent://${GENERAL}/%2e%2e/${RESEARCHER}/notes.txt`)).toThrow(
      AgentFolderUriInvalidError,
    );
  });

  it("rejects malformed hosts and separators", () => {
    // Uppercase and other characters outside the AgentFolderUri charset.
    expect(() => parseAgentFolderUri("agent://Agent_X/notes.txt")).toThrow(
      AgentFolderUriInvalidError,
    );
    // Empty path segments (double slashes).
    expect(() => parseAgentFolderUri(`agent://${GENERAL}//notes.txt`)).toThrow(
      AgentFolderUriInvalidError,
    );
    // Backslash is never a path separator here.
    expect(() => parseAgentFolderUri(`agent://${GENERAL}/notes\\x.txt`)).toThrow(
      AgentFolderUriInvalidError,
    );
  });
});

describe("decideAgentFolderAccess (pure guard decision)", () => {
  it("allows an Agent its OWN subtree — root and nested", () => {
    const own = decideAgentFolderAccess(GENERAL, parseAgentFolderUri(`agent://${GENERAL}/`));
    expect(own).toMatchObject({ allowed: true, agent_id: GENERAL, path: "" });
    const nested = decideAgentFolderAccess(
      GENERAL,
      parseAgentFolderUri(`agent://${GENERAL}/notes/ideas.txt`),
    );
    expect(nested).toMatchObject({
      allowed: true,
      agent_id: GENERAL,
      path: "notes/ideas.txt",
    });
  });

  it("denies ANY other Agent's private subtree — the decision names the reason", () => {
    const foreign = decideAgentFolderAccess(
      GENERAL,
      parseAgentFolderUri(`agent://${RESEARCHER}/notes/ideas.txt`),
    );
    expect(foreign).toMatchObject({
      allowed: false,
      reason: "foreign_private_folder",
      agent_id: RESEARCHER,
    });
  });
});

describe("AgentFoldersService (guard + in-memory store seam)", () => {
  it("lets an Agent write and read back its OWN folder through the seam", () => {
    service.writeFolder(
      "ws-primary",
      GENERAL,
      `agent://${GENERAL}/notes/ideas.txt`,
      "Persist me nowhere but memory.",
    );
    // Folder-root write too.
    service.writeFolder("ws-primary", GENERAL, `agent://${GENERAL}/`, "root note");
    expect(
      service.readFolder("ws-primary", GENERAL, `agent://${GENERAL}/notes/ideas.txt`),
    ).toBe("Persist me nowhere but memory.");
    expect(service.readFolder("ws-primary", GENERAL, `agent://${GENERAL}/`)).toBe("root note");
    // An unwritten path reads as null — not an error, not fabricated content.
    expect(
      service.readFolder("ws-primary", GENERAL, `agent://${GENERAL}/notes/absent.txt`),
    ).toBeNull();
  });

  it("denies reads AND writes into ANOTHER Agent's private subtree, at root and nested", () => {
    const foreignRoot = `agent://${RESEARCHER}/`;
    const foreignNested = `agent://${RESEARCHER}/notes/private.txt`;

    expect(() => service.readFolder("ws-primary", GENERAL, foreignRoot)).toThrow(
      AgentFolderAccessDeniedError,
    );
    expect(() => service.readFolder("ws-primary", GENERAL, foreignNested)).toThrow(
      AgentFolderAccessDeniedError,
    );
    expect(() =>
      service.writeFolder("ws-primary", GENERAL, foreignNested, "smuggled"),
    ).toThrow(AgentFolderAccessDeniedError);
    expect(() => service.writeFolder("ws-primary", GENERAL, foreignRoot, "smuggled")).toThrow(
      AgentFolderAccessDeniedError,
    );

    // The denied writes never touched the researcher's store.
    expect(
      service.readFolder("ws-primary", RESEARCHER, `agent://${RESEARCHER}/notes/private.txt`),
    ).toBeNull();
  });

  it("rejects traversal URIs at the seam — the store is never reached", () => {
    expect(() =>
      service.writeFolder(
        "ws-primary",
        GENERAL,
        `agent://${GENERAL}/../${RESEARCHER}/notes.txt`,
        "escape",
      ),
    ).toThrow(AgentFolderUriInvalidError);
    expect(() =>
      service.readFolder("ws-primary", GENERAL, `agent://${GENERAL}/%2e%2e/escape.txt`),
    ).toThrow(AgentFolderUriInvalidError);
  });

  it("resolves agent:// URIs against the WORKSPACE's Agent records — unknown agent, actor, or workspace are typed misses", () => {
    // Unknown folder owner.
    expect(() =>
      service.readFolder("ws-primary", GENERAL, "agent://agent_nobody/notes.txt"),
    ).toThrow(AgentNotFoundError);
    // Unknown ACTOR: an access decision needs a seeded acting Agent.
    expect(() =>
      service.readFolder("ws-primary", "agent_nobody", `agent://${GENERAL}/notes.txt`),
    ).toThrow(AgentNotFoundError);
    // Unknown (or foreign) workspace: the agent records live per workspace, so
    // nothing resolves there — the E12 scoping is the workspace boundary.
    expect(() =>
      service.readFolder("ws-other", GENERAL, `agent://${GENERAL}/notes.txt`),
    ).toThrow(AgentNotFoundError);
  });
});

describe("InMemoryAgentFolderStore (placeholder storage behind the seam)", () => {
  it("keys entries by workspace and agent — no cross-workspace or cross-agent bleed", () => {
    const store = new InMemoryAgentFolderStore();
    store.write("ws-primary", GENERAL, "notes/a.txt", "one");
    expect(store.read("ws-primary", GENERAL, "notes/a.txt")).toBe("one");
    expect(store.read("ws-primary", RESEARCHER, "notes/a.txt")).toBeNull();
    expect(store.read("ws-secondary", GENERAL, "notes/a.txt")).toBeNull();
    store.write("ws-primary", GENERAL, "notes/a.txt", "two");
    expect(store.read("ws-primary", GENERAL, "notes/a.txt")).toBe("two");
  });
});
