/**
 * In-process mock Google OIDC IdP for the S05 OAuth flow tests.
 *
 * The REAL Google provider from @auth/core is pointed at this server via the
 * documented factory test seam (`googleIssuer`): discovery, the authorization
 * code + PKCE flow, RS256 id_token validation against this JWKS, and the
 * token exchange all run through Auth.js core exactly as with Google — only
 * the issuer endpoints differ. This exists because real-Google E2E needs the
 * owner's credentials (documented as an owner item; G4: never faked).
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export interface MockIdp {
  /** http://127.0.0.1:<port> — pass as the Google provider `issuer` override. */
  readonly origin: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Identity the next authorization code will resolve to. */
  setIdentity(identity: MockIdentity): void;
  /** Number of successful token exchanges (assertion seam). */
  readonly tokenExchanges: number;
  /** The most recent access token value (redaction-assertion seam; test only). */
  readonly lastAccessToken: string | undefined;
  close(): Promise<void>;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface IdpState {
  origin: string;
  clientId: string;
  clientSecret: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  publicKeyJwk: Record<string, unknown>;
  identity: MockIdentity;
  tokenExchanges: number;
  lastAccessToken: string | undefined;
}

export async function startMockGoogleIdp(): Promise<MockIdp> {
  const state: IdpState = {
    origin: "pending",
    clientId: randomBytes(16).toString("hex"),
    clientSecret: randomBytes(24).toString("hex"),
    privateKey: undefined as never,
    publicKeyJwk: {},
    identity: {
      sub: "google-sub-default",
      email: "default@example.com",
      name: "Default User",
      picture: "https://example.com/avatar.png",
    },
    tokenExchanges: 0,
    lastAccessToken: undefined,
  };

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  state.privateKey = privateKey;
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  state.publicKeyJwk = { ...jwk, kid: randomBytes(8).toString("hex"), alg: "RS256", use: "sig" };

  const server = createServer((req, res) => {
    handle(req, res, state).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const p = typeof address === "object" && address ? address.port : 0;
      if (p > 0) resolve(p);
      else reject(new Error("no port"));
    });
    server.on("error", reject);
  });
  state.origin = `http://127.0.0.1:${port}`;

  return {
    origin: state.origin,
    clientId: state.clientId,
    clientSecret: state.clientSecret,
    get tokenExchanges() {
      return state.tokenExchanges;
    },
    get lastAccessToken() {
      return state.lastAccessToken;
    },
    setIdentity(identity: MockIdentity) {
      state.identity = identity;
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, state: IdpState): Promise<void> {
  const url = new URL(req.url ?? "/", state.origin);
  switch (url.pathname) {
    case "/.well-known/openid-configuration": {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          issuer: state.origin,
          authorization_endpoint: `${state.origin}/authorize`,
          token_endpoint: `${state.origin}/token`,
          userinfo_endpoint: `${state.origin}/userinfo`,
          jwks_uri: `${state.origin}/jwks.json`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "email", "profile"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          claims_supported: ["sub", "email", "email_verified", "name", "picture"],
        }),
      );
      return;
    }
    case "/authorize": {
      // Real OAuth2 authorization request shape → consent is automatic; the
      // code carries the identity selected by the test.
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const givenState = url.searchParams.get("state") ?? "";
      const payload = b64url(JSON.stringify(state.identity));
      const code = `${payload}.${randomBytes(12).toString("hex")}`;
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", givenState);
      res.statusCode = 302;
      res.setHeader("location", target.toString());
      res.end();
      return;
    }
    case "/token": {
      await handleToken(req, res, state);
      return;
    }
    case "/jwks.json": {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [state.publicKeyJwk] }));
      return;
    }
    default: {
      res.statusCode = 404;
      res.end("not found");
    }
  }
}

async function handleToken(
  req: IncomingMessage,
  res: ServerResponse,
  state: IdpState,
): Promise<void> {
  let body = "";
  for await (const chunk of req) body += String(chunk);
  const form = new URLSearchParams(body);

  // Client authentication (Basic, with a form fallback).
  let clientId = form.get("client_id") ?? "";
  let clientSecret = form.get("client_secret") ?? "";
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    clientId = decodeURIComponent(decoded.slice(0, colon));
    clientSecret = decodeURIComponent(decoded.slice(colon + 1));
  }
  if (clientId !== state.clientId || clientSecret !== state.clientSecret) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "invalid_client" }));
    return;
  }

  const code = form.get("code") ?? "";
  const payload = Buffer.from(code.split(".")[0] ?? "", "base64url").toString("utf8");
  const identity = JSON.parse(payload) as MockIdentity;

  const idToken = signIdToken(state, identity);
  state.tokenExchanges += 1;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      access_token: (() => {
        state.lastAccessToken = `at_${randomBytes(24).toString("hex")}`;
        return state.lastAccessToken;
      })(),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: `rt_${randomBytes(24).toString("hex")}`,
      scope: "openid email profile",
      id_token: idToken,
    }),
  );
}

function signIdToken(state: IdpState, identity: MockIdentity): string {
  const header = { alg: "RS256", typ: "JWT", kid: state.publicKeyJwk.kid };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: state.origin,
    sub: identity.sub,
    aud: state.clientId,
    azp: state.clientId,
    exp: now + 3600,
    iat: now,
    email: identity.email,
    email_verified: true,
    name: identity.name,
    picture: identity.picture,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), state.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}
