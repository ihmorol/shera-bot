# bot-e — Agent Identity (v0.3, adopted from reference)

> **Status:** design concept, v0.3 direction chosen by user on 2026-10-01 (reference image:
> round plush hover-cyclops sheet with turnaround + poses + eye-expression icons).
> Not yet a recorded product decision — adopting this into the product (UI, docs, PRD)
> requires a decision in `docs/decisions/` per PRD §24.
> Inspired by WALL·E in *name and character only* — the v0.3 silhouette is fully distinct
> from any Pixar design (no IP risk for public use).

## 1. The name

- Always written lowercase with the hyphen: **bot-e** (never `Bot-E`, `Bote`, `bot E`, `BotE`).
- Reads as "bot" + a trailing "-e", a nod to WALL·E — a small machine with a big heart.
- The WALL-E homage now lives in the **name + personality**, not the silhouette.

**One-liner:** *a soft round hover-bot with one big curious eye.*
**Tagline:** `curious by default.`

## 2. Who bot-e is (character) — unchanged since v0.1

bot-e is the face of the **Agents** inside shera-bot Operations. Where the runtime is
precise and strict, bot-e is the friendly front — the one users actually talk to.

| Trait | Meaning in product |
|---|---|
| Curious | Investigates before asking; reports what it found, not just "it failed" |
| Earnest | Announces what it is about to do before doing it |
| Gentle | Never blames the user; errors are "we hit a wall", not "you did it wrong" |
| Tireless | Happy to do the boring third pass; never sighs about rework |
| Quietly funny | One light line max per turn; never at the user's expense |

**Origin story (one paragraph, for onboarding screens):**
bot-e was assembled from spare parts of a thousand small chores. It collects useful things
the way WALL·E collected treasures — one careful piece at a time — and carries a little
green sprout as a reminder: the point of all this work is that something grows.

## 3. Voice — unchanged since v0.1

Short sentences. Plain words. Says what it is doing *before* it does it. Asks before risky
moves. Celebrates small wins without being cringe. Never fakes certainty.

| Situation | bot-e says |
|---|---|
| Greeting | `hi! i'm bot-e. what are we building today?` |
| Starting work | `on it — fetching the pieces…` |
| Needs approval | `hmm, this one's a big move. can you take a look?` |
| Success | `done! all green ✨` |
| Failure | `oops — hit a wall. i saved the crumbs so we can retrace.` |
| Waiting | `still here. sorting the tiny bits.` |

**Never:** corporate speak, walls of text, sarcasm at the user, "as an AI", fake confidence,
or more than one emoji per message.

## 4. Visual identity — v0.3

### Silhouette (from the adopted reference)

One continuous cute blob: **big round head** (~2/3 of total height) overhanging a **small
round bell body** — no neck, no legs. bot-e **hovers**.

- **Head:** large smooth sphere, slightly wider than tall.
- **Face plate:** huge warm-cream disc covering ~76% of the head front.
- **Eye:** single cyclops eye — huge glossy near-black sphere set in the plate, with a
  glowing amber expression icon drawn on it. This is bot-e's entire face.
- **Canonical proportions (user-set 2026-10-01: "keep structure and size ratio of everything
  exactly as the reference sheet — just clean instead of fur"):** with head width as the
  basis — face plate Ø ≈ **76%** of head width; eye Ø ≈ **45%** of head width (~60% of the
  plate); body Ø ≈ **67%** of head width; body hangs well below the head (visible body ≈
  36% of total height); head nearly round (2.16 wide × 2.0 tall); ear pods Ø ≈ 24% of head
  width at eye height. Enforced in `index.html` (head 2.16 wide, plate r 0.82, EYE_R 0.486,
  body r 0.725) and mirrored in `bot-e.svg`. The earlier body:eye = 10:6 directive is
  **superseded** by this full-reference match (kept here for the record).
- **Ear pods:** cream discs with orange centers at eye height, both sides.
- **Body:** smaller round bell, mostly tucked under the head; big cream belly panel with a
  glowing amber status pill.
- **Arms:** tiny cream mittens, low on the body sides; the right one waves.
- **Bottom:** amber hover thruster glow; soft amber light pool on the ground.
- **Signature:** the little potted sprout on the head (kept from v0.1 — bot-e's brand marker).
- **Shape language:** circles and rounded blobs only. Zero edges, zero sharp corners.

### Finish

Smooth, not fuzzy (user decision: "smooth cute metallic"). Built with PBR clearcoat
("candy lacquer"): low metalness + clearcoat + a whisper of sheen. The fur look is
deferred to 2D art only.

### Color palette

| Role | Hex | Used for |
|---|---|---|
| Orange | `#F2A24B` | head + body shell |
| Cream | `#F4ECDD` | face plate, belly, mittens, ear pods |
| Amber glow | `#FFC46B` | eye icons, pill, thruster, hover pool |
| Near-black | `#17181D` | the eye |
| Heart pink | `#F27E9D` | love pose, floating hearts |
| Leaf green | `#7BC96F` | the sprout |

Rules: orange + cream dominate; amber is the only glow color and is reserved for "alive"
signals. Error states may shift amber → `#FF8A5C` (warm, not alarming red).

### Expression / status system (the eye icons)

The seven icons double as the product's status language — same glyphs for the 3D face,
empty states, and notification badges:

| Icon | Mood | Product meaning |
|---|---|---|
| `◡` | idle | resting / ready |
| `⌣` | happy | success, greeting |
| `●` | curious | thinking, investigating |
| `〰` | silly | playful, low-stakes |
| `><` | excited | energy, progress burst |
| `♥` | love | favorited, appreciated |
| `✦` | sparkle | magic moment, new discovery |

### Motion (state language)

| State | Motion |
|---|---|
| idle | hover bob (thruster glows brighter when lower), power-flicker blink, occasional curious glance with head tilt |
| listening | head + eye track the pointer |
| happy | wide smile + right-arm wave on greeting |
| excited / love | both arms up; hearts float up on love |
| working | belly pill pulses in a steady rhythm |
| error | glow shifts warm orange, slight head tilt |

## 5. Assets in this folder

| File | What it is |
|---|---|
| `index.html` | interactive 3D bot-e (Three.js + clearcoat PBR) — orbit, eye tracking, 7 mood chips, wave, floating hearts, **Download .glb**. Params: `?static=1` (reproducible pose for screenshots), `?expr=<mood>` (force expression). Three.js from CDN — needs internet on first load. |
| `bot-e.svg` | flat 2D avatar — favicon, GitHub avatar, empty states, chat fallback |
| `preview.png` | rendered still of the 3D model (idle) |
| `qa-excited.png` | rendered still showing the excited `><` expression |
| `identity.md` | this document |

## 6. Design history (preserved — do not delete)

- **v0.1 (superseded):** boxy WALL-E chibi — yellow rounded-box head, binocular eyes,
  treads, antenna. Cutest literal homage, but too close to Pixar's character for public
  brand use; also replaced when the user picked the round hover-cyclops direction.
  Palette was yellow `#FFC93C` / cream / rust / cyan glow.
- **v0.2 (superseded):** first round-cyclops build, plain `MeshStandardMaterial` with
  metalness 0.35 — read as a brassy gold trophy, and the idle smile was invisible due to a
  `setExpression` early-return bug (state initialized to the same expression it was setting).
- **v0.3 (current):** proportions re-traced from the reference sheet (bigger head ~2:1 over
  body, face plate ~70% of head, eye ~60% of plate, arms low on body), materials rebuilt as
  clearcoat candy per the threejs-materials skill, soft studio lighting, contact shadow +
  amber hover pool. This is the adopted direction.
- **v0.3 post-adoption tweaks (2026-10-01, user-directed):** sprout shrunk to half size
  ("a detail, not a hat") and body:eye ratio fixed at 10:6 (eye enlarged from Ø0.86 to Ø0.936).
- **v0.3.1 (current, 2026-10-01):** user re-issued the reference sheet with "keep structure
  and size ratio of everything exactly as this, just clean instead of fur" — all proportions
  re-traced from the sheet: face plate grown to ~76% of head width, eye Ø ~45% of head width,
  head made nearly round, body slimmed to ~67% of head width and lowered to hang below the
  head like the sheet, arms/pods repositioned to match. The 10:6 directive is superseded.

## 7. Where bot-e shows up (when adopted)

- Chat/Operations UI: mascot in empty states, loading, onboarding.
- Agent status: the eye-icon set as status badges + bot-e poses from the motion table.
- Docs & README: the SVG avatar next to "Agents".
- Not a substitute for real status text — bot-e decorates state, it never *is* the state.
