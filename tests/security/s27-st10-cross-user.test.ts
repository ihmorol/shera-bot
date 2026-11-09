/**
 * S27 ST-10 — cross-user access, composed legs (threat model §5 ST-10;
 * TM-3.3/TM-5.2; PRD §16 + D1/D27/E12). Docker is unusable on the building
 * machine (the recorded E22–E36 reality), so the container-level leg stays the
 * documented PROCEDURE in THREAT-COVERAGE §4 (the owner's P9 item); THIS
 * suite proves the composed legs the prototype can prove for real:
 *
 *   1. THE TENANT BINDING (the web proxy's `runtimeWorkspaceMatches`): every
 *      adversarial selector shape a second account can craft — a
 *      query-named foreign workspace, a body-named one, DUPLICATE selectors
 *      where one matches, percent-encoded paths, a GET with no selector, a
 *      foreign selector under a method the binding accepts — answers FALSE.
 *      The positive controls (own workspace in query for GET, in body for
 *      POST) answer TRUE — the binding gates, it doesn't dead-end.
 *   2. THE PROXY ENFORCES IT (proxyToLocalApi over the real module): B's
 *      authenticated session calling with A's workspace_id in query or body
 *      answers the typed RUNTIME_TENANT_MISMATCH 403 and the upstream
 *      receives ZERO requests (the call never left the proxy). The positive
 *      control: B's own workspace IS forwarded.
 *   3. THE STORE BOUNDARY (E12, store-per-workspace composition): two real
 *      accounts, TWO runtime stores. Rows written through A's adapters are
 *      invisible to B's adapters (B's read models return nothing for A's
 *      ids), and B's whole-store byte scan carries neither A's workspace id
 *      nor A's synthetic content.
 *   4. THE CUSTODY BOUNDARY (D22/E9): A's provider key is sealed AES-256-GCM
 *      into A's store through the REAL vault; neither A's bytes (the seal)
 *      nor B's bytes carry the plaintext — the credential does not exist
 *      unsealed anywhere a second store could reach.
 *
 * RED-FIRST evidence: the proxy's runtimeWorkspaceMatches gate was removed
 * (the forwarder passed every request through), the suite FAILED (B's
 * foreign-workspace request was FORWARDED upstream), the control was
 * restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-09-st10-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-10, PRD §16, D1, D22, D27, E9, E12.
 */
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { runtimeWorkspaceMatches, Session } from "@shera-bot/contracts";

import { openDatabase, type SqliteConnection } from "../../apps/user-runtime/src/adapters/sqlite/connection.ts";
import { applyMigrations } from "../../apps/user-runtime/src/adapters/sqlite/migrations.ts";
import { SqliteTransactions } from "../../apps/user-runtime/src/adapters/sqlite/transactions.ts";
import { TerminalEventsRepository } from "../../apps/user-runtime/src/adapters/sqlite/terminal-events-repository.ts";
import { EventJournalRepository } from "../../apps/user-runtime/src/adapters/sqlite/event-journal-repository.ts";
import { ProvidersRepository } from "../../apps/user-runtime/src/adapters/sqlite/providers-repository.ts";
import { ProviderCredentialsRepository } from "../../apps/user-runtime/src/adapters/sqlite/provider-credentials-repository.ts";
import { EventsService } from "../../apps/user-runtime/src/modules/events/events.service.ts";
import { TerminalRecorder } from "../../apps/user-runtime/src/modules/terminals/terminal-recorder.service.ts";
import { ProviderCredentialVault } from "../../apps/user-runtime/src/modules/providers/provider-credential-vault.ts";
import { proxyToLocalApi } from "../../apps/web/lib/server/proxies";

const WS_A = "ws_account_a";
const WS_B = "ws_account_b";
const SUB_A = "google-account-a";
const SUB_B = "google-account-b";
const NOW = "2026-11-09T12:00:00.000Z";

/** A's synthetic provider key (clearly labeled, never real — G3). */
const PROVIDER_KEY_A = "s27-SYNTHETIC-provider-key-account-a-NOT-REAL";
const TERMINAL_CONTENT_A = "s27-SYNTHETIC-terminal-content-account-a-NOT-REAL";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["CONTROL_PLANE_URL"];
  delete process.env["RUNTIME_LOCAL_API_URL"];
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A session body for one account (the Session contract's shape). */
function sessionBody(workspaceId: string, googleSub: string) {
  return {
    workspace_id: workspaceId,
    google_sub: googleSub,
    email: `${googleSub}@example.com`,
    display_name: `User ${googleSub}`,
    tier: "balanced",
    is_admin: false,
    created_at: NOW,
    last_active_at: NOW,
  };
}

interface FetchCall {
  input: RequestInfo | URL;
  init?: RequestInit | undefined;
}

/** A fetch stub recording every call; /api/session answers with `session`. */
function stubFetch(
  respond: () => Response,
  session: () => Response,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(String(input).endsWith("/api/session") ? session() : respond());
    }),
  );
  return { calls };
}

async function proxied(
  method: "GET" | "POST",
  pathWithQuery: string,
  body: unknown,
  session: ReturnType<typeof sessionBody>,
): Promise<{ status: number; code: string | null; forwarded: number }> {
  process.env["CONTROL_PLANE_URL"] = "http://control-plane.test";
  process.env["RUNTIME_LOCAL_API_URL"] = "http://runtime-local.test";
  const { calls } = stubFetch(
    () => Response.json({ ok: true, upstream: "reached" }),
    () => Response.json(session),
  );
  const request = new Request(`http://web.test/api/runtime${pathWithQuery}`, {
    method,
    ...(body !== null
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", cookie: "shera.session=authenticated" },
        }
      : { headers: { cookie: "shera.session=authenticated" } }),
  });
  const upstreamPath = pathWithQuery.split("?")[0] ?? "/";
  const response = await proxyToLocalApi(request, upstreamPath);
  let code: string | null = null;
  try {
    const json = (await response.json()) as { code?: string };
    code = json.code ?? null;
  } catch {
    code = null;
  }
  // `forwarded` counts the calls AFTER the session lookup — i.e. whether the
  // proxy passed the request to the runtime.
  const forwarded = Math.max(0, calls.length - 1);
  return { status: response.status, code, forwarded };
}

interface Store {
  dbPath: string;
  conn: SqliteConnection;
  recorder: TerminalRecorder;
  credentials: ProviderCredentialsRepository;
  providers: ProvidersRepository;
  vault: ProviderCredentialVault;
  dispose(): void;
}

function buildStore(label: string): Store {
  const dir = mkdtempSync(join(tmpdir(), `shera-s27-st10-${label}-`));
  tempDirs.push(dir);
  const dbPath = join(dir, "runtime.db");
  const conn = openDatabase(dbPath);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  const recorder = new TerminalRecorder({
    tx,
    terminals: new TerminalEventsRepository(tx),
    events: new EventsService(new EventJournalRepository(tx), tx),
  });
  return {
    dbPath,
    conn,
    recorder,
    providers: new ProvidersRepository(tx),
    credentials: new ProviderCredentialsRepository(tx),
    vault: new ProviderCredentialVault(join(dir, "custody.key")),
    dispose(): void {
      try {
        conn.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Whole-store byte scan: the database plus every sibling sidecar (WAL/SHM). */
function scanStoreBytes(dbPath: string): string {
  const base = dbPath.split("/").pop() ?? "runtime.db";
  const parts = [readFileSync(dbPath).toString("latin1")];
  for (const name of readdirSync(join(dbPath, ".."))) {
    if (!name.startsWith(base)) continue;
    parts.push(readFileSync(join(dbPath, "..", name)).toString("latin1"));
  }
  return parts.join("\n---sidecar---\n");
}

describe("S27 ST-10 — the tenant binding refuses every foreign selector shape", () => {
  it("a foreign workspace in the QUERY is refused; duplicates where one matches are refused", () => {
    // B's session, A's workspace in the query: refused.
    expect(runtimeWorkspaceMatches("GET", new URL(`http://x/v1/terminals/state?workspace_id=${WS_A}`).searchParams, null, WS_B)).toBe(false);
    // Duplicate selectors — one matches B, one names A: refused (both must match).
    expect(
      runtimeWorkspaceMatches(
        "GET",
        new URL(`http://x/v1/credits?workspace_id=${WS_B}&workspace_id=${WS_A}`).searchParams,
        null,
        WS_B,
      ),
    ).toBe(false);
    // The duplicate in the OTHER order: equally refused.
    expect(
      runtimeWorkspaceMatches(
        "GET",
        new URL(`http://x/v1/credits?workspace_id=${WS_A}&workspace_id=${WS_B}`).searchParams,
        null,
        WS_B,
      ),
    ).toBe(false);
    // A percent-encoded foreign selector never equals the session's id.
    expect(
      runtimeWorkspaceMatches("GET", new URL(`http://x/v1/credits?workspace_id=${WS_A}%2f..%2f`).searchParams, null, WS_B),
    ).toBe(false);
    // A GET with NO selector: refused (the workspace binding is mandatory).
    expect(runtimeWorkspaceMatches("GET", new URL("http://x/v1/credits").searchParams, null, WS_B)).toBe(false);
    // A POST whose BODY names the foreign workspace: refused.
    expect(
      runtimeWorkspaceMatches("POST", new URL("http://x/v1/conversations/commands").searchParams, { workspace_id: WS_A }, WS_B),
    ).toBe(false);
    // A body with NO workspace_id at all: refused.
    expect(
      runtimeWorkspaceMatches("POST", new URL("http://x/v1/conversations/commands").searchParams, { type: "conversation.create" }, WS_B),
    ).toBe(false);
  });

  it("the positive controls: the session's OWN workspace passes (the gate is not a dead end)", () => {
    // B's own workspace in the query (GET): allowed.
    expect(runtimeWorkspaceMatches("GET", new URL(`http://x/v1/credits?workspace_id=${WS_B}`).searchParams, null, WS_B)).toBe(true);
    // B's own workspace in the body (POST): allowed.
    expect(
      runtimeWorkspaceMatches("POST", new URL("http://x/v1/conversations/commands").searchParams, { workspace_id: WS_B }, WS_B),
    ).toBe(true);
    // The parsed session carries the account identity (the binding's input).
    const session = Session.safeParse(sessionBody(WS_B, SUB_B));
    expect(session.success).toBe(true);
    if (session.success) {
      expect(session.data.workspace_id).toBe(WS_B);
      expect(session.data.google_sub).toBe(SUB_B);
    }
  });
});

describe("S27 ST-10 — the proxy enforces the binding (nothing forwarded on a mismatch)", () => {
  it("B's session calling with A's workspace in the QUERY: 403 RUNTIME_TENANT_MISMATCH, ZERO upstream calls", async () => {
    const result = await proxied("GET", `/v1/terminals/state?workspace_id=${WS_A}`, null, sessionBody(WS_B, SUB_B));
    expect(result.status).toBe(403);
    expect(result.code).toBe("RUNTIME_TENANT_MISMATCH");
    expect(result.forwarded).toBe(0);
  });

  it("B's session calling with A's workspace in the BODY: 403 RUNTIME_TENANT_MISMATCH, ZERO upstream calls", async () => {
    const result = await proxied(
      "POST",
      "/v1/conversations/commands",
      { type: "conversation.create", workspace_id: WS_A, idempotency_key: "idem_st10", payload: { title: "A's workspace" } },
      sessionBody(WS_B, SUB_B),
    );
    expect(result.status).toBe(403);
    expect(result.code).toBe("RUNTIME_TENANT_MISMATCH");
    expect(result.forwarded).toBe(0);
  });

  it("B's own workspace IS forwarded (the positive control reaches the runtime)", async () => {
    const result = await proxied(
      "POST",
      "/v1/conversations/commands",
      { type: "conversation.create", workspace_id: WS_B, idempotency_key: "idem_st10_ok", payload: { title: "B's own" } },
      sessionBody(WS_B, SUB_B),
    );
    expect(result.status).toBe(200);
    expect(result.forwarded).toBe(1);
  });
});

describe("S27 ST-10 — two accounts, two stores: B's runtime never resolves A's rows", () => {
  it("rows written through A's adapters are invisible to B's adapters and B's store bytes", () => {
    const storeA = buildStore("a");
    const storeB = buildStore("b");
    try {
      // A's runtime records a terminal execution with synthetic content.
      const terminalId = storeA.recorder.startExecution({
        workspace_id: WS_A,
        agent_id: "agent_a",
        session_id: null,
        command: "echo confidential",
        workdir: "/workspace",
        resource_policy: { network: "disabled" },
        approval_state: "not_required",
      });
      storeA.recorder.recordOutput({
        workspace_id: WS_A,
        agent_id: "agent_a",
        terminal_id: terminalId,
        stream: "stdout",
        raw_chunk: TERMINAL_CONTENT_A,
      });
      // B's adapters: the terminal id does not exist in B's store.
      const outputsInB = storeB.conn.db
        .prepare("SELECT COUNT(*) AS n FROM terminal_events WHERE terminal_id = ?")
        .get(terminalId) as { n: number };
      expect(outputsInB.n).toBe(0);
      const startInB = storeB.conn.db
        .prepare("SELECT COUNT(*) AS n FROM terminal_events WHERE workspace_id = ?")
        .get(WS_A) as { n: number };
      expect(startInB.n).toBe(0);
      // B's whole-store bytes: neither A's workspace id nor A's content.
      storeA.dispose();
      storeB.dispose();
      const bytesA = scanStoreBytes(storeA.dbPath);
      const bytesB = scanStoreBytes(storeB.dbPath);
      expect(bytesA).toContain(WS_A);
      expect(bytesA).toContain(TERMINAL_CONTENT_A);
      expect(bytesB).not.toContain(WS_A);
      expect(bytesB).not.toContain(TERMINAL_CONTENT_A);
      expect(bytesB).not.toContain(terminalId);
    } finally {
      storeA.dispose();
      storeB.dispose();
    }
  });
});

describe("S27 ST-10 — A's provider credential is sealed and absent from B's runtime bytes (D22/E9)", () => {
  it("the sealed custody row lives in A's store only; neither store carries the plaintext", () => {
    const storeA = buildStore("custody-a");
    const storeB = buildStore("custody-b");
    try {
      // A configures a provider and stores the key through the REAL vault.
      storeA.providers.create({
        id: "prov_a",
        workspace_id: WS_A,
        display_name: "A's provider",
        protocol: "openai",
        base_url: null,
        api_mode: "api_key",
        default_model_id: "model-a",
        organization: null,
        project: null,
        headers_json: "{}",
        request_params_json: "{}",
        origin: "user",
        created_at: NOW,
      });
      const sealed = storeA.vault.seal(PROVIDER_KEY_A);
      storeA.credentials.store({
        workspace_id: WS_A,
        provider_id: "prov_a",
        credential_hint: "s27-…A",
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        key_version: sealed.key_version,
        updated_at: NOW,
      });
      // A's own row exists and is SEALED: A's bytes carry the ciphertext but
      // never the plaintext (D22: decrypted only at call time).
      const row = storeA.credentials.getSealed(WS_A, "prov_a");
      expect(row).not.toBeNull();
      // B's store has no custody row at all for A's provider (queried while
      // the connection is live).
      const custodyInB = storeB.conn.db
        .prepare("SELECT COUNT(*) AS n FROM provider_credentials WHERE workspace_id = ?")
        .get(WS_A) as { n: number };
      expect(custodyInB.n).toBe(0);
      storeA.dispose();
      storeB.dispose();
      const bytesA = scanStoreBytes(storeA.dbPath);
      const bytesB = scanStoreBytes(storeB.dbPath);
      expect(bytesA).not.toContain(PROVIDER_KEY_A);
      expect(bytesB).not.toContain(PROVIDER_KEY_A);
    } finally {
      storeA.dispose();
      storeB.dispose();
    }
  });
});
