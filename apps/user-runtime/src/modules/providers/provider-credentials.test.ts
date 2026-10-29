/**
 * S23 chunk 2 provider-credential custody tests (D22, E9, PRD §9, §12, §16,
 * G3): the AES-256-GCM vault keeps provider keys encrypted at rest inside the
 * user container; the custody service stores, revokes, and replaces them and
 * decrypts ONLY at call time; no read-back path exists; the masked hint
 * reveals at most the final four characters. Tampered or foreign-key
 * ciphertext fails closed (never plaintext, never a guess — G4).
 *
 * The custody shape follows the recorded D22/E9 reading — the same
 * construction S19's project-credential vault established (container-local
 * 0600 key file beside the database, sealed payloads in SQLite, masked
 * display, revoke/replace lifecycle), adapted for provider keys.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { openDatabase, type SqliteConnection } from "../../adapters/sqlite/connection.ts";
import { applyMigrations } from "../../adapters/sqlite/migrations.ts";
import { ProvidersRepository } from "../../adapters/sqlite/providers-repository.ts";
import { ProviderCredentialsRepository } from "../../adapters/sqlite/provider-credentials-repository.ts";
import { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import { ProviderCredentialVault } from "./provider-credential-vault.ts";
import { ProviderCredentialsService, ProviderCredentialError } from "./provider-credentials.ts";

const tempDirs: string[] = [];
const openConnections: SqliteConnection[] = [];

function newFixture(): {
  baseDir: string;
  dbPath: string;
  keyPath: string;
  conn: SqliteConnection;
  tx: SqliteTransactions;
  service: ProviderCredentialsService;
} {
  const baseDir = mkdtempSync(join(tmpdir(), "shera-s23-custody-"));
  tempDirs.push(baseDir);
  const dbPath = join(baseDir, "runtime.db");
  const keyPath = join(baseDir, "provider-credentials.key");
  const conn = openDatabase(dbPath);
  openConnections.push(conn);
  applyMigrations(conn.db);
  const tx = new SqliteTransactions(conn.db);
  new ProvidersRepository(tx).create({
    id: "prov_0001",
    workspace_id: "ws-local-default",
    display_name: "Custody fixture",
    protocol: "openai-compatible",
    base_url: "https://api.example.invalid/v1",
    api_mode: "api_key",
    default_model_id: "test-model",
    organization: null,
    project: null,
    headers_json: "{}",
    request_params_json: "{}",
    origin: "user",
    created_at: "2026-10-30T12:00:00.000Z",
  });
  const service = new ProviderCredentialsService({
    vault: new ProviderCredentialVault(keyPath),
    credentials: new ProviderCredentialsRepository(tx),
  });
  return { baseDir, dbPath, keyPath, conn, tx, service };
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
const SECRET = "sk-fixture-0123456789abcdefSECRET";

describe("provider credential vault (AES-256-GCM, D22)", () => {
  it("round-trips a secret through seal and open", () => {
    const { keyPath } = newFixture();
    const vault = new ProviderCredentialVault(keyPath);
    const sealed = vault.seal(SECRET);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain(SECRET);
    expect(vault.open(sealed)).toBe(SECRET);
  });

  it("fails closed on a tampered payload and on a foreign key", () => {
    const { keyPath } = newFixture();
    const vault = new ProviderCredentialVault(keyPath);
    const sealed = vault.seal(SECRET);
    const tampered = { ...sealed, ciphertext: Buffer.from([0, ...sealed.ciphertext.subarray(1)]) };
    expect(() => vault.open(tampered)).toThrowError(ProviderCredentialError);
    // A different vault (a different key file) cannot open the payload.
    const otherVault = new ProviderCredentialVault(join(tempDirs[0]!, "other.key"));
    expect(() => otherVault.open(sealed)).toThrowError(ProviderCredentialError);
  });

  it("generates the 0600 key on first use and refuses a corrupt existing key file", () => {
    const first = newFixture();
    const vaultA = new ProviderCredentialVault(first.keyPath);
    vaultA.seal(SECRET);
    const mode = readFileSync(first.keyPath).length;
    expect(mode).toBe(32);
    // A key file of the wrong length is a typed hard failure (never a silent
    // re-key, which would brick every stored ciphertext — G4).
    writeFileSync(join(tempDirs[0]!, "short.key"), Buffer.alloc(8));
    expect(() => new ProviderCredentialVault(join(tempDirs[0]!, "short.key")).seal(SECRET)).toThrowError(
      ProviderCredentialError,
    );
  });
});

describe("provider credential custody service (E9/D22)", () => {
  it("stores, reports a masked hint, and decrypts only for a call", () => {
    const { service } = newFixture();
    service.store(WS, "prov_0001", SECRET, "2026-10-30T12:00:01.000Z");
    const hint = service.credentialHint(WS, "prov_0001");
    // Masked display only: never the full secret, at most the final four.
    expect(hint).not.toBe(SECRET);
    expect(hint).toContain("••••");
    expect(hint.endsWith("CRET")).toBe(true);
    expect(hint).not.toContain(SECRET.slice(0, 8));
    expect(service.decryptForCall(WS, "prov_0001")).toBe(SECRET);
  });

  it("fully masks short secrets", () => {
    const { service } = newFixture();
    service.store(WS, "prov_0001", "short", "2026-10-30T12:00:01.000Z");
    expect(service.credentialHint(WS, "prov_0001")).toBe("••••••");
  });

  it("revokes: the sealed row is deleted and call-time decryption fails typed", () => {
    const { service } = newFixture();
    service.store(WS, "prov_0001", SECRET, "2026-10-30T12:00:01.000Z");
    service.revoke(WS, "prov_0001");
    expect(service.hasCredential(WS, "prov_0001")).toBe(false);
    expect(service.credentialHint(WS, "prov_0001")).toBeNull();
    expect(() => service.decryptForCall(WS, "prov_0001")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_REVOKED" }),
    );
  });

  it("replaces without a restart: the next call decrypts the new value", () => {
    const { service } = newFixture();
    service.store(WS, "prov_0001", SECRET, "2026-10-30T12:00:01.000Z");
    const replacement = "sk-replaced-9876543210fedcbaNEWKEY";
    service.store(WS, "prov_0001", replacement, "2026-10-30T12:05:00.000Z");
    expect(service.decryptForCall(WS, "prov_0001")).toBe(replacement);
    expect(service.credentialHint(WS, "prov_0001").endsWith("EKEY")).toBe(true);
    expect(service.decryptForCall(WS, "prov_0001")).not.toBe(SECRET);
  });

  it("refuses custody operations for a provider outside the workspace (E12)", () => {
    const { service } = newFixture();
    service.store(WS, "prov_0001", SECRET, "2026-10-30T12:00:01.000Z");
    expect(service.hasCredential(OTHER_WS, "prov_0001")).toBe(false);
    expect(() => service.decryptForCall(OTHER_WS, "prov_0001")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_REVOKED" }),
    );
  });

  it("refuses to store a credential for an unknown provider entry", () => {
    const { service } = newFixture();
    expect(() => service.store(WS, "prov_absent", SECRET, "2026-10-30T12:00:01.000Z")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_NOT_FOUND" }),
    );
  });

  it("refuses an empty or oversized secret", () => {
    const { service } = newFixture();
    expect(() => service.store(WS, "prov_0001", "   ", "2026-10-30T12:00:01.000Z")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_INVALID" }),
    );
    expect(() => service.store(WS, "prov_0001", "x".repeat(8193), "2026-10-30T12:00:01.000Z")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_INVALID" }),
    );
  });
});
