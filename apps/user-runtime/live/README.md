# Live provider check (opt-in only, G7)

`providers-live.test.ts` makes ONE real, minimal model request through the
runtime's own adapter seam to verify a provider configuration against a REAL
endpoint. It is **never** part of `pnpm test` or CI — the default vitest
include patterns cannot reach this directory, and the suite skips itself
unless the owner's environment is present.

## Run it (owner only)

```sh
# from the repo root, with the owner's key in the environment
SHERA_LIVE_PROVIDER_PROTOCOL=openai \
SHERA_LIVE_PROVIDER_MODEL=gpt-4o-mini \
SHERA_LIVE_PROVIDER_API_KEY=sk-... \
node_modules/.bin/vitest run apps/user-runtime/live/providers-live.test.ts
```

- `SHERA_LIVE_PROVIDER_PROTOCOL` — one of `openai`, `anthropic`, `google`,
  `ollama`, `openai-compatible` (required).
- `SHERA_LIVE_PROVIDER_MODEL` — the model identifier to test (required).
- `SHERA_LIVE_PROVIDER_API_KEY` — the owner's key (required for `api_key`
  mode; omit for a no-key endpoint).
- `SHERA_LIVE_PROVIDER_BASE_URL` — required for `ollama` and
  `openai-compatible`; the native protocols refuse a base URL by design.
- `SHERA_LIVE_PROVIDER_ORGANIZATION` / `SHERA_LIVE_PROVIDER_PROJECT` —
  optional OpenAI organization/project.

The suite asserts the honest typed union — success with the checked model and
latency, or a typed, redacted failure (`PROVIDER_CONNECTION_TEST_*`). It never
prints the key, never logs provider response bodies, and persists nothing.
