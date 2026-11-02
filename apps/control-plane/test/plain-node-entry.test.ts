/**
 * The direct-TS run-path pin (S32 fix round, review P0).
 *
 * The control plane's documented start path is `node src/main.ts` — plain
 * node with default strip-only TypeScript mode. Strip-only mode REJECTS
 * transform-only syntax (constructor parameter properties, `enum`), so any
 * module in the app's import closure that uses it breaks the documented
 * start path with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at boot. The S32 review
 * found exactly that reintroduced in three statically-imported admin
 * modules after the bin fix (64b4586) made the start path matter; this pin
 * makes the whole-entry closure load a TESTED invariant, not a one-off fix.
 *
 * The CLI bin leg (the AC1 callable proof) lives in admin-cli.test.ts.
 */
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { runPlainNodeImport } from "./helpers/cli-bin.ts";

const APP_ENTRY = pathToFileURL(resolve(import.meta.dirname, "../src/index.ts")).href;
const CLI_ENTRY = pathToFileURL(resolve(import.meta.dirname, "../src/cli/shera-admin.ts")).href;

describe("the direct-TS run paths load under plain node (strip-only mode)", () => {
  it("imports the app entry (the documented `node src/main.ts` closure)", () => {
    const result = runPlainNodeImport(APP_ENTRY);
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
  });

  it("imports the CLI entry (the bin field's target)", () => {
    const result = runPlainNodeImport(CLI_ENTRY);
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.status).toBe(0);
  });
});
