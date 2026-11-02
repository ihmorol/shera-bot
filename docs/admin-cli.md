# The shera-admin CLI (S32)

Operational reference for the admin CLI shipped by S32 (issue #33; D47,
PRD §15). Authority stays with [`PRD.md`](PRD.md) and the decision records;
this document is implementation documentation subordinate to them. The
engineering record for the slice is
[`decisions/engineering-record-e38-s32-admin-api-cli-2026-11-02.md`](decisions/engineering-record-e38-s32-admin-api-cli-2026-11-02.md).

The console UI is production-gated (D47); the admin CLI plus the admin API are
the private prototype's operator surface. Every operational command maps 1:1
onto an authenticated admin-API endpoint, so the CLI and the API share the
audit trail (AC6: every admin action is recorded as a security event) and the
same typed error vocabulary.

## Invocation

From the repository root (Node >= 24; no build step — the entry is run
directly through Node's TypeScript stripping, the same direct-TS posture as
the control plane's own `start` script):

```
node apps/control-plane/src/cli/shera-admin.ts <command> [args]
```

The `bin` field in `apps/control-plane/package.json` declares the same entry
(`shera-admin`) for packaging completeness. Note that pnpm exposes a
workspace package's own bin only to its dependents — nothing depends on the
control plane in this prototype — so no `node_modules/.bin/shera-admin` shim
exists in the workspace; the direct `node` invocation above is the working
path. If a future change reintroduces TypeScript transform-only syntax into
the CLI's import closure (constructor parameter properties, `enum`),
`node --experimental-transform-types` is the fallback (the posture the
user-runtime `start` script already uses).

## Credentials and their sources

Two different commands touch two different authorities:

- **`token` commands are LOCAL operator operations** against the control
  plane's PostgreSQL. They require `DATABASE_URL` (the control plane's own
  database) and never call the API.
- **Every other command is an authenticated API call** and needs:

  | What | Where it comes from |
  |---|---|
  | Control plane origin | `--url <origin>` flag or `SHERA_CONTROL_PLANE_URL` |
  | Admin token | `--token-file <path>` flag or `SHERA_ADMIN_TOKEN` |

There is deliberately **no argv flag for the token value** — argv is visible
in `ps` and shell history (G3). The token is read from the environment or
from a file, used in the `Authorization: Bearer` header, and never printed,
logged, or echoed in errors.

**Plaintext origins are refused off loopback.** The bearer token must not
cross the network in cleartext: a `--url`/`SHERA_CONTROL_PLANE_URL` whose
scheme is `http:` is refused (exit 2) unless the host is loopback
(`localhost`, `127.0.0.1`, `::1`) for local development. The production
control plane presents a **CA-trusted TLS certificate** — point `--url` at
its `https://` origin; a self-signed deployment needs the operator's trust
store configured (Node's `NODE_EXTRA_CA_CERTS`) rather than a plaintext
downgrade.

The admin token is **DB-managed** (AC7): the control plane's PostgreSQL owns
the `is_admin` flag and the token table. There is **no route anywhere in the
API that writes `is_admin`** — operator bootstrap happens locally on the
control-plane host with database authority, exactly the `token create`
command below.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Typed API/local failure — the control plane's typed error (`code` + `safe_message`) is printed to stderr; **local-authority failures are also 1** (a missing `DATABASE_URL` for the token commands — the local DB authority is absent, the command line itself is fine) |
| `2` | Usage error — the command line itself is wrong (unknown command, missing argument, invalid `--amount`, missing URL/token, a refused plaintext origin) |

## Token lifecycle (`token` — local, exactly-once display)

- `token create` — creates the active admin token (revokes any previous
  one). The raw token is printed **once, alone on stdout**; guidance goes to
  stderr. It is stored ONLY as its SHA-256 digest (hash-only storage, G3)
  and cannot be recovered or displayed again. Capture it immediately.
- `token rotate` — mints a new active token (printed once, same rules); the
  previous token stops verifying immediately (AC5).
- `token show` — the active token's NON-SECRET identity only: the digest
  hint (first 12 hex chars of the digest), creation/last-use/revocation
  timestamps. Never the token material.

## Command reference

All operational commands accept the global flags `--url <origin>` and
`--token-file <path>` either before the command (program level) or after it
(per-command). `<account_id>` is the account UUID as listed by `users list`.

| Command | Syntax | Effect |
|---|---|---|
| users list | `users list` | List the accounts (identity, tier, signup state, container status) |
| users disable | `users disable <account_id>` | Disable an account; its sessions are revoked immediately (AC3) |
| users enable | `users enable <account_id>` | Re-enable an account (the user signs in again) |
| users tier | `users tier <account_id> <light\|balanced\|heavy>` | Assign the simulated resource tier (PRD §3.2; applies at next provisioning) |
| container provision | `container provision <account_id>` | Provision the user's runtime (idempotent) |
| container restart | `container restart <account_id>` | Bring the user's runtime to running (idempotent) |
| container stop | `container stop <account_id>` | Stop the user's runtime (idempotent; already-stopped is a truthful success) |
| container status | `container status <account_id>` | The runtime status — backend truth, synced to the record |
| container usage | `container usage <account_id>` | The usage view: applied tier limits + bounded health summary |
| backups trigger | `backups trigger <account_id>` | Trigger a backup — recorded as `requested`; the S33 mechanism executes it |
| backups list | `backups list <account_id>` | List the account's recorded backups |
| backups restore | `backups restore <account_id> <snapshot_ref>` | Request the restore of one recorded snapshot — S33 performs the restore |
| emergency-cancel | `emergency-cancel <account_id>` | Emergency-cancel ALL work for ONE user (AC4) |
| failures | `failures <account_id>` | Recent container and task failures for one user |
| credits top-up | `credits top-up <account_id> --amount <n> [--reason <text>]` | Top up credits (D48 unblocking path); `--amount` must be a positive integer |

Command groups also document themselves: `node
apps/control-plane/src/cli/shera-admin.ts --help` and `<group> --help`.

## Honest seams (what the CLI does NOT pretend)

- **Backups are REQUESTED, not executed.** The S32 surface records the
  trigger and the restore request (the S33 seam shape); the mechanism that
  actually produces a snapshot or restores one is S33's. Responses carry the
  `requested` status honestly — a backup trigger never claims a completed
  snapshot (G4).
- **Container commands degrade to recorded truth on an engine-less host.**
  Where no container engine or runtime is reachable, the commands answer the
  control plane's typed errors (`RUNTIME_PROVISION_FAILED`,
  `RUNTIME_UNAVAILABLE`, `RUNTIME_NOT_PROVISIONED`) or the RECORDED state
  last synced over the channel. The CLI never invents live metrics — the
  usage view reads the applied tier limits and the bounded health summary,
  never fabricated numbers (G4).
- **Credit top-ups are a durable grant plus the recorded resume path.** The
  grant is a durable central record (`control_credit_topups`); the resume is
  applied by the runtime through the recorded D8 `resume_task` row
  (PAUSED → QUEUED, admin actor). Runs paused for a reason other than
  `insufficient_credits` are reported back as typed skips
  (`pause_reason_not_insufficient_credits`), never silently claimed resumed.
  The S24 credit ledger is not built yet; the grant record is the seam it
  will consume (pinned in E38).
- **Emergency cancel is scoped and borrowed, not reinvented.** The command
  drives the runtime's OWN S22 `RunCancellationService` over the recorded
  internal channel for exactly one account (AC4): the target user's RUNNING
  and QUEUED work stops; other users' work is untouched. If the runtime is
  unreachable the typed `RUNTIME_UNAVAILABLE` is surfaced — no partial
  success is reported.

## Security posture (pinned by the redaction test)

- The raw token appears in output exactly once — the single create/rotate
  display the owner captures.
- No output line (stdout or stderr) on ANY other path contains the token:
  not on typed API errors, not on 401 rejection, not in usage text.
- Token verification failures are recorded as `admin_auth_rejected` security
  events WITHOUT the presented value (G3).
- Every operational command is recorded as an `admin_action` /
  `admin_action_failed` security event with the acting token's id, target
  account, and details scrubbed through the secret registry (AC6).
- Errors from the CLI are the control plane's typed error codes and safe
  messages only. Where a non-JSON failure body must be surfaced, the CLI
  prints a bounded (300-character) fallback — never the raw response with
  possible secrets, never the presented credential.
