/**
 * @shera-bot/contracts — the single source of truth for shared schemas.
 *
 * S02 fills this package with the ten Zod-first contracts (phase-0 plan §2:
 * Session, Pack, Agent, Operation, TaskRun + RunState, TypedExecutionEvent,
 * ApprovalRequest + Grant, ArtifactRef, CreditReservation/Settlement,
 * MemoryEntry) and the generated types.
 *
 * S01 ships only this marker: it gives the workspace graph something to resolve
 * and the pipeline smoke test something to assert (tests/contract/workspace-graph.test.ts).
 * It is not a product contract and must not grow into one — contracts arrive in
 * S02, Zod-first, with no hand-written duplicate types.
 * Governing records: D23 (layout), PRD §17, G2 (typed events, not prose).
 */
export const CONTRACTS_PACKAGE_PLACEHOLDER = true;
