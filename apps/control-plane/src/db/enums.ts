/**
 * Shared PostgreSQL enum definitions (D24: one definition per DDL object).
 * Values mirror the S02 contract vocabulary (`ResourceTier` in
 * packages/contracts) without importing transport contracts into the schema.
 */
import { pgEnum } from "drizzle-orm/pg-core";

/** PRD §3.3 simulated resource tiers; balanced is the prototype default. */
export const resourceTierEnum = pgEnum("resource_tier", ["light", "balanced", "heavy"]);

/**
 * PRD §15: administrators enable/disable accounts. A disabled account still
 * consumes one of the five signup slots.
 */
export const signupStateEnum = pgEnum("signup_state", ["active", "disabled"]);
