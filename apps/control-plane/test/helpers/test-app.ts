/**
 * Control-plane test fixture: real Express app + real PostgreSQL cluster +
 * HTTPS listener (self-signed cert) so the full Auth.js flow — cookies,
 * redirects, secure flags — runs end-to-end in-process. No Docker: the
 * cluster helper drives the installed PostgreSQL 16 binaries (see pg-cluster).
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:https";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Express } from "express";

import type { RuntimeBackend } from "@shera-bot/contracts";

import { createControlPlaneApp, type ControlPlaneApp } from "../../src/index.ts";

export interface ControlPlaneFixture {
  controlPlane: ControlPlaneApp;
  origin: string;
  stop(): Promise<void>;
}

/** Generate a throwaway self-signed cert and serve the app over HTTPS. */
async function listenHttps(app: Express, port: number): Promise<{ close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "shera-cp-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    { stdio: "pipe" },
  );
  const server: Server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    app,
  );
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });
  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } finally {
            if (error) reject(error);
            else resolve();
          }
        });
      }),
  };
}

export interface FixtureOptions {
  databaseUrl: string;
  /** TEST SEAM: Google provider issuer override (mock IdP origin). */
  googleIssuer?: string;
  /** Extra/overriding environment references (GOOGLE_CLIENT_ID etc.). */
  env?: Record<string, string>;
  logSink?: (line: string) => void;
  port?: number;
  /** TEST SEAM: deterministic RuntimeBackend (S06); defaults to the real local backend. */
  runtimeBackend?: RuntimeBackend;
}

export async function startControlPlaneFixture(
  options: FixtureOptions,
): Promise<ControlPlaneFixture> {
  const controlPlane = await createControlPlaneApp({
    databaseUrl: options.databaseUrl,
    ...(options.googleIssuer ? { googleIssuer: options.googleIssuer } : {}),
    ...(options.logSink ? { logSink: options.logSink } : {}),
    ...(options.runtimeBackend ? { runtimeBackend: options.runtimeBackend } : {}),
    env: {
      ...process.env,
      ...options.env,
    },
  });
  const port = options.port ?? 0;
  // AUTH_URL must match the listener origin; when the caller does not pin the
  // port we read it back off the server address and rebuild the env once.
  if (options.port === undefined) {
    await controlPlane.close();
    throw new Error("fixture requires an explicit port so AUTH_URL matches the origin");
  }
  const https = await listenHttps(controlPlane.app, port);
  return {
    controlPlane,
    origin: `https://127.0.0.1:${port}`,
    async stop() {
      await https.close();
      await controlPlane.close();
    },
  };
}

/** Random per-run credential reference values (G3: never committed literals). */
export function randomTestSecret(): string {
  return randomBytes(32).toString("hex");
}

export { existsSync };
