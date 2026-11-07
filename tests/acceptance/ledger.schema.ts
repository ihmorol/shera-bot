/**
 * The acceptance ledger's machine-readable contract (S34).
 *
 * The ledger maps every PRD §19 acceptance criterion (AC1–AC27) to the exact
 * evidence that supports it:
 *
 *   - `automated` entries name the repo-relative test files the criteria
 *     runner executes (`pnpm acceptance`). A missing mapped file is a RED
 *     build — the ledger never silently skips a claim it cannot run (G4).
 *   - `manual` entries carry the Stage-6 archivist columns: who ran what,
 *     when, with what result, and where the evidence lives. `ranBy:
 *     "pending-owner"` is an honest state: the criterion still needs the
 *     owner's personal run before it can ever be accepted.
 *   - `ownerVerdict` is THE OWNER'S column (`accepted` / `rejected` / `open`).
 *     Agents propose statuses through the evidence and gap columns; only the
 *     owner's recorded verdict may set this field, and `accepted` requires
 *     BOTH evidence kinds (enforced executably in ledger.test.ts).
 *
 * Vocabulary is G1-clean (Pack → Operations → Agents) and no row may carry
 * secret-shaped content (the runner leak-scans the ledger before any report
 * is written — findings report category + path, never matched content).
 */
import { z } from "zod";

export const ACCEPTANCE_IDS = [
  "AC1",
  "AC2",
  "AC3",
  "AC4",
  "AC5",
  "AC6",
  "AC7",
  "AC8",
  "AC9",
  "AC10",
  "AC11",
  "AC12",
  "AC13",
  "AC14",
  "AC15",
  "AC16",
  "AC17",
  "AC18",
  "AC19",
  "AC20",
  "AC21",
  "AC22",
  "AC23",
  "AC24",
  "AC25",
  "AC26",
  "AC27",
] as const;

export const acceptanceIdSchema = z.enum(ACCEPTANCE_IDS);

/** How the runner executes an automated evidence entry. */
export const automatedKindSchema = z.enum(["vitest", "browser-matrix"]);

/**
 * One automated-evidence claim: a test file the runner must be able to
 * execute. `requires` records mapped tests that live on a RECORDED unmerged
 * branch (G5 — surfaced, never silently resolved): the runner reports a typed
 * pending-merge state naming the branch and head instead of a fake pass.
 */
export const automatedEvidenceSchema = z.object({
  kind: automatedKindSchema,
  /** Repo-relative test file path. */
  file: z.string().min(1),
  /** What the file covers, in one line; may cite a load-bearing test name. */
  covers: z.string().min(1),
  requires: z
    .object({
      branch: z.string().min(1),
      head: z.string().min(1),
    })
    .optional(),
});

/** Who ran (or must run) a manual-evidence leg. */
export const manualRanBySchema = z.enum(["owner", "agent", "pending-owner"]);

/** One manual-evidence leg: the Stage-6 archivist columns. */
export const manualEvidenceSchema = z.object({
  ranBy: manualRanBySchema,
  /** ISO date the leg ran, or "pending" for a pending-owner leg. */
  when: z.string().min(1),
  what: z.string().min(1),
  result: z.string().min(1),
  /** Where the evidence lives (repo path or dated capture directory). */
  evidenceLocation: z.string().min(1),
});

/** The owner's verdict column. Agents never set "accepted"/"rejected". */
export const ownerVerdictSchema = z.enum(["accepted", "rejected", "open"]);

export const ledgerRowSchema = z.object({
  id: acceptanceIdSchema,
  /** The verbatim PRD §19 criterion text (the frozen baseline). */
  criterion: z.string().min(1),
  /** Implementing slices (S05, S11, ...). */
  slices: z.array(z.string().min(1)).min(1),
  /** The evidence trail: engineering record IDs, merged PRs, TRACEABILITY. */
  records: z.array(z.string().min(1)).min(1),
  automated: z.array(automatedEvidenceSchema),
  manual: z.array(manualEvidenceSchema),
  ownerVerdict: ownerVerdictSchema,
  /** Named blockers / standing NOT-VERIFIED items. Never silently empty. */
  gaps: z.array(z.string().min(1)),
  /** The row is exercised by the cross-browser matrix command. */
  browserMatrix: z.boolean().optional(),
  /** The row has a live-provider leg behind SHERA_ACCEPTANCE_LIVE=1 (G7). */
  liveOptIn: z.boolean().optional(),
});

export const acceptanceLedgerSchema = z.object({
  version: z.literal(1),
  rows: z.array(ledgerRowSchema).length(27),
});

export type AcceptanceId = z.infer<typeof acceptanceIdSchema>;
export type AutomatedEvidence = z.infer<typeof automatedEvidenceSchema>;
export type ManualEvidence = z.infer<typeof manualEvidenceSchema>;
export type OwnerVerdict = z.infer<typeof ownerVerdictSchema>;
export type LedgerRow = z.infer<typeof ledgerRowSchema>;
export type AcceptanceLedger = z.infer<typeof acceptanceLedgerSchema>;
