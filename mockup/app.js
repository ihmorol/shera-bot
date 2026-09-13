/* ============================================================
   Shera Bot UI mockup — app controller
   Hash router + state + event delegation + scripted demo runtime.
   ============================================================ */

const App = (function () {
  const I = Icons.get;
  const V = Views;

  const state = {
    route: "login",
    theme: document.documentElement.getAttribute("data-theme") || "dark",
    sideOpen: false,
    sideRail: false,         // desktop: sidebar collapsed to icon rail
    conn: "live",            // live | reconnecting | offline
    recovery: true,          // S11 banner
    storageWarn: true,
    loginCap: false,
    previewId: null,
    overlay: null,           // "preview" | "approval:<id>" | null
    pop: null,               // "notifs" | "account" | "demo" | null
    searchOpen: false,       // search modal (command palette)
    searchQuery: "",
    dock: {                  // per-chat workspace dock state (width defaults to 30% of the app)
      "op-research-paper": { open: true, panels: [{ type: "runs" }, { type: "tools" }] },
      "agent-general-assistant": { open: true, panels: [{ type: "profile" }] },
      "agent-researcher": { open: true, panels: [{ type: "profile" }] },
      "agent-developer": { open: true, panels: [{ type: "profile" }] },
      "agent-citation-manager": { open: true, panels: [{ type: "profile" }] },
      "agent-programming-tutor": { open: true, panels: [{ type: "profile" }] },
      "agent-study-planner": { open: true, panels: [{ type: "profile" }] },
    },
    dockAdd: null,           // chatId with the add-panel menu open
    profileMuted: {},        // agentId → muted (in-memory mockup preference)
    focusComposer: null,     // chatId awaiting composer focus after a route change
    wsPrivateAgent: "researcher",
    selRun: null,
    setSection: "account",
    adhocRoster: ["general-assistant"],
    resolved: {},            // approvalId → "approve:<grant>" | "reject" | "cancel"
    streaming: null,         // interval id
  };

  const appEl = document.getElementById("app");
  const workspaceSnapshots = new Map();
  let cancelDockDrag = null;
  let dockObserver = null;

  // Scope preservation to workspace/chat surfaces; unrelated screens keep their behavior.
  function workspaceSnapshot() {
    const root = document.getElementById("app");
    if (!root) return null;
    const fields = [...root.querySelectorAll('textarea, select:not([data-action="select-run"])')].map(el => ({
      key: el.id || (el.closest("[data-panel]")?.dataset.panel || "full") + ":" + el.className,
      value: el.value, start: el.selectionStart, end: el.selectionEnd,
      height: el.style.height, focus: el === document.activeElement,
    }));
    const scroll = [...root.querySelectorAll(".thread, .dp-body, .dock-body, .dock-col, .ws-body, textarea")]
      .filter(el => !el.closest("[hidden]"))
      .map(el => ({ key: el.id || (el.closest("[data-panel]")?.dataset.panel || "full") + ":" + el.className,
        top: el.scrollTop, left: el.scrollLeft }));
    return { fields, scroll };
  }
  function saveWorkspace(route, snapshot) {
    if (!snapshot) return;
    const previous = workspaceSnapshots.get(route);
    if (previous) {
      snapshot.fields = [...previous.fields.filter(old => !snapshot.fields.some(f => f.key === old.key)).map(f => ({ ...f, focus: false })), ...snapshot.fields];
      snapshot.scroll = [...previous.scroll.filter(old => !snapshot.scroll.some(s => s.key === old.key)), ...snapshot.scroll];
    }
    workspaceSnapshots.set(route, snapshot);
  }
  function restoreWorkspace(snapshot, restoreFocus = true) {
    const root = document.getElementById("app");
    if (!root || !snapshot) return;
    [...root.querySelectorAll("textarea, select")].forEach((el, index) => {
      const key = el.id || (el.closest("[data-panel]")?.dataset.panel || "full") + ":" + el.className;
      const saved = snapshot.fields.find(f => f.key === key);
      if (!saved) return;
      el.value = saved.value; el.style.height = saved.height;
      if (saved.start != null) el.setSelectionRange(saved.start, saved.end);
      if (saved.focus && restoreFocus) el.focus({ preventScroll: true });
    });
    root.querySelectorAll(".thread, .dp-body, .dock-body, .dock-col, .ws-body, textarea").forEach(el => {
      const key = el.id || (el.closest("[data-panel]")?.dataset.panel || "full") + ":" + el.className;
      const saved = snapshot.scroll.find(s => s.key === key);
      if (saved) { el.scrollTop = saved.top; el.scrollLeft = saved.left; }
    });
  }

  // On narrow viewports the dock is a full-screen sheet — start closed.
  if (typeof window !== "undefined" && window.innerWidth <= 980) {
    Object.values(state.dock).forEach(d => { d.open = false; });
  }

  /* ---------- router ---------- */
  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "");
    const parts = h.split("/").filter(Boolean);
    if (parts.length === 0) return "login";
    return parts.join("/");
  }

  function routeView() {
    const r = state.route;
    if (r === "login") return V.login(state);
    if (r === "overview") return V.overview(state);
    if (r === "app") return V.emptyHome();
    if (r === "operation/new") return V.createAdhoc(state);
    if (r.startsWith("preview/")) { state.previewId = r.split("/")[1]; state.overlay = "preview"; }
    if (r.startsWith("settings")) {
      const sec = r.split("/")[1];
      if (sec) state.setSection = sec;
      return V.settings(state);
    }
    if (r.startsWith("workspace/")) {
      const [, chatId, type] = r.split("/");
      const chat = V.chatById(chatId);
      return chat ? V.workspaceFull(chat, state, type || null) : notFound();
    }
    const chat = V.chatById(r);
    if (chat) return V.chatScreen(chat, state);
    return notFound();
  }

  function notFound() {
    return `<div class="empty-hero"><div class="empty-inner">
      ${Icons.logo("logo-mid")}<h1>Nothing here</h1>
      <p class="sub">This mockup covers S1–S11 of the UI design spec. The admin console is deferred (E7).</p>
      <a class="btn btn-primary" href="#/overview">Back to Overview</a>
    </div></div>`;
  }

  /* ---------- render ---------- */
  function render() {
    if (cancelDockDrag) cancelDockDrag();
    const previousRoute = state.route;
    const snapshot = workspaceSnapshot();
    saveWorkspace(previousRoute, snapshot);
    state.route = parseRoute();
    if (state.route === "login") {
      appEl.innerHTML = V.login(state);
      return;
    }
    const overlayHtml =
      state.overlay === "preview" ? V.preview(state)
      : state.overlay && state.overlay.startsWith("approval:") ? approvalModal(state.overlay.split(":")[1])
      : "";
    const popHtml =
      state.pop === "notifs" ? V.notifications()
      : state.pop === "account" ? V.accountPop()
      : state.pop === "demo" ? V.demoPop()
      : "";
    const searchHtml = state.searchOpen ? V.searchModal(state) : "";
    // #app already carries .app (flex shell) — render children directly, no nested wrapper
    const chat = V.chatById(state.route);
    appEl.innerHTML = `
      ${V.sidebar(state)}
      <div class="main">
        ${chat ? "" : V.topbar(state)}
        ${V.banners(state)}
        ${routeView()}
      </div>
      ${chat ? V.dockView(chat, state) : ""}
      ${overlayHtml}
      ${popHtml}
      ${searchHtml}`;
    afterRender();
    observeDock();
    restoreWorkspace(workspaceSnapshots.get(state.route), previousRoute === state.route);
  }

  function approvalModal(id) {
    const ap = APPROVALS.find(a => a.id === id);
    if (!ap) return "";
    return `
    <div class="overlay" data-action="close-overlay" role="dialog" aria-modal="true" aria-label="Approval required">
      <div class="modal" data-stop>
        <div class="modal-head">
          <span class="glyph" style="width:40px;height:40px;border-radius:12px;background:var(--warn-bg);color:var(--warn);display:grid;place-items:center">${I("shield", 18)}</span>
          <div class="grow"><h2>Approval required</h2><p class="muted" style="font-size:12.5px;margin-top:3px">Copy and choices are fixed by policy — the runtime owns every grant.</p></div>
          <button class="icon-btn" data-action="close-overlay" aria-label="Close">${I("x", 16)}</button>
        </div>
        <div class="modal-body">${V.approvalCard(ap)}</div>
      </div>
    </div>`;
  }

  function afterRender() {
    // scroll threads to the latest item
    const thread = document.getElementById("thread");
    if (thread) thread.scrollTop = thread.scrollHeight;
    // focus first input on create screen
    const name = document.getElementById("adhoc-name");
    if (name && state.route === "operation/new") name.focus();
    // approval modal focus trap: first choice
    if (state.overlay && state.overlay.startsWith("approval:")) {
      const first = document.querySelector(".appr-choice");
      if (first) first.focus();
    }
    // keep the search modal input focused across live-filter rerenders
    if (state.searchOpen) {
      const input = document.getElementById("search-modal-input");
      if (input) {
        input.focus({ preventScroll: true });
        input.value = state.searchQuery || "";
        const end = input.value.length;
        try { input.setSelectionRange(end, end); } catch (e) {}
      }
    }
    // returning to a chat from the profile panel's Message action
    if (state.focusComposer) {
      const input = document.getElementById("composer-input");
      if (input) input.focus({ preventScroll: false });
      state.focusComposer = null;
    }
  }

  /* ---------- toasts ---------- */
  function toast(title, body, ms) {
    let host = document.getElementById("toasts");
    if (!host) { host = document.createElement("div"); host.className = "toasts"; host.id = "toasts"; document.body.appendChild(host); }    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `${I("info", 16)}<div><b>${title}</b>${body ? `<span>${body}</span>` : ""}</div>`;
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 320); }, ms || 4200);
  }

  /* ---------- theme ---------- */
  function setTheme(t) {
    state.theme = t;
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("shera-theme", t); } catch (e) {}
  }

  /* ---------- thread helpers (demo runtime) ---------- */
  function currentChatId() {
    return V.chatById(state.route) ? state.route : null;
  }
  function pushItem(chatId, item) {
    if (!THREADS[chatId]) THREADS[chatId] = [];
    THREADS[chatId].push(item);
  }
  function refresh() { render(); }

  function streamReply(chatId, agentId, text) {
    const item = { kind: "msg", from: "agent", agent: agentId, text: "", streaming: true };
    pushItem(chatId, item);
    refresh();
    let i = 0;
    clearInterval(state.streaming);
    state.streaming = setInterval(() => {
      i = Math.min(text.length, i + 3 + Math.floor(Math.random() * 4));
      item.text = text.slice(0, i);
      const thread = document.getElementById("thread");
      if (thread) thread.scrollTop = thread.scrollHeight;
      const bubble = thread && thread.querySelector(".streaming-cursor");
      if (bubble) {
        const el = bubble.parentElement;
        el.innerHTML = text.slice(0, i).replace(/\n/g, "<br>") + '<span class="streaming-cursor" aria-hidden="true"></span>';
      }
      if (i >= text.length) {
        clearInterval(state.streaming); state.streaming = null;
        item.streaming = false;
        refresh();
      }
    }, 30);
  }

  const DEMO_REPLY = "Acknowledged — commands are idempotent, so a double-send is safe. In the prototype this reply streams over the WebSocket, the cursor acknowledges after render, and any typed behavior (a tool proposal, delegation, or approval request) is what creates a task run — never the words themselves.";

  /* ---------- actions ---------- */
  const actions = {
    "toggle-theme": () => setTheme(state.theme === "dark" ? "light" : "dark"),
    "toggle-side": () => { state.sideOpen = !state.sideOpen; render(); },
    "open-side": () => { state.sideOpen = true; render(); },
    "close-side": () => { state.sideOpen = false; render(); },
    "noop": () => {},
    "go-credits": () => { location.hash = "#/settings/credits"; },
    "go-settings-agents": () => { location.hash = "#/settings/agents"; },
    "do-login": () => { location.hash = "#/overview"; toast("Welcome back", "Signed in with Google · Balanced tier container ready"); },
    "toggle-cap": () => { state.loginCap = !state.loginCap; render(); },
    "logout": () => { state.pop = null; location.hash = "#/login"; },
    "dismiss-recovery": () => { state.recovery = false; render(); },
    "dismiss-storage": () => { state.storageWarn = false; render(); },
    "open-preview": (el) => { state.searchOpen = false; state.previewId = el.dataset.id; state.overlay = "preview"; render(); },
    "close-overlay": () => {
      if (state.overlay === "preview" && state.route.startsWith("preview/")) history.back();
      state.overlay = null; render();
    },
    "launch-op": (el) => {
      state.overlay = null;
      location.hash = "#/op-research-paper";
      toast("Operation launched", "run-4 created from the preview — estimate reserved: 120–180 cr");
    },
    "create-adhoc": () => {
      location.hash = "#/op-adhoc";
      toast("Ad-hoc Operation created", "Roster validated against pack membership by the runtime");
    },
    "toggle-roster-agent": (el) => {
      const id = el.dataset.agent;
      const set = new Set(state.adhocRoster);
      set.has(id) ? set.delete(id) : set.add(id);
      if (set.size === 0) { toast("Pick at least one Agent", "A roster is the user plus a minimum of one same-pack Agent."); return; }
      state.adhocRoster = [...set]; render();
    },
    "new-run": () => {
      const chatId = currentChatId(); if (!chatId) return;
      startQueuedRun(chatId);
    },
    "profile-new-run": (el) => {
      const chatId = el.dataset.chat || currentChatId(); if (!chatId) return;
      startQueuedRun(chatId);
    },
    "select-run": (el) => {
      state.selRun = el.dataset.run || (el.value || "").split(" · ")[0];
      // selecting a run opens its timeline beside the list
      const chatId = currentChatId();
      if (chatId) {
        const d = state.dock[chatId] || (state.dock[chatId] = { open: true, width: 440, panels: [] });
        d.open = true;
        if (!d.panels.some(p => p.type === "tasks")) d.panels.push({ type: "tasks" });
      }
      if (chatId) patchDock(chatId, true); else render();
    },
    "side-rail": () => {
      if (window.innerWidth <= 768) { state.sideOpen = !state.sideOpen; render(); return; }
      state.sideRail = !state.sideRail; render();
    },
    "dock-toggle": (el) => {
      const id = el.dataset.chat;
      const d = state.dock[id] || (state.dock[id] = { open: false, width: 440, panels: [] });
      d.open = !d.open;
      if (d.open && d.panels.length === 0) {
        d.panels = [{ type: id.startsWith("op-") ? "runs" : "profile" }];
      }
      state.dockAdd = null;
      patchDock(id);
    },
    "profile-open": (el) => {
      const id = el.dataset.chat;
      const d = state.dock[id] || (state.dock[id] = { open: true, width: 440, panels: [] });
      d.open = true;
      if (!d.panels.some(p => p.type === "profile")) {
        if (d.panels.length >= 6) { toast("Dock is full", "Close a panel to make room for the Agent profile."); return; }
        d.panels.unshift({ type: "profile" });
      }
      state.dockAdd = null;
      patchDock(id);
    },
    "profile-message": (el) => {
      const input = document.getElementById("composer-input");
      if (input) { input.focus(); return; }
      state.focusComposer = el.dataset.chat || null;
      if (el.dataset.chat) location.hash = "#/" + el.dataset.chat;
    },
    "profile-mute": (el) => {
      const id = el.dataset.agent;
      const a = AGENTS.find(x => x.id === id);
      state.profileMuted[id] = !state.profileMuted[id];
      render();
      toast(state.profileMuted[id] ? "Notifications muted" : "Notifications restored",
        `${a ? a.name : "Agent"} · mockup preference kept in memory for this session only.`);
    },
    "dock-add-toggle": (el) => {
      state.dockAdd = state.dockAdd === el.dataset.chat ? null : el.dataset.chat;
      patchDock(el.dataset.chat);
    },
    "dock-add": (el) => {
      const d = state.dock[el.dataset.chat];
      if (d && !d.panels.some(p => p.type === el.dataset.type) && d.panels.length < 6) {
        d.panels.push({ type: el.dataset.type });
      }
      state.dockAdd = null;
      patchDock(el.dataset.chat);
    },
    "dock-close": (el) => {
      const d = state.dock[el.dataset.chat];
      if (!d) return;
      d.panels = d.panels.filter(p => p.type !== el.dataset.type);
      d.panels.forEach(p => { p.max = false; });
      if (d.panels.length === 0) d.open = false;
      patchDock(el.dataset.chat);
    },
    "dock-max": (el) => {
      const d = state.dock[el.dataset.chat];
      if (!d) return;
      DockLayout.toggleMax(d, el.dataset.type);
      preserveDockLayout();
    },
    "dock-collapse": (el) => {
      const d = state.dock[el.dataset.chat];
      if (!d) return;
      const target = d.panels.find(p => p.type === el.dataset.type);
      if (target?.max) { target.max = false; target.collapsed = true; }
      else DockLayout.toggleCollapse(d, el.dataset.type);
      preserveDockLayout();
    },
    "dock-reset": (el) => {
      const d = state.dock[el.dataset.chat];
      if (d) { DockLayout.reset(d); preserveDockLayout(); }
    },
    "dock-chat": (el) => {
      const d = state.dock[el.dataset.chat];
      if (!d) return;
      DockLayout.leaveFill(d);
      layoutDock();
      srAlert("Chat restored. The workspace shrunk back to its previous width.");
      document.getElementById("composer-input")?.focus({ preventScroll: true });
    },
    "dock-size": (el) => {
      const dock = el.closest(".dock");
      const select = dock.querySelector(".dock-size-target");
      const handle = [...dock.querySelectorAll("[data-dock-resize]")].find(h => (h.dataset.dockResize === "row" ? "row:" + h.dataset.before : h.dataset.dockResize) === select.value);
      const ctx = handle && resizeContext(handle);
      if (!ctx) { toast("Split unavailable", "Expand both panels, restore the split, or widen the dock first."); return; }
      const value = el.dataset.size === "reset" ? ctx.reset : ctx.value + Number(el.dataset.size) * 48;
      ctx.set(DockLayout.clamp(value, ctx.min, ctx.max)); layoutDock();
    },
    "ws-private": (el) => { state.wsPrivateAgent = el.value; render(); },
    "toggle-roster": () => {
      const bar = document.getElementById("roster-bar");
      if (bar) bar.style.display = bar.style.display === "none" ? "flex" : "none";
    },
    "remove-agent": (el) => {
      toast("Removal proposed", el.dataset.agent === "general-assistant"
        ? "Coordinator removed — Agents fall back to peer-to-peer coordination; the runtime stays authoritative."
        : "Roster change proposed — the runtime validates pack membership, permissions, and cost.");
    },
    "approve": (el) => {
      const id = el.dataset.approval, grant = el.dataset.grant;
      state.resolved[id] = "approve:" + grant; state.overlay = null;
      resolveApproval(id, "RUNNING", "resumed after approval");
      const labels = { exec: "this execution only", tool: "always this tool", agent: "always this tool · this agent" };
      toast("Approved — grant created by the runtime", `Scope: ${labels[grant]}. Visible and revocable in Settings → Permissions.`);
      srAlert("Approved. The run resumes.");
      refresh();
    },
    "reject": (el) => { state.resolved[el.dataset.approval] = "reject"; state.overlay = null; resolveApproval(el.dataset.approval, "RUNNING", "continues without the rejected action"); toast("Action rejected", "The run continues without it; the requesting Agent is told."); refresh(); },
    "cancel-task": (el) => { state.resolved[el.dataset.approval] = "cancel"; state.overlay = null; resolveApproval(el.dataset.approval, "FAILED", "cancelled — parent, child and queued work stopped"); toast("Task cancelled", "Parent, child, and queued work stopped — logs and partial files preserved."); refresh(); },
    "open-approval": (el) => { state.overlay = "approval:" + el.dataset.approval; render(); },
    "send": () => {
      const chatId = currentChatId(); if (!chatId) return;
      const input = document.getElementById("composer-input");
      const text = (input.value || "").trim();
      if (!text) return;
      input.value = "";
      pushItem(chatId, { kind: "msg", from: "user", text, addressed: text.startsWith("@") ? guessAddressed(text) : null });
      const agentId = chatId.startsWith("agent-") ? chatId.replace("agent-", "") : "general-assistant";
      setTimeout(() => streamReply(chatId, agentId, DEMO_REPLY), 450);
      refresh();
    },
    "pick-at": (el) => {
      const input = document.getElementById("composer-input");
      const a = V.agentById(el.dataset.agent);
      if (input) input.value = `@${a.name.split(" ")[0]} `;
      const picker = document.getElementById("at-picker"); if (picker) picker.hidden = true;
      input && input.focus();
    },
    "open-notifs": () => { state.pop = state.pop === "notifs" ? null : "notifs"; render(); },
    "open-search": () => { state.searchOpen = true; state.searchQuery = ""; render(); },
    "close-search": () => { state.searchOpen = false; state.searchQuery = ""; render(); },
    "open-account": () => { state.pop = state.pop === "account" ? null : "account"; render(); },
    "open-demo": () => { state.pop = state.pop === "demo" ? null : "demo"; render(); },
    "mark-all-read": () => { NOTIFICATIONS.forEach(n => n.unread = false); render(); },
    "goto": (el) => {
      state.searchOpen = false;
      if (location.hash !== el.dataset.href) location.hash = el.dataset.href;
      else render(); // same-route result still closes the palette
    },
    "set-section": (el) => {
      state.setSection = el.dataset.section;
      // Keep the URL in sync so deep links and rerenders agree (fixes the
      // section-navigation defect where the old section URL won the rerender).
      if (location.hash !== "#/settings/" + el.dataset.section) location.hash = "#/settings/" + el.dataset.section;
      render();
    },
    "test-conn": (el) => toast(el.dataset.provider === "new" ? "Connection test passed" : "Connection healthy", "4 models listed · latency 212 ms — prototype simulation"),
    "revoke-grant": (el) => {
      const idx = GRANTS.findIndex(g => g.id === el.dataset.grant);
      if (idx > -1) GRANTS.splice(idx, 1);
      toast("Grant revoked", "The deterministic check fails immediately — no further execution under this grant.");
      render();
    },
    "publish-memory": () => toast("Published to Operation context", "Provenance preserved: “remembered from Researcher private memory”."),
    "cancel-run": () => toast("Cancellation requested", "In the prototype this stops parent, child, and queued work — logs and partial files are kept."),
    "toast": (el) => { try { const d = JSON.parse(el.dataset.toast); toast(d.t, d.b); } catch (e) { toast(el.dataset.toast); } },
    "reconnect": () => { state.conn = "reconnecting"; render(); setTimeout(() => { state.conn = "live"; render(); toast("Reconnected", "6 missed events replayed from your last acknowledged cursor."); }, 1600); },
    "toggle-conn": () => {
      if (state.conn === "live") { state.conn = "offline"; state.pop = null; render(); }
      else actions.reconnect();
    },
    "demo-stream": () => {
      const chatId = currentChatId() || (location.hash = "#/agent-researcher", "agent-researcher");
      state.pop = null;
      pushItem(chatId, { kind: "msg", from: "user", text: "Give me a quick status." });
      setTimeout(() => streamReply(chatId, chatId.startsWith("agent-") ? chatId.replace("agent-", "") : "general-assistant",
        "Streaming now: the run is healthy, two semantic checkpoints are durable, and 42 credits are reserved against a 45-credit estimate. Unused reservation releases on settlement."), 400);
      render();
    },
    "demo-tool": () => {
      const chatId = currentChatId() || (location.hash = "#/agent-researcher", "agent-researcher");
      state.pop = null;
      pushItem(chatId, {
        kind: "tool", tool: "web.search", version: "v2", agent: "researcher", risk: "read", riskLabel: "read-only",
        args: "\"semantic checkpoint recovery patterns\" · top 5 · recency bias",
        status: "succeeded", statusLabel: "Ran automatically — read-only tools never wait", when: "just now",
      });
      render();
    },
    "demo-risk": () => {
      const chatId = currentChatId() || (location.hash = "#/agent-developer", "agent-developer");
      state.pop = null;
      const demoAp = {
        id: "appr-demo", state: "pending", chat: chatId, agent: "developer", run: "run-d1",
        tool: "repo.merge", version: "v1",
        args: "wt/auth-fix → main · 2 files · +31 −12 · suite green",
        target: "repository shera-bot · branch main",
        sideEffect: "Merges the patch into the main branch history",
        risk: "repo", riskLabel: "repo mutation",
        expiry: "23 h 59 m", requested: "just now",
        reminders: ["now", "15 min", "45 min", "3 h", "24 h"],
      };
      APPROVALS.push(demoAp);
      pushItem(chatId, { kind: "msg", from: "agent", agent: "developer", text: "Suite is green on my worktree. Merging to main is a repository mutation, so I'm pausing for your review." });
      pushItem(chatId, { kind: "approval", approval: "appr-demo" });
      state.overlay = "approval:appr-demo";
      render();
    },
  };

  function startQueuedRun(chatId) {
    const n = RUNS.filter(r => r.chat === chatId).length + 1;
    const run = { id: "run-" + n, chat: chatId, goal: "New run — describe the goal in the composer", state: "QUEUED", credits: 0, artifacts: 0 };
    RUNS.push(run); pushItem(chatId, { kind: "run", ...run, steps: [{ label: "Queued — will start after your message", state: "now" }] });
    refresh();
  }

  function guessAddressed(text) {
    const m = text.match(/^@(\w+)/);
    if (!m) return null;
    const a = AGENTS.find(x => x.name.split(" ")[0].toLowerCase() === m[1].toLowerCase());
    return a ? a.id : null;
  }

  function srAlert(msg) { const el = document.getElementById("sr-alert"); if (el) el.textContent = msg; }

  // An answered approval flips the paused run and clears the sidebar badge.
  function resolveApproval(id, runState, note) {
    const ap = APPROVALS.find(a => a.id === id);
    if (!ap) return;
    const run = RUNS.find(r => r.id === ap.run);
    if (run) { run.state = runState; run.note = note; }
    const agent = AGENTS.find(a => a.id === ap.agent);
    if (agent) agent.approval = 0;
  }

  /* ---------- dock layout (no app render during layout changes) ---------- */
  function patchDock(chatId, updateRuns = false) {
    if (cancelDockDrag) cancelDockDrag();
    const chat = V.chatById(chatId);
    const main = document.querySelector(".main");
    if (!chat || !main) return;
    const old = document.getElementById("workspace-dock");
    const snapshot = workspaceSnapshot();
    saveWorkspace(state.route, snapshot);
    const active = document.activeElement;
    const focusAction = active?.dataset.action;
    const focusType = active?.dataset.type;
    const bodies = new Map();
    old?.querySelectorAll(".dock-panel").forEach(panel => {
      if (!updateRuns || !["runs", "tasks"].includes(panel.dataset.panel)) bodies.set(panel.dataset.panel, panel.querySelector(".dp-body"));
    });
    const template = document.createElement("template");
    template.innerHTML = V.dockView(chat, state);
    const dock = template.content.firstElementChild;
    if (dock) {
      dock.querySelectorAll(".dock-panel").forEach(panel => {
        const body = bodies.get(panel.dataset.panel);
        if (body) panel.querySelector(".dp-body").replaceWith(body);
      });
      if (old) old.replaceWith(dock); else if (!state.route.startsWith("workspace/")) main.insertAdjacentElement("afterend", dock);
    } else old?.remove();
    const buttons = main.querySelector("[data-dock-buttons]");
    if (buttons) buttons.outerHTML = V.dockButtons(chat);
    observeDock();
    restoreWorkspace(workspaceSnapshots.get(state.route));
    if (active && !active.isConnected && focusAction) {
      const target = [...main.querySelectorAll("[data-action]")].find(el => el.dataset.action === focusAction && el.dataset.type === focusType);
      (target || main.querySelector('.dock [data-action="dock-add-toggle"]') || main.querySelector('[data-action="dock-toggle"]') || document.querySelector('.dock [data-action="dock-add-toggle"]'))?.focus({ preventScroll: true });
    }
  }

  function preserveDockLayout() {
    saveWorkspace(state.route, workspaceSnapshot());
    layoutDock();
    restoreWorkspace(workspaceSnapshots.get(state.route));
  }

  function separatorValues(handle, value, min, max, unit = "pixels") {
    handle.setAttribute("aria-valuemin", Math.round(min));
    handle.setAttribute("aria-valuemax", Math.round(max));
    handle.setAttribute("aria-valuenow", Math.round(value));
    handle.setAttribute("aria-valuetext", `${Math.round(value)} ${unit}`);
  }

  // The dock is a top-level sibling panel: the space it may occupy is the app
  // width minus the in-flow sidebar and both panels' horizontal margins.
  function dockAvailableWidth() {
    const app = document.getElementById("app");
    const sb = document.querySelector(".sidebar");
    const inFlow = sb && getComputedStyle(sb).position !== "fixed";
    return app.clientWidth - (inFlow ? sb.offsetWidth : 0) - 48;
  }

  // Three-panel default: sidebar 25% · chat 45% · workspace bar 30%.
  function dockDefaultWidth() {
    return Math.round(document.getElementById("app").clientWidth * 0.30);
  }

  function layoutDock() {
    const dock = document.querySelector(".dock");
    if (!dock) return;
    const d = state.dock[dock.dataset.chat];
    const L = DockLayout, D = L.defaults;
    const bounds = L.widthBounds(dockAvailableWidth());
    // Fill mode takes the whole main area; otherwise the chat keeps at least chatMin.
    const width = d.fill ? bounds.max
      : L.clamp(d.width || dockDefaultWidth(), bounds.min, Math.max(bounds.min, bounds.max - D.chatMin));
    dock.style.setProperty("--dock-w", width + "px");
    dock.parentElement.classList.toggle("chat-collapsed", !!d.fill);
    separatorValues(dock.querySelector('[data-dock-resize="outer"]'), width, bounds.min, bounds.max);
    const body = dock.querySelector(".dock-body");
    const stacked = dock.clientWidth < 650 || window.innerWidth <= 980;
    const maxed = d.panels.find(p => p.max);
    dock.classList.toggle("stacked", stacked);
    dock.classList.toggle("maximized", !!maxed);
    const cols = [...body.querySelectorAll(".dock-col")];
    const columnHandle = body.querySelector(".dock-column-handle");
    const availableWidth = Math.max(0, body.clientWidth - 20 - D.gap);
    const columnMin = Math.min(D.columnMin, availableWidth / 2);
    const firstWidth = L.clamp(availableWidth * (d.column || D.column), columnMin, availableWidth - columnMin);
    if (columnHandle) {
      columnHandle.hidden = stacked || !!maxed;
      separatorValues(columnHandle, firstWidth / (availableWidth || 1) * 100, columnMin / (availableWidth || 1) * 100, (1 - columnMin / (availableWidth || 1)) * 100, "percent left column");
    }
    const stackSizes = stacked && !maxed ? L.heights(d.panels, Math.max(0, body.clientHeight - 20)) : null;
    cols.forEach((col, index) => {
      const panels = [...col.querySelectorAll(".dock-panel")];
      const models = panels.map(el => d.panels.find(p => p.type === el.dataset.panel));
      col.hidden = !!maxed && !models.includes(maxed);
      col.style.width = !stacked && !maxed && cols.length > 1 ? (index ? availableWidth - firstWidth : firstWidth) + "px" : "100%";
      // On a narrow dock stack whole groups, each with usable independently scrolling bodies.
      const available = Math.max(0, body.clientHeight - 20);
      const groupHeight = stackSizes
        ? models.reduce((sum, p) => sum + stackSizes.get(p.type), 0) + (models.length - 1) * D.gap
        : available;
      col.style.height = groupHeight + "px";
      const sizes = stackSizes || L.heights(models, groupHeight);
      panels.forEach(panel => {
        const p = d.panels.find(p => p.type === panel.dataset.panel);
        const collapsed = p.collapsed && !p.max;
        panel.hidden = !!maxed && !p.max;
        panel.classList.toggle("collapsed", !!collapsed);
        panel.classList.toggle("focused", !!p.max || d.panels.length === 1);
        panel.style.height = (p.max ? Math.max(D.panelMin, groupHeight) : sizes.get(p.type)) + "px";
        panel.querySelector(".dp-body").hidden = !!collapsed;
        const collapse = panel.querySelector('[data-action="dock-collapse"]');
        const label = panel.getAttribute("aria-label");
        collapse.setAttribute("aria-expanded", String(!collapsed));
        collapse.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${label}`);
        collapse.dataset.tip = collapsed ? "Expand panel" : "Collapse panel";
        const maximize = panel.querySelector('[data-action="dock-max"]');
        maximize.setAttribute("aria-label", p.max ? "Restore panel" : "Maximize panel");
        maximize.dataset.tip = p.max ? "Restore split" : "Fill the dock";
      });
      col.querySelectorAll(".dock-row-handle").forEach(handle => {
        const before = models.find(p => p.type === handle.dataset.before);
        const after = models.find(p => p.type === handle.dataset.after);
        // Collapsed headers keep a gap, but no meaningless resize control.
        handle.hidden = !!maxed;
        const disabled = before.collapsed || after.collapsed;
        handle.classList.toggle("inactive", !!disabled);
        handle.tabIndex = disabled ? -1 : 0;
        handle.setAttribute("aria-disabled", String(!!disabled));
        const total = sizes.get(before.type) + sizes.get(after.type);
        separatorValues(handle, sizes.get(before.type), disabled ? sizes.get(before.type) : D.panelMin, disabled ? sizes.get(before.type) : total - D.panelMin);
      });
    });
  }

  function observeDock() {
    dockObserver?.disconnect();
    layoutDock();
    const dock = document.querySelector(".dock");
    if (dock && typeof ResizeObserver !== "undefined") {
      dockObserver = new ResizeObserver(() => layoutDock());
      dockObserver.observe(dock.parentElement);
      dockObserver.observe(dock.querySelector(".dock-body"));
    }
  }

  function resizeContext(handle) {
    if (handle.hidden || handle.getAttribute("aria-disabled") === "true") return null;
    const dock = handle.closest(".dock"), d = state.dock[dock.dataset.chat];
    const kind = handle.dataset.dockResize, L = DockLayout, D = L.defaults;
    if (kind === "outer") {
      if (window.innerWidth <= 980) return null;
      const bounds = L.widthBounds(dockAvailableWidth());
      const originalWidth = d.width, originalFill = !!d.fill;
      let lastRequest = null;
      return { value: dock.getBoundingClientRect().width, ...bounds, reset: dockDefaultWidth(), axis: "x", direction: -1,
        set: value => { L.setOuterWidth(d, value, bounds.max, lastRequest); lastRequest = value; },
        undo: () => { d.width = originalWidth; d.fill = originalFill; } };
    }
    if (kind === "column") {
      const total = dock.querySelector(".dock-body").clientWidth - 20 - D.gap;
      const original = d.column, min = Math.min(D.columnMin, total / 2);
      return { value: dock.querySelector(".dock-col").getBoundingClientRect().width, min, max: total - min, reset: total / 2, axis: "x", direction: 1,
        set: value => { d.column = value / total; }, undo: () => { d.column = original; } };
    }
    const before = d.panels.find(p => p.type === handle.dataset.before), after = d.panels.find(p => p.type === handle.dataset.after);
    const a = dock.querySelector(`#dock-panel-${before.type}`).getBoundingClientRect().height;
    const b = dock.querySelector(`#dock-panel-${after.type}`).getBoundingClientRect().height;
    const original = d.panels.map(p => p.weight);
    const col = dock.classList.contains("stacked") ? dock : handle.closest(".dock-col");
    // Pixel weights reflect any min-size clamping and keep untouched rows stable.
    const weights = [...col.querySelectorAll(".dock-panel")].filter(el => !el.hidden).map(el => [d.panels.find(p => p.type === el.dataset.panel), el.getBoundingClientRect().height]);
    return { value: a, min: D.panelMin, max: a + b - D.panelMin, reset: (a + b) / 2, axis: "y", direction: 1,
      set: value => { weights.forEach(([p, size]) => { if (!p.collapsed) p.weight = size; }); before.weight = value; after.weight = a + b - value; },
      undo: () => { d.panels.forEach((p, i) => { p.weight = original[i]; }); } };
  }

  document.addEventListener("pointerdown", e => {
    const handle = e.target.closest("[data-dock-resize]");
    if (!handle || e.button !== 0 || e.isPrimary === false || cancelDockDrag) return;
    const ctx = resizeContext(handle); if (!ctx) return;
    e.preventDefault();
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
    const start = ctx.axis === "x" ? e.clientX : e.clientY;
    const cursor = document.body.style.cursor, select = document.body.style.userSelect;
    handle.classList.add("dragging");
    document.body.style.cursor = ctx.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    function move(ev) {
      if (ev.pointerId !== e.pointerId) return;
      const delta = (ctx.axis === "x" ? ev.clientX : ev.clientY) - start;
      if (delta === 0) return; // A click must never replace the saved preference.
      ctx.set(DockLayout.clamp(ctx.value + delta * ctx.direction, ctx.min, ctx.max));
      layoutDock();
    }
    function finish(cancel) {
      if (!cancelDockDrag) return;
      cancelDockDrag = null;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", abort);
      handle.removeEventListener("lostpointercapture", abort);
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.classList.remove("dragging");
      document.body.style.cursor = cursor; document.body.style.userSelect = select;
      if (cancel) ctx.undo();
      layoutDock();
    }
    function up(ev) { if (ev.pointerId === e.pointerId) finish(false); }
    function abort(ev) { if (ev.pointerId === e.pointerId) finish(true); }
    cancelDockDrag = () => finish(true);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", abort);
    handle.addEventListener("lostpointercapture", abort);
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && cancelDockDrag) { e.preventDefault(); cancelDockDrag(); return; }
    const handle = e.target.closest("[data-dock-resize]");
    if (!handle) return;
    const ctx = resizeContext(handle); if (!ctx) return;
    if (ctx.axis === "x" && ["ArrowUp", "ArrowDown"].includes(e.key)) return;
    if (ctx.axis === "y" && ["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    // Outer arrows move the boundary physically; Home/End mean min/max dock width.
    const key = ctx.direction === -1 ? ({ ArrowLeft: "ArrowRight", ArrowRight: "ArrowLeft" }[e.key] || e.key) : e.key;
    const value = DockLayout.keyValue(key, ctx.value, ctx.min, ctx.max, ctx.reset, e.shiftKey ? 48 : 16);
    if (value === null) return;
    e.preventDefault(); ctx.set(value); layoutDock();
  });
  window.addEventListener("resize", () => { if (cancelDockDrag) cancelDockDrag(); layoutDock(); });

  /* ---------- global listeners ---------- */
  document.addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    // popovers: click-outside closes
    if (state.pop) {
      const insidePop = e.target.closest("[data-pop]");
      const onToggle = actionEl && ["open-notifs", "open-account", "open-demo"].includes(actionEl.dataset.action);
      if (!insidePop && !onToggle) { state.pop = null; render(); }
      if (insidePop && actionEl && actionEl.dataset.action === "goto") { state.pop = null; }
    }
    if (actionEl && actionEl.classList.contains("overlay") && e.target.closest("[data-stop]")) {
      // Interior click inside a modal — never dismisses it. Repairs the data-stop
      // gap the 2026-09-13 audit documented; nested controls carry their own actions.
      return;
    }
    if (!actionEl) return;
    const fn = actions[actionEl.dataset.action];
    if (fn) { e.preventDefault(); fn(actionEl); }
  });

  document.addEventListener("input", (e) => {
    if (e.target.id === "search-modal-input") {
      state.searchQuery = e.target.value;
      render();
      return;
    }
    if (e.target.id === "composer-input") {
      const wrap = document.getElementById("composer");
      if (wrap) wrap.classList.add("focus");
      const picker = document.getElementById("at-picker");
      if (picker) {
        const show = /(^|\s)@$/.test(e.target.value) || e.target.value === "@";
        picker.hidden = !show;
      }
      e.target.style.height = "auto";
      e.target.style.height = Math.min(140, e.target.scrollHeight) + "px";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      if (state.overlay) { actions["close-overlay"](); }
      else if (state.searchOpen) { state.searchOpen = false; state.searchQuery = ""; render(); }
      else if (state.dockAdd) { const id = state.dockAdd; state.dockAdd = null; patchDock(id); }
      else if (state.pop) { state.pop = null; render(); }
      else if (state.sideOpen) { state.sideOpen = false; render(); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      if (state.route !== "login") { e.preventDefault(); state.searchOpen = true; state.searchQuery = ""; render(); }
    }
    if (state.searchOpen) {
      if (e.key === "Enter" && e.target.id === "search-modal-input") {
        e.preventDefault();
        document.querySelector(".search-hit")?.click();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const hits = [...document.querySelectorAll(".search-hit")];
        if (!hits.length) return;
        e.preventDefault();
        const current = hits.indexOf(document.activeElement);
        const next = e.key === "ArrowDown" ? Math.min(hits.length - 1, current + 1) : Math.max(0, current - 1);
        (hits[next] || hits[0])?.focus();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && e.target.id === "composer-input") {
      e.preventDefault(); actions["send"]();
    }
    if (state.overlay && state.overlay.startsWith("approval:")) {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 5) {
        const btns = document.querySelectorAll(".appr-choice");
        if (btns[n - 1]) btns[n - 1].click();
      }
    }
  });

  window.addEventListener("hashchange", () => {
    // The palette is a transient launcher — any navigation closes it.
    state.searchOpen = false;
    state.searchQuery = "";
    render();
  });

  // The ambient field is a nonessential loop — stop it while the tab is hidden.
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("tab-hidden", document.hidden);
  });

  /* ---------- overview live timer ---------- */
  setInterval(() => {
    const t = document.querySelector("[data-live-timer]");
    if (!t) return;
    const m = t.textContent.trim().split(":").map(Number);
    let s = m[0] * 3600 + m[1] * 60 + m[2] + 1;
    const pad = (n) => String(n).padStart(2, "0");
    t.textContent = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }, 1000);

  return { state, render, toast, actions };
})();

App.render();
