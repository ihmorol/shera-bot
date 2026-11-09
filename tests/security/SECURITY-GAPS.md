# S27 security gaps — the recorded findings (issue #28 rule: real gaps are filed, never silenced)

**Status:** the S27 deliverable's gap ledger (threat model §5 contract: "Real gaps
found are filed as new issues (with reproduction), not silenced or downgraded").
Every gap here is a REAL, reproduced behavior of the merged tree that a committed
S27 suite deliberately does NOT claim as covered. No committed test asserts a
control exists where it does not (G5).

Each gap carries: the hostile shape, the recorded control it defeats, the live
reproducer, the blast radius, and the suggested issue text. The S27 suites' rows
in `THREAT-COVERAGE.md` reference these gaps by id where a leg would otherwise
over-claim.

---

## S27-GAP-1 — a `setsid`/detached grandchild survives cancellation

- **Threat:** TM-5.1 (host/container escape, the process-persistence half); threat
  model §5 ST-04's second leg ("a detached grandchild (`setsid`/double-fork) that
  outlives cancellation or sheds the task's limits").
- **Control the threat model names:** D27 + D14 — "the gateway terminates the whole
  child process tree and detects process death independently of final events".
- **What holds (pinned by `s27-st04-process-tree-escape.test.ts`):** every
  process the payload forks INTO THE CHILD'S PROCESS GROUP is SIGKILLed on
  cancellation — the whole group dies on the live process list, and the exit is
  the typed cancellation.
- **What does NOT hold (the gap):** a payload that calls `setsid` (or double-forks
  with `detached: true`) creates a grandchild in a NEW session whose process group
  the runtime's group-kill does not address. The grandchild survives cancellation
  and keeps running after the task reports the typed cancellation. Reproduced live
  TWICE: by the builder while bringing ST-04 up (2026-11-05) and re-verified by
  the finisher after the main integration (2026-11-09 — a leader spawning
  `setsid sleep 6 &`, the leader's group SIGKILLed exactly as `killTree` does,
  the grandchild found alive on the process list afterwards, then reaped); no
  committed test claims the detached leg.
- **Why the prototype's other layers do not catch it:** the containment is the
  process-group kill (D14's recorded mechanism) — there is no PID-namespace or
  cgroup sweep on this box (see S27-GAP-2: cgroup v2 delegation unavailable, the
  sweep dead), so a session escape is outside every enforced boundary. The D27
  residual stands as recorded: the sandbox is "explicitly not a hardened microVM".
- **Blast radius:** a cancelled task's CPU/network work continues unbounded under
  the spawning user until it exits on its own; no limits apply to the survivor.
- **Suggested issue:** "S36/S35 hardening: terminate session-escaped descendants —
  a `setsid` grandchild outlives cancellation (S27-GAP-1)". Reproducer: spawn a
  payload `setsid sleep 600 &`; cancel the execution; `pgrep -f 'sleep 600'` still
  finds the descendant after the typed cancellation. Fix family: a PID/Cgroup
  namespace at spawn (the S35 compose deployment owns this surface) or a
  cgroup-delegation sweep; neither is buildable on the recorded host.

- **DISPOSITION (S35, issue #83, E48 — recorded 2026-11-10, nothing above is
  erased):** the fix family's cancel-side half LANDED on this host after all —
  a /proc-side escape sweep that needs neither a PID namespace nor cgroup
  delegation: at cancel()/wall-clock (and again in the post-exit reap) the
  termination seam walks the PPid chain while intact and sweeps NEW session
  leaders (sid === pid, the only shape setsid(2) can produce) born during the
  execution window INSIDE the execution's own user namespace (the leader's
  PRIVATE uid_map under the D27 `unshare --user` envelope — the host-map case
  disables the sweep, an honest degradation, recorded), and SIGKILLs every
  candidate pid-verified against the spawn-time starttime snapshot (the
  pidfd-reuse-safety stand-in — Node exposes no pidfd surface, a native FFI
  dependency was rejected). The DETACHED leg is now a pinned green in
  `s27-st04-process-tree-escape.test.ts` (red/green evidence pair
  `2026-11-10-gap1-setsid-{red,green}.txt` — the red run on the unfixed tree
  shows the grandchild surviving exactly as this section records). The
  REMAINING residual that still needs the deployment host: (a) a double-fork
  orphan whose intermediate parent exits inside one sweep window without ever
  calling setsid (leader's session, chain broken — invisible to a post-hoc
  walk); (b) an escapee that nests its OWN user namespace (no longer
  uid_map-matched); (c) a leader without a private uid_map (no D27 namespace —
  sweep disabled). These close with PID-namespace containment at spawn in the
  S35 Compose posture — recorded as the deployment-host item in the runbook
  §hardening.

## S27-GAP-2 — the cgroup memory layer is unavailable on the recorded host (limits ride RLIMIT_DATA only)

- **Threat:** TM-2.2 (container resource exhaustion); threat model §5 ST-05's
  memory half ("an infinite allocation loop … the container OOMs or starves the
  host").
- **Control the threat model names:** D27 — "CPU, memory, process-count, disk,
  wall-clock limits … enforced per container" (the cgroup layer), plus E1
  admission control.
- **What holds (pinned by `s27-st05-resource-exhaustion.test.ts`):** the kernel
  envelope actually enforced on this box — RLIMIT_FSIZE (SIGXFSZ typed disk
  boundary), RLIMIT_NPROC (fork storm refused), the wall clock (group SIGKILL),
  RLIMIT_DATA (a runaway allocator hits the data ceiling — allocation refusal or
  a limit death, either typed, never unbounded growth). The negative-control leg
  proves the nproc layer is the thing that bounds the storm.
- **What does NOT hold (the gap):** the CGROUP memory layer (a hard byte cap the
  kernel OOM-kills against, independent of the child's allocator) is DEAD on the
  recorded host — cgroup v2 delegation is unavailable to the unprivileged builder
  user, so the sweep cannot be created. The suite records this honestly: the
  memory leg asserts RLIMIT_DATA containment and names the cgroup layer GAP-2,
  never faking an OOM kill. A process that mmaps without touching RLIMIT_DATA's
  accounting (or a host already near its memory ceiling) is outside the enforced
  envelope.
- **Blast radius:** bounded by RLIMIT_DATA + the wall clock for allocators that
  use the heap; a raw-mmap hog relies on the host's own OOM killer.
- **Suggested issue:** "S35 compose deployment: enforce the per-container cgroup
  memory cap (S27-GAP-2) — the prototype's RLIMIT_DATA layer is the fallback, the
  cgroup sweep is dead on the recorded host". The S35 deployment owns the
  container boundary where D27's per-container limits are actually enforceable.

- **DISPOSITION (S35, issue #84, E48 — recorded 2026-11-10, nothing above is
  erased):** the re-verification CHANGED the picture on this host, and the
  change is recorded with its evidence, not absorbed: the delegated subtree
  is LIVE here now (systemd `user@1000.service` carries `Delegate=yes`; a
  direct leaf with a writable memory.max was created outside any code under
  test — the S27-era "not writable" observation no longer reproduces; the
  kernel moved to 7.0.0-42 between the record and this re-verification, and
  whatever the earlier probe hit, the present kernel delegates). TWO real
  defects were masking the layer, both fixed red-first (evidence pair
  `2026-11-10-gap2-cgroup-{red,green}.txt`): (1) `probeCgroupBaseDir`'s
  cleanup threw EISDIR on EVERY delegated host (`rmSync` without recursive
  on a directory) and returned null — a live layer invisible behind its own
  cleanup failure; (2) `teardownCgroupLeaf` used the same rmSync shape and
  could never remove a cgroupfs leaf (both now use rmdir(2), the cgroupfs
  semantics, best-effort and never verdict-bearing). AND a third, live:
  memory.max alone is not a HARD boundary while swap reclaim exists — the
  re-verification's tmpfs hog wrote straight through a live memory.max until
  `memory.swap.max = 0` was written beside it (the S06 no-headroom posture).
  The committed ST-05 leg now pins the answer to GAP-2's exact question on a
  delegated host: a tmpfs hog invisible to RLIMIT_DATA (dd into /dev/shm)
  waits until it observes itself inside its execution leaf, then EXECs dd —
  the kernel SIGKILLs it at memory.max and the exit is the TYPED
  `memory_oom`. The `verify-cgroup.sh` deployment procedure (infra/deploy)
  verifies the FULL delegation sequence on any host (mkdir-only LIES —
  recorded in the script). Residuals, honestly recorded: the pre-move window
  (a charger that begins before the D27 leaf move lands completes before the
  boundary exists — the Compose container-level cgroup covers it), a host
  without swap accounting refusing the swap.max write (the memory.max
  boundary still applies; the swap headroom residual stands), and the VM
  itself: the owner's scratch-VM re-run of `verify-cgroup.sh` + the ST-05
  suite is the deployment-host verification this disposition cannot perform
  from here (no daemon, E22-E47).

## S27-GAP-3 (recorded, not a runtime gap) — the container-level cross-user legs stay a manual PROCEDURE

- **Threat:** TM-5.2 (cross-container access); threat model §5 ST-10's
  container half ("port-scan the compose network toward user B's container,
  attempt to mount/read B's volumes, or call B's runtime gateway API").
- **Why it is not automated:** Docker is unusable on the building machine (the
  recorded E22–E36 reality: socket root-owned); the compose deployment (S35) does
  not exist on this box. The composed legs (the tenant binding, the proxy
  enforcement, the two-store boundary, the sealed custody) ARE automated in
  `s27-st10-cross-user.test.ts`; the container legs are the documented procedure
  in `THREAT-COVERAGE.md` §4 with exact commands and pass/fail observables — the
  owner's P9 item, exactly as the issue's "documented manual procedure" clause
  reserves.
- **Issue tracking:** carried by the standing P9 deployment item (S35), not a new
  issue — the procedure lands in the S27 PR and the acceptance ledger.

---

## The honest-coverage rule these gaps serve

`THREAT-COVERAGE.md` maps every ST row and TM register row to exactly one of
AUTOMATED / PINNED-ELSEWHERE / PROCEDURE / GAP. The GAP class exists so a missing
control is a VISIBLE row with a reproducer — never an absent test that looks like
coverage. Issue #28's acceptance criterion ("Each finding that indicates a real
gap is filed as an issue referencing its reproducer") is served by the suggested
issue texts above; filing them on the tracker is the orchestrator's merge-time
call (the S27 PR lists them either way).
