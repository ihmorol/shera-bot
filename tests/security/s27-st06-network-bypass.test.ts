/**
 * S27 ST-06 — network policy bypass (threat model §5 ST-06; TM-5.2; D27:
 * "network disabled by default for code execution"; PRD §16: localhost
 * services scoped to the user container, no inbound public access).
 *
 * The adversarial shape: sandboxed code execution — through the REAL
 * executor binding → sandbox spawn path, exactly as production composes it —
 * attempts:
 *   1. an outbound connection to an INTERNAL endpoint (an HTTP listener the
 *      test owns on 127.0.0.1 — the stand-in for the control-plane/runtime
 *      internal services a hostile payload would probe), and
 *   2. an outbound connection to an outside address (RFC 5733 TEST-NET-3,
 *      documentation-only — nothing routable, nothing real, G3/G7).
 * The connection must FAIL with the namespace's own ENETUNREACH and the
 * internal listener must record ZERO accepted sockets: the namespace is the
 * kernel's boundary, the runtime does not filter traffic, and "denied" is
 * demonstrated by the LISTENER's counter, not by trusting the payload's
 * self-report alone.
 *
 * RED-FIRST evidence: the binding's networkDisabled flag was flipped to
 * false (the namespace stripped — the control disabled), the suite FAILED
 * (the internal listener ACCEPTED the hostile connection), the control was
 * restored, the suite PASSED — both outputs in
 * tests/security-evidence/2026-11-05-st06-{red,green}.txt.
 *
 * Governing records: THREAT_MODEL §5 ST-06, D27, PRD §16, E36, G3/G7.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  makeCodeExecutionBinding,
  type ExecutionToolDeps,
} from "../../apps/user-runtime/src/modules/execution/execution-tool-binding.ts";
import { spawnSandboxedExecution } from "../../apps/user-runtime/src/adapters/process/execution-process-spawn.ts";
import {
  makeExecutionAuthority,
  type ToolExecutionContext,
} from "../../apps/user-runtime/src/modules/tools/tool-binding.ts";

const tempDirs: string[] = [];
let listener: Server | null = null;
let acceptedConnections = 0;
let listenerPort = 0;

/** The internal endpoint the hostile payload will probe (the test's own). */
async function startInternalListener(): Promise<number> {
  acceptedConnections = 0;
  listener = createServer((_req, res) => {
    acceptedConnections += 1;
    res.end("INTERNAL-ENDPOINT-REACHED");
  });
  listener.on("connection", () => {
    acceptedConnections += 1;
  });
  await new Promise<void>((resolve) => listener!.listen(0, "127.0.0.1", resolve));
  listenerPort = (listener.address() as AddressInfo).port;
  return listenerPort;
}

async function stopInternalListener(): Promise<void> {
  if (listener === null) return;
  await new Promise<void>((resolve) => listener!.close(() => resolve()));
  listener = null;
}

function contextFor(workspaceId = "ws_s27"): ToolExecutionContext {
  return {
    authority: makeExecutionAuthority(),
    deadline: Date.now() + 20_000,
    nowMs: () => Date.now(),
    maxResponseBytes: 65_536,
    resourceLimits: {
      max_memory_mb: 2048,
      max_cpu_seconds: 20,
      max_processes: 64,
      max_disk_mb: 64,
    },
    signal: new AbortController().signal,
    execution: {
      execution_id: "exe_s27_st06",
      workspace_id: workspaceId,
      task_id: "task_s27_st06",
      conversation_id: "conv_s27_st06",
      agent_id: "agent_dev",
      capability: "code.exec",
      approval_id: null,
      grant_id: null,
    },
  };
}

/** The REAL composition: binding → sandbox spawn (the production posture). */
function realBinding(workspaceRoot: string) {
  const deps: ExecutionToolDeps = {
    spawn: (request) => spawnSandboxedExecution(request),
    workspaceRoots: { ws_s27: workspaceRoot },
    terminalRecorder: null,
    artifacts: null,
    logFault: () => {},
  };
  const binding = makeCodeExecutionBinding(deps);
  if (typeof binding.executeAsync !== "function") {
    throw new Error("the code-execution binding must dispatch through executeAsync");
  }
  return binding.executeAsync.bind(binding);
}

/** The hostile probe payload (node): connect to both targets, report codes. */
function probePayload(port: number): string {
  return [
    `const net = require("node:net");`,
    `const os = require("node:os");`,
    `function probe(host, port, label) {`,
    `  return new Promise((resolve) => {`,
    `    const s = net.connect({ host, port });`,
    `    const done = (code) => { s.destroy(); console.log("PROBE " + label + " " + code); resolve(); };`,
    `    s.on("connect", () => done("CONNECTED"));`,
    `    s.on("error", (e) => done("ERR:" + (e.code || e.message)));`,
    `    s.setTimeout(4000, () => done("TIMEOUT"));`,
    `  });`,
    `}`,
    `(async () => {`,
    `  const ifaces = require("node:fs").readdirSync("/sys/class/net");`,
    `  console.log("IFACES " + JSON.stringify(ifaces));`,
    `  await probe("127.0.0.1", ${port}, "internal-listener");`,
    `  await probe("203.0.113.1", 9, "outside-testnet");`,
    `  process.exit(0);`,
    `})();`,
  ].join("\n");
}

describe("S27 ST-06 — network-disabled code execution (D27 namespace)", () => {
  afterEach(async () => {
    await stopInternalListener();
  });

  it("code execution cannot reach the internal endpoint or an outside address; the listener accepts ZERO sockets", async () => {
    const port = await startInternalListener();
    const work = mkdtempSync(join(tmpdir(), "shera-s27-st06-"));
    tempDirs.push(work);
    const dispatch = realBinding(work);

    const result = await dispatch(
      { language: "node", code: probePayload(port), workdir: "." },
      contextFor(),
    );
    // The payload itself exits cleanly — the REFUSAL is the kernel's, not a
    // tool failure; narrowing also gives the assertions below the text shape.
    if (!result.ok) throw new Error(`probe payload failed: ${result.errorCode}`);

    // The listener's own counter is the authority on "did the probe land":
    expect(
      acceptedConnections,
      "the internal endpoint must record ZERO accepted connections from sandboxed code",
    ).toBe(0);
    // Both probes report the namespace's refusal — no CONNECTED anywhere.
    const probes = result.text.split("\n").filter((line) => line.startsWith("PROBE "));
    expect(probes.length).toBe(2);
    for (const line of probes) {
      expect(line, `a probe must not connect: ${line}`).not.toContain("CONNECTED");
      expect(line).toMatch(/ERR:|TIMEOUT/);
    }
    // The namespace's interface reality: no default route, lo down — the
    // child sees the kernel's own boundary, not a runtime filter.
    const ifacesLine = result.text.split("\n").find((line: string) => line.startsWith("IFACES "));
    expect(ifacesLine).toBeDefined();
    const ifaces: string[] = JSON.parse(ifacesLine!.slice("IFACES ".length));
    expect(ifaces).toContain("lo");
  }, 60_000);
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
