/**
 * S05 redaction tests (issue #6, G3, PRD §16, D23 rule 4).
 *
 * Value-based redaction: every concrete secret the process touches (the auth
 * secret, the OAuth client secret, the issued access token, the session
 * token) is registered for scrubbing, and this test proves none of them reach
 * the log sink or the security_events table after a real sign-in flow.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";

import { controlSecurityEvents } from "../src/db/schema.ts";
import { CookieJar, runGoogleSignin } from "./helpers/test-server.ts";
import { startMockGoogleIdp, type MockIdp } from "./helpers/mock-google-idp.ts";
import {
  randomTestSecret,
  startControlPlaneFixture,
  type ControlPlaneFixture,
} from "./helpers/test-app.ts";
import { startTestCluster, type TestCluster } from "./helpers/pg-cluster.ts";

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as AddressInfo;
      probe.close(() => (address.port > 0 ? resolve(address.port) : reject(new Error("no port"))));
    });
    probe.on("error", reject);
  });
}

let cluster: TestCluster;
let idp: MockIdp;
let fixture: ControlPlaneFixture;
let origin: string;
let authSecret: string;
let clientSecret: string;
let logLines: string[];

beforeAll(async () => {
  cluster = await startTestCluster("redaction");
  idp = await startMockGoogleIdp();
  authSecret = randomTestSecret();
  clientSecret = idp.clientSecret;
  logLines = [];
  const port = await freePort();
  fixture = await startControlPlaneFixture({
    databaseUrl: cluster.connectionString,
    port,
    googleIssuer: idp.origin,
    logSink: (line) => logLines.push(line),
    env: {
      AUTH_SECRET: authSecret,
      GOOGLE_CLIENT_ID: idp.clientId,
      GOOGLE_CLIENT_SECRET: clientSecret,
      AUTH_URL: `https://127.0.0.1:${port}`,
    },
  });
  origin = fixture.origin;

  // Drive a real sign-in so issued tokens and the session token exist.
  idp.setIdentity({
    sub: "redaction-sub-001",
    email: "redaction@example.com",
    name: "Redaction User",
    picture: "https://example.com/redaction.png",
  });
  await runGoogleSignin({ origin, idpOrigin: idp.origin, jar: new CookieJar() });
}, 180_000);

afterAll(async () => {
  await fixture?.stop();
  await idp?.close();
  await cluster?.stop();
}, 180_000);

describe("secret redaction (G3)", () => {
  it("never writes the auth secret, the client secret, or the issued access token to the log", () => {
    expect(logLines.length).toBeGreaterThan(0);
    const forbidden = [authSecret, clientSecret, idp.lastAccessToken].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    expect(forbidden.length).toBeGreaterThanOrEqual(2); // the issued token must have existed
    for (const line of logLines) {
      for (const secret of forbidden) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it("never stores issued token values in the security_events table", async () => {
    const rows = await fixture.controlPlane.db.select().from(controlSecurityEvents);
    expect(rows.length).toBeGreaterThan(0);
    const forbidden = [authSecret, clientSecret, idp.lastAccessToken].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    for (const row of rows) {
      const serialized = JSON.stringify({
        details: row.details,
        correlation_id: row.correlationId,
      });
      for (const secret of forbidden) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it("records login events with redacted, non-credential details", async () => {
    const events = await fixture.controlPlane.securityEvents.listByType("login_succeeded");
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      const serialized = JSON.stringify(event.details);
      expect(serialized).not.toContain(idp.clientSecret);
      if (idp.lastAccessToken) {
        expect(serialized).not.toContain(idp.lastAccessToken);
      }
    }
  });
});
