/**
 * Secret redaction for the control plane (G3, PRD §16 "all logs redact
 * sensitive values", D23 rule 4). Two layers, because each alone can miss:
 *
 * 1. Key-based scrubbing — any object property whose name is a credential
 *    name (access_token, refresh_token, id_token, client_secret, cookie and
 *    authorization headers…) is replaced wherever it appears.
 * 2. Value-based scrubbing — the auth layer registers every concrete secret
 *    value it handles (env credentials, issued OAuth tokens, live session
 *    tokens) and any occurrence of the value in logs or event details is
 *    replaced, under any key name.
 *
 * S05 keeps this local to the control plane; packages/observability is filled
 * by S07/S27 and will subsume this module (recorded as an S05 E-note).
 */

const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /client_secret/i,
  /secret/i,
  /password/i,
  /credential/i,
  /token$/i,
  /verifier$/i,
  /authorization/i,
  /cookie/i,
  /api_key$/i,
];

const REDACTED = "[REDACTED]";

/** Bounded registry: a prototype-scale FIFO so long runs cannot grow unboundedly. */
const MAX_REGISTERED_SECRETS = 512;

export class SecretRegistry {
  private readonly values = new Map<string, string>();

  /** Register a concrete secret value; it is scrubbed from logs and events. */
  register(value: string | undefined | null, kind: string): void {
    if (!value || value.length < 8) return;
    if (this.values.has(value)) return;
    if (this.values.size >= MAX_REGISTERED_SECRETS) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
    this.values.set(value, `[REDACTED:${kind}]`);
  }

  /** Scrub a string: replace every registered secret occurrence. */
  scrubString(input: string): string {
    let output = input;
    for (const [value, replacement] of this.values) {
      if (output.includes(value)) output = output.split(value).join(replacement);
    }
    return output;
  }

  get size(): number {
    return this.values.size;
  }
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function scrubValue(value: unknown, registry?: SecretRegistry): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return registry ? registry.scrubString(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, registry));
  }
  if (value instanceof Error) {
    return scrubValue({ name: value.name, message: value.message }, registry);
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSecretKey(key) ? REDACTED : scrubValue(child, registry);
    }
    return output;
  }
  // Functions, symbols, and anything else unexpected never leaves the process.
  return REDACTED;
}

/** Scrub an object for persistence/logging; returns a JSON-safe plain object. */
export function scrubObject(
  value: Record<string, unknown>,
  registry?: SecretRegistry,
): Record<string, unknown> {
  const scrubbed = scrubValue(value, registry);
  return typeof scrubbed === "object" && scrubbed !== null && !Array.isArray(scrubbed)
    ? (scrubbed as Record<string, unknown>)
    : {};
}
