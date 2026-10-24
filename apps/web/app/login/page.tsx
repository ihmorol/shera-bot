import type { Metadata } from "next";

import { Wordmark } from "@/components/shell/wordmark";
import { Button } from "@/components/ui/button";
import { routes } from "@/lib/routes";

export const metadata: Metadata = {
  title: "Sign in",
};

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
        <Button className="mt-8 w-full" asChild>
          <a href={routes.controlPlaneSignIn()}>Sign in with Google</a>
        </Button>
        <p className="mt-4 text-xs text-muted">
          Sign in with your Google account. Private prototype access is capped at five accounts.
        </p>
      </div>
    </main>
  );
}
