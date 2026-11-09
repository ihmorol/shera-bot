# Deployment (S35) — the one-VM Compose stack

This directory is the production deployment for one Ubuntu 24.04 VM (PRD
§6.1): web, control-plane, PostgreSQL, Redis (transient only), SearXNG,
Caddy, the central-PG backup service, the monitor, and the S06-provisioned
user runtime containers (up to five, one per account — never static services
here; the control plane provisions them onto the `shera-internal` network).

- The stack definition is [`docker-compose.yml`](./docker-compose.yml)
  (secrets via environment only — [`./.env.example`](./.env.example) names
  them, never their values).
- The edge is [`Caddyfile`](./Caddyfile) (automatic HTTPS; the E43
  namespace-owner pattern — only the web service's netns publishes ports)
  with the scratch variant [`Caddyfile.local`](./Caddyfile.local).
- Images: [`Dockerfile.service`](./Dockerfile.service) (web / control-plane /
  backup / monitor stages) and
  [`Dockerfile.user-runtime`](./Dockerfile.user-runtime) (the S06-provisioned
  per-account image; util-linux + git for the D27 envelope and §10 flows).
- Smoke gate: [`smoke.sh`](./smoke.sh) — run after every deploy (the runbook).
- Structural gate, no daemon needed: `cp .env.example .env` (fill it), then
  `docker compose config` — exit 0 = the stack renders.

**The operator path is the runbook** —
[`docs/s35-deploy-runbook.md`](../../docs/s35-deploy-runbook.md): pre-flight,
migrate, health, smoke, rollback, disaster recovery, monitoring, the S27-GAP-2
cgroup verification, and the hardening notes (PID-namespace containment for
the S27-GAP-1 residual). This README is the map; the runbook is the procedure.

Honest boundary (E48): the compose stack, Caddyfiles, scripts, and Dockerfiles
were validated structurally (`docker compose config`, shell syntax) on the
recorded building machine where the engine daemon is unusable (E22–E47). The
real `docker compose up`, the TLS issuance, the smoke run, and the cgroup
verification are the OWNER's scratch-VM steps — never claimed from here.
