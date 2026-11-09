# Solo fresh-archive gate — S34 post-INTEGRATION tip 6baf72a (2026-11-10 +0600)

Procedure per the E41 precedent: `git archive HEAD | tar -x` into a fresh directory
(`shera-bot-s34-fresharchive`, outside every worktree), `pnpm install --frozen-lockfile`,
then each step redirected to its own file with its exit code recorded. Host PostgreSQL
16.15 via `SHERA_PG_BIN=/usr/lib/postgresql/16/bin`; vitest from the repo ROOT.

This gate ran at the POST-INTEGRATION tip (origin/main `9f50d9c` — the S30 merge with
its review round and the S12/S28 gate-environmental fixes — integrated at `9a5c573`,
the harness fixture adjustment `9cdc548`, the substantiated acceptance evidence
`6baf72a`). History of this file's earlier records: the pre-review-fix gate
(2458/2459) and the post-review-fix gate (2459/2460) each held the single documented
S12 protocol-cap race, green isolated 13/13 × 3 — **that family is now GONE**: the
S30 branch's frame fix (`986537f`, which pins both legal orderings of the D14
cascade) is on main and integrated, and the definitive run below is fully green
first try.

| Step | Exit | Note |
|---|---|---|
| install --frozen-lockfile | 0 | |
| lint | 0 | |
| format:check | 0 | |
| typecheck | 0 | |
| test (full suite) | 0 | **2527 passed / 2527 in 236 files — zero failures, zero flakes, first try** (the S12 protocol-cap race eliminated by the integrated frame fix; the +67 tests vs the pre-integration gate = S30's landed suites) |
| build | 0 | |
| license:inventory | 0 | Apache-2.0 (@playwright/test) + MPL-2.0 (axe-core) on the allowlist |
| boundary-guards | 0 | PASS — 526 source files scanned |
| mockup:test | 0 | |

Raw outputs: `gate-00-install.txt` … `gate-08-mockup-test.txt`, `gate-exits.txt` in
the archive directory (worktree-local scratch, not committed — this file is the
record).
