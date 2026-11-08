#!/usr/bin/env node
/**
 * The S34 criteria runner — ONE command that executes the automated rows of
 * the acceptance ledger (tests/acceptance/ledger.json) and emits the
 * machine-readable report the ledger cites.
 *
 *   pnpm acceptance
 *
 * Architecture follows the recorded E43 tiering (embedded as shera-bot code,
 * never imported):
 *
 *   Tier 1 (offline deterministic): every ledger row's `vitest` entries run
 *   as ONE batched `vitest run` invocation over the real suites — slice
 *   suites stay where they are; the runner INVOKEs them per the ledger and
 *   never re-implements a criterion.
 *
 *   Tier 2 (browser matrix): every row's `browser-matrix` entries run through
 *   Playwright Test (tests/acceptance/browser/) on the §18 browser projects
 *   that are actually obtainable in this environment. A browser binary that
 *   cannot be obtained is recorded NOT-VERIFIED with its reason — never a
 *   fake pass, never a silent skip.
 *
 *   Tier 3 (opt-in live): rows flagged `liveOptIn` are NEVER executed here.
 *   They are listed as OPT-IN in the report (G7 — live-provider legs are
 *   opt-in and never default CI).
 *
 * Honesty rules, executably:
 *   - G4: a row whose mapped test is missing, fails, or cannot run
 *     (pending-merge) leaves the run RED. The runner exits non-zero.
 *   - NOT-VERIFIED (an environment gap: browser binary unobtainable) is a
 *     recorded state, not a failure — the ledger row's gaps carry it and the
 *     report prints it loudly.
 *   - G5: a `requires`-pinned entry (mapped test on a recorded unmerged
 *     branch) is reported PENDING_MERGE naming branch + head; the run stays
 *     red until the branch merges.
 *   - G3/E43 leak-scan: the ledger, the S34 fixture area, and every report
 *     payload are scanned for secret-shaped content BEFORE anything is
 *     written. A finding reports the pattern CATEGORY and the field PATH —
 *     never the matched content — and aborts the write.
 *   - G2: the runner creates no runtime state outside its declared output
 *     (tests/acceptance/evidence/<date>/) and the tool-owned scratch dirs
 *     (vitest/playwright). Suites manage their own fixtures.
 *
 * Default CI stays bounded: `pnpm test` (which includes the ledger's own
 * executable honesty contract) plus lint/typecheck/guards. This full-ledger
 * run is the separate, explicit gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  acceptanceLedgerSchema,
  type AcceptanceLedger,
  type LedgerRow,
} from "../tests/acceptance/ledger.schema.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LEDGER_PATH = join(REPO_ROOT, "tests", "acceptance", "ledger.json");
const FIXTURE_AREA = join(REPO_ROOT, "tests", "acceptance");
const BROWSER_DIR = join(FIXTURE_AREA, "browser");
const EVIDENCE_ROOT = join(FIXTURE_AREA, "evidence");
const VITEST_BIN = join(REPO_ROOT, "node_modules", ".bin", "vitest");
const PLAYWRIGHT_BIN = join(REPO_ROOT, "node_modules", ".bin", "playwright");

/** UTC date directory: evidence archives are dated per the issue's contract. */
const RUN_DATE = new Date().toISOString().slice(0, 10);
const EVIDENCE_DIR = join(EVIDENCE_ROOT, RUN_DATE);

type EntryStatus = "pass" | "fail" | "missing" | "pending_merge" | "not_verified";
type RowState = "pass" | "fail" | "missing" | "pending_merge" | "partial";

interface AutomatedOutcome {
  file: string;
  kind: "vitest" | "browser-matrix";
  status: EntryStatus;
  testsPassed?: number;
  testsFailed?: number;
  durationMs?: number;
  /** Typed state detail — a branch name, a missing-file note, a reason. Never content. */
  detail?: string;
  browserProjects?: Record<string, { status: EntryStatus; detail?: string }>;
}

interface RowReport {
  id: string;
  ownerVerdict: string;
  state: RowState | "manual_only" | "opt_in";
  automated: AutomatedOutcome[];
  gaps: string[];
}

interface LeakFinding {
  category: string;
  path: string;
}

/**
 * The E43 leak-scan posture: a finding reports the pattern CATEGORY and the
 * field PATH, never the matched content, so a leak report cannot echo the
 * private data it found. Shapes are deliberately conservative (long random
 * assignments, key blocks, JWTs, AWS/Google/Slack token shapes, URL
 * credentials) — a fixture that trips one must not be committed.
 */
const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["aws_access_key_id", /\bAKIA[0-9A-Z]{16}\b/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack_token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  [
    "key_assignment",
    /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{20,}["']?/i,
  ],
  ["bearer_token", /\bbearer\s+[A-Za-z0-9._-]{24,}\b/i],
  ["url_credentials", /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]*\b/],
];

function scanForLeaks(text: string, path: string): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const [category, pattern] of LEAK_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({ category, path });
    }
  }
  return findings;
}

function listFiles(dir: string, extensions: string[], skip: Set<string>): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full, extensions, skip));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      out.push(full);
    }
  }
  return out;
}

function toRepoPath(absolutePath: string): string {
  return relative(REPO_ROOT, absolutePath).split(sep).join("/");
}

interface VitestFileResult {
  status: "passed" | "failed";
  passed: number;
  failed: number;
  durationMs: number;
  failureTail: string;
}

/** Run ONE batched vitest invocation over all mapped files; map results by file. */
function runVitestBatch(files: string[]): Map<string, VitestFileResult> {
  const results = new Map<string, VitestFileResult>();
  if (files.length === 0) return results;
  const jsonOut = join(EVIDENCE_DIR, "vitest-run.json");
  const started = Date.now();
  const spawn = spawnSync(
    VITEST_BIN,
    ["run", ...files, "--reporter=json", `--outputFile=${jsonOut}`, "--silent"],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 30 * 60_000 },
  );
  const wallMs = Date.now() - started;
  if (!existsSync(jsonOut)) {
    // The runner itself is broken or the invocation never started: every
    // mapped file is an honest FAIL with the runner's own note (never silent).
    for (const file of files) {
      results.set(file, {
        status: "failed",
        passed: 0,
        failed: 0,
        durationMs: wallMs,
        failureTail: `vitest produced no JSON report (exit ${spawn.status}). stderr tail:\n${(
          spawn.stderr ?? ""
        ).slice(-2000)}`,
      });
    }
    return results;
  }
  const parsed: {
    testResults?: Array<{
      name?: string;
      status?: string;
      duration?: number;
      assertionResults?: Array<{ status?: string }>;
    }>;
  } = JSON.parse(readFileSync(jsonOut, "utf8"));
  for (const file of files) {
    const match = parsed.testResults?.find(
      (entry) => entry.name && (entry.name === file || entry.name.endsWith(file)),
    );
    const assertions = match?.assertionResults ?? [];
    const passed = assertions.filter((a) => a.status === "passed").length;
    const failed = assertions.filter((a) => a.status === "failed").length;
    results.set(file, {
      status: match?.status === "passed" ? "passed" : "failed",
      passed,
      failed,
      durationMs: Math.round(match?.duration ?? 0),
      failureTail:
        match?.status === "passed"
          ? ""
          : `vitest exit ${spawn.status}; ${failed} failed assertion(s) — full output in the raw vitest-run.json evidence file`,
    });
  }
  return results;
}

interface BrowserProjectProbe {
  project: string;
  available: boolean;
  detail: string;
}

/**
 * The worktree-local browser cache (the official installer's target per the
 * S34 posture: versions + checksums recorded, the shared user cache never
 * widened). When the cache exists it is the DEFAULT browsers path for every
 * child process — an explicitly exported PLAYWRIGHT_BROWSERS_PATH always wins.
 */
function childEnv(): NodeJS.ProcessEnv {
  const worktreeCache = join(REPO_ROOT, ".browsers-cache");
  if (process.env["PLAYWRIGHT_BROWSERS_PATH"] || !existsSync(worktreeCache)) {
    return process.env;
  }
  return { ...process.env, PLAYWRIGHT_BROWSERS_PATH: worktreeCache };
}

/** Probe each §18 project's browser binary with the runner's pinned toolchain. */
function probeBrowserProjects(): BrowserProjectProbe[] {
  // Loaded lazily so the probe uses the exact-pinned @playwright/test whose
  // registry revisions match the installed browser cache.
  const probeSource = [
    "const fs = require('node:fs');",
    "const pw = require('@playwright/test');",
    "const out = [];",
    "for (const [name, type] of [['chromium', pw.chromium], ['firefox', pw.firefox], ['webkit', pw.webkit]]) {",
    "  try { const p = type.executablePath(); out.push([name, fs.existsSync(p), p]); }",
    "  catch (e) { out.push([name, false, String(e.message).split('\\n')[0]]); }",
    "}",
    "const chromeCandidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];",
    "const chrome = chromeCandidates.find((p) => fs.existsSync(p));",
    "out.push(['chrome', Boolean(chrome), chrome ?? 'no system Chrome binary found']);",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const spawn = spawnSync(process.execPath, ["-e", probeSource], {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  const parsed: Array<[string, boolean, string]> = JSON.parse(spawn.stdout.trim());
  return parsed.map(([project, available, detail]) => ({
    project,
    available,
    detail: available ? "binary present" : `NOT-VERIFIED: ${detail}`,
  }));
}

interface PlaywrightFileOutcome {
  projects: Record<string, { status: EntryStatus; detail?: string }>;
  stats: { total: number; passed: number; failed: number; skipped: number };
  rawErrors: string[];
}

/** Run the browser-matrix specs on the available projects; map by spec file. */
function runBrowserMatrix(
  specs: string[],
  probes: BrowserProjectProbe[],
): Map<string, PlaywrightFileOutcome> {
  const outcomes = new Map<string, PlaywrightFileOutcome>();
  const available = probes.filter((p) => p.available).map((p) => p.project);
  for (const spec of specs) {
    outcomes.set(spec, {
      projects: Object.fromEntries(
        probes.map((p) => [
          p.project,
          p.available
            ? { status: "pass" as EntryStatus }
            : { status: "not_verified" as EntryStatus, detail: p.detail },
        ]),
      ),
      stats: { total: 0, passed: 0, failed: 0, skipped: 0 },
      rawErrors: [],
    });
  }
  if (specs.length === 0) return outcomes;
  if (available.length === 0) {
    // Recorded, not failed: an environment with no obtainable browser is the
    // honest NOT-VERIFIED posture, and the ledger rows already name the gaps.
    for (const spec of specs) {
      const outcome = outcomes.get(spec);
      if (outcome) {
        for (const project of Object.keys(outcome.projects)) {
          outcome.projects[project] = {
            status: "not_verified",
            detail: "no §18 browser binary obtainable in this environment",
          };
        }
      }
    }
    return outcomes;
  }
  const jsonOut = join(EVIDENCE_DIR, "browser-run.json");
  const args = [
    "test",
    "--config=tests/acceptance/browser/playwright.config.ts",
    ...specs,
    ...available.map((project) => `--project=${project}`),
    "--reporter=line",
    `--output=${join(BROWSER_DIR, "test-results")}`,
  ];
  const spawn = spawnSync(PLAYWRIGHT_BIN, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30 * 60_000,
    env: {
      ...childEnv(),
      SHERA_PW_JSON_OUT: jsonOut,
      PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOut,
    },
  });
  const parsed: {
    stats?: { total?: number; passed?: number; failed?: number; skipped?: number };
    suites?: Array<Record<string, unknown>>;
    errors?: string[];
  } = existsSync(jsonOut) ? JSON.parse(readFileSync(jsonOut, "utf8")) : {};
  // Walk the Playwright suite tree: file-level suites carry their specs; each
  // spec's tests know their project and outcome.
  interface PwTest {
    projectName?: string;
    ok?: boolean;
    expectedStatus?: string;
    results?: Array<{ status?: string }>;
  }
  interface PwSuite {
    title?: string;
    file?: string;
    suites?: PwSuite[];
    specs?: Array<{ title?: string; ok?: boolean; tests?: PwTest[] }>;
  }
  const walk = (suite: PwSuite): void => {
    const file = suite.file ? toRepoPath(resolve(REPO_ROOT, suite.file)) : undefined;
    for (const spec of suite.specs ?? []) {
      if (!file || !specs.includes(file)) continue;
      const outcome = outcomes.get(file);
      if (!outcome) continue;
      for (const test of spec.tests ?? []) {
        const project = test.projectName ?? "unknown";
        const lastResult = test.results?.[(test.results?.length ?? 1) - 1]?.status;
        const passed =
          test.ok === true || (lastResult === "passed" && test.expectedStatus === "passed");
        const slot = outcome.projects[project] ?? { status: "pass" as EntryStatus };
        outcome.projects[project] = passed
          ? { status: "pass" }
          : {
              status: "fail",
              detail: `spec failed on ${project} (status: ${lastResult ?? "unknown"})`,
            };
        outcome.stats.total += 1;
        outcome.stats[passed ? "passed" : "failed"] += 1;
        void slot;
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (parsed.suites ?? []) as PwSuite[]) walk(suite);
  if (spawn.status !== 0 && (parsed.stats?.failed ?? 0) === 0 && (parsed.stats?.total ?? 0) === 0) {
    // Playwright died before producing results (config error, missing binary):
    // every spec is an honest FAIL with the CLI's note, never silent.
    const note = `playwright exit ${spawn.status}: ${(spawn.stderr ?? spawn.stdout ?? "").slice(-1500)}`;
    for (const spec of specs) {
      const outcome = outcomes.get(spec);
      if (!outcome) continue;
      for (const project of available) {
        if (outcome.projects[project]?.status === "pass") {
          outcome.projects[project] = { status: "fail", detail: note };
        }
      }
      outcome.rawErrors.push(note);
    }
  }
  return outcomes;
}

function rowState(row: LedgerRow, outcomes: AutomatedOutcome[]): RowReport {
  let state: RowState;
  if (outcomes.some((entry) => entry.status === "missing")) {
    state = "missing";
  } else if (outcomes.some((entry) => entry.status === "fail")) {
    state = "fail";
  } else if (outcomes.some((entry) => entry.status === "pending_merge")) {
    state = "pending_merge";
  } else if (
    outcomes.some((entry) =>
      Object.values(entry.browserProjects ?? {}).some(
        (project) => project.status === "not_verified",
      ),
    ) ||
    outcomes.some((entry) => entry.status === "not_verified")
  ) {
    // Partial: the claimable evidence held, but some §18 environment leg is
    // recorded NOT-VERIFIED (printed loudly in the report; ledger gaps carry it).
    state = "partial";
  } else {
    state = "pass";
  }
  return {
    id: row.id,
    ownerVerdict: row.ownerVerdict,
    state,
    automated: outcomes,
    gaps: row.gaps,
  };
}

function markdownReport(report: {
  generatedAt: string;
  rows: RowReport[];
  probes: BrowserProjectProbe[];
  leakFindings: LeakFinding[];
  exitCode: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Acceptance runner report — ${report.generatedAt}`);
  lines.push("");
  lines.push(
    "The criteria runner's record for this run (E43 tiering; G4/G5/G7 honesty rules in the script header). Machine-readable twin: `acceptance-report.json` alongside this file.",
  );
  lines.push("");
  const counts = new Map<string, number>();
  for (const row of report.rows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  lines.push(
    `Summary: ${report.rows.length} ledger rows — ` +
      [...counts.entries()].map(([state, count]) => `${state}: ${count}`).join(", "),
  );
  lines.push("");
  lines.push("## §18 browser projects probed this run");
  lines.push("");
  for (const probe of report.probes) {
    lines.push(`- **${probe.project}**: ${probe.available ? "available" : probe.detail}`);
  }
  lines.push("");
  lines.push("## Row states");
  lines.push("");
  lines.push("| Row | Owner verdict | Runner state | Automated evidence |");
  lines.push("|---|---|---|---|");
  for (const row of report.rows) {
    const evidence = row.automated
      .map((entry) => {
        const base = `${entry.file} → ${entry.status}`;
        const projects = entry.browserProjects
          ? Object.entries(entry.browserProjects)
              .map(([project, outcome]) => `${project}:${outcome.status}`)
              .join(", ")
          : undefined;
        return projects ? `${base} (${projects})` : base;
      })
      .join("<br>");
    lines.push(
      `| ${row.id} | ${row.ownerVerdict} | ${row.state} | ${evidence || "none (manual only)"} |`,
    );
  }
  lines.push("");
  const notVerified = report.rows.filter((row) => row.state === "partial");
  if (notVerified.length > 0) {
    lines.push("## NOT-VERIFIED this run (recorded gaps, never silent)");
    lines.push("");
    for (const row of notVerified) {
      for (const entry of row.automated) {
        for (const [project, outcome] of Object.entries(entry.browserProjects ?? {})) {
          if (outcome.status === "not_verified") {
            lines.push(
              `- ${row.id} / ${entry.file} / ${project}: ${outcome.detail ?? "unavailable"}`,
            );
          }
        }
      }
    }
    lines.push("");
  }
  const pending = report.rows.filter((row) => row.state === "pending_merge");
  if (pending.length > 0) {
    lines.push("## PENDING_MERGE this run (G5 — surfaced, never silently resolved)");
    lines.push("");
    for (const row of pending) {
      for (const entry of row.automated) {
        if (entry.status === "pending_merge") {
          lines.push(`- ${row.id} / ${entry.file}: ${entry.detail ?? "requires unmerged branch"}`);
        }
      }
    }
    lines.push("");
  }
  const failed = report.rows.filter((row) => row.state === "fail" || row.state === "missing");
  if (failed.length > 0) {
    lines.push("## FAILED / MISSING this run (G4 — the run is red)");
    lines.push("");
    for (const row of failed) {
      for (const entry of row.automated) {
        if (entry.status === "fail" || entry.status === "missing") {
          lines.push(
            `- ${row.id} / ${entry.file}: ${entry.status}${entry.detail ? ` — ${entry.detail}` : ""}`,
          );
        }
      }
    }
    lines.push("");
  }
  lines.push("## OPT-IN live legs (G7 — never run by this runner)");
  lines.push("");
  for (const row of report.rows.filter((r) =>
    r.gaps.some((gap) => gap.toLowerCase().includes("opt-in")),
  )) {
    lines.push(`- ${row.id}: live-provider legs stay behind the owner's explicit environment (G7)`);
  }
  lines.push("");
  lines.push("## Leak scan (E43 rule: category + path, never content)");
  lines.push("");
  lines.push(
    report.leakFindings.length === 0
      ? "No findings across the ledger and the S34 fixture area."
      : report.leakFindings.map((finding) => `- ${finding.category} at ${finding.path}`).join("\n"),
  );
  lines.push("");
  lines.push(
    `Exit code: ${report.exitCode} (0 = every claimable automated row held; red rows above are recorded, not faked).`,
  );
  lines.push("");
  return lines.join("\n");
}

function main(): number {
  console.log(`acceptance runner: ledger ${toRepoPath(LEDGER_PATH)}`);
  if (!existsSync(LEDGER_PATH)) {
    console.error("acceptance runner: FAIL — tests/acceptance/ledger.json does not exist");
    return 1;
  }
  const ledgerText = readFileSync(LEDGER_PATH, "utf8");
  const ledger: AcceptanceLedger = acceptanceLedgerSchema.parse(JSON.parse(ledgerText));

  // G3/E43: scan the ledger and the S34 fixture area BEFORE anything runs or
  // is written. A finding aborts the run without writing a report that could
  // echo the content (category + path only, on stderr).
  const leakFindings: LeakFinding[] = [...scanForLeaks(ledgerText, toRepoPath(LEDGER_PATH))];
  const fixtureSkip = new Set([
    "node_modules",
    "test-results",
    "playwright-report",
    "evidence",
    ".gitkeep",
  ]);
  const fixtureFiles = listFiles(
    FIXTURE_AREA,
    [".ts", ".tsx", ".json", ".md", ".txt"],
    fixtureSkip,
  ).filter((file) => !file.startsWith(EVIDENCE_ROOT) && !file.startsWith(BROWSER_DIR));
  for (const file of fixtureFiles) {
    const findings = scanForLeaks(readFileSync(file, "utf8"), toRepoPath(file));
    leakFindings.push(...findings);
  }
  if (leakFindings.length > 0) {
    console.error("acceptance runner: FAIL — leak-scan findings (category + path only, G3/E43):");
    for (const finding of leakFindings) {
      console.error(`  ${finding.category} at ${finding.path}`);
    }
    return 1;
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true });

  // Validate mappings first: a mapped test that does not exist is MISSING
  // before anything runs (G4 — no silent claim).
  const vitestFiles: string[] = [];
  const browserSpecs: string[] = [];
  const missing: Array<{ row: LedgerRow; file: string; kind: string }> = [];
  for (const row of ledger.rows) {
    for (const entry of row.automated) {
      if (entry.kind === "browser-matrix") {
        if (!existsSync(join(REPO_ROOT, entry.file))) {
          missing.push({ row, file: entry.file, kind: entry.kind });
        } else {
          browserSpecs.push(entry.file);
        }
        continue;
      }
      if (entry.requires) continue; // PENDING_MERGE — never run from this tree
      if (!existsSync(join(REPO_ROOT, entry.file))) {
        missing.push({ row, file: entry.file, kind: entry.kind });
      } else if (!vitestFiles.includes(entry.file)) {
        vitestFiles.push(entry.file);
      }
    }
  }

  const probes = probeBrowserProjects();
  console.log(
    `acceptance runner: §18 projects — ${probes
      .map((probe) => `${probe.project}=${probe.available ? "available" : "NOT-VERIFIED"}`)
      .join(", ")}`,
  );

  const vitestResults = runVitestBatch(vitestFiles);
  const browserResults = runBrowserMatrix(browserSpecs, probes);

  const rows: RowReport[] = [];
  for (const row of ledger.rows) {
    const outcomes: AutomatedOutcome[] = [];
    for (const entry of row.automated) {
      if (entry.kind === "browser-matrix") {
        if (missing.some((m) => m.row.id === row.id && m.file === entry.file)) {
          outcomes.push({
            file: entry.file,
            kind: entry.kind,
            status: "missing",
            detail: "mapped browser spec does not exist in this tree (G4)",
          });
          continue;
        }
        const outcome = browserResults.get(entry.file);
        const projects = outcome?.projects ?? {};
        const statuses = Object.values(projects).map((project) => project.status);
        const anyFail = statuses.includes("fail");
        const anyMissing = statuses.includes("missing");
        const anyPass = statuses.includes("pass");
        const allNotVerified = statuses.every((status) => status === "not_verified");
        const entryStatus: EntryStatus =
          anyFail || anyMissing ? "fail" : allNotVerified && !anyPass ? "not_verified" : "pass";
        outcomes.push({
          file: entry.file,
          kind: entry.kind,
          status: entryStatus,
          ...(anyFail ? { detail: "browser-matrix reported a failing project" } : {}),
          browserProjects: projects,
          ...(outcome
            ? { testsPassed: outcome.stats.passed, testsFailed: outcome.stats.failed }
            : {}),
        });
        continue;
      }
      if (missing.some((m) => m.row.id === row.id && m.file === entry.file)) {
        outcomes.push({
          file: entry.file,
          kind: entry.kind,
          status: "missing",
          detail: "mapped test file does not exist in this tree (G4)",
        });
        continue;
      }
      if (entry.requires) {
        outcomes.push({
          file: entry.file,
          kind: entry.kind,
          status: "pending_merge",
          detail: `PENDING_MERGE: lives on unmerged branch ${entry.requires.branch} (head ${entry.requires.head}) — G5 surfaced, run red until it merges`,
        });
        continue;
      }
      const result = vitestResults.get(entry.file);
      const passed = result?.status === "passed";
      outcomes.push({
        file: entry.file,
        kind: entry.kind,
        status: passed ? "pass" : "fail",
        ...(result
          ? {
              testsPassed: result.passed,
              testsFailed: result.failed,
              durationMs: result.durationMs,
              ...(result.failureTail ? { detail: result.failureTail } : {}),
            }
          : {}),
      });
    }
    rows.push(rowState(row, outcomes));
  }

  const failedRows = rows.filter(
    (row) => row.state === "fail" || row.state === "missing" || row.state === "pending_merge",
  );
  const exitCode = failedRows.length > 0 ? 1 : 0;

  const generatedAt = new Date().toISOString();
  const jsonReport = {
    tool: "shera-bot acceptance runner (S34)",
    schemaVersion: 1,
    generatedAt,
    ledger: { version: ledger.version, rows: ledger.rows.length },
    browserProjects: probes,
    summary: {
      rows: rows.length,
      pass: rows.filter((row) => row.state === "pass").length,
      partial: rows.filter((row) => row.state === "partial").length,
      fail: rows.filter((row) => row.state === "fail").length,
      missing: rows.filter((row) => row.state === "missing").length,
      pendingMerge: rows.filter((row) => row.state === "pending_merge").length,
    },
    rows,
    leakFindings,
    exitCode,
  };
  const jsonPath = join(EVIDENCE_DIR, "acceptance-report.json");
  const mdPath = join(EVIDENCE_DIR, "acceptance-report.md");
  const jsonText = JSON.stringify(jsonReport, null, 2) + "\n";
  // The report payload is itself leak-scanned (failure tails could carry
  // suite output); a finding in the payload aborts the write (G3/E43).
  const payloadFindings = [
    ...scanForLeaks(jsonText, toRepoPath(jsonPath)),
    ...scanForLeaks(
      markdownReport({ generatedAt, rows, probes, leakFindings, exitCode }),
      toRepoPath(mdPath),
    ),
  ];
  if (payloadFindings.length > 0) {
    console.error("acceptance runner: FAIL — report payload leak-scan (category + path only):");
    for (const finding of payloadFindings) {
      console.error(`  ${finding.category} at ${finding.path}`);
    }
    return 1;
  }
  writeFileSync(jsonPath, jsonText);
  writeFileSync(mdPath, markdownReport({ generatedAt, rows, probes, leakFindings, exitCode }));
  // The raw vitest/playwright JSON (full per-test results) stays as run
  // evidence, but each is leak-scanned first — they carry test names and
  // locations by construction, never content; a finding replaces the file
  // with a typed note naming category + path (G3/E43), never the content.
  for (const raw of ["vitest-run.json", "browser-run.json"]) {
    const rawPath = join(EVIDENCE_DIR, raw);
    if (!existsSync(rawPath)) continue;
    const rawText = readFileSync(rawPath, "utf8");
    const findings = scanForLeaks(rawText, toRepoPath(rawPath));
    if (findings.length > 0) {
      writeFileSync(
        rawPath,
        JSON.stringify(
          {
            omitted: true,
            reason: `raw ${raw} withheld: leak-scan findings (category + path only)`,
            findings,
          },
          null,
          2,
        ) + "\n",
      );
    }
  }

  console.log(`acceptance runner: report → ${toRepoPath(jsonPath)}`);
  console.log(
    `acceptance runner: rows — pass=${jsonReport.summary.pass} partial=${jsonReport.summary.partial} fail=${jsonReport.summary.fail} missing=${jsonReport.summary.missing} pendingMerge=${jsonReport.summary.pendingMerge}`,
  );
  if (failedRows.length > 0) {
    console.error("acceptance runner: RED — the ledger's automated claims do not all hold (G4):");
    for (const row of failedRows) {
      console.error(`  ${row.id}: ${row.state}`);
    }
    return 1;
  }
  console.log(
    "acceptance runner: GREEN — every claimable automated row held (owner verdicts stay the owner's).",
  );
  return 0;
}

process.exitCode = main();
