import type { Metadata } from "next";

import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * S1 login surface. OAuth wiring is a later slice — the primary action is
 * visibly disabled rather than pretending to work (G4 honest states).
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8">
        <Wordmark />
        <h1 className="mt-8 font-display text-2xl font-semibold tracking-tight text-text">
          Sign in to Shera Bot
        </h1>
        <p className="mt-2 text-sm text-muted">
          Your Agents, Operations, and workspace in one private place.
        </p>
        <Button className="mt-8 w-full" disabled>
          Sign in with Google
        </Button>
        <p className="mt-4 text-xs text-muted">
          Google sign-in is not wired into this prototype build yet. When it goes live, access is
          capped at five accounts.
        </p>
      </div>
    </main>
  );
}
