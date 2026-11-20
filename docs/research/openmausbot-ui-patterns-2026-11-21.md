# OpenMausBot UI reverse-engineering — pattern extraction for the D52 migration wave

**Status:** Research evidence annexed to [D52](../decisions/owner-decision-d52-interface-mode-ui-migration-2026-11-21.md) (owner instruction 2026-11-21: reverse-engineer the OpenMausBot UI and migrate the patterns).
**Provenance:** Extracted 2026-11-21 by a delegated analysis agent reading the pinned sparse clone (`aede7d817df9`) at `/home/emon-morol/projects/github-cloud-projects/OpenMausBot` — 22 text files across `src/components`, `src/lib`, `src/hooks`, `src/state`, `src/locales/en.json`. No images, no `enterprise/` content, no upstream code copied. Apache-2.0 core; patterns-not-pixels per the E43 addendum and D52.
**Authority:** `UI_DESIGN.md` (as amended by D52 §3.4) + the impeccable gate stay the rendering authority for every adoption; this document describes THEIR mechanics so Shera Bot can implement its own equivalent against Shera Bot's runtime-owned state (G4), vocabulary (G1), and honesty rules (D26).

# OpenMausBot UI reverse-engineering (pattern extraction, pinned aede7d8)

Pattern extraction for adaptation into Shera Bot. No code copied. All paths relative to
`/home/emon-morol/projects/github-cloud-projects/OpenMausBot/`. `t("key")` strings are verbatim from `src/locales/en.json`.

Design tokens live in `src/styles.css` (~line 142): `--color-app #121212`, `--color-panel #0e0e0e`, `--color-raised #202020`,
`--color-composer #1f1f1f`, `--color-menu #1f1f1f`, `--color-card #1f1f1f`, `--color-inset #1b1b1b`, `--color-control #282828`,
`--color-hairline #383838`, ink scale `--color-ink #f5f5f5` / `-secondary f5f5f5a8` / `-tertiary f5f5f591`, `--color-accent #1084fe`,
success `#38d591`, danger `#ff5667`, warning `#ff9800`. Dark-first, single neutral gray ramp + one accent + 3 semantic colors.
Type scale: 10 / 11 / 12 / 13 / 14 / 15 / 17 / 19 / 21px only. Motion: 150–300ms opacity/translate, `motion-reduce:` guards everywhere.

## 1. App shell & navigation model

- Root: `src/App.tsx` `Shell` — `flex h-full flex-col`: `WindowFrameBar` → status strips (`UpdateBanner`, `CloudAsleepStrip`,
  `LiveConnectionStrip`, `CloudSendStrip`, `HomeLine`, `AppNotices`) → `relative flex min-h-0 flex-1` row of:
  `PlacesRail` (60px far-left rail of saved "places"/servers, `src/components/PlacesRail.tsx`) → `Sidebar` → main view →
  right-side sibling panels.
- Main view is a single switch on `state.activeView` (App.tsx:356–397): `team-map` | `files` | `web-panel` | `routines` |
  first-run screens (`CloudWelcome`, `CloudIntent`, `CloudEngineSignIn`) | `NoEngines` | `EmptyChatShell` (onboarding) |
  `GroupView` | `ChatView` | loading main. One pane at a time; no tabs.
- Side panels mount as **siblings of the main view, not overlays**: `BotSettingsDialog key={`settings:${bot.id}`}`,
  `ComputerPanel key={`computer:${bot.id}`}`, `RoomPanel key={`room:${group.id}`}`, `InboxPanel`, `NotificationsPanel`,
  `InspectorPanel`, `ActivityPanel` (App.tsx:399–422). Comment: "Sibling panels need distinct keys: two keyed `bot.id`
  collide in React's keyed reconciliation." When the viewport can't fit sidebar+panel (`SIDEBAR_AND_PANEL_FIT` media query)
  the sidebar auto-collapses (`collapseSidebar`), and panels get `overlay` prop → sheet-over-content instead of push.
- `src/rail.tsx` is NOT the sidebar: it is the Electron window chrome page (renders `ChromeRail`, the window's own places
  rail); the main app redirects elsewhere. Real left rail = `PlacesRail`; sidebar = `Sidebar`.
- Sidebar (`src/components/Sidebar.tsx:1237–1259`): `<aside>` `border-r-[0.5px] border-edge bg-panel`; width via
  `--sidebar-width` custom property; `advanced ? 320px : 280px`, icons density `92px` (simple rail) / `80px`; drag-resize
  handle clamps 240–480px (`src/lib/sidebar-preferences.ts:171–175`, max = `viewportWidth - 320`). Density is user-resizable:
  dragging the edge below threshold snaps to a pure avatar column (`SidebarResizeHandle`).
- Structure top→bottom: top row (workspace switcher pill + search + "+" menu) → `OrganizationIdentity` → search input
  (advanced: always visible `h-8 rounded-full` field; simple: revealed search pill) → `SidebarInboxRow` → universal pinned
  bots → attention panel (`SidebarAttentionPanel`, pinnable) → pinned threads panel → bot tiles (simple) → sections:
  Pinned / Group chats / Bot threads / Bots / user "departments", each `SidebarSectionHeader` (11px uppercase
  `tracking-[0.08em]` label, collapsible, droppable) → footer nav. Rows grouped in `GlassScrollFrame` with fade edges.
- Mobile: sidebar becomes absolute drawer (`max-md:absolute … max-md:-translate-x-full`), hamburger button absolute
  top-left, scrim `bg-black/50`. Keyboard: Cmd+N new bot, Cmd+1–9 jump to nth bot, Cmd+Shift+↑/↓ cycle (App.tsx:172–204),
  ContextMenu / Shift+F10 opens row menus.
- Density discipline: every row `min-h-8`, single-line title + optional one-line preview, `truncate` on all text,
  `tabular-nums` on timestamps, secondary info at 10–12px, hover-reveal actions only (opacity-0 → group-hover:opacity-100),
  active row `bg-raised`, hover `bg-raised/50`. Colors via Tailwind theme tokens, never raw hex in components.

## 2. Sidebar/roster row anatomy

Bot row — `src/components/Sidebar.tsx` `BotListItem` (697–921):
- Left: `BotAvatar` (animated mascot, `stateForBot`; working/noticing ⇒ animated; sizes 44 comfortable / 36 simple /
  32 when thread list shown / 36–54 icons density). Overlaid badges: `BotModelBadge` bottom-left (provider mark);
  bottom-right status dot — working = green `bg-success` dot (`data-testid="working-dot"`), waiting-on-you = warning
  circle with bold `!`, teammate-wait = accent dot, queued = gray dot; chief = `Crown` accent glyph; live call = phone badge.
- Text column: line 1 = pin glyph (12px, secondary) + name (`RenameTitle` inline-editable, 15px semibold advanced /
  14px medium simple) + chief crown + role chip (`SidebarBotRole`) + timestamp right-aligned (`formatTime(last.at)`,
  12px tabular-nums) — timestamp only on the selected row in advanced (fades out on hover to make room for actions),
  always on phones. Line 2 = **activity preview**: `botPreview()` from `src/components/sidebar-preview.ts` — status
  first ("Waiting for you…" warning bold, "Waiting on a teammate…", "Working"), else the newest previewable message
  (skips receipts & screen frames; simple mode "quotes the bot": walks back over plain tool steps to the newest said
  line). Group rows prefix `"{name}: "` / `"You: "`.
- Right hover cluster (`opacity-0 group-hover:*`, keyboard/touch always visible): `+` new thread, `+` folder, `⋯` menu.
- Unread = 1.5–2px accent dot; expanded thread list shows dot next to name instead.

Thread row — `src/components/SidebarThreadRow.tsx` (`SidebarThreadRow`, memo with `sameThreadRow` custom compare):
- Indented `pl-6` under the bot's expander chevron; button `min-h-8 py-1.5 text-[13px]`; title truncate; byline inline
  after title (`max-w-[45%]` tertiary): `opened by {name}` / `closed by {name}` / `Archived` / `Snoozed`.
- Right cluster: `time` element (`tabular-nums text-[10px]`) with `threadUpdatedLabel` — <45s "just now", "{count} min
  ago", "{count} h ago", "yesterday", "{count} d ago", else locale short date; relative only while <7 days old
  (`stampClock`); `useRelativeNow()` ticks every 30s while tab visible.
- State marks: `Pin` glyph 11px; "Waiting" warning text; `Clock3` teammate-wait; spinning loader while working; "Queued"
  text; unread = `size-1.5 rounded-full bg-accent` dot with aria-label "Unread".
- Inline rename on double-click (input maxLength 80, Enter saves via `nextRename`, Esc cancels); Shift+F10 / ContextMenu
  opens row menu; `title` attr composes "title · timestamp · status · Unread".
- List shaping (`SidebarThreadRow.tsx:96–138,178–193`): `attentionRank` waiting-on-you 0 > working 1 > teammate 2 >
  queued 3 > unread 4 > active 5 > rest 6; sort by rank then original index. Visible = pinned always; archived only if
  active; closed/snoozed only if attention-demanding; others capped at **6 newest** + "Show all" footer; threads opened by
  bots fold into a collapsed "Opened by bots" group with count (`HelperThreadGroup`).
- Data source: store `Bot.tasks` (Task: threadId/title/pinned/unread/activity/busy/queued/openedBy/closedBy/archivedAt/
  snoozedUntil/updatedAt) + `state.pendingQueued`. All server-owned; the sidebar only renders it.

## 3. Context menu contract

Two generators, both portal to `document.body`, viewport-clamped (`Math.min(x, innerWidth-228/240)`,
`Math.max(8, …)`), focus first enabled item on open and restore opener focus on close, Escape closes+refocuses,
outside-mousedown closes, roving arrow-key nav via shared `navigateThreadMenu`. Sheet classes `src/components/menu-recipe.ts`:
`MENU_SHEET = popover-surface … rounded-[var(--radius-menu)] border border-hairline/50 bg-menu p-1.5`,
`MENU_ITEM = min-h-[30px] … text-[14px]`, separator `mx-1.5 h-px bg-hairline/50`. Disabled = `opacity-40 cursor-default`;
hint = `title` attr; destructive = `text-danger`; async actions use `keepOpen` + in-button spinner.

Bot menu — `src/components/SidebarBotMenu.tsx` (simple variant, lines 202–358):
Pin/Unpin → Move to department (flyout: departments with check, — , "New department…", "Remove from department") →
Mark as read (spinner "Marking…" while in flight) / Mark as unread → — → New thread → View threads → Set as main thread
(disabled hint "This is already the main thread") → — → Rename → — → Copy conversation ID → More (flyout: Edit profile,
Make/Remove Chief of Staff (disabled hint "Choose Claude or an ACP model provider first"), Duplicate, Change owner, Move
to team, Delete all conversations…) → — → Archive (disabled hints: "Choose another Chief of Staff first", "Keep at least
one active bot") → **Delete (danger, always last)**.
Advanced variant (361–433) adds New task folder/New folder at top, Mark all conversations as read, fuller labels
("Mark as Unread", "Edit Profile", "New Bot" capitalized), same destructive-last.

Thread-row menu — `src/components/SidebarThreadRow.tsx:351–377`, order: Copy link → Rename → Regenerate title →
Move to folder (inline `<Select>` with emoji folders + "No folder") → Pin/Unpin → Remove link → Archive/Unarchive
(disabled while working) → Snooze block (3 presets: "Until new activity" (=0: wake on next activity), "Until 6 PM"
(next 18:00), "Until 9 AM tomorrow") + "Stop snoozing" when snoozed → Refresh permissions (title explains it applies the
bot's current approval level) → **Delete thread (danger)** → `ConfirmDialog` "Delete thread?" / ""{title}" and its
conversation will be deleted. This cannot be undone."

Room (group) menu — `src/components/Sidebar.tsx` `RoomContextMenu` (227–442): Rename chat/channel (inline input with
save/cancel buttons) → Set description (inline input, maxLength 120) → Move to context → Copy conversation ID →
Delete chat/channel (danger last).

What each item mutates + persistence: pin/unread/snooze/archive/title are store actions (`updateTask`/`updateBot`
dispatch, `src/components/SidebarThreadRow.tsx:196–207 threadRowActions`) and persist server-side — NOT localStorage.
localStorage holds only *view* prefs: `openmausbot.sidebarDensity`, `.sidebarWidth`, `.sidebarWidth.simple`,
`.sidebarToolsLayout`, `.sidebarAttentionPinned.v1`, `.sidebarCollapsedSections.v1`, `.sidebarSectionOrder.v1` (+ a
`.simple.v1` variant), `.pinnedCircles`, `.universalPins`, `.pinnedCircleOrder.v1` (`src/lib/sidebar-preferences.ts:10–20`).
Pattern: every pref is a `useSyncExternalStore` hook + session cache + `storage` event listener so two windows agree.

## 4. Onboarding interview cards

Flow: `src/components/onboarding/WelcomeFlow.tsx` — beats `["meet","chief"]` (`src/lib/onboarding.ts:93 BEAT_ORDER`,
`beatsFor({hosted})` — hosted admins get only "meet"). Appears on first run when `welcomeDue()` (config.onboarding has no
`completedAt` or version < WELCOME_VERSION — server-owned so an app update re-runs it). Draft resume: every beat change
writes `{beat}` via `saveWelcomeDraft` (per-browser), `resumeBeat()` reopens where the user left; a reload mid-flow
resumes; completion writes `onboarding: {completedAt, version}` to config + sessionStorage `omb.onboarding.welcomeFinished`.
Analytics `onboarding_step` per beat.

MeetScreen (`MeetScreen.tsx`): full-screen `role="dialog"`, centered composition — title `t("onboarding.meet.title")`
= "Meet {app}" (28px, `tracking-[-0.02em]`), 72px mascot whose face switches to "listening" while the mock composer
types, and `DemoComposer`: a static fake composer (rounded-[22px], plus-button left, round arrow-up send right) that
after a 700ms placeholder shows `t("onboarding.meet.placeholder")` "Welcome to {app}" then types
`t("onboarding.meet.demo")` "Hand off any task to your team of bots" grapheme-by-grapheme (35ms/char, reduced-motion
shows it whole, caret animated). Primary pill below: if no working AI it is the sign-in pill (recommended AI ranked by
`aiChoices` — Claude account first, then ChatGPT plan; the app **sends a real test message** and shows green
"Connected to {name}" when it answers); otherwise "Next" fading in 150ms. Secondary line: "Other ways to connect" ·
"Set up later" (both plain text buttons). Keyboard: Escape = Later, Enter on the screen presses `[data-primary]`,
`trapTab()` keeps Tab inside (WelcomeFlow.tsx:31–47).

ChiefIntro (`src/components/onboarding/ChiefIntro.tsx`): 440px modal (`animate-pop-in`, scrim `ui-scrim`) over the
inert app (`EmptyChatShell.tsx` renders a disabled main containing only a fake composer "Ask anything, or drop a file").
Anatomy: 64px avatar with crown badge → title `t("onboarding.chief.title")` "Introducing your Chief of Staff" → body
`t("onboarding.chief.body")` "Your main point of contact. It checks in on its own and coordinates work with your other
bots." → two buttons: "Choose an existing bot" (opens `role="radiogroup"` list; bots that can't lead are `opacity-40`
`aria-disabled` with tooltip "Choose Claude or an ACP model provider first") and primary "Create Chief of Staff".
Guard: first 300ms (`CHIEF_GUARD_MS`) swallows clicks/Enter so a double-click on the prior screen can't fire Create.
Escape backs out of the chooser; ↑/↓ moves the radio; Create plays a flight animation of the avatar into its sidebar
tile (`landInSidebar`), then the chat opens. The first conversation stays quiet afterward via hint `met-chief-v1`.

Interview cards in chat — `src/components/QuestionCard.tsx` + shell `src/components/AskCard.tsx`:
- `AskCard`: max-w-[560px], `rounded-[24px]`, elevated surface; `stays` prop pins it `sticky` while it blocks the turn.
- Header `AskHeader`: 16px asker avatar + `t("ask.header.asks")` "{name} asks" + origin link "· {origin label}".
- Title 15px medium; meta "{answered} of {count} answered"; dismiss X when dismissable.
- Choice chips `AskChoices`: stacked full-width radio/checkbox buttons (`min-h-10 rounded-[14px] ring-[0.5px]`),
  pick = `bg-ink/[0.08]` + check glyph, sending = spinner and other rows disabled, multi adds hint
  `t("question.multiHint")` "Choose all that apply". Keyboard: `moveChoiceFocus` roving arrows/Home/End, RTL-aware.
- Free text always available: `AskReply` — a mini composer inside the card (rounded-[16px] `bg-ink/[0.045]` pill,
  placeholder `t("question.somethingElse")` "Something else…" when choices exist, else "Type your answer"; Enter sends,
  Shift+Enter newline; send button tinted the asking bot's color via `askPrimary(color)`).
- One-tap: a single non-multi question with options sends immediately on pick (`answersInOneTap`); otherwise footer
  "Submit answer" / "Submit answers" / "Done" disabled until every question answered. Progress tabs for multi-question
  cards (pills with green check when answered).
- After answering the card collapses to a one-line `AskSettledLine`: "You chose: {x}" / "You answered: {x}" /
  "Stopped before you answered" / "Expired before anyone answered" / "Closed without an answer"; multi shows "Details"
  toggle. Error under card: `t("ask.error")` "Couldn't send your answer. Try again." Focus returns to composer after
  send (`returnFocusToComposer`).
- `typedPast` prop: once the human types a normal message, the card "recedes" (`data-quiet`, choices go secondary gray)
  but stays answerable — nothing is ever blocked, only de-emphasized.

## 5. Model/provider picker

`src/components/ModelPicker.tsx` (advanced, 1045 lines) + `SimpleModelMenu.tsx` (simple) + `src/components/bot-settings/ModelSection.tsx`.

- Trigger (both modes): pill with provider mark, model label `max-w-[160px] truncate`, " · {provider}" secondary,
  variant/effort suffix, `UsageBars`, chevron. `disabled` while the bot's turn runs; tooltip = summary + scope line
  ("Uses {name}'s model" / "This thread's own model") + attention line + busy line `t("model.threadBusy")` "Stop this
  thread's turn before changing its model". Attention = tiny warning dot on the provider mark when setup/sign-in/org
  blocks apply — the reason is always in the title, never guessed.
- Full popover 420px (simple 300px, `role="dialog"`): left **provider rail** (`ModelEngineRail` — one column of
  engines, Claude/OpenAI plan families grouped with account switchers), right pane: header = display name + refresh
  button + status chip (`bg-warning/10 text-warning` or `bg-success/10 text-success` rendering
  `engineStatus(instance)` — "Setup required" / "Sign-in required" / etc.), scope toggle (two pills "Only this thread" /
  "Thread + bot default" with one-line help: "This thread only. It keeps this model when the bot's model changes." vs
  "The bot's model: this thread, groups, and every thread that uses the bot's model."), then list.
- List: `MENU_LABEL` headers "Suggested" / "All models · {count}" / "{count} results"; compact = 5 suggested models +
  "Show all {count} models" expander; search appears past 5 models; no-match "Nothing matches "{query}""; local-models
  pane with "Use a local model" footer row + "{count} available", empty "No local models found" + hint naming runtimes.
- **Dimmed-with-reason pattern**: a provider that can't serve models never just disables rows — it replaces the list
  with an explanation: policy pane `t("policy.managedBy")` "Managed by {organization}" + "Turned off by your
  organization"; blocked pane renders the inline setup/sign-in UI plus `t("model.afterSetupMany")` "{count} models will
  appear after setup." / `t("model.localSoon")` "Local models will appear as soon as the agent is installed." Switching
  to a provider that resets approval shows `ConfirmDialog` "Switch model with Ask permissions?" with a paragraph
  enumerating exactly what is cleared and what is untouched.
- Effort/reasoning: `EffortRow` chips `Default | Low | Medium | High` (aria-pressed; title "Ask for {level} reasoning
  effort"; Default's title `t("model.effort.noLevel")` "Send no effort level and let the provider decide"); compact
  Select in the popover footer; simple menu shows a "Thinking" section with the same levels; provider-specific
  "variants" get `ModelVariantRow` with "Use session setting", a clear link, and missing-variant help lines
  ("Saved variant is unavailable. Choose another or use the session setting.").
- Contained mode (`contained` prop, used by settings): label block on the left ("Default model" + 13px secondary help
  "For groups and every thread that uses the bot's model. A thread keeps its own model only when you pick one in it."),
  trigger on the right. `ModelSection.tsx` stacks: Default model card → Effort card (help "How hard this bot thinks in
  groups and every thread that uses its model.") → Fallback chain (ordered 1./2./3. list, max 5, same-account flagged
  "· same account") → keep-warm select. After a bot-default change the chat shows a dismissable
  `ThreadModelsLine` notice chip listing threads that kept their own model.

## 6. Empty states & definition strips

Formula everywhere: **one avatar/icon, one value-promise sentence, one CTA (or none)**; 13–14px, `text-ink-secondary`,
centered, never more than two lines.
- Empty chat (`src/components/ChatEmptyState.tsx`): 64px avatar, name, `bot.description || t("chat.emptyPrompt")`
  "Send a message to start the conversation." (max-w-[360px]).
- Empty inbox (`src/components/inbox/InboxPanel.tsx:94`): `t("inbox.empty")` "Nothing for you yet." / search miss
  "Nothing in the inbox matches."
- Empty folder: `t("task.empty")` "No threads yet" (11px tertiary, inside the expanded folder).
- Automation runs: `t("automations.panel.noRuns")` "It hasn't run yet." under the "Recent runs" uppercase header.
- "What should happen?" (`src/components/automations/NewAutomation.tsx`): the "+ new automation" dialog is a textarea
  with placeholder `t("automations.newBox.placeholder")` "e.g. every morning at 9, send me a summary of my inbox",
  a "Who should do it?" bot select, and **two CTAs**: primary "Set it up" (sends the sentence to the chosen bot as a
  normal chat message — the bot configures it) and quiet "Set it up yourself" (radio list "On a schedule" / "When
  something happens in an app" / "When another app sends something" → Continue). NoBots guard: "Create a bot first,
  then come back here."
- Definition strips (one-line how-it-works under a row title): room panel (`room-panel/RoomPanel.tsx`) rows pair title +
  tertiary hint — "Who responds" / "Who answers when you don't @mention anyone."; "Instructions" /
  "Tell the bots what this room is for"; "Members" / count. Automation webhook card: "Paste this address into the other
  app", "Keep {app} open so it can receive." Secrets: masked `••••••••` with Show/Hide/Copy and
  "The secret is shown once. Copy the address to make a new one."
- Welcome/announcement cards (`src/components/cloud-welcome/parts.tsx`): `StepHeading` (21px balance-wrapped title +
  14px sub) over choice **cards** (`rounded-2xl border p-4`; idle `border-hairline/50 bg-card/50`, picked
  `border-accent/70 bg-accent/[0.07]` + 3px accent glow shadow) each with 34px accent icon tile, title, one-line hint
  chip ("Your bots and chats", "Claude or ChatGPT", "Optional"), single CTA per card; whole flow escaped by
  "Skip setup". Value promises verbatim: `cloudWelcome.intro` "A few quick steps and your bots work around the clock.",
  `cloudWelcome.done.body` "Your bots now run 24/7. Close your laptop whenever you like."
- What's New popup (`src/components/whats-new/WhatsNewPopup.tsx`): 520px sheet, eyebrow `t("whatsNew.eyebrow")`
  "What's new" (12px uppercase `tracking-[0.06em]`), 19px balance title, 14px body, check-marked bullet list for team
  features, picture `aspect-[2/1]`, dots + Back/Next + "Not now" footer; inactive slides `inert` + translate/opacity
  300ms; Escape/outside/× all count as "close" in analytics.

## 7. Composer behaviors

`src/components/Composer.tsx` + helpers `src/components/composer-simple.ts`:
- **Placeholder is a state machine**, not a static string — `composerPlaceholder()`: locked → "Finish group setup to
  start a thread"; pending approval → `t("composer.placeholder.approval")` "Answer the approval above to continue";
  attaching → "Attaching files…"; dictation → "Listening…"; reply draft → "Reply…"; bot busy + steer →
  "{name} is working. {key} sends this into the running turn" (queued variant: "Press {key} again to steer the queued
  message into the running turn"); busy no-steer → "{name} is working. Sends when this turn finishes"; group →
  "Message {name} (@ to bring a bot in)"; goal mode → "Describe what {name} should finish together"; default →
  "Message {name}".
- **Send button label mirrors the action**: "Send message" (title "Send (⏎)"); busy+steer "Send into the running turn";
  busy "Queue message" (title "Sends when the current turn finishes"); simple-mode variants speak in the bot's terms:
  "Add this to what {name} is doing" / "Sends when {name} is done". One round button (arrow-up / stop while streaming).
- Simple shell: one pill `SIMPLE_COMPOSER` (field + mic + round send; `SIMPLE_CONTROL` = 28px round + / mic buttons);
  advanced: `+` menu (attachments, tools), slash-command menu (`/goal`, etc. with one-line descriptions), @mentions,
  queued-message strip with steer/undo.
- "+ new task" placement: it lives in the **sidebar rows** (hover `+` on bot row / folder row) and the bot menu — not in
  the composer. Room headers get a hover `+` too, disabled with title "Let this turn finish first" while busy.
- Group routing hints render as composer hint chips: "@ to bring a bot in" / "everyone responds" / "{name} responds".

## 8. Interface mode (simple/advanced)

`src/lib/interface-mode.ts` (73 lines, whole file is the pattern):
- Key `ADVANCED_MODE_KEY = "omb-advanced-mode"`, values "1"/"0". No key ⇒ default from `hasPriorRun(store)` —
  **first-run users land in Simple**; `settleAdvancedModeDefault()` writes the computed default on first boot so the
  key always exists afterwards. Module-level `sessionChoice` cache + `useSyncExternalStore` + `storage` event listener =
  instant cross-tab sync. Try/catch around all localStorage access with in-memory fallback.
- Every surface branches on `const advanced = useAdvancedMode()` (imported in ~40 components); `simple = !advanced`.
  Shera's existing `shera-advanced-mode` key is the same contract.
- Simple changes, surface by surface:
  - Sidebar: 280px; big primary bot **tile grid** (`SidebarTileGrid`), search collapses to a toggle pill, sections become
    "departments" with row counts in headers, thread lists hidden — bot row preview quotes the conversation instead;
    department menus with flyouts.
  - Context menus: fewer items, friendly verbs ("Mark as read", "Edit profile", "View threads"), flyout submenus, "More".
  - Model picker: 300px `SimpleModelMenu` — provider rows expandable in place (chevron), unconfigured providers get a
    "Set up" row, thinking levels inline; full picker reachable via a back-row ("Show more" path `fullView`).
  - Settings: `BotSettingsDialog`/`RoomPanel`/`InboxPanel` render as **side sheets** (`sidePanelCls`) with hero + Card
    rows (`NavRow` icon + title + current value + chevron, pages swap in-place with Back), not tabbed dialogs.
  - Composer: single pill; no slash menu chrome.
  - Onboarding hints quiet (`spotlightsQuiet`), archived bots hidden, bulk select hidden.
- Advanced: 320px sidebar with expandable per-bot thread lists, folders, bulk select, keyboard shortcut hints, archived
  bots entry, full model picker, 420px popover.
- Thread-list visibility is its own pref on top of mode: `src/lib/thread-preferences.ts` key `omb-show-threads`
  (default on; `useShowThreads() = advanced && chosen`).

## 9. Copy voice

Verbatim strings that define the tone — short declaratives, concrete nouns, the bot's perspective, no jargon, no
exclamation marks, loss/permission statements spelled out:

1. `onboarding.meet.demo` — "Hand off any task to your team of bots"
2. `onboarding.chief.body` — "Your main point of contact. It checks in on its own and coordinates work with your other bots."
3. `inbox.empty` — "Nothing for you yet."
4. `automations.panel.noRuns` — "It hasn't run yet."
5. `onboarding.shell.placeholder` — "Ask anything, or drop a file"
6. `sidebar.bot.chiefNeedsEngine` — "Choose Claude or an ACP model provider first" (disabled-with-reason)
7. `sidebar.bot.archiveBlockedLast` — "Keep at least one active bot" (guard as instruction, not refusal)
8. `model.threadBusy` — "Stop this thread's turn before changing its model"
9. `task.deleteBody` — ""{title}" and its conversation will be deleted. This cannot be undone."
10. `sidebar.bot.deletingRow` — "Deleting the bot and any desktop it owns…" (row-level progress states what is affected)
11. `automations.newBox.noBots` — "Create a bot first, then come back here."
12. `cloudWelcome.done.body` — "Your bots now run 24/7. Close your laptop whenever you like."

Voice rules distilled: status words not emoji ("Waiting", "Queued", "Working", "Snoozed"); relative time lowercase
("just now", "2 min ago"); questions end with "?" only in confirmations; every disabled control carries the reason in
its title; "You" for the person, the bot's name for the agent; numbers spelled as counts ("Show all {count} models").

## 10. Shera Bot mapping notes

1. **Shell** → Keep Shera's rail + chat pane; adopt the sibling-panel mount pattern (`key={`panel:${id}`}` distinct key
   prefixes, auto-collapse sidebar via media query, `overlay` prop for narrow viewports) for Operation detail panels.
2. **Roster rows** → Shera merged-chats list: two-line row (name+timestamp / preview line), preview = newest
   runtime-visible event only (skip synthetic frames — matches "runtime owns state, no invented data"), attention rank
   order (waiting-on-you first), 6-row cap + "Show all", unread = accent dot, relative time <7d then date. Never derive
   preview client-side beyond rendering runtime-provided last line.
3. **Context menu** → port the contract, not the items: order = pin → read-state → create → configure → copy → more
   flyout → destructive last; disabled-with-reason via title; async items keepOpen+spinner; menu recipe classes
   (30px rows, 14px text, hairline separators, viewport clamp, focus restore). Persist pin/unread through Shera's
   runtime gateway actions, not localStorage.
4. **Onboarding cards** → Shera onboarding-cards component: AskCard anatomy (24px radius, asker header "{name} asks",
   choice chips + always-present free text "Something else…", one-tap single question, quiet-recede once user types,
   settle to one line). First run = two beats max, draft-resume per beat, completion timestamp + version so updates can
   re-run it.
5. **Model picker** → Shera model-control: pill trigger w/ provider mark + attention dot (reason in title), provider
   rail + status chip, scope toggle ("Only this thread" / "Pack default" in Shera vocabulary), suggested-5 + show-all,
   dimmed-with-reason panes, effort chips with "let the provider decide" default.
6. **Empty states / definition strips** → use the formula: icon + one value sentence + one CTA; automations-style
   "+ new" dialog that delegates to an Agent via a normal chat message ("Set it up") with an expert escape hatch
   ("Set it up yourself").
7. **Composer** → adopt the placeholder state machine and action-labeled send button (queue/steer variants) for the
   Operation chat surface; "+ new Operation" stays in the sidebar rows, not the composer.
8. **Interface mode** → Shera's `shera-advanced-mode` key: copy the 73-line hook shape verbatim in spirit
   (sessionChoice cache + storage-event sync + hasPriorRun default) and branch per surface exactly as §8 lists;
   keep Simple's "quote the conversation" preview and side-sheet settings, Advanced's full pickers and bulk tools.
