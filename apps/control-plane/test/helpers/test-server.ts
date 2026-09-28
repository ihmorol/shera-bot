/**
 * HTTPS test server + OAuth flow client for the S05 integration tests.
 *
 * HTTPS (self-signed openssl cert generated per run) so the Auth.js secure
 * cookies are exercised for real: the `__Secure-` prefix, the Secure flag,
 * HttpOnly, SameSite, and expiry are asserted against live Set-Cookie
 * headers. NODE_TLS_REJECT_UNAUTHORIZED=0 is set for this test process only.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:https";
import type { Express } from "express";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export interface TestServer {
  origin: string;
  close(): Promise<void>;
}

export async function startHttpsApp(app: Express): Promise<TestServer> {
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
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const p = typeof address === "object" && address ? address.port : 0;
      if (p > 0) resolve(p);
      else reject(new Error("no port"));
    });
    server.on("error", reject);
  });

  return {
    origin: `https://127.0.0.1:${port}`,
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

/** A cookie jar that accumulates Set-Cookie from fetch responses. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair] = line.split(";");
      if (pair === undefined) continue;
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        // Cleared cookies (empty value / past expiry) drop the name.
        if (value.length === 0) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }
}

export interface FlowResponse {
  status: number;
  location: string | null;
  headers: Headers;
  body: string;
  /** set-cookie lines as sent by the server. */
  setCookie: string[];
}

export async function request(
  origin: string,
  path: string,
  init: RequestInit & { jar?: CookieJar } = {},
): Promise<FlowResponse> {
  const { jar, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (jar) headers.set("cookie", jar.header());
  const response = await fetch(`${origin}${path}`, { ...rest, headers, redirect: "manual" });
  if (jar) jar.absorb(response);
  return {
    status: response.status,
    location: response.headers.get("location"),
    headers: response.headers,
    body: await response.text(),
    setCookie: response.headers.getSetCookie(),
  };
}

/**
 * Drive the full browser-equivalent OAuth flow against the real Express app:
 * csrf → signin/google → mock authorize → callback → session cookie.
 * Returns the final redirect target (the post-login landing URL).
 */
export async function runGoogleSignin(args: {
  origin: string;
  idpOrigin: string;
  jar: CookieJar;
  callbackUrl?: string;
}): Promise<{ finalRedirect: string; setCookie: string[] }> {
  const { origin, jar, callbackUrl = `${origin}/app` } = args;

  const csrf = await request(origin, "/api/auth/csrf", { jar });
  if (csrf.status !== 200) throw new Error(`csrf failed: ${csrf.status}`);
  const { csrfToken } = JSON.parse(csrf.body) as { csrfToken: string };

  const signin = await request(origin, "/api/auth/signin/google", {
    method: "POST",
    jar,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, callbackUrl }).toString(),
  });
  if (!signin.location) throw new Error(`signin did not redirect: ${signin.status} ${signin.body}`);
  const authorizeUrl = new URL(signin.location, origin).toString();
  if (!authorizeUrl.startsWith(args.idpOrigin)) {
    throw new Error(`signin redirected outside the IdP: ${authorizeUrl}`);
  }

  const authorize = await request(authorizeUrl, "", { jar, redirect: "manual" });
  if (!authorize.location) throw new Error("authorize did not redirect with a code");
  const callbackUrlFromIdp = new URL(authorize.location, args.idpOrigin).toString();

  const callback = await request(callbackUrlFromIdp, "", { jar, redirect: "manual" });
  if (!callback.location) {
    throw new Error(`callback did not redirect: ${callback.status} ${callback.body}`);
  }
  const finalRedirect = new URL(callback.location, origin).toString();
  return { finalRedirect, setCookie: callback.setCookie };
}
