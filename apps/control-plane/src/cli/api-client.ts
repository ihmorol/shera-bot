/**
 * The admin CLI's API client (S32, issue #33). Every operational command is
 * an authenticated call to the control plane's admin API.
 *
 * Token handling (G3): the token comes from SHERA_ADMIN_TOKEN or
 * --token-file — NEVER from an argv flag (argv is visible in ps and shell
 * history). The value is read, used in the Authorization header, and never
 * printed, echoed in errors, or included in any output. The typed SheraError
 * body is the only failure surface.
 */
import { readFileSync } from "node:fs";

import type { CliEnv, CliIo } from "./io.ts";
import { CLI_EXIT_API_ERROR, CLI_EXIT_USAGE } from "./io.ts";

export interface AdminApiClient {
  request(args: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
  }): Promise<{ ok: true; body: unknown } | { ok: false; exit: number }>;
}

interface SheraErrorShape {
  code?: unknown;
  safe_message?: unknown;
}

export function resolveToken(args: {
  env: CliEnv;
  tokenFile?: string | undefined;
  io: CliIo;
}): string | null {
  if (args.tokenFile !== undefined) {
    try {
      const raw = readFileSync(args.tokenFile, "utf8").trim();
      if (raw.length > 0) return raw;
    } catch {
      args.io.err(`error: the token file could not be read: ${args.tokenFile}`);
      return null;
    }
  }
  const fromEnv = args.env.SHERA_ADMIN_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  args.io.err(
    "error: no admin token. Set SHERA_ADMIN_TOKEN or pass --token-file <path> (never a command-line flag — argv is world-readable).",
  );
  return null;
}

export function createAdminApiClient(args: {
  baseUrl: string;
  token: string;
  io: CliIo;
}): AdminApiClient {
  const base = args.baseUrl.replace(/\/$/, "");
  return {
    async request({ method, path, body }) {
      let response: Response;
      try {
        response = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${args.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        args.io.err(
          `error: the control plane did not answer: ${error instanceof Error ? error.name : "error"}`,
        );
        return { ok: false, exit: CLI_EXIT_API_ERROR };
      }
      const text = await response.text();
      if (!response.ok) {
        // The typed error body is the failure surface. The presented token is
        // NEVER part of any message (G3 — the redaction test pins it).
        let code = `HTTP_${response.status}`;
        let message = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as SheraErrorShape;
          if (typeof parsed.code === "string") code = parsed.code;
          if (typeof parsed.safe_message === "string") message = parsed.safe_message;
        } catch {
          // Non-JSON body: the bounded prefix is the honest fallback.
        }
        args.io.err(`error: ${code}: ${message}`);
        return { ok: false, exit: CLI_EXIT_API_ERROR };
      }
      let parsedBody: unknown = null;
      if (text.length > 0) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      }
      return { ok: true, body: parsedBody };
    },
  };
}

export function usageError(io: CliIo, message: string): { ok: false; exit: number } {
  io.err(`error: ${message}`);
  return { ok: false, exit: CLI_EXIT_USAGE };
}

/**
 * The plaintext-origin guard (review P3): the admin token is a bearer
 * credential — shipping it over cleartext http to a non-loopback host is a
 * credential disclosure. Returns the refusal message for a non-https
 * origin, or null when the origin is acceptable (https, or loopback http
 * for local development).
 */
export function httpsRefusal(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return `the control plane origin is not a valid URL: ${baseUrl}`;
  }
  if (parsed.protocol === "https:") return null;
  const host = parsed.hostname;
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  if (loopback) return null;
  return (
    `refusing plaintext http for a non-loopback control plane (${host}): ` +
    "the admin token would cross the network in cleartext. Use https " +
    "(the production control plane presents a CA-trusted certificate) or " +
    "http on loopback for local development."
  );
}
