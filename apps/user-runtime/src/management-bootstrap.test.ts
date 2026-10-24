import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { startRuntimeNode } from "./main.ts";

const token = "audit-only-management-token";
const digest = createHash("sha256").update(token).digest("hex");
describe("production management boot", () => {
  it("authenticates registration, refuses a foreign account and binds local commands to its owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-management-"));
    const node = await startRuntimeNode({
      port: 0,
      dbPath: join(dir, "runtime.db"),
      defaultWorkspaceId: "ws_owner",
      management: { host: "127.0.0.1", port: 0, accountId: "owner", credentialSha256: digest },
    });
    try {
      expect(node.managementPort).toBeGreaterThan(0);
      const base = `http://127.0.0.1:${node.managementPort}`;
      const registration = {
        account_id: "owner",
        runtime_handle: "rt_" + "a".repeat(32),
        tier: "balanced",
      };
      const post = (path: string, body: unknown, authenticated = true) =>
        fetch(base + path, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      expect((await post("/internal/v1/registration", registration, false)).status).toBe(401);
      expect(
        (await post("/internal/v1/registration", { ...registration, account_id: "victim" })).status,
      ).toBe(403);
      expect((await post("/internal/v1/registration", registration)).status).toBe(200);
      const command = {
        type: "conversation.create",
        workspace_id: "ws_owner",
        idempotency_key: "management-proof",
        payload: { title: "Proof" },
      };
      expect((await post("/internal/v1/local/v1/conversations/commands", command)).status).toBe(
        200,
      );
      expect(
        (
          await post("/internal/v1/local/v1/conversations/commands", {
            ...command,
            workspace_id: "ws_victim",
          })
        ).status,
      ).toBe(403);
      expect((await fetch(base + "/v1/agents?workspace_id=ws_owner")).status).toBe(404);
    } finally {
      await node.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("retains committed token rotation across a restart without restoring the old environment digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shera-rotation-"));
    const config = {
      port: 0,
      dbPath: join(dir, "runtime.db"),
      management: { host: "127.0.0.1", port: 0, accountId: "owner", credentialSha256: digest },
    };
    let node = await startRuntimeNode(config);
    const next = "audit-only-next-token";
    try {
      const base = `http://127.0.0.1:${node.managementPort}`;
      expect(
        (
          await fetch(base + "/internal/v1/credentials", {
            method: "PUT",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              credential_sha256: createHash("sha256").update(next).digest("hex"),
            }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(base + "/internal/v1/credentials/commit", {
            method: "POST",
            headers: { authorization: `Bearer ${next}`, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(200);
      await node.stop();
      node = await startRuntimeNode(config);
      const health = `http://127.0.0.1:${node.managementPort}/internal/v1/health`;
      expect((await fetch(health, { headers: { authorization: `Bearer ${token}` } })).status).toBe(
        401,
      );
      expect((await fetch(health, { headers: { authorization: `Bearer ${next}` } })).status).toBe(
        200,
      );
      const persisted = readFileSync(join(dir, ".runtime-control", "channel.json"), "utf8");
      expect(persisted).not.toContain(token);
      expect(persisted).not.toContain(next);
    } finally {
      await node.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
