/**
 * @shera-bot/user-runtime — the runtime gateway: Pi supervision, typed execution events, event journal, approvals, leases, recovery.
 *
 * S02 adds the pure runtime core: the task state machine as DATA (the D8
 * transition table), the pure transition function with typed rejections
 * (D23 rule 5), idempotency-key deduplication and optimistic version checks
 * (D23 rule 6), D26 event envelope construction, and the G2 task-run creator
 * that accepts only typed execution events (D34).
 *
 * S06 adds the authenticated internal channel: the credential store (digests
 * only, constant-time verification), the runtime registration binding, and
 * the internal API — the only control-plane-reachable surface, with no
 * inbound public access and no host-infrastructure access (D2, D11, PRD §16).
 *
 * Filled further by S07 (runtime gateway: local API, SQLite WAL, event journal,
 * WebSocket replay) — this package exports no persistence or process behavior
 * yet, and nothing here throws instead of rejecting.
 * Governing records: D5, D8, D10, D11, D13, D26, D34, G2.
 */
export * from "./modules/tasks/task-events.ts";
export * from "./modules/tasks/task-transitions.ts";
export * from "./modules/tasks/task-run-creator.ts";
export * from "./modules/runtime/channel-credentials.ts";
export * from "./modules/runtime/channel-security-events.ts";
export * from "./modules/runtime/runtime-registration.ts";
export * from "./modules/runtime/internal-api.ts";
