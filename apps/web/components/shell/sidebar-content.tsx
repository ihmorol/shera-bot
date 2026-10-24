"use client";

import { Layers, Loader2, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AgentRosterSection } from "@/components/shell/agent-roster";
import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useAgentRoster } from "@/lib/agent-data";
import { useContainerResolution } from "@/lib/container-connection";
import {
  entitySlug,
  sessionPresenceFor,
  sidebarModel,
  type AttentionVariant,
  type ConversationState,
} from "@/lib/fixtures";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { Wordmark } from "./wordmark";

/**
 * Sidebar (UI_DESIGN §3.2, §2.1, PRD §4.1): global chrome row, the six pack
 * Agents as persistent direct chats (AC3), the pack-defined Operation
 * templates (launch → preview, D30), the active Operation chats group, and
 * the pack footer label. Two sections only (D41); no workspace switcher, no
 * pack switcher (D40, D19).
 *
 * The Agents section has two honest data sources (S11): when the container is
 * ready it renders the REAL workspace roster from GET /v1/agents (the seeded
 * pack identities, quiet rows — no fabricated states, G4); in every other
 * resolution state it keeps the §9 fixture demo rows, honestly labeled demo
 * data. All rows and states come from the §9 fixture model otherwise: unread
 * (count pill), running (spinner), approval_required (amber dot + count — a
 * pending proposal, never a granted state, G2), failed (red dot for genuinely
 * FAILED runs; amber "needs your review" for PAUSED/RECOVERY_REQUIRED per
 * the §2.1 palette — red means error only), quiet (no marker). Color is
 * never the only signal — every dot pairs with a glyph, count, or
 * screen-reader label (§2.1).
 */

/** The live Agents section once the container is ready (S11 roster read). */
function LiveAgentRosterSection({
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const roster = useAgentRoster(workspaceId);
  return (
    <AgentRosterSection
      entries={roster.agents}
      state={roster.state === "ready" && roster.agents.length === 0 ? "empty" : roster.state}
      safeErrorMessage={roster.safeErrorMessage}
      onRetry={roster.refetch}
      pathname={pathname}
      onNavigate={onNavigate}
    />
  );
}

/** Screen-reader label per sidebar state (color is never the only signal). */
const STATE_LABELS: Record<ConversationState, string> = {
  unread: "unread messages",
  running: "work in progress",
  approval_required: "waiting for your approval",
  failed: "needs your review",
  quiet: "no new activity",
};

function SidebarSectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-2 font-mono text-xs uppercase tracking-[0.16em] text-muted">{children}</p>
  );
}

function UnreadPill({ count }: { count: number }) {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-surface-elevated px-1.5 py-0.5 font-mono text-[11px] leading-none text-text">
      {count}
    </span>
  );
}

function StateTrail({
  state,
  unreadCount,
  approvalCount,
  attention,
}: {
  state: ConversationState;
  unreadCount: number;
  approvalCount: number;
  attention: AttentionVariant;
}) {
  // §2.1 palette: red marks a genuinely FAILED run only; a run that is
  // paused or needs recovery review reads amber (attention), never red.
  const failedLabel = attention === "error" ? "failed" : "needs your review";
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {state === "running" ? (
        <Loader2 className="size-3.5 animate-spin text-sky" aria-hidden="true" />
      ) : null}
      {state === "approval_required" ? (
        <>
          <span className="size-2 rounded-full bg-approval" aria-hidden="true" />
          <UnreadPill count={approvalCount} />
        </>
      ) : null}
      {state === "failed" ? (
        // §2.1 palette: red marks a genuinely FAILED run only; PAUSED /
        // RECOVERY_REQUIRED read amber. The sr-only label renders once,
        // in the shared trailing span below.
        <span
          className={cn("size-2 rounded-full", attention === "error" ? "bg-failed" : "bg-approval")}
          aria-hidden="true"
        />
      ) : null}
      {state === "unread" ? <UnreadPill count={unreadCount} /> : null}
      <span className="sr-only">{state === "failed" ? failedLabel : STATE_LABELS[state]}</span>
    </span>
  );
}

const ITEM_BASE = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors";
const ITEM_ACTIVE = "bg-surface-elevated text-text";
const ITEM_IDLE = "text-muted hover:bg-surface-elevated hover:text-text";

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const model = sidebarModel();
  const linkProps = onNavigate ? { onClick: onNavigate } : {};
  const resolution = useContainerResolution();
  const readyWorkspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Global chrome row */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Wordmark />
        <Button variant="ghost" size="icon" asChild>
          <Link href={routes.settings()} aria-label="Open settings" {...linkProps}>
            <Settings2 className="size-4" />
          </Link>
        </Button>
      </div>

      <Separator />

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-4" aria-label="Primary">
        {/* Agents — the REAL workspace roster once the container is ready
            (S11); the fixture demo rows otherwise (§3.2, AC3). */}
        <section>
          {readyWorkspaceId ? (
            <LiveAgentRosterSection
              workspaceId={readyWorkspaceId}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          ) : (
            <>
              <SidebarSectionLabel>Agents</SidebarSectionLabel>
              <ul>
                {model.agents.map(({ agent, conversation, state, approvalCount, attention }) => {
                  const href = routes.agent(entitySlug(agent.agent_id));
                  const active = pathname === href || pathname.startsWith(`${href}/`);
                  const presence = sessionPresenceFor(conversation.conversation_id);
                  return (
                    <li key={agent.agent_id}>
                      <Link
                        href={href}
                        aria-current={active ? "page" : undefined}
                        title={agent.role_description}
                        className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}
                        {...linkProps}
                      >
                        <AgentAvatar agent={agent} size="sm" presence={presence} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-text">{agent.display_name}</span>
                          <span className="block truncate text-xs text-muted">
                            {agent.role_description}
                          </span>
                        </span>
                        <StateTrail
                          state={state}
                          unreadCount={conversation.unread_count}
                          approvalCount={approvalCount}
                          attention={attention}
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <Separator className="my-4" />

        {/* Operations — templates open the launch preview (D30); chats open directly */}
        <section>
          <div className="flex items-center justify-between pr-2">
            <SidebarSectionLabel>Operations</SidebarSectionLabel>
            <Button variant="ghost" size="sm" asChild className="-my-1">
              <Link href={routes.operationNew()} {...linkProps}>
                + New
              </Link>
            </Button>
          </div>
          <ul>
            {model.templates.map(({ definition }) => {
              const slug = entitySlug(definition.operation_id);
              return (
                <li key={definition.operation_id}>
                  <Link
                    href={routes.operationPreview(slug)}
                    className={cn(ITEM_BASE, ITEM_IDLE)}
                    {...linkProps}
                  >
                    <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{definition.title}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* Active Operation chats group (§3.2: "── active chats ──") */}
          <p className="px-3 pb-1 pt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
            Active chats
          </p>
          <ul>
            {model.operationChats.map(
              ({ operation, conversation, subtitle, state, approvalCount, attention }) => {
                return (
                  <li key={operation.operation_id}>
                    <Link
                      href={routes.operation(operation.operation_id)}
                      className={cn(ITEM_BASE, ITEM_IDLE)}
                      {...linkProps}
                    >
                      <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{conversation.title}</span>
                        <span className="block truncate text-xs text-muted">{subtitle}</span>
                      </span>
                      <StateTrail
                        state={state}
                        unreadCount={conversation.unread_count}
                        approvalCount={approvalCount}
                        attention={attention}
                      />
                    </Link>
                  </li>
                );
              },
            )}
          </ul>
        </section>
      </nav>

      {/* Footer: pinned pack shown once as a label, not a control (D40).
          pb-4 keeps the label inside the shell's 16px edge rhythm — it never
          rides the viewport's bottom edge. */}
      <Separator />
      <div className="px-4 pb-4 pt-3">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">student pack v1</p>
      </div>
    </div>
  );
}
