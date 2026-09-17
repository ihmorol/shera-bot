# Tests

Test tiers follow **E8** (`docs/decisions/closure-decisions.md`). Files live in the tier
directory they belong to and run from the repository root with `pnpm test` (Vitest, Node
environment). The default run never touches a live provider — live-provider tests are
opt-in only (**G7**).

| Tier        | Directory                     | What belongs here                                                                            |
| ----------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Unit        | `packages/*/src/**/*.test.ts` | Module-level behavior, next to the code (test files colocated)                               |
| Contract    | `tests/contract/`             | Shared schema round-trips and workspace/pipeline guarantees                                  |
| Integration | `tests/integration/`          | Two or more components against real local dependencies (SQLite WAL, control plane + runtime) |
| E2E         | `tests/e2e/`                  | Scripted user journeys against the fake Pi provider                                          |
| Recovery    | `tests/recovery/`             | Restart, replay, checkpoint, and cancellation probes                                         |
| Security    | `tests/security/`             | The threat-model test list (traversal, redaction, escalation, leases, cross-user)            |
| Benchmark   | `tests/benchmark/`            | Spike measurements kept as evidence (never merge gates)                                      |

S01 populates the contract tier with `workspace-graph.test.ts`; the remaining tiers are
created by the slices named in `docs/BUILD_MAP.md`.
