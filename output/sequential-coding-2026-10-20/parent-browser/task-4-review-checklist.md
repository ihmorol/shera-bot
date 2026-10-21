# Parent Task 4 verification checklist

- Read final diff and every changed caller/config/export/fixture. Check no unrelated data or source is lost.
- Actual application parser handles valid, malformed and oversized bodies with session binding and safe errors; B19 regression must exercise actual factory wiring.
- Trusted public origin handles Next internal URL differences and rejects foreign origins; B20 requires actual built-site browser send.
- Browser URL stays same-origin and contains no internal endpoint, channel bearer or query credential.
- Exact allowed upgrade target, Origin and session must be checked before selecting the account runtime. Handshake parsing must not throw.
- Initial session validation follows existing Auth.js authority. Disabled/deleted/expired sessions and real successful signout close streams; failed revalidation closes safely; logs omit token-bearing database error text.
- Managed runtime rejects foreign workspace for subscriptions and replay, including room joins; standalone supported tests retain behavior.
- Both proxy legs forward upgrade head and bidirectional frames. Pending/authenticated sockets close on disconnect/error/timeout/shutdown and credential revocation; rejected/upstream bodies cannot leak secrets.
- Parent independently runs meaningful targeted tests, complete real-PostgreSQL suite, source lint/format/type checks and production build as appropriate to final diff.
- Parent browser drives send, authoritative frame, refresh exactly once, reconnect/replay. Record provider absence and simulated engine; do not call this real OAuth or model execution.
- Review PASS must bind to the exact integrated full commit SHA in ledger. Only then assign Task 5.
