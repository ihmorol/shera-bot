/**
 * Sidebar navigation seed for the shell (UI_DESIGN §3.2): the six pack Agents
 * as persistent direct chats (AC3) and the three pack-defined Operation
 * templates, which open the launch preview (D30) rather than a chat.
 *
 * This is shell-only navigation seed data. The Zod-typed pack fixtures from
 * UI_DESIGN §9 (names, roles, tools, skills, rosters) replace it in the mock
 * data chunk — the sidebar component consumes this shape either way.
 */

export interface AgentNavEntry {
  slug: string;
  name: string;
}

export interface OperationTemplateNavEntry {
  slug: string;
  name: string;
}

export const PACK_AGENTS: AgentNavEntry[] = [
  { slug: "general-assistant", name: "General Assistant" },
  { slug: "researcher", name: "Researcher" },
  { slug: "developer", name: "Developer" },
  { slug: "citation-manager", name: "Citation Manager" },
  { slug: "programming-tutor", name: "Programming Tutor" },
  { slug: "study-planner", name: "Study Planner" },
];

export const PACK_OPERATION_TEMPLATES: OperationTemplateNavEntry[] = [
  { slug: "research-paper", name: "Research Paper" },
  { slug: "programming-assignment", name: "Programming Assignment" },
  { slug: "exam-preparation", name: "Exam Preparation" },
];

export function findAgent(slug: string): AgentNavEntry | undefined {
  return PACK_AGENTS.find((agent) => agent.slug === slug);
}

export function findOperationTemplate(slug: string): OperationTemplateNavEntry | undefined {
  return PACK_OPERATION_TEMPLATES.find((operation) => operation.slug === slug);
}
