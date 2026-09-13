# Docs-conformance audit — mockup vs PRD, decision records, and UI design spec

**Date:** 2026-09-13 (same day as the investor/client audit and pane verification; performed later, in a separate session)
**Type:** Read-only documentation-conformance audit. **No application file, PRD section, decision record, or acceptance status was changed.**
**Sources of authority checked against:** [`../../../docs/PRD.md`](../../../docs/PRD.md) (synchronized, D1–D45), [`../../../docs/decisions/`](../../../docs/decisions/) (incl. D40–D45, E1–E8), [`../../../docs/GLOSSARY.md`](../../../docs/GLOSSARY.md), [`../../../docs/TRACEABILITY.md`](../../../docs/TRACEABILITY.md), [`../../../docs/UI_DESIGN.md`](../../../docs/UI_DESIGN.md), plus the mockup's own [README](../../README.md), [REFERENCE](../../REFERENCE.md), [HANDOFF](../../HANDOFF.md) and [UX recommendations](../../UX_RECOMMENDATIONS.md).
**Method:** full read of `index.html`, `app.js`, `views.js`, `data.js` and all mockup docs; vocabulary grep over js/html/css; re-run of the documented checks; targeted spot-check of two preserved screenshots (`launch-broken-route.png`, `approval-dark.png`). The mockup was **not** re-served or re-walked in a browser for this audit; rendered-state claims rely on the same-day preserved evidence. Line numbers refer to the current uncommitted working tree (post-pane changes) and will shift.

---

## 1. Verdict

The mockup is **structurally faithful to every product-decision-level rule**: vocabulary (D44), the two-section sidebar (D41), one persistent Agent identity (D39), the preview gate with all eight groups (D30), the five verbatim approval choices and reminder sequence (PRD §8/D9), the risk-tier ladder (D35), D8 run-state vocabulary, the credits reservation/settlement model (D20/D21), the memory publication boundary (D37), recovery/storage/offline copy, pack pinning (AC22), and independent runs (AC24). Its own documentation is **accurate about its defects** — every defect claimed in README/REFERENCE/HANDOFF was confirmed in code; no overclaim and no undocumented product-boundary violation was found.

The audit's additions are: **one fixture conflict with a recorded decision (D43 roster reuse)**, several fixture/coverage gaps against PRD §9 and UI_DESIGN §9/S1/S3/S6/S9, and small fixture inconsistencies. These are recorded in HANDOFF §7 and prioritized in §6 below.

## 2. Checks run and results

| Check | Result |
|---|---|
| Vocabulary grep (`expert`, `scene`, `group chat`, `task chat`, `bundle`, `subscription`, `asking permission`) over mockup js/html/css | **0 hits.** One "expert" in UX_RECOMMENDATIONS.md is "expert review" (the reviewer kind), not the product noun — permitted. |
| `node --check mockup/app.js`, `views.js`, `dock-layout.test.cjs` | All parse clean |
| `node --test mockup/dock-layout.test.cjs` | **13/13 pass**, 0 fail — matches the documented claim |
| `git diff --check` | Clean (line-ending conversion notices only, as HANDOFF §11 records) |
| Fixture counts vs HANDOFF §11 | Verified: 6 Agents, 3 templates, 9 chats, 10 runs, 2 approvals, 2 grants, 4 providers, 4 notifications, 8 tools, 6 tool-history rows, 2 projects, 3 schedules |
| A11y spot-checks in CSS | `:focus-visible` 2px ring (`styles.css:136`), `prefers-reduced-motion` (`styles.css:529`), aria-live polite/assertive hosts (`index.html:27-28`) present |
| Working tree | Unchanged by the audit; matches the pre-audit `git status` snapshot |

## 3. Verified conformance highlights (evidence in code, not just docs)

| Rule (source) | Evidence |
|---|---|
| Wordmark hierarchy "pack → operations → agents"; no retired nouns (D44) | `views.js:94`; grep clean |
| Sidebar exactly Agents + Operations; Agents "+" → settings not creation; templates vs active chats groups; pinned-pack footer label, no switcher (D41/D40/PRD §4.1) | `views.js:133-171` |
| Six persistent direct chats; one identity per Agent everywhere (D39, AC3) | `data.js:23-76`; `views.js:1081` |
| Preview gate, eight required groups, launch/cancel only (D30, AC6/AC23) | `views.js:934-997` |
| Approval fields (tool, arguments, target, side effect, expiry) + five choices **verbatim** + reminder timeline + mute-copies + immutable decisions (PRD §8, D9, AC13) | `views.js:535-571`; `approval-dark.png` |
| Risk ladder: read-only auto, mutation diff-preview, exec command/workdir/policy, repo mutation gated (D35, AC26 shape) | `data.js:226-244`; `views.js:440-464` |
| D8 run states incl. RECOVERY_REQUIRED; retries bounded ×3; cancel stops tree, logs preserved | `data.js:136-157`; `views.js:74-85` |
| Credits reserve/settle; custom providers "no Shera credits"; pause-before-model-call (D20/D21) | `views.js:1114-1134` |
| Memory provenance, publication queue, secrets-rejected copy (D37, AC27) | `views.js:1190-1207` |
| Recovery banner "resumed from its last safe step"; storage ≥80% warn; offline banner copy; replay boundary marker (PRD §§12–14, D32/D33) | `views.js:200-215, 424` |
| Pack pin chip in Operation header (AC22); multiple independent runs (AC24); @-addressing; read-only terminal/browser; lease tooltip (D6) | `views.js:627-650, 780-931` |
| S12 admin absent with deferral notice (E7) | `app.js:117-123` |
| Tier table matches PRD §3.3 exactly; backups 6h/keep-7; masked credentials throughout | `views.js:1231-1236, 1249-1255`; `data.js:190-197, 246-255` |

## 4. New findings (recorded; none previously documented in this exact form)

**F1 — Fixture rosters contradict decision D43 (most substantive).** D43 requires each of the six Agents reused across **at least two** of the three Operations, with "Researcher in Research Paper and Exam Preparation" as the named example. The fixtures give Researcher, Developer, and Study Planner **one** Operation each (`data.js:78-134`), and Exam Preparation's roster excludes Researcher. With 3 roster slots × 3 Operations (9 slots), the ≥2-each rule (≥12 slots) is arithmetically impossible. REFERENCE §4 disclaims certification, and the complete pack mapping is an open item in TRACEABILITY — but the current fixture **cannot** be reconciled with D43 as written. Durable resolution is a drafted compliant roster recorded per the PRD §24 process, not a silent `data.js` edit.

**F2 — No native Google adapter anywhere in the providers fixtures** (PRD §9; UI_DESIGN S9 lists built-in OpenAI/Anthropic/**Google**). `data.js:190-195` and both model-override dropdowns (`views.js:613-621`, `views.js:1032`) lack any Google entry.

**F3 — Custom-provider form misses PRD §9 fields:** no optional organization/project field, no enable/disable toggle, no per-agent/per-conversation assignment control in the form (`views.js:1098-1112`; assignment exists only as the chat-header override). Display name, protocol, base URL, key/no-key placeholder, model id, headers/params, and connection test are present.

**F4 — No in-chat stop/cancel for an active run.** UI_DESIGN S3 expects a stop control in the conversation; the only cancel control is the Overview "Live run" card (`views.js:409-412`).

**F5 — S1 lacks its specified loading (button spinner) and redacted-error states;** only the cap variant exists (`views.js:218-238`).

**F6 — Ad-hoc created chat lacks the collapsible roster/skills/connectors summary** required by UI_DESIGN S6 (`views.js:1000-1041` form; `op-adhoc` thread has none).

**F7 — Memory section is thinner than UI_DESIGN S9's Memory row:** no per-scope breakdown (account/workspace/Operation/task/Agent-private), no version restore, no disable-auto-memory (global/per-Agent) toggles (`views.js:1190-1207`).

**F8 — Chat text-size setting (user-selectable 12–18px, UI_DESIGN §2.1) is absent;** breakpoints diverge from the spec grid 360/768/1024/1440 — mockup uses 900/768 (`styles.css:534-537`) and 1280/980/760 (`screens.css:622-638`). REFERENCE §12 flags divergence generically; these are the specifics.

**F9 — Fixture inconsistencies a careful client will notice:**
- Notification n3 title "Run failed" while run-4 is RETRYING; body says "paused after retry 2 of 3" (`data.js:155, 202`) — REFERENCE notes the mismatch; recorded here for the fix list.
- run-3's note says "**calendar** export needs your approval" while its approval appr-2 is `docx.export` to the shared folder (`data.js:143-144` vs `data.js:172-182`).
- The launch toast claims "run-4 created from the preview" for Research Paper while fixture run-4 belongs to `op-adhoc` with a different goal (`app.js:265` vs `data.js:155`).
- Overview "Up next" schedule times (02:00–04:00 pm, 06:30 pm) contradict the SCHEDULES fixture (Mondays 07:00) and include an event not in the fixture (`views.js:373-385` vs `data.js:220-224`).
- `runStateChip` hardcodes "Retrying · 2 of 3" for any RETRYING run (`views.js:78`).
- The fixture user carries a realistic personal-looking Gmail address (`data.js:9`) — swap before client demos.

**F10 — Sidebar "failed" state never demonstrated.** PRD §4.1 names five sidebar states; the fixtures exercise unread, running, approval-required, and completed but never failed (no FAILED run or chat is seeded; the chip exists at `views.js:80`). Relatedly, UI_DESIGN §9.3's fixture list calls for FAILED **and** PAUSED runs; neither is seeded (`data.js:142-157`).

## 5. Acknowledged divergences — documentation verified accurate

All of the following are already documented in the mockup's own docs and were **confirmed true in code**: post-login Overview landing instead of chat-first S2 (`app.js:252`; recorded in `docs/README.md`); light theme + softened palette vs dark-only landing-token spec (`styles.css:13`); nested-route link dead ends for launch/create/notifications/recovery/S2-shortcut/demo-fallbacks (`chatById` `views.js:66` matches only flat IDs; screenshot `launch-broken-route.png` confirms); `esc()` stringifies without escaping (`views.js:67`); approve never appends to GRANTS (`app.js:367-375`); empty `data-stop` branch lets interior modal clicks bubble to backdrop-dismiss (`app.js:698-700`); Settings deep-links override category clicks (`app.js:102-106`); editor textarea editable despite the Developer lease (`views.js:840-847`); FAILED/PAUSED unseeded; scripted replays/grants/tests are display-only; `#/preview/<id>` direct entry unreliable; approval focus/shortcut targeting is global; roster editing, editor save, memory mutations, uploads, searches are toast-only or inert. The 2026-09-13 baseline audit and pane verification remain the detailed evidence for these.

## 6. Recommended fix order (recommendation, not an adopted decision)

1. **Route contract** — normalize `chatById` or fix the ~8 nested-route emitters; one fix repairs launch, creation, all notification links, recovery banner, S2 shortcut, and demo fallbacks. Highest visibility, low effort; the launch → chat path is the D30 story and every demo currently dies there.
2. **`esc()` context-safe rendering + regression test** — any `<input>` in the composer mangles the thread today; developers will paste code at a coding-assistant demo.
3. **Approval dialog integrity** — fix the `data-stop` bubble-dismiss and scope focus/number-key targeting to the open dialog before any cosmetic work (HANDOFF: consent UI with the wrong active target is unsafe).
4. **Approve → grant → repeat (AC26)** — append a visible grant on approve and clear stale badges/threads so the differentiator demos truthfully.
5. **D43-compliant roster mapping** — draft a ≥2-each six-Agent mapping and record it (or record its provisional status) per PRD §24; do not silently reshuffle fixtures.
6. **Fixture truthfulness pass** — F9 items + F2 Google adapter; one-line edits, high client credibility.
7. **Settings/provider surface gaps** — section-navigation stickiness; F3 form fields; then the accessibility/mobile/contrast sequence already fixed by UX_RECOMMENDATIONS §12.

**Guardrails (from HANDOFF §9 / PRD §24):** the five approval choices, the preview's eight groups, the two-section sidebar, vocabulary, and preview gating are fixed by decisions — repairs must not simplify them. Anything altering user-visible scope (the roster mapping is the borderline case) gets a dated note in HANDOFF and, where it touches product scope, a decision record and traceability update.

## 7. Change record for this audit

Documentation only: this file, an index line in the folder README, appended rows in HANDOFF §7, a dated HANDOFF §12 entry, and a description extension in the mockup README's review-archive row. No application source, PRD, decision record, TRACEABILITY row, or acceptance status was touched.
