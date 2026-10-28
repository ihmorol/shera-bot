"use client";

import { Menu } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Group, Panel, Separator as ResizeSeparator } from "react-resizable-panels";

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  WorkspacePanelSlot,
  useWorkspacePanelRegionWiring,
} from "@/components/workspace/workspace-panel";

import { SidebarContent } from "./sidebar-content";
import { Wordmark } from "./wordmark";

/**
 * App shell (UI_DESIGN §2.2): desktop = sidebar (280px) + chat column
 * (fluid, minimum 320px — the chat's own floor) + the reserved workspace
 * region (S17 chunk 4: the workspace panel mounts here — the library owns
 * the one separator handle's pointer + keyboard resize, the panel host
 * provider in app/app/layout.tsx owns the semantic states and the
 * per-conversation persistence). Mobile = sidebar drawer over a
 * full-screen conversation (§3.2); the panel becomes a bottom sheet
 * rendered by the provider.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const { panelRef, handlePanelResize } = useWorkspacePanelRegionWiring();

  return (
    <div className="flex h-dvh overflow-hidden bg-canvas text-text">
      <a
        href="#conversation"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-60 focus:rounded-lg focus:bg-surface-elevated focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to conversation
      </a>

      <aside className="hidden w-70 shrink-0 border-r border-line bg-surface lg:flex lg:flex-col">
        <SidebarContent />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile chrome row */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="rounded-md p-2 text-muted transition-colors hover:bg-surface-elevated hover:text-text"
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <Wordmark />
        </header>

        <Group orientation="horizontal" className="min-h-0 flex-1">
          <Panel id="conversation-panel" minSize={320} className="min-w-0">
            <main id="conversation" className="h-full overflow-y-auto">
              {children}
            </main>
          </Panel>
          <ResizeSeparator
            className="w-px bg-line transition-colors hover:bg-line-accent max-lg:hidden"
            aria-label="Resize workspace panel"
          />
          <Panel
            id="workspace"
            collapsible
            collapsedSize={0}
            defaultSize={0}
            minSize={320}
            panelRef={panelRef}
            onResize={handlePanelResize}
            className="bg-surface"
          >
            {/* The S17 workspace panel (Files/Editor/Private files/Artifacts)
                mounts here for the registered conversation; without one the
                region stays an honest reserved slot. */}
            <WorkspacePanelSlot />
          </Panel>
        </Group>
      </div>

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
