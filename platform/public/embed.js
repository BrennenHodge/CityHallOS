/*!
 * City Hall OS: AI City Clerk chat.
 * Add to any website:
 *   <script src="https://app.cityhallos.com/embed.js" data-city="wiggins" async></script>
 * Options: data-mode="page" with data-target="#el" renders inline (resident portal); data-open="true" opens on load.
 */
(() => {
  const script = document.currentScript || document.querySelector('script[src*="embed.js"][data-city]');
  if (!script || window.__cityhallos) return;
  window.__cityhallos = true;
  const CITY = script.dataset.city || 'wiggins';
  const ORIGIN = script.dataset.api || new URL(script.src, location.href).origin;
  const API = `${ORIGIN}/api/${CITY}`;
  const PAGE = script.dataset.mode === 'page';
  const KEY = `chos:${CITY}`;

  const store = {
    load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } },
    save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICONS = {
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    build: '<path d="M3 21h18M5 21V10l7-5 7 5v11"/><path d="M9 21v-6h6v6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
    store: '<path d="M4 9h16l-1-5H5L4 9Z"/><path d="M5 9v11h14V9"/><path d="M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M10 20v-5h4v5"/>',
    sign: '<rect x="3" y="4" width="18" height="10" rx="1.5"/><path d="M8 14v7M16 14v7M7 9h10"/>',
    map: '<path d="m9 4-6 2.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Z"/><path d="M9 4v13.5M15 6.5V20"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8Z"/><path d="M12 17v5"/>',
    ruler: '<path d="m3 17 14-14 4 4L7 21l-4-4Z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 11h6M9 15h4"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  };
  const icon = (n, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
  const SEAL = '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><path d="M16 6.5 25 11H7z" fill="currentColor"/><rect x="9" y="13" width="2.6" height="8" rx="1" fill="currentColor"/><rect x="14.7" y="13" width="2.6" height="8" rx="1" fill="currentColor"/><rect x="20.4" y="13" width="2.6" height="8" rx="1" fill="currentColor"/><rect x="7" y="22.5" width="18" height="3" rx="1.2" fill="currentColor"/></svg>';
  const VERIFY_NOTE = { historical: 'Historical', secondary: 'News report', unverified: 'Needs confirmation', official_unverified: 'Published version' };
  const STATUS = { new: 'Received', needs_info: 'Needs information', assigned: 'Assigned to a crew', in_progress: 'In progress', awaiting_review: 'Awaiting review', resolved: 'Resolved', closed: 'Closed' };
  const STEPS = ['new', 'assigned', 'in_progress', 'resolved'];
  const PERMIT_STATUS = { submitted: 'Submitted', needs_info: 'Changes requested', fees_due: 'Complete · fee due', in_review: 'Under review', issued: 'Approved', closed: 'Closed', denied: 'Not approved', withdrawn: 'Withdrawn', draft: 'Draft' };
  const PERMIT_STEPS = ['submitted', 'fees_due', 'in_review', 'issued'];
  const REF = /\b[A-Z]{2,5}-(?:[A-Z]{2}-)?\d{4,6}\b/i;

  const CSS = `
  :host { all: initial; }
  [hidden] { display: none !important; }
  * { box-sizing: border-box; }
  .root { --brand: #1f5c46; --ink: #0b1324; --muted: #5e6779; --line: #e6e2d8; --soft: #f3f1ea; --paper: #fbfaf6;
    font: 14.5px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; }
  button, input, textarea, select { font: inherit; color: inherit; }
  .launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 20px 0 16px;
    border: 0; border-radius: 999px; background: var(--brand); color: #fff; cursor: pointer; font-weight: 650; font-size: 15px;
    box-shadow: 0 10px 30px -6px rgba(11, 19, 36, .45), 0 2px 6px rgba(11, 19, 36, .2); transition: transform .2s, box-shadow .2s; }
  .launcher:hover { transform: translateY(-2px); }
  .launcher:focus-visible, button:focus-visible, a:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid #8fa9ff; outline-offset: 2px; }
  .nudge { position: fixed; right: 20px; bottom: 90px; z-index: 2147483000; max-width: 270px; background: #fff; border: 1px solid var(--line); border-radius: 16px 16px 4px 16px;
    padding: 12px 34px 12px 14px; box-shadow: 0 12px 30px -10px rgba(11, 19, 36, .35); font-size: 14px; cursor: pointer; animation: rise .35s ease; }
  .nudge b { display: block; margin-bottom: 2px; }
  .nudge .nx { position: absolute; top: 6px; right: 6px; border: 0; background: none; cursor: pointer; color: var(--muted); padding: 4px; }
  .panel { position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; width: 400px; height: min(690px, calc(100vh - 40px)); display: flex; flex-direction: column;
    background: var(--paper); border-radius: 22px; overflow: hidden; box-shadow: 0 30px 80px -20px rgba(11, 19, 36, .45), 0 0 0 1px rgba(11, 19, 36, .08); animation: rise .25s ease; }
  .root.page { height: 100%; }
  .page .panel { position: relative; inset: auto; width: 100%; height: 100%; min-height: 560px; animation: none; box-shadow: 0 0 0 1px var(--line), 0 20px 50px -24px rgba(11, 19, 36, .25); }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } }
  .head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 14px 16px; background: var(--brand); color: #fff; }
  .avatar { width: 40px; height: 40px; flex: none; border-radius: 12px; background: rgba(255, 255, 255, .16); display: grid; place-items: center; color: #fff; }
  .head h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
  .head p { margin: 0; font-size: 12.5px; opacity: .82; display: flex; align-items: center; gap: 6px; }
  .online { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 3px rgba(74, 222, 128, .25); }
  .head .tools { margin-left: auto; display: flex; gap: 2px; }
  .icon-btn { width: 36px; height: 36px; border: 0; border-radius: 10px; background: transparent; color: inherit; cursor: pointer; display: grid; place-items: center; }
  .icon-btn:hover { background: rgba(255, 255, 255, .14); }
  .log { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }
  .msg { max-width: 88%; padding: 10px 13px; border-radius: 16px; overflow-wrap: anywhere; }
  .msg p { margin: 0 0 7px; } .msg p:last-child, .msg ul:last-child, .msg ol:last-child { margin-bottom: 0; }
  .msg ul, .msg ol { margin: 0 0 7px; padding-left: 20px; } .msg li { margin: 2px 0; }
  .msg a { color: var(--brand); font-weight: 600; }
  .user { align-self: flex-end; background: var(--ink); color: #fff; border-bottom-right-radius: 5px; }
  .bot { align-self: flex-start; background: #fff; border: 1px solid var(--line); border-bottom-left-radius: 5px; }
  .bot.emergency { background: #fde8e6; border-color: #f4c7c2; }
  .cite { display: inline-grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; margin: 0 1px; border-radius: 5px; background: #e8efe9; color: var(--brand);
    font-size: 10.5px; font-weight: 700; vertical-align: 2px; text-decoration: none; }
  .bot .cite { background: color-mix(in srgb, var(--brand) 12%, #fff); }
  .sources { display: grid; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
  .sources-label { font-size: 11.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .src { display: flex; gap: 9px; align-items: flex-start; text-decoration: none; color: inherit; padding: 7px 9px; border-radius: 10px; background: var(--paper); border: 1px solid var(--line); }
  .src:hover { border-color: var(--brand); }
  .src .n { flex: none; width: 20px; height: 20px; border-radius: 6px; background: var(--brand); color: #fff; font-size: 11px; font-weight: 700; display: grid; place-items: center; }
  .src strong { display: block; font-size: 13px; font-weight: 600; line-height: 1.35; }
  .src small { color: var(--muted); font-size: 12px; }
  .tag { display: inline-block; padding: 0 6px; border-radius: 5px; background: #fff1d6; color: #8a5100; font-size: 11px; font-weight: 600; margin-left: 4px; }
  .note { font-size: 12.5px; color: var(--muted); display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; cursor: pointer; font-weight: 600; font-size: 13.5px; text-decoration: none; color: var(--ink); }
  .btn:hover { border-color: var(--brand); color: var(--brand); }
  .btn.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
  .btn.primary:hover { filter: brightness(1.1); color: #fff; }
  .btn.danger { background: #b42318; border-color: #b42318; color: #fff; }
  .welcome { background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 16px; }
  .welcome p { margin: 0 0 12px; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .tiles.four { grid-template-columns: repeat(2, 1fr); }
  .tiles.four .tile:last-child:nth-child(odd) { grid-column: 1 / -1; }
  .tiles.four .tile { grid-template-columns: 34px 1fr; justify-items: start; text-align: left; align-items: center; padding: 10px; }
  .formlist { display: grid; gap: 8px; }
  .formitem { display: grid; grid-template-columns: 38px 1fr auto; gap: 10px; align-items: center; width: 100%; text-align: left; padding: 11px 12px; border-radius: 14px; border: 1px solid var(--line); background: #fff; cursor: pointer; }
  .formitem:hover { border-color: var(--brand); }
  .formitem > span:first-child { width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; background: color-mix(in srgb, var(--brand) 12%, #fff); color: var(--brand); }
  .formitem b { display: block; font-size: 14px; } .formitem small { display: block; color: var(--muted); font-size: 12.5px; line-height: 1.35; margin-top: 2px; }
  .formitem .go { color: var(--brand); font-weight: 650; font-size: 13px; white-space: nowrap; }
  .who { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 13px; color: var(--muted); }
  .who button { border: 0; background: none; color: var(--brand); font-weight: 650; cursor: pointer; padding: 0; }
  .resume { display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; margin-top: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid var(--brand);
    background: color-mix(in srgb, var(--brand) 6%, #fff); cursor: pointer; }
  .resume b { display: block; font-size: 13.5px; } .resume small { color: var(--muted); font-size: 12px; }
  .resume .bar { height: 5px; border-radius: 9px; background: var(--soft); margin-top: 5px; overflow: hidden; } .resume .bar i { display: block; height: 100%; background: var(--brand); }
  .tile { display: grid; gap: 6px; justify-items: center; text-align: center; padding: 12px 6px; border-radius: 14px; border: 1px solid var(--line); background: var(--paper);
    cursor: pointer; font-size: 12.5px; font-weight: 600; line-height: 1.25; }
  .tile:hover { border-color: var(--brand); color: var(--brand); }
  .tile span { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: color-mix(in srgb, var(--brand) 12%, #fff); color: var(--brand); }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 6px 11px; font-size: 13px; cursor: pointer; text-align: left; line-height: 1.3; }
  .chip:hover { border-color: var(--brand); color: var(--brand); }
  .card { align-self: stretch; background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 14px; display: grid; gap: 10px; }
  .card h3 { margin: 0; font-size: 15px; }
  .row { display: grid; grid-template-columns: 96px 1fr; gap: 6px; font-size: 13.5px; }
  .row b { color: var(--muted); font-weight: 600; }
  .ref { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; font-weight: 700; font-size: 18px; letter-spacing: .02em; }
  .progress { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
  .progress i { height: 6px; border-radius: 99px; background: var(--soft); }
  .progress i.on { background: var(--brand); }
  .forms { display: grid; gap: 6px; }
  .typing { display: inline-flex; gap: 4px; padding: 4px 0; } .typing i { width: 7px; height: 7px; border-radius: 50%; background: #9aa1ad; animation: blink 1.2s infinite; }
  .typing i:nth-child(2) { animation-delay: .2s; } .typing i:nth-child(3) { animation-delay: .4s; }
  @keyframes blink { 50% { opacity: .25; } }
  .composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--line); background: #fff; }
  .composer textarea { flex: 1; resize: none; border: 1px solid var(--line); border-radius: 14px; padding: 10px 12px; max-height: 120px; min-height: 44px; line-height: 1.4; background: var(--paper); outline: none; }
  .composer textarea:focus { border-color: var(--brand); background: #fff; }
  .send { width: 44px; height: 44px; flex: none; border: 0; border-radius: 14px; background: var(--brand); color: #fff; cursor: pointer; display: grid; place-items: center; }
  .send:disabled { opacity: .5; cursor: default; }
  .foot { padding: 0 12px 10px; background: #fff; font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
  .foot a { color: var(--muted); }
  .flow-hint { font-size: 12px; color: var(--muted); padding: 0 14px 6px; background: #fff; display: flex; gap: 8px; align-items: center; }
  .flow-hint button { border: 0; background: none; color: var(--brand); font-weight: 600; cursor: pointer; padding: 0; font-size: 12px; }
  .thumb { max-width: 160px; border-radius: 10px; display: block; }
  @media (max-width: 520px) {
    .root:not(.page) .panel { right: 0; bottom: 0; width: 100%; height: 100%; border-radius: 0; }
    .launcher { right: 14px; bottom: 14px; height: 54px; }
    .launcher .label { display: none; }
    .launcher { padding: 0; width: 56px; justify-content: center; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `;

  // Shared state, persisted so the conversation follows the resident across pages.
  let saved = store.load();
  let cfg = null;
  let busy = false;
  const state = {
    convoId: saved.convoId || null,
    items: Array.isArray(saved.items) ? saved.items.slice(-40) : [],
    flow: saved.flow || null,
    open: PAGE || saved.open || script.dataset.open === 'true',
    permit: saved.permit || null,
  };
  const persist = () => store.save({ convoId: state.convoId, items: state.items.slice(-40), flow: state.flow ? { ...state.flow, photo: null } : null, open: state.open, nudged: saved.nudged, permit: state.permit });
  const permitList = () => { try { return JSON.parse(localStorage.getItem(`chos:${CITY}:permit:list`)) || []; } catch { return []; } };
  const formInfo = (kind) => (cfg?.forms || []).find((x) => x.kind === kind) || null;

  // Resident sign-in with a phone number and a texted code. The session token stays on this device; applications
  // follow the resident to any device they sign in on.
  const ACCOUNT_KEY = `chos:${CITY}:me`;
  const account = {
    get() { try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY)); } catch { return null; } },
    set(v) { try { if (v) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(v)); else localStorage.removeItem(ACCOUNT_KEY); } catch { /* storage unavailable */ } },
    token() { return account.get()?.token || null; },
    profile() { return account.get()?.profile || null; },
    signedIn() { return !!account.token(); },
    async api(path, { method = 'GET', body } = {}) {
      const res = await fetch(`${API}/me${path}`, { method, headers: { ...(account.token() ? { 'X-Resident-Token': account.token() } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && account.token()) account.set(null);
      if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: res.status });
      return data;
    },
    sendCode: (phone) => account.api('/code', { method: 'POST', body: { phone } }),
    async verify(phone, code) {
      const r = await account.api('/verify', { method: 'POST', body: { phone, code } });
      account.set({ token: r.token, profile: r.profile });
      // Applications started on this device before signing in join the account.
      await account.api('/claim', { method: 'POST', body: { applications: permitList().map(({ id, token }) => ({ id, token })) } }).catch(() => {});
      return r.profile;
    },
    async signOut() { await account.api('/logout', { method: 'POST' }).catch(() => {}); account.set(null); },
  };
  let photoFile = null;

  const host = document.createElement('div');
  host.id = 'cityhallos-clerk';
  const shadow = host.attachShadow({ mode: 'open' });
  const root = document.createElement('div');
  root.className = `root${PAGE ? ' page' : ''}`;
  shadow.innerHTML = `<style>${CSS}</style>`;
  shadow.appendChild(root);
  if (PAGE) {
    const target = document.querySelector(script.dataset.target || '#cityhallos') || script.parentElement;
    host.style.cssText = 'display:block;height:100%';
    target.appendChild(host);
  } else {
    (document.body || document.documentElement).appendChild(host);
  }

  function md(text, sources = []) {
    const byN = new Map(sources.map((s) => [s.n, s]));
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\b(\d{3}-\d{3}-\d{4})\b/g, '<a href="tel:$1">$1</a>')
      .replace(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, (_, inner) => inner.split(/\s*,\s*/).map((n) => {
        const s = byN.get(Number(n));
        if (s?.form) return `<a class="cite" href="#" data-act="form" data-kind="${esc(s.form)}" title="Fill out the ${esc(s.title)} online">${esc(n)}</a>`;
        return s?.url ? `<a class="cite" href="${esc(absolute(s.url))}" target="_blank" rel="noopener" title="${esc(s.title)}">${esc(n)}</a>` : '';
      }).join(''));
    const out = [];
    let list = null;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
      if (li) {
        const tag = /^\d/.test(line) ? 'ol' : 'ul';
        if (!list || list !== tag) { if (list) out.push(`</${list}>`); list = tag; out.push(`<${tag}>`); }
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (list) { out.push(`</${list}>`); list = null; }
      if (line) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`</${list}>`);
    return out.join('');
  }
  const absolute = (u) => (u && u.startsWith('/') ? ORIGIN + u : u);

  /* ---------------- Rendering ---------------- */

  function render() {
    if (!cfg) return;
    root.style.setProperty('--brand', cfg.brandColor || '#1f5c46');
    if (!state.open) {
      root.innerHTML = `
        ${!saved.nudged ? `<div class="nudge" role="button" tabindex="0" id="nudge"><button class="nx" id="nudgeX" aria-label="Dismiss">${icon('x', 14)}</button><b>Questions for City Hall?</b>Permits, water bills, forms, or report an issue. I'm here 24/7.</div>` : ''}
        <button class="launcher" id="launch" aria-label="Open ${esc(cfg.assistantName)} chat">${icon('chat', 22)}<span class="label">${esc(cfg.assistantName)}</span></button>`;
      root.querySelector('#launch').onclick = () => setOpen(true);
      root.querySelector('#nudge')?.addEventListener('click', (e) => { if (!e.target.closest('#nudgeX')) setOpen(true); });
      root.querySelector('#nudgeX')?.addEventListener('click', () => { saved.nudged = true; persist(); render(); });
      return;
    }
    root.innerHTML = `
      <section class="panel" role="dialog" aria-label="${esc(cfg.assistantName)}">
        <header class="head">
          <div class="avatar">${SEAL}</div>
          <div><h2>${esc(cfg.assistantName)}</h2><p><span class="online"></span>${esc(cfg.tagline)}</p></div>
          <div class="tools">
            <button class="icon-btn" id="reset" title="Start over" aria-label="Start a new conversation">${icon('refresh')}</button>
            ${PAGE ? '' : `<button class="icon-btn" id="close" aria-label="Close chat">${icon('x')}</button>`}
          </div>
        </header>
        <div class="log" id="log" aria-live="polite"></div>
        <div class="flow-hint" id="flowHint" hidden></div>
        <form class="composer" id="form">
          <textarea id="input" rows="1" placeholder="Ask a question or describe a problem…" aria-label="Message"></textarea>
          <button class="send" id="send" type="submit" aria-label="Send">${icon('send')}</button>
        </form>
        <div class="foot"><span>Emergency? Call <a href="tel:911">911</a></span><span>Powered by <a href="https://cityhallos.com" target="_blank" rel="noopener">City Hall OS</a></span></div>
      </section>`;
    root.querySelector('#close')?.addEventListener('click', () => setOpen(false));
    root.querySelector('#reset').onclick = reset;
    const input = root.querySelector('#input');
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); root.querySelector('#form').requestSubmit(); } });
    root.querySelector('#form').onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (!v || busy) return; input.value = ''; input.style.height = ''; handleInput(v); };
    root.querySelector('#log').addEventListener('click', onLogClick);
    drawLog();
    drawFlowHint();
    if (state.permit?.active) { openPermit({ permit: state.permit }); return; }
    if (!PAGE) setTimeout(() => input.focus(), 50);
  }

  function setOpen(open) {
    state.open = open; saved.nudged = true; persist(); render();
  }

  function reset() {
    state.convoId = null; state.items = []; state.flow = null; photoFile = null; persist(); render();
  }

  function drawLog() {
    const log = root.querySelector('#log');
    if (!log) return;
    const welcome = `<div class="welcome">
        <p>${md(cfg.greeting)}</p>
        <div class="tiles ${cfg.permits || modules.some((m) => m.tiles) ? 'four' : ''}">
          ${cfg.permits ? `<button class="tile" data-act="forms"><span>${icon('file')}</span>Apply for a permit</button>
          <button class="tile" data-act="mine"><span>${icon('user')}</span>My applications</button>` : ''}
          <button class="tile" data-act="report"><span>${icon('alert')}</span>Report an issue</button>
          <button class="tile" data-act="track"><span>${icon('search')}</span>Track a request</button>
          ${modules.map((m) => m.tiles?.() || '').join('')}
        </div>
        ${resumeCards()}
        ${cfg.permits && account.signedIn() ? `<div class="who">${icon('user', 14)} Signed in as ${esc(account.profile()?.phone || '')} · <button data-act="sign-out">Sign out</button></div>` : ''}
      </div>
      ${state.items.length ? '' : `<div class="chips">${(cfg.suggestions || []).map((s) => `<button class="chip" data-ask="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}`;
    log.innerHTML = welcome + state.items.map(itemHtml).join('');
    log.scrollTop = log.scrollHeight;
  }

  // Applications this device started: continue a draft, or check on one already submitted.
  function resumeCards() {
    if (!cfg.permits) return '';
    return permitList().filter((x) => x.status !== 'withdrawn').slice(0, 2).map((x) => `
      <button class="resume" data-act="permit-resume" data-id="${esc(x.id)}"><span style="color:var(--brand)">${icon(formInfo(x.kind || 'construction')?.icon || 'file', 22)}</span>
        <span style="flex:1;min-width:0"><b>${x.status === 'draft' ? `Continue your ${esc((x.title || 'construction permit').toLowerCase())} application` : `${esc(x.title || 'Application')} ${esc(x.ref || '')}`}</b>
        <small>${esc(x.address || x.title || 'Application')} · ${x.status === 'draft' ? `${Number(x.progress) || 0}% done` : esc(PERMIT_STATUS[x.status] || x.status)}</small>
        ${x.status === 'draft' ? `<div class="bar"><i style="width:${Number(x.progress) || 0}%"></i></div>` : ''}</span></button>`).join('');
  }

  function itemHtml(it, i) {
    if (it.role === 'user') return `<div class="msg user">${esc(it.text)}${it.photo ? `<div style="margin-top:6px;font-size:12px;opacity:.8">${icon('camera', 14)} Photo attached</div>` : ''}</div>`;
    if (it.kind === 'card') return `<div class="card">${it.html}</div>`;
    const f = it.flags || {};
    const cited = new Set(it.cited || []);
    const shown = (it.sources || []).filter((s, k, all) => s.n > 1 && cited.has(s.n) && s.url && !(s.form && all.findIndex((x) => x.form === s.form && cited.has(x.n)) < k));
    return `<div class="msg bot ${f.emergency ? 'emergency' : ''}" data-i="${i}">
      ${it.pending && !it.text ? '<span class="typing"><i></i><i></i><i></i></span>' : md(it.text, it.sources)}
      ${shown.length ? `<div class="sources"><div class="sources-label">Sources</div>${shown.map((s) => (s.form ? `
        <a class="src" href="#" data-act="form" data-kind="${esc(s.form)}"><span class="n">${s.n}</span><span><strong>${esc(formInfo(s.form)?.short || s.title)}</strong>
        <small>Fill it out online, right here</small></span></a>` : `
        <a class="src" href="${esc(absolute(s.url))}" target="_blank" rel="noopener"><span class="n">${s.n}</span><span><strong>${esc(s.title)}</strong>
        <small>${esc(s.category || '')}${s.as_of ? ` · ${esc(s.as_of)}` : ''}${VERIFY_NOTE[s.verification] && s.verification !== 'official_unverified' ? `<span class="tag">${VERIFY_NOTE[s.verification]}</span>` : ''}</small></span></a>`)).join('')}</div>` : ''}
      ${f.emergency ? `<div class="actions"><a class="btn danger" href="tel:911">${icon('phone', 15)} Call 911</a></div>` : ''}
      ${f.offerReport && !it.reported ? `<div class="actions"><button class="btn primary" data-act="report-from" data-i="${i}">${icon('alert', 15)} Report this issue</button></div>` : ''}
      ${f.offerForm && formInfo(f.offerForm) ? `<div class="actions"><button class="btn primary" data-act="form-from" data-kind="${esc(f.offerForm)}" data-i="${i}">${icon(formInfo(f.offerForm).icon, 15)} Start my ${esc(formInfo(f.offerForm).short.toLowerCase())} application</button></div>` : ''}
      ${f.needsStaff ? `<div class="note">${icon('check', 14)} Flagged for City Hall staff to follow up.</div>` : ''}
      ${it.buttons ? `<div class="actions">${it.buttons}</div>` : ''}
      ${modules.map((m) => m.actions?.(it, i) || '').join('')}
    </div>`;
  }

  function push(item) {
    state.items.push(item); persist();
    const log = root.querySelector('#log');
    if (log) { drawLog(); }
    return item;
  }
  const bot = (text, extra = {}) => push({ role: 'bot', text, ...extra });
  const card = (html) => push({ role: 'bot', kind: 'card', html });

  // Add-ons listed in /config "modules" load from /embed-{name}.js and register here with the chat's helpers.
  // Each may provide tiles(), actions(item, i), click(act, el), input(text) and hint(flow); input and click return true when handled.
  const modules = [];
  window.__cityhallosRegister = (factory) => {
    modules.push(factory({ API, ORIGIN, PAGE, CITY, cfg: () => cfg, state, persist, push, bot, card, drawLog, drawFlowHint, focusInput, ask, esc, icon, md, absolute,
      busy: (v) => { if (v !== undefined) busy = v; return busy; } }));
    if (cfg) render();
  };
  const hook = (name, ...args) => { for (const m of modules) { const r = m[name]?.(...args); if (r) return r; } return null; };
  const loadModule = (name) => {
    if (!/^[a-z-]+$/.test(name)) return;
    const s = document.createElement('script');
    s.src = `${ORIGIN}/embed-${name}.js`; s.async = true;
    document.head.appendChild(s);
  };

  function onLogClick(e) {
    const ask = e.target.closest('[data-ask]');
    if (ask) { handleInput(ask.dataset.ask); return; }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const a = act.dataset.act;
    if (hook('click', a, act)) return;
    if (a === 'forms') showForms();
    else if (a === 'report') startReport({});
    else if (a === 'track') { state.flow = { name: 'track' }; persist(); bot("What's your request number? It looks like **WIG-1001**."); drawFlowHint(); focusInput(); }
    else if (a === 'report-from') {
      const it = state.items[Number(act.dataset.i)];
      it.reported = true;
      const q = [...state.items].slice(0, Number(act.dataset.i)).reverse().find((x) => x.role === 'user');
      startReport({ type: it.reportType, description: q?.text });
    } else if (a === 'choose-type') { flowAnswer(act.dataset.v, act.textContent.trim()); }
    else if (a === 'skip') { flowAnswer(''); }
    else if (a === 'gps') useLocation();
    else if (a === 'photo') pickPhoto();
    else if (a === 'submit') submitReport();
    else if (a === 'form') { e.preventDefault(); openPermit({ kind: act.dataset.kind }); }
    else if (a === 'form-from') {
      const q = [...state.items].slice(0, Number(act.dataset.i)).reverse().find((x) => x.role === 'user');
      openPermit({ kind: act.dataset.kind, opening: q?.text });
    } else if (a === 'permit-resume') {
      const x = permitList().find((p) => p.id === act.dataset.id) || mine.find((p) => p.id === act.dataset.id);
      if (x) openPermit({ permit: { id: x.id, token: x.token } });
    } else if (a === 'mine') showMine();
    else if (a === 'sign-in') startSignIn();
    else if (a === 'sign-out') { account.signOut().then(() => { bot("You're signed out on this device."); }); }
    else if (a === 'cancel-flow') cancelFlow();
  }

  const focusInput = () => root.querySelector('#input')?.focus();

  function drawFlowHint() {
    const h = root.querySelector('#flowHint');
    if (!h) return;
    const f = state.flow;
    h.hidden = !f;
    const mh = f && hook('hint', f);
    if (f) h.innerHTML = `${mh?.label || (f.name === 'track' ? 'Checking a request' : f.name === 'signin' ? 'Signing in with your phone' : 'Reporting an issue')} · <button type="button" id="cancelFlow">Cancel</button>`;
    h.querySelector('#cancelFlow')?.addEventListener('click', cancelFlow);
    const input = root.querySelector('#input');
    if (input) input.setAttribute('inputmode', f?.name === 'signin' ? (f.step === 'code' ? 'numeric' : 'tel') : 'text');
    if (input) input.placeholder = mh?.placeholder || (f?.name === 'signin' ? (f.step === 'code' ? '6-digit code' : 'Your cell number') : f?.name === 'report' ? ({ location: 'Street address, intersection or landmark', details: 'Add details, or type "skip"', contact: 'Name and phone or email, or "skip"' }[f.step] || 'Type your answer') : f?.name === 'track' ? 'e.g. WIG-1001' : 'Ask a question or describe a problem…');
  }

  function cancelFlow() { state.flow = null; photoFile = null; persist(); bot('No problem. What else can I help with?'); drawFlowHint(); }

  /* ---------------- Input routing ---------------- */

  async function handleInput(text) {
    if (hook('input', text)) return;
    if (state.flow?.name === 'report' && state.flow.step !== 'confirm') { push({ role: 'user', text }); flowAnswer(text); return; }
    if (state.flow?.name === 'signin') { push({ role: 'user', text: state.flow.step === 'code' ? '••••••' : text }); signInAnswer(text); return; }
    if (state.flow?.name === 'track' || REF.test(text) && /status|track|update|where|check|^\s*[A-Z]{2,5}-([A-Z]{2}-)?\d+\s*$/i.test(text)) {
      push({ role: 'user', text });
      const ref = (text.match(REF) || [text.trim()])[0];
      state.flow = null; persist(); drawFlowHint();
      return track(ref);
    }
    push({ role: 'user', text });
    return ask(text);
  }

  async function ask(text) {
    busy = true;
    const item = bot('', { pending: true, sources: [] });
    try {
      const res = await fetch(`${API}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, convoId: state.convoId, pageUrl: location.href }) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Something went wrong.'); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let raf = 0;
      const repaint = () => { raf = 0; const el = root.querySelector(`[data-i="${state.items.indexOf(item)}"]`); if (el) { el.outerHTML = itemHtml(item, state.items.indexOf(item)); const log = root.querySelector('#log'); log.scrollTop = log.scrollHeight; } };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.+)$/m) || [])[1];
          const data = JSON.parse((block.match(/^data: (.+)$/m) || [])[1] || '{}');
          if (ev === 'meta') { state.convoId = data.convoId; item.sources = data.sources; }
          if (ev === 'delta') { item.text += data.t; if (!raf) raf = requestAnimationFrame(repaint); }
          if (ev === 'done') { item.flags = data.flags; item.cited = data.cited; item.reportType = data.reportType; }
        }
      }
      item.pending = false;
    } catch (e) {
      item.pending = false;
      item.text = `${e.message} You can also call City Hall at ${cfg.phone}.`;
    }
    busy = false;
    persist(); drawLog();
  }

  /* ---------------- Forms ---------------- */

  async function showForms() {
    push({ role: 'user', text: 'Show me applications and forms' });
    const forms = cfg.forms?.length ? await fetch(`${API}/forms`).then((r) => r.json()).then((r) => r.forms).catch(() => null) : [];
    if (!forms) { bot(`I couldn't load the list of applications. Call City Hall at ${cfg.phone}.`); return; }
    card(`<h3>Apply online</h3><div style="font-size:13px;color:var(--muted)">Fill out any of these right here, on your phone or computer. I'll walk you through it one question at a time and explain anything that's confusing.</div>
      <div class="formlist">${forms.map((f) => `
        <button class="formitem" data-act="form" data-kind="${esc(f.kind)}"><span>${icon(f.icon, 19)}</span><span><b>${esc(f.short)}</b><small>${esc(f.intro.split(/(?<=[.!?])\s/)[0])}${f.fee != null ? ` ${f.fee ? `Fee: $${Number(f.fee).toLocaleString()}.` : 'No fee.'}` : ''}</small></span><span class="go">Start</span></button>`).join('')}</div>
      <div style="font-size:13px;color:var(--muted)">Not sure which one you need? Describe your project, like "I want to put up a sign for my shop", and I'll point you to the right one.</div>`);
  }

  /* ---------------- My applications ---------------- */

  let mine = [];
  async function showMine() {
    push({ role: 'user', text: 'My applications' });
    const row = (x) => `<button class="formitem" data-act="permit-resume" data-id="${esc(x.id)}"><span>${icon(formInfo(x.kind || 'construction')?.icon || 'file', 19)}</span>
      <span><b>${esc(x.title || formInfo(x.kind)?.short || 'Application')}${x.ref ? ` · ${esc(x.ref)}` : ''}</b><small>${esc(x.address || '')}${x.address ? ' · ' : ''}${x.status === 'draft' ? `${Number(x.progress) || 0}% done` : esc(PERMIT_STATUS[x.status] || x.status)}</small></span><span class="go">${x.status === 'draft' ? 'Continue' : 'Open'}</span></button>`;
    if (account.signedIn()) {
      const item = bot('', { pending: true });
      try {
        const r = await account.api('');
        state.items.pop();
        mine = r.applications;
        card(`<h3>My applications</h3><div style="font-size:13px;color:var(--muted)">Signed in as ${esc(r.profile.phone)}.</div>
          <div class="formlist">${mine.map(row).join('') || '<div style="font-size:13.5px">No applications yet.</div>'}</div>
          <div class="actions"><button class="btn primary" data-act="forms">${icon('file', 15)} Start a new application</button><button class="btn" data-act="sign-out">Sign out</button></div>`);
      } catch (e) {
        state.items.pop();
        if (e.status === 401) showMine(); else bot(e.message);
      }
      return;
    }
    const local = permitList().filter((x) => x.status !== 'withdrawn');
    card(`<h3>My applications</h3>
      ${local.length ? `<div style="font-size:13px;color:var(--muted)">Started on this device:</div><div class="formlist">${local.map(row).join('')}</div>` : '<div style="font-size:13.5px">Nothing started on this device yet.</div>'}
      <div style="font-size:13.5px">Sign in with your phone number to save your applications and open them on any phone or computer. No password: I'll text you a code.</div>
      <div class="actions"><button class="btn primary" data-act="sign-in">${icon('phone', 15)} Sign in with my phone</button><button class="btn" data-act="forms">Start an application</button></div>`);
  }

  function startSignIn() {
    state.flow = { name: 'signin', step: 'phone' }; persist();
    bot("What's your cell phone number? I'll text you a 6-digit code.");
    drawFlowHint(); focusInput();
  }

  async function signInAnswer(text) {
    const f = state.flow;
    busy = true;
    const item = bot('', { pending: true });
    try {
      if (f.step === 'phone') {
        const r = await account.sendCode(text);
        state.items.pop();
        state.flow = { name: 'signin', step: 'code', phone: text }; persist();
        bot(`I texted a code to **${esc(r.phone)}**. Type it here.${r.devCode ? ` (Test mode, no texts are sent: your code is **${r.devCode}**.)` : ''}`);
      } else {
        const profile = await account.verify(f.phone, text);
        state.items.pop();
        state.flow = null; persist();
        bot(`You're signed in as **${esc(profile.phone)}**. Your applications are saved to your account, so you can open them on any device.`);
        busy = false; drawFlowHint();
        showMine();
        return;
      }
    } catch (e) {
      state.items.pop();
      bot(e.message);
      if (e.status === 503) { state.flow = null; persist(); }
    }
    busy = false;
    drawFlowHint(); focusInput();
  }

  /* ---------------- Track ---------------- */

  // Timestamps are ISO ("…Z"); requests moved from the original database used "YYYY-MM-DD HH:MM:SS" in UTC.
  const stamp = (s) => new Date(/Z$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);

  async function track(ref) {
    const item = bot('', { pending: true });
    try {
      const res = await fetch(`${API}/track/${encodeURIComponent(ref.toUpperCase())}`);
      const r = await res.json();
      state.items.pop();
      if (!res.ok) { bot(`I couldn't find a request numbered **${ref.toUpperCase()}**. Check the number and try again, or call City Hall at ${cfg.phone}.`); return; }
      if (r.type === 'permit') {
        const at = PERMIT_STEPS.indexOf(r.status === 'closed' ? 'issued' : r.status === 'needs_info' ? 'submitted' : r.status);
        const mineHere = permitList().find((x) => x.ref === r.ref);
        card(`<div class="ref">${esc(r.ref)}</div><h3>${esc(PERMIT_STATUS[r.status] || r.status)}</h3>
          ${at >= 0 ? `<div class="progress">${PERMIT_STEPS.map((s, i) => `<i class="${i <= at ? 'on' : ''}"></i>`).join('')}</div>` : ''}
          <div class="row"><b>Type</b><span>${esc(formInfo(r.kind)?.short || 'Application')}</span></div>
          ${r.permit_number ? `<div class="row"><b>Number</b><span>${esc(r.permit_number)}</span></div>` : ''}
          <div class="row"><b>Submitted</b><span>${r.submitted_at ? new Date(r.submitted_at).toLocaleDateString() : '—'}</span></div>
          <div class="row"><b>Last update</b><span>${new Date(r.updated_at).toLocaleString()}</span></div>
          ${mineHere ? `<div class="actions"><button class="btn primary" data-act="permit-resume" data-id="${esc(mineHere.id)}">${icon('file', 15)} Open my application</button></div>` : ''}`);
        return;
      }
      const at = Math.max(0, STEPS.indexOf(r.status === 'closed' ? 'resolved' : r.status === 'needs_info' ? 'new' : r.status === 'awaiting_review' ? 'in_progress' : r.status));
      // Field work adds "Scheduled for <date>" and "Completed on <date>" to the public updates.
      const when = r.scheduled_for && new Date(`${r.scheduled_for}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
      const latest = (r.updates || []).at(-1)?.note;
      const title = r.status === 'resolved' ? 'Completed' : when && r.status === 'assigned' ? `Scheduled for ${when}` : STATUS[r.status] || r.status;
      card(`<div class="ref">${esc(r.ref)}</div><h3>${esc(title)}</h3>
        <div class="progress">${STEPS.map((s, i) => `<i class="${i <= at ? 'on' : ''}"></i>`).join('')}</div>
        <div class="row"><b>Issue</b><span>${esc(r.category)}</span></div>
        <div class="row"><b>Department</b><span>${esc(r.department)}</span></div>
        ${when ? `<div class="row"><b>Scheduled</b><span>${esc(when)}</span></div>` : ''}
        ${latest && latest !== title ? `<div class="row"><b>Latest</b><span>${esc(latest)}</span></div>` : ''}
        <div class="row"><b>Reported</b><span>${stamp(r.created_at).toLocaleDateString()}</span></div>
        <div class="row"><b>Last update</b><span>${stamp(r.updated_at).toLocaleString()}</span></div>`);
    } catch {
      item.pending = false; item.text = 'I could not check that right now. Please try again in a moment.'; persist(); drawLog();
    }
  }

  /* ---------------- Report an issue (guided, conversational) ---------------- */

  function startReport({ type, description }) {
    state.flow = { name: 'report', step: 'type', type: type || null, description: description || '', location: '', details: '', contact: '' };
    persist(); drawFlowHint();
    if (state.flow.type) { const t = typeLabel(state.flow.type); state.flow.typeLabel = t; return nextStep(); }
    bot("I can send that to the right department. What kind of issue is it?", {
      buttons: cfg.requestTypes.map((t) => `<button class="btn" data-act="choose-type" data-v="${t.key}">${esc(t.label)}</button>`).join(''),
    });
  }
  const typeLabel = (key) => (cfg.requestTypes.find((t) => t.key === key) || {}).label || 'Something else';

  function nextStep() {
    const f = state.flow;
    const order = ['type', 'location', 'details', 'contact', 'confirm'];
    f.step = order[order.indexOf(f.step) + 1];
    persist(); drawFlowHint();
    if (f.step === 'location') {
      bot(`Got it: **${esc(f.typeLabel)}**. Where is it? A street address, intersection or nearby landmark works.`, {
        buttons: `<button class="btn" data-act="gps">${icon('pin', 15)} Use my current location</button>`,
      });
    } else if (f.step === 'details') {
      bot(f.description ? 'Anything else the crew should know, like size or whether it is a safety hazard? A photo helps too.' : 'Tell me a little more about it. Is it a safety hazard? A photo helps too.', {
        buttons: `<button class="btn" data-act="photo">${icon('camera', 15)} Add a photo</button>${f.description ? '<button class="btn" data-act="skip">Nothing to add</button>' : ''}`,
      });
    } else if (f.step === 'contact') {
      bot("Would you like updates? Share your name and a phone number or email. This is optional.", { buttons: '<button class="btn" data-act="skip">Skip</button>' });
    } else if (f.step === 'confirm') {
      card(`<h3>Ready to send</h3>
        <div class="row"><b>Issue</b><span>${esc(f.typeLabel)}</span></div>
        <div class="row"><b>Location</b><span>${esc(f.location)}</span></div>
        <div class="row"><b>Details</b><span>${esc([f.description, f.details].filter(Boolean).join(' — ') || '—')}</span></div>
        ${photoFile ? `<div class="row"><b>Photo</b><span>${esc(photoFile.name)}</span></div>` : ''}
        <div class="row"><b>Contact</b><span>${esc(f.contact || 'Not provided')}</span></div>
        <div class="actions" style="margin-top:2px"><button class="btn primary" data-act="submit">${icon('send', 15)} Submit request</button><button class="btn" data-act="cancel-flow">Cancel</button></div>`);
    }
    focusInput();
  }

  function flowAnswer(text, label) {
    const f = state.flow;
    if (!f) return;
    if (f.step === 'type') {
      const t = cfg.requestTypes.find((x) => x.key === text) || cfg.requestTypes.find((x) => x.label.toLowerCase().includes(String(text).toLowerCase().split(' ')[0])) || cfg.requestTypes.at(-1);
      if (label) push({ role: 'user', text: label });
      if (!label && t.key === 'other' && text) f.description = text;
      f.type = t.key; f.typeLabel = t.label;
    } else if (f.step === 'location') {
      if (!text || text.length < 3) { bot("I need a location so the crew can find it. What's the street, intersection or a nearby landmark?"); return; }
      f.location = text;
    } else if (f.step === 'details') {
      if (!label && text === '') push({ role: 'user', text: 'Nothing to add' });
      if (/^skip$/i.test(text)) text = '';
      if (!text && !f.description && !photoFile) { bot('Please add a short description so staff know what to look for.'); return; }
      if (text) { if (f.description) f.details = text; else f.description = text; }
    } else if (f.step === 'contact') {
      if (!label && text === '') push({ role: 'user', text: 'Skip' });
      f.contact = /^skip$/i.test(text) ? '' : text;
    }
    nextStep();
  }

  function useLocation() {
    if (!navigator.geolocation) { bot('Location is not available on this device. Please type the street or intersection.'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      const loc = `GPS ${p.coords.latitude.toFixed(5)}, ${p.coords.longitude.toFixed(5)}`;
      push({ role: 'user', text: `📍 ${loc}` });
      flowAnswer(loc);
    }, () => bot("I couldn't get your location. Please type the street, intersection or a landmark."), { timeout: 10000 });
  }

  function pickPhoto() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
    inp.onchange = () => {
      const file = inp.files[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { bot('That photo is larger than 10 MB. Please choose a smaller one.'); return; }
      photoFile = file;
      push({ role: 'user', text: file.name, photo: true });
      if (state.flow?.step === 'details') bot('Thanks, photo attached. Anything else to add? If not, tap "Nothing to add".', { buttons: '<button class="btn" data-act="skip">Nothing to add</button>' });
    };
    inp.click();
  }

  async function submitReport() {
    const f = state.flow;
    if (!f || busy) return;
    busy = true;
    const btn = root.querySelector('[data-act="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    const contact = f.contact || '';
    const fd = new FormData();
    fd.append('category', f.type);
    fd.append('location', f.location);
    fd.append('description', [f.description, f.details].filter(Boolean).join('\n\n') || f.typeLabel);
    fd.append('name', contact.replace(/[\w.+-]+@[\w-]+\.[\w.]+|\+?[\d\s().-]{7,}/g, '').replace(/[,·]/g, ' ').trim());
    fd.append('contact', (contact.match(/[\w.+-]+@[\w-]+\.[\w.]+|\+?[\d\s().-]{7,}/) || [''])[0].trim());
    if (state.convoId) fd.append('convoId', state.convoId);
    if (photoFile) fd.append('photo', photoFile);
    try {
      const res = await fetch(`${API}/requests`, { method: 'POST', body: fd });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'Could not submit');
      state.flow = null; photoFile = null;
      card(`<div style="display:flex;gap:10px;align-items:center"><span style="width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center">${icon('check')}</span><div><h3>Request submitted</h3><div style="font-size:13px;color:var(--muted)">Sent to ${esc(r.department)}</div></div></div>
        <div class="ref">${esc(r.ref)}</div>
        <div style="font-size:13.5px">Save this number. Type it here any time to check the status.</div>`);
    } catch (e) {
      bot(`Sorry, that didn't go through (${esc(e.message)}). Please try again, or call City Hall at ${cfg.phone}.`);
      if (btn) { btn.disabled = false; btn.textContent = 'Submit request'; }
    }
    busy = false;
    persist(); drawFlowHint();
  }

  /* ---------------- Permit applications (permit.js, loaded on demand) ---------------- */

  let permitScript = null;
  function openPermit({ permit = null, opening = '', kind = null }) {
    kind = kind || permit?.kind || 'construction';
    state.permit = { ...(permit || {}), kind, active: true };
    if (!state.open) { state.open = true; persist(); render(); return; }
    persist();
    permitScript = permitScript || new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = `${ORIGIN}/permit.js?v=7`; el.async = true; el.onload = resolve; el.onerror = reject;
      document.head.appendChild(el);
    });
    permitScript.then(() => window.__chosPermit.mount({
      root, api: API, origin: ORIGIN, city: CITY, cfg, esc, md, icon, cityName: cfg.cityName, phone: cfg.phone,
      permit: permit?.id ? permit : null, kind, opening, convoId: state.convoId, account,
      openForm: (k) => openPermit({ kind: k }),
      onChange: (x) => { state.permit = { id: x.id, token: x.token, kind: x.kind, active: true }; persist(); },
      onClose: () => { state.permit = { ...state.permit, active: false }; persist(); render(); },
    })).catch(() => { permitScript = null; state.permit = null; persist(); render(); bot(`The application couldn't load. Please try again, or call City Hall at ${cfg.phone}.`); });
  }

  // A secret application link (from an email or text) opens that application directly.
  const linked = location.hash.match(/#permit=(p[a-f0-9]{12})\.([\w-]{16,64})/);
  if (linked) {
    state.permit = { id: linked[1], token: linked[2], active: true };
    state.open = true; persist();
    history.replaceState(null, '', location.pathname + location.search);
  }
  // A link on the city's website can start an application directly: #apply=variance.
  const apply = location.hash.match(/#apply=([a-z_]+)/);
  if (apply && !linked) {
    state.permit = { kind: apply[1], active: true };
    state.open = true; persist();
    history.replaceState(null, '', location.pathname + location.search);
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open && !PAGE && !state.permit?.active) setOpen(false); });

  fetch(`${API}/config`).then((r) => r.json()).then((c) => { cfg = c; (c.modules || []).forEach(loadModule); render(); }).catch(() => { /* stay hidden if the service is unreachable */ });
})();
