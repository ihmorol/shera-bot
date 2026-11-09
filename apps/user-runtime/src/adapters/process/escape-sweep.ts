/**
 * The S27-GAP-1 escape sweep (issue #83; this slice's cancellation hardening)
 * — the /proc-side companion to the recorded group kill (D14/D27): a group
 * kill reaches only the leader's process group, so a descendant that sheds
 * the group AND the session (`setsid`) survived cancellation on the unfixed
 * tree (live-reproduced: ST-04's detached leg,
 * tests/security-evidence/2026-11-10-gap1-setsid-red.txt).
 *
 * The mechanism, and why it is safe to run from a multi-execution runtime:
 *
 *   1. SNAPSHOT AT SPAWN — the caller records every pid's /proc starttime at
 *      spawn. A process absent from the snapshot (or present under a
 *      different starttime — pid reuse) was born during THIS execution's
 *      window. The starttime compare is the pidfd-reuse-safety stand-in:
 *      Node exposes no pidfd syscall surface, and a native FFI dependency
 *      was rejected (E15; E48 records the substitution).
 *
 *   2. THE SWEEP AT CANCEL — walk /proc and collect processes that are
 *      (a) NEW in the window, (b) their OWN session leader (sid === pid —
 *      the setsid shape; a session is only created by setsid(2)), and
 *      (c) inside the execution's OWN user namespace (/proc/<pid>/uid_map
 *      equals the leader's PRIVATE map — "0 <uid> 1" under the D27
 *      `unshare --user` envelope). Condition (c) is what makes the sweep
 *      safe next to concurrent executions and test workers: processes
 *      outside the namespace carry the HOST map ("0 0 4294967295") and are
 *      never collected. When the leader has no private map (no unshare —
 *      the D27 fail-closed posture refuses such spawns anyway when
 *      networkDisabled), the sweep is skipped entirely: without the
 *      namespace boundary the sweep cannot scope itself, and a control that
 *      cannot scope itself does not run (G5 — recorded, never approximated).
 *
 *   3. VERIFIED KILL — every collected pid is SIGKILLed only after its
 *      /proc starttime still matches the collection-time sample (a pid
 *      reused between the walk and the kill is spared — we kill the
 *      process we identified, never whatever now owns the number).
 *
 * Residual (honest, G5): a double-fork orphan whose intermediate parent
 * exits INSIDE one sweep window without ever calling setsid keeps the
 * leader's session and is invisible here (the group kill and the PPid-chain
 * walk in the adapter cover it only while the chain is intact); an escapee
 * that nests its OWN user namespace no longer matches the leader's uid_map.
 * Both stay outside any post-hoc host-side sweep and are closed by
 * PID-namespace containment at spawn on the deployment host — the S35
 * Compose posture records it (runbook §hardening, E48). A swept candidate
 * that races another concurrent execution's escape (both inside THAT other
 * execution's own namespace is impossible — condition (c) excludes it);
 * two executions of the SAME user namespace cannot coexist.
 *
 * Everything here reads /proc and signals — no new dependency, no shell.
 *
 * Governing records: D27, D14, E36, E45 (S27-GAP-1), E48, G3/G5.
 */
import { readdirSync, readFileSync } from "node:fs";

/** One /proc/<pid>/stat sample: the fields the sweep and the walk need. */
export interface ProcSample {
  pid: number;
  ppid: number;
  pgrp: number;
  session: number;
  /** Clock ticks since boot at exec — the pid-reuse guard. */
  starttime: string;
}

/**
 * Parse /proc/<pid>/stat. Fields 3+ live after the last ')' (comm may
 * contain spaces and parentheses): state, ppid, pgrp, session, ...,
 * starttime (field 22 — index 19 of the tail).
 */
export function sampleProc(pid: number): ProcSample | null {
  try {
    const text = readStat(pid);
    const tail = text.slice(text.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(tail[1]);
    const pgrp = Number(tail[2]);
    const session = Number(tail[3]);
    const starttime = tail[19] ?? "";
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || starttime === "") return null;
    return { pid, ppid, pgrp, session, starttime };
  } catch {
    return null; // the process is gone (or /proc declined) — not sampleable
  }
}

function readStat(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

/** The host user-namespace map (a process NOT inside a private namespace). */
export const HOST_UID_MAP = "0 0 4294967295";

/**
 * First line of /proc/<pid>/uid_map, whitespace-normalized — the user
 * namespace the process runs in. null when unreadable (gone, or a kernel
 * without the file).
 */
export function readUidMap(pid: number): string | null {
  try {
    const text = readFileSync(`/proc/${pid}/uid_map`, "utf8");
    const first = text.split("\n")[0]?.trim();
    return first === undefined || first === "" ? null : first.replace(/\s+/g, " ");
  } catch {
    return null;
  }
}

/** Snapshot every sampleable pid's starttime — the spawn-time window anchor. */
export function snapshotProcStarttimes(): Map<number, string> {
  const snapshot = new Map<number, string>();
  for (const sample of scanProcTable()) {
    snapshot.set(sample.pid, sample.starttime);
  }
  return snapshot;
}

function scanProcTable(): ProcSample[] {
  const samples: ProcSample[] = [];
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return samples;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const sample = sampleProc(pid);
    if (sample !== null) samples.push(sample);
  }
  return samples;
}

/**
 * Descendants reachable through the CURRENT PPid chain from `rootPid` —
 * collected BEFORE the group kill while the chain is intact. Covers
 * group-shedding-but-still-parented descendants the group kill misses;
 * reparented orphans (chain broken) are the sweep's business or the
 * recorded residual.
 */
export function collectGroupDescendants(rootPid: number): ProcSample[] {
  const byPpid = new Map<number, ProcSample[]>();
  const table = scanProcTable();
  for (const sample of table) {
    const list = byPpid.get(sample.ppid);
    if (list === undefined) byPpid.set(sample.ppid, [sample]);
    else list.push(sample);
  }
  const descendants: ProcSample[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const parent = queue.pop()!;
    for (const child of byPpid.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      queue.push(child.pid);
    }
  }
  return descendants;
}

/**
 * The S27-GAP-1 sweep: every process that is NEW in this execution's window,
 * its own session leader, and inside the leader's PRIVATE user namespace.
 * `leaderPid` is excluded (it is a session leader itself under the detached
 * spawn — its own pid, not an escape). Returns the collected samples with
 * their collection-time starttimes for the verified kill.
 */
export function collectEscapeCandidates(
  leaderPid: number,
  spawnSnapshot: Map<number, string>,
  leaderUidMap: string | null,
): ProcSample[] {
  // No private namespace on the leader — the sweep cannot scope itself and
  // does not run (recorded honest degradation, G5; the D27 envelope makes
  // this the networkDisabled norm, where the map is "0 <uid> 1").
  if (leaderUidMap === null || leaderUidMap === HOST_UID_MAP) return [];
  const candidates: ProcSample[] = [];
  for (const sample of scanProcTable()) {
    if (sample.pid === leaderPid) continue;
    // NEW in the window: absent from the spawn snapshot, or the pid was
    // reused since (different starttime).
    if (spawnSnapshot.get(sample.pid) === sample.starttime) continue;
    // The setsid shape: the process is its OWN session leader (a session is
    // only ever created by setsid(2)).
    if (sample.session !== sample.pid) continue;
    // And it still runs inside THIS execution's user namespace.
    if (readUidMap(sample.pid) !== leaderUidMap) continue;
    candidates.push(sample);
  }
  return candidates;
}

/**
 * SIGKILL every collected pid whose /proc starttime still matches the
 * collection-time sample (the pid-reuse guard — kill what we identified,
 * never whatever now owns the number). A dying candidate between the walk
 * and the kill is the expected race and is skipped harmlessly.
 */
export function killVerified(candidates: readonly ProcSample[]): void {
  for (const candidate of candidates) {
    const current = sampleProc(candidate.pid);
    if (current === null || current.starttime !== candidate.starttime) continue;
    try {
      process.kill(candidate.pid, "SIGKILL");
    } catch {
      // Already dead — a kill race is not a failure.
    }
  }
}
