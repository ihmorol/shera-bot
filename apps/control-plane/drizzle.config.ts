import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config (D24): generate committed SQL migrations only —
 * `pnpm db:generate` in apps/control-plane. Schema push is deliberately not
 * configured anywhere in this repository.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
