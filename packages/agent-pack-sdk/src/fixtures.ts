/**
 * Shared manifest fixtures for the SDK test suites (integrity, compatibility,
 * loader). G3: these fixtures are clean by construction — no credential-shaped
 * value ever appears in a fixture. Secret/host-path/executable rejection
 * samples live only in manifest.test.ts as obviously fake dummies.
 */
type ManifestObject = Record<string, unknown>;

const MINIMAL: ManifestObject = {
  pack_id: "student",
  version: "1.0.0",
  title: "Student Pack",
  runtime_compatibility: "^0.10.0",
  default_coordinator_agent_id: "general_assistant",
  skills: [{ skill_id: "research_basics", version: "1.0.0", title: "Research basics" }],
  connectors: [],
  tool_allow_list: [{ tool_id: "web_search", version: "1.0.0" }],
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
      connectors: [],
      ui_identity: { avatar_hue: 120, initial_glyph: "R" },
      home_operation_id: "research_paper",
    },
  ],
  operations: [
    {
      operation_id: "research_paper",
      version: "1.0.0",
      title: "Research Paper",
      purpose: "Plan, draft, and check a research paper.",
      roster: ["general_assistant", "researcher"],
      skills: ["research_basics"],
      connectors: [],
    },
  ],
};

/** A fresh, deep clone of the minimal valid manifest; mutate via the callback. */
export function minimalManifest(mutate?: (m: ManifestObject) => void): ManifestObject {
  const clone = structuredClone(MINIMAL);
  mutate?.(clone);
  return clone;
}
