/**
 * S03 spike — supervision measurement harness. Runs the SAME scenario battery
 * against both variants (A: JSONL stdio child, B: loopback HTTP sidecar) and
 * writes raw results as JSON under results/.
 *
 * Scenarios (identical semantics per variant):
 *   1. lifecycle: cold start -> ready, cold TTFT, warm-session TTFT (second
 *      prompt on the live session), full stream completion.
 *   2. kill9-loss: kill -9 mid-stream -> crash-detection latency, in-flight
 *      token loss (stub emit log vs supervisor journal), restart latency,
 *      TTFT after restart, post-recovery completeness (no permanent loss).
 *   3. hang-detection: stub stops emitting AND heartbeating but stays alive ->
 *      heartbeat-watchdog detection window.
 *   4. backpressure: slow consumer (25ms/token vs 2ms/token producer) with a
 *      bounded queue (50) -> queue peak, pause/resume counts, source-side
 *      write-block evidence, and loss (must be 0).
 *
 * Run: node src/bench-supervision.ts [--iter N]
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { nowMs, parseArgs, sleep, stats, type Stats } from "./contract.ts";
import type { ExitInfo, SupervisionMetrics } from "./supervision-core.ts";
import { JsonlStdioSupervisor } from "./variant-a.ts";
import { HttpSidecarSupervisor } from "./variant-b.ts";

const SPIKE_DIR = import.meta.dirname;
const RESULTS_DIR = path.join(SPIKE_DIR, "..", "results");

type VariantName = "A:jsonl-stdio" | "B:http-sidecar";

type SupervisorLike = {
  start(): Promise<void>;
  prompt(text: string, fromSeq: number): Promise<void>;
  kill(signal: NodeJS.Signals): void;
  restart(): Promise<void>;
  stop(): Promise<void>;
  metrics: SupervisionMetrics;
};

type RunState = {
  journal: Set<number>;
  duplicates: number;
  journalLog: string;
  firstTokenAtMs: number | null;
  completedAtMs: number | null;
  lastSeq: number | null;
};

type CommonOpts = {
  tokens: number;
  tokenDelayMs: number;
  heartbeatMs: number;
  watchdogTimeoutMs: number;
  maxQueue: number;
  consumerDelayMs: number;
  hangAfterFirstToken: boolean;
  /** Pad stub token payloads to ~this many bytes (0 = short tokens). */
  tokenBytes: number;
  emitLog: string;
  sessionId: string;
};

function makeSupervisor(
  variant: VariantName,
  opts: CommonOpts,
  callbacks: {
    onToken: (token: { seq: number; text: string; recvAtMs: number }) => void | Promise<void>;
    onExit: (info: ExitInfo) => void;
    onHung: () => void;
    onCompleted: (lastSeq: number) => void;
  },
): SupervisorLike {
  if (variant === "A:jsonl-stdio") {
    return new JsonlStdioSupervisor(
      { ...opts, stubPath: path.join(SPIKE_DIR, "fake-pi-stdio.ts") },
      callbacks,
    );
  }
  return new HttpSidecarSupervisor(
    { ...opts, sidecarPath: path.join(SPIKE_DIR, "fake-pi-sidecar.ts") },
    callbacks,
  );
}

function freshState(dir: string): RunState {
  const journalLog = path.join(dir, "supervisor-journal.log");
  return {
    journal: new Set(),
    duplicates: 0,
    journalLog,
    firstTokenAtMs: null,
    completedAtMs: null,
    lastSeq: null,
  };
}

function callbacksFor(state: RunState) {
  return {
    onToken: (token: { seq: number; text: string; recvAtMs: number }): void => {
      if (state.journal.has(token.seq)) state.duplicates += 1;
      else state.journal.add(token.seq);
      appendFileSync(state.journalLog, `${JSON.stringify(token)}\n`);
      state.lastSeq = token.seq;
      if (state.firstTokenAtMs === null) state.firstTokenAtMs = token.recvAtMs;
    },
    onExit: (): void => {},
    onHung: (): void => {},
    onCompleted: (lastSeq: number): void => {
      state.completedAtMs = nowMs();
      state.lastSeq = lastSeq;
    },
  };
}

function ttftFrom(state: RunState, promptSentAtMs: number): number | null {
  return state.firstTokenAtMs === null ? null : round(state.firstTokenAtMs - promptSentAtMs);
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Read token seqs the stub actually emitted (its own synchronous log). */
function emittedTokenSeqs(emitLog: string): number[] {
  const text = readFileSync(emitLog, "utf8");
  const seqs: number[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { type?: string; seq?: number };
      if (msg.type === "token" && typeof msg.seq === "number") seqs.push(msg.seq);
    } catch {
      // partial trailing line after kill -9: ignore (never fully emitted)
    }
  }
  return seqs;
}

function readStubSummary(
  emitLog: string,
): { emitted_events: number; transport_write_false: number } | null {
  try {
    const text = readFileSync(emitLog, "utf8");
    const lines = text.trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return null;
    const msg = JSON.parse(last) as {
      type?: string;
      emitted_events?: number;
      transport_write_false?: number;
    };
    if (msg.type === "stub_summary") {
      return {
        emitted_events: msg.emitted_events ?? 0,
        transport_write_false: msg.transport_write_false ?? 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioLifecycle(
  variant: VariantName,
  dir: string,
  opts: CommonOpts,
): Promise<Record<string, number | null>> {
  const state = freshState(dir);
  const sup = makeSupervisor(variant, opts, callbacksFor(state));
  const startAt = nowMs();
  await sup.start();
  const readyMs = nowMs() - startAt;

  // Cold prompt: full 200-token stream.
  state.firstTokenAtMs = null;
  const coldPromptAt = nowMs();
  await sup.prompt("cold", 0);
  const coldStreamMs = nowMs() - coldPromptAt;
  const ttftColdMs = ttftFrom(state, coldPromptAt);

  // Warm prompt on the LIVE session: re-emit from 101 (session reuse, no respawn).
  state.firstTokenAtMs = null;
  const warmPromptAt = nowMs();
  await sup.prompt("warm", 100);
  const ttftWarmMs = ttftFrom(state, warmPromptAt);

  await sup.stop();
  return {
    readyMs: round(readyMs),
    ttftColdMs,
    ttftWarmMs,
    coldStreamMs: round(coldStreamMs),
  };
}

async function scenarioKill9(
  variant: VariantName,
  dir: string,
  opts: CommonOpts,
): Promise<Record<string, number | null>> {
  const state = freshState(dir);
  const exitInfo: { info: ExitInfo | null } = { info: null };
  const callbacks = callbacksFor(state);
  callbacks.onExit = (info) => {
    exitInfo.info = info;
  };
  const sup = makeSupervisor(variant, opts, callbacks);
  await sup.start();

  void sup.prompt("kill9", 0).catch(() => {}); // rejected by the kill
  // Kill once ~60 tokens are durably journaled.
  while (state.journal.size < 60) {
    await sleep(2);
  }
  const journaledAtKill = state.journal.size;
  sup.kill("SIGKILL");
  while (exitInfo.info === null) {
    await sleep(1);
  }
  const detectLatencyMs = exitInfo.info.detectLatencyMs;
  await sleep(150); // settle: let kernel-buffered bytes (variant B) flush
  const journaledAtDeath = state.journal.size;
  const emitted = emittedTokenSeqs(opts.emitLog);
  const lostTokens = emitted.filter((s) => !state.journal.has(s)).length;

  // Restart with the durable cursor and finish the stream (warm-session reuse).
  const restartAt = nowMs();
  await sup.restart();
  const restartReadyMs = nowMs() - restartAt;
  const fromSeq = Math.max(0, ...state.journal);
  state.firstTokenAtMs = null;
  const resumePromptAt = nowMs();
  await sup.prompt("resume", fromSeq);
  const ttftAfterRestartMs = ttftFrom(state, resumePromptAt);
  const resumeStreamMs = nowMs() - resumePromptAt;
  await sup.stop();

  return {
    detectLatencyMs: detectLatencyMs === null ? null : round(detectLatencyMs),
    emittedAtDeath: emitted.length,
    journaledAtKill,
    journaledAtDeath,
    lostTokens,
    restartReadyMs: round(restartReadyMs),
    ttftAfterRestartMs,
    resumeStreamMs: round(resumeStreamMs),
    finalDistinctTokens: state.journal.size,
    duplicateTokens: state.duplicates,
    partialLinesDropped: sup.metrics.droppedPartialLines,
    tokensMissingAfterRecovery: 200 - state.journal.size,
  };
}

async function scenarioHang(
  variant: VariantName,
  dir: string,
  opts: CommonOpts,
): Promise<Record<string, number | null>> {
  const state = freshState(dir);
  const hung = { at: 0 };
  const callbacks = callbacksFor(state);
  callbacks.onHung = () => {
    hung.at = nowMs();
  };
  const sup = makeSupervisor(variant, opts, callbacks);
  await sup.start();
  void sup.prompt("hang", 0).catch(() => {});
  // Wait until the watchdog fires (stub went silent after its first token).
  const deadline = nowMs() + 5000;
  while (hung.at === 0 && nowMs() < deadline) {
    await sleep(5);
  }
  const lastEventAt = sup.metrics.lastEventAtMs ?? hung.at;
  const detectionMs = hung.at === 0 ? null : round(hung.at - lastEventAt);
  // Process is still alive but silent: clean shutdown (escalation path).
  await sup.stop();
  return {
    hungDetectionMs: detectionMs,
    watchdogTimeoutMs: opts.watchdogTimeoutMs,
    tokensReceivedBeforeHang: state.journal.size,
    fired: hung.at === 0 ? 0 : 1,
  };
}

async function scenarioBackpressure(
  variant: VariantName,
  dir: string,
  opts: CommonOpts,
): Promise<Record<string, number | null>> {
  const state = freshState(dir);
  const sup = makeSupervisor(variant, opts, callbacksFor(state));
  await sup.start();
  const startAt = nowMs();
  await sup.prompt("slow-consumer", 0);
  const wallMs = nowMs() - startAt;
  await sup.stop();
  const summary = readStubSummary(opts.emitLog);
  return {
    wallMs: round(wallMs),
    queuePeak: sup.metrics.queuePeak,
    maxQueue: opts.maxQueue,
    pauseCount: sup.metrics.pauseCount,
    resumeCount: sup.metrics.resumeCount,
    sourceWriteFalse: summary?.transport_write_false ?? null,
    stubEmittedEvents: summary?.emitted_events ?? null,
    lossTokens: 200 - state.journal.size,
    duplicateTokens: state.duplicates,
  };
}

// ---------------------------------------------------------------------------
// Battery + reporting
// ---------------------------------------------------------------------------

type ScenarioResult = {
  scenario: string;
  iterations: Record<string, number | null>[];
  stats: Record<string, Stats>;
};

function summarize(scenario: string, iterations: Record<string, number | null>[]): ScenarioResult {
  const keys = Object.keys(iterations[0] ?? {});
  const s: Record<string, Stats> = {};
  for (const key of keys) {
    const values = iterations
      .map((it) => it[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    s[key] = stats(values);
  }
  return { scenario, iterations, stats: s };
}

function countLines(file: string): { total: number; code: number } {
  const text = readFileSync(file, "utf8");
  let code = 0;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("*/")) {
      continue;
    }
    code += 1;
  }
  return { total: text.split("\n").length, code };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ITER = Number(args["iter"] ?? 5);
  const BP_ITER = Number(args["iter-backpressure"] ?? 3);
  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");

  const baseOpts: CommonOpts = {
    tokens: 200,
    tokenDelayMs: 5,
    heartbeatMs: 100,
    watchdogTimeoutMs: 500,
    maxQueue: 50,
    consumerDelayMs: 0,
    hangAfterFirstToken: false,
    tokenBytes: 0,
    emitLog: "",
    sessionId: "spike-session",
  };

  const results: Record<string, ScenarioResult[]> = {};

  for (const variant of ["A:jsonl-stdio", "B:http-sidecar"] as const) {
    const variantDir = path.join(RESULTS_DIR, `run-${runStamp}`, variant.split(":")[0] ?? "x");
    mkdirSync(variantDir, { recursive: true });
    const scenarioResults: ScenarioResult[] = [];

    {
      const iterations: Record<string, number | null>[] = [];
      for (let i = 0; i < ITER; i++) {
        const dir = path.join(variantDir, `lifecycle-iter${i}`);
        mkdirSync(dir, { recursive: true });
        iterations.push(
          await scenarioLifecycle(variant, dir, {
            ...baseOpts,
            emitLog: path.join(dir, "stub-emit.log"),
          }),
        );
      }
      scenarioResults.push(summarize("lifecycle", iterations));
    }

    {
      const iterations: Record<string, number | null>[] = [];
      for (let i = 0; i < ITER; i++) {
        const dir = path.join(variantDir, `kill9-iter${i}`);
        mkdirSync(dir, { recursive: true });
        iterations.push(
          await scenarioKill9(variant, dir, {
            ...baseOpts,
            emitLog: path.join(dir, "stub-emit.log"),
          }),
        );
      }
      scenarioResults.push(summarize("kill9-loss-restart", iterations));
    }

    {
      const iterations: Record<string, number | null>[] = [];
      for (let i = 0; i < ITER; i++) {
        const dir = path.join(variantDir, `hang-iter${i}`);
        mkdirSync(dir, { recursive: true });
        iterations.push(
          await scenarioHang(variant, dir, {
            ...baseOpts,
            hangAfterFirstToken: true,
            emitLog: path.join(dir, "stub-emit.log"),
          }),
        );
      }
      scenarioResults.push(summarize("hang-detection", iterations));
    }

    {
      const iterations: Record<string, number | null>[] = [];
      for (let i = 0; i < BP_ITER; i++) {
        const dir = path.join(variantDir, `backpressure-iter${i}`);
        mkdirSync(dir, { recursive: true });
        iterations.push(
          await scenarioBackpressure(variant, dir, {
            ...baseOpts,
            tokenDelayMs: 2,
            consumerDelayMs: 25,
            // 1.6KB tokens: ~320KB total stream, enough to saturate the 64KB
            // OS pipe / socket buffers so write()===false is observed source-side.
            tokenBytes: 1600,
            emitLog: path.join(dir, "stub-emit.log"),
          }),
        );
      }
      scenarioResults.push(summarize("backpressure-slow-consumer", iterations));
    }

    results[variant] = scenarioResults;
  }

  const codeSize = {
    "supervision-core.ts (shared by both variants)": countLines(
      path.join(SPIKE_DIR, "supervision-core.ts"),
    ),
    "variant-a.ts (transport-specific, A)": countLines(path.join(SPIKE_DIR, "variant-a.ts")),
    "variant-b.ts (transport-specific, B)": countLines(path.join(SPIKE_DIR, "variant-b.ts")),
    "contract.ts (shared protocol types + JSONL framing)": countLines(
      path.join(SPIKE_DIR, "contract.ts"),
    ),
    "fake-pi-stdio.ts (stub host, A)": countLines(path.join(SPIKE_DIR, "fake-pi-stdio.ts")),
    "fake-pi-sidecar.ts (stub host, B)": countLines(path.join(SPIKE_DIR, "fake-pi-sidecar.ts")),
    note: "code = non-blank, non-comment lines; total = all lines",
  };

  const output = {
    run: runStamp,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    iterations: { timingScenarios: ITER, backpressure: BP_ITER },
    codeSize,
    results,
  };

  const outFile = path.join(RESULTS_DIR, `supervision-${runStamp}.json`);
  writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);

  for (const [variant, scenarioResults] of Object.entries(results)) {
    console.log(`\n=== ${variant} ===`);
    for (const sr of scenarioResults) {
      console.log(`\n${sr.scenario}:`);
      for (const [metric, s] of Object.entries(sr.stats)) {
        console.log(
          `  ${metric.padEnd(28)} median=${String(s.median).padStart(9)}  min=${String(s.min).padStart(9)}  max=${String(s.max).padStart(9)}  n=${s.n}`,
        );
      }
    }
  }
  console.log(`\nresults written: ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
