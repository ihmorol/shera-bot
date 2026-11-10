# Acceptance runner report — 2026-11-10T00:51:48.459Z

The criteria runner's record for this run (E43 tiering; G4/G5/G7 honesty rules in the script header). Machine-readable twin: `acceptance-report.json` alongside this file.

Summary: 27 ledger rows — pass: 25, partial: 2

## §18 browser projects probed this run

- **chromium**: available
- **firefox**: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/firefox-1555/firefox/firefox
- **webkit**: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/webkit-2370/pw_run.sh
- **chrome**: available

## Row states

| Row | Owner verdict | Runner state | Automated evidence |
|---|---|---|---|
| AC1 | open | pass | apps/control-plane/test/auth-flow.test.ts → pass<br>apps/control-plane/test/signup-cap.test.ts → pass<br>apps/web/test/login.test.ts → pass |
| AC2 | open | pass | apps/control-plane/test/runtime-provisioning.test.ts → pass<br>tests/integration/runtime-provisioning.test.ts → pass<br>apps/control-plane/test/runtime-container-spec.test.ts → pass<br>apps/control-plane/test/local-container-backend.test.ts → pass |
| AC3 | open | pass | apps/user-runtime/src/transport/local-api/s11-agents-api.test.ts → pass<br>apps/web/test/agent-surfaces.test.ts → pass |
| AC4 | open | pass | apps/user-runtime/src/transport/local-api/s11-agent-folder-api.test.ts → pass<br>apps/user-runtime/src/modules/sessions/session-supervisor.service.test.ts → pass<br>apps/user-runtime/src/modules/agents/agent-folders.service.test.ts → pass |
| AC5 | open | pass | apps/user-runtime/src/transport/local-api/s14-adhoc-api.test.ts → pass<br>apps/web/test/adhoc-operation.test.ts → pass |
| AC6 | open | pass | apps/user-runtime/src/transport/local-api/s15-preview-api.test.ts → pass<br>apps/web/test/launch-preview.test.ts → pass<br>apps/user-runtime/src/modules/operations/operations.service.test.ts → pass |
| AC7 | open | pass | apps/user-runtime/src/transport/local-api/s18-live-views-api.test.ts → pass<br>apps/web/test/live-views.test.ts → pass<br>apps/web/test/runtime-live.test.ts → pass<br>apps/web/test/e2e/mock-runtime-e2e.test.ts → pass |
| AC8 | open | pass | apps/user-runtime/src/modules/tools/tool-executor.service.test.ts → pass<br>apps/user-runtime/src/modules/research/s25-research-tools.test.ts → pass<br>apps/user-runtime/src/transport/local-api/s26-execution-api.test.ts → pass |
| AC9 | open | pass | apps/user-runtime/src/transport/local-api/s21-tools-api.test.ts → pass<br>apps/user-runtime/src/modules/tools/tools-inventory.service.test.ts → pass |
| AC10 | open | pass | apps/user-runtime/src/modules/providers/provider-service.test.ts → pass<br>apps/user-runtime/src/modules/providers/connection-test.test.ts → pass<br>apps/user-runtime/src/transport/local-api/s23-providers-api.test.ts → pass |
| AC11 | open | pass | tests/contract/agent-settings-contract.test.ts → pass<br>apps/user-runtime/src/modules/providers/provider-service.test.ts → pass<br>apps/user-runtime/src/transport/local-api/s23-providers-api.test.ts → pass |
| AC12 | open | pass | apps/user-runtime/src/transport/local-api/s28-autonomous-proof.test.ts → pass<br>apps/user-runtime/src/modules/schedules/scheduler.service.test.ts → pass<br>apps/user-runtime/src/modules/schedules/scheduler-wake-manager.test.ts → pass |
| AC13 | open | partial | apps/user-runtime/src/modules/approvals/approvals.service.test.ts → pass<br>tests/contract/approval-contract.test.ts → pass<br>apps/web/test/approvals-ui.test.ts → pass<br>apps/user-runtime/src/modules/approvals/approvals.service.test.ts → pass<br>tests/acceptance/browser/journeys.spec.ts → pass (chromium:pass, firefox:not_verified, webkit:not_verified, chrome:pass) |
| AC14 | open | pass | apps/user-runtime/src/modules/tasks/retry-policy.test.ts → pass<br>apps/user-runtime/src/modules/tasks/retry-coordinator.service.test.ts → pass |
| AC15 | open | pass | apps/user-runtime/src/modules/tasks/run-cancellation.service.test.ts → pass<br>apps/user-runtime/src/modules/workers/worker-tree-cancellation.test.ts → pass |
| AC16 | open | pass | apps/user-runtime/src/adapters/sqlite/workspace-files-repository.test.ts → pass<br>apps/user-runtime/src/modules/recovery/s31-restart-matrix.test.ts → pass<br>apps/user-runtime/src/modules/memory/memory.service.test.ts → pass |
| AC17 | open | pass | apps/user-runtime/src/modules/git/git.service.test.ts → pass<br>apps/user-runtime/src/modules/git/validation-runner.test.ts → pass |
| AC18 | open | pass | apps/user-runtime/src/modules/backups/s33-backups.test.ts → pass<br>apps/user-runtime/src/modules/backups/s33-restore-service.test.ts → pass<br>apps/control-plane/test/s33-admin-backups.test.ts → pass |
| AC19 | open | pass | apps/user-runtime/src/modules/recovery/s31-recovery-classes.test.ts → pass<br>apps/user-runtime/test/recovery/kill9-recovery.test.ts → pass<br>apps/user-runtime/test/recovery/recovery-probes.test.ts → pass<br>apps/user-runtime/src/transport/local-api/s31-recovery-boot.test.ts → pass |
| AC20 | open | partial | tests/acceptance/browser/layout.spec.ts → pass (chromium:pass, firefox:not_verified, webkit:not_verified, chrome:pass)<br>tests/acceptance/browser/keyboard-a11y.spec.ts → pass (chromium:pass, firefox:not_verified, webkit:not_verified, chrome:pass)<br>apps/web/test/design-tokens.test.ts → pass |
| AC21 | open | pass | tests/security/s27-st01-path-traversal.test.ts → pass<br>tests/security/s27-st02-workspace-boundary.test.ts → pass<br>tests/security/s27-st07-credential-leakage.test.ts → pass<br>apps/user-runtime/src/modules/providers/custody-boundary.test.ts → pass<br>tests/contract/runtime-access.test.ts → pass<br>tests/contract/user-runtime-boundary.test.ts → pass |
| AC22 | open | pass | apps/user-runtime/src/modules/runtime/pack-pin.test.ts → pass<br>packages/agent-pack-sdk/src/loader.test.ts → pass<br>apps/user-runtime/src/adapters/sqlite/workspaces-repository.test.ts → pass |
| AC23 | open | pass | apps/user-runtime/src/transport/local-api/s15-preview-api.test.ts → pass<br>apps/web/test/launch-preview.test.ts → pass |
| AC24 | open | pass | apps/user-runtime/src/modules/operations/operations.service.test.ts → pass<br>apps/user-runtime/src/transport/local-api/s13-operations-api.test.ts → pass<br>apps/user-runtime/src/modules/credits/credit-aggregation.test.ts → pass |
| AC25 | open | pass | apps/user-runtime/src/modules/tasks/s31-checkpoints.test.ts → pass<br>apps/user-runtime/src/modules/workers/task-worker-supervisor.service.test.ts → pass<br>apps/user-runtime/src/modules/recovery/s31-restart-matrix.test.ts → pass |
| AC26 | open | pass | apps/user-runtime/src/modules/tools/tool-executor-approvals.test.ts → pass<br>apps/user-runtime/src/modules/tools/tool-executor.service.test.ts → pass<br>apps/user-runtime/src/modules/tools/tool-executor-cancellation.test.ts → pass |
| AC27 | open | pass | apps/user-runtime/src/transport/local-api/s29-memory-api.test.ts → pass<br>apps/user-runtime/src/modules/memory/memory-controls.test.ts → pass<br>apps/user-runtime/src/modules/memory/memory-secrets.test.ts → pass |

## NOT-VERIFIED this run (recorded gaps, never silent)

- AC13 / tests/acceptance/browser/journeys.spec.ts / firefox: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/firefox-1555/firefox/firefox
- AC13 / tests/acceptance/browser/journeys.spec.ts / webkit: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/webkit-2370/pw_run.sh
- AC20 / tests/acceptance/browser/layout.spec.ts / firefox: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/firefox-1555/firefox/firefox
- AC20 / tests/acceptance/browser/layout.spec.ts / webkit: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/webkit-2370/pw_run.sh
- AC20 / tests/acceptance/browser/keyboard-a11y.spec.ts / firefox: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/firefox-1555/firefox/firefox
- AC20 / tests/acceptance/browser/keyboard-a11y.spec.ts / webkit: NOT-VERIFIED: /home/emon-morol/.cache/ms-playwright/webkit-2370/pw_run.sh

## OPT-IN live legs (G7 — never run by this runner)

- AC8: live-provider legs stay behind the owner's explicit environment (G7)
- AC9: live-provider legs stay behind the owner's explicit environment (G7)
- AC10: live-provider legs stay behind the owner's explicit environment (G7)
- AC12: live-provider legs stay behind the owner's explicit environment (G7)
- AC13: live-provider legs stay behind the owner's explicit environment (G7)
- AC20: live-provider legs stay behind the owner's explicit environment (G7)
- AC25: live-provider legs stay behind the owner's explicit environment (G7)

## Leak scan (E43 rule: category + path, never content)

No findings across the ledger and the S34 fixture area.

Exit code: 0 (0 = every claimable automated row held; red rows above are recorded, not faked).
