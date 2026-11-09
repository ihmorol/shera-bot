#!/bin/sh
# The central-PostgreSQL backup cadence (S35; PRD §12). The USER-facing
# snapshot/restore machinery is the runtime's own six-hour scheduler
# (S33/E44) — this service covers the CONTROL-PLANE database only and
# reports its result to /backups/status.json for the monitor's
# backup-success check.
#
# Posture (E44, carried honestly):
#   BACKUP_BACKEND=copy   — pg_dump (custom format) into the backups volume,
#                           prune to BACKUP_KEEP; dependency-free default.
#   BACKUP_BACKEND=restic — the DOCUMENTED EXTERNAL binary per E44: the
#                           script requires `restic` on PATH and REFUSES
#                           typed when absent (never a silent fallback).
#                           Restic reads the same /backups directory; its
#                           repository init/keys are the operator's (the
#                           runbook's DR section).
#
# G3: the script never echoes DATABASE_URL or any credential; failures are
# surfaced through the status file and the exit code, with reasons — never
# secret material.

set -u

INTERVAL="${BACKUP_INTERVAL_SECONDS:-21600}"
KEEP="${BACKUP_KEEP:-7}"
BACKEND="${BACKUP_BACKEND:-copy}"
DEST_DIR="${BACKUP_DIR:-/backups}"
STATUS_FILE="${DEST_DIR}/status.json"

log() {
  # Structure-only output: no env values, no connection strings (G3).
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $1"
}

write_status() {
  # $1 = ok|failed, $2 = reason (bounded, redacted by construction), $3 = file
  mkdir -p "${DEST_DIR}" 2>/dev/null
  printf '{"backend":"%s","status":"%s","reason":"%s","file":"%s","at":"%s"}\n' \
    "${BACKEND}" "$1" "$2" "$3" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STATUS_FILE}.tmp" \
    && mv "${STATUS_FILE}.tmp" "${STATUS_FILE}"
}

dump_once() {
  mkdir -p "${DEST_DIR}"
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  TARGET="${DEST_DIR}/control-plane-${STAMP}.dump"

  if [ "${BACKEND}" = "restic" ]; then
    if ! command -v restic >/dev/null 2>&1; then
      # Typed refusal (G4) — the E44 posture: restic is the documented
      # external binary; its absence is a configuration state, never a
      # silent degradation to "backed up".
      write_status "failed" "BACKUP_BACKEND=restic but the restic binary is not installed in this image (E44 posture)" ""
      log "refused: restic backend requested but the binary is absent"
      return 1
    fi
    # The operator owns the restic repository (init/keys/env per the DR
    # runbook); the pg_dump still lands in the volume so the snapshot is
    # inspectable, then restic snapshots the directory.
    if ! pg_dump --format=custom --file="${TARGET}" "${DATABASE_URL}"; then
      write_status "failed" "pg_dump failed (see container logs)" ""
      log "pg_dump failed"
      return 1
    fi
    if ! restic backup "${DEST_DIR}" --tag shera-control-plane; then
      write_status "failed" "restic backup failed (see container logs)" ""
      log "restic backup failed"
      return 1
    fi
  else
    if ! pg_dump --format=custom --file="${TARGET}" "${DATABASE_URL}"; then
      write_status "failed" "pg_dump failed (see container logs)" ""
      log "pg_dump failed"
      return 1
    fi
  fi

  # Retention: keep exactly BACKUP_KEEP dumps, remove the OLDEST (the E44
  # cadence rule — never the newest).
  ls -1t "${DEST_DIR}"/control-plane-*.dump 2>/dev/null | tail -n "+$((KEEP + 1))" | while IFS= read -r old; do
    rm -f -- "${old}"
    log "pruned old dump: $(basename -- "${old}")"
  done

  write_status "ok" "" "$(basename -- "${TARGET}")"
  log "snapshot complete: $(basename -- "${TARGET}")"
}

# Fail fast when the required references are absent (G4) — the container
# restarts (restart: unless-stopped) and the monitor reports the flap.
if [ -z "${DATABASE_URL:-}" ]; then
  write_status "failed" "DATABASE_URL is not configured" ""
  log "refused: DATABASE_URL missing"
  sleep 60
  exit 1
fi

while :; do
  dump_once
  sleep "${INTERVAL}"
done
