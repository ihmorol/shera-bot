import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

const repoRoot = "/home/emon-morol/projects/github-cloud-projects/shera-bot-s20";
const dir = mkdtempSync(join(tmpdir(), "probe-s22-"));
const { composeRuntime, DEFAULT_WORKSPACE_ID } = await import(
  join(repoRoot, "apps/user-runtime/src/transport/local-api/compose.ts")
);
const WS = DEFAULT_WORKSPACE_ID;
const runtime = composeRuntime({
  dbPath: join(dir, "runtime.db"),
  workspaceId: WS,
  packsRoot: resolve(repoRoot, "agent-packs"),
  now: () => "2026-10-31T12:00:00.000Z",
  workerHarness: {
    file: process.execPath,
    args: [join(repoRoot, "apps/user-runtime/src/modules/workers/fake-task-worker-child.ts"),
      "--run-id", "{run_id}", "--worker-id", "{worker_id}",
      "--heartbeat-ms", "{heartbeat_interval_ms}", "--steps", "900", "--step-delay-ms", "60"],
  },
});
await new Promise((r) => runtime.httpServer.listen(0, "127.0.0.1", r));
const runtimePort = runtime.httpServer.address().port;
console.log("runtime", runtimePort);

const control = createServer((req, res) => {
  void (async () => {
    console.log("stub hit:", req.url);
    if (req.url === "/api/session") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ workspace_id: WS, google_sub: "capture-user", email: "c@e.com", display_name: "E", tier: "balanced", is_admin: false, created_at: "2026-10-01T00:00:00Z", last_active_at: "2026-10-01T00:00:00Z" }));
      return;
    }
    if (req.url === "/api/runtime/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ runtime_handle: `rt_${"0".repeat(32)}`, account_id: "capture-user", tier: "balanced", provisioning_status: "running", health: "healthy", resource_summary: { tier: "balanced", cpu_vcpus: 4, memory_bytes: 8589934592, storage_bytes: 107374182400 }, checked_at: "2026-10-31T12:00:00.000Z" }));
      return;
    }
    if (!req.url?.startsWith("/api/runtime/local/")) { res.writeHead(404); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(`http://127.0.0.1:${runtimePort}` + req.url.slice("/api/runtime/local".length), { method: req.method, headers: { "content-type": "application/json" }, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    res.end(await upstream.text());
  })().catch((e) => { console.log("stub error", String(e)); res.writeHead(500); res.end(); });
});
await new Promise((r) => control.listen(0, "127.0.0.1", r));
const controlPort = control.address().port;

const webOrigin = "http://127.0.0.1:4321";
const next = spawn(process.execPath, [join(repoRoot, "apps/web/node_modules/next/dist/bin/next"), "dev", "--port", "4321"], {
  cwd: join(repoRoot, "apps/web"),
  env: { ...process.env, CONTROL_PLANE_URL: `http://127.0.0.1:${controlPort}`, SHERA_WEB_ORIGIN: webOrigin, BROWSER: "none" },
  stdio: ["ignore", "pipe", "pipe"],
});
let nextLog = "";
next.stdout.on("data", (d) => (nextLog += d.toString()));
next.stderr.on("data", (d) => (nextLog += d.toString()));
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { if ((await fetch(webOrigin + "/login", { signal: AbortSignal.timeout(4000) })).ok) break; } catch {}
}
console.log("web ready");
for (const path of ["/api/control/api/session", "/api/control/api/runtime/status"]) {
  const started = Date.now();
  try {
    const response = await fetch(webOrigin + path, { signal: AbortSignal.timeout(30000) });
    console.log(path, "->", response.status, "in", Date.now() - started, "ms");
  } catch (error) {
    console.log(path, "FAILED in", Date.now() - started, "ms:", String(error?.cause ?? error).slice(0, 120));
  }
}
console.log("[next tail]", nextLog.slice(-800));
next.kill(); control.close(); await runtime.close(); rmSync(dir, { recursive: true, force: true });
process.exit(0);
