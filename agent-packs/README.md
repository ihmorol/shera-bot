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
