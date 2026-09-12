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
    dock: {                  // per-chat workspace dock state
      "op-research-paper": { open: true, width: 460, panels: [{ type: "runs" }, { type: "tools" }] },
      "agent-developer": { open: true, width: 420, panels: [{ type: "runs" }, { type: "terminal" }] },
    },
    dockAdd: null,           // chatId with the add-panel menu open
    wsPrivateAgent: "researcher",
    selRun: null,
    setSection: "account",
    adhocRoster: ["general-assistant"],
    resolved: {},            // approvalId → "approve:<grant>" | "reject" | "cancel"
    streaming: null,         // interval id
  };

  const appEl = document.getElementById("app");

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
    // #app already carries .app (flex shell) — render children directly, no nested wrapper
    appEl.innerHTML = `
      ${V.sidebar(state)}
      <div class="main">
        ${V.topbar(state)}
        ${V.banners(state)}
        ${routeView()}
      </div>
      ${overlayHtml}
      ${popHtml}`;
    afterRender();
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
    "open-preview": (el) => { state.previewId = el.dataset.id; state.overlay = "preview"; render(); },
    "close-overlay": () => {
      if (state.overlay === "preview" && state.route.startsWith("preview/")) history.back();
      state.overlay = null; render();
    },
    "launch-op": (el) => {
      state.overlay = null;
      location.hash = "#/operation/op-research-paper";
      toast("Operation launched", "run-4 created from the preview — estimate reserved: 120–180 cr");
    },
    "create-adhoc": () => {
      location.hash = "#/operation/op-adhoc";
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
      const n = RUNS.filter(r => r.chat === chatId).length + 1;
      const run = { id: "run-" + n, chat: chatId, goal: "New run — describe the goal in the composer", state: "QUEUED", credits: 0, artifacts: 0 };
      RUNS.push(run); pushItem(chatId, { kind: "run", ...run, steps: [{ label: "Queued — will start after your message", state: "now" }] });
      refresh();
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
      render();
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
        d.panels = [{ type: id.startsWith("op-") ? "runs" : "files" }];
      }
      state.dockAdd = null;
      render();
    },
    "dock-add-toggle": (el) => {
      state.dockAdd = state.dockAdd === el.dataset.chat ? null : el.dataset.chat;
      render();
    },
    "dock-add": (el) => {
      const d = state.dock[el.dataset.chat];
      if (d && !d.panels.some(p => p.type === el.dataset.type) && d.panels.length < 6) {
        d.panels.push({ type: el.dataset.type });
      }
      state.dockAdd = null;
      render();
    },
    "dock-close": (el) => {
      const d = state.dock[el.dataset.chat];
      if (!d) return;
      d.panels = d.panels.filter(p => p.type !== el.dataset.type);
      d.panels.forEach(p => { p.max = false; });
      if (d.panels.length === 0) d.open = false;
      render();
    },
    "dock-max": (el) => {
      const d = state.dock[el.dataset.chat];
      if (!d) return;
      const on = !(d.panels.find(p => p.type === el.dataset.type) || {}).max;
      d.panels.forEach(p => { p.max = false; });
      const target = d.panels.find(p => p.type === el.dataset.type);
      if (target && on) target.max = true;
      state.dockAdd = null;
      render();
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
    "open-account": () => { state.pop = state.pop === "account" ? null : "account"; render(); },
    "open-demo": () => { state.pop = state.pop === "demo" ? null : "demo"; render(); },
    "mark-all-read": () => { NOTIFICATIONS.forEach(n => n.unread = false); render(); },
    "goto": (el) => { location.hash = el.dataset.href; },
    "set-section": (el) => { state.setSection = el.dataset.section; render(); },
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
      const chatId = currentChatId() || (location.hash = "#/agent/researcher", "agent-researcher");
      state.pop = null;
      pushItem(chatId, { kind: "msg", from: "user", text: "Give me a quick status." });
      setTimeout(() => streamReply(chatId, chatId.startsWith("agent-") ? chatId.replace("agent-", "") : "general-assistant",
        "Streaming now: the run is healthy, two semantic checkpoints are durable, and 42 credits are reserved against a 45-credit estimate. Unused reservation releases on settlement."), 400);
      render();
    },
    "demo-tool": () => {
      const chatId = currentChatId() || (location.hash = "#/agent/researcher", "agent-researcher");
      state.pop = null;
      pushItem(chatId, {
        kind: "tool", tool: "web.search", version: "v2", agent: "researcher", risk: "read", riskLabel: "read-only",
        args: "\"semantic checkpoint recovery patterns\" · top 5 · recency bias",
        status: "succeeded", statusLabel: "Ran automatically — read-only tools never wait", when: "just now",
      });
      render();
    },
    "demo-risk": () => {
      const chatId = currentChatId() || (location.hash = "#/agent/developer", "agent-developer");
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

  /* ---------- dock drag-resize ---------- */
  document.addEventListener("mousedown", (e) => {
    const handle = e.target.closest("[data-dock-resize]");
    if (!handle) return;
    e.preventDefault();
    const chatId = handle.getAttribute("data-dock-resize");
    const dockEl = document.querySelector(".dock");
    if (!dockEl) return;
    handle.classList.add("dragging");
    const startX = e.clientX;
    const startW = dockEl.getBoundingClientRect().width;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    function onMove(ev) {
      const w = Math.min(780, Math.max(320, startW + (startX - ev.clientX)));
      dockEl.style.setProperty("--dock-w", w + "px");
      dockEl.dataset.width = String(w);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      handle.classList.remove("dragging");
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const d = state.dock[chatId] || (state.dock[chatId] = { open: true, panels: [] });
      d.width = parseInt(dockEl.dataset.width || "440", 10);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

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
    if (state.overlay && e.target.closest("[data-stop]")) {
      // clicks inside a modal should not hit overlay-close
    }
    if (!actionEl) return;
    const fn = actions[actionEl.dataset.action];
    if (fn) { e.preventDefault(); fn(actionEl); }
  });

  document.addEventListener("input", (e) => {
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
      if (state.overlay) { actions["close-overlay"](); }
      else if (state.dockAdd) { state.dockAdd = null; render(); }
      else if (state.pop) { state.pop = null; render(); }
      else if (state.sideOpen) { state.sideOpen = false; render(); }
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      const inp = document.querySelector(".tb-search input");
      if (inp && state.route !== "login") { e.preventDefault(); inp.focus(); }
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

  window.addEventListener("hashchange", render);

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
