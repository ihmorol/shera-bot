/**
 * @shera-bot/pi-protocol — versioned JSON Lines protocol for the Pi adapter, plus the fake Pi used by tests.
 *
 * S12 chunk 1 ships the protocol frames (D13, D14; shapes ported from the S03
 * spike, variant A — E17), the typed protocol errors, the JSONL framing
 * helpers, and the fake Pi test double. The supervision core (watchdog,
 * bounded queue, restart policy) lands in a later S12 chunk.
 *
 * Governing records: D13, D14, E17, G2, G7.
 */
export * from "./errors.ts";
export * from "./fake-pi.ts";
export * from "./framing.ts";
export * from "./protocol.ts";
