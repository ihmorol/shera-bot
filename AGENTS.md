# Shera Bot Agent Instructions

## Mandatory context loading

Before making architecture or product changes, read:

1. [`docs/README.md`](docs/README.md)
2. [`docs/PRD.md`](docs/PRD.md) — synchronized product baseline (2026-09-11, D1–D45); changes require a recorded product decision per PRD §24
3. [`docs/decisions/README.md`](docs/decisions/README.md)
4. [`docs/GLOSSARY.md`](docs/GLOSSARY.md)
5. [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md)
6. [`docs/history/2026-09-08-to-2026-09-11/README.md`](docs/history/2026-09-08-to-2026-09-11/README.md)
7. The relevant full transcript and findings ledger before relying on a summary

## Non-negotiable documentation rules

- The current canonical product vocabulary is **Pack → Operations → Agents**.
- Use **Agent** in new UI, code, schemas, pack files, database names, tests, and docs. `Expert` is a historical alias only; do not reintroduce it as a separate object.
- Preserve the Operation framing. Do not collapse Operations into generic task chats or rename them back to Scenes.
- Do not modify `docs/PRD.md` without a recorded product decision. The PRD was synchronized with D1–D45 on 2026-09-11 by explicit user instruction (SYNC-1); that instruction lifted the earlier freeze, not the general rule that PRD changes go through decisions recorded in `docs/decisions/` and reconciled in `docs/TRACEABILITY.md`.
- Preserve decision evidence and status. Explicit answers, incomplete acknowledgements, provisional choices, refined decisions, superseded decisions, engineering decisions, deferred work, and open items are different categories.
- Never delete or summarize away an alternative, finding, obstacle, failed attempt, reference, or correction when updating a decision.
- Every new decision must include an ID, status, date, exact evidence source, rationale, alternatives considered, affected PRD sections, implementation implications, and verification coverage.
- Every decision that changes an earlier choice must update the supersession map and traceability table.
- Every new acceptance criterion must have an owner, implementation boundary, test/manual QA target, and evidence location.

## Implementation boundary reminders

- Agents propose; the runtime validates and executes.
- Central PostgreSQL owns control-plane records; container-local SQLite owns product state in the prototype.
- The runtime gateway owns authoritative transitions, persistence, event sequencing, approvals, leases, supervision, and recovery.
- Never expose secrets in prompts, events, logs, memory, artifacts, transcripts, or documentation.
- Check `docs/TRACEABILITY.md` for unresolved implementation-defined items before treating the design as fully closed.
