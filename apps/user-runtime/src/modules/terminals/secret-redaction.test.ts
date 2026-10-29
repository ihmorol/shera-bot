/**
 * S18 chunk 1 secret redaction tests (PRD §16, D22, D27, G3): the redaction
 * layer that runs on EVERY output chunk (and the recorded command/workdir
 * fields) before anything is persisted to terminal_events or journalled.
 *
 * The pinned rule: secret-shaped values — env-style assignments, bearer
 * tokens, connection-string credentials, private key material — NEVER survive
 * the boundary, and plain non-secret output is left readable. Redaction errs
 * toward over-redaction: a false positive loses display fidelity, a false
 * negative leaks a credential (AC21).
 */
import { describe, expect, it } from "vitest";

import { SECRET_REDACTION_PLACEHOLDER, redactSecrets } from "./secret-redaction.ts";

const ENV_STYLE = "export API_KEY=sk-live-abc123def456";
const ENV_STYLE_JSON = 'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG"';
const BEARER =
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const CONNECTION_STRING = "postgres://app_user:s3cr3t-pw@db.internal:5432/shera?sslmode=require";
const PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/yGWy+X6wDUrNwmSrMm8CgLqkLdzXJyiBIQ==",
  "aqu9iirZZh6Vmorebase64materiallineQ9dV7EDFhN1nEKxmcQ==",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

/** Every secret value the tests pin; none may survive the boundary. */
const SECRET_VALUES = [
  "sk-live-abc123def456",
  "wJalrXUtnFEMI/K7MDENG",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  "s3cr3t-pw",
  "MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/yGWy+X6wDUrNwmSrMm8CgLqkLdzXJyiBIQ==",
];

describe("redactSecrets (S18 G3 boundary)", () => {
  it("redacts env-style secret assignments", () => {
    const redacted = redactSecrets(ENV_STYLE);
    expect(redacted).not.toContain("sk-live-abc123def456");
    expect(redacted).toContain("API_KEY=");
    expect(redacted).toContain(SECRET_REDACTION_PLACEHOLDER);
  });

  it("redacts quoted secret assignments (JSON-style output)", () => {
    const redacted = redactSecrets(ENV_STYLE_JSON);
    expect(redacted).not.toContain("wJalrXUtnFEMI/K7MDENG");
    expect(redacted).toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("redacts bearer tokens and Authorization header values", () => {
    const redacted = redactSecrets(BEARER);
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).toContain("Authorization:");
  });

  it("redacts connection-string credentials but keeps the rest of the URL", () => {
    const redacted = redactSecrets(CONNECTION_STRING);
    expect(redacted).not.toContain("s3cr3t-pw");
    expect(redacted).toContain("postgres://app_user:");
    expect(redacted).toContain("@db.internal:5432/shera?sslmode=require");
  });

  it("redacts whole private key blocks", () => {
    const redacted = redactSecrets(`generated:\n${PRIVATE_KEY}\ndone`);
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn");
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).toContain("generated:");
    expect(redacted).toContain("done");
  });

  it("redacts every pinned secret family inside one mixed chunk", () => {
    const mixed = [ENV_STYLE, BEARER, CONNECTION_STRING, PRIVATE_KEY].join("\n");
    const redacted = redactSecrets(mixed);
    for (const secret of SECRET_VALUES) {
      expect(redacted).not.toContain(secret);
    }
  });

  it("redacts key=value pairs whose key merely CONTAINS a secret vocabulary word", () => {
    const redacted = redactSecrets("git config user.token abc12345 && npm run build");
    expect(redacted).not.toContain("abc12345");
    expect(redacted).toContain("npm run build");
  });

  it("redacts JSON-style QUOTED keys (review round: the log-file reality)", () => {
    const redacted = redactSecrets('{"api_key": "abc12345xyz", "user": "bob"}');
    expect(redacted).not.toContain("abc12345xyz");
    expect(redacted).toContain('"api_key"');
    expect(redacted).toContain('"user": "bob"');
    // The tight, space-free JSON spelling redacts too.
    const tight = redactSecrets('{"token":"value123"}');
    expect(tight).not.toContain("value123");
    expect(redactSecrets(redacted)).toBe(redacted);
  });

  it("redacts echoed set-cookie headers (review round: cookie is a secret family, AC4)", () => {
    const redacted = redactSecrets("set-cookie: shera_session=4a9d7f2b1c8e; Path=/");
    expect(redacted).not.toContain("4a9d7f2b1c8e");
    expect(redacted).toContain("set-cookie:");
  });

  it("leaves plain non-secret output readable", () => {
    const plain = [
      "vite v5.4.11 building for production...",
      "PATH=/usr/local/bin:/usr/bin",
      "✓ 42 modules transformed.",
      "npm run build completed in 3.2s",
      "const total = 42;",
    ].join("\n");
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("is idempotent on already-redacted text", () => {
    const once = redactSecrets(ENV_STYLE);
    expect(redactSecrets(once)).toBe(once);
  });

  it("returns non-string-safe input unchanged in shape (empty text)", () => {
    expect(redactSecrets("")).toBe("");
  });
});
