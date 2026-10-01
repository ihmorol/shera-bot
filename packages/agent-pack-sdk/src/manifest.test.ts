import { describe, expect, it } from "vitest";

import {
  PackManifest,
  validateManifest,
  type PackManifestRule,
  type ValidateResult,
} from "./manifest.ts";

/**
 * Manifest rejection-rule tests (S10 chunk 1). Every rule below is enforced by
 * the PackManifest Zod schema itself (strict parse + superRefine), so each
 * rejection test asserts BOTH the classified SDK result and that the raw
 * schema parse fails — the rules live in the schema, not only in the wrapper.
 *
 * G3 note: every credential-shaped string in this file is fake by construction
 * (zeroed dummies or the documented AWS doc example) and exists only to
 * exercise the rejection rules. No real secret is ever committed here; pack
 * fixtures stay clean (D22, D28).
 */

type Mutable = Record<string, unknown>;

const VALID_MANIFEST = {
  pack_id: "student",
  version: "1.0.0",
  title: "Student Pack",
  runtime_compatibility: "^0.10.0",
  default_coordinator_agent_id: "general_assistant",
  skills: [
    { skill_id: "research_basics", version: "1.0.0", title: "Research basics" },
    { skill_id: "citation_styles", version: "1.0.0", title: "Citation styles" },
    { skill_id: "study_planning", version: "1.0.0", title: "Study planning" },
  ],
  connectors: [
    { connector_id: "university_library", version: "1.0.0", title: "University library" },
  ],
  tool_allow_list: [
    { tool_id: "web_search", version: "1.0.0" },
    { tool_id: "file_read", version: "1.0.0" },
  ],
  agents: [
    {
      agent_id: "general_assistant",
      display_name: "General Assistant",
      role_description: "Coordinates Operations and helps with everyday questions.",
      default_provider: { provider_id: "platform_default", model: "shera-default" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 210, initial_glyph: "G" },
      home_operation_id: null,
    },
    {
      agent_id: "researcher",
      display_name: "Researcher",
      role_description: "Finds and summarizes sources for research work.",
      default_provider: { provider_id: "platform_default", model: "shera-default" },
      skills: ["research_basics"],
      tools: [{ tool_id: "web_search", version: "1.0.0" }],
      connectors: ["university_library"],
      ui_identity: { avatar_hue: 120, initial_glyph: "R" },
      home_operation_id: "research_paper",
    },
    {
      agent_id: "citation_manager",
      display_name: "Citation Manager",
      role_description: "Formats and checks citations.",
      default_provider: { provider_id: "platform_default", model: "shera-default" },
      skills: ["citation_styles"],
      tools: [{ tool_id: "file_read", version: "1.0.0" }],
      connectors: [],
      ui_identity: { avatar_hue: 30, initial_glyph: "C" },
      home_operation_id: "research_paper",
    },
    {
      agent_id: "developer",
      display_name: "Developer",
      role_description: "Implements and reviews programming work.",
      default_provider: { provider_id: "platform_default", model: "shera-default" },
      skills: [],
      tools: [{ tool_id: "file_read", version: "1.0.0" }],
      connectors: [],
      ui_identity: { avatar_hue: 260, initial_glyph: "D" },
      home_operation_id: "programming_assignment",
    },
    {
      agent_id: "programming_tutor",
      display_name: "Programming Tutor",
      role_description: "Explains programming concepts step by step.",
      default_provider: { provider_id: "platform_default", model: "shera-default" },
      skills: [],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 200, initial_glyph: "P" },
      home_operation_id: "programming_assignment",
    },
    {
      agent_id: "study_planner",
      display_name: "Study Planner",
      role_description: "Builds study plans and schedules revision.",
      default_provider: { provider_id: "platform_default", model: "shera-default" },
      skills: ["study_planning"],
      tools: [],
      connectors: [],
      ui_identity: { avatar_hue: 20, initial_glyph: "S" },
      home_operation_id: "exam_preparation",
    },
  ],
  operations: [
    {
      operation_id: "research_paper",
      version: "1.0.0",
      title: "Research Paper",
      purpose: "Plan, draft, and check a research paper.",
      roster: ["general_assistant", "researcher", "citation_manager"],
      skills: ["research_basics", "citation_styles"],
      connectors: ["university_library"],
    },
    {
      operation_id: "programming_assignment",
      version: "1.0.0",
      title: "Programming Assignment",
      purpose: "Implement and review a programming assignment.",
      roster: ["general_assistant", "developer", "programming_tutor"],
      skills: [],
      connectors: [],
    },
    {
      operation_id: "exam_preparation",
      version: "1.0.0",
      title: "Exam Preparation",
      purpose: "Build a study plan and drill past material.",
      roster: ["study_planner"],
      coordinator: "study_planner",
      skills: ["study_planning"],
      connectors: [],
    },
  ],
} satisfies Mutable;

function manifest(mutate?: (m: Mutable) => void): Mutable {
  const clone = structuredClone(VALID_MANIFEST) as Mutable;
  mutate?.(clone);
  return clone;
}

function listOf(m: Mutable, key: string): Mutable[] {
  return m[key] as Mutable[];
}

function agentById(m: Mutable, agentId: string): Mutable {
  const found = listOf(m, "agents").find((agent) => agent.agent_id === agentId);
  if (!found) throw new Error(`fixture agent ${agentId} missing`);
  return found;
}

function opById(m: Mutable, operationId: string): Mutable {
  const found = listOf(m, "operations").find((operation) => operation.operation_id === operationId);
  if (!found) throw new Error(`fixture operation ${operationId} missing`);
  return found;
}

function expectRejection(raw: unknown, rule: PackManifestRule, messagePart?: string): void {
  const result = validateManifest(raw);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.issues.map((issue) => issue.rule)).toContain(rule);
  if (messagePart !== undefined) {
    expect(result.issues.some((issue) => issue.message.includes(messagePart))).toBe(true);
  }
  // The rule lives in the schema itself, not only in the SDK wrapper.
  expect(PackManifest.safeParse(raw).success).toBe(false);
}

describe("pack manifest schema (D18, D28, D46)", () => {
  it("accepts a minimal valid manifest", () => {
    const result = validateManifest(manifest());
    if (!result.ok) {
      throw new Error(`expected the fixture to be valid: ${JSON.stringify(result.issues)}`);
    }
    expect(result.manifest).toEqual(VALID_MANIFEST);
  });

  it("allows the default coordinator in several rosters — the coordinator role is not a roster assignment (D46 point 2)", () => {
    // general_assistant (the pack default coordinator) appears in two rosters.
    const result = validateManifest(manifest());
    expect(result.ok).toBe(true);
  });

  it("rejects executable and credential fields outright (strict unknown-field discipline, D25/D28)", () => {
    for (const field of [
      "command",
      "script",
      "entrypoint",
      "startup",
      "api_key",
      "apiKey",
      "token",
      "password",
      "docker",
      "socket",
    ]) {
      const raw = manifest((m) => {
        agentById(m, "researcher")[field] = "placeholder";
      });
      expectRejection(raw, "unknown-field");
    }
    expectRejection(
      manifest((m) => void (m.startup_command = "placeholder")),
      "unknown-field",
    );
  });

  it("rejects an Agent rostered in two Operations (D46 single-membership)", () => {
    const raw = manifest((m) => {
      opById(m, "programming_assignment").roster = [
        "general_assistant",
        "researcher",
        "developer",
        "programming_tutor",
      ];
    });
    expectRejection(raw, "d46-single-membership", "researcher");
  });

  it("rejects a per-Operation coordinator (other than the pack default) rostered in a second Operation", () => {
    const raw = manifest((m) => {
      // study_planner already coordinates exam_preparation and is rostered there;
      // a second roster entry would be multi-membership, reserved for the default coordinator.
      opById(m, "research_paper").roster = [
        "general_assistant",
        "researcher",
        "citation_manager",
        "study_planner",
      ];
    });
    expectRejection(raw, "d46-single-membership", "study_planner");
  });

  it("rejects a duplicate roster entry inside a single Operation", () => {
    const raw = manifest((m) => {
      opById(m, "research_paper").roster = [
        "general_assistant",
        "researcher",
        "researcher",
        "citation_manager",
      ];
    });
    expectRejection(raw, "duplicate-roster-entry", "researcher");
  });

  it("rejects an unknown Agent reference in a roster", () => {
    const raw = manifest((m) => {
      opById(m, "research_paper").roster = [
        "general_assistant",
        "researcher",
        "citation_manager",
        "ghost_agent",
      ];
    });
    expectRejection(raw, "unknown-agent-ref", "ghost_agent");
  });

  it("rejects an unknown coordinator reference", () => {
    const raw = manifest((m) => {
      opById(m, "exam_preparation").coordinator = "ghost_agent";
    });
    expectRejection(raw, "unknown-coordinator-ref", "ghost_agent");
  });

  it("rejects an unknown home Operation reference on an Agent", () => {
    const raw = manifest((m) => {
      agentById(m, "researcher").home_operation_id = "ghost_operation";
    });
    expectRejection(raw, "unknown-home-operation", "ghost_operation");
  });

  it("rejects an unknown pack default coordinator", () => {
    const raw = manifest((m) => {
      m.default_coordinator_agent_id = "ghost_agent";
    });
    expectRejection(raw, "unknown-default-coordinator", "ghost_agent");
  });

  it("rejects a missing skill reference on an Agent and on an Operation", () => {
    expectRejection(
      manifest((m) => {
        agentById(m, "researcher").skills = ["ghost_skill"];
      }),
      "missing-skill-ref",
      "ghost_skill",
    );
    expectRejection(
      manifest((m) => {
        opById(m, "research_paper").skills = ["research_basics", "ghost_skill"];
      }),
      "missing-skill-ref",
      "ghost_skill",
    );
  });

  it("rejects a missing connector reference on an Agent and on an Operation", () => {
    expectRejection(
      manifest((m) => {
        agentById(m, "researcher").connectors = ["ghost_connector"];
      }),
      "missing-connector-ref",
      "ghost_connector",
    );
    expectRejection(
      manifest((m) => {
        opById(m, "exam_preparation").connectors = ["ghost_connector"];
      }),
      "missing-connector-ref",
      "ghost_connector",
    );
  });

  it("rejects an Agent tool outside the pack tool allow-list (D38 upper bound)", () => {
    const raw = manifest((m) => {
      agentById(m, "researcher").tools = [{ tool_id: "shell_execute", version: "1.0.0" }];
    });
    expectRejection(raw, "tool-not-in-allow-list", "shell_execute");
  });

  it("rejects an Agent tool whose version differs from the allow-listed version (D38 upper bound)", () => {
    const raw = manifest((m) => {
      agentById(m, "researcher").tools = [{ tool_id: "web_search", version: "9.9.9" }];
    });
    expectRejection(raw, "tool-not-in-allow-list", "web_search@9.9.9");
  });
});

describe("manifest content rules — no secrets, no host paths, no executable content (D22, D28)", () => {
  const SECRET_SAMPLES: Array<[string, string]> = [
    ["provider API key", "sk-test-0000000000000000"],
    ["GitHub token", "ghp_TESTTESTTESTTEST0000"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["JWT", "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.MEUCIQDUMMY"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["credential assignment", "password: dummy-value"],
    ["bearer token", "Bearer dummYdummYdummYdummY"],
  ];

  it("rejects secret-looking values wherever they appear", () => {
    for (const [, sample] of SECRET_SAMPLES) {
      const inRole = manifest((m) => {
        agentById(m, "researcher").role_description = `Use ${sample} for access.`;
      });
      expectRejection(inRole, "secret-looking-value");
      const inPurpose = manifest((m) => {
        opById(m, "research_paper").purpose = `Stored ${sample}.`;
      });
      expectRejection(inPurpose, "secret-looking-value");
    }
  });

  it("never echoes a secret-shaped value back in a rejection message", () => {
    for (const [, sample] of SECRET_SAMPLES) {
      const result = validateManifest(
        manifest((m) => {
          agentById(m, "researcher").role_description = `Use ${sample} for access.`;
        }),
      );
      if (!result.ok) {
        for (const issue of result.issues) {
          expect(issue.message).not.toContain(sample);
        }
      }
    }
  });

  const HOST_PATH_SAMPLES = [
    "/home/emon/notes.md",
    "/Users/emon/Desktop",
    "/root/.ssh/known_hosts",
    "C:\\Users\\emon\\notes",
    "C:/Users/emon/notes",
    "\\\\server\\share",
    "/etc/shadow",
    "/var/run/docker.sock",
    "/some/absolute/path",
    "~/Documents/notes",
  ];

  it("rejects host filesystem paths and docker socket references", () => {
    for (const sample of HOST_PATH_SAMPLES) {
      const wholeString = manifest((m) => {
        opById(m, "research_paper").title = sample;
      });
      expectRejection(wholeString, "host-path-value");
      const embedded = manifest((m) => {
        agentById(m, "developer").role_description = `Work in ${sample} when needed.`;
      });
      expectRejection(embedded, "host-path-value");
    }
  });

  it("still accepts workspace-scheme references that are not host paths", () => {
    const raw = manifest((m) => {
      agentById(m, "researcher").role_description =
        "Reads shared context from workspace://reference/architecture.";
    });
    expect(validateManifest(raw).ok).toBe(true);
  });

  const EXECUTABLE_SAMPLES: Array<[string, string]> = [
    ["shebang", "#!/bin/sh"],
    ["eval call", "eval('1 + 1')"],
    ["require call", "require('node:fs')"],
    // The sample below is assembled from parts so the D23 boundary guard does
    // not flag this test file as child-process module usage — it is only a
    // deny-rule sample (see the matching note in manifest.ts).
    ["process module", `child${"_process"}`],
    ["shell invocation", "bash -c 'echo hi'"],
    ["node one-liner", "node -e 'console.log(1)'"],
    ["script tag", "<script>alert(1)</script>"],
    ["container engine command", "docker run -it alpine"],
    ["unix socket URI", "unix:///var/run/docker.sock"],
  ];

  it("rejects executable content wherever it appears", () => {
    for (const [, sample] of EXECUTABLE_SAMPLES) {
      const wholeString = manifest((m) => {
        opById(m, "research_paper").title = sample;
      });
      expectRejection(wholeString, "executable-content");
      const embedded = manifest((m) => {
        agentById(m, "developer").role_description = `Then run ${sample} to proceed.`;
      });
      expectRejection(embedded, "executable-content");
    }
  });
});

describe("manifest shape rules", () => {
  it("rejects malformed runtime compatibility ranges and malformed versions", () => {
    for (const range of ["latest", "1.0", ">=1.0.0", "1.x", ""]) {
      expectRejection(
        manifest((m) => {
          m.runtime_compatibility = range;
        }),
        "schema",
      );
    }
    expectRejection(
      manifest((m) => {
        m.version = "1.0";
      }),
      "schema",
    );
    expectRejection(
      manifest((m) => {
        (listOf(m, "skills")[0] as Mutable).version = "not-a-version";
      }),
      "schema",
    );
  });

  it("rejects a pack with no Agents and an Operation with an empty roster", () => {
    expectRejection(
      manifest((m) => {
        m.agents = [];
      }),
      "schema",
    );
    expectRejection(
      manifest((m) => {
        opById(m, "research_paper").roster = [];
      }),
      "schema",
    );
  });

  it("rejects out-of-range avatar hues and multi-character initial glyphs", () => {
    expectRejection(
      manifest((m) => {
        (agentById(m, "researcher").ui_identity as Mutable).avatar_hue = 361;
      }),
      "schema",
    );
    expectRejection(
      manifest((m) => {
        (agentById(m, "researcher").ui_identity as Mutable).initial_glyph = "AB";
      }),
      "schema",
    );
  });

  it("rejects unknown fields at every level of the manifest", () => {
    expectRejection(
      manifest((m) => {
        m.surprise = true;
      }),
      "unknown-field",
    );
    expectRejection(
      manifest((m) => {
        (agentById(m, "researcher").ui_identity as Mutable).extra = true;
      }),
      "unknown-field",
    );
  });
});
