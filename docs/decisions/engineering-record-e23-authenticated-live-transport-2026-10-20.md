# E23: Authenticated same-origin live transport

- ID: E23
- Status: Delegated engineering, pending owner review; local verification in progress
- Date: 2026-10-20
- Exact evidence source: current Codex chat, owner instruction: "Delegate sub-agents one by one. Delegate one complete its task, then you check it, review it, merge it, and then after complete delegate another and step by step complete the coding part." Continuation: "continue from where you left off, also call the failed agents to continue there work from where they left off as well." Parent evidence is under `output/sequential-coding-2026-10-20/parent-browser/`; executor evidence is under `task-4/`.
- Authority: PRD section 24 engineering delegation, implementing D1, D2, D11, D12, D16, D22 and E12.
- Supersession: no product decision is superseded. This completes E22's deferred authenticated Socket.IO integration; its earlier evidence remains historical. PRD text and acceptance statuses are unchanged.
- Affected PRD sections: 3.3, 4.2, 6, 14, 16, 17 and 19.

## Decision and rationale

The browser uses the website origin and a fixed Engine.IO websocket route. Next forwards that route to the configured control plane, which validates the trusted public Origin and the existing Auth.js database session before selecting the account's runtime. The management channel receives a server-held bearer and forwards only the fixed Socket.IO handshake to the loopback gateway. Managed subscriptions and replay independently reject another workspace. No browser chooses a runtime endpoint or receives the channel credential.

Streams close at session expiry and after successful Auth.js session deletion. A bounded database check also detects direct session revocation and disabled accounts. Validation failures close the stream; errors must not log database parameter text containing a session token. Both proxy legs close pending and active peers on failure and shutdown. Credential changes invalidate affected live management connections.

The real command path also needs bounded JSON parsing in the control-plane runtime router. A focused proxy fixture had installed a parser that the actual application lacked, causing valid commands to fail its workspace check. Browser POST origin validation uses the trusted public origin rather than Next's internal request URL, which can use localhost behind a public hostname.

## Alternatives considered

- Browser-configured internal websocket URLs were rejected because they expose topology and bypass account routing.
- A custom Next server was rejected because the installed Next server already proxies external rewrites for upgrades.
- Authentication only at connection start was rejected because signout, direct revocation and account disable must terminate ongoing access.
- Trusting arbitrary browser Host or forwarded headers for the public origin was rejected; the deployment config supplies the allowed origin.
- Relying on the web JSON parser was rejected because the control plane remains an independent trust boundary.
- Replacing the existing Socket.IO/replay client was rejected; the durable journal and existing protocol are reused.

## Ownership and implementation boundary

Coding agent owns the implementation; parent agent owns independent review and integration; maintainer owns release acceptance. Web owns same-origin URL construction, rewrite and POST-origin validation. Control plane owns Auth.js validation, account selection and session lifetime. Managed runtime owns channel authentication, workspace enforcement and local gateway forwarding. Existing acceptance criteria gain test evidence only; no new acceptance criterion is introduced.

`SHERA_WEB_ORIGIN` must be set to the public website origin on both web and control-plane services. `CONTROL_PLANE_URL` is server-only. Next external rewrites are generated during its production build, so the intended control-plane address must be supplied at build time as well as for runtime HTTP forwarding. Deployment must preserve websocket upgrades and the browser Origin through its TLS edge.

## Verification and limits

Parent browser assertions pass through the built website, real PostgreSQL session validation, managed runtime and SQLite: message persistence/live delivery, one copy after refresh, a new replay acknowledgement after reconnect, and real CSRF-protected Auth.js signout followed by zero open streams and session HTTP401. Responsive observations cover 360, 768 and 1440 pixels. The account/session is seeded in a disposable database and container lifecycle is simulated. This is not real Google login, Docker replacement or a model response.

Final full-suite, source checks and exact integration commit are recorded in the sequential ledger after review. Until that record exists, this record is not a claim of completed integration. Remaining product slices, providers, Pi/Hermes, Docker, real OAuth and full website acceptance remain open. B21, a separately reproduced stale settings editor after reset, is queued as the next sequential repair.
