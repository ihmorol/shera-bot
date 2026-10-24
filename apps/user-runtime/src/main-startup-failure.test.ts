import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

const closeRuntime = vi.hoisted(() => vi.fn());

vi.mock("./transport/local-api/compose.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport/local-api/compose.ts")>();
  return {
    ...actual,
    composeRuntime: (...args: Parameters<typeof actual.composeRuntime>) => {
      const runtime = actual.composeRuntime(...args);
      const close = runtime.close.bind(runtime);
      runtime.close = async () => {
        closeRuntime();
        await close();
      };
      return runtime;
    },
  };
});

import { startRuntimeNode } from "./main.ts";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("runtime startup failure", () => {
  it("closes the composed runtime when the local listener cannot bind", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("test listener did not bind");

    const dir = mkdtempSync(join(tmpdir(), "shera-runtime-bind-failure-"));
    tempDirs.push(dir);
    try {
      await expect(
        startRuntimeNode({
          host: "127.0.0.1",
          port: address.port,
          dbPath: join(dir, "runtime.db"),
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(closeRuntime).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) =>
        blocker.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
