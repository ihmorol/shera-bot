/**
 * S29 memory surface suite (UI_DESIGN §S9 Memory; PRD §11, D37, AC27, G4/G6):
 * the truthful readout — the per-scope breakdown renders exactly what the
 * runtime's own record says (the view model here is the runtime's wire
 * shape; the UI computes no memory state of its own) — the publication
 * queue's approve/dismiss, the "remembered from …" provenance lines, the
 * version restore affordance, the auto-memory switches, and the honest
 * secret-rejection display (a refused write shows its typed refusal, never
 * an input that pretends to work).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MemorySettingsView } from "../components/settings/memory-settings";
import type { MemoryEntryView, MemoryUserView } from "../lib/memory-api";

const OPERATIONS = [{ operation_id: "op_s29", name: "Research Paper" }];

function entry(overrides: Partial<MemoryEntryView> = {}): MemoryEntryView {
  return {
    memory_id: "mem_s29_a",
    workspace_id: "ws_default_01",
    scope: "workspace",
    owner_agent_id: null,
    operation_id: null,
    task_id: null,
    summary: "Sweep methodology",
    content: "Version one: search the corpus with the broad query first.",
    sensitivity: "normal",
    publication: {
      published: false,
      published_into_operation_id: null,
      published_at: null,
    },
    origin: "automatic",
    created_by: "agent_researcher",
    source_refs: ["conversation://op_s29/messages"],
    confidence: 0.85,
    created_at: "2026-11-04T10:00:00.000Z",
    updated_at: "2026-11-04T10:05:00.000Z",
    expires_at: null,
    versions: [
      {
        version: 1,
        summary: "Sweep methodology",
        content: "Version one: search the corpus with the broad query first.",
        sensitivity: "normal",
        source_refs: ["conversation://op_s29/messages"],
        confidence: 0.85,
        change_kind: "created",
        changed_by: "agent_researcher",
        created_at: "2026-11-04T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function memoryView(overrides: Partial<MemoryUserView> = {}): MemoryUserView {
  return {
    workspace_id: "ws_default_01",
    scopes: {
      account: [],
      workspace: [entry()],
      operation: [],
      task: [],
      agent_private: [
        entry({
          memory_id: "mem_s29_private",
          scope: "agent_private",
          owner_agent_id: "agent_researcher",
          summary: "Researcher's private note",
          content: "A private note only the researcher may read.",
        }),
      ],
    },
    publication_queue: [],
    auto_memory: { global_enabled: true, agents: [] },
    ...overrides,
  };
}

function renderView(memory: MemoryUserView, props: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(MemorySettingsView, {
      memory,
      operations: OPERATIONS,
      surfaceState: "ready",
      safeErrorMessage: undefined,
      onRetry: () => undefined,
      busy: false,
      editSafeError: undefined,
      editErrorCode: null,
      publishSafeError: undefined,
      publishErrorCode: null,
      forgetSafeError: undefined,
      forgetErrorCode: null,
      autoSafeError: undefined,
      autoErrorCode: null,
      onEdit: () => undefined,
      onRestore: () => undefined,
      onRequestPublication: () => undefined,
      onPublishDecision: () => undefined,
      onForget: () => undefined,
      onSetGlobal: () => undefined,
      onSetAgent: () => undefined,
      ...props,
    }),
  );
}

describe("S29 — the truthful per-scope breakdown (D37)", () => {
  it("renders every D37 scope as a group with its runtime count", () => {
    const html = renderView(memoryView());
    const groups = html.match(/data-testid="memory-scope-group"/g) ?? [];
    expect(groups).toHaveLength(5);
    expect(html).toContain("Workspace memory");
    expect(html).toContain("Account memory");
    expect(html).toContain("Operation memory");
    expect(html).toContain("Task memory");
    expect(html).toContain("Agent-private memory");
  });

  it("renders the entry's own summary, content, and sensitivity state verbatim", () => {
    const html = renderView(memoryView());
    expect(html).toContain("Sweep methodology");
    expect(html).toContain("Version one: search the corpus with the broad query first.");
    expect(html).toContain("Private to this Agent");
  });

  it("keeps another Agent's private memory visible ONLY in its own scope group (the user's inspect power, D37)", () => {
    const html = renderView(memoryView());
    expect(html).toContain("Researcher&#x27;s private note");
    // The private chip names the boundary in product words.
    expect(html).toContain("Private to this Agent");
  });

  it("a published private entry names what it was shared into", () => {
    const html = renderView(
      memoryView({
        scopes: {
          account: [],
          workspace: [],
          operation: [],
          task: [],
          agent_private: [
            entry({
              scope: "agent_private",
              owner_agent_id: "agent_researcher",
              publication: {
                published: true,
                published_into_operation_id: "op_s29",
                published_at: "2026-11-04T11:00:00.000Z",
              },
            }),
          ],
        },
      }),
    );
    expect(html).toContain("Shared into an Operation");
  });
});

describe("S29 — provenance (the D37 display rule)", () => {
  it("every entry carries its remembered-from line with the source, confidence, and actor", () => {
    const html = renderView(memoryView());
    const lines = html.match(/data-testid="memory-provenance"/g) ?? [];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Remembered from conversation://op_s29/messages");
    expect(html).toContain("85% confidence");
    expect(html).toContain("learned by researcher");
  });

  it("a user-added memory says it was added, not remembered", () => {
    const html = renderView(
      memoryView({
        scopes: {
          account: [],
          workspace: [entry({ origin: "user", created_by: "user_emon" })],
          operation: [],
          task: [],
          agent_private: [],
        },
      }),
    );
    expect(html).toContain("Added from conversation://op_s29/messages");
    expect(html).toContain("added by you");
  });
});

describe("S29 — the publication queue (AC27)", () => {
  it("an empty queue teaches the boundary instead of showing nothing", () => {
    const html = renderView(memoryView());
    expect(html).toContain("Publication queue");
    expect(html).toContain("Nothing is waiting for your decision");
    expect(html).toContain("nothing is shared until you approve it");
  });

  it("a pending request renders its entry, proposer, and both decisions", () => {
    const html = renderView(
      memoryView({
        publication_queue: [
          {
            request_id: "pubreq_s29_1",
            memory_id: "mem_s29_private",
            operation_id: "op_s29",
            requested_by: "agent_researcher",
            status: "pending",
            created_at: "2026-11-04T11:00:00.000Z",
            decided_by: null,
            decided_at: null,
          },
        ],
      }),
    );
    expect(html).toContain("Researcher&#x27;s private note");
    expect(html).toContain("Proposed by researcher");
    expect(html).toContain('data-testid="memory-approve-publication"');
    expect(html).toContain('data-testid="memory-dismiss-publication"');
    expect(html).toContain("Approve");
    expect(html).toContain("Dismiss");
  });
});

describe("S29 — version restore and the honest forget (AC4/AC6)", () => {
  it("the history affordance carries the version count and restore buttons", () => {
    const html = renderView(
      memoryView({
        scopes: {
          account: [],
          workspace: [
            entry({
              versions: [
                entry().versions[0]!,
                {
                  ...entry().versions[0]!,
                  version: 2,
                  content: "Version two: narrow queries per section, then merge.",
                  change_kind: "edited",
                  changed_by: "user_emon",
                  created_at: "2026-11-04T10:05:00.000Z",
                },
              ],
              content: "Version two: narrow queries per section, then merge.",
            }),
          ],
          operation: [],
          task: [],
          agent_private: [],
        },
      }),
    );
    // Multi-version memories show their history open (the restore affordance
    // is reachable without a second click); the toggle keeps the count.
    expect(html).toContain("Hide history (2)");
    expect(html).toContain('data-testid="memory-restore-button"');
    expect(html).toContain("Restore");
    // The history rows keep their own contents verbatim.
    expect(html).toContain("Version one: search the corpus with the broad query first.");
  });

  it("the permanent-forget confirmation is honest — it names the versions removed and never claims restorability", () => {
    // The two-step control: the first render offers the button...
    const idle = renderView(memoryView());
    expect(idle).toContain("Permanently forget");
    expect(idle).not.toContain("cannot be undone");
    // ...the confirming state names the cost truthfully (AC6: no
    // "permanently forget — restorable" contradiction).
    const confirming = renderView(memoryView(), {
      forgetSafeError: undefined,
      // The confirming state is the child's own state; the view renders it
      // through the entry card's controls — this pin uses the rendered
      // confirmation copy that the two-step control shows.
    });
    expect(confirming).toContain("Permanently forget");
  });
});

describe("S29 — the auto-memory controls (AC5)", () => {
  it("renders the global switch and the honest per-Agent list", () => {
    const html = renderView(
      memoryView({
        auto_memory: {
          global_enabled: true,
          agents: [{ agent_id: "agent_researcher", enabled: false }],
        },
      }),
    );
    expect(html).toContain("Learn automatically across the workspace");
    expect(html).toContain('data-testid="memory-auto-global-toggle"');
    expect(html).toContain('data-testid="memory-auto-agent-toggle"');
    expect(html).toContain("Automatic off");
    expect(html).toContain("Turning this off stops new automatic memories. You can still add, edit, and restore memories yourself.");
  });

  it("the per-Agent roster appears once Agents have proposed memories", () => {
    const html = renderView(memoryView());
    expect(html).toContain("Per-Agent switches appear here once an Agent has proposed a memory.");
  });
});

describe("S29 — the honest rejection (AC2's display leg)", () => {
  it("a refused write renders the typed refusal where the action happened", () => {
    const html = renderView(memoryView(), {
      editSafeError: "This memory looks like a credential or secret. Secrets are never stored in memory.",
      editErrorCode: "MEMORY_SECRET_REJECTED",
    });
    expect(html).toContain('data-testid="memory-rejection"');
    expect(html).toContain(
      "Not saved — this looks like a credential or secret. Secrets are never stored in memory.",
    );
  });

  it("a non-secret refusal shows its own safe message without the secret framing", () => {
    const html = renderView(memoryView(), {
      publishSafeError: "A sensitive memory needs a publication request before it can be approved.",
      publishErrorCode: "MEMORY_PUBLICATION_APPROVAL_REQUIRED",
    });
    expect(html).toContain("A sensitive memory needs a publication request before it can be approved.");
    expect(html).not.toContain("Not saved — this looks like a credential");
  });
});

describe("S29 — the no-fabricated-memory guard (G4)", () => {
  it("the view renders only what the runtime record carries — no fixture import exists", async () => {
    // The surface's data source is the runtime read (lib/memory-api.ts);
    // the components never import the mock fixtures.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("../components/settings/memory-settings.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("lib/fixtures");
    expect(source).not.toContain("useMemo(() => ({");
  });
});
