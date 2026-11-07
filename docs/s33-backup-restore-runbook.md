# S33 runbook — backups and restore (issue #34, PRD §12, E11, D22/D24/D47)

**Status:** Recorded 2026-11-08 with slice S33. Every command below is exact;
the `<placeholders>` are the deployment's own values (noted where they vary).
The MANUAL DECISIONS that cannot be automated are listed in their own section
— they are the operator's job and no script makes them.

**Scope honesty:** the automated drill (`apps/user-runtime/scripts/s33-restore-drill.ts`,
archived output `docs/s33-restore-drill-output-2026-11-07.md`) proves the
mechanism. The OWNER's live drill is the recorded sensitive-slice item
(E11, P4/P9) and remains the owner's — this runbook is what that drill
follows.

---

## 0. The recorded layout

| Thing | Value (the recorded convention) |
| --- | --- |
| Runtime database | `RUNTIME_DB_PATH` (default `./data/runtime.db` inside the runtime container) |
| Snapshot root | the database directory's SIBLING: `<db-dir>.snapshots/` (e.g. `./data.snapshots/`) |
| One snapshot | `<snapshot-root>/<snapshot_id>/` = `runtime.db` + `snapshot.json` (sidecar) + `volume/roots/<n>/…` |
| Retention | the latest 7; the 8th removes the OLDEST, never the newest (AC18) |
| Cadence | every 6 hours from runtime boot (the runtime owns the clock; a restarted runtime re-anchors at ITS boot) |
| Ledger | the runtime's own SQLite `backup_snapshots` table (v23; authored v22, renumbered at the S29 integration — the chain is append-only) — integrity status, alert, `restored_at` |

The credential key files (`provider-credentials.key`, `project-credentials.key`)
and the live database files are NEVER inside a snapshot (D22/E9 — asserted by
inspection: `docs/s33-secrets-exclusion-inspection-2026-11-08.md`).

## 1. What runs automatically (no operator action)

1. **Every 6 hours** (and on every admin trigger): a consistent `VACUUM INTO`
   export of the whole database on the live WAL connection, verified at birth
   with `PRAGMA integrity_check` (a failing copy is refused and removed, never
   retained), the workspace volume captured with the D22/E9 exclusions, the
   ledger row written, retention enforced.
2. **At the start of every 6-hour tick**: the retained window (≤7 snapshots)
   is re-verified. A corrupt stored snapshot raises the ALERT — the bounded
   reason rides the snapshot's ledger row and the redacted fault log
   (`backup_snapshot_corrupt`, plus the tick summary `backup_verify_failed`).
   A later healthy check clears the alert; real corruption keeps failing.
   A corrupt snapshot can NEVER be restored — the restore-candidate policy
   (`RESTORE_SNAPSHOT_CORRUPT`) refuses it before services are even stopped.

## 2. Read the current state (exact commands)

```bash
# The control plane's record (statuses: requested → taken → restored; refusals recorded truthfully)
shera-admin backups list <account_id>

# The runtime's own ledger (authoritative): inside the runtime container,
# against the runtime database:
node --experimental-transform-types -e '
  import { openDatabase } from "apps/user-runtime/src/adapters/sqlite/connection.ts";
  const db = openDatabase(process.env.RUNTIME_DB_PATH ?? "data/runtime.db");
  console.log(db.prepare(
    "SELECT snapshot_id, taken_at, triggered_by, integrity_status, retained_index, alert, restored_at FROM backup_snapshots ORDER BY taken_at DESC"
  ).all());
'
```

A row with a non-null `alert` is a snapshot the restore will refuse. Rows read
`integrity_status = 'ok'` only (a failed copy is never retained).

## 3. The admin-triggered backup (issue #33's surface; D47)

```bash
shera-admin backups trigger <account_id>
```

The trigger dispatches over the recorded internal channel; the runtime takes
the snapshot under the control plane's 1:1 ref (a replayed trigger is the
typed `conflict` — never a second snapshot). The response's `dispatched`
field is the truth: `taken` (row status `taken`), `refused:<reason>` (row
records the refusal), or `runtime_unavailable` (the row stays `requested` —
the snapshot was NOT taken).

## 4. The admin-triggered restore (D47) and its honest boundary

```bash
shera-admin backups restore <account_id> <snapshot_ref>
```

The request is recorded durably (`restore_requested`), then the runtime
executes its recorded walk. HONEST BOUNDARY (G4): the prototype composition
wires no container-level stop/start ports, so the runtime answers the typed

```
RESTORE_PORTS_NOT_WIRED — this composition wires no container-level stop/start
ports — the restore is performed through the operator runbook (stop services,
run the restore, restart)
```

and the control-plane row records `restore_refused:RESTORE_PORTS_NOT_WIRED`.
**This is the expected production answer, not a failure** — the container-level
stop is a step no in-container process can perform honestly. A deployment that
CAN stop its own services supplies the `restorePorts` composition option and
the same command executes the whole walk.

## 5. THE MANUAL RESTORE PROCEDURE (the real one)

Do every step in order. The typed walk in
`apps/user-runtime/src/modules/backups/restore-service.ts` is the reference
implementation of this procedure (the drill proves it); the operator performs
it at the container level.

```bash
# ── 0. The snapshot ref you chose (see the DECISIONS section before choosing) ──
SNAP_ID="<snapshot_id>"                     # e.g. snapshot_53873ea0-…
SNAP_DIR="<db-dir>.snapshots/$SNAP_ID"      # the recorded sibling convention
DB_PATH="<db-dir>/runtime.db"               # the live database inside the volume

# ── 1. STOP the container services (the posture: nothing may hold the db) ──
docker compose stop <runtime-service>       # the deployment's service name
# bare-process deployments: stop the entrypoint unit (systemctl stop shera-runtime)

# ── 2. VERIFY the snapshot's integrity (the same statement the walk runs) ──
sqlite3 "$SNAP_DIR/runtime.db" 'PRAGMA integrity_check;'
#   → exactly one line: ok            (anything else: STOP. Choose another snapshot.)

# ── 3. ARCHIVE the current (broken/suspect) state for forensics ──
mv  "$DB_PATH"      "$DB_PATH.pre-restore"
rm  -f "$DB_PATH-wal" "$DB_PATH-shm"       # stale WAL of the OLD db — never reused
mv  "<db-dir>" "<db-dir>.pre-restore"      # the workspace volume, whole

# ── 4. REPLACE the database ──
mkdir -p "<db-dir>"
cp "$SNAP_DIR/runtime.db" "$DB_PATH"

# ── 5. REPLACE the workspace volume (the snapshot's captured entries back
#       into place; the D22/E9 exclusions are NEVER copied IN and the live
#       custody key files on disk are NEVER deleted) ──
rsync -a "$SNAP_DIR/volume/roots/0/" "<db-dir>/"
#   (the snapshot contains no key files by construction)

# ── 5b. RESTORE THE CUSTODY KEYS (review F2 — do NOT skip) ──
#   The snapshot EXCLUDES the key files by design (D22/E9), so the rebuilt
#   <db-dir> has none. Boot without them generates a FRESH key — the
#   restored sealed credential rows can never resolve against it. Copy the
#   keys back from the step-3 archive BEFORE restart:
cp "$DB_PATH.pre-restore/provider-credentials.key" "<db-dir>/" 2>/dev/null || \
  echo "no provider key in the archive — see decision 6"
cp "$DB_PATH.pre-restore/project-credentials.key" "<db-dir>/" 2>/dev/null || \
  echo "no project key in the archive — see decision 6"
#   (adjust the paths if your deployment stores them elsewhere; the rsync in
#    step 5 never deleted them — they live only in the step-3 archive now)

# ── 6. RESTART ──
docker compose start <runtime-service>     # / systemctl start shera-runtime

# ── 7. WATCH the boot: migrations + the recovery scan (both automatic) ──
docker compose logs -f <runtime-service>
#   migrations run automatically at boot (applyMigrations; D24) — restoring an
#   OLDER snapshot lands at the current head before the API serves (pinned:
#   apps/user-runtime/src/modules/backups/s33-restore-migrations.test.ts).
#   interrupted tasks auto-resume from their semantic checkpoints (S31's
#   RecoveryDriver runs in the boot walk; pinned:
#   apps/user-runtime/src/modules/backups/s33-restore-checkpoint-resume.test.ts).
#   Runs that CANNOT auto-resume (the E13 classes) pause RECOVERY_REQUIRED and
#   show in the recovery banner — that is the typed surface, not an error.

# ── 8. THE SMOKE SUBSET (the drill's three probes, against the live runtime) ──
# login / workspace identity (the workspace answers its owner's reads):
curl -fsS "http://127.0.0.1:${RUNTIME_PORT:-8080}/v1/agents?workspace_id=ws_<account_id>"
# chat history (the conversation from before the incident):
curl -fsS "http://127.0.0.1:${RUNTIME_PORT:-8080}/v1/conversations/<conversation_id>/events?workspace_id=ws_<account_id>&last_acknowledged_sequence=0"
# artifact read:
curl -fsS "http://127.0.0.1:${RUNTIME_PORT:-8080}/v1/workspace/artifacts?workspace_id=ws_<account_id>"

# ── 9. RECORD the restore on the ledger (typed, honest) ──
shera-admin backups restore <account_id> "snapshot_ref_you_used"
#   (after a manual restore this records the request; the runtime will report
#    the snapshot's recorded state — the ledger's restored_at of the WALK is
#    the authoritative stamp for an executed restore)
```

If step 2 fails or the smoke subset fails: keep the pre-restore archive
(step 3), pick a different snapshot, and go again — the archive is the
rollback.

## 6. THE MANUAL DECISIONS (cannot be automated — no script makes these)

1. **Whether to restore at all.** A restore reverts EVERYTHING to
   `taken_at` — messages, approvals, checkpoints, files. Only the operator
   (with the account owner) decides the data-loss window is acceptable.
2. **WHICH snapshot.** When several verify clean, the choice of instant is a
   business decision informed by the ledger (`taken_at`, `triggered_by`,
   `alert`), the fault log, and what the incident was.
3. **The stop window.** Taking the runtime down has user impact; only the
   operator decides when, and whether to announce it first.
4. **User communication.** What users are told, and when, is human work.
5. **Beyond the smoke subset.** The three probes prove the machinery; a human
   must still look at the restored CONTENT and confirm it is the right data.
6. **The custody re-check.** Key files are never in a snapshot, so the
   restore's rebuilt directory has none until step 5b copies them back from
   the pre-restore archive. After a restore, confirm the copied
   `provider-credentials.key` / `project-credentials.key` still resolve the
   restored sealed payloads (a successful provider status read is the
   proof). If the step-3 archive is MISSING (or the disk itself died), the
   keys are unrecoverable from this machine — re-provisioning custody is a
   MANUAL control-plane step, and the restored sealed rows stay unresolvable
   until it runs.
7. **Forensics retention.** How long the `.pre-restore` archives are kept
   (and when they are destroyed) is a policy decision, made by a person.
8. **The owner's live drill** (E11, P4/P9) — performed by the owner, recorded
   as the owner's acceptance; the automated drill is its rehearsal, not its
   replacement.

## 7. Alerts — where they land and what they mean

| Fault line | Meaning | Operator action |
| --- | --- | --- |
| `backup_snapshot_failed` | a tick's export/verify/volume/ledger failed (typed, bounded detail) | read `shera-admin backups list`; check disk space/permissions |
| `backup_snapshot_corrupt` | a RETAINED snapshot failed its re-check | the row carries the alert; exclude it from restore choices; investigate the disk |
| `backup_verify_failed` | the tick's window summary (count of corrupt snapshots) | same as above, at window scale |
| `backup_restore_refused` | a restore walk refused (stage + code, bounded) | the detail names the stage; `RESTORE_SNAPSHOT_CORRUPT` = never restore that snapshot |
| `backup_verify_tick_failed` | the scheduled check itself threw | the cadence continued (never stalls, G4); investigate the runtime |

Every detail field is bounded at 300 characters and carries no secret
material (G3).
