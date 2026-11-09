import Link from "next/link";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * Interim wordmark. Final logo art is deliberately undecided (PRODUCT.md,
 * owner reference material pending) — the mark is a neutral letterform block
 * that a real logo replaces without layout changes.
 *
 * The link's accessible name is its visible text ("Shera Bot"): an aria-label
 * here cannot contain the rendered letterform glyph's text (axe's
 * label-content-name-mismatch, serious — S34 browser-matrix finding), so no
 * aria-label is set and the content labels the link.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <Link
      href={routes.app()}
      className={cn("inline-flex items-center gap-2.5 rounded-md", className)}
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
