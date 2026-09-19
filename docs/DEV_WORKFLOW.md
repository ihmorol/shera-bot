# Solo Developer Workflow: Current State → Production Shipment

**Created:** 2026-09-13 · **Owner:** you (solo developer) · **Executors:** AI coding agents
**Status:** Engineering process documentation. Subordinate to `PRD.md` and the decision records (D1–D50, E1–E14). This file changes *how* you build; it never changes *what* you build. Any scope, tenancy, data, or approval change still requires a recorded product decision (PRD §24).

---

## 0. How to use this file

1. Work **one stage at a time, in order**. Do not open the next stage until the current stage's **Gate** is true. Gates are evidence-based, not vibes-based.
2. Every stage has four parts: **Goal → You do → Agents do → Gate**, followed by a copy-ready **prompt set**. Prompts work in any capable coding agent (Claude Code, Codex, ZCode, Cursor, …); a few map to installed `/skills` — see §3.3.
3. **You are the bottleneck on purpose.** Research is consistent: the amount of work you can safely delegate is limited by what you can *specify, inspect, test, and confidently accept* — not by how much code an agent can generate (see §9, sources S1–S9). Every gate below exists because of that.
4. Two-track rule, always: **mockup evidence ≠ runtime evidence ≠ live-provider evidence.** Keep claims labeled and never merge them (this rule is already recorded in `docs/README.md` and `mockup/README.md`).
5. If reality diverges from this file, fix this file in the same session. If reality diverges from the PRD, stop and record a product decision first.

---

## 1. Where you are today (baseline snapshot, 2026-09-13)

Verified state — this is the starting line:

| Area | State |
|---|---|
| Product design | Complete and synchronized: PRD + D1–D50 + E1–E14, acceptance criteria 1–27 defined. Criteria **22–27 are adopted but not implemented** (`docs/TRACEABILITY.md`). D46–D50/E9–E14 were recorded 2026-09-17 under the owner's delegation (D47–D50/E9–E14 pending owner review). |
| Static mockup | Interactive HTML/CSS/JS client with fixtures, pane system, search palette, Agent profile panel, three-panel floating shell, ambient canvas (`mockup/dock-layout.test.cjs`, 27 passing). No backend, no auth, no persistence beyond theme. |
| Mockup defects | All five Stage-1 trust/safety defects repaired 2026-09-13 with regression tests: nested routes (17 links), unsafe `esc()`, settings deep-link trap, modal interior-click dismissal, login landing on Overview — commits `788e38f`, `958ce34`, `fd0270d`; HANDOFF §13–§20. Fixture truthfulness (F9/F10) repaired at the data source. |
| Recorded conflict | D43 roster mapping — **resolved 2026-09-17 by D46** (one home Operation per Agent; subagent triggering; mapping table in the record). The Exam Preparation fixture roster now matches D46; the change is recorded in `mockup/HANDOFF.md` §21 rather than applied silently. |
| Unresolved decisions | The ten items open on 2026-09-13 were dispositioned 2026-09-17 (D46–D50, E9–E14; ledger in `docs/decisions/open-items-decisions-2026-09-17.md`). Remaining open: exact subagent semantics (D46 sub-item) and the Stage-3 plan confirmations (`docs/TRACEABILITY.md`, Open items). |
| Runtime | **Nothing implemented.** Chosen stack (Next.js/React/TS/Tailwind, Express control plane, PostgreSQL + container SQLite WAL, Drizzle, Redis transient, Zod contracts, pnpm/Turborepo, Docker Compose on one Ubuntu 24.04 VM) exists only as decisions. D13 TypeScript↔Pi process boundary needs a supervision spike; `node:sqlite` choice is subject to that spike (and now also the E11 backup mechanism). |
| CI / deploy | None. No pipeline, no Dockerfile/Compose, no migrations, no deploy runbook. |
| Marketing site | Separate standalone Next.js repo (git-ignored here). Waitlist is simulated and currently tells visitors they are on the list when nothing is stored (`business-landing-portfolio/components/waitlist-form.tsx`) — fix before any public exposure. |
| Git | Product repo clean on `main` at the 2026-09-17 open-items commit (D46–D50/E9–E14 records, PRD SYNC-2, fixture update). Stage 0/1 banked via `788e38f`, `958ce34`, `fd0270d`, `c656c75`; HANDOFF §13–§21 and evidence committed. |

**The approved next release is a private prototype** (≤5 accounts, Google OAuth, simulated tiers, one VM), not a public launch. A separate production-readiness decision comes after prototype acceptance (§7, Stage 7).

---

## 2. Operating principles (why this is not vibe coding)

Each principle below is backed by a cited source in §9. Where evidence is weak, the principle says so.

| # | Principle | Based on |
|---|---|---|
| P1 | **Verification capacity is the limit.** Delegate only what you can specify, inspect, and test. | S6/S7 (METR), S8 (DORA: throughput up, stability down without tests) |
| P2 | **Bounded slices with executable acceptance.** Small vertical slices, each with a runnable check, beat large delegated tasks. | S1 (Anthropic best practices), S2 (Building effective agents: simplest adequate pattern) |
| P3 | **Red/green discipline.** A test that never failed proves nothing. Bugs get a reproducer first. | S4 (Willison, red/green TDD) |
| P4 | **Run the thing.** Green unit tests are not a demonstration. Agents run the app; you personally exercise core journeys before release. | S5 (Willison, agentic manual testing), S9 (Claude Code team) |
| P5 | **Separate implementation from review.** Review happens in a fresh context, and *you* approve sensitive changes (auth, migrations, secrets, deletion, billing/credits, recovery). | S9, S2 (human checkpoints), repo rule: coding-task main-branch merges require your explicit approval |
| P6 | **Never let the implementer define its own acceptance criteria.** Agents may draft tests; you confirm the tests represent the requirement, not the generated code. | S3 (Anthropic evals: judge the artifact), S4 |
| P7 | **No "the agent said it passed."** Require command output, diffs, screenshots, and a list of what was *not* verified. | S3, S5 |
| P8 | **Stop drift early.** Repeated failed corrections → narrow the task or reset context with a better spec; do not add more agents to a failing loop. | S1, S2 |
| P9 | **Escalate review with consequences.** The more a change can destroy data or spend money, the more direct your scrutiny. | S9, PRD approval/grant model |
| P10 | **Security is structural, not a prompt.** Map OWASP LLM risks to runtime mechanics (§6, Stage 3/6): prompt injection (LLM01), resource exhaustion (LLM04), secret disclosure (LLM06), excessive agency (LLM08) → grants, approval gates, redaction, limits. Agents proposing vs. the runtime validating/executing is your core defense and is already a recorded decision. | S10 (OWASP GenAI Top 10), PRD/decisions |
| P11 | **Releases are reproducible and reversible.** Pinned versions, versioned build script, tested restore, staged exposure, rollback plan — sized for one VM, not Google scale. | S11 (SRE release engineering), PRD backup/restore requirements |
| P12 | **Measure finished work, not activity.** Track slice cycle time, rework, and escaped defects. Feeling faster is not being faster (METR developers mis-estimated by ~40 points). | S6, S7 |

### Hard guardrails (non-negotiable in every prompt)

- **G1.** Vocabulary is **Pack → Operations → Agents**. Never reintroduce "Expert" as a separate object.
- **G2.** Agents propose; the **runtime gateway** validates and executes. No LLM classification of prose creates tasks — typed execution events do.
- **G3.** Never expose secrets in prompts, events, logs, memory, artifacts, or docs. Agents receive references, never credentials.
- **G4.** No fake completion fallback: a missing provider shows a configuration failure (recorded decision).
- **G5.** Do not silently resolve recorded conflicts (e.g., D43 roster mapping) in code or fixtures — surface them.
- **G6.** Read-only tools automatic; local mutations previewed; risky effects approval-gated. Agents can never self-approve.
- **G7.** Live-provider tests are opt-in, never default CI.
- **G8.** Every main-branch merge of coding work gets your explicit approval after a fresh-context review.

---

## 3. Your agent roster

Roles are **not** different tools — they are different prompts, and where it matters, **fresh sessions**. One agent can wear several hats across a day; the two roles that must never share a context are *Implementer* and *Reviewer*.

### 3.1 The roles

| Role | Job | Fresh context? | Used in |
|---|---|---|---|
| **Scout** | Read-only investigation: map files, summarize diffs, find all callers, draft slice proposals. Never edits. | Yes, per task | Stages 0–9 |
| **Planner** | Turn a slice idea into a spec: contracts, affected files, decision IDs, acceptance criteria, non-goals. | Yes | Stages 2–8 |
| **Test-writer** | Red tests first: reproducers, fixtures, boundary cases, manual-check procedures. | Yes | Standing loop |
| **Implementer** | The only role allowed to edit code. Works one slice, runs checks, reports evidence. | Yes, per slice | Standing loop |
| **Reviewer** | Fresh-context adversarial review of a finished diff: correctness, requirement coverage, guardrails G1–G8. Never the same session as the implementer. | **Always fresh** | Standing loop |
| **Security reviewer** | Reviews security-sensitive diffs (auth, grants, migrations, isolation, secrets) against the threat model and G3/G6. | **Always fresh** | Stages 3–8 |
| **QA runner** | Executes the app like a user: scripted journeys, then exploratory; converts findings into reproducers. | Yes | Stages 1, 6, 8 |
| **Archivist** | Updates HANDOFF/REFERENCE/traceability/evidence ledgers; prepares commits and decision drafts. | Yes | Every stage |
| **Release engineer** | Build scripts, Compose, deploy runbook, rollback drill, smoke tests, monitoring. | Yes | Stages 7–8 |

### 3.2 Staffing rules

- **Default: one active implementation task.** Run Scout/Archivist/QA in parallel only because they don't edit code. Add a second Implementer only for provably independent slices — and only if your review capacity is free. (This is the conservative reading of S2/S6, not an empirically proven optimum.)
- When you approve a merge, say so in the session ("approved, merge") — that sentence is your recorded gate (matches the repo rule that coding merges need explicit user approval).
- If the same fix fails twice, invoke the drift rule (P8): stop, reset, rewrite the task spec — usually the spec was the problem.
- **2026-09-19 — owner delegation: parallel worktree agents + delegated merge gate.** The owner instructed: *"use parallal agents for parralal execution for the issues so that agents can work parallaly on parallel worktree … you analyze the subagents pr. review them and merge them if no issues occur. keep everything documented."* From this point: (1) parallel Implementer agents are authorized for **provably independent slices** — one agent per git worktree, branch, and PR; the standing loop is unchanged and every agent prompt carries the guardrails G1–G8, the red-first rule, and the slice issue; (2) the G8 approval sentence is **delegated to the orchestrator**: a slice PR merges when its fresh-context adversarial review has no outstanding BLOCK / FIX-THEN-MERGE findings, local verification on the pinned toolchain is green, and CI is green — or its absence is explained on the PR (on 2026-09-19: an Actions billing/spending-limit block; see PR #37); (3) every merge carries a PR comment recording the review verdict, fixes applied, and open items passing to the owner; (4) observed platform limit: two concurrent subagents — slices run in waves, not all at once; (5) sensitive artifacts keep the owner's direct-scrutiny requirement (P9) as an explicit open item on the PR — the delegation waives review bottlenecks, never scrutiny of auth/migrations/threat models/grants.
- **Lesson (2026-09-19, S01):** a second session had already built S01 on a remote branch with an open PR while this session rebuilt it locally in parallel. `git fetch` + `gh pr list` **before** starting any slice; adopt the existing PR and review it rather than duplicating (the duplicate was discarded).

### 3.3 Installed `/skill` shortcuts (this workspace)

You don't need them — the prompts below are self-contained — but these map onto the roster:

| Stage need | Shortcut |
|---|---|
| Slice spec (Planner) | `/spec` |
| Red-green implementation | `/tdd` (or `/tdd-strict`) |
| Fresh-context review | `/review`, `/review-security` |
| App-level testing | `/qa`, `/qa-only` |
| Debugging an investigation | `/investigate` |
| Deploy setup / runbook | `/setup-deploy` |
| Release documentation | `/document-release` |
| Shipping a slice | `/ship` |
| End-of-stage retrospective | `/retro` |

---

## 4. The prompt skeleton

Every prompt in this file is a filled-in version of this shape. When you write your own, keep the shape:

```
ROLE: You are the {role} on a solo project. You may/may not edit files.

CONTEXT (read before acting):
- {files to read, e.g. docs/PRD.md §x, docs/decisions/confirmed-decisions.md Dxx}
- {relevant state, e.g. "mockup has no backend; fixtures are fake by design"}

TASK: {one bounded outcome}

CONSTRAINTS:
- {scope boundaries: what NOT to touch}
- Repo guardrails: Pack → Operations → Agents vocabulary; runtime validates and executes;
  never expose secrets; no fake completion fallback; do not silently resolve recorded conflicts.
- {stop conditions, e.g. "if D43 appears, stop and report instead of deciding"}

ACCEPTANCE (how we'll both know it's done):
- {executable checks, expected outputs, or manual procedure}

STOP & REPORT: {exact commands to run and their output, files changed, what you did NOT verify}.
Do not claim success without showing evidence.
```

---

## 5. The standing loop (used in every build stage)

This is the unit of work from Stage 3 onward. One loop = one slice = one reviewable diff. Budget half a day to two days per loop; if a slice is bigger, split it.

1. **Define the slice (you, 15–30 min).** What behavior, for whom, what's explicitly out. You write or approve the acceptance criteria. *You own intent.*
2. **Red tests (Test-writer).** Reproducer for bugs; failing acceptance tests for features. **You read the tests and confirm they describe the requirement, not the implementation** (P6). Reject tests that only test what the agent found easy.
3. **Implement (Implementer).** One slice, guardrails in prompt, runs the checks itself, iterates until green. It may not touch files outside the declared scope.
4. **Evidence handoff (Implementer).** Diff summary, actual command output, screenshots/runnable demo path, remaining failures, unverified areas. No evidence = no review.
5. **Fresh-context review (Reviewer).** Adversarial pass over the diff: correctness, requirement coverage, G1–G8. Security-sensitive slices go to the Security reviewer too.
6. **You verify (10–30 min).** Read the diff yourself. Run the app where it matters. **Sensitive changes (auth, migrations, grants, secrets, deletion, credits, recovery) always get direct personal scrutiny** (P9).
7. **Merge with recorded approval (you).** Explicit approval sentence, then merge to main.
8. **Archive (Archivist).** Update traceability/evidence entries, note regressions found → new reproducers (feeds step 1 of the next loop).

---

## 6. The stages

### Stage 0 — Bank the present (one session, do first)

**Goal:** Clean working trees, every piece of real work committed with honest messages, evidence preserved. You cannot build on a dirty foundation.

**You do:**
- Skim the 528-line diff. Confirm you recognize everything in it (this is your work from recent sessions).
- Decide the fate of untracked material: `mockup/HANDOFF.md`, `REFERENCE.md`, `UX_RECOMMENDATIONS.md`, `dock-layout.test.cjs`, `mockup/reviews/` — these are evidence and should be committed; `.gstack/` is tooling state (git-ignore it if not already covered).
- Approve the commit plan the agent proposes.

**Agents do:**
- Scout: summarize the uncommitted diff file-by-file and flag anything unexpected.
- Archivist: group changes into logical commits (mockup fixes vs. docs vs. tests), draft conventional-commit messages.
- Runner: execute the documented checks so the committed state is known-good:
  `node --test mockup/dock-layout.test.cjs`, `node --check mockup/app.js mockup/views.js`, `git diff --check`.

**Gate:** `git status` clean in the product repo (and the marketing repo committed or deliberately left). Test run output pasted into `mockup/reviews/` dated evidence.

**Prompt set:**

```text
ROLE: Scout. Read-only. Do not edit anything.
CONTEXT: Product repo E:/PROJECTS/shera-bot on main, 7 modified files (~528 insertions:
README.md, docs/README.md, mockup/README.md, app.js, index.html, screens.css, views.js)
plus untracked mockup/HANDOFF.md, REFERENCE.md, UX_RECOMMENDATIONS.md,
dock-layout.test.cjs, mockup/reviews/, .gstack/.
TASK: Summarize the uncommitted diff file-by-file: what changed, what risk each change
carries, and whether anything looks unintended or contradicts mockup/HANDOFF.md.
CONSTRAINTS: Read-only. Do not run servers or tests. If you find a change that contradicts
a documented decision or the D43 roster conflict, report it — do not judge it "fine".
ACCEPTANCE: A table (file → change → risk → keep/fix/ask) plus a one-paragraph overall
assessment.
STOP & REPORT: List the git commands you ran. Quote anything ambiguous verbatim.
```

```text
ROLE: Archivist. You may stage files but not modify content.
CONTEXT: Same repo state as the Scout task. Current HEAD fca3090.
TASK: Propose 2–5 logical commits: which files in which commit, conventional-commit
messages (e.g. "fix(mockup): ...", "docs(mockup): ..."). .gstack/ should be git-ignored,
not committed — verify .gitignore covers it and include the .gitignore line if needed.
CONSTRAINTS: Do not commit UX_RECOMMENDATIONS as if it were adopted product design —
commit message must say "proposal, not adopted". Do not touch docs/PRD.md.
ACCEPTANCE: I will approve the plan before you run git commit. After my approval: clean
status, git log shows the planned commits.
STOP & REPORT: The commit plan first. After approval: `git log --oneline -5` and
`git status` output.
```

---

### Stage 1 — Repair mockup trust & safety (before any runtime work)

**Goal:** The five documented mockup defects are fixed with regression tests, and the D43 conflict is surfaced, not buried. This is a trust exercise: it proves the standing loop works before you point it at the runtime, and it leaves the UX reference honest.

**You do:**
- Approve the fix order (suggested: `esc()` → modal guard → navigation → settings deep-link → login destination; security-adjacent first).
- **Decide the D43 roster-mapping question yourself** (product decision; record it per repo rules) — the agent only documents the conflict's impact on fixtures.
- Personally click through each fixed journey (P4).
- Separately, decide whether to adopt any part of `UX_RECOMMENDATIONS.md` — that is a product decision, not a repair. Do not let it ride along with bug fixes.

**Agents do:**
- Test-writer: one failing regression test per defect before each fix (red → green).
- Implementer: one defect per loop, evidence at handoff.
- QA runner: exploratory pass afterward to catch collateral breaks; findings become reproducers.
- Archivist: update `mockup/REFERENCE.md` implementation status and append dated evidence to `mockup/reviews/`.

**Gate:** All documented defects fixed with green regression tests; full `node --test` suite green; QA pass with no new reproducers; HANDOFF/REFERENCE updated; D43 decision recorded or explicitly deferred with a decision record.

**Progress 2026-09-13:** all five defects repaired (baseline table); QA click-through done in-session for routes/settings/login; **gate still open** pending two owner decisions: the D43 roster-mapping record and the UX_RECOMMENDATIONS adoption call. Escaping/modal tests cover DOM-level behavior; the login-destination change was verified in-browser only.

**Progress 2026-09-17 — gate closed:** the owner answered the roster question (*"currently an agent can run only one operation, but the same agent can trigger multiple subagents"*), recorded as **D46** with the student pack v1 mapping; the UX_RECOMMENDATIONS call is dispositioned as **D50** (not adopted as a redesign; evaluated per Phase-1 UI slice) under the owner's Stage-2 delegation. The Exam Preparation fixture roster was updated to D46 with a dated HANDOFF §21 entry (test suite green, 27 passing) — no longer a silent-conflict risk (G5) because the conflict is now resolved by a recorded decision.

**Prompt set:**

```text
ROLE: Test-writer. You may create/modify ONLY mockup/dock-layout.test.cjs (or a sibling
*.test.cjs). You may not fix the bug yet.
CONTEXT: mockup/app.js and mockup/views.js implement a static client. Documented defects
in mockup/HANDOFF.md: (1) esc() only stringifies input — unsafe HTML rendering;
(2) modal data-stop branch does not stop delegated overlay actions (app.js ~698-703);
(3) launch/create actions emit nested paths the flat router can't resolve and report
creation without creating (app.js ~95-114, 262-269); (4) settings rendering reapplies the
URL section, overriding category selection (app.js ~102-105, 402).
TASK: For defect (1) only: write failing tests that prove escaped rendering — e.g. a
fixture string containing <img onerror> or <script> must render as inert text. Run
node --test and show the failure.
CONSTRAINTS: Tests must load real files (VM pattern used by the existing suite). No new
dependencies. If a test cannot be written without a browser, write the closest DOM-level
test and say what still needs manual verification.
ACCEPTANCE: Red test output pasted. I approve the test intent before implementation.
STOP & REPORT: node --test output, test names, what the test does and does not cover.
```

```text
ROLE: Implementer. One slice: make the approved red tests green by fixing esc() in
mockup/views.js.
CONTEXT: docs/PRD.md §security expectations; mockup/HANDOFF.md. Tests already approved
and failing.
TASK: Implement safe escaping, minimal diff. Run the full mockup test suite plus
node --check on changed files.
CONSTRAINTS: Do not refactor anything else. Do not touch fixtures or the D43 roster
mapping. No new dependencies.
ACCEPTANCE: Previously failing tests pass; full suite green; no behavioral change to
legitimate rendering (show before/after output for a normal fixture).
STOP & REPORT: git diff, full test output, list of what you did NOT verify (e.g. visual
rendering in a browser).
```

```text
ROLE: Reviewer. Fresh context — you did not write this code. Read-only except that you
may run tests.
CONTEXT: Review the diff of {commit/branch} fixing {defect}. Requirements in the slice
spec; repo guardrails: no silent fixture changes, no unresolved conflict decisions.
TASK: Adversarial review: correctness, edge cases (nested quotes, already-escaped input,
non-string values), requirement coverage, guardrail violations.
ACCEPTANCE: Verdict per finding: BLOCK / FIX-THEN-MERGE / NOTE, each with file:line
evidence.
STOP & REPORT: Findings list; explicit statement of what you could not check.
```

---

### Stage 2 — Clear the decision backlog (you are the product owner here)

**Goal:** The ten open items in `docs/TRACEABILITY.md` get explicit dispositions: decided now, deferred with an owner and evidence target, or bundled into Stage 7's production gate. Agents cannot make these decisions — they can only prepare them for you.

**You do:**
- For each item, choose: **decide / defer / production-gate**. Answer in one sentence each; the Archivist formalizes.
- Sign each new decision record (D46+, E9+ as applicable) — with ID, status, date, exact evidence, rationale, alternatives, affected PRD sections, implementation implications, verification coverage, and supersession updates. This is the repo's own rule; keep it.

**Agents do:**
- Scout: for each open item, a half-page brief: what it is, what depends on it, cheapest viable prototype answer, what breaks if ignored.
- Archivist: draft decision records from your one-sentence answers; update the supersession map and traceability table.

**Gate:** TRACEABILITY shows no unowned open item; every new record has evidence and traceability entries.

**Prompt set:**

```text
ROLE: Scout. Read-only.
CONTEXT: docs/TRACEABILITY.md lists open implementation-defined items; context in
docs/decisions/confirmed-decisions.md and closure-decisions.md. Product = private
prototype, ≤5 accounts, one VM, phases 0–7 recorded.
TASK: For each open item: (a) restate it precisely with its source line; (b) what
depends on deciding it; (c) the cheapest viable prototype answer; (d) the risk of
deferring it to the production gate; (e) which recorded decision IDs interact with it.
CONSTRAINTS: Do not recommend a "right" answer for product questions — lay out 2–3
options with trade-offs. Flag any item you believe blocks Phase 0/1 work with a ⚠.
ACCEPTANCE: One structured block per item, all ten covered.
STOP & REPORT: Sources consulted with paths.
```

```text
ROLE: Archivist. You may edit only docs/decisions/*, docs/TRACEABILITY.md, and this
workflow file's decision log appendix.
CONTEXT: My one-sentence dispositions follow. Repo rules: every decision needs ID,
status, date, exact evidence source, rationale, alternatives, affected PRD sections,
implementation implications, verification coverage; supersessions update the map and
traceability table; never delete alternatives/findings/corrections.
TASK: Draft decision records for the approved items; mark deferred ones "deferred, owner
Emon, evidence target {…}", production-gated ones "assigned to production gate".
CONSTRAINTS: Vocabulary Pack → Operations → Agents. No PRD edits — PRD sync happens
after I approve the records (PRD §24).
ACCEPTANCE: I review each draft. After approval: index updated, supersession map
consistent, TRACEABILITY rows updated.
STOP & REPORT: Drafts for review; then diffs after approval.
```

**Progress 2026-09-17 — gate met under owner delegation:** the owner delegated the ten dispositions (*"based on prd and all the decisions make the smart and best suitable choices for each one"*). The brief's disposition table is filled; records **D46–D50 and E9–E14** are drafted in `docs/decisions/open-items-decisions-2026-09-17.md` with evidence, rationale, alternatives, affected PRD sections, implementation implications, and verification coverage; the supersession map, index, and TRACEABILITY ledger are updated; PRD SYNC-2 applied. D47–D50/E9–E14 are marked **Delegated (pending owner review)** — the gate closes fully when the owner reviews those records. Remaining open: exact subagent semantics (D46 sub-item) and this plan's confirmations below.

---

### Stage 3 — Phase 0 foundation: contracts, safety model, harness, CI skeleton

**Goal:** The recorded Phase 0 artifacts exist as code and documents: shared Zod contracts, operation/task state machine, approval model, filesystem layout, Pack schema, threat model, and a test harness — plus the monorepo scaffold (pnpm/Turborepo) and a CI pipeline that runs lint, typecheck, and tests on every push. Nothing user-visible yet; everything downstream depends on this being right.

**You do:**
- Approve the repository scaffold and module boundaries (this is engineering, within the recorded stack decisions — you own it).
- Read the threat model top to bottom. This document encodes G6 and the approval model; it is a sensitive artifact (P9).
- Approve the CI definition (what blocks a merge).

**Agents do:**
- Planner: scaffold plan per `docs/decisions/confirmed-decisions.md` repo-layout record; contract list per PRD.
- Implementer: scaffold, Zod contract packages, state-machine module with exhaustive transition tests, approval-model module (read-only/preview/gated classification as data, not prose).
- Security reviewer: threat model draft mapped to OWASP LLM01/04/06/08 and the recorded isolation rules (no host Docker socket, no host FS, network-disabled execution by default, resource limits).
- Release engineer: CI pipeline (lint → typecheck → unit → contract tests), branch protection notes, commit conventions.

**Gate:** `pnpm install && pnpm test` green locally and in CI; contracts versioned and exported from one place; state machine rejects illegal transitions in tests; threat model reviewed by you line-by-line; this file's decision-log appendix notes the E-record for any engineering choice made (e.g., CI provider).

**Progress 2026-09-17 — unchanged draft; owner deferred.** The owner directed that Stage 3 wait (*"stage 3. lets work on it later. first update the changes, mis configuration"*). The plan draft stands unapproved; the S2 contract blockers it listed (Pack mapping, `workspace_id`) are now decided (D46, E12), and the remaining confirmations in its §8 (dark-only v1, CI provider, pnpm/Node pins) plus the owner's review of the Delegated records are the only pre-scaffold items left.

**Prompt set:**

```text
ROLE: Planner.
CONTEXT: docs/PRD.md §247–261 (stack) and §338–361; docs/decisions/confirmed-decisions.md
repo-layout record (apps/web, apps/control-plane, apps/runtime-gateway, packages/contracts,
infra/, migrations, test dirs); decisions D13 (TypeScript↔Pi process boundary — spike
pending in Stage 4), D32/D43 (lifecycle and roster), PRD §19 acceptance criteria 22–27.
TASK: Produce the Phase 0 build plan: monorepo scaffold layout; the first 8–12 shared Zod
contracts (login/session, operation, task/typed execution events, approval request/grant,
artifact ref, credit reservation); the operation/task state machine's states and legal
transitions; the approval-model data shape; the filesystem layout contract; the test
harness shape (unit/contract/integration/recovery/E2E slots, fake Pi provider seam, fake
clock seam). Deliver as an ordered slice list where each slice fits the standing loop.
CONSTRAINTS: Do not choose the SQLite driver (spike pending). Do not design provider
integrations. Contracts must be Zod-first with generated types — no hand-written duplicate
types. Every slice lists: files touched, decisions referenced, acceptance checks.
ACCEPTANCE: I approve the slice list before any scaffolding starts.
STOP & REPORT: The plan; open engineering questions you had to assume.
```

```text
ROLE: Implementer. Slice: repository scaffold + CI skeleton.
CONTEXT: Approved scaffold plan; pnpm + Turborepo per recorded stack; Node LTS.
TASK: Create the workspace layout from the plan, root package.json, turbo config, tsconfig
bases, eslint/prettier, .gitignore updates, and a CI workflow running lint, typecheck, and
placeholder tests on push/PR to main. Add a smoke contract test that imports the empty
contracts package.
CONSTRAINTS: Pin exact tool versions. No app code yet. Do not add Docker/Compose yet
(Stage 8). Do not modify docs/ or mockup/.
ACCEPTANCE: pnpm install && pnpm lint && pnpm typecheck && pnpm test all green; CI
workflow file present and valid YAML.
STOP & REPORT: Command outputs, tree of created files, any deviation from the plan with
reasons.
```

```text
ROLE: Security reviewer. Fresh context.
CONTEXT: docs/PRD.md isolation/approval/secrets sections; confirmed-decisions.md security
records; OWASP GenAI LLM Top 10: LLM01 prompt injection, LLM04 resource exhaustion, LLM06
sensitive disclosure, LLM08 excessive agency.
TASK: Draft docs/THREAT_MODEL.md for the runtime gateway: assets, trust boundaries
(user ↔ control plane ↔ runtime gateway ↔ user container ↔ providers), and for each
threat: the structural control that answers it (approval gates, scoped expiring grants,
redaction, network-disabled execution, resource limits, process-tree cancellation). Map
each control to the recorded decision IDs. End with the security test list that Stage 6
must implement (traversal/symlink escapes, secret leakage, process/resource/network
escapes, tool escalation, lease bypass, cross-user access).
CONSTRAINTS: No controls that contradict recorded decisions. If a threat has no recorded
answer, mark OPEN — do not invent one.
ACCEPTANCE: Every OWASP-mapped threat has a structural control or OPEN flag; test list is
concrete and runnable-looking.
STOP & REPORT: The draft; the OPEN list.
```

---

### Stage 4 — Phase 1 vertical slice: login → container → one Operation chat → SQLite → streaming (fake provider)

**Goal:** The thinnest honest end-to-end path: sign in, get one provisioned container, open one General Assistant chat in an Operation, send a message, see tokens stream, refresh the page, and see the same history via replay — all against the **fake Pi provider** and real SQLite. This is where the architecture meets reality for the first time.

**You do:**
- **Run and approve the D13 supervision spike first.** How the TypeScript control plane supervises the Pi process is the recorded open engineering question; its outcome (and the SQLite driver choice) gets an E-record.
- Watch the slice demo live: login, chat, kill the server mid-stream, reconnect, verify replay. This demo is the gate (P4).
- Approve the E-records for spike outcomes.

**Agents do:**
- Spike runner (fresh session per variant): supervision spike with a measurable harness; report latencies, failure modes, code that survives contact with reality.
- Planner: slice breakdown (auth/cap → container provisioning → chat send/receive → persistence → streaming/reconnect/replay), each loop-sized.
- Implementer: one loop per slice, fake Pi provider from day one, real SQLite WAL file, migrations from Stage 3 contracts.
- QA runner: reconnect/replay probes (kill -9, refresh mid-stream, double-send, empty message, oversized message).

**Gate:** Demo performed by you personally; deterministic E2E test (fake provider) covers login→chat→stream→refresh→replay; unit+contract+integration suites green in CI; E-records written for spike outcomes; recovery probe results archived.

**Prompt set:**

```text
ROLE: Spike runner. Time-boxed experiment; you may create code ONLY under spikes/d13/.
CONTEXT: D13 requires a supervision spike for the TypeScript↔Pi process boundary; the
node:sqlite choice is subject to this spike (confirmed-decisions.md). PRD runtime sections.
TASK: Build two minimal variants — (A) Pi as child process with IPC, (B) Pi behind a local
HTTP sidecar — each demonstrating: start, warm session reuse, stream token forwarding,
crash detection, restart, backpressure on slow consumers. Measure: time-to-first-token,
restart latency, message loss on kill -9, and what code the caller must write.
CONSTRAINTS: Use the fake Pi stub, no real model calls, no network. Both variants share
the same minimal contract so results are comparable. Delete nothing; spikes are evidence.
ACCEPTANCE: A results table (metric × variant), a recommendation with reasoning, and the
recommendation for node:sqlite vs alternatives for WAL-mode product state.
STOP & REPORT: How to run both variants, raw measurements, failure modes observed,
what you could not test.
```

```text
ROLE: Planner.
CONTEXT: Approved Phase 0 artifacts; spike results for D13/SQLite; PRD Phase 1 scope:
login/cap → one container → one General Assistant chat → SQLite → streaming/reconnect/
replay, fake provider. Stack decisions recorded.
TASK: Split Phase 1 into 5–7 standing-loop slices with exact acceptance checks each,
including the recovery probe list (refresh mid-stream, server kill, duplicate send,
reconnect replay ordering). Identify which slices are security-sensitive (auth, session,
provisioning) and mark them for the Security reviewer.
CONSTRAINTS: Every slice ends in a runnable demo. No slice touches live providers. Keep
the runtime gateway as the sole writer of SQLite (control plane talks to it via contract).
ACCEPTANCE: Slice list I can approve; each slice ≤2 days.
STOP & REPORT: Plan + assumptions.
```

```text
ROLE: Implementer. Slice: {name} from the approved Phase 1 plan.
CONTEXT: The slice spec; guardrails G1–G8; fake Pi provider seam; migrations exist.
TASK: Red tests first (show me failing), then implement to green. Run pnpm lint,
typecheck, test, and the slice's E2E check.
CONSTRAINTS: Only files in the slice spec. Secrets only via env/config references —
never literal. No fake completion fallback: if the fake provider is unconfigured, surface
a configuration error. Agents (product-level) never write SQLite directly — gateway only.
ACCEPTANCE: Suite green; E2E check demonstrates the slice behavior; diff confined to spec.
STOP & REPORT: Full evidence pack per §5 step 4.
```

---

### Stage 5 — Phases 2–6 build-out (the long middle)

**Goal:** Deliver the recorded phases as a sequence of standing loops. Same loop every time — the variety is in the slices, not the process.

| Recorded phase | Slice theme | Extra gate |
|---|---|---|
| **2 — Multi-Agent runtime** | Durable Agent identity, on-demand warm Pi sessions, supervised task workers; full six-Agent/three-Operation capability mapping from Stage 2's decision | Capability mapping decision referenced in every contract change |
| **3 — Workspace & artifacts** | Artifacts, leases, isolated Git worktrees; lease checks on resume | Lease tests include steal/expire/renew |
| **4 — Safety & execution** | Real tool execution, grants (scoped/expiring/revocable), retries (max 3 transient), cancellation (whole process tree), credit reservation/settlement | **Security reviewer on every slice.** No real side effects without the approval path; approval UI from mockup gets a real backend |
| **5 — Defaults & settings** | Onboarding, provider configuration UI (real provider config → still fake execution until you opt in), simulated tiers, Balanced default | Provider keys encrypted at rest; redaction test |
| **6 — Recovery & durability** | Semantic checkpoints, pause-on-uncertain-external-effects, six-hour snapshot backups, administrator restore, restart-survival | **Restore drill performed, not just written** |

**You do:**
- Keep one slice active. When review debt exceeds two unreviewed diffs, stop starting; finish reviewing.
- Personally test each phase's user-visible behavior (P4) and every recovery claim (P9 — recovery is destructive-adjacent).
- Keep the Stage 2 deferred decisions from silently reappearing as implementation choices.

**Agents do:** the standing loop. QA runner gains a growing regression journey file (every fixed bug becomes a scripted check). Archivist keeps `docs/TRACEABILITY.md` acceptance statuses honest — a criterion moves to "implemented" only with evidence links.

**Gate (per phase):** phase demo by you; suites green in CI; phase-specific extra gate above; traceability updated.

**Prompt set (the only new prompt you need — the loop prompts carry over):**

```text
ROLE: Planner.
CONTEXT: docs/PRD.md phase {N} scope; the recorded slice order; TRACEABILITY acceptance
criteria relevant to this phase; lessons in mockup/HANDOFF.md (UX blockers to avoid
repeating); open decisions list from Stage 2.
TASK: Break phase {N} into standing-loop slices as before, but additionally: for each
slice name which existing test files must keep passing (regression budget) and which
 acceptance criterion number it advances.
CONSTRAINTS: Same as prior planning prompts. Any slice that would resolve a deferred
decision by implementation must instead be split: implement the recorded answer or stop.
ACCEPTANCE: Approvable slice list with criterion mapping.
STOP & REPORT: Plan; decisions you found unrecorded.
```

---

### Stage 6 — Prototype acceptance audit (the 27 criteria)

**Goal:** All 27 PRD acceptance criteria verified with evidence — this is the recorded release gate, and "screenshot completion" explicitly does not count. Output: an acceptance ledger mapping every criterion → implementation → automated evidence → manual evidence → status.

**You do:**
- Personally run the full user journey on the built app: login → Operation chat → artifact → approval → recovery after refresh → settings → provider config failure path (must show configuration failure, not fake success — G4).
- Accept or reject each criterion. Your name goes on the ledger.

**Agents do:**
- Implementer (test slices): close the security test list from the Stage 3 threat model (traversal/symlink, secret leakage, escapes, escalation, leases, cross-user) as real tests.
- QA runner: full deterministic mock-runtime E2E pass + exploratory pass on the five target browsers (Chrome/Edge/Firefox/Safari), responsive + keyboard flows.
- Archivist: build the acceptance ledger; every "implemented" status cites evidence.

**Gate:** Ledger shows all 27 criteria accepted by you; CI green; security list fully covered; browser matrix pass recorded in `mockup/reviews/` or a new evidence dir. **Prototype is accepted — now stop and decide production readiness (Stage 7) before exposing anyone else.**

**Prompt set:**

```text
ROLE: Archivist. Build the acceptance ledger.
CONTEXT: docs/PRD.md §19 (criteria 1–27); docs/TRACEABILITY.md current statuses;
evidence dirs (test outputs, reviews, probe results).
TASK: Create docs/ACCEPTANCE_LEDGER.md: one row per criterion — criterion, implementing
slice/commits, automated evidence (exact test names + where outputs live), manual evidence
(who ran what, when, result), status (accepted/rejected/open), and gaps.
CONSTRAINTS: Status "accepted" only where BOTH automated and manual evidence exist.
Mockup-only evidence never satisfies a runtime criterion. Do not upgrade any status
yourself — propose it and wait for my verdict.
ACCEPTANCE: Complete 27-row ledger with honest gaps; I will annotate verdicts.
STOP & REPORT: The ledger draft plus the shortest list of what's missing for full
acceptance.
```

```text
ROLE: Security reviewer + QA runner. Execute the security test list.
CONTEXT: docs/THREAT_MODEL.md security test list (from Stage 3); PRD isolation and
approval rules.
TASK: Implement each listed test as automated where possible (malicious payload files,
symlink attacks, oversized/streamed floods, grant expiry, cross-user probes with the
second test account, prompt-injection fixtures attempting tool calls without grants).
Manual-only items: document the exact procedure and expected result.
CONSTRAINTS: All hostile inputs stay inside the test container/files. No real provider
calls. Tests must FAIL if the control is removed — verify each by temporarily disabling
the control and showing the test go red, then restore.
ACCEPTANCE: Full list covered; each test shown red-without-control and green-with.
STOP & REPORT: Test inventory with red/green evidence per control.
```

---

### Stage 7 — Production-readiness gate (a decision, not code)

**Goal:** A recorded decision that says, explicitly, what "production" means for this system now that the prototype is accepted: hardening, operations, data guarantees, and what remains deferred. Skipping this stage is how solo prototypes become liabilities.

**You do:** Decide, with the agent's gap analysis in front of you, at least: operational ownership (who gets paged — you), SLO/RPO/RTO, backup/restore schedule sign-off, monitoring/alerting minimum, capacity (one VM: what load is in/out of scope), privacy posture (what user data leaves the VM; export/purge), and the deferral list you accept. Record as decision(s) per repo rules.

**Agents do:**
- Scout: gap analysis prototype → production across the axes above, plus PRD deferred-work list.
- Release engineer: produce the runbooks the decision will require (deploy, rollback, restore, key rotation) as drafts.
- Security reviewer: re-run the threat model against the *real* configuration (real providers now exist; the marketing site may be public).

**Gate:** Production-readiness decision recorded with evidence and traceability; runbooks exist in draft; deferred list signed.

**Prompt set:**

```text
ROLE: Scout. Read-only.
CONTEXT: Accepted prototype (docs/ACCEPTANCE_LEDGER.md); PRD deferred-work section;
THREAT_MODEL.md; current infra = one Ubuntu 24.04 VM, Docker Compose, six-hour volume
snapshots (latest 7), administrator restore.
TASK: Gap analysis prototype → production across: security hardening (container, host,
transport), data guarantees (RPO/RTO from the recorded backup scheme; SQLite-consistent
backup procedure — currently an open item), observability (logs/metrics/alerts minimum for
one operator), capacity & load limits, privacy (data residency, export/purge), key
management (rotation, compromise response), and the marketing/waitlist surface. For each
gap: minimal viable answer for a ≤5-account system, cost in effort, and what breaks if
skipped.
CONSTRAINTS: Do not propose enterprise machinery (HA clusters, SOC2 tooling) — right-size
to one VM and five users. Distinguish "must decide now" from "defensible to defer".
ACCEPTANCE: Gap table + recommended decision package I can approve.
STOP & REPORT: Sources in repo used for each row.
```

---

### Stage 8 — Ship: private prototype launch (≤5 accounts, one VM)

**Goal:** Reproducible build, reviewed migrations, staged exposure, tested rollback and restore, working monitoring — then real users (starting with you).

**You do:**
- Walk the deploy runbook yourself once in a scratch environment (P4/P9). The Release engineer's runbook that you haven't executed is fiction.
- Approve migrations line-by-line (P9). Restore drill: restore last night's snapshot into a scratch VM and use the app — witnessed by you.
- Decide exposure order: you first, then accounts 2–5, with a check-in after each.

**Agents do:**
- Release engineer: versioned build script (pinned deps, reproducible images), Compose for the VM, deploy + rollback runbooks, smoke tests, monitoring/alerts (uptime, error rate, disk, container restarts, credit anomalies), backup snapshot verification.
- Implementer: fix what your dry-run surfaces.
- Archivist: release notes; mark the waitlist honest (wire real persistence or change the copy — currently it lies; that's a pre-ship blocker for any public surface).

**Gate:** Smoke tests pass post-deploy; rollback drill executed; restore drill executed; monitoring shows green for 24h with you as sole user; secrets audit confirms no keys in images, logs, backups (G3).

**Prompt set:**

```text
ROLE: Release engineer.
CONTEXT: PRD deployment section (Ubuntu 24.04 VM, Docker Compose); accepted prototype;
stack decisions; SRE practice: reproducible builds, staged exposure, prepared rollback.
TASK: Produce: (1) reproducible build (pinned lockfile, versioned images, build identity
= git SHA); (2) production Compose + env template with ALL secrets external — no literals;
(3) deploy runbook (pre-flight checks, migrate, health checks, smoke tests); (4) rollback
runbook (previous image + DB migration strategy stated explicitly — forward-only or
compensating, your pick must be tested either way); (5) smoke test script run after any
deploy (login, send message, artifact, approval, refresh-replay); (6) monitoring minimum:
uptime, error rate, disk, memory, container restarts, backup job success, alert routing
to me.
CONSTRAINTS: Right-size: one VM, five users. No Kubernetes. Secrets never in Compose
files, images, logs, or docs. Migrations reviewed by me before inclusion.
ACCEPTANCE: I execute the runbook in a scratch environment and it works end to end.
STOP & REPORT: Files + runbooks; explicit list of steps requiring human judgment.
```

```text
ROLE: Implementer. Slice: restore drill + backup verification.
CONTEXT: Recorded backup scheme (six-hour snapshots, keep 7, administrator restore);
Stage 7 decision on SQLite-consistent backups.
TASK: Script the restore drill: take snapshot → restore into scratch → run migrations if
required → integrity check → automated smoke subset. Run it once now and archive the
output. Add a scheduled check that a snapshot restore actually works (at minimum, an
integrity check on the live snapshot with alerting on failure).
CONSTRAINTS: Restore testing happens only against scratch copies. Provider keys excluded
from backups unless explicitly encrypted and authorized (recorded rule).
ACCEPTANCE: Drill output archived; alert path demonstrated once with a deliberately
corrupted test snapshot.
STOP & REPORT: Drill log; what an operator must do manually after a real restore.
```

---

### Stage 9 — Operate & learn (steady state)

**Goal:** The system stays healthy while the loop continues: every incident makes the suite stronger; your process gets measured honestly.

**You do:**
- Weekly (15 min): review metrics, open incidents, escaped defects, and slice cycle time. Run `/retro` or the retro prompt.
- On any incident: reproducer first, then fix, then regression test — the incident becomes a permanent test (S9's practice).

**Agents do:**
- QA runner: expand the regression journey with each incident.
- Archivist: monthly traceability honesty check (statuses vs. reality); update this workflow file when the process itself changes.

**Prompt set:**

```text
ROLE: Implementer. Incident {id}: {symptom}.
CONTEXT: Monitoring/log excerpts below; relevant traces; PRD acceptance criteria affected.
TASK: Reproducer first (red test), then diagnose, then minimal fix to green. If the root
cause is a design/contract issue, stop at diagnosis and report — I decide whether to
change the design.
CONSTRAINTS: No fix before the reproducer exists. Match the surrounding code's style.
ACCEPTANCE: Red reproducer shown; green after fix; full suite green; the reproducer is
kept as a regression test.
STOP & REPORT: Evidence pack; one-paragraph root cause; prevention note for the ledger.
```

```text
ROLE: Archivist. Monthly process retro.
CONTEXT: This workflow file; slice logs (dates, cycle time, rework count); incident log;
escaped defects.
TASK: Report: median slice cycle time, rework rate, escaped defects, incidents → tests
converted, and where verification was thinnest. Compare against the guardrails (§2):
which did I actually keep? Propose at most 3 concrete workflow changes with reasoning.
CONSTRAINTS: No vanity metrics (lines of code, commit counts, agent activity). Distinguish
"felt fast" from measured (METR: practitioners mis-estimate).
ACCEPTANCE: I approve ≤3 changes; you apply them to this file in place.
STOP & REPORT: The report.
```

---

## 7. Ship-day checklist (condensed)

- [ ] All 27 acceptance criteria: accepted in `docs/ACCEPTANCE_LEDGER.md` with evidence
- [ ] Security test list: every control shown red-without / green-with
- [ ] Production-readiness decision recorded (Stage 7)
- [ ] Migrations reviewed by you, line-by-line
- [ ] Deploy runbook executed by you in scratch first
- [ ] Rollback drill executed; forward-only vs compensating migration strategy tested
- [ ] Restore drill executed on a real snapshot
- [ ] Secrets audit: nothing in images/logs/backups/docs (G3)
- [ ] Smoke tests green post-deploy; monitoring green 24h
- [ ] Waitlist/marketing claims honest before any public exposure
- [ ] Exposure staged: you → accounts 2–5, check-in each
- [ ] Acceptance statuses in `docs/TRACEABILITY.md` updated with evidence links

---

## 8. Measuring honestly

Track per slice (a line in a log file is enough): date, slice, cycle time, rework loops, review findings count, escaped defects later found. Track per month (Stage 9 retro): the same, aggregated, plus incident→test conversion rate. Do **not** track lines of code, commit counts, or agent activity — the research consistently shows perceived productivity diverges from measured productivity (S6: developers expected −24%, believed −20%, measured **+19% slower**; S7: intervals still span zero). If a number ever justifies loosening a guardrail, re-read §2 first.

---

## 9. Sources (what this workflow is built on, and how strong each source is)

| # | Source | Date | Access | Key supported claim used here |
|---|---|---|---|---|
| S1 | Anthropic — *Best practices for Claude Code* (code.claude.com/docs/en/best-practices) | undated, living doc | full text | Give agents a way to verify their work; explore → plan → implement for big changes; reset drifting context |
| S2 | Anthropic — *Building effective agents* | 2024-12-19 | full text | Simplest adequate pattern; workflows vs agents; environmental feedback, stopping conditions, human checkpoints |
| S3 | Anthropic — *Demystifying evals for AI agents* | 2026-01-09 | full text | Judge the artifact, not the narrative; executable correctness + regression coverage; don't trust self-report |
| S4 | Simon Willison — *Red/green TDD* (agentic engineering patterns) | undated | full text | Watch the test fail first; a test that never failed proves nothing |
| S5 | Simon Willison — *Agentic manual testing* | undated | full text | Run generated code; agent-led exploratory testing plus personally viewing features before release |
| S6 | METR — *Early-2025 AI on experienced OS developer productivity* | 2025-07-10 | study write-up | RCT, 16 devs/246 tasks: 19% slower with AI vs expected −24%/believed −20%; narrow scope, historical |
| S7 | METR — *Changing our developer productivity experiment design* | 2026-02-24 | full text | Follow-up (57 devs/800+ tasks): −18% returning devs, CI −38% to +9% — includes no effect; very weak evidence of magnitude |
| S8 | DORA / Google Cloud — *2025 DORA Report announcement* | 2025-09-24 | official announcement | ~5,000 respondents: AI adoption ↑ throughput, **↓ delivery stability**; testing/version-control/fast feedback matter more |
| S9 | Simon Willison — *Fireside chat with Cat Wu & Thariq Shihipar (Claude Code team)* | 2026-07-21 | edited transcript (video exists; **not watched**) | Human code-owner approval for sensitive changes; automated review earned through validation; incidents → regression evals |
| S10 | OWASP — *GenAI LLM Top 10* (LLM01 Prompt Injection, LLM04 Resource Exhaustion/DoS, LLM06 Sensitive Disclosure, LLM08 Excessive Agency) | 2026 release referenced | project page + archived list | Structural controls, not prompts: approval gates, scoped grants, redaction, resource limits |
| S11 | Google SRE book — *Release Engineering* (ch. 8, McNutt) | book chapter | full text | Reproducible builds, automated pipelines, test the release candidate, staged rollout, prepared rollback — right-sized here to one VM |

**Honest limits:** S1/S2/S3/S9 are vendor guidance — operational wisdom, not controlled studies. S6/S7 are the only randomized evidence and they are narrow and inconclusive on magnitude; they justify *measurement*, not pessimism or optimism. S8 is organizational correlation. No source validates this workflow end-to-end; the workflow's defense is its gates, not its provenance.

---

## Appendix: decision log for this workflow

| Date | Record | What changed |
|---|---|---|
| 2026-09-13 | Created `docs/DEV_WORKFLOW.md` | Process baseline: stages 0–9, standing loop, guardrails G1–G8 |
| 2026-09-17 | D46–D50, E9–E14 recorded (`docs/decisions/open-items-decisions-2026-09-17.md`) | Stage 1 gate closed (D46, D50); Stage 2 dispositions executed under owner delegation; PRD SYNC-2; Stage 3 deferred by the owner (plan stays draft); mockup Exam Prep fixture aligned to D46 (HANDOFF §21). No new engineering choices made — the Stage-3 E-records (CI provider, pins) remain pending. |
| 2026-09-18 | E15 recorded (`docs/decisions/oss-leverage-decisions-2026-09-18.md`); BUILD_MAP §8 added; "Open-source leverage" sections appended to issues #1–#36 (append script archived at `artifacts/oss-issue-sections.sh`) | Open-source leverage policy under the owner's 2026-09-18 instructions: embed (MIT/Apache-2.0/BSD/ISC, enforced by the S01 license gate) / pattern-only (AGPL/GPL and out-of-stack platforms) / never-adopt (agent frameworks as runtime, whole platforms); read-docs-first anti-creativity rule; per-slice adoption map. No product changes; no Stage-3 confirmations resolved. |
| 2026-09-19 | Owner delegation (parallel worktree agents + delegated merge gate); first exercised on PR #37 | Parallel Implementer agents authorized for provably independent slices (one worktree/branch/PR each); G8 merge sentence delegated to the orchestrator's fresh-context review + local verification, with CI absence explained on the PR (Actions billing block discovered 2026-09-19); every merge documented via PR comment; sensitive artifacts keep owner P9 scrutiny. S01 landed via PR #37 (merge commit `b684592`) after resolving the E15/E16 identifier collision (S01's record renumbered E16) and a duplicate-build collision (remote PR adopted, local duplicate discarded). Wave 2 (S02 + S04) dispatched on worktrees. |
| | *(append future process changes here; product changes go to `docs/decisions/`, not here)* | |
