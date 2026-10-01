/**
 * Shared primitives for the pack SDK (S10).
 *
 * These mirror the S02 contract primitives (packages/contracts/src/primitives.ts)
 * one-for-one: the SDK is intentionally dependency-light (zod only) so a pack
 * author's toolchain never pulls the full runtime contract surface. The loader
 * layer bridges manifest values into the shared contracts at runtime.
 *
 * Governing records: D18 (versioned declarative packs), D25 (Zod-first,
 * strict unknown-field discipline), D28 (packs are data and configuration).
 */
import { z } from "zod";

/** Stable opaque identifiers (D2). */
export const Id = z.string().min(1).max(256);
export type Id = z.infer<typeof Id>;

/** MAJOR.MINOR.PATCH version string for packs, operations, skills, tools (D18, D28). */
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/, "expected MAJOR.MINOR.PATCH");
export type SemVer = z.infer<typeof SemVer>;

/** SHA-256 hex digest over the canonical manifest JSON (D28). */
export const Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected a 64-char lowercase sha256 hex digest");
export type Sha256Hex = z.infer<typeof Sha256Hex>;
