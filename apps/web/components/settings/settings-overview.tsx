"use client";

import Link from "next/link";

import { SETTINGS_CATEGORIES } from "@/lib/settings-categories";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/**
 * The settings overview (S30; D16): ALL FIFTEEN recorded categories, in
 * D16's order, each linking its real section — the index never advertises a
 * section that cannot render (G4). The recorded read-only categories carry
 * the decision's own words instead of an invented control (G4/G5).
 */
export function SettingsOverview() {
  return (
    <div>
      <p className="max-w-xl text-sm text-muted">
        Everything you configure, in one place. Every section keeps its recommended default;
        advanced items stay tucked away until you open them.
      </p>
      <ul className="mt-6 grid gap-2 sm:grid-cols-2">
        {SETTINGS_CATEGORIES.map((category) => (
          <li
            key={category.slug}
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
        ))}
      </ul>
    </div>
  );
}
