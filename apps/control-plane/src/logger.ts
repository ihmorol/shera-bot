/**
 * Structured, redacted logger for the control plane (G3). Every emitted line
 * passes through the secret registry (value-based) and the key-based scrubber
 * before serialization. The Auth.js "env-url-basepath-redundant" warning is a
 * known-benign artifact of mounting ExpressAuth at /api/auth while AUTH_URL
 * pins the origin; it is filtered, everything else passes through.
 */
import { scrubObject, scrubValue, type SecretRegistry } from "./redaction.ts";

const BENIGN_WARNINGS = new Set(["env-url-basepath-redundant"]);

export interface ControlPlaneLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(codeOrMessage: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
  /** Raw emission seam for the redaction test (assertions attach a sink here). */
  sink: ((line: string) => void) | undefined;
}

export interface LoggerOptions {
  registry: SecretRegistry;
  emit?: (line: string) => void;
}

export function createControlPlaneLogger(options: LoggerOptions): ControlPlaneLogger {
  const { registry } = options;
  const emit = options.emit ?? ((line: string) => console.log(line));
  let sinkOverride: ((line: string) => void) | undefined;

  function emitLine(level: string, message: string, details?: Record<string, unknown>): void {
    const payload = {
      level,
      service: "control-plane",
      time: new Date().toISOString(),
      message: registry.scrubString(message),
      ...(details ? { details: scrubObject(details, registry) } : {}),
    };
    const line = JSON.stringify(payload);
    emit(line);
    // Raw emission seam (redaction tests attach here); part of the same
    // scrubbed pipeline as the console output, never a bypass.
    sinkOverride?.(line);
  }

  return {
    get sink() {
      return sinkOverride;
    },
    set sink(value) {
      sinkOverride = value;
    },
    debug(message, details) {
      emitLine("debug", message, details);
    },
    info(message, details) {
      emitLine("info", message, details);
    },
    warn(codeOrMessage, details) {
      if (BENIGN_WARNINGS.has(codeOrMessage)) return;
      emitLine("warn", codeOrMessage, details);
    },
    error(message, details) {
      emitLine("error", message, details);
    },
  };
}

/** Adapt the control-plane logger to the Auth.js logger interface. */
export function authJsLogger(logger: ControlPlaneLogger): {
  debug: (m: unknown) => void;
  info: (m: unknown) => void;
  warn: (m: unknown) => void;
  error: (m: unknown) => void;
} {
  const message = (m: unknown): string => {
    if (typeof m === "string") return m;
    return JSON.stringify(scrubValue(m));
  };
  return {
    debug: (m) => logger.debug(message(m)),
    info: (m) => logger.info(message(m)),
    warn: (m) => {
      // Auth.js emits warning *codes* as strings; keep the benign-code filter.
      logger.warn(typeof m === "string" ? m : message(m));
    },
    error: (m) => logger.error(message(m)),
  };
}
