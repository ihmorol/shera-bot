# S09 E2E demo path — the General Assistant live conversation (E8 mock mode)

**Status:** Recorded 2026-10-01 (S09 chunk 3). This is the demo path the slice's
executable acceptance actually drives, step by step, with evidence. The
browser-level walkthrough is listed but **not yet browser-verified** — the E2E
test drives the identical client/proxy/runtime stack headlessly (Node 24,
no browser). The orchestrator performs the browser verification before the PR.

**Automation:** `apps/web/test/e2e/mock-runtime-e2e.test.ts`
(`pnpm exec vitest run apps/web/test/e2e/mock-runtime-e2e.test.ts`, commit
`0780ba3`). Runtime stack: the E8 mock runtime (real SQLite, real HTTP, real
WebSocket gateway, scripted reply streamer), the web app's real `/api/runtime`
proxy, and the web app's real typed client + wire client + live reducer.

## What the demo shows

- One idempotent typed command per send; a turn is durable journal truth.
- Reply streaming is transient presentation; the durable message renders once.
- A hard refresh renders exactly what persisted — nothing invented (G4/E10).
- Reconnect replays missed events as the marked replayed batch (§6.2/§6.4).

## The path (as verified by the E2E test)

1. **Login (honest state).** The sign-in surface renders with its visibly
   disabled provider button — OAuth is a later slice, no fake success. The
   prototype session is the fixture user **Emon**; sends are attributed to
   them. *(Browser step pending — asserted via static markup in the E2E.)*
2. **Prepare the workspace.** The General Assistant chat resolves its
   conversation through the idempotent `conversation.create` seed key
   (`s09-ga-direct-chat-seed-v1`); calling it again replays the receipt and
   returns the SAME conversation id. *(Verified.)*
3. **Connect.** The tab opens the WebSocket, subscribes to
   `conversation:<id>`, and requests a replay from its acknowledged cursor
   (0) — history renders as live-class, no batch marker. *(Verified.)*
4. **Send.** The composer dispatches the optimistic copy keyed by
   `msg-<uuid>`, then `message.send` over
   `POST /api/runtime/v1/conversations/commands` through the proxy. The
   durable user event fans out live and reconciles the optimistic copy —
   exactly one message. **Measured ack: 21–41 ms across three E2E runs
   (target ≈500 ms, §6.3).** *(Verified.)*
5. **Stream.** The scripted reply emits transient `message.delta` frames
   (never journaled) rendered as the streaming bubble; the durable agent
   message then lands through the same command path and the bubble clears —
   the reply is visible exactly once, and the streamed text matches the
   journaled message verbatim. No `task.*` events exist (G2/D34). *(Verified.)*
6. **Hard refresh mid-stream.** The tab reloads: fresh state, fresh socket,
   replay from cursor 0. The durable prefix renders (user turn + committed
   replies); the in-flight optimistic copy and unpersisted deltas leave no
   trace and nothing is fabricated in their place. *(Verified.)*
7. **Reconnect replay.** With the tab offline, a turn commits elsewhere (the
   E2E sends it through the same typed client). On reconnect the tab requests
   the replay from its acknowledged cursor and the missed events render as
   the replayed batch closed by the "N missed events replayed" marker; the
   cursor is acknowledged only after render. *(Verified.)*
8. **Recovery backstop.** `kill -9` mid-reply-stream, restart on the same
   SQLite file: the journal holds exactly the committed prefix, the receipt
   still replays, and no content is invented
   (`apps/user-runtime/test/recovery/kill9-recovery.test.ts`). *(Verified.)*

## Browser-verification checklist (before the PR)

- [ ] Start the mock runtime (`RUNTIME_E2E_MOCK=1 node --experimental-transform-types apps/user-runtime/src/mock/mock-runtime-main.ts` with `RUNTIME_DB_PATH`, `RUNTIME_PORT`) and point the web app's `RUNTIME_LOCAL_API_URL` + `NEXT_PUBLIC_RUNTIME_WS_URL` at it.
- [ ] Steps 1–7 in a real browser, including a hard reload (Cmd/Ctrl+Shift+R) while the reply is streaming and the disconnected/reconnecting banner copy (§6.4).
- [ ] Confirm the measured send-ack feels immediate in the browser UI.
