/**
 * The runtime's own version (S10; D28 checkCompatibility seam). The pack
 * loader checks every loaded pack's `runtime_compatibility` range against
 * this constant at startup — a pack built for another runtime line fails
 * with a typed error before it can influence any task (G4: honest
 * configuration failure, never a silent mismatch).
 *
 * Kept in sync with apps/user-runtime/package.json `version` by a test
 * (version.test.ts) rather than by an import: package.json is not part of
 * the exported module surface, and the test fails loudly on drift.
 */
export const RUNTIME_VERSION = "0.0.0";
