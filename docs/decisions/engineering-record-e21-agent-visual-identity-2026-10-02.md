# E21 — Agent visual identity: authored hue wins, and how a 3D avatar derives its form

- **ID:** E21
- **Status:** Delegated engineering (pending owner review)
- **Date:** 2026-10-02
- **Filed with:** the Agent 3D identity profiles change (branch `feat/agent-3d-profiles`)
- **Evidence source:** review of PR #51 with a fresh-context adversarial pass plus a verification pass; `apps/web/test/agent-identity.test.ts`; `agent-packs/student/v1/manifest.json`; `packages/agent-pack-sdk/src/mockup-divergence.test.ts`
- **Supersedes:** nothing. **Refines:** D18 (UI identity metadata) and D39 (stable per-Agent identity) at the implementation level. **Product impact:** presentation only — no capability, authorization, or acceptance change.

## The defect this records

The pack manifest already authored a visual identity per Agent, and a test pinned it:

```json
"ui_identity": { "avatar_hue": 217, "initial_glyph": "G" }
```

`packages/agent-pack-sdk/src/mockup-divergence.test.ts` asserts those six hues against the mockup. The web avatar nevertheless hashed `agent_id` into one of six fixed `color-mix` values and ignored the authored data entirely. The identity was declared, pinned by a test, and silently discarded at render time.

It could not have worked even if the component had wanted it: `packages/contracts/src/agent.ts` had no `ui_identity` field, so the value could not survive pack loading into the contracts path.

## Decisions

### 1. Authored identity wins over any derived value

`ui_identity` is optional on the contracts `Agent`. When present it is authoritative; when absent the client derives a hue deterministically from `agent_id`, preserving D39's "one Agent, one appearance" for packs written before identity authoring.

### 2. `ui_identity` is presentation-only and can never grant capability (D38)

`UiIdentity` carries exactly two validated fields: `avatar_hue` (integer, 0-360) and `initial_glyph` (exactly one code point). No skill, tool, connector, or permission. A test asserts the `tools` / `skills` / `connectors` sets are **unchanged** by the presence of identity.

### 3. Hue boundary: `360 ≡ 0`

The contract permits `360`; the renderer normalizes it to `0`. They are the same color, so two Agents authoring 0 and 360 render identically. HSL semantics, now stated in code rather than left implicit.

### 4. Silhouette variants must be distinct across the whole roster, not merely varied

A deterministic facet count varies each Agent's silhouette alongside its hue, because §2.1 requires color never be the only signal.

**Correction recorded:** the first implementation used 4 buckets, and the six shipped Agent ids collapsed into only **3 distinct silhouettes** — so half the roster was distinguishable by hue alone. The test that should have caught this asserted merely `size > 1` and passed anyway. Fixed by widening to `SHAPE_VARIANT_COUNT = 8` and asserting `new Set(variants).size === ids.length` for every Agent in the shipped manifest, so widening the pack cannot silently reintroduce the collapse.

### 5. Glyph fallback is code-point based

Both fallback paths use `[...text][0]`, matching the contract's "one code point" rule. `charAt(0)` splits an astral character into a lone surrogate and renders U+FFFD. A whitespace-only `display_name` yields `"?"` rather than an empty avatar — `charAt` returns `""` (not nullish), so a `??` chain cannot catch that input.

### 6. Non-finite authored hues are rejected before reaching CSS

A `NaN` hue would emit `--agent-hue:NaN`; because custom properties are substituted at computed-value time, every color consumer derived from it fails to parse and falls back to a transparent shell — an invisible avatar rather than a safe one. Unreachable from parsed JSON, reachable from any programmatic caller of the exported function.

<!-- continued: alternatives, verification, not-verified, owner item -->
## Alternatives considered

- **three.js / React Three Fiber (WebGL)** — rejected. E15 permits only MIT/Apache/BSD/ISC deps fitting PRD §17, and a WebGL renderer is heavy for a 24-40px avatar with real failure modes (no-JS, reduced-motion, GPU-less hosts). Preserved as an option: the component owns only hue and facet count, so a GLB renderer can replace the CSS without changing the data contract or any test.
- **Pre-rendered static images per Agent** — rejected: one binary artifact per Agent per size per theme, with no way to honor reduced-motion or restyle from tokens.
- **Requiring `ui_identity` (non-optional)** — rejected as a breaking contract change for packs already written; optional plus a derived fallback is backward compatible.
- **Keeping 4 silhouette buckets** — rejected; see the correction above.

## Verification

| Gate | Result |
|---|---|
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| `pnpm typecheck` | 10/10 |
| `apps/web` suites | 19 files / 189 tests pass, incl. `design-tokens` and `a11y` |
| `pnpm gen:clients` | re-run; `packages/clients/openapi.json` regenerated (+36 lines) |

`agent-identity.test.ts` reads the **shipped manifest from disk** rather than retyped fixture values, and asserts each Agent's emitted hue and glyph equal what the pack authored — so the headline claim is tested at its source. It also asserts: the authored hue verbatim (not merely equal across two ids), an in-range stable fallback hue, non-finite hue rejection, distinct silhouettes for every manifest Agent, byte-identical markup across repeated renders, decorative `aria-hidden`, presence paired with a text label, and no raw color in the markup or the style object.

## Explicitly NOT verified

- **Rendered appearance.** No browser or Playwright on this host (CI Actions is billing-dead), so blend-mode and transform interactions are reasoned from spec, not observed. The 3D form's correctness in the *compiled* CSS bundle was verified by inspection; its painted pixels were not.
- **Glyph contrast.** Computed from the gradient geometry at roughly 6.7:1 worst case (hue 32) against a ≥4.5:1 requirement, but not measured with a contrast tool on a real render.
- **Known divergence:** two `UiIdentity` schemas now exist — contracts (`optional`) and `packages/agent-pack-sdk/src/manifest.ts` (`required`) — with identical shape and no cross-validation. Surfaced rather than hidden; unifying them is future work.
- No acceptance criterion in [`../TRACEABILITY.md`](../TRACEABILITY.md) is upgraded by this record.

## Owner item

`docs/UI_DESIGN.md` §21 item 4 resolves the avatar art direction as "**avatar art open**" and lists "avatar illustration style" among the items deliberately left for the owner's reference and sketch. This record ships a concrete illustration style (a shaded shell with a facet-count sheen). That is a reversible implementation choice, but per **G8** it is surfaced as an owner-approval item rather than merged silently, since the owner's sketch is expected to replace it.