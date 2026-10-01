import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkCompatibility } from "./compatibility.ts";
import { verifyIntegrity } from "./integrity.ts";
import { BuiltInPackLoader } from "./loader.ts";
import type { PackManifest } from "./manifest.ts";

/**
 * S10 chunk 2: end-to-end contract for the committed student pack v1
 * (agent-packs/student/v1, D43 scope + D46 roster mapping). These tests load
 * the REAL in-repo pack through the default BuiltInPackLoader — the same path
 * chunk 3's workspace pinning will use — and pin:
 *
 *   - the D46 roster mapping exactly (including the General Assistant's
 *     coordinator-role presence in two rosters, which is not roster membership);
 *   - the PRD §5.1–5.6 role text, verbatim, read from docs/PRD.md at test time
 *     so any drift on either side fails;
 *   - integrity (the committed manifest.sha256 sidecar) and runtime
 *     compatibility (against the version declared by apps/user-runtime);
 *   - the G1 vocabulary rule over everything shipped under agent-packs/.
 *
 * Pack ids chosen and documented in agent-packs/README.md: pack_id "student",
 * version "1.0.0", directory agent-packs/student/v1/, agent/operation/skill/
 * tool/connector ids consistent with the S08 fixture vocabulary
 * (apps/web/lib/fixtures/pack.ts).
 */
const REPO_ROOT = join(import.meta.dirname, "../../..");
const PACK_DIR = join(REPO_ROOT, "agent-packs", "student", "v1");

const PACK: PackManifest = new BuiltInPackLoader().resolve("student", "1.0.0").manifest;

/** D46 mapping table, verbatim (docs/decisions/open-items-decisions-2026-09-17.md, D46 point 4). */
const D46_OPERATIONS: Array<{
  operation_id: string;
  title: string;
  coordinator: string | null;
  roster: string[];
}> = [
  {
    operation_id: "operation_research_paper",
    title: "Research Paper",
    coordinator: null,
    roster: ["agent_general_assistant", "agent_researcher", "agent_citation_manager"],
  },
  {
    operation_id: "operation_programming_assignment",
    title: "Programming Assignment",
    coordinator: null,
    roster: ["agent_general_assistant", "agent_developer", "agent_programming_tutor"],
  },
  {
    operation_id: "operation_exam_preparation",
    title: "Exam Preparation",
    coordinator: "agent_study_planner",
    roster: ["agent_study_planner"],
  },
];

const D46_HOME_OPERATIONS: Record<string, string | null> = {
  agent_general_assistant: null,
  agent_researcher: "operation_research_paper",
  agent_citation_manager: "operation_research_paper",
  agent_developer: "operation_programming_assignment",
  agent_programming_tutor: "operation_programming_assignment",
  agent_study_planner: "operation_exam_preparation",
};

const PRD_SECTIONS: Record<string, string> = {
  agent_researcher: "5.1 Researcher",
  agent_developer: "5.2 Developer",
  agent_general_assistant: "5.3 General Assistant",
  agent_citation_manager: "5.4 Citation Manager",
  agent_programming_tutor: "5.5 Programming Tutor",
  agent_study_planner: "5.6 Study Planner",
};

/** First paragraph under a "### 5.x" heading — the verbatim role text. */
function prdFirstParagraph(section: string): string {
  const prd = readFileSync(join(REPO_ROOT, "docs", "PRD.md"), "utf8");
  const heading = `### ${section}`;
  const start = prd.indexOf(heading);
  if (start < 0) {
    throw new Error(`PRD section "${section}" not found — section was renamed?`);
  }
  for (const line of prd.slice(start + heading.length).split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("###")) {
      throw new Error(`PRD section "${section}" lost its role paragraph`);
    }
    return trimmed;
  }
  throw new Error(`PRD section "${section}" is empty`);
}

const VOCABULARY_EXTENSIONS = [".json", ".md"];
const VOCABULARY_SKIP_DIRS = new Set(["node_modules"]);
const BANNED_TERMS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bexperts?\b/i, reason: '"Expert" is retired — use "Agent" (D44)' },
  { pattern: /\bscenes?\b/i, reason: '"Scene" is retired — use "Operation" (D29, D44)' },
];

function listPackFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!VOCABULARY_SKIP_DIRS.has(entry)) files.push(...listPackFiles(full));
    } else if (VOCABULARY_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

describe("committed student pack v1 (D43 scope, D46 mapping)", () => {
  it("resolves end-to-end through the default BuiltInPackLoader", () => {
    expect(PACK.pack_id).toBe("student");
    expect(PACK.version).toBe("1.0.0");
    expect(PACK.agents).toHaveLength(6);
    expect(PACK.operations).toHaveLength(3);
  });

  it("ships an independently recorded manifest hash sidecar that verifies", () => {
    const sidecar = join(PACK_DIR, "manifest.sha256");
    expect(existsSync(sidecar)).toBe(true);
    expect(readFileSync(sidecar, "utf8").trim()).toBe(
      new BuiltInPackLoader().resolve("student", "1.0.0").manifest_hash,
    );
    expect(verifyIntegrity(new BuiltInPackLoader().resolve("student", "1.0.0"))).toEqual({
      ok: true,
      manifest_hash: new BuiltInPackLoader().resolve("student", "1.0.0").manifest_hash,
    });
  });

  it("is compatible with the runtime version declared by apps/user-runtime", () => {
    const runtimePackage = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "user-runtime", "package.json"), "utf8"),
    ) as { version: string };
    expect(() => checkCompatibility(PACK, runtimePackage.version)).not.toThrow();
  });

  it("implements the D46 mapping table exactly — rosters, coordinators, home Operations", () => {
    expect(PACK.default_coordinator_agent_id).toBe("agent_general_assistant");
    for (const expected of D46_OPERATIONS) {
      const operation = PACK.operations.find((op) => op.operation_id === expected.operation_id);
      expect(operation, `missing Operation ${expected.operation_id}`).toBeDefined();
      if (!operation) continue;
      expect(operation.title).toBe(expected.title);
      expect([...operation.roster].sort()).toEqual([...expected.roster].sort());
      expect(operation.coordinator ?? null).toBe(expected.coordinator);
    }
    for (const agent of PACK.agents) {
      expect(agent.home_operation_id).toBe(D46_HOME_OPERATIONS[agent.agent_id]);
    }
  });

  it("carries the PRD §5.1–5.6 role text verbatim", () => {
    for (const agent of PACK.agents) {
      const section = PRD_SECTIONS[agent.agent_id];
      expect(section, `no PRD section pinned for ${agent.agent_id}`).toBeDefined();
      expect(agent.role_description).toBe(prdFirstParagraph(section as string));
    }
  });
});

describe("vocabulary (D44) across agent-packs/", () => {
  it("never uses the retired aliases Expert or Scene in pack files", () => {
    const violations: string[] = [];
    for (const file of listPackFiles(join(REPO_ROOT, "agent-packs"))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { pattern, reason } of BANNED_TERMS) {
          if (pattern.test(line)) {
            violations.push(`${file}:${index + 1} — ${reason}: ${line.trim()}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
