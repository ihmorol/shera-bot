# Shera Bot — full feature QA pass (2026-10-04)

**Question asked:** what features were intended, is the build complete, is it shippable, and does every feature actually work? Everything found is tracked here so we can fix it later.

**Tester:** automated browser GUI pass (black-box, real clicks/keys in the ZCode in-app browser, 1280×720 and 390×844), plus the repo's own regression suite. No code was modified.

---

## 1. What the product was intended to be (per `docs/PRD.md`, D1–D51)

A private, local-first multi-agent assistant platform ("Pack → Operations → Agents"), Telegram-like web client. Intended feature surface (PRD §2–§19): Google-OAuth login with a 5-account cap; per-user containers with Balanced tier; 6 student-pack Agents as persistent direct chats; pack-defined Operations launched through a preview (8 information groups) plus ad-hoc Operations; workspace panels (files, editor, terminal, browser, task runs, tool history, private files); scoped expiring approvals with 5 choices and a fixed reminder ladder (immediate/15m/45m/3h/24h); providers/models incl. custom OpenAI-compatible endpoints; credit ledger; memory; schedules; Git worktrees/merge review; backups every 6 h keeping 7; restart recovery; notifications; admin capabilities via API (UI deferred, E7/D47). **27 acceptance criteria in PRD §19 define "done".**

## 2. What actually exists today

| Layer | State |
|---|---|
| `apps/web`, `apps/control-plane`, `apps/user-runtime` | **S01 scaffold only — placeholders, no behavior** (per root `README.md`). No runtime to ship. |
| `mockup/` | Static HTML/CSS/JS client covering S1–S11 of `docs/UI_DESIGN.md` + Overview. Scripted, no backend. This is the only testable "building". |
| `business-landing-portfolio/` | Marketing site, out of scope for prototype acceptance. |
| Mockup regression suite | `node --test mockup/dock-layout.test.cjs` → **27/27 pass** on 2026-10-04. |

So: of PRD §19's 27 acceptance criteria, **none can pass today** — AC1 (OAuth), AC2 (container), AC7–AC19 (runtime behaviors) have no implementation; the mockup only *illustrates* AC3–AC6/AC20/AC23 at the UI level.

## 3. Test results (browser GUI pass, T01–T30)

Environment prep: `python -m http.server 8000 --directory mockup` (port 8000 was free). Evidence screenshots in `output/qa-2026-10-04/screenshots/`.

| # | Test point | Result | Evidence |
|---|---|---|---|
| T01 | Login screen → "Continue with Google" → lands `#/app` with honest "Welcome back" toast | PASS | t01a/t01b |
| T02 | At-cap login variant ("Shera is at its cap", server-enforced cap copy) | PASS | t02a |
| T03 | Home screen's 3 shortcuts (Researcher chat / Research Paper preview / ad-hoc creation) all resolve | PASS | t03a |
| T04 | Sidebar: 6 Agents + Operations (Templates/Active chats), unread & status badges, credits, connection chip, storage meter, pinned pack label | PASS | t01b |
| T05/T06 | All six Agent chats render correct identity/role/fixtures; message send works; scripted reply streams; Enter sends, empty send ignored | PASS | t05a/b, t06b–g |
| T07 | All three Operation chats render (runs, retry scenario, recovery scenario, roster chips, tool history table) | PASS | t07a, t09c |
| T08 | Launch preview: all 8 groups (purpose/agents/skills/connectors/provider/credits/approvals/outputs); Cancel works; **Launch now navigates to the matching fixture chat, queues a real local run, honest "(mockup accounting)" toast** — the "broken route" recorded in REFERENCE.md is repaired | PASS | t08a–c |
| T09 | Ad-hoc creation: roster toggling works locally; zero-Agent refusal toast; coordinator options incl. "No coordinator — peer-to-peer"; **Create ignores entered values** (see F8) | MIXED | t09a–c |
| T10 | Approval card: fields, reminder ladder, 5 choices; Approve/Reject/Cancel mutate run state + honest toasts; modal variant; keyboard "5" = Cancel; mute = toast-only (honest) | PASS | t10a–d, t15b/c |
| T11 | Notifications popover (4 fixtures, honest delivery copy); Mark-all-read clears avatar badge | PASS | t11a/b |
| T12 | Search palette (Ctrl+F / icon): live-filters chats/templates/settings, Enter/Esc/↑↓, honest "not message contents" scope note | PASS | t12a/b |
| T13 | Theme: dark ↔ light via account menu; `shera-theme` localStorage restored before first paint; survives reload | PASS | t13a |
| T14 | Account menu: identity, theme, notifications, profile/tier, credits, settings, demo, connection simulate, sign out, storage | PASS | t14a/c |
| T15 | Demo menu: risky action → approval modal; disconnect → offline banner → reconnect toggle → "Reconnecting" → "Live" + "6 missed events replayed" toast | PASS | t15a–f |
| T16 | Settings: **all 15 sections render with URL sync**; Permissions revoke genuinely removes a grant; reminder policy matches PRD; provider list honest (unconfigured = Configure only); masked keys | PASS (1 defect, F11) | t16a–d |
| T17 | Dock: add-panel menu (9 types), 6-panel cap enforced, collapse/expand/maximize/reset controls present | MIXED (F12) | t17a/b |
| T18 | Full-page workspace `#/workspace/<chat>/<panel>`: all 9 tabs, deep-linkable, "Back to chat" | PASS | t18a |
| T19 | Banners: Review run → `#/op-exam-prep`; Clean up files → `#/settings/files`; both Dismiss buttons work | PASS (F13 copy note) | t19 |
| T20 | Overview dashboard (KPIs, run activity) | PASS (stale KPIs, F4) | t20 |
| T21 | Non-alias nested route → honest "Nothing here" fallback incl. admin-deferral note | PASS | t21 |
| T22 | Wordmark is not a Home link (by design); unknown routes never crash | PASS | t21 |
| T25 | "New run" appends queued run to thread + runs panel | PASS (copy defect, F6) | t25 |
| T26 | Artifact "Open"/"Download" buttons | **INERT — no feedback at all** (F10) | DOM-verified |
| T27 | Editor: typing works, Save = honest toast (no persistence), text retained across panel/tab switches | PASS | t27 |
| T28 | Per-conversation model picker changes nothing (presentation control, as documented) | PASS (mockup limitation) | DOM-verified |
| T29 | Mobile 390×844: no horizontal overflow; dock sheet; chat readable; settings grid OK | MIXED (F14) | t29a–c |
| T30 | Empty/whitespace send ignored | PASS | DOM-verified |

## 4. Defects & findings (tracked, fix later)

Severity: **P1** blocks a demo flow, **P2** wrong/misleading behavior a user will hit, **P3** polish.

| ID | Sev | Finding | Repro / evidence |
|---|---|---|---|
| F1 | P2 | **Thread does not auto-scroll to the newest message.** After sending, the view stays at the top; your own message and the streamed reply are below the fold (`scrollTop: 0` measured during and after streaming; DOM confirms message present). Every chat, every send. | Developer/GA chats; t05b, t06b, t06d |
| F2 | P3 | **Focused sidebar item renders a stray overlapping name chip** (e.g. "Developer" pill floating over the "Researcher" row). Visible after click/focus in every screenshot of a chat. | t06c/d, t06f |
| F3 | P2 | **Composer model picker ignores the Agent's default.** Every chat shows "OpenAI · GPT-4o (default)" even where the profile says GPT-4o mini (Citation Manager, Study Planner) or Ollama llama3:70b (Programming Tutor). | t06f, t06g |
| F4 | P2 | **Stale badges/KPIs never reconcile.** After approving/rejecting: Study Planner sidebar badge stays "⚠1"; "Research Paper · run 3" active-chat badge stays amber; Overview keeps "Awaiting approval 2"; credits table keeps run-3 "Waiting approval". Thread run cards also keep stale state (documented duplication). | t10b, t15f, t20 |
| F5 | P2 | **Popover state desyncs from the DOM.** Account menu can be "open" in state while invisible; the next click on the avatar toggles it closed → button appears dead until Esc. Reproduced repeatedly. | t14c |
| F6 | P3 | **Queued-run copy overclaims.** "Queued — will start after your message" — sending a message never transitions the run (stays QUEUED). New run IDs are per-chat counts and can collide across chats (`run-3` existed in both Research Paper and Exam Preparation). | t25, t08c |
| F7 | P2 | **@-mention wipes the composer draft.** Typing "@" opens the picker, but selecting an Agent replaces the whole draft with "@FirstName " instead of inserting at the caret. | t23a |
| F8 | P2 | **Ad-hoc creation ignores the form.** With name "My Ad-hoc Op QA" and roster [Researcher], Create lands in the fixture "Ad-hoc · 2 Agents" (roster: General Assistant + Programming Tutor) with a success toast; entered values appear nowhere. Additionally the Name field is **reset when you toggle a roster Agent** (form-field loss). | t09c |
| F9 | P3 | **Roster checkmarks can desync from internal selection.** After unchecking agents, "Developer" still showed checked while Create refused with "Pick at least one Agent". | t09b |
| F10 | P2 | **Artifact Open/Download are fully inert** — no navigation, no dialog, no toast, no download. Dead buttons with zero feedback. | DOM-verified (aria-labels "Open artifact"/"Download artifact") |
| F11 | P2 | **Custom provider "Test connection" passes with an empty form** ("Connection test passed · 4 models listed" — toast does admit "prototype simulation"). Unconfigured built-ins are honest (Configure only), so this is the one misleading spot. | t16b |
| F12 | P3 | **Six-panel dock limit gives no feedback.** A 7th "Add panel" attempt silently does nothing (menu item, no toast). The profile header button variant does toast. | t17b |
| F13 | P3 | **Banner "Clean up files" leads to Files & projects (upload/clone) — no cleanup flow exists**, so the storage-banner promise dangles. | t19 |
| F14 | P2 | **Mobile polish:** dock-sheet header overlaps the global banner strip at 390×844; composer row is cramped (hint wraps to 3 lines, send button tight to the edge). No horizontal page overflow, though. | t29a/b |
| F15 | P2 | **Account menu "Notifications" unread count is inconsistent** (showed "3 unread" fresh, "8 unread" after Mark-all-read with only 4 notification fixtures). | t13a vs t11b |

Non-defect notes: the login-screen "dead click" I hit early was a stale-coordinate artifact of test tooling (real-user clicks verified fine); `fill("")`-based clearing raced the draft-snapshot system once — real keyboard clear works; screenshot capture in the automation pane intermittently stalled (environment, not the app).

## 5. What is intentionally NOT functional (mockup boundary, confirmed)

Real authentication, provider calls, tool execution, file upload/download/save, durable persistence, replay, storage/backups, memory writes, schedules, notification delivery, new-chat provisioning — all scripted/readout, as the mockup docs state. The S12 admin surface is deferred (E7/D47) and the fallback screen says so honestly.

## 6. Verdict

**Shippable as a product: NO.** The runtime doesn't exist yet (S01 of 35 build-plan slices), so none of PRD §19's 27 acceptance criteria can pass. **Shippable as a UI prototype/demo: YES, with fixes.** The mockup is cohesive, honest in most copy, and covers S1–S11 well, but before putting it in front of stakeholders I'd fix at least F1 (auto-scroll), F8 (creation ignores input), F10 (inert artifacts), F4/F15 (stale badges/counts), and F5 (popover desync) — those are the ones a 10-minute demo will hit.

**Recommended fix order:** F1 → F8 → F10 → F4 → F5 → F3 → F7 → F15 → F11 → F6 → F14 → F2/F9/F12/F13.
