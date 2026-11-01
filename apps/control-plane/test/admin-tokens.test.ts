/**
 * S32 admin token lifecycle tests (issue #33, AC5) — the owner-held operator
 * credential:
 *
 * - creation stores ONLY the SHA-256 digest (hash-only storage, G3); the raw
 *   token is returned exactly once at creation and never again;
 * - verification rejects missing/unknown tokens and records each rejection as
 *   a security event (AC2's control-plane leg);
 * - rotation invalidates the previous token immediately (AC5);
 * - the token value never appears in a log line or event detail (the
 *   redaction leg of AC5) — every emission is scanned.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createControlPlaneApp, type ControlPlaneApp } from "../src/index.ts";
import { controlAdminTokens } from "../src/db/schema.ts";
import { AdminTokenService } from "../src/modules/admin-tokens.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";
import { request, startHttpsApp, type TestServer } from "./helpers/test-server.ts";

let cluster: TestCluster;
let controlPlane: ControlPlaneApp;
let tokens: AdminTokenService;
let server: TestServer;
const logLines: string[] = [];

beforeAll(async () => {
  cluster = await startTestCluster("admin-tokens");
  controlPlane = await createControlPlaneApp({
    databaseUrl: cluster.connectionString,
    env: {},
    logSink: (line) => logLines.push(line),
  });
  tokens = new AdminTokenService({
    db: controlPlane.db,
    registry: controlPlane.registry,
    securityEvents: controlPlane.securityEvents,
  });
  server = await startHttpsApp(controlPlane.app);
}, 180_000);

afterAll(async () => {
  await server?.close();
  await controlPlane?.close();
  await cluster?.stop();
}, 180_000);

/** Every emitted log line must be free of the given secret value. */
function assertNoSecretLeak(secret: string, where: string): void {
  for (const line of logLines) {
    expect(line, `log line leaked the ${where} token`).not.toContain(secret);
  }
}

describe("admin token lifecycle (AC5)", () => {
  it("creates a token, stores only its digest, and displays the raw value exactly once", async () => {
    const created = await tokens.create({ createdBy: "cli" });

    // The raw token is returned once, is a real credential-shaped value, and
    // is NOT stored anywhere readable (G3).
    expect(created.token).toMatch(/^shera_admin_[A-Za-z0-9_-]{43,}$/);
    expect(created.tokenId).toMatch(/[0-9a-f-]{36}/);

    const rows = await controlPlane.db
      .select()
      .from(controlAdminTokens)
      .where(eq(controlAdminTokens.id, created.tokenId));
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenSha256).not.toBe(created.token);
    // The hint identifies the token without being token material: it is a
    // prefix of the DIGEST, never of the secret itself.
    expect(row?.tokenDigestHint).toBe(row?.tokenSha256.slice(0, 12));
    expect(JSON.stringify(row)).not.toContain(created.token);
    assertNoSecretLeak(created.token, "created");
  });

  it("verifies the active token and refuses missing/unknown values with recorded reasons", async () => {
    const created = await tokens.create({ createdBy: "cli" });

    expect((await tokens.verify(created.token)).ok).toBe(true);

    const missing = await tokens.verify(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("missing_token");

    const wrongToken = "shera_admin_wrongwrongwrongwrongwrongwrongwron";
    const wrong = await tokens.verify(wrongToken);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("unknown_token");

    // Both rejections are security events (AC2's recorded-rejection rule).
    const events = await controlPlane.securityEvents.listByType("admin_auth_rejected");
    const reasons = events.map((event) => event.details["reason"]);
    expect(reasons).toContain("missing_token");
    expect(reasons).toContain("unknown_token");
    // The presented wrong value is never recorded (G3).
    for (const event of events) {
      expect(JSON.stringify(event.details)).not.toContain("wrongwrongwrong");
    }
    assertNoSecretLeak(created.token, "verified");
  });

  it("rotates: the previous token stops verifying immediately and the event records the rotation", async () => {
    const first = await tokens.create({ createdBy: "cli" });
    expect((await tokens.verify(first.token)).ok).toBe(true);

    const rotated = await tokens.rotate({ rotatedBy: "cli", previousTokenId: first.tokenId });
    expect(rotated.token).not.toEqual(first.token);
    expect((await tokens.verify(first.token)).ok).toBe(false);
    expect((await tokens.verify(rotated.token)).ok).toBe(true);

    const events = await controlPlane.securityEvents.listByType("admin_token_rotated");
    const latest = events[events.length - 1];
    expect(latest?.details["previous_token_id"]).toBe(first.tokenId);
    expect(JSON.stringify(events)).not.toContain(first.token);
    assertNoSecretLeak(first.token, "rotated-from");
    assertNoSecretLeak(rotated.token, "rotated-to");
  });

  it("a created token replaces any previous one (the lost-token recovery is a rotation)", async () => {
    const first = await tokens.create({ createdBy: "cli" });
    const second = await tokens.create({ createdBy: "cli" });
    expect((await tokens.verify(first.token)).ok).toBe(false);
    expect((await tokens.verify(second.token)).ok).toBe(true);
  });

  it("exactly one token is active at a time", async () => {
    await tokens.create({ createdBy: "cli" });
    const active = await tokens.activeToken();
    expect(active).not.toBeNull();
    expect(active?.revokedAt).toBeNull();
  });
});

describe("admin API gate (AC2, control-plane leg)", () => {
  it("answers typed 401 without a token, with a wrong token, and on a malformed header", async () => {
    const noToken = await request(server.origin, "/api/admin/users");
    expect(noToken.status).toBe(401);
    expect(noToken.body).toContain("ADMIN_UNAUTHENTICATED");
    expect(noToken.body).not.toMatch(/shera_admin_/);

    const wrong = await request(server.origin, "/api/admin/users", {
      headers: { authorization: "Bearer shera_admin_wrongwrongwrongwrongwrongwrongwron" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toContain("ADMIN_UNAUTHENTICATED");

    const malformed = await request(server.origin, "/api/admin/users", {
      headers: { authorization: "shera_admin_notscheme" },
    });
    expect(malformed.status).toBe(401);
    expect(malformed.body).toContain("ADMIN_UNAUTHENTICATED");

    const events = await controlPlane.securityEvents.listByType("admin_auth_rejected");
    expect(events.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the active-token invariant (review P2)", () => {
  it("two active admin tokens are unrepresentable (the partial unique index)", async () => {
    await tokens.create({ createdBy: "test" });
    // The direct-insert probe: a second ACTIVE row must be refused by the
    // schema itself, not by application discipline.
    let smuggled: { id: string } | undefined;
    try {
      const inserted = await controlPlane.db
        .insert(controlAdminTokens)
        .values({
          tokenSha256: "f".repeat(64),
          tokenDigestHint: "ffffffffffff",
          createdBy: "test",
        })
        .returning({ id: controlAdminTokens.id });
      smuggled = inserted[0];
    } catch {
      // The invariant held at the schema level.
    }
    expect(smuggled).toBeUndefined();
    if (smuggled) {
      // Red-run hygiene: leave the table with at most one active row.
      await controlPlane.db.delete(controlAdminTokens).where(eq(controlAdminTokens.id, smuggled.id));
    }
  });

  it("concurrent rotates leave exactly one active token (one wins, one typed-refused)", async () => {
    const results = await Promise.allSettled([
      tokens.rotate({ rotatedBy: "concurrent-a" }),
      tokens.rotate({ rotatedBy: "concurrent-b" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const actives = await controlPlane.db
      .select({ id: controlAdminTokens.id })
      .from(controlAdminTokens);
    const activeRows = [];
    for (const row of actives) {
      const full = await controlPlane.db
        .select()
        .from(controlAdminTokens)
        .where(eq(controlAdminTokens.id, row.id));
      if (full[0] && full[0].revokedAt === null) activeRows.push(full[0]);
    }
    expect(activeRows).toHaveLength(1);
  });

  it("an unauthenticated flood of unknown tokens cannot evict the real secret from the registry", async () => {
    const created = await tokens.create({ createdBy: "test" });
    for (let i = 0; i < 600; i += 1) {
      await tokens.verify(`shera_admin_junk_${i}_${"x".repeat(43)}`);
    }
    // The owner's real token must STILL scrub: attacker-controlled verify()
    // values must never take up the shared registry's bounded slots (review
    // P2 — after 512 junk registrations the FIFO would evict the real
    // secrets and a later log could render them verbatim).
    const scrubbed = controlPlane.registry.scrubString(created.token);
    expect(scrubbed).not.toContain(created.token);
  });
});
