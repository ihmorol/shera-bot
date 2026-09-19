/**
 * S05 schema-scope and migration tests (issue #6, D2/D24).
 *
 * PRD §12: the central database stores ONLY control-plane records. This test
 * introspects the migrated database and asserts the EXACT table set — any new
 * table (a conversation, a task, a memory, a provider key) fails here. The
 * migrations apply from an empty database (every fixture does this; this file
 * asserts it explicitly) and the committed migration journal is verified.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAccounts } from "../src/db/schema.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";

const EXPECTED_PUBLIC_TABLES = [
  "control_accounts",
  "control_oauth_accounts",
  "control_sessions",
  "control_container_mappings",
  "control_backups",
  "control_security_events",
].sort();

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;

beforeAll(async () => {
  cluster = await startTestCluster("schema");
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
  });
}, 180_000);

afterAll(async () => {
  await controlPlane?.close();
  await cluster?.stop();
}, 180_000);

describe("control-plane schema scope (D2, PRD §12)", () => {
  it("migrations apply from an empty database and record in the journal", async () => {
    const journal = await controlPlane.db.execute(
      sql`select count(*)::int as count from drizzle.__drizzle_migrations`,
    );
    const rows = journal.rows as Array<{ count: number }>;
    expect(rows[0]?.count).toBeGreaterThanOrEqual(2);
  });

  it("contains exactly the control-plane tables — nothing else", async () => {
    const result = await controlPlane.db.execute(
      sql`select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const tables = (result.rows as Array<{ table_name: string }>)
      .map((row) => row.table_name)
      .sort();
    expect(tables).toEqual(EXPECTED_PUBLIC_TABLES);
  });

  it("never stores product-state-shaped records (conversations, tasks, memories, provider keys)", () => {
    for (const forbidden of [
      "conversation",
      "task",
      "memor",
      "provider_key",
      "artifact",
      "message",
    ]) {
      for (const table of EXPECTED_PUBLIC_TABLES) {
        expect(table).not.toContain(forbidden);
      }
    }
  });

  it("installs the admin-flag audit trigger (PRD §15: manual flag, DB-level audit)", async () => {
    const result = await controlPlane.db.execute(
      sql`select tgname from pg_trigger
          where tgrelid = 'control_accounts'::regclass and not tgisinternal`,
    );
    const triggers = (result.rows as Array<{ tgname: string }>).map((row) => row.tgname);
    expect(triggers).toContain("control_accounts_admin_flag_audit");
  });

  it("records an admin_flag_changed security event when the flag changes via direct SQL", async () => {
    const [account] = await controlPlane.db
      .insert(controlAccounts)
      .values({
        name: "Admin Candidate",
        email: "admin-candidate@example.com",
      })
      .returning();
    if (!account) throw new Error("insert failed");

    // The only legitimate write path for the flag: operator SQL (D47's admin
    // API/CLI arrives later; there is deliberately no HTTP route for this).
    await controlPlane.db.execute(
      sql`update control_accounts set is_admin = true where id = ${account.id}`,
    );

    const events = await controlPlane.securityEvents.listByType("admin_flag_changed");
    const ours = events.find((event) => event.details["account_id"] === account.id);
    expect(ours).toBeDefined();
  });
});
