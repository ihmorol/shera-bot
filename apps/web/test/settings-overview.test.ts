/**
 * S30 chunk 5 — the D16 settings register (issue #31; D16, UI_DESIGN §S9,
 * G4): the overview index enumerates ALL FIFTEEN recorded categories and
 * links only real sections; the new surfaces render the runtime's own
 * records; the Account surface's reopen control issues the typed
 * onboarding.reopen command (D16: reopenable; onboarding and settings share
 * commands/schemas); the recorded read-only categories say so IN THE
 * DECISION'S OWN WORDS instead of carrying an invented control (G4/G5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SETTINGS_CATEGORIES, SETTINGS_CATEGORY_SLUGS } from "../lib/settings-categories";
import { submitOnboardingCommand } from "../lib/onboarding-api";
import {
  AccountSettingsView,
  storageUsageLine,
} from "../components/settings/account-settings";
import { WorkspaceSettingsView } from "../components/settings/workspace-settings";
import { FilesSettingsView } from "../components/settings/files-settings";
import { PrivacySettingsView } from "../components/settings/privacy-settings";
import { BackupsSettingsView } from "../components/settings/backups-settings";
import { SettingsOverview } from "../components/settings/settings-overview";

const WORKSPACE = "ws_default_01";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("The D16 settings register", () => {
  it("enumerates exactly the fifteen recorded categories", () => {
    expect(SETTINGS_CATEGORY_SLUGS).toEqual([
      "account",
      "agents",
      "providers",
      "credits",
      "tools",
      "permissions",
      "workspace",
      "files",
      "memory",
      "schedules",
      "notifications",
      "privacy",
      "runtime",
      "git",
      "backups",
    ]);
  });

  it("every category slug is a real section of the settings catch-all page", () => {
    const page = join(import.meta.dirname, "../app/app/settings/[[...section]]/page.tsx");
    const source = readFileSync(page, "utf8");
    const missing = SETTINGS_CATEGORY_SLUGS.filter(
      (slug) => !source.includes(`section[0] === "${slug}"`),
    );
    expect(missing, `categories without a section: ${missing.join(", ")}`).toEqual([]);
  });

  it("the overview renders all fifteen categories; the read-only ones carry the decision's own words", () => {
    const html = renderToStaticMarkup(createElement(SettingsOverview));
    for (const category of SETTINGS_CATEGORIES) {
      // Static markup escapes & — normalize before the label check.
      expect(html.replace(/&amp;/g, "&")).toContain(category.label);
      expect(html).toContain(`href="/app/settings/${category.slug}"`);
    }
    // The recorded read-only postures are stated, never disguised as controls.
    expect(html).toContain("D40");
    expect(html).toContain("read-only");
  });
});

describe("Account settings (S9 Account)", () => {
  it("renders the session identity, the tier, and the honest storage line", () => {
    const html = renderToStaticMarkup(
      createElement(AccountSettingsView, {
        displayName: "Emon",
        email: "emon@example.com",
        tier: "balanced",
        onboardingStatus: "pending",
        surfaceState: "ready",
        safeErrorMessage: undefined,
        commandPending: false,
        commandSafeError: undefined,
        pendingReopen: false,
        onReopenClick: () => undefined,
        onReopenConfirm: () => undefined,
        onReopenCancel: () => undefined,
      }),
    );
    expect(html).toContain("emon@example.com");
    expect(html).toContain("Balanced");
    // G4: no fabricated usage number — the honest statement instead.
    expect(storageUsageLine(null)).toContain("not measured");
  });

  it("the reopen-onboarding control is armed, confirmed, and issues the typed onboarding.reopen command", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { accepted: true }));
    vi.stubGlobal("fetch", fetchMock);
    await submitOnboardingCommand(WORKSPACE, {
      command_id: "cmd_reopen_1",
      idempotency_key: "idem_reopen_1",
      workspace_id: WORKSPACE,
      actor: { type: "user", id: "google-1" },
      issued_at: "2026-11-08T10:00:00.000Z",
      type: "onboarding.reopen",
    });
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/runtime/v1/onboarding/commands");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["type"]).toBe("onboarding.reopen");

    // The control renders armed-and-confirmed (no destructive single click).
    const armed = renderToStaticMarkup(
      createElement(AccountSettingsView, {
        displayName: "Emon",
        email: "emon@example.com",
        tier: "balanced",
        onboardingStatus: "dismissed",
        surfaceState: "ready",
        safeErrorMessage: undefined,
        commandPending: false,
        commandSafeError: undefined,
        pendingReopen: true,
        onReopenClick: () => undefined,
        onReopenConfirm: () => undefined,
        onReopenCancel: () => undefined,
      }),
    );
    expect(armed).toContain("Confirm reopen");
    expect(armed).toContain("Cancel");
  });
});

describe("The read-only categories render the runtime's own records (G4)", () => {
  it("Workspace: the pinned pack display with the D40 statement — no switcher", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceSettingsView));
    expect(html).toContain("student pack v1");
    expect(html).toContain("no workspace or pack switcher");
    expect(html).toContain("D40");
  });

  it("Files & projects: the projects list from the runtime with honest empty state", () => {
    const empty = renderToStaticMarkup(
      createElement(FilesSettingsView, {
        projects: [],
        surfaceState: "ready",
        safeErrorMessage: undefined,
      }),
    );
    expect(empty).toContain("Connected projects will appear here");
    expect(empty).toContain('data-testid="files-empty-cta"');
    const listed = renderToStaticMarkup(
      createElement(FilesSettingsView, {
        projects: [
          {
            workspace_id: WORKSPACE,
            project_id: "proj_1",
            name: "research-paper",
            source_kind: "git_url",
            source_url: "https://github.com/example/research-paper",
            repo_path: "/workspace/research-paper",
            default_branch: "main",
            access_mode: "shared",
            created_by: { type: "user", id: "google-1" },
            created_at: "2026-11-01T00:00:00.000Z",
            updated_at: "2026-11-01T00:00:00.000Z",
          },
        ],
        surfaceState: "ready",
        safeErrorMessage: undefined,
      }),
    );
    expect(listed).toContain("research-paper");
    expect(listed).toContain("main");
  });

  it("Privacy & retention: the redaction and data-location statements (D2, PRD §12)", () => {
    const html = renderToStaticMarkup(createElement(PrivacySettingsView));
    expect(html).toContain("never automatically delete");
    expect(html).toContain("inside your workspace container");
    expect(html).toContain("redacted");
  });

  it("Backups & recovery: the recorded snapshot posture plus the runtime's own recovery status", () => {
    const html = renderToStaticMarkup(
      createElement(BackupsSettingsView, {
        recoveryState: "idle",
        reviewNeededCount: 0,
        surfaceState: "ready",
        safeErrorMessage: undefined,
      }),
    );
    expect(html).toContain("every six hours");
    expect(html).toContain("latest seven");
    expect(html).toContain("administrator");
    expect(html).toContain("Idle");
  });
});
