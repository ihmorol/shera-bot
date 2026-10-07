import Link from "next/link";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * Interim wordmark. Final logo art is deliberately undecided (PRODUCT.md,
 * owner reference material pending) — the mark is a neutral letterform block
 * that a real logo replaces without layout changes.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href={routes.app()}
      className={cn("inline-flex items-center gap-2.5 rounded-md", className)}
      aria-label="Shera Bot dashboard"
    >
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-lg bg-brand font-display text-sm font-semibold text-text"
      >
        S
      </span>
      <span className="font-display text-base font-semibold tracking-tight text-text">
        Shera Bot
      </span>
    </Link>
  );
}
