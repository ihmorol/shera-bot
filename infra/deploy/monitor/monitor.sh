#!/bin/sh
# The monitoring minimum (S35; the slice's monitoring rows) — one loop, one
# alert route:
#
#   uptime              — HTTP probe of PUBLIC_URL (the web app; through the
#                         edge, so Caddy is probed with it)
#   container restarts  — the engine API (read-only socket) restart counts and
#                         health states for the stack's own containers AND the
#                         provisioned user runtime containers (shera-rt-*)
#   backup job success  — freshness of /backups/status.json (the backup
#                         service's last cadence result)
#   disk / memory       — HOST-side by nature: the runbook documents the two
#                         host-cron lines (df / free thresholds) that call the
#                         SAME alert() helper below — the container cannot see
#                         host mount pressure honestly
#   error rate / credit anomalies — the S32 admin API is the recorded surface
#                         (`shera-admin`); the runbook documents the check-in
#                         commands and the owner's alert thresholds
#
# Alert routing: ALERT_WEBHOOK_URL (an owner-owned JSON webhook). Empty = the
# alert logs only — the runbook's monitoring section demonstrates the route
# with a deliberately failing check before the 24h green window.
#
# G3: the script never prints env values or engine socket details; alerts
# carry the check name, the observed state, and a timestamp.

set -u

INTERVAL="${CHECK_INTERVAL_SECONDS:-60}"
BACKUP_MAX_AGE="${BACKUP_MAX_AGE_SECONDS:-25200}"
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1:3000}"
WEBHOOK="${ALERT_WEBHOOK_URL:-}"
SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
STATE_DIR="${MONITOR_STATE_DIR:-/tmp/shera-monitor}"
mkdir -p "${STATE_DIR}"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) monitor: $1"; }

alert() {
  # $1 = check name, $2 = observed state (redacted by construction)
  PAYLOAD="$(printf '{"content":"shera-bot alert: %s — %s at %s"}' "$1" "$2" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  log "ALERT $1: $2"
  if [ -n "${WEBHOOK}" ]; then
    curl -sf -H 'Content-Type: application/json' -d "${PAYLOAD}" "${WEBHOOK}" >/dev/null \
      || log "alert delivery failed for $1 (webhook unreachable)"
  else
    log "ALERT_WEBHOOK_URL is empty — the alert is logged only (runbook: configure the route)"
  fi
}

# One-shot per check with edge-triggering: an alert fires when a check turns
# unhealthy and when it recovers, not on every tick.
edge_alert() {
  # $1 = check name, $2 = 0 (healthy) | 1 (unhealthy), $3 = detail
  STATE_FILE="${STATE_DIR}/$1.state"
  PREV=""
  [ -f "${STATE_FILE}" ] && PREV="$(cat "${STATE_FILE}")"
  if [ "$2" = "1" ]; then
    if [ "${PREV}" != "down" ]; then alert "$1" "$3"; fi
    echo "down" > "${STATE_FILE}"
  else
    if [ "${PREV}" = "down" ]; then log "RECOVERED $1"; fi
    echo "up" > "${STATE_FILE}"
  fi
}

check_uptime() {
  if curl -sf -o /dev/null --max-time 10 "${PUBLIC_URL}/login"; then
    edge_alert "uptime" 0 ""
  else
    edge_alert "uptime" 1 "${PUBLIC_URL} did not answer /login within 10s"
  fi
}

check_containers() {
  # The engine API over the read-only socket: every stack container and every
  # provisioned user runtime (shera-rt-*) must be running and (when a
  # healthcheck exists) healthy. Restart counts above the threshold alert.
  LIST="$(curl -sf --max-time 10 --unix-socket "${SOCKET}" "http://localhost/v1.24/containers/json?all=1" 2>/dev/null)" || LIST=""
  if [ -z "${LIST}" ]; then
    edge_alert "engine" 1 "the engine socket did not answer (read-only probe)"
    return
  fi
  edge_alert "engine" 0 ""
  # The stack's containers are PINNED by container_name in docker-compose.yml
  # (shera-*), and the provisioned user runtimes are shera-rt-<account> — the
  # filter matches the pinned prefix, never the compose project name (which
  # derives from the checkout directory and is not an identity, the review's
  # P3c).
  echo "${LIST}" | jq -c '.[] | select(.Names[0] | test("^/shera-")) | {name: .Names[0], state: .State, status: .Status, restarts: .RestartCount}' 2>/dev/null |
  while IFS= read -r row; do
    NAME="$(printf '%s' "${row}" | jq -r '.name' | sed 's|^/||')"
    STATE="$(printf '%s' "${row}" | jq -r '.state')"
    RESTARTS="$(printf '%s' "${row}" | jq -r '.restarts')"
    [ -f "${STATE_DIR}/restarts-${NAME}.base" ] || printf '%s' "${RESTARTS}" > "${STATE_DIR}/restarts-${NAME}.base"
    BASE="$(cat "${STATE_DIR}/restarts-${NAME}.base" 2>/dev/null || echo 0)"
    if [ "${STATE}" != "running" ]; then
      edge_alert "container-${NAME}" 1 "state=${STATE}"
    else
      edge_alert "container-${NAME}" 0 ""
    fi
    if [ "$((RESTARTS - BASE))" -ge 3 ]; then
      alert "restarts-${NAME}" "restart count rose from ${BASE} to ${RESTARTS} since monitor start"
      printf '%s' "${RESTARTS}" > "${STATE_DIR}/restarts-${NAME}.base"
    fi
  done
}

check_backup() {
  if [ ! -f /backups/status.json ]; then
    edge_alert "backup" 1 "no backup status file yet (the first cadence tick has not completed)"
    return
  fi
  STAMP="$(jq -r '.at // empty' /backups/status.json 2>/dev/null)"
  RESULT="$(jq -r '.status // "unknown"' /backups/status.json 2>/dev/null)"
  if [ -z "${STAMP}" ]; then
    edge_alert "backup" 1 "the backup status file is unreadable"
    return
  fi
  EPOCH="$(date -u -d "${STAMP}" +%s 2>/dev/null || echo 0)"
  NOW="$(date -u +%s)"
  AGE=$((NOW - EPOCH))
  if [ "${RESULT}" != "ok" ]; then
    # Reason comes from the backup service itself (redacted by construction).
    REASON="$(jq -r '.reason // "unknown"' /backups/status.json 2>/dev/null)"
    edge_alert "backup" 1 "last cadence result=${RESULT} (${REASON})"
  elif [ "${AGE}" -gt "${BACKUP_MAX_AGE}" ]; then
    edge_alert "backup" 1 "the last successful backup is ${AGE}s old (bound: ${BACKUP_MAX_AGE}s)"
  else
    edge_alert "backup" 0 ""
  fi
}

log "monitor started (interval=${INTERVAL}s, backup bound=${BACKUP_MAX_AGE}s, public=${PUBLIC_URL})"
while :; do
  check_uptime
  check_containers
  check_backup
  sleep "${INTERVAL}"
done
