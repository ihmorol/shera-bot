# S33 restore drill — archived output (2026-11-07)

**Status:** The scripted restore drill (issue #34, DEV_WORKFLOW Stage 8) run ONCE
against commit `46d0680` plus the chunk-4 restore-service work on branch
`s33-backups`. Result: **PASSED, exit 0** — every probe green.

**What ran:** `node --experimental-transform-types apps/user-runtime/scripts/s33-restore-drill.ts`
(the script is committed at `apps/user-runtime/scripts/s33-restore-drill.ts`).

**Redaction (G3):** the output is redacted BY CONSTRUCTION — the script prints
every host path as its scratch-root-relative label (`<scratch>/...`), no
origins/ports, and seeds no secret material at all. The output below is the
complete, unedited captured run (minus Node's experimental-warning banner).

**The smoke subset's honest mapping (recorded):** the account login itself
lives in the CONTROL PLANE, outside the container-local SQLite this slice
restores. The drill's login-equivalent probe is the restored workspace
answering its owner's identity-bearing read (`GET /v1/workspace/nodes` over the
restored copy); chat history and artifact read are the real journal/artifact
reads over real HTTP. The OWNER's live drill is the recorded sensitive-slice
item (E11, P4/P9) and stays NOT-VERIFIED until the owner performs it.

**What the run demonstrated:**

1. A real composed runtime over a real migrated SQLite database seeds a
   conversation, an attributed chat message (the fixture user Emon), a project
   directory + file, and one artifact — all through the real HTTP routes.
2. ONE snapshot through the recorded BackupService walk (E17 export,
   snapshot-time integrity verification, volume capture with the D22/E9
   exclusions, ledger row, retention); the scheduled verifier then verifies
   the retained window clean.
3. A post-snapshot message and a post-snapshot file are written — the data a
   restore must NOT resurrect.
4. The restore walk into the SCRATCH copy: policy → stop (the fixture runtime
   closed FOR REAL) → verify (the snapshot file re-verified) → database →
   volume → migrations (D24; the applied chain 1..22 recorded before and
   after) → restart (the restored copy composed FOR REAL); the ledger row
   stamped `restored_at`.
5. The smoke subset over the restored copy: the workspace answers (the seeded
   file present, the post-snapshot file absent), chat history holds exactly
   the snapshot-time message (the post-snapshot message absent), and the
   artifact's bytes round-trip exactly.

```text
S33 restore drill — take snapshot → restore into a SCRATCH copy → smoke subset
posture: every path is under a throwaway scratch root; the owner's live drill
         (E11, P4/P9) is a separate recorded item — this is the automated rehearsal

scratch root : <scratch> (mktemp; live-shaped fixture at <scratch>/live/data)
restore target: <scratch>/restored/data (the SCRATCH copy)

phase 1 — the live-shaped fixture (a real composed runtime over a real database)
  runtime #1 composed + listening (origin redacted: loopback, ephemeral port)
  PASS  fixture seed — conversation + attributed message (Emon) + projects/thesis directory + outline.md + 1 artifact, all through the real routes

phase 2 — one snapshot through the recorded BackupService walk
  PASS  snapshot + snapshot-time integrity — snapshot taken (db_bytes=622592, volume_entries=1, integrity=ok)
  PASS  scheduled verification (healthy window) — the retained window verifies clean

phase 3 — the post-snapshot mutation (the data a restore must NOT resurrect)
  PASS  post-snapshot mutation — one post-snapshot message + one post-snapshot file written

phase 4 — the restore walk (stop → verify → replace → migrations → restart)
  stage  : policy
  stage  : stop
  stop   : runtime #1 closed (server + SQLite)
  stage  : verify
  stage  : database
  stage  : volume
  stage  : migrations
  stage  : restart
  restart: runtime #2 composed over the restored scratch copy
  PASS  restore walk — restored (migrated 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22 → 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22, db_bytes=622592, volume_entries=1)
  PASS  ledger stamp — restored_at recorded on the snapshot row

phase 5 — the smoke subset over the restored scratch copy (real HTTP)
  PASS  login / workspace-identity — the restored workspace answers: outline.md present, the post-snapshot file absent
  PASS  chat history — the snapshot-time message is present; the post-snapshot message is absent
  PASS  artifact read — the artifact lists and its bytes round-trip exactly

DRILL RESULT: PASSED — the snapshot restored into a working scratch copy
  cleanup: closing the drill's runtimes and removing the scratch root
  cleanup: done
```
