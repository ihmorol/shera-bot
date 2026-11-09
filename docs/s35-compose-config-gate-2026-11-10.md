# S35 compose structural gate — `docker compose config` (2026-11-10)

The recorded building machine has NO usable engine daemon (E22-E47: the
socket is root-owned) — the structural gate for the deployment artifacts on
this host is `docker compose config`, which renders and validates the stack
WITHOUT a daemon (exit 0 = structurally valid). This file is that gate's
archived evidence; every re-run lands beside it with its date.

Environment: Docker 29.1.3 / Compose v2.24.0 (client-only use).

## Positive gate — the stack renders with a filled env

Command (run from `infra/deploy/`, the project directory the relative bind
mounts resolve against):

    docker compose --env-file <placeholder-env> config

The placeholder env is `.env.example` with every required reference filled
by a `gate-placeholder` value — placeholders, never real secrets (G3). The
rendered tree is the full 8-service stack with the labels, networks,
healthchecks, and the `service:web` namespace posture resolved.

Observed: exit 0; the rendered config names all eight services (web,
control-plane, postgres, redis, searxng, caddy, backup, monitor), the
`shera-internal` network pinned to its real name, the revision labels on
every built image, and `network_mode: service:web` on caddy.

Rendered excerpt (structure lines only — environment values are redacted
from this archive by construction, G3):

```
        condition: service_healthy
    image: shera-backup:local
      org.opencontainers.image.revision: local
      shera-internal: null
        condition: service_healthy
    image: caddy:2
    network_mode: service:web
        condition: service_healthy
      SHERA_RUNTIME_NETWORK: shera-internal
    image: shera-control-plane:local
      org.opencontainers.image.revision: local
      shera-internal: null
        condition: service_started
        condition: service_started
        condition: service_started
        condition: service_started
        condition: service_started
        condition: service_started
    image: shera-monitor:local
      org.opencontainers.image.revision: local
      shera-internal: null
    image: postgres:16
      shera-internal: null
    image: redis:7-alpine
      shera-internal: null
    image: searxng/searxng:latest
      shera-internal: null
    image: shera-web:local
      org.opencontainers.image.revision: local
      shera-internal: null
    ports:
  shera-internal:
    name: shera-internal
```

## Negative gate — an unconfigured env REFUSES (G4)

Command:

    docker compose --env-file /dev/null config

Observed: non-zero exit (15) with the typed complaint naming the missing
reference:

```
error while interpolating services.backup.environment.DATABASE_URL: required variable POSTGRES_PASSWORD is missing a value: set POSTGRES_PASSWORD in .env
```

The `${VAR:?}` posture in docker-compose.yml is what makes an
unconfigured deployment a first-class failure — the stack never renders
half-configured with silent defaults (G4).

## What this gate does NOT verify (honest, E48)

- No image was built and no container was started (no daemon) — the
  Dockerfiles are correct-by-inspection against the workspace's package
  scripts until the owner's scratch-VM build exercises them.
- TLS issuance, the healthchecks' live behavior, the smoke run, and the
  S27-GAP-2 cgroup verification are deployment-host steps (the runbook).
