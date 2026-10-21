# Device handoff archive

This branch preserves the source checkpoint, design files, avatar source/assets, screenshots, historical QA findings, sequential repair plans, authored probe scripts and validation logs needed for laptop continuation.

The source development branch is `feat/task-4-authenticated-live-transport`. See `docs/handoffs/laptop-2026-10-21.md` for setup and known open work. This archive is evidence preservation; historical scripts and logs retain their original content and may contain device-specific paths. They are not newly supported application entry points.

`archive-paths.txt` lists the files intentionally staged in the archive commit. `artifact-sha256.json` records SHA-256 hashes of selected Git blob content and the selection/exclusion manifests. The `worktreeSha256` field also records the original device bytes before Git line-ending normalization. The hash file and this receipt do not hash themselves. `artifact-selection.txt` lists the initial 237 selected artifacts.

Fresh source verification: 842 tests / 85 suites passed, source lint, changed-source formatting, types, production build, boundary guards and 27 mockup tests passed. Individual commands' exit codes and logs are in this directory. These checks ran before archiving historical artifacts; the archive branch is not a claim that root-wide lint or formatting includes those historical files successfully.

High-confidence key/private-key scans and targeted quoted-secret/bearer/database-URL/environment-secret scans found no credential matches in the selected text. Two broader token-like code matches were independently inspected: both generate disposable test tokens at runtime. This is bounded screening, not a guarantee that arbitrary binary content can be exhaustively checked.

Excluded, preserved on the original device:

- Raw `.session-archive/`, `.review-logs/`, `.omo/` and automatic Cline/Codex checkpoint refs, which can contain hidden prompts, transient state or prior raw snapshots.
- `output/rea-source/`, an independent third-party repository and its dependencies/build caches.
- `output/release-audit-2026-10-20/source/` and `output/sequential-coding-2026-10-20/task-2-baseline/`, duplicate extracted source snapshots. Source history and the authored baseline patch remain available.
- Downloaded PostgreSQL installer/archive and `task-3/extracted/`. PostgreSQL version/source receipts are archived instead.
- Browser profile/cache data, runtime databases, runtime control-channel credentials and process IDs. The individually filtered candidates are listed in `excluded-artifacts.txt`.
- Installed dependencies, generated build output, codegraph indexes and other existing ignored files.

No files were deleted. This archive transfers source/evidence, not live application state, credentials or personal databases. Main remains unchanged and no merge/release readiness is implied.
