# E15 — S01 monorepo scaffold, CI gate, toolchain pins, and license inventory

Part of the decision records. Index and provenance: [`README.md`](README.md). Previous records: [`confirmed-decisions.md`](confirmed-decisions.md) (D1–D39), [`closure-decisions.md`](closure-decisions.md) (D40–D45, E1–E8), [`open-items-decisions-2026-09-17.md`](open-items-decisions-2026-09-17.md) (D46–D50, E9–E14).

**Status:** Delegated engineering record — decided by the agent while executing slice **S01** (issue #2) under the owner's 2026-09-17 instruction to start building; owner review pending.
**Date:** 2026-09-17.
**Evidence:**
- Issue #2 (S01) — acceptance criteria, layout, and the E-record requirement; `docs/BUILD_MAP.md` §5–§6 (S01 unblocked; the plan confirmations "S01 records them as Delegated pending review").
- [`phase0-plan-draft-2026-09-13.md`](phase0-plan-draft-2026-09-13.md) §1 and §8 — the layout and the four confirmations this slice had to resolve.
- Owner instruction 2026-09-17 (this session): **"Lets start building"**, followed by **"keep going"** after the S01-blocking questions were put to the owner with recommendations and left unanswered. The agent therefore proceeded on the recorded defaults and marked every unresolved item Delegated rather than treating it as confirmed.
- Local toolchain measurement before pinning: `node -v` → `v24.19.0`, `pnpm -v` → `12.4.1`, `git --version` → `2.40.0.windows.1`, `docker` → not installed.
- `pnpm licenses list --json` output for the resolved dependency tree (221 packages, 10 distinct licenses) and the negative gate run recorded below.

## Decision

1. **Plan-approval conflict (G5).** Two repository documents disagreed: `phase0-plan-draft-2026-09-13.md` ("nothing scaffolded… the owner approves this slice list before any scaffolding starts") versus `docs/BUILD_MAP.md` §6 and issue #2 ("can start immediately"; the §8 confirmations are recorded as Delegated pending owner review). Scaffolding proceeded under the newer tracker-side authority (BUILD_MAP §6 / issue #2), on the owner's explicit instruction to start building. **The plan draft's approval gate is treated as satisfied for S01 only.** The remaining confirmations stay open items, recorded below as Delegated.
2. **CI provider: GitHub Actions.** The repository already lives on GitHub with the slice tracker in its issues; workflows run on `ubuntu-latest` only (private-repository Actions minutes are metered, and the production target is Ubuntu 24.04). `concurrency.cancel-in-progress` avoids paying twice for superseded pushes.
3. **Toolchain pins, declared in one place.** Node **24.19.0** (`.nvmrc`, the line CI installs from) with `engines: ">=24.0.0 <25.0.0"`; pnpm **12.4.1** via `packageManager` plus `engines.pnpm`, with `.npmrc` `save-exact=true` and `engine-strict=true`. Both were measured on the development machine before pinning, not assumed.
4. **TypeScript 5.9.3, not 7.0.2.** The registry's `latest` is 7.0.2, but `typescript-eslint@8.70` (current) peer-caps TypeScript at `<6.1.0`. Pinning TypeScript 7 would either break the lint gate or require disabling typed linting in the slice whose entire purpose is a trustworthy pipeline. TypeScript 5.9.3 is the newest version the lint toolchain supports; the upgrade is deferred to a later slice, when typescript-eslint supports it.
5. **Workspace layout: the ten members named by issue #2**, exactly: `apps/web`, `apps/control-plane`, `apps/user-runtime`, `packages/contracts`, `packages/clients`, `packages/agent-pack-sdk`, `packages/pi-protocol`, `packages/provider-contracts`, `packages/observability`, `packages/test-kit`, plus `agent-packs/`, `infra/`, and `tests/{contract,integration,e2e,recovery,security,benchmark}`.
6. **Placeholders, honestly labelled.** Nine of the ten members ship as documented placeholders that compile, typecheck, and carry no product behavior; `packages/contracts` additionally exports one marker so the pipeline smoke test proves the workspace graph resolves. `apps/control-plane` exports a typed factory returning an *empty* Express app — no routes, no listener — which exercises the dependency without starting any behavior (G4: nothing pretends to work).
7. **Test runner: Vitest, run once from the repository root** (`vitest.config.ts`), not per package. Test files live in the tier directories named by E8. Turborepo orchestrates `typecheck` and `build` only; lint and format run once at the root. This keeps the pipeline small enough to trust.
8. **License policy as data + a gate that fails closed.** `scripts/license-policy.json` holds an `allowed` list (permissive licenses plus MPL-2.0, which carries an explicit linking permission) and `reviewedExceptions`. `scripts/license-inventory.mjs` evaluates each license expression (`A OR B` passes when either side passes; `A AND B` requires both), writes `artifacts/license-inventory.json`, and exits non-zero on anything unreviewed. **One reviewed exception is in force: `LGPL-3.0-or-later` for `@img/sharp-*`, the prebuilt native binary behind Next.js image optimization** — unmodified, loaded at runtime, and not distributed because the prototype is private; the distribution obligations must be re-checked at the Stage 7 production gate. The exception is flagged for owner review.
9. **The Pi-fork license criterion in issue #2 is NOT met, and is not faked.** No Pi fork exists in the owner's GitHub account, nothing matching it exists under `E:/PROJECTS`, and no repository document names the upstream project or its license. Writing "the Pi fork's real license text" is impossible today, and inventing text would violate G3/G5 and PRD §22.1. The criterion is recorded as an **open item with an evidence target** (see TRACEABILITY) instead of being silently dropped. S03's supervision spike is unaffected: it is specified against the fake Pi stub with no network access.

## Rationale

The slice exists to make the pipeline trustworthy before anything is built on it: pins that cannot drift, a lint/type/test/build gate that runs the same way locally and in CI, and a license gate that fails closed rather than reporting. Every choice above optimizes for that one property — including the deliberate refusal to invent the Pi fork's license and the choice of a TypeScript version the lint toolchain actually supports.

## Alternatives considered (preserved)

- **CI:** GitLab CI or a self-hosted runner — rejected: the code, issues, and slice tracker are already on GitHub; a second system adds an account, a token, and a failure mode for a one-person project. **Recorded as Delegated, pending owner review.**
- **Toolchain pins:** pin only the major line (Node 24, pnpm 12) — rejected: patch-level drift is exactly what makes "green locally, red in CI" possible. Exact pins plus `engine-strict` fail loudly instead.
- **TypeScript 7.0.2:** rejected for S01 (see decision 4). Alternative of TypeScript 7 with untyped ESLint linting was rejected: it would lower the gate to keep a version number current.
- **Per-package test scripts with Turborepo caching:** rejected for S01 — more configuration surface and more ways to be green for the wrong reason; revisit if CI time becomes the bottleneck.
- **Failing the license gate on LGPL today:** rejected in favour of a recorded, reviewable exception with an explicit re-check point; blocking S01 on an owner decision that has not been requested would stop the build for a private, undistributed prototype.
- **Committing nothing until the plan draft was formally approved:** rejected because the newer tracker-side document (BUILD_MAP §6, issue #2) authorizes immediate start and the owner instructed exactly that; the conflict itself is recorded rather than resolved silently (G5).
- **Pi fork:** creating a placeholder license document — rejected outright (see decision 9).

## Affected PRD sections

§17 (stack — realized here as code), §22.1 and §22.22 (Pi fork license and dependency license inventory; the first is now an explicit open item, the second is implemented), §23 (compliance posture). No PRD text changes were made or needed.

## Implementation implications

- `pnpm install && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build` is the single gate, identical locally and in CI.
- `pnpm license:inventory` fails the build on an unreviewed license; the inventory artifact is retrievable from the CI run even when the gate fails.
- S02 fills `packages/contracts`; S10 fills `packages/agent-pack-sdk` and `agent-packs/`; S07 fills `apps/user-runtime` and `packages/pi-protocol`; S23 fills `packages/provider-contracts`. The placeholders name their filling slice in-file.
- The `.gitattributes` `eol=lf` rule prevents Windows/Linux line-ending drift; the mockup suite runs as a CI job so the S01 regression budget cannot be broken silently.
- `docs/decisions/README.md`'s record-count line (E1–E14) was **not** updated: the slice's acceptance criteria forbid touching `docs/decisions/*` other than this new record. Updating the index is a follow-up for the next documentation slice.

## Verification coverage

Run on the S01 branch (evidence in the pull request):

- `pnpm test` — 3 contract-tier tests pass, including the workspace-graph and un-publishable-manifest checks; before the scaffold the same command failed with `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` (red→green, P3).
- `pnpm lint` — clean (initial run failed on `.agents/skills/impeccable/scripts/`, third-party tooling now ignored).
- `pnpm format:check` — clean.
- `pnpm typecheck` — 10/10 workspace members.
- `pnpm build` — Next.js 16.3.5 production build succeeds; `next-env.d.ts` verified byte-stable across builds.
- `pnpm license:inventory` — passes with the recorded exception; **negative test**: with the exception removed the gate exits 1 and names `@img/sharp-win32-x64@0.35.4 — Apache-2.0 AND LGPL-3.0-or-later`, and the inventory artifact is still written.
- `node --test mockup/dock-layout.test.cjs` — 27 passing (S01 regression budget).
- **Not verified in this slice:** CI execution itself (first run is the pull request), Linux behaviour of platform-specific optional binaries (`@img/sharp-linux-x64` carries the same license expression), and anything requiring Docker — not installed on the development machine.

## Open items this record leaves standing

1. **Pi fork license, modifications' obligations, and upstream-sync process** — blocked until the upstream project is identified; owner input required. Tracked in [`../TRACEABILITY.md`](../TRACEABILITY.md).
2. **Owner review of the Delegated choices:** CI provider, toolchain pins, dark-only `apps/web` v1, the license-policy exception for `LGPL-3.0-or-later`, and the plan-approval conflict resolution in decision 1.
3. **Exact subagent semantics** (D46 sub-item) — unchanged, still due before the Agent/Operation contracts freeze in S02.
