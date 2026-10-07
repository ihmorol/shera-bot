import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/app-shell";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "Dashboard",
};

/** Shell layout for everything under /app (UI_DESIGN §2.2, §3.2). */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
