# Future-agent handoff: Shera Bot mockup

**Updated:** 2026-09-13
**Scope:** local static client mockup, its review evidence, and the subsequent pane interaction enhancement.
**Do not infer:** backend implementation, production readiness, adopted redesign, new product decisions, or a clean/committed working tree.

## 1. Read in this order

1. Root [AGENTS.md](../AGENTS.md), [documentation index](../docs/README.md), [PRD](../docs/PRD.md), [decision index](../docs/decisions/README.md), [glossary](../docs/GLOSSARY.md), [traceability](../docs/TRACEABILITY.md).
2. [UI_DESIGN.md](../docs/UI_DESIGN.md): target client specification, not proof that every feature exists here.
3. [Mockup README](README.md): serving, scope and immediate limitations.
4. [REFERENCE.md](REFERENCE.md): all screens, controls, fixture IDs, actual statuses, state and source locations.
5. [UX_RECOMMENDATIONS.md](UX_RECOMMENDATIONS.md): proposed calmer first-use experience, not implemented.
6. [Independent audit](reviews/2026-09-13/design-audit-localhost-2026-09-13.md) followed by [pane verification](reviews/2026-09-13/pane-verification-2026-09-13.md). The latter updates only tested pane-related baseline findings.

Historical caveat: `docs/history/2026-09-08-to-2026-09-11/README.md` is referenced by older documentation but absent from the working tree after commit `9d8b81c`. The prior session located archived material in Git at `cea3ba1` and local raw exports under `.session-archive/`. Check availability yourself; read relevant full evidence before relying on an old summary. Do not restore, rewrite or invent missing archives as part of ordinary mockup work.

## 2. User requests and authority

Evidence source: this ZCode conversation, session `sess_9a661b81-4293-4c56-9be3-a4f2315ac103`, 2026-09-13. Excerpts below are preserved verbatim; they are excerpts, not a fabricated full transcript.

- Review request: “run an independent review of this mock from investor and customer or client point of view. ne neutral and true, dont tell lies.”
- Pane request: “in the workspace right pane. i want them to be expandable and collapsable. meaning. i want to point the mouse in the intersection of panes. and grag to make it stretch or not stretch. like claude code side panel.”
- Client goal: “as i want the ui to be easiar to understand for the client. for the first client view it will be easiar to work with.”
- Documentation request: “what improvement needed for the ux to look better. so that nobody gets overwhelmed when they land. and also keep everything documented of what you did and all the things this mockup contains in detail. so that future agent can use .”

The pane interaction was explicitly requested and implemented locally. The latest request called for UX assessment and documentation; **no broader landing redesign was implemented**. Recommendations are not approved product decisions. No D46 or other new product-decision ID was created, and the PRD/traceability acceptance statuses were not changed.

## 3. Work completed and what remains unchanged

### Existing baseline

- `32a897d`: product/UI design documentation and design skill addition.
- `fca3090`: full static UI mockup, S1–S11 plus Overview, with light/dark styling.
- The mockup is plain HTML/CSS/JavaScript, not the planned Next.js client.

### 2026-09-13 review

- Separate investor and first-client source reviews, plus main-agent browser checks.
- Frameworks: Nielsen heuristics, Shneiderman golden rules, WCAG2.2, recognition/recall, Hick/Fitts, grouping and progressive disclosure.
- S1–S11 source coverage, all fifteen Settings sections, eight panels, six direct chats and three existing Operation chats.
- Browser evidence for launch dead end, Settings navigation, first-landing hierarchy, approval layout, panel density and phone clipping.
- No invented customer sentiment, traction, conversion numbers, task timings or numerical usability score.
- Original reports/screenshots were stored in `.gstack/design-reports/`. This documentation pass **copied**, not moved/deleted, all sixteen existing report/evidence files into [reviews/2026-09-13](reviews/2026-09-13/README.md). Fourteen are PNG screenshots, two are Markdown reports.

### 2026-09-13 pane implementation

Changed application files from the baseline:
- `app.js`: pointer/keyboard resizing, dock-only updates, in-memory workspace snapshots and layout measurement.
- `views.js`: `DockLayout`, named separators, per-panel collapse controls, resize alternatives, empty/current-chat timeline guards.
- `screens.css`: splitter affordances, minimum geometry, collapse/stack/sheet behavior.
- `index.html`: versioned changed script/style URLs after observed stale cache.
- Added `dock-layout.test.cjs`; updated README.

Implemented outer dock width, inner column widths and row heights; Collapse/Expand; Maximize/Restore; Reset layout; keyboard and click-based alternatives; draft retention in verified pane operations. Existing full-page links and read-only terminal/browser intent remain.

Not implemented: arbitrary panel reordering, floating windows, a joint two-axis intersection handle, durable saved layouts, actual file saving, new onboarding, backend execution or global UX fixes. The requested stretch/shrink outcome is implemented through the individual row/column boundaries.

### This documentation pass

Added the detailed [reference](REFERENCE.md), [UX recommendations](UX_RECOMMENDATIONS.md), this handoff, durable dated review evidence and its index. Corrected current README overclaims while recording the corrections below. Added root/documentation entry links so future agents can discover this material.

Only documentation/evidence files changed in this pass. Existing uncommitted application edits were preserved. No commit or push was requested/performed.

## 4. Run and verify

From repository root:

```sh
python -m http.server 8000 --directory mockup
```

Open `http://localhost:8000/index.html`. Useful known-good inspection paths:
- `#/agent-general-assistant`: starts with dock closed; open Files and add panels.
- `#/agent-developer`: seeded runs/terminal dock on desktop.
- `#/op-research-paper`: existing Operation with approvals, runs and artifacts.
- `#/settings/providers`: inspect provider UI directly despite the section-navigation defect.

If port8000 is occupied, inspect the listener/service first. Do not stop an unknown process. Use a different explicit port and matching URL if needed. The earlier session started a Python server in the background; a later session must verify that it is still running.

```sh
node --check mockup/app.js
node --check mockup/views.js
node --check mockup/dock-layout.test.cjs
node --test mockup/dock-layout.test.cjs
git diff --check
```

The recorded result is thirteen passing pane tests. Run them again after changes. They test pure helpers/rendered markup in a VM, not real browser interactions or the full runtime. Do not confuse them with the terminal fixture showing fourteen tests passed.

Before changes, run `git status --short`, inspect the diff, and preserve user work. The last known branch was `main`, with pane/docs changes uncommitted; neither that branch nor status should be assumed in a future session.

## 5. Browser acceptance evidence

Environment: Windows; ZCode3.11.2 in-app browser; Chromium146.0.7680.80 / Electron41.0.3. See the dated verification report for exact screenshots and measured values.

Verified with real browser actions:
- Files collapses to46px and expands; unsent chat draft survives.
- Outer keyboard Left changed width440→456px.
- Horizontal drag produced280px/170px panels.
- Outer physical drag widened440→720px with sidebar rail.
- Four-panel column drag produced approximately384.5px/304.5px columns.
- Editor text survives collapse/expand, maximize/restore and close/re-add.
- Click-based sizing widened720→768px; Reset restored440px and retained panel membership/editor text.
- Empty General Assistant timeline displays a safe message.
- Dark single-panel rendering; phone390×844 workspace sheet; outer handle hidden on phone.

Not verified exhaustively: Firefox/Safari/Edge, screen reader, real touch/pen hardware, drag cancellation/Escape, every pane permutation, full-page/context draft synchronization,200% text zoom, complete keyboard focus behavior, or a comprehensive console audit. Do not mark existing AC20 or runtime criteria complete from these checks.

## 6. Failed attempts and operational lessons

- The original browser tab sometimes returned to blank, lost in-memory scenario state, or timed out on input while DOM reads still worked. A programmatic click was used diagnostically, **not counted as physical-input acceptance**. A fresh independent tab subsequently passed the real actions.
- Reloading the root URL retained stale scripts. Current script URLs were inspected, assets versioned, and the explicit `index.html` entry used. If controls are missing, verify loaded assets before assuming implementation failure; hard-refresh when appropriate.
- An approval Escape test failed in the harness because the expected focus target had changed. The audit does not label that as proof that Escape itself is broken; the source and snapshot independently show focus-scoping problems.
- Supplementary agents later hit provider rate limits. Completed findings were retained, and the main agent finished documentation/verification directly. In this documentation pass, both delegated tasks failed before completing their deliverables; the main agent inspected source and authored the inventory/recommendations.
- No broad automated browser suite existed. Focused Node tests were added; unrelated marketing CI/testing was not repurposed.
- Browser test state and pane preferences are in memory. A refresh/reset means a scenario must be rebuilt; it does not establish a persistence regression because durable pane storage was never implemented.

## 7. Known problems: preserve until individually resolved

| Area | Current problem / evidence |
|---|---|
| Core navigation | Flat chat routes versus nested generated links. Launch, creation, notifications and recovery are affected. Browser-confirmed launch dead end. |
| Launch/create | Selected template/form values ignored; no real Operation/run/reservation creation despite success copy. |
| Settings | Section-specific hash overrides category selection; browser confirmed. Most controls inert or toast-only. |
| Approval safety | Global focus/shortcut targeting, incomplete dialog containment, interior-click dismissal, no new grant insertion, stale badges/thread/notifications. |
| Output access | Artifact Open/Download, attachments and file-tree actions incomplete; editor Save toast-only. |
| Input/state | `esc` does not escape HTML; mention picker overwrites drafts; ad-hoc roster edits reset form values; one global streaming timer. |
| Timeline | Empty/current-chat guard fixed; global selection and click-based native selects still need broader correction/testing. |
| Visual/accessibility | Faint-text contrast, tiny labels/targets, hidden rail names, mobile Settings clipping, dialog separation/focus and announcements. |
| First arrival | Overview/seeded warnings dominate rather than a clear first useful task. |
| Runtime claims | Mock login, provider tests, tool output, replay, grants, costs, memory and resources are not real execution. |
| Pack content (F1, 2026-09-13 audit) | Fixture Operation rosters give Researcher, Developer and Study Planner one Operation each, contradicting D43's "each Agent reused across at least two Operations" (its example even places Researcher in Exam Preparation); with three roster slots per Operation the ≥2-each rule is arithmetically impossible. Resolution belongs in a recorded mapping/decision, not a silent `data.js` edit. Evidence: [docs-conformance audit](reviews/2026-09-13/docs-conformance-audit-2026-09-13.md) §4 F1; `data.js` OP_TEMPLATES; `docs/decisions/closure-decisions.md` D43. |
| Providers (F2/F3, 2026-09-13 audit) | No native Google adapter in fixtures or override dropdowns (PRD §9, UI_DESIGN S9); custom-provider form omits organization/project, enable/disable and per-agent/per-conversation assignment. Evidence: audit §4 F2–F3; `data.js` PROVIDERS; providers settings section. |
| Chat controls (F4, 2026-09-13 audit) | No stop/cancel for an active run inside the chat — only the Overview "Live run" card has one; UI_DESIGN S3 expects an in-thread stop. Evidence: audit §4 F4. |
| Login states (F5, 2026-09-13 audit) | S1 loading (button spinner) and redacted-error states absent; only the cap variant exists. Evidence: audit §4 F5. |
| Spec-detail gaps (F6–F8, 2026-09-13 audit) | Ad-hoc created chat lacks the S6 roster/skills/connectors summary; Memory section lacks per-scope breakdown, version restore and auto-memory toggles (S9); chat font-size setting (12–18px) absent and breakpoints are 900/768/1280/980/760 vs the spec's 360/768/1024/1440. Evidence: audit §4 F6–F8. |
| Fixture truthfulness (F9/F10, 2026-09-13 audit) | Notification n3 "Run failed" vs run-4 RETRYING; run-3 note says "calendar export" while appr-2 is `docx.export`; launch toast claims run-4 for Research Paper while fixture run-4 belongs to op-adhoc; Overview "Up next" times contradict the SCHEDULES fixture; `runStateChip` hardcodes "Retrying · 2 of 3"; fixture user email resembles a real personal address; sidebar "failed" state and FAILED/PAUSED runs (UI_DESIGN §9.3) never seeded. Evidence: audit §4 F9–F10. |

Status changes belong in a dated verification entry with reproduction, code boundary and evidence. Do not delete a baseline finding because the latest screenshot looks better.

## 8. README corrections made during documentation

The prior README is preserved in Git/history and in this conversation's evidence; these statements were corrected in the current entry guide:

| Earlier claim | Verified correction |
|---|---|
| App lands chat-first; Overview reached from wordmark | Current login goes to Overview; wordmark is not a link. S2 exists at `#/app`. |
| Approving creates a visible runtime grant | Approval changes local display/run state; `GRANTS` is not appended. Only pre-existing fixture grants can be removed. |
| Replay batch occurs on reconnect | Connection state changes after a timer; no event replay exists. |
| Fixtures cover every run state | State renderers exist for several states; initial `RUNS` does not seed every supported state. |
| Views are pure functions | Several read `App.state` directly. |
| No dependencies/network | No installed application packages/build step; Google Fonts still loads over the network. |
| Read-only live terminal/browser | Rendered fixture output/HTML placeholders, not live services. |

Earlier owner-direction/style claims in the README were historical context, not newly revalidated design approval. Current docs describe the palette as a mockup exploration and defer product adoption to the existing authority rules.

## 9. Safe continuation boundaries

- Implement against current source, not the screenshots alone. Use [REFERENCE.md](REFERENCE.md) for stable function names and route IDs; old report line numbers are baseline-specific.
- Do not edit PRD or mark acceptance coverage complete merely to match mockup fixtures.
- Keep two sidebar sections, same-Pack Agent identity, independent Operation runs, preview gating and five approval choices.
- Do not introduce real billing, workspace switching, browser/terminal takeover, new autonomous behavior or a new persistence guarantee while “simplifying UX.”
- Improving layout/copy within approved behavior is delegated visual design; changing scope, roles, safety, tenancy, persistence or acceptance requires recorded product evidence and traceability per PRD§24.
- Never enter real credentials or confidential material into this static mockup. Existing text rendering is unsafe; provider fields do not implement secure custody.
- When a future user requests the calmer landing implementation, use the prioritized recommendations, repair core journeys first, and add honest empty/returning/demo states. Do not infer that this documentation request already authorized that rewrite.

## 10. Keep documentation current

When changing a feature:
1. Update its row/status in `REFERENCE.md` and relevant README instructions.
2. Record what changed, why, evidence source, files, commands/results and untested limits in a dated handoff/review entry.
3. Preserve previous findings and failed attempts; append dispositions instead of erasing them.
4. Add/update targeted regressions; distinguish source checks, VM tests, browser observations and real backend evidence.
5. Link screenshots relative to the review folder; retain original evidence rather than silently retouching it.
6. If adopting a product change, follow decision records and traceability separately; recommendation IDs are not product-decision IDs.

These documentation steps are maintenance guidance, not new product acceptance criteria.

## 12. Docs-conformance audit entry (2026-09-13, later the same day)

A separate read-only session audited the mockup source and documentation against `docs/PRD.md`, the decision records (incl. D40–D45, E1–E8), `docs/GLOSSARY.md`, `docs/TRACEABILITY.md` and `docs/UI_DESIGN.md`. Recorded in [reviews/2026-09-13/docs-conformance-audit-2026-09-13.md](reviews/2026-09-13/docs-conformance-audit-2026-09-13.md).

- **Verified conforming:** vocabulary clean (no Expert/Scene/group chat/task chat in code); sidebar two-section model; six persistent Agent identities; preview's eight groups and gate; five approval choices verbatim with the reminder sequence; D8 run-state labels; risk-tier ladder; credits reserve/settle copy; memory publication boundary; recovery/storage/offline copy; pack pinning; tier table; backups 6h/keep-7; masked credentials.
- **Checks re-run, all green:** `node --check` × 3; `node --test mockup/dock-layout.test.cjs` 13/13; `git diff --check`; fixture counts match §11.
- **New findings** are appended as rows in §7 above (F1–F10), the most substantive being the D43 roster conflict. The audit also confirms every previously documented defect is still accurate in code (nested routes, `esc()`, approval grant insertion, `data-stop` bubble, Settings navigation, lease-not-enforced, unseeded FAILED/PAUSED).
- **Recommended fix order** (routes → safe escaping → approval dialog integrity → grant demo → recorded roster mapping → fixture truthfulness → settings/provider gaps) is a recommendation, not an adopted decision.
- **Documentation-only pass:** no application source, PRD, decision record, TRACEABILITY row or acceptance status was changed. The working tree already carried uncommitted pane/documentation changes before this entry; those were preserved.

## 11. Documentation-pass verification

Completed on 2026-09-13:
- Checked 86 relative file/directory links across the current README/index, handoff, reference, recommendations and review index: no missing targets. This check did not certify Markdown fragment anchors or legacy external machine paths inside preserved reports.
- Confirmed all sixteen copied review/evidence files match their originals byte-for-byte; SHA-256 hashes are recorded in the review folder.
- Executed fixture-count checks against current scripts: six Agents, three templates, nine chats, ten runs, two approvals, two grants, four providers, four notifications, eight tools, six tool-history rows, two projects and three schedules.
- Reran `node --test mockup/dock-layout.test.cjs`: thirteen passed, zero failed.
- `git diff --check` passed. Git emitted line-ending conversion notices, not test failures.
- No browser checks were repeated in the documentation-only pass; browser results above remain attributed to the earlier pane verification.
- Documentation and evidence remain uncommitted/unpushed, together with the prior pane implementation changes.

## 13. Agent profile panel entry (2026-09-13, later the same day)

User request (this conversation, verbatim intent): in the first chat interface's right pane, the **Agent profile** should be the initial default panel — Telegram-inspired, scrollable, with 3–6 primary buttons, then other information, then collapsible profile file structure, ongoing tasks/sessions and session history.

### Changed application files

- `data.js`: added `AGENT_SESSIONS` per-Agent sample session fixtures, consistent with the existing thread/run scenarios.
- `views.js`: added `profile` as the first `DOCK_PANELS` entry; new `profileBody`/`operationProfileBody`/`profileActions` renderers wired through `dockBody` (now exported, with a `fullPage` flag); direct-chat header identity is now a `profile-open` button; `workspaceFull` passes `fullPage` so the panel swaps dock-only actions for links.
- `app.js`: all six Agent chats seed the dock open at 440px with `profile`; Operations keep the Research Paper seed; `dock-toggle` empty-dock default for Agent chats is now `profile` (was `files`); new actions `profile-open`, `profile-message`, `profile-mute` (in-memory `state.profileMuted` with honest toast), `profile-new-run` (shared `startQueuedRun` helper with `new-run`); `state.focusComposer` restores composer focus when Message is used from full-page mode; `afterRender` consumes it.
- `screens.css`: Telegram-style profile card styles (`.prof*`, `.pa-*`, `.chat-id` header button) using existing tokens; no new animation beyond the existing `pulse` keyframe.
- `index.html`: **all** local assets now carry `?v=20260913-profile2` — `data.js`/`icons.js`/`styles.css` were previously unversioned, which reproduced the documented stale-cache failure during verification (page loaded old `data.js`, render threw `AGENT_SESSIONS is not defined`, blank app until cache-busted reload).
- `dock-layout.test.cjs`: four new tests (profile quick actions/sections, mute state + ongoing runs, Operation roster variant, header/full-page exposure). Suite is now **seventeen** tests, all passing.

### Behavior notes and dispositions

- The Developer chat no longer seeds runs/terminal; it opens with the profile like every Agent chat. This **supersedes** the §5 pane-verification row that referenced the seeded runs/terminal Developer dock as a starting point — that evidence remains valid for what it tested (panel sizing/drag), not for today's initial layout.
- Profile info rows are readouts from existing fixtures; session history is explicitly labelled "Sample session history — mockup fixture, not a runtime log". Mute does not claim delivery changes; the toast says the preference is in-memory only. No new persistence, no new product decisions (recommendation IDs and PRD statuses untouched).
- The profile panel in an Operation chat shows a roster/outputs/connectors summary so the ninth tab is not broken in full-page mode; mute/message are Agent-level and absent there.

### Verification (2026-09-13, in-app browser Chromium, 1440×900 and 800×900)

- `node --check` on `data.js`/`views.js`/`app.js`/test file: clean; `node --test`: 17/17 pass.
- Browser-verified: GA chat opens with dock 440px + profile panel (avatar 84px, six quick actions, three collapsible sections, scrollable body 594/908px); Mute flips label/`aria-pressed` with toast; Files quick action adds the Files panel; closing the dock then clicking the header identity reopens it with the profile retained; Study Planner profile lists run-t1 "Waiting approval" under Ongoing tasks plus two session entries; General Assistant shows the honest "No active task runs" empty state; Message quick action focuses `#composer-input`; light and dark themes both render; 800px initial load keeps the dock closed.
- Screenshot artifacts recorded in the session transcript (dark GA, light GA, Study Planner filled profile). Not stored in `reviews/` because this pass reused the live server rather than the evidence-archive flow; the transcript quotes measured values.
- Not verified: real touch/pen input, screen readers, 200% zoom, Firefox/Safari/Edge, Escape during profile interactions, six-panel cap edge cases via the profile path, or the full-page profile tab in a live browser (covered by VM test only).
- Cache lesson reinforced: after editing **any** mockup asset, bump every version query in `index.html`; unversioned scripts silently served stale fixtures.

## 14. Sidebar de-smelling pass (2026-09-13, later the same day)

User request: "lets fix the left side panel. the design smells. and suggest changes."

### Assessment recorded (smells found)

1. Asymmetric grouping: `active chats` had a sub-label, templates had none, and both used identical row styling — "Research Paper" appeared twice looking nearly the same.
2. Cryptic `+` buttons: Agents had a bare, unnamed `+` that actually opens Agent Settings; Operations had `+ New`.
3. Footer mixed a demo control ("simulate connection change") into real status indicators; three cramped rows with a 10.5px uppercase pack label wrapping to three lines.
4. Structure "whispered": 10.5px mono uppercase eyebrows/group labels in the faint color (known contrast defect).
5. Rail mode dropped item names from the accessibility tree and lost all section structure (documented defect).
6. Active-item accent bar floated outside the row (`left:-12px`).
7. Wordmark tagline duplicated the footer pack info as a third micro-label vocabulary.

### Changed files

- `views.js`: `brandRow` tagline removed; Agents section head is now a gear button (`aria-label="Agent settings"`, honest tooltip kept); Operations adds a `Templates` group label and renames `active chats` → `Active chats`; footer reworked — connection is a text chip (Live/Reconnecting/Offline), storage shows `% of 25 GB`, pack label is one readable line (`student pack v1 · pinned` with a title tooltip), and the redundant footer connection-demo button was **removed** (the same `toggle-conn` demo remains in the Demo menu).
- `data.js`: `USER.storageTotal: "25 GB"` added instead of hardcoding the total in markup (keeps account-section copy consistent).
- `styles.css`: eyebrow/group labels bumped to `--muted` 11px; `.sb-add-icon` variant; active accent bar moved inside the row; new `.conn-chip`/`.storage-text` styles; rail mode now uses a visually-hidden (not `display:none`) name so links keep accessible names, plus a section divider; rail hides the new text chips.
- `dock-layout.test.cjs`: new sidebar test (group labels, aria-labels, pack label, no demo control in footer). Suite is now **eighteen** tests, all passing. Asset versions bumped to `?v=20260913-sidebar2`.

### Verification and harness notes

- `node --check` clean; `node --test`: 18/18; `git diff --check` clean (line-ending warnings only).
- Browser-verified on a fresh tab after the known blank-tab failure recurred (tab returned to `about:blank` mid-check; recovered per §6): expanded sidebar shows the new grouping/labels/footer in dark theme; rail shows avatars + divider + compact footer; an accessibility read confirmed full item names present in the tree while in rail mode.
- Rail toggle needed the documented **diagnostic programmatic click** — physical clicks timed out on input while DOM reads worked (same as §6); that toggle is therefore not newly counted as physical-input acceptance. The collapse control itself was physically clicked successfully earlier in the same session before the tab blanked.
- Not verified: light theme for the sidebar pass (token-only changes, low risk), screen readers, 200% zoom, drawer behavior at <=768px.
- Deliberately **not** done (needs product decisions per PRD §24 / UX_RECOMMENDATIONS): merging template launch rows into a single picker, moving credits/storage into the Account menu, changing badge semantics, or reordering the two sections. The two-section sidebar and all six Agent identities remain intact.

## 15. Floating shell + ambient field pass (2026-09-13, later the same day)

User request: make the left sidebar floating "like the right sidebar", extend a slight floating theme, add a subtle non-distracting background movement in both themes; asked for a doability analysis first. Run under the `impeccable` skill (context loaded; craft-floor and animate references followed; Operate mode).

### Doability verdict (delivered): yes — CSS-only

No routing, state or test-architecture change was required. The ambient field is a fixed, pointer-transparent layer with three radial-gradient blobs animated on `transform` only (compositor work, no layout/paint), which the existing stack expresses without dependencies.

### Changed files

- `index.html`: `.ambient` layer (`aria-hidden`, three `<i>` blobs) before `#app`; asset versions bumped (`?v=20260913-float2`).
- `styles.css`: `--glass-surface/--glass-line/--panel-shadow/--ambient-{a,b,c}` tokens per theme; ambient keyframes (64/82/96s ease-in-out alternate, translate ≤~6vmax, scale ≤1.14); `.app` gets `position:relative; z-index:1`; sidebar rebuilt as a floating glass panel (12px inset, 18px radius, backdrop blur + saturate, offset soft shadow, `@supports` solid fallback); topbar glass; drawer at <=768px now floats (10px inset, margin 0); global reduced-motion rule additionally stops the ambient loops explicitly.
- `screens.css`: chat header glass; dock column background `transparent` so panels float over the ambient field (banners and the composer card stay solid on purpose).
- `app.js`: `visibilitychange` toggles `body.tab-hidden` → `.ambient i { animation-play-state: paused }` (nonessential loops stop when hidden).
- Active nav item: the 3px side stripe (`.sb-item.active::before`) was **removed** — the gradient fill alone carries the active state — and `.prof-sess .ps-dot.active` lost its pulse (static dot). Both were impeccable-detector findings on rules this session owned; the remaining detector findings (`--glow` on the login logo, a hatch-texture advisory) are pre-existing brand/texture language and were deliberately kept.

### Verification

- Dark + light themes inspected at 1440×900: floating glass sidebar, ambient field visible but calm, dock panels float; 390×844: dock sheet intact, drawer offscreen (`left:-305px`); active nav state still clearly visible without the stripe; detector re-run: owned findings cleared.
- `node --check` clean. `node --test`: **16/18 — see the concurrent-work warning below**; the 2 failures are in DockLayout sizing assertions changed by separate in-flight work, not by this pass (this pass touched no views.js logic).
- Untested: real reduced-motion emulation, other browsers, drag performance profiling, 200% zoom.

### Concurrent work observed in the tree (not mine, left untouched)

During this pass `views.js` gained an in-flight **dock fill** feature from outside this conversation: `DockLayout.setOuterWidth/leaveFill` + `d.fill` handling, a `dock-back` "Back to chat" button in the dock head (`data-action="dock-chat"`), and a rewritten `widthBounds` without the 780px cap / 360px chat reservation. Wiring is incomplete: `app.js` still calls the old `widthBounds` pattern and has **no `dock-chat` action handler**, so "Back to chat" is currently inert, and the chat-reservation guarantee the old bounds enforced is not yet reimplemented. Consequences recorded honestly:

- `node --test` now reports **16/18**: "dock width bounds reserve 360px for chat and cap at 780px" and "width clamping does not mutate a saved preference" fail against the new `widthBounds`. The failing assertions belong to the fill feature's contract decision (update the tests when the feature settles) — deliberately not patched here to avoid cementing a half-wired design or colliding with in-flight edits.
- REFERENCE §8's "Sizes" line and the pane tests will need reconciliation when the fill feature lands. Do not treat the fill feature as accepted or reviewed; it appeared mid-session and its intent/authority are unrecorded.

## 16. Coherent two-panel floating shell (2026-09-13, later the same day)

User feedback with a light-theme screenshot: the floating sidebar clashed with the topbar/chat-header still reading as bands glued to the window edges — "find a slick different strategy to match the floating theme throughout the mockup… don't make it look unrealistic. inconsistent."

### Strategy adopted

Two floating panels on the ambient canvas (the Telegram-Desktop/Slack-2024 model): the sidebar keeps its floating glass card, and the **entire content area becomes one rounded glass sheet** — topbar, banners, chat header, thread, composer and dock all live inside it, separated by hairlines instead of competing solid strips.

### Changed files

- `styles.css`: `.main` is now a sheet (12px margins, 18px radius, `--glass-surface` fill, hairline border, `--panel-shadow`, `overflow: hidden`); `.topbar`/`.chat-head` backgrounds transparent (hairline only); glass tokens unified (dark `rgba(16,24,40,.66)`, light `rgba(255,255,255,.8)`); **all `backdrop-filter` removed** (the blobs are already soft gradients; blur added GPU cost for no visible gain and needed an `@supports` fallback — the `@supports` block was deleted); topbar/chat-header tooltips now open **downward** so the sheet's `overflow: hidden` cannot clip them.
- `screens.css`: chat header glass reverted to transparent.
- Asset versions bumped to `?v=20260913-float3`.

### Deliberate invariants

- Banners (recovery/storage) stay solid: they are semantic states pinned inside the sheet, not chrome.
- The dock sheet at ≤980px is `position: fixed` and therefore still escapes the main sheet's clipping — verified covering the viewport at 390px.
- Popovers/toasts render as siblings of the sheet and are unaffected.

### Verification

- DOM-verified computed styles (main 12px margin/18px radius/0.8 alpha; topbar/chat-head transparent; no backdrop-filter) in light and dark at 1440×900, plus 390×844 dock-sheet behavior. Screenshots in session transcript.
- Detector: only the two pre-existing, deliberately-kept findings remain (login glow, hatch texture). Tests: still 16/18 — the 2 failures belong to the concurrent dock-fill work (§15), unchanged by this pass.
- Untested: hover tooltip flip in a live browser (CSS-only change, low risk), screen readers, 200% zoom, login/overview/settings screens at narrow widths inside the new sheet.

## 17. Top-cleanup arc: three-panel shell, search palette, account menu (2026-09-13, evening)

User requests across four messages: clean up the chat top (remove the Resize panels disclosure), move user info into the chat topbar, raise the workspace controls to the absolute top, make the right sidebar a truly separate floating panel, move the model picker to the composer and later to the chat-top right corner, shrink search to an icon button opening a modal, fold theme/notifications/demo into the account menu, badge the avatar with the unread count — refined via `impeccable` (context, craft-floor, animate, polish references; Operate mode).

### Final structure (supersedes the intermediate states recorded in §13–§16)

- **Three sibling panels under `#app`:** sidebar | `.main` sheet (chat only) | `aside.dock` workspace bar. `chatScreen` no longer renders the dock; `render()` appends `V.dockView` after `.main`; `patchDock` inserts with `main.insertAdjacentElement("afterend", …)`.
- **Chat header** (one row): identity + workspace toggles left · search icon button · account avatar right. Model picker lives in the **composer bar** beside send (`.composer-model`, 30px compact select).
- **Resize panels** disclosure removed from the dock head; the split selector and ±/Equal controls now live at the bottom of the **Add panel menu** (`add-resize`). Drag + keyboard resizing unchanged. Recorded trade-off: the click/tap fine-tune path now requires opening the Add panel menu.
- **Account menu** (`accountPop`) gained rows: theme switch, Notifications (with unread chip — opens the notifications popover), Scripted demo — before the existing Profile/tier, Credits, Settings, Connection, Sign out. The topbar/avatar is now icon-only with the unread count as a badge on the avatar (`.tb-account .notif`, `position: relative` added).
- **Search modal** (`searchModal`, `state.searchOpen/searchQuery`): command palette over fixture destinations (6 Agent chats, 3 Operation chats, 3 templates via `open-preview`, Overview, Settings + six settings sections). Live-filter on input, Enter opens the first result, ↑↓ move focus, Esc/backdrop/X close, any navigation (`goto`, `open-preview`) closes it. Honest scope in the footer: searches chats/templates/settings — **not message contents**. Ctrl+F opens it (replacing the old focus-inline-input behavior); the Mac-style ⌘F badge and the "no results implementation" finding are thereby retired.
- **Modal dismissal repair:** the delegated click handler now returns early when the innermost `[data-action]` is an `.overlay` root and the click is inside a `[data-stop]` modal. This fixes the documented interior-click-dismissal defect for **all** modals (preview, approval, search) — nested controls keep working because they are the innermost match.
- The per-open-state cluster fallback (`render()` on dock-toggle etc.) from the intermediate pass was reverted to `patchDock` — the cluster is statically in the chat header again.
- Snapshot scope widened: `workspaceSnapshot`/`restoreWorkspace` now root at `#app` so dock-panel drafts survive the dock living outside `.chat-shell`. `layoutDock`/`resizeContext` use `dockAvailableWidth()` (app width − in-flow sidebar − 48px margins). Fill mode (`chat-collapsed`) now toggles on `#app` and the dock grows with `flex: 1`.

### Verification

- `node --check` × all; `node --test`: **25/25** (includes the concurrent session's fill tests and updated topbar/palette tests).
- Browser (DOM-verified): dock sibling of `.main` (`parentElement.className === "app"`); search centered between head zones when space allows; model picker in composer; avatar badge "3"; palette open → focused input, 6 quick destinations; filter "prov" → 1 hit; Enter navigates to `settings/providers` and closes; same-route Enter closes; interior click does not dismiss; Esc closes. Detector: only the two pre-existing, deliberately-kept findings (login glow, hatch advisory).
- **Visual confirmation limited:** the in-app browser's screenshot capture failed repeatedly at the end (known §6/§14 issue), so the palette's final look was verified via DOM measurements, not a screenshot. Worth one human glance.
- Untested: real keyboard-only walk of the palette, screen readers, Ctrl+F on login route edge, fill-mode visuals after the sibling restructure (concurrent WIP, noted in §15).

### Notes for future sessions

- `dock-chat`/fill-mode remains the concurrent session's in-flight feature (§15); it now hangs off `#app.chat-collapsed`. The "Back to chat" button only displays in fill mode (`.dock-back`).
- `goto` closes the search palette on every use — notification-popover links also pass through it (no behavioral change there).
- Asset versions: `?v=20260913-search3` at the time of writing; the concurrent session re-bumps versions periodically — always re-check `index.html` before blaming stale cache.
