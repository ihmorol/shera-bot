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

describe("workspace panel allowlist (S17, D6/D39/G6)", () => {
  it("allows the workspace reads the panel renders", () => {
    for (const path of [
      "/v1/workspace/nodes",
      "/v1/workspace/files",
      "/v1/workspace/leases",
      "/v1/workspace/artifacts",
      "/v1/workspace/artifacts/artifact_1",
    ])
      expect(isBrowserRuntimePath("GET", path)).toBe(true);
  });

  it("allows the typed workspace writes the panel performs", () => {
    expect(isBrowserRuntimePath("PUT", "/v1/workspace/files")).toBe(true);
    for (const path of [
      "/v1/workspace/files/upload",
      "/v1/workspace/directories",
      "/v1/workspace/delete",
      "/v1/workspace/leases",
      "/v1/workspace/leases/lease_1/renew",
      "/v1/workspace/artifacts",
    ])
      expect(isBrowserRuntimePath("POST", path)).toBe(true);
    expect(isBrowserRuntimePath("DELETE", "/v1/workspace/leases/lease_1")).toBe(true);
  });

  it("never allows the runtime-internal task-terminal force-release (D6)", () => {
    expect(isBrowserRuntimePath("POST", "/v1/workspace/leases/release-for-task")).toBe(false);
  });

  it("still refuses everything outside the workspace panel surface", () => {
    for (const [method, path] of [
      ["GET", "/v1/workspace"],
      ["GET", "/v1/workspace/nodes/extra"],
      ["POST", "/v1/workspace/files/upload/extra"],
      ["PATCH", "/v1/workspace/files"],
      ["DELETE", "/v1/workspace/files"],
      ["DELETE", "/v1/workspace/delete"],
      ["GET", "/v1/workspace/../secrets"],
      ["POST", "/v1/workspace/files%2fupload"],
    ] as const)
      expect(isBrowserRuntimePath(method, path)).toBe(false);
  });
});
