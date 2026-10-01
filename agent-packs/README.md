# Agent packs

Pack definitions live here (Pack → Operations → Agents). The first real content is
**student pack v1** in **S10** (pack loader, student pack v1, workspace pack pinning),
mapped per **D46**:

| Operation              | Coordinator                        | Rostered Agents                                 |
| ---------------------- | ---------------------------------- | ----------------------------------------------- |
| Research Paper         | General Assistant (default, D42)   | General Assistant, Researcher, Citation Manager |
| Programming Assignment | General Assistant (default, D42)   | General Assistant, Developer, Programming Tutor |
| Exam Preparation       | Study Planner (pack override, D42) | Study Planner                                   |

Rules that apply to everything committed here: an Agent is rostered in exactly one
pack-defined Operation (D46); skills, tools, and connectors are pack content (D18, D43);
no secrets ever appear in a pack file (**G3**); pack files use the **Agent** vocabulary
(**G1**).

## Layout and ids (S10 chunk 2)

```text
agent-packs/student/v1/manifest.json    # the pack manifest (@shera-bot/agent-pack-sdk schema)
agent-packs/student/v1/manifest.sha256  # canonical manifest hash (SHA-256 over key-sorted JSON)
```

- `pack_id` is `student`, `version` is `1.0.0`; the directory name is only a
  container — identity and version always come from the manifest itself.
- `manifest.sha256` is the independently recorded integrity record honored by
  `BuiltInPackLoader`; any post-recording edit to `manifest.json` must regenerate it.
- `runtime_compatibility` is `^0.0.0`: the 0.0.x prototype runtime contract line,
  anchored to the version `apps/user-runtime/package.json` declares.
- Agent/Operation/skill/tool/connector ids follow the S08 fixture vocabulary
  (`apps/web/lib/fixtures/pack.ts`): `agent_*`, `operation_*`, `skill_*`,
  `tool_*`, `connector_*`, provider `provider_platform`.
- Agent role text quotes PRD §5.1–5.6 verbatim (first paragraph of each section);
  `packages/agent-pack-sdk/src/pack-content.test.ts` enforces the equality.
- Avatar hues are derived from the mockup avatar colors (`mockup/data.js`); final
  art is owner-pending (D18 UI identity metadata).
