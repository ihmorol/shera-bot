/* ============================================================
   Shera Bot UI mockup — authored inline SVG icon set
   One consistent 24×24 grid, 1.7px stroke, round caps.
   ============================================================ */

const Icons = (function () {
  const S = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  const P = {
    overview: `<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>`,
    agent: `<rect x="5" y="7.5" width="14" height="11" rx="3.5"/><path d="M12 7.5V4.8"/><circle cx="12" cy="3.9" r="1.1"/><circle cx="9.2" cy="12.4" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="12.4" r="1" fill="currentColor" stroke="none"/><path d="M9.5 15.4c1.6 1 3.4 1 5 0"/>`,
    operation: `<path d="M12 3.5 20 8l-8 4.5L4 8l8-4.5Z"/><path d="m4 12.5 8 4.5 8-4.5"/><path d="m4 17 8 4.5L20 17"/>`,
    settings: `<circle cx="12" cy="12" r="3.2"/><path d="M19 12c0-.6.4-1.2 1-1.6-.3-1.2-.8-2.3-1.5-3.2-.6.2-1.3.1-1.8-.4s-.6-1.2-.4-1.8c-1-.7-2-1.2-3.2-1.5-.4.6-1 1-1.6 1s-1.2-.4-1.6-1c-1.2.3-2.3.8-3.2 1.5.2.6.1 1.3-.4 1.8s-1.2.6-1.8.4c-.7 1-1.2 2-1.5 3.2.6.4 1 1 1 1.6s-.4 1.2-1 1.6c.3 1.2.8 2.3 1.5 3.2.6-.2 1.3-.1 1.8.4s.6 1.2.4 1.8c1 .7 2 1.2 3.2 1.5.4-.6 1-1 1.6-1s1.2.4 1.6 1c1.2-.3 2.3-.8 3.2-1.5-.2-.6-.1-1.3.4-1.8s1.2-.6 1.8-.4c.7-1 1.2-2 1.5-3.2-.6-.4-1-1-1-1.6Z"/>`,
    bell: `<path d="M18 9.5a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>`,
    search: `<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.8-3.8"/>`,
    sun: `<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2M12 19.2v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.8 12h2M19.2 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
    moon: `<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>`,
    menu: `<path d="M4 6.5h16M4 12h16M4 17.5h16"/>`,
    plus: `<path d="M12 5v14M5 12h14"/>`,
    play: `<path d="M7 5.3v13.4c0 .8.9 1.3 1.6.9l10.6-6.7c.6-.4.6-1.4 0-1.8L8.6 4.4c-.7-.4-1.6.1-1.6.9Z"/>`,
    pause: `<rect x="6.5" y="5" width="3.6" height="14" rx="1.4"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.4"/>`,
    stop: `<rect x="6" y="6" width="12" height="12" rx="2.5"/>`,
    send: `<path d="m4.5 11.5 15-7-4.5 15-3.4-5.8-7.1-2.2Z"/><path d="M11.6 13.7 19.5 4.5"/>`,
    clip: `<path d="m20 11.5-7.8 7.8a5 5 0 0 1-7-7l8.5-8.5a3.4 3.4 0 0 1 4.8 4.8l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8"/>`,
    at: `<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6-1 10 10 0 1 0-4 8"/>`,
    more: `<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>`,
    chevD: `<path d="m6 9.5 6 6 6-6"/>`,
    chevR: `<path d="m9.5 6 6 6-6 6"/>`,
    arrowUR: `<path d="M7 17 17 7M9 7h8v8"/>`,
    x: `<path d="m6 6 12 12M18 6 6 18"/>`,
    check: `<path d="m5 12.5 4.5 4.5L19 7.5"/>`,
    alert: `<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.2" r=".9" fill="currentColor" stroke="none"/>`,
    info: `<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".9" fill="currentColor" stroke="none"/>`,
    clock: `<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.5"/>`,
    file: `<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5l-5-5Z"/><path d="M13.5 3.5v5h5"/>`,
    folder: `<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2.5h8A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6.5Z"/>`,
    terminal: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="m7 9.5 3 3-3 3M12.5 15.5H17"/>`,
    globe: `<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.6 5.4 3.6 8.5S14.4 18 12 20.5c-2.4-2.5-3.6-5.4-3.6-8.5S9.6 6 12 3.5Z"/>`,
    list: `<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4.3" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.3" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.3" cy="18" r="1" fill="currentColor" stroke="none"/>`,
    history: `<path d="M4 12a8 8 0 1 1 2.3 5.7"/><path d="M4 13.5V9h4.5"/><path d="M12 8.5V12l2.7 2.2"/>`,
    lock: `<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>`,
    shield: `<path d="M12 3.5 5 6v6c0 4.5 3 7.4 7 8.5 4-1.1 7-4 7-8.5V6l-7-2.5Z"/><path d="m9 12 2.2 2.2L15.5 10"/>`,
    key: `<circle cx="8" cy="14.5" r="4"/><path d="m11 11.5 8.5-8.5M16 7l2.5 2.5M13.5 9.5 16 12"/>`,
    coins: `<ellipse cx="9" cy="7" rx="5.5" ry="2.6"/><path d="M3.5 7v4c0 1.4 2.5 2.6 5.5 2.6s5.5-1.2 5.5-2.6V7"/><path d="M3.5 11v4c0 1.4 2.5 2.6 5.5 2.6 1 0 2-.1 2.8-.4"/><path d="M15.5 10.6c2.8.2 5 1.3 5 2.6v4.2c0 1.4-2.4 2.6-5.5 2.6-2 0-3.8-.5-4.7-1.2"/>`,
    database: `<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>`,
    git: `<circle cx="6.5" cy="6" r="2.4"/><circle cx="6.5" cy="18" r="2.4"/><circle cx="17.5" cy="9" r="2.4"/><path d="M6.5 8.4v7.2"/><path d="M17.5 11.4c0 3-4.5 2.6-8 4.2"/>`,
    calendar: `<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>`,
    eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>`,
    download: `<path d="M12 4v11M7.5 11 12 15.5 16.5 11"/><path d="M4.5 19.5h15"/>`,
    upload: `<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 19.5h15"/>`,
    retry: `<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4.5h-4.5"/>`,
    wifioff: `<path d="m3 3 18 18"/><path d="M8.6 15.5a5 5 0 0 1 6.6-.2"/><path d="M5.3 12.2a9.7 9.7 0 0 1 3.2-2M15.8 10c1 .4 2 1 2.9 1.9"/><path d="M2.3 8.9A14.5 14.5 0 0 1 7 6M17 6c1.7.7 3.3 1.7 4.7 2.9"/><circle cx="12" cy="18.8" r="1.2" fill="currentColor" stroke="none"/>`,
    user: `<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.4 4-5 7.5-5s6.3 1.6 7.5 5"/>`,
    spark: `<path d="M12 3v4.5M12 16.5V21M3 12h4.5M16.5 12H21M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2"/>`,
    book: `<path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v15.5H7a2.5 2.5 0 0 0-2.5 2.5V5.5Z"/><path d="M4.5 18.5A2.5 2.5 0 0 1 7 16h12.5"/><path d="M8.5 7.5h7"/>`,
    zap: `<path d="M13 3 4.5 13.5H11L10 21l8.5-10.5H12L13 3Z"/>`,
    box: `<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9L12 3Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>`,
    archive: `<rect x="3.5" y="4" width="17" height="4.5" rx="1.5"/><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"/><path d="M10 12.5h4"/>`,
    activity: `<path d="M3 12h3.5l2.5-6.5 4 13 2.5-6.5H21"/>`,
    recovery: `<path d="M12 8v4.2l2.8 1.7"/><path d="M5.5 6A9 9 0 1 1 3.4 13"/><path d="M5.5 2.5V6H9"/>`,
    merge: `<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="12" r="2"/><path d="M7 7.5v9"/><path d="M7 9c0 3 10 1 10 3"/>`,
    branch: `<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="6" r="2.2"/><path d="M7 8.2v7.6"/><path d="M17 8.2c0 4-10 1.6-10 7.6"/>`,
    layers: `<path d="m12 3.5 9 4.7-9 4.7-9-4.7 9-4.7Z"/><path d="m3.5 12.5 8.5 4.4 8.5-4.4"/><path d="m3.5 16.7 8.5 4.4 8.5-4.4"/>`,
    briefcase: `<rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5"/><path d="M3.5 12.5h17"/>`,
    gauge: `<path d="M4.5 17.5a8.5 8.5 0 1 1 15 0"/><path d="m12 14 3.5-4.5"/><circle cx="12" cy="14.5" r="1.6"/>`,
    credit: `<rect x="3" y="6" width="18" height="12.5" rx="2.5"/><path d="M3 10.5h18"/><path d="M7 15h4"/>`,
    skill: `<path d="m12 4 1.8 4.6L18.5 10l-4.7 1.4L12 16l-1.8-4.6L5.5 10l4.7-1.4L12 4Z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"/>`,
    plug: `<path d="M9 3.5V8M15 3.5V8"/><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z"/><path d="M12 17v3.5"/>`,
    expand: `<path d="M4 9.5V5.5A1.5 1.5 0 0 1 5.5 4h4M20 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-4M14.5 4h4A1.5 1.5 0 0 1 20 5.5v4M9.5 20h-4A1.5 1.5 0 0 1 4 18.5v-4"/>`,
    panelright: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14 4.5v15"/><path d="M16.75 8h1.5M16.75 11h1.5" stroke-width="1.4"/>`,
    sidebar: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M10 4.5v15"/>`,
    drag: `<circle cx="9" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="7" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="17" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="1.1" fill="currentColor" stroke="none"/>`,
    columns: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.2 4.5v15M14.8 4.5v15"/>`,
  };

  // Brand logo mark: orbit + satellite on a cobalt tile
  function logo(cls) {
    return `<svg class="${cls || "sb-logo"}" viewBox="0 0 40 40" aria-hidden="true">
      <defs><linearGradient id="lg-brand" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#0ea5e9"/>
      </linearGradient></defs>
      <rect width="40" height="40" rx="11.5" fill="url(#lg-brand)"/>
      <circle cx="20" cy="20" r="9" fill="none" stroke="#fff" stroke-width="3.2"/>
      <circle cx="30.5" cy="9.5" r="3.8" fill="#7dd3fc"/>
      <circle cx="20" cy="20" r="2.6" fill="#fff"/>
    </svg>`;
  }

  // Google sign-in glyph (standard four-color G used on OAuth buttons)
  function google() {
    return `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9Z"/>
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7Z"/>
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44Z"/>
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9Z"/>
    </svg>`;
  }

  function get(name, size) {
    const body = P[name];
    if (!body) return "";
    const s = size || 18;
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" ${S} aria-hidden="true">${body}</svg>`;
  }

  return { get, logo, google };
})();
