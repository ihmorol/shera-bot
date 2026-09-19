/**
 * S06 runtime portability grep test (issue #7, AC5).
 *
 * PRD §6.1: the runtime API is provider-neutral; product behavior must not
 * depend on engine-specific paths or APIs. D23 rule 2: no container-engine
 * API outside provisioning adapters.
 *
 * This test greps the ENTIRE runtime API surface — the shared contract, the
 * generated clients, the user-runtime gateway sources, the test-kit fake,
 * the control-plane web routes, the provisioning service, and the channel
 * code — for container-engine vocabulary. The ONLY files allowed to speak
 * engine dialect are apps/control-plane/src/runtime/local-container-backend.ts
 * and container-spec.ts (the provisioning adapter), which are excluded here.
 * If engine vocabulary leaks anywhere else, a remote/cloud backend could no
 * longer implement the same contract and this test fails.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files that implement the local engine adapter (the ONLY sanctioned home of engine vocabulary). */
const ADAPTER_FILES = new Set([
  join(repoRoot, "apps", "control-plane", "src", "runtime", "local-container-backend.ts"),
  join(repoRoot, "apps", "control-plane", "src", "runtime", "container-spec.ts"),
]);

const SCAN_ROOTS: string[] = [
  join(repoRoot, "packages", "contracts", "src"),
  join(repoRoot, "packages", "test-kit", "src"),
  join(repoRoot, "packages", "clients", "src"),
  join(repoRoot, "apps", "user-runtime", "src"),
  join(repoRoot, "apps", "control-plane", "src", "modules"),
  join(repoRoot, "apps", "control-plane", "src", "auth"),
];

const SCAN_FILES: string[] = [
  join(repoRoot, "apps", "control-plane", "src", "routes.ts"),
  join(repoRoot, "packages", "clients", "openapi.json"),
  join(repoRoot, "apps", "user-runtime", "package.json"),
  join(repoRoot, "packages", "contracts", "package.json"),
];

/** Engine API vocabulary: none of this may appear in the runtime API surface. */
const BANNED_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["engine package name", /dockerode/i],
  ["engine CLI/process", /\bdocker\b/i],
  ["engine socket", /docker\.sock/i],
  ["engine socket root", /\/var\/run\//i],
  ["engine CPU field", /NanoCpus/],
  ["engine CPU period field", /CpuPeriod/],
  ["engine CPU quota field", /CpuQuota/],
  ["engine memory-swap field", /MemorySwap/],
  ["engine host config", /HostConfig/],
  ["engine restart policy", /RestartPolicy/],
  ["engine health config", /HealthConfig/],
  ["engine create call", /createContainer/],
  ["engine get call", /getContainer/],
  ["engine list call", /listContainers/],
  ["engine image flag", /\b--image\b/],
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (full.endsWith(".ts") || full.endsWith(".json")) {
      yield full;
    }
  }
}

function collectSurfaceFiles(): string[] {
  const files = new Set<string>(SCAN_FILES);
  for (const root of SCAN_ROOTS) {
    for (const file of walk(root)) {
      files.add(file);
    }
  }
  return [...files].filter((file) => !ADAPTER_FILES.has(file)).sort();
}

describe("runtime API surface is container-engine-neutral (PRD §6.1, D23 rule 2)", () => {
  it("contains no engine-specific path, API, or dependency anywhere in the surface", () => {
    const violations: string[] = [];
    for (const file of collectSurfaceFiles()) {
      const content = readFileSync(file, "utf8");
      for (const [label, pattern] of BANNED_PATTERNS) {
        const match = pattern.exec(content);
        if (match) {
          const line = content.slice(0, match.index).split("\n").length;
          violations.push(`${file}:${line} ${label} → "${match[0]}"`);
        }
      }
    }
    expect(
      violations,
      `engine vocabulary leaked into the runtime API surface:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps the engine client out of the web app (dockerode belongs to the provisioning dependency only)", () => {
    const webPackage = JSON.parse(
      readFileSync(join(repoRoot, "apps", "web", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...webPackage.dependencies, ...webPackage.devDependencies };
    expect(Object.keys(all).filter((name) => /docker/i.test(name))).toEqual([]);
  });

  it("actually scans the load-bearing surface (no vacuous pass)", () => {
    const files = collectSurfaceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith("runtime.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("internal-api.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("fake-container-backend.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("routes.ts"))).toBe(true);
    // The adapter files are the exclusion set — they must exist so the
    // exclusion is real and not an accident of a missing file.
    for (const adapter of ADAPTER_FILES) {
      expect(statSync(adapter).isFile(), `${adapter} must exist`).toBe(true);
    }
  });
});
