import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DM_Sans, JetBrains_Mono, Space_Grotesk } from "next/font/google";

import "./globals.css";

/**
 * Typography (UI_DESIGN §2.1 / PRODUCT.md brand commitments): Space Grotesk
 * display, DM Sans body, JetBrains Mono for code/paths/status meta — loaded
 * once here and exposed to the token layer via CSS variables.
 */
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const body = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Shera Bot",
    template: "%s · Shera Bot",
  },
  description: "Pack-defined AI Agents working in supervised, transparent Operations.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-theme="dark"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body className="bg-canvas font-sans text-text antialiased">{children}</body>
    </html>
  );
}
