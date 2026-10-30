/**
 * Execution tools over the composed runtime (S26 chunk 6; PRD §7, D27, D35,
 * E31's recorded deferral, G2/G3/G4) — the composition test: the two sandbox
 * execution tools registered as platform built-ins through the composition
 * option, the D35 facts surfacing through the EXISTING surfaces (the tools
 * inventory + history API; the S18 terminal live view), and the network
 * separation demonstrated at the kernel level (the sandbox's namespace has no
 * routes; the runtime's own namespace does).
 */
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { spawnSandboxedExecution } from "../../adapters/process/execution-process-spawn.ts";
import { ApprovalsRepository } from "../../adapters/sqlite/approvals-repository.ts";
import { composeRuntime, type RuntimeHandle } from "./compose.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = join(here, "../../../../../agent-packs");

const WS = "ws-local-default";
const AGENT = "agent_researcher";
const TASK = "task_s26_composed";
const CONV = "conv_s26_composed";
const NOW = "2026-10-31T12:00:00.000Z";
const HASH = "a".repeat(64);

const tempDirs: string[] = [];

interface RunningRuntime {
  runtime: RuntimeHandle;
  origin: string;
  dir: string;
  workspaceRoot: string;
  close(): Promise<void>;
}

async function composeOn(): Promise<RunningRuntime> {
  const dir = mkdtempSync(join(tmpdir(), "shera-s26-exec-api-"));
  tempDirs.push(dir);
  const workspaceRoot = join(dir, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const runtime = composeRuntime({
    dbPath: join(dir, "runtime.db"),
    packsRoot: PACKS_ROOT,
    now: () => NOW,
    executionTools: {
      workspaceRoots: { [WS]: workspaceRoot },
    },
  });
  await new Promise<void>((resolveListen) =>
    runtime.httpServer.listen(0, "127.0.0.1", resolveListen),
  );
  const address = runtime.httpServer.address() as { port: number };
  return {
    runtime,
    origin: `http://127.0.0.1:${address.port}`,
    dir,
    workspaceRoot,
    close: () => runtime.close(),
  };
}

async function getJson(origin: string, path: string) {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("execution tools over the composed runtime (S26 chunk 6)", () => {
  it("the D35 facts surface through the existing tools inventory (command/workdir/policy via the preview)", async () => {
    const running = await composeOn();
    try {
      const { status, body } = await getJson(running.origin, `/v1/tools?workspace_id=${WS}`);
      expect(status).toBe(200);
      const entries = body["tools"] as Array<Record<string, unknown>>;
      const codeExec = entries.find((entry) => entry["tool_id"] === "tool_code_exec");
      const terminalExec = entries.find((entry) => entry["tool_id"] === "tool_terminal_exec");
      expect(codeExec).toBeDefined();
      expect(terminalExec).toBeDefined();
      expect(codeExec!["risk_class"]).toBe("LOCAL_MUTATION");
      expect(codeExec!["capabilities"]).toContain("code.execute");
      expect(codeExec!["approval_policy"]).toBe("approval_required");
      expect(terminalExec!["capabilities"]).toContain("terminal.execute");
      // These are NOT auto-run tools: the D35 ladder gates them.
      expect(codeExec!["risk_class"]).not.toBe("READ_ONLY");
    } finally {
      await running.close();
    }
  });

  it("a real execution records tool history AND brings the terminal live view alive (the E31 deferral fulfilled)", async () => {
    const running = await composeOn();
    try {
      // The AC26 grant fast-path: a reusable task grant ("always approve this
      // tool") recorded in the one runtime place, exactly as a user decision
      // would create it.
      const approvalsRepo = new ApprovalsRepository(running.runtime.tx);
      approvalsRepo.insertGrant({
        grant_id: "grant_s26_composed",
        workspace_id: WS,
        source_choice: "always-approve-this-tool",
        principal_type: "task",
        principal_id: TASK,
        tool_id: "tool_terminal_exec",
        tool_version: "1.0.0",
        capability: "terminal.execute",
        resource_scope: `workspace:${WS}`,
        conversation_scope: "any",
        workspace_scope: WS,
        expires_at: null,
        one_time: false,
        created_by: { type: "user", id: "user_owner" },
        approved_at: NOW,
        revoked_at: null,
        args_digest: null,
        consumed_at: null,
      });
      const rawArgs = { command: `echo composed-live-view; echo done > composed-out.txt` };
      const result = running.runtime.tools.executeProposal({
        proposal: {
          workspace_id: WS,
          task_id: TASK,
          conversation_id: CONV,
          tool_id: "tool_terminal_exec",
          tool_version: "1.0.0",
          capability: "terminal.execute",
          args_digest: `sha256:${(await import("node:crypto")).createHash("sha256").update(JSON.stringify(rawArgs)).digest("hex")}`,
          proposal_summary: "composed terminal execution",
        },
        run: {
          task_id: TASK,
          workspace_id: WS,
          conversation_id: CONV,
          created_from: { trigger_event_type: "tool.proposed", trigger_event_id: "evt_s26" },
          pack_snapshot: { pack_id: "pack_student", pack_version: "1.0.0", pack_hash: HASH },
          roster: [AGENT],
          state: "RUNNING",
          version: 7,
          retry_count: 0,
          created_at: NOW,
          updated_at: NOW,
        },
        agent_id: AGENT,
        rawArgs,
        resource_scope: `workspace:${WS}`,
      });
      if (result.outcome !== "dispatched") throw new Error(`got ${result.outcome}`);
      const settled = await result.completion;
      expect(settled.outcome).toBe("executed");

      // The tool history carries the redacted, bounded result.
      const history = await getJson(running.origin, `/v1/tools/history?workspace_id=${WS}`);
      const rows = history.body["history"] as Array<Record<string, unknown>>;
      const row = rows.find((entry) => entry["tool_id"] === "tool_terminal_exec");
      expect(row).toBeDefined();
      expect(row!["status"]).toBe("succeeded");
      expect(String(row!["result_summary"])).toContain("composed-live-view");

      // The terminal live view shows the REAL execution: started (command,
      // workdir, the enforced resource policy, the record-time approval
      // state), output chunks, exit.
      const events = await getJson(
        running.origin,
        `/v1/terminals/events?workspace_id=${WS}&agent_id=${AGENT}`,
      );
      expect(events.status).toBe(200);
      const eventsText = JSON.stringify(events.body);
      expect(eventsText).toContain("composed-live-view");
      expect(eventsText).toContain("disabled");
      const sideEffect = (await import("node:fs")).existsSync(
        join(running.workspaceRoot, "composed-out.txt"),
      );
      expect(sideEffect).toBe(true);
    } finally {
      await running.close();
    }
  });

  it("the network separation is demonstrated at the kernel level: the sandbox namespace has no routes, the runtime's does", async () => {
    const running = await composeOn();
    try {
      void running;
      const { readFileSync } = await import("node:fs");
      const handle = spawnSandboxedExecution({
        command: ["/bin/sleep", "2"],
        cwd: "/tmp",
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp" },
        networkDisabled: true,
        limits: { memoryBytes: null, cpuSeconds: null, maxProcesses: null, diskBytes: null },
        wallClockMs: 30_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const sandboxRoutes = readFileSync(`/proc/${handle.pid}/net/route`, "utf8").trim();
      const runtimeRoutes = readFileSync(`/proc/self/net/route`, "utf8").trim();
      handle.cancel();
      await handle.waitForExit();
      // The sandbox's namespace: no routes at all (loopback only, DOWN).
      expect(sandboxRoutes).toBe("");
      // The runtime's own namespace: the research posture (routes exist).
      expect(runtimeRoutes.length).toBeGreaterThan(0);
    } finally {
      await running.close();
    }
  }, 30_000);
});
