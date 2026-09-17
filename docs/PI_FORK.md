# Pi fork — source, licensing, and upstream-sync reference

**Updated:** 2026-09-17 · **Audience:** maintainers of Shera Bot and its Pi adapter.
**Status:** source and license evidence for S01; proposed maintenance procedure under [E15](decisions/engineering-record-e15-2026-09-17.md#fork-evidence-update-2026-09-17). The fork is not installed, integrated, or approved as a runtime dependency by this document. D13's supervision spike remains provisional.

The owner supplied **"https://github.com/ihmorol/shera-pi.git pi forked."** in this session. This resolves the missing repository identity behind S01's license-documentation gap. It does not approve a merge, choose subagent semantics, or confirm the remaining Delegated decisions.

## 1. Verified source snapshot

| Item | Verified value |
|---|---|
| Fork | [ihmorol/shera-pi](https://github.com/ihmorol/shera-pi), public; default branch `main` |
| Parent and source repository | [earendil-works/pi](https://github.com/earendil-works/pi) |
| Inspected commit | `1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b` |
| Root license | MIT; Copyright (c) 2025 Mario Zechner |
| License Git blob | `b0a8e9b81083294360c69b4ec45d3d39a2b28197` |
| License size | 1069 bytes |
| License SHA-256 | `0457f5bcec3b3b211605dfb5d1a49042fd638f3686a410fe099c24a25af13c48` |

The inspected commit resolves in both repositories with the same source tree. At the initial check, their `main` branches also compared as identical (0 ahead, 0 behind). These are observations at that time, not a promise that the branches remain synchronized.

**This SHA identifies the evidence, not an adopted runtime pin.** A later integration slice must choose and record the exact revision it actually builds and tests. No manifest, lockfile, submodule, or adapter was changed to consume Pi here.

The [root package manifest at this commit][root-package] declares an npm workspace (`pi-monorepo`, ESM, Node `>=22.19.0`) with its own `package-lock.json`. Shera Bot's Node pin satisfies that declared minimum; this does not establish build or runtime compatibility, and does not authorize migrating the fork to pnpm.

## 2. Protocol boundary: JSONL RPC is not `packages/protocol`

The [coding-agent RPC documentation][rpc-doc] describes `--mode rpc`, newline-delimited JSON over stdin/stdout, and optional request IDs. Its implementation is under [`packages/coding-agent/src/modes/rpc/`][rpc-code]. This is the relevant upstream interface to investigate for Shera's child-process adapter; no Pi process or provider call was run during this documentation work.

In contrast, [`packages/protocol/README.md`][routed-protocol] describes an experimental routed protocol, version 8, with four-byte length-prefixed **CBOR** messages. It excludes server/worker lifecycle and makes no compatibility guarantees. It is not the JSONL protocol selected in D14.

Shera's [D13–D14 records](decisions/confirmed-decisions.md#d13--typescript-runtime-gateway-pi-behind-a-versioned-child-process-adapter) still require its own versioned, validated adapter boundary: correlation IDs, lifecycle events, heartbeat handling, redacted diagnostics, crash detection, and process-tree cancellation. Upstream RPC does not by itself prove those requirements. `packages/pi-protocol` is Shera's package, not an alias or automatic import of upstream `packages/protocol`.

The runtime gateway remains authoritative for approvals, durable state, event sequencing, leases, supervision, and recovery. Finding an upstream tool or approval feature does not authorize it to bypass that boundary. S03's deterministic fake-Pi spike remains distinct from real-fork integration and live-provider verification.

## 3. License and modification obligations

The root [upstream license][upstream-license] and [fork license][fork-license] at the inspected commit match the complete, unmodified local copy: [`pi-fork/LICENSE`](pi-fork/LICENSE). Its notice condition is:

> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

MIT permits use, modification, distribution, sublicensing, and sale subject to that condition. It does not require publishing modifications. Preserve the copyright, permission notice, and warranty/liability disclaimer when copying or packaging the covered code, including in container images or other distributions containing it. Keep attribution honest under PRD §23; do not replace upstream authorship with Shera branding.

### Third-party code remains separately licensed

The root MIT license is not a blanket license for everything bundled with Pi. Source inspection already found:

- [`highlight.min.js`][highlight-vendor] identifies Highlight.js 11.9.0 and **BSD-3-Clause**. Its banner contains an incomplete copyright attribution (`undefined and other contributors`); verify the complete applicable notice before packaging this file, rather than inventing a copyright holder.
- [`marked.min.js`][marked-vendor] identifies marked 18.0.5 and MIT notices for MarkedJS (2018–2026) and Christopher Jeffrey (2011–2018).
- The [coding-agent package manifest][coding-package] includes asset-copy scripts for these vendored JavaScript files. Package-manager metadata alone is therefore not a complete distribution inventory.

Preserve applicable file-level notices and review all included dependencies and assets before distributing the fork. These examples are evidence of additional review obligations, not a complete license audit.

**Current inventory limit:** [`scripts/license-inventory.ts`](../scripts/license-inventory.ts) runs `pnpm licenses list --json` in the **Shera Bot workspace**. It does not traverse a separate fork checkout, its npm lockfile, vendored files, or a future container image. Rerunning it here does not audit Pi. The integration slice must inventory the actual fork dependency/build inputs and bundled notices separately, then include that evidence in the release inventory. This coverage is not implemented yet.

### Public-fork boundary

The fork is public; this product repository is private. Inspect every proposed fork diff for credentials, private configuration, prompts, transcripts, and other unpublished product material before any publication. A fork-specific patch may be proposed when needed, but this document does not authorize publishing it or changing the fork's default branch. Secrets must never be published, and other private material requires the owner's explicit publication decision.

## 4. Proposed upstream-sync procedure

**Owner:** Emon / the explicitly authorized fork maintainer. **Status:** Delegated engineering procedure, pending owner review; not executed in this session. A sync is maintenance of a separate repository, not permission to merge or publish automatically.

1. **Start from a separate, clean fork checkout.** Read its current contributor instructions, inspect `git status`, `git remote -v`, and the branch. Verify `origin` points to the fork and `upstream` to `https://github.com/earendil-works/pi.git`; configure a missing remote only within the authorized maintenance task. Never reset away someone else's changes.
2. **Fetch and select an immutable candidate.** Fetch upstream, record the current fork base SHA and candidate SHA, and inspect their complete commit/file diff. Review release notes, RPC changes, manifests, lockfiles, install/build scripts, root and package-level licenses, and vendored notices. A changed license hash requires reading the change; it is not automatically a product decision. Changes in obligations require owner review, and changes to product scope or safety follow PRD §24.
3. **Integrate on a topic branch, not directly on `main`.** Merge the selected SHA into that branch without rewriting shared history. Preserve fork-specific changes and resolve conflicts explicitly. Keep the existing approved integration revision unchanged if validation fails.
4. **Validate in an isolated development environment before publication.** Review scripts before installing dependencies. The inspected upstream contributor guidance calls for `npm run check` and `./test.sh`; `check` includes formatter writes, so review its resulting diff. The [test wrapper][test-wrapper] clears ambient environment variables and isolates home/temp/cache state, including `PI_NO_LOCAL_LLM=1`. It is not a network or filesystem sandbox: tests can pack/install fixture packages and launch subprocesses. Do not substitute a bare `npm test` in a credential-bearing shell, or assume all tests are side-effect-free. Live-provider tests remain opt-in and never part of Shera's default CI (E8/G7).
5. **Verify Shera's boundary as well as upstream tests.** Once adapter tests exist, run the deterministic protocol, malformed-message, crash, backpressure, cancellation, and recovery checks against the candidate. Record precisely which checks used fake Pi, real Pi without a provider, or an explicitly authorized live provider. Source inspection or fake-Pi success alone is not real-fork compatibility evidence.
6. **Prepare review before pushing or merging.** Include the base/candidate SHAs, fork patches, license/dependency changes, commands/results, and unverified items in the evidence pack. Obtain the required owner approval for publication to the public fork and for default-branch merges. Do not force-push, auto-merge, or enable automatic synchronization as part of this procedure.
7. **Record the approved result and update consumers deliberately.** After an authorized merge, append a sync entry with the actual resulting fork SHA, reason, modifications, notices, and test evidence. When Shera starts consuming the fork, pin that approved revision in the real build inputs through a separate reviewed integration change. Preserve earlier snapshot entries; do not replace them with a floating `main` reference.

Sync when an identified fix/capability is needed or before a relevant phase gate. No recurring automation or sync cadence was configured here.

## 5. Snapshot and modification ledger

| Date | Revision | Observation / action |
|---|---|---|
| 2026-09-17 | `1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b` | Owner identified the fork. Fork and upstream share this commit/tree; no project-specific difference at the inspected revision. Read-only source/license inspection; no checkout, installation, fork edit, sync, or integration performed. |

## 6. Evidence and acceptance boundary

**Requirement covered:** the existing S01 requirement to document the real fork license, modification obligations, and upstream-sync process. **Owner:** Emon; **implementation boundary:** these documents and the verbatim license copy; **verification target:** immutable source comparison, notice/hash checks, and documentation review; **evidence:** [E15's fork update](decisions/engineering-record-e15-2026-09-17.md#fork-evidence-update-2026-09-17) and [the verification ledger](pi-fork/verification-2026-09-17.md).

The S01 documentation is supplied for owner review. The broader PRD §22.1 dependency-license work remains open for the actual fork build/distribution. No runtime acceptance criterion is promoted and D13 is not validated by these documents.

Read-only reproduction commands, from the Shera Bot repository root:

```bash
gh api repos/ihmorol/shera-pi --jq '{fork, parent: .parent.full_name, source: .source.full_name, visibility, default_branch}'
gh api repos/ihmorol/shera-pi/commits/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b --jq '{sha, tree: .commit.tree.sha}'
gh api 'repos/ihmorol/shera-pi/contents/LICENSE?ref=1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b' --jq '{sha, size}'
gh api 'repos/earendil-works/pi/contents/LICENSE?ref=1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b' --jq '{sha, size}'
git hash-object docs/pi-fork/LICENSE
```

Expected license result: 1069 bytes and Git blob `b0a8e9b81083294360c69b4ec45d3d39a2b28197` for both remote files and the local copy. The verification ledger preserves the initial draft's incorrect protocol/pinning claims and their corrections rather than treating them as validated architecture.

**Not verified:** full fork dependency/license closure, the incomplete vendor attribution, actual distribution contents, upstream builds/tests, adapter compatibility, or live-provider behavior. Before real integration (S07, or an earlier explicitly scoped real-fork experiment), the implementer must supply the dependency/notice evidence and integration results; S35 must verify notices in the actual distributed artifacts.

[root-package]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/package.json
[fork-license]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/LICENSE
[upstream-license]: https://github.com/earendil-works/pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/LICENSE
[rpc-doc]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/coding-agent/docs/rpc.md#L1-L37
[rpc-code]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/coding-agent/src/modes/rpc/rpc-mode.ts
[routed-protocol]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/protocol/README.md#L3-L41
[highlight-vendor]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/coding-agent/src/core/export-html/vendor/highlight.min.js#L1-L5
[marked-vendor]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/coding-agent/src/core/export-html/vendor/marked.min.js#L1-L6
[coding-package]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/packages/coding-agent/package.json
[test-wrapper]: https://github.com/ihmorol/shera-pi/blob/1283afd0d0685d1ffe88aa56a725c0e4ad3cfc7b/test.sh#L4-L79
