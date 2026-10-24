import { createServer } from "node:http";
import express from "express";
import { expect, it, vi } from "vitest";
import { createErrorHandler } from "../src/index.ts";

it("returns a typed safe error when a route throws", async () => {
  const app = express();
  app.get("/failure", () => {
    throw new Error("private-failure-sentinel");
  });
  const logger = { error: vi.fn() };
  app.use(createErrorHandler(logger));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const reply = await fetch(`http://127.0.0.1:${address.port}/failure`);
    expect(reply.status).toBe(500);
    const body = await reply.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.internal_details).toBeNull();
    expect(JSON.stringify(body)).not.toContain("private-failure-sentinel");
    expect(logger.error).toHaveBeenCalledOnce();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
