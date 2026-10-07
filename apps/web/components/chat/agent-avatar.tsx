import { cn } from "@/lib/utils";

/**
 * Agent avatar (UI_DESIGN §5, §21 item 4): initial glyph on a distinct hue,
 * stable per `agent_id` so the same Agent carries one identity everywhere
 * (D39). The hue mixes the §2.1 token colors with `color-mix` — no raw color
 * values leave the token layer (final illustration art stays open for the
 * owner sketch per §8).
 */
const HUE_MIXES = [100, 80, 60, 40, 20, 0] as const;

export function avatarColorFor(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (Math.imul(hash, 31) + agentId.charCodeAt(i)) >>> 0;
  }
  const index = hash % HUE_MIXES.length;
  const share = HUE_MIXES[index] ?? HUE_MIXES[0];
  return `color-mix(in oklab, var(--color-sky) ${share}%, var(--color-brand))`;
}

const SIZES = {
  sm: { box: "size-6 text-[10px]", dot: "size-2 -right-0.5 -bottom-0.5" },
  md: { box: "size-8 text-xs", dot: "size-2.5 -right-0.5 -bottom-0.5" },
  lg: { box: "size-10 text-sm", dot: "size-3 -right-0.5 -bottom-0.5" },
} as const;

export function AgentAvatar({
  agentId,
  name,
  size = "md",
  presence = "hibernating",
  className,
}: {
  agentId: string;
  name: string;
  size?: keyof typeof SIZES;
  /** D32 on-demand sessions: a live dot only while work is executing. */
  presence?: "active" | "hibernating";
  className?: string;
}) {
  const initials = name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("");
  const dimensions = SIZES[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold text-canvas",
        dimensions.box,
        className,
      )}
      style={{ backgroundColor: avatarColorFor(agentId) }}
    >
      {initials}
      {presence === "active" ? (
        <span
          className={cn("absolute rounded-full bg-live ring-2 ring-surface", dimensions.dot)}
          title="Session active"
        />
      ) : null}
    </span>
  );
}
