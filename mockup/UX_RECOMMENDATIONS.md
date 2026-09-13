# A calmer first-use experience

**Date:** 2026-09-13
**Status:** UX recommendations, **not implemented or adopted product decisions**.
**Goal:** reduce avoidable first-landing overwhelm while keeping the product's capabilities, safety and canonical vocabulary intact.
**Audience:** product owner, designers and future implementation agents.

No design can guarantee that nobody will feel overwhelmed. The defensible goal is that an intended first-time client can identify where to start, understand the next consequence, and obtain a useful result without needing a walkthrough. That must eventually be tested with real people; the current evidence is expert review and browser observation.

Read the [current reference](REFERENCE.md) for what exists and the [independent audit](reviews/2026-09-13/design-audit-localhost-2026-09-13.md) for supporting evidence. This document does not authorize a broad UI rewrite.

## 1. Core recommendation

**Show the next useful action first. Show the machinery only when it helps the current task.**

The first screen should answer three questions:
1. What can I accomplish here?
2. What should I do now?
3. What happens if I continue?

Today, the mockup instead presents recovery, storage usage, run counts, Agent activity, model controls and multiple entry paths before a client has completed anything. The underlying capabilities are valuable; presenting them simultaneously is the problem.

A calmer interface does not mean fewer capabilities. It means fewer decisions at once, clearer grouping, useful defaults and predictable access to details.

## 2. Product boundaries that this recommendation preserves

Sources: [PRD §§4, 8, 9, 12, 18, 24](../docs/PRD.md), [UI design S2/S5/S8/S9](../docs/UI_DESIGN.md), [glossary](../docs/GLOSSARY.md), [traceability](../docs/TRACEABILITY.md).

- Keep **Pack → Operations → Agents**. An Operation remains reusable collaborative work with independent runs, not an ordinary one-off chat renamed for marketing.
- Keep the sidebar's two main sections, **Agents** and **Operations**. Do not introduce a third chat taxonomy or a workspace/Pack switcher.
- Keep all six Agent identities and all three Operation templates available. Reorder or progressively disclose details, not delete capabilities.
- Chat remains primary, with optional workspace inspection and a full-page view.
- Pack-defined Operations still require explicit preview confirmation before execution. An initial suggestion, typed goal or selected template is not approval.
- Retain all eight preview groups and all five approval choices, including rejection and cancellation. Do not hide safety options in an advanced menu.
- Keep genuine pending approvals, recovery problems, disconnected state and storage warnings visible when applicable. Do not suppress real warnings to make the screen look clean.
- Start with deployment defaults when valid; do not invent credentials or simulate success when a real provider is unavailable.
- Credits remain internal prototype accounting, not a price or subscription. The intended prototype has no real payments.
- Terminal/browser observation stays read-only. Resizing panels is not authorization to add takeover controls.

The existing UI specification already calls for a chat-first home, zero-config defaults, progressive disclosure and skippable/reopenable onboarding. Restoring that intent is different from inventing a new product mode.

## 3. Separate the first visit, returning visit and demo account

| State | Recommended primary content | Avoid |
|---|---|---|
| New account with valid defaults | One plain-language heading, a clear starting action, and a small number of example outcomes | Filled activity charts, invented previous jobs, fake unread badges, default recovery/storage warnings |
| Returning account | Last conversation, unfinished work and the next relevant action; important pending decisions remain findable | Restarting a tutorial or forcing the user to reselect their Agents every time |
| Demo account | Clearly labelled sample data and optional scenario controls | Presenting sample activity, container status or “live” output as real execution |
| Missing provider / configuration | Specific explanation and direct configuration/help action | A happy success state or canned answer pretending configuration worked |
| Real blocked/recovery state | What happened, affected work, safe next action and what remains paused | Hiding the issue or replacing it with vague “something went wrong” copy |

For a clean demo scenario, seed a genuinely empty account with storage below the warning threshold and no recovery-required runs. Do not merely hide warnings while retaining fixture values that require them. Keep the existing populated/recovery scenarios for explicit demonstrations and regression tests.

## 4. First-screen composition

Recommended initial hierarchy:

1. **One outcome-oriented heading:** “What would you like to work on?”
2. **One short explanation:** “Ask an Agent, or use an Operation to work with several Agents.”
3. **A primary starting action:** “Ask General Assistant,” leading to its direct chat. No new routing architecture is needed for this entry.
4. **A small set of outcome shortcuts:** for example, compare research sources, work through a programming assignment, prepare for an exam. Each retains its actual Operation name and opens its preview rather than starting execution.
5. **Optional setup/help link:** brief, skippable and reopenable; safe defaults remain usable.

The specification currently describes three home shortcuts: one Agent, one pack-defined Operation preview, one ad-hoc creation. A minimal first pass should improve those labels and hierarchy rather than silently changing the entire entry model. A later outcome-focused arrangement can be reviewed as a visual-design amendment, with all entry paths preserved.

### Conceptual wireframe, not a built screen

```text
Shera Bot                                      Help   Notifications   Account

Agents                 What would you like to work on?
 General Assistant     Ask an Agent, or use an Operation with several Agents.
 Researcher
 Developer             [ Ask General Assistant ]
 Citation Manager
 Programming Tutor     Research Paper
 Study Planner         Compare sources and prepare a cited draft. [Preview]

Operations             New ad-hoc Operation
 Templates             Choose your own same-Pack collaborators. [Create]
 Active conversations
                       Optional setup and help
```

This illustrates hierarchy, not final dimensions or mandated copy. Keep a normal text-based sidebar on desktop: an icon-only rail can make a newcomer memorize symbols. Collapse is an optional user preference, not the default cure for complexity.

### Returning-user content

Use the last relevant conversation as the default, with a concise contextual summary if needed. Inside that context, prioritize:
- **Needs your decision:** a pending approval with a specific consequence.
- **Continue working:** the unfinished Operation or direct chat.
- **Ready to inspect:** an actual output with preview/download.

These can be groups in the content area; they are not new sidebar sections or product objects. Do not add a separate analytics dashboard as a prerequisite to work. The existing Overview can remain a secondary mockup exploration rather than the initial landing.

## 5. Reduce attention competition, not just word count

| Current friction | Recommended treatment | Reason |
|---|---|---|
| A colorful “14 runs” card dominates landing | Give stronger emphasis to the primary action or actual pending decision; move illustrative statistics to secondary Overview | Activity does not tell a first-time client what to do |
| Multiple full-width seeded warnings | Correct the scenario state; render genuine warnings compactly with specific actions | Prevent alarm fatigue without concealing problems |
| Pack version, presence and runtime metadata compete with names | Keep the Agent/Operation title prominent; make technical metadata secondary and available in details | Recognition should precede internal concepts |
| Numerous rounded cards carry equal weight | Use headings, spacing and simple lists for related information; cards only where containment or selection is useful | Everything should not look equally important |
| Repeated monospaced tiny labels | Use normal readable body text for explanations; reserve monospace for code, IDs and paths | Technical styling should not make ordinary instructions harder to read |
| Several accent/gradient surfaces | Keep one clear action accent; use semantic warning/error colors for real states | Attention has limited capacity |
| Small faint text | Increase contrast and comfortable reading size, not just container size | An uncluttered page that cannot be read is not simpler |

Suggested starting typography, subject to viewport review: 16px task instructions/chat where practical, 13–14px secondary labels, and a restrained title scale. These are design recommendations, not WCAG font-size requirements. Measure real text contrast: normal text needs 4.5:1 for AA, with the specified large-text exceptions.

Use spacing to group related controls: a panel title close to its actions, a goal next to its status, an output next to its producing run. Decorative changes should follow those relationships rather than cover up missing structure.

## 6. Chat should feel like a place to work, not configure infrastructure

- Keep Agent/Operation name, current task and composer obvious.
- Make provider override accessible through a clearly labelled secondary control or details area; show a blocking configuration issue immediately if one exists.
- Avoid asking newcomers to pick a model, coordinator and tool policy before their first ordinary question when safe defaults are already configured.
- Replace implementation explanations in the default scripted reply with an honestly labelled sample that relates to the example task. Do not claim model execution until it exists.
- A progress summary should say what is happening and what requires the client, with expandable technical details and separate run identity retained.
- Keep output links beside their run. Clicking a filename should open the relevant content, not a generic editor fixture.
- Preserve drafts, cursor and reading position when opening menus/panels or returning to a conversation. Pane work addressed several cases, not the full input lifecycle.
- Fix mention insertion before promoting @-addressing. It must not delete the rest of a message.

## 7. Workspace: simple by default, flexible when needed

The implemented drag/collapse controls are useful for experienced use. They do not by themselves simplify first arrival.

Recommended defaults:
- New-user landing: dock closed.
- Direct chat: show the requested file/output panel only when needed, with a visible way to reopen it.
- Operation: surface relevant progress/decision in context; open one useful inspection panel on demand rather than four unrelated panels.
- Technical panels such as Terminal and Tool history remain in Add panel and full-page mode, not automatically in every client's first view.
- Explicit user-resized/collapsed layout should not be unexpectedly reset by a routine event. Do not promise durable cross-session layout storage while implementation is memory-only.
- Label the workspace toggle visibly where space allows. Collapse, maximize, full-page and close need distinct names/tooltips.
- A collapsed panel retains its header; closing is removal from the current layout. Teach this with the control itself, not a forced tour.
- Keep minimum usable dimensions and stacking on narrow layouts. Do not shrink text to fit four panels.

The current six-open-panel cap is an implementation detail. A future UI should explain the limit or offer replacement/close guidance rather than silently ignore an addition.

## 8. Preview: show the decision first, preserve the detail

Before confirmation, make these easy to find together:
- What this Operation is for and what input it still needs.
- Expected outputs.
- Participating Agents and coordinator.
- Estimated credits and when the estimate becomes a reservation.
- What may pause for approval.

Keep skills, connector status and provider/model details in well-labelled expandable groups if space is limited. They remain reviewable before confirmation. Do not collapse configuration errors or consequential risks out of sight.

Use a visible/sticky footer where appropriate so Launch and Cancel remain reachable, but check that it does not cover content or keyboard focus. Selecting a preview must preserve the chosen template; launching must enter that Operation with coherent simulated state or a real acknowledged command.

Ad-hoc creation remains separate and optional. Preserve name/roster/coordinator/model choices across edits, enforce a selected-roster coordinator, and do not silently turn ad-hoc creation into a required onboarding task.

## 9. Approvals: simplify explanation, never weaken informed consent

Add a plain-language summary above the exact technical fields, for example:

> Study Planner wants to create 12 events in your calendar.
> People sharing that calendar may see them.

Then retain the actual tool, arguments summary, target, side effect, expiry and all five mandated choices. Make Reject this action and Cancel the task discoverable without first consenting. Keep permission scope understandable before choosing reusable approval.

The one-time choice can be the visually recommended option, but do not preselect or automatically execute it. Do not rename away the exact policy choices, hide broad scope, or suggest that revoking permission undoes a completed external effect.

Before visual changes, fix dialog containment, background interaction and shortcut scoping. Good-looking consent UI with the wrong active target is unsafe.

## 10. Settings: group without removing

Retain every section while introducing a clear common/advanced distinction in the Settings area, not a new main sidebar taxonomy.

Suggested grouping for review:
- **Account and everyday preferences:** Account, Notifications, Credits, Files/projects.
- **Agents and connections:** Agents, Providers/models, Memory, Schedules/watchers.
- **Safety and system details:** Permissions, Privacy/retention, Tools, Workspace, Runtime/resources, Git, Backups/recovery.

Group labels are a proposed wayfinding aid, not adopted terminology. Permissions and privacy must remain easy to locate, especially from an approval. Add task-oriented links from the relevant UI rather than requiring people to search fifteen categories. Repair deep-link/category navigation before reorganizing it.

Every control should state current value, relevant default, and consequence. In the mockup, disable or label unavailable actions instead of showing false saved/test-passed messages. In the real product, use the authoritative command/schema and state acknowledgement, not these fixtures.

## 11. Phone layout and accessibility

- One primary surface at a time: conversation or workspace sheet, with a visible return/close action.
- Reflow header controls and warning text; no partially visible sidebar strip obscuring content.
- Keep input and primary actions reachable without horizontal hunting.
- Prefer generous click/touch areas. WCAG 2.2 AA's minimum is 24×24 CSS pixels or a valid exception; 44×44 is a useful touch recommendation and the enhanced AAA criterion, not the AA minimum.
- Keyboard users need the same resizing and navigation outcomes. Keep the implemented click/tap alternatives, not only drag and keyboard.
- Test focus with dialogs, sheets, menus and sticky footers. Hidden backgrounds must not receive focus accidentally.
- Preserve text labels with icons; do not rely on color alone.
- Keep reduced-motion support and avoid perpetual decorative activity.

The phone workspace sheet passed a focused 390×844 check. This does not resolve phone Settings or establish 320px reflow, text zoom, screen-reader or cross-browser compliance.

## 12. Recommended implementation order and proposed verification

The following is a prioritized recommendation, **not a new acceptance-criteria register**. Owners are proposed roles, not assignments to named people. Tests link to existing product intent; no PRD acceptance status is changed.

| Priority | Work | Proposed owner / boundary | Proposed evidence |
|---|---|---|---|
| First | Fix launch/create/Settings/notification routes, modal targeting and unsafe text rendering | Frontend; runtime contracts remain authoritative in the real application | Route/handler regressions, safe literal-text test, keyboard dialog test stored with the future change |
| First | Complete one honest Operation-to-result path | Frontend + product owner; clearly bounded simulation until runtime exists | Exact scenario, preview/launch/result screenshots and state checks |
| Next | Restore chat-first home with valid empty/returning/demo states | Design + frontend; visual layout only unless scope changes | First-viewport screenshots and navigation checks for each state |
| Next | Make model/tool/runtime detail secondary; preserve safety visibility | Design + frontend | All required preview groups and approval choices remain accessible before action |
| Next | Fix global contrast, phone shell, focus and labels | Design/accessibility + frontend | Measured contrast, target/focus geometry, keyboard and reflow evidence |
| After | Client comprehension testing | Product/design research | Real observed first action, misunderstandings, task completion, help requests and post-task confidence |

### Suggested client tasks for an actual study

Ask representative researchers/developers/students to try without coaching:
1. Find how to ask a question and how that differs from launching an Operation.
2. Choose Research Paper and explain what will happen before confirming.
3. Find the output and identify its source/run.
4. Explain what a reusable approval permits, then reject an action safely.
5. Make more room for a file, collapse it and reopen it.
6. Find how to change a model and where private data is processed.

Record what actually happens, including failures. Set performance targets after observing a baseline; do not invent completion times, “zero overwhelm” claims or conversion improvements. Store future observations in a dated review folder with participant consent and without sensitive personal content.

## 13. Alternatives considered and trade-offs

- **Retain the analytics-first landing:** useful for supervision, but weak for the first useful action. Keep as secondary exploration, not the recommended default.
- **Force a setup wizard:** can explain concepts, but delays value and conflicts with zero-config/skippable intent. Use optional, reopenable guidance instead.
- **Default to an icon-only sidebar:** gains width but increases recognition/recall burden. Keep labels for newcomers and user-controlled collapse.
- **Expose all workspace panes immediately:** demonstrates breadth but divides attention and compresses content. Use on-demand panels; retain the resizable power-user layout.
- **Remove tools/models/advanced settings entirely:** superficially simpler but loses required control and discoverability. Group and disclose rather than remove.
- **Hide warnings or refusal choices:** visually calmer but dishonest or unsafe. Fix fixture state and presentation, never conceal the underlying consequence.
- **Rewrite the brand/colors first:** might look different without making tasks clearer. Prioritize interaction integrity and hierarchy, then polish.

No alternative is recorded here as superseded product policy. Adoption that changes user-visible scope, roles, safety, persistence or acceptance criteria must follow PRD §24 and the decision/traceability process.
