# S33 secrets-exclusion inspection — archived evidence (2026-11-08)

**Status:** PASSED (exit 0). The exclusion is **asserted by inspection, not
assumed** (issue #34, D22/E9) — and the inspection EARNED its keep: its FIRST
run found a real exclusion hole, which was fixed on this branch before the
passing run below.

**What ran:** `node --experimental-transform-types apps/user-runtime/scripts/s33-secrets-exclusion-inspection.ts`
(the script is committed at `apps/user-runtime/scripts/s33-secrets-exclusion-inspection.ts`).

**The posture:** a snapshot is taken whose volume carries PLANTED credential
key files under the recorded EXACT names (`provider-credentials.key`,
`project-credentials.key`) — at the volume root AND nested inside a captured
directory — each containing a SYNTHETIC secret (never a real credential; the
same posture the suite's inspection pin uses). The inspection then runs the
exact commands a reviewer would run and prints each with its output and exit
code. Every host path is printed as a scratch-relative label — redacted by
construction (G3); there is no secret material in this evidence.

## The first run — FAILED (the finding, kept as evidence; never summarized away)

The first run captured `projects/provider-credentials.key` — a key file
NESTED inside a captured directory rode the wholesale recursive `cpSync` of
the copy backend. The root-level key files were correctly excluded, but the
exclusion did not hold at depth. The suite's pin was extended red-first
(the nested plant), and the backend's capture walk was fixed to honor the
exclusion vocabulary at EVERY directory level (the walk skips excluded names
instead of descending into a wholesale copy). Both sides kept: the failing
run is recorded here, and the suite pins the nested plant permanently.

```text
$ find <snapshot-root> -type f | sort
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/runtime.db
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/snapshot.json
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/volume/roots/0/agent-files/profile.md
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/volume/roots/0/projects/provider-credentials.key
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/volume/roots/0/projects/repo.txt
  [exit=0]

$ find <snapshot-root> -name '*credentials*'
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/volume/roots/0/projects/provider-credentials.key
  [exit=0 — EXPECTED 1]

$ grep -R -a -F '<SYNTHETIC-SECRET-FULL-VALUE>' <snapshot-root>
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/volume/roots/0/projects/provider-credentials.key: match
  [exit=0 — EXPECTED 1]

$ grep -R -a -F '<SYNTHETIC-SECRET-16-CHAR-FRAGMENT>' <snapshot-root>
  <snapshot-root>/data.snapshots/snapshot_53873ea0-290b-4726-8e9b-3b2fbf06751a/volume/roots/0/projects/provider-credentials.key: match
  [exit=0 — EXPECTED 1]

$ jq -r '.volume_entries[]' <snapshot-root>/<snapshot-id>/snapshot.json | grep credentials
  [exit=1]

INSPECTION RESULT: FAILED — see the unexpected findings above
```

## The passing run (after the fix — the recorded evidence)

```text
S33 secrets-exclusion inspection (D22/E9) — the exact commands + their outputs
posture: the planted key files carry a SYNTHETIC secret; every path is under a
         throwaway scratch root and printed as a scratch-relative label (G3)

step 1 — the snapshot is taken through the recorded BackupService walk
  snapshot taken (db_bytes=622592, volume_entries=0:agent-files, 0:projects)

$ find <snapshot-root> -type f | sort
  <snapshot-root>/data.snapshots/snapshot_11ee319f-602d-449e-8006-92549ab82aed/runtime.db
  <snapshot-root>/data.snapshots/snapshot_11ee319f-602d-449e-8006-92549ab82aed/snapshot.json
  <snapshot-root>/data.snapshots/snapshot_11ee319f-602d-449e-8006-92549ab82aed/volume/roots/0/agent-files/profile.md
  <snapshot-root>/data.snapshots/snapshot_11ee319f-602d-449e-8006-92549ab82aed/volume/roots/0/projects/repo.txt
  [exit=0]

$ find <snapshot-root> -name '*credentials*'
  [exit=1]

$ grep -R -a -F '<SYNTHETIC-SECRET-FULL-VALUE>' <snapshot-root>
  [exit=1]

$ grep -R -a -F '<SYNTHETIC-SECRET-16-CHAR-FRAGMENT>' <snapshot-root>
  [exit=1]

$ jq -r '.volume_entries[]' <snapshot-root>/<snapshot-id>/snapshot.json | grep credentials
  [exit=1]

INSPECTION RESULT: PASSED — no credential key file, and no synthetic secret bytes, appear anywhere in the snapshot
```

**Commands, verbatim** (as printed by the script; `<snapshot-root>` is the
throwaway mktemp root, `<snapshot-id>` the taken snapshot's id):

1. `find <snapshot-root> -type f | sort` — the complete file inventory of
   the snapshot (only the database copy, the sidecar, and the captured
   non-excluded volume entries).
2. `find <snapshot-root> -name '*credentials*'` — no key file anywhere.
3. `grep -R -a -F '<SYNTHETIC-SECRET-FULL-VALUE>' <snapshot-root>` — the
   full synthetic secret appears nowhere (binary-safe, every file).
4. `grep -R -a -F '<SYNTHETIC-SECRET-16-CHAR-FRAGMENT>' <snapshot-root>` —
   no fragment either (a partial leak would be a leak).
5. `jq -r '.volume_entries[]' <snapshot-root>/<snapshot-id>/snapshot.json | grep credentials`
   — the sidecar's captured-entries manifest names no credential file.
