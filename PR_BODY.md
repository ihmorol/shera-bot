# S31 — Semantic checkpoints, restart recovery, recovery surfaces (issue #32)

## Summary

Implements PRD §13's restart-recovery clauses through D32's policy layer and D33's checkpoint record (E13's recovery classes as executable, fail-closed data): semantic checkpoints at safe boundaries only, a defined recovery class per pending action, a restart path that resumes what it can prove and pauses on what it cannot, and honest recovery surfaces. A **new migration** — the chain head moves to **v20 `run_checkpoints`** (STRICT, append-only, keyed `(workspace_id, task_id, step_id, checkpoint_version)`; the full D33 field set).

### Checkpoints (D33, AC5)

The runtime's `CheckpointService` writes the v20 D33 row AND the task stream's `checkpoint.taken` contract envelope in ONE transaction (D23 rule 5); deterministic-event-id idempotency deduplicates a replayed step (D23 rule 6); `checkpoint_version` is monotonic per task. The boundary vocabulary is **closed data**, not convention:

- the seven D33 named boundaries (completed search, downloaded document, saved artifact, applied patch, completed test run, received approval, confirmed external request) plus `tool_execution` — the generic succeeded-tool boundary the recorded capability→kind mapping lands on (`research.search` → `completed_search`, `research.fetch`/`parse.document` → `downloaded_document`);
- the ONLY writer entry point validates the step kind: a stream/token-style step is a typed `NON_SEMANTIC_STEP` refusal — no row, no journal event, structurally unrepresentable;
- AC5 end-to-end: a 50-frame `progress.reported` streamed run journals the lightweight between-checkpoint vocabulary and produces **zero** checkpoint rows and **zero** checkpoint markers — never per token, never on a timer;
- a SUCCEEDED tool execution IS a boundary: the S21 executor offers it through a contained port (one checkpoint per settled execution; the tool's identity and its DECLARED E13 class recorded in `external_effect_state`; a checkpoint gap never changes the settled outcome);
- `lease_state`/`approval_state` CAPTURE the recorded S16 lease and S20 approval states at the boundary — never a new mechanism; every field is bounded before any write (G3).

### Recovery classes (E13) — fail-closed, one scripted case per class

The pure decision (`decideRecovery`) reads the checkpoint's pending action:

| Declared class                                                                            | Recovery behavior                                                      | The pin                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `replayable`                                                                              | auto-resumes; the effect re-executes from the checkpoint               | resumes WITHOUT user action; the effect happens exactly ONCE                                                                                                                      |
| `idempotent_retry`                                                                        | auto-resumes ONLY under its RECORDED idempotency key                   | the worst case pinned: the original effect LANDED before the interruption; the re-execution carries the SAME key and the net effect count stays ONE (a fresh key would double it) |
| `needs_human`, undeclared (the E13 default), keyless `idempotent_retry`, or no checkpoint | `RECOVERY_REQUIRED` — the possibly-duplicated effect is NEVER replayed | the effect ledger is untouched; the resume port is never called                                                                                                                   |

The `RecoveryDriver` walks the ONE D8 machinery (`applyRowLifecycleTransition` — never a second state machine): the runtime-actor **`recovery_auto_resume`** row the 2026-09-19 review note reserved for this layer (contracts grows by exactly one command; reason `recovery_class_permits` — the journal never mistakes a class-driven resume for a human approval; the human `recovery_resume` row is unchanged), the existing `recovery_required` row for pauses, the **live-worker-row skip** (a run with live work is never re-driven — the S16 conservative rule; the matrix RED caught this before it shipped), the honest `resume_failed` outcome on a failed re-drive, and the `recovery.decided` journal marker whose `resume_from_checkpoint_version` anchors every resume claim to the last safe step. QUEUED stays the S16 reconciliation's re-drive; RETRYING stays the S22 coordinator's clock; PAUSED stays human.

### The restart matrix (AC19/AC25) — the boot walk composes S16 FIRST, then S31

Pinned over a close-and-reopen restart (the same SQLite file, every service rebuilt — the durable state is exactly the rows and the journal):

- the journal streams and the run rows survive byte-identical (E2/E10 retention, D26 replay);
- QUEUED tasks re-drive through the S16 reconciliation (pinned, not reworked);
- an interrupted task resumes from its LAST SAFE STEP — the marker's basis is the checkpoint version, the recorded `resume_instructions` ride;
- an interrupted ambiguous task pauses `RECOVERY_REQUIRED` with the effect never replayed;
- Operation chat history and membership restore;
- pending approvals survive UNCHANGED — same request record, same reminder slots, still pending — and their `WAITING_FOR_APPROVAL` runs are untouched;
- schedules catch up EXACTLY ONCE across two boots (the S28 ledger pinned through the real `reconcileBoot` — never reworked);
- a healthy worker (a live pid) is kept — no reap, no re-drive (the AC25 keep-alive leg).

The composed boot test re-drives through **REAL fake-worker children** end-to-end: the interrupted replayable run's stream shows checkpoint → worker.reaped → recovery.decided → worker.started; the ambiguous run's shows the pause and NO worker spawn. No WS client (no browser) is attached for any of it.

### Honest surfaces (UI_DESIGN S11, AC8)

The web reads the REAL `GET /v1/recovery/status` (the runtime's own records — the journal and the D8 rows; the browser allowlist grows by exactly that one workspace-scoped GET):

- the **top-of-app recovery banner**: `RECOVERING` ("Restoring your workspace…"), `RESUMED` (transient, names the last-safe-step basis), `RECOVERY_REQUIRED` ("A task needs your review" + the Operation deep link); a strip, never a modal; idle renders nothing;
- the **run cards' recovery timeline**: checkpoint → restart → resume/pause markers from the durable journal;
- the copy is basis-anchored **by test**: "Resumed from last safe step — checkpoint v<n> (<step>)" with the authorizing class named; the pause marker names what could not be proven safe and promises no outcome; the exact-resume claims are banned AT THE SOURCE by a grep test over the surface modules.

The impeccable UI gate ran exactly per its SKILL.md (context → operate.md + craft-floor.md before any UI edit): `impeccable detect` clean over the three surface modules; the adversarial taste pass found ONE defect (the S11 strip stacked above AppShell's `h-dvh` root double-counted the viewport height) — fixed (the shell fills the space beside the strip) and recaptured in one confirmation round; the §2.3 rules held (icon+text pairing everywhere; the a11y suite's single-focus-treatment rule kept the banner from declaring its own focus ring).

## Evidence

| Item                                                                                                                                                                                | Location                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Checkpoint pins (v20 + D33 field set + AC5 no-per-token + executor hook)                                                                                                            | `apps/user-runtime/src/modules/tasks/s31-checkpoints.test.ts` (9)           |
| Recovery-class matrix + fail-closed policy + D8 rows                                                                                                                                | `apps/user-runtime/src/modules/recovery/s31-recovery-classes.test.ts` (14)  |
| Restart matrix (AC19/AC25 legs)                                                                                                                                                     | `apps/user-runtime/src/modules/recovery/s31-restart-matrix.test.ts` (8)     |
| Composed boot walk end-to-end (real worker children)                                                                                                                                | `apps/user-runtime/src/transport/local-api/s31-recovery-boot.test.ts` (1)   |
| Copy gate + banner/timeline rendering                                                                                                                                               | `apps/web/test/s31-recovery-surfaces.test.ts` (13)                          |
| Production-build captures (360/768/1440 + keyboard trail + reduced motion) with the JSON truth legs (the harness FAILS unless the rendered status matches the runtime's own record) | `apps/web/.impeccable/review/s31/`                                          |
| Capture harness (real runtime, real boot-walk decisions, fake worker harness)                                                                                                       | `apps/user-runtime/scripts/capture-s31.mjs`                                 |
| Engineering record (incl. the two-builder resumption)                                                                                                                               | `docs/decisions/engineering-record-e41-s31-checkpoints-2026-11-04.md` (E41) |
| Traceability (the AC19/AC25 evidence links)                                                                                                                                         | `docs/TRACEABILITY.md` § E41                                                |

## Gate

| Step                                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint` (repo-wide)                                                                                  | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm format:check` (repo-wide)                                                                          | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm typecheck`                                                                                         | exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `pnpm gen:clients`                                                                                       | run after the contracts change; the codegen `--check` pin green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm test` (SHERA_PG_BIN set), worktree                                                                 | three runs recorded honestly in E41's gate table: 2195/2199 (run 1: the codegen drift + the slice's own TWO boundary-contract violations — a `PRAGMA` and a `child_process` import — both fixed at the recorded pattern; the S12 flake green isolated) → 2197/2199 (run 2: a self-inflicted parse error in the boot test from the fix-round edit — fixed; the S12 flake again, green isolated twice) → **2198/2199** (run 3: the single failure the documented S16 QUEUED re-drive load-flake family — the same leg and timeout E40 recorded persistent on this box; the leg builds its own supervisor and nothing in this diff touches the spawn path) |
| **Solo fresh-archive gate** (`git archive HEAD \| tar -x`, `pnpm install --frozen-lockfile`, at 7327e7c) | **every step exit 0**: lint → format:check → typecheck → **test 2199/2199 in 186 files, zero failures (the S16 leg green in the archive run — the worktree failure confirmed load-flake)** → build → license:inventory (no new dependency) → boundary-guards → mockup:test                                                                                                                                                                                                                                                                                                                                                                              |

## Review passes

- [ ] Standards review (fresh context) — orchestrator — PENDING
- [ ] Spec review (issue #32's acceptance set + PRD §13 + D32/D33/E13 point by point) — orchestrator — PENDING
- [ ] Security review (the recovery pause posture, the status read's scoping, G3 in the checkpoint records) — orchestrator — PENDING
- [ ] **P9 owner test of every recovery claim before merge** (sensitive-slice instruction) — the live AC25 demo is the recorded owner item below; the automated legs are not a substitute

## NOT verified / owner items

- **The owner's live AC25 recovery demo** — a real browser-closure survival with a REAL harness and a REAL container restart, plus the real browser-profile/cookies restore (the S18 posture's live leg). Docker is unusable on the building machine (the recorded E22–E41 reality); the automated legs prove the machinery, the demonstration proves the claim.
- **Real process death of the composed gateway** — the restart matrix simulates the restart honestly (close and reopen the SAME store, every service rebuilt); no actual gateway process death was demonstrated on this branch.
- **WS live fanout for the recovery markers** — the banner and timelines read the status on the visible-tab poll cadence (15 s); the post-commit fanout cell exists for the decisions, the realtime leg is the standing S21/S22 posture.
- **A real harness (Pi) re-entering a run from the recorded `resume_instructions`** — the re-drive hands the run back through the recorded supervisor seam; the fake worker walks its steps. The prototype's honest claim is the recorded checkpoint + the runtime's re-drive, never exact resume.
- **AC19/AC25 acceptance-status flips** — the TRACEABILITY row-25 status change is the owner's reconciliation (the E41 section carries the evidence links).

## Commits

| Chunk                                                                                                          | Commit(s)                 |
| -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1 RED — the D33 pins (v20 table, closed vocabulary, AC5 no-per-token, executor hook)                           | `bd80ae8`                 |
| 1 GREEN — the reconciled writer (repository + service + compose + chain-pin sweep)                             | `5c69dd2`                 |
| 2 — the E13 recovery classes (fail-closed decision, RecoveryDriver, `recovery_auto_resume`, the class matrix)  | `5cf0cc9`                 |
| 3 — the restart matrix + the composed boot walk (the live-worker skip, `resume_failed`, the `recovery` handle) | `10a5c39`                 |
| 4 — the honest surfaces + the `/v1/recovery/status` read + the production captures + the taste-pass fix        | `ceaa5e8`                 |
| 5 — the gate round (gen:clients, boundary fixes, lint/format) + E41 + traceability + this PR body              | `7327e7c` (+ this commit) |
