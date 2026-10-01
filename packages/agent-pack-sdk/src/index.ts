/**
 * @shera-bot/agent-pack-sdk — pack manifest schema and loader (S10).
 *
 * S10 chunk 1 fills the SDK proper: the Zod pack-manifest schema with its
 * rejection rules (D18, D28, D46), the loader interface with the
 * BuiltInPackLoader, integrity verification, and runtime compatibility checks
 * (D28). The workspace pins one pack version; tasks snapshot the version that
 * created them (D19, D28, PRD AC22).
 *
 * Zod-first (D25): every exported type is inferred from its Zod schema. The
 * SDK is intentionally dependency-light (zod only) so a pack author's
 * toolchain never pulls the full runtime contract surface; the loader layer
 * bridges manifest values into @shera-bot/contracts at runtime.
 */
export * from "./primitives.ts";
