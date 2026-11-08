# S33 secrets-exclusion inspection — archived evidence (2026-11-08)

**Status:** PASSED (exit 0) — **the exclusion is a NAME vocabulary, not a
content scan** (see the boundary at the end of this document). It is
**asserted by inspection, not assumed** (issue #34, D22/E9) — and the
inspection EARNED its keep: its FIRST run found a real exclusion hole (the
wholesale `cpSync`), and the review round found a second class (link
dereferencing, F1) — each fixed on this branch before the passing run.

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
  snapshot taken (db_bytes=684032, volume_entries=0:agent-files, 0:projects)

$ find <snapshot-root> -type f | sort
  <snapshot-root>/data.snapshots/snapshot_5cb74e38-b620-4714-8d8d-992533bab43f/runtime.db
  <snapshot-root>/data.snapshots/snapshot_5cb74e38-b620-4714-8d8d-992533bab43f/snapshot.json
  <snapshot-root>/data.snapshots/snapshot_5cb74e38-b620-4714-8d8d-992533bab43f/volume/roots/0/agent-files/profile.md
  <snapshot-root>/data.snapshots/snapshot_5cb74e38-b620-4714-8d8d-992533bab43f/volume/roots/0/projects/repo.txt
  [exit=0]

$ find <snapshot-root> -name '*credentials*'
  [exit=1]

$ grep -R -a -F '<SYNTHETIC-SECRET-FULL-VALUE>' <snapshot-root>
  [exit=1]

$ grep -R -a -F '<SYNTHETIC-SECRET-16-CHAR-FRAGMENT>' <snapshot-root>
  [exit=1]

$ jq -r '.volume_entries[]' <snapshot-root>/<snapshot-id>/snapshot.json | grep credentials
  [exit=1]

INSPECTION RESULT: PASSED — none of the PLANTED key-file shapes (the recorded exclusion names, at any depth, through any link) and none of the planted synthetic secret bytes appear in the snapshot. The exclusion is a NAME vocabulary, not a content scan — see the boundary note in the archived evidence.
```

## The boundary (the review F3 honesty — recorded, not hidden)

The exclusion vocabulary is **NAME-based at the recorded paths**: the
credential key FILES (`provider-credentials.key`, `project-credentials.key`,
and the live database files) never enter a snapshot, at any directory depth,
through any link type (the F1 fix). It is NOT a content scan. A reviewer
proved the difference live: a file named `provider-credentials.key.bak`, an
`.env`, a `projects/secrets.json`, or a `.git/config` with embedded
credentials is an ORDINARY name to the walk and its bytes DO ride the
snapshot. The passing verdict below therefore claims exactly the planted
shape — no file under the recorded exclusion NAMES, and none of the planted
synthetic secret's bytes — nothing stronger.

**Capture-time content scanning is OUT of S33 scope** and is the recorded
follow-up: scan every captured file's bytes for secret-shaped content at
capture time (and refuse-or-redact typed) — the S29 memory scanner's
write-time secret posture (`memory_entry`'s G3 write-time scan) is the
future reference for that machinery. Until that follow-up lands, the
runbook's forensic-archive step (step 3) and the deployment's at-rest
controls are what bound a same-shape leak.

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
