"use client";

import Link from "next/link";

import {
  ADVANCED_SETTINGS_CATEGORIES,
  CORE_SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_SLUGS,
  type SettingsCategory,
} from "@/lib/settings-categories";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The settings overview (S30; D16): ALL FIFTEEN recorded categories, in D16's
 * order, each linking its real section — the index never advertises a section
 * that cannot render (G4). Owner direction (2026-11-20): the core six lead;
 * the remaining nine live under one collapsed "Advanced" disclosure (still
 * rendered and reachable, never hidden from assistive tech). The recorded
 * read-only categories carry the decision's own words instead of an invented
 * control (G4/G5).
 */
function CategoryCard({ category }: { category: SettingsCategory }) {
  return (
    <li
      className={cn(
        "rounded-xl border border-line bg-surface px-4 py-3 transition-colors hover:bg-surface-elevated",
      )}
    >
      <Link
        href={routes.settings(category.slug)}
        className="block text-sm font-medium text-text underline-offset-4 hover:text-cool-highlight hover:underline"
      >
        {category.label}
      </Link>
      <p className="mt-0.5 text-xs text-muted">{category.summary}</p>
      {category.readOnlyBecause ? (
        <p className="mt-1 text-[11px] text-muted">
          Read-only by decision — {category.readOnlyBecause}
        </p>
      ) : null}
    </li>
  );
}

export function SettingsOverview() {
  return (
    <div>
      <p className="max-w-xl text-sm text-muted">Everything you configure, in one place.</p>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {CORE_SETTINGS_CATEGORIES.map((category) => (
          <CategoryCard key={category.slug} category={category} />
        ))}
      </ul>
      <details className="mt-6 group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-1 py-2 font-mono text-xs uppercase tracking-[0.16em] text-muted transition-colors hover:text-text">
          Advanced
          <span className="text-[11px] normal-case tracking-normal">
            ({ADVANCED_SETTINGS_CATEGORIES.length} sections)
          </span>
        </summary>
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {ADVANCED_SETTINGS_CATEGORIES.map((category) => (
            <CategoryCard key={category.slug} category={category} />
          ))}
        </ul>
      </details>
      {/* The register stays complete: the fifteen slugs are the contract. */}
      <span className="sr-only">{SETTINGS_CATEGORY_SLUGS.length} settings sections</span>
    </div>
  );
}
