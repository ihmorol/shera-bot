# S27 threat coverage — the inventory→test matrix

**Status:** the S27 deliverable's spine (issue #28). Every row of the threat
model's register (`docs/THREAT_MODEL.md` §4, TM-1.1…TM-5.6) and every item of
its security test list (§5, ST-01…ST-14) maps to exactly one of:

- **AUTOMATED** — a Vitest suite under `tests/security/`, proven to bite:
  red-without-control (the control temporarily disabled, the test FAILING) and
  green-with (restored, PASSING), both outputs recorded under
  `tests/security-evidence/<date>-<st-id>-{red,green}.txt` and committed.
- **PINNED-ELSEWHERE** — an existing automated suite in this repo already
  exercises the threat's control; S27 references it instead of duplicating it
  (the standing instruction: the boundary guards and contract suites are the
  static layer; S27 is the dynamic layer).
- **PROCEDURE** — documented manual procedure with exact commands and expected
  results (the second-container legs the recorded Docker-unusable reality
  reserves for the owner; the P9 item).
- **GAP** — a real, reproducible gap found while building this suite, recorded
  in `tests/security/SECURITY-GAPS.md` with its reproducer and suggested issue
  text (G5: never silenced, never downgraded). No committed test claims a
  control exists where it does not.

Governing records: the threat model §5 (the S27 contract), D27, D6, D9, D35,
D38, D22, D23 rule 4, D39, E12, E36, G2–G7, AC21. Redaction vocabulary and the
test-list payload shapes follow the threat model §6 exactly (placeholders, no
real secret values — G3).

## 1. The ST list (threat model §5) → S27 verification

| ID | Hostile input (threat model §5) | Control that must stop it | S27 verification | Status |
|---|---|---|---|---|
| ST-01 | Path traversal + symlink escape (`<workspace>/../../../../<outside>` styled; planted symlink to outside) | D27: paths resolved and checked before every file operation; working directory fixed to scope | AUTOMATED — `s27-st01-path-traversal.test.ts`: traversal/absolute/symlink workdirs refused with nothing created outside (filesystem sentinels); planted file + directory symlinks refused; symlinked scope root pins to its real location; the row-based file store refuses raw, percent-encoded (`%2e%2e`, `%2F`, `%5C`, `%00`) and malformed-escape URIs and materializes nothing. Red/green: `2026-11-05-st01-{red,green}.txt` (policy-layer checks disabled for red; URI-parser segment checks disabled for the store leg) | AUTOMATED (green) |
| ST-02 | Workspace boundary escape (another task's worktree / another Agent's private folder / unassigned project path) | D27 + D6 (task-scoped leases) + D39 (private folders) + E12 (workspace_id on every table) | AUTOMATED — `s27-st02-workspace-boundary.test.ts`: Agent B's read/write/list/delete against Agent A's private folder are all `PRIVATE_SCOPE_DENIED` before any row is touched; refused writes leave A's content byte-identical; the same URI in two workspaces is two independent trees (write in A invisible from B); an execution task in workspace A cannot reach workspace B's execution scope (`SANDBOX_PATH_ESCAPE`). Red/green: `2026-11-05-st02-{red,green}.txt` (the scope guard disabled for red) | AUTOMATED (green) |
| ST-03 | Env-var secret exposure to children (`printenv`, `process.env`, `/proc/self/environ` hunting `<provider-key-reference>`) | D27 + D22/E9: child env is a fixed allowlist; runtime env never consulted | AUTOMATED — `s27-st03-env-secret-exposure.test.ts`: a synthetic provider secret planted in the RUNTIME's `process.env`; the payload prints its whole environment and reads `/proc/self/environ` through the REAL executor→binding→sandbox path; the secret appears nowhere in the capture, the terminal rows, the tool history, or the database bytes. Red/green: env allowlist bypassed for red | AUTOMATED (green) |
| ST-04 | Process-tree escape (detached grandchild survives cancellation or sheds limits) | D27 + D14: the whole child process tree terminated on cancellation; limits inherited | AUTOMATED (same-group leg) — `s27-st04-process-tree-escape.test.ts`: a payload that keeps forking group descendants + holds stdio; the run is cancelled; every group member is dead on the live process list and the exit is the typed cancellation. Red/green: the group-kill disabled for red. **The setsid/detached-GRANDCHILD leg is a confirmed GAP (S27-GAP-1): a `detached: true` grandchild sheds the process group and SURVIVES cancellation on this box (no PID namespace; the cgroup sweep dead — S27-GAP-2). Reproducer + issue text in SECURITY-GAPS.md; no committed test claims that control.** | AUTOMATED (same-group green) + GAP (grandchild leg) |
| ST-05 | Resource exhaustion (fork bomb, allocation loop, disk-fill, wall-clock-defying) | D27 (CPU/memory/process/disk/wall-clock) + E1 admission control | AUTOMATED — `s27-st05-resource-exhaustion.test.ts`: fork storm refuses at the kernel process cap (typed, bounded count on the live list); disk-fill loop dies SIGXFSZ (`SANDBOX_LIMIT_EXCEEDED`, file capped); infinite loop dies at the wall clock (`wall_clock` limit death, group dead); memory hog contained (RLIMIT_DATA refusal; the cgroup layer is GAP-2 — recorded, not faked). Red/green: limits stripped (all nulls) for red where a deterministic red is possible (disk + wall clock) | AUTOMATED (green) |
| ST-06 | Network policy bypass (code exec reaching the network / internal endpoints) | D27: network disabled by default for code execution; capability-based for research/browser | AUTOMATED — `s27-st06-network-bypass.test.ts`: through the REAL executor path, code execution connecting to an internal HTTP listener the test owns (the B5 "internal endpoint" shape) and to an outside address receives ENETUNREACH; the listener records ZERO connections; the namespace's loopback is DOWN (route-table probe from the child). Red/green: the namespace stripped (`networkDisabled: false`) for red — the listener IS reached | AUTOMATED (green) |
| ST-07 | Credential leakage in stdout/stderr and logs | D14 (stderr redacted before logging) + D22/D23 rule 4 | AUTOMATED — `s27-st07-credential-leakage.test.ts`: fixtures (fake provider client echoing an `Authorization` header, Git remote URL with embedded credential, env-dump lines) streamed through the S18 TerminalRecorder and the S26 execution output boundary; the persisted terminal rows, fault logs, and history summaries carry `[REDACTED]` and never the raw synthetic values; a whole-database byte scan finds none. Red/green: redaction replaced by identity for red | AUTOMATED (green) |
| ST-08 | Agent-created tool privilege escalation (declares `DEPLOYMENT`/`CREDENTIAL_ACCESS` or hidden effects; activates/runs without grant) | PRD §7/E4 + D38 + D35 | AUTOMATED — `s27-st08-tool-escalation.test.ts`: creation declaring a capability outside PLATFORM_TOOL_CATALOG ∩ pack allow-list refused (`TOOL_CAPABILITY_NOT_ALLOWED`, the refusing layer named); agent self-activation refused (`ACTIVATION_REQUIRES_RUNTIME_GRANT`); execution un-activated refused (`TOOL_NOT_ACTIVATED`); private tool run by another Agent refused (`TOOL_NOT_SHARED`); every path routes through the executor — no bypass execution occurred (sentinel untouched). Red/green: the D38 subset check bypassed for red; the executor's activation gate bypassed for red | AUTOMATED (green) |
| ST-09 | Cross-task lease violation (concurrent writes, expired lease, foreign lease) | D6 (task-scoped write leases; conflicts queue — never silent overwrite) | AUTOMATED — `s27-st09-lease-violation.test.ts`: task B's write over task A's leased path is `WRITE_LEASE_REQUIRED` naming the foreign holder; content byte-identical afterwards (no silent overwrite); a write to a path whose lease was taken for a DIFFERENT path refused; an expired lease authorizes nothing (the holder's own post-expiry write needs re-acquisition; the new acquirer wins). Red/green: the lease gate bypassed for red (silent overwrite demonstrated, then refused again) | AUTOMATED (green) |
| ST-10 | Cross-user container access (B's data/processes/gateway from A) | PRD §16 + D1/D27/E12 | AUTOMATED (composed leg) — `s27-st10-cross-user.test.ts`: two real accounts composed as two workspaces over two runtime stores; B's session against A's workspace is `RUNTIME_TENANT_MISMATCH` (the web proxy's `runtimeWorkspaceMatches` binding, adversarial shapes: query-only, body-mismatched, encoded); A's runtime store never resolves B's rows; provider credentials of A invisible to B's runtime bytes. PROCEDURE — the second-container leg (port-scan the compose network, mount B's volumes, call B's gateway): `docs` §4 below, exact commands + expected results (the owner's P9 item; Docker unusable on the building box per E22–E36) | AUTOMATED (composed green) + PROCEDURE (container leg) |
| ST-11 | Indirect injection → ungranted tool call (fetched page says "write this file and run publish") | D4/D11/G2 + D38 + D35 | AUTOMATED — `s27-st11-injection-ungranted-tool.test.ts`: the hostile page is DATA in the proposal summary; the resulting typed proposals are refused on TYPED grounds: unknown tool `TOOL_NOT_REGISTERED`; gated tool without grant pauses (`paused_for_approval`) with a zero-side-effect sentinel untouched and nothing executed pre-decision; the runtime reads risk from the resolved DEFINITION, never the injected capability string. Red/green: the executor's gating bypassed for red (the injected mutation executes un-gated) | AUTOMATED (green) |
| ST-12 | Direct injection → self-approval / grant creation | D9 + D35 + G6 | AUTOMATED — `s27-st12-self-approval.test.ts`: the proposing Agent's decision on its own pending approval refused (`AGENT_CANNOT_SELF_APPROVE`); any Agent-actor decision refused (`AGENT_CANNOT_DECIDE_APPROVAL`); the request stays pending, no grant row exists, no execution occurred; grant creation through the only runtime path behind the actor refusals; approval decisions immutable events. Red/green: the actor refusal bypassed for red (a grant appears with an Agent creator) | AUTOMATED (green) |
| ST-13 | Oversized payload / flood | D11 (bounded payloads) + D15 (context budget) + PRD §7 (timeouts, response-size limits) | AUTOMATED — `s27-st13-oversized-flood.test.ts`: a tool result over the tool's own `max_response_bytes` is the typed `TOOL_RESPONSE_TOO_LARGE` with nothing oversized persisted; a child streaming far beyond the forward cap fires the truncation marker, the capture and the history stay capped (byte counts asserted); a hostile oversized argument string is bounded in the summary surfaces. Red/green: the response-budget check bypassed for red | AUTOMATED (green) |
| ST-14 | Redaction sweep (all five secret classes through logs/events/errors/tool history) | §6 redaction rules (G3, D22, D23 rule 4, D14, D5/D26, D37) | AUTOMATED — `s27-st14-redaction-sweep.test.ts`: the five threat-model fixture classes (`<provider-key-reference>`, `<repository-credential-reference>`, `<browser-cookie-reference>`, `<oauth-token-reference>`, `<url-with-embedded-secret>` — synthetic values, G3) driven through fault logs, the error taxonomy (`internal_details` never crosses; `safe_message` clean), tool history, and terminal rows; a whole-database + log byte scan finds zero raw fixtures. Red/green: redaction identity-bypassed for red | AUTOMATED (green) |

## 2. The TM register (threat model §4) → coverage roll-up

Register rows are covered through the ST list they name; this table is the
per-row roll-up (no row skipped — G5).

| TM row | Level | Covered by | Notes |
|---|---|---|---|
| TM-1.1 direct injection | L1 | ST-11, ST-12; D34 task-detection suites (PINNED-ELSEWHERE: `tests/contract`/`tests/integration` typed-trigger suites) | Refusal is typed, never model behavior (G2) |
| TM-1.2 indirect injection | L1 | ST-11 | Runtime-side containment (typed proposals + ladder) tested; the OPEN-1 untrusted-content marking question stays open in the threat model, not silently answered here |
| TM-1.3 injection seeking grants | L1 | ST-12 | |
| TM-1.4 cross-context contamination | L1 | ST-02 (workspace scoping, E12), ST-10; D37 memory-scope suites PINNED-ELSEWHERE (AC27 test) | |
| TM-1.5 system-prompt leakage | L2 | OPEN-2 in the threat model — no recorded control; nothing to test without inventing one (G5). Recorded here as NOT covered, on purpose | |
| TM-2.1 oversized inputs | L1 | ST-13; the D15 context-compiler budget suites PINNED-ELSEWHERE where they exist | |
| TM-2.2 container resource exhaustion | L1 | ST-05 (+ S26's `execution-sandbox-limits.test.ts` PINNED-ELSEWHERE for the CPU/cgroup legs) | cgroup layer: GAP-2 |
| TM-2.3 denial of wallet | L1 | D48 reservation-failure + D20 ledger suites PINNED-ELSEWHERE (`credit-ledger-*` tests); S27 adds no duplicate | |
| TM-2.4 retry amplification | L1 | S22 retry-policy suites PINNED-ELSEWHERE (bounded backoff, provider-failure release) | |
| TM-3.1 secrets into model/persisted surfaces | L1 | ST-03, ST-07, ST-14; D22/E9 custody suites PINNED-ELSEWHERE | |
| TM-3.2 child-process output leakage | L1 | ST-07 | |
| TM-3.3 cross-user disclosure | L1 | ST-02, ST-10 | |
| TM-3.4 error-message disclosure | L1 | ST-14 (the error-taxonomy leg); D23 contract suites PINNED-ELSEWHERE | |
| TM-3.5 agent-private memory leak | L1 | D37 AC27 suites PINNED-ELSEWHERE; ST-02 covers the folder half | |
| TM-3.6 URLs/headers with embedded secrets | L1 | ST-07, ST-14 | |
| TM-4.1 tool call without capability/grant | L1 | ST-11, ST-08; D35 matrix suites PINNED-ELSEWHERE | |
| TM-4.2 self-approval / prompt-created permissions | L1 | ST-12 | |
| TM-4.3 child-task permission widening | L1 | D34 delegation + D9 grant-contract suites PINNED-ELSEWHERE (S13/S20); S27 exercises the same refusal surface through ST-12 | |
| TM-4.4 agent-created tool escalation | L1 | ST-08 | |
| TM-4.5 pack-driven widening | L1 | D18/D28 pack-manifest validation suites PINNED-ELSEWHERE (pack loader + `agent-pack-sdk`); ST-08 pins the runtime-side D38 intersection | |
| TM-4.6 unapproved external write | L1 | ST-11 (the ladder legs); D35 risk-matrix suites PINNED-ELSEWHERE | |
| TM-4.7 silent repository mutation | L1 | E6 worktree/merge-approval suites PINNED-ELSEWHERE (S19); out of S27's dynamic scope — reference, not duplicate | |
| TM-4.8 roster manipulation | L2 | D36 roster-validation suites PINNED-ELSEWHERE (S13/S14) | |
| TM-4.9 unsafe autonomous work | L1 | E5 watcher-dedup + E13 recovery-class suites PINNED-ELSEWHERE (S28/S31); OPEN-5 (webhook sender auth) stays open | |
| TM-5.1 host/container escape | L1 | ST-01 (path discipline), ST-04 (tree termination), ST-06 (network), boundary-guards PINNED-ELSEWHERE (static layer); the raw-filesystem leg of sandboxed children is D27's own recorded residual ("explicitly not a hardened microVM") — compose deployment (S35) owns mount isolation; covered by the ST-10 second-container PROCEDURE | |
| TM-5.2 cross-container access | L1 | ST-06 (internal-endpoint probes from tool code), ST-10 | |
| TM-5.3 channel impersonation | L2 | S06 provisioning + D12 backend-contract suites PINNED-ELSEWHERE; OPEN-3 mechanics stay open | |
| TM-5.4 conflicting browser control | L2 | OPEN-4 — mechanism unrecorded; nothing to test without inventing one (G5) | |
| TM-5.5 task-state/event-journal forgery | L1 | D8 transition suites + D26 replay suites + D10/D25 (no direct SQL, unknown fields rejected) PINNED-ELSEWHERE; boundary-guards enforce the SQL boundary statically | |
| TM-5.6 credential exposure via backups | L2 | E11 restore-drill suites PINNED-ELSEWHERE; OPEN-6 stays open; the ST-14 sweep habit (byte-scan persisted artifacts) is the S27-side discipline | |

## 3. The red/green evidence index

Every AUTOMATED row above was proven to bite the recorded way. Evidence files
(command output, dated) under `tests/security-evidence/`:

| Family | Red (control disabled — test FAILS) | Green (control restored — test PASSES) |
|---|---|---|
| ST-01 path traversal/symlink | `2026-11-05-st01-red.txt` | `2026-11-05-st01-green.txt` |
| ST-02 workspace boundary | `2026-11-05-st02-red.txt` | `2026-11-05-st02-green.txt` |
| ST-03 env secrets | `2026-11-05-st03-red.txt` | `2026-11-05-st03-green.txt` |
| ST-04 process-tree escape | `2026-11-05-st04-red.txt` | `2026-11-05-st04-green.txt` |
| ST-05 resource exhaustion | `2026-11-05-st05-red.txt` | `2026-11-05-st05-green.txt` |
| ST-06 network bypass | `2026-11-05-st06-red.txt` | `2026-11-05-st06-green.txt` |
| ST-07 credential leakage | `2026-11-05-st07-red.txt` | `2026-11-05-st07-green.txt` |
| ST-08 tool escalation | `2026-11-05-st08-red.txt` | `2026-11-05-st08-green.txt` |
| ST-09 lease violation | `2026-11-05-st09-red.txt` | `2026-11-05-st09-green.txt` |
| ST-10 cross-user | `2026-11-05-st10-red.txt` | `2026-11-05-st10-green.txt` |
| ST-11 injection → ungranted tool | `2026-11-05-st11-red.txt` | `2026-11-05-st11-green.txt` |
| ST-12 self-approval | `2026-11-05-st12-red.txt` | `2026-11-05-st12-green.txt` |
| ST-13 oversized/flood | `2026-11-05-st13-red.txt` | `2026-11-05-st13-green.txt` |
| ST-14 redaction sweep | `2026-11-05-st14-red.txt` | `2026-11-05-st14-green.txt` |

Each red file records the exact control-bypass diff applied (reverted before
commit — `git status` clean of it) and the failing suite output; each green
file records the restored-control passing output. The suite is deterministic
and provider-free (G7): no live provider is contacted by any S27 suite; the
ST-06 network legs run inside the namespace (no packet leaves the box) and
against a listener the test itself owns.

## 4. The documented manual procedure — the second-container legs (ST-10 container half; the owner's P9 item)

Docker is unusable on the building machine (socket root-owned; recorded
E22–E36 reality), so the container-level isolation leg is a documented
procedure for an environment where the compose deployment runs (S35). Record
the results in the run log; every step has a pass/fail observable.

```bash
# 0. Preconditions: the compose stack up with TWO user containers
#    (docker compose ps shows both; this is the S35 deployment).

# 1. Discover the compose network + the two containers' addresses.
docker network ls                      # note the compose network name
docker inspect <container-a> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'
docker inspect <container-b> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'

# 2. From INSIDE container A: probe container B (the TM-5.2 hostile probe).
docker exec <container-a> sh -c 'command -v nc || apt-get install -y --no-install-recommends netcat-openbsd'
docker exec <container-a> nc -zv -w2 <ip-b> 8080   # B's local-api port
#   EXPECTED (pass): refused/timeout — B's gateway answers nothing from A's
#   container. FAIL: "succeeded!" — a real cross-container reachability gap.

# 3. From INSIDE container A: attempt B's gateway API unauthenticated.
docker exec <container-a> sh -c 'wget -qO- --timeout=2 http://<ip-b>:8080/v1/workspace/leases || echo REFUSED'
#   EXPECTED (pass): REFUSED (connection failed, not a JSON answer).

# 4. Attempt to read B's volume from A.
docker exec <container-a> sh -c 'ls /var/lib/shera-volumes/user-b 2>&1 || true'
#   EXPECTED (pass): the path does not exist inside A (volumes are per-container).

# 5. Host-side negative control (the probe WOULD work from the host — proves
#    step 2's refusal is the isolation, not a dead service):
docker exec <container-b> wget -qO- http://127.0.0.1:8080/v1/health || true
#   EXPECTED: a health answer INSIDE B (the service is up; A simply cannot reach it).
```

Pass criterion: steps 2–4 all refuse while step 5 answers. Any "succeeded"
in steps 2–4 is a filed gap (the procedure records it; it never silences it).

## 5. CI-vs-scheduled decision

Recorded in Chunk 5 (`docs/decisions/` E43 record): which critical cases stay
in the default suite vs a documented scheduled job, with the reasoning.
Placeholder resolved there — see the E43 record.
