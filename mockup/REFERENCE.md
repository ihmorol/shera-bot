# Mockup reference: screens, features, and implementation status

**As inspected:** 2026-09-13, working tree based on `fca3090` with the subsequent workspace-pane changes.
**Audience:** future agents, frontend developers, designers and demo reviewers.
**Authority:** descriptive reference for `mockup/`, not the product specification or proof of prototype acceptance.

Read [README](README.md) to run it, [HANDOFF](HANDOFF.md) before changing it, and [UX recommendations](UX_RECOMMENDATIONS.md) for proposed first-use improvements. The [review archive](reviews/2026-09-13/design-audit-localhost-2026-09-13.md) preserves detailed findings; its source line references describe the pre-pane baseline, not today's shifted line numbers.

## 1. Status language

- **Local:** real browser-side interaction or in-memory state mutation; no backend implied.
- **Scripted:** timed or predefined demonstration, not authentication/model/tool/runtime execution.
- **Toast-only:** a message appears but the advertised operation does not occur.
- **Inert:** a control has no meaningful handler, or uses `noop`.
- **Readout:** fixture information with no editing/execution behavior.
- **Deferred:** explicitly outside the intended prototype boundary; not merely an unfinished mockup control.
- **Defect:** current code or observed behavior contradicts the apparent interaction.

A single feature can have more than one status. For example, Editor accepts text locally, Save is toast-only, and certain draft-retention scenarios are browser-verified. Do not call that a working filesystem editor.

## 2. Files and runtime

| File | Responsibility |
|---|---|
| `index.html` | HTML shell, language/viewport metadata, early theme restoration, Google Fonts, stylesheet/script order, toast and screen-reader live-region hosts. Changed pane assets use a version query. |
| `data.js` | Global fixture constants and mutable arrays: account, Pack, Agents, Operation templates, chats, threads, runs, approvals, grants, providers, credits, files, memory, tools, schedules, projects and backups. |
| `icons.js` | Authored inline SVG helpers exposed through `Icons`, including `get`, logo and Google mark. No external icon library. |
| `views.js` | `DockLayout` sizing/state helpers and `Views` HTML-template renderers. Some renderers read `App.state`; they are not all independent pure functions. |
| `app.js` | `App` controller: hash routing, global state, event delegation, scripted streaming, notifications, pane manipulation, snapshots and resize listeners. |
| `styles.css` | Light/dark tokens, global typography, shell/navigation, controls, cards, overlays, tooltips, motion and responsive shell rules. |
| `screens.css` | Screen/component layouts: login, Overview, chat, roster, approvals, dock, full-page workspace, editor/terminal/browser, preview, creation and Settings. |
| `dock-layout.test.cjs` | Node built-in test runner with isolated VM loading of data/icons/views. Seventeen tests for sizing, layout state, safe timeline rendering, separator markup and the Agent profile panel. Does not exercise actual pointer events or the full controller. |

Scripts load in this order: `data.js`, `icons.js`, `views.js`, `app.js`. There is no bundler, package install, production application server, OAuth implementation, WebSocket connection, database, model request, container provisioning or actual tool execution in this directory.

Google Fonts are fetched externally. The fixture comment “no network” describes the lack of runtime integrations, not a guarantee that the HTML makes zero network requests. Provider URLs, tool commands and file paths displayed inside the UI are sample content; do not execute or connect to them to demonstrate the mockup.

The separate `business-landing-portfolio/` Next.js app is not this mockup. Its build/lint commands do not validate these scripts.

## 3. Actual routes and entry behavior

All paths below are hash routes relative to the served `index.html`.

| Route / entry | Surface | Actual behavior and limits |
|---|---|---|
| Empty hash, `#/login` | S1 login / account-cap variant | Normal first load. Continue with Google lands on the S2 chat-first home (`#/app`) with a simulated success toast — repaired 2026-09-13 (was Overview). No authentication. Cap link toggles a local fixture. |
| `#/overview` | Additional mockup dashboard | Statistics, activity chart, outcomes donut, schedules, Operation summaries and live timer. No longer the post-login destination — login lands on `#/app` (2026-09-13). |
| `#/app` | S2 empty chat-first home | **Post-login landing.** Three shortcuts: Researcher direct chat, Research Paper preview, ad-hoc creation — all routes resolve (2026-09-13). |
| `#/agent-general-assistant` | S3 | General Assistant direct chat. |
| `#/agent-researcher` | S3 | Researcher direct chat. |
| `#/agent-developer` | S3 | Developer direct chat; runs + terminal dock initially open on desktop. |
| `#/agent-citation-manager` | S3 | Citation Manager direct chat. |
| `#/agent-programming-tutor` | S3 | Programming Tutor direct chat. |
| `#/agent-study-planner` | S3 | Study Planner direct chat with calendar approval. |
| `#/op-research-paper` | S4 | Existing Research Paper Operation with three independent fixture runs; runs + tool-history dock initially open on desktop. |
| `#/op-adhoc` | S4 | Existing two-Agent ad-hoc Operation, including a retry scenario. |
| `#/op-exam-prep` | S4 | Existing Exam Preparation Operation with recovery scenario. |
| Template button | S5 modal | Sets `previewId` and opens the preview overlay on the current route. Preferred way to inspect previews. |
| `#/preview/<template-id>` | Attempted preview route | Incomplete: routing sets overlay state during view selection after overlay HTML was already chosen. Do not rely on fresh direct entry. |
| `#/operation/new` | S6 creation form | Name, same-Pack roster, coordinator and model overrides. Creation does not create a new chat or honor the form. |
| `#/workspace/<chat-id>` | S7 full-page workspace | Defaults to Task runs when the chat has runs, otherwise Files. |
| `#/workspace/<chat-id>/<panel-id>` | S7 selected panel | Deep-linkable tab with Back to chat. Panel IDs listed below. |
| `#/settings` | S9 Settings | Uses `setSection`, initially Account. Section buttons update that state. |
| `#/settings/<section-id>` | S9 direct section | Renders that section, but then section-button navigation is overwritten by the URL on rerender. Known defect. |
| Bell / approval card / demo controls | S8/S10 overlays | No standalone notification or approval route. |
| Global banners / run markers | S11 status/recovery | Presentations within the shell and threads. |
| Unknown route | Fallback | “Nothing here” with Back to Overview. Its admin-deferral explanation is also shown for unrelated route mistakes. |
| S12 | Admin | No implemented admin route; optional/deferred surface. |

**Route contract (repaired 2026-09-13):** all internal links now use the flat chat format (`#/agent-researcher`, `#/op-research-paper`); launch, creation, notifications, banners, overview cards and demo fallbacks included. A regression test scans every rendered surface and fails if any `href`/`data-href` resolves to a route the router cannot handle. The sidebar wordmark is **not** a Home link.

## 4. Fixture inventory and scenarios

### Pack and identities

`PACK` describes **student pack**, version `v1.3.0`, six Agents and three Operation templates. Several UI strings hardcode “student pack v1”; no live pack loader or version reconciliation exists.

| Agent ID | Role / default provider | Direct-chat scenario |
|---|---|---|
| `general-assistant` | Coordinator, planning/synthesis; GPT-4o | Morning summary of several jobs; recommends calendar approval and recovery review. “Jumped to Study Planner” is a fixture system message, not actual navigation. |
| `researcher` | Evidence-backed investigation; GPT-4o | Source-monitor run, source ranking, web/browser tool examples, artifact and seeded streaming-looking message. |
| `developer` | Code, repositories/tooling; GPT-4o | Auth middleware patch, worktree, diff preview, test output and pending merge narrative. |
| `citation-manager` | Sources/reference integrity; GPT-4o mini | Citation index refreshed and APA-format audit conversation. |
| `programming-tutor` | Code comprehension/practice; Ollama llama3:70b | Hash-table quiz. “Local model answering” is fixture copy, not a model connection. |
| `study-planner` | Schedules/exam readiness; GPT-4o mini | Study plan and permission to create twelve calendar events. |

Each Agent has one fixture identity and one direct-chat ID. Do not create distinct identities for the same Agent in different Operations.

### Operation definitions

| Template ID | Recommended roster / coordinator | Outputs and estimate fixtures |
|---|---|---|
| `research-paper` | General Assistant, Researcher, Citation Manager; General Assistant coordinates | `literature-review.md`, `evidence-table.csv`, `draft-v1.md`, `bibliography.json`; 120–180 credits. Scholar/Semantic Scholar connected, Notion export not configured. |
| `programming-assignment` | General Assistant, Developer, Programming Tutor; General Assistant coordinates | Solution worktree, `test-report.md`, `study-guide.md`; 90–150 credits. GitHub connected, LMS not configured. |
| `exam-preparation` | Study Planner, Programming Tutor, Citation Manager; Study Planner coordinates | `study-plan.md`, `practice-set-1.pdf`, `readiness-report.md`; 60–110 credits. Calendar connected, Anki sync not configured. |

These rosters are current fixtures, not certification against every Pack membership requirement in the product specification. The mockup has **three templates and three existing Operation chats**, but not one existing chat per template: the existing set includes Ad-hoc and has no Programming Assignment instance.

### Runs

`RUNS` contains ten initial records:

| Chat | Run IDs and initial states |
|---|---|
| Research Paper | `run-3` waiting approval; `run-2`, `run-1` succeeded |
| Ad-hoc | `run-2a` running; `run-4` retrying |
| Exam Preparation | `run-2b` recovery required; `run-1a` succeeded |
| Developer | `run-d1` running |
| Researcher | `run-s1` succeeded |
| Study Planner | `run-t1` waiting approval |

General Assistant, Citation Manager and Programming Tutor have no initial runs. Supported state labels include queued, running, waiting approval, retrying, succeeded, failed, paused and recovery required; **not all are seeded as initial run records**. `runStateChip()` uses a default fallback for other values.

Thread run cards duplicate fields rather than dynamically projecting every value from `RUNS`. Approval mutation can therefore change the run-list state while leaving the thread card stale. Dashboard counts are separately hardcoded. `run-3` also has inconsistent calendar/export descriptions across fixtures; do not infer correctness from the displayed badges.

### Other fixtures

- Two pending approvals: `appr-1` calendar sync for Study Planner; `appr-2` spreadsheet export for Researcher.
- Two pre-existing grants: Developer terminal execution and Researcher web search. New approval choices do not insert new grants.
- Four provider entries: OpenAI, unconfigured Anthropic, Ollama and an OpenAI-compatible vLLM example. No provider is actually contacted.
- Credits: balance 1,240; reserved 85; used this month 2,430. Internal accounting examples, not money or real billing.
- Four notifications: approval, success, failed/retrying mismatch, recovery. Initially three unread. All four destinations use unsupported nested chat routes.
- Memory: three shared entries, one Researcher-private entry, one publication-queue item.
- Three triggers: weekly literature sweep, research-folder watcher, inactive GitHub-push webhook. No scheduler or watcher executes.
- Eight tool inventory entries: `web.search`, `browser.drive`, `file.write`, `terminal.exec`, `repo.merge`, `docx.export`, `litreview.rank`, `pdf.extract`; six global history rows.
- Two project readouts: shared repository and restricted thesis-notes archive.
- `AGENT_SESSIONS`: sample per-Agent session history for the profile panel (2 entries for most Agents, 1 for Citation Manager). Display fixtures consistent with the thread scenarios — not a runtime session log; the panel labels them as sample data.
- Backup schedule readout: every six hours, keep seven; three sample snapshot rows. No backup operation.

## 5. Global shell and controls

| Feature | Contents / actual behavior |
|---|---|
| Sidebar | Exactly Agents and Operations as major sections; inside Operations, `Templates` and `Active chats` carry explicit group labels. Includes unread/status badges, credits, connection chip with text, storage meter with total and Pack label. Footer status shows no demo controls — the disconnect/reconnect simulation lives in the Demo menu. |
| Sidebar sizing | Desktop 296px sidebar collapses to 76px rail; controller treats <=768px as drawer behavior. In rail mode item names are visually hidden but remain in the accessibility tree, and a divider separates the two sections (fixed 2026-09-13; earlier the rail dropped names from the tree). |
| Agent section gear | Opens Agent Settings, not Agent creation — pack Agents are fixed. Gear icon with `aria-label="Agent settings"` and an honest tooltip (fixed 2026-09-13; previously an unnamed bare `+`). |
| Operation New | Navigates to the ad-hoc creation form. |
| Search | Icon button in the chat topbar and global topbar opens a **search modal** (command palette, Ctrl+F). It live-filters chat names, Operation chats, launch templates and settings sections from fixtures and navigates via `goto`/`open-preview`; Enter opens the first result, ↑↓ move, Esc closes, and any navigation closes it. It does **not** search message contents — the footer states that scope. |
| Theme | Local light/dark switch, reachable from the account menu; `shera-theme` localStorage value restored before first paint. Attribute/icon states can be stale until rerender because the theme action does not rerender all markup. |
| Account menu | Avatar-only button (unread badge on the avatar) opening the popover: theme switch, Notifications entry (opens the notifications popover), Profile/tier, Credits, Settings, Scripted demo, simulated connection change, Sign out and storage summary. No account authentication lifecycle. On chat routes the button sits in the chat header; elsewhere in the topbar. |
| Notifications | Popover with fixture rows; Mark all read changes unread flags locally. Item opening does not itself reconcile read/resolved state. |
| Demo menu | Scripted response, read-only tool example, risky repository action, disconnect/reconnect. Running outside a chat can invoke broken fallback routes. |
| Toasts | Local timed messages, normally about 4.2 seconds. Their existence does not prove the advertised operation succeeded. |
| Recovery/storage | Both start enabled. Dismiss changes local flags. Review run is a broken route; Clean up files opens project imports rather than a cleanup flow. |
| Offline/reconnecting | Local `conn` changes, then a 1.6-second timer sets live and claims six replayed events. No network loss/replay is implemented; sending is not blocked offline. |

## 6. Chats, collaboration and outputs

`threadItem()` renders day separators, user/Agent messages, system notices, tool cards, run steppers, artifacts, approvals and replay markers.

- Sender identity, Agent role, sent label, optional addressed-Agent marker and streaming cursor are displayed.
- In a direct Agent chat the header identity (avatar, name, role) is a button that opens the workspace dock with the Agent profile panel; if the dock is full it explains via toast instead of adding. Operation headers keep a static glyph.
- Tool cards include name/version, risk, arguments, status, explanatory copy and optional code diff.
- Run cards include ID, goal, state, credits, artifact count, elapsed time and checkpoints.
- Artifact cards include filename, size, producer, originating run, Open and Download buttons. Both actions are inert.
- Enter sends; Shift+Enter inserts a newline. Empty/whitespace-only sends are ignored.
- Sending appends a user message and starts a predefined reply after about 450ms. Streaming advances a random 3–6 characters every 30ms. One global streaming timer means simultaneous streams are not independently managed.
- The canned reply describes idempotency/WebSockets/typed behavior; none of those runtime guarantees is implemented by this interaction.
- Model selectors are presentation controls with `noop`; they do not change the responding provider/model.
- Attach, conversation menu and Operation menu lack working flows.
- Operation Roster toggles visibility. Remove Agent only toasts; Add Agent is toast-only. No actual membership mutation.
- Typing `@` can display the roster picker. Selecting an Agent **replaces the draft** with a first-name mention; it does not insert at the caret. Address parsing only recognizes a leading `@word`.
- New run adds a queued record and thread item locally. Its ID depends on the run count within the current chat, so it can collide with other chats. It supplies `id` where the thread renderer expects `run`. The next message does not implement a real run-start transition.
- Draft snapshots introduced for pane work reduce some rerender losses. They do not fix ad-hoc form resets, mention replacement, live-stream scroll behavior or every focus issue.
- `esc()` escapes `& < > " '` since 2026-09-13 with unit tests (previously it only stringified — a documented injection risk). It is context-safe for the quoted-attribute and text positions this mockup uses; do not use real sensitive content or publish this as a secure application.

## 7. Launch preview and ad-hoc creation

### Pack-defined launch preview (S5)

Eight groups are rendered: Purpose; Agents; Skills; Connectors; Provider/model; Estimated credits; Approval requirements; Expected outputs. Coordinator is marked, connectors show configured status, outputs appear as filename chips.

Cancel/Close dismiss locally. Roster removal is `noop`. Model information has no effective per-Agent override editor here. No brief/material is collected. Launch ignores the selected template, emits the same broken Research Paper route and claims a run/reservation was created without creating either. Interior modal clicks can bubble to dismissal because the `data-stop` branch does not stop the delegated action. See the audit before using this as an investor demonstration.

### Ad-hoc creation (S6)

Name is optional in presentation. Roster toggling works locally and refuses a zero-Agent selection. Coordinator options include General Assistant, other selected Agents and no coordinator; General Assistant can remain available when not selected. Provider override options are illustrative. Roster rerendering resets other form fields. Create ignores entered values and navigates to an existing fixture using a broken route. Cancel goes to `#/app`.

## 8. Workspace panels (S7)

Nine panel types are available, but `dock-add` permits **at most six open at once**, with no duplicate types. The Add-panel list gives no explicit explanation when attempting a seventh; the profile panel's header button toasts when the dock is full. Full-page mode exposes all nine tabs independently of this dock limit.

| Panel ID | Visible label | Contents / status |
|---|---|---|
| `profile` | Agent profile | Telegram-style card: large avatar with presence, name, role; six quick actions (Message focuses the composer, New task queues a run, Files adds the Files panel, Mute/Unmute is a real in-memory toggle with `aria-pressed`, Settings and Full page are links); info rows (status, default model, skills aggregated from Operation templates, Operation memberships, about); collapsible sections for private Files, Ongoing tasks (current-chat runs with `select-run` links, honest empty state) and Session history (sample fixture, labelled as such). In Operation chats it renders a roster/outputs/connectors summary instead. No editing or runtime behavior behind the info rows. |
| `runs` | Task runs | Current-chat run buttons with state, goal, credits and artifact count. Selecting opens timeline locally. Empty list still has only an explanatory paragraph, unlike timeline's explicit empty message. |
| `tasks` | Run timeline | Current-chat selected/fallback run, selector, state/cost, checkpoints, retry/recovery chips. Empty chat now safely shows “No task runs in this chat yet.” The selector still relies on delegated click, not a proper change handler. |
| `files` | Files | Shared fixture tree, folder/file names, sizes and lease badge. Rows do not expand/open files. Upload is toast-only. |
| `editor` | Editor | Editable textarea for the same auth-middleware sample in every chat. Save is toast-only. Lease notice does not enforce locking. Verified pane operations retain local edits; no file persistence. |
| `terminal` | Terminal | Read-only sample commands/test output, working directory/resource badges. The displayed fourteen passed tests are **fixture output**, unrelated to the actual thirteen pane regression tests. |
| `browser` | Browser | Static HTML placeholder composition with sample URL/title; not an embedded live browser or real page screenshot. Direct takeover is deferred. |
| `tools` | Tool history | Same global history table in every chat, including unrelated Agent actions. Not filtered event history. |
| `private` | Private files | Agent selector and sample paths; Researcher/Developer have specific lists, others use fallback paths. Selector handling is incomplete; privacy labels are not enforcement. |

Shared tree examples: research literature review, CSV, PDF folder; project middleware/package file; exam-prep folder; artifact summary. Only the displayed editor text is editable; these paths do not map to actual mockup files.

### Current dock behavior

- Initial desktop dock: every Agent chat opens 440px wide with the Agent profile panel; Research Paper 460px with runs/tools. The former Developer seed (runs/terminal) was replaced by the profile default on 2026-09-13. At initial load <=980px, seeded docks are closed.
- First opening an unseeded chat's dock adds the Agent profile for Agent chats and Task runs for Operations.
- One/two panels form one group. Three through six split at `ceil(count/2)` into two groups. No drag reordering, floating/detached windows, arbitrary docking tree or whole-intersection two-axis drag.
- Dock >=650px on desktop shows groups side-by-side; narrower dock or viewport <=980px stacks them. Row dividers exist within each group; not between stacked groups.
- Outer preferred width defaults to 440px and is client-controlled with no cap: bounds are `{min: lesser of 320 and available, max: available}`. Rendering clamps without silently overwriting the preference. When a resize would leave the chat under 320px (`available − chatMin`), the dock enters fill state (`d.fill`): the chat column is hidden and the dock takes the whole main area except the left sidebar. Widening moves hold the fill; a narrowing move (drag or keyboard) exits fill and the chat returns at the 320px minimum, then tracks the pointer. The dock-header **Back to chat** control (`dock-chat` action) exits fill and restores the last chosen width. Keyboard End fills, Home/Enter reset to a normal width, Reset layout also clears fill.
- Side-by-side columns have approximately 300px minimum each. Expanded panels have 144px minimum total height, collapsed headers 46px, gaps 10px. Short layouts scroll instead of squeezing below minimum.
- Collapse retains membership/body state, hides the body and gives space back. Expand restores it.
- Maximize temporarily shows one panel in the dock; Restore restores normal layout and prior collapse/proportion state. Collapsing a maximized panel returns to split with that panel collapsed.
- Close removes membership, clears maximized flags and closes the dock if it was the last panel. Reopening an empty dock restores its default panel.
- Full-page link changes route, not a separate browser window. Full-page tabs show one panel; Back to chat preserves in-memory layout. Cross-route editor synchronization is not guaranteed.
- Reset restores 440px preference, equal proportions, expanded panels and no maximized panel, but does not remove panel membership or save files.

### Divider input and accessibility implementation

- Outer and column boundaries use horizontal movement; row boundaries use vertical movement.
- Pointer capture handles primary mouse/pen/touch pointer events. Escape, pointer cancellation, lost capture and window resize cancel an active drag and restore its starting preference.
- A press/release with no movement does not overwrite the width preference.
- Focus a divider: arrows move 16px; Shift+arrow moves 48px; Home/End reach limits; Enter resets that split. Outer arrows physically move the boundary, so Left widens the right-hand dock.
- **Resize panels** disclosure contains a split selector, decrease/increase buttons (48px steps) and Equal/default. This is a click/tap alternative to dragging.
- Separators expose names, orientation, controlled pane, help and current/min/max values; focus is visible. Collapsed-neighbor row separators are disabled and removed from tab order; hidden columns have no active divider.
- At <=980px the dock is a viewport sheet and outer resizing is unavailable. Other shell screens still have known mobile defects.
- Enter-reset differs from the ARIA splitter pattern's common Enter-collapse behavior. This is documented, not claimed as exact APG conformance.

## 9. Approval UI (S8)

Fields: requesting Agent, tool/version, run, request age, arguments summary, target resource, side effect, risk, expiry. Reminder timeline: immediate, 15min, 45min, 3h, 24h, none afterward.

The five displayed choices are:
1. **Approve this execution only**
2. **Always approve this tool**
3. **Always approve this tool for this agent**
4. **Reject this action**
5. **Cancel the task**

Approve mutates `state.resolved` and a `RUNS` record, clears an Agent approval property and toasts. It does not add `GRANTS`. Reject resumes the fixture run without the action; Cancel uses `FAILED` with a cancellation note. These are local display mutations, not runtime grants/cancellation. Hardcoded badges, duplicated thread states and notifications can remain stale.

Mute-this-approval/task/all controls are toast-only. Modal and inline variants share rendering. Number-key handling and initial focus select global `.appr-choice` elements, not reliably the active dialog. Background inertness/focus containment/restoration are incomplete. Keep approval policy and all five choices intact when repairing these defects.

## 10. All Settings sections (S9)

Common shell: category navigation, heading/description, cards/rows and controls. Section switching keeps the URL in sync (`#/settings/<section>`) as of 2026-09-13 — deep links and category clicks no longer fight each other (previously the section URL overrode the clicked category on rerender).

| Section ID | Displayed content | Controls and actual behavior |
|---|---|---|
| `account` | Google identity, simulated Balanced tier, 82% of 25GB storage, non-admin label | Readouts. No tier purchasing/account provisioning. |
| `agents` | Six profiles, roles, defaults and descriptions | Edit profile is toast-only; no instruction/profile editor. |
| `providers` | Four provider entries, statuses, masked display value; custom display name/protocol/base URL/password/model/headers fields | Test always displays simulated success, including empty configuration. Configure/Revoke/Save only toast. No credentials stored or connection validated. |
| `credits` | Balance, reserved, used-month, three per-run accounting rows, custom-provider note | Readouts. No reservation/settlement ledger mutation or billing flow. |
| `tools` | Eight tools with owner/scope/risk/policy and creation-policy explanation | Readout; no executable inventory management or activation. |
| `permissions` | Pause-for-approval switch, reminder-policy readout, active grants | Switch is `noop`. Revoke actually removes an existing fixture grant locally; deterministic runtime enforcement is not implemented. |
| `workspace` | Pack/version, pinned policy, one-workspace description | Readout, no switcher or Pack switching. |
| `files` | Two projects, visibility, credentials/worktree labels | Upload archive/Clone repository toast only. No cleanup/delete workflow despite the storage banner link. |
| `memory` | Shared entries with provenance, private entry, publication queue | Edit/Forget/Publish/Dismiss toast only. “Permanently forget — versioned, restorable” is contradictory existing copy, not a supported guarantee. No secret detector here. |
| `schedules` | Schedule, file watcher and webhook examples | Switches are `noop`; no pause/edit or restart-safe scheduling. |
| `notifications` | In-app, browser and reminder toggles with delivery explanation | `noop`; no browser permission request or delivery integration. |
| `privacy` | Container data location, redaction claims, export/purge deferred | Readout. Does not prove redaction or provider data boundaries. |
| `runtime` | Light 1CPU/2GB/10GB, Balanced 2CPU/4GB/25GB, Heavy 4CPU/8GB/50GB; queue/gateway readouts | Fixtures; no resource telemetry or container management. |
| `git` | Worktree/branch strategy and merge-review switch | Switch `noop`; no repository control or merge. |
| `backups` | Six-hour schedule, seven retained, three sample rows, admin-restore labels | Readout; restore is administrator-triggered intended behavior, not a client feature to invent. |

Switches use the same generic accessible label and delegated `noop` cancels normal click behavior. Provider fields also need correctly associated labels. A form that accepts typing is not a working settings operation.

## 11. State, rendering and persistence map

| State / collection | Purpose / lifetime |
|---|---|
| `state.route` + hash | Current screen. `render()` reparses location; Settings subroute can override selected section. |
| `theme` + `shera-theme` | Only implemented durable preference: localStorage theme. |
| `sideOpen`, `sideRail` | Local drawer/rail appearance. |
| `conn`, `recovery`, `storageWarn`, `loginCap` | Local scripted/status variants. Reload resets fixtures. |
| `previewId`, `overlay`, `pop` | Current preview/approval/popover. No robust modal navigation state machine. |
| `dock[chatId]` | `open`, preferred `width`, optional column fraction, ordered panels with type/max/collapsed/weight. Per-chat in memory. |
| `dockAdd` | Chat ID whose Add panel menu is open. |
| `profileMuted` | Agent ID → boolean mute flag shown by the profile quick action. In-memory only; no notification delivery exists to mute. |
| `focusComposer` | Chat ID pending composer focus after the profile's Message action navigates back to a chat. |
| `selRun` | Global selected run ID; panel renderers now restrict fallback to runs belonging to current chat. Not independent per-chat selection storage. |
| `wsPrivateAgent` | Global private-folder selection. |
| `setSection`, `adhocRoster` | Settings category and creation roster; other form inputs not controlled state. |
| `resolved` | Approval presentation outcome by approval ID. Not a grant/event ledger. |
| `streaming` | One global interval handle. |
| `THREADS`, `RUNS`, `APPROVALS`, `GRANTS`, `NOTIFICATIONS` | Mutable fixture arrays/objects; reload reconstructs them. |
| `workspaceSnapshots` | Route-keyed textarea/select values, selections/heights/focus, and scroll positions. Not database or filesystem persistence. |

`render()` replaces the entire app markup, then runs post-render work and restores workspace snapshots. Streaming still directly modifies a bubble and forces latest-position scrolling. `patchDock()` rebuilds only the dock and reuses existing panel bodies, preserving chat DOM. `preserveDockLayout()` keeps bodies and updates geometry. `layoutDock()` measures available space; `ResizeObserver` recalculates it. No full-app rerender is performed on each drag movement.

The full-page and chat routes have separate snapshot keys. Do not promise that edits in one view synchronize to every representation of the same file. The snapshot helper deliberately excludes selected-run values from capture, but general select restoration and focus behavior still need broader regression coverage.

## 12. Visual system and responsiveness

- Space Grotesk display, DM Sans body, JetBrains Mono metadata/code; network-loaded with system fallbacks.
- Body baseline 14px/1.55; some labels/metadata are 10–12px. This is descriptive, not a readability endorsement.
- Main tokens: dark canvas `#0a0f1c`, surface `#101828`, text `#eef4ff`; light canvas `#edf1f7`, white surface, text `#0b1526`; cobalt/blue actions, emerald success, amber warning, red errors.
- Floating shell (2026-09-13, final form): **three sibling panels** float on the ambient canvas — the sidebar, the main content sheet, and the workspace bar (the dock is a top-level sibling of `.main` under `#app`, no longer a child of the chat window). All three share `--glass-surface` fill, hairline `--glass-line` border and offset soft shadow; the main sheet has `overflow: hidden` (chat-header tooltips open downward so they are never clipped). Chat-header structure: identity + workspace toggles left, search icon button, account avatar right; per-conversation model picker in the composer bar. Dock resize math uses `dockAvailableWidth()` (app width minus in-flow sidebar minus 48px margins); fill mode toggles `chat-collapsed` on `#app`. Behind all panels, a fixed `.ambient` layer drifts three brand-tinted light fields (cobalt/sky/indigo, ≤10% alpha) with transform-only keyframes over 64–96s cycles — paused via `body.tab-hidden` when the tab is hidden and static under `prefers-reduced-motion`.
- Border radii: cards16px, controls10px, pills999px. Sidebar296px, rail76px, topbar64px.
- Shared classes include buttons/icon buttons, chips, cards, avatars, status dots/spinners, trees, tables, switches, popovers, dialogs, run steppers and toasts.
- Native/light/dark color-scheme values and reduced-motion CSS exist. Their presence does not certify accessibility. Tooltips, dialog focus, tiny targets, streaming announcements and faint-text contrast have outstanding findings.
- Dock breakpoint is980px; sidebar drawer behavior is768px. Do not assume all layout breakpoints match the target UI specification.
- The phone dock was visually checked at390×844; the Settings shell at the same size showed internal clipping/overflow. These are separate surfaces and outcomes.
- No list virtualization, pagination, universal loading/error-state coverage or production performance validation is implemented.

## 13. Verification and known limits

See [pane verification](reviews/2026-09-13/pane-verification-2026-09-13.md) for exact measurements, screenshot links, real-pointer checks, failed harness attempts, cache workaround and untested scenarios. The actual automated suite has thirteen tests; the terminal fixture's “14 passed” is not test evidence.

Outstanding priorities after the 2026-09-13 repair passes: launch truthfulness is fixed (real queued run; Programming Assignment honestly limited), routes/escaping/settings-navigation are repaired with regression tests, and search exists as a palette. Still open: approval focus/grant/state consistency; input retention beyond pane actions; mobile shell beyond the dock sheet; contrast/labels/focus; event/delivery honesty; the D43 roster decision (product owner). The [UX recommendations](UX_RECOMMENDATIONS.md) explain how to simplify first use without deleting required capabilities.
