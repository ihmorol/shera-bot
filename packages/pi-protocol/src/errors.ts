/**
 * Typed protocol errors for the Pi adapter (S12).
 *
 * The code/category pair pattern follows packages/contracts/src/errors.ts
 * (D23 rule 4). Both errors are validation-category: they mean the peer spoke
 * wrongly, not that the gateway is broken. Codes are stable once shipped.
 *
 * Governing records: D13, D14, E17.
 */

export const PI_PROTOCOL_ERROR_CATEGORIES = ["validation"] as const;
export type PiProtocolErrorCategory = (typeof PI_PROTOCOL_ERROR_CATEGORIES)[number];

export const PI_PROTOCOL_ERROR_CODES = ["PROTOCOL_VERSION_MISMATCH", "PROTOCOL_VIOLATION"] as const;
export type PiProtocolErrorCode = (typeof PI_PROTOCOL_ERROR_CODES)[number];

/**
 * Machine-readable classification of a protocol violation. The parse helper
 * never surfaces a raw SyntaxError — every malformed input lands in exactly
 * one of these buckets.
 */
export const PROTOCOL_VIOLATION_REASONS = [
  "unparseable_json_line",
  "frame_not_object",
  "missing_required_field",
  "invalid_version_field",
  "field_type_invalid",
  "unknown_frame_type",
  "oversized_line",
] as const;
export type ProtocolViolationReason = (typeof PROTOCOL_VIOLATION_REASONS)[number];

export class PiProtocolError extends Error {
  readonly code: PiProtocolErrorCode;
  readonly category: PiProtocolErrorCategory = "validation";
  /**
   * Violation reason; set on ProtocolViolationError, undefined on other
   * subclasses (a version mismatch is a negotiation failure, not a violation).
   */
  readonly reason: ProtocolViolationReason | undefined;

  constructor(
    code: PiProtocolErrorCode,
    message: string,
    details?: { reason?: ProtocolViolationReason },
  ) {
    super(message);
    this.name = "PiProtocolError";
    this.code = code;
    this.reason = details?.reason;
  }
}

/**
 * Version mismatch / negotiation failure (D14: the protocol is versioned).
 * Raised when an envelope `v` or a handshake `protocol_version` does not match
 * the negotiated PROTOCOL_VERSION.
 */
export class ProtocolVersionError extends PiProtocolError {
  readonly expected: number;
  readonly received: number;

  constructor(details: { expected: number; received: number }) {
    super(
      "PROTOCOL_VERSION_MISMATCH",
      `protocol version mismatch: expected ${details.expected}, received ${details.received}`,
    );
    this.name = "ProtocolVersionError";
    this.expected = details.expected;
    this.received = details.received;
  }
}

/**
 * Malformed frame: unparseable JSON line, unknown type, missing required
 * field, wrong field type, or a line over the framing cap (D14: invalid
 * messages are rejected and recorded as protocol failures).
 */
export class ProtocolViolationError extends PiProtocolError {
  override readonly reason: ProtocolViolationReason;
  readonly field: string | undefined;
  readonly detail: string | undefined;

  constructor(details: {
    reason: ProtocolViolationReason;
    field?: string | undefined;
    detail?: string | undefined;
  }) {
    super(
      "PROTOCOL_VIOLATION",
      `protocol violation: ${details.reason}${details.field ? ` (${details.field})` : ""}`,
      { reason: details.reason },
    );
    this.name = "ProtocolViolationError";
    this.reason = details.reason;
    this.field = details.field;
    this.detail = details.detail;
  }
}
