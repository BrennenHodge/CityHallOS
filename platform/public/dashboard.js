/* City Hall OS staff dashboard. Vanilla JS, no build step. */
(() => {
  // Set once the signed-in person picks (or has) a city.
  let CITY = '';
  let API = '';
  let PUBLIC_SITE = '';
  const EMBED_SRC = `${location.origin}/embed.js`;
  const CATEGORIES = ['City Hall & Government', 'Ordinances & Code', 'Permits & Forms', 'Planning & Zoning', 'Utilities & Payments',
    'City Services', 'Public Safety', 'Municipal Court', 'Budget & Finance', 'Meetings & Minutes', 'Plans & Studies',
    'Parks & Community', 'Economic Development', 'Community', 'FAQs', 'Research notes', 'Permit workflows', 'Staff guidance', 'General'];
  const AUTHORITY = {
    'official-city': ['Official city', 'green'], 'official-third-party': ['Official code', 'green'], 'state-public-record': ['State record', 'blue'],
    'official-county': ['County', 'blue'], 'media-report': ['News report', 'amber'], 'staff-note': ['Staff note', 'violet'],
    'curated-research': ['Research', 'violet'],
  };
  const REQ_STATUS = { new: ['New', 'blue'], needs_info: ['Needs information', 'amber'], assigned: ['Assigned', 'violet'], in_progress: ['In progress', 'amber'],
    awaiting_review: ['Awaiting review', 'violet'], resolved: ['Resolved', 'green'], closed: ['Closed', ''] };
  const VERIFY = { verified_current: ['Verified current', 'green'], official_unverified: ['Official, not verified', 'blue'], historical: ['Historical', ''],
    secondary: ['Secondary', 'amber'], unverified: ['Unverified', 'red'] };
  const PERMIT_STATUS = { draft: ['Draft', ''], submitted: ['Completeness check', 'blue'], needs_info: ['Waiting on applicant', 'amber'], fees_due: ['Fee due', 'violet'],
    in_review: ['Under review', 'amber'], issued: ['Issued / approved', 'green'], closed: ['Closed', ''], denied: ['Not approved', 'red'], withdrawn: ['Withdrawn', ''] };
  const CONVO_STATUS = { answered: ['Answered', 'green'], needs_review: ['Needs review', 'amber'], reviewed: ['Reviewed', 'blue'], emergency: ['Emergency', 'red'] };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  store.del('chos_token'); // the old shared access code; sign-in now uses a session cookie
  const state = { docs: [], cat: '', q: '', convoFilter: '', convoId: null, overview: null, me: null, city: null };
  const can = (perm) => !!state.city && (state.city.perms.includes('*') || state.city.perms.includes(perm));
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const app = $('#app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n) => `<svg class="icon" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const pill = (map, key) => { const [label, tone] = map[key] || [key, '']; return `<span class="pill ${tone}"><span class="dot"></span>${esc(label)}</span>`; };
  const fmt = (n) => Number(n || 0).toLocaleString();
  const toDate = (s) => (s ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : null);
  function ago(s) {
    const d = toDate(s); if (!d) return '';
    const sec = (Date.now() - d) / 1000;
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : n ? `${n} B` : '');
  function extOf(d) {
    const n = (d.file_name || '').toLowerCase();
    if (n.endsWith('.pdf')) return ['PDF', ''];
    if (/\.(docx?|xlsx?|csv)$/.test(n)) return [n.split('.').pop().toUpperCase().slice(0, 4), 'doc'];
    if (/\.html?$/.test(n) || (!d.file_name && d.source_url && d.authority !== 'staff-note' && d.authority !== 'curated-research')) return ['WEB', 'web'];
    if (/\.(png|jpe?g|webp)$/.test(n)) return ['IMG', 'doc'];
    return ['TXT', 'txt'];
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch((path.startsWith('/api/') ? '' : API) + path, { ...opts, headers, body });
    if (res.status === 401) { boot(); throw new Error('Please sign in again'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // Minimal markdown: paragraphs, bullets, bold, links, and [n] citation chips.
  function md(text, sources = []) {
    const byN = new Map(sources.map((s) => [s.n, s]));
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g, (_, inner) => inner.split(/\s*,\s*/).map((n) => {
        const src = byN.get(Number(n));
        return src?.url ? `<a class="cite" href="${esc(src.url)}" target="_blank" rel="noopener" title="${esc(src.title)}">${esc(n)}</a>` : `<span class="cite">${esc(n)}</span>`;
      }).join(''));
    const out = [];
    let list = null;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      const li = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)/);
      if (li) {
        const tag = /^\d/.test(line) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { if (list) out.push(`</${list.tag}>`); list = { tag }; out.push(`<${tag}>`); }
        out.push(`<li>${inline(li[1])}</li>`);
        continue;
      }
      if (list) { out.push(`</${list.tag}>`); list = null; }
      if (line) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push(`</${list.tag}>`);
    return out.join('');
  }

  // Server-sent events from POST /chat.
  async function streamChat(body, on) {
    const res = await fetch(`${API}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'Chat failed'); }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = (block.match(/^event: (.+)$/m) || [])[1];
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        if (ev && data) on[ev]?.(JSON.parse(data));
      }
    }
  }

  /* ---------------- Sign-in ---------------- */

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.me = null; state.city = null;
    renderLogin();
  }

  function loginCard(inner) {
    app.innerHTML = `
      <div class="login">
        <div class="login-card">
          <div class="brand"><img src="/favicon.svg" alt=""><span>City Hall <span>OS</span></span></div>
          ${inner}
        </div>
      </div>`;
  }

  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  function renderLogin(err = '', operator = false) {
    loginCard(operator ? `
      <h1>City Hall OS support</h1>
      <p>Sign in with the platform access code.</p>
      <form id="loginForm">
        <label class="field"><span>Access code</span><input class="input" id="code" type="password" autocomplete="current-password" required autofocus></label>
        <div class="login-error" id="loginErr">${esc(err)}</div>
        <button class="btn btn-primary" type="submit">${icon('lock')} Sign in</button>
        <button class="btn btn-ghost" type="button" id="swap">Staff sign-in</button>
      </form>` : `
      <h1>Staff dashboard</h1>
      <p>Manage the knowledge base behind your AI City Clerk, review resident conversations, and work service requests.</p>
      <form id="loginForm">
        <label class="field"><span>Email</span><input class="input" id="email" type="email" autocomplete="username" required autofocus></label>
        <label class="field"><span>Password</span><input class="input" id="password" type="password" autocomplete="current-password" required></label>
        <div class="login-error" id="loginErr">${esc(err)}</div>
        <button class="btn btn-primary" type="submit">${icon('lock')} Sign in</button>
        <p class="faint" style="margin:4px 0 0;font-size:12.5px">New here or forgot your password? Ask your City Hall administrator for a setup link.</p>
        <button class="btn btn-ghost btn-sm" type="button" id="swap" style="justify-self:center">City Hall OS support</button>
      </form>`);
    $('#swap').onclick = () => renderLogin('', !operator);
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = e.submitter;
      btn.disabled = true;
      try {
        const me = operator
          ? await postJson('/api/auth/operator', { code: $('#code').value.trim() })
          : await postJson('/api/auth/login', { email: $('#email').value.trim(), password: $('#password').value });
        start(me);
      } catch (err2) { $('#loginErr').textContent = err2.message; btn.disabled = false; }
    });
  }

  async function renderSetup(token) {
    const res = await fetch(`/api/auth/setup?token=${encodeURIComponent(token)}`);
    const info = await res.json().catch(() => ({}));
    if (!res.ok) {
      loginCard(`<h1>This link has expired</h1><p>${esc(info.error || 'Ask your administrator for a new setup link.')}</p><a class="btn btn-primary" href="/">Go to sign-in</a>`);
      return;
    }
    loginCard(`
      <h1>Welcome, ${esc(info.name.split(' ')[0])}</h1>
      <p>Choose a password for <b>${esc(info.email)}</b>. You'll use it to sign in to the City Hall OS dashboard.</p>
      <form id="setupForm">
        <input type="email" value="${esc(info.email)}" autocomplete="username" hidden>
        <label class="field"><span>New password</span><input class="input" id="pw1" type="password" autocomplete="new-password" minlength="10" required autofocus><small>At least 10 characters.</small></label>
        <label class="field"><span>Type it again</span><input class="input" id="pw2" type="password" autocomplete="new-password" required></label>
        <div class="login-error" id="loginErr"></div>
        <button class="btn btn-primary" type="submit">${icon('check')} Set password and sign in</button>
      </form>`);
    $('#setupForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if ($('#pw1').value !== $('#pw2').value) { $('#loginErr').textContent = "The passwords don't match."; return; }
      try {
        const me = await postJson('/api/auth/setup', { token, password: $('#pw1').value });
        history.replaceState(null, '', '/#/overview');
        start(me);
      } catch (err) { $('#loginErr').textContent = err.message; }
    });
  }

  function start(me) {
    state.me = me;
    if (!me.cities.length) {
      loginCard(`<h1>No city yet</h1><p>Your account isn't connected to a city. Ask your City Hall administrator to give you access.</p><button class="btn" id="out">Sign out</button>`);
      $('#out').onclick = signOut;
      return;
    }
    const saved = store.get('chos_city');
    selectCity(me.cities.find((c) => c.slug === saved) || me.cities[0]);
  }

  function selectCity(c) {
    state.city = c;
    CITY = c.slug;
    API = `/api/${CITY}`;
    PUBLIC_SITE = c.publicSite || '';
    store.set('chos_city', c.slug);
    Object.assign(state, { docs: [], cat: '', q: '', convoFilter: '', convoId: null, overview: null, staff: null, departments: null, roles: null });
    renderShell();
  }

  async function boot() {
    const setup = location.hash.match(/^#\/setup\/([\w-]+)/);
    if (setup) return renderSetup(setup[1]);
    const res = await fetch('/api/auth/me').catch(() => null);
    if (res?.ok) start(await res.json()); else renderLogin();
  }
  /* ---------------- Shell & routing ---------------- */

  const ROUTES = {
    overview: { title: 'Overview', sub: () => `How the AI City Clerk is serving ${state.city.shortName}`, icon: 'grid', render: renderOverview, perm: 'overview' },
    knowledge: { title: 'Knowledge base', sub: 'The documents behind every answer', icon: 'brain', render: renderKnowledge, perm: 'knowledge.view' },
    assistant: { title: 'Test the assistant', sub: 'Ask anything and see exactly what the AI read', icon: 'spark', render: renderAssistant, perm: 'assistant.test' },
    conversations: { title: 'Conversations', sub: 'What residents are asking', icon: 'chat', render: renderConversations, perm: 'conversations.view' },
    permits: { title: 'Applications', sub: 'Permits, certificates and Planning Commission applications residents fill out in the AI chat', icon: 'file', render: renderPermits, perm: 'permits.view' },
    requests: { title: 'Service requests', sub: () => (state.city.department_id ? 'Requests routed to your department' : 'Issues reported by residents'), icon: 'clipboard', render: renderRequests, perm: 'requests.view' },
    channels: { title: 'Channels & embed', sub: 'Where residents reach the AI City Clerk', icon: 'plug', render: renderChannels, perm: 'channels.view' },
    staff: { title: 'Staff & access', sub: 'Who can sign in, and what each person can do', icon: 'users', render: renderStaff, perm: 'staff.manage' },
    activity: { title: 'Activity', sub: 'Every change, by whom and when', icon: 'refresh', render: renderActivity, perm: 'audit.view' },
    settings: { title: 'Settings', sub: 'Assistant, city profile, departments and routing', icon: 'gear', render: renderSettings, perm: 'settings.edit' },
    report: { title: 'Results', sub: 'What the AI City Clerk is doing for residents and staff', icon: 'grid', render: renderReport, perm: 'report.view' },
    platform: { title: 'All cities', sub: 'City Hall OS support console', icon: 'globe', render: renderPlatform, perm: 'overview', operator: true },
  };

  const allowed = (key) => can(ROUTES[key].perm) && (!ROUTES[key].operator || state.me.operator);
  const roleLabel = (key) => (state.me.operator ? 'Platform operator' : (state.me.roles.find((r) => r.key === key) || {}).label || key);

  function renderShell() {
    const c = state.city;
    app.innerHTML = `
      <div class="shell">
        <aside class="side" id="side">
          <div class="brand"><img src="/favicon.svg" alt=""><span>City Hall <span>OS</span></span></div>
          <div class="city-card"><div class="city-seal" style="background:${esc(c.brandColor || '#1f5c46')}">${esc((c.shortName || c.name)[0])}</div>
            <div style="min-width:0"><strong>${esc(c.name)}</strong><small>${esc([c.county, c.state].filter(Boolean).join(', '))}</small></div></div>
          ${state.me.cities.length > 1 ? `<select class="select city-switch" id="citySwitch" aria-label="Switch city">${state.me.cities.map((x) => `<option value="${esc(x.slug)}" ${x.slug === c.slug ? 'selected' : ''}>${esc(x.name)}${x.status !== 'active' ? ` (${esc(x.status)})` : ''}</option>`).join('')}</select>` : ''}
          <nav class="nav" aria-label="Dashboard">
            ${navGroup('', ['overview', 'report'])}
            ${navGroup('Brain', ['knowledge', 'assistant'])}
            ${navGroup('Residents', [['conversations', 'navReview'], ['requests', 'navReq'], ['permits', 'navPermits']])}
            ${[...new Set(PAGES.map((p) => p.group))].filter((g) => !['', 'Brain', 'Residents', 'Setup'].includes(g)).map((g) => navGroup(g, [])).join('')}
            ${navGroup('Setup', ['channels', 'staff', 'activity', 'settings'])}
            ${navGroup('City Hall OS', ['platform'])}
          </nav>
          <div class="side-foot">
            <div class="model-chip">${icon('spark')}<span>AI model<br><code id="modelName">loading…</code></span></div>
            ${PUBLIC_SITE ? `<a href="${esc(PUBLIC_SITE)}" target="_blank" rel="noopener">${icon('globe')} View ${esc(host(PUBLIC_SITE))}</a>` : ''}
            <div class="user-chip">${icon('users')}<span>${esc(state.me.operator ? 'City Hall OS support' : state.me.user.name)}<small>${esc(roleLabel(c.role))}</small></span></div>
            <button id="signOut" type="button">${icon('logout')} Sign out</button>
          </div>
        </aside>
        <div class="main">
          <header class="topbar">
            <button class="btn btn-ghost btn-sm menu-btn" id="menuBtn" aria-label="Open menu">${icon('menu')}</button>
            <div><h1 id="pageTitle"></h1><div class="sub" id="pageSub"></div></div>
            <div class="actions" id="pageActions"></div>
          </header>
          <main class="page" id="page"></main>
        </div>
      </div>
      <div class="scrim" id="scrim"></div>
      <aside class="drawer" id="drawer" aria-modal="true" role="dialog"></aside>`;
    $('#signOut').onclick = signOut;
    $('#citySwitch')?.addEventListener('change', (e) => selectCity(state.me.cities.find((x) => x.slug === e.target.value)));
    $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
    $('#scrim').onclick = closeDrawer;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    window.onhashchange = route;
    route();
    refreshBadges();
    SHELL_HOOKS.forEach((fn) => fn());
  }

  // Built-in pages, then any feature pages registered for this group (see window.CHOS below).
  function navGroup(label, items) {
    items = [...items, ...PAGES.filter((p) => p.group === label).map((p) => [p.key, p.badge])];
    const links = items.map((it) => (Array.isArray(it) ? it : [it])).filter(([key]) => allowed(key)).map(([key, badge]) => navLink(key, badge));
    return links.length ? `${label ? `<div class="nav-label">${label}</div>` : ''}${links.join('')}` : '';
  }

  function navLink(key, badgeId) {
    const r = ROUTES[key];
    return `<a href="#/${key}" data-route="${key}">${icon(r.icon)}<span>${r.title}</span>${badgeId ? `<span class="badge warn" id="${badgeId}" hidden></span>` : ''}</a>`;
  }

  async function refreshBadges() {
    try {
      const o = await api('/overview');
      state.overview = o;
      $('#modelName').textContent = o.model;
      const setBadge = (id, n) => { const b = $(`#${id}`); if (b) { b.textContent = n; b.hidden = !n; } };
      setBadge('navReview', o.needsReview);
      setBadge('navReq', o.openRequests);
      setBadge('navPermits', o.permits?.toReview);
    } catch { /* shown on the page itself */ }
  }

  function route() {
    if (/^#\/setup\//.test(location.hash)) { boot(); return; }
    let key = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'overview';
    if (!ROUTES[key] || !allowed(key)) key = 'overview';
    const r = ROUTES[key];
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
    $('#side').classList.remove('open');
    $('#pageTitle').textContent = r.title;
    $('#pageSub').textContent = typeof r.sub === 'function' ? r.sub() : r.sub;
    $('#pageActions').innerHTML = '';
    closeDrawer();
    $$('.modal').forEach((m) => m.remove());
    const page = $('#page');
    page.innerHTML = '<div class="empty"><div class="spin" style="margin:30px auto"></div></div>';
    r.render(page).catch((e) => { page.innerHTML = `<div class="card empty">${icon('alert')}<div>${esc(e.message)}</div></div>`; });
  }

  function openDrawer(html) {
    const d = $('#drawer'); d.innerHTML = html; d.classList.add('open'); $('#scrim').classList.add('open');
    d.querySelector('.close')?.addEventListener('click', closeDrawer);
    return d;
  }
  function closeDrawer() { $('#drawer')?.classList.remove('open'); $('#scrim')?.classList.remove('open'); }

  function modal(html) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.remove(); });
    m.querySelector('input, textarea')?.focus();
    return m;
  }

  /* ---------------- Overview ---------------- */

  async function renderOverview(page) {
    const o = await api('/overview');
    state.overview = o;
    const k = o.knowledge;
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const t = new Date(Date.now() - i * 864e5);
      const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      days.push({ d, n: (o.byDay.find((x) => x.day === d) || {}).n || 0 });
    }
    const maxDay = Math.max(1, ...days.map((x) => x.n));
    const maxCat = Math.max(1, ...k.categories.map((c) => c.n));
    const hour = new Date().getHours();
    if (PUBLIC_SITE) $('#pageActions').innerHTML = `<a class="btn" href="${esc(PUBLIC_SITE)}" target="_blank" rel="noopener">${icon('external')} Public site</a>`;
    page.innerHTML = `
      <section class="welcome">
        <div>
          <h2>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, ${esc(state.me.operator ? state.city.shortName : state.me.user.name.split(' ')[0])}</h2>
          <p>Your AI City Clerk answers residents around the clock from ${fmt(k.n)} city documents.</p>
          ${PUBLIC_SITE ? `<div class="live"><span class="live-dot"></span> Live on ${esc(host(PUBLIC_SITE))}</div>` : ''}
        </div>
        <div class="actions">
          ${can('knowledge.edit') ? `<a class="btn btn-primary" href="#/knowledge">${icon('upload')} Add documents</a>` : ''}
          ${can('assistant.test') ? `<a class="btn" href="#/assistant">${icon('spark')} Test the assistant</a>` : ''}
        </div>
      </section>
      <div class="kpis">
        ${kpi('brain', 'Knowledge base', fmt(k.n), `${fmt(k.chunks)} searchable passages`)}
        ${kpi('chat', 'Resident questions', fmt(o.questions), `${fmt(o.conversations)} conversations`)}
        ${kpi('alert', 'Needs staff review', fmt(o.needsReview), 'Questions the AI could not answer')}
        ${kpi('clipboard', 'Open requests', fmt(o.openRequests), `${fmt(o.requests)} reported in total`)}
      </div>
      <div class="cols cols-21">
        <div class="stack">
          <div class="card"><div class="card-h"><h2>Conversations, last 14 days</h2></div>
            <div class="card-b"><div class="bars">${days.map((x) => `<div class="bar ${x.n ? '' : 'zero'}" title="${x.d}: ${x.n}"><i style="height:${Math.max(3, (x.n / maxDay) * 110)}px"></i><small>${new Date(x.d + 'T12:00').getDate()}</small></div>`).join('')}</div></div>
          </div>
          <div class="cols cols-2">
            <div class="card"><div class="card-h"><h2>Recent questions</h2><a class="more" href="#/conversations">View all</a></div>
              <div class="card-b"><div class="list">${o.recentQuestions.length ? o.recentQuestions.map((c) => `
                <div class="list-item clickable" data-convo="${c.id}"><div class="grow"><div class="title">${esc(c.first_question || 'Conversation')}</div><div class="meta">${ago(c.last_at)} · ${esc(c.channel)}</div></div>${pill(CONVO_STATUS, c.status)}</div>`).join('') : emptyNote('chat', 'No resident questions yet.')}</div></div>
            </div>
            <div class="card"><div class="card-h"><h2>Recent requests</h2><a class="more" href="#/requests">Open board</a></div>
              <div class="card-b"><div class="list">${o.recentRequests.length ? o.recentRequests.map((r) => `
                <div class="list-item clickable" data-req="${r.id}"><div class="grow"><div class="title">${esc(r.category)}</div><div class="meta"><span class="mono">${esc(r.ref)}</span> · ${esc(r.location || r.department)} · ${ago(r.created_at)}</div></div>${pill(REQ_STATUS, r.status)}</div>`).join('') : emptyNote('clipboard', 'No requests yet.')}</div></div>
            </div>
            ${o.permits && can('permits.view') ? `<div class="card"><div class="card-h"><h2>Applications</h2><span class="faint" style="font-size:12.5px">${o.permits.open} open · ${o.permits.drafts} being filled out</span><a class="more" href="#/permits">Open queue</a></div>
              <div class="card-b"><div class="list">${o.permits.recent.length ? o.permits.recent.map((x) => `
                <div class="list-item clickable" data-permit="${x.id}"><div class="grow"><div class="title">${esc(x.address || x.title || 'Application')}</div><div class="meta"><span class="mono">${esc(x.ref || '')}</span> · ${esc(x.applicant || '')} · ${ago(x.submitted_at)}</div></div>${pill(PERMIT_STATUS, x.status)}</div>`).join('') : emptyNote('file', 'No permit applications submitted yet.')}</div></div>
            </div>` : ''}
          </div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h2>Knowledge coverage</h2><a class="more" href="#/knowledge">Manage</a></div>
            <div class="card-b"><div class="meter">${k.categories.map((c) => `
              <div class="meter-row"><span>${esc(c.category)}</span><b>${c.n}</b><div class="track"><i style="width:${(c.n / maxCat) * 100}%"></i></div></div>`).join('')}</div></div>
          </div>
          <div class="card"><div class="card-h"><h2>Most-cited documents</h2></div>
            <div class="card-b"><div class="list">${o.topDocuments.length ? o.topDocuments.map((d) => `
              <div class="list-item clickable" data-doc="${d.id}"><div class="grow"><div class="title">${esc(d.title)}</div><div class="meta">${esc(d.category)}</div></div><span class="pill blue">${d.n}×</span></div>`).join('') : emptyNote('file', 'Citations appear once residents start asking.')}</div></div>
          </div>
          ${o.unanswered.length ? `<div class="card"><div class="card-h"><h2>Unanswered questions</h2><a class="more" href="#/conversations">Review</a></div>
            <div class="card-b"><div class="list">${o.unanswered.map((c) => `<div class="list-item clickable" data-convo="${c.id}"><div class="grow"><div class="title">${esc(c.first_question)}</div><div class="meta">${ago(c.last_at)}</div></div></div>`).join('')}</div></div></div>` : ''}
        </div>
      </div>`;
    page.onclick = (e) => {
      const c = e.target.closest('[data-convo]'); if (c) { state.convoId = c.dataset.convo; location.hash = '#/conversations'; return; }
      const r = e.target.closest('[data-req]'); if (r) { state.reqId = Number(r.dataset.req); location.hash = '#/requests'; return; }
      const pm = e.target.closest('[data-permit]'); if (pm) { state.permitId = pm.dataset.permit; location.hash = '#/permits'; return; }
      const d = e.target.closest('[data-doc]'); if (d) { location.hash = '#/knowledge'; setTimeout(() => openDocument(d.dataset.doc), 300); }
    };
  }
  const kpi = (ic, label, value, hint) => `<div class="card kpi"><div class="label">${icon(ic)}${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
  const emptyNote = (ic, text) => `<div class="empty">${icon(ic)}<div>${text}</div></div>`;

  /* ---------------- Knowledge base ---------------- */

  async function renderKnowledge(page) {
    const upload = { category: 'auto', visibility: 'public', as_of: '' };
    const editable = can('knowledge.edit');
    page.innerHTML = `
      <section class="drop" id="drop" ${editable ? '' : 'hidden'}>
        <div class="drop-icon">${icon('upload')}</div>
        <div>
          <h2>Drop documents to teach your AI City Clerk</h2>
          <p>Ordinances, minutes, agendas, budgets, forms, fee schedules, policies: PDFs, Word, Excel, images or text. Every file becomes searchable knowledge for the website chatbot, the voice agent and every City Hall OS agent.</p>
        </div>
        <div class="actions">
          <button class="btn btn-primary" id="pick">${icon('file')} Choose files</button>
          <button class="btn" id="addUrl">${icon('link')} Add a web page</button>
          <button class="btn" id="addNote">${icon('pen')} Write an answer</button>
        </div>
        <div class="drop-opts">
          <span>Category</span>
          <select class="select" id="upCat"><option value="auto">Auto-detect from file name</option>${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
          <span>Who can see it</span>
          <div class="seg" id="upVis"><button class="on" data-v="public">Residents &amp; staff</button><button data-v="internal">Staff only</button></div>
          <span>Document date</span>
          <input class="input" id="upAsOf" placeholder="e.g. 2026 or Adopted Mar 2026" style="width:200px">
        </div>
        <input type="file" id="fileInput" multiple hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.html,.htm,.png,.jpg,.jpeg,.webp,.json">
      </section>
      <div class="queue" id="queue"></div>
      <div id="fresh"></div>
      <div class="toolbar">
        <div class="search">${icon('search')}<input class="input" id="docSearch" placeholder="Search documents" value="${esc(state.q)}"></div>
        <div class="chips" id="catChips"></div>
      </div>
      <div class="card" style="overflow:hidden"><table class="table">
        <thead><tr><th>Document</th><th class="hide-sm">Category</th><th class="hide-sm">Status of source</th><th class="hide-sm">Date</th><th class="num">Passages</th><th>Status</th></tr></thead>
        <tbody id="docRows"></tbody></table></div>`;

    $('#docSearch').oninput = (e) => { state.q = e.target.value; drawDocs(); };
    $('#catChips').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; state.cat = c.dataset.cat; drawDocs(); };
    $('#docRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openDocument(tr.dataset.id); };
    drawFreshness();
    if (!editable) { await loadDocs(); return; }
    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files], upload));
    // Dropping anywhere on the page works too.
    page.addEventListener('dragover', (e) => e.preventDefault());
    page.addEventListener('drop', (e) => { if (!drop.contains(e.target)) { e.preventDefault(); uploadFiles([...e.dataTransfer.files], upload); } });
    $('#pick').onclick = () => $('#fileInput').click();
    $('#fileInput').onchange = (e) => { uploadFiles([...e.target.files], upload); e.target.value = ''; };
    $('#upCat').onchange = (e) => { upload.category = e.target.value; };
    $('#upAsOf').oninput = (e) => { upload.as_of = e.target.value; };
    $('#upVis').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      upload.visibility = b.dataset.v; $$('#upVis button').forEach((x) => x.classList.toggle('on', x === b));
    };
    $('#addUrl').onclick = () => addUrlModal(upload);
    $('#addNote').onclick = () => noteModal({});
    await loadDocs();
  }

  // Documents that need a person: changed at the source, verified over a year ago, or unreadable.
  async function drawFreshness() {
    const box = $('#fresh');
    if (!box) return;
    const f = await api('/freshness').catch(() => null);
    if (!f || !$('#fresh')) return;
    const items = [
      ...f.changed.map((d) => ({ d, why: `Changed at the source ${ago(d.source_changed_at)}`, tone: 'amber' })),
      ...f.stale.map((d) => ({ d, why: `Last confirmed ${ago(d.verified_at || d.updated_at)}`, tone: '' })),
      ...f.errors.map((d) => ({ d, why: 'Could not be read', tone: 'red' })),
    ];
    const verified = (f.verification.find((v) => v.verification === 'verified_current') || {}).n || 0;
    const total = f.verification.reduce((a, v) => a + v.n, 0);
    box.innerHTML = `<div class="card" style="margin-bottom:16px"><div class="card-h"><h2>Needs review</h2><span class="pill ${items.length ? 'amber' : 'green'}">${items.length || 'Nothing'}</span>
        <span class="faint" style="font-size:12.5px;margin-left:auto">${fmt(verified)} of ${fmt(total)} confirmed current · ${fmt(f.sources.checked)} of ${fmt(f.sources.total)} web sources checked${f.sources.last_check ? `, last ${ago(f.sources.last_check)}` : ''}</span>
        ${can('knowledge.edit') ? `<button class="btn btn-sm" id="checkNow">${icon('refresh')} Check sources now</button>` : ''}</div>
      ${items.length ? `<div class="card-b"><div class="list">${items.slice(0, 12).map(({ d, why, tone }) => `<div class="list-item clickable" data-doc="${d.id}"><div class="grow"><div class="title">${esc(d.title)}</div><div class="meta">${esc(d.category)}</div></div><span class="pill ${tone}">${esc(why)}</span></div>`).join('')}</div></div>`
        : '<div class="card-b muted" style="padding-top:0">City Hall OS checks the original web pages and files every week and lists anything that changed here.</div>'}</div>`;
    box.onclick = (e) => { const it = e.target.closest('[data-doc]'); if (it) openDocument(it.dataset.doc); };
    $('#checkNow')?.addEventListener('click', async (e) => {
      e.target.closest('button').disabled = true;
      try { const r = await api('/freshness', { method: 'POST' }); toast(`Checked ${r.checked} sources, ${r.changed} changed`); drawFreshness(); } catch (err) { toast(err.message); }
    });
  }

  async function loadDocs() {
    const { documents } = await api('/documents');
    state.docs = documents;
    drawDocs();
  }

  function drawDocs() {
    const counts = {};
    state.docs.forEach((d) => { counts[d.category] = (counts[d.category] || 0) + 1; });
    const chips = $('#catChips');
    if (!chips) return;
    chips.innerHTML = `<button class="chip ${state.cat ? '' : 'on'}" data-cat="">All <b>${state.docs.length}</b></button>` +
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([c, n]) => `<button class="chip ${state.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)} <b>${n}</b></button>`).join('');
    const q = state.q.toLowerCase();
    const rows = state.docs.filter((d) => (!state.cat || d.category === state.cat) && (!q || `${d.title} ${d.category} ${d.notes || ''}`.toLowerCase().includes(q)));
    $('#docRows').innerHTML = rows.length ? rows.map((d) => {
      const [ext, tone] = extOf(d);
      const [authLabel, authTone] = AUTHORITY[d.authority] || [d.authority, ''];
      const status = d.status === 'ready' ? `<span class="pill green">${icon('check')}Ready</span>` : d.status === 'error' ? `<span class="pill red" title="${esc(d.error)}">Needs attention</span>` : '<span class="pill amber">Processing</span>';
      return `<tr data-id="${d.id}">
        <td><div class="doc-title"><span class="ext ${tone}">${ext}</span><div style="min-width:0"><strong title="${esc(d.title)}">${esc(d.title)}</strong><small>${d.visibility === 'internal' ? `${icon('lock')} Staff only · ` : ''}${bytes(d.bytes) || `${fmt(d.chars)} characters`} · added ${ago(d.created_at)}</small></div></div></td>
        <td class="hide-sm">${esc(d.category)}</td>
        <td class="hide-sm"><span class="pill ${authTone}" title="Source type">${esc(authLabel)}</span> ${pill(VERIFY, d.verification)}</td>
        <td class="hide-sm muted">${esc(d.as_of || '—')}</td>
        <td class="num">${fmt(d.chunks)}</td>
        <td>${status}</td></tr>`;
    }).join('') : `<tr><td colspan="6">${emptyNote('search', 'No documents match.')}</td></tr>`;
  }

  function guessCategory(name) {
    const n = name.toLowerCase();
    const rules = [[/ordinance|code|chapter|resolution/, 'Ordinances & Code'], [/minute|agenda|meeting/, 'Meetings & Minutes'],
      [/permit|application|form|license|checklist/, 'Permits & Forms'], [/budget|audit|financ|revenue|tax/, 'Budget & Finance'],
      [/water|sewer|utilit|garbage|sanitation|rate/, 'Utilities & Payments'], [/zoning|flood|land use|plat|subdivision|map/, 'Planning & Zoning'],
      [/police|fire|emergency|safety/, 'Public Safety'], [/court|citation|ticket/, 'Municipal Court'], [/park|recreation|event|library|senior/, 'Parks & Community'],
      [/plan|study|report/, 'Plans & Studies'], [/faq|policy|procedure|handbook/, 'City Hall & Government']];
    for (const [re, c] of rules) if (re.test(n)) return c;
    return 'General';
  }

  let pdfjsReady;
  function loadPdfJs() {
    pdfjsReady ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; resolve(window.pdfjsLib); };
      s.onerror = () => reject(new Error('Could not load the PDF reader'));
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }

  // Read a PDF's text layer in the browser, so large files don't hit server CPU limits.
  async function pdfText(file, onPage) {
    const lib = await loadPdfJs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      let text = '';
      let lastY = null;
      for (const it of content.items) {
        const y = it.transform?.[5];
        if (lastY !== null && Math.abs(y - lastY) > 4) text += '\n';
        text += it.str + (it.hasEOL ? '\n' : '');
        lastY = y;
      }
      pages.push(`## Page ${i}\n\n${text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()}`);
      onPage?.(i, pdf.numPages);
    }
    return pages.join('\n\n');
  }

  function queueItem(name, kind) {
    const el = document.createElement('div');
    el.className = 'q-item';
    const [ext, tone] = kind === 'web' ? ['WEB', 'web'] : kind === 'note' ? ['TXT', 'txt'] : extOf({ file_name: name });
    el.innerHTML = `<span class="ext ${tone}">${ext}</span><div style="min-width:0"><strong>${esc(name)}</strong><div class="muted" style="font-size:12.5px" data-msg>Waiting…</div><div class="prog"><i></i></div></div><div data-right><div class="spin"></div></div>`;
    $('#queue')?.prepend(el);
    return {
      step(msg, pct) { el.querySelector('[data-msg]').textContent = msg; el.querySelector('.prog i').style.width = `${pct}%`; },
      done(doc) {
        el.classList.add(doc.status === 'ready' ? 'done' : 'error');
        el.querySelector('[data-msg]').textContent = doc.status === 'ready'
          ? `Ready · ${fmt(doc.chunks)} passages · ${doc.category}` : doc.error || 'Something went wrong';
        el.querySelector('[data-right]').innerHTML = doc.id ? `<button class="btn btn-sm" data-open="${doc.id}">Open</button>` : '';
        el.querySelector('[data-open]')?.addEventListener('click', () => openDocument(doc.id));
      },
    };
  }

  async function uploadFiles(files, opts) {
    for (const file of files) {
      const q = queueItem(file.name, 'file');
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('category', opts.category === 'auto' ? guessCategory(file.name) : opts.category);
        fd.append('visibility', opts.visibility);
        if (opts.as_of) fd.append('as_of', opts.as_of);
        if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
          q.step('Reading PDF…', 15);
          const text = await pdfText(file, (i, n) => q.step(`Reading page ${i} of ${n}…`, 15 + (i / n) * 35)).catch(() => '');
          if (text.replace(/\s/g, '').length > 200) fd.append('text', text);
        }
        q.step('Uploading and indexing…', 65);
        const { documents } = await api('/documents', { method: 'POST', body: fd });
        q.done(documents[0]);
        if (documents[0].status === 'ready') toast(`Added "${documents[0].title}"`);
      } catch (e) {
        q.done({ status: 'error', error: e.message });
      }
    }
    await loadDocs();
    refreshBadges();
  }

  function addUrlModal(opts) {
    const m = modal(`
      <h2>Add a web page or online PDF</h2>
      <p class="muted" style="margin:0">City Hall OS fetches the page, reads it and adds it to the knowledge base. Link to the original stays attached to every answer.</p>
      <label class="field"><span>URL</span><input class="input" id="mUrl" type="url" placeholder="https://" required></label>
      <label class="field"><span>Title (optional)</span><input class="input" id="mTitle"></label>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="mGo">${icon('link')} Add page</button></div>`);
    m.querySelector('#mGo').onclick = async () => {
      const url = m.querySelector('#mUrl').value.trim();
      if (!/^https?:\/\//.test(url)) { m.querySelector('#mUrl').focus(); return; }
      const title = m.querySelector('#mTitle').value.trim();
      m.remove();
      const q = queueItem(title || url, 'web');
      q.step('Fetching and indexing…', 50);
      try {
        const { documents } = await api('/documents', { method: 'POST', body: { url, title: title || undefined, category: opts.category === 'auto' ? guessCategory(url) : opts.category, visibility: opts.visibility, as_of: opts.as_of || undefined } });
        q.done(documents[0]);
      } catch (e) { q.done({ status: 'error', error: e.message }); }
      await loadDocs();
    };
  }

  // Staff-written answers: the fastest way to fill a gap the AI couldn't answer.
  function noteModal({ question = '', convoId = null }) {
    return new Promise((resolve) => {
      const m = modal(`
        <h2>${question ? 'Answer and teach the AI' : 'Write an answer'}</h2>
        <p class="muted" style="margin:0">This becomes an official staff answer in the knowledge base. The AI City Clerk will use it the next time anyone asks.</p>
        <label class="field"><span>Question or topic</span><input class="input" id="nQ" value="${esc(question)}" placeholder="e.g. When does the Board of Aldermen meet?"></label>
        <label class="field"><span>Answer</span><textarea class="textarea" id="nA" rows="6" placeholder="Write the answer the way you'd say it at the front desk."></textarea></label>
        <div class="grid-2">
          <label class="field"><span>Category</span><select class="select" id="nCat">${CATEGORIES.map((c) => `<option ${c === 'FAQs' ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="field"><span>Who can see it</span><select class="select" id="nVis"><option value="public">Residents &amp; staff</option><option value="internal">Staff only</option></select></label>
        </div>
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nSave">${icon('check')} Save to knowledge base</button></div>`);
      m.querySelector(question ? '#nA' : '#nQ').focus();
      m.querySelector('#nSave').onclick = async () => {
        const q = m.querySelector('#nQ').value.trim();
        const a = m.querySelector('#nA').value.trim();
        if (!q || !a) { (q ? m.querySelector('#nA') : m.querySelector('#nQ')).focus(); return; }
        const today = new Date().toISOString().slice(0, 10);
        try {
          await api('/documents', { method: 'POST', body: { title: q, text: `# ${q}\n\n${a}`, category: m.querySelector('#nCat').value, visibility: m.querySelector('#nVis').value, authority: 'staff-note', as_of: today } });
          if (convoId && can('conversations.review')) await api(`/conversations/${convoId}`, { method: 'PATCH', body: { status: 'reviewed' } });
          m.remove(); toast('Saved. The AI will use this answer from now on.');
          if ($('#docRows')) loadDocs();
          refreshBadges();
          resolve(true);
        } catch (e) { toast(e.message); }
      };
    });
  }

  async function openDocument(id) {
    const d = openDrawer('<div class="drawer-b"><div class="spin"></div></div>');
    const { document: doc, chunks } = await api(`/documents/${id}`);
    const fileUrl = `${API}/documents/${doc.id}/file`;
    const [authLabel, authTone] = AUTHORITY[doc.authority] || [doc.authority, ''];
    d.innerHTML = `
      <div class="drawer-h"><div><div class="section-title">${esc(doc.category)}</div><h2>${esc(doc.title)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap"><span class="pill ${authTone}">${esc(authLabel)}</span>${pill(VERIFY, doc.verification)}${doc.visibility === 'internal' ? `<span class="pill">${icon('lock')} Staff only</span>` : '<span class="pill blue">Residents &amp; staff</span>'}${doc.status === 'error' ? '<span class="pill red">Needs attention</span>' : ''}</div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        ${doc.status === 'error' ? `<div class="card card-b" style="border-color:#f4c7c2;background:var(--red-soft)"><b>${esc(doc.error)}</b><div class="muted" style="margin-top:4px">Paste the document's text below and save to index it.</div></div>` : ''}
        ${doc.source_changed_at ? `<div class="card card-b" style="border-color:var(--amber-line, #f1d9a6);background:var(--amber-soft)"><b>The original changed ${ago(doc.source_changed_at)}.</b><div class="muted" style="margin-top:4px">Re-import it to update what the AI reads, then confirm it's current.</div></div>` : ''}
        <div class="muted" style="font-size:13px">${doc.verified_at ? `${icon('check')} Confirmed current by ${esc(doc.verified_by)} ${ago(doc.verified_at)}` : 'Not yet confirmed current by City Hall staff.'}</div>
        <div class="facts">
          <div class="fact"><small>Passages</small><b>${fmt(doc.chunks)}</b></div>
          <div class="fact"><small>Cited in answers</small><b>${fmt(doc.cited)}</b></div>
          <div class="fact"><small>Size</small><b>${bytes(doc.bytes) || fmt(doc.chars) + ' ch'}</b></div>
        </div>
        <label class="field"><span>Title</span><input class="input" id="dTitle" value="${esc(doc.title)}"></label>
        <div class="grid-2">
          <label class="field"><span>Category</span><select class="select" id="dCat">${[...new Set([doc.category, ...CATEGORIES])].map((c) => `<option ${c === doc.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
          <label class="field"><span>Who can see it</span><select class="select" id="dVis"><option value="public" ${doc.visibility === 'public' ? 'selected' : ''}>Residents &amp; staff</option><option value="internal" ${doc.visibility === 'internal' ? 'selected' : ''}>Staff only</option></select></label>
          <label class="field"><span>Document date</span><input class="input" id="dAsOf" value="${esc(doc.as_of || '')}" placeholder="e.g. Adopted 2024"></label>
          <label class="field"><span>Verification</span><select class="select" id="dVer">${Object.entries(VERIFY).map(([k, [l]]) => `<option value="${k}" ${k === doc.verification ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Source type</span><select class="select" id="dAuth">${Object.entries(AUTHORITY).map(([k, [l]]) => `<option value="${k}" ${k === doc.authority ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Original link</span><input class="input" id="dUrl" value="${esc(doc.source_url || '')}" placeholder="https://"><small>Residents see this link when the AI cites the document.</small></label>
        <label class="field"><span>Staff notes</span><textarea class="textarea" id="dNotes" rows="2" placeholder="Context for staff, e.g. superseded sections">${esc(doc.notes || '')}</textarea></label>
        <details ${doc.status === 'error' ? 'open' : ''}><summary class="section-title" style="cursor:pointer">Replace the text (for scanned documents or corrections)</summary>
          <textarea class="textarea" id="dText" rows="6" style="margin-top:8px" placeholder="Paste the full text of the document"></textarea></details>
        <div class="section-title">What the AI reads (${chunks.length} passages)</div>
        <div class="passages">${chunks.slice(0, 40).map((c) => `<div class="passage">${c.heading ? `<b>${esc(c.heading)}</b>` : ''}${esc(c.text)}</div>`).join('') || '<div class="muted">No passages yet.</div>'}${chunks.length > 40 ? `<div class="muted">…and ${chunks.length - 40} more</div>` : ''}</div>
      </div>
      <div class="drawer-f">
        ${can('knowledge.edit') ? `<button class="btn btn-danger" id="dDel">${icon('trash')} Delete</button>` : ''}
        ${doc.file_name && can('knowledge.edit') ? `<button class="btn" id="dReidx">${icon('refresh')} Re-index</button>` : ''}
        ${/^https?:/.test(doc.source_url || '') && can('knowledge.edit') ? `<button class="btn" id="dRefresh">${icon('link')} Re-import</button>` : ''}
        ${can('knowledge.edit') ? `<button class="btn" id="dVerify">${icon('check')} Confirm current</button>` : ''}
        <div class="right">
          ${doc.source_url ? `<a class="btn" href="${esc(doc.source_url)}" target="_blank" rel="noopener">${icon('external')} Original</a>` : doc.file_name ? `<button class="btn" id="dFile">${icon('external')} Open file</button>` : ''}
          ${can('knowledge.edit') ? '<button class="btn btn-primary" id="dSave">Save changes</button>' : ''}
        </div>
      </div>`;
    d.querySelector('.close').onclick = closeDrawer;
    d.querySelector('#dFile')?.addEventListener('click', async () => {
      const res = await fetch(fileUrl);
      if (!res.ok) { toast('Could not open file'); return; }
      window.open(URL.createObjectURL(await res.blob()), '_blank');
    });
    if (!can('knowledge.edit')) { $$('input, select, textarea', d).forEach((el) => { el.disabled = true; }); return; }
    d.querySelector('#dSave').onclick = async () => {
      const body = { title: $('#dTitle').value, category: $('#dCat').value, visibility: $('#dVis').value, as_of: $('#dAsOf').value, authority: $('#dAuth').value, verification: $('#dVer').value, source_url: $('#dUrl').value, notes: $('#dNotes').value };
      const text = $('#dText').value.trim();
      if (text) body.text = text;
      $('#dSave').disabled = true;
      try { await api(`/documents/${id}`, { method: 'PATCH', body }); toast('Saved'); await loadDocs(); openDocument(id); } catch (e) { toast(e.message); $('#dSave').disabled = false; }
    };
    d.querySelector('#dDel').onclick = async () => {
      const b = $('#dDel');
      if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.innerHTML = `${icon('trash')} Click again to delete`; return; }
      await api(`/documents/${id}`, { method: 'DELETE' }); closeDrawer(); toast('Document removed'); loadDocs();
    };
    d.querySelector('#dVerify')?.addEventListener('click', async () => {
      try { await api(`/documents/${id}/verify`, { method: 'POST' }); toast('Marked as confirmed current'); openDocument(id); loadDocs(); drawFreshness(); } catch (err) { toast(err.message); }
    });
    d.querySelector('#dRefresh')?.addEventListener('click', async (e) => {
      e.target.closest('button').disabled = true;
      try { const r = await api(`/documents/${id}/refresh`, { method: 'POST' }); toast(r.document.status === 'ready' ? 'Re-imported from the source' : r.document.error); openDocument(id); loadDocs(); drawFreshness(); } catch (err) { toast(err.message); }
    });
    d.querySelector('#dReidx')?.addEventListener('click', async (e) => {
      e.target.closest('button').disabled = true;
      try { const r = await api(`/documents/${id}/reprocess`, { method: 'POST' }); toast(r.document.status === 'ready' ? 'Re-indexed' : r.document.error); openDocument(id); loadDocs(); } catch (err) { toast(err.message); }
    });
  }

  /* ---------------- Test the assistant ---------------- */

  async function renderAssistant(page) {
    const cfg = await fetch(`${API}/config`).then((r) => r.json());
    let convoId = null;
    let includeInternal = true;
    page.innerHTML = `
      <div class="console">
        <div class="card chat">
          <div class="card-h"><h2>AI City Clerk</h2>
            <div class="seg" id="aMode" style="margin-left:auto"><button class="on" data-v="staff">Staff view</button><button data-v="public">Resident view</button></div>
            <button class="btn btn-sm" id="aReset">${icon('refresh')} New chat</button></div>
          <div class="chat-log" id="aLog"><div class="msg bot">${md(cfg.greeting)}</div></div>
          <div class="suggest" id="aSuggest">${[...cfg.suggestions, 'Can I put up a fence in my front yard?', 'What did the 2024 audit find?'].map((s) => `<button class="chip">${esc(s)}</button>`).join('')}</div>
          <form class="chat-form" id="aForm"><textarea class="textarea" id="aInput" rows="1" placeholder="Ask a question the way a resident would…"></textarea><button class="btn btn-primary" type="submit" aria-label="Send">${icon('send')}</button></form>
        </div>
        <div class="card retrieval">
          <div class="card-h"><h2>What the AI read</h2><span class="pill" id="aCount" style="margin-left:auto">—</span></div>
          <div class="card-b" id="aSources"><div class="empty">${icon('brain')}<div>Ask a question to see the passages the AI retrieved, ranked by relevance. Cited passages are highlighted.</div></div></div>
        </div>
      </div>`;
    const log = $('#aLog');
    $('#aMode').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      includeInternal = b.dataset.v === 'staff';
      $$('#aMode button').forEach((x) => x.classList.toggle('on', x === b));
      toast(includeInternal ? 'Staff view: includes staff-only documents' : 'Resident view: public documents only');
    };
    $('#aReset').onclick = () => { convoId = null; log.innerHTML = `<div class="msg bot">${md(cfg.greeting)}</div>`; $('#aSources').innerHTML = ''; $('#aCount').textContent = '—'; };
    $('#aSuggest').onclick = (e) => { const c = e.target.closest('.chip'); if (c) ask(c.textContent); };
    $('#aInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aForm').requestSubmit(); } });
    $('#aForm').onsubmit = (e) => { e.preventDefault(); const v = $('#aInput').value.trim(); if (v) { $('#aInput').value = ''; ask(v); } };

    async function ask(q) {
      log.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(q)}</div>`);
      const bot = document.createElement('div');
      bot.className = 'msg bot';
      bot.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      log.appendChild(bot); log.scrollTop = log.scrollHeight;
      let text = '';
      let sources = [];
      try {
        await streamChat({ message: q, convoId, mode: includeInternal ? 'staff' : 'public' }, {
          meta: (m) => { convoId = m.convoId; sources = m.sources; drawSources(sources, new Set()); },
          delta: (d) => { text += d.t; bot.innerHTML = md(text, sources); log.scrollTop = log.scrollHeight; },
          done: (d) => {
            drawSources(sources, new Set(d.cited));
            const f = d.flags;
            if (f.emergency) bot.classList.add('emergency');
            const tags = [f.emergency && '<span class="pill red">Emergency redirect</span>', f.needsStaff && '<span class="pill amber">Would be sent to staff</span>',
              f.offerReport && `<span class="pill blue">Opens report form${d.reportType ? `: ${esc(d.reportType)}` : ''}</span>`].filter(Boolean);
            if (tags.length) bot.insertAdjacentHTML('beforeend', `<div class="msg-flags">${tags.join('')}</div>`);
          },
        });
      } catch (e) { bot.textContent = e.message; }
    }

    function drawSources(sources, cited) {
      const docs = sources.filter((s) => s.n > 1);
      $('#aCount').textContent = `${docs.length} passages`;
      $('#aSources').innerHTML = docs.length ? `<div class="stack" style="gap:10px">${docs.map((s) => `
        <div class="src ${cited.has(s.n) ? 'cited' : ''}">
          <div class="src-h"><span class="n">${s.n}</span><strong>${esc(s.title)}</strong>${s.score != null ? `<span class="score">${s.score.toFixed(3)}</span>` : ''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${s.heading ? `<span class="pill">${esc(s.heading.slice(0, 50))}</span>` : ''}<span class="pill">${esc(s.category)}</span>${s.visibility === 'internal' ? `<span class="pill">${icon('lock')} Staff only</span>` : ''}${s.as_of ? `<span class="pill">${esc(s.as_of)}</span>` : ''}</div>
          ${s.excerpt ? `<p>${esc(s.excerpt)}</p>` : ''}
          ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener" style="font-size:12.5px">${icon('external')} Open source</a>` : ''}
        </div>`).join('')}</div>` : `<div class="empty">${icon('search')}<div>No documents were needed for this reply.</div></div>`;
    }
  }

  /* ---------------- Conversations ---------------- */

  async function renderConversations(page) {
    page.innerHTML = `
      <div class="toolbar" style="margin-top:0"><div class="chips" id="cTabs">
        ${[['', 'All'], ['needs_review', 'Needs review'], ['emergency', 'Emergency'], ['reviewed', 'Reviewed']].map(([v, l]) => `<button class="chip ${state.convoFilter === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
      </div></div>
      <div class="convo-layout">
        <div class="card convo-list" id="cList"></div>
        <div class="card transcript" id="cView"><div class="empty">${icon('chat')}<div>Select a conversation to read it.</div></div></div>
      </div>`;
    $('#cTabs').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; state.convoFilter = c.dataset.v; renderConversations(page); };
    const { conversations } = await api(`/conversations${state.convoFilter ? `?status=${state.convoFilter}` : ''}`);
    $('#cList').innerHTML = conversations.length ? conversations.map((c) => `
      <div class="convo-item ${c.id === state.convoId ? 'on' : ''}" data-id="${c.id}">
        <div class="q">${esc(c.first_question || 'Conversation')}</div>
        <div class="meta">${pill(CONVO_STATUS, c.status)}<span>${c.messages / 2 | 0} ${c.messages === 2 ? 'question' : 'questions'}</span><span>·</span><span>${ago(c.last_at)}</span>${c.channel !== 'web' ? `<span class="pill">${esc(c.channel)}</span>` : ''}</div>
      </div>`).join('') : emptyNote('chat', `No conversations here yet.${PUBLIC_SITE ? ` Try the chatbot on ${esc(host(PUBLIC_SITE))}.` : ''}`);
    $('#cList').onclick = (e) => { const it = e.target.closest('.convo-item'); if (!it) return; state.convoId = it.dataset.id; $$('.convo-item').forEach((x) => x.classList.toggle('on', x === it)); showConvo(it.dataset.id); };
    if (state.convoId) showConvo(state.convoId).catch(() => {});
  }

  async function showConvo(id) {
    const view = $('#cView');
    const { conversation: c, messages, requests } = await api(`/conversations/${id}`);
    view.innerHTML = `
      <div class="card-h" style="flex-wrap:wrap"><h2>Conversation</h2>${pill(CONVO_STATUS, c.status)}
        <span class="faint" style="font-size:12.5px">Started ${ago(c.started_at)}${c.page_url ? ` on <a href="${esc(c.page_url)}" target="_blank" rel="noopener">${esc(new URL(c.page_url, location.href).pathname)}</a>` : ''}</span>
        <div style="margin-left:auto;display:flex;gap:8px">
          ${can('knowledge.edit') ? `<button class="btn btn-sm" id="cTeach">${icon('pen')} Answer &amp; teach the AI</button>` : ''}
          ${c.status !== 'reviewed' && can('conversations.review') ? `<button class="btn btn-sm btn-dark" id="cDone">${icon('check')} Mark reviewed</button>` : ''}
        </div></div>
      ${requests.length ? `<div class="card-b" style="padding-bottom:0">${requests.map((r) => `<span class="pill blue">${icon('clipboard')} ${esc(r.ref)} · ${esc(r.category)} · ${esc((REQ_STATUS[r.status] || [r.status])[0])}</span>`).join(' ')}</div>` : ''}
      <div class="chat-log">${messages.map((m) => m.role === 'user' ? `<div class="msg user">${esc(m.content)}</div>` : `
        <div class="msg bot ${m.flag === 'emergency' ? 'emergency' : ''}">${md(m.content, m.sources)}
          ${m.sources?.filter((s) => s.n > 1).length ? `<div class="msg-sources">${m.sources.filter((s) => s.n > 1).map((s) => `<a href="${esc(s.url || '#')}" target="_blank" rel="noopener"><b>[${s.n}]</b> ${esc(s.title)}</a>`).join('')}</div>` : ''}
          ${m.flag ? `<div class="msg-flags">${{ needs_staff: '<span class="pill amber">Flagged for staff</span>', emergency: '<span class="pill red">Emergency redirect</span>', report: '<span class="pill blue">Offered report form</span>', action: '<span class="pill green">Workflow action</span>' }[m.flag] || ''}<span class="pill">${esc(m.model || '')}</span></div>` : ''}
        </div>`).join('')}</div>`;
    view.querySelector('#cDone')?.addEventListener('click', async () => {
      await api(`/conversations/${id}`, { method: 'PATCH', body: { status: 'reviewed' } }); toast('Marked reviewed'); refreshBadges(); renderConversations($('#page'));
    });
    view.querySelector('#cTeach')?.addEventListener('click', async () => {
      const lastQ = [...messages].reverse().find((m) => m.role === 'user');
      if (await noteModal({ question: lastQ?.content || c.first_question, convoId: id })) renderConversations($('#page'));
    });
  }

  /* ---------------- Service requests ---------------- */

  async function renderRequests(page) {
    const [{ requests }, staff, depts] = await Promise.all([api('/requests'), state.staff ? null : api('/staff'), state.departments ? null : api('/departments')]);
    if (staff) state.staff = staff.staff.filter((p) => p.active);
    if (depts) state.departments = depts.departments.filter((d) => d.active);
    if (can('requests.create')) {
      $('#pageActions').innerHTML = `<button class="btn btn-primary" id="rNew">${icon('plus')} Log a request</button>`;
      $('#rNew').onclick = newRequestModal;
    }
    const lanes = [['new', 'New'], ['needs_info', 'Needs information'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['awaiting_review', 'Awaiting review'], ['resolved', 'Resolved']];
    page.innerHTML = `<div class="board">${lanes.map(([key, label]) => {
      const items = requests.filter((r) => (key === 'resolved' ? ['resolved', 'closed'].includes(r.status) : r.status === key));
      return `<div class="lane"><div class="lane-h">${pill(REQ_STATUS, key)}<span class="count">${items.length}</span></div>
        <div class="lane-cards">${items.map((r) => `
          <div class="rcard" data-id="${r.id}">
            <div class="top"><span class="ref">${esc(r.ref)}</span>${r.priority !== 'normal' ? `<span class="pill ${r.priority === 'low' ? '' : 'red'}">${esc(r.priority)}</span>` : ''}${r.photo ? `<span class="pill">Photo</span>` : ''}${r.source === 'chat' ? '<span class="pill blue">AI intake</span>' : r.source === 'staff' ? '<span class="pill">Logged by staff</span>' : ''}</div>
            <strong>${esc(r.category)}</strong>
            ${r.location ? `<p>${esc(r.location)}</p>` : ''}
            <div class="foot"><span>${esc(r.department)}</span><span>·</span><span>${ago(r.created_at)}</span>${r.assignee ? `<span>· ${esc(r.assignee)}</span>` : ''}</div>
          </div>`).join('') || '<div class="faint" style="padding:8px 6px;font-size:12.5px">Nothing here.</div>'}</div></div>`;
    }).join('')}</div>`;
    page.onclick = (e) => { const c = e.target.closest('.rcard'); if (c) openRequest(requests.find((r) => r.id === Number(c.dataset.id))); };
    if (state.reqId) { const r = requests.find((x) => x.id === state.reqId); state.reqId = null; if (r) openRequest(r); }
  }

  function openRequest(r) {
    const edit = can('requests.edit');
    const mapQ = r.latitude != null ? `${r.latitude},${r.longitude}` : `${r.location}${(r.location || '').toLowerCase().includes(state.city.shortName.toLowerCase()) ? '' : `, ${state.city.shortName}, ${state.city.state}`}`;
    const d = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(r.ref)}</div><h2>${esc(r.category)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px">${pill(REQ_STATUS, r.status)}<span class="pill">${esc(r.department)}</span><span class="pill">Reported ${ago(r.created_at)}</span></div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        ${r.summary ? `<div class="card card-b" style="background:var(--blue-soft);border-color:var(--blue-line)"><div class="section-title">Summary</div><p style="margin:6px 0 0">${esc(r.summary)}</p></div>` : ''}
        <div class="card card-b"><div class="section-title">Resident's description</div><p style="margin:6px 0 0;white-space:pre-wrap">${esc(r.description)}</p>
          ${r.location ? `<p style="margin:10px 0 0"><b>Location:</b> ${esc(r.location)} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQ)}" target="_blank" rel="noopener">Map</a></p>` : ''}
          ${r.name || r.contact ? `<p style="margin:6px 0 0"><b>Contact:</b> ${esc([r.name, r.contact].filter(Boolean).join(' · '))}</p>` : ''}
          ${r.convo_id ? `<p style="margin:6px 0 0"><a href="#/conversations" data-convo="${esc(r.convo_id)}">View the chat conversation</a></p>` : ''}</div>
        ${r.photo ? '<img class="photo" id="rPhoto" alt="Photo from resident">' : ''}
        ${edit ? `<div class="field"><span>Move to</span><div class="status-steps">${Object.entries(REQ_STATUS).map(([k, [l]]) => `<button class="btn btn-sm ${k === r.status ? 'btn-dark' : ''}" data-status="${k}">${l}</button>`).join('')}</div></div>
        <div class="grid-2">
          <label class="field"><span>Assigned to</span><select class="select" id="rAssignee"><option value="">Unassigned</option>${(state.staff || []).map((p) => `<option value="${esc(p.id)}" ${p.id === r.assignee_id ? 'selected' : ''}>${esc(p.name)}${p.department ? ` · ${esc(p.department)}` : ''}</option>`).join('')}</select></label>
          <label class="field"><span>Priority</span><select class="select" id="rPriority">${['low', 'normal', 'high', 'urgent'].map((p) => `<option ${p === r.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <label class="field"><span>Department</span><select class="select" id="rDept">${(state.departments || []).map((x) => `<option value="${esc(x.id)}" ${x.id === r.department_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        </div>
        ${state.staff && !state.staff.length ? '<small class="faint">Add people under Staff &amp; access to assign requests.</small>' : ''}
        <label class="field"><span>Add a note</span><textarea class="textarea" id="rNote" rows="2" placeholder="Internal: visible to staff only"></textarea><small>Residents tracking ${esc(r.ref)} see status changes, not notes.</small></label>` : `<div class="grid-2"><div class="field"><span>Assigned to</span><b>${esc(r.assignee || 'Unassigned')}</b></div><div class="field"><span>Priority</span><b>${esc(r.priority)}</b></div></div>`}
        <div class="section-title">History</div>
        <div class="timeline">${r.history.slice().reverse().map((h) => `<div class="tl"><i></i><div><b>${esc(h.note || (REQ_STATUS[h.status] || [h.status])[0])}</b><small>${esc(h.by)} · ${toDate(h.at).toLocaleString()}${h.public ? ' · shown to resident' : ''}</small></div></div>`).join('')}</div>
      </div>
      ${edit ? '<div class="drawer-f"><div class="right"><button class="btn btn-primary" id="rSave">Save</button></div></div>' : ''}`);
    let status = r.status;
    d.querySelector('[data-convo]')?.addEventListener('click', (e) => { state.convoId = e.target.dataset.convo; });
    if (r.photo) {
      fetch(`${API}/requests/${r.id}/photo`).then((res) => res.blob()).then((b) => { $('#rPhoto').src = URL.createObjectURL(b); });
    }
    DRAWER_HOOKS.forEach((fn) => fn(d, r));
    if (!edit) return;
    d.querySelector('.status-steps').onclick = (e) => {
      const b = e.target.closest('[data-status]'); if (!b) return;
      status = b.dataset.status; $$('[data-status]', d).forEach((x) => x.classList.toggle('btn-dark', x === b));
    };
    d.querySelector('#rSave').onclick = async () => {
      try {
        const { request } = await api(`/requests/${r.id}`, { method: 'PATCH', body: { status, assignee_id: $('#rAssignee').value || null, priority: $('#rPriority').value, department_id: $('#rDept').value, note: $('#rNote').value } });
        toast(`${request.ref} updated`); refreshBadges(); await renderRequests($('#page'));
        if (!state.city.department_id || request.department_id === state.city.department_id) openRequest(request);
      } catch (e) { toast(e.message); }
    };
  }

  async function newRequestModal() {
    const cfg = await fetch(`${API}/config`).then((r) => r.json());
    const m = modal(`
      <h2>Log a request</h2>
      <p class="muted" style="margin:0">For issues reported by phone or at the counter.</p>
      <label class="field"><span>Type</span><select class="select" id="nrType">${cfg.requestTypes.map((t) => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></label>
      <label class="field"><span>Location</span><input class="input" id="nrLoc" placeholder="Street address or nearest intersection"></label>
      <label class="field"><span>Description</span><textarea class="textarea" id="nrDesc" rows="3"></textarea></label>
      <div class="grid-2"><label class="field"><span>Resident name</span><input class="input" id="nrName"></label><label class="field"><span>Phone or email</span><input class="input" id="nrContact"></label></div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nrSave">Create request</button></div>`);
    m.querySelector('#nrSave').onclick = async () => {
      const description = m.querySelector('#nrDesc').value.trim();
      if (!description) { m.querySelector('#nrDesc').focus(); return; }
      try {
        const r = await api('/requests', { method: 'POST', body: { category: m.querySelector('#nrType').value, location: m.querySelector('#nrLoc').value, description, name: m.querySelector('#nrName').value, contact: m.querySelector('#nrContact').value } });
        m.remove(); toast(`${r.ref} created and routed to ${r.department}`); refreshBadges(); renderRequests($('#page'));
      } catch (e) { toast(e.message); }
    };
  }

  /* ---------------- Permit applications ---------------- */

  const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const optLabel = (opts, v) => (opts.find(([k]) => k === v) || [])[1] || v;

  async function renderPermits(page) {
    const [{ permits: all, forms }] = await Promise.all([api('/permits'), state.staff || !can('permits.edit') ? null : api('/staff').then((r) => { state.staff = r.staff.filter((x) => x.active); })]);
    const kind = state.permitKind || '';
    const permits = kind ? all.filter((x) => x.kind === kind) : all;
    const kinds = forms.filter((f) => all.some((x) => x.kind === f.kind));
    const o = state.overview || await api('/overview');
    const lanes = [['submitted', 'Completeness check'], ['needs_info', 'Waiting on applicant'], ['fees_due', 'Fee due'], ['in_review', 'Under review'], ['issued', 'Issued'], ['done', 'Closed']];
    page.innerHTML = `
      <div class="card card-b" style="display:flex;gap:18px;flex-wrap:wrap;align-items:center;margin-bottom:16px">
        <div style="flex:1;min-width:260px"><b>How applications reach you</b><div class="muted" style="font-size:13px">Residents fill out the city's forms in the AI City Clerk chat, usually on their phone. It collects every field on the city's form, answers their questions, screens the address against Census and FEMA maps, estimates the fee and runs a completeness check before anything is submitted. Staff decide completeness, fees and approval.</div>
          ${kinds.length > 1 ? `<select class="select" id="pmKind" style="width:auto;margin-top:10px;height:32px;font-size:13px"><option value="">All applications (${all.length})</option>${kinds.map((f) => `<option value="${esc(f.kind)}" ${f.kind === kind ? 'selected' : ''}>${esc(f.short)} (${all.filter((x) => x.kind === f.kind).length})</option>`).join('')}</select>` : ''}</div>
        <div style="display:flex;gap:18px">${[['Being filled out', o.permits?.drafts || 0], ['Open', o.permits?.open || 0], ['Issued', o.permits?.issued || 0]].map(([l, n]) => `<div><div class="faint" style="font-size:12px">${l}</div><div style="font:650 24px var(--font-display)">${n}</div></div>`).join('')}</div>
      </div>
      <div class="board">${lanes.map(([key, label]) => {
        const items = permits.filter((x) => (key === 'done' ? ['closed', 'denied', 'withdrawn'].includes(x.status) : x.status === key));
        return `<div class="lane"><div class="lane-h">${key === 'done' ? `<span class="pill">${label}</span>` : pill(PERMIT_STATUS, key)}<span class="count">${items.length}</span></div>
          <div class="lane-cards">${items.map((x) => `
            <div class="rcard" data-id="${esc(x.id)}">
              <div class="top"><span class="ref">${esc(x.ref)}</span><span class="pill">${esc(x.title || '')}</span>${x.errors ? `<span class="pill red">${x.errors} missing</span>` : ''}${x.concerns ? `<span class="pill violet">AI: ${x.concerns}</span>` : ''}${key === 'done' ? pill(PERMIT_STATUS, x.status) : ''}</div>
              <strong>${esc(x.address || 'Address not given')}</strong>
              ${x.summary ? `<p>${esc(x.summary)}</p>` : ''}
              <div class="foot"><span>${esc(x.applicant || '')}</span><span>·</span><span>${ago(x.updated_at)}</span>${x.fee_assessed != null ? `<span>· ${money(x.fee_assessed)}</span>` : x.fee_estimate != null ? `<span>· est. ${money(x.fee_estimate)}</span>` : ''}</div>
            </div>`).join('') || '<div class="faint" style="padding:8px 6px;font-size:12.5px">Nothing here.</div>'}</div></div>`;
      }).join('')}</div>`;
    page.onclick = (e) => { const c = e.target.closest('.rcard'); if (c) openPermitDrawer(c.dataset.id); };
    page.querySelector('#pmKind')?.addEventListener('change', (e) => { state.permitKind = e.target.value; renderPermits(page); });
    if (state.permitId) { const id = state.permitId; state.permitId = null; openPermitDrawer(id); }
  }

  const ISSUE_TONE = { error: 'red', warning: 'amber', info: '' };
  const issueRow = (i) => `<div style="display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.45"><span class="pill ${ISSUE_TONE[i.level]}" style="flex:none">${i.source === 'ai' ? 'AI' : 'Rule'} · ${esc(i.level)}</span><span>${esc(i.message)}</span></div>`;

  async function openPermitDrawer(id) {
    let p;
    try { p = await api(`/permits/${id}`); } catch (e) { toast(e.message); return; }
    const d = p.data; const sc = p.screen || {};
    const ai = p.review || {};
    const forApplicant = [...(ai.issues || []).filter((i) => i.for === 'applicant' && i.level !== 'info'), ...(p.checks || []).filter((i) => i.level !== 'info')];
    const forStaff = (ai.issues || []).filter((i) => i.for === 'staff');
    const val = (f) => {
      let v = d[f.key];
      if (v == null || v === '') return null;
      if (f.options) v = Array.isArray(v) ? v.map((x) => optLabel(f.options, x)).join(', ') : optLabel(f.options, v);
      if (f.type === 'bool' || f.type === 'check') v = v === true ? 'Yes' : v === false ? 'No' : v;
      if (f.type === 'money') v = money(v);
      return v;
    };
    const shown = (f) => !f.when || Object.entries(f.when).every(([k, w]) => (Array.isArray(w) ? w.includes(d[k]) : w?.has ? (d[k] || []).includes(w.has) : w && typeof w === 'object' ? d[k] != null && d[k] !== w.not : w === true ? !!d[k] : d[k] === w));
    const ed = p.canEdit;
    const pdfUrl = `${API}/permits/${id}/pdf`;
    const iss = p.schema.issue;
    const noun = iss.noun === 'permit' ? 'permit' : iss.noun === 'certificate' ? 'certificate' : 'approval';
    const inspections = iss.inspections ? `<div class="card card-b stack" style="gap:10px"><b>Inspections</b><div class="grid-2"><label class="field"><span>Inspection</span><select class="select" id="pmInsType">${iss.inspections.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
          <label class="field"><span>Result</span><select class="select" id="pmInsRes"><option value="passed">Passed</option><option value="failed">Did not pass</option></select></label></div>
          <input class="input" id="pmInsNote" placeholder="Notes for the applicant (optional)">
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary" data-pm="inspection">Record inspection</button>${p.status === 'issued' ? `<button class="btn" data-pm="close">${icon('check')} Final passed: close</button>` : ''}</div></div>` : '';
    const decision = !ed ? '' : {
      submitted: `<div class="grid-2">
          <div class="card card-b stack" style="gap:10px"><b>Complete? Set the fee</b><label class="field"><span>Fee</span><input class="input" id="pmFee" inputmode="decimal" value="${p.fee?.total ?? ''}"><small>${p.fee ? 'Estimate from the published fee schedule' : 'No fee schedule configured; enter the fee'}${d.work_started ? ' (doubled: work already started)' : ''}.</small></label><button class="btn btn-primary" data-pm="accept">${icon('check')} Mark complete</button></div>
          <div class="card card-b stack" style="gap:10px"><b>Send back for changes</b><textarea class="textarea" id="pmItems" rows="5" placeholder="One item per line">${esc(forApplicant.filter((i) => i.level === 'error' || i.source === 'ai').map((i) => i.message).join('\n'))}</textarea><small class="faint">Drafted from the AI review and rule checks. Edit before sending.</small><button class="btn" data-pm="request_info">${icon('send')} Request changes</button></div>
        </div>`,
      fees_due: `<div class="card card-b stack" style="gap:10px"><b>Record payment</b><div class="grid-2"><label class="field"><span>Amount received</span><input class="input" id="pmAmt" inputmode="decimal" value="${p.fee_assessed ?? ''}"></label><label class="field"><span>Receipt number</span><input class="input" id="pmRcpt"></label></div><button class="btn btn-primary" data-pm="payment">${icon('check')} Payment received: start review</button></div>`,
      in_review: `${iss.noun === 'certificate' ? inspections : ''}<div class="card card-b stack" style="gap:10px"><b>${esc(iss.action)}</b><div class="grid-2"><label class="field"><span>${esc(iss.numberLabel)}</span><input class="input mono" id="pmNum" value="${esc(p.suggestedPermitNumber)}"></label><div></div></div>
          <label class="field"><span>Conditions (printed on the ${noun})</span><textarea class="textarea" id="pmCond" rows="2" placeholder="Optional"></textarea></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary" data-pm="issue">${icon('check')} ${esc(iss.action)}</button><button class="btn" data-pm="request_info_prompt">Request changes</button><button class="btn btn-ghost" data-pm="deny">Not approved…</button></div></div>`,
      needs_info: `<div class="card card-b"><b>Waiting on the applicant</b><div class="muted" style="font-size:13px;margin-top:4px">Asked ${ago(p.review?.returned?.at)} by ${esc(p.review?.returned?.by || 'staff')}. Residents get automatic reminders until they resubmit.</div><ul style="margin:8px 0 0;padding-left:18px;font-size:13px">${(p.review?.returned?.items || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`,
      issued: iss.noun === 'certificate' || !iss.inspections ? `<div class="card card-b" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><b style="flex:1">${esc(p.schema.statuses.issued[0])}</b><button class="btn btn-sm" data-pm="close">${icon('check')} Close</button></div>` : inspections,
    }[p.status] || '';
    const dr = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(p.ref)}${p.permit_number ? ` · Permit ${esc(p.permit_number)}` : ''}</div><h2>${esc(p.address || p.schema.title)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${pill(PERMIT_STATUS, p.status)}<span class="pill">${esc(p.schema.short)}</span><span class="pill">Submitted ${ago(p.submitted_at)}</span>${p.assignee ? `<span class="pill">${esc(p.assignee)}</span>` : ''}</div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn btn-sm" href="${pdfUrl}" target="_blank" rel="noopener">${icon('file')} Application (PDF)</a>${['issued', 'closed'].includes(p.status) ? `<a class="btn btn-sm" href="${API}/permits/${id}/permit.pdf" target="_blank" rel="noopener">${icon('file')} ${iss.noun === 'permit' ? 'Permit to post' : iss.noun === 'certificate' ? 'Certificate' : 'Approval letter'} (PDF)</a>` : ''}
          ${ed ? `<select class="select" id="pmAssign" style="width:auto;height:30px;font-size:13px"><option value="">Unassigned</option>${(state.staff || []).map((x) => `<option value="${esc(x.id)}" ${x.id === p.assignee_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}</div>
        <div class="card card-b" style="background:var(--violet-soft);border-color:#d9d0ff"><div style="display:flex;align-items:center;gap:8px"><div class="section-title" style="color:var(--violet)">${icon('spark')} AI review</div>
          <span class="faint" style="font-size:12px;margin-left:auto">${ai.at ? `${esc(ai.model || '')} · ${ago(ai.at)}` : 'Not run yet'}</span>${ed ? `<button class="btn btn-sm" data-pm="rereview">${icon('refresh')} Re-run</button>` : ''}</div>
          ${ai.summary ? `<p style="margin:8px 0 0">${esc(ai.summary)}</p>` : ''}
          ${forStaff.length ? `<div class="stack" style="gap:6px;margin-top:10px"><div class="section-title">For staff to verify</div>${forStaff.map(issueRow).join('')}</div>` : ''}
          ${forApplicant.length ? `<div class="stack" style="gap:6px;margin-top:10px"><div class="section-title">Completeness</div>${forApplicant.map(issueRow).join('')}</div>` : '<div style="margin-top:8px;font-size:13px">No completeness problems found.</div>'}
          ${d.applicant_note ? `<div style="margin-top:10px;font-size:13px"><b>Applicant's note:</b> ${esc(d.applicant_note)}</div>` : ''}
          <div class="faint" style="font-size:11.5px;margin-top:10px">The AI drafts; staff decide. It never approves applications or makes zoning, floodplain or code determinations.</div></div>
        <div class="grid-2">
          <div class="card card-b"><div class="section-title">Address screen</div>
            <p style="margin:6px 0 0;font-size:13px">${sc.jurisdiction?.checked ? `${sc.jurisdiction.inCity ? '✓ Inside city limits' : `⚠ ${esc(sc.jurisdiction.place || 'Outside city limits')}`} (${esc(sc.jurisdiction.county || '')})<br><span class="faint">${esc(sc.matchedAddress || '')} · U.S. Census geocoder</span>` : esc(sc.jurisdiction?.error || 'Not screened')}</p>
            <p style="margin:6px 0 0;font-size:13px">${sc.flood?.checked ? `Flood zone <b>${esc(sc.flood.zone || 'none mapped')}</b>${sc.flood.sfha ? ' · special flood hazard area' : ''}${sc.flood.bfe ? ` · BFE ${sc.flood.bfe}` : ''}<br><span class="faint">FEMA NFHL panel ${esc(sc.flood.panel || '')}</span>` : esc(sc.flood?.error || '')}</p>
            ${sc.lat ? `<a style="font-size:12.5px" href="https://www.google.com/maps/search/?api=1&query=${sc.lat},${sc.lon}" target="_blank" rel="noopener">${icon('external')} Map</a>` : ''}</div>
          <div class="card card-b"><div class="section-title">Fee</div>
            ${p.fee ? `<div style="font:650 22px var(--font-display);margin-top:4px">${money(p.fee.total)}</div><div class="faint" style="font-size:12px">${esc(p.fee.lines.map((l) => l.label).join(' · '))}</div>` : '<p class="faint">No estimate</p>'}
            ${p.fee_assessed != null ? `<div style="font-size:13px;margin-top:6px">Assessed <b>${money(p.fee_assessed)}</b>${p.fee_paid != null ? ` · Paid <b>${money(p.fee_paid)}</b>${p.receipt ? ` (receipt ${esc(p.receipt)})` : ''}` : ''}</div>` : ''}</div>
        </div>
        ${decision}
        <div class="card card-b"><div class="section-title">Attachments</div><div class="list" style="margin-top:6px">${p.files.length ? p.files.map((f) => `<a class="list-item" href="${API}/permits/${id}/files/${esc(f.id)}" target="_blank" rel="noopener"><div class="grow"><div class="title">${esc(f.name)}</div><div class="meta">${esc(optLabel(p.schema.docKinds, f.kind))} · ${bytes(f.bytes)}${f.has_text ? ' · read by AI' : ''}</div></div>${icon('external')}</a>`).join('') : '<span class="faint">None</span>'}</div></div>
        ${p.schema.sections.map((sec) => {
          const rows = sec.fields.filter((f) => shown(f) && f.type !== 'files').map((f) => [f.label, val(f)]).filter(([, v]) => v != null);
          return rows.length ? `<div class="card card-b"><div class="section-title">${esc(sec.title)}</div><div style="display:grid;grid-template-columns:minmax(140px,38%) 1fr;gap:6px 14px;margin-top:8px;font-size:13px">${rows.map(([l, v]) => `<span class="faint">${esc(l.length > 70 ? `${l.slice(0, 70)}…` : l)}</span><span>${esc(v)}</span>`).join('')}</div></div>` : '';
        }).join('')}
        <div class="card card-b"><div class="section-title">Messages to the applicant</div><div class="stack" style="gap:8px;margin-top:8px">${p.outbox.length ? p.outbox.map((m) => `<div style="font-size:13px"><span class="pill ${m.status === 'sent' ? 'green' : m.status === 'failed' ? 'red' : ''}">${esc(m.channel)} · ${m.status === 'not_configured' ? 'not sent: provider not set up' : esc(m.status)}</span> <b>${esc(m.subject || '')}</b> <span class="faint">${ago(m.at)}${m.to_addr ? ` · ${esc(m.to_addr)}` : ''}</span>${m.error ? `<div class="faint">${esc(m.error)}</div>` : ''}</div>`).join('') : '<span class="faint">None yet</span>'}</div></div>
        ${ed ? `<label class="field"><span>Add a note</span><textarea class="textarea" id="pmNote" rows="2" placeholder="Internal note, or a message to the applicant"></textarea></label>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-sm" data-pm="note">Save internal note</button><button class="btn btn-sm" data-pm="message">${icon('send')} Send to applicant</button></div>` : ''}
        <div class="section-title">History</div>
        <div class="timeline">${p.events.slice().reverse().map((h) => `<div class="tl"><i></i><div><b>${esc(h.note || (PERMIT_STATUS[h.status] || [h.status])[0])}</b><small>${esc(h.actor_name)} · ${toDate(h.at).toLocaleString()}${h.public ? ' · shown to applicant' : ''}</small></div></div>`).join('')}</div>
      </div>`);
    const act = async (body, msg) => {
      try { await api(`/permits/${id}/actions`, { method: 'POST', body }); toast(msg); refreshBadges(); await renderPermits($('#page')); openPermitDrawer(id); } catch (e) { toast(e.message); }
    };
    dr.querySelector('#pmAssign')?.addEventListener('change', (e) => act({ action: 'assign', assignee_id: e.target.value || null }, 'Assigned'));
    dr.onclick = async (e) => {
      const b = e.target.closest('[data-pm]'); if (!b) return;
      const a = b.dataset.pm;
      const v = (sel) => dr.querySelector(sel)?.value.trim();
      if (a === 'accept') act({ action: 'accept', fee: Number(v('#pmFee').replace(/[$,]/g, '')) }, 'Marked complete; applicant told the fee');
      else if (a === 'request_info') act({ action: 'request_info', items: v('#pmItems').split('\n').map((x) => x.trim()).filter(Boolean) }, 'Changes requested; applicant notified');
      else if (a === 'request_info_prompt') { const t = prompt('What does the applicant need to change? One item per line.'); if (t) act({ action: 'request_info', items: t.split('\n') }, 'Changes requested'); }
      else if (a === 'payment') act({ action: 'payment', amount: Number(v('#pmAmt').replace(/[$,]/g, '')), receipt: v('#pmRcpt') }, 'Payment recorded; review started');
      else if (a === 'issue') { if (confirm(`${iss.action}: ${v('#pmNum')}? The applicant is notified and can download the ${noun}.`)) act({ action: 'issue', permit_number: v('#pmNum'), conditions: v('#pmCond') }, `${p.schema.statuses.issued[0]}; applicant notified`); }
      else if (a === 'deny') { const r = prompt('Reason the application is not approved (sent to the applicant):'); if (r) act({ action: 'deny', reason: r }, 'Applicant notified'); }
      else if (a === 'inspection') act({ action: 'inspection', type: v('#pmInsType'), result: v('#pmInsRes'), note: v('#pmInsNote') }, 'Inspection recorded');
      else if (a === 'close') { if (confirm('Close this application?')) act({ action: 'close' }, 'Closed'); }
      else if (a === 'note' || a === 'message') { if (v('#pmNote')) act({ action: 'note', note: v('#pmNote'), public: a === 'message' }, a === 'message' ? 'Sent to the applicant' : 'Note saved'); }
      else if (a === 'rereview') { b.disabled = true; b.textContent = 'Reviewing…'; try { await api(`/permits/${id}/review`, { method: 'POST' }); openPermitDrawer(id); } catch (err) { toast(err.message); b.disabled = false; } }
    };
  }

  /* ---------------- Channels ---------------- */

  async function renderChannels(page) {
    const snippet = `<script src="${EMBED_SRC}" data-city="${CITY}" async></script>`;
    const phone = await api('/channels');
    page.innerHTML = `
      <div class="stack" style="max-width:980px">
        <div class="card card-b"><div class="channel">
          <div class="channel-icon">${icon('chat')}</div>
          <div><h3>Website chat <span class="pill green" style="margin-left:6px"><span class="live-dot"></span>Live</span></h3>
            <p>Paste this one line before <code>&lt;/body&gt;</code> on any website: CivicPlus, Granicus, WordPress, Wix or a custom site. The chat bubble appears in the corner and answers from this knowledge base.</p>
            <div class="code" style="margin-top:12px"><button class="btn btn-sm copy" id="copySnippet">${icon('copy')} Copy</button>${esc(snippet)}</div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
              ${PUBLIC_SITE ? `<a class="btn" href="${esc(PUBLIC_SITE)}" target="_blank" rel="noopener">${icon('external')} See it on ${esc(host(PUBLIC_SITE))}</a>` : ''}
              <button class="btn" id="previewHere">${icon('spark')} Preview it on this page</button>
            </div></div>
          <span></span></div></div>
        <div class="card card-b"><div class="channel">
          <div class="channel-icon" style="background:var(--violet-soft);color:var(--violet)">${icon('phone')}</div>
          <div><h3>Phone and text messages ${phone.texts ? `<span class="pill green" style="margin-left:6px">${phone.texts === 'telnyx' ? 'Telnyx' : 'Twilio'} connected</span>` : '<span class="pill amber" style="margin-left:6px">Needs a phone number</span>'}</h3>
            <p>Residents call or text a City Hall number. The AI answers from this knowledge base, takes problem reports with a tracking number, checks on requests by number, and hands callers to City Hall during office hours. Every call and text appears under Conversations.</p>
            <ol class="muted" style="margin:10px 0 0;padding-left:20px;font-size:13.5px">
              <li>Buy a local number in Telnyx (Numbers → Search &amp; Buy Numbers).</li>
              <li>Create a messaging profile (Messaging → Programmable Messaging), set its inbound webhook to the address below with API v2, and assign the number to it.</li>
              <li>Register the city for business texting (Messaging → 10DLC: a brand for the city and a campaign). Carriers block texts from unregistered numbers.</li>
              <li>City Hall OS support adds the Telnyx keys to the platform once; every city's number then works.</li>
            </ol>
            <div class="code" style="margin-top:12px">Texts: ${esc(phone.telnyxUrl)}${phone.texts === 'twilio' ? `
Twilio messages: ${esc(phone.smsUrl)}
Twilio calls:    ${esc(phone.voiceUrl)}` : ''}</div></div><span></span></div></div>
        <div class="cols cols-2">
          <div class="card card-b"><div class="channel" style="grid-template-columns:48px 1fr">
            <div class="channel-icon" style="background:var(--amber-soft);color:var(--amber)">${icon('mail')}</div>
            <div><h3>Email inbox</h3><p>Draft replies to the City Clerk's inbox from city documents, for staff to approve and send.</p><span class="pill" style="margin-top:8px">Coming next</span></div></div></div>
        </div>
        <div class="card card-b"><div class="channel">
          <div class="channel-icon" style="background:var(--paper-2);color:var(--ink)">${icon('code')}</div>
          <div><h3>Knowledge API</h3><p>Everything in the dashboard is available to City Hall OS agents and approved integrations.</p>
            <div class="code" style="margin-top:12px">GET  /api/${CITY}/config            public assistant settings
POST /api/${CITY}/chat              ask the AI City Clerk (streams answers with citations)
POST /api/${CITY}/requests          file a service request
GET  /api/${CITY}/track/${esc(state.city.requestPrefix)}-1001    check a request's status
GET  /api/${CITY}/documents         staff: list the knowledge base
POST /api/${CITY}/documents         staff: add files, web pages or answers</div></div><span></span></div></div>
      </div>`;
    $('#copySnippet').onclick = async () => { try { await navigator.clipboard.writeText(snippet); toast('Embed code copied'); } catch { toast('Select the code and copy it'); } };
    $('#previewHere').onclick = () => {
      if (document.querySelector('script[data-chos-preview]')) { toast('The chat bubble is in the bottom-right corner'); return; }
      const s = document.createElement('script');
      s.src = '/embed.js'; s.dataset.city = CITY; s.dataset.chosPreview = '1'; s.dataset.open = 'true';
      document.body.appendChild(s);
    };
  }

  /* ---------------- Settings ---------------- */

  async function renderSettings(page) {
    const s = await api('/settings');
    page.innerHTML = `
      <form class="stack" id="sForm" style="max-width:860px">
        <div class="card"><div class="card-h"><h2>AI City Clerk</h2></div><div class="card-b stack" style="gap:14px">
          <div class="grid-2">
            <label class="field"><span>Assistant name</span><input class="input" name="assistantName" value="${esc(s.assistantName)}"></label>
            <label class="field"><span>Short city name</span><input class="input" name="shortName" value="${esc(s.shortName)}"><small>Used in replies, e.g. "${esc(s.shortName)} Police".</small></label>
            <label class="field"><span>Brand color</span><div style="display:flex;gap:8px"><input type="color" name="brandColor" value="${esc(s.brandColor)}" style="width:46px;height:38px;border:1px solid var(--line-2);border-radius:10px;padding:3px;background:#fff"><input class="input" id="colorText" value="${esc(s.brandColor)}"></div></label>
          </div>
          <label class="field"><span>Subtitle</span><input class="input" name="tagline" value="${esc(s.tagline)}"></label>
          <label class="field"><span>Greeting</span><textarea class="textarea" name="greeting" rows="3">${esc(s.greeting)}</textarea></label>
          <label class="field"><span>Suggested questions</span><textarea class="textarea" name="suggestions" rows="4">${esc((s.suggestions || []).join('\n'))}</textarea><small>One per line. Shown as buttons when a resident opens the chat.</small></label>
        </div></div>
        <div class="card"><div class="card-h"><h2>City profile</h2></div><div class="card-b stack" style="gap:14px">
          <p class="muted" style="margin:0">The AI always knows these facts and treats them as current. Use them for anything that changes often.</p>
          <div class="grid-2">
            <label class="field"><span>City Hall phone</span><input class="input" name="phone" value="${esc(s.phone)}"></label>
            <label class="field"><span>Police non-emergency</span><input class="input" name="policeNonEmergency" value="${esc(s.policeNonEmergency)}"></label>
          </div>
          <label class="field"><span>Address</span><input class="input" name="address" value="${esc(s.address)}"></label>
          <div class="grid-2">
            <label class="field"><span>Office hours</span><input class="input" name="hours" value="${esc(s.hours)}" placeholder="e.g. Monday–Friday, 8 am to 5 pm"></label>
            <label class="field"><span>City website</span><input class="input" name="website" value="${esc(s.website)}"></label>
          </div>
          <label class="field"><span>Site where the chat is installed</span><input class="input" name="publicSite" value="${esc(s.publicSite || '')}" placeholder="https://"></label>
          <label class="field"><span>Other current facts</span><textarea class="textarea" name="profileNotes" rows="4" placeholder="e.g. The Board of Aldermen meets the first and third Tuesday of each month at 6 pm at City Hall.">${esc(s.profileNotes || '')}</textarea></label>
        </div></div>
        <div class="card"><div class="card-h"><h2>Online services</h2><button type="button" class="btn btn-sm" id="svcAdd" style="margin-left:auto">${icon('plus')} Add a service</button></div><div class="card-b stack" style="gap:12px">
          <p class="muted" style="margin:0">Things residents can do on another website, like paying a water bill. When a question uses one of the words, the AI gives the direct link and the chat shows a button to it. Text message replies include the link.</p>
          <div class="stack" id="svcRows" style="gap:10px">${(s.services || []).map(serviceRow).join('') || ''}</div>
        </div></div>
        <div class="card"><div class="card-h"><h2>Office hours and results</h2></div><div class="card-b stack" style="gap:14px">
          <p class="muted" style="margin:0">Office hours decide who hears about a new request after hours. The two numbers below turn questions answered into staff time saved on the Results page.</p>
          <div class="grid-2">
            <label class="field"><span>Opens</span><input class="input" type="time" name="openTime" value="${esc(s.openTime || '08:00')}"></label>
            <label class="field"><span>Closes</span><input class="input" type="time" name="closeTime" value="${esc(s.closeTime || '17:00')}"></label>
          </div>
          <div class="field"><span>Open on</span><div class="chips" id="openDays">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<button type="button" class="chip ${(s.openDays || [1, 2, 3, 4, 5]).includes(i) ? 'on' : ''}" data-day="${i}">${d}</button>`).join('')}</div></div>
          <div class="grid-2">
            <label class="field"><span>Minutes staff spend on a typical call</span><input class="input" type="number" min="0" step="0.5" name="minutesPerCall" value="${esc(s.minutesPerCall ?? 4)}"></label>
            <label class="field"><span>Calls per week before City Hall OS</span><input class="input" type="number" min="0" name="baselineCallsPerWeek" value="${esc(s.baselineCallsPerWeek ?? '')}" placeholder="Your baseline count"></label>
          </div>
        </div></div>
        <div><button class="btn btn-primary" type="submit">${icon('check')} Save settings</button></div>
      </form>
      <div class="stack" style="max-width:1100px;margin-top:22px" id="routingArea"><div class="empty"><div class="spin" style="margin:20px auto"></div></div></div>`;
    $('#openDays').onclick = (e) => { const c = e.target.closest('.chip'); if (c) c.classList.toggle('on'); };
    $('#svcAdd').onclick = () => { $('#svcRows').insertAdjacentHTML('beforeend', serviceRow({})); $('#svcRows .svc:last-child input').focus(); };
    $('#svcRows').onclick = (e) => { if (e.target.closest('[data-svc-remove]')) e.target.closest('.svc').remove(); };
    renderRouting($('#routingArea'));
    const f = $('#sForm');
    f.brandColor.oninput = () => { $('#colorText').value = f.brandColor.value; };
    $('#colorText').oninput = (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) f.brandColor.value = e.target.value; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f).entries());
      body.suggestions = body.suggestions.split('\n').map((x) => x.trim()).filter(Boolean);
      body.openDays = $$('#openDays .chip.on').map((c) => Number(c.dataset.day));
      for (const k of ['svcLabel', 'svcUrl', 'svcWords']) delete body[k];
      body.services = $$('#svcRows .svc').map((r) => ({ label: r.querySelector('[name=svcLabel]').value.trim(), url: r.querySelector('[name=svcUrl]').value.trim(), words: r.querySelector('[name=svcWords]').value.trim() }))
        .filter((x) => x.label || x.url);
      const bad = body.services.find((x) => !x.label || !/^https:\/\/\S+$/i.test(x.url));
      if (bad) { toast('Each online service needs a name and a link starting with https://'); return; }
      try {
        const saved = await api('/settings', { method: 'PUT', body });
        Object.assign(state.city, { shortName: saved.shortName, publicSite: saved.publicSite, brandColor: saved.brandColor });
        PUBLIC_SITE = saved.publicSite || '';
        toast('Settings saved. The chatbot updates within a minute.');
      } catch (err) { toast(err.message); }
    };
  }

  function serviceRow(x) {
    return `<div class="svc" style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:8px;align-items:end;border:1px solid var(--line);border-radius:12px;padding:10px">
      <label class="field"><span>Name</span><input class="input" name="svcLabel" value="${esc(x.label || '')}" placeholder="Pay your water bill"></label>
      <label class="field"><span>Direct link</span><input class="input" name="svcUrl" value="${esc(x.url || '')}" placeholder="https://"></label>
      <button type="button" class="btn btn-sm" data-svc-remove title="Remove">${icon('trash')}</button>
      <label class="field" style="grid-column:1 / -1"><span>Words residents use</span><input class="input" name="svcWords" value="${esc(x.words || '')}" placeholder="water bill, utility bill, pay my bill"><small>Separate with commas.</small></label>
    </div>`;
  }

  /* ---------------- Departments and request routing (in Settings) ---------------- */

  async function renderRouting(area) {
    const [{ departments }, { requestTypes }, { staff }] = await Promise.all([api('/departments'), api('/request-types'), api('/staff')]);
    const people = staff.filter((p) => p.active);
    const nameOf = (id) => people.find((p) => p.id === id)?.name || '—';
    const names = (list) => (list.length ? list.map(nameOf).map(esc).join(', ') : '<span class="faint">Department staff</span>');
    area.innerHTML = `
      <div class="card"><div class="card-h"><h2>Departments</h2><button class="btn btn-sm" id="dNew" style="margin-left:auto">${icon('plus')} Add department</button></div>
        <div style="overflow:auto"><table class="table"><thead><tr><th>Department</th><th>Phone</th><th>Email</th><th>Status</th></tr></thead><tbody id="dRows">
        ${departments.map((d) => `<tr data-id="${esc(d.id)}"><td><strong>${esc(d.name)}</strong></td><td>${esc(d.phone || '—')}</td><td>${esc(d.email || '—')}</td><td>${d.active ? '<span class="pill green">Active</span>' : '<span class="pill">Inactive</span>'}</td></tr>`).join('')}
        </tbody></table></div></div>
      <div class="card"><div class="card-h"><h2>Request types and routing</h2><button class="btn btn-sm" id="tNew" style="margin-left:auto">${icon('plus')} Add request type</button></div>
        <div class="card-b" style="padding-bottom:0"><p class="muted" style="margin:0">Who gets a text or email when a resident reports each kind of problem. With nobody listed, everyone in the department with contact details is told.</p></div>
        <div style="overflow:auto"><table class="table"><thead><tr><th>Request type</th><th>Department</th><th>Priority</th><th>Assign to</th><th>Tell during hours</th><th>Tell after hours</th></tr></thead><tbody id="tRows">
        ${requestTypes.map((t) => `<tr data-key="${esc(t.key)}" ${t.active ? '' : 'style="opacity:.55"'}><td><strong>${esc(t.label)}</strong></td><td>${esc(t.department)}</td><td>${esc(t.priority)}</td>
          <td>${t.default_assignee_id ? esc(nameOf(t.default_assignee_id)) : '<span class="faint">Nobody</span>'}</td><td>${names(t.notify_staff)}</td><td>${t.after_hours_staff.length ? names(t.after_hours_staff) : '<span class="faint">Same as during hours</span>'}</td></tr>`).join('')}
        </tbody></table></div></div>`;
    const deptModal = (d = null) => {
      const m = modal(`
        <h2>${d ? esc(d.name) : 'Add a department'}</h2>
        <label class="field"><span>Name</span><input class="input" id="dmName" value="${esc(d?.name || '')}"></label>
        <div class="grid-2"><label class="field"><span>Phone</span><input class="input" id="dmPhone" value="${esc(d?.phone || '')}"></label>
          <label class="field"><span>Email</span><input class="input" id="dmEmail" value="${esc(d?.email || '')}"></label></div>
        ${d ? `<label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="dmActive" ${d.active ? 'checked' : ''}> <span>Active</span></label>` : ''}
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="dmSave">Save</button></div>`);
      m.querySelector('#dmSave').onclick = async () => {
        const body = { name: m.querySelector('#dmName').value, phone: m.querySelector('#dmPhone').value, email: m.querySelector('#dmEmail').value };
        if (d) body.active = m.querySelector('#dmActive').checked;
        try { await api(d ? `/departments/${d.id}` : '/departments', { method: d ? 'PUT' : 'POST', body }); m.remove(); toast('Saved'); state.departments = null; renderRouting(area); } catch (e) { toast(e.message); }
      };
    };
    const typeModal = (t = null) => {
      const pick = (id, sel) => `<select class="select" id="${id}" multiple size="4">${people.map((p) => `<option value="${esc(p.id)}" ${sel.includes(p.id) ? 'selected' : ''}>${esc(p.name)}${p.department ? ` · ${esc(p.department)}` : ''}</option>`).join('')}</select>`;
      const m = modal(`
        <h2>${t ? esc(t.label) : 'Add a request type'}</h2>
        <div class="grid-2">
          <label class="field"><span>Name residents see</span><input class="input" id="tmLabel" value="${esc(t?.label || '')}"></label>
          <label class="field"><span>Department</span><select class="select" id="tmDept">${departments.filter((d) => d.active || d.id === t?.department_id).map((d) => `<option value="${esc(d.id)}" ${d.id === t?.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Priority</span><select class="select" id="tmPri">${['low', 'normal', 'high', 'urgent'].map((p) => `<option ${p === (t?.priority || 'normal') ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          <label class="field"><span>Assign new requests to</span><select class="select" id="tmAssign"><option value="">Nobody (staff pick it up)</option>${people.map((p) => `<option value="${esc(p.id)}" ${p.id === t?.default_assignee_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Tell during office hours</span>${pick('tmNotify', t?.notify_staff || [])}<small>Ctrl-click to choose several.</small></label>
          <label class="field"><span>Tell after hours (on call)</span>${pick('tmAfter', t?.after_hours_staff || [])}</label>
        </div>
        ${t ? `<label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="tmActive" ${t.active ? 'checked' : ''}> <span>Residents can choose this type</span></label>` : ''}
        ${people.length ? '' : '<small class="faint">Add people under Staff &amp; access to route requests to them.</small>'}
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="tmSave">Save</button></div>`);
      const sel = (id) => [...m.querySelector(id).selectedOptions].map((o) => o.value);
      m.querySelector('#tmSave').onclick = async () => {
        const body = { label: m.querySelector('#tmLabel').value, department_id: m.querySelector('#tmDept').value, priority: m.querySelector('#tmPri').value,
          default_assignee_id: m.querySelector('#tmAssign').value || null, notify_staff: sel('#tmNotify'), after_hours_staff: sel('#tmAfter') };
        if (t) body.active = m.querySelector('#tmActive').checked;
        try { await api(t ? `/request-types/${t.key}` : '/request-types', { method: t ? 'PUT' : 'POST', body }); m.remove(); toast('Saved'); renderRouting(area); } catch (e) { toast(e.message); }
      };
    };
    $('#dNew').onclick = () => deptModal();
    $('#tNew').onclick = () => typeModal();
    $('#dRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) deptModal(departments.find((d) => d.id === tr.dataset.id)); };
    $('#tRows').onclick = (e) => { const tr = e.target.closest('tr[data-key]'); if (tr) typeModal(requestTypes.find((t) => t.key === tr.dataset.key)); };
  }

  /* ---------------- Results report ---------------- */

  async function renderReport(page) {
    state.reportDays ??= 30;
    const r = await api(`/report?days=${state.reportDays}`);
    const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
    const hrs = (x) => (x == null ? '—' : x < 1 ? `${Math.round(x * 60)} min` : x < 48 ? `${x.toFixed(1)} h` : `${(x / 24).toFixed(1)} days`);
    const bars = (rows) => { const max = Math.max(1, ...rows.map((x) => x.n)); return rows.length ? `<div class="meter">${rows.map((x) => `<div class="meter-row"><span>${esc(x.label)}</span><b>${x.n}</b><div class="track"><i style="width:${(x.n / max) * 100}%"></i></div></div>`).join('')}</div>` : emptyNote('grid', 'Nothing yet in this period.'); };
    const weekMax = Math.max(1, ...r.weekly.map((w) => w.conversations));
    $('#pageActions').innerHTML = `<div class="seg" id="rDays">${[[30, '30 days'], [90, '90 days'], [365, '12 months']].map(([d, l]) => `<button class="${state.reportDays === d ? 'on' : ''}" data-d="${d}">${l}</button>`).join('')}</div>
      <button class="btn" id="rCsv">${icon('file')} Download CSV</button>`;
    const i = r.impact;
    page.innerHTML = `
      <div class="kpis">
        ${kpi('chat', 'Resident questions', fmt(r.questions), `${i.questionsPerWeek.toFixed(1)} a week${i.baselineCallsPerWeek ? ` · baseline ${fmt(i.baselineCallsPerWeek)} calls a week` : ''}`)}
        ${kpi('check', 'Answered without staff', pct(i.selfServedRate), `${fmt(i.selfServed)} of ${fmt(r.answers.total)} replies`)}
        ${kpi('users', 'Staff time saved', hrs(i.staffHoursSaved), `At ${i.minutesPerCall} minutes a call`)}
        ${kpi('clipboard', 'Service requests', fmt(r.requests.total), `${fmt(r.requests.open)} still open · ${fmt(r.requests.openOlderThanWeek)} open over a week`)}
      </div>
      <div class="cols cols-2">
        <div class="card"><div class="card-h"><h2>Response times</h2></div><div class="card-b"><div class="facts">
          <div class="fact"><small>First staff action (median)</small><b>${hrs(r.requests.medianHoursToFirstAction)}</b></div>
          <div class="fact"><small>Resolved (median)</small><b>${hrs(r.requests.medianHoursToResolve)}</b></div>
          <div class="fact"><small>Emergency redirects</small><b>${fmt(r.answers.emergencies)}</b></div></div></div></div>
        <div class="card"><div class="card-h"><h2>Conversations by week</h2></div><div class="card-b">${r.weekly.length ? `<div class="bars">${r.weekly.map((w) => `<div class="bar" title="Week of ${w.week}: ${w.conversations}"><i style="height:${Math.max(3, (w.conversations / weekMax) * 110)}px"></i><small>${w.week.slice(5)}</small></div>`).join('')}</div>` : emptyNote('chat', 'No conversations in this period.')}</div></div>
        <div class="card"><div class="card-h"><h2>What residents ask about</h2></div><div class="card-b">${bars(r.topics)}</div></div>
        <div class="card"><div class="card-h"><h2>Requests by type</h2></div><div class="card-b">${bars(r.requests.byType)}</div></div>
        <div class="card"><div class="card-h"><h2>Requests by department</h2></div><div class="card-b">${bars(r.requests.byDepartment)}</div></div>
        <div class="card"><div class="card-h"><h2>Channels</h2></div><div class="card-b">${bars(r.conversations.map((c) => ({ label: c.channel, n: c.n })))}</div></div>
        <div class="card"><div class="card-h"><h2>Most-cited documents</h2></div><div class="card-b"><div class="list">${r.topDocuments.length ? r.topDocuments.map((d) => `<div class="list-item"><div class="grow"><div class="title">${esc(d.title)}</div></div><span class="pill blue">${d.n}×</span></div>`).join('') : emptyNote('file', 'No citations in this period.')}</div></div></div>
        <div class="card"><div class="card-h"><h2>Questions the AI couldn't answer</h2></div><div class="card-b"><div class="list">${r.unanswered.length ? r.unanswered.map((c) => `<div class="list-item clickable" data-convo="${c.id}"><div class="grow"><div class="title">${esc(c.first_question)}</div><div class="meta">${ago(c.last_at)}</div></div></div>`).join('') : emptyNote('check', 'None in this period.')}</div></div></div>
      </div>`;
    $('#rDays').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.reportDays = Number(b.dataset.d); renderReport(page); } };
    page.onclick = (e) => { const c = e.target.closest('[data-convo]'); if (c) { state.convoId = c.dataset.convo; location.hash = '#/conversations'; } };
    $('#rCsv').onclick = () => {
      const rows = [['Measure', 'Value'], ['Period (days)', r.days], ['Resident questions', r.questions], ['Replies', r.answers.total], ['Answered without staff', i.selfServed],
        ['Answered without staff (%)', i.selfServedRate == null ? '' : Math.round(i.selfServedRate * 100)], ['Staff hours saved', i.staffHoursSaved.toFixed(1)],
        ['Emergency redirects', r.answers.emergencies], ['Service requests', r.requests.total], ['Open requests', r.requests.open],
        ['Median hours to first staff action', r.requests.medianHoursToFirstAction?.toFixed(1) ?? ''], ['Median hours to resolve', r.requests.medianHoursToResolve?.toFixed(1) ?? ''],
        ...r.requests.byType.map((x) => [`Requests: ${x.label}`, x.n]), ...r.topics.map((x) => [`Questions about: ${x.label}`, x.n])];
      const csv = rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `${CITY}-results-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
    };
  }

  /* ---------------- Support console (City Hall OS operators) ---------------- */

  async function renderPlatform(page) {
    const { cities } = await api('/api/platform/cities?stats=1');
    $('#pageActions').innerHTML = `<button class="btn btn-primary" id="cNew">${icon('plus')} Add a city</button>`;
    const STATUS = { onboarding: ['Onboarding', 'amber'], active: ['Active', 'green'], suspended: ['Suspended', 'red'], archived: ['Archived', ''] };
    page.innerHTML = `
      <div class="card" style="overflow:auto"><table class="table">
        <thead><tr><th>City</th><th>Status</th><th class="num">Documents</th><th class="num">Conversations</th><th class="num">Requests</th><th class="num">Size</th><th></th></tr></thead>
        <tbody id="pRows">${cities.filter((c) => c.status !== 'archived' || state.showArchived).map((c) => `<tr data-slug="${esc(c.slug)}">
          <td><strong>${esc(c.name)}</strong><div class="faint" style="font-size:12.5px">${esc([c.county, c.state].filter(Boolean).join(', '))} · <span class="mono">${esc(c.id)}</span></div></td>
          <td><select class="select" data-status="${esc(c.slug)}">${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td class="num">${fmt(c.stats?.documents)}</td><td class="num">${fmt(c.stats?.conversations)}</td><td class="num">${fmt(c.stats?.requests)}</td><td class="num">${bytes(c.stats?.bytes)}</td>
          <td><button class="btn btn-sm" data-open="${esc(c.slug)}">Open</button></td></tr>`).join('')}</tbody></table></div>
      <label class="faint" style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:13px"><input type="checkbox" id="pArch" ${state.showArchived ? 'checked' : ''}> Show archived cities</label>`;
    $('#pArch').onchange = (e) => { state.showArchived = e.target.checked; renderPlatform(page); };
    page.onchange = async (e) => {
      const sel = e.target.closest('[data-status]'); if (!sel) return;
      try { await api(`/api/platform/cities/${sel.dataset.status}/status`, { method: 'PUT', body: { status: sel.value } }); toast('Status updated'); } catch (err) { toast(err.message); }
    };
    page.onclick = async (e) => {
      const b = e.target.closest('[data-open]'); if (!b) return;
      const me = await fetch('/api/auth/me').then((res) => res.json());
      state.me = me;
      const c = me.cities.find((x) => x.slug === b.dataset.open);
      if (c) { location.hash = '#/overview'; selectCity(c); } else toast('Archived cities can’t be opened');
    };
    $('#cNew').onclick = () => {
      const m = modal(`
        <h2>Add a city</h2>
        <div class="grid-2">
          <label class="field"><span>Official name</span><input class="input" id="nName" placeholder="City of Poplarville"></label>
          <label class="field"><span>State</span><input class="input" id="nState" maxlength="2" value="MS"></label>
          <label class="field"><span>County</span><input class="input" id="nCounty" placeholder="Pearl River County"></label>
          <label class="field"><span>Request prefix</span><input class="input" id="nPrefix" maxlength="5" placeholder="POP"></label>
        </div>
        <small class="faint">The city starts as Onboarding with default departments. Load its documents, fill in Settings, add its first administrator, then set it to Active.</small>
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nSave">Add city</button></div>`);
      m.querySelector('#nSave').onclick = async () => {
        try {
          const { city } = await api('/api/platform/cities', { method: 'POST', body: { name: m.querySelector('#nName').value, state: m.querySelector('#nState').value, county: m.querySelector('#nCounty').value, requestPrefix: m.querySelector('#nPrefix').value.toUpperCase() || undefined } });
          m.remove(); toast(`${city.name} added`); renderPlatform(page);
        } catch (e) { toast(e.message); }
      };
    };
  }

  /* ---------------- Staff & access ---------------- */

  const roleName = (key) => (state.roles || state.me.roles).find((r) => r.key === key)?.label || key;

  async function renderStaff(page) {
    const [{ staff, roles }, { departments }] = await Promise.all([api('/staff'), api('/departments')]);
    state.staff = null; // the assignment list reloads with any changes
    state.roles = roles;
    state.departments = departments.filter((d) => d.active);
    $('#pageActions').innerHTML = `<button class="btn btn-primary" id="sNew">${icon('plus')} Add a person</button>`;
    $('#sNew').onclick = () => staffModal();
    const accessPill = (p) => (!p.access ? '<span class="pill">No dashboard access</span>'
      : `<span class="pill ${p.access.role === 'admin' ? 'violet' : 'blue'}">${esc(roleName(p.access.role))}</span>${p.access.status === 'invited' ? ' <span class="pill amber">Invited</span>' : ''}`);
    page.innerHTML = `
      <div class="cols cols-21">
        <div class="card" style="overflow:hidden"><table class="table">
          <thead><tr><th>Person</th><th class="hide-sm">Department</th><th>Dashboard access</th><th class="hide-sm">Last sign-in</th></tr></thead>
          <tbody id="sRows">${staff.length ? staff.map((p) => `<tr data-id="${p.id}" ${p.active ? '' : 'style="opacity:.55"'}>
            <td><strong>${esc(p.name)}</strong><div class="faint" style="font-size:12.5px">${esc([p.title, p.access?.email || p.email].filter(Boolean).join(' · '))}</div></td>
            <td class="hide-sm">${esc(p.department || '—')}</td>
            <td>${p.active ? accessPill(p) : '<span class="pill">Inactive</span>'}</td>
            <td class="hide-sm muted">${p.access?.last_login_at ? ago(p.access.last_login_at) : '—'}</td></tr>`).join('')
            : `<tr><td colspan="4">${emptyNote('users', 'Add the people who work requests or manage the knowledge base.')}</td></tr>`}</tbody></table></div>
        <div class="card"><div class="card-h"><h2>Roles</h2></div><div class="card-b"><div class="list">${roles.map((r) => `
          <div class="list-item"><div class="grow"><div class="title">${esc(r.label)}</div><div class="meta">${esc(r.description)}</div></div></div>`).join('')}</div>
          <p class="faint" style="font-size:12.5px;margin:12px 0 0">People without dashboard access can still be assigned requests. Every change anyone makes is recorded under Activity.</p></div></div>
      </div>`;
    $('#sRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) staffModal(staff.find((p) => p.id === tr.dataset.id)); };
  }

  function staffModal(p = null) {
    const roles = state.roles || state.me.roles;
    const isSelf = !!(p && state.me.user && p.user_id === state.me.user.id);
    const m = modal(`
      <h2>${p ? esc(p.name) : 'Add a person'}</h2>
      <div class="grid-2">
        <label class="field"><span>Name</span><input class="input" id="pName" value="${esc(p?.name || '')}" required></label>
        <label class="field"><span>Job title</span><input class="input" id="pTitle" value="${esc(p?.title || '')}" placeholder="e.g. Street crew lead"></label>
        <label class="field"><span>Department</span><select class="select" id="pDept"><option value="">None</option>${state.departments.map((d) => `<option value="${esc(d.id)}" ${d.id === p?.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Email</span><input class="input" id="pEmail" type="email" value="${esc(p?.access?.email || p?.email || '')}" ${p?.access ? 'disabled' : ''}></label>
        <label class="field"><span>Phone</span><input class="input" id="pPhone" value="${esc(p?.phone || '')}"></label>
        <label class="field"><span>Dashboard access</span><select class="select" id="pRole" ${isSelf ? 'disabled' : ''}><option value="">No dashboard access</option>${roles.map((r) => `<option value="${r.key}" ${r.key === p?.access?.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
      </div>
      <small class="faint" id="pRoleHelp"></small>
      ${isSelf ? "<small class=\"faint\">You can't change your own access. Ask another administrator.</small>" : ''}
      <div class="row">
        ${p && p.active && !isSelf ? '<button class="btn btn-danger" id="pDeactivate" style="margin-right:auto">Mark inactive</button>' : ''}
        ${p && !p.active ? '<button class="btn" id="pReactivate" style="margin-right:auto">Reactivate</button>' : ''}
        ${p?.access ? `<button class="btn" id="pLink">${icon('link')} New password link</button>` : ''}
        <button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pSave">${p ? 'Save' : 'Add person'}</button>
      </div>`);
    const help = () => {
      const r = roles.find((x) => x.key === m.querySelector('#pRole').value);
      m.querySelector('#pRoleHelp').textContent = r ? `${r.label}: ${r.description}.` : "They can be assigned requests but can't sign in.";
    };
    m.querySelector('#pRole').onchange = help;
    help();
    const done = (res, msg) => {
      m.remove();
      toast(msg);
      if (res.setupUrl) setupLinkModal(res.staff?.name || p?.name, res.setupUrl);
      renderStaff($('#page'));
    };
    m.querySelector('#pSave').onclick = async () => {
      const body = { name: m.querySelector('#pName').value, title: m.querySelector('#pTitle').value, department_id: m.querySelector('#pDept').value, phone: m.querySelector('#pPhone').value };
      if (!p?.access) body.email = m.querySelector('#pEmail').value;
      if (!isSelf) body.role = m.querySelector('#pRole').value;
      if (!body.name.trim()) { m.querySelector('#pName').focus(); return; }
      try {
        const res = p ? await api(`/staff/${p.id}`, { method: 'PATCH', body }) : await api('/staff', { method: 'POST', body });
        done(res, p ? 'Saved' : `${body.name} added`);
      } catch (e) { toast(e.message); }
    };
    m.querySelector('#pDeactivate')?.addEventListener('click', async () => {
      try { done(await api(`/staff/${p.id}`, { method: 'PATCH', body: { active: false } }), `${p.name} marked inactive`); } catch (e) { toast(e.message); }
    });
    m.querySelector('#pReactivate')?.addEventListener('click', async () => {
      try { done(await api(`/staff/${p.id}`, { method: 'PATCH', body: { active: true } }), `${p.name} reactivated`); } catch (e) { toast(e.message); }
    });
    m.querySelector('#pLink')?.addEventListener('click', async () => {
      try { const r = await api(`/staff/${p.id}/setup-link`, { method: 'POST' }); m.remove(); setupLinkModal(p.name, r.setupUrl); } catch (e) { toast(e.message); }
    });
  }

  function setupLinkModal(name, link) {
    const m = modal(`
      <h2>Send ${esc(name)} their setup link</h2>
      <p class="muted" style="margin:0">They open it to choose a password. It works once and expires in 7 days. Anyone with the link can set the password, so send it only to them.</p>
      <div class="code" style="white-space:pre-wrap;word-break:break-all;padding-right:84px"><button class="btn btn-sm copy" id="copyLink">${icon('copy')} Copy</button>${esc(link)}</div>
      <div class="row"><button class="btn btn-primary" data-close>Done</button></div>`);
    m.querySelector('#copyLink').onclick = async () => { try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { toast('Select the link and copy it'); } };
  }

  /* ---------------- Activity (audit log) ---------------- */

  const AUDIT_TYPES = [['', 'All'], ['document', 'Knowledge base'], ['request', 'Requests'], ['records_request', 'Public records'], ['license', 'Licenses'], ['staff', 'Staff & access'], ['conversation', 'Conversations'], ['settings', 'Settings'], ['city', 'City']];

  async function renderActivity(page, append = false) {
    state.auditType ??= '';
    const before = append ? state.auditEvents.at(-1)?.id : null;
    const qs = new URLSearchParams({ ...(state.auditType ? { type: state.auditType } : {}), ...(before ? { before } : {}) });
    const { events } = await api(`/audit?${qs}`);
    state.auditEvents = append ? [...state.auditEvents, ...events] : events;
    const actorPill = (e) => ({ resident: '<span class="pill">Resident</span>', ai: '<span class="pill violet">AI</span>', operator: '<span class="pill violet">Support</span>', system: '<span class="pill">System</span>' }[e.actor_type] || '');
    const changes = (c) => (c ? `<div class="faint" style="font-size:12.5px;margin-top:4px">${Object.entries(c).map(([k, [a, b]]) => `${esc(k.replace(/_/g, ' '))}: ${esc(typeof a === 'object' && a ? JSON.stringify(a) : a ?? '—')} → ${esc(typeof b === 'object' && b ? JSON.stringify(b) : b ?? '—')}`).join(' · ')}</div>` : '');
    page.innerHTML = `
      <div class="toolbar" style="margin-top:0"><div class="chips" id="aTypes">${AUDIT_TYPES.map(([v, l]) => `<button class="chip ${state.auditType === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="card"><div class="card-b"><div class="list">${state.auditEvents.length ? state.auditEvents.map((e) => `
        <div class="list-item"><div class="grow"><div class="title">${esc(e.summary)}</div>
          <div class="meta">${esc(e.actor_name)} ${actorPill(e)} · <span title="${esc(toDate(e.at).toLocaleString())}">${ago(e.at)}</span></div>${changes(e.changes)}</div></div>`).join('')
        : emptyNote('refresh', 'Nothing recorded yet.')}</div>
        ${events.length >= 100 ? '<div style="text-align:center;margin-top:12px"><button class="btn" id="aMore">Load older</button></div>' : ''}</div></div>`;
    $('#aTypes').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; state.auditType = c.dataset.v; renderActivity(page); };
    $('#aMore')?.addEventListener('click', () => renderActivity(page, true));
  }

  /* ---------------- Feature modules ---------------- */

  // Features live in their own files (public/<feature>.js), loaded after this one, and plug in through window.CHOS.
  const PAGES = [];
  const SHELL_HOOKS = [];
  const DRAWER_HOOKS = [];
  window.CHOS = {
    $, $$, api, esc, icon, pill, ago, toast, modal, openDrawer, closeDrawer, can, md, emptyNote, kpi, toDate, fmt, REQ_STATUS, openRequest, refreshBadges,
    get state() { return state; },
    get apiBase() { return API; },
    // A page in the sidebar: route is { title, sub, icon, render, perm }; group is a nav label, new or existing.
    addPage(key, route, group, badgeId) {
      ROUTES[key] = route;
      PAGES.push({ key, group, badge: badgeId });
      if (state.city) renderShell(); // registered after sign-in finished
    },
    onShell(fn) { SHELL_HOOKS.push(fn); },
    // Adds to the service request drawer: fn(drawer, request) after it opens.
    onRequestDrawer(fn) { DRAWER_HOOKS.push(fn); },
    addAuditType(value, label) { AUDIT_TYPES.push([value, label]); },
    rerender: () => route(),
    route,
    get API() { return API; },
  };

  window.addEventListener('hashchange', () => { if (!state.me && /^#\/setup\//.test(location.hash)) boot(); });
  boot();
})();
