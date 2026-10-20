import { describe, expect, it } from "vitest";
import { isBrowserRuntimePath, runtimeWorkspaceMatches } from "@shera-bot/contracts";

describe("browser runtime trust boundary", () => {
  it("allows only the actual client read and command surfaces", () => {
    expect(isBrowserRuntimePath("GET", "/v1/agents/agent_researcher/settings")).toBe(true);
    for (const path of [
      "/internal/v1/health",
      "/v1/agents/../health",
      "/v1/agents/%2e%2e",
      "/v1/agents/a\b",
    ])
      expect(isBrowserRuntimePath("GET", path)).toBe(false);
    expect(isBrowserRuntimePath("PATCH", "/v1/agents/a/instructions")).toBe(false);
  });
  it("rejects missing, conflicting and duplicate workspace selectors", () => {
    expect(
      runtimeWorkspaceMatches("GET", new URLSearchParams("workspace_id=ws_a"), null, "ws_a"),
    ).toBe(true);
    expect(runtimeWorkspaceMatches("GET", new URLSearchParams(), null, "ws_a")).toBe(false);
    expect(
      runtimeWorkspaceMatches(
        "GET",
        new URLSearchParams("workspace_id=ws_a&workspace_id=ws_b"),
        null,
        "ws_a",
      ),
    ).toBe(false);
    expect(
      runtimeWorkspaceMatches(
        "POST",
        new URLSearchParams("workspace_id=ws_b"),
        { workspace_id: "ws_a" },
        "ws_a",
      ),
    ).toBe(false);
    expect(
      runtimeWorkspaceMatches("POST", new URLSearchParams(), { workspace_id: "ws_a" }, "ws_a"),
    ).toBe(true);
    expect(
      runtimeWorkspaceMatches("POST", new URLSearchParams(), { workspace_id: "ws_b" }, "ws_a"),
    ).toBe(false);
  });
});
