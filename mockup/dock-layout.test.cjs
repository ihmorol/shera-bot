/* Run: node --test mockup/dock-layout.test.cjs (no packages required). */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const context = vm.createContext({ App: { state: { dock: {} } } });
for (const file of ["data.js", "icons.js", "views.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context, { filename: file });
}
const L = vm.runInContext("DockLayout", context);
const json = value => JSON.parse(JSON.stringify(value));

test("dock width bounds track the available width — no artificial cap", () => {
  assert.deepEqual(json(L.widthBounds(1440)), { min: 320, max: 1440 });
  assert.deepEqual(json(L.widthBounds(701)), { min: 320, max: 701 });
  assert.deepEqual(json(L.widthBounds(300)), { min: 300, max: 300 });
  assert.deepEqual(json(L.widthBounds(0)), { min: 0, max: 0 });
});

test("rendering clamps a saved width to keep the chat usable without mutating it", () => {
  const d = { width: 720 };
  const bounds = L.widthBounds(800);
  const shown = L.clamp(d.width, bounds.min, Math.max(bounds.min, bounds.max - L.defaults.chatMin));
  assert.equal(shown, 480);
  assert.equal(d.width, 720);
});

test("dragging past the chat threshold fills the dock and keeps the pre-fill width", () => {
  const d = { width: 700 };
  L.setOuterWidth(d, 1000, 1440);       // below the threshold (1120) — normal resize
  assert.equal(d.fill, undefined);
  assert.equal(d.width, 1000);
  L.setOuterWidth(d, 1200, 1440);       // past the threshold — dock fills the main area
  assert.equal(d.fill, true);
  assert.equal(d.width, 1000);          // Back to chat restores this
  L.setOuterWidth(d, 1440, 1440);       // pinned at full width
  assert.equal(d.fill, true);
});

test("any shrink leaves fill mode at the chat minimum, then tracks the pointer", () => {
  const d = { width: 700, fill: true };
  L.setOuterWidth(d, 1440, 1440);
  assert.equal(d.fill, true);           // still pinned
  L.setOuterWidth(d, 1300, 1440);
  assert.equal(d.fill, false);
  assert.equal(d.width, 1120);          // chat returns at its minimum
  L.setOuterWidth(d, 900, 1440);
  assert.equal(d.width, 900);
});

test("a continuous drag holds fill while widening and leaves it on a narrowing move", () => {
  const d = { width: 1000 };
  L.setOuterWidth(d, 1150, 1440);        // crosses the threshold (1120) mid-drag
  assert.equal(d.fill, true);
  L.setOuterWidth(d, 1250, 1440, 1150);  // still widening — stays filled
  assert.equal(d.fill, true);
  L.setOuterWidth(d, 1440, 1440, 1250);  // pinned at full width
  assert.equal(d.fill, true);
  L.setOuterWidth(d, 1200, 1440, 1440);  // pointer reverses — hands space back
  assert.equal(d.fill, false);
  assert.equal(d.width, 1120);
  L.setOuterWidth(d, 800, 1440, 1200);   // keeps tracking the pointer
  assert.equal(d.width, 800);
});

test("leaveFill restores the last chosen width and reset clears fill", () => {
  const d = { width: 620, fill: true };
  L.leaveFill(d);
  assert.equal(d.fill, false);
  assert.equal(d.width, 620);
  const fresh = { fill: true };
  L.leaveFill(fresh);
  assert.equal(fresh.width, null, "no chosen width — falls back to the proportional default");
  const r = { width: 900, fill: true, column: 0.7, panels: [{ type: "files", collapsed: true }] };
  L.reset(r);
  assert.equal(r.fill, false);
  assert.equal(r.width, null);
});

test("one/two panels stack and three through six keep deterministic groups", () => {
  for (let n = 1; n <= 6; n++) {
    const panels = Array.from({ length: n }, (_, i) => ({ type: String(i) }));
    const cols = L.columns(panels);
    assert.equal(cols.length, n <= 2 ? 1 : 2);
    assert.deepEqual(json(cols.flat()), panels);
  }
});

test("row heights use proportions and spend all available space", () => {
  const sizes = L.heights([{ type: "a", weight: 1 }, { type: "b", weight: 2 }], 610);
  assert.equal(sizes.get("a"), 200);
  assert.equal(sizes.get("b"), 400);
});

test("minimums redistribute remaining space rather than compress bodies", () => {
  const sizes = L.heights([{ type: "a", weight: 0.01 }, { type: "b", weight: 3 }, { type: "c", weight: 1 }], 620);
  assert.equal(sizes.get("a"), 144);
  assert.equal(sizes.get("b"), 312);
  assert.equal(sizes.get("c"), 144);
  assert.equal([...sizes.values()].reduce((a, b) => a + b, 0), 600);
});

test("short viewports overflow with usable body minimums", () => {
  const sizes = L.heights([{ type: "a" }, { type: "b" }, { type: "c" }], 200);
  assert.deepEqual([...sizes.values()], [144, 144, 144]);
});

test("collapsed panel is header-only and donates space to siblings", () => {
  const panels = [{ type: "a", collapsed: true, weight: 2 }, { type: "b", weight: 1 }];
  const sizes = L.heights(panels, 610);
  assert.equal(sizes.get("a"), 46);
  assert.equal(sizes.get("b"), 554);
  assert.equal(panels[0].weight, 2);
});

test("all collapsed panels remain reachable headers without filling empty space", () => {
  const sizes = L.heights([{ type: "a", collapsed: true }, { type: "b", collapsed: true }], 610);
  assert.deepEqual([...sizes.values()], [46, 46]);
});

test("maximize/restore and collapse/expand preserve row and column preferences", () => {
  const d = { width: 720, column: 0.6, panels: [{ type: "a", weight: 2 }, { type: "b", weight: 1 }] };
  L.toggleCollapse(d, "a");
  L.toggleMax(d, "a");
  assert.equal(d.panels[0].collapsed, true);
  assert.equal(d.panels[0].max, true);
  L.toggleMax(d, "a");
  L.toggleCollapse(d, "a");
  assert.equal(d.panels[0].max, false);
  assert.equal(d.panels[0].collapsed, false);
  assert.equal(d.panels[0].weight, 2);
  assert.equal(d.column, 0.6);
  assert.equal(d.width, 720);
});

test("reset affects only the selected chat and keeps its panels", () => {
  const a = { width: 720, column: 0.6, panels: [{ type: "editor", weight: 2, collapsed: true, max: true }] };
  const b = { width: 510, panels: [{ type: "terminal", collapsed: true }] };
  const before = JSON.stringify(b);
  L.reset(a);
  assert.equal(a.width, null, "reset returns the width to the 30% proportional default");
  assert.equal(a.column, 0.5);
  assert.deepEqual(a.panels, [{ type: "editor", collapsed: false, max: false }]);
  assert.equal(JSON.stringify(b), before);
});

test("keyboard steps, endpoints and reset stay bounded", () => {
  assert.equal(L.keyValue("ArrowRight", 400, 320, 440, 460, 16), 416);
  assert.equal(L.keyValue("ArrowLeft", 330, 320, 440, 460, 48), 320);
  assert.equal(L.keyValue("ArrowUp", 400, 320, 440, 460, 16), 384);
  assert.equal(L.keyValue("ArrowDown", 400, 320, 440, 460, 48), 440);
  assert.equal(L.keyValue("Home", 400, 320, 440, 460, 16), 320);
  assert.equal(L.keyValue("End", 400, 320, 440, 460, 16), 440);
  assert.equal(L.keyValue("Enter", 400, 320, 440, 460, 16), 440);
  assert.equal(L.keyValue("Tab", 400, 320, 440, 460, 16), null);
});

test("timeline supports empty chats and ignores a different chat's selected run", () => {
  const empty = vm.runInContext(`Views.workspaceFull({ id: "empty-chat" }, { selRun: "run-1" }, "tasks")`, context);
  assert.match(empty, /No task runs in this chat yet/);
  const ownRun = vm.runInContext('RUNS.find(r => r.chat === "agent-developer")', context);
  const otherRun = vm.runInContext('RUNS.find(r => r.chat !== "agent-developer")', context);
  context.testState = { selRun: otherRun.id };
  const html = vm.runInContext('Views.workspaceFull({ id: "agent-developer" }, testState, "tasks")', context);
  assert.ok(html.includes(ownRun.goal));
  assert.ok(!html.includes(otherRun.goal));
});

test("dock renders named focusable separators and independent collapse controls", () => {
  context.App = { state: { dock: { "agent-developer": { open: true, width: 700, panels: [{ type: "files" }, { type: "editor" }, { type: "terminal" }] } } } };
  const html = vm.runInContext('Views.dockView({ id: "agent-developer" }, App.state)', context);
  for (const kind of ["outer", "row", "column"]) assert.ok(html.includes(`data-dock-resize="${kind}"`));
  assert.equal((html.match(/role="separator"/g) || []).length, 3);
  assert.equal((html.match(/data-action="dock-collapse"/g) || []).length, 3);
  assert.match(html, /aria-describedby="dock-resize-help"/);
});

test("resize controls live in the Add panel menu, not the dock head", () => {
  context.App = { state: { dock: { "agent-developer": { open: true, width: 700, panels: [{ type: "files" }, { type: "editor" }, { type: "terminal" }] } }, dockAdd: "agent-developer", profileMuted: {} } };
  const html = vm.runInContext('Views.dockView({ id: "agent-developer" }, App.state)', context);
  assert.ok(!html.includes("dock-sizing"), "the Resize panels disclosure is gone from the dock head");
  assert.match(html, /Resize panels/);
  assert.match(html, /Decrease selected size/);
  assert.match(html, /Increase selected size/);
  assert.match(html, /Left column width/);
});

test("chat topbar: icon search opens a modal; model stays in the composer; account rows", () => {
  context.App = { state: { dock: { "agent-developer": { open: true, width: 440, panels: [{ type: "profile" }] } }, profileMuted: {}, conn: "live", searchOpen: false, searchQuery: "" } };
  const chat = vm.runInContext('Views.chatScreen({ id: "agent-developer", type: "agent", ref: "developer" }, App.state)', context);
  assert.equal((chat.match(/id="model-select"/g) || []).length, 1, "model select appears once");
  assert.match(chat, /composer-model/, "model picker lives in the composer");
  assert.match(chat, /data-action="open-search"/, "search is an icon button");
  assert.ok(!chat.includes("tb-search"), "the inline search field is gone");
  assert.match(chat, /tb-account/, "avatar-only account button");
  assert.match(chat, /class="notif"/, "unread count shows on the avatar");
  assert.ok(!chat.includes("workspace-dock"), "the dock is no longer a child of the chat window");
  const modal = vm.runInContext('Views.searchModal(App.state)', context);
  assert.match(modal, /search-modal-input/);
  assert.match(modal, /General Assistant/, "unfiltered palette lists chats");
  assert.match(modal, /not message contents/, "scope is stated honestly in the footer");
  context.App.state.searchQuery = "prov";
  const filtered = vm.runInContext('Views.searchModal(App.state)', context);
  assert.match(filtered, /Providers &amp; models/, "labels render escaped");
  assert.ok(!filtered.includes("General Assistant</b>"), "non-matching chats are filtered out");
  const pop = vm.runInContext('Views.accountPop()', context);
  assert.match(pop, /toggle-theme/, "theme toggle lives in the account menu");
  assert.match(pop, /open-notifs/, "notifications live in the account menu");
  assert.match(pop, /open-demo/, "demo controls live in the account menu");
});

test("dock head carries the Back to chat control that exits fill mode", () => {
  context.App = { state: { dock: { "agent-developer": { open: true, width: 440, fill: true, panels: [{ type: "files" }] } } } };
  const html = vm.runInContext('Views.dockView({ id: "agent-developer" }, App.state)', context);
  assert.match(html, /data-action="dock-chat"/);
  assert.match(html, /Back to chat/);
  assert.match(html, /--dock-w:100%/);
});

test("agent profile panel renders identity, quick actions and collapsible sections", () => {
  context.App = { state: { dock: {}, profileMuted: {} } };
  const html = vm.runInContext(
    'Views.dockBody("profile", { id: "agent-general-assistant", type: "agent", ref: "general-assistant" }, App.state, false)', context);
  assert.match(html, /General Assistant/);
  assert.match(html, /Coordinator · planning &amp; synthesis/, "ampersands render escaped");
  for (const action of ["profile-message", "profile-new-run", "dock-add", "profile-mute"]) {
    assert.ok(html.includes(`data-action="${action}"`), `missing ${action}`);
  }
  assert.match(html, /href="#\/settings\/agents"/);
  assert.match(html, /href="#\/workspace\/agent-general-assistant"/);
  assert.match(html, /aria-pressed="false"/);
  const sections = [...html.matchAll(/<details class="prof-sec"[^>]*>\s*<summary>[\s\S]*?<span>([^<]+)<\/span>/g)].map(m => m[1]);
  assert.deepEqual(sections, ["Files", "Ongoing tasks", "Session history"]);
  // General Assistant has no seeded runs — the panel must say so instead of inventing one.
  assert.match(html, /No active task runs in this chat/);
  assert.match(html, /Sample session history — mockup fixture/);
});

test("profile mute reflects in-memory state and ongoing tasks list current-chat runs", () => {
  context.App = { state: { dock: {}, profileMuted: { "study-planner": true } } };
  const html = vm.runInContext(
    'Views.dockBody("profile", { id: "agent-study-planner", type: "agent", ref: "study-planner" }, App.state, false)', context);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, />Unmute<\/button>/);
  assert.match(html, /run-t1/);
  assert.match(html, /Waiting approval/);
});

test("profile panel on an Operation chat shows the roster instead of an Agent identity", () => {
  context.App = { state: { dock: {}, profileMuted: {} } };
  const html = vm.runInContext(
    'Views.dockBody("profile", { id: "op-research-paper", type: "operation", ref: "research-paper" }, App.state, false)', context);
  assert.match(html, /Research Paper/);
  assert.match(html, /Roster/);
  assert.match(html, /Coordinator/);
  assert.ok(!html.includes("data-action=\"profile-mute\""), "mute is an Agent-level control");
});

test("agent chat header and full-page workspace expose the profile", () => {
  context.App = { state: { dock: { "agent-developer": { open: true, width: 440, panels: [{ type: "profile" }] } }, profileMuted: {} } };
  const chat = vm.runInContext('Views.chatScreen({ id: "agent-developer", type: "agent", ref: "developer" }, App.state)', context);
  assert.match(chat, /data-action="profile-open"/);
  assert.match(chat, /View Agent profile/);
  const full = vm.runInContext('Views.workspaceFull({ id: "agent-developer", type: "agent", ref: "developer" }, App.state, "profile")', context);
  assert.match(full, /Agent profile/);
  assert.match(full, /href="#\/workspace\/agent-developer\/files"/);
  const grid = full.match(/<div class="pa-grid"[\s\S]*?<\/div>/)[0];
  assert.ok(!grid.includes('href="#/workspace/agent-developer"'), "full page hides its own link from quick actions");
});

test("sidebar groups Operations into Templates and Active chats with labeled controls", () => {
  const html = vm.runInContext('Views.sidebar({ route: "agent-general-assistant", sideRail: false, sideOpen: false, conn: "live" })', context);
  assert.match(html, /<div class="sb-group-label">Templates<\/div>/);
  assert.match(html, /<div class="sb-group-label">Active chats<\/div>/);
  assert.match(html, /aria-label="Agent settings"/);
  assert.match(html, /aria-label="New ad-hoc Operation"/);
  assert.match(html, /student pack v1 · pinned/);
  assert.ok(html.includes("conn-chip"), "connection renders as a labeled status chip");
  assert.ok(!html.includes("Simulate connection change"), "demo connection control stays in the Demo menu, not the status footer");
});

test("esc escapes markup-significant characters", () => {
  context.testInput = "<img src=x onerror=alert(1)>&\"'";
  assert.equal(
    vm.runInContext("Views.esc(testInput)", context),
    "&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;"
  );
  assert.equal(vm.runInContext('Views.esc(null)', context), "");
});

test("every internal link in rendered views resolves to a real route", () => {
  context.App = {
    state: {
      route: "overview", theme: "dark", conn: "live", recovery: true, storageWarn: true,
      sideOpen: false, sideRail: false, searchOpen: false, searchQuery: "",
      dock: {
        "op-research-paper": { open: true, panels: [{ type: "runs" }, { type: "tools" }] },
        "agent-general-assistant": { open: true, panels: [{ type: "profile" }] },
        "agent-researcher": { open: true, panels: [{ type: "profile" }] },
        "agent-developer": { open: true, panels: [{ type: "profile" }] },
        "agent-citation-manager": { open: true, panels: [{ type: "profile" }] },
        "agent-programming-tutor": { open: true, panels: [{ type: "profile" }] },
        "agent-study-planner": { open: true, panels: [{ type: "profile" }] },
        "op-adhoc": { open: true, panels: [{ type: "runs" }] },
        "op-exam-prep": { open: true, panels: [{ type: "runs" }] },
      },
      profileMuted: {}, setSection: "account", adhocRoster: ["general-assistant"], resolved: {},
    },
  };
  const chatIds = vm.runInContext('CHATS.list.map(c => c.id)', context);
  const surfaces = [
    "Views.sidebar(App.state)",
    "Views.notifications()",
    "Views.overview(App.state)",
    "Views.banners(App.state)",
    ...chatIds.map(id => `Views.chatScreen(CHATS.list.find(c => c.id === "${id}"), App.state)`),
  ];
  const hrefs = new Set();
  for (const expr of surfaces) {
    const html = vm.runInContext(expr, context);
    for (const m of html.matchAll(/(?:href|data-href)="(#[^"]*)"/g)) hrefs.add(m[1]);
  }
  const valid = new Set(["#/overview", "#/app", "#/operation/new", "#/login", "#/settings", ...chatIds.map(id => "#/" + id)]);
  const bad = [...hrefs].filter(h => {
    if (valid.has(h)) return false;
    if (/^#\/settings\/[a-z-]+$/.test(h)) return false; // known settings sections
    if (new RegExp(`^#\/workspace\/(${chatIds.join("|")})(\/[a-z]+)?$`).test(h)) return false;
    return true;
  });
  assert.deepEqual(bad, [], "no link may point at a route the router cannot resolve");
});
