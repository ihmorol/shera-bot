# Pi fork verification and correction ledger — 2026-09-17

**Scope:** evidence for the S01 fork-license documentation in [`../PI_FORK.md`](../PI_FORK.md), governed by [E15's follow-up](../decisions/engineering-record-e15-2026-09-17.md#fork-evidence-update-2026-09-17). Source inspection is not runtime validation or owner acceptance.

## Owner evidence

The owner supplied **"https://github.com/ihmorol/shera-pi.git pi forked."**, then instructed **"continue"**. This identifies the repository; it does not choose a production revision, approve publication, or approve a merge. E15's pre-fork blocked state and its alternatives are preserved in that record.

## Read-only source checks

The source-verification reviewer used authenticated `gh` reads of commit-addressed files, not a checkout, installation, or test run. No source from the private product repository was sent to the public fork.

| Check | Result / evidence |
|---|---|
| `gh api repos/ihmorol/shera-pi` | Public fork; default `main`; `parent.full_name` and `source.full_name` are `earendil-works/pi`. Repository metadata is an observation, not an immutable commit property. |
| `gh api repos/ihmorol/shera-pi/commits/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b` and corresponding upstream commit | Both resolve to tree `dc795f892dc830c560573030092881cf6586ce87`. |
| Fork and upstream `contents/LICENSE?ref=1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b` | MIT; Copyright (c) 2025 Mario Zechner; 1069 bytes; Git blob `b0a8e9b81083294360c69b4ec45d3d39a2b28197`. |
| Independently decoded license bytes and local `git hash-object docs/pi-fork/LICENSE` | Same blob; SHA-256 `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48`. The local file is byte-identical, including its original ending. |
| Initial `compare/main...ihmorol:main` check | `identical`, 0 ahead, 0 behind at that check. No claim about later branch changes or all fork history. |
| Root `package.json` at the source SHA | Private ESM npm workspace, `pi-monorepo` 0.0.3, Node `>=22.19.0`; includes nested session-backend and extension-example workspaces in addition to `packages/*`. |
| Coding-agent RPC docs and implementation | `--mode rpc` uses bidirectional JSONL with optional request IDs. `--mode json` is event-stream output, not the same command transport; `--no-session` is not a tool/network sandbox. |
| Upstream `packages/protocol/README.md` | Experimental routed protocol version 8, length-prefixed CBOR; lifecycle is outside the protocol and compatibility is not guaranteed. |
| Coding-agent vendored export HTML assets | Highlight.js 11.9.0 BSD-3-Clause and marked 18.0.5 MIT notices; manifest scripts copy these vendor files into outputs. The Highlight.js banner literally contains `(c) 2006-2023 undefined and other contributors`, so full attribution needs verification before packaging. |
| Root contributor/test scripts | `npm run check` includes `biome check --write`; `./test.sh` clears ambient credentials, isolates HOME/temp/cache, and sets `PI_NO_LOCAL_LLM=1`. It is not a sandbox: consumer tests pack/install fixture packages and launch subprocesses. |

Immutable source URLs are linked in [`../PI_FORK.md`](../PI_FORK.md). Additional checks used:

- [CONTRIBUTING.md:56–71](https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/CONTRIBUTING.md#L56-L71) — upstream pre-PR checks.
- [README.md:53–75](https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/README.md#L53-L75) — network-refreshing build versus `build:offline`; `pi-test.sh` launches Pi rather than running the suite.
- [coding-agent RPC integration tests:14–51](https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/coding-agent/test/rpc.test.ts#L14-L51) — credential-activated provider tests.
- [AI stream tests:1617–1649](https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/ai/test/stream.test.ts#L1617-L1649) — direct tests can pull an Ollama model and start its server.
- [consumer test helpers:11–61](https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/scripts/coding-agent-consumer.test.mjs#L11-L61) — temporary fixture package/install subprocesses.

## Draft corrections and rejected approaches

The first local `PI_FORK.md` draft was written before the full source review. Its incorrect assumptions are preserved here; none are adopted product decisions.

| Initial claim or approach | Finding and correction |
|---|---|
| "Each claim below was verified" | Overstated: source metadata did not prove runtime adoption, protocol identity, release ancestry, test behavior, or complete license coverage. The reference now states verification limits per topic. |
| "Pinned revision" and "the revision the adapter is written against" | No Pi adapter or dependency consumes that SHA. It is a verified source snapshot only; selection of actual integration inputs remains later work. |
| `packages/protocol` is home of the JSONL adapter protocol | Source says CBOR. Correct JSONL RPC reference is `packages/coding-agent/docs/rpc.md`; Shera's versioned gateway contract remains independent. |
| Nearest release tag `v0.85.1`, with the inspected commit "after" it | A tag SHA/package version is not ancestry or nearest-tag proof. Omitted from the normative reference; relation not verified. Stars/fork counts were also omitted because they do not establish compliance or compatibility. |
| Root MIT plus existing workspace inventory covers the fork | Root license does not replace dependency or vendored-file notices. Shera's inventory script only scans this workspace; explicit separate fork/build evidence is needed. |
| "No product code ... may ever be committed" to the fork | Broader than G3 and the recorded product-maintained-fork model. Replaced with no-secret controls and explicit owner approval before publishing any private material or fork patch. |
| Merge and push the fork's `main` before running tests | Unsafe ordering and no publication approval. The proposed process uses a topic branch, license/protocol review and isolated validation first, then explicit owner approval. No sync was executed. |
| A changed license blob automatically requires a product decision | A hash change prompts a content/obligations review; a formatting/year change is not inherently a product change. PRD §24 applies when product scope or safety changes. |
| Run the fork's "own test suite" without further qualification | Bare tests can pick up credentials, download local models, or spawn subprocesses. The credential-isolating wrapper is documented, including its remaining effects and opt-in live-provider boundary. |

## Required historical evidence consulted

The mandatory archive is absent from the working tree. Read via Git at `cea3ba1:docs/history/2026-09-08-to-2026-09-11/`:

- `README.md`, `source-manifest.md`, and the full `findings-obstacles-references.md` ledger.
- `codex-transcript.md:1088–1165`: full Q13 boundary, the owner's **"lets try it for now."**, and the provisional supervision-spike acknowledgement.
- `codex-transcript.md:1170–1241`: full Q14 alternatives, gateway-owned versioned JSONL shape and required behavior, the owner's cost preference, and recorded transport choice.
- `codex-transcript.md:2693–2770`: full Q25 Zod-first proposal, strict internal-message/versioning rules, and explicit **"yes"** acknowledgement.

Current PRD, glossary, traceability, decision indexes, D13/D14/D23/D25, and E8 were also read. One delegated archive-reading attempt failed with a provider rate limit; no conclusions were taken from that failed task. The listed source evidence was then read directly.

## Local validation and independent review

Executed after the fork-reference corrections, using the existing installed Shera Bot workspace:

| Command / check | Result |
|---|---|
| `pnpm test` | Exit 0; 15 tests across 2 files. |
| `pnpm mockup:test` | Exit 0; 27 tests. |
| `pnpm lint` | Exit 0. |
| `pnpm format:check` | Exit 0 for the configured code scope; `docs/` is excluded, so this is not a Markdown-review claim. |
| `pnpm typecheck` | Exit 0; 10 workspace tasks reused valid Turborepo cache entries, then the root TypeScript check ran. |
| `pnpm build` | Exit 0; Next.js build reused its valid Turborepo cache entry. No clean rebuild or fresh installation was performed in this documentation-only follow-up. |
| `pnpm license:inventory` | Exit 0; 222 packages, 10 distinct licenses on Windows, 0 failures; existing scoped sharp exception applied. This is the Shera workspace only, not the fork. |
| Local document-link/anchor checks | 57 links/anchors resolved; license size and both hashes matched; every historical E15 line remained present. |
| `git diff --check` | Initial check caught a trailing blank line in the appended E15 section; corrected before final verification. |
| Independent documentation review | PASS, no factual/authority blockers. One extra Markdown delimiter in E15's evidence heading was fixed. No runtime or license-audit acceptance was implied by the review. |

A first attempt to launch the final documentation reviewer failed with a provider rate limit and produced no review verdict. A fresh read-only reviewer then completed the pass above. Neither failure was treated as successful verification.

## Validation boundary

The source-verification pass was read-only. Full fork installation, dependency audit, builds, tests, container packaging, supervisor behavior, and live providers were **not run**. S01's last pushed CI result remains evidence for that commit only; local documentation validation does not produce a new GitHub check or approve a merge.
