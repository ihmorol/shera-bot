/**
 * Secret redaction for the terminal live-view boundary (S18 chunk 1; PRD §16,
 * D22, D27, G3) — the layer that runs on every output chunk (and the recorded
 * command/workdir fields) BEFORE anything is persisted to terminal_events,
 * appended to the journal, or broadcast.
 *
 * The rule it enforces: secret-shaped values — env-style secret assignments,
 * bearer tokens, connection-string credentials, private key material — never
 * survive the boundary, while plain non-secret output stays readable. The
 * families are pinned by the chunk's automated tests, and the layer errs
 * toward OVER-redaction: a false positive loses display fidelity for one
 * chunk, a false negative leaks a credential (AC21).
 *
 * This module is the single redaction authority for the terminal boundary;
 * the recorder applies it before both writes (the same redaction therefore
 * covers the WS broadcast, which replays the committed journal rows), and
 * later slices (S26 execution tools) write through the same layer.
 */

/** The marker every redacted value is replaced with. */
export const SECRET_REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * PEM private key blocks (RSA/DSA/EC/OPENSSH/ENCRYPTED/...): the whole block
 * is the secret — key type headers included — so the entire span collapses.
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * Bearer tokens in the Authorization scheme shape (`Bearer <token>`). Runs
 * BEFORE the generic header redaction so a header line cannot consume the
 * scheme word and leave the token behind.
 */
const BEARER_TOKEN = /\b(bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi;

/** Any `Authorization: <value>` header (credentials may not be Bearer-shaped). */
const AUTHORIZATION_HEADER = /\b(authorization[ \t]*[:=][ \t]*)([^\s"']+)/gi;

/**
 * Connection-string userinfo credentials: `scheme://user:password@host...`.
 * The password collapses; the scheme, user, host, and query survive so the
 * panel still shows WHAT was connected to.
 */
const CONNECTION_STRING_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"&#]+):([^\s@/'"&#]+)@/gi;

/**
 * Secret-shaped key assignments: `KEY=value`, `key: value`, and the
 * bare-whitespace CLI shape (`user.token abc12345`), where the key CONTAINS a
 * secret-vocabulary word (password/passwd/pwd/secret/token/api key/access
 * key/private key/credential/cookie, case-insensitive — so API_KEY,
 * AWS_SECRET_ACCESS_KEY, DB_PASSWORD, client_secret all match). The key span
 * may carry JSON/YAML-style quotes (`"api_key": "..."` — quoted keys are
 * log-file reality, and leaving them readable would be a false negative), and
 * `cookie` is in the vocabulary because a `set-cookie:` header echoed into
 * terminal output is a cookie-value leak channel (AC4). Quoted and bare
 * values both collapse. The separator never spans lines, so a key at a line
 * end cannot swallow unrelated output on the next line.
 */
const SECRET_KEY_ASSIGNMENT =
  /(["'A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|credential|cookie)["'A-Za-z0-9_.-]*)([ \t]*[:=][ \t]*|[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s,&"']+)/gi;

/**
 * Redact every secret-shaped value in one chunk of output. Order matters:
 * private keys first (they span lines), then the Bearer scheme (before the
 * generic Authorization header could consume it), then header values,
 * connection-string credentials, and finally the key-assignment sweep.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PEM_PRIVATE_KEY, SECRET_REDACTION_PLACEHOLDER)
    .replace(BEARER_TOKEN, (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`)
    .replace(
      AUTHORIZATION_HEADER,
      (_match, prefix: string) => `${prefix}${SECRET_REDACTION_PLACEHOLDER}`,
    )
    .replace(
      CONNECTION_STRING_USERINFO,
      (_match, scheme: string, user: string) => `${scheme}${user}:${SECRET_REDACTION_PLACEHOLDER}@`,
    )
    .replace(
      SECRET_KEY_ASSIGNMENT,
      (_match, key: string, separator: string) =>
        `${key}${separator}${SECRET_REDACTION_PLACEHOLDER}`,
    );
}
