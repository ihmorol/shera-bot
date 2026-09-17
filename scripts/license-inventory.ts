#!/usr/bin/env node
/**
 * Dependency and license inventory gate (PRD §22.22, §23; S01 acceptance criteria).
 *
 * Reads the installed dependency tree with `pnpm licenses list --json`, evaluates every
 * license expression against scripts/license-policy.json (via the tested evaluator in
 * scripts/license-expression.ts), writes the full inventory to
 * artifacts/license-inventory.json, and exits non-zero when a dependency carries a license
 * that is neither allowed nor covered by a matching reviewed exception.
 *
 * The artifact is written even when the gate fails, so a failing CI run still hands over
 * the inventory it rejected.
 *
 * Run directly with Node's TypeScript support: `pnpm license:inventory`.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createEvaluator, type LicensePolicy } from "./license-expression.ts";

type PnpmLicenseEntry = {
  name: string;
  versions?: string[];
  license?: string;
  description?: string;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(repoRoot, "scripts", "license-policy.json");
const artifactPath = join(repoRoot, "artifacts", "license-inventory.json");

const policy = JSON.parse(readFileSync(policyPath, "utf8")) as LicensePolicy;
const evaluate = createEvaluator(policy);

function readInstalledTree(): Record<string, PnpmLicenseEntry[]> {
  // A single literal command string: on Windows pnpm resolves to a .cmd shim, which Node
  // can only launch through a shell. Passing an args array with shell:true is deprecated
  // (DEP0190), so the command goes in whole.
  const result = spawnSync("pnpm licenses list --json", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`pnpm licenses list failed (${result.status}): ${result.stderr ?? ""}`);
  }

  return JSON.parse(result.stdout) as Record<string, PnpmLicenseEntry[]>;
}

const tree = readInstalledTree();
const packages: { name: string; version: string; license: string }[] = [];
const failures: { name: string; version: string; license: string; unmatched: string[] }[] = [];
const exceptionsApplied: { name: string; version: string; license: string; exception: string }[] =
  [];
const notes: { name: string; note: string }[] = [];
const exceptionsUsedOverall = new Set<string>();
const byLicense: Record<string, number> = {};

for (const [license, entries] of Object.entries(tree)) {
  byLicense[license] = (byLicense[license] ?? 0) + entries.length;

  for (const entry of entries) {
    const version = (entry.versions ?? []).join(", ");
    packages.push({ name: entry.name, version, license });

    const verdict = evaluate(license, entry.name);

    if (!verdict.ok) {
      failures.push({ name: entry.name, version, license, unmatched: verdict.unmatched });
    }

    for (const exception of verdict.exceptionsUsed) {
      exceptionsUsedOverall.add(exception);
      exceptionsApplied.push({ name: entry.name, version, license, exception });
    }

    for (const note of verdict.notes) {
      notes.push({ name: entry.name, note });
    }
  }
}

packages.sort((a, b) => a.name.localeCompare(b.name));

const exceptionsUnused = policy.reviewedExceptions
  .map((entry) => entry.license)
  .filter((license) => !exceptionsUsedOverall.has(license));

const artifact = {
  generatedBy: "scripts/license-inventory.ts",
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform },
  source: "pnpm licenses list --json",
  policy: { allowed: policy.allowed, reviewedExceptions: policy.reviewedExceptions },
  summary: {
    // Counts are platform-dependent: optional platform binaries (for example @img/sharp-*)
    // differ between the Windows development machine and the Linux CI runner.
    totalPackages: packages.length,
    distinctLicenses: Object.keys(byLicense).length,
    byLicense,
    failures: failures.length,
    exceptionsApplied: exceptionsApplied.length,
    exceptionsUnused,
  },
  exceptionsApplied,
  notes,
  failures,
  packages,
};

mkdirSync(dirname(artifactPath), { recursive: true });
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

console.log(
  `License inventory: ${packages.length} packages, ${Object.keys(byLicense).length} distinct licenses`,
);
for (const [license, count] of Object.entries(byLicense).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}

if (exceptionsApplied.length > 0) {
  const names = [...new Set(exceptionsApplied.map((entry) => entry.name))];
  console.log(`\nReviewed exceptions applied (owner review pending): ${names.join(", ")}`);
}

if (exceptionsUnused.length > 0) {
  console.log(
    `\nReviewed exceptions that matched no installed package: ${exceptionsUnused.join(", ")}`,
  );
  console.log(
    "Remove them from scripts/license-policy.json, or confirm the dependency is still installed.",
  );
}

console.log(`\nInventory written to ${artifactPath.replace(repoRoot, ".")}`);

if (failures.length > 0) {
  console.error(`\nUnreviewed licenses found in ${failures.length} package(s):`);
  for (const failure of failures) {
    console.error(
      `  ${failure.name}@${failure.version} — ${failure.license} (unmatched: ${failure.unmatched.join(", ")})`,
    );
  }
  console.error(
    "\nAdd the license to scripts/license-policy.json with a written rationale, alternatives,",
  );
  console.error("and package scope — or replace the dependency.");
  console.error("Do not widen the policy to make a build pass (PRD §23).");
  process.exit(1);
}

console.log("\nAll licenses are allowed or covered by a matching reviewed exception.");
