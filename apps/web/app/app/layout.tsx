import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { Providers } from "@/components/providers";
import { ContainerGate } from "@/components/shell/container-gate";
import { WorkspacePanelHostProvider } from "@/components/workspace/workspace-panel";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * Shell layout for everything under /app (UI_DESIGN §2.2, §3.2). The
 * workspace panel host provider wraps the shell: the shell's reserved
 * region, the chat-header toggles, and the mobile sheet all share the ONE
 * controller — conflicting simultaneous control is impossible by
 * construction.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <WorkspacePanelHostProvider>
        <AppShell>
          <ContainerGate>{children}</ContainerGate>
        </AppShell>
      </WorkspacePanelHostProvider>
    </Providers>
  );
}
