"use client";

import { Layers, Loader2, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { AgentRosterSection } from "@/components/shell/agent-roster";
import { CreditsPill } from "@/components/shell/credits-pill";
import { LiveOperationChatsSection } from "@/components/shell/operation-chats-section";
import { NotificationBell } from "@/components/shell/notification-center";
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
import { useAdvancedMode, setAdvancedMode } from "@/lib/interface-mode";
import { useOperationsList } from "@/lib/operation-data";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { Wordmark } from "./wordmark";

/**
 * Sidebar (UI_DESIGN §3.2, §2.1, PRD §4.1) in two interface modes
 * (lib/interface-mode.ts, owner direction 2026-11-20):
 *
 * SIMPLE (default) — one "Chats" list: the pack Agents' direct chats and the
 * Operation chats interleaved by last activity, each row reduced to
 * avatar-or-Operation glyph + name + the honest state trail. No role
 * descriptions, no subtitles, no template gallery — a student opens the app
 * and picks up a conversation. The Operation framing stays: Operation rows
 * carry the Layers glyph and open the Operation chat surface.
 *
 * ADVANCED — the documented structure: the six pack Agents as persistent
 * direct chats (AC3, with the §3.2 settings affordance), the pack-defined
 * Operation templates (launch → preview, D30), and the active Operation
 * chats group (S14 live rows + fixture demo rows). Two sections only (D41);
 * no workspace or pack switcher (D40, D19).
 *
 * State language is shared by both modes (§2.1, G2): unread (count pill),
 * running (spinner), approval_required (amber dot + count — a pending
 * proposal, never a granted state), failed (red only for genuinely FAILED
 * runs; amber "needs your review" otherwise), quiet (no marker). Color is
 * never the only signal — every dot pairs with a glyph, count, or
 * screen-reader label. Live rows fabricate no state (G4) and render quiet.
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

/**
 * The live Operation chats (S14): the workspace's REAL Operations read from
 * GET /v1/operations, each entry carrying the ad-hoc identity (D41). Rendered
 * beside the fixture demo chats (which stay, honestly labeled demo data, G4);
 * a wrapper component keeps the list hook's lifecycle inside "container
 * ready" — the same discipline as LiveAgentRosterSection.
 */
function LiveOperationChats({
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const operations = useOperationsList(workspaceId);
  return (
    <LiveOperationChatsSection
      operations={operations.operations}
      state={operations.state}
      safeErrorMessage={operations.safeErrorMessage}
      onRetry={operations.refetch}
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

/**
 * The merged Chats list is recency-sorted (D52, UI_DESIGN §3.4): agent
 * direct chats and Operation chats interleave by their own recorded
 * timestamps, newest first, agent rows winning ties (stable sort keeps
 * roster order within a tie). Exported for the order contract test.
 */
export function mergeChatsByRecency<A extends { at: number }, O extends { at: number }>(
  agentRows: A[],
  operationRows: O[],
): (A | O)[] {
  return [...agentRows, ...operationRows].sort((a, b) => b.at - a.at);
}

/** The Advanced footer toggle — one quiet control, both modes. */
function AdvancedToggle() {
  const advanced = useAdvancedMode();
  return (
    <button
      type="button"
      aria-pressed={advanced}
      onClick={() => setAdvancedMode(!advanced)}
      title={advanced ? "Show the simple interface" : "Show agents, templates, and machinery"}
      className="flex items-center gap-2 rounded-md px-1.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-text"
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex h-3.5 w-6 items-center rounded-full border px-0.5 transition-colors",
          advanced ? "border-line-accent bg-surface-elevated" : "border-line bg-transparent",
        )}
      >
        <span
          className={cn(
            "size-2 rounded-full transition-colors",
            advanced ? "translate-x-2.5 bg-sky" : "translate-x-0 bg-muted",
          )}
        />
      </span>
      Advanced
    </button>
  );
}

/** The SIMPLE chat list — fixture demo data (no container yet). */
function SimpleChatListDemo({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const model = sidebarModel();
  const rows = mergeChatsByRecency(
    model.agents.map((entry) => ({
      kind: "agent" as const,
      key: entry.agent.agent_id,
      conversationId: entry.conversation.conversation_id,
      href: routes.agent(entitySlug(entry.agent.agent_id)),
      title: entry.agent.display_name,
      agent: entry.agent,
      at: Date.parse(entry.conversation.last_activity_at),
      state: entry.state,
      unreadCount: entry.conversation.unread_count,
      approvalCount: entry.approvalCount,
      attention: entry.attention,
    })),
    model.operationChats.map((entry) => ({
      kind: "operation" as const,
      key: entry.operation.operation_id,
      conversationId: entry.conversation.conversation_id,
      href: routes.operation(entry.operation.operation_id),
      title: entry.conversation.title,
      agent: null,
      at: Date.parse(entry.conversation.last_activity_at),
      state: entry.state,
      unreadCount: entry.conversation.unread_count,
      approvalCount: entry.approvalCount,
      attention: entry.attention,
    })),
  );

  return (
    <ul>
      {rows.map((row) => {
        const active = pathname === row.href || pathname.startsWith(`${row.href}/`);
        return (
          <li key={row.key}>
            <Link
              href={row.href}
              aria-current={active ? "page" : undefined}
              className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}
              {...(onNavigate ? { onClick: onNavigate } : {})}
            >
              {row.agent ? (
                <AgentAvatar
                  agent={row.agent}
                  size="sm"
                  presence={sessionPresenceFor(row.conversationId)}
                />
              ) : (
                <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <StateTrail
                state={row.state}
                unreadCount={row.unreadCount}
                approvalCount={row.approvalCount}
                attention={row.attention}
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The SIMPLE chat list over the REAL workspace reads (S11/S14 discipline). */
function SimpleChatListLive({
  workspaceId,
  pathname,
  onNavigate,
}: {
  workspaceId: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  const roster = useAgentRoster(workspaceId);
  const operations = useOperationsList(workspaceId);
  const linkProps = onNavigate ? { onClick: onNavigate } : {};

  // Real reads fabricate no state (G4): live rows render quiet — no derived
  // unread/approval markers until the runtime's real tracking lands.
  const agentRows = roster.agents.map((agent) => ({
    kind: "agent" as const,
    key: agent.agent_id,
    href: routes.agent(entitySlug(agent.agent_id)),
    title: agent.display_name,
    hue: agent.avatar_hue,
    glyph: agent.initial_glyph,
    at: agent.last_activity ? Date.parse(agent.last_activity.at) : 0,
  }));
  const operationRows = operations.operations.map((operation) => ({
    kind: "operation" as const,
    key: operation.operation_id,
    href: routes.operation(operation.operation_id),
    title: operation.name,
    autoLabel: operation.auto_label,
    isAdhoc: operation.is_adhoc,
    // The runtime derives no last-activity preview for Operations yet — the
    // record's updated_at is the honest available sort key (G4); rows stay
    // preview-less until the runtime adds one.
    at: Date.parse(operation.updated_at) || 0,
  }));

  if (roster.state === "loading" || operations.state === "loading") {
    return (
      <div aria-busy="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-3 py-2">
            <span className="size-6 animate-pulse rounded-full bg-surface-elevated" />
            <span className="h-3 w-36 animate-pulse rounded bg-surface-elevated" />
          </div>
        ))}
      </div>
    );
  }

  if (roster.state === "error" || operations.state === "error") {
    const safeErrorMessage = roster.safeErrorMessage ?? operations.safeErrorMessage;
    return (
      <div role="alert" className="mx-1 flex flex-col gap-2 rounded-lg px-2 py-2">
        <p className="text-sm text-text">
          {safeErrorMessage ?? "The conversations could not be loaded."}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            roster.refetch();
            operations.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  }

  // §2.4 + §3.4: the live merged list defines its empty state — one line
  // naming what will appear; the New Operation action sits directly above.
  if (agentRows.length === 0 && operationRows.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted" role="status">
        No conversations yet. Agent chats and Operations appear here.
      </p>
    );
  }

  return (
    <ul>
      {mergeChatsByRecency(agentRows, operationRows).map((row) => {
        const active = pathname === row.href || pathname.startsWith(`${row.href}/`);
        return (
          <li key={row.key}>
            <Link
              href={row.href}
              aria-current={active ? "page" : undefined}
              className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_IDLE)}
              {...linkProps}
            >
              {row.kind === "agent" ? (
                <AgentAvatar
                  agent={{
                    agent_id: row.key,
                    display_name: row.title,
                    ui_identity: { avatar_hue: row.hue, initial_glyph: row.glyph },
                  }}
                  size="sm"
                />
              ) : (
                <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  row.kind === "operation" && row.autoLabel && "italic text-muted",
                )}
              >
                {row.title}
              </span>
              {row.kind === "operation" && row.isAdhoc ? (
                <span
                  title="Created without a pack definition"
                  className="shrink-0 rounded-full border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted"
                >
                  Ad-hoc
                </span>
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const advanced = useAdvancedMode();
  const model = sidebarModel();
  const linkProps = onNavigate ? { onClick: onNavigate } : {};
  const resolution = useContainerResolution();
  const readyWorkspaceId = resolution.data?.kind === "ready" ? resolution.data.workspace_id : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Global chrome row (§3.2: bell | gear) */}
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <Wordmark />
        <div className="flex items-center gap-1">
          <NotificationBell workspaceId={readyWorkspaceId} onNavigate={onNavigate} />
          <Button variant="ghost" size="icon" asChild>
            <Link href={routes.settings()} aria-label="Open settings" {...linkProps}>
              <Settings2 className="size-4" />
            </Link>
          </Button>
        </div>
      </div>

      <Separator />

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-4" aria-label="Primary">
        {advanced ? (
          <>
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
                    {model.agents.map(
                      ({ agent, conversation, state, approvalCount, attention }) => {
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
                                <span className="block truncate text-text">
                                  {agent.display_name}
                                </span>
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
                      },
                    )}
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

              {/* Active Operation chats group (§3.2: "── active chats ──").
                  S14: the REAL Operations render first with the ad-hoc identity
                  (D41); the fixture demo chats stay below, honestly demo. */}
              <p className="px-3 pb-1 pt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                Active chats
              </p>
              {readyWorkspaceId ? (
                <div className="pb-1">
                  <LiveOperationChats
                    workspaceId={readyWorkspaceId}
                    pathname={pathname}
                    onNavigate={onNavigate}
                  />
                </div>
              ) : null}
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
          </>
        ) : (
          <>
            {/* SIMPLE (default): one conversation list + one primary action. */}
            <div className="px-1 pb-3">
              <Button className="w-full" asChild>
                <Link href={routes.operationNew()} {...linkProps}>
                  New Operation
                </Link>
              </Button>
            </div>
            <section aria-label="Chats">
              <SidebarSectionLabel>Chats</SidebarSectionLabel>
              {readyWorkspaceId ? (
                <SimpleChatListLive
                  workspaceId={readyWorkspaceId}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ) : (
                <SimpleChatListDemo pathname={pathname} onNavigate={onNavigate} />
              )}
            </section>
          </>
        )}
      </nav>

      {/* Footer: the credits pill (S24, D21 — remaining, reserved on hover).
          Advanced also shows the pinned pack once as a label, not a control
          (D40); simple keeps the footer to credits + the mode toggle. */}
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pb-4 pt-3">
        <CreditsPill workspaceId={readyWorkspaceId} />
        <div className="flex items-center gap-3">
          {advanced ? (
            <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
              student pack v1
            </p>
          ) : null}
          <AdvancedToggle />
        </div>
      </div>
    </div>
  );
}
