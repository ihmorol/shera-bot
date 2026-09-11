# Shera Bot — Client UI Design Specification

**Status:** Implementation-ready UI design specification (design record under PRD §24 delegation)
**Date:** 2026-09-11
**Scope:** The `apps/web` client of the private prototype — every user-facing surface, page, component, state, and copy rule.
**Authority:** This document resolves the PRD §21 Visual/design TODO register at the specification level. It does not change any product decision. Where this document could be read as contradicting the PRD or decisions D1–D45, **the PRD and decision records win** and this document must be corrected. Pure visual taste (exact layout feel, density, illustration style, final logo art) is intentionally left open for the product owner's reference material and handwritten sketch (2026-09-11); when that material lands, it amends this document.

**Sources analyzed:**

- [`PRD.md`](PRD.md) — synchronized baseline, D1–D45 (2026-09-11)
- [`GLOSSARY.md`](GLOSSARY.md) — canonical vocabulary
- [`TRACEABILITY.md`](TRACEABILITY.md) — acceptance coverage and open items
- [`decisions/confirmed-decisions.md`](decisions/confirmed-decisions.md) — D1–D39
- [`decisions/closure-decisions.md`](decisions/closure-decisions.md) — D40–D45, E1–E8
- [`../business-landing-portfolio/`](../business-landing-portfolio/) — the only implemented visual identity (dark theme, tokens extracted in §2.1)

---

## 1. Non-negotiable rules for the UI

These come from recorded decisions and the PRD. Every screen spec below assumes them.

1. **Vocabulary:** "Agent" everywhere — UI copy, labels, code identifiers, schemas (D44). The word "Expert" must not appear in any user-visible surface. "Scene" is retired; the word is **Operation** (D29, D44). Hierarchy is **Pack → Operations → Agents**.
2. **Sidebar has exactly two sections:** **Agents** and **Operations** (D41, PRD §4.1). No third chat type; the old "task-specific chat" is retired (D41).
3. **No workspace switcher** — one workspace per user in the prototype; the container is the workspace (D40). Records are internally scoped by `workspace_id`, but no UI surface exposes workspace management.
4. **Six Agents, three pack-defined Operations** (student pack v1, D43): General Assistant, Researcher, Developer, Citation Manager, Programming Tutor, Study Planner; Operations: Research Paper, Programming Assignment, Exam Preparation. Each Agent appears in at least two Operations.
5. **One persistent Agent identity** everywhere it appears: one profile, one direct chat, one private memory, one settings surface, with a scoped assignment per Operation (D39). The UI must never present "the Researcher in Operation A" and "the Researcher in Operation B" as different identities.
6. **Operation launch is preview-gated:** nothing executes before the user confirms the preview (D30, AC23). The preview shows purpose, agents, skills, connectors, provider/model, estimated credits, approval requirements, and expected outputs.
7. **Agents propose; the runtime decides** (D4, D23 rule 7). The UI never renders an agent action as done before the runtime validates it. Tool calls render as proposals → validated → executed/rejected, per the event stream.
8. **Approval safety copy is fixed:** the five approval choices and the reminder sequence come verbatim from PRD §8; the approval prompt shows the exact tool, arguments summary, target resource, side effect, and expiry (D9).
9. **No secrets anywhere:** provider keys, Git credentials, and browser cookies never render in the UI, not even masked beyond the settings surfaces designed for them (PRD §16, D22). Errors are redacted (`safe_message` only — D23 rule 4).
10. **Responsive and accessible from day one:** current Chrome/Edge/Firefox/Safari, ~360px mobile through large desktop, keyboard-accessible core flows, visible focus, meaningful labels (PRD §18, AC20).
11. **Event honesty:** the UI must distinguish live, replayed, delayed, and disconnected events (PRD §14, D26). It must never silently merge replayed events into live ones or fake activity.

---

## 2. Design foundations

### 2.1 Design tokens (carried from the landing site brand)

The product UI reuses the identity already approved on the marketing site so the brand is consistent. Exact values are the starting point; the owner's sketch may adjust accents.

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#050a14` | Page background |
| `--surface` | `#08111f` | Sidebar, panels, cards |
| `--surface-elevated` | `#101d31` | Modals, dropdowns, composer |
| `--brand` | `#3b82f6` | Primary actions, active states |
| `--brand-deep` | `#2563eb` | Hover/pressed |
| `--sky` | `#7dd3fc` | Accents, eyebrows, links |
| `--cool-highlight` | `#dcebff` | Gradient text ends, highlights |
| `--text` | `#ffffff` | Primary text |
| `--muted` | `#91a4bd` | Secondary text, metadata |
| `--live` | `#16f456` | Live/running/success status dots |
| line color | `rgba(148,163,184,0.2)` | Borders, dividers |
| line-accent | `rgba(191,219,254,0.34)` | Focused/active borders |
| glow | `0 0 80px rgba(59,130,246,0.22)` | Hero/preview emphasis only |

**Status palette (extend the landing palette for the five sidebar states, PRD §4.1):**

| State | Color | Treatment |
|---|---|---|
| Running | `--live` green | Pulsing dot (respects `prefers-reduced-motion`) |
| Approval-required | amber `#fbbf24` | Solid dot + badge count |
| Failed | red `#f87171` | Solid dot |
| Unread | `--brand` blue | Bold name + count pill |
| Completed | `--muted` | No dot; checkmark in run views only |

**Typography** (next/font/google, as on the landing site):

- **Space Grotesk** — display: headings, wordmark, screen titles. Tight tracking (−0.02em to −0.05em).
- **DM Sans** — body: chat text, settings copy, labels.
- **JetBrains Mono** — eyebrows, file paths, tool names, code, status meta. Uppercase eyebrows with 0.16em letterspacing.

Type scale (desktop): 12 / 13 / 14 (chat default) / 16 / 20 / 28 / 36 px. Chat text renders at user-selectable 12–18px via settings (PRD §21.19 test plan covers tokens; theme is dark-only in v1 — a light theme is a future option, not prototype scope).

**Theme:** dark-only for the prototype, matching the landing site (PRD §21.19: design tokens and visual regression plan are a register item; a token-only architecture keeps a light theme cheap later).

### 2.2 Layout system

- Spacing on a 4px grid; container gutters 16px mobile / 24px desktop.
- Breakpoints: `sm` 360px (min supported), `md` 768px, `lg` 1024px, `xl` 1440px.
- Desktop app shell: sidebar (280–320px, collapsible to icon rail) + chat column (fluid) + workspace panel (0 / 360 / 50% / full-page). Workspace panel resizing is drag-adjustable with persisted width per conversation.
- Mobile shell: chat list full-screen → conversation full-screen → workspace panel becomes a bottom sheet / full-screen route with a grab handle.
- Long lists (chat history, file browser, tool history, memory list) use windowed rendering (PRD §18: pagination/virtualization).

### 2.3 Accessibility baseline (PRD §18)

- Full keyboard reachability of core flows: navigate sidebar, send message, open workspace panel, answer approval, open settings. Documented tab order per screen.
- Visible focus ring (2px `--sky` outline, 2px offset) on every interactive element; never `outline: none` without replacement.
- Approval dialogs are modal focus traps; the approval choices are the only initially-focusable actions.
- Screen-reader labels: every icon-only button has an accessible name; agent messages announce the sender ("Researcher said:"); streaming text uses `aria-live="polite"` with throttled announcement; tool/approval events use `aria-live="assertive"`.
- Color is never the only signal — every status pairs color with icon/text.
- Respect `prefers-reduced-motion` (landing site already does; all pulse/glow/typing animations follow).

### 2.4 State design language

Every data surface defines all of these states up front (PRD §21.17): **loading** (skeleton matching final layout, not spinners), **empty** (one-line explanation + the single most likely next action), **error** (redacted `safe_message` + retry when retryable — D23 rule 4), **disconnected** (persistent banner, §6.4), **reconnecting** (banner switches to spinner + "Replaying missed events…" during cursor replay), **queued/paused/failed/recovered** (task run states per D8/D32).

---

## 3. Information architecture

### 3.1 Route map

```
/login                         S1  Auth (Google OAuth)
/app                           S2  Dashboard shell (redirects to last chat or Agent empty state)
/app/agent/[agentId]           S3  Agent direct chat
/app/operation/[operationId]   S4  Operation chat
/app/operation/new             S6  Ad-hoc Operation creation
/app/operation/[id]/preview    S5  Launch preview (pack-defined Operations)
/app/chat/[id]/workspace       S7  Workspace panel (inline) · /app/chat/[id]/workspace/full (full page)
/app/settings/*                S9  Settings sections
/app/admin/*                   S12 Admin console (optional/deferred)
```

Modals (approval dialog, notification center, roster editor) overlay any route. Deep links to a pending approval jump to its conversation with the dialog open.

### 3.2 Sidebar specification (PRD §4.1, D29, D41)

```
┌──────────────────────────────┐
│ [logo] Shera Bot      [ bell │  ← global chrome row
│                        gear ] │
│──────────────────────────────│
│ AGENTS            [+ ]       │  ← section is fixed; "+" opens Agent settings, not creation
│  ● General Assistant      2   │  ← SidebarItem anatomy below
│  ● Researcher            (1)
│  ○ Developer
│  ● Citation Manager
│  ● Programming Tutor
│  ○ Study Planner              [⏸]  ← approval-required dot variant
│──────────────────────────────│
│ OPERATIONS          [+ New]  │  ← "+" = ad-hoc creation (S6)
│  ▣ Research Paper        ▶   │  ← pack-defined template entries
│  ▣ Programming Assignment
│  ▣ Exam Preparation
│  ── active chats ──
│  ▣ Research Paper · run 2  ⏸ │
│  ▣ Ad-hoc · 3 Agents     ●   │
│──────────────────────────────│
│ [credits pill] [storage] [≡] │  ← connection + account footer
└──────────────────────────────┘
```

**SidebarItem anatomy:** avatar (Agent) or Operations glyph (pack-defined template) / name / trailing state (dot, unread count, approval badge, running spinner) / optional last-activity timestamp on hover.

- **Agents section** lists the six pack Agents as persistent direct chats (AC3). They are never deletable in v1; each opens Agent settings via context menu.
- **Operations section** has two visual groups: **pack-defined Operation templates** (launch → preview S5) and **Operation chats** (instances, open directly). Ad-hoc chats are labeled with their roster summary ("Ad-hoc · 3 Agents") until the user names them.
- Sidebar item states — unread, running (spinner), approval-required (amber + count), failed (red), completed (clears to quiet) — mirror PRD §4.1 and drive the notification badge in global chrome.
- No workspace switcher, no pack switcher (D40, D19). The pinned pack (student v1) is shown once as a footer label, not a control.
- Mobile: sidebar becomes a slide-over drawer; the five states render as the same badges.

### 3.3 Global chrome

- **Connection indicator** (footer dot): live (green), reconnecting (amber spinner), disconnected (red; banner appears per §6.4).
- **Notification center** (bell; S10): unread notification list, mute shortcuts.
- **Recovery banner** (S11): top-of-app banner when any task is `RECOVERY_REQUIRED` or the container is recovering (PRD §13: "The dashboard shows recovery status").
- **Credits pill** (footer): Shera credits remaining; reserved amount on hover (D21).
- **Account menu**: profile (Google identity), tier badge (Light/Balanced/Heavy — simulated, PRD §3.2), settings link, storage usage summary (warn at ≥80% per PRD §12).

---

## 4. Screen specifications

Each screen: purpose → entry points → layout → required content/components → interactions → states → sources.

### S1 — Login / Auth

- **Purpose:** Google OAuth is the only login method (PRD §3.2, AC1).
- **Layout:** centered brand panel on `--canvas`: logo mark + wordmark, one primary button "Continue with Google", tagline from the landing voice. No email/password fields anywhere.
- **States:** loading (button spinner); **signup-cap refusal** — a distinct, friendly screen: "Shera is in private testing and is at its five-account limit." No retry button (cap is server-enforced); **error** (redacted, retry allowed); **returning user** (straight to `/app`).
- **Not shown:** tier selection, payments, admin login (admin is a DB flag, PRD §3.2).
- **Sources:** PRD §3.2, §19 AC1.

### S2 — Dashboard shell

- **Purpose:** Telegram-like home; the sidebar is the product (§3.2). Landing view shows the most recent conversation, or an empty-state "Pick an Agent or launch an Operation" panel with three shortcuts (one Agent, one pack-defined Operation preview, one ad-hoc creation).
- **Required:** sidebar (§3.2), global chrome (§3.3), recovery banner (S11) when applicable, storage warning banner at ≥80% (PRD §12).
- **Mobile:** drawer + list.
- **Sources:** PRD §4.1, D29, D40, D41.

### S3 — Agent direct chat

- **Purpose:** persistent conversation with one fixed-role Agent (PRD §4.2). Spawns task runs automatically when execution needs lifecycle supervision (D34) — the UI shows this as an inline run card, not a screen change.
- **Header:** Agent avatar, name, role line (from pack profile), presence (session active / hibernating — on-demand session, D32), provider/model override control (per-conversation override, PRD §9, AC11), overflow menu → Agent settings, memory, private folder (via workspace panel private tab).
- **Thread:** message list (§5.1 components): user messages, Agent messages with sender attribution, tool-call cards, artifact cards, progress steppers, run cards ("Task run #3 · Comparing theories · RUNNING"), system notices (retry, pause, recovery).
- **Composer:** text input (Enter sends, Shift+Enter newline), attach file, agent-addressing not needed here (single agent), send-state (sending → sent → failed/retry; idempotent command — D23 rule 6). Disabled + explanatory state when no provider is configured (D17: clear configuration state, never fake completion).
- **Interactions:** scrollback with day separators; jump-to-unread; streaming token rendering (§6.1); stop/cancel button while a run is active (cancellation stops parent/child/queued work — PRD §8, AC15).
- **States:** all §2.4 states; empty state ("Say hello — {Agent} is ready"); hibernating-session note (subtle, first time only).
- **Sources:** PRD §4.2, §5.1–5.6, D32, D34, D39.

### S4 — Operation chat

- **Purpose:** persistent reusable collaborative workspace from a pack-defined Operation or ad-hoc (D41). Holds the user, selected Agents, shared Operation context, and **multiple independently tracked task runs** (D31, AC24).
- **Header:** Operation name (editable for ad-hoc), pack version pin label (AC22), run count, roster button.
- **Roster bar** (below header, collapsible): one chip per Agent — avatar, name, role; **coordinator chip** on the General Assistant by default with a "Coordinator" badge and a remove action (D42: default coordinator is removable; if removed, a quiet banner notes peer-to-peer coordination, runtime still authoritative). Roster editing opens an inline roster editor dialog on this screen: user can add/remove same-pack Agents directly; coordinator proposals (`ExpertInvited` → `AgentInvited` etc., D36/D44) appear as inline proposal cards the user approves or dismisses; cost/access-increasing changes require user approval (D36).
- **Task runs panel:** a runs list (right rail on desktop, tab on mobile) — each run: ID, goal, state (D8 vocabulary: QUEUED, RUNNING, WAITING_FOR_APPROVAL, RETRYING, SUCCEEDED, FAILED, PAUSED, RECOVERY_REQUIRED…), credits used, artifact count, own timeline. Runs are never merged (AC24); selecting a run filters the thread's run cards and opens its timeline.
- **Thread:** as S3, plus **@-addressing** — typing `@` opens the roster picker; addressing an Agent routes visibly ("To Researcher:"); messages to the Operation at large are unaddressed. Agent attribution on every message (PRD §21.5).
- **Persistence:** chat remains after tasks complete for follow-ups and new runs (PRD §4.2); "New run" affordance in composer area.
- **States:** all §2.4; empty roster never occurs (minimum: user + 1 Agent; runtime-validated).
- **Sources:** PRD §4.2, D31, D34, D36, D41, D42; AC5, AC22, AC24.

### S5 — Operation launch preview

- **Purpose:** the hard gate before any execution (D30, AC6, AC23). No model call, no task, no chat creation before confirmation.
- **Presentation:** full-screen modal (desktop) / full page (mobile) opened from a pack-defined Operation template.
- **Required content (complete field list):**
  1. **Purpose** — Operation description from the pack.
  2. **Agents** — recommended roster with roles; each add/remove limited to the same pack (D41); coordinator marked (D42).
  3. **Skills** — per-Agent skill list (pack-declared, D38).
  4. **Connectors** — recommended connectors with connection status (connected / not configured); a connector may be recommended but never auto-installed (D38).
  5. **Provider / model** — each Agent's effective default, with per-Agent override controls.
  6. **Estimated credits** — per the reservation model: estimate range + "actual usage settles after execution" note (D20); custom-provider Agents marked "no Shera credits".
  7. **Approval requirements** — which risk classes this Operation will hit and what will pause (D35 tiers).
  8. **Expected outputs** — artifacts the Operation aims to produce.
- **Actions:** "Launch Operation" (primary) and "Cancel". Launch creates the chat, then the first run. An "advanced" preference for immediate start in future versions is allowed by D30 but **not built** in the prototype.
- **Sources:** D30, D38, D20; AC6, AC23.

### S6 — Ad-hoc Operation creation

- **Purpose:** create an Operation chat with a custom same-Pack roster, no reusable definition (D41).
- **Flow:** name (optional, auto "Ad-hoc") → roster picker (six Agents, multi-select, min 1) → coordinator selection (defaults to General Assistant; "no coordinator" allowed — peer-to-peer mode, D42) → optional provider/model overrides → Create. Ad-hoc obeys the same pinning/validation as pack-defined (D41).
- **No preview step is required** for ad-hoc creation (the preview gate applies to pack-defined launches, D30), but the created chat shows the same roster/skills/connectors summary collapsible.
- **Sources:** D41, D42; AC5.

### S7 — Workspace panel

- **Purpose:** the agent-harness-style expandable workspace behind every chat (PRD §4.3): file/folder browser, file editor, terminal panel, interactive browser panel, task/progress panel, tool-call history/results, shared files, private Agent files.
- **Entry:** toggle in chat header (inline panel: 0 → 360px → 50% → full-page route `/app/chat/[id]/workspace/full`).
- **Tabs:**
  - **Files** — tree browser of the shared workspace; upload; context actions (download, delete with confirm — delete is never automatic, PRD §12).
  - **Editor** — file editor for text files; saving a local mutation shows a preview + approval when an Agent requests it (D35: local file mutation → preview and approval); the user editing directly is a user action, not agent-gated.
  - **Terminal** — **read-only live view** of agent terminal activity (streamed output, current command, working directory); user-side terminal control is future work (PRD §20). Command/executions initiated by Agents show command + working directory + resource policy + approval state (D35).
  - **Browser** — read-only live view of the shared browser session (current page screenshot/thumbnail, URL bar); interaction is future work.
  - **Tasks** — run list + selected run timeline (checkpoint markers per D33: meaningful steps, not per-token), progress events, retry history (max 3, PRD §8), state transitions (D8).
  - **Tool history** — chronological tool calls: name, version, arguments summary, result/status, risk class badge, approval linkage; redaction-safe (PRD §7, §16).
  - **Private files** — per-Agent private folder viewer; switching Agent via selector; clearly labeled private (D39 identity, PRD §4.3).
- **Conflict prevention:** the UI must prevent conflicting simultaneous control (PRD §4.3) — when an Agent holds a task-scoped write lease (D6), user editing of the same path is disabled with an explanatory tooltip ("Developer is editing this file · task #4"); concurrent reads stay allowed.
- **Full-page mode:** same tabs, more width; deep-linkable; "Back to chat" returns with panel state preserved.
- **Mobile:** tabs become a bottom sheet; live views prioritize the active one.
- **Sources:** PRD §4.3, §7; D6, D33, D35; AC7, AC8.

### S8 — Approvals

- **Purpose:** risky actions pause for approval (PRD §8). This is the safety centerpiece; copy and fields are fixed.
- **Dialog (in-thread card + modal on open):** shows **exact tool, arguments summary, target resource, side effect, and expiry** (D9), the requesting Agent and conversation/task scope, and the risk class badge. Code execution additionally shows command, working directory, and resource policy; repository mutation shows diff/branch/worktree (D35).
- **Choices (verbatim, PRD §8):**
  1. **Approve this execution only**
  2. **Always approve this tool**
  3. **Always approve this tool for this agent**
  4. **Reject this action**
  5. **Cancel the task**
- Scoped grant variants for tool/agent grants follow D35's ladder ("… in this workspace", "… for this repository/path") where applicable; the chosen grant is created by the runtime, never by a prompt (D9).
- **Waiting state:** the run shows `WAITING_FOR_APPROVAL`; reminder timeline rendered on the approval card: immediate → 15 min → 45 min → 3 h → 24 h, none after; mute controls (mute this approval / this task / all reminders) stop notifications only — the task stays paused and the approval stays visible (PRD §8, E3).
- **Grants review:** Settings → Permissions & approvals lists all active grants (scope, tool + version, expiry, created by) with revoke (D9, D35). "Full access" is never a mode — only visible, revocable grants (D35).
- **Propagation:** approval decisions sync across tabs (PRD §14); decisions are immutable events (D9).
- **Sources:** PRD §8; D9, D35, E3; AC13, AC26.

### S9 — Settings

Category list follows D16 (onboarding and settings use the same commands/schemas). Every setting shows: recommended default, current value, why it matters, risk/cost impact, and reset-to-default; advanced items progressively disclosed (D16).

| Section | Must cover | Sources |
|---|---|---|
| Account | Google identity, tier (display only), storage usage | PRD §3, §12 |
| Agents | Per-Agent profile: role, editable user instructions, memory link, default provider/model, tool defaults | PRD §5, D39 |
| Providers & models | Provider list (built-in OpenAI/Anthropic/Google, Ollama/local, OpenAI-compatible, custom); custom provider form: display name, protocol, base URL, API key or no-key mode, model id, optional org/project, optional headers, optional request params, **connection test**, enable/disable, per-agent/per-conversation assignment; keys **masked**, revoke/replace only — never re-displayed | PRD §9, D17, D22; AC10, AC11 |
| Model budgets / Credits | Shera credits remaining, reserved for active tasks, used this month, custom-provider usage; per-run cost drill-down; exhausted-credit pause state | D20, D21 |
| Tools | Tool inventory (built-in + agent-created): name, purpose, owner, scope (private/shared), risk class, permissions, version; agent-created tool creation/activation states (preview → approval → runtime grant) | PRD §7, E4 |
| Permissions & approvals | Approval defaults, active grants table + revoke, reminder/mute settings | D9, D35, PRD §8 |
| Workspace | Pinned pack display (student v1, version), workspace policy readouts | D19, D40 |
| Files & projects | Projects list, import/clone entry, per-repo credentials (masked, revocable), project visibility (shared / restricted to selected Agents) | PRD §10 |
| Memory | Shared workspace memory + per-Agent private memory; scopes (account/workspace/Operation/task/Agent-private); view, edit, delete, permanently forget, disable auto-memory globally/per-Agent; provenance inspection; version restore; publication queue (private → Operation requires explicit publish; sensitive requires approval) | PRD §11, D37 |
| Schedules & watchers | Autonomous triggers list (schedules, file/Git changes, webhooks, task-completion, conditions) with pause/edit | PRD §8, E5 |
| Notifications | In-app + browser toggles, mute scopes | PRD §14 |
| Privacy & retention | Redaction explanation, data location statement (local-first, D2) | PRD §12 |
| Runtime & resources | Tier table, current usage, queue state | PRD §3.3, E1 |
| Git & repositories | Worktree/branch policy display, merge review defaults | PRD §10, E6 |
| Backups & recovery | Snapshot info (every 6h, latest 7), restore is admin-triggered (read-only info for users) | PRD §12 |

**Onboarding (first arrival, skippable):** D16 — zero-config start is the default (dashboard works immediately with safe defaults); the wizard is ordered, skippable, reopenable, and each step keeps the recommended default. Steps: welcome → provider/model check (uses deployment default; no credential invention) → approvals briefing (what pauses) → memory briefing → done. Same schemas/commands as Settings (D16).

### S10 — Notifications center

- Bell → panel: unread notifications (completion, failure, approval-required, recovery), each deep-linking to the conversation/task; mark-read; per-item mute.
- Delivery channels: in-app always; browser notifications only when tab open but unfocused (PRD §14); toggles in Settings.
- Badge counts mirror sidebar states (§3.2).

### S11 — Recovery & status surfaces

- **Recovery banner** (top of app, PRD §13): states from D32 — `RECOVERING` ("Restoring your workspace…"), `RESUMED` (transient confirmation), `RECOVERY_REQUIRED` ("A task needs your review" → deep link). Pending approvals remain visible and pending through recovery (PRD §13).
- **Run-level recovery markers:** in task timelines, checkpoint → restart → resume markers; a paused-for-review run shows what could not be proven safe (D32/D33: never claim exact resume falsely — copy must say "resumed from last safe step").
- **Resource states:** queued-on-exhaustion shown as QUEUED with reason (E1: healthy work is never killed for capacity); credit-pause state on runs (D20).
- **Storage:** banner at ≥80%, blocking-with-explanation at 100% (create/expand blocked; chat/read/delete/export/cleanup remain — PRD §12).

### S12 — Admin console (optional / deferred)

PRD §15 defines the function list (users, enable/disable, tiers, container provisioning/restart/stop, status/resources, backups/restore, emergency cancel-all, recent failures). TRACEABILITY lists "exact admin UI scope versus manual/admin API operation" as an **open item**; E7 makes Phase 7 (admin console) optional for the prototype. This document therefore specifies it as **deferred**: if built, it is a separate `/admin` route gated on the administrator flag, reusing the same tokens, with security-relevant actions confirmed by typed dialog. Do not build in the UI-first pass.

---

## 5. Component inventory

| Component | Spec |
|---|---|
| Message bubble (user) | Right-aligned, `--surface-elevated`; status ticks (sending/sent/failed-retry) |
| Agent message | Left-aligned with **avatar + name + role** attribution (PRD §21.5); streaming cursor while live |
| System notice | Centered muted line (reconnect, recovery, roster changes, pack pin notes) |
| Tool-call card | Header: tool icon, name, version, risk-class badge; body per risk tier (D35): read-only → "ran automatically" collapsed; local mutation → preview diff; code execution → command + workdir + resource policy; repo mutation → diff/branch/worktree; external write → target + effect. Footer: status (proposed/validated/running/succeeded/failed/blocked) + approval link |
| Progress stepper | Semantic steps only (D33), not tokens; current step highlighted; checkpoint markers |
| Run card / run timeline | Run ID, goal, state (D8 vocabulary), started/duration, credits used, artifacts, checkpoint/retry/recovery markers |
| Approval card | See S8; fixed fields, five choices |
| Artifact card | Type icon, name, size, producer Agent, provenance ("from run #3"), open/preview/download |
| Roster chip / coordinator badge | S4 |
| Operation preview card | S5 layout |
| Status dot + badge set | §2.1 palette; all five sidebar states + D8 run states |
| Avatars | Six Agents (distinct hue + initial glyph; final art from owner sketch), user (Google avatar), Operations glyph; one avatar per Agent identity everywhere (D39) |
| Composer | S3; disabled states for no-provider/disconnected/capacity-queued |
| Empty / loading / error states | §2.4; every surface defines all |
| Disconnect banner | §6.4 |
| Replayed-event marker | §6.2 |

## 6. Realtime & interaction specification

### 6.1 Streaming
`message_delta` tokens render incrementally with a typing cursor; markdown rendered after stream completion for stability. Throttle DOM updates (≥30fps budget). Stop button cancels the run (termination propagates to the worker tree — D32).

### 6.2 Event honesty (PRD §14, D26)
Every event renders with a delivery class:
- **Live** — no marker.
- **Replayed** — subtle left-border + "replayed" tag on the batch boundary ("N missed events replayed"), never interleaved silently as if live.
- **Delayed** — timestamp drift flagged when event time ≫ receive time.
- **Disconnected** — banner (§6.4).
The UI acknowledges a cursor only after render; duplicate `event_id`s are ignored (D26).

### 6.3 Commands
All user actions that mutate state (send, approve, cancel, roster change, settings save) go through idempotent typed commands with visible pending state; double-submits are safe (D23 rule 6, PRD §14). Ack target ≈500ms — optimistic rendering with reconciliation against the authoritative event (PRD §18).

### 6.4 Connection lifecycle
Disconnect → banner "Connection lost — you can keep reading; work continues server-side" (tasks survive browser closure, PRD §14, AC25). Reconnect → replay with progress ("Replaying missed events…") → resume live. Multi-tab: all tabs share state; approval decided in one tab propagates to others (PRD §14).

## 7. Copy & terminology rules

**Do / Don't**

| Do | Don't |
|---|---|
| Agent, Agents | Expert, specialist (as a noun for the product object) |
| Operation, Operation chat, task run | Scene, group chat, task chat |
| Pack (student pack v1) | Bundle, plan, subscription |
| "pausing for your approval" | "asking permission" (grants are runtime objects) |
| "This action was blocked by policy" | Raw internal errors, stack traces, header dumps |

- Approval dialog labels are **verbatim** from PRD §8 (S8). Do not paraphrase safety copy.
- Errors show `safe_message` + retry when retryable; internal details never render (D23 rule 4, PRD §16).
- Memory copy must make provenance visible ("remembered from …") and must never offer to store secrets (PRD §11: credentials/secrets always rejected — the UI shows the rejection, not an input that pretends to work).
- Never promise outcomes ("I will merge") — Agents propose; copy reflects runtime authority (D4).

## 8. PRD §21 resolution map

| §21 item | Resolved in | Status |
|---|---|---|
| 1 Name/logo/typography/colors/voice | §2.1, S1 | Typography/colors resolved from landing brand; **logo final art open** for owner sketch |
| 2 Dashboard IA and sidebar details | §3.2, S2 | Resolved |
| 3 Wireframes and breakpoints | §2.2 | Structure resolved; pixel wireframes come from owner sketch |
| 4 Agent identity/avatar/status/header | §2.1, S3, §5 | Structure resolved; **avatar art open** |
| 5 Member display and agent attribution | S4, §5 | Resolved |
| 6 Message/tool/progress/error/approval/artifact components | §5, S8 | Resolved |
| 7 Workspace panel sizing and full-page transition | S7 | Resolved |
| 8 File/editor/terminal/browser/task/tool-history layouts | S7 | Resolved |
| 9 Live browser/terminal visualization | S7 | Resolved (read-only views) |
| 10 Approval dialog wording and hierarchy | S8 | Resolved (verbatim) |
| 11 Notification center, badges, muted states | S10 | Resolved |
| 12 Provider/model settings screens | S9 | Resolved |
| 13 Memory-management screens | S9 | Resolved |
| 14 Tool inventory and permission screens | S9 | Resolved |
| 15 Project import/Git/worktree/merge-review screens | S9 (Files & projects), S8-pattern merge dialog per PRD §10 (summary, changed files, validation, conflicts, target branch — minimal view) | Resolved at spec level |
| 16 Admin console layouts | S12 | **Deferred** (E7; open item in TRACEABILITY) |
| 17 Loading/empty/offline/reconnect/queued/paused/failed/recovered states | §2.4, S11 | Resolved |
| 18 Keyboard and screen-reader interaction | §2.3 | Resolved |
| 19 Design tokens and visual regression plan | §2.1 | Tokens resolved; regression test plan is build-phase work |

**Deliberately open for the owner's reference + sketch:** final logo art, avatar illustration style, exact layout taste/density, pixel-level wireframes, whether any accent color changes. These amend §2 when the sketch lands; none of them unlock or block the structural specs above.

## 9. Mock-data requirements (for the UI-first build)

Fixtures (Zod-typed via `packages/contracts` so the real runtime slots in later):

1. **Pack fixture** — student v1: 6 Agents (names, roles, default tools, per-PRD §5 profiles), 3 Operation definitions (Research Paper, Programming Assignment, Exam Preparation) with skills, connectors, coordinator, expected outputs.
2. **Conversations** — one seeded direct chat per Agent; 2 Operation chats (one pack-defined with 3 runs in different states, one ad-hoc with 2 Agents).
3. **Runs** — covering: RUNNING with streaming, WAITING_FOR_APPROVAL (external-write example), RETRYING (2 of 3 attempts), SUCCEEDED with artifacts, FAILED, PAUSED, RECOVERY_REQUIRED.
4. **Approvals** — one pending with full D9 field set; one historical grant (tool-scoped) shown in settings.
5. **Providers** — one platform provider (admin-funded), one custom OpenAI-compatible entry; masked key display.
6. **Credits** — balance, reservation on the running run, month usage (D20/D21 fields).
7. **Memory** — workspace memory items with provenance; one Agent-private memory; one pending publication request (D37).
8. **Files** — small shared workspace tree + one private folder per Agent.

Scripted demo scenarios (mock runtime): send message → streamed reply; trigger a tool proposal → auto-run read-only; trigger a risky action → approval dialog with the five choices; approve → grant creation → repeat action runs without prompt (AC26); cancel a run; disconnect/reconnect with replay. These let the UI be evaluated against AC shapes 3, 5, 6, 7, 13, 23, 24, 26, 27 before any backend exists.

## 10. Traceability appendix

| Acceptance criterion (PRD §19) | UI surface(s) |
|---|---|
| 1 OAuth + cap | S1 |
| 3 Six Agents as direct chats | S2, S3 |
| 5 Ad-hoc Operations | S6 |
| 6 / 23 Launch preview | S5 |
| 7 Live messages/progress/tools/approvals/results | S3, S4, §6 |
| 8 / 9 Tools work; agent-created tools | S7 tool history, S9 Tools |
| 10 / 11 Providers configured/tested; defaults + overrides | S9, S3 header |
| 13 Approvals pause; choices + reminders | S8 |
| 14 Retries ≤3 then pause+notify | S11 run states |
| 15 Cancellation stops tree | S3/S4 stop control |
| 16 Persistence across restart | S11 (recovery surfaces) |
| 17 Branch/worktree + merge approval | S8-pattern merge dialog, S9 Git |
| 20 Responsive layouts | §2.2, all screens |
| 22 Pack/version pinning visible | S4 header, S9 Workspace |
| 24 Multiple independent runs | S4 runs panel |
| 25 Browser-close survival | §6.4, S11 |
| 26 Read-only auto / mutation preview / grants | §5 tool cards, S8, S9 |
| 27 Private memory publication boundary | S9 Memory |

Decision coverage: D29→§3.2; D30→S5; D31→S4; D32/D33→S11; D34→S3; D35→§5/S8/S9; D36→S4; D37→S9 Memory; D38→S5/S9; D39→§1.5, S3; D40→§1.3, §3.2; D41→§1.2, §3.2; D42→S4; D43→§1.4; D44→§1.1, §7; D45→§10 table; D9→S8; D16→S9; D17→S9; D20/D21→S9 Credits; D22→S9; D26→§6.2; D6→S7.

Open items this document does **not** close (remain in TRACEABILITY): admin UI scope (S12 deferred), student pack skill/tool/connector complete mapping (fixtures in §9 are provisional until that record exists), exact coordinator-removal lifecycle visuals, per-tool recovery semantics wording.
