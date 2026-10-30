/* Public meetings page: /{city}/meetings. Shows published agendas and approved minutes only. */
(() => {
  const slug = (location.pathname.match(/^\/([a-z0-9-]+)\/meetings/) || [])[1] || new URLSearchParams(location.search).get('city');
  const API = `/api/${slug}/meetings/public`;
  const KINDS = { regular: 'Regular meeting', special: 'Special meeting', work_session: 'Work session' };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const wall = (s) => new Date(`${s.slice(0, 10)}T${s.slice(11, 16) || '00:00'}:00`);
  const when = (s) => wall(s).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  let data = null;
  let board = '';
  const loaded = new Map();

  // Markdown from the agenda and minutes: headings, paragraphs, bullets, bold and links.
  function doc(text) {
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(((?:https?:\/\/|\/)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const out = [];
    let list = false;
    for (const raw of String(text || '').split('\n')) {
      const line = raw.trim();
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const li = line.match(/^[-*]\s+(.*)/);
      if (list && !li) { out.push('</ul>'); list = false; }
      if (h) out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      else if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); }
      else if (line) out.push(`<p>${inline(line)}</p>`);
    }
    if (list) out.push('</ul>');
    return `<div class="doc">${out.join('')}</div>`;
  }

  function row(m) {
    const d = wall(m.starts_at);
    const tags = [
      m.status === 'cancelled' ? '<span class="tag no">Cancelled</span>' : m.status === 'postponed' ? '<span class="tag no">Postponed</span>' : '',
      m.has_agenda ? '<span class="tag ok">Agenda</span>' : '',
      m.has_minutes ? '<span class="tag ok">Minutes</span>' : '',
    ].join('');
    return `<div class="m" id="${m.id}"><button aria-expanded="false" data-id="${m.id}">
      <div class="d"><b>${d.getDate()}</b><small>${d.toLocaleDateString('en-US', { month: 'short' })}</small></div>
      <div><div class="t">${esc(m.title || m.board)}</div><div class="s">${esc(KINDS[m.kind])} · ${esc(when(m.starts_at))}${m.location ? ` · ${esc(m.location)}` : ''}</div></div>
      <div class="tags">${tags}</div></button><div class="body"></div></div>`;
  }

  async function open(id, scroll) {
    const el = document.getElementById(id);
    if (!el) return;
    const btn = el.querySelector('button');
    const isOpen = el.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(isOpen));
    if (!isOpen) return;
    const body = el.querySelector('.body');
    if (!loaded.has(id)) {
      body.innerHTML = '<p class="note">Loading…</p>';
      const res = await fetch(`${API}/${id}`);
      loaded.set(id, res.ok ? (await res.json()).meeting : null);
    }
    const m = loaded.get(id);
    if (!m) { body.innerHTML = '<p class="note">This meeting is not available.</p>'; return; }
    const parts = [m.minutes_approved && ['minutes', 'Minutes'], m.agenda_published && ['agenda', 'Agenda']].filter(Boolean);
    const show = (k) => {
      body.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      body.querySelector('.view').innerHTML = k === 'minutes'
        ? `${doc(m.minutes_approved)}<p class="note">Approved ${esc(new Date(m.minutes_approved_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))}.</p>`
        : `${doc(m.agenda_published)}<p class="note">Agenda posted ${esc(new Date(m.agenda_published_at).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }))}.</p>`;
    };
    if (!parts.length) {
      body.innerHTML = `${m.purpose ? `<p><b>Purpose:</b> ${esc(m.purpose)}</p>` : ''}<p class="note">${m.status === 'cancelled' ? 'This meeting was cancelled.' : 'The agenda will be posted here before the meeting.'}</p>`;
    } else {
      body.innerHTML = `${parts.length > 1 ? `<div class="tabs">${parts.map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>` : ''}<div class="view"></div>`;
      body.querySelector('.tabs')?.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.k); });
      show(parts[0][0]);
    }
    if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function draw() {
    const ms = data.meetings.filter((m) => !board || m.board_id === board);
    const today = data.now.slice(0, 10);
    const upcoming = ms.filter((m) => m.starts_at.slice(0, 10) >= today).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const past = ms.filter((m) => m.starts_at.slice(0, 10) < today);
    $('#list').innerHTML = `
      <h2>Upcoming</h2>${upcoming.length ? upcoming.map(row).join('') : '<div class="empty">No upcoming meetings are scheduled yet.</div>'}
      <h2>Past meetings</h2>${past.length ? past.map(row).join('') : '<div class="empty">Approved minutes will appear here.</div>'}`;
  }

  async function boot() {
    if (!slug) { $('#list').innerHTML = '<div class="empty">Choose a city.</div>'; return; }
    const res = await fetch(API);
    if (!res.ok) { $('#list').innerHTML = '<div class="empty">This city was not found.</div>'; return; }
    data = await res.json();
    const c = data.city;
    document.title = `Public meetings | ${c.name}`;
    document.documentElement.style.setProperty('--brand', c.brandColor || '#1f5c46');
    $('#cityName').innerHTML = `${esc(c.name)}<br>${esc(c.state)}`;
    $('#lead').textContent = `Meetings of the ${c.shortName} ${data.boards.map((b) => b.name).join(', ') || 'city boards'}: agendas for upcoming meetings and approved minutes of past meetings. Meetings are open to the public.`;
    if (data.boards.length > 1) {
      $('#filters').innerHTML = `<button class="on" data-b="">All boards</button>${data.boards.map((b) => `<button data-b="${b.id}">${esc(b.name)}</button>`).join('')}`;
      $('#filters').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; board = b.dataset.b; $('#filters').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); draw(); };
    }
    const sched = data.boards.filter((b) => b.schedule).map((b) => `<b>${esc(b.name)}</b>: ${esc(b.schedule)}${b.location ? `, ${esc(b.location)}` : ''}`);
    $('#ask').hidden = false;
    $('#ask').innerHTML = `${sched.length ? `<p style="margin:0 0 8px">${sched.join('<br>')}</p>` : ''}<p style="margin:0">Questions about a decision? <a href="${esc(c.publicSite || `/${c.slug}`)}">Ask ${esc(c.assistantName || 'the AI City Clerk')}</a>, which answers from these minutes with citations${c.phone ? `, or call City Hall at <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}.</p>`;
    draw();
    $('#list').onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) { history.replaceState(null, '', `#${b.dataset.id}`); open(b.dataset.id); } };
    const hash = location.hash.slice(1);
    if (hash) open(hash, true);
  }
  boot();
})();
