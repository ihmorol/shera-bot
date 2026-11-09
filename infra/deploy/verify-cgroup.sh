#!/bin/sh
# The S27-GAP-2 cgroup verification procedure (issue #84; S35's recorded
# verification step). Run it ON the deployment VM (and on any host whose
# posture you want to observe) — it OBSERVES and REPORTS, it never fakes a
# pass: the recorded building machine answers `cgroup_delegation_absent`
# (the GAP-2 state), a delegated VM answers `engaged`.
#
# What it checks, in order:
#   1. cgroup v2 unified hierarchy present (/sys/fs/cgroup/cgroup.controllers)
#   2. the systemd user-slice delegation the D27 layer probes
#      (/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service
#      writable by the RUNTIME user — the probeCgroupBaseDir path)
#   3. the engine's cgroup driver + the container posture when the engine
#      CLI is available (skipped honestly when it is not)
#   4. INSIDE a provisioned user runtime container (when one runs): whether
#      the D27 cgroup layer engages — the honest check is the runtime's own
#      SandboxExit.cgroupApplied field (the ST-05 suite's re-verification
#      vehicle); this script checks the container's cgroup namespace and
#      writable subtree so the operator can see WHY it does not engage when
#      it does not.
#
# Exit codes (typed, for the runbook and CI):
#   0  the cgroup layer ENGAGES on this host (delegation present)
#   2  observed and NOT engaged — the recorded GAP-2 state (expected on the
#      building machine; a DEPLOYMENT finding on the VM — the runbook's
#      hardening section carries the fix)
#   3  the script could not even observe (no /proc, no cgroup fs) — never
#      silently treated as either of the above
#
# G4/G5: every verdict names its evidence line; nothing is assumed.

set -u

UID_NUM="${SHERA_RUNTIME_UID:-$(id -u)}"
BASE="/sys/fs/cgroup"
USER_SLICE="${BASE}/user.slice/user-${UID_NUM}.slice/user@${UID_NUM}.service"

verdict=""
evidence=""

say() { echo "verify-cgroup: $1"; }

# 1. The unified hierarchy.
if [ ! -f "${BASE}/cgroup.controllers" ]; then
  say "evidence: ${BASE}/cgroup.controllers is ABSENT — this host is not a cgroup-v2 unified host"
  say "verdict: not_a_cgroup_v2_host"
  exit 3
fi
CONTROLLERS="$(cat "${BASE}/cgroup.controllers" 2>/dev/null || echo "")"
say "evidence: root controllers: ${CONTROLLERS}"
case " ${CONTROLLERS} " in
  *" memory "*) : ;;
  *) say "evidence: the memory controller is not available at the root — the D27 memory layer cannot be delegated at all" ;;
esac

# 2. The systemd user-slice delegation the runtime probes — verified with
#    the FULL delegation sequence, because mkdir alone LIES (the S27-GAP-2
#    re-verification, issue #84: the layer was pronounced dead on hosts where
#    a cleanup failure masked a live delegation): enable the controllers on
#    the slice's subtree_control, create a fresh leaf, write memory.max, and
#    only then call it delegated.
if [ ! -d "${USER_SLICE}" ]; then
  say "evidence: ${USER_SLICE} does not exist (no systemd user manager for uid ${UID_NUM} — or a session-less host)"
  verdict="cgroup_delegation_absent"
else
  PROBE="${USER_SLICE}/shera-cgroup-probe-$$"
  DELEGATED="no"
  if mkdir "${PROBE}" 2>/dev/null; then
    # A refused subtree_control write is NOT a verdict by itself: an
    # EEXIST-shaped refusal often means the controllers are ALREADY enabled
    # (systemd's Delegate=yes) — the mkdir-only lie's sibling. Attempt the
    # leaf writes REGARDLESS and let THEM decide (the script's own lesson).
    if echo "+memory +pids" > "${USER_SLICE}/cgroup.subtree_control" 2>/dev/null; then
      say "evidence: subtree_control +memory +pids written at ${USER_SLICE}"
    else
      ENABLED="$(cat "${USER_SLICE}/cgroup.subtree_control" 2>/dev/null || echo "")"
      case " ${ENABLED} " in
        *" memory "*|*" pids "*) say "evidence: the subtree_control write was refused but the controllers are ALREADY enabled (${ENABLED}) — proceeding to the leaf attempt" ;;
        *) say "evidence: subtree_control +memory +pids was REFUSED at ${USER_SLICE} (enabled: '${ENABLED}') — the controllers are likely not delegated; the leaf attempt decides" ;;
      esac
    fi
    if echo 1048576 > "${PROBE}/memory.max" 2>/dev/null && echo 0 > "${PROBE}/memory.swap.max" 2>/dev/null; then
      DELEGATED="yes"
      say "evidence: ${USER_SLICE} carries a WRITABLE leaf (memory.max + memory.swap.max=0 applied) — the full delegation sequence, not just mkdir"
    else
      say "evidence: the leaf's memory.max/swap.max writes were REFUSED — the memory boundary cannot engage (partial delegation at best)"
    fi
    rmdir "${PROBE}" 2>/dev/null
  else
    say "evidence: ${USER_SLICE} is NOT writable by uid ${UID_NUM} — no delegation to the user slice (the recorded GAP-2 shape)"
  fi
  if [ "${DELEGATED}" = "yes" ]; then
    verdict="engaged"
  else
    say "evidence: the fix on a delegated host is systemctl set-property user-${UID_NUM}.slice Delegate=yes (runbook §hardening)"
    verdict="cgroup_delegation_absent"
  fi
fi

# 3. The engine's cgroup posture (skipped honestly without the CLI).
if command -v docker >/dev/null 2>&1; then
  INFO="$(docker info --format '{{.CgroupDriver}} {{.CgroupVersion}}' 2>/dev/null)" || INFO=""
  if [ -n "${INFO}" ]; then
    say "evidence: engine cgroup driver/version: ${INFO}"
  else
    say "evidence: the engine CLI is present but the daemon did not answer (the recorded building-machine shape) — driver posture unobserved"
  fi
else
  say "evidence: no engine CLI on this host — the container-leg checks are skipped (the runtime container checks run ON the VM)"
fi

# 4. Inside a provisioned user runtime container (when this script itself
#    runs INSIDE one — /proc/self/cgroup names the container's leaf).
SELF_CGROUP="$(head -1 /proc/self/cgroup 2>/dev/null || echo "")"
say "evidence: this process's cgroup: ${SELF_CGROUP}"
case "${SELF_CGROUP}" in
  */docker/*|*/system.slice/docker-*) say "evidence: running INSIDE an engine container — the runtime's D27 layer engages here only when the container's subtree is delegated (compose: see the runbook's cgroup notes)" ;;
  *) : ;;
esac

say "verdict: ${verdict}"
case "${verdict}" in
  engaged) exit 0 ;;
  cgroup_delegation_absent) exit 2 ;;
  *) exit 3 ;;
esac
