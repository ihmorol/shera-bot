# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Next.js (App Router) + React + TypeScript + Tailwind CSS for the product client (`apps/web`, greenfield UI-first build with mock data). Confirmed by the owner on 2026-09-11; it matches the existing `business-landing-portfolio/` stack, the `next/font/google` typography plan in `docs/UI_DESIGN.md`, and the planned Zod-typed mock fixtures (`packages/contracts`).

## Users

- **Primary user (confirmed for design decisions): students** — working on research papers, programming assignments, and exam preparation, using a team of AI Agents in one connected workspace.
- Future expansion audiences (PRD §3.1 priority order, not the prototype's design center): researchers, then individual developers.

## Product Purpose

Shera Bot is an independent, general-purpose AI assistant platform: a team of specialized AI Agents organized in versioned customer Packs (canonical hierarchy **Pack → Operations → Agents**), with persistent user workspaces, tool use, autonomous tasks, multi-agent collaboration, provider/model choice, and transparent execution through a Telegram-like web interface. The private prototype (≤5 users, one VM) validates the end-to-end experience and runtime architecture to produce evidence for deciding whether to build the larger platform. Success for the prototype is validated acceptance criteria (PRD §19), not scale.

## Positioning

Versioned Packs of persistent-identity Agents working in supervised, transparent Operations: agents propose and the runtime validates and executes every action; risky work pauses for explicit, scoped user approval; user data lives local-first in isolated containers. A neighboring generic chat product could not truthfully claim pack-defined multi-agent Operations with preview-gated launches, immutable runtime-owned grants, and honest event streams (live vs replayed vs delayed).

## Operating Context

- Authoritative specs in this repo: `docs/PRD.md` (synchronized baseline, D1–D50/E1–E14), `docs/UI_DESIGN.md` (implementation-ready UI spec), `docs/GLOSSARY.md`, `docs/TRACEABILITY.md`, `docs/decisions/`. Where any design doc could contradict the PRD or decision records, the PRD and records win.
- Canonical vocabulary is binding: **Agent** (never "Expert"), **Operation** (never "Scene" or "group chat"), **Pack**, **task run**. Hierarchy: Pack → Operations → Agents.
- `business-landing-portfolio/` is the implemented marketing surface and the source of the approved brand; it intentionally simplifies the product model for visitors and is out of scope for prototype acceptance criteria.
- Access: Google OAuth is the only login; signup capped at five accounts (server-enforced); tiers (Light/Balanced/Heavy) are simulated; no real payments.
- One workspace per user; no workspace or pack switcher in the UI (D40, D19). Pinned pack: student v1.

## Capabilities and Constraints

- **Six pack-defined Agents** (General Assistant, Researcher, Developer, Citation Manager, Programming Tutor, Study Planner) and **three pack-defined Operations** (Research Paper, Programming Assignment, Exam Preparation); ad-hoc Operations with same-pack rosters also exist. Each Agent is rostered in exactly one Operation; cross-Operation work runs through subagent triggering (D46).
- One persistent Agent identity everywhere: one profile, one direct chat, one private memory, one settings surface (D39).
- Operation launch is preview-gated: nothing executes before the user confirms the preview (D30, AC23).
- Agents propose; the runtime validates and executes (D4, D23). The UI never renders an agent action as done before runtime validation.
- Dynamic approvals: five fixed, verbatim choices from PRD §8; grants are runtime objects, never prompt-created (D9, D35).
- Credits use a reservation model with post-execution settlement (D20, D21); custom-provider Agents use no Shera credits.
- Event honesty: live, replayed, delayed, and disconnected events are visually distinct (D26); tasks survive browser closure (AC25).
- Workspace panel per chat: files, editor, read-only terminal and browser live views, task runs, tool history, private Agent files; write-lease conflict prevention (D6).
- Providers: built-in OpenAI/Anthropic/Google, Ollama/local, OpenAI-compatible, and custom providers; keys masked, revoke/replace only (D17, D22).
- Memory with provenance and a private → shared publication boundary (D37); secrets are always rejected, never stored.
- UI constraints: dark-only theme in v1; responsive from ~360px; full keyboard reachability and visible focus; no secrets rendered anywhere; errors show redacted `safe_message` only.
- Build approach: UI-first with Zod-typed mock fixtures and a scripted mock runtime (UI_DESIGN.md §9) so acceptance-criterion shapes are evaluable before any backend exists.
- Deliberately undecided/open: final logo art and avatar illustration style (owner's reference material + sketch, 2026-09-11); exact subagent semantics (D46 open sub-item); admin console deferred (E7); Stage-3 plan confirmations (dark-only v1, CI provider, tool pins) pending plan approval.

## Brand Commitments

- Name: **Shera Bot**. No Grok/xAI trademarks, assets, or architecture.
- Dark cinematic visual identity carried from the approved landing site: `#050a14` canvas, electric-cobalt brand (`#3b82f6`), sky accents, glass surfaces, restrained glow used for emphasis only. Tokens in `docs/UI_DESIGN.md` §2.1.
- Typography: Space Grotesk (display), DM Sans (body), JetBrains Mono (eyebrows/code/meta) via `next/font/google`.
- Voice: benefit-led, concrete, honest about the product's state; landing voice established in `business-landing-portfolio/`.

## Evidence on Hand

- `docs/PRD.md` — approved prototype specification (D1–D50, E1–E14).
- `docs/decisions/` — decision records with evidence, alternatives, and supersession map.
- `docs/UI_DESIGN.md` — screen-by-screen UI spec with component inventory and mock-data requirements.
- `docs/TRACEABILITY.md` — acceptance-criterion coverage and open items.
- `business-landing-portfolio/` — implemented, runnable landing page (Next.js 15, React 19, Tailwind) with the approved dark brand; frontend-only waitlist (no persistence).
- No real testimonials, customer logos, benchmarks, or usage data exist; future work must not fabricate any. The waitlist has no live submissions to cite.

## Product Principles

1. **Agents propose; the runtime decides.** No surface ever fakes completion, merges replayed events into live ones, or pretends a grant exists.
2. **Supervised autonomy.** Risky work pauses for explicit approval; every grant is visible, scoped, and revocable.
3. **Transparent execution.** Tool calls, runs, retries, recovery, and credits are inspectable in honest detail, in D8 vocabulary.
4. **Persistent identity.** One Agent, one identity, one memory, everywhere it appears.
5. **Local-first trust.** User data lives in isolated containers; secrets never render, memory never stores them.

## Accessibility & Inclusion

PRD §18 / AC20 baseline: current Chrome/Edge/Firefox/Safari; ~360px mobile through large desktop; keyboard-accessible core flows with documented tab order; visible focus ring on every interactive element; screen-reader labels and sender attribution; `aria-live` regions for streaming (polite) and tool/approval events (assertive); color never the only signal; `prefers-reduced-motion` respected everywhere.
