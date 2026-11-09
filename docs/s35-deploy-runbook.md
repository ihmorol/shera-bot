# S35 runbook — deployment on one VM, rollback, DR, monitoring (issue #36; PRD §6.1, §12, §22.23; E48)

**Status:** Recorded 2026-11-10 with slice S35. Every command below is exact;
the `<placeholders>` are the deployment's own values. The MANUAL DECISIONS
that cannot be automated are in their own section — they are the operator's
job and no script makes them.

**Honesty about where this runbook was proven (E48):** the recorded building
machine cannot run Docker (E22–E47: the engine socket is root-owned). What
was verified THERE: the stack renders (`docker compose config`, exit 0 —
archived `docs/s35-compose-config-gate-2026-11-10.md`), the smoke script's
automated HTTP legs against a locally-booted real stack (web + control plane
+ a scratch PostgreSQL 16, no Docker), shell syntax of every script, and the
S27-GAP-1/-2 runtime fixes with their committed red/green evidence. What is
NOT verified until YOU run it: every step below that touches the engine —
image builds, `docker compose up`, TLS issuance, the live smoke run, the
cgroup verification on the VM, the monitoring's 24h green window. The PR's
NOT-verified list is the contract; this runbook is the bridge.

---

## 0. The recorded layout

| Thing | Value |
| --- | --- |
| Host | ONE Ubuntu 24.04 VM (PRD §6.1) — Docker + the Compose plugin, no Kubernetes |
| Stack definition | `infra/deploy/docker-compose.yml` — 8 services: web, control-plane, postgres, redis (TRANSIENT only, no volume), searxng, caddy, backup, monitor |
| The edge | Caddy INSIDE the web service's network namespace (`network_mode: "service:web"`): only the web netns publishes 80/443; the control plane never binds a public interface (the E43 one-tenant pattern) |
| User runtime containers | NOT compose services — the control plane provisions one per account through the S06 backend onto the `shera-internal` network (up to five: `SIGNUP_CAP = 5`); the image comes from `SHERA_RUNTIME_IMAGE` (built by `infra/deploy/Dockerfile.user-runtime`) |
| Secrets | `.env` on the VM only (gitignored); the committed template `infra/deploy/.env.example` carries NAMES only (G3); the compose `${VAR:?}` posture refuses to render an unconfigured stack |
| Backups | TWO layers, both already built: (a) the runtime's OWN six-hour snapshot/restore machinery (S33/E44 — the user-facing AC18 layer); (b) this stack's `backup` service — the CENTRAL PostgreSQL cadence (pg_dump custom format into the `backups` volume, keep 7) with its result in `/backups/status.json` |
| Monitoring | the `monitor` service — uptime probe, container health/restart counts over the read-only engine socket, backup freshness; alerts to `ALERT_WEBHOOK_URL`; disk/memory/error-rate/credit-anomaly rows are the §7 host commands (a container cannot see host mount pressure honestly) |
| Build identity | every built image is tagged and labeled `org.opencontainers.image.revision = $GIT_SHA`; the smoke script checks the running labels against `git rev-parse HEAD` |

---

## 1. Pre-flight (one-time, exact commands)

```bash
# 1.1 The host: Docker Engine + the Compose plugin on Ubuntu 24.04, and git.
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 1.2 The repo, at the reviewed commit.
git clone https://github.com/ihmorol/shera-bot.git && cd shera-bot
git checkout <the reviewed merge commit>          # the PR's head SHA

# 1.3 The environment file — ON THE VM, never committed (G3).
cd infra/deploy
cp .env.example .env
$EDITOR .env    # every required reference; generate secrets with:
#   openssl rand -base64 32   # AUTH_SECRET
#   openssl rand -base64 24   # POSTGRES_PASSWORD (URL-safe encode it)
#   openssl rand -base64 24   # SEARXNG_SECRET

# 1.4 The structural gate — the stack must render BEFORE anything builds.
export GIT_SHA=$(git rev-parse HEAD)
docker compose config > /dev/null && echo "stack renders OK (exit 0)"
# If this fails with 'set <VAR> in .env', the named reference is missing —
# an unconfigured deployment refuses here BY DESIGN (G4), never later.

# 1.5 DECISION (manual): scratch edge or production edge?
#   Scratch (no DNS yet): set CADDYFILE=Caddyfile.local and
#     PUBLIC_URL=http://<vm-ip> in .env — HTTP only, automatic HTTPS off.
#   Production: DNS must already resolve DOMAIN to this VM (ports 80/443
#     open — Caddy answers the ACME challenge on them).
```

**Manual decision 1 — the Google OAuth client.** Create the client in Google
Cloud Console with the authorized redirect URI
`https://<DOMAIN>/api/control/api/auth/callback/google` (scratch:
`http://<vm-ip>/api/control/api/auth/callback/google`). No script can own
this console.

---

## 2. Build (build identity = git SHA)

```bash
cd infra/deploy
export GIT_SHA=$(git rev-parse HEAD)     # the SAME SHA the smoke script checks

# The stack's own images (web, control-plane, backup, monitor).
docker compose build
# The USER runtime image (provisioned per account by the control plane).
docker build -f Dockerfile.user-runtime -t "$SHERA_RUNTIME_IMAGE" --build-arg GIT_SHA=$GIT_SHA ..
#   (.env's SHERA_RUNTIME_IMAGE must name the tag you just built, e.g.
#    shera-user-runtime:$GIT_SHA)
```

Every image carries `org.opencontainers.image.revision=$GIT_SHA`. Verify:

```bash
docker image inspect shera-web:$GIT_SHA --format '{{.Config.Labels}}' | grep -o "$GIT_SHA"
```

---

## 3. Boot, migrate, health

```bash
cd infra/deploy

# 3.1 Boot the stateful core first; the migrations run in the next step.
docker compose up -d postgres
docker compose ps                       # postgres healthy (its healthcheck gates the rest)

# 3.2 MIGRATIONS — the control plane's PostgreSQL schema (drizzle, forward-only).
#      The migration step is the repo's own script run in a one-shot container:
docker compose run --rm control-plane \
  node --eval "import('./src/db/migrations.ts').then(async (m) => { const { createDb } = await import('./src/db/client.ts'); const url = process.env.DATABASE_URL; if (!url) { console.error('DATABASE_URL is required'); process.exit(1); } const { db, pool } = createDb(url); await m.runMigrations(db); await pool.end(); console.log('migrations applied'); })"
#      MIGRATION REVIEW (P9, the sensitive-slice rule): the migrations in
#      THIS slice are NONE — the chain head is v23 (S33's backup-snapshots;
#      S30's v24/v25 are runtime-SQLite, not PostgreSQL) and deployment adds
#      no migration. The drizzle PostgreSQL migrations were reviewed line by
#      line at their own slices; a FUTURE deployment that adds any re-runs
#      this review before merge (recorded in that PR).

# 3.3 Boot everything.
docker compose up -d
docker compose ps        # ALL services healthy (or running, for caddy — it has
                         # no healthcheck by design; the OMB precedent — the
                         # web service's healthcheck covers the shared netns)

# 3.4 Health — the boot-response shape (the E43 monitoring-shape reference):
curl -s http://127.0.0.1:3000/healthz
#   {"status":"ok","auth":{"configured":true,"provider":"google"}}
#   (configured:false = the OAuth references are missing — G4: a first-class
#    configuration state; fix .env and restart the control-plane before
#    continuing. Never proceed on a fake-login posture.)
docker compose logs caddy --tail 20      # TLS issuance (production edge):
#   certificate obtained successfully for <DOMAIN>
```

---

## 4. Smoke (run after EVERY deploy)

```bash
cd infra/deploy
./smoke.sh "${PUBLIC_URL:-http://127.0.0.1}"
# Automated legs: the web through the edge; /api/control/healthz through the
# web proxy (the typed boot response); the unauthenticated session probe
# REFUSED (401 — the auth gate alive); the running images' revision labels
# matching the checked-out GIT_SHA. Idempotent — re-run freely.

# The INTERACTION legs (login, send message, artifact, approval,
# refresh-replay) — two recorded paths, both required after a real deploy:
#   (a) the committed acceptance harness (the S34 machinery, 27/27 rows):
pnpm acceptance          # from the repo root — the criteria runner
#   (b) the owner's manual walk: sign in with the OAuth account, send a
#       message, watch the stream, refresh (durable replay), request and
#       decide one approval. No script owns your eyes (G4).
```

---

## 5. Rollback (previous image; the migration strategy is FORWARD-ONLY)

**The stated strategy: forward-only migrations.** PostgreSQL schema changes
(drizzle) and the runtime's SQLite chain (D24) never move backwards; a
rollback restores the previous IMAGE and, when the previous image predates a
schema change, the DATA is restored from the backup layer (compensating via
restore — the only compensated path). The prototype's migrations are reviewed
line by line per slice (P9); a rollback that would cross a schema change is
NOT a rollback — it is a restore.

```bash
cd infra/deploy

# 5.1 The previous image is present because every build is tagged with its
#     GIT_SHA (never :latest). List the deployed tag and the previous one:
docker images --format '{{.Repository}}:{{.Tag}}' | grep shera-web

# 5.2 Roll the stack to the previous SHA (the .env's GIT_SHA value + retag):
export GIT_SHA=<previous-sha>     # edit .env's GIT_SHA to the previous SHA
docker compose up -d --no-build   # recompose against the EXISTING previous images
./smoke.sh "${PUBLIC_URL}"        # the smoke gate decides health — same legs

# 5.3 If the previous image predates a schema change (forward-only rule):
#     restore the central-PG data instead of rolling the schema —
docker compose stop control-plane
docker compose run --rm -v shera_backups:/backups:ro backup \
  pg_restore --clean --if-exists --dbname "postgres://shera:<POSTGRES_PASSWORD>@postgres:5432/shera" \
  /backups/control-plane-<timestamp>.dump
docker compose start control-plane
./smoke.sh "${PUBLIC_URL}"
```

**The rollback drill (the issue's acceptance item) is the OWNER's scratch-VM
step** — the procedure above is what to drill; the PR records it as
NOT-VERIFIED from the building machine. Drill it BEFORE the first real
exposure (Manual decision 3).

---

## 6. Disaster recovery (references the #34 restore drill)

Two independent data planes, two recovery paths — both already drilled where
the building machine allowed:

1. **The user plane (per-account product state)** — the S33 machinery. The
   runbook is `docs/s33-backup-restore-runbook.md`; the DRILL is
   `apps/user-runtime/scripts/s33-restore-drill.ts` (run once, PASSED, exit
   0 — archived `docs/s33-restore-drill-output-2026-11-07.md`); the restore
   path is the S32 admin trigger (`shera-admin backups restore ...`), the
   seven-stage typed walk, the D24 migration-after-restore, the F2
   custody-key copy-back step. On the VM the deployment supplies
   `restorePorts` (E44's honest `RESTORE_PORTS_NOT_WIRED` boundary applies
   only where the composition wires none) — verify with
   `shera-admin backups list <account_id>` after the first six-hour cadence.

2. **The control plane (central PostgreSQL)** — this stack's `backup`
   service: pg_dump (custom format) into the `backups` volume every
   `BACKUP_INTERVAL_SECONDS` (default 6h), keep 7, the result in
   `/backups/status.json`. Restore (the §5.3 command, or onto a scratch DB
   for the drill):

```bash
# The DRILL (scratch DB — never the live one):
docker compose exec postgres createdb -U shera shera_drill
docker compose run --rm -v shera_backups:/backups:ro backup \
  pg_restore --dbname "postgres://shera:<POSTGRES_PASSWORD>@postgres:5432/shera_drill" \
  /backups/control-plane-<timestamp>.dump
docker compose exec postgres psql -U shera -d shera_drill -c "SELECT count(*) FROM accounts;"
docker compose exec postgres dropdb -U shera shera_drill
# The restore drill from #34 is (1) above; this block is the control-plane
# path's own drill. Both are OWNER scratch-VM steps (NOT-VERIFIED from here).
```

---

## 7. Monitoring minimum + the alert route (the issue's rows)

The `monitor` service automates three rows and the alert route; four rows are
host/admin commands — each with its threshold and its alert line:

| Row | Automated by the monitor | Manual row (exact command) |
| --- | --- | --- |
| Uptime | HTTP probe of `PUBLIC_URL` every `CHECK_INTERVAL_SECONDS` | — |
| Container restarts | engine socket (read-only): state != running, restart-count +3 | — |
| Backup job success | `/backups/status.json` older than `BACKUP_MAX_AGE_SECONDS`, or status != ok | — |
| Disk | — | host cron: `df -h / | awk 'NR==2 {gsub("%","",$5); exit ($5 > 80)}'` (PRD §12's 80% warn) |
| Memory | — | host cron: `free -m | awk 'NR==2 {exit ($7 < 512)}'` |
| Error rate | — | `docker compose logs --since 10m control-plane | grep -c '"level":"error"'` (threshold: yours — Manual decision 5) |
| Credit anomalies | — | `shera-admin credits list` / the S32 ledger readouts (an unexpected reservation balance) |

Every row alerts through the SAME route — `alert()` in
`infra/deploy/monitor/monitor.sh` POSTs to `ALERT_WEBHOOK_URL`. Host-cron
rows POST with the same body shape (the two cron lines call a two-line
`curl -d '{"content":"..."}' "$ALERT_WEBHOOK_URL"`).

**The alert path MUST be demonstrated once** (the issue's acceptance item) —
the deliberate failing check:

```bash
# Point .env's ALERT_WEBHOOK_URL at a webhook you receive, then:
docker compose stop searxng          # a deliberate failure
sleep $((CHECK_INTERVAL_SECONDS + 30))
#   EXPECTED on your webhook: 'shera-bot alert: container-searxng — state=exited ...'
docker compose start searxng         # recovery is logged too
```

The 24h green window with the owner as the sole user is the OWNER's
acceptance step — start it the day the scratch environment goes green.

---

## 8. The S27-GAP-2 cgroup verification ON THE VM (issue #84)

```bash
# Host posture — the FULL delegation sequence (mkdir-only lies; the script
# records why):
cd infra/deploy
./verify-cgroup.sh
#   verdict: engaged                 → the D27 cgroup layer can engage
#   verdict: cgroup_delegation_absent → systemctl set-property user-$(id -u).slice Delegate=yes
#                                       (log out/in; re-run the script)

# The runtime answer — the ST-05 suite is the re-verification vehicle:
#   on the VM, from the repo root:
pnpm vitest run tests/security/s27-st05-resource-exhaustion.test.ts
#   the GAP-2 leg asserts the TYPED memory_oom on a delegated host (the
#   kernel boundary, not the allocator); on a non-delegated host it pins the
#   honest degradation — the runbook records WHICH verdict the VM gave.
# IN THE DEPLOYED CONTAINERS the container-level memory cap is the compose/
# S06 posture (S06's container spec sets Memory + MemorySwap = Memory — no
# swap headroom — per account tier); the per-execution leaf is the D27 layer.
```

Record the verdict (both commands' output) in the deployment's evidence note.

---

## 9. Hardening — the S27-GAP-1 residual and its closure (issue #83)

What LANDED on the runtime side (this slice, live-verified):
`spawnSandboxedExecution`'s termination seams (cancel, wall clock, the
post-exit reap) sweep session-escaped descendants — the PPid chain while
intact, then every NEW session leader inside the execution's own user
namespace (uid_map-anchored), pid-verified kills against the spawn-time
starttime snapshot. The ST-04 detached leg is pinned green
(`tests/security-evidence/2026-11-10-gap1-setsid-{red,green}.txt`).

The RESIDUAL that needs the deployment host (recorded, never silenced):

1. **PID-namespace containment at spawn.** On a host where the engine can
   grant it, the complete closure is spawning each execution inside a PID
   namespace owned by the runtime (then killing the namespace's init kills
   EVERY descendant — no post-hoc walk needed, and the pre-move window of
   the memory boundary closes too). The runtime container image already
   carries util-linux; the posture needs the engine daemon configured so
   provisioned containers may create user+PID namespaces (Docker's default
   seccomp profile denies unprivileged userns creation inside containers —
   `--security-opt seccomp=unconfined` for the RUNTIME containers is the
   blunt option, a scoped profile the honest one). **Manual decision 6.**
2. **A double-fork orphan that completes inside one sweep window** (no
   setsid, chain broken) stays outside any post-hoc host-side sweep — same
   closure as (1).
3. Until (1) is in place, the sweep + the group kill + the prlimit envelope
   are the enforced boundary, and the ST-04 suite is the pinned proof of
   what each layer guarantees.

---

## 10. Secrets audit (the acceptance item — commands and output go in the PR)

```bash
# 10.1 The tree: no secret-shaped value in the committed deployment files.
git grep -nE '(secret|password|token|key)\s*[:=]\s*["'"'"'][A-Za-z0-9+/]{16,}' \
  -- infra/deploy docs/s35-deploy-runbook.md || echo "clean: no literal secrets in the deployment tree"

# 10.2 The images: the env they BAKE is names only (the Dockerfiles copy
#      sources, never .env — the root .dockerignore excludes it).
docker image inspect shera-control-plane:$GIT_SHA --format '{{.Config.Env}}' | tr ' ' '\n' | \
  grep -E 'SECRET|PASSWORD|TOKEN|CLIENT_ID' || echo "clean: no secret references baked into the image env"

# 10.3 The running stack: the secrets live in .env (on the VM) and the
#      engine's runtime config ONLY — never in logs:
docker compose logs --since 1h | grep -iE "$(.env is not sourced here — spot-check by eye)" || true
#   and the mechanical sweep of the visible logs for the actual values:
for v in AUTH_SECRET POSTGRES_PASSWORD GOOGLE_CLIENT_SECRET SEARXNG_SECRET; do
  val=$(grep "^$v=" .env | cut -d= -f2)
  docker compose logs 2>/dev/null | grep -qF "$val" && echo "LEAK: $v appears in logs" || echo "clean: $v not in logs"
done

# 10.4 The backups: the S33 exclusion is the recorded name vocabulary
#      (asserted by inspection at S33); the central-PG dumps hold schema+rows
#      (no credentials by schema design — the control plane stores identity
#      and container mapping only, D2).
```

---

## 11. The exposure plan (the issue's acceptance item)

1. **The owner first** — one account, the sole user, the 24h monitoring
   window green, one alert demonstrated.
2. **Accounts 2–5, one at a time**, with a recorded check-in after each
   (the S32 admin surface lists users/tiers; `SIGNUP_CAP = 5` is the code's
   ceiling — the sixth signup is refused, AC1's tenancy).
3. **No other exposure path exists**: the edge is the only published surface
   (the web netns), the control plane and the runtimes are
   `shera-internal`-only, the engine socket is mounted ONLY into the
   control-plane (read-only for the monitor), and no ports beyond 80/443 are
   published. Any second path is a change to this runbook and a recorded
   decision.

---

## 12. The manual decisions that cannot be automated

1. **The Google OAuth client** (§1) — console-owned, per-deployment.
2. **Scratch edge vs production edge** (§1.5) — the DNS/TLS go/no-go.
3. **The rollback drill date** (§5) — before the first real exposure.
4. **ALERT_WEBHOOK_URL's destination** — the owner's own webhook service
   (ntfy/Slack-compatible); a token there is the owner's custody, never a
   repo value (G3).
5. **The error-rate threshold** (§7) — the owner's noise floor.
6. **The engine's seccomp posture for the runtime containers** (§9.1) — the
   scoped profile vs the blunt unconfined opt-in for the userns-based
   sandbox; a security decision, recorded before the first provisioning.
7. **The first real account's identity** (§11) — who is user #1.
8. **The 24h green window's start** (§7) — the acceptance clock.
