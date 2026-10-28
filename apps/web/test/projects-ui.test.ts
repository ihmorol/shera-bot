import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MergeRequestCard, mergeRequestStatusCopy } from "../components/settings/git-settings";
import { OperationRunsPanel } from "../components/operations/operation-runs-panel";
import { fetchGitLinkage } from "../lib/projects-api";
import type { MergeRequestView, ProjectDetail } from "../lib/projects-api";
import { OperationRun } from "@shera-bot/contracts";

/**
 * S19 chunk 2 — the merge review surface (UI_DESIGN §S9 "Git & repositories"
 * + the §8 resolution map's merge-review view; PRD §10, D35, G2/G3/G5/G6) and
 * the git-aware run cards, rendered to static markup (node environment, no
 * DOM) like the S13/S20 suites. Data comes from the REAL S19 projects HTTP
 * surface under /v1/projects, reached through the same-origin runtime proxy;
 * fetch is stubbed at that boundary, and the real round trip is proven in
 * apps/user-runtime (git.service, validation-runner, archive-import,
 * git.credential-clone, s19-projects-api suites).
 *
 * The merge review renders EXACTLY the minimal PRD §10 fields — change
 * summary, changed files, validation status, conflict status, target branch —
 * with the three decisions; decisions are immutable, so the post-decision
 * state replaces the buttons. There is no force-push affordance anywhere, and
 * no secret material can render (the read models carry masked hints only).
 */
const render = (element: ReactElement): string => renderToStaticMarkup(element);
const WORKSPACE = "ws_account-1";

function makeMergeRequest(overrides: Partial<MergeRequestView> = {}): MergeRequestView {
  return {
    workspace_id: WORKSPACE,
    project_id: "prj_demo_01",
    merge_request_id: "mr_01",
    task_id: "task_run_demo_01",
    agent_id: "agent_developer",
    source_branch: "shera/task/task_run_demo_01",
    target_branch: "main",
    change_summary: "Fix the login validation.",
    changed_files: ["src/login.ts"],
    validation_status: "not_run",
    validation_note: null,
    conflict_status: "clean",
    conflict_files: [],
    approval_id: "apr_01",
    status: "awaiting_approval",
    status_reason: null,
    merged_commit: null,
    created_at: "2026-10-29T10:00:00.000Z",
    updated_at: "2026-10-29T10:00:00.000Z",
    ...overrides,
  };
}

function makeProjectDetail(mergeRequests: MergeRequestView[]): ProjectDetail {
  return {
    project: {
      workspace_id: WORKSPACE,
      project_id: "prj_demo_01",
      name: "demo-repo",
      source_kind: "git_url",
      source_url: "https://example.invalid/demo-repo.git",
      repo_path: "/container/projects/prj_demo_01/repo",
      default_branch: "main",
      access_mode: "shared",
      created_by: { type: "user", id: "user_001" },
      created_at: "2026-10-29T10:00:00.000Z",
      updated_at: "2026-10-29T10:00:00.000Z",
    },
    worktrees: [
      {
        workspace_id: WORKSPACE,
        project_id: "prj_demo_01",
        worktree_id: "wt_01",
        task_id: "task_run_demo_01",
        agent_id: "agent_developer",
        branch_name: "shera/task/task_run_demo_01",
        worktree_path: "/container/projects/prj_demo_01/worktrees/wt_01",
        status: "active",
        queue_reason: null,
        created_at: "2026-10-29T10:00:00.000Z",
        updated_at: "2026-10-29T10:00:00.000Z",
      },
      {
        workspace_id: WORKSPACE,
        project_id: "prj_demo_01",
        worktree_id: "wt_02",
        task_id: "task_run_demo_02",
        agent_id: "agent_researcher",
        branch_name: "shera/task/task_run_demo_02",
        worktree_path: "/container/projects/prj_demo_01/worktrees/wt_02",
        status: "queued",
        queue_reason:
          "active worktree wt_01 held by task task_run_demo_01; related conflicting work queues until the earlier change finishes (D6/E6)",
        created_at: "2026-10-29T10:01:00.000Z",
        updated_at: "2026-10-29T10:01:00.000Z",
      },
    ],
    merge_requests: mergeRequests,
    credentials: [
      {
        workspace_id: WORKSPACE,
        project_id: "prj_demo_01",
        credential_id: "cred_01",
        credential_kind: "token",
        username: "x-access-token",
        masked_hint: "••••5678",
        created_at: "2026-10-29T10:00:00.000Z",
        revoked_at: null,
      },
    ],
  };
}

function makeRun(runId: string, overrides: Partial<OperationRun> = {}): OperationRun {
  return OperationRun.parse({
    run_id: runId,
    workspace_id: WORKSPACE,
    operation_id: "operation_demo",
    parent_task_id: null,
    state: "RUNNING",
    events_seq_cursor: 4,
    credits: {},
    artifacts: [],
    created_at: "2026-10-29T10:00:00.000Z",
    updated_at: "2026-10-29T10:00:00.000Z",
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const CARD_BASE = {
  projectName: "demo-repo",
  decisionPending: false,
  validationPending: false,
  sessionReady: true,
  decisionError: null,
  onDecide: () => undefined,
  onRunValidation: () => undefined,
};

describe("merge review surface: exactly the minimal PRD §10 fields", () => {
  it("renders change summary, changed files, validation, conflict, and target branch while awaiting review", () => {
    const markup = render(
      createElement(MergeRequestCard, {
        ...CARD_BASE,
        mergeRequest: makeMergeRequest({
          changed_files: ["src/login.ts", "src/token.ts"],
          validation_status: "failed",
          validation_note: "Validation failed: npm run test failed with exit code 3.",
          conflict_status: "conflict",
          conflict_files: ["src/token.ts"],
        }),
      }),
    );
    expect(markup).toContain("Fix the login validation.");
    expect(markup).toContain("src/login.ts");
    expect(markup).toContain("src/token.ts");
    expect(markup).toContain("shera/task/task_run_demo_01");
    expect(markup).toContain("main");
    expect(markup).toContain("Validation failed");
    expect(markup).toContain("npm run test failed with exit code 3");
    expect(markup).toContain("Conflicts with main");
    // The three PRD §10 decisions, plus the validation affordance.
    expect(markup).toContain("Approve merge");
    expect(markup).toContain("Request changes");
    expect(markup).toContain("Reject");
    // A FAILED validation offers no re-run button here; the not_run case
    // below is where the runtime's validation is invoked.
    expect(markup).not.toContain("Run validation");
    // G2 in copy, and never any rewritten-history affordance.
    expect(markup).toContain("only after your approval");
    expect(markup.toLowerCase()).not.toContain("force");
  });

  it("offers the runtime validation exactly while validation has not run", () => {
    const notRun = render(
      createElement(MergeRequestCard, {
        ...CARD_BASE,
        mergeRequest: makeMergeRequest({ validation_status: "not_run" }),
      }),
    );
    expect(notRun).toContain("Validation not run");
    expect(notRun).toContain("Run validation");
  });

  it("replaces the buttons with the recorded state after a decision (immutable)", () => {
    for (const status of ["merged", "rejected", "changes_requested"] as const) {
      const markup = render(
        createElement(MergeRequestCard, {
          ...CARD_BASE,
          mergeRequest: makeMergeRequest({ status }),
        }),
      );
      expect(markup).toContain("merge-decided");
      expect(markup).not.toContain("Approve merge");
      expect(markup).not.toContain("Run validation");
      expect(mergeRequestStatusCopy(makeMergeRequest({ status }))).toBeTruthy();
    }
    expect(mergeRequestStatusCopy(makeMergeRequest({ status: "merged" }))).toContain("Merged");
    expect(mergeRequestStatusCopy(makeMergeRequest({ status: "rejected" }))).toContain("Rejected");
    expect(mergeRequestStatusCopy(makeMergeRequest({ status: "changes_requested" }))).toContain(
      "Changes requested",
    );
  });

  it("waits for the session identity before enabling decisions (G6: users decide)", () => {
    const markup = render(
      createElement(MergeRequestCard, {
        ...CARD_BASE,
        sessionReady: false,
        mergeRequest: makeMergeRequest(),
      }),
    );
    expect(markup).toContain("Approve merge");
    expect(markup).toContain('disabled=""');
  });

  it("never renders credential material (masked hints live elsewhere; no read-back exists)", () => {
    const markup = render(
      createElement(MergeRequestCard, {
        ...CARD_BASE,
        mergeRequest: makeMergeRequest(),
      }),
    );
    expect(markup).not.toContain("masked_hint");
    expect(markup).not.toContain("\u2022\u2022\u2022\u20225678");
  });
});

describe("git-aware run cards", () => {
  it("renders the git line (project, branch, worktree state, validation) only when linkage exists", () => {
    const run = makeRun("task_run_demo_01");
    const withGit = render(
      createElement(OperationRunsPanel, {
        runs: [run],
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        onCreateRun: () => undefined,
        createPending: false,
        gitLinkage: {
          task_run_demo_01: {
            project_id: "prj_demo_01",
            project_name: "demo-repo",
            branch_name: "shera/task/task_run_demo_01",
            worktree_status: "active",
            queue_reason: null,
            validation_status: "passed",
            merge_request_id: "mr_01",
          },
        },
      }),
    );
    expect(withGit).toContain("operation-run-git");
    expect(withGit).toContain("demo-repo");
    expect(withGit).toContain("shera/task/task_run_demo_01");
    expect(withGit).toContain("active");
    expect(withGit).toContain("operation-run-validation");
    expect(withGit).toContain("validation passed");

    // A run without git work renders NO git line — never an invented branch.
    const plain = render(
      createElement(OperationRunsPanel, {
        runs: [makeRun("task_run_other")],
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        onCreateRun: () => undefined,
        createPending: false,
        gitLinkage: {
          task_run_demo_01: {
            project_id: "prj_demo_01",
            project_name: "demo-repo",
            branch_name: "shera/task/task_run_demo_01",
            worktree_status: "active",
            queue_reason: null,
            validation_status: "failed",
            merge_request_id: "mr_01",
          },
        },
      }),
    );
    expect(plain).not.toContain("operation-run-git");
  });

  it("renders the queue reason on a queued worktree's run card (G5: the wait is visible)", () => {
    const markup = render(
      createElement(OperationRunsPanel, {
        runs: [makeRun("task_run_demo_02", { state: "QUEUED" })],
        state: "ready",
        safeErrorMessage: undefined,
        onRetry: () => undefined,
        onCreateRun: () => undefined,
        createPending: false,
        gitLinkage: {
          task_run_demo_02: {
            project_id: "prj_demo_01",
            project_name: "demo-repo",
            branch_name: "shera/task/task_run_demo_02",
            worktree_status: "queued",
            queue_reason: "active worktree wt_01 held by task task_run_demo_01",
            validation_status: null,
            merge_request_id: null,
          },
        },
      }),
    );
    expect(markup).toContain("queued");
    expect(markup).toContain("active worktree wt_01 held by task task_run_demo_01");
    // No merge request for this task yet: no validation claim at all —
    // the card stays quiet rather than implying a check ran.
    expect(markup).not.toContain("validation");
  });
});

describe("git-linkage join over the real API shape", () => {
  it("joins worktrees and merge requests per task id across projects", async () => {
    const detail = makeProjectDetail([
      makeMergeRequest({ validation_status: "failed", validation_note: "boom" }),
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const path = String(input);
        if (path.includes("/v1/projects?")) {
          return new Response(
            JSON.stringify({
              projects: [
                {
                  workspace_id: WORKSPACE,
                  project_id: "prj_demo_01",
                  name: "demo-repo",
                  source_kind: "git_url",
                  source_url: "https://example.invalid/demo-repo.git",
                  repo_path: "/container/projects/prj_demo_01/repo",
                  default_branch: "main",
                  access_mode: "shared",
                  created_by: { type: "user", id: "user_001" },
                  created_at: "2026-10-29T10:00:00.000Z",
                  updated_at: "2026-10-29T10:00:00.000Z",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (path.includes("/v1/projects/prj_demo_01?")) {
          return new Response(JSON.stringify(detail), { status: 200 });
        }
        throw new Error(`unexpected fetch ${path}`);
      }),
    );
    const linkage = await fetchGitLinkage(WORKSPACE);
    const joined = linkage["task_run_demo_01"];
    expect(joined?.project_name).toBe("demo-repo");
    expect(joined?.branch_name).toBe("shera/task/task_run_demo_01");
    expect(joined?.worktree_status).toBe("active");
    expect(joined?.validation_status).toBe("failed");
    expect(linkage["task_run_demo_02"]?.worktree_status).toBe("queued");
  });
});
