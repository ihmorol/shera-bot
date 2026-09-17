#!/usr/bin/env node
/**
 * Dependency and license inventory gate (PRD §22.22, §23; S01 acceptance criteria).
 *
 * Reads the installed dependency tree with `pnpm licenses list --json`, evaluates every
 * license expression against scripts/license-policy.json, writes the full inventory to
 * artifacts/license-inventory.json, and exits non-zero when a dependency carries a
 * license that is neither allowed nor a recorded reviewed exception.
 *
 * The artifact is written even when the gate fails, so a failing CI run still hands over
 * the inventory it rejected.
 *
 * Usage: pnpm license:inventory
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const policyPath = join(repoRoot, "scripts", "license-policy.json");
const artifactPath = join(repoRoot, "artifacts", "license-inventory.json");

const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const allowed = new Set(policy.allowed);
const exceptions = new Map(policy.reviewedExceptions.map((entry) => [entry.license, entry]));

/**
 * `A OR B` passes when either side passes; `A AND B` requires both sides. A component is
 * satisfied when it is allowed outright or carries a recorded reviewed exception.
 * Returns the unmatched components and, when the expression passes, which exceptions
 * were relied on.
 */
function evaluateExpression(expression) {
  const unmatched = [];
  const used = new Set();

  const operandPasses = (operand) => {
    const components = operand
      .split(/\s+AND\s+/i)
      .map((part) => part.trim())
      .filter(Boolean);

    return components.every((component) => {
      if (allowed.has(component)) return true;
      if (exceptions.has(component)) {
        used.add(component);
        return true;
      }
      unmatched.push(component);
      return false;
    });
  };

  const ok = expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .some(operandPasses);

  return { ok, unmatched: [...new Set(unmatched)], exceptionsUsed: ok ? [...used] : [] };
}

function readInstalledTree() {
  // A single literal command string: on Windows pnpm resolves to a .cmd shim, which
  // Node can only launch through a shell. Passing an args array with shell:true is
  // deprecated (DEP0190), so the command goes in whole.
  const result = spawnSync("pnpm licenses list --json", {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`pnpm licenses list failed (${result.status}): ${result.stderr || ""}`);
  }

  return JSON.parse(result.stdout);
}

const tree = readInstalledTree();
const packages = [];
const failures = [];
const exceptionsApplied = [];
const byLicense = {};

for (const [license, entries] of Object.entries(tree)) {
  byLicense[license] = (byLicense[license] ?? 0) + entries.length;
  const verdict = evaluateExpression(license);

  for (const entry of entries) {
    const version = (entry.versions ?? []).join(", ");
    packages.push({ name: entry.name, version, license });

    if (!verdict.ok) {
      failures.push({ name: entry.name, version, license, unmatched: verdict.unmatched });
    }

    for (const exception of verdict.exceptionsUsed) {
      exceptionsApplied.push({ name: entry.name, version, license, exception });
    }
  }
}

packages.sort((a, b) => a.name.localeCompare(b.name));

const artifact = {
  generatedBy: "scripts/license-inventory.mjs",
  generatedAt: new Date().toISOString(),
  runtime: { node: process.version, platform: process.platform },
  source: "pnpm licenses list --json",
  policy: { allowed: policy.allowed, reviewedExceptions: policy.reviewedExceptions },
  summary: {
    totalPackages: packages.length,
    distinctLicenses: Object.keys(byLicense).length,
    byLicense,
    failures: failures.length,
  },
  exceptionsApplied,
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

console.log(`\nInventory written to ${artifactPath.replace(repoRoot, ".")}`);

if (failures.length > 0) {
  console.error(`\nUnreviewed licenses found in ${failures.length} package(s):`);
  for (const failure of failures) {
    console.error(
      `  ${failure.name}@${failure.version} — ${failure.license} (unmatched: ${failure.unmatched.join(", ")})`,
    );
  }
  console.error(
    "\nAdd the license to scripts/license-policy.json with a written rationale and alternatives,",
  );
  console.error(
    "or replace the dependency. Do not widen the policy to make a build pass (PRD §23).",
  );
  process.exit(1);
}

console.log("\nAll licenses are allowed or recorded as reviewed exceptions.");
