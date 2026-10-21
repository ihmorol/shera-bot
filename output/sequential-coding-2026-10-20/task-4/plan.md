# Task 4 plan: authenticated same-origin live transport

Baseline: `bc8efbbd04a7e5791938b437b3942b59433cad68` on `dev/complete-prototype`.

## Scope and callers

- Web callers: `agent-direct-chat-surface.tsx` and `general-assistant-surface.tsx` will use one shared hook that derives the Engine.IO websocket URL from `window.location`. `NEXT_PUBLIC_RUNTIME_WS_URL` is removed from the managed browser path.
- Web routing: `next.config.ts` will place an external `beforeFiles` rewrite at `/api/runtime/live`, using server-only `CONTROL_PLANE_URL`. The browser sees only its own origin and the fixed Engine.IO websocket path/query.
- Control plane: the real Node HTTP server will attach a bounded upgrade handler beside Express. It will accept only `/api/runtime/live?EIO=4&transport=websocket`, require the configured website origin, validate the real Auth.js database session, derive account/workspace/runtime target server-side, and proxy frames to the runtime management listener with the server-held channel bearer.
- Session lifecycle: live sockets will be indexed by a digest of the Auth.js session token. The official Auth.js adapter's successful `deleteSession` path will close that session's sockets; an expiry timer plus bounded database-session/account revalidation will close streams after expiry, direct session deletion, or account disable. The pre-signout audit handler will not authorize disconnection.
- Runtime management: the authenticated management listener will accept only the fixed `/internal/v1/live` upgrade, verify the channel bearer, and proxy raw websocket bytes to the already-bound loopback Socket.IO server. Browser cookies, authorization headers, internal endpoints, and channel credentials will not cross to the local runtime or browser.
- Runtime gateway: managed composition will bind subscriptions and replay requests to its one account-derived workspace. Standalone composition keeps the existing multi-workspace test seam.
- Tests and fixtures: add focused raw-upgrade integration coverage for authentication, origin, fixed path/query, account routing, frame/head forwarding, signout/expiry/direct-revocation cleanup, management credential refusal, upstream failure, shutdown, and managed workspace refusal. Existing Socket.IO and standalone replay tests remain unchanged.
- Configuration/docs touched only where required: control-plane env typing/example for the trusted web origin and web rewrite behavior. No PRD, decision, schema, acceptance-status, dependency, or vocabulary changes.

## Security checks

- Reject absent/foreign `Origin`; do not trust browser-selected runtime endpoint, workspace, bearer, forwarded authorization, or query credentials.
- Authenticate with Auth.js before runtime lookup. Derive `workspace_id` as `ws_<session account id>` and enforce it again inside the managed runtime for both `stream.subscribe` and `replay.request`.
- Forward only RFC6455/Engine.IO handshake headers required by the fixed path. Never log or serialize cookies, session tokens, channel credentials, or internal runtime endpoints.
- Bound both proxy handshake legs with timeouts; close both sides on error, shutdown, signout, expiry, account disable, or direct session deletion. Forward both upgrade `head` buffers before bidirectional piping.
- Validate the internally stored management endpoint as `http:` or `https:` with no credentials or fragment before connecting.

## Verification order

1. Add red focused tests for the runtime managed-workspace gate and management upgrade proxy.
2. Implement runtime enforcement/proxy; run runtime websocket, management, startup and recovery tests.
3. Add red control-plane upgrade tests using real Auth.js/PostgreSQL fixtures and a local authenticated upstream; implement upgrade/session lifecycle wiring.
4. Add web URL/rewrite caller tests; implement the same-origin hook and rewrite.
5. Run focused transport integration tests with real frames and replay, then source lint/format/type checks.
6. Notify the parent, run the full Vitest suite with the verified PostgreSQL binary, then run the production Next build in the cleared build slot.
7. Record exact commands, results, changed files, known limits, and manual-transport evidence in this task directory. Do not stage, commit, push, or deploy.
