/**
 * S27 ST-04 — process-tree escape (threat model §5 ST-04; TM-5.1; D27 +
 * D14: "tool-created processes inherit the parent task's limits; process
 * trees terminated on cancellation"; the D14 independent-death detection).
 *
 * The adversarial shape: the payload FORKS multiple group descendants (the
 * hostile input — children that keep burning CPU well past their parent's
 * useful life), the run is CANCELLED mid-flight through the recorded cancel
 * seam (the executor's ctx.signal abort → handle.cancel()), and the suite
 * then walks the LIVE PROCESS LIST (kill(pid, 0) — the kernel's own answer,
 * not a bookkeeping flag) proving every descendant is dead and the exit is
 * the typed cancellation.
 *
 * HONEST SCOPE (G5 — recorded, never silenced): this suite pins what the
 * control actually guarantees — the WHOLE PROCESS GROUP dies. A descendant
 * that SHEDS the group (setsid / double-fork / detached: true) was outside a
 * group kill's reach: that leg is the CONFIRMED GAP recorded in
 * tests/security/SECURITY-GAPS.md §S27-GAP-1 and filed as issue #83.
 *
 * S35 CLOSURE (issue #83, this slice): the DETACHED leg below pins the
 * S27-GAP-1 fix — the cancellation seam now sweeps session-escaped
 * descendants (a /proc walk anchored on the execution's own user namespace:
 * a NEW session leader born during the execution window whose uid_map is the
 * execution's private map is collected and SIGKILLed alongside the group).
 * The sweep runs BEFORE the group kill (the chain is intact) and again in
 * the post-exit reap; candidates are killed pid-verified against the
 * spawn-time starttime snapshot (the pidfd-reuse-safety stand-in — Node
 * exposes no pidfd surface; recorded in E48). The FULLY-reparented residual
 * (a double-fork orphan whose intermediate parent exits inside one sweep
 * gap, or an escapee that nests its own user namespace) stays outside the
 * sweep's reach and remains the deployment-host item: PID-namespace
 * containment at spawn in the S35 Compose posture (runbook §hardening).
 *
 * RED-FIRST evidence: the group kill (killTree) was disabled, the suite
 * FAILED (survivors on the live process list; the typed cancellation gone),
 * the control was restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st04-{red,green}.txt. The DETACHED leg
 * carries its own pair: the escape sweep absent, the setsid grandchild
 * SURVIVED cancellation (red), the sweep landed, the grandchild is dead
 * (green) — tests/security-evidence/2026-11-10-gap1-setsid-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-04, D27, D14, E36, E48, G3/G5.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  spawnSandboxedExecution,
  type SandboxSpawnRequest,
} from "../../apps/user-runtime/src/adapters/process/execution-process-spawn.ts";

const tempDirs: string[] = [];

/** True when the OS still has a live process with this pid. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort cleanup so a RED-run survivor never outlives the suite. */
function reapMarkerPids(markerPath: string): void {
  let pids: number[];
  try {
    pids = readFileSync(markerPath, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

describe("S27 ST-04 — cancellation terminates the whole process tree (D27/D14)", () => {
  it("a forking payload's group descendants are ALL dead after cancel() — walked on the live process list", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st04-"));
    tempDirs.push(work);
    const marker = join(work, "children.pids");
    writeFileSync(marker, "", "utf8");

    // The adversarial payload: three long-running group descendants (45 s of
    // spin — far past every deadline in this test) plus a parent that would
    // idle 10 s. Every child registers its pid so the suite can walk the LIVE
    // process list for survivors. NOTE: no `detached` anywhere in the spawn —
    // these descendants stay in the group the control kills; the shedding
    // variant is the recorded GAP (S27-GAP-1), not a green leg here.
    const payload = [
      `const { spawn } = require("node:child_process");`,
      `const fs = require("node:fs");`,
      `for (let i = 0; i < 3; i++) {`,
      `  const c = spawn(process.execPath, ["-e",`,
      `    'const fs=require("node:fs");' +`,
      `    'fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\\\n");' +`,
      `    'const t=Date.now(); while(Date.now()-t<45000){}'`,
      `  ], { stdio: "ignore" });`,
      `  c.on("error", () => {});`,
      `}`,
      `setTimeout(() => process.exit(0), 10000); // the parent idles; cancel is expected first`,
    ].join("\n");

    const request: SandboxSpawnRequest = {
      command: [process.execPath, "-e", payload],
      cwd: work,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
      networkDisabled: true,
      limits: {
        // RLIMIT_DATA clears node's boot floor (E36); nproc leaves headroom
        // for the three children; fsize generous.
        memoryBytes: 2 * 1024 * 1024 * 1024,
        cpuSeconds: 50,
        maxProcesses: 64,
        diskBytes: 64 * 1024 * 1024,
      },
      wallClockMs: null, // cancel() is the seam under test — not the wall clock
    };
    const handle = spawnSandboxedExecution(request, {});

    // Let the children register and start spinning, then cancel mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const registered = readFileSync(marker, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    expect(
      registered.length,
      "the adversarial payload must have forked its group descendants before cancel",
    ).toBeGreaterThanOrEqual(3);
    for (const pid of registered) {
      expect(processAlive(pid), `descendant ${pid} must be alive BEFORE cancel`).toBe(true);
    }

    handle.cancel(); // THE CONTROL under test (the D27 termination seam)
    const exit = await handle.waitForExit();

    // The typed cancellation — the run answers honestly that the seam fired.
    expect(exit.cancelled).toBe(true);
    // And the kernel agrees: EVERY registered descendant is gone.
    await new Promise((resolve) => setTimeout(resolve, 700));
    for (const pid of registered) {
      expect(
        processAlive(pid),
        `descendant ${pid} SURVIVED cancellation — the D27 tree termination failed`,
      ).toBe(false);
    }
    reapMarkerPids(marker); // defense in depth for the suite's own hygiene
  }, 60_000);

  it("a setsid grandchild that sheds the group AND session is ALSO dead after cancel() — the S27-GAP-1 escape sweep (issue #83)", async () => {
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st04-gap1-"));
    tempDirs.push(work);
    const marker = join(work, "escaped.pids");
    writeFileSync(marker, "", "utf8");

    // The hostile shape of the recorded gap: the payload spawns a child under
    // setsid(1) — a NEW SESSION the group kill cannot reach. The setsid(1)
    // utility forks (it is a group leader under the detached spawn) and the
    // session-escaped GRANDCHILD registers its OWN pid — the marker holds the
    // true escaped pid, not the short-lived setsid parent's. The escapee is
    // reparented (its setsid parent exits within milliseconds) — exactly the
    // shape a post-hoc PPid-chain walk cannot find, which is why the control
    // is the uid_map-anchored session sweep.
    const payload = [
      `const { spawn } = require("node:child_process");`,
      `const fs = require("node:fs");`,
      `const c = spawn("setsid", [process.execPath, "-e",`,
      `  'const fs=require("node:fs");' +`,
      `  'fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\\\n");' +`,
      `  'const t=Date.now(); while(Date.now()-t<45000){}'`,
      `], { stdio: "ignore", detached: true });`,
      `c.on("error", () => process.exit(1));`,
      `setTimeout(() => process.exit(0), 10000); // the parent idles; cancel is expected first`,
    ].join("\n");

    const request: SandboxSpawnRequest = {
      command: [process.execPath, "-e", payload],
      cwd: work,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
      networkDisabled: true, // the D27 default — the user namespace the sweep anchors on
      limits: {
        memoryBytes: 2 * 1024 * 1024 * 1024,
        cpuSeconds: 50,
        maxProcesses: 64,
        diskBytes: 64 * 1024 * 1024,
      },
      wallClockMs: null, // cancel() is the seam under test — not the wall clock
    };
    const handle = spawnSandboxedExecution(request, {});

    // Let the setsid fork complete and the escaped grandchild register, then
    // cancel mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const escaped = readFileSync(marker, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    expect(
      escaped.length,
      "the adversarial payload must have registered its session-escaped grandchild before cancel",
    ).toBeGreaterThanOrEqual(1);
    for (const pid of escaped) {
      expect(processAlive(pid), `escaped grandchild ${pid} must be alive BEFORE cancel`).toBe(true);
    }

    handle.cancel(); // THE CONTROL under test (the D27 termination seam + the #83 sweep)
    const exit = await handle.waitForExit();

    // The typed cancellation — the run answers honestly that the seam fired.
    expect(exit.cancelled).toBe(true);
    // And the kernel agrees: the session-escaped grandchild is gone TOO —
    // surviving outside the group is no longer surviving cancellation.
    await new Promise((resolve) => setTimeout(resolve, 700));
    for (const pid of escaped) {
      expect(
        processAlive(pid),
        `session-escaped grandchild ${pid} SURVIVED cancellation — the S27-GAP-1 escape sweep failed (issue #83)`,
      ).toBe(false);
    }
    reapMarkerPids(marker); // defense in depth for the suite's own hygiene
  }, 60_000);

  it("a concurrent execution's tree is UNTOUCHED by another execution's cancel — the sweep scopes by namespace IDENTITY, not a shared map string (F1, PR #86 review)", async () => {
    // The hostile shape the review identified: EVERY networkDisabled
    // execution runs `unshare --user --map-root-user`, so EVERY execution's
    // leader carries the IDENTICAL uid_map string ("0 1000 1") in a DISTINCT
    // namespace. A sweep that scopes by the map STRING collects a concurrent
    // execution's leader (new in A's spawn-window, its own session leader,
    // map-string-equal) and SIGKILLs execution B's legitimate running tree
    // when A is cancelled. The identity must be the namespace ITSELF
    // (/proc/<pid>/ns/user — the inode), which differs per unshare.
    const workA = mkdtempSync(join(tmpdir(), "shera-s27-st04-f1-a-"));
    const workB = mkdtempSync(join(tmpdir(), "shera-s27-st04-f1-b-"));
    tempDirs.push(workA, workB);
    const markerA = join(workA, "children.pids");
    const markerB = join(workB, "children.pids");
    writeFileSync(markerA, "", "utf8");
    writeFileSync(markerB, "", "utf8");

    const forkAndIdle = (marker: string, idleMs: number): string =>
      [
        `const { spawn } = require("node:child_process");`,
        `const fs = require("node:fs");`,
        `for (let i = 0; i < 2; i++) {`,
        `  const c = spawn(process.execPath, ["-e",`,
        `    'const fs=require("node:fs");' +`,
        `    'fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\\\n");' +`,
        `    'const t=Date.now(); while(Date.now()-t<40000){}'`,
        `  ], { stdio: "ignore" });`,
        `  c.on("error", () => {});`,
        `}`,
        `setTimeout(() => process.exit(0), ${idleMs});`,
      ].join("\n");

    const makeRequest = (work: string, marker: string): SandboxSpawnRequest => ({
      command: [process.execPath, "-e", forkAndIdle(marker, 30_000)],
      cwd: work,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
      networkDisabled: true,
      limits: {
        memoryBytes: 2 * 1024 * 1024 * 1024,
        cpuSeconds: 50,
        maxProcesses: 64,
        diskBytes: 64 * 1024 * 1024,
      },
      wallClockMs: null,
    });

    // A first, then B — B's leader is new in A's spawn-window BY CONSTRUCTION.
    const handleA = spawnSandboxedExecution(makeRequest(workA, markerA), {});
    await new Promise((resolve) => setTimeout(resolve, 900));
    const handleB = spawnSandboxedExecution(makeRequest(workB, markerB), {});
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const childrenA = readFileSync(markerA, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    const childrenB = readFileSync(markerB, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    expect(childrenA.length, "execution A must have forked its children").toBeGreaterThanOrEqual(2);
    expect(childrenB.length, "execution B must have forked its children").toBeGreaterThanOrEqual(2);
    for (const pid of [...childrenA, ...childrenB, handleB.pid]) {
      expect(processAlive(pid), `pid ${pid} must be alive BEFORE A's cancel`).toBe(true);
    }

    handleA.cancel(); // A's termination seam — B is a CONCURRENT execution
    const exitA = await handleA.waitForExit();
    expect(exitA.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));

    // A's tree is dead (the control holding), and B's tree is UNTOUCHED —
    // the red here is B: today the map-string sweep collects B's leader.
    for (const pid of childrenA) {
      expect(processAlive(pid), `A's descendant ${pid} must be dead after A's cancel`).toBe(false);
    }
    expect(
      processAlive(handleB.pid),
      "execution B's LEADER must SURVIVE another execution's cancel — the sweep must scope by namespace identity, not the shared map string (F1)",
    ).toBe(true);
    for (const pid of childrenB) {
      expect(
        processAlive(pid),
        `execution B's descendant ${pid} must SURVIVE another execution's cancel (F1)`,
      ).toBe(true);
    }

    // Cleanup: cancel B too; its own tree dies by its own seam.
    handleB.cancel();
    const exitB = await handleB.waitForExit();
    expect(exitB.cancelled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    for (const pid of childrenB) {
      expect(processAlive(pid), `B's descendant ${pid} must be dead after B's own cancel`).toBe(
        false,
      );
    }
    reapMarkerPids(markerA);
    reapMarkerPids(markerB);
  }, 60_000);

  it("a payload that setsids a daemon then EXITS 0 leaves NO survivor — the reap's sweep carries the identity captured while the leader lived (F2, PR #86 review)", async () => {
    // The hostile shape: the payload daemonizes (setsid) a long-lived child
    // and exits cleanly — no cancel(), no wall clock, the exit is 0. The
    // post-exit reap fires 50 ms after close, by which time the LEADER is
    // gone: an identity read lazily AT reap time is unreadable, the sweep
    // disables itself, and the daemon survives while the reap comment claims
    // coverage. The identity must be captured while the leader LIVES.
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st04-f2-"));
    tempDirs.push(work);
    const marker = join(work, "daemon.pids");
    writeFileSync(marker, "", "utf8");

    const payload = [
      `const { spawn } = require("node:child_process");`,
      `const fs = require("node:fs");`,
      `const c = spawn("setsid", [process.execPath, "-e",`,
      `  'const fs=require("node:fs");' +`,
      `  'fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid) + "\\\\n");' +`,
      `  'setTimeout(() => process.exit(0), 40000);'`,
      `], { stdio: "ignore", detached: true });`,
      `c.on("error", () => process.exit(1));`,
      `setTimeout(() => process.exit(0), 400); // the payload exits CLEANLY after the daemonizing spawn`,
    ].join("\n");

    const request: SandboxSpawnRequest = {
      command: [process.execPath, "-e", payload],
      cwd: work,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: work },
      networkDisabled: true,
      limits: {
        memoryBytes: 2 * 1024 * 1024 * 1024,
        cpuSeconds: 50,
        maxProcesses: 64,
        diskBytes: 64 * 1024 * 1024,
      },
      wallClockMs: null, // the reap is the seam under test — not the wall clock, not cancel()
    };
    const handle = spawnSandboxedExecution(request, {});
    const exit = await handle.waitForExit();
    expect(exit.code).toBe(0); // the clean exit is the shape's premise

    // The daemon registered itself; the reap's sweep (which fired inside
    // waitForExit's close path) must have collected and killed it.
    const daemon = readFileSync(marker, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    expect(
      daemon.length,
      "the payload must have registered its setsid'd daemon",
    ).toBeGreaterThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const pid of daemon) {
      expect(
        processAlive(pid),
        `the daemonized child ${pid} SURVIVED a clean exit — the reap's sweep ran without the leader's identity (F2)`,
      ).toBe(false);
    }
    reapMarkerPids(marker); // defense in depth for the suite's own hygiene
  }, 60_000);
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
