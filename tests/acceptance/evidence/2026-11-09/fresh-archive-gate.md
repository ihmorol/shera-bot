# Solo fresh-archive gate — S34 post-review-fix tip 3c0ee88 (2026-11-09T20:xxZ / 2026-11-10 +0600)

Procedure per the E41 precedent: `git archive HEAD | tar -x` into a fresh directory
(`shera-bot-s34-fresharchive`, outside every worktree), `pnpm install --frozen-lockfile`,
then each step redirected to its own file with its exit code recorded. Host PostgreSQL
16.15 via `SHERA_PG_BIN=/usr/lib/postgresql/16/bin`; vitest from the repo ROOT.

This gate ran at the POST-REVIEW-FIX tip (the F1/F2/F3 + P3 batch `a3d874f` + the
substantiated evidence `3c0ee88`); the pre-fix gate record is superseded by this file
(its numbers: 2458/2459 with the same single documented flake).

| Step | Exit | Note |
|---|---|---|
| install --frozen-lockfile | 0 | |
| lint | 0 | |
| format:check | 0 | |
| typecheck | 0 | |
| test (full suite) | 1 | **2459 passed / 1 failed of 2460 in 226 files** — the single failure the **documented S12 supervisor protocol-cap race** ("records every protocol failure and applies the cap", `AgentSessionFailedError` thrown from `ensureStarted` — the exact shape the in-flight `s30-settings` branch's 986537f frame fix pins both orders of; not on main at this tip). Green isolated **13/13 × 3 consecutive runs**. The documented load-flake family confirmed, never widened: nothing in the review-round diff touches the session-supervisor or worker-spawn path. (+1 test vs the pre-fix gate = the F3 ledger-identity pin in ledger.test.ts.) |
| build | 0 | |
| license:inventory | 0 | Apache-2.0 (@playwright/test) + MPL-2.0 (axe-core) on the allowlist |
| boundary-guards | 0 | PASS |
| mockup:test | 0 | |

Raw outputs: `gate-00-install.txt` … `gate-08-mockup-test.txt`, `gate-exits.txt`,
`gate-04b-isolated{,-2,-3}.txt` in the archive directory (worktree-local scratch, not
committed — this file is the record).
