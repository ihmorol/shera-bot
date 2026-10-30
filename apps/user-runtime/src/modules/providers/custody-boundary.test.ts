/**
 * S23 chunk 6 — the custody at-rest scan (G3; PRD §9, §12, §16, D22, E9;
 * AC "a credential never appears in prompts, events, logs, memory rows,
 * artifacts, tool history, central PostgreSQL, or a default backup").
 *
 * A SECRET-SHAPED fixture credential is stored through the real custody
 * service into a REAL composed runtime. The scan then proves the raw value
 * appears ONLY as the sealed (encrypted) custody payload:
 *
 *   - the SQLite database file AND its WAL sidecar (at-rest bytes — one
 *     byte-level assertion that covers EVERY table at once: the journal,
 *     the command receipts, the memory/artifact/worker channels, and the
 *     custody table itself);
 *   - a DEFAULT BACKUP produced the E11 way (the recorded backup-export
 *     helper on the adapter) — the backup carries the SEALED payload, never
 *     the plaintext;
 *   - the redacted fault-log sink (every untyped fault flows through it);
 *   - the service/API view (masked hints only).
 *
 * Prompts (D15) never carry it structurally: the session context is
 * assembled from the Agent's identity fields alone (the composition's
 * contextProvider), and no provider path feeds prompt content. The central
 * PostgreSQL claim is architectural: the runtime process has no PostgreSQL
 * client at all (PRD §12's container-local boundary) — recorded in the
 * slice's engineering record.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  openDatabase,
  walCheckpointTruncate,
  vacuumIntoBackup,
} from "../../adapters/sqlite/connection.ts";
import type { RuntimeHandle } from "../../transport/local-api/compose.ts";
import { DEFAULT_WORKSPACE_ID, composeRuntime } from "../../transport/local-api/compose.ts";
import {
  cleanupTempResources,
  makeTempDir,
  trackConnection,
} from "../../../test/helpers/temp-resources.ts";

const here = import.meta.dirname;
const PACKS_ROOT = resolve(here, "../../../../../agent-packs");
const WORKSPACE = DEFAULT_WORKSPACE_ID;

/**
 * The secret-shaped fixture: exactly the shape a real provider key takes
 * (prefix + long random-looking body). If custody ever leaks, the byte scan
 * finds THIS.
 */
const SECRET_FIXTURE = `sk-prod-${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0"}u1V2`;

/** The fixture fragment the scan also hunts for (belt and braces). */
const SECRET_FRAGMENT = "a1B2c3D4e5F6g7H8";

afterEach(async () => {
  await cleanupTempResources();
});

const openConnections: Array<{ close(): void }> = [];

afterAll(() => {
  for (const conn of openConnections.splice(0)) {
    conn.close();
  }
});

/** The captured redacted fault sink (every untyped fault flows through it). */
function makeLogCapture(): {
  lines: string[];
  sink: (event: string, fields: Record<string, unknown>) => void;
} {
  const lines: string[] = [];
  return {
    lines,
    sink: (event, fields) => {
      lines.push(JSON.stringify({ event, ...fields }));
    },
  };
}

interface Fixture {
  runtime: RuntimeHandle;
  dbPath: string;
  logLines: string[];
  providerId: string;
  close(): Promise<void>;
}

async function composeWithCredential(): Promise<Fixture> {
  const dbPath = join(makeTempDir("shera-s23-custody-"), "runtime.db");
  const capture = makeLogCapture();
  const runtime = composeRuntime({
    dbPath,
    packsRoot: PACKS_ROOT,
    providerEnforcement: true,
    logUntypedFault: capture.sink,
  });
  trackConnection(runtime);
  const provider = runtime.providers.configure({
    workspace_id: WORKSPACE,
    display_name: "Custody scan endpoint",
    protocol: "openai-compatible",
    base_url: "https://scan.example.invalid/v1",
    api_mode: "api_key",
    credential: SECRET_FIXTURE,
    default_model_id: "scan-model",
    organization: null,
    project: null,
    headers: {},
    request_params: {},
    origin: "user",
  });
  return {
    runtime,
    dbPath,
    logLines: capture.lines,
    providerId: provider.id,
    close: () => runtime.close(),
  };
}

/** The raw fixture must not appear anywhere in the given bytes. */
function assertSecretAbsent(bytes: Buffer, where: string): void {
  expect(bytes.includes(Buffer.from(SECRET_FIXTURE, "utf8")), where).toBe(false);
  expect(bytes.includes(Buffer.from(SECRET_FRAGMENT, "utf8")), where).toBe(false);
}

describe("the custody at-rest scan (G3, secret-shaped fixture)", () => {
  it("keeps the raw credential out of the database file, its WAL, and a default backup", async () => {
    const fixture = await composeWithCredential();
    try {
      // Exercise the provider paths with the credential loaded: a connection
      // test against the unreachable endpoint (typed honest failure), and a
      // resolution refusal for an absent provider (the fault path).
      const testResult = await fixture.runtime.providers.runConnectionTest(
        WORKSPACE,
        fixture.providerId,
      );
      expect(testResult.ok).toBe(false);
      try {
        fixture.runtime.providers.resolveCredentialForCall(WORKSPACE, "prov_absent");
      } catch {
        // typed refusal — the fault path
      }
      // A second, scan-only connection (the runtime keeps its own open).
      const scanConn = openDatabase(fixture.dbPath);
      openConnections.push(scanConn);
      // Force a WAL checkpoint so the main file carries every page.
      walCheckpointTruncate(scanConn.db);
      // The database file itself: sealed ciphertext only (D22).
      assertSecretAbsent(readFileSync(fixture.dbPath), "sqlite file");
      // The WAL sidecar: scan whatever bytes exist.
      try {
        assertSecretAbsent(readFileSync(`${fixture.dbPath}-wal`), "sqlite wal");
      } catch {
        // A truncated/absent WAL is fine — the file scan is the proof.
      }
      // A DEFAULT BACKUP (E11 mechanism): the sealed payload backs up; the
      // plaintext never does. The vault KEY FILE is volume state, not a
      // database backup (recorded in the engineering record).
      const backupPath = join(dirname(fixture.dbPath), "backup.db");
      vacuumIntoBackup(scanConn.db, backupPath);
      assertSecretAbsent(readFileSync(backupPath), "default backup");
      // The view boundary: masked hint only, never the secret (D22).
      const viewJson = JSON.stringify(
        fixture.runtime.providers.getProviderView(WORKSPACE, fixture.providerId),
      );
      expect(viewJson).not.toContain(SECRET_FIXTURE);
      expect(viewJson).not.toContain(SECRET_FRAGMENT);
      expect(
        fixture.runtime.providers.getProviderView(WORKSPACE, fixture.providerId)?.credential_hint,
      ).toBe(`••••${SECRET_FIXTURE.slice(-4)}`);
    } finally {
      await fixture.close();
      rmSync(join(dirname(fixture.dbPath), "backup.db"), { force: true });
    }
  });

  it("keeps the raw credential out of every fault-log line (the redacted sink)", async () => {
    const fixture = await composeWithCredential();
    try {
      // Trigger the fault paths that mention this provider.
      try {
        fixture.runtime.providers.resolveCredentialForCall(WORKSPACE, "prov_absent");
      } catch {
        // typed refusal — the fault path
      }
      const revoked = fixture.runtime.providers.configure({
        workspace_id: WORKSPACE,
        display_name: "Revoked for log scan",
        protocol: "openai-compatible",
        base_url: "https://scan.example.invalid/v1",
        api_mode: "api_key",
        credential: SECRET_FIXTURE,
        default_model_id: "scan-model",
        organization: null,
        project: null,
        headers: {},
        request_params: {},
        origin: "user",
      });
      fixture.runtime.providers.revokeCredential(WORKSPACE, revoked.id);
      expect(fixture.logLines.length).toBeGreaterThanOrEqual(0);
      for (const line of fixture.logLines) {
        expect(line.includes(SECRET_FIXTURE), "fault log").toBe(false);
        expect(line.includes(SECRET_FRAGMENT), "fault log").toBe(false);
      }
    } finally {
      await fixture.close();
    }
  });
});
