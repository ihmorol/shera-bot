import { createHash } from "node:crypto";

import {
  DEFAULT_COORDINATOR_SENTINEL,
  Pack,
  type Agent,
  type OperationDefinition,
} from "@shera-bot/contracts";
import { z } from "zod";

/**
 * MOCK DATA — the §9 #1 pack fixture (student pack v1), typed with the real
 * `Pack` contract from @shera-bot/contracts so the runtime slots in later.
 * Everything in lib/fixtures is demo data for the UI-first build; it never
 * pretends to be a runtime result (G2/G4).
 */
export const STUDENT_PACK = Pack.parse({
  pack_id: "pack_student",
  version: "1.0.0",
  manifest_hash: createHash("sha256").update("pack_student/v1.0.0").digest("hex"),
  default_coordinator_agent_id: DEFAULT_COORDINATOR_SENTINEL,
  agents: [
    {
      agent_id: "agent_general_assistant",
      display_name: "General Assistant",
      role_description:
        "Default coordinator of every Operation and the everyday direct chat: plans work, delegates inside an Operation, and answers general questions.",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: ["skill_planning_core"],
      tools: [
        { tool_id: "tool_web_search", version: "1.4.0" },
        { tool_id: "tool_file_read", version: "1.2.0" },
      ],
      connectors: [],
      home_operation_id: null,
      declared_in_pack_version: "1.0.0",
    },
    {
      agent_id: "agent_researcher",
      display_name: "Researcher",
      role_description:
        "Finds, reads, and synthesizes sources for academic work, and keeps a traceable trail from claim to source.",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: ["skill_research_core"],
      tools: [
        { tool_id: "tool_web_search", version: "1.4.0" },
        { tool_id: "tool_file_read", version: "1.2.0" },
      ],
      connectors: ["connector_scholar_library"],
      home_operation_id: "operation_research_paper",
      declared_in_pack_version: "1.0.0",
    },
    {
      agent_id: "agent_developer",
      display_name: "Developer",
      role_description:
        "Writes, reviews, and debugs code in the workspace, and runs builds and tests before proposing anything risky.",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: ["skill_development_core"],
      tools: [
        { tool_id: "tool_code_exec", version: "2.0.1" },
        { tool_id: "tool_file_read", version: "1.2.0" },
      ],
      connectors: [],
      home_operation_id: "operation_programming_assignment",
      declared_in_pack_version: "1.0.0",
    },
    {
      agent_id: "agent_citation_manager",
      display_name: "Citation Manager",
      role_description:
        "Formats, checks, and organizes citations and bibliographies in the requested style.",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: ["skill_citation_core"],
      tools: [{ tool_id: "tool_file_read", version: "1.2.0" }],
      connectors: [],
      home_operation_id: "operation_research_paper",
      declared_in_pack_version: "1.0.0",
    },
    {
      agent_id: "agent_programming_tutor",
      display_name: "Programming Tutor",
      role_description:
        "Explains programming concepts step by step and coaches through assignments without taking over the work.",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: ["skill_tutoring_core"],
      tools: [{ tool_id: "tool_file_read", version: "1.2.0" }],
      connectors: [],
      home_operation_id: "operation_exam_preparation",
      declared_in_pack_version: "1.0.0",
    },
    {
      agent_id: "agent_study_planner",
      display_name: "Study Planner",
      role_description:
        "Builds study schedules, tracks progress against exam dates, and rebalances plans when deadlines move.",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
      skills: ["skill_planning_core"],
      tools: [{ tool_id: "tool_file_read", version: "1.2.0" }],
      connectors: [],
      home_operation_id: "operation_exam_preparation",
      declared_in_pack_version: "1.0.0",
    },
  ],
  operations: [
    {
      operation_id: "operation_research_paper",
      version: "1.0.0",
      title: "Research Paper",
      purpose:
        "Take a research paper from topic to submission: sources, outline, drafts, and a checked bibliography.",
      roster: ["agent_researcher", "agent_citation_manager"],
      // D42/D46: coordinator absent = the pack default (General Assistant)
      // coordinates by role; it is not a roster assignment.
      skills: ["skill_research_core", "skill_citation_core", "skill_writing_core"],
      connectors: ["connector_scholar_library"],
      content_hash: createHash("sha256").update("operation_research_paper/v1.0.0").digest("hex"),
    },
    {
      operation_id: "operation_programming_assignment",
      version: "1.0.0",
      title: "Programming Assignment",
      purpose:
        "Deliver a programming assignment: understand the task, implement, test, and hand in with a write-up.",
      roster: ["agent_developer"],
      skills: ["skill_development_core", "skill_writing_core"],
      connectors: [],
      content_hash: createHash("sha256")
        .update("operation_programming_assignment/v1.0.0")
        .digest("hex"),
    },
    {
      operation_id: "operation_exam_preparation",
      version: "1.0.0",
      title: "Exam Preparation",
      purpose:
        "Prepare for an exam: study plan, practice questions, spaced review, and progress checks.",
      roster: ["agent_programming_tutor", "agent_study_planner"],
      skills: ["skill_tutoring_core", "skill_planning_core"],
      connectors: [],
      content_hash: createHash("sha256").update("operation_exam_preparation/v1.0.0").digest("hex"),
    },
  ],
  runtime_compatibility: ">=0.1.0 <1.0.0",
});

/** Display-level tool registry for fixture cards — NOT the runtime ToolDefinition. */
export const FixtureToolInfo = z.strictObject({
  tool_id: z.string(),
  name: z.string(),
  version: z.string(),
  risk_class: z.enum(["READ_ONLY", "LOCAL_MUTATION", "DESTRUCTIVE_LOCAL", "EXTERNAL_WRITE"]),
});
export type FixtureToolInfo = z.infer<typeof FixtureToolInfo>;

export const FIXTURE_TOOLS: FixtureToolInfo[] = [
  { tool_id: "tool_web_search", name: "Web search", version: "1.4.0", risk_class: "READ_ONLY" },
  { tool_id: "tool_file_read", name: "Read file", version: "1.2.0", risk_class: "READ_ONLY" },
  { tool_id: "tool_file_write", name: "Write file", version: "1.1.0", risk_class: "LOCAL_MUTATION" },
  { tool_id: "tool_code_exec", name: "Run code", version: "2.0.1", risk_class: "LOCAL_MUTATION" },
  {
    tool_id: "tool_repo_push",
    name: "Push to repository",
    version: "0.9.2",
    risk_class: "EXTERNAL_WRITE",
  },
];

export function agentById(agentId: string): Agent | undefined {
  return STUDENT_PACK.agents.find((agent) => agent.agent_id === agentId);
}

export function operationDefinitionById(operationId: string): OperationDefinition | undefined {
  return STUDENT_PACK.operations.find(
    (operation) => operation.operation_id === operationId,
  );
}

export function toolInfoById(toolId: string): FixtureToolInfo | undefined {
  return FIXTURE_TOOLS.find((tool) => tool.tool_id === toolId);
}
