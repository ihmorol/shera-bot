import type { CSSProperties } from "react";
import type { Agent } from "@shera-bot/contracts";

import { cn } from "@/lib/utils";

/**
 * Agent avatar — a small 3D-shaded identity token (UI_DESIGN §5, §21 item 4).
 *
 * Design notes:
 *
 * - **Pack data is authoritative (D18).** The pack authors `ui_identity`
 *   (`avatar_hue`, `initial_glyph`) per Agent. This component previously hashed
 *   `agent_id` into one of six fixed color mixes and ignored the authored values
 *   entirely, silently discarding identity the pack had already declared — and
 *   `mockup-divergence.test.ts` was pinning those hues for nothing. Authored
 *   identity now wins; the `agent_id` hash is only a fallback for packs that
 *   author no identity.
 * - **Stable per Agent (D39).** The same Agent looks identical in the sidebar,
 *   the chat header, and the streaming bubble. Appearance is a pure function of
 *   the Agent's data, never of render order or call site.
 * - **Distinct by more than hue.** Six Agents sit side by side in the sidebar,
 *   so a deterministic shape variant (facet count) varies alongside the hue.
 *   §2.1 requires color never be the only signal; here it is not the *only*
 *   differentiator even visually.
 * - **Tokens only (§2.1).** The component emits a bare hue NUMBER in a CSS
 *   custom property; every actual color value is composed in `globals.css`, the
 *   single file allowed to hold raw colors (enforced by `design-tokens.test.ts`).
 * - **Decorative.** The name is always rendered adjacent to the avatar, so the
 *   avatar is `aria-hidden` and never announced twice. Presence pairs its dot
 *   with a text label, so state is never conveyed by color alone.
 */

/** Deterministic 32-bit string hash (stable across renders and processes). */
function hashOf(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * The Agent's authored hue, or a stable derived hue when the pack authors none.
 * Returned as a plain degree number so `globals.css` owns every color value.
 */
export function avatarHueFor(agent: Pick<Agent, "agent_id" | "ui_identity">): number {
  const authored = agent.ui_identity?.avatar_hue;
  if (typeof authored === "number") {
    return ((authored % 360) + 360) % 360;
  }
  return hashOf(agent.agent_id) % 360;
}

/**
 * Deterministic shape variant index (D39). Varies the facet count so Agents
 * differ in silhouette as well as hue.
 */
export function shapeVariantFor(agentId: string): number {
  return hashOf(`shape:${agentId}`) % 4;
}

/** The glyph: the pack's authored one, else the display name's first letter. */
export function glyphFor(agent: Pick<Agent, "display_name" | "ui_identity">): string {
  return agent.ui_identity?.initial_glyph ?? agent.display_name.trim().charAt(0) ?? "?";
}

/** The CSS custom properties the avatar emits; typed so tests can read them. */
export type AgentAvatarVars = {
  "--agent-hue": string;
  "--agent-facets": string;
};

/**
 * The avatar's inline style: hue + facet count as CSS custom properties.
 * Contains no color values — only numbers — so the token layer stays authoritative.
 */
export function avatarStyleFor(agent: Pick<Agent, "agent_id" | "ui_identity">): AgentAvatarVars {
  return {
    "--agent-hue": String(avatarHueFor(agent)),
    "--agent-facets": String(shapeVariantFor(agent.agent_id) + 4),
  };
}

const SIZES = {
  sm: { box: "size-6 text-[10px]", dot: "size-2 -right-0.5 -bottom-0.5" },
  md: { box: "size-8 text-xs", dot: "size-2.5 -right-0.5 -bottom-0.5" },
  lg: { box: "size-10 text-sm", dot: "size-3 -right-0.5 -bottom-0.5" },
} as const;

export function AgentAvatar({
  agent,
  size = "md",
  presence = "hibernating",
  className,
}: {
  agent: Pick<Agent, "agent_id" | "display_name" | "ui_identity">;
  size?: keyof typeof SIZES;
  /** D32 on-demand sessions: a live dot only while work is executing. */
  presence?: "active" | "hibernating";
  className?: string;
}) {
  const dimensions = SIZES[size];
  const glyph = glyphFor(agent);
  return (
    <span
      // Decorative: the Agent's name is always rendered next to the avatar, so
      // announcing the avatar too would duplicate it for screen reader users.
      aria-hidden="true"
      data-agent-avatar=""
      data-presence={presence}
      className={cn(
        "agent-avatar relative inline-flex shrink-0 items-center justify-center rounded-full",
        "font-mono font-semibold",
        dimensions.box,
        className,
      )}
      style={avatarStyleFor(agent) as CSSProperties}
    >
      {/* The 3D form: an isometric cap shaded by the token layer from --agent-hue. */}
      <span className="agent-avatar__shell" data-shape={shapeVariantFor(agent.agent_id)} />
      <span className="agent-avatar__glyph relative">{glyph}</span>
      {presence === "active" ? (
        <span
          className={cn("absolute rounded-full bg-live ring-2 ring-surface", dimensions.dot)}
          title="Session active"
        />
      ) : null}
    </span>
  );
}
