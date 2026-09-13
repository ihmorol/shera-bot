# Shera Bot — independent client-experience design audit

- **Report date:** 2026-09-13.
- **Audience:** product/design owners, frontend/runtime engineers, QA, and investor-demo presenters.
- **Primary viewpoint:** a first-time, nontechnical paying client trying to obtain useful work safely.
- **Source baseline:** `fca3090` (`fca30906f1f60c6cca6bd0020cf3a09ba0742063`).
- **Audited directory:** `E:/PROJECTS/shera-bot/mockup`.
- **Status:** completed baseline review. [Post-change pane verification](pane-verification-2026-09-13.md) records implemented fixes, passed tests, and remaining limits.
- **Change boundary:** review recommendations are not adopted product decisions. Only the explicitly requested pane interactions were implemented separately; PRD and product acceptance criteria remain unchanged.

## 1. Executive conclusion

The mockup communicates a promising structure: **Pack → Operations → Agents**, visible collaborators, separate runs, reviewable actions, and expected outputs.
It does not yet support a dependable unassisted demonstration from first intent to a usable result.
The highest-priority problems are broken journeys, lost input, false completion feedback, and unsafe or incomplete interaction behavior—not an assumed visual-style failure.
The browser-confirmed launch dead end is particularly damaging: the interface promises an Operation has launched, then displays “Nothing here.”
An attractive control surface cannot substitute for a working outcome, trustworthy cost/privacy explanations, or proof that the runtime executed the work.

### Severity scheme

| Priority | Meaning in this report | Examples |
|---|---|---|
| **P1 — demo blocker** | Prevents a core task, loses user work, misrepresents a consequential result, or blocks safe/accessible operation in that journey. | Broken launch; discarded brief; wrong approval target; absent result access. |
| **P2 — friction** | Causes avoidable uncertainty, effort, or navigation failure outside the primary happy path; workaround may exist. | Technical vocabulary; weak empty state; incoherent secondary status. |
| **P3 — polish** | Improves clarity, presentation, or efficiency after the interaction works. | Better section grouping, icon labels, consistent metadata wording. |

These are prioritization recommendations, not measured defect rates or a numerical usability score.
Accessibility obligations remain obligations even when a finding is scheduled below P1.

### Recommended immediate sequence

1. Repair one complete journey: enter → choose an Operation → provide a brief → review cost/permissions → launch → inspect the result.
2. Preserve drafts and form state; make every completion claim correspond to an actual demonstrated state change.
3. Fix approval focus/shortcut scoping, accessible names, focus visibility, and contrast defects.
4. Retest the separately changing panes against the baseline findings; do not assume either persistence or resolution.
5. Simplify the newcomer path while retaining the Operation framing and all five mandated approval choices.

## 2. Method, scope, and evidence honesty

### Coverage

Source review covered all S1–S11 templates, Overview, every controller handler, both CSS files, fixtures, icons, and the HTML shell.
S3 included six Agent chats; S4 included three Operation chats; S5 included all three template definitions.
S7 included all eight panel types, with baseline renderer checks against all nine chats.
S9 included all fifteen sections; their baseline templates rendered in isolated script checks.
The full matrix below is **source coverage**, not a claim that every screen was visited in a browser.

### Evidence categories

- **SRC:** inspection of source at `fca3090`; references below always use pre-change line numbers.
- **VM:** baseline scripts executed in an isolated Node VM with minimal document/window stubs; useful for routes, state mutations, template exceptions, and handler logic.
- **B-MAIN:** browser observations supplied by the main tester/user for this report; not independently re-observed by this auditor.
- **REC:** proposed strategy or QA retest; neither implemented behavior nor a new product acceptance criterion.

VM checks are not a DOM implementation, visual measurement, screen-reader test, or browser compatibility test.
There was no screen-reader, cross-browser, complete mobile/zoom, or full backend verification in this independent audit.
No customer interviews, usability study, traction data, conversion data, timing study, or invented scores support this report.
The baseline declares static fixtures and no runtime/network integration: `E:/PROJECTS/shera-bot/mockup/data.js:1–5`.
Google Fonts are network-loaded, so “no backend” should not be misread as “the page makes no network requests”: `E:/PROJECTS/shera-bot/mockup/index.html:16–18`.

### Baseline and concurrent-work protection

When preparing this report, `mockup/app.js` and `mockup/views.js` already contained separate uncommitted implementation edits.
This report does not review, overwrite, or certify those edits.
All pane/dock findings are **baseline findings — pending verification against the current implementation**.
Browser observations are retained as supplied; an exact served revision and browser version still need recording for each test. B8/B9 have supplied screenshot paths below; other artifact paths await the main tester's index.
Main testing will append those details and further results; do not silently replace the baseline evidence.

## 3. Browser-confirmed evidence supplied by the main tester

| ID | Observed scope and finding | Interpretation and limit |
|---|---|---|
| **B1** | Dark theme, 1280×720, Sign-in → Overview: recovery/storage banners appear by default; the 14-runs KPI dominates; useful work is below the fold. | Confirmed for this viewport/journey only. Prioritize a next action and actual outcome over demo activity counts. |
| **B2** | Launch preview: cost and actions are below the fold. | Makes commitment information less discoverable. Scrolling itself is not a WCAG failure. |
| **B3** | Research Paper preview → Launch → `#/operation/op-research-paper` → “Nothing here”; screenshot confirmed by main tester. | Core journey blocker; consistent with the baseline route mismatch. Screenshot path pending attachment. |
| **B4** | General Assistant Task runs pane contains only the explanatory paragraph, with no run items. | Weak empty state, not the separate Run timeline exception. Pane implementation is changing; retest required. |
| **B5** | Approval dialog at 1280×720 shows choices 1–3 while Reject/Cancel are below the fold. Background visually bleeds through the dialog surface. | Unequal discoverability of approval versus refusal; inspect backdrop/surface implementation. Do not infer a CSS cause or a contrast measurement from this observation alone. |
| **B6** | Account → Profile & tier opens `#/settings/account`; clicking Providers & models leaves Account content and URL unchanged. Screenshot captured by main tester. | Browser corroboration of the source/VM settings navigation defect. Screenshot path pending main index. |
| **B7** | With an approval modal open, the browser snapshot shows a background approval option active. An attempted locator `.press("Escape")` failed with “Active element no longer expected.” | Active background option corroborates focus-management concerns. The Escape attempt failed in the harness; **this does not establish an Escape-key product defect**. |
| **B8** | Light theme, 390×844, `#/settings/account`: left edge of Settings clipped; a narrow sidebar sliver overlaps the left; content has a horizontal scrollbar; global account controls extend beyond the right edge; warnings consume approximately 200px. | Confirmed phone-layout obstruction/internal overflow for this screen. Document and body `scrollWidth` both measured 390: **do not claim whole-document overflow**. |
| **B9** | Baseline browser, light theme, 1440×900, four dock panels (Files, Task runs, Browser, Editor), default dock width 440px: measured Files region width 204.6px. Task runs paragraph computed at 11px, `rgb(133,147,171)`, on white `rgb(255,255,255)`. | Measured density and browser-corroborated color pairing; calculated contrast is 3.11:1. Pane space fixes remain pending verification; they do not resolve global color-token contrast. |

**B8 screenshot:** `C:/Users/User/.zcode/cli/artifacts/sess_9a661b81-4293-4c56-9be3-a4f2315ac103/call_ajPxcz18W99rhJ8KfsIKV5RZ-tool-result-4d281a11-8844-4f46-b174-0e1b152bc599.png`.
**B9 screenshot:** `C:/Users/User/.zcode/cli/artifacts/sess_9a661b81-4293-4c56-9be3-a4f2315ac103/call_Hd0wY2LpJvR2UsRmrYfb1tQk-tool-result-9e82c58c-5a39-4b11-a1e1-e1dbddf0166f.png`.
These paths are supplied evidence locations, not screenshots independently inspected by this auditor.
Baseline anchors for B6/B7: `E:/PROJECTS/shera-bot/mockup/app.js:57–60,132–135,334,485–489`.
Baseline anchors for B8/B9: `E:/PROJECTS/shera-bot/mockup/styles.css:154,305–345,537–547`; `E:/PROJECTS/shera-bot/mockup/screens.css:331–359,594–618`; `E:/PROJECTS/shera-bot/mockup/views.js:623–650,696`.

Baseline anchors for B1: `E:/PROJECTS/shera-bot/mockup/app.js:15–17,201`; `E:/PROJECTS/shera-bot/mockup/views.js:146–157,280–284`.
Baseline anchors for B2/B3: `E:/PROJECTS/shera-bot/mockup/views.js:899–915`; `E:/PROJECTS/shera-bot/mockup/app.js:50–69,211–215`.
Baseline anchors for B4: `E:/PROJECTS/shera-bot/mockup/views.js:685–697`.
Baseline anchors for B5: `E:/PROJECTS/shera-bot/mockup/views.js:499–515`; `E:/PROJECTS/shera-bot/mockup/styles.css:430–448`.
The baseline modal uses a surface token and an overlay; B5 does not prove that this token is translucent or identify the live implementation responsible.

## 4. Full S1–S11 source coverage matrix

| Screen / scope | Client task and concrete friction | Priority / evidence | Recommended strategy, owner, and retest |
|---|---|---|---|
| **S1 — sign-in and cap** | “Access the service I paid for.” Copy says private prototype, five accounts, and no payments; cap refusal has no contact action. Login only changes route but reports Google sign-in/container readiness. | **P2**, SRC/VM. `E:/PROJECTS/shera-bot/mockup/views.js:163–180`; `E:/PROJECTS/shera-bot/mockup/app.js:201–203`. | **Product/Design + Frontend:** explicitly frame demo entry; provide an administrator/contact destination. **QA proposal:** enter normal/capped variants and verify no unsupported authentication claim. Commercial scope requires separate product decisions. |
| **S2 — chat-first landing** | “Where should I start?” Login bypasses S2 for Overview. Researcher shortcut uses an unsupported route. Wordmark is not a home link. “Ad-hoc/same-pack/coordinator” precede explanation of value. | Broken shortcut **P1**; orientation **P2**, SRC/VM/B1. `E:/PROJECTS/shera-bot/mockup/views.js:35–41,185–210`; `E:/PROJECTS/shera-bot/mockup/app.js:43–69,201`. | **Frontend + Design:** canonical route generation, obvious Home, outcome-oriented explanations. **QA proposal:** start from sign-in and independently complete each landing shortcut without manually editing the URL. |
| **S3 — six direct chats** | “Ask, attach a file, collect an answer.” Replies are canned; attachment/result/menu controls are inert; model override is noop. Rerendering loses drafts and scroll position. Offline messages say Sent. | Draft/result/delivery trust **P1**; simulated response explanation **P2**, SRC/VM. `E:/PROJECTS/shera-bot/mockup/views.js:370–381,436–443,521–568`; `E:/PROJECTS/shera-bot/mockup/app.js:81–106,125–128,190,311–321`. | **Frontend + Runtime:** preserve per-chat drafts/scroll; implement or clearly label unavailable actions; truthful delivery state. **QA proposal:** type a draft, open notifications/panes, switch chats, return, send offline, then retrieve an output. Pane-related retest pending. |
| **S4 — three Operations** | “Direct collaborators and follow runs.” Roster changes are toast-only; mention selection overwrites the draft. New run IDs collide and the thread card expects a different ID property. Next message does not start the queued run. | Draft/run integrity **P1**; roster simulation **P2**, SRC/VM. `E:/PROJECTS/shera-bot/mockup/views.js:411–417,542–544,587–594`; `E:/PROJECTS/shera-bot/mockup/app.js:227–233,294–298,317–327,389–393`. | **Frontend + Runtime:** structured mentions, coherent roster state, globally unique run IDs, explicit goal/start transition. **QA proposal:** mention mid-draft, create runs in two Operations, verify identity/state and collaborator routing. |
| **S5 — three launch previews** | “Understand and authorize work.” Every template launches Research Paper using a broken route; no run/reservation is created despite success toast. Cost/actions are below fold. Roster remove is noop; model overrides have no editor. Interior modal clicks dismiss it. | Launch/state/dismissal **P1**; information hierarchy **P2**, SRC/VM/B2/B3. `E:/PROJECTS/shera-bot/mockup/views.js:857–915`; `E:/PROJECTS/shera-bot/mockup/app.js:211–215,440–454`. | **Frontend + Design + Runtime:** selected-template launch, brief capture, visible cost/permission summary, safe modal behavior. **QA proposal:** launch each template; click interior text; verify chosen Operation, run and reservation or clearly labelled simulation. |
| **S6 — ad-hoc creation** | “Name and assemble an Operation.” Picking roster members resets form values. Coordinator can remain outside the roster. Create ignores all entered configuration and navigates to an existing fixture on a broken route. | **P1**, SRC/VM. `E:/PROJECTS/shera-bot/mockup/views.js:923–959`; `E:/PROJECTS/shera-bot/mockup/app.js:129–131,216–225`. | **Frontend:** controlled form state, roster-derived coordinator options, actual distinct record/navigation. **QA proposal:** name first, change roster/model/coordinator, create twice, and inspect independent records. |
| **S7 — eight workspace panels** | “Find output and inspect the right run.” File rows do nothing; Save is toast-only; Browser/Terminal are fixtures. Task runs lacks a useful empty state; empty Run timeline throws; selected run leaks across chats; selects lack change handling. | Crash/save/context **P1**; empty state/labels **P2**, SRC/VM/B4. `E:/PROJECTS/shera-bot/mockup/views.js:685–851`; `E:/PROJECTS/shera-bot/mockup/app.js:234–243,289,440–494`. | **Frontend + Design:** explicit empty/error states, per-chat selection, functional file/result access, dirty/save state, change listeners. **QA proposal:** all eight panels × empty/nonempty chats, switching context, keyboard selection and editing. **All pane findings baseline/pending verification.** |
| **S8 — inline and modal approvals** | “Authorize exactly one consequence.” No grant is added despite the promise; thread/sidebar/notifications remain inconsistent. Dialog focus and keys can target underlying approval choices. Refusal options are below fold; mute is toast-only. | Safety/coherence **P1**; discoverability/mute **P2**, SRC/VM/B5. `E:/PROJECTS/shera-bot/mockup/views.js:92,452–515`; `E:/PROJECTS/shera-bot/mockup/app.js:132–135,299–309,398–405,485–489`. | **Frontend + Runtime + Accessibility:** scope dialog actions/focus, unified approval state, visible reusable grants, balanced discovery of all five choices. **QA proposal:** different inline/modal approvals; all choices; grant review/revoke; keyboard-only return to origin. |
| **S9 — fifteen settings sections** | “Change a preference or understand spending.” Section-specific URL overwrites navigation state. Tests always pass; most saves/actions are toast-only. Switches are noop. Credits are explicitly not billing; no paid-service interpretation can be inferred. | Navigation/false save **P1**; grouping/cost explanation **P2**, SRC/VM. `E:/PROJECTS/shera-bot/mockup/app.js:57–60,334–344,453–454`; `E:/PROJECTS/shera-bot/mockup/views.js:967–1177`. | **Frontend + Product/Design:** route-driven navigation; honest read-only/demo settings; common versus advanced grouping; clear cost/privacy explanations. **QA proposal:** open each deep link, change sections, enter invalid provider data, toggle/save/reload and compare state. |
| **S10 — notifications** | “Resolve an alert.” All fixture destinations use unsupported chat routes. Opening does not mark read/focus the event. A failed notification refers to a retrying run. | Broken attention journey **P1**; read/status coherence **P2**, SRC/VM. `E:/PROJECTS/shera-bot/mockup/data.js:155–156,199–203`; `E:/PROJECTS/shera-bot/mockup/views.js:1187–1202`; `E:/PROJECTS/shera-bot/mockup/app.js:329–333`. | **Frontend + Runtime:** canonical event deep links, target focus, coherent resolved/read state. **QA proposal:** open all notification kinds and reconcile with the destination event/run. |
| **S11 — recovery/storage/connection** | “Recover without losing work.” Default banners confront newcomers with trouble. Recovery link is broken and no recovery decision is provided. Cleanup opens upload/clone cards, not cleanup. Timed reconnect falsely claims replay; offline sends claim success. | Recovery/delivery trust **P1**; default warning burden **P2**, SRC/VM/B1. `E:/PROJECTS/shera-bot/mockup/app.js:15–17,311–320,345–348`; `E:/PROJECTS/shera-bot/mockup/views.js:146–157,1095–1111`; `E:/PROJECTS/shera-bot/mockup/data.js:450–465`. | **Frontend + Runtime + Design:** actionable review/cleanup, truthful sync/delivery, intentional demo scenarios. **QA proposal:** disconnect, attempt send, reconnect, inspect replay and unresolved recovery; follow storage remediation to completion. |
| **Overview — additional actual landing** | “What useful work should I do next?” 14-runs KPI dominates at tested viewport; useful work is below fold. Links mismatch meaning/routes; timer and controls do not reflect real work. | Broken destinations **P1**; hierarchy/activity emphasis **P2**, SRC/VM/B1. `E:/PROJECTS/shera-bot/mockup/views.js:280–305,334–356`; `E:/PROJECTS/shera-bot/mockup/app.js:343,496–504`. | **Design + Frontend:** next best action, pending decisions and usable results before decorative activity summaries. **QA proposal:** first viewport at 1280×720; each summary opens its matching item; pause/cancel and state agree. |

## 5. Detailed finding strategies

### F1 — P1: one route contract, not multiple incompatible URL shapes

The router looks up flat chat IDs, but launch, notifications, recovery and several shortcuts use nested Agent/Operation routes.
VM checks confirmed `#/agent/researcher` fails while `#/agent-researcher` works; the same mismatch applies to Operation links.
Direct preview routing also sets overlay state too late for the current render and falls through to “Nothing here.”
**Strategy:** generate all destinations from one route contract, including direct links and browser Back; ensure overlays have an intentional route lifecycle.
**Owner / QA proposal:** Frontend; click each route origin and test fresh deep links, refresh, Back and invalid IDs.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/app.js:50–69,87–105`; `E:/PROJECTS/shera-bot/mockup/data.js:199–203`.

### F2 — P1: do not lose a client's brief while they inspect the interface

`appEl.innerHTML` replacement reconstructs controls; input state is not retained. Form roster changes explicitly trigger that replacement.
`afterRender()` always moves threads to the latest item and focuses the creation name input. Mention selection replaces the whole message with a first-name mention.
**Strategy:** keep draft/form/selection state separately from presentation; preserve reading position unless already following live output; insert mentions at the cursor.
**Owner / QA proposal:** Frontend; draft → open notification → change pane → change roster → return, with content and focus checks. Pane behavior pending current-build verification.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/app.js:81–106,125–136,220–225,322–327`.

### F3 — P1: completion copy must describe the state that actually exists

Launch creates no run/reservation; creation adds no chat; approval adds no grant; Save does not persist editor text.
The baseline approval test left two grants unchanged, changed `RUNS.run-3` to RUNNING, and left its thread card WAITING_FOR_APPROVAL and chat waiting.
**Strategy:** demonstrate coherent local state if remaining a mockup; otherwise use actual runtime acknowledgements. Label simulations before commitment, not only in a transient toast afterward.
**Owner / QA proposal:** Frontend + Runtime; inspect every success claim against the record and all related views, including reload behavior.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/app.js:211–218,299–309,398–405`; `E:/PROJECTS/shera-bot/mockup/views.js:764–771,1078–1085`.

### F4 — P1: make the approval dialog operate on its own approval

The “focus trap” only queries the first `.appr-choice` anywhere in the document; the digit handler uses the same global collection.
Opening a different approval over an existing inline card can therefore focus or execute the wrong card's choice.
The `data-stop` branch is empty, so ordinary interior clicks can trigger overlay closure.
**Strategy:** contain focus, restore it to the invoker, make background content inert, and scope every shortcut/action to the active dialog and approval ID.
Keep all five mandated choices; improve consequence explanations and refusal discoverability without deleting or renaming those choices.
**Owner / QA proposal:** Frontend + Accessibility + Runtime; deliberately use different underlying/modal approvals and verify all five actions by keyboard and pointer.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/app.js:109–136,440–454,471–490`; `E:/PROJECTS/shera-bot/mockup/views.js:499–515`.

### F5 — P1/P2: distinguish empty Task runs from a broken Run timeline

B4 is a **P2 empty-state** observation: General Assistant Task runs renders an explanatory paragraph but no next step.
A separate **P1 baseline exception** occurs when Run timeline dereferences `sel.state` with no run; VM reproduced it for General Assistant, Citation Manager and Programming Tutor.
Global `selRun` can also show Developer cost/state in Research Paper; identical global history across chats lacks a scope explanation.
**Strategy:** “No runs yet” plus a relevant next step; scope run selection and history explicitly; keep unavailable panels safe rather than crashing.
**Owner / QA proposal:** Frontend; empty/nonempty contexts, cross-chat switching, full-page/dock variants and typed selection changes.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/views.js:685–697,803–835`; `E:/PROJECTS/shera-bot/mockup/app.js:234–243,289`.
**Status:** all pane-related observations are baseline/pending verification; separate implementation is underway.

### F6 — P1: usable outputs matter more than simulated work narration

Artifact preview/download and file rows advertise results that cannot be opened. Attach has no picker, while the Browser/Terminal are fixed fixtures.
Editor Save gives explanatory feedback rather than saving; the leased-file notice does not itself implement an edit policy.
**Strategy:** choose a narrow, honestly demonstrated result journey with a readable/downloadable artifact; label technical panels as samples when they are samples.
**Owner / QA proposal:** Frontend + Runtime; open a result from the Operation, inspect provenance, download it, and compare the saved content after returning/reloading.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/views.js:436–443,531–536,747–800`.
**Status:** pane implementation pending verification; no live browser/runtime or file persistence is certified here.

### F7 — P2: make costs and privacy understandable at the decision point

Preview states an estimated credit range, but “reserved now” is ambiguous before Launch and the cost appears below fold in B2.
Credits are explicitly prototype accounting, not billing; a paying client should not have to infer currency value, plan coverage, or refund/settlement rules.
“Local-first” plus a cloud container and custom provider URLs may be misunderstood as “nothing leaves my laptop.”
**Strategy:** explain what credits mean here, when a reservation occurs, what changes the estimate, who receives prompts/files, and what persists; avoid inventing pricing or privacy promises.
**Owner / QA proposal:** Product/Design + Runtime/Security; compare launch explanation with actual provider data flow and accounting behavior before making public claims.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/views.js:894–902,1037–1056,1143–1151`; `E:/PROJECTS/shera-bot/mockup/data.js:190–197`.

### F8 — P2/P3: explain consequential controls before exposing implementation vocabulary

“Ad-hoc,” “hibernating,” “worktree,” “typed protocol,” “lease,” and “runtime-owned grants” require knowledge beyond the client's task.
Fifteen settings categories and eight panel types expose useful breadth but increase first-use decision burden.
**Strategy:** preserve canonical nouns, pair them with plain-language outcomes, group common/advanced settings, and reveal technical detail when needed.
**Owner / QA proposal:** Product/Design; moderated newcomer task walkthrough recommended, with observed misunderstandings recorded rather than invented research claims.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/views.js:554,593,599–607,928–955,967–973`.

### F9 — P1: render user text as text, not interpreted markup

`esc()` only converts to a string; user messages are interpolated into `innerHTML`. VM confirmed literal `<b>` input remained markup.
This can corrupt a conversation and creates an injection surface; no browser exploit or backend compromise was tested.
**Strategy:** use text nodes or context-appropriate escaping, with intentional formatting handled through a safe renderer.
**Owner / QA proposal:** Frontend + Security; paste markup/code characters and verify literal display, including messages, attributes and editor content.
**Evidence:** `E:/PROJECTS/shera-bot/mockup/views.js:12,370–381`; `E:/PROJECTS/shera-bot/mockup/app.js:97,317`.

### F10 — P2: responsive obstruction and measured pane density

B8 confirms internal clipping at 390×844 light Settings: navigation residue overlaps content, account controls extend out of reach visually, and warnings consume about 200px.
Do not infer whole-document overflow: document/body scrollWidth stayed 390. Fix and retest the internal shell, header, drawer and content containers.
B9 confirms a 204.6px Files region within a 440px, four-panel dock at 1440×900; this makes technical content difficult to read without moving into another view.
**Strategy:** prioritize a usable content column, close/inert the mobile drawer correctly, allow header controls/banners to reflow, and consolidate persistent warnings without concealing unresolved issues.
For panes, establish content-sensitive minimum widths, prefer stacking or a single active panel when width is insufficient, and provide obvious collapse/maximize/full-page options.
Do not use smaller text as the solution to pane density. The 11px secondary text is a readability concern; its 3.11:1 pairing separately fails normal-text contrast.
**Owner / QA proposal:** Frontend + Design/Accessibility; retest 390×844 and 320-CSS-pixel reflow, light/dark headers/banners, and 1–4 panels at representative widths; verify visible keyboard focus and reachable controls.
**Evidence:** B8/B9 screenshots and measurements; `E:/PROJECTS/shera-bot/mockup/styles.css:154,305–345,537–547`; `E:/PROJECTS/shera-bot/mockup/screens.css:331–359,594–618`.
**Status:** pane space implementation is separately underway; geometry and global contrast need independent post-change verification.

## 6. Nielsen heuristic matrix

| Heuristic | Positive foundation | Friction / recommended response |
|---|---|---|
| Visibility of system status | Named status chips, banners, per-run costs. | F3/F5: stale or simulated status defeats visibility; derive displays from coherent state. |
| Match with the real world | Agent role descriptions and expected outputs. | F7/F8: explain consequences and costs in client language; retain Operations, not generic task chats. |
| User control and freedom | Cancel, close, dock restore and explicit rejection are present. | F2/F4: protect drafts, scrolling, focus and intentional dismissal; make cancellation real or labelled. |
| Consistency and standards | Pack → Operations → Agents remains recognizable. | F1/F3: normalize routes and action semantics; resolve settings navigation contradiction. |
| Error prevention | Preview gate, minimum roster, one-time approval choice. | F4/F9: scope approvals, validate actual input and safely render it before adding decorative safeguards. |
| Recognition rather than recall | Named roster and persistent run records. | Hidden rail labels, icon-only access and technical IDs demand recall; preserve accessible and visible context. |
| Flexibility and efficiency | Dock, maximize, pop-out, keyboard send. | Search is inert and hijacks browser Find; implement it or preserve browser behavior. |
| Aesthetic and minimalist design | Reusable groups and optional panels support hierarchy. | B1/B2/B5: elevate next action, cost and all decision options; no claim that unvisited layouts are visually verified. |
| Help users recover from errors | Explanations of recovery, storage and provider issues. | S11: provide actual review/cleanup actions and trustworthy delivery/replay feedback. |
| Help and documentation | Inline policy and role explanations. | S1/F8: provide actionable support and task-oriented help, not only implementation explanations. |

Additional anchors: `E:/PROJECTS/shera-bot/mockup/views.js:124–127,146–157,185–210,485–515`; `E:/PROJECTS/shera-bot/mockup/app.js:478–480`.

## 7. Shneiderman's eight golden rules

| Rule | Baseline assessment | Recommended strategy / linked evidence |
|---|---|---|
| Strive for consistency | Object names are consistent; destinations and statuses are not. | One route/state contract; F1/F3. |
| Seek universal usability | Labels, reduced-motion CSS and breakpoints exist; keyboard/naming defects remain. | Accessibility repairs and assisted/unassisted retests; section 9. |
| Offer informative feedback | Frequent feedback sometimes claims nonexistent work. | State-based acknowledgements, not success-themed narration; F3. |
| Design dialogs to yield closure | Creation, launch, saving and collecting an output lack dependable endpoints. | Finish one coherent Operation/result loop; S5/S6/F6. |
| Prevent errors | Preview and approval scopes are good foundations. | Preserve input, validate before action, bind shortcuts to the right approval; F2/F4. |
| Permit easy reversal | Dock restore/close works locally; discarded drafts do not. | Recover draft state; distinguish revoking future permission from undoing an external action; F2/F4. |
| Keep users in control | Automatic scroll, focus replacement and modal mis-dismissal interrupt intent. | Intentional navigation/focus and explicit state transitions; F2/F4. |
| Reduce short-term memory load | Rosters and separate runs aid recognition. | Named results, scoped context, common-task grouping and plain language; F5/F8. |

These frameworks organize expert judgment; they are not empirical proof of user behavior or independent numeric scores.

## 8. Recognition, Hick/Fitts, Gestalt, and progressive disclosure

- **Recognition over recall:** keep Agent names, Operation goals, result titles and selected-run context visible; do not require remembering an ID or panel icon.
- **Hick's law:** eight panel types, fifteen settings sections and several approval/mute actions create choice cost when ungrouped. No universal maximum number of choices is asserted.
- **Fitts's law:** 16px roster-removal and 22px preview-removal controls are difficult acquisition targets; enlarge consequential targets and separate adjacent actions. Travel time was not measured.
- **Gestalt proximity/common region:** group a run's goal, state, cost, pending decision and outputs together so the client can infer their relationship without scanning unrelated panes.
- **Gestalt similarity:** use consistent treatments for “needs your decision,” “in progress” and “ready to use”; do not make simulated and completed outcomes look equivalent without labels.
- **Figure/ground:** B5 indicates weak separation in the tested approval dialog; verify an adequately opaque dialog/backdrop without guessing the rendering cause.
- **Progressive disclosure:** keep purpose, expected result, necessary input, estimated cost and user decisions in the primary path; reveal provider/tool/runtime detail secondarily.
- **Do not hide refusal:** progressive disclosure must not remove the five mandated approval choices or make broad consent easier to discover than reject/cancel.
- **P3 polish:** consistent visible icon labels, clearer “Back to Operation” context and aligned metadata wording can follow functional repairs.

Anchors: `E:/PROJECTS/shera-bot/mockup/screens.css:187,488`; `E:/PROJECTS/shera-bot/mockup/views.js:599–607,871–915,967–973`.

## 9. WCAG 2.2 AA: normative requirements versus recommendations

This is a source-based accessibility assessment, not a conformance certification. AA conformance also requires applicable Level A criteria.
Normative reference: https://www.w3.org/TR/WCAG22/ . Browser geometry, accessibility-tree behavior and assistive-technology output still require retesting.

| Area | Source finding / evidence | Normative requirement and recommended QA |
|---|---|---|
| Keyboard focus | Search/composer suppress outline; composer emphasis begins on input, not focus. `E:/PROJECTS/shera-bot/mockup/styles.css:136,318`; `E:/PROJECTS/shera-bot/mockup/screens.css:298–301`; `E:/PROJECTS/shera-bot/mockup/app.js:457–467`. | **2.4.7 AA:** visible keyboard focus. Restore keyboard focus styling and verify actual contrast/visibility in browser. **Owner:** Frontend/Accessibility. |
| Focus order/obstruction | Dialog focus can select background controls; no containment/restoration/inertness. Mobile sidebar is moved offscreen, not removed from interaction. `E:/PROJECTS/shera-bot/mockup/app.js:125–136`; `E:/PROJECTS/shera-bot/mockup/styles.css:537–544`. | **2.4.3 A / 2.4.11 AA:** meaningful focus order; focused component not entirely hidden by author content. Trap/restore dialog focus appropriately; test closed drawers and overlays. Partial obstruction is not the same as the AA minimum's entire-obstruction threshold. |
| Character shortcuts | Bare 1–5 works whenever overlay state exists, independent of component focus. `E:/PROJECTS/shera-bot/mockup/app.js:485–489`. | **2.1.4 A:** disable, remap to include a non-printable key, or activate only while the relevant component has focus. Test speech-input/keyboard conflicts. |
| Dragging/keyboard | Dock resizing is mouse-drag only; separator has no tabindex/keyboard support. `E:/PROJECTS/shera-bot/mockup/views.js:633–634`; `E:/PROJECTS/shera-bot/mockup/app.js:409–436`. | **2.1.1 A:** keyboard functionality. **2.5.7 AA:** single-pointer alternative without dragging, except essential or unmodified user-agent behavior. Add keyboard resizing and click/tap presets. **Baseline pane finding, pending retest.** |
| Names/labels | Provider fields use adjacent spans; switches are named “toggle”; Agent-settings plus has no meaningful name; rail hides names while avatars are aria-hidden. `E:/PROJECTS/shera-bot/mockup/views.js:14–16,51–55,90,993,1023–1029`; `E:/PROJECTS/shera-bot/mockup/styles.css:285–291`. | **1.3.1 A / 4.1.2 A:** programmatically determinable relationships, names, roles and states. **3.3.2 A:** labels/instructions for input. Associate labels and retain meaningful names; inspect accessibility tree and screen-reader output. |
| Menus/tabs | Menu containers hold ordinary buttons/links; tabs lack associated tabpanels and expected widget keyboard behavior. `E:/PROJECTS/shera-bot/mockup/views.js:674–680,737–740,1190–1199,1208–1215`. | Assess **1.3.1 / 4.1.2** and keyboard operation. Use ordinary navigation/list semantics or implement complete widgets. ARIA pattern conventions are guidance, not separate WCAG thresholds. Pane findings pending retest. |
| Status messages | Toast live region exists; `sr-live` is never populated; streaming thread lacks equivalent live/log semantics. `E:/PROJECTS/shera-bot/mockup/index.html:25–28`; `E:/PROJECTS/shera-bot/mockup/app.js:166–187,396`. | **4.1.3 AA:** qualifying status messages must be programmatically exposed without moving focus. Announce concise response/run/delivery states, not every token; screen-reader test required. |
| Auto-update/motion | Live timer updates indefinitely; pause is toast-only. CSS reduced motion does not stop the JS timer. `E:/PROJECTS/shera-bot/mockup/app.js:496–504`; `E:/PROJECTS/shera-bot/mockup/views.js:350–356`; `E:/PROJECTS/shera-bot/mockup/styles.css:529–530`. | **2.2.2 A:** nonessential automatic updating alongside other content needs pause/stop/hide or frequency control. Moving/blinking/scrolling branch has a more-than-five-second condition; auto-updating branch does not. Test actual controls. |
| Hover content | Tooltips are hover-only, pointer-events:none, with no dedicated dismissal behavior. `E:/PROJECTS/shera-bot/mockup/styles.css:520–525`. | **1.4.13 AA:** additional content must be dismissible where required, hoverable and persistent; exceptions include unmodified user-agent presentation. Verify overlap, pointer transition and dismissal; provide keyboard-accessible equivalents. |
| Reflow/resize/spacing | Fixed overflow shell, grids, tables and banners warrant testing; breakpoints alone prove nothing. `E:/PROJECTS/shera-bot/mockup/styles.css:154,404–407`; `E:/PROJECTS/shera-bot/mockup/screens.css:516–537,588–618`. | **1.4.10 AA:** vertical content at 320 CSS px width without two-axis scrolling/loss, with limited two-dimensional-content exceptions. Also test **1.4.4 AA** 200% text resize and **1.4.12 AA** prescribed text-spacing overrides. No untested visual failure asserted. |

### Contrast calculations: exact inputs, ratios rounded to two decimal places

Values below are computed WCAG relative-luminance ratios from specified sRGB colors, not rendered/browser-sampled pixels.
They are not exact infinite-precision ratios; no rounding should be used to turn a below-threshold result into a pass.

| Foreground / background | Computed ratio | Baseline use / interpretation |
|---|---|---|
| `#5f7392` / `#101828` | **3.68:1** | Dark faint text on surface: below 4.5:1 for normal text. |
| `#5f7392` / `#16213a` | **3.32:1** | Dark faint text on elevated surface: below 4.5:1. |
| `#8593ab` / `#ffffff` | **3.11:1** | Light faint text on white surface: below 4.5:1. |
| `#ffffff` / `#3b82f6` | **3.68:1** | Dark-theme user-message background and bright primary-gradient endpoint: normal text needs correction; gradient requires actual placement sampling. |
| `#ffffff` / `#2563eb` | **5.17:1** | Passes normal-text minimum for this pair; does not certify an entire gradient/button/theme. |
| `#5d7290` / `#0a0f1c` | **3.89:1** | Dark terminal dim text: below normal-text minimum. |
| `#5d7290` / `#0b1220` | **3.81:1** | Light-theme terminal dim text on retained dark terminal: below minimum. |

Evidence: `E:/PROJECTS/shera-bot/mockup/styles.css:13–25,44,50,58–69,88,93,145,355`; `E:/PROJECTS/shera-bot/mockup/screens.css:204–210,448–455`.
**1.4.3 AA:** 4.5:1 for normal text; 3:1 for large-scale text, generally at least 18pt regular or 14pt bold. Inactive/incidental text and logotypes have specified exceptions.
**1.4.11 AA:** 3:1 for necessary control/state/graphical information against adjacent colors, subject to exceptions; not every decorative border must meet 3:1.
Low-opacity borders/focus substitutes need compositing and rendered measurement: `E:/PROJECTS/shera-bot/mockup/styles.css:32–34,76–78,453–457`.
**Owner / QA proposal:** Design + Frontend/Accessibility; retest text, icons, focus and states in both themes and all overlays after color changes.

### Target size: do not confuse AA with preferred touch sizing

**2.5.8 AA** requires at least **24×24 CSS pixels**, unless a valid exception applies.
For spacing: a 24-CSS-pixel-diameter circle centered on each undersized target must not intersect another target or another undersized target's corresponding circle.
Other exceptions cover an equivalent qualifying control on the same page, inline/line-height-constrained targets, unmodified user-agent sizing, and essential or legally required presentation.
The 16×16 roster remove and 22×22 preview remove targets are undersized; geometry/spacing must be checked before declaring a criterion failure.
**44×44 CSS pixels is 2.5.5 AAA**, not the AA minimum; recommending it for touch/consequential actions is usability guidance.
Evidence: `E:/PROJECTS/shera-bot/mockup/screens.css:187,488`; standard icon buttons are 38×38 at `E:/PROJECTS/shera-bot/mockup/styles.css:325–327`.
There is **no universal WCAG minimum font size**. Comfortable secondary text, simpler hierarchy and fewer visible controls are recommendations, not normative thresholds.
Below-fold cost or Reject/Cancel is not automatically a WCAG failure; test keyboard access, reflow and focus visibility separately.

## 10. Implemented, simulated, missing, and deliberately deferred

| Classification | Baseline behavior |
|---|---|
| Implemented locally | Valid flat hash routes; theme persistence; sidebar/dock toggle; maximize/close/pop-out; mouse resize; roster selection; mark-all-read; removing existing fixture grants. |
| Scripted simulation | Google login, canned streaming, inserted tool/risky-action examples, approval-card/run mutation, timed reconnect, provider test. No runtime verification follows from these. |
| Toast-only operation | Save editor, upload/clone, roster add/remove, mute, pause/cancel-run, provider save/configure/revoke, profile editing, memory edit/forget/publish. |
| Missing advertised interaction | Search/results, attachments, artifact preview/download, chat/Operation menus, file opening/tree expansion, preview roster removal, effective model override. |
| Explicitly deferred | Direct browser takeover, user export/purge, admin console; snapshot restore is administrator-triggered, not a missing client button to invent. |

Evidence: `E:/PROJECTS/shera-bot/mockup/app.js:193–387`; `E:/PROJECTS/shera-bot/mockup/views.js:442–443,533,560–568,584,747–800,1018–1033,1117–1177`.
Most state resets on reload; only theme is persisted by these scripts: `E:/PROJECTS/shera-bot/mockup/app.js:149–154`.
Simulated behavior is acceptable in a mockup if made explicit; presenting it as completed production work is the trust defect.
Pane classifications refer to the baseline and require retesting after the separate pane changes.

## 11. Investor perspective: prove an outcome, not dashboard activity

This audit found no evidence of traction, paid adoption, retention, accepted outputs, execution reliability, or unit economics.
That is an evidence limit of this mockup audit—not a claim that the wider project has no such evidence.
The 14-runs KPI and other fixture counts are illustrative UI data, not customer traction or investor metrics.
A broken launch followed by a success toast weakens confidence in execution more than extra visual polish strengthens it.

### Recommended outcome / accepted-artifact wedge

Demonstrate one bounded Operation, such as Research Paper: a client supplies a real brief, understands the scope/cost, reviews an action if needed, and obtains an inspectable evidence-backed artifact.
The differentiating story is not “many Agents are active”; it is “this Operation produces work the client can inspect, accept or request revisions to, with provenance and controlled execution.”
A proposed accepted-artifact loop is a presentation/research recommendation, not an existing feature claim or new product decision.
Do not report an acceptance rate, time saved, margin, or quality score without real observations and definitions.

| Investor question | What this mockup supports | What remains to demonstrate |
|---|---|---|
| Why this product? | Explicit Operations, roles, permissions and output expectations. | A valuable client problem and evidence that the resulting artifact meets that client's need. |
| Does it really execute? | Scripted examples of runs, tools, approvals and recovery. | Actual runtime acknowledgement, persistence, grant enforcement, execution trace, failure recovery and accessible final files. |
| Is cost understandable/sustainable? | Estimated credits and illustrative per-run accounting. | Real provider usage, reservation/settlement correctness, pricing meaning and economic evidence; no invented margins. |
| Is private material safe? | UI descriptions of private memory, publication, masked keys and cloud container boundaries. | Verified provider data flows, retention/access controls, redaction and consent at relevant boundaries. |
| Is there traction? | Nothing in this audit establishes it. | Separately sourced user/customer evidence, honestly distinguished from fixtures and demo reactions. |

Suggested owners: Product/Founder for the evidence story; Runtime for execution/accounting proof; Security for privacy claims; Design for comprehension.
Anchors: `E:/PROJECTS/shera-bot/mockup/data.js:1–5,78–96,197`; `E:/PROJECTS/shera-bot/mockup/views.js:280–284,1037–1056,1113–1151`.

## 12. Recommended newcomer flow, without changing the product vocabulary

1. **Enter an explicitly labelled demo or authenticated workspace.** Explain the pack in one sentence and avoid treating seeded warnings as the first success state.
2. **Choose the desired outcome.** Present “Launch an Operation” alongside “Ask an Agent”; describe an Operation as reusable collaborative work with a goal, runs and outputs.
3. **Pick a template and provide the brief/material.** Offer ad-hoc creation as an optional advanced path; do not force provider/coordinator decisions on every newcomer.
4. **Review before launch.** Keep purpose, expected outputs, participants, estimated cost and required permissions easy to find; preserve all eight preview groups, with detail disclosure where useful.
5. **Launch the selected Operation.** Show one coherent run and its truthful queued/running/waiting state, not an unsupported success toast.
6. **Answer consequential requests.** Retain all five mandated approval choices; explain one-time versus reusable scope and reject versus cancel, with equal discoverability and safe focus.
7. **Inspect the artifact.** Make provenance, relevant run, preview/download and next action available from the Operation instead of requiring a hunt through technical panes.
8. **Request revision or indicate acceptance where product scope permits.** Treat any new acceptance interaction as a separate product proposal; do not silently add it to the PRD.
9. **Understand cost and return later.** Explain credits versus real billing, provider data exposure, persistence and recovery without overstating implemented guarantees.

Owners: Product/Design for proposed flow and language; Frontend/Runtime for behavior; QA for an independent newcomer walkthrough.
This flow is a recommendation derived from the audited obstacles, not usability research or an approved replacement specification.

## 13. Positive foundations to preserve

- The launch gate contains purpose, Agents, skills, connectors, provider/model, estimated credits, approval requirements and expected outputs: `E:/PROJECTS/shera-bot/mockup/views.js:871–910`.
- Approval fields expose target, side effect and expiry; choices distinguish one-time/reusable permission, rejection and cancellation: `E:/PROJECTS/shera-bot/mockup/views.js:485–515`.
- Agent roles, roster chips and separate run records preserve collaboration rather than collapsing Operations into generic chats: `E:/PROJECTS/shera-bot/mockup/views.js:547–595,685–696`.
- Private/shared memory and explicit publication make provenance and boundaries visible: `E:/PROJECTS/shera-bot/mockup/views.js:839–851,1113–1128`.
- Language metadata, many icon-button names, text status labels, live-region containers, focus CSS and reduced-motion rules provide accessibility foundations: `E:/PROJECTS/shera-bot/mockup/index.html:2,25–28`; `E:/PROJECTS/shera-bot/mockup/styles.css:136,529–547`.
- Local dock layout controls offer useful expert flexibility; preserve them while fixing scope and newcomer discovery. Baseline implementation: `E:/PROJECTS/shera-bot/mockup/app.js:249–287`.

## 14. Recommended QA ownership and append-only verification ledger

The following are **recommended QA activities**, not new product acceptance criteria, delivery commitments, or modifications to PRD scope.
No acceptance-criterion IDs are introduced. If a proposal changes product behavior, use the existing decision/traceability process separately.

| Proposed owner | Retest package | Evidence to append |
|---|---|---|
| Frontend | Every route origin, all three launches, ad-hoc creation, settings deep links, notification/recovery navigation. | Served commit, URL, steps, expected/actual result, screenshot or recording, console errors. |
| Frontend / pane implementer | Eight panels across empty/nonempty chats; context isolation, keyboard selects, resize alternatives, save/result access. | Post-change commit/diff, pane identity, empty-state and cross-chat recordings; explicit baseline finding disposition. |
| Runtime | Approval/grant consistency, actual execution, cancellation, cost reservation/settlement, reconnect/replay and persistence. | Safe/redacted event/record evidence; never secrets; distinguish simulation from backend execution. |
| Accessibility QA | Keyboard-only completion, dialog/menu/tab semantics, screen-reader announcements, both-theme contrast, target spacing, zoom/reflow/text spacing. | Browser/AT versions, viewport/zoom, focus sequence, sampled colors/geometry and criterion-specific outcomes. |
| Product / Design | Newcomer understanding of Operation, output, cost, privacy and next action. | Actual walkthrough observations and exact misunderstandings; no fabricated task timings or success rates. |
| Main browser tester | Extend B1–B9 and attach screenshots; verify current pane implementation separately. | Timestamp, served revision, browser/version, viewport/theme, action sequence, screenshot paths and untested scope. |

**Baseline ledger:** B1–B9 are supplied browser observations; source/VM findings remain baseline findings. Use the dated addendum for current pane-fix status.
A later screenshot of one repaired pane must not be interpreted as proof that all screens, accessibility criteria, or runtime paths pass.

## 15. Screenshot index and reference frameworks

Screenshots were captured from the running mockup before reloading the pane changes. They are original browser captures, not reconstructed designs.

| Evidence | Local screenshot |
|---|---|
| Sign-in dark, 1280×720 | [Sign-in](screenshots/sign-in-dark.png) |
| B1: Overview dark, 1280×720 | [Overview](screenshots/overview-dark.png) |
| One-panel workspace dark, 1280×720 | [Workspace before](screenshots/workspace-dark-before.png) |
| B2: launch preview dark, 1280×720 | [Preview](screenshots/launch-preview-dark.png) |
| B3: launch failure dark, 1280×720 | [Nothing here](screenshots/launch-broken-route.png) |
| B5: approval dark, 1280×720 | [Approval](screenshots/approval-dark.png) |
| B6: settings section does not change | [Settings navigation](screenshots/settings-section-stuck.png) |
| B8: light Settings at 390×844 | [Phone clipping](screenshots/settings-mobile-clipping.png) |
| One-panel workspace light, 1440×900 | [Workspace light](screenshots/workspace-light-before.png) |
| B9: four-panel baseline light, 1440×900 | [Four panels before](screenshots/workspace-four-panels-before.png) |

Framework references consulted:
- [Nielsen's ten usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/).
- [Shneiderman's eight golden rules](https://www.cs.umd.edu/users/ben/goldenrules.html).
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/) and [Understanding target size minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- [ARIA window splitter pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/). Pattern guidance is not a conformance certificate; Enter-reset in this mockup differs from the pattern's Enter-collapse convention.

### Visual judgment, separate from functional correctness

The tested desktop views use a coherent light/dark palette, consistent Agent identities, repeated control patterns and recognizable chat/workspace regions. Those are strengths worth retaining. The main hierarchy problem is that warnings, model selection, status metadata and panel chrome compete with the client's next useful action. Small faint metadata, narrow equal-sized tiles, and the approval dialog's weak figure/ground separation reduce readability. More gradients or decorative cards would not solve these problems.

A neutral review does not reject the design simply for using rounded cards, blue accents or a particular font. Those are taste choices unless they impair hierarchy, comprehension, contrast or interaction. No invented numerical design score, conversion prediction or customer sentiment is presented here.

### Practical improvement order

1. **Demo integrity:** repair navigation and one complete Operation-to-artifact journey; label scripted behavior visibly.
2. **Protect user work and consent:** preserve input across all rerenders, make approval scope/focus safe, reconcile simulated state, escape user text.
3. **First-client simplicity:** lead with desired outcome and a recommended Operation; make provider/runtime controls secondary; show next action and useful output before activity statistics.
4. **Readability and reachability:** fix global contrast, phone shell clipping, labels, focus and targets. Pane resizing is only one part of this.
5. **Evidence:** test the revised flow with actual intended clients and compare accepted-result quality, correction effort and real cost with a simpler baseline. These measurements are proposed, not claimed results.
