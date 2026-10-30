/**
 * S23 chunk 4 provider service tests (PRD §9, AC10, AC11, D17, D20, D22, E9):
 * the registry service owns provider configuration, credential custody
 * calls, and the EFFECTIVE provider resolution — conversation override, then
 * the conversation Agent's default, then the honest unconfigured state.
 * Everything crossing the service boundary is masked (G3).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ConversationsRepository } from "../../adapters/sqlite/conversations-repository.ts";
import { ProvidersRepository } from "../../adapters/sqlite/providers-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ProviderCredentialVault } from "./provider-credential-vault.ts";
import { ProviderCredentialsService } from "./provider-credentials.ts";
import { ProviderCredentialsRepository } from "../../adapters/sqlite/provider-credentials-repository.ts";
import { ProviderService, ProviderServiceError } from "./provider-service.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

const WS = "ws-local-default";
const clock = "2026-10-30T12:00:00.000Z";

/** The agent-defaults lookup stub: agent_researcher defaults to prov_openai. */
const agentDefaults = {
  findAgentForDirectChat(workspaceId: string, conversationId: string): string | null {
    if (conversationId === "conv_direct") return "agent_researcher";
    return null;
  },
  getDefaultProvider(
    workspaceId: string,
    agentId: string,
  ): { provider_id: string; model: string } | null {
    if (agentId === "agent_researcher") return { provider_id: "prov_openai", model: "gpt-4o-mini" };
    return null;
  },
};

function newService(): ProviderService {
  const dir = mkdtempSync(join(tmpdir(), "shera-s23-service-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  openConnections.push(conn);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  new ConversationsRepository(tx).create({
    id: "conv_direct",
    workspace_id: WS,
    title: "Direct chat",
    revision: 1,
    created_at: clock,
    updated_at: clock,
  });
  const providers = new ProvidersRepository(tx);
  providers.create({
    id: "prov_openai",
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
  });
  providers.create({
    id: "prov_local",
    workspace_id: WS,
    display_name: "Local Ollama",
    protocol: "ollama",
    base_url: "http://127.0.0.1:11434/v1",
    api_mode: "no_key",
    default_model_id: "llama3.2",
    organization: null,
    project: null,
    headers_json: "{}",
    request_params_json: "{}",
    origin: "user",
    created_at: "2026-10-30T12:00:01.000Z",
  });
  return new ProviderService({
    providers,
    credentials: new ProviderCredentialsService({
      vault: new ProviderCredentialVault(join(dir, "provider-credentials.key")),
      credentials: new ProviderCredentialsRepository(tx),
    }),
    agentDefaults,
    now: () => clock,
  });
}

afterAll(() => {
  for (const conn of openConnections) {
    conn.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("provider service configuration (masked everywhere, G3)", () => {
  it("configures an entry with its credential in one unit and returns the masked view", () => {
    const service = newService();
    const view = service.configure({
      workspace_id: WS,
      display_name: "Proxy endpoint",
      protocol: "openai-compatible",
      base_url: "https://proxy.example.invalid/v1",
      api_mode: "api_key",
      credential: "sk-new-0123456789abcdef",
      default_model_id: "proxy-model",
      organization: null,
      project: null,
      headers: {},
      request_params: {},
      origin: "user",
    });
    expect(view.id).toMatch(/^prov_/);
    expect(view.credential_hint).toBe("••••cdef");
    // The view NEVER carries the secret.
    expect(JSON.stringify(view)).not.toContain("sk-new-0123456789abcdef");
    expect(service.resolveCredentialForCall(WS, view.id)).toBe("sk-new-0123456789abcdef");
  });

  it("rejects credential-shaped headers with a typed error before any row exists", () => {
    const service = newService();
    expect(() =>
      service.configure({
        workspace_id: WS,
        display_name: "Bad headers",
        protocol: "openai-compatible",
        base_url: "https://proxy.example.invalid/v1",
        api_mode: "api_key",
        credential: "sk-new-0123456789abcdef",
        default_model_id: "proxy-model",
        organization: null,
        project: null,
        headers: { "X-Api-Key": "leak" },
        request_params: {},
        origin: "user",
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_HEADER_CREDENTIAL_REJECTED" }));
  });

  it("requires a credential for api_key mode and forbids one for no_key mode", () => {
    const service = newService();
    expect(() =>
      service.configure({
        workspace_id: WS,
        display_name: "No key given",
        protocol: "openai-compatible",
        base_url: "https://proxy.example.invalid/v1",
        api_mode: "api_key",
        credential: null,
        default_model_id: "m",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      }),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }));
    expect(() => service.setCredential(WS, "prov_local", "should-not-exist")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CONFIG_INVALID" }),
    );
  });

  it("lists masked views and enables/disables", () => {
    const service = newService();
    const list = service.listProviders(WS);
    expect(list.map((row) => row.id)).toEqual(["prov_openai", "prov_local"]);
    expect(list.every((row) => !JSON.stringify(row).includes("sk-"))).toBe(true);
    const disabled = service.setStatus(WS, "prov_openai", false);
    expect(disabled.status).toBe("disabled");
  });

  it("revokes and replaces a credential (replace takes effect on the next call)", () => {
    const service = newService();
    service.setCredential(WS, "prov_openai", "sk-first-0123456789aaaa");
    expect(service.resolveCredentialForCall(WS, "prov_openai")).toBe("sk-first-0123456789aaaa");
    service.revokeCredential(WS, "prov_openai");
    expect(service.getProviderView(WS, "prov_openai")?.credential_hint).toBeNull();
    expect(() => service.resolveCredentialForCall(WS, "prov_openai")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_REVOKED" }),
    );
    service.setCredential(WS, "prov_openai", "sk-second-0123456789bbbb");
    expect(service.resolveCredentialForCall(WS, "prov_openai")).toBe("sk-second-0123456789bbbb");
  });
});

describe("effective provider resolution (AC11)", () => {
  it("prefers the conversation override over the Agent default", () => {
    const service = newService();
    service.setCredential(WS, "prov_openai", "sk-openai-0123456789aaaa");
    service.setConversationOverride(WS, "conv_direct", "prov_local", "llama3.1:8b");
    const effective = service.resolveEffective(WS, "conv_direct");
    expect(effective).toMatchObject({
      configured: true,
      provider_id: "prov_local",
      model: "llama3.1:8b",
      source: "conversation_override",
    });
  });

  it("falls back to the conversation Agent's default pair when no override exists", () => {
    const service = newService();
    service.setCredential(WS, "prov_openai", "sk-openai-0123456789aaaa");
    const effective = service.resolveEffective(WS, "conv_direct");
    expect(effective).toMatchObject({
      configured: true,
      provider_id: "prov_openai",
      model: "gpt-4o-mini",
      source: "agent_default",
    });
  });

  it("uses a null-model override's provider default model", () => {
    const service = newService();
    service.setConversationOverride(WS, "conv_direct", "prov_local", null);
    const effective = service.resolveEffective(WS, "conv_direct");
    expect(effective).toMatchObject({
      configured: true,
      provider_id: "prov_local",
      model: "llama3.2",
      source: "conversation_override",
    });
  });

  it("answers the honest unconfigured state when nothing resolves (D17)", () => {
    const service = newService();
    const effective = service.resolveEffective(WS, "conv_unbound");
    expect(effective).toMatchObject({
      configured: false,
      code: "PROVIDER_NOT_CONFIGURED",
    });
    expect(effective.configured ? "" : effective.safe_message).toMatch(/no provider/i);
  });

  it("refuses a disabled provider with its own typed state", () => {
    const service = newService();
    service.setCredential(WS, "prov_openai", "sk-openai-0123456789aaaa");
    service.setStatus(WS, "prov_openai", false);
    expect(service.resolveEffective(WS, "conv_direct")).toMatchObject({
      configured: false,
      code: "PROVIDER_DISABLED",
    });
  });

  it("refuses a key-mode provider whose credential was revoked (D22 fail-safe)", () => {
    const service = newService();
    // The default pair points at prov_openai but no credential is stored.
    expect(service.resolveEffective(WS, "conv_direct")).toMatchObject({
      configured: false,
      code: "PROVIDER_CREDENTIAL_REVOKED",
    });
  });

  it("clears an override and returns to the Agent default", () => {
    const service = newService();
    service.setCredential(WS, "prov_openai", "sk-openai-0123456789aaaa");
    service.setConversationOverride(WS, "conv_direct", "prov_local", null);
    service.clearConversationOverride(WS, "conv_direct");
    expect(service.resolveEffective(WS, "conv_direct")).toMatchObject({
      source: "agent_default",
    });
    expect(() => service.clearConversationOverride(WS, "conv_absent")).toThrowError(
      ProviderServiceError,
    );
  });

  it("validates an override's provider against the catalog", () => {
    const service = newService();
    expect(() =>
      service.setConversationOverride(WS, "conv_direct", "prov_absent", null),
    ).toThrowError(expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }));
  });
});
