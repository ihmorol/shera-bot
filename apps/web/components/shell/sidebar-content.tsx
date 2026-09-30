"use client";

import { Layers, Loader2, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AgentAvatar } from "@/components/chat/agent-avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  entitySlug,
  sessionPresenceFor,
  sidebarModel,
  type ConversationState,
} from "@/lib/fixtures";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { Wordmark } from "./wordmark";

/**
 * Sidebar (UI_DESIGN §3.2, PRD §4.1): global chrome row, the six pack Agents
 * as persistent direct chats (AC3), the pack-defined Operation templates
 * (launch → preview, D30), the active Operation chats group, and the pack
 * footer label. Two sections only (D41); no workspace switcher, no pack
 * switcher (D40, D19).
 *
 * All rows and states come from the §9 fixture model: unread (count pill),
 * running (spinner), approval_required (amber dot + count — a pending
 * proposal, never a granted state, G2), failed (red dot), quiet (no marker).
 * Color is never the only signal — every dot pairs with a glyph, count, or
 * screen-reader label (§2.1).
 */

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
}: {
  state: ConversationState;
  unreadCount: number;
  approvalCount: number;
}) {
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
        <span className="size-2 rounded-full bg-failed" aria-hidden="true" />
      ) : null}
      {state === "unread" ? <UnreadPill count={unreadCount} /> : null}
      <span className="sr-only">{STATE_LABELS[state]}</span>
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
        {/* Agents — six pack Agents as persistent direct chats (AC3, §3.2) */}
        <section>
          <SidebarSectionLabel>Agents</SidebarSectionLabel>
          <ul>
            {model.agents.map(({ agent, conversation, state, approvalCount }) => {
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
                    <AgentAvatar
                      agentId={agent.agent_id}
                      name={agent.display_name}
                      size="sm"
                      presence={presence}
                    />
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
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
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
              ({ operation, conversation, subtitle, state, approvalCount }) => {
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
                      />
                    </Link>
                  </li>
                );
              },
            )}
          </ul>
        </section>
      </nav>

      {/* Footer: pinned pack shown once as a label, not a control (D40) */}
      <Separator />
      <div className="px-4 py-3">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">student pack v1</p>
      </div>
    </div>
  );
}
