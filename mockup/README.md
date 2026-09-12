# Shera Bot — UI Mockup (S1–S11, light + dark)

Static HTML/CSS/JS mockup of the entire client design in [`docs/UI_DESIGN.md`](../docs/UI_DESIGN.md), styled after the owner's reference image (a Donezo-style dashboard) with a slick dark version. **No build step, no dependencies, no backend** — plain files.

## Run it

- Open `index.html` directly in a browser, **or**
- serve the folder: `npx http-server .` / any static server, then open `http://localhost:4173/` (a dev server may already be running there).

Google Fonts (Space Grotesk / DM Sans / JetBrains Mono) load from the network; offline you get system fallbacks.

## The workspace dock (Claude-style dynamic grid)

The chat is the spine; everything the Agents produce opens as a panel in an **adaptive right-hand dock**:

- **Layout**: 1 panel = full height · 2 panels = stacked split · 3+ panels = two columns. Any panel can **maximize** (fills the dock), **pop out** to a deep-linkable full page (`#/workspace/<chat>/<panel>`), or close. The dock edge is **drag-resizable** (320–780px) and each chat remembers its own panels and width.
- **Panels**: Task runs, Run timeline, Files, Editor, read-only Terminal, read-only Browser, Tool history, Private files. The old fixed runs rail is gone — Operation runs live in the same dock. Selecting a run opens its timeline beside the list.
- **Sidebar**: collapses to a 76px icon rail (avatars + state badges, hover names); expands back from the same control.
- **Mobile**: the dock becomes a full-screen sheet, closed by default; the sidebar becomes a slide-over drawer.

## What's inside

| File | Purpose |
|---|---|
| `index.html` | Shell, fonts, theme bootstrap (dark default, persisted in `localStorage`) |
| `styles.css` | Design tokens (dark = softened navy + gradient accents, light = reference adaptation) + base + core components |
| `screens.css` | Screen layouts: overview, chat, dock, full-page workspace, preview, settings, modals, responsive |
| `data.js` | Fixtures per UI_DESIGN.md §9: pack, 6 Agents, 3 Operations, threads, runs in all D8 states, approvals, providers, credits, memory, files |
| `icons.js` | Authored inline SVG icon set (one 24px grid, one stroke) |
| `views.js` | Screen renderers (pure functions) |
| `app.js` | Hash router, state, event delegation, dock state machine, scripted demo runtime |

## Screens (UI_DESIGN.md route map)

- `#/login` — **S1** auth + the at-cap refusal variant (link at the bottom of the card)
- `#/overview` — mockup-only Donezo-style dashboard (KPIs, run-activity chart with hatched *queued* bars, schedules, Operations list, agent activity, outcomes donut, live-run timer). Reached from the wordmark/logo; the app still lands chat-first per S2.
- `#/app` — **S2** chat-first landing (empty state with the three shortcuts)
- `#/agent-…` — **S3** six Agent direct chats (presence, provider override, tool cards, run cards, artifacts, streaming demo)
- `#/op-research-paper`, `#/op-exam-prep`, `#/op-adhoc` — **S4** Operation chats (roster bar with removable coordinator, dockable runs, @-addressing picker, pack pin label)
- `#/operation/new` — **S6** ad-hoc creation (same-pack roster picker, coordinator choice incl. peer-to-peer)
- Launch a pack template (sidebar or Overview button) — **S5** preview gate with all eight required field groups
- Dock panel → pop-out icon, or `#/workspace/…` — **S7** full-page workspace (deep-linkable per panel)
- Approval cards / bell / ⚡ demo menu — **S8** five verbatim choices, fixed fields, reminder timeline, mute semantics; approving creates a visible runtime grant (revocable in Settings → Permissions)
- `#/settings/…` — **S9** all fifteen sections
- Bell — **S10** notification center · top banners — **S11** recovery / storage / disconnect + replay
- **S12 admin console is intentionally absent** (deferred, E7)

## Scripted demo (⚡ button in the topbar)

Stream a reply · read-only tool call (runs automatically) · risky action (pauses, opens the approval dialog; keys `1`–`5` answer it) · disconnect → reconnect with a replayed-events batch. Sending a message in any chat streams a reply with a typing cursor.

## Fidelity notes

- Vocabulary is canonical everywhere: **Pack → Operations → Agents**; approval copy is verbatim from PRD §8.
- **Dark theme (owner direction: "softer navy + gradient colors")**: lifted, less-saturated navy (canvas `#0a0f1c`, cards `#101828`, elevated `#16213a`), soft-white text `#eef4ff`, calm emerald live status (`#34d399`) instead of the neon green. Gradients are focal moments only: hero KPI card, live-run card, primary buttons, active nav wash, focused panel header. If adopted for the product, this amends UI_DESIGN.md §2.1 as owner reference material; the documented v1 palette remains the fallback.
- The light theme is the owner's reference-image exploration on the same cobalt brand. The product itself remains dark-only in v1 — the token architecture keeps the light theme cheap, which this mockup demonstrates.
- The zero-offset brand glow (`--glow`) appears only on hero/login marks, per its documented "emphasis only" role; the hatched chart bars encode *queued/held* runs (legend included), mirroring the reference image. Both were flagged by the mechanical detector and kept deliberately.
- Everything is mock data. "Keys" are fake masked strings; nothing here is a secret.
