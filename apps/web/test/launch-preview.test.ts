import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OperationLaunchPreview } from "@shera-bot/contracts";

import {
  OperationLaunchMenu,
  OperationLaunchPreviewModal,
} from "../components/operations/launch-preview";
import type { AgentRosterSummary } from "../lib/agent-api";
import { RuntimeApiError } from "../lib/runtime-client";
import {
  fetchOperationDefinitions,
  fetchOperationLaunchPreview,
  type OperationDefinitionSummary,
} from "../lib/operation-preview-api";
import {
  isPreviewOverrideFailure,
  operationDefinitionsQueryOptions,
  operationLaunchPreviewQueryOptions,
  previewSurfaceState,
  safeDefinitionsMessage,
  safePreviewMessage,
} from "../lib/operation-preview-data";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * S15 chunk 2 — the D30 launch preview web surfaces (UI_DESIGN §S5): the
 * "From the pack…" launcher on the Operations surface, the launch preview
 * modal rendering ALL EIGHT groups from the real S15 read model, and the
 * typed client layer behind them. Everything here is GET-only: the preview
 * is a safety gate where NOTHING may execute before confirmation (D30,
 * AC6/AC23), so the only writes in this chunk are the test file's own.
 * Rendered to static markup (node environment, no DOM) like the S11/S13
 * suites; fetch is stubbed at the same-origin proxy boundary.
 */

const APP_DIR = join(import.meta.dirname, "..");
const render = (element: ReactElement): string => renderToStaticMarkup(element);

const WORKSPACE = "ws_account-1";
const DEFINITION_ID = "operation_research_paper";

/**
 * The REAL shipped pack manifest (same source of truth as the S13 suite):
 * identities for the picker and the definition's pack-authored purpose.
 */
const STUDENT_MANIFEST = JSON.parse(
  readFileSync(join(APP_DIR, "..", "..", "agent-packs", "student", "v1", "manifest.json"), "utf8"),
) as {
  agents: Array<{
    agent_id: string;
    display_name: string;
    role_description: string;
    ui_identity: { avatar_hue: number; initial_glyph: string };
  }>;
  operations: Array<{ operation_id: string; title: string; purpose: string }>;
};

const IDENTITIES: AgentRosterSummary[] = STUDENT_MANIFEST.agents.map((agent) => ({
  agent_id: agent.agent_id,
  display_name: agent.display_name,
  role_description: agent.role_description,
  avatar_hue: agent.ui_identity.avatar_hue,
  initial_glyph: agent.ui_identity.initial_glyph,
  has_user_instructions: false,
  session: { presence: "none" },
}));

const GA = IDENTITIES[0]!;
const RESEARCHER = IDENTITIES[1]!;
const CITATION = IDENTITIES[2]!;

const PURPOSE = STUDENT_MANIFEST.operations[0]!.purpose;

/**
 * The honest note strings the S15 runtime builder answers verbatim (the
 * preview renders them word for word — the UI never paraphrases the
 * runtime's provenance notes, G3). Kept in step with
 * apps/user-runtime/src/modules/operations/operations-preview.ts.
 */
const CONNECTOR_NOTE =
  "Recommended connector, not installed. Connect it yourself before launch if you want it available.";
const PROVIDER_NOTE =
  "Not configured: no live provider is wired in this prototype (S23 owns provider wiring); the " +
  "pair shown is the Agent's saved default.";
const FORMULA_NOTE =
  "Policy placeholder (D20): min = 1 credit per platform-provider Agent, max = 5 credits per " +
  "platform-provider Agent; Agents on custom providers consume no Shera credits. The providers " +
  "slice (S23) replaces this with real pricing.";
const SETTLEMENT_NOTE =
  "The runtime reserves a bounded estimate before execution, settles against actual usage, and " +
  "releases unused reservations (D20). The preview itself consumes nothing.";
const MAPPING_NOTE =
  "The pinned pack references tools without risk classes (the runtime owns tool definitions, " +
  "D38); this preview applies the documented D35 default ladder to tool ids, and the runtime " +
  "re-derives every class at execution time. Read-only tools execute automatically; the other " +
  "ladder classes request approval (D35).";
const OUTPUTS_REASON = "The pinned pack's definition carries no expected outputs field.";

/**
 * A contracts-valid OperationLaunchPreview, mirroring what the S15 backend
 * answers for the student pack's Research Paper definition (chunk 1): the
 * eight D30 groups, connectors literally never connected, providers
 * literally never configured.
 */
const PREVIEW = OperationLaunchPreview.parse({
  workspace_id: WORKSPACE,
  definition_ref: "agent-packs/student/v1.0.0/operations/operation_research_paper@1.0.0",
  pack: { pack_id: "student", pack_version: "1.0.0", pinned: true },
  definition: {
    operation_definition_id: DEFINITION_ID,
    version: "1.0.0",
    title: "Research Paper",
    purpose: PURPOSE,
  },
  roster: {
    agents: [
      {
        agent_id: GA.agent_id,
        display_name: GA.display_name,
        role: GA.role_description,
        is_coordinator: true,
      },
      {
        agent_id: RESEARCHER.agent_id,
        display_name: RESEARCHER.display_name,
        role: RESEARCHER.role_description,
        is_coordinator: false,
      },
    ],
    coordinator_agent_id: GA.agent_id,
    source: "pack_default",
  },
  skills: {
    operation_skill_ids: ["skill_research_core", "skill_citation_core", "skill_writing_core"],
    agents: [
      {
        agent_id: GA.agent_id,
        skills: [{ skill_id: "skill_research_core", title: "Research core" }],
      },
      {
        agent_id: RESEARCHER.agent_id,
        skills: [{ skill_id: "skill_citation_core", title: null }],
      },
    ],
    source: "pack",
  },
  connectors: {
    items: [
      {
        connector_id: "connector_scholar_library",
        title: null,
        version: null,
        connected: false,
        status: "not_connected",
        note: CONNECTOR_NOTE,
      },
    ],
  },
  providers: {
    agents: [
      {
        agent_id: GA.agent_id,
        provider_id: "provider_platform",
        model: "platform-default",
        configured: false,
        source: "agent_settings",
        note: PROVIDER_NOTE,
      },
      {
        agent_id: RESEARCHER.agent_id,
        provider_id: "provider_openrouter",
        model: "openrouter/free",
        configured: false,
        source: "pack_default",
        note: PROVIDER_NOTE,
      },
    ],
  },
  estimated_credits: {
    currency: "shera_credits",
    min_credits: 1,
    max_credits: 5,
    formula: FORMULA_NOTE,
    settlement_note: SETTLEMENT_NOTE,
    custom_provider_agents: [RESEARCHER.agent_id],
  },
  approval_requirements: {
    risk_classes: ["read-only", "local-mutation", "external-write"],
    classes_requiring_approval: ["local-mutation", "external-write"],
    mapping: [
      { risk_class: "read-only", tool_ids: ["tool_file_read"], behavior: "auto_execute" },
      {
        risk_class: "local-mutation",
        tool_ids: ["tool_file_write"],
        behavior: "approval_required",
      },
      {
        risk_class: "external-write",
        tool_ids: ["tool_custom_unmapped"],
        behavior: "approval_required",
      },
    ],
    mapping_note: MAPPING_NOTE,
  },
  expected_outputs: {
    statement: `From the definition's purpose: ${PURPOSE}`,
    source: "purpose_derived",
    reason: OUTPUTS_REASON,
  },
});

/** The same preview after a roster override: the server recomputed read-only. */
const PREVIEW_OVERRIDE = OperationLaunchPreview.parse({
  ...PREVIEW,
  roster: {
    agents: [
      {
        agent_id: RESEARCHER.agent_id,
        display_name: RESEARCHER.display_name,
        role: RESEARCHER.role_description,
        is_coordinator: false,
      },
      {
        agent_id: CITATION.agent_id,
        display_name: CITATION.display_name,
        role: CITATION.role_description,
        is_coordinator: false,
      },
    ],
    coordinator_agent_id: "none",
    source: "request_override",
  },
});

const DEFINITIONS: OperationDefinitionSummary[] = [
  {
    operation_definition_id: DEFINITION_ID,
    version: "1.0.0",
    title: "Research Paper",
    purpose_summary: PURPOSE,
  },
  {
    operation_definition_id: "operation_exam_preparation",
    version: "1.0.0",
    title: "Exam Preparation",
    purpose_summary: "Plan and run an exam preparation sprint.",
  },
];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderModal(props: Record<string, unknown> = {}, preview = PREVIEW): string {
  return render(
    createElement(OperationLaunchPreviewModal, {
      preview,
      state: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      identities: IDENTITIES,
      overridePending: false,
      overrideErrorMessage: null,
      onRosterToggle: () => undefined,
      onCoordinatorChange: () => undefined,
      onResetOverrides: () => undefined,
      onClose: () => undefined,
      ...props,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. The typed client through the same-origin proxy (GET-only)
// ---------------------------------------------------------------------------

describe("Operation preview client (proxy paths)", () => {
  it("fetchOperationDefinitions GETs the pinned pack's definition summaries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { definitions: DEFINITIONS }));
    vi.stubGlobal("fetch", fetchMock);

    const definitions = await fetchOperationDefinitions(WORKSPACE);
    expect(definitions).toHaveLength(2);
    expect(definitions[0]).toMatchObject({
      operation_definition_id: DEFINITION_ID,
      title: "Research Paper",
      purpose_summary: PURPOSE,
    });

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(`/api/runtime/v1/operation-definitions?workspace_id=${WORKSPACE}`);
  });

  it("fetchOperationLaunchPreview GETs the eight-group read model for one definition", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PREVIEW));
    vi.stubGlobal("fetch", fetchMock);

    const preview = await fetchOperationLaunchPreview(WORKSPACE, DEFINITION_ID);
    expect(preview.roster.agents).toHaveLength(2);
    expect(preview.connectors.items[0]).toMatchObject({ connected: false });
    expect(preview.estimated_credits.settlement_note).toBe(SETTLEMENT_NOTE);

    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe(
      `/api/runtime/v1/operation-definitions/${DEFINITION_ID}/preview?workspace_id=${WORKSPACE}`,
    );
  });

  it("a default read carries NO override params — the pack's own recommendation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PREVIEW));
    vi.stubGlobal("fetch", fetchMock);

    await fetchOperationLaunchPreview(WORKSPACE, DEFINITION_ID, {});
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).not.toContain("roster_agent_ids");
    expect(path).not.toContain("coordinator_agent_id");
  });

  it("roster and coordinator overrides ride the query string — the server recomputes", async () => {
    // URLSearchParams percent-encodes the comma separator (the runtime's
    // query parser decodes it back before splitting).
    const cases: Array<{
      overrides: Parameters<typeof fetchOperationLaunchPreview>[2];
      tail: string;
    }> = [
      {
        overrides: { roster_agent_ids: [RESEARCHER.agent_id, CITATION.agent_id] },
        tail: `&roster_agent_ids=${RESEARCHER.agent_id}%2C${CITATION.agent_id}`,
      },
      {
        overrides: { coordinator_agent_id: CITATION.agent_id },
        tail: `&coordinator_agent_id=${CITATION.agent_id}`,
      },
      {
        overrides: { coordinator_agent_id: "none" },
        tail: "&coordinator_agent_id=none",
      },
      {
        overrides: {
          roster_agent_ids: [RESEARCHER.agent_id],
          coordinator_agent_id: "none",
        },
        tail: `&roster_agent_ids=${RESEARCHER.agent_id}&coordinator_agent_id=none`,
      },
    ];
    for (const { overrides, tail } of cases) {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PREVIEW));
      vi.stubGlobal("fetch", fetchMock);
      await fetchOperationLaunchPreview(WORKSPACE, DEFINITION_ID, overrides);
      const [path] = fetchMock.mock.calls[0] as [string];
      expect(path, JSON.stringify(overrides)).toBe(
        `/api/runtime/v1/operation-definitions/${DEFINITION_ID}/preview?workspace_id=${WORKSPACE}${tail}`,
      );
    }
  });

  it("answers an unknown definition with the typed 404-class failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(404, {
          code: "OPERATION_DEFINITION_NOT_FOUND",
          category: "resource",
          safe_message: "The requested Operation definition does not exist in this workspace.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "44444444-4444-4444-8444-444444444444",
        }),
      ),
    );
    await expect(fetchOperationLaunchPreview(WORKSPACE, "operation_unknown")).rejects.toMatchObject(
      {
        sheraError: { code: "OPERATION_DEFINITION_NOT_FOUND" },
      },
    );
  });

  it("an override the runtime refuses (400) raises typed with its safe copy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(400, {
          code: "OPERATION_PREVIEW_OVERRIDE_INVALID",
          category: "validation",
          safe_message:
            "The roster override names an Agent outside the pinned pack, or removes every Agent.",
          retryable: false,
          user_action: null,
          internal_details: null,
          correlation_id: "44444444-4444-4444-8444-444444444445",
        }),
      ),
    );
    await expect(
      fetchOperationLaunchPreview(WORKSPACE, DEFINITION_ID, {
        roster_agent_ids: ["agent_elsewhere"],
      }),
    ).rejects.toMatchObject({
      sheraError: { code: "OPERATION_PREVIEW_OVERRIDE_INVALID" },
    });
  });

  it("a 2xx body that drifts from the contracts schema is a server drift, not data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { definitions: "all of them, trust me" })),
    );
    // The generic typed fallback — a server drift, never a user-facing 4xx.
    await expect(fetchOperationDefinitions(WORKSPACE)).rejects.toMatchObject({
      sheraError: { code: "INTERNAL_ERROR" },
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The data hooks' testable contract (no React renderer in this suite)
// ---------------------------------------------------------------------------

describe("Preview data hooks (testable contract)", () => {
  it("the definitions query caches per workspace and calls the typed fetcher", async () => {
    const options = operationDefinitionsQueryOptions(WORKSPACE);
    expect(options.queryKey).toEqual(["operation-definitions", WORKSPACE]);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { definitions: DEFINITIONS }));
    vi.stubGlobal("fetch", fetchMock);
    const definitions = await options.queryFn();
    expect(definitions).toHaveLength(2);
  });

  it("the preview query caches per definition and is disabled without one", async () => {
    const options = operationLaunchPreviewQueryOptions(WORKSPACE, DEFINITION_ID);
    expect(options.queryKey).toEqual(["operation-launch-preview", WORKSPACE, DEFINITION_ID]);
    expect(operationLaunchPreviewQueryOptions(WORKSPACE, "").enabled).toBe(false);

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PREVIEW));
    vi.stubGlobal("fetch", fetchMock);
    const preview = await options.queryFn();
    expect(preview.definition.operation_definition_id).toBe(DEFINITION_ID);
  });

  it("the tri-state mapper keeps a failed REFETCH in ready (the last good preview stays)", () => {
    expect(previewSurfaceState(true, true, false)).toBe("loading");
    expect(previewSurfaceState(false, true, false)).toBe("error");
    // A refetch failure with a previous preview on screen is NOT the error
    // state — the modal keeps rendering the last good read model plus the
    // override alert (the 400 must not blank the gate).
    expect(previewSurfaceState(false, true, true)).toBe("ready");
    expect(previewSurfaceState(false, false, true)).toBe("ready");
    expect(isPreviewOverrideFailure(true, true)).toBe(true);
    expect(isPreviewOverrideFailure(true, false)).toBe(false);
    expect(isPreviewOverrideFailure(false, true)).toBe(false);
  });

  it("safe messages pass the runtime's safe copy and never raw internals", () => {
    const typed = new RuntimeApiError({
      code: "OPERATION_PREVIEW_OVERRIDE_INVALID",
      category: "validation",
      safe_message: "The roster override names an Agent outside the pinned pack.",
      retryable: false,
      user_action: null,
      internal_details: null,
      correlation_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(safePreviewMessage(typed)).toBe(
      "The roster override names an Agent outside the pinned pack.",
    );
    expect(safePreviewMessage(new Error("postgres exploded"))).toBe(
      "The launch preview could not be loaded.",
    );
    expect(safeDefinitionsMessage(new Error("kaboom"))).toBe(
      "The pack's Operations could not be loaded.",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The "From the pack…" launcher (the Operations-surface entry point)
// ---------------------------------------------------------------------------

describe("From-the-pack launcher (§S5 entry, D30)", () => {
  const renderMenu = (props: Record<string, unknown> = {}) =>
    render(
      createElement(OperationLaunchMenu, {
        definitions: DEFINITIONS,
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        onPick: () => undefined,
        ...props,
      }),
    );

  it("lists the pinned pack's definitions as launchable previews", () => {
    const html = renderMenu();
    expect(html).toContain("From the pack");
    expect(html).toContain("Research Paper");
    expect(html).toContain("Exam Preparation");
    expect(html).toContain('aria-label="Launch Research Paper from the pack"');
    expect(html).toContain('aria-label="Launch Exam Preparation from the pack"');
    // The gate's promise, stated once, up front.
    expect(html).toContain("Nothing runs until you confirm");
  });

  it("an empty pack explains the truth; loading is a skeleton; error carries retry", () => {
    const empty = renderMenu({ definitions: [] });
    expect(empty).toContain("The pinned pack declares no Operations.");

    const loading = renderMenu({ definitions: [], state: "loading" });
    expect(loading).toContain("animate-pulse");
    expect(loading).not.toContain("Research Paper");

    const error = renderMenu({
      definitions: [],
      state: "error",
      safeErrorMessage: "The pack's Operations could not be loaded.",
    });
    // SSR entity-encodes the apostrophe — assert the apostrophe-free tail
    // (the suite's verbatim-check convention).
    expect(error).toContain('role="alert"');
    expect(error).toContain("Operations could not be loaded.");
    expect(error).toContain("Retry");
  });
});

// ---------------------------------------------------------------------------
// 4. The preview modal — ALL EIGHT D30 groups (§S5)
// ---------------------------------------------------------------------------

describe("Launch preview modal — the eight groups (§S5, D30/D38/D20/D35)", () => {
  it("group 1, purpose: renders the pack-authored purpose verbatim", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Purpose"');
    expect(html).toContain(PURPOSE);
    expect(html).toContain("Research Paper");
    expect(html).toContain("v1.0.0");
  });

  it("group 2, agents: one chip per roster Agent with role, avatar identity, and the coordinator marked", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Agents"');
    expect(html.indexOf(GA.display_name)).toBeGreaterThan(-1);
    expect(html.indexOf(RESEARCHER.display_name)).toBeGreaterThan(-1);
    expect(html).toContain(GA.role_description);
    expect(html).toContain(RESEARCHER.role_description);
    // The coordinator role is a mark on the chip (D42/D46), not a membership.
    expect(html).toContain("Coordinator");
    // The pack-authored avatar identity rides along (D39) when the workspace
    // roster can resolve it.
    expect(html).toContain(`--agent-hue:${GA.avatar_hue}`);
  });

  it("group 3, skills: per-Agent skill lists from the pinned pack, titles over ids", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Skills"');
    expect(html).toContain("Research core");
    // A skill without a catalog title renders its pack id — never a fabricated name.
    expect(html).toContain("skill_citation_core");
  });

  it("group 4, connectors: honestly Not configured — the word Connected never renders", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Connectors"');
    expect(html).toContain("Not configured");
    expect(html).toContain(CONNECTOR_NOTE);
    // The wire shape cannot even express a connected connector (D38, G2); the
    // UI must not introduce the claim.
    expect(html).not.toContain("Connected");
  });

  it("group 5, provider and model: the effective pair per Agent with the honest note verbatim", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Provider and model"');
    expect(html).toContain("provider_platform · platform-default");
    expect(html).toContain("provider_openrouter · openrouter/free");
    // The runtime's honest note (SSR encodes the apostrophe — assert the
    // apostrophe-free head of the note).
    expect(html).toContain("no live provider is wired in this prototype");
  });

  it("group 6, estimated credits: the bounded range, the settlement note verbatim, and custom-provider Agents marked", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Estimated credits"');
    expect(html).toContain("1–5 Shera credits");
    expect(html).toContain(SETTLEMENT_NOTE);
    expect(html).toContain(FORMULA_NOTE);
    // Agents on custom providers consume no Shera credits (D20).
    expect(html).toContain("no Shera credits");
    expect(html).toContain(RESEARCHER.display_name);
  });

  it("group 7, approval requirements: the D35 classes named, the mapping note verbatim, no outcome promises", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Approval requirements"');
    expect(html).toContain("read-only");
    expect(html).toContain("external-write");
    expect(html).toContain("pauses for your approval");
    expect(html).toContain(MAPPING_NOTE);
  });

  it("group 8, expected outputs: the statement with its honest source, or the honest null", () => {
    const derived = renderModal();
    expect(derived).toContain('aria-label="Expected outputs"');
    // SSR entity-encodes the apostrophe in "definition's" — assert around it.
    expect(derived).toContain("From the definition");
    expect(derived).toContain(`purpose: ${PURPOSE}`);
    expect(derived).toContain("derived from the purpose");
    expect(derived).toContain("carries no expected outputs field");

    // A definition with no derivable outputs renders the honest null — the
    // UI never invents artifacts (G4).
    const none = renderModal(
      {},
      OperationLaunchPreview.parse({ ...PREVIEW, expected_outputs: null }),
    );
    expect(none).toContain("The pack does not declare expected outputs for this Operation.");
  });

  it("the OUTCOME-PROMISE AUDIT: no 'will execute/install/send/merge'-class phrasing anywhere", () => {
    // The S15 payload is regex-audited at the backend; the UI mirrors the
    // audit over its FULL rendered output — a preview is a read model (D30),
    // and no copy may promise execution before the confirm step exists.
    const outcomePromise = /\bwill\s+(execute|install|send|merge|create|delete|run|launch)\b/i;
    for (const preview of [PREVIEW, PREVIEW_OVERRIDE]) {
      const html = renderModal({}, preview);
      const match = outcomePromise.exec(html);
      expect(match, match ? `promised outcome: ${match[0]}` : undefined).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Roster edits, overrides, and the honest source
// ---------------------------------------------------------------------------

describe("Launch preview modal — roster overrides (D30 co-planning)", () => {
  it("renders the SAME pack identities picker as the S14 creation flow", () => {
    const html = renderModal();
    // The S14 checkbox-picker idiom, reused for the preview's roster edits.
    expect(html).toContain(`aria-label="Include ${GA.display_name}"`);
    expect(html).toContain(`aria-label="Include ${CITATION.display_name}"`);
    expect(html).toMatch(
      new RegExp(`aria-label="Include ${GA.display_name}"[^>]*aria-checked="true"`),
    );
    // A pack Agent NOT on the roster is unchecked, ready to add.
    expect(html).toMatch(
      new RegExp(`aria-label="Include ${CITATION.display_name}"[^>]*aria-checked="false"`),
    );
  });

  it("a checkbox that would remove the LAST roster Agent is disabled — the runtime's min-1 rule, stated", () => {
    const solo = renderModal(
      {},
      OperationLaunchPreview.parse({
        ...PREVIEW,
        roster: {
          agents: [
            {
              agent_id: GA.agent_id,
              display_name: GA.display_name,
              role: GA.role_description,
              is_coordinator: true,
            },
          ],
          coordinator_agent_id: GA.agent_id,
          source: "pack_default",
        },
      }),
    );
    expect(solo).toMatch(new RegExp(`aria-label="Include ${GA.display_name}"[^>]*\\bdisabled=""`));
    expect(solo).toContain("An Operation needs at least one Agent.");
  });

  it("an active override says so honestly and offers the way back to the pack's recommendation", () => {
    const html = renderModal({}, PREVIEW_OVERRIDE);
    expect(html).toContain("Adjusted in this preview");
    expect(html).toContain("nothing is saved");
    expect(html).toContain('aria-label="Back to the pack-recommended roster"');
    // The override flipped the coordinator to none: the peer-to-peer radio
    // reflects it (D49) and no chip claims the coordinator role.
    expect(html).toMatch(/aria-label="No coordinator \(peer-to-peer\)"[^>]*aria-checked="true"/);
    expect(html).not.toContain('aria-checked="true" aria-label="Coordinator');
  });

  it("every roster edit control is disabled while an override refetch is pending", () => {
    const html = renderModal({ overridePending: true });
    // SSR serializes the disabled boolean attribute.
    expect(html).toMatch(new RegExp(`aria-label="Include ${GA.display_name}"[^>]*\\bdisabled=""`));
    expect(html).toMatch(
      new RegExp(`aria-label="Coordinator: ${GA.display_name}"[^>]*\\bdisabled=""`),
    );
    // The default render has none disabled.
    const idle = renderModal();
    expect(idle).not.toMatch(
      new RegExp(`aria-label="Include ${GA.display_name}"[^>]*\\bdisabled=""`),
    );
  });

  it("a refused override (400) surfaces its safe message as an alert, not a blank gate", () => {
    const html = renderModal({
      overrideErrorMessage: "The roster override names an Agent outside the pinned pack.",
    });
    expect(html).toContain('data-testid="override-error"');
    expect(html).toContain("The roster override names an Agent outside the pinned pack.");
  });

  it("the coordinator picker offers every pack Agent plus the D49 none option", () => {
    const html = renderModal();
    expect(html).toContain('aria-label="Coordinator for this preview"');
    expect(html).toContain(`aria-label="Coordinator: ${GA.display_name}"`);
    expect(html).toContain(`aria-label="Coordinator: ${CITATION.display_name}"`);
    expect(html).toContain('aria-label="No coordinator (peer-to-peer)"');
  });
});

// ---------------------------------------------------------------------------
// 6. States, dialog idiom, and the footer (chunk 3 wires Launch)
// ---------------------------------------------------------------------------

describe("Launch preview modal — states and the footer", () => {
  it("loading state is a layout-matched skeleton — no fabricated groups", () => {
    const html = renderModal({ state: "loading", preview: null });
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain(PURPOSE);
    expect(html).not.toContain('aria-label="Purpose"');
  });

  it("error state carries the safe message + retry inside the still-open gate", () => {
    const html = renderModal({
      state: "error",
      preview: null,
      safeErrorMessage: "The launch preview could not be loaded.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The launch preview could not be loaded.");
    expect(html).toContain("Retry");
    // Cancel still works — the gate is honest even when the read failed.
    expect(html).toContain(">Cancel</button>");
  });

  it("the dialog follows the S11 a11y idiom: role, modal, label, initial focus, a keyboard-reachable close", () => {
    const html = renderModal();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Operation launch preview"');
    // Initial focus lands on the dialog container itself (SSR serializes
    // autoFocus); Escape and the Close affordance return focus.
    expect(html).toMatch(/role="dialog"[^>]*autofocus/);
    expect(html).toContain('aria-label="Close preview"');
  });

  it("D30 presentation: full page on mobile, full-screen modal on desktop", () => {
    const html = renderModal();
    // The gate covers the viewport at EVERY width (mobile = full page).
    expect(html).toMatch(/class="[^"]*fixed inset-0/);
    // …and becomes the desktop modal only at lg+ (class assertion per the
    // suite's responsive conventions).
    expect(html).toMatch(/class="[^"]*lg:rounded/);
  });

  it("the footer renders Cancel (side-effect free close) and an inert Launch marker for chunk 3", () => {
    const html = renderModal();
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain('data-testid="launch-inert"');
    expect(html).toContain('title="Launch wiring lands with the confirm flow"');
    // The gate's headline promise rides the modal itself.
    expect(html).toContain("Nothing runs until you confirm");
  });
});
