# Shera Bot release readiness and completion plan

Audit date: 2026-10-20, Asia/Dhaka. Verdict: **NO-GO for a working assistant release, including a private usable beta.** A clearly labelled demonstration or marketing site can be released separately after its own fixes.

## 1. What is actually done

The live GitHub `main` is `42ddc798115665b9976093f24ffd930f8ababd87` (2026-10-07). The local checked-out `main` is `a1a30b1d1b65903f7410fd2359630b07763d5dd1`, 109 commits behind. This audit uses an isolated archive of the live-main commit under `source/`; it does not update, reset, or merge the user's checkout.

GitHub issues #2–#11, corresponding to S01–S10, are closed. Issues #12–#36, corresponding to S11–S35, remain open. No open pull requests were returned. Thus **10/35 slices are closed (28.6%) and 25 remain**. This is a count of planned slices, not a percentage of effort, quality, acceptance, or useful product functionality.

| Completed slice | What the source establishes | Limit |
|---|---|---|
| S01 | Monorepo, toolchain, CI, license inventory | No deployable release artifact |
| S02 | Typed contracts, task states and execution events | Contracts do not prove executed product behavior |
| S03 | Process supervision and SQLite spike evidence | Fake Pi experiment; no production Pi adapter |
| S04 | Threat model and control/test specifications | Full security implementation and verification remain |
| S05 | Control-plane OAuth, account cap, sessions, administrator flag | Browser entry and deployed end-to-end authentication remain incomplete |
| S06 | Provisioning service, backend adapter, token/channel primitives | Production runtime wiring is incomplete |
| S07 | SQLite WAL, journal, typed local API, WebSocket replay, fake harness seam | No working live model/tool runtime or full task recovery |
| S08 | Responsive client shell and chat components | Most product screens are fixture or placeholder surfaces |
| S09 | Durable General Assistant thin slice, scripted streaming, refresh/replay, recovery probes | Test bypasses real OAuth/provisioning; not a real-model journey |
| S10 | Pack validation/loading, student manifest, workspace pinning and task configuration snapshots | Does not implement the Operations, workers, tools or memory it describes |

S11 has substantial code on `origin/s11-agent-identity` at `cc891e4`, including Agent records, settings, chat binding and tests/screenshots. It is **unmerged and not release-creditable**. Its private-folder implementation is an in-memory store; finish and review it before merging. Local-only design/avatar output is also not a merged release feature.

## 2. Publishable forms

| Release form | Ship now? | Required next step |
|---|---|---|
| Private engineering demonstration | Yes, with boundaries stated | Identify scripted replies, fixture chats, placeholders, and lack of real tools; use test data and controlled access |
| Public marketing or illustrative demo website | Conditional | Fix false waitlist success, track the site, validate claims and contact/forms, add actual privacy information, build and browser-test it |
| Hosted private working web prototype, up to five accounts | No | Finish existing prototype scope, safety, persistence, acceptance and one-VM deployment |
| Public multi-user service | No | Private prototype acceptance first; then record expanded capacity, privacy, operations, billing if sold, and abuse-control decisions |
| Self-hosted software release | No | Working product plus images, configuration, install/upgrade/backup/restore documentation, notices and clean-machine verification |
| Installable PWA | No | Accepted web app first; then explicitly approve PWA scope and implement/install-test it |
| Desktop installer | No | Accepted web app first; define whether a hosted client or bundled local stack is wanted, then add platform packaging and release security |
| Native mobile apps | No | Explicitly deferred product scope; a separate project after web acceptance |

Recommendation: ship the **responsive private hosted web prototype** first. A web app is already software. Use a PWA as a later installable surface if installation is the actual need. A desktop wrapper cannot supply the missing backend or safety behavior.

## 3. Existing defects and integration failures

These are source-confirmed findings. B01, B02 and B05 were also reproduced through the running built app and real runtime bootstrap with disposable data; see `VALIDATION.md`. They are not claims about an existing public deployment. Paths refer to the pinned `source/` snapshot unless marked local-only or branch-only. Severity is this audit's release-priority assessment. Fix each with a reproducer before implementation.

| ID | Priority | Finding and evidence | Required fix and proof | Owner |
|---|---|---|---|---|
| B01 | Blocker | `/` leads to `/login`, whose Google button is disabled (`apps/web/app/page.tsx`, `app/login/page.tsx`); observed in the running built app. The real OAuth link exists elsewhere in the container gate. | Wire the normal login entry to control-plane auth; browser test login, redirect, logout, expired session, denied/capped signup. | Web + identity |
| B02 | Blocker | Runtime HTTP proxy has no authenticated principal-to-workspace binding (`apps/web/app/api/runtime/[...path]/route.ts`, `lib/server/proxies.ts`). Reproduced: an anonymous `conversation.create` with caller-chosen `workspace_id` returned HTTP 200 through the built web proxy. | Resolve the runtime from the authenticated account on the server; deny anonymous access and cross-account routing; do not trust browser-supplied runtime identity. Prove two-account isolation. | Security + web/backend |
| B03 | Blocker | Live client requires a browser runtime WebSocket URL (`NEXT_PUBLIC_RUNTIME_WS_URL`); authenticated TLS routing to the correct user's runtime is unfinished (`general-assistant-surface.tsx`, `ws-socket.ts`). | Add authenticated WSS routing, origin/session checks and workspace isolation; test revoked/expired sessions, cross-user stream subscriptions and reconnect. | Runtime + web |
| B04 | Blocker | Container spec does not configure non-loopback runtime bind, while `apps/user-runtime/src/main.ts` defaults to loopback and refuses external bind without opt-in. | Make one deliberate authenticated container-network topology; keep local APIs private and prove control-plane registration/health against a real container. | Runtime + infrastructure |
| B05 | Blocker | `createInternalApi` is implemented but not mounted by the production entrypoint; S06 expects its registration channel. Reproduced: real bootstrap returns HTTP 404 for `POST /internal/v1/registration`; its separate local health probe exists and responds HTTP 200. | Mount the authenticated internal API in the actual boot path; test registration, credential commit/rotation and restart using that entrypoint. | Runtime |
| B06 | Blocker | SQLite defaults inside the container filesystem and the container spec has no persistent volume. Credential recovery deletes/recreates the container (`main.ts`, `container-spec.ts`, `local-container-backend.ts`). | Add per-user persistent storage and protected ownership; prove messages, pack pin, files, credentials and runtime state survive recreation. Do not run a destructive test on user data. | Infrastructure + storage |
| B07 | High | A crash after setting `provisioning` can leave future calls returning `RUNTIME_PROVISION_IN_PROGRESS` indefinitely (`runtime-provisioning.ts`, around lines 121–132). | Add bounded stale-provision reconciliation/idempotent recovery; fault-test each create/register/commit interruption. | Control plane |
| B08 | Blocker | Default composition uses `FakeHarnessAdapter`; real Pi adapter is deferred (`compose.ts`, `harness-adapter.ts`). Normal chat has a reply producer only when scripted replies are injected. | Implement the real supervised Pi path and configured-provider error states. Keep fake execution explicitly test/demo-only. Show an opt-in live-model conversation. | Runtime + providers |
| B09 | High | Task projection is memory-only with no restart reconstruction (`harness-run-service.ts`, around lines 189–194). | Reconstruct authoritative state from durable records; crash/restart queued, running, paused, cancelled and uncertain-effect runs. | Runtime + recovery |
| B10 | High | Live General Assistant display attributes sends to fixture name `Emon` (`general-assistant-surface.tsx`). | Use authenticated identity; test two distinct users and unknown/missing profile fields. | Web + identity |
| B11 | High | Five Agent chats and non-ready General Assistant states can use interactive fixture data. Production behavior is therefore mixed with demonstrations (`app/app/agent/[agentId]/page.tsx`, `agent-chat-view.tsx`, `general-assistant-surface.tsx`). | Make production use durable APIs and honest unavailable states. No fallback that implies real saved work. Test missing runtime/provider and restart. | Web |
| B12 | High | Many `/app` routes can display fixture surfaces without the session/container resolution used by `/app`. | Gate production app routes consistently; separately authorize every backend request. Route guarding alone is insufficient. | Web + identity |
| B13 | High | Local marketing waitlist confirms signup after a delay without storing the address (`business-landing-portfolio/components/waitlist-form.tsx`). | Persist and validate submissions, including failure/duplicate behavior, or remove signup claims and offer an honest alternative. | Marketing web |
| B14 | Medium | Marketing Privacy and Terms links point to FAQ rather than actual pages (`business-landing-portfolio/app/page.tsx`). | Supply accurate pages and real links appropriate to the released service and any collected data. | Product + marketing |
| B15 | High | Marketing site is git-ignored and absent from live-main source. | Establish its own tracked release source or deliberately include it; verify a clean checkout can build the exact deployed site. | Release |
| B16 | High, branch-only | S11 private folders are an in-memory map (`agent-folders.service.ts` on `origin/s11-agent-identity`). | Replace with persistent scoped storage; test restart durability, cross-Agent access, traversal/symlink rejection and quotas. | S11 owner |
| B18 | Low, test harness | Two PostgreSQL-dependent suites timed out in cleanup after setup failed because server binaries were missing (`unconfigured.test.ts`, `runtime-response-scanning.test.ts`). | Make failed-setup cleanup finish when no server was created; retain the truthful missing-dependency failure. Verify setup-failure cleanup completes promptly. | Test infrastructure |
| B17 | Medium | README/build-map baseline still says runtime is unimplemented; AC22 still says unimplemented despite S10 evidence; threat register includes items implemented in isolated slices. | Reconcile each statement against evidence without upgrading unverified acceptance. Keep dated historical evidence intact. | Documentation + verifier |

No open issue labelled `bug` was found in the slice tracker. That does not mean no bugs exist. New issues should separate B01–B18 from feature work and link the regressions that close them. Some findings share one root integration fix; do not create redundant implementations.

## 4. Every remaining planned implementation slice

The issue number is slice number + 1. Every row's owner is a responsibility to assign, not a claim that an individual is already staffed. Every slice must leave code, targeted regressions, manual evidence for its surface, full required gates, and a reviewed evidence pack. Preserve Pack → Operations → Agents and runtime-owned execution.

| Slice / issue | Remaining deliverable and boundary | Prerequisites | Accountable role and release proof |
|---|---|---|---|
| S11 / #12 | Six durable direct Agent chats; profile/private folders; persisted settings and private-memory boundary; complete existing branch and remove temporary stores | S09, S10 | Agent owner; six-Agent create/read/update/restart/isolation journey |
| S12 / #13 | Real on-demand Pi session adapter; warm reuse, hibernate, reconstruct, heartbeat/hang detection, cleanup; selected harness policy | S03, S11 | Runtime owner; real process lifecycle, crash/hang/restart tests |
| S13 / #14 | Persisted Operation chats, roster, removable coordinator, independent runs, typed messages/delegation, same-Pack enforcement; settle remaining cross-Agent subordinate reading per E19 | S11 | Operations owner; concurrent runs and coordinator removal do not merge state/cost |
| S14 / #15 | Ad-hoc Operation creation with selected same-Pack roster, optional coordinator, persistence and validation | S13 | Operations/web owner; create/reopen/reject cross-Pack browser journey |
| S15 / #16 | Effective launch preview with Agents, skills, connectors, provider/model, estimated credits and approvals; execution only after confirmation | S10, S13 | Operations/web owner; no work before confirm; snapshots match confirmed preview |
| S16 / #17 | Durable task-worker supervision, admission/queue/concurrency/resource limits; keep healthy work alive after browser closure | S12 | Runtime owner; browser-close, exhaustion, queue, cancellation and worker-death cases |
| S17 / #18 | Workspace files, editor, private folders, artifacts, preview/download, path validation, write leases and conflicts | S16 | Workspace owner; durable outputs, isolation, traversal/symlink and lease cases |
| S18 / #19 | Read-only terminal/browser live views, persistent isolated Chromium profile, control conflict protection | S17 | Workspace/runtime owner; read-only enforcement, reconnect, restart and profile isolation |
| S19 / #20 | Separate Git branches/worktrees, conflict queue, diffs and merge review; approval before merge, safe cleanup | S17 | Git/tool owner; real coding task plus reject/approve/conflict cases |
| S20 / #21 | All five approval choices, scoped expiring/revocable grants, reminders, durable decisions and restart handling | S16 | Security/runtime owner; full grant matrix, expiry/revocation and no self-approval |
| S21 / #22 | Sole runtime tool executor, capability intersection, risk ladder, preview/reuse policy, versioned private/shared tool inventory and connectors | S07, S20 | Tools/security owner; lower layers cannot widen permission; proposed tools cannot self-execute |
| S22 / #23 | Classified transient retry, maximum three retries, idempotency, queued/child/process-tree cancellation, partial output preservation, uncertain effects pause | S16, S21 | Runtime owner; fault cases and detached child cancellation without duplicate effects |
| S23 / #24 | Built-in/local/OpenAI-compatible/custom providers; connection tests, secure credentials, per-Agent defaults and per-conversation overrides; real adapter integration | S16, S20 | Provider/security owner; configured success, invalid/missing credentials, redaction and honest failure |
| S24 / #25 | Atomic internal credit reserve/settle/release, usage reconciliation, insufficient-credit pause and top-up resume; no real billing claims | S23 | Accounting/runtime owner; race, duplicate response, cancellation and insufficient-balance tests |
| S25 / #26 | Functional bounded search/fetch/document/spreadsheet/image-data tools with provenance and untrusted-content handling; image generation remains future scope | S21 | Research-tools owner; real input/output files, oversized/error and injection fixtures |
| S26 / #27 | Sandboxed code/terminal execution with filesystem/network policy, environment scrubbing, time/resource limits and containment | S21 | Execution/security owner; escape/secret/limit/cancel tests in disposable environments |
| S27 / #28 | Entire threat-model security test suite ST-01–ST-14, reconciled controls and negative-control evidence | S21, S22, S23, S25, S26 | Independent security verifier; each applicable control fails when disabled and passes restored |
| S28 / #29 | Durable schedules/watchers/authenticated webhooks, deduplication, missed-run behavior and at least one autonomous completion | S22, S23 | Automation owner; trigger/restart/duplicate/auth failure and completed-task evidence |
| S29 / #30 | Scoped memory/provenance, explicit publication, rejection of secrets, correction/deletion and private-memory isolation | S13, S20 | Memory/security owner; no automatic private-to-Operation publication |
| S30 / #31 | Working onboarding and profile/provider/tool/Git/memory/credit/workspace settings; notification center and multi-tab synchronization | S20, S23, S29 | Web owner; defaults, overrides/reset, failure states, keyboard/mobile and tab consistency |
| S31 / #32 | Semantic checkpoints, recovery-class handling, authoritative restart reconstruction and recovery surfaces; approvals/schedules/profile restored safely | S16, S22, S28 | Recovery owner; crash matrix and pause on unprovable external effects |
| S32 / #33 | Secured admin API/CLI; account/tier/runtime controls, failure inspection, emergency cancellation, credit top-up, token rotation and audit | S06, S16 | Operator/backend owner; least privilege, redaction and scoped emergency control |
| S33 / #34 | Six-hour snapshots, latest-seven retention, integrity/corruption checks, secret-safe backups, old-snapshot migration, scratch restore and runbook | S31, S32 | Storage/operator owner; performed restore with usable product state and failure alert |
| S34 / #35 | All 27 criteria mapped to implementation plus automated/manual evidence, runner, target-browser/accessibility matrix, owner acceptance and blocker tracking | S31, S33 | Independent QA + product owner; every adopted criterion accepted with evidence |
| S35 / #36 | Versioned images, Compose/Caddy on one VM, configuration/secrets, migration/start order, health, deploy/rollback/DR runbooks, smoke tests, alerts and staged launch | S34 | Release/operator owner; scratch deploy, rollback/restore drills, post-deploy smoke and 24h monitored soak |

### Security verification inventory, individually required by S27

Each row needs an implementation/control owner, automated proof where feasible, and the specified red-with-control-disabled/green-with-control-restored evidence in the slice evidence pack. Do not run destructive negative controls on production or real user data.

| Test | Remaining verification target |
|---|---|
| ST-01 | Path traversal and symlink escape rejected on every file operation |
| ST-02 | Workspace/task/Agent private-folder boundaries enforced |
| ST-03 | Child environment cannot disclose provider or repository credentials |
| ST-04 | Detached grandchildren cannot survive task cancellation or shed limits |
| ST-05 | CPU/memory/process/disk/wall-clock exhaustion contained |
| ST-06 | Code/network policy and research SSRF prevent forbidden internal/external access |
| ST-07 | Stdout/stderr/Git URLs/provider echoes cannot persist raw credentials |
| ST-08 | Agent-created tool cannot activate, escalate capability or run outside runtime grants |
| ST-09 | Concurrent, expired, foreign and wrong-path write leases cannot silently overwrite |
| ST-10 | User A cannot reach user B's data, volumes, credentials or runtime |
| ST-11 | Indirect prompt injection cannot execute ungranted mutations or external actions |
| ST-12 | Direct injection cannot self-approve or create a grant |
| ST-13 | Oversized messages/uploads/tool streams and floods stay bounded |
| ST-14 | Redaction sweep finds no fixture secret in logs/events/errors/tools/memory/backups |

## 5. Acceptance criteria, every row

Statuses here are this audit's assessment, **not an alteration of the canonical acceptance ledger or an owner acceptance**. Pass requires the complete criterion, including its real integration and manual evidence. Missing, fixture-only, branch-only and unverified portions cannot pass. No complete prototype acceptance package was found, so no row is marked accepted.

| AC | Requirement | Audit status and remaining proof |
|---|---|---|
| 1 | Google OAuth and five-account cap | Conditional: backend implemented/tested; ordinary login entry disabled; full browser/deployed flow unverified |
| 2 | Balanced-tier user container | Fail: provisioning components exist; real registration/bind/storage wiring incomplete |
| 3 | All six direct Agent chats | Fail: merged UI has five fixture chats; S11 remains unmerged |
| 4 | Persistent private identity and on-demand selected-harness session | Fail: real supervision missing; branch folders not durable; Hermes evidence gate unresolved |
| 5 | Ad-hoc same-Pack Operation | Fail: creation placeholder |
| 6 | Preview and delegation within Operations | Fail: placeholder preview and no executed delegation |
| 7 | Live messages/progress/tools/approvals/results | Conditional: one scripted message stream exists; real model/tool/approval/results journey missing |
| 8 | Functional tools end to end | Fail: S21/S25/S26 missing |
| 9 | Agent-created reusable private/shared tools under policy | Fail: no executable policy-backed inventory |
| 10 | Configurable/testable provider classes | Fail: provider layer/settings missing |
| 11 | Agent defaults and conversation overrides | Fail: branch settings are partial; real effective provider execution not established |
| 12 | One autonomous triggered task | Fail: schedules/watchers/webhooks missing |
| 13 | Risky action pause, choices and reminders | Fail: approval machinery missing |
| 14 | At most three transient retries then pause/notify | Fail: execution retry path missing |
| 15 | Immediate whole-tree and queued cancellation, partial outputs retained | Fail: production worker cancellation missing |
| 16 | Shared/private product data persists across restart | Fail: partial SQLite journal durability only; no persistent volume; complete scope missing |
| 17 | Coding worktree with approval before merge | Fail: product Git workflow missing |
| 18 | Automatic backups and administrator restore | Fail: no performed backup/restore system |
| 19 | Safe restart recovery of processes/state/schedules/browser/approvals | Fail: conversation probes cover only a subset; S31 missing |
| 20 | Desktop/mobile web on target browsers | Conditional: responsive shell and screenshots exist; full real-product browser matrix absent |
| 21 | No critical isolation or credential-leak failure observed | Unverified: incomplete proxy authorization and unperformed full security/deployed tests block acceptance |
| 22 | Versioned workspace Pack pin and existing-run configuration snapshots | Conditional: S10 provides concrete schema/persistence/snapshot evidence; reconcile stale traceability, add manual release proof and completed Operation use |
| 23 | Complete preview before any Operation execution | Fail: pending fields/disabled confirmation |
| 24 | Independent task state/events/cost in one Operation | Fail: full Operation/runtime accounting missing |
| 25 | Browser-close survival plus semantic checkpoint restart | Fail: durable worker/checkpoint system missing |
| 26 | Read-only auto, mutation preview, policy-checked reusable grants | Fail: executor and approval enforcement missing |
| 27 | Private memory only enters Operations via explicit publication | Fail: memory implementation and security proof missing |

## 6. Decisions and non-code release obligations

- Reconcile the threat-model register OPEN-1–OPEN-8 with actual implementation: untrusted content separation; system-prompt confidentiality; internal-channel authentication; browser/terminal control leasing; webhook sender verification; backup credential handling; referenced OWASP edition; child-process environment scrubbing. OPEN-3 has isolated S06 implementation and should not be labelled wholly absent, but the production integration still needs proof.
- Complete the threat-model owner's review and assign a test/evidence owner for each control. ST-01–ST-14 must be checked individually; some lower-level controls already have tests, which does not close S27.
- Ratify or explicitly disposition delegated records still marked pending review, including E16 toolchain/CI choices and later E19/E20/E21 records. Preserve historical alternatives and corrections. Reconcile the decision index and traceability rather than assuming headers are current.
- Apply E19's subordinate-run semantics; settle the cross-Agent interpretation before S13 contracts freeze. Replace the concurrency placeholder through S16 evidence. Preserve the no-private-memory-inheritance boundary.
- Obtain the required owner-supplied Hermes upstream source/license/protocol evidence before implementing a Hermes code path or selectable working option. Either fulfil D51 or record an explicit release deferral; do not silently change accepted scope.
- Pin the consumed Pi revision, implement/test the real adapter, inventory its build/dependencies, complete notices including Highlight.js attribution, and approve a maintenance/update procedure.
- Recheck distribution/license obligations on the actual packaged artifact. The current license policy includes an LGPL sharp-binary exception marked pending owner review; green inventory is not final distribution clearance. Preserve required licenses/notices.
- Record the production-readiness decision: intended users/account cap, service ownership, support/incident contact, capacity limits, privacy/data flows, RPO/RTO, retention/deletion/export, monitoring and accepted deferrals. Account-cap expansion is a product change.
- Review migration behavior and execute scratch migration/rollback strategy before launch. Image rollback alone cannot reverse a database change.
- Establish domain/DNS, TLS, OAuth redirect/consent configuration, secrets injection/rotation, VM access/patching, PostgreSQL/network isolation, disk/resource limits and alert routing. Do not log or publish secrets.
- Publish accurate product copy, actual privacy/terms/contact information and release/support limitations. A waitlist needs correct collection purpose, storage, access and deletion behavior; choose confirmation/unsubscribe behavior if sending mail. Analytics is optional, not a release requirement by itself.
- Create a version/build identity, changelog/release notes, known-limitations list and supported environment instructions. A private package flag is normal for a hosted monorepo, not itself a defect; do not publish packages merely to make the website available.
- Decide and test event retention/compaction thresholds and snapshot fallback for the intended load. Typed snapshot-required errors exist; they are not a completed compaction/rehydration operation.

## 7. Dependency-ordered completion plan

These are proposed work packages, not new product decisions. Preserve one logical slice per PR. Independent lanes can proceed in parallel after their prerequisites pass; one integration owner must own the runnable system.

| Stage | Work and owner | Evidence gate before moving on | Rough focused engineering effort |
|---|---|---|---|
| A: establish a real deployable skeleton | Integration/release owner fixes B01–B07, B10–B12, aligns current source, creates minimal private development image/network/storage wiring and reproducer tests; documentation owner reconciles stale facts | A new test account signs in through normal entry, gets its own container, passes authenticated registration/health, cannot reach another account, and retains data after recreation. No model success claimed yet. | 3–7 days |
| B: finish Agent/Operation execution | S11–S16; runtime owner implements real Pi supervision while Operations/web owner handles S13–S15 after S11. Resolve Hermes release disposition and provider integration contract. | Six durable Agent identities; genuine supervised model reply using controlled configuration; persisted Operations/preview/delegation; separate runs; browser-close survival. Provider secrets/calls remain controlled until Stage C. | 10–20 days |
| C: safe tools and useful output | S17–S27; parallel workspace/Git and approval/executor lanes, then providers/credits and research/sandbox tools. No risky tool execution before approvals/policy gates. | Real research/coding output, artifacts, worktree review, grant/revoke/retry/cancel cases and full adversarial security suite. No fake success/provider fallback. | 20–35 days |
| D: unattended use and durability | S28–S33; automation/memory/settings can split by ownership, then integrate checkpoint recovery/admin/backups | One autonomous task completes; scoped memory stays private; schedules/approvals/state recover; corrupt backup rejected and valid snapshot restored into scratch. | 10–20 days |
| E: acceptance and private launch | S34–S35; independent QA, product owner and release operator | All 27 criteria have automated and manual evidence plus owner acceptance; real deployed login/model/tool journey; cross-browser/accessibility; deploy/rollback/restore drills; demonstrated alerts; 24h sole-user soak; then accounts 2–5 in stages. | 7–15 days plus soak/review time |

Total planning allowance: **roughly 50–100 focused engineering days**, with review, failed integrations and owner decisions capable of extending it. This is an estimate based on the remaining scope, not measured delivery velocity or a promised date. For one full-time developer coordinating AI tools, reserve approximately **3–6 calendar months**, then re-estimate after Stage A and the first two completed slices. Do not assume six agents produce six times the throughput.

Marketing-only release is a separate, much smaller lane: track source, fix/remove the false waitlist, add actual privacy/contact pages, validate every claim, deploy a build and check mobile/keyboard/forms. Budget a few focused days if copy/design is retained; external domain/account decisions can add elapsed time. It does not reduce the product backlog.

## 8. Website and software packaging after acceptance

### Hosted website: the primary route

Deploy the existing three-service architecture, not the Next.js client by itself: public HTTPS web/control-plane access, private per-user runtime routing, central PostgreSQL, durable per-user SQLite/files/browser volumes, required transient infrastructure, external secrets, and scheduled verified backups. Start with the recorded one-VM/five-account boundary. Keep Docker socket, runtime tokens, internal ports and private paths away from browsers. Use the S35 build SHA as the release identity and rerun smoke tests after each deploy.

### Self-hosted distribution: the smallest software package

Once the hosted stack works, provide pinned images/Compose, `.env` examples without credentials, prerequisites/resource requirements, first-admin/bootstrap instructions, OAuth/provider setup, migration/upgrade/rollback instructions, backup/restore and troubleshooting. Verify installation from a clean machine with no developer-local paths/cache. Publish notices and an explicit support/security update policy. Do not bundle user secrets, local databases or session archives.

### PWA: optional later scope

Record the scope change first. Add the web manifest, icons, HTTPS/installability, appropriate cached shell behavior and update handling. Keep authentication and private API data out of unsafe caches; define how offline/expired-session behavior works. Prove install/update/logout behavior on supported desktop/mobile browsers. PWA installation still depends on the hosted backend for real work.

### Desktop app: only if it solves a specific need

Choose whether it is a client of the hosted service or a complete local stack. A hosted client needs secure OAuth/deep links, platform packaging, signing, trusted updates, crash/support handling and platform QA. A bundled stack adds local runtime/database/browser/process installation, isolated secret storage, resource/port management and migrations. Review licenses on the final bundle. Do not pick a wrapper dependency until those requirements exist.

## 9. Explicit future scope, not silently counted as current prototype blockers

PRD §20 defers: native iOS/Android and PWA enhancements; full desktop/browser takeover; X/social search and feeds; voice, image/video generation and richer multimodal work; commercial billing/subscriptions/metering/cost controls; user/admin export, permanent purge and configurable retention; enterprise teams/roles/audit UI; multi-region/HA/autoscaling/per-user VM orchestration; managed production secrets service; advanced connector/OAuth/webhook-condition builder; tool review/signing/marketplace/distribution; model routing/fallback/quotas; distributed tracing/external error monitoring/formal load tests/performance budgets; cross-device local-first synchronization; cloud-migration automation.

Some become necessary for a broader public or paid release, especially privacy lifecycle, abuse/cost limits and support/operations. Reassess and record that release's scope after private acceptance. They are not all prerequisites to a five-user prototype; enterprise infrastructure is unnecessary for the first release.

## 10. Evidence and audit limits

- Live GitHub main SHA was checked using `git ls-remote`; issues and open PRs were queried live. Raw lists are in `issues.json` and `pull-requests.json`.
- Exact-main CI run [37586953882](https://github.com/ihmorol/shera-bot/actions/runs/37586953882), completed 2026-10-07, has successful verify, license and mockup jobs. Its gates cover install, lint, format, types, boundary guards, tests and build. These do not deploy or establish full product acceptance.
- Fresh local gates: lint, formatting, types, boundary guards, licenses, build and mockup 27/27 passed. Product tests did **not** pass overall: 61 files passed, nine failed PostgreSQL setup; 645 tests passed and 50 skipped. Two failed-setup teardown hooks also timed out. Rerun those suites with PostgreSQL 16 before claiming a full fresh pass.
- Running-build smoke reproduced disabled login, registration HTTP 404 and anonymous caller-chosen-workspace creation HTTP 200, all using disposable audit data.
- Fresh local validation results and observed runtime smoke evidence are recorded in `VALIDATION.md` alongside their logs. Read that file for precise pass/fail status and environment limits.
- The snapshot is an archive of `origin/main`; source findings can be reproduced without touching the older current checkout. Local-only marketing files and branch-only S11 are explicitly distinguished.
- This inventory covers the 35-slice plan, every adopted acceptance criterion, visible source blockers, known release obligations and deferred scope. It cannot guarantee discovery of every latent bug. Failed or unperformed tests are not evidence of safety.

No product code was changed, no branch was merged, no service was deployed, and no paid model call was made during this audit.
