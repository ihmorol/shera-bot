# Shera Bot client mockup

Static HTML/CSS/JavaScript exploration of S1–S11 from [UI_DESIGN.md](../docs/UI_DESIGN.md), plus an additional Overview dashboard and light/dark themes. **No build step, installed application packages, or backend.** Google Fonts load externally, with system-font fallbacks offline.

**Status, 2026-09-13:** workspace pane resizing/collapse is implemented and tested in the scenarios below. Many other controls are scripted, toast-only or inert. This is not the implemented product runtime, a secure production client, or proof that prototype acceptance criteria pass.

## Documentation for future agents

| Read | Purpose |
|---|---|
| [HANDOFF.md](HANDOFF.md) | User-request evidence, completed changes, verification, failed attempts, known blockers and safe continuation rules. Start here before editing. |
| [REFERENCE.md](REFERENCE.md) | Detailed inventory of every screen, route, Agent/Operation, panel, Settings category, interaction status, fixture and state boundary. |
| [UX_RECOMMENDATIONS.md](UX_RECOMMENDATIONS.md) | Proposed calmer first landing, hierarchy, progressive disclosure and validation strategy. **Not implemented or adopted product policy.** |
| [Review archive](reviews/2026-09-13/README.md) | Independent investor/client audit, pane verification and fourteen original screenshots, plus a docs-conformance audit against the PRD, decisions and UI design spec (findings and recommended fix order; documentation only). |
| [Product documentation](../docs/README.md) | Authoritative PRD, decisions, glossary and traceability; these take precedence over mockup choices. |

## Run it

From the repository root:

```sh
python -m http.server 8000 --directory mockup
```

Open **http://localhost:8000/index.html**. Directly opening `index.html` also works for ordinary static viewing. If port8000 is already serving this directory, reuse it. Inspect an occupied port before stopping anything.

For pane inspection, open **http://localhost:8000/index.html#/agent-general-assistant** and use the workspace toggle in the chat header. Hard-refresh if an old tab shows stale controls; the changed pane assets have versioned URLs.

Do not enter actual provider credentials, private documents or other sensitive content. This mockup does not implement secure secret custody, and user-text HTML escaping has an outstanding defect.

## What actually works versus what is simulated

- **Local interactions:** valid hash navigation, theme preference, sidebar/dock controls, pane resizing, collapse/maximize/reset, selected run display, notification mark-all-read and removal of existing fixture grants.
- **Scripted:** sign-in presentation, canned streamed replies, tool/approval examples and connection-state changes.
- **Not completed:** actual authentication, providers/models, tool execution, files/downloads/uploads, saving, new Operation creation, new approval grants, replay, storage/backups, memory or schedules.
- **Known walkthrough blockers:** launch/creation/notification/recovery links use unsupported chat routes; Settings navigation can stick to a section-specific URL; many success messages overstate the demonstrated operation.

See [REFERENCE.md](REFERENCE.md) for control-by-control status rather than assuming a visible button works.

## Workspace dock

The chat stays primary. Inspection panels can open beside it or in a full-page route.

- **Panels:** Agent profile (`profile`), Task runs (`runs`), Run timeline (`tasks`), Files, Editor, Terminal, Browser, Tool history (`tools`), Private files (`private`). Nine types, at most six open simultaneously in the dock, no duplicate types. The six-panel limit currently lacks explanatory feedback when a seventh is attempted (except the profile header button, which toasts).
- **Defaults:** every direct Agent chat starts with the dock open showing the Agent profile panel; Operation chats keep their seeded panels (`runs`+`tools` for Research Paper). Reopening an emptied dock restores `profile` for Agent chats and `runs` for Operations. At initial load <=980px seeded docks start closed.
- **Layout:** one/two panels in one group; three or more in two groups. Side-by-side columns require dock width >=650px and viewport >980px. Otherwise groups stack. There is no arbitrary panel reordering or floating-window system.
- **Drag:** outer dock boundary, inner column boundary and row boundaries within each group. These are independent axes, not a combined two-axis intersection handle.
- **Sizes:** preferred width440px; client-controlled from 320px up to the whole main area — no cap. Dragging past the threshold (chat space below 320px) snaps the dock to fill everything except the left sidebar, and a **Back to chat** control in the dock header (or any drag back) restores the chat. Internal columns reserve about300px; expanded panels keep144px minimum total height; collapsed headers46px; short layouts scroll.
- **Collapse / Expand:** retain the header, identity and local body state while reclaiming space.
- **Maximize / Restore:** fill the dock temporarily and preserve prior split/collapse preferences.
- **Close / full page:** Close removes a panel from the current layout; the separate full-page link navigates to that panel with more room. Closing the last panel closes the dock.
- **Reset layout:** restore440px preference, equal proportions and expanded panels without closing them or saving files.
- **Keyboard:** arrow keys resize16px; Shift+arrow48px; Home/End limits; Enter resets the selected split. Outer arrows move the boundary physically, so Left widens the right dock. Escape cancels an active drag.
- **Click/tap alternative:** Resize panels disclosure offers a split selector, decrease/increase and Equal/default. Inactive/hidden splits need restoration, expansion or more width first.
- **Phone:** <=980px uses a full-screen sheet, no outer divider and stacked panels; initially seeded docks start closed. This does not repair unrelated mobile shell/Settings defects.
- **Lifetime:** layout preferences and draft snapshots are memory-only; reload resets them. Tested pane actions retain chat/editor drafts. This is **not file saving**, durable layout persistence or verified synchronization across all full-page/chat views.

The pointer implementation supports mouse/pen/touch events and capture/cancellation. Actual touch/pen hardware and cancellation were not exhaustively browser-tested.

## Routes and screen scope

| Entry | Screen |
|---|---|
| `#/login` | S1 login/cap fixture; Continue goes to Overview, not S2 |
| `#/overview` | Additional sample statistics/activity dashboard; **actual post-login landing** |
| `#/app` | S2 chat-first empty home with three shortcuts |
| `#/agent-<agent-id>` | S3 six persistent direct-chat fixtures |
| `#/op-research-paper`, `#/op-adhoc`, `#/op-exam-prep` | S4 existing collaborative Operation fixtures |
| Template button | S5 launch preview with all eight information groups |
| `#/operation/new` | S6 ad-hoc creation form; not a working creation flow |
| `#/workspace/<chat-id>/<panel-id>` | S7 full-page selected workspace panel |
| Approval card / demo overlay | S8 five required approval choices; local scripted response, not grant creation |
| `#/settings` or `#/settings/<section-id>` | S9 fifteen Settings categories; category-switch defect on section deep links |
| Bell | S10 notification popover |
| Global banners / run markers | S11 recovery, storage, offline/reconnecting fixtures |
| S12 admin | Intentionally absent/deferred |

The wordmark is not a Home link. Nested forms such as `#/agent/researcher` and `#/operation/op-research-paper` are **not** working aliases. See the full route table in [REFERENCE.md](REFERENCE.md).

## Files and checks

Implementation: `index.html`, `styles.css`, `screens.css`, `icons.js`, `data.js`, `views.js`, `app.js`. The view/controller use global scripts, not React components. `DockLayout` helpers live in `views.js`.

From repository root, no install required:

```sh
node --check mockup/app.js
node --check mockup/views.js
node --check mockup/dock-layout.test.cjs
node --test mockup/dock-layout.test.cjs
git diff --check
```

**Recorded result:** thirteen pane regression tests passed. Real browser checks covered outer/row/column drag, collapse/expand, maximize/restore, reset, click-based sizing, editor retention, empty timeline and a phone sheet. [Verification and limits](reviews/2026-09-13/pane-verification-2026-09-13.md) distinguish unit/source/browser evidence. The fourteen tests displayed in the mock terminal are only fixture text.

## Design fidelity and limits

Canonical vocabulary is **Pack → Operations → Agents**. Keep Operations, same-Agent identity, independent runs, explicit preview gating and the five approval choices. Agents propose; the intended runtime validates and executes.

The current mockup uses softened navy, blue accents/gradients, rounded surfaces and a light alternative. It is a design exploration, not automatic adoption into the documented dark-only v1 design. Palette tokens and exact feature coverage are described in [REFERENCE.md](REFERENCE.md). The preserved [handoff corrections](HANDOFF.md#8-readme-corrections-made-during-documentation) explain earlier README overclaims rather than erasing their history.

The latest UX request produced recommendations and documentation only. No landing-page redesign, new product decision, PRD change, commit or push was made in that documentation pass.
