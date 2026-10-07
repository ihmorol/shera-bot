import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { BuiltInPackLoader } from "./loader.ts";
import type { PackManifest } from "./manifest.ts";

/**
 * G5 divergence test (the S10 chunk-2 AC): the committed student pack v1 and
 * the D46-aligned mockup fixture (mockup/data.js) must agree on the six-Agent
 * roster — names, role tags, avatar hues, per-Operation rosters, and
 * coordinators. Any divergence on either side fails loudly here.
 *
 * mockup/data.js is a browser-global script by design (reference evidence, not
 * a module): it defines top-level consts and exports nothing. Loading it as
 * data appends an export line to an in-memory copy, writes it to a temp .mjs
 * file, and imports that; the test fails loudly if the expected consts
 * disappear from the mockup.
 */
const REPO_ROOT = join(import.meta.dirname, "../../..");

const PACK: PackManifest = new BuiltInPackLoader().resolve("student", "1.0.0").manifest;

interface MockupAgent {
  id: string;
  name: string;
  hue: string;
  role: string;
}

interface MockupOperation {
  id: string;
  name: string;
  coordinator: string;
  agents: string[];
}

interface MockupFixture {
  AGENTS: MockupAgent[];
  OP_TEMPLATES: MockupOperation[];
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function loadMockupFixture(): Promise<MockupFixture> {
  const source = readFileSync(join(REPO_ROOT, "mockup", "data.js"), "utf8");
  if (!/const AGENTS = \[/m.test(source) || !/const OP_TEMPLATES = \[/m.test(source)) {
    throw new Error(
      "mockup/data.js no longer defines the AGENTS/OP_TEMPLATES fixtures — update this divergence test against the renamed fixture",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "shera-mockup-"));
  tempDirs.push(dir);
  const file = join(dir, "mockup-data.mjs");
  writeFileSync(file, `${source}\nexport { AGENTS, OP_TEMPLATES };\n`);
  return (await import(pathToFileURL(file).href)) as MockupFixture;
}

/** Role tags pinned from the D46-aligned mockup; a swap of two roles must fail. */
const MOCKUP_ROLE_TAGS: Record<string, string> = {
  "General Assistant": "Coordinator · planning & synthesis",
  Researcher: "Evidence-backed investigation",
  Developer: "Code, repos & tooling",
  "Citation Manager": "Sources & reference integrity",
  "Programming Tutor": "Code comprehension & practice",
  "Study Planner": "Schedules & exam readiness",
};

/** Hue degrees from the mockup avatar hex colors (same conversion the pack used). */
function hueFromHex(hex: string): number {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  const red = ((value >> 16) & 255) / 255;
  const green = ((value >> 8) & 255) / 255;
  const blue = (value & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
  }
  hue = Math.round(hue * 60);
  return hue < 0 ? hue + 360 : hue;
}

describe("pack ↔ mockup divergence (G5, D46-aligned fixture)", () => {
  it("declares exactly the mockup's six Agents — names, role tags, avatar hues", async () => {
    const mockup = await loadMockupFixture();
    const packAgents = new Map(PACK.agents.map((agent) => [agent.display_name, agent]));
    expect([...packAgents.keys()].sort()).toEqual(mockup.AGENTS.map((agent) => agent.name).sort());
    for (const mockupAgent of mockup.AGENTS) {
      const packAgent = packAgents.get(mockupAgent.name);
      expect(packAgent, `pack Agent "${mockupAgent.name}" missing`).toBeDefined();
      if (!packAgent) continue;
      expect(
        MOCKUP_ROLE_TAGS[mockupAgent.name],
        `no pinned role tag for mockup Agent "${mockupAgent.name}"`,
      ).toBe(mockupAgent.role);
      expect(packAgent.ui_identity.avatar_hue).toBe(hueFromHex(mockupAgent.hue));
    }
  });

  it("matches the mockup roster and coordinator for every pack-defined Operation", async () => {
    const mockup = await loadMockupFixture();
    const agentName = new Map(PACK.agents.map((agent) => [agent.agent_id, agent.display_name]));
    const mockupName = new Map(mockup.AGENTS.map((agent) => [agent.id, agent.name]));
    expect(PACK.operations).toHaveLength(mockup.OP_TEMPLATES.length);

    for (const template of mockup.OP_TEMPLATES) {
      const operation = PACK.operations.find((op) => op.title === template.name);
      expect(operation, `pack Operation "${template.name}" missing`).toBeDefined();
      if (!operation) continue;

      const rosterNames = operation.roster
        .map((agentId) => {
          const name = agentName.get(agentId);
          expect(name, `roster references unknown pack Agent ${agentId}`).toBeDefined();
          return name as string;
        })
        .sort();
      const expectedNames = template.agents
        .map((id) => {
          const name = mockupName.get(id);
          expect(name, `mockup roster references unknown agent ${id}`).toBeDefined();
          return name as string;
        })
        .sort();
      expect(rosterNames).toEqual(expectedNames);

      const coordinatorId = operation.coordinator ?? PACK.default_coordinator_agent_id;
      const coordinatorName = agentName.get(coordinatorId);
      expect(coordinatorName, `coordinator ${coordinatorId} is not a declared Agent`).toBeDefined();
      expect(coordinatorName).toBe(mockupName.get(template.coordinator));
    }
  });
});
