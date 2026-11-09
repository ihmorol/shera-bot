#!/bin/sh
# The post-deploy smoke test (S35; the slice's smoke-test script — committed
# and idempotent, run after ANY deploy per the runbook).
#
# What it AUTOMATES (pure HTTP probes — creates no state, safe to re-run):
#   1. the web app answers through the edge (the E43 smoke-workflow posture)
#   2. the web → control-plane same-origin proxy chain is alive
#      (/api/control/healthz → the control plane's typed /healthz, whose
#      body also reports the auth-configured state — the boot-response
#      monitoring shape)
#   3. the unauthenticated runtime surface answers TYPED (the session probe
#      is refused, never faked — G4)
#   4. build identity: the running images' revision labels match the checked
#      out GIT_SHA on the VM
#
# What it does NOT automate (honest boundary, never faked):
#   - LOGIN (Google OAuth), send-message, artifact, approval, and
#     refresh-replay need an authenticated browser session. Those legs are
#     the S34 acceptance harness (the committed 27/27 browser matrix — the
#     runbook names the exact command to point it at a deployment) plus the
#     owner's manual walk. This script prints the pointers; it does NOT
#     pretend the interaction path ran (G4).
#
# Usage (on the VM, from infra/deploy/):  ./smoke.sh [PUBLIC_URL]
#   PUBLIC_URL defaults to \$PUBLIC_URL from the environment (the filled
#   .env), else http://127.0.0.1 (the scratch edge).

set -u

URL="${1:-${PUBLIC_URL:-http://127.0.0.1}}"
FAILURES=0

say()  { echo "smoke: $1"; }
pass() { echo "smoke PASS: $1"; }
fail() { echo "smoke FAIL: $1"; FAILURES=$((FAILURES + 1)); }

http_code() {
  # curl's -w prints 000 itself when the transfer fails — no fallback echo
  # (the old `|| echo 000` double-printed: 000000, the cosmetic review nit).
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null
}

say "probing ${URL}"

# 1. The web app through the edge.
CODE="$(http_code "${URL}/login")"
if [ "${CODE}" = "200" ]; then pass "web /login answers 200 through the edge";
else fail "web /login answered ${CODE} (expected 200)"; fi

# 2. The proxy chain: the web's same-origin /api/control/* → control plane.
BODY="$(curl -sf --max-time 10 "${URL}/api/control/healthz" 2>/dev/null)" || BODY=""
case "${BODY}" in
  *'"status":"ok"'*) pass "the control plane answers healthz through the web proxy (${BODY})";;
  "") fail "the /api/control/healthz proxy returned nothing (the web → control-plane chain is down)";;
  *) fail "the /api/control/healthz proxy answered an unexpected body: ${BODY}";;
esac

# 3. The unauthenticated session surface is REFUSED, typed — never a fake
#    login (G4). Any 4xx (401/403) is the honest shape; a 200 here would be
#    a control failure.
CODE="$(http_code "${URL}/api/control/api/session")"
case "${CODE}" in
  401|403) pass "the unauthenticated session probe is refused (${CODE}) — the auth gate is alive";;
  200) fail "the unauthenticated session probe returned 200 — the auth gate is NOT enforced";;
  *) fail "the unauthenticated session probe answered ${CODE} (expected 401/403)";;
esac

# 4. Build identity (the issue's criterion): the running images' revision
#    labels match the DEPLOYMENT'S CONFIGURED GIT_SHA — resolved in this
#    order: the GIT_SHA environment reference, else the .env value next to
#    this script, else (last resort) the checkout's HEAD. The configured
#    value wins because a healthy ROLLED-BACK deployment runs the PREVIOUS
#    image while the checkout stays on the merge commit — the gate must
#    validate the deployment's identity, never fail a healthy rollback on
#    its own checkout (the F4 review finding; the runbook's §5.2 edits
#    .env's GIT_SHA to the previous SHA and this leg agrees).
if command -v docker >/dev/null 2>&1; then
  EXPECTED_SHA="${GIT_SHA:-}"
  if [ -z "${EXPECTED_SHA}" ]; then
    ENV_FILE="${SMOKE_ENV:-$(cd "$(dirname "$0")" && pwd)/.env}"
    if [ -f "${ENV_FILE}" ]; then
      EXPECTED_SHA="$(sed -n 's/^GIT_SHA=//p' "${ENV_FILE}" | head -1 | tr -d '\"' | tr -d '[:space:]')"
    fi
  fi
  if [ -z "${EXPECTED_SHA}" ]; then
    EXPECTED_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
    [ -n "${EXPECTED_SHA}" ] && EXPECTED_SOURCE="the checked-out HEAD (last resort — no configured GIT_SHA found)"
  else
    EXPECTED_SOURCE="the configured GIT_SHA"
  fi
  RUNNING="$(docker ps --format '{{.Image}}' 2>/dev/null)" || RUNNING=""
  if [ -z "${RUNNING}" ]; then
    say "skipped the build-identity leg: no running containers on this host (the leg runs ON the VM)"
  elif [ -z "${EXPECTED_SHA}" ]; then
    say "skipped the build-identity leg: no configured GIT_SHA and not a git checkout (the runbook pins GIT_SHA at build time)"
  else
    LABELS="$(docker ps --filter label=org.opencontainers.image.revision --format '{{.Image}} {{.Label "org.opencontainers.image.revision"}}' 2>/dev/null)" || LABELS=""
    if [ -z "${LABELS}" ]; then
      fail "running containers exist but none carries the revision label (built without GIT_SHA?)"
    elif printf '%s\n' "${LABELS}" | grep -q "${EXPECTED_SHA}"; then
      pass "the running images' revision labels match ${EXPECTED_SOURCE} (${EXPECTED_SHA})"
    else
      fail "the running images' revision labels do not match ${EXPECTED_SOURCE} ${EXPECTED_SHA}: ${LABELS}"
    fi
  fi
else
  say "skipped the build-identity leg: no engine CLI on this host (run it ON the VM)"
fi

# The interaction-path pointers (honest, G4 — never claimed as run).
cat <<'NEXT'

smoke: the automated legs are done. The interaction legs of the issue's
smoke list (login, send message, artifact, approval, refresh-replay) run
through the committed S34 acceptance harness against the deployment (the
runbook's exact command) and the owner's manual walk — this script does not
pretend they ran.
NEXT

if [ "${FAILURES}" -gt 0 ]; then
  echo "smoke: ${FAILURES} failure(s) — the deployment is NOT verified"
  exit 1
fi
echo "smoke: all automated legs passed"
