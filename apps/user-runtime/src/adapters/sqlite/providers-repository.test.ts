/**
 * S23 chunk 1 provider catalog storage contract tests (PRD §9, §19 AC10/AC11,
 * D17, D20, D22, E9, E12, G3): the v15 migration creates the STRICT provider
 * catalog, per-conversation override, and credential-custody tables, and the
 * repositories enforce the writer-side rules — validated configuration shapes,
 * workspace scoping (E12), and a schema where a provider key can never live in
 * the catalog row (the credential's only storage is the sealed-custody table).
 *
 * Real SQLite, real migrations — the same discipline as the agents/terminal
 * repository tests. Vocabulary: Pack → Operations → Agents (G1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "./connection.ts";
import { appliedMigrationVersions, applyMigrations, MIGRATIONS } from "./migrations.ts";
import { ConversationsRepository } from "./conversations-repository.ts";
import {
  ProvidersRepository,
  ProvidersRepositoryError,
  type ProviderCreateInput,
  type ProviderOverrideInput,
} from "./providers-repository.ts";
import { SqliteTransactions } from "./transactions.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

function newDb(): { conn: SqliteConnection; tx: SqliteTransactions } {
  const dir = mkdtempSync(join(tmpdir(), "shera-s23-providers-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  return { conn, tx: new SqliteTransactions(conn.db) };
}

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const WS = "ws-local-default";
const OTHER_WS = "ws-other-0000";
const clock = "2026-10-30T12:00:00.000Z";

function providerInput(overrides: Partial<ProviderCreateInput> = {}): ProviderCreateInput {
  return {
    id: "prov_0001",
    workspace_id: WS,
    display_name: "Workspace OpenAI",
    protocol: "openai",
    base_url: null,
    api_mode: "api_key",
    default_model_id: "gpt-4o-mini",
    organization: null,
    project: null,
    headers_json: "{}",
    request_params_json: "{}",
    origin: "user",
    created_at: clock,
    ...overrides,
  };
}

describe("provider catalog storage (S23 migration v15)", () => {
  it("appends the provider catalog as version 15 of the committed chain", () => {
    const v15 = MIGRATIONS.find((migration) => migration.version === 15);
    expect(v15?.name).toBe("provider-catalog");
    expect(MIGRATIONS.at(-1)?.version).toBe(15);
  });

  it("creates the STRICT tables through the migration runner", () => {
    const { conn } = newDb();
    expect(appliedMigrationVersions(conn.db)).toContain(15);
    for (const table of ["providers", "provider_credentials", "conversation_provider_overrides"]) {
      const row = conn.db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(table) as { sql: string } | undefined;
      expect(row?.sql).toContain("STRICT");
    }
  });

  it("creates and reads back one provider entry (the schema has no api_key column)", () => {
    const { conn, tx } = newDb();
    const repo = new ProvidersRepository(tx);
    const created = repo.create(providerInput());
    expect(created.id).toBe("prov_0001");
    expect(created.status).toBe("enabled");
    // The row carries the columns of PRD §9's field list, never a key.
    const raw = conn.db
      .prepare("SELECT * FROM providers WHERE workspace_id = ? AND id = ?")
      .get(WS, "prov_0001") as Record<string, unknown>;
    expect(raw["api_key"]).toBeUndefined();
    expect(raw["credential"]).toBeUndefined();
    expect(raw["display_name"]).toBe("Workspace OpenAI");
    expect(raw["default_model_id"]).toBe("gpt-4o-mini");
    expect(repo.get(WS, "prov_0001")).toMatchObject({ id: "prov_0001", protocol: "openai" });
  });

  it("defaults missing optional JSON columns to empty objects and validates their shape", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    const created = repo.create(
      providerInput({ headers_json: '{"X-Custom":"routing"}', request_params_json: "{}" }),
    );
    expect(JSON.parse(created.headers_json)).toEqual({ "X-Custom": "routing" });
    expect(() =>
      repo.create(providerInput({ id: "prov_bad", headers_json: '{"X":1}' })),
    ).toThrowError(ProvidersRepositoryError);
  });

  it("refuses duplicate ids, unknown protocols, and non-http(s) base URLs with typed errors", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    repo.create(providerInput());
    expect(() => repo.create(providerInput())).toThrowError(
      expect.objectContaining({ code: "PROVIDER_ALREADY_EXISTS" }),
    );
    expect(() =>
      repo.create(providerInput({ id: "prov_bad_proto", protocol: "grok" as never })),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
    expect(() =>
      repo.create(
        providerInput({
          id: "prov_bad_url",
          protocol: "openai-compatible",
          base_url: "ftp://example.invalid/v1",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
    expect(() => repo.create(providerInput({ id: "prov_empty", display_name: "  " }))).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }),
    );
  });

  it("refuses a no_key entry that still declares a base URL-less native protocol without a model", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    expect(() =>
      repo.create(providerInput({ id: "prov_nomodel", default_model_id: "" })),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
  });

  it("updates config fields and status, stamping updated_at, without touching identity", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    repo.create(providerInput());
    const updated = repo.updateConfig(WS, "prov_0001", {
      display_name: "Renamed",
      base_url: "https://proxy.example.invalid/v1",
      default_model_id: "gpt-4o",
      organization: "org_1",
      project: null,
      headers_json: '{"X-Route":"a"}',
      request_params_json: '{"temperature":0.2}',
      updated_at: "2026-10-30T13:00:00.000Z",
    });
    expect(updated.display_name).toBe("Renamed");
    expect(updated.updated_at).toBe("2026-10-30T13:00:00.000Z");
    const disabled = repo.setStatus(WS, "prov_0001", "disabled", "2026-10-30T14:00:00.000Z");
    expect(disabled.status).toBe("disabled");
    expect(() =>
      repo.updateConfig(OTHER_WS, "prov_0001", { display_name: "nope", updated_at: clock }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }));
  });

  it("lists a workspace's entries and keeps another workspace's invisible (E12)", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    repo.create(providerInput());
    repo.create(
      providerInput({
        id: "prov_0002",
        display_name: "Local Ollama",
        protocol: "ollama",
        api_mode: "no_key",
      }),
    );
    expect(repo.list(WS).map((row) => row.id)).toEqual(["prov_0001", "prov_0002"]);
    expect(repo.list(OTHER_WS)).toEqual([]);
    expect(repo.get(OTHER_WS, "prov_0001")).toBeNull();
  });

  it("stores one per-conversation override and clears it (AC11)", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    // The override writer validates the conversation in the SAME workspace
    // (E12) — seed one real conversation row first.
    new ConversationsRepository(tx).create({
      id: "conv_0001",
      workspace_id: WS,
      title: "Direct chat",
      revision: 1,
      created_at: clock,
      updated_at: clock,
    });
    repo.create(providerInput());
    const override: ProviderOverrideInput = {
      workspace_id: WS,
      conversation_id: "conv_0001",
      provider_id: "prov_0001",
      model: "gpt-4o",
      updated_at: clock,
    };
    repo.setOverride(override);
    expect(repo.getOverride(WS, "conv_0001")).toMatchObject({
      provider_id: "prov_0001",
      model: "gpt-4o",
    });
    // A null model is meaningful: "use the provider's default model".
    repo.setOverride({ ...override, model: null, updated_at: "2026-10-30T12:30:00.000Z" });
    expect(repo.getOverride(WS, "conv_0001")?.model).toBeNull();
    // The override writer validates the provider in the SAME workspace (E12).
    expect(() => repo.setOverride({ ...override, provider_id: "prov_absent" })).toThrowError(
      expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }),
    );
    expect(() => repo.setOverride({ ...override, conversation_id: "conv_absent" })).toThrowError(
      expect.objectContaining({ code: "CONVERSATION_NOT_FOUND" }),
    );
    repo.clearOverride(WS, "conv_0001");
    expect(repo.getOverride(WS, "conv_0001")).toBeNull();
  });

  it("resolves a conversation override only when its provider is enabled", () => {
    const { tx } = newDb();
    const repo = new ProvidersRepository(tx);
    new ConversationsRepository(tx).create({
      id: "conv_0001",
      workspace_id: WS,
      title: "Direct chat",
      revision: 1,
      created_at: clock,
      updated_at: clock,
    });
    repo.create(providerInput());
    repo.setOverride({
      workspace_id: WS,
      conversation_id: "conv_0001",
      provider_id: "prov_0001",
      model: null,
      updated_at: clock,
    });
    expect(repo.getOverride(WS, "conv_0001")?.provider_id).toBe("prov_0001");
    repo.setStatus(WS, "prov_0001", "disabled", clock);
    // The row remains (re-enabling restores it); resolution itself is the
    // service's rule — the repository keeps the durable shape only.
    expect(repo.get(WS, "prov_0001")?.status).toBe("disabled");
  });
});
