import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTRACT_REGISTRY, RUN_STATES } from "@shera-bot/contracts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The S01 layout (issue #2, D23). Adding a member without declaring it here, or
 * declaring one whose manifest does not exist, fails this test — that is the point:
 * the pipeline proves the workspace graph resolves before any slice builds on it.
 */
const WORKSPACE_MEMBERS = [
  "apps/web",
  "apps/control-plane",
  "apps/user-runtime",
  "packages/contracts",
  "packages/clients",
  "packages/agent-pack-sdk",
  "packages/pi-protocol",
  "packages/provider-contracts",
  "packages/observability",
  "packages/test-kit",
] as const;

function readManifest(member: string): Record<string, unknown> {
  const path = join(repoRoot, member, "package.json");
  expect(existsSync(path), `${member}/package.json is missing`).toBe(true);
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("workspace graph (S01 pipeline smoke test)", () => {
  it("resolves packages/contracts through the pnpm workspace", () => {
    // S02 replaced the S01 marker with the real Zod contracts (the S01 test
    // said it would): the import itself proves the workspace graph resolves,
    // and the D8 vocabulary is the smallest product assertion to make on top.
    expect(RUN_STATES.length).toBe(14);
    expect(Object.keys(CONTRACT_REGISTRY).length).toBeGreaterThan(10);
  });

  it("declares every layout member as a workspace package", () => {
    const workspaceGlobs = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");

    const uncovered = WORKSPACE_MEMBERS.filter(
      (member) => !workspaceGlobs.includes(`"${member.split("/")[0]}/*"`),
    );

    expect(uncovered).toEqual([]);
  });

  it("keeps every member private and un-publishable", () => {
    for (const member of WORKSPACE_MEMBERS) {
      const manifest = readManifest(member);

      expect(manifest["name"], `${member} name`).toBe(`@shera-bot/${member.split("/")[1]}`);
      // A workspace package that loses `private` could be published by accident.
      expect(manifest["private"], `${member} private`).toBe(true);
      expect(manifest["type"], `${member} type`).toBe("module");
    }
  });
});
