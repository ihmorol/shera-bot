/* ============================================================
   Shera Bot UI mockup — fixtures (docs/UI_DESIGN.md §9)
   Static mock data only. No runtime, no network, no secrets —
   every "key" below is a fake masked display value.
   ============================================================ */

const USER = {
  name: "Turing Michael",
  email: "tmichael20@gmail.com",
  googleInitials: "TM",
  tier: "Balanced",
  storageUsedPct: 82,
  storageTotal: "25 GB",
  isAdmin: false,
};

const PACK = {
  name: "student pack",
  version: "v1.3.0",
  agents: 6,
  operations: 3,
};

const AGENTS = [
  {
    id: "general-assistant", name: "General Assistant", hue: "#3b82f6",
    role: "Coordinator · planning & synthesis",
    presence: "active",
    provider: "OpenAI · GPT-4o",
    blurb: "Clarifies goals, delegates to the right Agents, combines results into final answers and artifacts.",
    unread: 2,
  },
  {
    id: "researcher", name: "Researcher", hue: "#0891b2",
    role: "Evidence-backed investigation",
    presence: "active",
    provider: "OpenAI · GPT-4o",
    blurb: "Searches and reads public sources, compares authority, extracts claims, writes literature reviews and reports with citations.",
    running: "Comparing source authority · run 3",
    unread: 0,
  },
  {
    id: "developer", name: "Developer", hue: "#7c3aed",
    role: "Code, repos & tooling",
    presence: "active",
    provider: "OpenAI · GPT-4o",
    blurb: "Inspects repositories, writes and reviews code, runs tests and builds, operates terminals and browsers on a separate worktree.",
    running: "Patching auth middleware · worktree",
    unread: 0,
  },
  {
    id: "citation-manager", name: "Citation Manager", hue: "#d97706",
    role: "Sources & reference integrity",
    presence: "hibernating",
    provider: "OpenAI · GPT-4o mini",
    blurb: "Maintains source indexes, reference metadata, and citation formats; preserves provenance for every source.",
    done: "Citation index refreshed",
    unread: 0,
  },
  {
    id: "programming-tutor", name: "Programming Tutor", hue: "#059669",
    role: "Code comprehension & practice",
    presence: "hibernating",
    provider: "Ollama · llama3:70b (local)",
    blurb: "Explains concepts, reviews solutions, and produces study-oriented exercises for programming assignments.",
    unread: 1,
  },
  {
    id: "study-planner", name: "Study Planner", hue: "#db2777",
    role: "Schedules & exam readiness",
    presence: "hibernating",
    provider: "OpenAI · GPT-4o mini",
    blurb: "Turns courses, deadlines, and exam dates into study schedules, and adjusts plans as work completes.",
    approval: 1,
    unread: 0,
  },
];

const OP_TEMPLATES = [
  {
    id: "research-paper", name: "Research Paper",
    purpose: "Take a topic from question to a cited, evidence-backed research paper: literature sweep, claim extraction, outline, drafting, and citation audit.",
    coordinator: "general-assistant",
    agents: ["general-assistant", "researcher", "citation-manager"],
    skills: {
      "general-assistant": ["task decomposition", "outline synthesis", "final QA"],
      researcher: ["literature sweep", "claim extraction", "source comparison", "report drafting"],
      "citation-manager": ["index building", "format audit (APA 7)"],
    },
    connectors: [
      { name: "Google Scholar", status: "connected" },
      { name: "Semantic Scholar", status: "connected" },
      { name: "Notion export", status: "not configured" },
    ],
    outputs: ["literature-review.md", "evidence-table.csv", "draft-v1.md", "bibliography.json"],
    approvals: "External writes (source exports) and file deletions pause for approval. Read-only research runs automatically.",
    estimate: [120, 180],
  },
  {
    id: "programming-assignment", name: "Programming Assignment",
    purpose: "Understand the assignment brief, scaffold a solution, and coach the student through it — with tests, review, and a study guide.",
    coordinator: "general-assistant",
    agents: ["general-assistant", "developer", "programming-tutor"],
    skills: {
      "general-assistant": ["brief parsing", "milestone planning"],
      developer: ["repo scaffold", "test harness", "CI script"],
      "programming-tutor": ["concept explainers", "practice exercises"],
    },
    connectors: [
      { name: "GitHub", status: "connected" },
      { name: "University LMS", status: "not configured" },
    ],
    outputs: ["solution repo (worktree)", "test-report.md", "study-guide.md"],
    approvals: "Repository mutation, package installs, and merges pause for approval. Tests and linting run automatically.",
    estimate: [90, 150],
  },
  {
    id: "exam-preparation", name: "Exam Preparation",
    purpose: "Build a study plan from course material and exam date, generate practice sets, and track readiness as work completes.",
    coordinator: "study-planner",
    agents: ["study-planner", "programming-tutor", "citation-manager"],
    skills: {
      "study-planner": ["schedule building", "progress tracking"],
      "programming-tutor": ["past-paper drills"],
      "citation-manager": ["syllabus source index"],
    },
    connectors: [
      { name: "Google Calendar", status: "connected" },
      { name: "Anki deck sync", status: "not configured" },
    ],
    outputs: ["study-plan.md", "practice-set-1.pdf", "readiness-report.md"],
    approvals: "Calendar writes pause for approval. Plan computation and practice generation run automatically.",
    estimate: [60, 110],
  },
];

const RUN_STATES = {
  QUEUED: "queued", RUNNING: "running", WAITING_FOR_APPROVAL: "waiting",
  RETRYING: "retrying", SUCCEEDED: "succeeded", FAILED: "failed",
  PAUSED: "paused", RECOVERY_REQUIRED: "recovery",
};

const RUNS = [
  { id: "run-3", chat: "op-research-paper", goal: "Comparative analysis of 14 sources", state: "WAITING_FOR_APPROVAL", credits: 42, artifacts: 1, elapsed: "00:41:17", live: true,
    note: "Paused — calendar export needs your approval" },
  { id: "run-2", chat: "op-research-paper", goal: "Literature sweep · graph neural networks", state: "SUCCEEDED", credits: 118, artifacts: 4, elapsed: "1:12:40", done: "yesterday" },
  { id: "run-1", chat: "op-research-paper", goal: "Topic scoping & question definition", state: "SUCCEEDED", credits: 31, artifacts: 2, elapsed: "0:22:05", done: "2 days ago" },
  { id: "run-2a", chat: "op-adhoc", goal: "Practice set generation · hashing", state: "RUNNING", credits: 17, artifacts: 1, elapsed: "00:09:03", live: true },
  { id: "run-2b", chat: "op-exam-prep", goal: "Schedule rebuild after syllabus change", state: "RECOVERY_REQUIRED", credits: 8, artifacts: 0, elapsed: "—",
    note: "Resumed from last safe step — review required" },
  { id: "run-1a", chat: "op-exam-prep", goal: "Syllabus source index", state: "SUCCEEDED", credits: 12, artifacts: 1, done: "3 days ago" },
  { id: "run-d1", chat: "agent-developer", goal: "Patch auth middleware + green tests", state: "RUNNING", credits: 23, artifacts: 1, elapsed: "00:18:52", live: true },
  { id: "run-s1", chat: "agent-researcher", goal: "Morning source monitor sweep", state: "SUCCEEDED", credits: 9, artifacts: 1, done: "today 07:40" },
  { id: "run-t1", chat: "agent-study-planner", goal: "Sync study plan to calendar", state: "WAITING_FOR_APPROVAL", credits: 2, artifacts: 0, elapsed: "—",
    note: "Paused — calendar.sync needs your approval" },
  { id: "run-4", chat: "op-adhoc", goal: "Explain DP vs greedy with examples", state: "RETRYING", credits: 5, artifacts: 0, elapsed: "—",
    note: "Transient provider failure · attempt 2 of 3" },
];

const APPROVALS = [
  {
    id: "appr-1", state: "pending", chat: "agent-study-planner", agent: "study-planner", run: "run-t1",
    tool: "calendar.sync", version: "v2",
    args: "12 study blocks · Oct 14 – Nov 2 · \"exam-prep\" calendar",
    target: "Google Calendar — primary account",
    sideEffect: "Creates 12 calendar events visible to shared calendar members",
    risk: "ext", riskLabel: "external write",
    expiry: "23 h 59 m",
    requested: "2 minutes ago",
    reminders: ["now", "15 min", "45 min", "3 h", "24 h"],
    choicesUsed: null,
  },
  {
    id: "appr-2", state: "pending", chat: "op-research-paper", agent: "researcher", run: "run-3",
    tool: "docx.export", version: "v1",
    args: "evidence-table.csv → evidence-table.xlsx · shared folder",
    target: "workspace://research/evidence-table.xlsx",
    sideEffect: "Writes one file into the shared workspace (local mutation)",
    risk: "mutat", riskLabel: "local mutation",
    expiry: "22 h 40 m",
    requested: "1 h 20 m ago",
    reminders: ["now", "15 min", "45 min", "3 h", "24 h"],
  },
];

const GRANTS = [
  { id: "grant-1", tool: "terminal.exec v3", agent: "Developer", scope: "workspace · this user", expiry: "in 5 h 12 m", created: "today 09:14", by: "runtime" },
  { id: "grant-2", tool: "web.search v2", agent: "Researcher", scope: "workspace · always allow (tool)", expiry: "revocable", created: "Sep 09", by: "runtime" },
];

const PROVIDERS = [
  { id: "prov-openai", name: "OpenAI", kind: "Built-in", status: "connected", detail: "Platform-funded · admin-supplied key", models: "GPT-4o, GPT-4o mini" },
  { id: "prov-anthropic", name: "Anthropic", kind: "Built-in", status: "not configured", detail: "Add a key to enable Claude models", models: "—" },
  { id: "prov-ollama", name: "Ollama (local)", kind: "Local", status: "connected", detail: "llama3:70b detected on localhost · no Shera credits", models: "llama3:70b, qwen2.5-coder" },
  { id: "prov-vllm", name: "vLLM box", kind: "OpenAI-compatible", status: "connected", detail: "http://192.168.1.42:8000/v1 · key masked · no Shera credits", models: "mixtral-8x22b", maskedKey: "sk-·······7f2a" },
];

const CREDITS = { balance: 1240, reserved: 85, usedMonth: 2430, customNote: "Custom-provider usage measured locally — never billed as Shera credits." };

const NOTIFICATIONS = [
  { id: "n1", kind: "approval", title: "Approval required — calendar.sync v2", body: "Study Planner · run-t1 · external write", when: "2 m", unread: true, link: "#/agent/study-planner" },
  { id: "n2", kind: "success", title: "Run succeeded — literature sweep", body: "Research Paper · run-2 · 4 artifacts · 118 credits", when: "1 d", unread: true, link: "#/operation/op-research-paper" },
  { id: "n3", kind: "failed", title: "Run failed — provider timeout", body: "Ad-hoc · run-4 paused after retry 2 of 3", when: "3 h", unread: true, link: "#/operation/op-adhoc" },
  { id: "n4", kind: "recovery", title: "Recovery needs review", body: "Exam Preparation · run-2b resumed from last safe step", when: "yesterday", unread: false, link: "#/operation/op-exam-prep" },
];

const MEMORY = {
  shared: [
    { id: "m1", text: "User prefers APA 7 for all coursework and wants citations checked against the source index before drafting.", prov: "remembered from Research Paper · run 1 · Sep 09", scope: "workspace" },
    { id: "m2", text: "Exam window confirmed: Nov 3–7. Study Planner owns the countdown schedule.", prov: "remembered from chat with Study Planner · Sep 10", scope: "workspace" },
    { id: "m3", text: "User's GPU box (vLLM) is the preferred provider for long local coding sessions.", prov: "remembered from Settings change · Sep 08", scope: "workspace" },
  ],
  private: [
    { id: "mp1", agent: "researcher", text: "User's thesis angle: energy-efficient scheduling — prioritize recent (2024+) sources when comparing authority.", prov: "remembered from direct chat · Sep 10 · private to Researcher" },
  ],
  publishQueue: [
    { id: "pq1", agent: "researcher", text: "arXiv preprint server layout changed — monitor sweep updated.", prov: "private memory · requested for publication to Research Paper", sensitive: false },
  ],
};

const SCHEDULES = [
  { id: "s1", name: "Literature sweep — weekly", detail: "Researcher · Mondays 07:00 · monitors 6 configured sources", active: true, trigger: "schedule" },
  { id: "s2", name: "research/ folder watcher", detail: "Runs claim extraction when a new PDF lands in workspace://research", active: true, trigger: "file change" },
  { id: "s3", name: "GitHub push → build check", detail: "Developer · on push to agent/* branches", active: false, trigger: "webhook" },
];

const TOOLS = [
  { name: "web.search", version: "v2", owner: "built-in", scope: "shared", risk: "read", riskLabel: "read-only", note: "runs automatically" },
  { name: "browser.drive", version: "v2", owner: "built-in", scope: "shared", risk: "read", riskLabel: "read-only", note: "read-only live view" },
  { name: "file.write", version: "v1", owner: "built-in", scope: "shared", risk: "mutat", riskLabel: "local mutation", note: "preview + approval" },
  { name: "terminal.exec", version: "v3", owner: "built-in", scope: "shared", risk: "exec", riskLabel: "code execution", note: "command + workdir + resource policy" },
  { name: "repo.merge", version: "v1", owner: "built-in", scope: "shared", risk: "repo", riskLabel: "repo mutation", note: "merge review required" },
  { name: "docx.export", version: "v1", owner: "built-in", scope: "shared", risk: "ext", riskLabel: "external write", note: "approval required" },
  { name: "litreview.rank", version: "v1", owner: "Researcher", scope: "private", risk: "read", riskLabel: "read-only", note: "agent-created · active grant" },
  { name: "pdf.extract", version: "v3", owner: "Researcher", scope: "shared", risk: "read", riskLabel: "read-only", note: "agent-created · shared inventory" },
];

const TOOL_HISTORY = [
  { tool: "web.search v2", agent: "Researcher", args: "\"graph neural networks survey 2024..2025\"", status: "succeeded", risk: "read", when: "09:41", auto: true },
  { tool: "browser.drive v2", agent: "Researcher", args: "open arxiv.org/abs/2405.12345 · extract abstract", status: "succeeded", risk: "read", when: "09:44", auto: true },
  { tool: "file.write v1", agent: "Developer", args: "patch src/auth/middleware.ts (+18 −6)", status: "waiting approval", risk: "mutat", when: "10:02", auto: false },
  { tool: "terminal.exec v3", agent: "Developer", args: "npm test -- auth · worktree wt/auth-fix", status: "succeeded", risk: "exec", when: "10:05", auto: true },
  { tool: "terminal.exec v3", agent: "Developer", args: "npm run lint · worktree wt/auth-fix", status: "succeeded", risk: "exec", when: "10:06", auto: true },
  { tool: "docx.export v1", agent: "Researcher", args: "evidence-table.csv → xlsx", status: "proposed", risk: "ext", when: "10:12", auto: false },
];

const PROJECTS = [
  { name: "shera-bot", repo: "git@github.com:you/shera-bot.git", credential: "deploy key · ····9f2a", visibility: "shared", branch: "main", worktree: "wt/auth-fix (agent branch)" },
  { name: "thesis-notes", repo: "local archive", credential: "—", visibility: "restricted · Researcher, Citation Manager", branch: "—", worktree: "—" },
];

const BACKUPS = { every: "every 6 hours", keep: 7, latest: [
  { id: "snap-7", when: "today 06:00", size: "3.1 GB" },
  { id: "snap-6", when: "today 00:00", size: "3.0 GB" },
  { id: "snap-5", when: "yesterday 18:00", size: "2.9 GB" },
]};

/* ---------- Agent profile panel ---------- */
/* Sample session history for the Agent profile panel. Display fixtures only —
   not a runtime session log. Kept consistent with THREADS/RUNS scenarios above. */
const AGENT_SESSIONS = {
  "general-assistant": [
    { when: "Today 08:02", title: "Morning status review", detail: "Summarized 3 Operations · opened the calendar approval", outcome: "done" },
    { when: "Yesterday 20:15", title: "Evening planning", detail: "Prepared today's job list and follow-ups", outcome: "done" },
  ],
  "researcher": [
    { when: "Today 07:40", title: "Morning source monitor sweep", detail: "run-s1 · 2 new papers filed to research/inbox", outcome: "done" },
    { when: "Today 09:12", title: "Literature folding & re-ranking", detail: "Current session — ranking sources by recency and authority", outcome: "active" },
  ],
  "developer": [
    { when: "Today 10:05", title: "Auth middleware patch session", detail: "run-d1 · failing test first, then the guard fix", outcome: "active" },
    { when: "Yesterday 16:30", title: "Test harness maintenance", detail: "Flaky session test quarantined", outcome: "done" },
  ],
  "citation-manager": [
    { when: "Yesterday 18:44", title: "Citation index refresh", detail: "41 sources re-checked · 3 APA 7 drifts corrected", outcome: "done" },
  ],
  "programming-tutor": [
    { when: "Today 19:10", title: "Hash-table quiz", detail: "Current session — 3 questions on lookup, load factor, caching", outcome: "active" },
  ],
  "study-planner": [
    { when: "Today 21:58", title: "Exam-window replan", detail: "12 blocks planned · calendar push waiting for approval", outcome: "attention" },
    { when: "Yesterday 09:00", title: "Weekly schedule check", detail: "Progress against diagnostic areas reviewed", outcome: "done" },
  ],
};

/* ---------- Threads ---------- */
/* Item kinds: msg(user|agent) · system · tool · run · artifact · approval · replay · day */

const THREADS = {
  "agent-researcher": [
    { kind: "day", label: "Today" },
    { kind: "system", text: "Session resumed · scheduled monitor sweep completed at 07:40" },
    {
      kind: "run", run: "run-s1", goal: "Morning source monitor sweep", state: "SUCCEEDED", credits: 9, artifacts: 1, duration: "6 m 12 s",
      steps: [
        { label: "Checked 6 configured sources", state: "done" },
        { label: "2 new papers matched topic filter", state: "done" },
        { label: "Abstracts filed to research/inbox", state: "done", checkpoint: true },
      ],
    },
    {
      kind: "msg", from: "agent", agent: "researcher",
      text: "Overnight sweep found 2 new papers on energy-efficient scheduling. Both are 2025 publications, so they rank above the 2023 survey you had flagged.\n\nI compared authority: one is a journal article (peer-reviewed), the other a preprint. I marked the preprint as *pending review* in the evidence table rather than treating it as settled.",
    },
    {
      kind: "tool", tool: "web.search", version: "v2", agent: "researcher", risk: "read", riskLabel: "read-only",
      args: "\"energy-efficient scheduling\" 2025 · filtered: peer-review preferred",
      status: "succeeded", statusLabel: "Ran automatically", when: "07:41",
    },
    {
      kind: "tool", tool: "browser.drive", version: "v2", agent: "researcher", risk: "read", riskLabel: "read-only",
      args: "arxiv.org/abs/2501.02993 · extract abstract + affiliations",
      status: "succeeded", statusLabel: "Ran automatically", when: "07:44",
      extra: "Page is open in the workspace Browser tab (read-only live view).",
    },
    {
      kind: "artifact", name: "source-delta-0911.md", size: "14 KB", producer: "researcher", from: "run-s1",
    },
    { kind: "msg", from: "user", text: "Good. Fold both into the lit review, and re-rank the table by recency then authority. Keep the preprint visually distinct.", time: "09:12" },
    {
      kind: "msg", from: "agent", agent: "researcher", streaming: true,
      text: "Folding both in now. Ranking order will be recency → venue authority → citation count. The preprint gets a",
      note: "streaming",
    },
  ],

  "agent-developer": [
    { kind: "day", label: "Today" },
    {
      kind: "run", run: "run-d1", goal: "Patch auth middleware + green tests", state: "RUNNING", credits: 23, artifacts: 1, duration: "18 m 52 s", live: true,
      steps: [
        { label: "Created worktree wt/auth-fix from agent/developer", state: "done", checkpoint: true },
        { label: "Reproduced the session-refresh bug with a failing test", state: "done", checkpoint: true },
        { label: "Patched middleware (diff awaiting approval)", state: "now" },
        { label: "Full test suite + lint", state: "" },
        { label: "Merge review → main (needs your approval)", state: "" },
      ],
    },
    {
      kind: "msg", from: "agent", agent: "developer",
      text: "Reproduced it: the refresh path trusted the clock skew guard even when the token was already expired. I wrote a failing test first, then patched the guard.\n\nThe patch touches `src/auth/middleware.ts` on my worktree branch. Per policy I can't apply it to the shared checkout until you approve the local mutation.",
    },
    {
      kind: "tool", tool: "file.write", version: "v1", agent: "developer", risk: "mutat", riskLabel: "local mutation",
      args: "src/auth/middleware.ts · +18 −6",
      status: "waiting approval", statusLabel: "Preview ready — approval required", when: "10:02",
      diff: [
        { t: "ctx", s: "function guard(req, tok) {" },
        { t: "del", s: "-  if (now() - tok.iat < SKEW) return allow(req);" },
        { t: "add", s: "+  if (expired(tok)) return deny(req, 'token_expired');" },
        { t: "add", s: "+  if (now() - tok.iat < SKEW) return allow(req);" },
        { t: "ctx", s: "  return verify(tok, req);" },
        { t: "ctx", s: "}" },
      ],
    },
    {
      kind: "tool", tool: "terminal.exec", version: "v3", agent: "developer", risk: "exec", riskLabel: "code execution",
      args: "npm test -- auth · worktree wt/auth-fix",
      status: "succeeded", statusLabel: "Ran automatically · scoped grant", when: "10:05",
      extra: "2 failed → 14 passed after patch. Command visible in workspace → Terminal.",
    },
    { kind: "msg", from: "user", text: "Approve the patch — but don't touch main until the full suite is green.", time: "10:20" },
  ],

  "agent-study-planner": [
    { kind: "day", label: "Today" },
    { kind: "msg", from: "user", text: "Rebuild my study plan around the Nov 3–7 exam window and push the blocks to my calendar.", time: "21:58" },
    {
      kind: "msg", from: "agent", agent: "study-planner",
      text: "Plan rebuilt: 12 blocks between Oct 14 and Nov 2, weighted toward Programming Assignment topics in week 2 (your weakest diagnostic area).\n\nPushing to Google Calendar is an external write, so the run is paused until you approve it.",
    },
    { kind: "approval", approval: "appr-1" },
  ],

  "agent-general-assistant": [
    { kind: "day", label: "Today" },
    { kind: "msg", from: "user", text: "What's the state of everything this morning?", time: "08:02" },
    {
      kind: "msg", from: "agent", agent: "general-assistant",
      text: "Short version:\n\n• Research Paper — run 3 is comparing sources; one export is paused for your approval.\n• Developer — auth patch on worktree wt/auth-fix, suite green, merge review pending.\n• Exam Preparation — schedule rebuild resumed from its last safe step after yesterday's restart and needs your review.\n\nSuggested first move: answer the calendar approval, then review the recovered run. I can open either one.",
    },
    { kind: "msg", from: "user", text: "Open the calendar one.", time: "08:03" },
    { kind: "system", text: "Jumped to Study Planner · run-t1" },
  ],

  "agent-citation-manager": [
    { kind: "day", label: "Yesterday" },
    {
      kind: "msg", from: "agent", agent: "citation-manager",
      text: "Citation index refreshed: 41 sources, all with provenance links. 3 entries had drifted from APA 7 — corrected. The evidence table and bibliography.json now match 1:1.",
    },
    { kind: "msg", from: "user", text: "Perfect. Keep the format audit on for every new import.", time: "18:44" },
  ],

  "agent-programming-tutor": [
    { kind: "day", label: "Today" },
    { kind: "msg", from: "user", text: "Quiz me on hash tables before the practice set.", time: "19:10" },
    {
      kind: "msg", from: "agent", agent: "programming-tutor",
      text: "Three quick ones:\n\n1. When does a hash table degrade to O(n) lookup?\n2. Why is a load factor of 0.75 a common resize trigger?\n3. Open addressing vs chaining — one trade-off that matters for cache behavior.\n\nAnswer in any order; I'll correct as we go. Local model (llama3) is answering, so this consumes no Shera credits.",
    },
  ],

  "op-research-paper": [
    { kind: "day", label: "2 days ago" },
    { kind: "system", text: "Operation launched from student pack v1 · preview confirmed" },
    { kind: "replay", n: 4 },
    {
      kind: "run", run: "run-1", goal: "Topic scoping & question definition", state: "SUCCEEDED", credits: 31, artifacts: 2, duration: "22 m 05 s", done: "2 days ago",
      steps: [
        { label: "Clarified research question with user", state: "done", checkpoint: true },
        { label: "Scoped 3 candidate angles", state: "done" },
      ],
    },
    { kind: "day", label: "Yesterday" },
    {
      kind: "run", run: "run-2", goal: "Literature sweep · graph neural networks", state: "SUCCEEDED", credits: 118, artifacts: 4, duration: "1 h 12 m", done: "yesterday",
      steps: [
        { label: "Swept 6 sources · 31 candidates", state: "done", checkpoint: true },
        { label: "Authority comparison · kept 14", state: "done", checkpoint: true },
        { label: "Evidence table drafted", state: "done", checkpoint: true },
      ],
    },
    {
      kind: "msg", from: "agent", agent: "researcher",
      text: "Literature sweep is done: 14 sources kept after authority comparison, 4 artifacts filed. Evidence table is in the shared workspace.",
    },
    {
      kind: "artifact", name: "literature-review.md", size: "86 KB", producer: "researcher", from: "run-2",
    },
    { kind: "day", label: "Today" },
    {
      kind: "run", run: "run-3", goal: "Comparative analysis of 14 sources", state: "WAITING_FOR_APPROVAL", credits: 42, artifacts: 1, duration: "41 m 17 s", live: true,
      steps: [
        { label: "Pairwise authority scoring · 14×14", state: "done", checkpoint: true },
        { label: "Draft comparison matrix", state: "done", checkpoint: true },
        { label: "Export matrix to xlsx — paused for approval", state: "now" },
      ],
    },
    {
      kind: "msg", from: "agent", agent: "researcher",
      text: "Comparison matrix is drafted. To keep a portable copy I want to write `evidence-table.xlsx` into the shared folder — a local mutation, so it's pausing here.",
    },
    { kind: "approval", approval: "appr-2" },
    {
      kind: "msg", from: "user", text: "@Citation Manager please pre-audit the matrix columns against the index while we wait.", time: "10:40", addressed: "citation-manager",
    },
    {
      kind: "msg", from: "agent", agent: "citation-manager",
      text: "On it — column labels match the index; two author names need diacritics restored. I'll hold the fix until the export is approved so we don't collide on the same file.",
    },
  ],

  "op-adhoc": [
    { kind: "day", label: "Today" },
    { kind: "system", text: "Ad-hoc Operation created · roster: Programming Tutor + General Assistant" },
    { kind: "msg", from: "user", text: "Build me a practice set on hashing for tomorrow. @Programming Tutor own the questions.", time: "18:02", addressed: "programming-tutor" },
    {
      kind: "msg", from: "agent", agent: "programming-tutor",
      text: "Taking the question set: 12 items, mix of recall and tracing. I'll generate locally — no Shera credits.",
    },
    {
      kind: "run", run: "run-2a", goal: "Practice set generation · hashing", state: "RUNNING", credits: 17, artifacts: 1, duration: "09 m 03 s", live: true,
      steps: [
        { label: "Diagnostic recap from last session", state: "done", checkpoint: true },
        { label: "Generating 12 questions + answer key", state: "now" },
      ],
    },
    {
      kind: "msg", from: "agent", agent: "general-assistant",
      text: "Heads up: run-4 hit a provider timeout twice. It's retrying (attempt 2 of 3); if the third attempt fails it will pause and notify rather than loop.",
    },
    {
      kind: "run", run: "run-4", goal: "Explain DP vs greedy with examples", state: "RETRYING", credits: 5, artifacts: 0,
      note: "Transient provider failure · attempt 2 of 3 · bounded backoff",
    },
  ],

  "op-exam-prep": [
    { kind: "day", label: "Yesterday" },
    { kind: "system", text: "Container restarted · workspace remounted · schedules restored without duplication" },
    {
      kind: "msg", from: "agent", agent: "study-planner",
      text: "The syllabus changed on short notice, so I started a schedule rebuild. The container restarted mid-run; the runtime could not prove the last external call was safe to replay, so run 2b resumed from the last safe step and now needs your review.",
    },
    {
      kind: "run", run: "run-2b", goal: "Schedule rebuild after syllabus change", state: "RECOVERY_REQUIRED", credits: 8, artifacts: 0,
      steps: [
        { label: "Parsed updated syllabus PDF", state: "done", checkpoint: true },
        { label: "Diffed old vs new exam weightings", state: "done", checkpoint: true },
        { label: "Restart marker · resumed from last safe step", state: "fail" },
        { label: "Calendar write — held for review", state: "" },
      ],
    },
  ],
};

/* ---------- Workspace ---------- */
const WORKSPACE = {
  tree: [
    { depth: 0, type: "folder", name: "workspace", open: true },
    { depth: 1, type: "folder", name: "research", open: true },
    { depth: 2, type: "file", name: "literature-review.md", size: "86 KB" },
    { depth: 2, type: "file", name: "evidence-table.csv", size: "22 KB" },
    { depth: 2, type: "file", name: "papers", folder: true },
    { depth: 3, type: "file", name: "gnn-survey-2024.pdf", size: "2.1 MB" },
    { depth: 1, type: "folder", name: "projects", open: true },
    { depth: 2, type: "folder", name: "shera-bot", open: true },
    { depth: 3, type: "file", name: "src/auth/middleware.ts", size: "11 KB", lease: "Developer is editing this file · task #4" },
    { depth: 3, type: "file", name: "package.json", size: "3 KB" },
    { depth: 2, type: "folder", name: "exam-prep" },
    { depth: 1, type: "folder", name: "artifacts" },
    { depth: 2, type: "file", name: "source-delta-0911.md", size: "14 KB" },
  ],
  editorFile: "workspace/projects/shera-bot/src/auth/middleware.ts",
  editorContent: `import type { NextRequest } from "next/server/next-request";

const SKEW_MS = 30_000;

export function guard(req: NextRequest, tok: AuthToken) {
  // FAILING TEST FIRST: expired tokens slipped through the skew window.
  if (expired(tok)) return deny(req, "token_expired");
  if (now() - tok.iat < SKEW_MS) return allow(req);
  return verify(tok, req);
}`,
  terminalLines: [
    { cls: "dim", s: "# read-only live view · commands executed by agents" },
    { cls: "", s: "" },
    { cls: "p", s: "developer@wt-auth-fix", extra: ":~/workspace/projects/shera-bot$ " },
    { cls: "cmd", s: "npm test -- auth" },
    { cls: "dim", s: "> shera-bot@0.3.0 test" },
    { cls: "", s: "  auth/middleware.test.ts" },
    { cls: "", s: "    ✓ rejects expired token inside skew window" },
    { cls: "", s: "    ✓ allows fresh token within clock skew" },
    { cls: "", s: "" },
    { cls: "", s: "  Test Files  1 passed (1)" },
    { cls: "", s: "       Tests  14 passed (14)" },
    { cls: "warnline", s: "⏸ next command held: git add -A · repo mutation · approval required" },
    { cls: "", s: "" },
    { cls: "p", s: "developer@wt-auth-fix", extra: ":~/workspace/projects/shera-bot$ " },
  ],
  browser: { url: "https://arxiv.org/abs/2501.02993", title: "Energy-Efficient Scheduling via Graph Partitioning" },
  privateAgents: ["researcher", "developer", "citation-manager", "programming-tutor", "study-planner", "general-assistant"],
  privateFiles: {
    researcher: ["memory/journal.md", "skills/source-ranking.md", "notes/topic-angle.md"],
    developer: ["memory/decisions.md", "skills/test-harness.md"],
  },
};

const CHATS = {
  list: [
    { id: "agent-general-assistant", type: "agent", ref: "general-assistant" },
    { id: "agent-researcher", type: "agent", ref: "researcher" },
    { id: "agent-developer", type: "agent", ref: "developer" },
    { id: "agent-citation-manager", type: "agent", ref: "citation-manager" },
    { id: "agent-programming-tutor", type: "agent", ref: "programming-tutor" },
    { id: "agent-study-planner", type: "agent", ref: "study-planner" },
    { id: "op-research-paper", type: "operation", ref: "research-paper", name: "Research Paper · run 3", runs: 3, state: "waiting" },
    { id: "op-adhoc", type: "operation", ref: "adhoc", name: "Ad-hoc · 2 Agents", runs: 2, state: "running" },
    { id: "op-exam-prep", type: "operation", ref: "exam-preparation", name: "Exam Preparation", runs: 2, state: "recovery" },
  ],
};
