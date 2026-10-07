/**
 * S11 chunk 3 — the D16 Agent settings command surface (contracts level).
 *
 * D16: zero-configuration start with safe defaults; onboarding (S30) and the
 * settings editor must use the SAME configuration commands and schemas, so the
 * command union, the per-setting metadata, and the stored overrides blob are
 * pinned HERE in the contracts — not in any one transport. The per-setting
 * metadata carries exactly what the D16 UI must surface: display label,
 * recommended default, why it matters, risk/cost impact, editability, and the
 * reset-to-default command. Pack-owned fields (role, capabilities,
 * ui_identity) appear as read-only entries and are NEVER reset targets.
 *
 * Vocabulary: Pack → Operations → Agents; "Agent" only, never "Expert".
 */
import { describe, expect, it } from "vitest";

import {
  AGENT_SETTING_KEYS,
  AGENT_SETTINGS_COMMAND_TYPES,
  EDITABLE_AGENT_SETTING_KEYS,
  AgentSettingsCommand,
  AgentSettingsOverrides,
  AgentSettingsSnapshot,
} from "@shera-bot/contracts";

const COMMAND_BASE = {
  command_id: "cmd_001",
  idempotency_key: "idem_cmd_001",
  workspace_id: "ws_default_01",
  agent_id: "agent_general_assistant",
  actor: { type: "user", id: "user_emon" },
  issued_at: "2026-10-07T09:50:00.000Z",
} as const;

describe("S11 agent settings commands (D16 — one command surface for settings AND onboarding)", () => {
  it("accepts every D16 settings command shape", () => {
    const updateInstructions = AgentSettingsCommand.parse({
      ...COMMAND_BASE,
      type: "agent_settings.update_instructions",
      user_instructions: "Always answer in Bangla.",
    });
    expect(updateInstructions).toMatchObject({
      type: "agent_settings.update_instructions",
      agent_id: "agent_general_assistant",
      user_instructions: "Always answer in Bangla.",
    });

    // `null` clears the instructions back to pack-only behavior.
    expect(
      AgentSettingsCommand.parse({
        ...COMMAND_BASE,
        type: "agent_settings.update_instructions",
        user_instructions: null,
      }),
    ).toMatchObject({ type: "agent_settings.update_instructions", user_instructions: null });

    expect(
      AgentSettingsCommand.parse({
        ...COMMAND_BASE,
        type: "agent_settings.update_default_provider",
        default_provider: { provider_id: "provider_platform", model: "platform-default" },
      }),
    ).toMatchObject({
      type: "agent_settings.update_default_provider",
      default_provider: { provider_id: "provider_platform", model: "platform-default" },
    });

    // Tool defaults are placeholder-typed (tool_id + free-form config JSON)
    // until the tool slices own real config schemas (S21+).
    expect(
      AgentSettingsCommand.parse({
        ...COMMAND_BASE,
        type: "agent_settings.update_tool_defaults",
        tool_defaults: [{ tool_id: "tool_web_search", config: { depth: "standard" } }],
      }),
    ).toMatchObject({
      type: "agent_settings.update_tool_defaults",
      tool_defaults: [{ tool_id: "tool_web_search", config: { depth: "standard" } }],
    });

    expect(
      AgentSettingsCommand.parse({
        ...COMMAND_BASE,
        type: "agent_settings.reset_setting",
        setting_key: "user_instructions",
      }),
    ).toMatchObject({ type: "agent_settings.reset_setting", setting_key: "user_instructions" });

    expect(
      AgentSettingsCommand.parse({ ...COMMAND_BASE, type: "agent_settings.reset_all" }),
    ).toMatchObject({ type: "agent_settings.reset_all" });
  });

  it("carries exactly the five D16 command types with the idempotent envelope", () => {
    expect([...AGENT_SETTINGS_COMMAND_TYPES].sort()).toEqual(
      [
        "agent_settings.update_instructions",
        "agent_settings.update_default_provider",
        "agent_settings.update_tool_defaults",
        "agent_settings.reset_setting",
        "agent_settings.reset_all",
      ].sort(),
    );

    // The envelope is the contracts command shape (D23 rule 6: idempotent,
    // workspace-scoped) — minus the task aggregate's expected_version, which
    // has no analogue on settings (last-write-wins validated JSON).
    const missing = { ...COMMAND_BASE } as Record<string, unknown>;
    delete missing["idempotency_key"];
    expect(
      AgentSettingsCommand.safeParse({
        ...missing,
        type: "agent_settings.update_instructions",
        user_instructions: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown types, unknown fields, and non-conforming payloads (strictObject)", () => {
    expect(
      AgentSettingsCommand.safeParse({
        ...COMMAND_BASE,
        type: "agent_settings.set_temperature",
        temperature: 0.2,
      }).success,
    ).toBe(false);

    expect(
      AgentSettingsCommand.safeParse({
        ...COMMAND_BASE,
        type: "agent_settings.update_instructions",
        user_instructions: "Always answer in Bangla.",
        temperature: 0.2, // unknown field
      }).success,
    ).toBe(false);

    expect(
      AgentSettingsCommand.safeParse({
        ...COMMAND_BASE,
        type: "agent_settings.update_default_provider",
        default_provider: { provider_id: "provider_platform" }, // model missing
      }).success,
    ).toBe(false);
  });

  it("never accepts a pack-owned field as a reset target (read-only entries, never commands)", () => {
    for (const packOwned of ["role", "capabilities", "ui_identity", "memory_link"]) {
      expect(
        AgentSettingsCommand.safeParse({
          ...COMMAND_BASE,
          type: "agent_settings.reset_setting",
          setting_key: packOwned,
        }).success,
        `${packOwned} must not be a reset target`,
      ).toBe(false);
    }
    expect([...EDITABLE_AGENT_SETTING_KEYS].sort()).toEqual(
      ["default_provider", "tool_defaults", "user_instructions"].sort(),
    );
    // Every editable key is a setting key; the pack-owned keys never are.
    for (const key of EDITABLE_AGENT_SETTING_KEYS) {
      expect(AGENT_SETTING_KEYS).toContain(key);
    }
  });
});

describe("S11 agent settings read model (D16 metadata: default, why-it-matters, reset)", () => {
  const SNAPSHOT = {
    workspace_id: "ws_default_01",
    agent_id: "agent_general_assistant",
    entries: [
      {
        key: "role",
        display_label: "Role",
        description: "The fixed role from the pack.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: "The General Assistant coordinates every Operation.",
        recommended_default: null,
      },
      {
        key: "user_instructions",
        display_label: "Your instructions",
        description: "Layered above the pack role.",
        risk_note: "",
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: "Always answer in Bangla.",
        recommended_default: null,
      },
      {
        key: "memory_link",
        display_label: "Memory",
        description: "The Agent's private memory folder.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: "agent://agent_general_assistant/",
        recommended_default: null,
      },
      {
        key: "default_provider",
        display_label: "Default provider and model",
        description: "Which model answers by default.",
        risk_note: "Providers differ in privacy and cost behavior.",
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: { provider_id: "provider_local", model: "qwen3-8b" },
        recommended_default: { provider_id: "provider_platform", model: "platform-default" },
      },
      {
        key: "tool_defaults",
        display_label: "Tool defaults",
        description: "Per-tool default configuration.",
        risk_note: "",
        editable: true,
        resettable: true,
        reset_command: "agent_settings.reset_setting",
        value: [{ tool_id: "tool_web_search", config: { depth: "standard" } }],
        recommended_default: [],
      },
      {
        key: "capabilities",
        display_label: "Capabilities",
        description: "Skills, tools, and connectors from the pack.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: {
          skills: ["skill_planning_core"],
          tools: [{ tool_id: "tool_web_search", version: "1.4.0" }],
          connectors: [],
        },
        recommended_default: null,
      },
      {
        key: "ui_identity",
        display_label: "Appearance",
        description: "Authored visual identity from the pack.",
        risk_note: "",
        editable: false,
        resettable: false,
        reset_command: null,
        value: { avatar_hue: 217, initial_glyph: "G" },
        recommended_default: null,
      },
    ],
  };

  it("parses the full settings snapshot with typed per-key values", () => {
    const parsed = AgentSettingsSnapshot.parse(SNAPSHOT);
    expect(parsed.entries).toHaveLength(7);
    const provider = parsed.entries.find((entry) => entry.key === "default_provider");
    expect(provider?.editable).toBe(true);
    expect(provider?.recommended_default).toEqual({
      provider_id: "provider_platform",
      model: "platform-default",
    });
  });

  it("rejects entries with missing D16 metadata or unknown keys", () => {
    const stripped = structuredClone(SNAPSHOT);
    const role = stripped.entries.find((entry) => entry.key === "role");
    expect(role).toBeDefined();
    // "Why it matters" is mandatory metadata (D16), not optional UI garnish.
    const { description, ...rest } = role!;
    expect(description).toBeDefined();
    expect(
      AgentSettingsSnapshot.safeParse({
        ...stripped,
        entries: [...stripped.entries.filter((entry) => entry.key !== "role"), rest],
      }).success,
    ).toBe(false);

    expect(
      AgentSettingsSnapshot.safeParse({
        ...stripped,
        entries: [
          ...stripped.entries,
          { ...stripped.entries[0], key: "temperature" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("S11 agent settings overrides blob (the validated stored shape)", () => {
  it("round-trips the stored overrides and rejects non-conforming JSON", () => {
    expect(AgentSettingsOverrides.parse({})).toEqual({});
    expect(
      AgentSettingsOverrides.parse({
        tool_defaults: [{ tool_id: "tool_web_search", config: {} }],
      }),
    ).toEqual({ tool_defaults: [{ tool_id: "tool_web_search", config: {} }] });

    // Strict: a legacy raw blob (chunk 1 stored plain JSON) no longer passes.
    expect(AgentSettingsOverrides.safeParse({ temperature: 0.2 }).success).toBe(false);
    expect(AgentSettingsOverrides.safeParse({ tone: "warm" }).success).toBe(false);
  });
});
