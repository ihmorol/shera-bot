/**
 * The acceptance ledger's executable honesty rules (S34).
 *
 * The ledger is the release gate's data (PRD §19 rows; E14 evidence rules;
 * E7 definition of done). These tests pin it:
 *
 *   1. The ledger exists, parses, and validates against the zod contract.
 *   2. Every `criterion` equals the verbatim PRD §19 text — the frozen
 *      baseline embedded below (the E43 golden-baseline pattern: drift is a
 *      red, never a silent rewrite of the product's own words).
 *   3. Every mapped automated test file EXISTS in the working tree, unless
 *      the entry records a `requires` branch — a G5-surfaced pending-merge
 *      state that must also appear in the row's named gaps.
 *   4. The honesty rule is executable: `ownerVerdict: "accepted"` requires
 *      BOTH an automated mapping AND an owner-ran manual leg. Agents propose;
 *      only the owner accepts (issue #35).
 *   5. Every not-yet-accepted row names what the owner must still run
 *      (`ranBy: "pending-owner"`) and names its gaps — nothing is quietly
 *      downgraded and no row claims acceptance it cannot support.
 *
 * This suite is deliberately part of the DEFAULT `pnpm test` run: a ledger
 * that lies must break the build, not a separate opt-in gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acceptanceLedgerSchema,
  type AcceptanceLedger,
  type LedgerRow,
} from "./ledger.schema.ts";

const here = import.meta.dirname;
const LEDGER_PATH = join(here, "ledger.json");
const REPO_ROOT = resolve(here, "..", "..");

/**
 * The verbatim PRD §19 acceptance criteria (the frozen baseline; source:
 * docs/PRD.md §19 at the S34 base 7c97752). If the PRD ever changes via a
 * recorded product decision (PRD §24), this baseline changes WITH it, in the
 * open, and the ledger rows are reconciled in the same PR.
 */
const PRD_SECTION_19: Readonly<Record<string, string>> = {
  AC1: "Google OAuth login works and the five-account cap is enforced.",
  AC2: "A Balanced-tier user container is provisioned.",
  AC3: "All six Agents from the student pack are available as direct chats.",
  AC4: "Each Agent is a persistent identity with its own private profile folder and an on-demand supervised session process on its selected harness (Pi default, Hermes optional — D51).",
  AC5: "Ad-hoc Operations can be created with a custom same-Pack Agent roster.",
  AC6: "Operations launch through a preview (agents, skills, connectors, provider/model, estimated credits, approval requirements) before execution, and Agents can delegate work inside Operations.",
  AC7: "Live agent messages, progress, tool calls, approvals, and results are visible.",
  AC8: "Prototype-functional tools work end-to-end.",
  AC9: "Agents can create reusable private/shared tools under the approval policy.",
  AC10: "Built-in, local, OpenAI-compatible, and custom providers can be configured and tested.",
  AC11: "Per-agent defaults and per-conversation provider overrides work.",
  AC12: "At least one autonomous scheduled or event-triggered task completes.",
  AC13: "Risky actions pause and display the defined approval choices and reminder sequence.",
  AC14: "Transient failures retry no more than three times before pausing and notifying.",
  AC15: "Immediate cancellation stops parent, child, and queued work while preserving partial outputs.",
  AC16: "Shared/private files, chats, tasks, memories, browser state, and tools persist across restart.",
  AC17: "A coding task uses a separate branch/worktree and asks approval before merge.",
  AC18: "Automatic backups run and an administrator restores one snapshot.",
  AC19: "Restart recovery restores processes, state, schedules, browser profile, and approvals safely.",
  AC20: "Desktop and mobile web layouts work on target browsers.",
  AC21: "No critical cross-user isolation or credential-leak failure is observed.",
  AC22: "A workspace is pinned to a versioned customer pack, and existing tasks retain the pack/Operation/Agent versions that created them.",
  AC23: "An Operation launches through a preview that shows agents, skills, connectors, provider/model, estimated credits, and approval requirements before execution.",
  AC24: "One Operation chat can hold multiple independently tracked task runs without merging their state, events, or cost.",
  AC25: "A long-running task survives browser closure, keeps its worker alive while healthy, and resumes from a semantic checkpoint after a restart.",
  AC26: "Read-only tools run automatically, local mutations show a preview, and a matching reusable grant executes without another prompt while still being policy-checked.",
  AC27: "Agent-private memory does not leak into Operation context without explicit publication.",
};

function loadLedger(): AcceptanceLedger {
  expect(existsSync(LEDGER_PATH), "tests/acceptance/ledger.json must exist").toBe(true);
  const parsed: unknown = JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  return acceptanceLedgerSchema.parse(parsed);
}

describe("the acceptance ledger (AC1–AC27)", () => {
  const ledger = loadLedger();

  it("has exactly one row per criterion, ids AC1–AC27, no duplicates", () => {
    const ids = ledger.rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(27);
    expect(ids.sort()).toEqual(
      Object.keys(PRD_SECTION_19).sort(),
    );
  });

  it("carries the verbatim PRD §19 text on every row (frozen baseline)", () => {
    for (const row of ledger.rows) {
      expect(row.criterion, `${row.id} criterion drifted from PRD §19`).toBe(
        PRD_SECTION_19[row.id],
      );
    }
  });

  it("maps every row to at least one automated or manual evidence leg", () => {
    for (const row of ledger.rows) {
      expect(
        row.automated.length + row.manual.length,
        `${row.id} has no evidence mapping at all`,
      ).toBeGreaterThan(0);
      expect(row.slices.length, `${row.id} names no implementing slice`).toBeGreaterThan(0);
      expect(row.records.length, `${row.id} names no evidence trail`).toBeGreaterThan(0);
    }
  });

  it("maps automated claims to existing test files in this tree (G4: no silent claim)", () => {
    for (const row of ledger.rows) {
      for (const entry of row.automated) {
        if (entry.kind === "browser-matrix") {
          expect(entry.file.startsWith("tests/acceptance/browser/")).toBe(true);
          expect(row.browserMatrix, `${row.id} browser-matrix entry needs the flag`).toBe(true);
          continue;
        }
        const absolute = resolve(REPO_ROOT, entry.file);
        expect(isAbsolute(entry.file), `${row.id}: mapped file must be repo-relative`).toBe(false);
        expect(entry.file.includes(".."), `${row.id}: mapped file must not escape the repo`).toBe(
          false,
        );
        expect(
          existsSync(absolute),
          `${row.id}: mapped test file ${entry.file} does not exist in this tree — the ledger must not claim evidence it cannot run`,
        ).toBe(true);
        expect(entry.file.endsWith(".test.ts"), `${row.id}: vitest mappings cite .test.ts`).toBe(
          true,
        );
      }
    }
  });

  it("surfaces pending-merge mappings as named gaps (G5: no silent conflict)", () => {
    for (const row of ledger.rows) {
      for (const entry of row.automated) {
        if (entry.requires) {
          expect(entry.requires.branch.length).toBeGreaterThan(0);
          expect(entry.requires.head.length).toBeGreaterThan(0);
          expect(
            row.gaps.some((gap) => gap.includes(entry.requires?.branch ?? "")),
            `${row.id}: mapped entry requires unmerged branch ${entry.requires.branch} but the row's gaps never name it`,
          ).toBe(true);
        }
      }
    }
  });

  it("never marks a row accepted without BOTH evidence kinds (the E14/E7 rule)", () => {
    for (const row of ledger.rows) {
      if (row.ownerVerdict !== "accepted") continue;
      expect(row.automated.length, `${row.id}: accepted without automated evidence`).toBeGreaterThan(
        0,
      );
      const ownerLeg = row.manual.find((leg) => leg.ranBy === "owner");
      expect(ownerLeg, `${row.id}: accepted without an owner-ran manual leg`).toBeDefined();
      expect(ownerLeg?.result ?? "").not.toBe("pending");
      expect(ownerLeg?.when ?? "").not.toBe("pending");
    }
  });

  it("names the owner's remaining run on every not-yet-accepted row (Stage 6)", () => {
    for (const row of ledger.rows) {
      if (row.ownerVerdict !== "open") continue;
      const hasOwnerLeg = row.manual.some((leg) => leg.ranBy === "owner");
      const hasPendingOwnerLeg = row.manual.some((leg) => leg.ranBy === "pending-owner");
      expect(
        hasOwnerLeg || hasPendingOwnerLeg,
        `${row.id}: open rows must record either the owner's run or the pending owner leg`,
      ).toBe(true);
      if (!hasOwnerLeg) {
        const pending = row.manual.find((leg) => leg.ranBy === "pending-owner");
        expect(pending?.when, `${row.id}: pending owner leg must say "pending"`).toBe("pending");
        expect(
          row.gaps.length,
          `${row.id}: an open row must name its gaps — nothing quietly downgraded`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("records manual legs with the archivist columns filled", () => {
    for (const row of ledger.rows) {
      for (const leg of row.manual) {
        expect(leg.what.length).toBeGreaterThan(0);
        expect(leg.result.length).toBeGreaterThan(0);
        expect(leg.evidenceLocation.length).toBeGreaterThan(0);
        expect(leg.when.length).toBeGreaterThan(0);
      }
    }
  });

  it("flags live-provider legs as opt-in only (G7)", () => {
    for (const row of ledger.rows) {
      if (!row.liveOptIn) continue;
      expect(
        row.gaps.some((gap) => gap.toLowerCase().includes("opt-in")),
        `${row.id}: a live leg must record its opt-in posture in the gaps`,
      ).toBe(true);
    }
  });
});

describe("ledger row hygiene", () => {
  const ledger = loadLedger();

  it("uses G1 vocabulary (Agent/Operation, never Expert/Scene) in row text", () => {
    for (const row of ledger.rows as LedgerRow[]) {
      const text = [row.criterion, ...row.gaps, ...row.automated.map((a) => a.covers)].join(" ");
      expect(text.match(/\bExpert\b/), `${row.id}: historical alias in ledger text`).toBeNull();
      expect(text.match(/\bScene\b/), `${row.id}: retired noun in ledger text`).toBeNull();
    }
  });

  it("keeps every mapped path inside the repository", () => {
    for (const row of ledger.rows) {
      for (const entry of row.automated) {
        const resolved = resolve(REPO_ROOT, entry.file);
        expect(resolved.startsWith(REPO_ROOT + sep), `${row.id}: path escapes repo`).toBe(true);
      }
      for (const leg of row.manual) {
        expect(leg.evidenceLocation.startsWith("/"), `${row.id}: evidence path must be repo-relative or a named external record`).toBe(false);
      }
    }
  });
});
