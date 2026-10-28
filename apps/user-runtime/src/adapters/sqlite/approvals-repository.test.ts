/**
 * The approvals repository's write-once guards (S20 review fix F4), tested
 * directly at the repository level — real SQLite, real migrations, no service
 * above them. The SERVICE's in-transaction checks remain the first line
 * (decisions are immutable, D9; revocation is write-once); these guards make
 * the WRITERS themselves idempotent no-ops, so a raced second write cannot
 * re-stamp history even if it ever reaches SQL:
 *
 *   - resolveRequest only moves a PENDING request off pending — an already
 *     resolved row is untouched (the first resolution stands), and the call
 *     answers false;
 *   - revokeGrant only stamps an UNREVOKED grant — an already revoked row is
 *     untouched (the first revoked_at stands, never re-stamped), and the call
 *     answers false.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import type { ApprovalGrant, ApprovalRequest } from "@shera-bot/contracts";

import { ApprovalsRepository, type ApprovalGrantRecord } from "./approvals-repository.ts";
import { openDatabase, type SqliteConnection } from "./connection.ts";
import { applyMigrations } from "./migrations.ts";
import { SqliteTransactions } from "./transactions.ts";

const tempDirs: string[] = [];

const WS = "ws_guard_01";
const NOW = "2026-10-28T12:00:00.000Z";

function newRepo(): { conn: SqliteConnection; repo: ApprovalsRepository } {
  const dir = mkdtempSync(join(tmpdir(), "shera-runtime-approvals-repo-"));
  tempDirs.push(dir);
  const conn = openDatabase(join(dir, "runtime.db"));
  applyMigrations(conn.db);
  return { conn, repo: new ApprovalsRepository(new SqliteTransactions(conn.db)) };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function requestFixture(approvalId: string): ApprovalRequest {
  return {
    workspace_id: WS,
    approval_id: approvalId,
    task_id: "task_guard_001",
    conversation_id: "conv_guard_001",
    tool_id: "tool_repo_push",
    tool_version: "1.2.0",
    capability: "repo.push",
    risk_class: "EXTERNAL_WRITE",
    resource_scope: "workspace://notes/draft.md",
    args_digest: `sha256:${"a".repeat(64)}`,
    side_effect_summary: "Pushes local commits to the configured remote repository.",
    requested_by: { type: "agent", id: "agent_general_assistant" },
    requested_at: NOW,
    status: "pending",
  };
}

function grantFixture(grantId: string): ApprovalGrantRecord {
  const grant: ApprovalGrant = {
    grant_id: grantId,
    workspace_id: WS,
    source_choice: "always-approve-this-tool",
    principal_type: "task",
    principal_id: "task_guard_001",
    tool_id: "tool_repo_push",
    tool_version: "1.2.0",
    capability: "repo.push",
    resource_scope: "workspace://notes/draft.md",
    conversation_scope: "conv_guard_001",
    workspace_scope: WS,
    expires_at: null,
    one_time: false,
    created_by: { type: "user", id: "user_guard_001" },
    approved_at: NOW,
    revoked_at: null,
  };
  return { ...grant, args_digest: null, consumed_at: null };
}

describe("approvals repository: resolveRequest is guarded to pending rows (F4a)", () => {
  it("the first resolution wins; a raced second UPDATE is a no-op that changes nothing", () => {
    const { conn, repo } = newRepo();
    try {
      repo.insertRequest(requestFixture("apr_guard_01"));

      const first = repo.resolveRequest(WS, "apr_guard_01", {
        status: "approved",
        resolved_at: NOW,
        resolved_by_choice: "approve-this-execution-only",
      });
      expect(first).toBe(true);

      // A second resolution attempt — same or DIFFERENT choice, later stamp —
      // must not re-stamp the row: decisions are immutable (D9), and the
      // writer itself refuses now.
      expect(
        repo.resolveRequest(WS, "apr_guard_01", {
          status: "rejected",
          resolved_at: "2026-10-28T13:00:00.000Z",
          resolved_by_choice: "reject-this-action",
        }),
      ).toBe(false);

      const row = repo.getRequest(WS, "apr_guard_01");
      expect(row).toMatchObject({
        status: "approved",
        resolved_at: NOW,
        resolved_by_choice: "approve-this-execution-only",
      });
    } finally {
      conn.close();
    }
  });

  it("still resolves a pending row and stays workspace-scoped (E12)", () => {
    const { conn, repo } = newRepo();
    try {
      repo.insertRequest(requestFixture("apr_guard_02"));
      // A foreign workspace's identically-keyed write touches nothing here.
      expect(
        repo.resolveRequest("ws_other", "apr_guard_02", {
          status: "cancelled",
          resolved_at: NOW,
          resolved_by_choice: "cancel-the-task",
        }),
      ).toBe(false);
      expect(repo.getRequest(WS, "apr_guard_02")?.status).toBe("pending");

      expect(
        repo.resolveRequest(WS, "apr_guard_02", {
          status: "cancelled",
          resolved_at: NOW,
          resolved_by_choice: "cancel-the-task",
        }),
      ).toBe(true);
      expect(repo.getRequest(WS, "apr_guard_02")?.status).toBe("cancelled");
    } finally {
      conn.close();
    }
  });
});

describe("approvals repository: revokeGrant is guarded to unrevoked rows (F4b)", () => {
  it("the first revoked_at stamp wins; a raced second revoke is a no-op, not a re-stamp", () => {
    const { conn, repo } = newRepo();
    try {
      repo.insertGrant(grantFixture("grt_guard_01"));

      expect(repo.revokeGrant(WS, "grt_guard_01", NOW)).toBe(true);

      // The second revoke (a later clock) must NOT overwrite the stamp: the
      // revocation instant is part of the audit record, write-once like the
      // decision it came from.
      expect(repo.revokeGrant(WS, "grt_guard_01", "2026-10-28T14:00:00.000Z")).toBe(false);

      const row = repo.listGrants(WS).find((grant) => grant.grant_id === "grt_guard_01");
      expect(row?.revoked_at).toBe(NOW);
    } finally {
      conn.close();
    }
  });

  it("still revokes an unrevoked row and stays workspace-scoped (E12)", () => {
    const { conn, repo } = newRepo();
    try {
      repo.insertGrant(grantFixture("grt_guard_02"));
      expect(repo.revokeGrant("ws_other", "grt_guard_02", NOW)).toBe(false);
      expect(repo.listGrants(WS)[0]?.revoked_at).toBeNull();

      expect(repo.revokeGrant(WS, "grt_guard_02", NOW)).toBe(true);
      expect(repo.listGrants(WS)[0]?.revoked_at).toBe(NOW);
    } finally {
      conn.close();
    }
  });
});
