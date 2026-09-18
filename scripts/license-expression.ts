/**
 * License-expression evaluation for the dependency inventory gate
 * (PRD §22.22, §23). Pure functions, unit-tested in
 * `tests/contract/license-expression.test.ts`.
 *
 * The gate fails closed. Rules, in precedence order:
 *
 * - Empty or unparsable expression → failure (`(empty license field)`).
 * - `A OR B` → passes when either side passes.
 * - `A AND B` → both sides must pass.
 * - `A WITH B` → the base license decides. An SPDX `WITH` clause adds permissions, so an
 *   allowed base is sufficient; the clause is recorded as a note.
 * - Parenthesized or mixed expressions (both `AND` and `OR`, or any parentheses) → **every**
 *   component must be individually acceptable. This is stricter than SPDX in some
 *   combinations, deliberately: a subtle expression goes to a human as a failure instead of
 *   passing silently.
 *
 * Reviewed exceptions are package-scoped. An exception entry may declare `packages` globs;
 * it then applies only to packages matching one of them, and a license covered by an
 * exception but carried by an unexpected package fails — the written rationale was for
 * specific packages, not for the license at large.
 */

export type ReviewedException = {
  license: string;
  reviewedOn?: string;
  status?: string;
  packages?: string[];
  rationale?: string;
  alternatives?: string[];
};

export type LicensePolicy = {
  notes?: string[];
  allowed: string[];
  reviewedExceptions: ReviewedException[];
};

export type Evaluation = {
  ok: boolean;
  /** Components that could not be satisfied. Empty when the expression passes. */
  unmatched: string[];
  /** Reviewed exceptions the expression relied on. */
  exceptionsUsed: string[];
  /** Non-fatal observations worth recording in the inventory artifact. */
  notes: string[];
};

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g;

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function createEvaluator(policy: LicensePolicy) {
  const allowed = new Set(policy.allowed);
  const exceptions = new Map<string, ReviewedException>(
    policy.reviewedExceptions.map((entry) => [entry.license, entry]),
  );

  return function evaluate(expression: string | null | undefined, packageName: string): Evaluation {
    const raw = (expression ?? "").trim();
    const unmatched: string[] = [];
    const exceptionsUsed: string[] = [];
    const notes: string[] = [];

    if (raw.length === 0) {
      return { ok: false, unmatched: ["(empty license field)"], exceptionsUsed, notes };
    }

    const hasParens = /[()]/.test(raw);
    const hasAnd = /\sAND\s/i.test(raw);
    const hasOr = /\sOR\s/i.test(raw);
    const mixedExpression = hasParens || (hasAnd && hasOr);

    const components = raw
      .replace(/[()]/g, " ")
      .split(/\s+(?:AND|OR)\s+/i)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const check = (component: string): boolean => {
      const withIndex = component.search(/\sWITH\s/i);
      const base = withIndex === -1 ? component : component.slice(0, withIndex).trim();
      const exceptionClause =
        withIndex === -1
          ? null
          : component
              .slice(withIndex)
              .replace(/^\s+WITH\s+/i, "")
              .trim();

      if (allowed.has(base)) {
        if (exceptionClause !== null) {
          notes.push(
            `${component}: base license ${base} is allowed; SPDX exception clause recorded`,
          );
        }
        return true;
      }

      const entry = exceptions.get(base);
      if (entry === undefined) {
        unmatched.push(component);
        return false;
      }

      const scopes = entry.packages ?? [];
      if (scopes.length === 0) {
        exceptionsUsed.push(base);
        notes.push(
          `${base}: reviewed exception declares no package scope; applied to ${packageName}`,
        );
        return true;
      }

      if (scopes.some((glob) => globToRegExp(glob).test(packageName))) {
        exceptionsUsed.push(base);
        return true;
      }

      unmatched.push(`${base} (reviewed exception does not cover ${packageName})`);
      return false;
    };

    const results = components.map(check);
    const ok = mixedExpression
      ? components.length > 0 && results.every(Boolean)
      : hasOr
        ? results.some(Boolean)
        : results.every(Boolean);

    return {
      ok,
      unmatched: ok ? [] : dedupe(unmatched),
      exceptionsUsed: dedupe(exceptionsUsed),
      notes,
    };
  };
}
