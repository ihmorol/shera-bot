/**
 * Agent visual identity (D18 `ui_identity` + the 3D avatar renderer).
 *
 * Three properties are pinned here, each of which the avatar gets wrong in a
 * way that is invisible in a screenshot but very visible in use:
 *
 *  1. **Pack data is authoritative.** The pack manifest already authors a hue and
 *     glyph per Agent, and `mockup-divergence.test.ts` pins those values. The
 *     avatar previously hashed `agent_id` and ignored them entirely, so the
 *     authored identity was silently discarded. Appearance must come from
 *     `ui_identity` when present.
 *  2. **Stable per Agent (D39).** The same Agent must render identically in the
 *     sidebar, the chat header, and the streaming bubble. Appearance may never
 *     depend on render order, call site, or how many times it was rendered.
 *  3. **Distinct where it matters.** Six Agents in one sidebar must be told
 *     apart by more than hue alone — hence a deterministic shape variant too.
 *
 * `ui_identity` is presentation data only (D38): the tests here also assert that
 * identity is optional, so a pack without it still renders.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Agent, Pack } from "@shera-bot/contracts";

import { AgentAvatar, avatarStyleFor, shapeVariantFor } from "../components/chat/agent-avatar";

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

/** Minimal valid Agent; overrides are merged over the required fields. */
function agent(overrides: Record<string, unknown> = {}) {
  return Agent.parse({
    agent_id: "agent_test",
    display_name: "Test Agent",
    role_description: "A test Agent used by the identity tests.",
    default_provider: { provider_id: "provider_platform", model: "platform-default" },
    skills: [],
    tools: [],
    connectors: [],
    home_operation_id: null,
    ...overrides,
  });
}

describe("D18 authored identity is authoritative", () => {
  it("uses the pack's authored hue, not a hash of the id", () => {
    const a = agent({ ui_identity: { avatar_hue: 217, initial_glyph: "G" } });
    // A different Agent id with the SAME authored hue must render identically:
    // proof the hue comes from the data rather than from the id.
    const b = agent({
      agent_id: "agent_completely_different",
      ui_identity: { avatar_hue: 217, initial_glyph: "G" },
    });
    expect(avatarStyleFor(a)["--agent-hue"]).toBe(avatarStyleFor(b)["--agent-hue"]);
  });

  it("keeps authored hues distinguishable across the six student Agents", () => {
    const hues = [217, 192, 32, 262, 161, 333].map(
      (avatar_hue) =>
        avatarStyleFor(agent({ ui_identity: { avatar_hue, initial_glyph: "A" } }))["--agent-hue"],
    );
    expect(new Set(hues).size).toBe(hues.length);
  });

  it("falls back to a stable derived hue when a pack authors no identity", () => {
    const a = agent({ agent_id: "agent_legacy" });
    const b = agent({ agent_id: "agent_legacy" });
    // Optional by design (D18): the Agent still validates and still has ONE
    // stable appearance, satisfying D39.
    expect(avatarStyleFor(a)["--agent-hue"]).toBe(avatarStyleFor(b)["--agent-hue"]);
    expect(avatarStyleFor(a)["--agent-hue"]).toMatch(/^\d+$/);
  });

  it("renders the authored glyph, and a name-derived glyph as fallback", () => {
    const authored = render(
      createElement(AgentAvatar, {
        agent: agent({
          display_name: "Researcher",
          ui_identity: { avatar_hue: 192, initial_glyph: "R" },
        }),
      }),
    );
    expect(authored).toContain(">R<");

    // No authored glyph: derive from the display name so it is never blank.
    const derived = render(
      createElement(AgentAvatar, { agent: agent({ display_name: "Study Planner" }) }),
    );
    expect(derived).toMatch(/>S</);
  });
});

describe("D39 identity is stable per Agent across render sites", () => {
  it("produces the same style regardless of how many times it is rendered", () => {
    const a = agent({
      agent_id: "agent_stable",
      ui_identity: { avatar_hue: 262, initial_glyph: "D" },
    });
    const first = avatarStyleFor(a);
    expect(avatarStyleFor(a)).toEqual(first);
    expect(avatarStyleFor(a)).toEqual(first);
  });

  it("gives different Agents different shape variants, deterministically", () => {
    const ids = [
      "agent_general_assistant",
      "agent_researcher",
      "agent_developer",
      "agent_study_planner",
    ];
    const variants = ids.map((agent_id) => shapeVariantFor(agent_id));
    expect(new Set(variants).size).toBeGreaterThan(1);
    // Deterministic across calls.
    for (const id of ids) {
      expect(shapeVariantFor(id)).toBe(shapeVariantFor(id));
    }
  });
});

describe("3D avatar accessibility (§2.3)", () => {
  const a = agent({
    display_name: "Developer",
    ui_identity: { avatar_hue: 262, initial_glyph: "D" },
  });

  it("is decorative: hidden from assistive tech, with the name carried elsewhere", () => {
    // The avatar repeats information the adjacent label already carries, so it
    // must not be announced twice.
    expect(render(createElement(AgentAvatar, { agent: a }))).toContain('aria-hidden="true"');
  });

  it("never signals state by color alone — presence pairs with a text label", () => {
    const hibernating = render(createElement(AgentAvatar, { agent: a, presence: "hibernating" }));
    const active = render(createElement(AgentAvatar, { agent: a, presence: "active" }));
    // An active session must be announced, not merely colored.
    expect(active).toContain("Session active");
    expect(active).not.toBe(hibernating);
  });

  it("carries the hue in a CSS custom property, never a raw color literal", () => {
    // design-tokens.test.ts forbids raw colors in components; the hue must reach
    // CSS as a number so globals.css owns every actual color value.
    const html = render(createElement(AgentAvatar, { agent: a }));
    expect(html).toContain("--agent-hue:");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\brgba?\(/);
    expect(html).not.toMatch(/\bhsl[a]?\(/);
  });

  it("exposes no raw color in the style object either", () => {
    for (const value of Object.values(avatarStyleFor(a))) {
      expect(String(value)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });
});

describe("ui_identity is presentation-only and optional (D18, D38)", () => {
  it("is optional on the Agent contract", () => {
    expect(() => agent({ ui_identity: undefined })).not.toThrow();
  });

  it("carries no skill, tool, connector, or permission field", () => {
    const authored = agent({ ui_identity: { avatar_hue: 217, initial_glyph: "G" } });
    // Identity must not smuggle capability: the tool set is unchanged by it.
    const plain = agent();
    expect(authored.tools).toEqual(plain.tools);
    expect(authored.skills).toEqual(plain.skills);
    expect(authored.connectors).toEqual(plain.connectors);
  });

  it("rejects an out-of-range hue and a multi-code-point glyph", () => {
    expect(() => agent({ ui_identity: { avatar_hue: 361, initial_glyph: "G" } })).toThrow();
    expect(() => agent({ ui_identity: { avatar_hue: 10, initial_glyph: "AB" } })).toThrow();
  });

  it("does not break Pack validation when present", () => {
    expect(() =>
      Pack.parse({
        pack_id: "student",
        version: "1.0.0",
        manifest_hash: "a".repeat(64),
        default_coordinator_agent_id: "agent_general_assistant",
        agents: [
          agent({
            agent_id: "agent_general_assistant",
            ui_identity: { avatar_hue: 217, initial_glyph: "G" },
          }),
        ],
        operations: [],
        runtime_compatibility: "^0.0.0",
      }),
    ).not.toThrow();
  });
});
