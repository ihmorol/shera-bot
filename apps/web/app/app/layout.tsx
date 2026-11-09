import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { Providers } from "@/components/providers";
import { ContainerGate } from "@/components/shell/container-gate";
import { RecoveryBannerHost } from "@/components/shell/recovery-banner-host";
import { WorkspacePanelHostProvider } from "@/components/workspace/workspace-panel";
import { OnboardingDock } from "@/components/onboarding/onboarding-cards";

export const metadata: Metadata = {
  title: "Dashboard",
};

/**
 * Shell layout for everything under /app (UI_DESIGN §2.2, §3.2). The
 * workspace panel host provider wraps the shell: the shell's reserved
 * region, the chat-header toggles, and the mobile sheet all share the ONE
 * controller — conflicting simultaneous control is impossible by
 * construction.
 *
 * S31 (UI_DESIGN S11): the recovery banner mounts top-of-app — the ONE strip
 * above the whole shell (sidebar included), because recovery is a workspace
 * fact, not a surface fact. A strip, never a modal: reading stays possible
 * through recovery, and an idle workspace renders nothing at all.
 *
 * S30 (E43): the onboarding dock mounts over the conversation area — the
 * first-run interview as a chat-bubble card, never a wizard, never a modal.
 * A non-pending interview renders nothing (zero-config start, D16).
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <div className="flex h-dvh flex-col">
        <RecoveryBannerHost />
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspacePanelHostProvider>
            <AppShell>
              <ContainerGate>{children}</ContainerGate>
            </AppShell>
          </WorkspacePanelHostProvider>
        </div>
        <OnboardingDock />
      </div>
    </Providers>
  );
}
