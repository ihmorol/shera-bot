# Review evidence — 2026-09-13

This directory is the repository-local copy of the completed mockup review and pane verification. The two reports and fourteen screenshots were copied byte-for-byte from `.gstack/design-reports/` during the subsequent documentation pass. Originals were retained. This index and the integrity manifest were added afterward.

Added later the same day: [docs-conformance-audit-2026-09-13.md](docs-conformance-audit-2026-09-13.md) is **not** copied evidence — it is an original read-only audit of the mockup against the PRD, decision records and UI design spec, produced in a separate session, and is therefore not covered by SHA256SUMS.txt. Its findings are also appended to [HANDOFF](../../HANDOFF.md) §7/§12.

## Read in order

1. [Independent investor/client UX/UI audit](design-audit-localhost-2026-09-13.md): baseline screen coverage, problems, strategies, framework references and evidence limits.
2. [Pane implementation verification](pane-verification-2026-09-13.md): which requested pane behaviors were implemented/tested, exact results and remaining limits.
3. [Docs-conformance audit](docs-conformance-audit-2026-09-13.md): mockup vs PRD/decisions/UI_DESIGN — verified conformance, new findings (D43 roster conflict, provider gaps, fixture inconsistencies), recommended fix order. Read-only; documentation only.
3. [Current feature reference](../../REFERENCE.md): status after pane changes; source function references instead of old baseline line numbers.
4. [Current recommendations](../../UX_RECOMMENDATIONS.md): calmer first landing; proposals only.
5. [Future-agent handoff](../../HANDOFF.md): user request evidence, failed attempts and maintenance rules.

## Evidence interpretation

- Audit source line numbers refer to pre-pane `fca3090`; application line numbers have shifted.
- Statements that pane changes are pending in the audit are baseline observations. The verification addendum updates only its explicitly tested cases.
- Absolute original screenshot paths remain inside the reports as provenance. Use the relative screenshot index below when those machine paths are unavailable.
- The reports' references to `.gstack` describe their original location. This directory makes the evidence discoverable from the repository documentation without depending on agent-local storage.
- No customer study, production backend test, traction evidence or full accessibility certification is claimed.
- Visual acceptance of a workspace screenshot does not prove all routes, controls, screen-reader behavior or runtime guarantees.
- Files are in the working tree; they are not committed or pushed by this documentation task.

## Screenshots

| File | What it records |
|---|---|
| [sign-in-dark.png](screenshots/sign-in-dark.png) | Baseline dark sign-in |
| [overview-dark.png](screenshots/overview-dark.png) | First-landing dashboard and seeded warnings |
| [workspace-dark-before.png](screenshots/workspace-dark-before.png) | Baseline dark dock |
| [launch-preview-dark.png](screenshots/launch-preview-dark.png) | Preview information density |
| [launch-broken-route.png](screenshots/launch-broken-route.png) | Launch reaches Nothing here |
| [approval-dark.png](screenshots/approval-dark.png) | Approval layout and below-fold choices |
| [settings-section-stuck.png](screenshots/settings-section-stuck.png) | Providers selection leaves Account displayed |
| [settings-mobile-clipping.png](screenshots/settings-mobile-clipping.png) | Phone Settings internal clipping |
| [workspace-light-before.png](screenshots/workspace-light-before.png) | Baseline light workspace |
| [workspace-four-panels-before.png](screenshots/workspace-four-panels-before.png) | Narrow equal-column baseline |
| [workspace-empty-timeline-after.png](screenshots/workspace-empty-timeline-after.png) | Safe empty timeline and retained chat draft |
| [workspace-four-panels-after.png](screenshots/workspace-four-panels-after.png) | Updated split workspace before verified column drag |
| [workspace-dark-after.png](screenshots/workspace-dark-after.png) | Updated dark single-panel workspace |
| [workspace-phone-after.png](screenshots/workspace-phone-after.png) | Updated viewport-sized phone workspace |

Screenshots have different viewport/sidebar/dock sizes. Do not treat them as controlled pixel-for-pixel comparisons or numerical proof of reduced overwhelm.

[SHA256SUMS.txt](SHA256SUMS.txt) records integrity hashes for the sixteen copied originals. It does not certify their claims or replace reading the associated methods and limitations.
