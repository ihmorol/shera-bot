/**
 * `resolvePgBin` portability tests (S10 review fix).
 *
 * The S05 harness hardcoded `/usr/lib/postgresql/16/bin`, so on Windows and
 * macOS every control-plane/integration suite failed to load with an opaque
 * `spawnSync ... initdb ENOENT`. These tests pin the resolution contract
 * without needing a real PostgreSQL install: `exists` is injected, so the
 * behavior is asserted on any host.
 */
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePgBin } from "./pg-cluster.ts";

/** Pretend `initdb` exists only under the given directories. */
function existsOnlyIn(...dirs: string[]): (path: string) => boolean {
  return (path: string) => dirs.includes(path);
}

describe("resolvePgBin", () => {
  // `join` is used throughout so these assertions are separator-correct on the
  // host OS: resolvePgBin probes `join(dir, "initdb")`, so a hardcoded "/" in the
  // test would not match on Windows.
  it("prefers the SHERA_PG_BIN override when it contains initdb", () => {
    const override = join("custom", "pg", "bin");
    expect(
      resolvePgBin(
        { SHERA_PG_BIN: override } as NodeJS.ProcessEnv,
        existsOnlyIn(join(override, "initdb")),
      ),
    ).toBe(override);
  });

  it("accepts a Windows-style override that only has initdb.exe", () => {
    // Regression for review finding F2: the override branch originally probed
    // only "initdb", so SHERA_PG_BIN could never work on Windows — the exact
    // platform this fix exists to support.
    const override = "D:\\tools\\pgsql\\bin";
    expect(
      resolvePgBin(
        { SHERA_PG_BIN: override } as NodeJS.ProcessEnv,
        existsOnlyIn(join(override, "initdb.exe")),
      ),
    ).toBe(override);
  });

  it("falls back to a conventional install directory when the override is stale", () => {
    const winDir = "C:\\Program Files\\PostgreSQL\\16\\bin";
    // The override points at a directory with no initdb; a real install wins.
    expect(
      resolvePgBin(
        { SHERA_PG_BIN: join("nope", "bin"), PATH: "" } as NodeJS.ProcessEnv,
        existsOnlyIn(join(winDir, "initdb.exe")),
      ),
    ).toBe(winDir);
  });

  it("finds initdb on PATH when no conventional directory matches", () => {
    const pathDir = join("opt", "tools", "pg");
    expect(
      resolvePgBin(
        { PATH: [join("usr", "bin"), pathDir].join(delimiter) } as NodeJS.ProcessEnv,
        (p) => p === join(pathDir, "initdb"),
      ),
    ).toBe(pathDir);
  });

  it("throws an actionable configuration error naming every probed path (G4)", () => {
    let message = "";
    try {
      resolvePgBin(
        { SHERA_PG_BIN: join("nope"), PATH: join("usr", "bin") } as NodeJS.ProcessEnv,
        () => false,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    // Not an opaque ENOENT: it names the env var, the fix, and what was probed.
    expect(message).toContain("SHERA_PG_BIN");
    expect(message).toContain("initdb");
    expect(message).toContain("Probed");
    expect(message).toContain("PATH entries: 1 checked");
  });
});
