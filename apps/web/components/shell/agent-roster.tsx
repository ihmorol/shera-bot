"use client";

import { AlertTriangle, Settings2 } from "lucide-react";
import Link from "next/link";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Button } from "@/components/ui/button";
import { entitySlug } from "@/lib/fixtures";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The sidebar Agents section backed by the REAL workspace roster (S11, §3.2):
 * the six pack Agents seeded at container startup, read from GET /v1/agents.
 * Each row opens that Agent's direct chat (the route resolves the
 * get-or-create `direct_chat_id`) and carries the §3.2 settings affordance
 * (the D16 settings surface, reached via the same commands the onboarding
 * reuses).
 *
 * §2.4 state language: a layout-matched skeleton while the roster loads, the
 * redacted safe_message with retry on failure, and a one-line empty state —
 * the pack seeds six Agents, so an empty roster means seeding did not run.
 *
 * Honesty (G4): the live roster fabricates NO sidebar state — real read
 * tracking and session presence arrive in later slices, so live rows render
 * quiet (the fixture demo's derived states never leak onto real data).
 */

/** One roster summary from GET /v1/agents (identity fields only, G3). */
export interface AgentRosterEntry {
  agent_id: string;
  display_name: string;
  role_description: string;
  avatar_hue: number;
  initial_glyph: string;
  has_user_instructions: boolean;
}

export type AgentRosterState = "loading" | "ready" | "error" | "empty";

const ITEM_BASE = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
const ITEM_ACTIVE = "bg-surface-elevated text-text";
const ITEM_IDLE = "text-muted hover:bg-surface-elevated hover:text-text";

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-2 font-mono text-xs uppercase tracking-[0.16em] text-muted">{children}</p>
  );
}

function SkeletonRow() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 px-3 py-2">
      <span className="size-6 animate-pulse rounded-full bg-surface-elevated" />
      <span className="min-w-0 flex-1">
        <span className="block h-3 w-28 animate-pulse rounded bg-surface-elevated" />
        <span className="mt-1.5 block h-2.5 w-40 animate-pulse rounded bg-surface-elevated" />
      </span>
    </div>
  );
}

export function AgentRosterSection({
  entries,
  state,
  safeErrorMessage,
  onRetry,
  pathname,
  onNavigate,
}: {
  entries: AgentRosterEntry[];
  state: AgentRosterState;
  /** Redacted message for the error state (D23 rule 4). */
  safeErrorMessage?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** The active route, passed in by the shell so this section stays pure. */
  pathname?: string | undefined;
  /** Close the mobile drawer on navigation (the shell owns the sheet). */
  onNavigate?: (() => void) | undefined;
}) {
  const linkProps = onNavigate ? { onClick: onNavigate } : {};

  return (
    <section>
      <SectionLabel>Agents</SectionLabel>
      {state === "loading" ? (
        <div data-testid="agent-roster-skeleton">
          {Array.from({ length: 6 }, (_, index) => (
            <SkeletonRow key={index} />
          ))}
        </div>
      ) : state === "error" ? (
        <div role="alert" className="mx-1 flex flex-col gap-2 rounded-lg px-2 py-2">
          <p className="flex items-start gap-2 text-sm text-text">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-failed" aria-hidden="true" />
            {safeErrorMessage ?? "The Agent roster could not be loaded."}
          </p>
          {onRetry ? (
            <Button variant="outline" size="sm" className="self-start" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      ) : state === "empty" ? (
        <p className="px-3 py-2 text-sm text-muted" role="status">
          No Agents are seeded in this workspace yet. Restart your workspace to re-run pack
          seeding.
        </p>
      ) : (
        <ul>
          {entries.map((agent) => {
            const slug = entitySlug(agent.agent_id);
            const href = routes.agent(slug);
            const active =
              pathname !== undefined && (pathname === href || pathname.startsWith(`${href}/`));
            return (
              <li key={agent.agent_id} className="group">
                <div className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    title={agent.role_description}
                    className="flex min-w-0 flex-1 items-center gap-3"
                    {...linkProps}
                  >
                    <AgentAvatar
                      agent={{
                        agent_id: agent.agent_id,
                        display_name: agent.display_name,
                        ui_identity: {
                          avatar_hue: agent.avatar_hue,
                          initial_glyph: agent.initial_glyph,
                        },
                      }}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-text">{agent.display_name}</span>
                      <span className="block truncate text-xs text-muted">
                        {agent.role_description}
                      </span>
                    </span>
                  </Link>
                  {/* §3.2: the Agents section is fixed — the gear opens the
                      Agent's settings (D16 commands), it never creates. The
                      p-1.5 padding keeps the pointer/keyboard target at the
                      24px+ a11y baseline (§2.3). */}
                  <Link
                    href={routes.settings(`agents/${slug}`)}
                    aria-label={`Open ${agent.display_name} settings`}
                    title={`Open ${agent.display_name} settings`}
                    className="shrink-0 rounded-md p-1.5 text-muted transition-colors hover:bg-surface-elevated hover:text-text"
                    {...linkProps}
                  >
                    <Settings2 className="size-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
