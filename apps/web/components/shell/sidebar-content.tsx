"use client";

import { Layers, Settings2 } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { PACK_AGENTS, PACK_OPERATION_TEMPLATES } from "@/lib/navigation";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { Wordmark } from "./wordmark";

/**
 * Sidebar (UI_DESIGN §3.2): global chrome row, fixed Agents section, fixed
 * Operations section, pack footer label. Two sections only (D41); no
 * workspace switcher, no pack switcher (D40, D19).
 *
 * Chunk-1 shell: per-item state trails (unread / running / approval-required /
 * failed) and the Operation chats group arrive with the §9 mock fixtures —
 * nothing here pretends state that does not exist yet (G4).
 */
function agentInitials(name: string): string {
  return name
    .split(" ")
    .map((word) => word[0])
    .slice(0, 2)
    .join("");
}

function SidebarSectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-2 font-mono text-xs uppercase tracking-[0.16em] text-muted">
      {children}
    </p>
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

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
        {/* Agents — six pack Agents as persistent direct chats (AC3) */}
        <section>
          <SidebarSectionLabel>Agents</SidebarSectionLabel>
          <ul>
            {PACK_AGENTS.map((agent) => {
              const href = routes.agent(agent.slug);
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={agent.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-surface-elevated text-text"
                        : "text-muted hover:bg-surface-elevated hover:text-text",
                    )}
                    {...linkProps}
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface-elevated font-mono text-[10px] font-medium text-sky"
                    >
                      {agentInitials(agent.name)}
                    </span>
                    <span className="truncate">{agent.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>

        <Separator className="my-4" />

        {/* Operations — pack-defined templates open the launch preview (D30) */}
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
            {PACK_OPERATION_TEMPLATES.map((operation) => {
              const href = routes.operationPreview(operation.slug);
              return (
                <li key={operation.slug}>
                  <Link
                    href={href}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-elevated hover:text-text"
                    {...linkProps}
                  >
                    <Layers className="size-4 shrink-0 text-sky" aria-hidden="true" />
                    <span className="truncate">{operation.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      </nav>

      {/* Footer: pinned pack shown once as a label, not a control (D40) */}
      <Separator />
      <div className="px-4 py-3">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted">
          student pack v1
        </p>
      </div>
    </div>
  );
}
