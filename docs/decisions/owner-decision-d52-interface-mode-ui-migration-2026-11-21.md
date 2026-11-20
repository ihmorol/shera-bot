# D52: Interface mode — simple-mode default UI and the OpenMausBot UI-pattern migration wave

- ID: D52
- Status: Confirmed (owner-directed, in-chat instruction evidence; recorded by the delegated orchestrator per the standing build-out delegation)
- Date: 2026-11-21 (owner instruction 2026-11-20 for the simple-mode distillation; 2026-11-21 for the migration wave)
- Evidence source: owner in-chat instructions, verbatim:
  - 2026-11-20: "ui should be minimal, user doesn't need to know everything… too many informations and structure" — followed by a request to take the idea from OpenMausBot's interface.
  - 2026-11-21: "do a massive migration of ui. use  reverse engineer skill to analyze openmausebot and update and refactor the ui. use subagent and orchastrate the work. … create pr, review pr, add comment, message to fix, do whatever you need. keep working no time limit."
  - Chain of standing authority: E43 addendum 2026-11-07 ("take idea from there interface as well. thats what is easy for users") made OpenMausBot UI patterns owner-instructed reference material; D44/D41/D29 govern vocabulary and the sidebar's information architecture; PRD §24 governs the decision boundary this record exists to satisfy.
- Supersedes: nothing. Extends the E43 addendum's idea map from "post-merge refinement candidates evaluated per surface" to an executed migration wave; refines (does not supersede) D41 — the Agents/Operations two-section sidebar remains the information architecture, and simple mode is a presentation mode over the same data, not a new chat type or a collapse of Operations into generic task chats (the Layers glyph and Operation naming survive in simple mode).
- Affected PRD sections: §4.1 (dashboard/sidebar description — the documented structure is now the ADVANCED presentation; SIMPLE is the default presentation of the same two data sets), §21 item 2 (dashboard IA and sidebar details — refined), §21 item 17 (state design — empty-state voice refined). No acceptance criteria change; §19 is untouched. A PRD text sync (SYNC-4) is NOT performed by this record and awaits the owner's explicit instruction, per the SYNC-1/2/3 precedent.

## Decision

1. **The client UI defaults to SIMPLE mode.** One quiet conversation list (agent direct chats + Operation chats merged, recency-sorted), the single most likely next action surfaced as a primary button, and the machinery (roster management, pack summary, the full settings register, the full §3.2 sidebar structure) reachable on request. **ADVANCED mode restores the full documented UI_DESIGN structure** (§3.2 sidebar with Agents + Operations sections, §S4 roster panel, §S9 fifteen-section settings register). The choice persists per browser in `localStorage` under `shera-advanced-mode`; first paint is simple.

2. **OpenMausBot UI patterns are adopted as a migration wave, patterns not pixels.** The E43 addendum's idea map (patterns 1–8) is executed as refinement waves over the built surfaces, each wave with its own PR, red-first tests where behavior changes, the impeccable gate, and an E-note citing E43 + this record. Pattern 9 (pack import/export safe defaults) remains BLOCKED on its own owner product decision and is not built in this wave.

3. **`UI_DESIGN.md` is amended** (same PR as this record) to document interface mode as the presentation layer over its specifications; where its §3.2/§S4/§S9 ASCII structures describe the advanced presentation, they remain the authority for that mode.

## Rationale

- The owner's product direction is explicit and repeated (2026-11-20 minimal UI, 2026-11-21 "massive migration of ui"). The prototype's audience (researchers, developers, students — PRD §3.1) meets the same first-run wall OpenMausBot's 13k users smoothed: machinery-first interfaces read as complexity before they read as power.
- OpenMausBot is the sanctioned reference (E43 addendum): Apache-2.0 core, patterns-not-pixels posture, `UI_DESIGN.md` + the impeccable gate stay authority. Nothing is copied verbatim; every adoption is Shera Bot code written against Shera Bot's runtime-owned state (no invented data — G4), the Pack → Operations → Agents vocabulary (G1), and the D26 event-honesty rules.
- Simple mode changes no contracts: conversations, runs, approvals, credits, and settings surfaces are unchanged behind the presentation; the advanced mode keeps every documented surface reachable, so UI_DESIGN's acceptance mapping (§10) is preserved in the advanced mode verbatim.

## Alternatives considered (preserved)

- (a) Keep the full §3.2 structure as default and add a "compact" preference — rejected: contradicts the owner's explicit direction that the minimal presentation is the default a user first sees.
- (b) Simple mode as a separate stripped-down route — rejected: forks the surface area, doubles test burden, and violates the one-persistent-identity/one-surface posture (D39).
- (c) Adopt OpenMausBot wholesale as the client base — already rejected by E43 Decision §1 (product-shape and stack mismatch); not reopened.
- (d) Fold the migration into one giant PR — rejected: waves keep reviews fresh-context (two-axis), file scopes non-overlapping, and each adoption independently revertible.

## Implementation implications

- `apps/web/lib/interface-mode.ts` owns the mode (simple default; `shera-advanced-mode` localStorage key; `useSyncExternalStore`; server snapshot reports the module session choice so static-render tests opt into advanced explicitly).
- Sidebar (`components/shell/sidebar-content.tsx`): simple = merged recency-sorted Chats list + New Operation primary button + footer ADVANCED toggle; advanced = full §3.2 structure. Pack-defined Operation templates stay reachable in simple mode through the New Operation flow.
- Operation chat (`components/operations/operation-chat-surface.tsx`): roster management collapses behind a Manage-roster strip in simple mode; pack-summary strip and runs panel remain visible in both modes (D26/AC24 honesty).
- Settings overview (`components/settings/settings-overview.tsx` + `lib/settings-categories.ts`): core six (D16 order) lead; nine others under a disclosed Advanced group; all 15 stay in DOM so per-section deep links keep working.
- The migration waves (2026-11-21 onward), each an independent PR: sidebar activity preview lines + roster context menu (pin/mark-unread/copy-conversation-id; pinning is a client preference); "+ New run" affordance placement and a Pack → Operations → Agents definition strip on the Operation chat surface; onboarding interview-card mechanics refinement; model picker dimmed-with-reason; empty-state value-promise sweep. Every wave: red-first tests where behavior changes, `impeccable detect` zero-findings, full web-suite green, E-note citing E43 §5 + this record. The pattern source for every wave is the reverse-engineering annex [`../research/openmausbot-ui-patterns-2026-11-21.md`](../research/openmausbot-ui-patterns-2026-11-21.md) (extracted 2026-11-21 from the pinned clone; patterns-not-pixels).
- Not built (awaiting its own product decision): pattern 9 — pack import/export safe defaults (imports arrive inert, disclosure dialog).

## Verification coverage

- Simple-mode implementation verified at filing: vitest apps/web 736/736 (48 files, including 5 new interface-mode tests), `tsc --noEmit` clean, eslint clean, prettier clean, `impeccable detect` zero findings on every touched surface, Playwright visual passes on the simple sidebar (dev server, localStorage flip — machine-local evidence, not committed).
- Each migration wave verifies itself in its own PR (tests + gates + review record); this record is the product authorization those PRs cite.
- The two owner instructions above are preserved verbatim in this record; the 2026-11-20 session's remaining evidence (Playwright screenshots at `/tmp/shera-shots/`) is machine-local and reproducible per the harness scripts.

---

## Addendum 2026-11-21 (wave A execution refinements, recorded per G5)

Wave A's review surfaced that the migration executions refined two phrasings of this record and added one entry point. Recorded here so the decision record and the shipped spec never disagree (the spec amendment alone would be a silent conflict resolution):

1. **Ordering refinement.** Decision §1 and the implementation section describe the simple list as "recency-sorted" without exception. Wave A ships **"pinned rows lead; recency within the rest"** (the pin is a client view preference from this record's implementation section; the recency rule governs the remaining rows unchanged). UI_DESIGN §3.4 carries the same clause. The recency claim otherwise stands; the attention states continue to render as markers, never as reorder rules.
2. **The row context menu's "Open roster" entry** (Operation rows) is authorized as part of the E43 §3 transposition: it is an entry point to the existing Manage-roster machinery, not new machinery; §S4's "roster editing opens on the Operation chat screen" is unchanged. "Agent settings" was already bound by UI_DESIGN §3.2 ("each opens Agent settings via context menu").
3. **Advanced-row timestamps render always-on** when the record carries a stamp (previously specified hover-only in UI_DESIGN §3.2's anatomy; amended there in the same PR). E43 idea 4's row anatomy ("+ timestamp") is the source.

Evidence: PR #94 (branch `ui/wave-a-sidebar`), the two-axis review records on that PR, and `docs/research/openmausbot-ui-patterns-2026-11-21.md` §2/§3.
