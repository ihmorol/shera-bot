# Infra

Deployment and runtime infrastructure. Empty in S01 — **no Docker or Compose in this
slice**. The first content is Phase 1 container provisioning (**S06**, and the local
development stack that slice needs), and the prototype deployment itself (**S35**:
Compose on one Ubuntu 24.04 VM, runbooks, smoke tests, monitoring).

Guardrails that apply to everything committed here: secrets never appear in Compose
files, images, logs, or docs (**G3**); the container is the isolation boundary — no host
Docker socket, no host filesystem, network-disabled execution by default (PRD §16).
