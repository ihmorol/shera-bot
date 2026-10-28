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
  it("allowlists the S20 approvals reads and the three approval mutations", () => {
    // The web UI's approvals seam (§S8): the pending list, the detail card,
    // and the grants/mutes lists are GETs; the decision, the grant revoke,
    // the mute, and the due-reminder scan are POSTs. Every route is
    // workspace-scoped (E12) — the workspace selector check above still
    // applies to all of them. (S20 review fix F3: the scan MOVED to POST — a
    // GET that stamps delivered_at was a state mutation on a read verb, with
    // no Origin check; the S15-precedent command-convention applies.)
    for (const path of [
      "/v1/approvals/pending",
      "/v1/approvals/approval_pending_01",
      "/v1/approvals/grants",
      "/v1/approvals/mutes",
    ])
      expect(isBrowserRuntimePath("GET", path), `GET ${path}`).toBe(true);
    expect(isBrowserRuntimePath("GET", "/v1/approvals/unknown%2f")).toBe(false);
    for (const [method, path] of [
      ["POST", "/v1/approvals/approval_pending_01/decision"],
      ["POST", "/v1/approvals/grants/revoke"],
      ["POST", "/v1/approvals/mutes"],
      ["POST", "/v1/approvals/due-reminders"],
    ] as const)
      expect(isBrowserRuntimePath(method, path), `${method} ${path}`).toBe(true);
    // No other mutation class opens up: no approval creation, no un-mute, no
    // un-revoke (write-once semantics live in the runtime, not the browser),
    // a decision stays POST-only, and the state-mutating reminder scan is no
    // longer reachable as a GET.
    expect(isBrowserRuntimePath("POST", "/v1/approvals/pending")).toBe(false);
    expect(isBrowserRuntimePath("DELETE", "/v1/approvals/mutes/mute_01")).toBe(false);
    expect(isBrowserRuntimePath("GET", "/v1/approvals/approval_pending_01/decision")).toBe(false);
    expect(isBrowserRuntimePath("GET", "/v1/approvals/due-reminders")).toBe(false);
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

  it("allowlists the S19 merge-review reads and its two mutations — nothing more", () => {
    // The web UI's projects seam (§S9 Git & repositories, PRD §10): the
    // project list, one project's detail, the worktree ledger, and the
    // merge-request queue are GETs; the runtime's validation run and the PRD
    // §10 decision are POSTs. Deliberately ABSENT (Agent/runtime-owned
    // surfaces, G2/G6): project import/clone, credential store/revoke,
    // worktree allocation/release, merge-request preparation — and there is
    // no secret read-back at all (D22).
    for (const path of [
      "/v1/projects",
      "/v1/projects/prj_demo_01",
      "/v1/projects/prj_demo_01/worktrees",
      "/v1/projects/prj_demo_01/merge-requests",
    ])
      expect(isBrowserRuntimePath("GET", path), `GET ${path}`).toBe(true);
    for (const path of [
      "/v1/projects/prj_demo_01/merge-requests/mr_01/decision",
      "/v1/projects/prj_demo_01/merge-requests/mr_01/validation",
    ])
      expect(isBrowserRuntimePath("POST", path), `POST ${path}`).toBe(true);
    for (const [method, path] of [
      ["POST", "/v1/projects"],
      ["POST", "/v1/projects/prj_demo_01/worktrees"],
      ["POST", "/v1/projects/prj_demo_01/credentials"],
      ["POST", "/v1/projects/prj_demo_01/credentials/cred_1/revoke"],
      ["POST", "/v1/projects/prj_demo_01/worktrees/wt_1/release"],
      ["POST", "/v1/projects/prj_demo_01/merge-requests"],
      ["GET", "/v1/projects/prj_demo_01/credentials"],
      ["GET", "/v1/projects/prj_demo_01/merge-requests/mr_01"],
      ["GET", "/v1/projects/prj_demo_01/merge-requests/../.."],
      ["POST", "/v1/projects/prj_demo_01/merge-requests/mr_01/decide"],
    ] as const)
      expect(isBrowserRuntimePath(method, path), `${method} ${path}`).toBe(false);
  });
});

describe("live views allowlist (S18, G6 — read-only, no takeover)", () => {
  it("allowlists the five read-only live-view GETs the panels render", () => {
    for (const path of [
      "/v1/terminals/events",
      "/v1/terminals/state",
      "/v1/terminals/term_01",
      "/v1/browser/view",
      "/v1/browser/state",
    ])
      expect(isBrowserRuntimePath("GET", path), `GET ${path}`).toBe(true);
  });

  it("opens NO mutation path on the live-view resources (no takeover affordance)", () => {
    // The UI gate's no-takeover rule starts here: the browser cannot even
    // REACH a terminal stdin write, a signal send, or a browser navigation —
    // the proxy refuses every non-GET verb on the live-view paths before the
    // runtime is consulted (and the runtime itself registers only GETs).
    for (const [method, path] of [
      ["POST", "/v1/terminals/events"],
      ["POST", "/v1/terminals/state"],
      ["POST", "/v1/terminals/term_01"],
      ["PUT", "/v1/terminals/term_01"],
      ["DELETE", "/v1/terminals/term_01"],
      ["PATCH", "/v1/terminals/term_01"],
      ["POST", "/v1/browser/view"],
      ["POST", "/v1/browser/state"],
      ["PUT", "/v1/browser/state"],
      ["DELETE", "/v1/browser/state"],
      ["POST", "/v1/browser/navigate"],
      ["POST", "/v1/terminals/term_01/stdin"],
      ["POST", "/v1/terminals/term_01/signal"],
    ] as const)
      expect(isBrowserRuntimePath(method, path), `${method} ${path}`).toBe(false);
  });
});
