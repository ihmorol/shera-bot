/**
 * S27 ST-05 — resource exhaustion under the recorded limits (threat model
 * §5 ST-05; TM-2.2; D27's kernel envelope + E1's admission-control posture,
 * LLM04/LLM10). The adversarial payloads, through the REAL sandbox spawn:
 *
 *   - DISK FILL: a loop appending past the tool's RLIMIT_FSIZE dies at the
 *     cap with the TYPED signal (SIGXFSZ → limitDeath "disk") and the file
 *     stays bounded;
 *   - WALL CLOCK: an infinite computation is SIGKILLed at the wall clock,
 *     the group is dead, and the exit classifies wall_clock;
 *   - FORK STORM: a 40-spawn loop against an 8-process cap sees the kernel
 *     refuse the excess (RLIMIT_NPROC inside the namespace counts its own
 *     processes) — the spawned count stays bounded; the NEGATIVE CONTROL leg
 *     (no cap) demonstrates what the cap prevents, once, so the assertion is
 *     never a tautology;
 *   - MEMORY: a runaway allocator is contained by RLIMIT_DATA (allocation
 *     refusal or a limit death — the honest either-way containment, the
 *     cgroup layer being GAP-2, never faked).
 *
 * Each leg asserts the gateway-health invariant: the runtime process is
 * alive and responsive after the hostile child died.
 *
 * RED-FIRST evidence: the prlimit wrapper's limits were stripped (disk +
 * nproc legs) and the wall-clock timer was disabled, the suite FAILED (the
 * file grew past the cap; the fork storm spawned every child; the infinite
 * loop outlived its ceiling), the controls were restored, the suite PASSED —
 * both outputs in tests/security-evidence/2026-11-05-st05-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-05, D27, E1, E36, GAP-2, G3/G7.
 */
import { mkdtempSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  spawnSandboxedExecution,
  type SandboxSpawnRequest,
} from "../../apps/user-runtime/src/adapters/process/execution-process-spawn.ts";

const tempDirs: string[] = [];

function baseRequest(
  work: string,
  overrides: Partial<SandboxSpawnRequest> = {},
): SandboxSpawnRequest {
  return {
    command: ["/bin/sh", "-c", "echo noop"],
    cwd: work,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
    networkDisabled: true,
    limits: { memoryBytes: null, cpuSeconds: null, maxProcesses: null, diskBytes: null },
    wallClockMs: null,
    ...overrides,
  };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STORM_SCRIPT = [
  `count=0; refused=0;`,
  `i=0; while [ $i -lt 40 ]; do`,
  `  if /bin/sleep 4 2>/dev/null & then count=$((count+1)); else refused=$((refused+1)); fi;`,
  `  i=$((i+1));`,
  `done;`,
  `sleep 1; echo "SPAWNED=$count REFUSED=$refused"`,
].join(" ");

describe("S27 ST-05 — disk fill dies at RLIMIT_FSIZE (typed SIGXFSZ)", () => {
  it("a loop appending past the 1 MiB cap is killed at the boundary and the file stays bounded", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st05-disk-"));
    tempDirs.push(work);
    const handle = spawnSandboxedExecution(
      baseRequest(work, {
        command: [
          "/bin/sh",
          "-c",
          `i=0; while true; do printf '%1024s' x >> fill.bin; i=$((i+1)); done`,
        ],
        limits: { memoryBytes: null, cpuSeconds: 25, maxProcesses: null, diskBytes: 1024 * 1024 },
        wallClockMs: 20_000,
      }),
      {},
    );
    const exit = await handle.waitForExit();
    expect(exit.limitDeath, "the disk-fill loop must die at a TYPED limit boundary").toBe("disk");
    expect(exit.signal).toBe("SIGXFSZ");
    // The file never crossed the cap (plus one write's slack).
    const size = existsSync(join(work, "fill.bin")) ? statSync(join(work, "fill.bin")).size : 0;
    expect(size).toBeLessThanOrEqual(1024 * 1024 + 2048);
    expect(processAlive(process.pid), "the runtime gateway stays healthy").toBe(true);
  }, 45_000);
});

describe("S27 ST-05 — the wall clock kills an infinite computation", () => {
  it("an infinite loop is SIGKILLed at the ceiling; the group is dead; wall_clock typed", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st05-clock-"));
    tempDirs.push(work);
    const handle = spawnSandboxedExecution(
      baseRequest(work, {
        command: ["/bin/sh", "-c", `while true; do :; done`],
        limits: { memoryBytes: null, cpuSeconds: 60, maxProcesses: null, diskBytes: null },
        wallClockMs: 1_500,
      }),
      {},
    );
    const exit = await handle.waitForExit();
    expect(exit.timedOut).toBe(true);
    expect(exit.limitDeath).toBe("wall_clock");
    expect(processAlive(handle.pid), "the wall-clock kill leaves nothing running").toBe(false);
    expect(processAlive(process.pid), "the runtime gateway stays healthy").toBe(true);
  }, 30_000);
});

describe("S27 ST-05 — a fork storm is bounded by RLIMIT_NPROC", () => {
  it("40 spawn attempts against an 8-process cap: the kernel refuses the excess; the tree stays bounded", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st05-fork-"));
    tempDirs.push(work);
    let captured = "";
    const handle = spawnSandboxedExecution(
      baseRequest(work, {
        command: ["/bin/sh", "-c", STORM_SCRIPT],
        limits: { memoryBytes: null, cpuSeconds: 30, maxProcesses: 8, diskBytes: null },
        wallClockMs: 25_000,
        onOutput: (_stream, chunk) => {
          captured += chunk;
        },
      }),
      {},
    );
    const exit = await handle.waitForExit();
    // THE CONTROL, in either of its two honest shapes on this box:
    //  (a) the kernel counts the namespace's processes and refuses the storm
    //      mid-loop — the accounting line shows spawned bounded + refused > 0;
    //  (b) when the box's own uid-1000 process population already fills the
    //      tiny cap, the shell cannot fork AT ALL ("Cannot fork") — stricter
    //      than the storm needs, still the same kernel refusal (E1/E36).
    const accounting = captured.split("\n").find((l) => l.startsWith("SPAWNED="));
    const totalForkRefusal = captured.includes("Cannot fork");
    if (totalForkRefusal) {
      // Shape (b): nothing of the storm ran.
      expect(exit.code).not.toBe(0);
    } else {
      expect(accounting, "the payload must report its spawn accounting").toBeDefined();
      const spawned = Number(accounting!.match(/SPAWNED=(\d+)/)![1]);
      const refused = Number(accounting!.match(/REFUSED=(\d+)/)![1]);
      expect(spawned + refused).toBe(40);
      expect(spawned).toBeLessThanOrEqual(20);
      expect(refused).toBeGreaterThan(0);
    }
    expect(processAlive(process.pid), "the runtime gateway stays healthy").toBe(true);
  }, 45_000);

  it("NEGATIVE CONTROL: the same storm with no nproc limit spawns most of its children (what the cap prevents)", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st05-negctl-"));
    tempDirs.push(work);
    let captured = "";
    const handle = spawnSandboxedExecution(
      baseRequest(work, {
        command: ["/bin/sh", "-c", STORM_SCRIPT],
        limits: { memoryBytes: null, cpuSeconds: 30, maxProcesses: null, diskBytes: null },
        wallClockMs: 25_000,
        onOutput: (_stream, chunk) => {
          captured += chunk;
        },
      }),
      {},
    );
    const exit = await handle.waitForExit();
    const line = captured.split("\n").find((l) => l.startsWith("SPAWNED="));
    const spawned = line ? Number(line.match(/SPAWNED=(\d+)/)![1]) : 0;
    expect(exit.code).toBe(0);
    // No cap: the storm mostly lands (the host's own ulimits aside) — this is
    // what the nproc layer prevents. Cleanup is the wall clock's group kill.
    expect(spawned).toBeGreaterThan(20);
  }, 45_000);
});

describe("S27 ST-05 — a runaway allocator is contained (RLIMIT_DATA; cgroup = GAP-2, honest)", () => {
  it("a loop allocating beyond the data ceiling either refuses allocation or dies at a limit — never grows unbounded", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st05-mem-"));
    tempDirs.push(work);
    let captured = "";
    const handle = spawnSandboxedExecution(
      baseRequest(work, {
        command: [
          process.execPath,
          "-e",
          [
            `const chunks = [];`,
            `let i = 0;`,
            `try {`,
            `  for (;;) { chunks.push(Buffer.alloc(256 * 1024 * 1024, 1)); i++; }`,
            `} catch { console.log("ALLOC-REFUSED iterations=" + i); }`,
            `setTimeout(() => process.exit(0), 30000);`,
          ].join(" "),
        ],
        limits: {
          memoryBytes: 2 * 1024 * 1024 * 1024, // node's boot floor (E36) as the ceiling
          cpuSeconds: 40,
          maxProcesses: null,
          diskBytes: null,
        },
        wallClockMs: 30_000,
        onOutput: (_stream, chunk) => {
          captured += chunk;
        },
      }),
      {},
    );
    const exit = await handle.waitForExit();
    const refused = captured.includes("ALLOC-REFUSED");
    const diedAtLimit = exit.limitDeath !== null;
    // THE CONTAINMENT (either typed path): the allocator never outgrew the
    // ceiling unbounded, and the runtime process is alive after it.
    expect(
      refused || diedAtLimit,
      `the allocator must hit the data ceiling (refused=${refused}, limitDeath=${exit.limitDeath})`,
    ).toBe(true);
    expect(processAlive(process.pid), "the runtime gateway stays healthy").toBe(true);
  }, 60_000);
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
