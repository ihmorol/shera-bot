# S25 — Research and data tools (issue #26)

## Summary

Implements the research and data capabilities the Agents' job descriptions promise (PRD §5.1–5.3, §7) as five real, READ_ONLY tools through the S21 executor (the ONE execution path):

| Tool                       | Capability                     | What it does                                                                                     |
| -------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `tool_web_search`          | `research.search`              | SearXNG JSON API search from a configured base URL; bounded, engine-attributed results           |
| `tool_page_fetch`          | `research.fetch`               | Fetch + @mozilla/readability (over linkedom) + turndown → markdown; byte-cap and deadline policy |
| `tool_document_parse`      | `research.parse.document`      | Uploaded PDF (unpdf) / text/markdown from the S17 row-based workspace store → text artifact      |
| `tool_spreadsheet_analyze` | `research.analyze.spreadsheet` | SheetJS CE decode + deterministic per-column statistics → CSV artifact                           |
| `tool_image_understand`    | `research.describe.image`      | AI SDK vision (one honest request, `maxRetries: 0`) → description artifact                       |

All five are `READ_ONLY` built-ins in the D35 ladder: they execute automatically with **no approval row and no grant** (AC8, pinned with the real S20 machinery wired). They run through the executor's async-dispatch seam (the S26 posture): network and file I/O never run inside the caller's SQLite transaction; the executor's cancel seam aborts in-flight requests; the sync `execute` is the typed refusal even with genuine authority.

Key properties, each pinned by test:

- **AC1** — every tool runs end-to-end against local deterministic fixture servers in default CI (SearXNG JSON shape, canned page, hand-built minimal PDF, SheetJS-generated workbook, mock vision model). No live network in default CI (G7).
- **AC3** — oversized and streamed responses are handled by policy: an over-cap _search_ response is the typed `TOOL_RESPONSE_TOO_LARGE` refusal (the JSON cannot be truncated at a semantic boundary); an over-cap _page_ is truncated by policy into an artifact with an explicit marker (the readable head is real content). Never a crash, never an unbounded buffer. The tool deadline aborts as the typed `TOOL_EXECUTION_TIMEOUT`.
- **AC4** — large outputs become artifacts with provenance (producing run + agent); the prompt payload stays bounded (8 KiB head + the artifact pointer, which LEADS the recorded summary so it survives the executor's bound).
- **AC5** — secrets in fetched content or uploaded files are redacted in history and never enter events or memory: whole-database byte-scan (runtime.db + WAL) for fetched content; history rows, journal payloads, derived artifact bytes, and the empty agent-memory table pinned for uploads. Surfaced and fixed one real leak: CSV-doubled JSON quoting in spreadsheet cells defeated the S18 quoted-value match — the key-assignment sweep gained the doubled-quoted alternative (additive; all S18 pins green).
- **AC6** — typed errors with correct `retryable` flags; the research failure shapes and the S22 retry classification are pinned to agree per code; a transient (503) failure retries per the bounded policy (1s/2s/4s → `retry_exhausted` pause) and a permanent one fails immediately; a re-propose after a transient failure executes.
- **AC7** — every tool declares the full contracts shape; E13 recovery classes are data both ways: `idempotent_retry` (fetch) and `replayable` (parsers) declared; search and image OMIT the class and carry the stored `needs_human` default.
- **AC9** — regression budget held: tool executor, approvals, and credits suites green throughout.

The D27 network separation is asserted where it is used: one test pins a real loopback fetch through the research binding next to the code-exec spawn request carrying `networkDisabled: true` — research is the network-allowed, capability-based side; code execution stays sandboxed and network-disabled (the kernel-level separation stays E36's).

No new migration (chain head stays v19 — the slice adds no tables).

## Evidence

| Item                                                                                                                                        | Location                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S25 test suites (29 tests)                                                                                                                  | `apps/user-runtime/src/modules/research/s25-research-tools.test.ts`, `s25-page-fetch.test.ts`, `s25-document-data.test.ts`, `s25-image-redaction-retry.test.ts` |
| AC2 manual-run evidence (one real run per tool, transcripts)                                                                                | `apps/web/.impeccable/review/s25/manual-runs.md` + `manual-runs.json`                                                                                           |
| UI captures (360/768/1440 + keyboard trail + reduced motion, production build against the real runtime with all five tools really executed) | `apps/web/.impeccable/review/s25/*.png` + `tools-keyboard-trail.json`                                                                                           |
| Capture harness                                                                                                                             | `apps/user-runtime/scripts/capture-s25.mjs`                                                                                                                     |
| Engineering record                                                                                                                          | `docs/decisions/engineering-record-e40-s25-research-tools-2026-11-02.md` (E40)                                                                                  |
| Traceability                                                                                                                                | `docs/TRACEABILITY.md` § E40                                                                                                                                    |

### UI gate

The impeccable skill ran exactly per its SKILL.md (context loader → audit/critique playbooks → craft-floor before any UI edit). The existing truthful surfaces (Settings → Tools inventory + the workspace panel Tool history tab) render the research tools without a new surface; the adversarial taste pass on the rendered result found two defects, both fixed and recaptured in one confirmation round:

1. **F1** — the artifact pointer rendered as `artifact artifact…` (the id slice took exactly the literal prefix); fixed to the id stem (`artifact_68fa228e…`).
2. **F2** — multi-line result transcripts collapsed into run-on paragraphs; the history row now renders `whitespace-pre-line`, keeping the executor's recorded structure.

### Fresh-archive gate (Linux, at the final commit)

`git archive HEAD | tar -x` + `pnpm install --frozen-lockfile` → lint exit 0 → format:check exit 0 → typecheck exit 0 → test **2134/2135** (the single failure the S28 schedules fixture's date dependence — a `0 9 * * 1` trigger whose expected next occurrence hardcodes today's 09:00 UTC; verified failing identically at the BASE commit via stash, sibling code untouched, never widened) → build exit 0 → license:inventory exit 0 → boundary-guards exit 0 → mockup:test exit 0. The documented S16 QUEUED-re-drive flake was observed once mid-slice, green isolated 11/11.

## Review record

- [ ] Standards review (fresh context) — orchestrator
- [ ] Spec review (the 9 ACs + PRD §5.1–5.3/§7 + D27/D35 point by point) — orchestrator
- [ ] Security review (G3 redaction surfaces, network posture, upload path) — orchestrator
- [ ] P9 owner diff-read before merge (sensitive-slice instruction)

## NOT verified / owner items

- **Real SearXNG container integration** — the recorded owner item. SearXNG stays an unmodified EXTERNAL AGPL container spoken to over HTTP only (no code linking); Docker is unusable on the building machine, so tests, captures, and the manual runs speak the JSON API shape from local deterministic fixtures. Verification step: point `SHERA_SEARXNG_URL` at a real container and re-run a search.
- **Live vision provider** — image understanding exists only where `SHERA_VISION_BASE_URL`/`SHERA_VISION_MODEL` name an OpenAI-compatible endpoint; default CI drives deterministic mocks (G7 opt-in posture).
- **SheetJS CE 0.18.5 CVE posture** — the npm-published CE version parses untrusted spreadsheets in-process; upstream 0.20.x fixes distribute via cdn.sheetjs.com (a non-registry channel — not silently pinned behind a frozen lockfile). Owner item.
- **SSRF host policy** — the page-fetch guard is scheme-only (http/https); a production host allowlist / egress policy is the recorded hardening path.
- **Live MCP-server wrapping** beyond the research half (standing from E33 — the research bindings arrive through the same typed seam).
- **WS fanout for tool states** (the visible-tab poll posture, standing from S21).
- **S28 schedules fixture date dependence** — sibling slice owner item (verified pre-existing at the base commit of this branch).
- Real OAuth/Docker/container restarts (standing from E22–E38).

## Commits

| Chunk                                                             | Red       | Green                     |
| ----------------------------------------------------------------- | --------- | ------------------------- |
| 1 — inventory declarations (AC7) + read-only auto-execution (AC8) | `d4908f6` | `6ffa122`                 |
| 2 — page fetch (AC1/AC3/AC4) + D27 separation pin                 | `7c6abb4` | `e403c64`                 |
| 3 — document parse + spreadsheet analysis                         | `eb50afd` | `b5ea77d`                 |
| 4 — image understanding + redaction + retry (AC5/AC6)             | `c8d0db8` | `cf7424d`                 |
| 5 — UI gate + AC2 evidence                                        | —         | `4911bb3`                 |
| 6 — lint/format round + records                                   | —         | `6d4a5e2` (+ this commit) |
