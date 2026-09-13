/* ============================================================
   Shera Bot UI mockup — view renderers (pure functions → HTML)
   ============================================================ */

// Pure sizing rules shared by the view/controller and dependency-free Node tests.
const DockLayout = (function () {
  const defaults = { column: 0.5, panelMin: 144, header: 46, gap: 10, columnMin: 300, chatMin: 320 };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function widthBounds(available) {
    const max = Math.max(0, available);
    return { min: Math.min(320, max), max };
  }
  // The chat never shrinks below chatMin: past that threshold the dock snaps to
  // the whole main area (d.fill). Only a narrowing move hands space back — a
  // continuous widening drag must stay filled instead of bouncing off the threshold.
  function setOuterWidth(d, requested, available, prevRequest) {
    const min = Math.min(320, available);
    const fillAt = Math.max(min, available - defaults.chatMin);
    if (d.fill) {
      const narrowing = prevRequest == null ? requested < available : requested < prevRequest;
      if (!narrowing) return;
      d.fill = false;
    } else if (requested > fillAt) {
      d.fill = true;
      return;
    }
    d.width = clamp(requested, min, fillAt);
  }
  function leaveFill(d) {
    d.fill = false;
    d.width = d.width || null; // null = proportional 30% default
  }
  function columns(panels) {
    const middle = Math.ceil(panels.length / 2);
    return panels.length <= 2 ? [panels] : [panels.slice(0, middle), panels.slice(middle)];
  }
  function heights(panels, available) {
    const open = panels.filter(p => !p.collapsed);
    let remaining = Math.max(open.length * defaults.panelMin,
      available - (panels.length - 1) * defaults.gap - (panels.length - open.length) * defaults.header);
    const sizes = new Map(panels.filter(p => p.collapsed).map(p => [p.type, defaults.header]));
    let pending = [...open];
    while (pending.length) {
      const total = pending.reduce((sum, p) => sum + (p.weight || 1), 0);
      const small = pending.filter(p => remaining * (p.weight || 1) / total < defaults.panelMin);
      if (!small.length) {
        pending.forEach(p => sizes.set(p.type, remaining * (p.weight || 1) / total));
        break;
      }
      small.forEach(p => { sizes.set(p.type, defaults.panelMin); remaining -= defaults.panelMin; });
      pending = pending.filter(p => !small.includes(p));
    }
    return sizes;
  }
  function reset(d) {
    d.width = null; d.column = defaults.column; d.fill = false;
    d.panels.forEach(p => { delete p.weight; p.collapsed = false; p.max = false; });
  }
  function toggleCollapse(d, type) {
    const p = d.panels.find(p => p.type === type);
    if (p) { p.collapsed = !p.collapsed; p.max = false; }
  }
  function toggleMax(d, type) {
    const target = d.panels.find(p => p.type === type);
    const on = target && !target.max;
    d.panels.forEach(p => { p.max = false; });
    if (target) target.max = !!on;
  }
  function keyValue(key, value, min, max, reset, step) {
    if (key === "Home") return min;
    if (key === "End") return max;
    if (key === "Enter") return clamp(reset, min, max);
    if (key === "ArrowLeft" || key === "ArrowUp") return clamp(value - step, min, max);
    if (key === "ArrowRight" || key === "ArrowDown") return clamp(value + step, min, max);
    return null;
  }
  return { defaults, clamp, widthBounds, setOuterWidth, leaveFill, columns, heights, reset, toggleCollapse, toggleMax, keyValue };
})();

const Views = (function () {
  const I = Icons.get;

  /* ---------- shared helpers ---------- */
  function agentById(id) { return AGENTS.find(a => a.id === id); }
  function tmplById(id) { return OP_TEMPLATES.find(t => t.id === id); }
  function chatById(id) { return CHATS.list.find(c => c.id === id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, ch => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
    ));
  }

  function avatar(id, sizeCls) {
    const a = agentById(id);
    return `<span class="avatar ${sizeCls || ""}" style="background:${a.hue}" aria-hidden="true">${a.name.split(" ").map(w => w[0]).join("").slice(0, 2)}</span>`;
  }

  function runStateChip(state) {
    switch (state) {
      case "RUNNING": return `<span class="chip live"><span class="spin"></span>Running</span>`;
      case "WAITING_FOR_APPROVAL": return `<span class="chip warn">${I("alert", 11)}Waiting approval</span>`;
      case "RETRYING": return `<span class="chip sky">${I("retry", 11)}Retrying · 2 of 3</span>`;
      case "SUCCEEDED": return `<span class="chip quiet">${I("check", 11)}Succeeded</span>`;
      case "FAILED": return `<span class="chip bad">${I("x", 11)}Failed</span>`;
      case "PAUSED": return `<span class="chip quiet">${I("pause", 11)}Paused</span>`;
      case "RECOVERY_REQUIRED": return `<span class="chip warn">${I("recovery", 11)}Recovery review</span>`;
      default: return `<span class="chip">${esc(state)}</span>`;
    }
  }

  function riskBadge(risk, label) { return `<span class="risk ${risk}">${esc(label)}</span>`; }

  /* ---------- logo / chrome fragments ---------- */
  function brandRow() {
    return `
      <div class="sb-brand">
        ${Icons.logo()}
        <div class="sb-wordmark">Shera Bot</div>
        <button class="sb-collapse tip" data-tip="Collapse sidebar" data-action="side-rail" aria-label="Collapse or expand sidebar">${I("chevD")}</button>
      </div>`;
  }

  function sidebarItem(item, active) {
    const a = agentById(item.ref);
    const trail = [];
    if (item.approval) trail.push(`<span class="badge-approval tip" data-tip="Approval required">${I("alert", 10)}${item.approval}</span>`);
    else if (item.approvalCount) trail.push(`<span class="badge-approval">${item.approvalCount}</span>`);
    if (item.unread) trail.push(`<span class="pill-count">${item.unread}</span>`);
    return `
      <a href="#/${item.id}" class="sb-item tip ${active ? "active" : ""} ${item.unread ? "unread" : ""}" data-tip="${esc(a ? a.name : item.name)}" data-nav="${item.id}" aria-current="${active ? "page" : "false"}">
        ${avatar(item.ref)}
        <span class="sb-name">${esc(a ? a.name : item.name)}</span>
        <span class="sb-trailing">
          ${item.running ? `<span class="spin tip" data-tip="Run active" role="img" aria-label="run active"></span>` : ""}
          ${item.done ? `<span class="dot muted tip" data-tip="${esc(item.done)}" role="img" aria-label="completed"></span>` : ""}
          ${trail.join("")}
        </span>
      </a>`;
  }

  function opItem(item, active) {
    const isTemplate = !!item.template;
    return `
      <${isTemplate ? "button" : "a"} ${isTemplate ? `data-action="open-preview" data-id="${item.template}"` : `href="#/${item.id}"`}
        class="sb-item ${active ? "active" : ""}" ${!isTemplate ? `data-nav="${item.id}" aria-current="${active ? "page" : "false"}"` : `aria-label="Launch ${esc(item.name)} — opens preview"`}>
        <span class="glyph sb-op-icon">${I("operation", 14)}</span>
        <span class="sb-name">${esc(item.name)}</span>
        <span class="sb-trailing">
          ${item.state === "waiting" ? `<span class="badge-approval tip" data-tip="Run paused for approval">${I("alert", 10)}</span>` : ""}
          ${item.state === "running" ? `<span class="spin" role="img" aria-label="run active"></span>` : ""}
          ${item.state === "recovery" ? `<span class="dot warn pulse tip" data-tip="Recovery needs review" role="img" aria-label="recovery"></span>` : ""}
          ${isTemplate ? `<span class="faint">${I("play", 12)}</span>` : ""}
        </span>
      </${isTemplate ? "button" : "a"}>`;
  }

  function sidebar(state) {
    const route = state.route;
    const act = (id) => route === id ? "active" : "";
    const agentsItems = CHATS.list.filter(c => c.type === "agent");
    const templates = OP_TEMPLATES.map(t => ({ template: t.id, name: t.name }));
    const opChats = CHATS.list.filter(c => c.type === "operation");
    return `
      <aside class="sidebar ${state.sideRail ? "rail" : ""} ${state.sideOpen ? "open" : ""}" id="sidebar" aria-label="Primary">
        ${brandRow()}
        <nav class="sb-scroll">
          <div class="sb-section">
            <div class="sb-section-head"><span class="eyebrow">Agents</span>
              <button class="sb-add sb-add-icon tip" data-tip="Agent settings — pack Agents are fixed" data-action="go-settings-agents" aria-label="Agent settings">${I("settings", 12)}</button>
            </div>
            ${agentsItems.map(c => sidebarItem({ ...c, ref: c.ref, id: c.id, approval: c.ref === "study-planner" ? 1 : 0, unread: agentById(c.ref).unread, running: agentById(c.ref).running, done: agentById(c.ref).done }, route === c.id)).join("")}
          </div>
          <div class="sb-section">
            <div class="sb-section-head"><span class="eyebrow">Operations</span>
              <a class="sb-add" href="#/operation/new" aria-label="New ad-hoc Operation">${I("plus", 11)}New</a>
            </div>
            <div class="sb-group-label">Templates</div>
            ${templates.map(t => opItem({ ...t, id: t.template }, false)).join("")}
            <div class="sb-group-label">Active chats</div>
            ${opChats.map(c => opItem(c, route === c.id)).join("")}
          </div>
        </nav>
        <footer class="sb-footer">
          <div class="sb-foot-row">
            <button class="credits-pill tip" data-tip="Reserved by active runs: 85 cr · settles after execution" data-action="go-credits">${I("coins", 13)}<span class="t num">1,240 cr</span></button>
            <span class="spacer" style="flex:1"></span>
            <span class="conn-chip ${state.conn} tip" data-tip="${state.conn === "live" ? "Live · events streaming" : state.conn === "reconnecting" ? "Reconnecting — replaying missed events" : "Disconnected — work continues server-side"}" role="img" aria-label="connection ${state.conn}"><i class="conn-dot ${state.conn}"></i><span class="t">${state.conn === "live" ? "Live" : state.conn === "reconnecting" ? "Reconnecting" : "Offline"}</span></span>
          </div>
          <div class="sb-foot-row">
            <span class="storage-meter ${USER.storageUsedPct >= 80 ? "warn" : ""}" role="img" aria-label="storage ${USER.storageUsedPct} percent of ${USER.storageTotal} used"><i style="width:${USER.storageUsedPct}%"></i></span>
            <span class="storage-text num">${USER.storageUsedPct}% of ${USER.storageTotal}</span>
          </div>
          <div class="sb-pack-row sb-pack-label" title="Pinned pack — one workspace per account">student pack v1 · pinned</div>
        </footer>
      </aside>
      ${state.sideOpen ? '<div class="sb-scrim" data-action="close-side" aria-hidden="true"></div>' : ""}`;
  }

  /* Right-corner account button (2026-09-13): the only identity element in the
     chat topbar's right corner. Theme, notifications and the demo controls live
     inside the account menu; the unread count also shows on the avatar badge. */
  function headCluster(state) {
    const unread = NOTIFICATIONS.filter(n => n.unread).length;
    return `
      <button class="tb-account tip" data-action="open-account" aria-haspopup="menu" aria-label="Account menu${unread ? ` — ${unread} unread` : ""}" data-tip="Account, theme, notifications">
        <span class="avatar" style="background:#0f766e">${USER.googleInitials}</span>
        ${unread ? `<span class="notif">${unread}</span>` : ""}
      </button>`;
  }

  /* Search is a compact icon button (2026-09-13) — it opens the search modal,
     a local navigation palette over chats, templates and settings sections. */
  function searchButton() {
    return `<button class="icon-btn tip" data-action="open-search" data-tip="Search (Ctrl+F)" aria-label="Search" aria-haspopup="dialog">${I("search", 17)}</button>`;
  }

  function topbar(state) {
    const unread = NOTIFICATIONS.filter(n => n.unread).length;
    return `
      <header class="topbar">
        <button class="icon-btn tb-menu-btn" data-action="open-side" aria-label="Open menu">${I("menu")}</button>
        <div class="tb-right">
          ${searchButton()}
          <button class="tb-account tip" data-action="open-account" aria-haspopup="menu" aria-label="Account menu${unread ? ` — ${unread} unread` : ""}" data-tip="Account, theme, notifications">
            <span class="avatar" style="background:#0f766e">${USER.googleInitials}</span>
            ${unread ? `<span class="notif">${unread}</span>` : ""}
          </button>
        </div>
      </header>`;
  }

  /* ---------- banners ---------- */
  function banners(state) {
    let out = "";
    if (state.conn === "offline") {
      out += `<div class="banner banner-off" role="status">${I("wifioff", 16)}<span><b>Connection lost</b> — you can keep reading; work continues server-side.</span><span class="spacer"></span><button class="btn btn-xs btn-ghost" data-action="reconnect">Reconnect</button></div>`;
    } else if (state.conn === "reconnecting") {
      out += `<div class="banner banner-replay" role="status"><span class="spin"></span><span>Replaying missed events…</span></div>`;
    }
    if (state.recovery) {
      out += `<div class="banner banner-recover" role="status">${I("recovery", 16)}<span><b>Restoring your workspace…</b> Run 2b resumed from its last safe step and needs your review.</span><span class="spacer"></span><a class="btn btn-xs btn-ghost" href="#/op-exam-prep">Review run</a><button class="icon-btn" style="width:28px;height:28px" data-action="dismiss-recovery" aria-label="Dismiss">${I("x", 13)}</button></div>`;
    }
    if (state.storageWarn) {
      out += `<div class="banner banner-storage" role="status">${I("database", 16)}<span>Workspace storage at <b class="num">${USER.storageUsedPct}%</b> — nothing is deleted automatically, but new uploads may fail at 100%.</span><span class="spacer"></span><a class="btn btn-xs btn-ghost" href="#/settings/files">Clean up files</a><button class="icon-btn" style="width:28px;height:28px" data-action="dismiss-storage" aria-label="Dismiss">${I("x", 13)}</button></div>`;
    }
    return out;
  }

  /* ---------- S1: login ---------- */
  function login(state) {
    const capped = state.loginCap;
    return `
      <main class="login-wrap">
        <div class="card login-card">
          ${Icons.logo("logo-big")}
          <h1>${capped ? "Shera is at its cap" : "Sign in to Shera Bot"}</h1>
          <p class="tag">${capped
            ? "This private prototype has reached its five-account limit."
            : "Your pack of agents, one connected workspace."}</p>
          ${capped
            ? `<div class="col" style="justify-items:center"><span class="chip bad">${I("lock", 12)} Signup paused — server-enforced cap</span><p class="muted" style="font-size:12.5px;max-width:38ch">No retry is offered because the cap is checked server-side. Ask an administrator for one of the five seats.</p></div>`
            : `<button class="g-btn" data-action="do-login">${Icons.google()}Continue with Google</button>`}
          <p class="login-meta">Google OAuth is the only sign-in method<br>no email, no passwords, no payments</p>
          <div class="login-cap">
            <p>Private prototype · up to five accounts</p>
            <small><a href="#/login" data-action="toggle-cap" style="color:var(--faint);text-decoration:underline">${capped ? "Back to sign-in" : "Preview the at-cap screen"}</a></small>
          </div>
        </div>
      </main>`;
  }

  /* ---------- S2: empty home ---------- */
  function emptyHome() {
    return `
      <div class="empty-hero">
        <div class="empty-inner">
          ${Icons.logo("logo-mid")}
          <div>
            <h1>Pick an Agent or launch an Operation</h1>
            <p class="sub">Your workspace pins <b>student pack v1</b> — six Agents and three Operations, ready to work. Everything they do is visible here.</p>
          </div>
          <div class="shortcut-row">
            <a class="shortcut" href="#/agent-researcher">
              <span class="glyph">${I("agent", 18)}</span>
              <b>Message the Researcher</b>
              <span>Persistent direct chat — it picks up where you left off.</span>
            </a>
            <button class="shortcut" data-action="open-preview" data-id="research-paper">
              <span class="glyph">${I("operation", 18)}</span>
              <b>Launch “Research Paper”</b>
              <span>Open the launch preview first — nothing runs before you confirm it.</span>
            </button>
            <a class="shortcut" href="#/operation/new">
              <span class="glyph">${I("plus", 18)}</span>
              <b>Create an ad-hoc Operation</b>
              <span>Choose any same-pack Agents and a coordinator.</span>
            </a>
          </div>
        </div>
      </div>`;
  }

  /* ---------- Overview ---------- */
  function kpiCard(opts) {
    return `
      <div class="card kpi ${opts.hero ? "kpi-hero" : ""}">
        <div class="kpi-top"><span>${opts.label}</span><span class="spacer"></span>
          ${opts.go ? `<a class="go tip" data-tip="${esc(opts.goTip || "Open")}" href="${opts.go}" aria-label="${esc(opts.label)}">${I("arrowUR", 14)}</a>` : ""}
        </div>
        <div class="kpi-num num">${opts.num}</div>
        <div class="kpi-foot">${opts.foot}</div>
      </div>`;
  }

  function overview(state) {
    const bars = [
      { d: "S", v: 6, q: 1 }, { d: "M", v: 11, q: 0 }, { d: "T", v: 8, q: 2 },
      { d: "W", v: 14, q: 0, today: true }, { d: "T", v: 9, q: 3 }, { d: "F", v: 12, q: 1 }, { d: "S", v: 5, q: 0 },
    ];
    const max = Math.max(...bars.map(b => b.v + b.q));
    const chart = `<div class="chart" role="img" aria-label="Runs per day, last 7 days">${bars.map(b => `
      <div class="bar-col">
        <div class="bar ${b.q ? "hatched" : ""} ${b.today ? "today" : ""}" style="height:${Math.round((b.v + b.q) / max * 100)}%" ${b.today ? `data-tip="${b.v} running + ${b.q} queued"` : ""}>
          ${b.today ? `<span class="val num">${b.v}${b.q ? "+" + b.q : ""}</span>` : ""}
        </div>
        <span class="day">${b.d}</span>
      </div>`).join("")}
    </div>
    <div class="chart-legend">
      <span class="key"><span class="sw sw-brand"></span>ran</span>
      <span class="key"><span class="sw sw-hatch"></span>queued / held</span>
      <span class="key muted">W · peak day</span>
    </div>`;

    const donut = (() => {
      // 30-day runs: 22 succeeded, 5 running/held, 3 other → C = 2πr, r=74
      const r = 74, C = 2 * Math.PI * r;
      const seg = (pct) => C * pct;
      return `
      <div class="donut-wrap">
        <div class="donut" role="img" aria-label="Run outcomes, last 30 days: 73 percent succeeded">
          <svg viewBox="0 0 168 168">
            <circle class="track" cx="84" cy="84" r="${r}"/>
            <circle class="arc arc-live" cx="84" cy="84" r="${r}" stroke-dasharray="${seg(0.12)} ${C}" stroke-dashoffset="-${seg(0.73)}"/>
            <circle class="arc" cx="84" cy="84" r="${r}" stroke-dasharray="${seg(0.73)} ${C}" stroke-dashoffset="0"/>
          </svg>
          <div class="donut-center"><b class="num">73%</b><span>runs succeeded</span></div>
        </div>
      </div>
      <div class="donut-legend">
        <span class="key"><span class="dot" style="background:var(--brand)"></span>succeeded · 22</span>
        <span class="key"><span class="dot live"></span>active · 5</span>
      </div>`;
    })();

    return `
      <main class="page"><div class="page-inner">
        <div class="page-title-row">
          <div><h1>Overview</h1><p class="sub">Plan, launch, and supervise your pack's work with ease.</p></div>
          <div class="actions">
            <a class="btn btn-ghost" href="#/operation/new">${I("plus", 15)}Ad-hoc Operation</a>
            <button class="btn btn-primary" data-action="open-preview" data-id="research-paper">${I("play", 15)}Launch Operation</button>
          </div>
        </div>

        <div class="ov-grid" style="margin-top:16px">
          <div class="ov-kpis">
            ${kpiCard({ hero: true, label: "Runs this week", num: 14, foot: `<span class="trend">${I("arrowUR", 10)} +3 from last week</span>`, go: "#/op-research-paper", goTip: "Open Research Paper" })}
            ${kpiCard({ label: "Succeeded", num: 9, foot: `<span class="chip live" style="height:20px">${I("check", 10)}</span> within policy` , go: "#/settings/credits", goTip: "Credit usage" })}
            ${kpiCard({ label: "Active now", num: 3, foot: `<span class="dot live pulse"></span> live · healthy`, go: "#/op-adhoc", goTip: "Open Ad-hoc Operation" })}
            ${kpiCard({ label: "Awaiting approval", num: 2, foot: `<span class="chip warn" style="height:20px">${I("alert", 10)}</span> oldest 1 h 20 m`, go: "#/agent-study-planner", goTip: "Review approvals" })}
          </div>

          <div class="ov-main">
            <div class="card">
              <div class="card-head"><h3>Run activity</h3><span class="spacer"></span><span class="chip quiet num">last 7 days</span></div>
              <div class="card-pad">${chart}</div>
            </div>
            <div class="ov-pair">
              <div class="card">
                <div class="card-head"><h3>Agent activity</h3><span class="spacer"></span><button class="btn btn-xs btn-ghost" data-action="go-settings-agents">${I("settings", 12)}Manage</button></div>
                <div class="act-list">
                  ${[
                    { id: "researcher", what: "Comparing source authority · run 3", chip: `<span class="chip live"><span class="spin"></span>Running</span>` },
                    { id: "developer", what: "Patching auth middleware · wt/auth-fix", chip: `<span class="chip live"><span class="spin"></span>Running</span>` },
                    { id: "study-planner", what: "calendar.sync v2 · external write", chip: `<span class="chip warn">${I("alert", 10)}Approval</span>` },
                    { id: "citation-manager", what: "Citation index refreshed · 41 sources", chip: `<span class="chip quiet">${I("check", 10)}Done</span>` },
                  ].map(r => `
                    <div class="act-row">
                      ${avatar(r.id)}
                      <div class="t"><b>${agentById(r.id).name}</b><span>${r.what}</span></div>
                      ${r.chip}
                    </div>`).join("")}
                </div>
              </div>
              <div class="card">
                <div class="card-head"><h3>Run outcomes</h3><span class="spacer"></span><span class="chip quiet num">30 d</span></div>
                <div class="card-pad">${donut}</div>
              </div>
            </div>
          </div>

          <div class="ov-side">
            <div class="card">
              <div class="card-head"><h3>Up next</h3><span class="spacer"></span><span class="chip quiet">schedules</span></div>
              <div class="sched">
                <div class="sched-item">
                  <b>Literature sweep — weekly monitor</b>
                  <span class="when">${I("clock", 12)}02:00 pm – 04:00 pm · Researcher</span>
                  <button class="btn btn-sm btn-primary" style="justify-self:start" data-action="toast" data-toast="Mockup: in the prototype this starts the scheduled run">${I("play", 13)}Start now</button>
                </div>
                <hr class="divider">
                <div class="sched-item">
                  <b>Citation format audit</b>
                  <span class="when">${I("clock", 12)}06:30 pm · Citation Manager</span>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="card-head"><h3>Operations</h3><span class="spacer"></span><a class="btn btn-xs btn-ghost" href="#/operation/new">${I("plus", 11)}New</a></div>
              <div class="op-list">
                ${[
                  { name: "Research Paper · run 3", sub: "Comparative analysis · 42 cr", chip: `<span class="chip warn">${I("alert", 10)}Approval</span>`, href: "#/op-research-paper" },
                  { name: "Programming Assignment", sub: "Solution merged · study guide filed", chip: `<span class="chip quiet">${I("check", 10)}Done</span>`, href: "#/operation/new" },
                  { name: "Ad-hoc · 2 Agents", sub: "Practice set generation · 17 cr", chip: `<span class="chip live"><span class="spin"></span>Running</span>`, href: "#/op-adhoc" },
                  { name: "Exam Preparation", sub: "Schedule rebuild · after restart", chip: `<span class="chip warn">${I("recovery", 10)}Recovery</span>`, href: "#/op-exam-prep" },
                ].map(o => `
                  <a class="op-row" href="${o.href}">
                    <span class="glyph">${I("operation", 15)}</span>
                    <span class="t"><b>${o.name}</b><span>${o.sub}</span></span>
                    ${o.chip}
                  </a>`).join("")}
              </div>
            </div>

            <div class="card live-card">
              <div class="card-head"><h3>Live run</h3><span class="spacer"></span><span class="chip" style="background:rgba(255,255,255,.16);color:#fff;border-color:transparent"><span class="dot live pulse"></span>live</span></div>
              <div class="live-timer num" data-live-timer>00:41:17</div>
              <p class="what">run 3 · Comparative analysis of 14 sources<br><span style="opacity:.75">Research Paper · Researcher</span></p>
              <div class="live-controls">
                <button class="lc tip" data-tip="Pause is a runtime decision — mockup only" data-action="toast" data-toast="Mockup: pause request would go through the runtime gateway" aria-label="Pause run">${I("pause", 18)}</button>
                <button class="lc stop tip" data-tip="Cancel stops parent, child and queued work" data-action="cancel-run" aria-label="Cancel run">${I("stop", 18)}</button>
              </div>
            </div>
          </div>
        </div>
      </div></main>`;
  }

  /* ---------- thread item renderers ---------- */
  function threadItem(it) {
    switch (it.kind) {
      case "day": return `<div class="day-sep">${esc(it.label)}</div>`;
      case "system": return `<div class="sysnote">${I("info", 13)}<span>${esc(it.text)}</span></div>`;
      case "replay": return `<div class="replay-boundary" role="note">${I("history", 12)}${it.n} missed events replayed</div>`;
      case "msg": {
        if (it.from === "user") {
          return `<div class="msg user"><div class="bubble">${esc(it.text)}
            <span class="status num">${I("check", 11)} Sent</span></div></div>`;
        }
        const a = agentById(it.agent);
        return `<div class="msg agent">
          ${avatar(it.agent)}
          <div class="grow">
            <div class="meta"><b>${esc(a.name)}</b><span>${esc(a.role)}</span></div>
            ${it.addressed ? `<span class="addr">${I("at", 11)} to ${esc(agentById(it.addressed).name)}</span>` : ""}
            <div class="bubble">${esc(it.text).replace(/\n/g, "<br>")}${it.streaming ? '<span class="streaming-cursor" aria-hidden="true"></span>' : ""}</div>
          </div>
        </div>`;
      }
      case "tool": {
        const a = agentById(it.agent);
        return `
        <div class="tool-card">
          <div class="tool-head">
            <span class="glyph">${I("box", 15)}</span>
            <div class="t"><b class="mono">${esc(it.tool)} <span class="faint">${esc(it.version)}</span></b><span>${esc(a.name)} proposed · runtime executed the policy</span></div>
            ${riskBadge(it.risk, it.riskLabel)}
          </div>
          <div class="tool-body">
            <code>${esc(it.args)}</code>
            ${it.diff ? `<div class="diff-preview" role="img" aria-label="proposed diff">${it.diff.map(l => `<span class="ln ${l.t}">${esc(l.s)}</span>`).join("")}</div>` : ""}
            ${it.extra ? `<span>${esc(it.extra)}</span>` : ""}
          </div>
          <div class="tool-foot">
            ${it.status === "waiting approval"
              ? `<span class="chip warn">${I("alert", 10)}${esc(it.status)}</span>`
              : it.status === "proposed"
                ? `<span class="chip sky">${I("clock", 10)}proposed · not executed</span>`
                : `<span class="chip live">${I("check", 10)}${esc(it.status)}</span>`}
            <span class="spacer"></span>
            <span class="num">${esc(it.statusLabel || "")}</span>
            ${it.when ? `<span class="num faint">${esc(it.when)}</span>` : ""}
          </div>
        </div>`;
      }
      case "run": {
        const chip = runStateChip(it.state);
        return `
        <div class="run-card">
          <div class="run-head">
            <span class="id">${esc(it.run)}</span>
            <b>${esc(it.goal)}</b>
            <span class="spacer"></span>
            ${chip}
          </div>
          ${it.steps ? `<div class="card-pad" style="padding-top:12px;padding-bottom:6px"><div class="stepper">
            ${it.steps.map(s => `<div class="step ${s.state === "done" ? "done" : s.state === "now" ? "now" : s.state === "fail" ? "fail" : ""}">
              <span class="step-dot">${I("check", 10)}</span>
              <div class="step-body"><b>${esc(s.label)}${s.checkpoint ? `<span class="chip quiet" style="height:18px;font-size:9.5px">checkpoint</span>` : ""}</b></div>
            </div>`).join("")}
          </div></div>` : ""}
          ${it.note ? `<div class="tool-foot" style="border-top:none;background:transparent;padding-top:0;margin:0 14px">${esc(it.note)}</div>` : ""}
          <div class="run-foot">
            <span>${I("coins", 11)} <span class="num">${it.credits} cr</span></span>
            <span>${I("box", 11)} <span class="num">${it.artifacts} artifact${it.artifacts === 1 ? "" : "s"}</span></span>
            ${it.duration ? `<span>${I("clock", 11)} <span class="num">${esc(it.duration)}</span></span>` : ""}
            ${it.done ? `<span>${esc(it.done)}</span>` : ""}
          </div>
        </div>`;
      }
      case "artifact": {
        const a = agentById(it.producer);
        return `
        <div class="artifact">
          <span class="glyph">${I("file", 17)}</span>
          <div class="t"><b>${esc(it.name)}</b><span>${esc(a.name)} · from ${esc(it.from)} · ${esc(it.size)}</span></div>
          <button class="icon-btn tip" data-tip="Open preview" aria-label="Open artifact">${I("eye", 15)}</button>
          <button class="icon-btn tip" data-tip="Download" aria-label="Download artifact">${I("download", 15)}</button>
        </div>`;
      }
      case "approval": return approvalCard(APPROVALS.find(x => x.id === it.approval));
      default: return "";
    }
  }

  /* ---------- S8: approval card (fields fixed per D9) ---------- */
  function approvalCard(ap) {
    const a = agentById(ap.agent);
    const res = (typeof App !== "undefined" && App.state.resolved[ap.id]) || null;
    if (res === "approve:exec" || res === "approve:tool" || res === "approve:agent") {
      const scope = { exec: "this execution only", tool: "always this tool", agent: "always this tool · this agent" }[res.split(":")[1]];
      return `
      <div class="approval-card" data-approval="${ap.id}">
        <div class="appr-head" style="background:var(--live-bg);color:var(--live)">${I("shield", 16)}<b>Approved · run resumed</b><span class="spacer"></span><span class="chip live">${I("check", 10)}grant · ${scope}</span></div>
        <div class="appr-body">
          <div class="row" style="gap:9px">${avatar(ap.agent)}<b>${esc(a.name)}</b><span class="faint" style="font-size:12px">· ${esc(ap.tool)} ${esc(ap.version)} · decided just now</span></div>
          <p class="muted" style="font-size:12.5px">The runtime created the grant deterministically — a prompt could never create it. Review or revoke it in Settings → Permissions & approvals. A matching reusable grant executes without another prompt while the policy still checks it every time.</p>
        </div>
      </div>`;
    }
    if (res === "reject") {
      return `
      <div class="approval-card" data-approval="${ap.id}">
        <div class="appr-head" style="background:var(--bad-bg);color:var(--bad)">${I("x", 16)}<b>Action rejected</b><span class="spacer"></span><span class="chip bad">decision immutable</span></div>
        <div class="appr-body"><p class="muted" style="font-size:12.5px">The run continues without ${esc(ap.tool)}; ${esc(a.name)} has been told. The decision is recorded as an immutable event.</p></div>
      </div>`;
    }
    if (res === "cancel") {
      return `
      <div class="approval-card" data-approval="${ap.id}">
        <div class="appr-head" style="background:var(--bad-bg);color:var(--bad)">${I("stop", 16)}<b>Task cancelled</b><span class="spacer"></span><span class="chip bad">tree stopped</span></div>
        <div class="appr-body"><p class="muted" style="font-size:12.5px">Parent, child, and queued work stopped immediately. Logs and partial files are preserved.</p></div>
      </div>`;
    }
    return `
    <div class="approval-card hot" data-approval="${ap.id}">
      <button class="appr-head" style="width:100%;border:none;cursor:pointer;font:inherit" data-action="open-approval" data-approval="${ap.id}" aria-label="Open full approval dialog">${I("shield", 16)}<b>Pausing for your approval</b><span class="spacer"></span>${riskBadge(ap.risk, ap.riskLabel)}${I("arrowUR", 14)}</button>
      <div class="appr-body">
        <div class="row" style="gap:9px">${avatar(ap.agent)}<b>${esc(a.name)}</b><span class="faint" style="font-size:12px">· ${esc(ap.tool)} ${esc(ap.version)} · run ${esc(ap.run)} · requested ${esc(ap.requested)}</span></div>
        <dl class="appr-grid">
          <dt>Tool</dt><dd><code>${esc(ap.tool)} ${esc(ap.version)}</code></dd>
          <dt>Arguments</dt><dd>${esc(ap.args)}</dd>
          <dt>Target</dt><dd><code>${esc(ap.target)}</code></dd>
          <dt>Side effect</dt><dd>${esc(ap.sideEffect)}</dd>
          <dt>Expiry</dt><dd class="num">request expires in ${esc(ap.expiry)}</dd>
        </dl>
        <div class="remind-line">Reminders: ${ap.reminders.map((r, i) => `<i class="num">${r}</i>${i < ap.reminders.length - 1 ? '<span aria-hidden="true">→</span>' : ""}`).join(" ")} <span class="faint">— none after 24 h</span></div>
        <div class="mute-row">
          <button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Muting stops notifications only — the task stays paused and this approval stays visible">Mute this approval</button>
          <button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Muting stops notifications only — the task stays paused and this approval stays visible">Mute this task</button>
          <button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Muting stops notifications only — the task stays paused and this approval stays visible">Mute all reminders</button>
        </div>
      </div>
      <div class="appr-choices" role="group" aria-label="Approval choices">
        <button class="appr-choice primary" data-action="approve" data-approval="${ap.id}" data-grant="exec">
          <span class="n">1</span><span>Approve this execution only<small>the runtime creates a one-time grant for this exact call</small></span>
        </button>
        <button class="appr-choice" data-action="approve" data-approval="${ap.id}" data-grant="tool">
          <span class="n">2</span><span>Always approve this tool<small>scoped grant · reviewable and revocable in Settings</small></span>
        </button>
        <button class="appr-choice" data-action="approve" data-approval="${ap.id}" data-grant="agent">
          <span class="n">3</span><span>Always approve this tool for this agent<small>narrower grant — ${esc(a.name)} only</small></span>
        </button>
        <button class="appr-choice danger" data-action="reject" data-approval="${ap.id}">
          <span class="n">4</span><span>Reject this action<small>the run continues without it; the agent is told</small></span>
        </button>
        <button class="appr-choice danger" data-action="cancel-task" data-approval="${ap.id}">
          <span class="n">5</span><span>Cancel the task<small>stops parent, child, and queued work · logs kept</small></span>
        </button>
        <div class="group-note">choices 2–3 create runtime-owned grants — a prompt can never create one</div>
      </div>
    </div>`;
  }

  /* ---------- chat screens (S3 / S4) ---------- */
  function composer(chat) {
    const isOp = chat.type === "operation";
    return `
      <div class="composer-wrap">
        <div class="composer" id="composer">
          ${isOp ? `<div class="at-picker" id="at-picker" hidden>
            <div class="at-title">Address an agent</div>
            ${AGENTS.filter(a => opRoster(chat).includes(a.id)).map(a => `
              <button class="at-item" data-action="pick-at" data-agent="${a.id}">${avatar(a.id, "sm")}<span class="grow"><b>${esc(a.name)}</b><span style="display:block">${esc(a.role)}</span></span></button>`).join("")}
          </div>` : ""}
          <textarea id="composer-input" rows="1" placeholder="${isOp ? "Message the Operation — type @ to address an Agent" : `Message ${esc(agentById(chat.ref).name)}…`}" aria-label="Message"></textarea>
          <div class="composer-bar">
            <button class="icon-btn tip" data-tip="Attach file" style="width:32px;height:32px" aria-label="Attach file">${I("clip", 15)}</button>
            ${isOp ? `<button class="btn btn-xs btn-ghost" data-action="new-run">${I("plus", 11)}New run</button>` : ""}
            <span class="hint">Enter to send · Shift+Enter for newline</span>
            ${!isOp ? `<div class="model-pick composer-model">
              <label class="sr-only" for="model-select">Provider / model override</label>
              <select id="model-select" class="select" data-action="noop" title="Per-conversation provider override">
                <option>OpenAI · GPT-4o (default)</option>
                <option>OpenAI · GPT-4o mini</option>
                <option>Ollama · llama3:70b (local)</option>
                <option>vLLM · mixtral-8x22b (custom)</option>
              </select>
            </div>` : ""}
            <button class="send-btn" data-action="send" aria-label="Send message">${I("send", 15)}</button>
          </div>
        </div>
      </div>`;
  }

  function opRoster(chat) {
    if (chat.id === "op-adhoc") return ["general-assistant", "programming-tutor"];
    return tmplById(chat.ref).agents;
  }

  function chatHeader(chat, state) {
    if (chat.type === "agent") {
      const a = agentById(chat.ref);
      return `
        <div class="chat-head">
          <div class="chat-head-left">
            <button class="chat-id tip" data-tip="View Agent profile" data-action="profile-open" data-chat="${chat.id}" aria-label="View ${esc(a.name)} profile">
              ${avatar(chat.ref, "lg").replace('class="avatar lg"', `class="avatar lg"`).replace("</span>", `<span class="presence ${a.presence === "active" ? "on" : "away"}"></span></span>`)}
              <div class="t">
                <b>${esc(a.name)} <span class="chip quiet" style="height:20px;font-size:10px">${a.presence === "active" ? "session active" : "hibernating"}</span></b>
                <span>${esc(a.role)}</span>
              </div>
            </button>
            <div class="chat-head-actions">
              ${dockButtons(chat)}
            </div>
          </div>
          <div class="chat-head-right">
            ${searchButton()}
            ${headCluster(state)}
          </div>
        </div>`;
    }
    const t = tmplById(chat.ref);
    const name = chat.id === "op-adhoc" ? "Ad-hoc · 2 Agents" : t.name;
    return `
      <div class="chat-head">
        <div class="chat-head-left">
          <span class="glyph sb-op-icon" style="width:40px;height:40px;border-radius:12px;background:var(--brand-bg);display:grid;place-items:center">${I("operation", 19)}</span>
          <div class="t">
            <b>${esc(name)} <span class="chip sky" style="height:20px;font-size:10px">${I("lock", 9)} student pack v1</span></b>
            <span>${t ? esc(t.purpose.split(":")[0].split(".")[0]) + "." : "Custom same-pack roster"} · ${chat.runs} task runs tracked separately</span>
          </div>
          <div class="chat-head-actions">
            <button class="btn btn-xs btn-ghost" data-action="toggle-roster">${I("user", 12)}Roster</button>
            ${dockButtons(chat)}
          </div>
        </div>
        <div class="chat-head-right">
          ${searchButton()}
          ${headCluster(state)}
        </div>
      </div>
      <div class="roster-bar" id="roster-bar">
        ${opRoster(chat).map(id => {
          const a = agentById(id);
          const coord = (chat.ref === "adhoc" ? id === "general-assistant" : t.coordinator === id);
          return `<span class="roster-chip">${avatar(id, "sm")} ${esc(a.name)} ${coord ? '<span class="coord-badge">Coordinator</span>' : ""}<button class="x tip" data-tip="${coord ? "Default coordinator is removable — runtime stays authoritative" : "Remove from roster"}" data-action="remove-agent" data-agent="${id}" aria-label="Remove ${esc(a.name)}">${I("x", 9)}</button></span>`;
        }).join("")}
        <span class="roster-note">· peer-to-peer coordination if the coordinator is removed</span>
        <button class="btn btn-xs btn-ghost" style="margin-left:auto" data-action="toast" data-toast="Mockup: roster editor — runtime validates every change against pack membership">${I("plus", 11)}Add agent</button>
      </div>`;
  }

  /* ---------- workspace dock (adaptive panel grid) ---------- */
  const DOCK_PANELS = [
    ["profile", "Agent profile", "user"],
    ["runs", "Task runs", "list"],
    ["tasks", "Run timeline", "history"],
    ["files", "Files", "folder"],
    ["editor", "Editor", "file"],
    ["terminal", "Terminal", "terminal"],
    ["browser", "Browser", "globe"],
    ["tools", "Tool history", "box"],
    ["private", "Private files", "lock"],
  ];

  function dockState(chat) {
    return App.state.dock[chat.id] || { open: false, width: null, panels: [] };
  }

  function dockButtons(chat) {
    const d = dockState(chat);
    return `
      <span class="dock-buttons" data-dock-buttons="${chat.id}">
      <button class="icon-btn tip" data-tip="Workspace dock" data-action="dock-toggle" data-chat="${chat.id}" aria-pressed="${d.open}" aria-label="Toggle workspace dock">${I("panelright", 17)}</button>
      </span>`;
  }

  function dockPanelMeta(type) { return DOCK_PANELS.find(x => x[0] === type) || DOCK_PANELS[0]; }

  function dockView(chat, state) {
    const d = dockState(chat);
    if (!d.open) return "";
    const panels = d.panels || [];
    const cols = DockLayout.columns(panels);
    return `
    <aside class="dock" id="workspace-dock" data-chat="${chat.id}" style="--dock-w:${d.fill ? "100%" : (d.width || 440) + "px"}" aria-label="Workspace dock">
      ${dockSeparator("outer", "vertical", "Workspace width", "workspace-dock", "dock-handle")}
      <p class="sr-only" id="dock-resize-help">Drag to resize. Use arrow keys, Shift for larger steps, Home or End for limits, Enter to reset. Escape cancels a drag. The dock can fill the whole main area; drag back or use Back to chat to restore the chat.</p>
      <div class="dock-head">
        <button class="btn btn-xs btn-soft dock-back" data-action="dock-chat" data-chat="${chat.id}">${I("chevR", 12)}Back to chat</button>
        <h4>${I("panelright", 14)}Workspace</h4>
        <span class="chip quiet num">${panels.length} open</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn btn-xs btn-ghost" data-action="dock-reset" data-chat="${chat.id}" title="Reset width, splits and collapsed panels">Reset layout</button>
        <button class="btn btn-xs btn-ghost" data-action="dock-add-toggle" data-chat="${chat.id}" aria-haspopup="menu" aria-expanded="${state.dockAdd === chat.id}">${I("plus", 11)}Add panel</button>
        <button class="icon-btn tip" data-tip="Collapse dock" data-action="dock-toggle" data-chat="${chat.id}" style="width:30px;height:30px" aria-label="Collapse dock">${I("x", 14)}</button>
      </div>
      ${state.dockAdd === chat.id ? addPanelPop(chat, panels, cols) : ""}
      <div class="dock-body">
        ${panels.length === 0 ? `
          <div class="dock-empty">
            <span class="glyph">${I("panelright", 20)}</span>
            <div><b style="font-size:14px">Nothing open</b><p class="muted" style="font-size:12.5px;margin-top:3px">Open anything the Agents produce — it docks here, out of the chat.</p></div>
            <button class="btn btn-sm btn-soft" data-action="dock-add-toggle" data-chat="${chat.id}">${I("plus", 13)}Add panel</button>
          </div>` : cols.map((col, index) => `
          ${index ? dockSeparator("column", "vertical", "Workspace column split", "dock-col-0", "dock-column-handle") : ""}
          <div class="dock-col" id="dock-col-${index}" data-column="${index}">${col.map((p, row) => `
            ${row ? dockSeparator("row", "horizontal", `Resize ${dockPanelMeta(col[row - 1].type)[1]} and ${dockPanelMeta(p.type)[1]}`, `dock-panel-${col[row - 1].type}`, "dock-row-handle", `data-before="${col[row - 1].type}" data-after="${p.type}"`) : ""}
            ${dockPanel(chat, p, panels, state)}`).join("")}</div>`).join("")}
      </div>
    </aside>`;
  }

  function dockSeparator(kind, orientation, label, controls, cls, extra = "") {
    return `<div class="dock-separator ${cls}" data-dock-resize="${kind}" ${extra} tabindex="0" role="separator" aria-orientation="${orientation}" aria-label="${label}" aria-controls="${controls}" aria-describedby="dock-resize-help" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50" title="${label} · drag or arrow keys · Enter to reset"><span></span></div>`;
  }

  function dockPanel(chat, p, panels, state) {
    const [id, label, icon] = dockPanelMeta(p.type);
    const focused = p.max || panels.length === 1;
    return `
    <section class="dock-panel ${focused ? "focused" : ""}" id="dock-panel-${p.type}" data-panel="${p.type}" aria-label="${label}">
      <header class="dp-head">
        <span class="dp-title" title="${label}">${I(icon, 14)}<span>${label}</span></span>
        <div class="dp-actions">
          <button class="icon-btn tip" data-tip="Collapse panel" data-action="dock-collapse" data-chat="${chat.id}" data-type="${p.type}" aria-expanded="true" aria-controls="dock-body-${p.type}" aria-label="Collapse ${label}">${I("chevD", 13)}</button>
          <button class="icon-btn tip" data-tip="${p.max ? "Restore split" : "Fill the dock"}" data-action="dock-max" data-chat="${chat.id}" data-type="${p.type}" aria-label="${p.max ? "Restore panel" : "Maximize panel"}">${I("expand", 13)}</button>
          <a class="icon-btn tip" data-tip="Open full page" href="#/workspace/${chat.id}/${p.type}" aria-label="Open ${label} full page">${I("arrowUR", 13)}</a>
          <button class="icon-btn tip" data-tip="Close panel" data-action="dock-close" data-chat="${chat.id}" data-type="${p.type}" aria-label="Close ${label}">${I("x", 13)}</button>
        </div>
      </header>
      <div class="dp-body" id="dock-body-${p.type}">${dockBody(p.type, chat, state)}</div>
    </section>`;
  }

  function addPanelPop(chat, panels, cols = []) {
    return `
    <div class="add-pop" role="menu" aria-label="Add a panel">
      <div class="at-title">Open a panel</div>
      ${DOCK_PANELS.map(([id, label, icon]) => {
        const open = panels.find(p => p.type === id);
        return `<button class="add-item" data-action="dock-add" data-chat="${chat.id}" data-type="${id}" ${open ? "disabled" : ""}>
          ${I(icon, 15)}${label}${open ? '<span class="in-dock">OPEN</span>' : ""}
        </button>`;
      }).join("")}
      <div class="add-resize">
        <div class="at-title">Resize panels</div>
        <div class="dock-size-controls">
          <label class="sr-only" for="dock-size-target">Split to resize</label>
          <select id="dock-size-target" class="select dock-size-target" aria-label="Split to resize">
            <option value="outer">Dock width</option>
            ${cols.length > 1 ? '<option value="column">Left column width</option>' : ""}
            ${cols.map(col => col.slice(0, -1).map(p => `<option value="row:${p.type}">${dockPanelMeta(p.type)[1]} height</option>`).join("")).join("")}
          </select>
          <button class="btn btn-xs btn-ghost" data-action="dock-size" data-size="-1" aria-label="Decrease selected size">−</button>
          <button class="btn btn-xs btn-ghost" data-action="dock-size" data-size="1" aria-label="Increase selected size">+</button>
          <button class="btn btn-xs btn-ghost" data-action="dock-size" data-size="reset">Equal / default</button>
        </div>
      </div>
    </div>`;
  }

  /* ---------- Agent profile panel (Telegram-style) ---------- */
  const PROFILE_ACTIVE_STATES = ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "RETRYING", "RECOVERY_REQUIRED", "PAUSED"];

  function profRow(icon, label, value) {
    return `<div class="prof-row"><span class="pr-ic">${I(icon, 15)}</span><span class="pr-body"><span class="pr-label">${label}</span><span class="pr-value">${value}</span></span></div>`;
  }

  function agentSkills(id) {
    const set = new Set();
    OP_TEMPLATES.forEach(t => ((t.skills && t.skills[id]) || []).forEach(s => set.add(s)));
    return [...set];
  }

  function agentOperations(id) {
    const names = OP_TEMPLATES.filter(t => t.agents.includes(id)).map(t => t.name);
    if (["general-assistant", "programming-tutor"].includes(id)) names.push("Ad-hoc");
    return names;
  }

  function profileActions(chat, a, state, fullPage) {
    const muted = !!(state.profileMuted || {})[a.id];
    const filesBtn = fullPage
      ? `<a class="pa-btn" href="#/workspace/${chat.id}/files"><span class="pa-ic">${I("folder", 16)}</span>Files</a>`
      : `<button class="pa-btn" data-action="dock-add" data-chat="${chat.id}" data-type="files"><span class="pa-ic">${I("folder", 16)}</span>Files</button>`;
    return `
      <div class="pa-grid" role="group" aria-label="${esc(a.name)} quick actions">
        <button class="pa-btn" data-action="profile-message" data-chat="${chat.id}"><span class="pa-ic">${I("send", 16)}</span>Message</button>
        <button class="pa-btn" data-action="profile-new-run" data-chat="${chat.id}"><span class="pa-ic">${I("play", 16)}</span>New task</button>
        ${filesBtn}
        <button class="pa-btn" data-action="profile-mute" data-agent="${a.id}" aria-pressed="${muted}"><span class="pa-ic">${I("bell", 16)}</span>${muted ? "Unmute" : "Mute"}</button>
        <a class="pa-btn" href="#/settings/agents"><span class="pa-ic">${I("settings", 16)}</span>Settings</a>
        ${fullPage ? "" : `<a class="pa-btn" href="#/workspace/${chat.id}"><span class="pa-ic">${I("expand", 16)}</span>Full page</a>`}
      </div>`;
  }

  function profileBody(chat, state, fullPage) {
    if (chat.type !== "agent") return operationProfileBody(chat);
    const a = agentById(chat.ref);
    if (!a) return '<p class="muted">No Agent is attached to this chat.</p>';
    const skills = agentSkills(a.id);
    const ops = agentOperations(a.id);
    const files = WORKSPACE.privateFiles[a.id] || ["memory/journal.md", "skills/profile.md"];
    const activeRuns = RUNS.filter(r => r.chat === chat.id && PROFILE_ACTIVE_STATES.includes(r.state));
    const statusText = a.running || a.done || (a.approval ? "Permission request pending" : a.presence === "active" ? "Session active" : "Hibernating");
    const sessions = AGENT_SESSIONS[a.id] || [];
    return `
      <div class="prof">
        <div class="prof-head">
          ${avatar(chat.ref).replace('class="avatar', 'class="avatar prof-ava').replace("</span>", `<span class="presence ${a.presence === "active" ? "on" : "away"}"></span></span>`)}
          <b class="prof-name">${esc(a.name)}</b>
          <span class="prof-role">${esc(a.role)}</span>
        </div>
        ${profileActions(chat, a, state, fullPage)}
        <div class="prof-rows">
          ${profRow("activity", "Status", esc(statusText))}
          ${profRow("zap", "Default model", esc(a.provider))}
          ${profRow("skill", "Skills", skills.length ? skills.map(s => esc(s)).join(" · ") : "General assistance")}
          ${profRow("operation", "Operations", `${ops.length} — ${ops.map(o => esc(o)).join(", ")}`)}
          ${profRow("info", "About", esc(a.blurb))}
        </div>
        <details class="prof-sec" open>
          <summary>${I("folder", 14)}<span>Files</span><span class="spacer"></span><span class="count">${files.length}</span>${I("chevD", 12)}</summary>
          <div class="prof-sec-body">
            ${files.map(f => `<div class="tree-row d1">${I("file", 13)}<span class="grow">${esc(f)}</span></div>`).join("")}
            <p class="faint">Private folder — shared with an Operation only through an explicit publication step.</p>
          </div>
        </details>
        <details class="prof-sec" open>
          <summary>${I("activity", 14)}<span>Ongoing tasks</span><span class="spacer"></span><span class="count">${activeRuns.length}</span>${I("chevD", 12)}</summary>
          <div class="prof-sec-body">
            ${activeRuns.length ? activeRuns.map(r => `
              <button class="prof-run" data-action="select-run" data-run="${r.id}">
                <span class="pr1"><span class="id">${esc(r.id)}</span><span class="spacer"></span>${runStateChip(r.state)}</span>
                <span class="goal">${esc(r.goal)}</span>
              </button>`).join("")
            : `<p class="prof-empty">No active task runs in this chat. Send a message or use <b>New task</b> to start one.</p>`}
          </div>
        </details>
        <details class="prof-sec">
          <summary>${I("history", 14)}<span>Session history</span><span class="spacer"></span><span class="count">${sessions.length}</span>${I("chevD", 12)}</summary>
          <div class="prof-sec-body">
            ${sessions.length ? sessions.map(s => `
              <div class="prof-sess">
                <span class="ps-dot ${esc(s.outcome)}">${s.outcome === "done" ? I("check", 10) : s.outcome === "attention" ? I("alert", 10) : ""}</span>
                <span class="ps-body"><span class="ps-title">${esc(s.title)}<span class="ps-when">${esc(s.when)}</span></span><span class="ps-detail">${esc(s.detail)}</span></span>
              </div>`).join("")
            : `<p class="prof-empty">No past sessions recorded for this scenario.</p>`}
            <p class="faint">Sample session history — mockup fixture, not a runtime log.</p>
          </div>
        </details>
      </div>`;
  }

  function operationProfileBody(chat) {
    const t = tmplById(chat.ref);
    const name = chat.id === "op-adhoc" ? "Ad-hoc · 2 Agents" : (t ? t.name : chat.id);
    const roster = opRoster(chat);
    const coord = chat.ref === "adhoc" ? "general-assistant" : (t ? t.coordinator : null);
    return `
      <div class="prof">
        <div class="prof-head">
          <span class="glyph prof-op-glyph">${I("operation", 22)}</span>
          <b class="prof-name">${esc(name)}</b>
          <span class="prof-role">Operation · student pack v1</span>
        </div>
        <div class="prof-rows">
          ${t ? profRow("info", "Purpose", esc(t.purpose)) : ""}
          ${t ? profRow("coins", "Estimated credits", `${t.estimate[0]}–${t.estimate[1]} cr — reserved at launch`) : ""}
        </div>
        <details class="prof-sec" open>
          <summary>${I("user", 14)}<span>Roster</span><span class="spacer"></span><span class="count">${roster.length}</span>${I("chevD", 12)}</summary>
          <div class="prof-sec-body">
            ${roster.map(id => {
              const ag = agentById(id);
              return `<div class="prof-member">${avatar(id, "sm")}<span class="grow"><b>${esc(ag.name)}</b><span class="pr-label">${esc(ag.role)}</span></span>${coord === id ? '<span class="coord-badge">Coordinator</span>' : ""}</div>`;
            }).join("")}
          </div>
        </details>
        ${t ? `
        <details class="prof-sec">
          <summary>${I("box", 14)}<span>Expected outputs</span><span class="spacer"></span><span class="count">${t.outputs.length}</span>${I("chevD", 12)}</summary>
          <div class="prof-sec-body">${t.outputs.map(o => `<div class="tree-row d1">${I("file", 13)}<span class="grow">${esc(o)}</span></div>`).join("")}</div>
        </details>
        <details class="prof-sec">
          <summary>${I("plug", 14)}<span>Connectors</span><span class="spacer"></span><span class="count">${t.connectors.length}</span>${I("chevD", 12)}</summary>
          <div class="prof-sec-body">${t.connectors.map(c => `<div class="prof-member"><span class="pr-ic">${I("plug", 14)}</span><span class="grow"><b>${esc(c.name)}</b></span><span class="chip ${c.status === "connected" ? "quiet" : "warn"}" style="height:20px;font-size:10px">${esc(c.status)}</span></div>`).join("")}</div>
        </details>` : ""}
      </div>`;
  }

  function runsPanelBody(chat, state) {
    const runs = RUNS.filter(r => r.chat === chat.id);
    const sel = (runs.find(r => r.id === state.selRun) || runs[0])?.id;
    return `
    <div class="col" style="gap:8px">
      ${runs.map(r => `
        <button class="run-item ${sel === r.id ? "sel" : ""}" data-action="select-run" data-run="${r.id}">
          <span class="r1"><span class="id">${esc(r.id)}</span><span class="spacer"></span>${runStateChip(r.state)}</span>
          <span class="goal">${esc(r.goal)}</span>
          <span class="meta"><span class="num">${I("coins", 10)} ${r.credits} cr</span><span class="num">${I("box", 10)} ${r.artifacts}</span>${r.live ? `<span class="dot live pulse"></span>` : ""}</span>
        </button>`).join("")}
      <p class="faint" style="font-size:11px">Selecting a run opens its timeline in the Run timeline panel. Runs are never merged — each keeps its own state, events and cost.</p>
    </div>`;
  }

  function dockBody(type, chat, state, fullPage) {
    if (type === "runs") return runsPanelBody(chat, state);
    if (type === "profile") return profileBody(chat, state, fullPage);
    return wsBody(type, chat, state);
  }

  function chatScreen(chat, state) {
    const thread = THREADS[chat.id] || [];
    return `
      <div class="chat-shell">
        <div class="chat-col">
          ${chatHeader(chat, state)}
          <div class="thread-wrap">
            <div class="thread" id="thread">
              <div class="thread-inner">
                ${thread.map(threadItem).join("")}
              </div>
            </div>
          </div>
          ${composer(chat)}
        </div>
      </div>`;
  }

  /* ---------- S7: full-page workspace ---------- */
  function workspaceFull(chat, state, focusType) {
    const runs = RUNS.filter(r => r.chat === chat.id);
    const active = dockPanelMeta(focusType || (runs.length ? "runs" : "files"))[0];
    return `
      <div class="chat-shell">
        <div class="chat-col">
          <div class="chat-head">
            <a class="btn btn-sm btn-ghost" href="#/${chat.id}">${I("chevR", 13)}Back to chat</a>
            <div class="t"><b>Workspace — ${chat.id.replace("agent-", "").replace("op-", "")}</b><span>full-page mode · deep-linkable · panel state preserved</span></div>
            <div class="chat-head-actions">${dockButtons({ ...chat, id: chat.id })}</div>
          </div>
          <div class="ws-fullpage">
            <div class="ws-tabs" role="tablist">
              ${DOCK_PANELS.map(([id, label, icon]) => `<a class="ws-tab ${active === id ? "active" : ""}" role="tab" aria-selected="${active === id}" href="#/workspace/${chat.id}/${id}">${I(icon, 13)}${label}</a>`).join("")}
            </div>
            <div class="ws-body">${dockBody(active, chat, state, true)}</div>
          </div>
        </div>
      </div>`;
  }

  /* ---------- S7: workspace panel bodies (shared by dock + full page) ---------- */
  function wsBody(tab, chat, state) {
    if (tab === "files") {
      return `
        <div class="ws-toolbar">
          <span class="ws-flag">${I("folder", 12)} shared workspace</span><span class="spacer"></span>
          <button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Mockup: upload — storage warns at 80%, blocks at 100%">${I("upload", 12)}Upload</button>
        </div>
        <div class="tree">
          ${WORKSPACE.tree.map(n => `
            <button class="tree-row d${n.depth} ${n.lease ? "locked" : ""}" ${n.lease ? `data-tip="${esc(n.lease)}"` : ""}>
              ${n.type === "folder" || n.folder ? I("folder", 14) : I("file", 13)}
              <span class="grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(n.name)}</span>
              ${n.lease ? `<span class="lease">${I("lock", 10)}lease</span>` : n.size ? `<span class="size">${n.size}</span>` : ""}
            </button>`).join("")}
        </div>
        <p class="faint" style="font-size:11.5px;margin-top:10px">Deletes always ask. Nothing is removed automatically.</p>`;
    }
    if (tab === "editor") {
      return `
        <div class="editor-head">
          <span class="fname mono">${esc(WORKSPACE.editorFile)}</span><span class="spacer"></span>
          <button class="btn btn-xs btn-ghost" data-action="toast" data-toast="You are editing directly — a user action, not agent-gated">${I("check", 11)}Save</button>
        </div>
        <textarea class="editor-area" aria-label="File editor" spellcheck="false">${esc(WORKSPACE.editorContent)}</textarea>
        <p class="faint" style="font-size:11.5px;margin-top:8px">${I("lock", 11)} middleware.ts is write-leased by Developer · task #4 — agent edits show a preview and ask first.</p>`;
    }
    if (tab === "terminal") {
      return `
        <div class="term-meta">
          <span class="ws-flag">${I("terminal", 12)} read-only live view</span>
          <span class="chip quiet" style="height:22px">workdir ~/workspace/projects/shera-bot</span>
          <span class="chip brand" style="height:22px">policy: 2 vCPU · 4 GB · 60 s timeout</span>
        </div>
        <div class="term" role="log" aria-label="Agent terminal activity">${WORKSPACE.terminalLines.map(l => {
          if (l.extra) return `<div><span class="${l.cls}">${esc(l.s)}</span><span class="${l.cls}">${esc(l.extra)}</span><span class="caret"></span></div>`;
          return `<div class="${l.cls}">${esc(l.s)}</div>`;
        }).join("")}</div>`;
    }
    if (tab === "browser") {
      return `
        <div class="term-meta"><span class="ws-flag">${I("eye", 12)} read-only live view</span><span class="spacer"></span><span class="chip quiet" style="height:22px">shared browser profile</span></div>
        <div class="browser-view">
          <div class="browser-bar"><span class="browser-dot"></span><span class="browser-dot"></span><span class="browser-dot"></span><span class="url">${esc(WORKSPACE.browser.url)}</span></div>
          <div class="browser-stage" role="img" aria-label="Live page: ${esc(WORKSPACE.browser.title)}">
            <div class="bk-nav"><span class="bk-logo"></span><span class="bk-txt" style="width:120px"></span><span class="bk-ctl"></span></div>
            <div class="bk-lines">
              <div class="bk-hero"></div>
              <div class="bk-grid"><div class="bk-tile"></div><div class="bk-tile"></div><div class="bk-tile"></div></div>
              <div class="bk-txt" style="width:70%"></div>
              <div class="bk-txt" style="width:55%"></div>
            </div>
          </div>
        </div>
        <p class="faint" style="font-size:11.5px;margin-top:8px">${esc(WORKSPACE.browser.title)} — direct takeover is future work.</p>`;
    }
    if (tab === "tasks") {
      const runs = RUNS.filter(r => r.chat === chat.id);
      const sel = runs.find(r => r.id === state.selRun) || runs[0];
      if (!sel) return '<p class="muted">No task runs in this chat yet.</p>';
      return `
        <div class="ws-toolbar">
          <select class="select" style="height:32px;font-size:12px" data-action="select-run" aria-label="Select run">
            ${runs.map(r => `<option ${r.id === sel.id ? "selected" : ""}>${r.id} · ${r.goal}</option>`).join("")}
          </select>
        </div>
        <div class="row" style="margin-bottom:12px">${runStateChip(sel.state)}<span class="chip quiet num">${sel.credits} cr</span></div>
        <div class="stepper">
          ${(sel.steps || [{ label: "Run created from typed behavior (tool proposal)", state: "done", checkpoint: true }, { label: "Semantic checkpoints written", state: sel.state === "SUCCEEDED" ? "done" : "now" }]).map(s => `
            <div class="step ${s.state === "done" ? "done" : s.state === "now" ? "now" : s.state === "fail" ? "fail" : ""} ${s.checkpoint ? "checkpoint" : ""}">
              <span class="step-dot">${I("check", 10)}</span>
              <div class="step-body"><b>${esc(s.label)}</b><small>${s.checkpoint ? "durable checkpoint" : ""}</small></div>
            </div>`).join("")}
        </div>
        <hr class="divider" style="margin:14px 0">
        <div class="row-wrap">
          <span class="chip sky">${I("retry", 10)}retries: bounded ×3</span>
          <span class="chip quiet">recovery: resume from last safe step</span>
        </div>`;
    }
    if (tab === "tools") {
      return `
        <div class="ws-toolbar"><span class="ws-flag">${I("history", 12)} tool history · redaction-safe</span></div>
        <table class="tbl">
          <thead><tr><th>Tool</th><th>Agent</th><th>Status</th><th>Risk</th></tr></thead>
          <tbody>${TOOL_HISTORY.map(t => `
            <tr>
              <td><span class="mono" style="font-size:12px">${esc(t.tool)}</span><br><span class="faint" style="font-size:11px">${esc(t.args)}</span></td>
              <td>${esc(agentById(t.agent.toLowerCase().replace("citation manager", "citation-manager").replace(" ", "-")).name)}</td>
              <td><span class="chip ${t.status === "succeeded" ? "live" : t.status === "waiting approval" ? "warn" : "sky"}" style="height:20px;font-size:10px">${esc(t.status)}</span></td>
              <td>${riskBadge(t.risk, t.risk)}</td>
            </tr>`).join("")}</tbody>
        </table>`;
    }
    if (tab === "private") {
      const sel = state.wsPrivateAgent || "researcher";
      const files = WORKSPACE.privateFiles[sel] || ["memory/journal.md", "skills/profile.md"];
      const a = agentById(sel);
      return `
        <div class="ws-toolbar">
          <select class="select" style="height:32px;font-size:12px" data-action="ws-private" aria-label="Choose agent private folder">
            ${WORKSPACE.privateAgents.map(id => `<option value="${id}" ${id === sel ? "selected" : ""}>${agentById(id).name}</option>`).join("")}
          </select>
        </div>
        <div class="row" style="margin-bottom:12px">${avatar(sel)}<b>${esc(a.name)} · private folder</b><span class="spacer"></span><span class="chip warn" style="height:22px">${I("lock", 10)}private</span></div>
        <div class="tree">${files.map(f => `<div class="tree-row d1">${I("file", 13)}<span class="grow">${esc(f)}</span></div>`).join("")}</div>
        <p class="faint" style="font-size:11.5px;margin-top:10px">Private memory reaches an Operation only through an explicit publication step.</p>`;
    }
    return "";
  }

  /* ---------- S5: launch preview ---------- */
  function preview(state) {
    const t = tmplById(state.previewId || "research-paper");
    return `
    <div class="overlay" data-action="close-overlay" role="dialog" aria-modal="true" aria-label="Operation launch preview">
      <div class="modal preview-modal" data-stop>
        <div class="modal-head">
          <span class="glyph sb-op-icon" style="width:42px;height:42px;border-radius:13px;background:var(--brand-bg);display:grid;place-items:center">${I("operation", 20)}</span>
          <div class="grow">
            <h2>Launch “${esc(t.name)}”</h2>
            <p class="muted" style="font-size:12.5px;margin-top:3px">student pack v1 · preview gate — nothing executes until you confirm</p>
          </div>
          <button class="icon-btn" data-action="close-overlay" aria-label="Close preview">${I("x", 16)}</button>
        </div>
        <div class="modal-body">
          <div class="pv-grid">
            <div class="pv-section wide">
              <h4>${I("briefcase", 15)}Purpose</h4>
              <p class="pv-purpose">${esc(t.purpose)}</p>
            </div>
            <div class="pv-section">
              <h4>${I("user", 15)}Agents · same pack only</h4>
              ${t.agents.map(id => {
                const a = agentById(id);
                const coord = t.coordinator === id;
                return `<div class="pv-agent-row">${avatar(id, "sm")}<div class="t"><b>${esc(a.name)} ${coord ? '<span class="coord-badge">Coordinator</span>' : ""}</b><span>${esc(a.role)}</span></div><button class="x" aria-label="Remove ${esc(a.name)}" data-action="noop">${I("x", 11)}</button></div>`;
              }).join("")}
              <p class="pv-note">Roster changes are validated against pack membership and cost by the runtime.</p>
            </div>
            <div class="pv-section">
              <h4>${I("skill", 15)}Skills</h4>
              ${t.agents.map(id => `<div><span class="faint mono" style="font-size:10.5px">${esc(agentById(id).name.toUpperCase())}</span><div class="skill-chips" style="margin-top:5px">${t.skills[id].map(s => `<span class="chip">${esc(s)}</span>`).join("")}</div></div>`).join("")}
            </div>
            <div class="pv-section">
              <h4>${I("plug", 15)}Connectors</h4>
              ${t.connectors.map(c => `<div class="row" style="justify-content:space-between"><span style="font-size:13px">${esc(c.name)}</span><span class="chip ${c.status === "connected" ? "live" : "quiet"}" style="height:21px;font-size:10px">${esc(c.status)}</span></div>`).join("")}
              <p class="pv-note">Recommended only — a connector is never auto-installed.</p>
            </div>
            <div class="pv-section">
              <h4>${I("gauge", 15)}Provider / model</h4>
              ${t.agents.map(id => `<div class="row" style="justify-content:space-between"><span style="font-size:12.5px">${esc(agentById(id).name)}</span><span class="mono muted" style="font-size:11px">${esc(agentById(id).provider)}</span></div>`).join("")}
              <p class="pv-note">Per-agent overrides apply before launch.</p>
            </div>
            <div class="pv-section">
              <h4>${I("coins", 15)}Estimated credits</h4>
              <div class="pv-est"><b class="num">${t.estimate[0]}–${t.estimate[1]}</b><span class="pv-note">cr range</span></div>
              <p class="pv-note">A bounded estimate is reserved now; actual usage settles after execution. Custom-provider agents consume no Shera credits.</p>
            </div>
            <div class="pv-section">
              <h4>${I("shield", 15)}Approval requirements</h4>
              <p class="pv-purpose" style="font-size:12.5px">${esc(t.approvals)}</p>
            </div>
            <div class="pv-section wide">
              <h4>${I("box", 15)}Expected outputs</h4>
              <div class="skill-chips">${t.outputs.map(o => `<span class="chip mono">${esc(o)}</span>`).join("")}</div>
            </div>
          </div>
          <div class="pv-footer">
            <button class="btn btn-ghost" data-action="close-overlay">Cancel</button>
            <button class="btn btn-primary" data-action="launch-op" data-template="${t.id}">${I("play", 15)}Launch Operation</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ---------- S6: ad-hoc creation ---------- */
  function createAdhoc(state) {
    const sel = state.adhocRoster || ["general-assistant"];
    return `
      <main class="page"><div class="page-inner">
        <div class="create-wrap">
          <div class="page-title-row" style="margin-bottom:6px"><div><h1>New ad-hoc Operation</h1><p class="sub">A reusable collaborative chat with a custom same-pack roster. Same pinning, same validation as pack-defined Operations.</p></div></div>
          <div class="card card-pad col" style="gap:20px">
            <div class="field">
              <label for="adhoc-name">Name <span class="faint" style="font-weight:400">— optional, defaults to “Ad-hoc”</span></label>
              <input class="input" id="adhoc-name" placeholder="Ad-hoc">
            </div>
            <div class="field">
              <label>Roster — minimum one Agent, same pack only</label>
              <div class="agent-pick-grid">
                ${AGENTS.map(a => `
                  <button class="agent-pick ${sel.includes(a.id) ? "sel" : ""}" data-action="toggle-roster-agent" data-agent="${a.id}" aria-pressed="${sel.includes(a.id)}">
                    ${avatar(a.id)}<span class="t"><b>${esc(a.name)}</b><span>${esc(a.role)}</span></span>
                    <span class="tick">${I("check", 11)}</span>
                  </button>`).join("")}
              </div>
            </div>
            <div class="field">
              <label for="adhoc-coord">Coordinator</label>
              <select class="select" id="adhoc-coord">
                <option>General Assistant (recommended default)</option>
                ${sel.filter(id => id !== "general-assistant").map(id => `<option>${esc(agentById(id).name)}</option>`).join("")}
                <option>No coordinator — peer-to-peer (runtime still authoritative)</option>
              </select>
              <p class="faint" style="font-size:11.5px">The default coordinator is removable. Without one, Agents coordinate peer-to-peer through the typed protocol.</p>
            </div>
            <div class="field">
              <label for="adhoc-provider">Provider / model overrides <span class="faint" style="font-weight:400">— optional</span></label>
              <select class="select" id="adhoc-provider"><option>Keep each Agent's default</option><option>OpenAI · GPT-4o for everyone</option><option>Ollama · llama3:70b (local, no credits)</option></select>
            </div>
            <div class="row" style="justify-content:flex-end;padding-top:4px">
              <a class="btn btn-ghost" href="#/app">Cancel</a>
              <button class="btn btn-primary ${sel.length === 0 ? "" : ""}" data-action="create-adhoc" ${sel.length === 0 ? "disabled" : ""}>${I("operation", 15)}Create Operation</button>
            </div>
          </div>
        </div>
      </div></main>`;
  }

  /* ---------- S9: settings ---------- */
  const SET_SECTIONS = [
    ["account", "Account", "user"], ["agents", "Agents", "agent"], ["providers", "Providers & models", "plug"],
    ["credits", "Model budgets / credits", "coins"], ["tools", "Tools", "box"], ["permissions", "Permissions & approvals", "shield"],
    ["workspace", "Workspace", "layers"], ["files", "Files & projects", "folder"], ["memory", "Memory", "book"],
    ["schedules", "Schedules & watchers", "clock"], ["notifications", "Notifications", "bell"],
    ["privacy", "Privacy & retention", "lock"], ["runtime", "Runtime & resources", "gauge"],
    ["git", "Git & repositories", "branch"], ["backups", "Backups & recovery", "archive"],
  ];

  function settings(state) {
    const sec = state.setSection || "account";
    return `
      <main class="page"><div class="page-inner">
        <div class="page-title-row" style="margin-top:16px"><div><h1>Settings</h1><p class="sub">Every value shows its recommended default, current state, and why it matters.</p></div></div>
        <div class="set-layout">
          <nav class="set-nav" aria-label="Settings sections">
            ${SET_SECTIONS.map(([id, label, icon]) => `<button class="${sec === id ? "active" : ""}" data-action="set-section" data-section="${id}">${I(icon, 15)}${label}</button>`).join("")}
          </nav>
          <div class="set-pane">${setSection(sec)}</div>
        </div>
      </div></main>`;
  }

  function setRow(title, desc, ctl) {
    return `<div class="set-row"><div class="t"><b>${title}</b><span>${desc}</span></div><div class="ctl">${ctl}</div></div>`;
  }
  const sw = (on, action) => `<label class="switch"><input type="checkbox" ${on ? "checked" : ""} data-action="${action}" aria-label="toggle"><i></i></label>`;

  function setSection(sec) {
    if (sec === "account") return `
      <div class="set-head"><h2>Account</h2><p>Google identity, tier, and storage. The administrator manages accounts; tiers are simulated in the prototype.</p></div>
      <div class="card card-pad set-block">
        <div class="row">${avatarlessUser()}<div class="grow"><b style="font-size:14.5px">${esc(USER.name)}</b><div class="muted" style="font-size:12.5px">${esc(USER.email)} · Google OAuth only</div></div><span class="chip brand">${esc(USER.tier)} tier · simulated</span></div>
        ${setRow("Storage", `Used <b class="num">${USER.storageUsedPct}%</b> of 25 GB (Balanced). Warns at 80%, blocks create/expand at 100% — chat, reading, deletion and export keep working.`, `<span class="storage-meter ${USER.storageUsedPct >= 80 ? "warn" : ""}" style="width:140px" aria-label="${USER.storageUsedPct} percent"><i style="width:${USER.storageUsedPct}%"></i></span>`)}
        ${setRow("Administrator", "Your account is not flagged as administrator. The admin console is a separate deferred surface (E7).", `<span class="chip quiet">not admin</span>`)}
      </div>`;
    if (sec === "agents") return `
      <div class="set-head"><h2>Agents</h2><p>Six pack Agents with persistent identity: one profile, one memory, one settings surface — everywhere they appear.</p></div>
      <div class="set-block">${AGENTS.map(a => `
        <div class="card card-pad">
          <div class="row">${avatar(a.id)}<div class="grow"><b style="font-size:14px">${esc(a.name)}</b><div class="muted" style="font-size:12.5px">${esc(a.role)} · default ${esc(a.provider)}</div></div>
          <button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Mockup: editable user instructions, memory link, tool defaults">Edit profile</button></div>
          <p class="muted" style="font-size:12.5px;margin-top:10px">${esc(a.blurb)}</p>
        </div>`).join("")}</div>`;
    if (sec === "providers") return `
      <div class="set-head"><h2>Providers & models</h2><p>Keys are local-first, masked, and revocable — never re-displayed. A missing provider shows a clear configuration state, never fake completion.</p></div>
      <div class="set-block">
        ${PROVIDERS.map(p => `
          <div class="card card-pad">
            <div class="row"><div class="grow"><b style="font-size:14px">${esc(p.name)}</b> <span class="chip quiet" style="height:20px;font-size:10px">${esc(p.kind)}</span><div class="muted" style="font-size:12.5px;margin-top:3px">${esc(p.detail)} ${p.maskedKey ? `· <span class="masked">${esc(p.maskedKey)}</span>` : ""}</div></div>
            <span class="chip ${p.status === "connected" ? "live" : "quiet"}">${p.status}</span>
            ${p.status === "connected" ? `<button class="btn btn-xs btn-ghost" data-action="test-conn" data-provider="${p.id}">Test</button><button class="btn btn-xs btn-danger" data-action="toast" data-toast="Mockup: revoke — the key is replaced, never re-displayed">Revoke</button>` : `<button class="btn btn-xs btn-soft" data-action="toast" data-toast="Mockup: key entry is masked and local-first">Configure</button>`}
          </div>
        </div>`).join("")}
        <div class="card card-pad">
          <b style="font-size:14px">Add custom provider</b>
          <div class="kv" style="margin-top:12px;grid-template-columns:150px 1fr">
            <span class="k">Display name</span><input class="input" placeholder="my-vllm-box" style="max-width:340px">
            <span class="k">Protocol</span><select class="select" style="max-width:340px"><option>OpenAI-compatible</option><option>Ollama / local</option></select>
            <span class="k">Base URL</span><input class="input" placeholder="http://host:8000/v1" style="max-width:340px">
            <span class="k">API key</span><input class="input" type="password" placeholder="or choose no-key mode" style="max-width:340px">
            <span class="k">Model id</span><input class="input" placeholder="mixtral-8x22b" style="max-width:340px">
            <span class="k">Headers / params</span><input class="input" placeholder="optional, one per line" style="max-width:340px">
          </div>
          <div class="row" style="margin-top:14px;justify-content:flex-end;gap:8px">
            <button class="btn btn-sm btn-ghost" data-action="test-conn" data-provider="new">Test connection</button>
            <button class="btn btn-sm btn-primary" data-action="toast" data-toast="Mockup: saved locally in the user container · key masked immediately">Save provider</button>
          </div>
        </div>
      </div>`;
    if (sec === "credits") return `
      <div class="set-head"><h2>Model budgets / credits</h2><p>Prototype accounting for platform-provider usage — requests reserve, settle against actual usage, and release the rest. Not billing.</p></div>
      <div class="set-block">
        <div class="ov-kpis" style="grid-template-columns:repeat(3,1fr)">
          ${kpiCard({ label: "Balance", num: CREDITS.balance.toLocaleString(), foot: "Shera credits" })}
          ${kpiCard({ label: "Reserved now", num: CREDITS.reserved, foot: "held by active runs · released on settle", })}
          ${kpiCard({ label: "Used this month", num: CREDITS.usedMonth.toLocaleString(), foot: "settled" })}
        </div>
        <div class="card">
          <div class="card-head"><h3>Per-run cost</h3></div>
          <div class="card-pad" style="padding-top:8px">
            <table class="tbl"><thead><tr><th>Run</th><th>Reserved</th><th>Settled</th><th>State</th></tr></thead>
            <tbody>
              <tr><td class="mono" style="font-size:12px">run-3 · Research Paper</td><td class="num">45</td><td class="num">42</td><td>${runStateChip("WAITING_FOR_APPROVAL")}</td></tr>
              <tr><td class="mono" style="font-size:12px">run-2a · Ad-hoc</td><td class="num">20</td><td class="num">17 so far</td><td>${runStateChip("RUNNING")}</td></tr>
              <tr><td class="mono" style="font-size:12px">run-2 · Research Paper</td><td class="num">120</td><td class="num">118</td><td>${runStateChip("SUCCEEDED")}</td></tr>
            </tbody></table>
          </div>
        </div>
        <p class="muted" style="font-size:12.5px">${esc(CREDITS.customNote)} If a reservation cannot be made, the task pauses <b>before</b> calling the model.</p>
      </div>`;
    if (sec === "tools") return `
      <div class="set-head"><h2>Tools</h2><p>Runtime-owned executables and agent-created tools. Agents propose; the runtime validates and executes — no bypass.</p></div>
      <div class="card">
        <div class="card-head"><h3>Inventory</h3><span class="spacer"></span><span class="chip quiet num">${TOOLS.length} tools</span></div>
        <div class="card-pad" style="padding-top:8px">
          <table class="tbl"><thead><tr><th>Tool</th><th>Owner</th><th>Scope</th><th>Risk class</th><th>Policy</th></tr></thead>
          <tbody>${TOOLS.map(t => `
            <tr><td class="mono" style="font-size:12px">${esc(t.name)} ${t.version}</td><td>${esc(t.owner)}</td>
            <td><span class="chip ${t.scope === "private" ? "warn" : "quiet"}" style="height:20px;font-size:10px">${esc(t.scope)}</span></td>
            <td>${riskBadge(t.risk, t.riskLabel)}</td><td class="muted" style="font-size:12px">${esc(t.note)}</td></tr>`).join("")}</tbody></table>
        </div>
      </div>
      <p class="muted" style="font-size:12.5px">Agent-created tools are declarative, versioned records. Creation follows the preview policy; risky tools need explicit approval and a runtime grant to activate.</p>`;
    if (sec === "permissions") return `
      <div class="set-head"><h2>Permissions & approvals</h2><p>Risky actions pause by default. Grants are scoped, expiring, revocable runtime objects — never “full access”.</p></div>
      <div class="set-block">
        <div class="card card-pad">
          ${setRow("Pause for approval", "Destructive files, repo mutation, external writes, messages, deployments and purchases pause by default.", sw(true, "noop"))}
          ${setRow("Reminder sequence", "Immediate → 15 min → 45 min → 3 h → 24 h. Nothing after 24 h; muting stops notifications only.", `<span class="chip quiet num">fixed by policy</span>`)}
        </div>
        <div class="card">
          <div class="card-head"><h3>Active grants</h3><span class="spacer"></span><span class="chip quiet num">${GRANTS.length}</span></div>
          <div class="card-pad" style="padding-top:8px">
            <table class="tbl"><thead><tr><th>Grant</th><th>Scope</th><th>Expiry</th><th>Created</th><th></th></tr></thead>
            <tbody>${GRANTS.map(g => `
              <tr><td><b style="font-size:12.5px">${esc(g.agent)}</b><br><span class="mono faint" style="font-size:11px">${esc(g.tool)}</span></td>
              <td class="muted" style="font-size:12px">${esc(g.scope)}</td><td class="num" style="font-size:12px">${esc(g.expiry)}</td><td class="muted" style="font-size:12px">${esc(g.created)} · ${esc(g.by)}</td>
              <td><button class="btn btn-xs btn-danger" data-action="revoke-grant" data-grant="${g.id}">Revoke</button></td></tr>`).join("")}</tbody></table>
          </div>
        </div>
      </div>`;
    if (sec === "workspace") return `
      <div class="set-head"><h2>Workspace</h2><p>One workspace per user — your container. The pinned pack is shown here, never switched.</p></div>
      <div class="card card-pad set-block">
        <div class="row">${Icons.logo("logo-mid").replace("logo-mid", "")}<div class="grow"><b style="font-size:14.5px">student pack ${esc(PACK.version)}</b><div class="muted" style="font-size:12.5px">Pinned by policy · ${PACK.agents} Agents · ${PACK.operations} Operations · config and data, not executable code</div></div><span class="chip brand">pinned</span></div>
        ${setRow("Workspace policy", "Records are scoped by workspace id internally; the prototype exposes no workspace switcher (D40).", `<span class="chip quiet">1 workspace</span>`)}
      </div>`;
    if (sec === "files") return `
      <div class="set-head"><h2>Files & projects</h2><p>Projects are shared by default with optional restriction to selected Agents.</p></div>
      <div class="set-block">
        ${PROJECTS.map(p => `
          <div class="card card-pad">
            <div class="row"><span class="glyph" style="width:36px;height:36px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line-soft);display:grid;place-items:center">${I("git", 16)}</span>
            <div class="grow"><b style="font-size:14px">${esc(p.name)}</b><div class="muted mono" style="font-size:11.5px">${esc(p.repo)}</div></div>
            <span class="chip ${p.visibility.startsWith("shared") ? "quiet" : "warn"}" style="height:22px">${esc(p.visibility)}</span></div>
            <div class="row-wrap muted" style="font-size:12px;margin-top:10px">
              <span class="chip quiet" style="height:22px">credential: ${esc(p.credential)}</span>
              <span class="chip quiet" style="height:22px">worktree: ${esc(p.worktree)}</span>
            </div>
          </div>`).join("")}
        <div class="row" style="gap:10px">
          <button class="btn btn-primary btn-sm" data-action="toast" data-toast="Mockup: upload project archive">${I("upload", 13)}Upload archive</button>
          <button class="btn btn-ghost btn-sm" data-action="toast" data-toast="Mockup: clone from Git URL — credentials stored per-repo, masked">${I("git", 13)}Clone repository</button>
        </div>
      </div>`;
    if (sec === "memory") return `
      <div class="set-head"><h2>Memory</h2><p>One shared workspace memory plus private memory per Agent — with provenance, versioning, and a publication boundary.</p></div>
      <div class="set-block">
        <div class="card card-pad"><b style="font-size:14px">Shared workspace memory</b><div class="col" style="margin-top:10px">
          ${MEMORY.shared.map(m => `<div class="memory-item"><span class="prov">${I("history", 11)}${esc(m.prov)}</span><p>${esc(m.text)}</p><div class="row"><button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Mockup: edit memory">Edit</button><button class="btn btn-xs btn-danger" data-action="toast" data-toast="Mockup: permanently forget — versioned, restorable">Forget</button></div></div>`).join("")}
        </div></div>
        <div class="card card-pad"><b style="font-size:14px">Private memory</b><div class="col" style="margin-top:10px">
          ${MEMORY.private.map(m => `<div class="memory-item"><span class="prov">${I("lock", 11)}${esc(m.prov)}</span><p>${esc(m.text)}</p></div>`).join("")}
          <p class="faint" style="font-size:11.5px">Secrets are always rejected — the UI shows the rejection, never an input that pretends to work.</p>
        </div></div>
        <div class="card card-pad"><b style="font-size:14px">Publication queue</b><div class="col" style="margin-top:10px">
          ${MEMORY.publishQueue.map(m => `
            <div class="memory-item" style="border-color:var(--line-accent)">
              <span class="prov">${I("spark", 11)}${esc(m.prov)}</span><p>${esc(m.text)}</p>
              <div class="row"><button class="btn btn-xs btn-primary" data-action="publish-memory">Publish to Operation</button><button class="btn btn-xs btn-ghost" data-action="toast" data-toast="Dismissed — stays private">Dismiss</button></div>
            </div>`).join("")}
        </div></div>
      </div>`;
    if (sec === "schedules") return `
      <div class="set-head"><h2>Schedules & watchers</h2><p>Autonomous triggers — each one is visible and pausable. Schedules restart without duplication after a restart.</p></div>
      <div class="card card-pad set-block">
        ${SCHEDULES.map(s => setRow(`${esc(s.name)} <span class="chip quiet" style="height:19px;font-size:9.5px">${esc(s.trigger)}</span>`, esc(s.detail), sw(s.active, "noop"))).join("")}
      </div>`;
    if (sec === "notifications") return `
      <div class="set-head"><h2>Notifications</h2><p>In-app always; browser notifications only when the tab is open but unfocused.</p></div>
      <div class="card card-pad">
        ${setRow("In-app notifications", "Completion, failure, approval-required, recovery.", sw(true, "noop"))}
        ${setRow("Browser notifications", "Only while the tab is open in the background.", sw(true, "noop"))}
        ${setRow("Approval reminders", "The reminder sequence is fixed; muting stops notifications only — the approval stays visible and the task stays paused.", sw(true, "noop"))}
      </div>`;
    if (sec === "privacy") return `
      <div class="set-head"><h2>Privacy & retention</h2></div>
      <div class="card card-pad set-block">
        ${setRow("Data location", "Everything product-level lives in your container: conversations, files, memories, tasks, provider keys, browser state. The central service stores only your identity and container mapping.", `<span class="chip live">local-first</span>`)}
        ${setRow("Redaction", "Errors render a safe message only. Provider keys, Git credentials and cookies never appear in prompts, logs, memory, or this UI.", `<span class="chip quiet">always on</span>`)}
        ${setRow("Export & purge", "User data export and permanent purge are future work; snapshots retain the latest seven.", `<span class="chip quiet">deferred</span>`)}
      </div>`;
    if (sec === "runtime") return `
      <div class="set-head"><h2>Runtime & resources</h2><p>Your container is your cloud computer. When resources run out, healthy work continues and new jobs queue — nothing healthy is killed.</p></div>
      <div class="set-block">
        <div class="card"><div class="card-pad">
          <table class="tbl tier-table"><thead><tr><th>Tier</th><th>CPU</th><th>RAM</th><th>Storage</th><th></th></tr></thead>
          <tbody>
            <tr><td>Light</td><td class="num">1 vCPU</td><td class="num">2 GB</td><td class="num">10 GB</td><td></td></tr>
            <tr><td class="cur">Balanced</td><td class="num">2 vCPU</td><td class="num">4 GB</td><td class="num">25 GB</td><td><span class="chip brand" style="height:20px">current</span></td></tr>
            <tr><td>Heavy</td><td class="num">4 vCPU</td><td class="num">8 GB</td><td class="num">50 GB</td><td></td></tr>
          </tbody></table>
        </div></div>
        <div class="card card-pad">
          ${setRow("Queue state", "1 job queued (capacity) — healthy runs unaffected.", `<span class="chip warn">QUEUED · capacity</span>`)}
          ${setRow("Gateway", "Runtime gateway supervising 2 agent sessions, 3 task workers.", `<span class="chip live">healthy</span>`)}
        </div>
      </div>`;
    if (sec === "git") return `
      <div class="set-head"><h2>Git & repositories</h2><p>Coding agents work on separate branches and worktrees. Related conflicting work queues rather than merging concurrently.</p></div>
      <div class="card card-pad">
        ${setRow("Branch strategy", "Each coding task gets an agent-specific branch + worktree (currently: wt/auth-fix).", `<span class="chip sky mono" style="height:22px">wt/auth-fix</span>`)}
        ${setRow("Merge review", "The coordinating Agent prepares merges and asks first. Review shows summary, changed files, validation, conflicts, target branch — the agent never silently merges to main.", sw(true, "noop"))}
      </div>`;
    if (sec === "backups") return `
      <div class="set-head"><h2>Backups & recovery</h2><p>Snapshots run automatically; restore is administrator-triggered.</p></div>
      <div class="card card-pad set-block">
        ${setRow("Snapshot schedule", `${esc(BACKUPS.every)} · keeping the latest ${BACKUPS.keep}.`, `<span class="chip live">active</span>`)}
        <table class="tbl"><thead><tr><th>Snapshot</th><th>When</th><th>Size</th><th></th></tr></thead>
        <tbody>${BACKUPS.latest.map(b => `<tr><td class="mono" style="font-size:12px">${b.id}</td><td>${b.when}</td><td class="num">${b.size}</td><td><span class="chip quiet" style="height:20px;font-size:10px">admin restore</span></td></tr>`).join("")}</tbody></table>
      </div>`;
    return "";
  }

  function avatarlessUser() {
    return `<span class="avatar lg" style="background:#0f766e">${USER.googleInitials}</span>`;
  }

  /* ---------- S10: notifications popover ---------- */
  function notifications() {
    const iconFor = { approval: ["alert", "warn"], success: ["check", "live"], failed: ["x", "bad"], recovery: ["recovery", "warn"] };
    return `
    <div class="popover" role="menu" aria-label="Notifications" data-pop>
      <div class="pop-head"><h3>Notifications</h3><span class="spacer"></span><button class="btn btn-xs btn-ghost" data-action="mark-all-read">Mark all read</button></div>
      <div class="notif-list">
        ${NOTIFICATIONS.map(n => {
          const [ic, tone] = iconFor[n.kind] || ["info", "quiet"];
          return `<button class="notif-item ${n.unread ? "unread" : ""}" data-action="goto" data-href="${n.link}">
            <span class="glyph" style="background:var(--${tone === "live" ? "live" : tone}-bg);color:var(--${tone === "live" ? "live" : tone})">${I(ic, 14)}</span>
            <span class="t"><b>${esc(n.title)}</b><span>${esc(n.body)}</span></span>
            <span class="when num">${esc(n.when)}</span>
          </button>`;
        }).join("")}
      </div>
      <div class="account-foot">Browser notifications fire only when the tab is open but unfocused. Mute scopes live in Settings → Notifications.</div>
    </div>`;
  }

  function accountPop() {
    return `
    <div class="popover account-pop" role="menu" aria-label="Account" data-pop>
      <div class="account-id">${avatarlessUser()}<div class="t"><b>${esc(USER.name)}</b><span>${esc(USER.email)}</span></div></div>
      <div class="account-links">
        <button data-action="toggle-theme">${App.state.theme === "dark" ? I("sun", 15) : I("moon", 15)}${App.state.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}</button>
        <button data-action="open-notifs">${I("bell", 15)}Notifications <span class="spacer"></span><span class="chip ${NOTIFICATIONS.some(n => n.unread) ? "warn" : "quiet"}" style="height:20px;font-size:10px">${NOTIFICATIONS.filter(n => n.unread).length} unread</span></button>
        <a href="#/settings/account">${I("user", 15)}Profile & tier <span class="spacer"></span><span class="chip brand" style="height:20px;font-size:10px">${esc(USER.tier)}</span></a>
        <a href="#/settings/credits">${I("coins", 15)}Credits <span class="spacer"></span><b class="num" style="font-size:12px">1,240 cr</b></a>
        <a href="#/settings">${I("settings", 15)}Settings</a>
        <button data-action="open-demo">${I("spark", 15)}Scripted demo <span class="spacer"></span><span class="faint" style="font-size:11px">mock runtime</span></button>
        <button data-action="toggle-conn">${I("activity", 15)}Connection: ${App.state.conn} <span class="spacer"></span><span class="faint" style="font-size:11px">simulate</span></button>
        <button data-action="logout">${I("x", 15)}Sign out</button>
      </div>
      <div class="account-foot">Storage <b class="num">${USER.storageUsedPct}%</b> of 25 GB · warns at 80% · nothing auto-deleted.</div>
    </div>`;
  }

  /* Search modal (2026-09-13): a local navigation palette. It filters chat
     names, templates and settings sections from fixtures — it does NOT search
     message contents, and the footer says so. */
  function searchModal(state) {
    const q = (state.searchQuery || "").trim().toLowerCase();
    const index = [
      ...AGENTS.map(a => ({ icon: "agent", label: a.name, sub: a.role, href: "#/agent-" + a.id })),
      ...CHATS.list.filter(c => c.type === "operation").map(c => ({ icon: "operation", label: c.name, sub: "Operation chat", href: "#/" + c.id })),
      ...OP_TEMPLATES.map(t => ({ icon: "operation", label: t.name, sub: "Launch template — preview confirms first", tpl: t.id })),
      { icon: "overview", label: "Overview", sub: "Runs, activity and schedules", href: "#/overview" },
      { icon: "settings", label: "Settings", sub: "All sections", href: "#/settings" },
      ...[["account", "Account"], ["providers", "Providers & models"], ["credits", "Credits"], ["permissions", "Permissions"], ["memory", "Memory"], ["privacy", "Privacy"]].map(([id, label]) => ({ icon: "settings", label, sub: "Settings section", href: "#/settings/" + id })),
    ];
    const hits = q ? index.filter(x => (x.label + " " + x.sub).toLowerCase().includes(q)) : index.slice(0, 6);
    return `
    <div class="overlay" data-action="close-search" role="dialog" aria-modal="true" aria-label="Search">
      <div class="modal search-modal" data-stop>
        <div class="search-row">
          ${I("search", 16)}
          <input id="search-modal-input" type="search" placeholder="Search chats, templates, settings…" aria-label="Search" autocomplete="off">
          <button class="icon-btn" data-action="close-search" aria-label="Close search">${I("x", 15)}</button>
        </div>
        <div class="search-hits">
          ${hits.length ? hits.map(h => h.tpl
            ? `<button class="search-hit" data-action="open-preview" data-id="${h.tpl}">${I(h.icon, 15)}<span class="grow"><b>${esc(h.label)}</b><span>${esc(h.sub)}</span></span></button>`
            : `<a class="search-hit" data-action="goto" data-href="${h.href}" href="${h.href}">${I(h.icon, 15)}<span class="grow"><b>${esc(h.label)}</b><span>${esc(h.sub)}</span></span></a>`).join("")
          : `<p class="search-empty">Nothing matches that. Search covers chat names, templates and settings sections in this mockup — not message contents.</p>`}
        </div>
        <p class="search-foot">Enter opens the first result · ↑↓ to move · Esc closes · searches chats, templates and settings — not message contents</p>
      </div>
    </div>`;
  }

  function demoPop() {
    return `
    <div class="popover demo-pop" role="menu" aria-label="Demo controls" data-pop>
      <div class="pop-head"><h3>Scripted demo</h3><span class="spacer"></span><span class="chip brand" style="height:21px;font-size:10px">mock runtime</span></div>
      <div class="account-links">
        <button data-action="demo-stream">${I("send", 15)}<span>Stream a reply<small>token streaming with typing cursor</small></span></button>
        <button data-action="demo-tool">${I("box", 15)}<span>Read-only tool call<small>runs automatically — no approval</small></span></button>
        <button data-action="demo-risk">${I("shield", 15)}<span>Risky action<small>pauses the run · opens the approval dialog</small></span></button>
        <button data-action="toggle-conn">${I("wifioff", 15)}<span>Disconnect / reconnect<small>offline banner → replayed-event batch</small></span></button>
      </div>
    </div>`;
  }

  return {
    agentById, tmplById, chatById, avatar, runStateChip, riskBadge, opRoster,
    sidebar, topbar, banners, login, emptyHome, overview, chatScreen, preview,
    createAdhoc, settings, notifications, accountPop, demoPop, searchModal, approvalCard, threadItem, esc,
    workspaceFull, dockView, dockState, dockButtons, dockBody,
  };
})();
