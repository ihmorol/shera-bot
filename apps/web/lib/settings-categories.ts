/**
 * S30 — the D16 settings category register (issue #31; D16, UI_DESIGN §S9).
 *
 * The fifteen categories in D16's recorded order. The overview index renders
 * every one of them; each slug is a real section of the settings catch-all
 * route (the index never links a section that cannot render — G4). The
 * recorded read-only postures are marked: five categories are read-only BY
 * DECISION (D40 pinned pack, D20 admin-funded ledger, PRD §12 never-delete,
 * E1 runtime readout, PRD §12 admin-triggered restore) — their surfaces
 * render the runtime's own records with the decision's own words, and no
 * fake control is invented to satisfy a checkbox (G4/G5).
 */

export interface SettingsCategory {
  slug: string;
  label: string;
  summary: string;
  /** The recorded decision that makes the category read-only, if any. */
  readOnlyBecause?: string;
}

export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  {
    slug: "account",
    label: "Account",
    summary: "Your Google identity, tier, and the welcome interview.",
  },
  {
    slug: "agents",
    label: "Agents",
    summary: "Per-Agent profiles, instructions, defaults, and tool permissions.",
  },
  {
    slug: "providers",
    label: "Providers & models",
    summary: "The masked provider catalog, connection tests, and per-Agent defaults.",
  },
  {
    slug: "credits",
    label: "Model budgets / Credits",
    summary: "Remaining, reserved, and used credits — the ledger's own numbers.",
    readOnlyBecause: "the ledger is admin-funded (D20); custom providers use no Shera credits",
  },
  {
    slug: "tools",
    label: "Tools",
    summary: "The tool inventory: built-ins and Agent-created tools with their risk classes.",
  },
  {
    slug: "permissions",
    label: "Permissions & approvals",
    summary: "Active grants and reminder mutes — every grant visible and revocable.",
  },
  {
    slug: "workspace",
    label: "Workspace",
    summary: "The pinned pack and the tenancy posture.",
    readOnlyBecause: "one pinned pack per workspace; no switcher exists to build (D40, D19)",
  },
  {
    slug: "files",
    label: "Files & projects",
    summary: "Connected projects, worktrees, and merge-review queues.",
  },
  {
    slug: "memory",
    label: "Memory",
    summary: "Scopes, provenance, the publication queue, and the auto-memory switches.",
  },
  {
    slug: "schedules",
    label: "Schedules & watchers",
    summary: "Autonomous triggers with their truthful state and next occurrence.",
  },
  {
    slug: "notifications",
    label: "Notifications",
    summary: "In-app and browser delivery toggles (unfocused tab only).",
  },
  {
    slug: "privacy",
    label: "Privacy & retention",
    summary: "Redaction and the local-first data location statement.",
    readOnlyBecause: "user files are never automatically deleted (PRD §12); nothing to configure",
  },
  {
    slug: "runtime",
    label: "Runtime & resources",
    summary: "The tier table and the task-worker admission readout.",
    readOnlyBecause: "the runtime owns admission (E1) — the honest who-is-waiting read",
  },
  {
    slug: "git",
    label: "Git & repositories",
    summary: "Worktrees, conflict queues, and merge reviews.",
  },
  {
    slug: "backups",
    label: "Backups & recovery",
    summary: "Snapshot posture and the current recovery status.",
    readOnlyBecause: "restore is admin-triggered (PRD §12) — the user surface is read-only info",
  },
];

export const SETTINGS_CATEGORY_SLUGS: readonly string[] = SETTINGS_CATEGORIES.map((c) => c.slug);
