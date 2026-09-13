# Pane implementation verification — 2026-09-13

Companion to [the independent UX/UI audit](design-audit-localhost-2026-09-13.md). This addendum supersedes that report's **pending verification** labels only for the specific pane behaviors verified below. Other audit findings remain open.

## Outcome

Implemented the user's requested right-workspace resizing and collapse/expand behavior. Real browser input confirmed outer-edge dragging, horizontal row dragging, vertical column dragging, collapse/expand, maximize/restore, keyboard sizing, click-based sizing, reset, and editor-content preservation across panel operations.

This is a local static mockup enhancement, not a runtime, file-save, approval-system or production-readiness claim. No PRD, product decision records, or acceptance criteria were changed. No commit or push was made.

## Changed files

- `mockup/app.js`: pointer/keyboard controllers, dock-only updates, in-memory draft/scroll snapshots and layout measurements.
- `mockup/views.js`: named splitters, collapse controls, size alternatives and empty/current-chat timeline safeguards.
- `mockup/screens.css`: resize affordances, minimum sizes, collapsed headers and stacked/narrow layouts.
- `mockup/index.html`: versioned changed asset URLs after the browser retained stale resources.
- `mockup/README.md`: interaction behavior, limits, preference lifetime and accurate server command.
- `mockup/dock-layout.test.cjs`: 13 dependency-free regression tests.

## Automated checks

All passed on the final working files:

```sh
node --check mockup/app.js
node --check mockup/views.js
node --test mockup/dock-layout.test.cjs
git diff --check
```

**13 tests passed, 0 failed.** Coverage includes width bounds, minimum sizes, proportional row sizing, all-collapsed headers, reset isolation, state preservation across maximize/restore, keyboard sizing, empty/current-chat timeline rendering, and named focusable separator markup. These tests do not replace browser or assistive-technology testing.

## Browser evidence

Environment: Windows, ZCode 3.11.2 in-app browser, Chromium 146.0.7680.80 / Electron 41.0.3. URL: `http://localhost:8000/index.html#/agent-general-assistant`. Served version: uncommitted working tree based on `fca3090`, with pane assets `?v=20260913-panes`.

| Check | Observed result |
|---|---|
| Open workspace | Real button click exposed Files and the new controls in a clean verification tab. |
| Collapse / expand | Files collapsed to a 46px header, `aria-expanded=false`; expanding returned it to 460px in the tested one-panel layout. |
| Chat draft | `Pane test draft` remained unchanged after collapse/expand. |
| Keyboard width | ArrowLeft moved the outer boundary left and changed width from 440 to 456px. |
| Empty timeline | Adding Run timeline to General Assistant displayed “No task runs in this chat yet.” No missing-run rendering exception occurred in that action. |
| Row drag | Physical pointer drag moved the Files/Run timeline boundary 55px, yielding 280px and 170px panels. |
| Outer drag | With the sidebar rail active, physical pointer drag widened the dock from 440px to 720px. |
| Column drag | Four-panel layout exposed a vertical divider. Physical drag changed the columns from equal shares to approximately 384.5px / 304.5px. |
| Editor collapse / expand | `Draft editor content retained` survived collapsing Editor to 46px and expanding it. |
| Maximize / restore | Editor became the sole visible panel; restore returned the split layout without losing the edited value. |
| Click-based sizing | Resize panels → Increase selected size changed the dock from 720px to 768px without dragging. |
| Close / re-add | Closing Editor removed its region; re-adding it retained the edited value in memory. |
| Reset layout | Restored 440px width, kept all four panels, retained edited content, and returned narrow dock layout to stacking. |
| Dark theme | Updated single-panel workspace rendered correctly at 1280×720; global faint-text concerns remain in the audit. |
| Phone-sized dock | At 390×844 the dock filled the viewport from x=0/y=0 with stacked content; outer divider was not visible. Header and Files actions remained visible. Measured width was 390.4px (fractional CSS rounding), height 844px. |

### Screenshots

- [Safe empty timeline and retained chat draft](screenshots/workspace-empty-timeline-after.png)
- [Four-panel split layout before the verified column drag](screenshots/workspace-four-panels-after.png)
- [Dark workspace after](screenshots/workspace-dark-after.png)
- [Phone workspace after](screenshots/workspace-phone-after.png)

The four-panel before/after screenshots use different viewport/sidebar/dock widths. They demonstrate the available layouts, not a pixel-for-pixel comparison or measured improvement in client task performance.

## Browser-tool interruptions and limits

The original review tab repeatedly returned to blank or lost its test state, and input actions sometimes timed out even while DOM reads worked. A diagnostic programmatic click confirmed handler behavior but was **not** counted as physical interaction acceptance. A clean independent tab then passed the real pointer/button/keyboard actions documented above. Stale script URLs were observed directly; versioned asset URLs and the explicit `index.html` entry loaded the changed resources. These interruptions are disclosed rather than misreported as product errors or successful tests.

Not completed: full cross-browser coverage, screen-reader testing, actual touch/pen hardware, pointer-cancel/Escape drag automation, all pane-count permutations in a real browser, 200% text zoom, exhaustive keyboard focus testing, complete per-chat/full-page draft restoration scenarios, or a comprehensive browser-console audit. Cancellation and several edge conditions have implementation/source or unit-test coverage only.

Layout preferences and drafts are **in memory only** and reset on page reload. Retaining editor text is not saving a file. Maximize means fill the dock; a separate full-page link remains available. At narrow widths, panels stack rather than forcing unusable side-by-side columns.

## Remaining audit disposition

- **Addressed within scope:** missing inner dividers/collapse controls, mouse-only outer resizing, narrow equal-width panel squeezing, pane-action draft loss in the verified scenarios, empty timeline exception and cross-chat fallback guard.
- **Partially addressed:** broad draft preservation and timeline context. Full-page/context combinations and all select-change behavior are not certified.
- **Not changed:** broken Operation launch routes, Settings navigation, misleading simulation success claims, artifact/file actions, approval/grant state and dialog focus bugs, unsafe text escaping, global contrast, phone Settings clipping, inert search, ad-hoc creation, notifications and recovery workflows.

The mockup is easier to arrange, but it is **still not ready for a dependable unassisted client walkthrough** until the core journey and trust blockers in the audit are repaired.
