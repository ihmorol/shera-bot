/**
 * The memory write-time secret scanner (S29 chunk 2; issue #30 AC2; PRD §11,
 * D22/E9, G3) — the boundary that keeps memory from ever becoming a secret
 * store. Every memory write (user command AND runtime-mediated automatic
 * candidate) is scanned BEFORE anything is persisted; a rejection means no
 * row, no version, no event, no byte on disk.
 *
 * Three layers, erring toward OVER-rejection (a false positive loses one
 * memory note; a false negative leaks a credential — AC21's recorded
 * asymmetry):
 *
 * 1. secretlint (github.com/secretlint/secretlint — MIT; embedded, not
 *    reimplemented): @secretlint/core 13.1.0 driving the
 *    secretlint-rule-preset-recommend 13.1.0 scanner rules (AWS, GCP,
 *    privatekey, GitHub, basic-auth, OpenAI, Anthropic, connection strings,
 *    and the rest of the recommended set). Rule ids become the rejection
 *    classes; the matched secret TEXT is never carried out (G3).
 * 2. The recorded redaction vocabulary (S18's secret-redaction.ts — the
 *    key-assignment sweep, quoted values, the S25 CSV-doubled-quote
 *    extension, PEM blocks, bearer tokens, Authorization headers,
 *    connection-string userinfo) re-expressed as DETECTORS: the same
 *    families the terminal boundary collapses, the memory boundary refuses.
 *    Attribution: the patterns are the recorded S18/S25/S26 vocabulary,
 *    deliberately reused rather than reinvented.
 * 3. An entropy pass over remaining standalone literals: a long mixed-charset
 *    token with high Shannon entropy (base64/hex credential shapes) is
 *    rejected even when no key name names it. Scoped tightly (>= 32 chars,
 *    mixed classes, entropy >= 4.2) so hashes, ids, and ordinary prose never
 *    trip it.
 */

import { lintSource } from "@secretlint/core";
import { rules as secretlintRules } from "@secretlint/secretlint-rule-preset-recommend";

/** The preset's scanner rules, bound once at module load (no per-call setup).
 * The AWS rule's access-key-id scan is OPT-IN upstream
 * (enableIDScanRule defaults false) — a memory write is exactly the surface
 * where an un-keyed AWS access key id must still be refused, so it is
 * enabled here. */
const PRESET_RULES = secretlintRules.map((rule) =>
  rule.meta.id === "@secretlint/secretlint-rule-aws"
    ? { id: rule.meta.id, rule, options: { enableIDScanRule: true } }
    : { id: rule.meta.id, rule },
);

/** One rejection: the RULE class only — never the matched content (G3). */
export interface SecretScanRejection {
  rule: string;
}

export interface SecretScanResult {
  rejected: boolean;
  rejections: SecretScanRejection[];
}

/**
 * PEM private key blocks: the whole block is the secret (the S18 rule,
 * verbatim family).
 */
const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * Bearer tokens in the Authorization scheme shape (the S18 rule family).
 */
const BEARER_TOKEN = /\b(bearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/i;

/**
 * Any `Authorization: <value>` header (the S18 rule family).
 */
const AUTHORIZATION_HEADER = /\b(authorization[ \t]*[:=][ \t]*)([^\s"']+)/i;

/**
 * Connection-string userinfo credentials (the S18 rule family):
 * `scheme://user:password@host...`.
 */
const CONNECTION_STRING_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"&#]+):([^\s@/'"&#]+)@/i;

/**
 * The S18 key-assignment sweep — including the S25 CSV-doubled-quote
 * alternative — as a detector: a key containing the secret vocabulary
 * (password/secret/token/api key/access key/private key/credential/cookie)
 * followed by ANY value is a rejection.
 */
const SECRET_KEY_ASSIGNMENT =
  /(?<!["'A-Za-z0-9_.-])(["'A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|credential|cookie)["'A-Za-z0-9_.-]*)([ \t]*[:=][ \t]*|[ \t]+)("[^"\n]*"|'[^'\n]*'|""[^"\n]*""|[^\s,&"']+)/i;

/** Shannon entropy in bits per character. */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The entropy pass: a standalone literal of >= 32 chars, mixing upper case,
 * lower case, and digits/symbols, with entropy >= 4.2 bits/char — the
 * base64ish credential shape. Hex digests cap at 4 bits/char and never trip;
 * prose and ids never trip.
 */
function highEntropyLiteral(text: string): string | null {
  const literals = text.match(/[A-Za-z0-9+/=_.~-]{32,}/g) ?? [];
  for (const literal of literals) {
    const hasUpper = /[A-Z]/.test(literal);
    const hasLower = /[a-z]/.test(literal);
    const hasDigitOrSymbol = /[0-9+/=_.~-]/.test(literal);
    if (hasUpper && hasLower && hasDigitOrSymbol && shannonEntropy(literal) >= 4.2) {
      return literal;
    }
  }
  return null;
}

/** Scan one memory write's text for secret shapes. Async: the secretlint layer is. */
export async function scanForSecrets(...texts: string[]): Promise<SecretScanResult> {
  const rejections: SecretScanRejection[] = [];
  const combined = texts.join("\n");

  // Layer 2 first (the recorded vocabulary — deterministic, sync).
  if (PEM_PRIVATE_KEY.test(combined)) rejections.push({ rule: "pem-private-key" });
  if (BEARER_TOKEN.test(combined)) rejections.push({ rule: "bearer-token" });
  if (AUTHORIZATION_HEADER.test(combined)) rejections.push({ rule: "authorization-header" });
  if (CONNECTION_STRING_USERINFO.test(combined)) {
    rejections.push({ rule: "connection-string-credential" });
  }
  if (SECRET_KEY_ASSIGNMENT.test(combined)) rejections.push({ rule: "secret-assignment" });
  if (highEntropyLiteral(combined) !== null) rejections.push({ rule: "high-entropy-literal" });

  // Layer 1: the embedded secretlint preset (its rules see the same text;
  // maskSecrets keeps any message data out of what we read back).
  try {
    const result = await lintSource({
      source: {
        filePath: "memory-write.txt",
        content: combined,
        contentType: "text",
      },
      options: {
        locale: "en",
        maskSecrets: true,
        config: { rules: PRESET_RULES },
      },
    });
    for (const message of result.messages) {
      rejections.push({ rule: `secretlint:${message.ruleId ?? "unknown"}` });
    }
  } catch {
    // The scanner itself failing is a fault, not an allow: treat it as the
    // most conservative rejection (the write is refused; the fault is
    // recorded by the caller through the redacted sink).
    rejections.push({ rule: "scanner-unavailable" });
  }

  return { rejected: rejections.length > 0, rejections };
}
