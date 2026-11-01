/**
 * Execution-process-spawn adapter tests (S26 chunk 1; D23 rule 2, D27, E1
 * kernel-enforcement precedent, G3/G4) — REAL child processes against the
 * REAL OS primitives this machine provides (probed 2026-10-31: unshare
 * user+net namespaces allowed for uid 1000, util-linux prlimit present,
 * delegated cgroup v2 subtree writable under user@1000.service).
 *
 * These suites exercise the sandbox envelope itself:
 *   - network disabled by default (a real outbound connect inside the netns
 *     fails with ENETUNREACH — demonstrated, not asserted);
 *   - the child environment is EXACTLY the request's env (never the runtime's
 *     process.env — the AC5 secret-shaped env var is invisible to the child);
 *   - kernel limits are applied (verified against /proc/<pid>/limits) and a
 *     CPU spin dies at its ceiling with the typed limit-death classification;
 *   - the wall-clock ceiling kills the WHOLE process group (detached + group
 *     kill + post-exit reap, the S19 validation-seam pattern) and cancel()
 *     kills the tree before any clock fires;
 *   - the optional cgroup layer (memory.max/pids.max) is applied to the child
 *     and its leaf is cleaned up after exit;
 *   - a missing enforcement binary is a TYPED failure, never a silent
 *     fall-back to an unbounded child (G4).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveExecutionPrlimitBinary,
  resolveUnshareBinary,
  spawnSandboxedExecution,
  UnshareUnavailableError,
  type SandboxSpawnRequest,
} from "./execution-process-spawn.ts";

function makeRequest(overrides: Partial<SandboxSpawnRequest> = {}): SandboxSpawnRequest {
  return {
    command: ["/bin/sleep", "0.2"],
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin", HOME: tmpdir() },
    networkDisabled: true,
    limits: { memoryBytes: null, cpuSeconds: null, maxProcesses: null, diskBytes: null },
    wallClockMs: 30_000,
    ...overrides,
  };
}

/** The delegated cgroup v2 subtree this user may create children under. */
function probeCgroupBase(): string | null {
  const candidates = ["/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service"];
  for (const base of candidates) {
    if (!existsSync(base)) continue;
    const probe = join(base, "shera-exec-probe");
    try {
      mkdirSync(probe);
      rmSync(probe);
      return base;
    } catch {
      return null;
    }
  }
  return null;
}

const cgroupBase = probeCgroupBase();

describe("execution-process-spawn adapter (S26 chunk 1)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "s26-spawn-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("resolves the enforcement binaries through their candidate paths (G4)", () => {
    expect(resolveUnshareBinary()).toBe("/usr/bin/unshare");
    expect(resolveExecutionPrlimitBinary()).toBe("/usr/bin/prlimit");
    expect(() => resolveUnshareBinary(["/nonexistent/unshare"])).toThrow(UnshareUnavailableError);
  });

  it("disables the network for the child: an outbound connect fails with ENETUNREACH (D27, demonstrated)", async () => {
    let seen = "";
    const handle = spawnSandboxedExecution(
      makeRequest({
        command: [
          process.execPath,
          "-e",
          `const net=require("net");
           const s=net.connect({host:"10.255.255.1",port:9},()=>{console.log("CONNECTED-BAD");process.exit(2)});
           s.on("error",(e)=>{console.log("CONNECT-ERR",e.code);process.exit(0)});
           setTimeout(()=>{console.log("TIMEOUT-BAD");process.exit(3)},3000);`,
        ],
        onOutput: (_stream, chunk) => {
          seen += chunk;
        },
      }),
    );
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0);
    expect(seen).toContain("CONNECT-ERR ENETUNREACH");
    expect(seen).not.toContain("CONNECTED-BAD");
  });

  it("gives the child EXACTLY the request env — a secret planted in the runtime env is invisible (AC5)", async () => {
    const planted = "sk-s26-planted-secret-0123456789abcdef";
    process.env.SHERA_S26_PLANTED_SECRET = planted;
    try {
      let seen = "";
      const handle = spawnSandboxedExecution(
        makeRequest({
          command: [process.execPath, "-e", `console.log(JSON.stringify(process.env))`],
          env: { PATH: "/usr/bin:/bin", HOME: workspace },
          onOutput: (_stream, chunk) => {
            seen += chunk;
          },
        }),
      );
      const exit = await handle.waitForExit();
      expect(exit.code).toBe(0);
      const childEnv = JSON.parse(seen) as Record<string, string>;
      expect(childEnv["SHERA_S26_PLANTED_SECRET"]).toBeUndefined();
      expect(seen).not.toContain(planted);
      expect(Object.keys(childEnv).sort()).toEqual(["HOME", "PATH"]);
    } finally {
      delete process.env.SHERA_S26_PLANTED_SECRET;
    }
  });

  it("applies the kernel limits and verifies them against /proc/<pid>/limits (E1 precedent)", async () => {
    const handle = spawnSandboxedExecution(
      makeRequest({
        command: ["/bin/sleep", "0.4"],
        limits: {
          memoryBytes: 536_870_912,
          cpuSeconds: 7,
          maxProcesses: 32,
          diskBytes: 1_048_576,
        },
      }),
    );
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0);
    expect(exit.verifiedLimits).not.toBeNull();
    const limits = exit.verifiedLimits!;
    expect(limits["Max data size"]?.soft).toBe("536870912");
    expect(limits["Max cpu time"]?.soft).toBe("7");
    expect(limits["Max processes"]?.soft).toBe("32");
    expect(limits["Max file size"]?.soft).toBe("1048576");
  });

  it("kills a CPU spin at its ceiling with the typed limit-death classification (AC3)", async () => {
    const handle = spawnSandboxedExecution(
      makeRequest({
        command: [process.execPath, "-e", `while (true) {}`],
        limits: { memoryBytes: null, cpuSeconds: 1, maxProcesses: null, diskBytes: null },
        wallClockMs: 60_000,
      }),
    );
    const exit = await handle.waitForExit();
    expect(exit.signal).toBe("SIGXCPU");
    expect(exit.limitDeath).toBe("cpu");
  });

  it("enforces the wall-clock ceiling on the WHOLE tree (detached group kill + reap)", async () => {
    const started = Date.now();
    const handle = spawnSandboxedExecution(
      makeRequest({
        command: ["/bin/sh", "-c", "sleep 30 & sleep 30; wait"],
        wallClockMs: 400,
      }),
    );
    const pid = handle.pid;
    const exit = await handle.waitForExit();
    const elapsed = Date.now() - started;
    expect(exit.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
    // Post-exit reap: the group is gone (no descendant survives the kill).
    const reap = spawnSync("/bin/sh", [
      "-c",
      `for i in 1 2 3 4 5 6 7 8 9 10; do if kill -0 -- -${pid} 2>/dev/null; then sleep 0.2; else exit 0; fi; done; kill -0 -- -${pid} 2>/dev/null && exit 1 || exit 0`,
    ]);
    expect(reap.status).toBe(0);
  });

  it("cancel() kills the tree before any clock fires (the D27 termination seam)", async () => {
    const handle = spawnSandboxedExecution(
      makeRequest({ command: ["/bin/sh", "-c", "sleep 30 & sleep 30; wait"], wallClockMs: 60_000 }),
    );
    const pid = handle.pid;
    await new Promise((resolve) => setTimeout(resolve, 300));
    handle.cancel();
    const exit = await handle.waitForExit();
    expect(exit.cancelled).toBe(true);
    const reap = spawnSync("/bin/sh", [
      "-c",
      `for i in 1 2 3 4 5 6 7 8 9 10; do if kill -0 -- -${pid} 2>/dev/null; then sleep 0.2; else exit 0; fi; done; kill -0 -- -${pid} 2>/dev/null && exit 1 || exit 0`,
    ]);
    expect(reap.status).toBe(0);
  });

  it("skips the network namespace only when the request says so (the flag is the policy's, never the adapter's)", async () => {
    const handle = spawnSandboxedExecution(
      makeRequest({ command: ["/bin/echo", "plain"], networkDisabled: false }),
    );
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0);
  });

  it("applies the cgroup layer when a delegated base exists, and cleans the leaf up (best-effort, honestly recorded)", async () => {
    if (cgroupBase === null) {
      // No delegated subtree on this host: the layer is honestly absent.
      const handle = spawnSandboxedExecution(
        makeRequest({ cgroupBaseDir: null, command: ["/bin/true"] }),
      );
      const exit = await handle.waitForExit();
      expect(exit.cgroupApplied).toBeNull();
      return;
    }
    const base = join(cgroupBase, "shera-exec-test");
    rmSync(base, { recursive: true, force: true });
    try {
      let cgroupPath = "";
      const handle = spawnSandboxedExecution(
        makeRequest({
          command: ["/bin/sleep", "1.5"],
          cgroupBaseDir: base,
          id: "exec-cgtest",
          limits: {
            memoryBytes: 536_870_912,
            cpuSeconds: null,
            maxProcesses: 16,
            diskBytes: null,
          },
        }),
        {
          onCgroupApplied: (applied) => {
            cgroupPath = applied.cgroup_path;
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(cgroupPath).toContain("exec-cgtest");
      const procCgroup = readFileSync(`/proc/${handle.pid}/cgroup`, "utf8");
      expect(procCgroup).toContain("shera-exec-test/exec-cgtest");
      const exit = await handle.waitForExit();
      expect(exit.code).toBe(0);
      expect(exit.cgroupApplied).not.toBeNull();
      expect(exit.cgroupApplied!.memory_max).toBe("536870912");
      expect(exit.cgroupApplied!.pids_max).toBe("16");
      expect(existsSync(cgroupPath)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("bounds forwarded output at the adapter cap and marks the truncation", async () => {
    let forwarded = "";
    let truncated = false;
    const handle = spawnSandboxedExecution(
      makeRequest({
        command: [
          process.execPath,
          "-e",
          `process.stdout.write("x".repeat(2 * 1024 * 1024)); process.exit(0)`,
        ],
        maxForwardedBytes: 64 * 1024,
        onOutput: (_stream, chunk) => {
          forwarded += chunk;
        },
        onTruncated: () => {
          truncated = true;
        },
      }),
    );
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0);
    expect(forwarded.length).toBeLessThanOrEqual(64 * 1024 + 1024);
    expect(truncated).toBe(true);
  });
});
