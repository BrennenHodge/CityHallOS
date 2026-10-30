/* City Hall OS staff dashboard. Vanilla JS, no build step. */
(() => {
  const CITY = 'wiggins';
  const API = `/api/${CITY}`;
  const PUBLIC_SITE = 'https://wiggins.cityhallos.com';
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
  const CONVO_STATUS = { answered: ['Answered', 'green'], needs_review: ['Needs review', 'amber'], reviewed: ['Reviewed', 'blue'], emergency: ['Emergency', 'red'] };

  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } },
  };
  let token = store.get('chos_token');
  const state = { docs: [], cat: '', q: '', convoFilter: '', convoId: null, overview: null };

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
    const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
    let body = opts.body;
    if (body && !(body instanceof FormData) && typeof body !== 'string') { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(API + path, { ...opts, headers, body });
    if (res.status === 401) { signOut(); throw new Error('Please sign in again'); }
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
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
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

  /* ---------------- Auth ---------------- */

  function signOut() { token = null; store.del('chos_token'); renderLogin(); }

  function renderLogin(err = '') {
    app.innerHTML = `
      <div class="login">
        <div class="login-card">
          <div class="brand"><img src="/favicon.svg" alt=""><span>City Hall <span>OS</span></span></div>
          <h1>City of Wiggins staff dashboard</h1>
          <p>Manage the knowledge base behind your AI City Clerk, review resident conversations, and work service requests.</p>
          <form id="loginForm">
            <label class="field"><span>Staff access code</span><input class="input" id="code" type="password" autocomplete="current-password" required autofocus></label>
            <div class="login-error" id="loginErr">${esc(err)}</div>
            <button class="btn btn-primary" type="submit">${icon('lock')} Sign in</button>
          </form>
        </div>
      </div>`;
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#code').value.trim();
      const res = await fetch('/api/auth/check', { headers: { Authorization: `Bearer ${code}` } });
      if (!res.ok) { $('#loginErr').textContent = 'That access code is not valid.'; return; }
      token = code; store.set('chos_token', code); renderShell();
    });
  }

  /* ---------------- Shell & routing ---------------- */

  const ROUTES = {
    overview: { title: 'Overview', sub: 'How the AI City Clerk is serving Wiggins', icon: 'grid', render: renderOverview },
    knowledge: { title: 'Knowledge base', sub: 'The documents behind every answer', icon: 'brain', render: renderKnowledge },
    assistant: { title: 'Test the assistant', sub: 'Ask anything and see exactly what the AI read', icon: 'spark', render: renderAssistant },
    conversations: { title: 'Conversations', sub: 'What residents are asking', icon: 'chat', render: renderConversations },
    requests: { title: 'Service requests', sub: 'Issues reported by residents', icon: 'clipboard', render: renderRequests },
    channels: { title: 'Channels & embed', sub: 'Where residents reach the AI City Clerk', icon: 'plug', render: renderChannels },
    settings: { title: 'Settings', sub: 'Assistant and city profile', icon: 'gear', render: renderSettings },
  };

  function renderShell() {
    app.innerHTML = `
      <div class="shell">
        <aside class="side" id="side">
          <div class="brand"><img src="/favicon.svg" alt=""><span>City Hall <span>OS</span></span></div>
          <div class="city-card"><div class="city-seal">W</div><div><strong>City of Wiggins</strong><small>Stone County, Mississippi</small></div></div>
          <nav class="nav" aria-label="Dashboard">
            ${navLink('overview')}
            <div class="nav-label">Brain</div>
            ${navLink('knowledge')}${navLink('assistant')}
            <div class="nav-label">Residents</div>
            ${navLink('conversations', 'navReview')}${navLink('requests', 'navReq')}
            <div class="nav-label">Setup</div>
            ${navLink('channels')}${navLink('settings')}
          </nav>
          <div class="side-foot">
            <div class="model-chip">${icon('spark')}<span>AI model<br><code id="modelName">loading…</code></span></div>
            <a href="${PUBLIC_SITE}" target="_blank" rel="noopener">${icon('globe')} View wiggins.cityhallos.com</a>
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
    $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
    $('#scrim').onclick = closeDrawer;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    window.onhashchange = route;
    route();
    refreshBadges();
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
    } catch { /* shown on the page itself */ }
  }

  function route() {
    const key = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'overview';
    const r = ROUTES[key] || ROUTES.overview;
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === key));
    $('#side').classList.remove('open');
    $('#pageTitle').textContent = r.title;
    $('#pageSub').textContent = r.sub;
    $('#pageActions').innerHTML = '';
    closeDrawer();
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
      const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
      days.push({ d, n: (o.byDay.find((x) => x.day === d) || {}).n || 0 });
    }
    const maxDay = Math.max(1, ...days.map((x) => x.n));
    const maxCat = Math.max(1, ...k.categories.map((c) => c.n));
    const hour = new Date().getHours();
    $('#pageActions').innerHTML = `<a class="btn" href="${PUBLIC_SITE}" target="_blank" rel="noopener">${icon('external')} Public site</a>`;
    page.innerHTML = `
      <section class="welcome">
        <div>
          <h2>Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, Wiggins</h2>
          <p>Your AI City Clerk answers residents around the clock from ${fmt(k.n)} city documents.</p>
          <div class="live"><span class="live-dot"></span> Live on wiggins.cityhallos.com</div>
        </div>
        <div class="actions">
          <a class="btn btn-primary" href="#/knowledge">${icon('upload')} Add documents</a>
          <a class="btn" href="#/assistant">${icon('spark')} Test the assistant</a>
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
      const d = e.target.closest('[data-doc]'); if (d) { location.hash = '#/knowledge'; setTimeout(() => openDocument(d.dataset.doc), 300); }
    };
  }
  const kpi = (ic, label, value, hint) => `<div class="card kpi"><div class="label">${icon(ic)}${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
  const emptyNote = (ic, text) => `<div class="empty">${icon(ic)}<div>${text}</div></div>`;

  /* ---------------- Knowledge base ---------------- */

  async function renderKnowledge(page) {
    const upload = { category: 'auto', visibility: 'public', as_of: '' };
    page.innerHTML = `
      <section class="drop" id="drop">
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
      <div class="toolbar">
        <div class="search">${icon('search')}<input class="input" id="docSearch" placeholder="Search documents" value="${esc(state.q)}"></div>
        <div class="chips" id="catChips"></div>
      </div>
      <div class="card" style="overflow:hidden"><table class="table">
        <thead><tr><th>Document</th><th class="hide-sm">Category</th><th class="hide-sm">Status of source</th><th class="hide-sm">Date</th><th class="num">Passages</th><th>Status</th></tr></thead>
        <tbody id="docRows"></tbody></table></div>`;

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
    $('#docSearch').oninput = (e) => { state.q = e.target.value; drawDocs(); };
    $('#catChips').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; state.cat = c.dataset.cat; drawDocs(); };
    $('#docRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openDocument(tr.dataset.id); };
    await loadDocs();
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
      <label class="field"><span>URL</span><input class="input" id="mUrl" type="url" placeholder="https://www.cityofwiggins.gov/..." required></label>
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
          if (convoId) await api(`/conversations/${convoId}`, { method: 'PATCH', body: { status: 'reviewed' } });
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
        <button class="btn btn-danger" id="dDel">${icon('trash')} Delete</button>
        ${doc.file_name ? `<button class="btn" id="dReidx">${icon('refresh')} Re-index</button>` : ''}
        <div class="right">
          ${doc.source_url ? `<a class="btn" href="${esc(doc.source_url)}" target="_blank" rel="noopener">${icon('external')} Original</a>` : doc.file_name ? `<button class="btn" id="dFile">${icon('external')} Open file</button>` : ''}
          <button class="btn btn-primary" id="dSave">Save changes</button>
        </div>
      </div>`;
    d.querySelector('.close').onclick = closeDrawer;
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
    d.querySelector('#dReidx')?.addEventListener('click', async (e) => {
      e.target.closest('button').disabled = true;
      try { const r = await api(`/documents/${id}/reprocess`, { method: 'POST' }); toast(r.document.status === 'ready' ? 'Re-indexed' : r.document.error); openDocument(id); loadDocs(); } catch (err) { toast(err.message); }
    });
    d.querySelector('#dFile')?.addEventListener('click', async () => {
      const res = await fetch(fileUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { toast('Could not open file'); return; }
      window.open(URL.createObjectURL(await res.blob()), '_blank');
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
      </div>`).join('') : emptyNote('chat', 'No conversations here yet. Try the chatbot on wiggins.cityhallos.com.');
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
          <button class="btn btn-sm" id="cTeach">${icon('pen')} Answer &amp; teach the AI</button>
          ${c.status !== 'reviewed' ? `<button class="btn btn-sm btn-dark" id="cDone">${icon('check')} Mark reviewed</button>` : ''}
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
    view.querySelector('#cTeach').onclick = async () => {
      const lastQ = [...messages].reverse().find((m) => m.role === 'user');
      if (await noteModal({ question: lastQ?.content || c.first_question, convoId: id })) renderConversations($('#page'));
    };
  }

  /* ---------------- Service requests ---------------- */

  async function renderRequests(page) {
    const [{ requests }, settings] = await Promise.all([api('/requests'), state.staff ? null : api('/settings')]);
    if (settings) state.staff = settings.staff || [];
    $('#pageActions').innerHTML = `<button class="btn btn-primary" id="rNew">${icon('plus')} Log a request</button>`;
    $('#rNew').onclick = newRequestModal;
    const lanes = [['new', 'New'], ['needs_info', 'Needs information'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['awaiting_review', 'Awaiting review'], ['resolved', 'Resolved']];
    page.innerHTML = `<div class="board">${lanes.map(([key, label]) => {
      const items = requests.filter((r) => (key === 'resolved' ? ['resolved', 'closed'].includes(r.status) : r.status === key));
      return `<div class="lane"><div class="lane-h">${pill(REQ_STATUS, key)}<span class="count">${items.length}</span></div>
        <div class="lane-cards">${items.map((r) => `
          <div class="rcard" data-id="${r.id}">
            <div class="top"><span class="ref">${esc(r.ref)}</span>${r.priority !== 'normal' ? `<span class="pill ${r.priority === 'low' ? '' : 'red'}">${esc(r.priority)}</span>` : ''}${r.photo ? `<span class="pill">Photo</span>` : ''}${r.sample ? '<span class="pill">Sample</span>' : ''}${r.convo_id ? '<span class="pill blue">AI intake</span>' : ''}</div>
            <strong>${esc(r.category)}</strong>
            ${r.location ? `<p>${esc(r.location)}</p>` : ''}
            <div class="foot"><span>${esc(r.department)}</span><span>·</span><span>${ago(r.created_at)}</span>${r.assignee ? `<span>· ${esc(r.assignee)}</span>` : ''}</div>
          </div>`).join('') || '<div class="faint" style="padding:8px 6px;font-size:12.5px">Nothing here.</div>'}</div></div>`;
    }).join('')}</div>`;
    page.onclick = (e) => { const c = e.target.closest('.rcard'); if (c) openRequest(requests.find((r) => r.id === Number(c.dataset.id))); };
    if (state.reqId) { const r = requests.find((x) => x.id === state.reqId); state.reqId = null; if (r) openRequest(r); }
  }

  function openRequest(r) {
    const d = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(r.ref)}</div><h2>${esc(r.category)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px">${pill(REQ_STATUS, r.status)}<span class="pill">${esc(r.department)}</span><span class="pill">Reported ${ago(r.created_at)}</span></div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        ${r.summary ? `<div class="card card-b" style="background:var(--blue-soft);border-color:var(--blue-line)"><div class="section-title">Summary</div><p style="margin:6px 0 0">${esc(r.summary)}</p></div>` : ''}
        <div class="card card-b"><div class="section-title">Resident's description</div><p style="margin:6px 0 0;white-space:pre-wrap">${esc(r.description)}</p>
          ${r.location ? `<p style="margin:10px 0 0"><b>Location:</b> ${esc(r.location)} · <a href="https://www.google.com/maps/search/${encodeURIComponent(r.location + (/wiggins/i.test(r.location) ? '' : ', Wiggins, MS'))}" target="_blank" rel="noopener">Map</a></p>` : ''}
          ${r.name || r.contact ? `<p style="margin:6px 0 0"><b>Contact:</b> ${esc([r.name, r.contact].filter(Boolean).join(' · '))}</p>` : ''}
          ${r.convo_id ? `<p style="margin:6px 0 0"><a href="#/conversations" data-convo="${esc(r.convo_id)}">View the chat conversation</a></p>` : ''}</div>
        ${r.photo ? '<img class="photo" id="rPhoto" alt="Photo from resident">' : ''}
        <div class="field"><span>Move to</span><div class="status-steps">${Object.entries(REQ_STATUS).map(([k, [l]]) => `<button class="btn btn-sm ${k === r.status ? 'btn-dark' : ''}" data-status="${k}">${l}</button>`).join('')}</div></div>
        <div class="grid-2">
          <label class="field"><span>Assigned to</span><select class="select" id="rAssignee"><option value="">Unassigned</option>${(state.staff || []).map((p) => `<option value="${esc(p.name)}" ${p.name === r.assignee ? 'selected' : ''}>${esc(p.name)} · ${esc(p.department)}</option>`).join('')}${r.assignee && !(state.staff || []).some((p) => p.name === r.assignee) ? `<option selected>${esc(r.assignee)}</option>` : ''}</select></label>
          <label class="field"><span>Priority</span><select class="select" id="rPriority">${['low', 'normal', 'high', 'urgent'].map((p) => `<option ${p === r.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Add a note</span><textarea class="textarea" id="rNote" rows="2" placeholder="Visible to staff in the history"></textarea></label>
        <div class="section-title">History</div>
        <div class="timeline">${r.history.slice().reverse().map((h) => `<div class="tl"><i></i><div><b>${esc(h.note || (REQ_STATUS[h.status] || [h.status])[0])}</b><small>${esc(h.by)} · ${new Date(h.at).toLocaleString()}</small></div></div>`).join('')}</div>
      </div>
      <div class="drawer-f"><div class="right"><button class="btn btn-primary" id="rSave">Save</button></div></div>`);
    let status = r.status;
    d.querySelector('.status-steps').onclick = (e) => {
      const b = e.target.closest('[data-status]'); if (!b) return;
      status = b.dataset.status; $$('[data-status]', d).forEach((x) => x.classList.toggle('btn-dark', x === b));
    };
    d.querySelector('[data-convo]')?.addEventListener('click', (e) => { state.convoId = e.target.dataset.convo; });
    if (r.photo) {
      fetch(`${API}/requests/${r.id}/photo`, { headers: { Authorization: `Bearer ${token}` } }).then((res) => res.blob()).then((b) => { $('#rPhoto').src = URL.createObjectURL(b); });
    }
    d.querySelector('#rSave').onclick = async () => {
      try {
        const { request } = await api(`/requests/${r.id}`, { method: 'PATCH', body: { status, assignee: $('#rAssignee').value, priority: $('#rPriority').value, note: $('#rNote').value } });
        toast(`${request.ref} updated`); refreshBadges(); await renderRequests($('#page')); openRequest(request);
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

  /* ---------------- Channels ---------------- */

  async function renderChannels(page) {
    const snippet = `<script src="${EMBED_SRC}" data-city="${CITY}" async></script>`;
    page.innerHTML = `
      <div class="stack" style="max-width:980px">
        <div class="card card-b"><div class="channel">
          <div class="channel-icon">${icon('chat')}</div>
          <div><h3>Website chat <span class="pill green" style="margin-left:6px"><span class="live-dot"></span>Live</span></h3>
            <p>Paste this one line before <code>&lt;/body&gt;</code> on any website: CivicPlus, Granicus, WordPress, Wix or a custom site. The chat bubble appears in the corner and answers from this knowledge base.</p>
            <div class="code" style="margin-top:12px"><button class="btn btn-sm copy" id="copySnippet">${icon('copy')} Copy</button>${esc(snippet)}</div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
              <a class="btn" href="${PUBLIC_SITE}" target="_blank" rel="noopener">${icon('external')} See it on wiggins.cityhallos.com</a>
              <button class="btn" id="previewHere">${icon('spark')} Preview it on this page</button>
            </div></div>
          <span></span></div></div>
        <div class="card card-b"><div class="channel">
          <div class="channel-icon" style="background:var(--violet-soft);color:var(--violet)">${icon('phone')}</div>
          <div><h3>Voice agent <span class="pill amber" style="margin-left:6px">Ready to connect</span></h3>
            <p>The phone agent uses this same knowledge base and the same rules: it answers from city documents, files requests and transfers to staff. Connect a City Hall phone number to turn it on.</p>
            <div class="code" style="margin-top:12px">POST ${location.origin}/api/${CITY}/chat
{ "message": "What time does City Hall close?", "channel": "voice" }</div></div><span></span></div></div>
        <div class="cols cols-2">
          <div class="card card-b"><div class="channel" style="grid-template-columns:48px 1fr">
            <div class="channel-icon" style="background:var(--green-soft);color:var(--green)">${icon('sms')}</div>
            <div><h3>Text messages <span class="pill amber" style="margin-left:6px">Ready to connect</span></h3><p>Residents text questions and report issues by SMS. Same knowledge base, same conversation log. Send messages to the chat API with <code>"channel": "sms"</code>.</p></div></div></div>
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
GET  /api/${CITY}/track/WIG-1001    check a request's status
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
          <label class="field"><span>Other current facts</span><textarea class="textarea" name="profileNotes" rows="4" placeholder="e.g. The Board of Aldermen meets the first and third Tuesday of each month at 6 pm at City Hall.">${esc(s.profileNotes || '')}</textarea></label>
        </div></div>
        <div><button class="btn btn-primary" type="submit">${icon('check')} Save settings</button></div>
      </form>`;
    const f = $('#sForm');
    f.brandColor.oninput = () => { $('#colorText').value = f.brandColor.value; };
    $('#colorText').oninput = (e) => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) f.brandColor.value = e.target.value; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f).entries());
      body.suggestions = body.suggestions.split('\n').map((x) => x.trim()).filter(Boolean);
      try { await api('/settings', { method: 'PUT', body }); toast('Settings saved. The chatbot updates within a minute.'); } catch (err) { toast(err.message); }
    };
  }

  if (token) {
    fetch('/api/auth/check', { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? renderShell() : signOut())).catch(() => renderShell());
  } else {
    renderLogin();
  }
})();
