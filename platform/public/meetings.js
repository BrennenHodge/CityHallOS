/* City Hall OS staff dashboard: the Meeting secretary. Loaded after dashboard.js and plugged in through window.CHOS.
   Pages: #/meetings (list), #/meetings/<id> (one meeting), #/meetings/actions, #/meetings/boards, #/meetings/rules. */
(() => {
  const C = () => window.CHOS;
  const KINDS = { regular: 'Regular', special: 'Special', work_session: 'Work session', community: 'Town hall' };
  const ITEM_TYPES = { consent: ['Consent', ''], action: ['Action', 'blue'], discussion: ['Discussion', 'violet'], public_hearing: ['Public hearing', 'amber'], report: ['Report', ''] };
  const AGENDA = { draft: ['Agenda: draft', ''], ready: ['Agenda: awaiting approval', 'amber'], published: ['Agenda: published', 'green'] };
  const MINUTES = { none: ['No minutes yet', ''], draft: ['Minutes: draft', 'amber'], approved: ['Minutes: approved', 'green'] };
  const STATUS = { scheduled: ['Scheduled', 'blue'], held: ['Held', ''], cancelled: ['Cancelled', 'red'], postponed: ['Postponed', 'amber'] };
  const ITEM_STATUS = { submitted: ['Submitted', 'amber'], accepted: ['On the agenda', 'green'], returned: ['Returned', 'red'], withdrawn: ['Withdrawn', ''] };
  const ACTION_STATUS = { open: ['Open', 'blue'], in_progress: ['In progress', 'amber'], done: ['Done', 'green'], cancelled: ['Cancelled', ''] };
  const ROLES = { presiding: 'Presiding officer (mayor or chair)', vice: 'Vice chair / mayor pro tem', member: 'Member', clerk: 'Clerk', attorney: 'Attorney', staff: 'Staff' };
  const BOARD_KINDS = { board: 'Board', council: 'Council', commission: 'Commission', committee: 'Committee', authority: 'Authority', other: 'Other' };
  const WAV_SECONDS = 120; // browser-prepared segments: two minutes of 16 kHz mono audio, about 3.8 MB each

  const local = { boards: null, staff: null, departments: null, tab: 'upcoming', actionFilter: 'open', pendingFile: null };

  const wallDate = (s) => new Date(`${s.slice(0, 10)}T${s.slice(11, 16) || '00:00'}:00`);
  const fmtWhen = (s) => wallDate(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtDay = (s) => wallDate(s).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const warnHtml = (ws) => (ws || []).map((w) => `<div class="mt-warn ${w.level}">${C().icon(w.level === 'info' ? 'clipboard' : 'alert')}<span>${C().esc(w.text)}</span></div>`).join('');
  const tabs = [['upcoming', 'Upcoming'], ['past', 'Past'], ['actions', 'Action items'], ['boards', 'Boards & members'], ['rules', 'Notice rules']];
  const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : n ? `${n} B` : '');
  const publicUrl = (id) => `${location.origin}/${C().state.city.slug}/meetings${id ? `#${id}` : ''}`;

  // Headings, then everything else through the dashboard's own markdown.
  function doc(text) {
    const { esc, md } = C();
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) out.push(md(buf.join('\n'))); buf = []; };
    for (const line of String(text || '').split('\n')) {
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { flush(); out.push(`<h${Math.min(h[1].length + 2, 5)}>${esc(h[2])}</h${Math.min(h[1].length + 2, 5)}>`); } else buf.push(line);
    }
    flush();
    return `<div class="mt-doc">${out.join('')}</div>`;
  }

  async function lookups() {
    const { api } = C();
    const [b, s, d] = await Promise.all([api('/meetings/boards'), local.staff ? null : api('/staff').catch(() => ({ staff: [] })), local.departments ? null : api('/departments')]);
    local.boards = b.boards;
    if (s) local.staff = s.staff.filter((p) => p.active);
    if (d) local.departments = d.departments.filter((x) => x.active);
  }

  /* ---------------- Router ---------------- */

  async function render(page) {
    injectStyle();
    const sub = (location.hash.match(/^#\/meetings\/([\w-]+)/) || [])[1];
    await lookups();
    if (sub && /^m[a-f0-9]{12}$/.test(sub)) return renderMeeting(page, sub);
    if (sub && tabs.some(([k]) => k === sub)) local.tab = sub;
    return renderList(page);
  }

  function tabBar() {
    return `<div class="toolbar" style="margin-top:0"><div class="chips">${tabs.map(([k, l]) => `<a class="chip ${local.tab === k ? 'on' : ''}" href="#/meetings/${k}">${l}</a>`).join('')}</div>
      <a class="btn btn-sm btn-ghost" href="${publicUrl()}" target="_blank" rel="noopener" style="margin-left:auto">${C().icon('external')} Public meetings page</a></div>`;
  }

  async function renderList(page) {
    const { api, can, esc, icon, pill, emptyNote, $ } = C();
    if (local.tab === 'actions') return renderActions(page);
    if (local.tab === 'boards') return renderBoards(page);
    if (local.tab === 'rules') return renderRules(page);
    if (can('meetings.manage')) {
      $('#pageActions').innerHTML = `<button class="btn btn-primary" id="mtNew">${icon('plus')} Schedule a meeting</button>`;
      $('#mtNew').onclick = () => meetingModal();
    }
    const { meetings } = await api(`/meetings?when=${local.tab}`);
    const noBoards = !local.boards.length;
    page.innerHTML = `${tabBar()}
      ${noBoards ? `<div class="card card-b">${emptyNote('users', `Add the city's boards first: the governing board (for example the Board of Aldermen or City Council), the planning commission and any others.${can('meetings.manage') ? ' <a href="#/meetings/boards">Add a board</a>' : ''}`)}</div>` : ''}
      <div class="stack">${meetings.length ? meetings.map((m) => `
        <a class="card mt-row" href="#/meetings/${m.id}">
          <div class="mt-date"><b>${wallDate(m.starts_at).getDate()}</b><small>${wallDate(m.starts_at).toLocaleDateString(undefined, { month: 'short' })}</small></div>
          <div class="grow">
            <div class="title">${esc(m.title || `${m.board}`)} <span class="faint">· ${esc(KINDS[m.kind])} meeting</span></div>
            <div class="meta">${esc(fmtWhen(m.starts_at))}${m.location ? ` · ${esc(m.location)}` : ''}</div>
            <div class="mt-pills">${m.external ? `<span class="pill violet">Another government</span>` : ''}${m.historical ? '<span class="pill">Past meeting, added later</span>' : m.status !== 'scheduled' ? pill(STATUS, m.status) : ''}
              ${m.record_source ? `<span class="pill blue">Notes: ${esc(m.record_source)}</span>` : ''}
              ${m.historical && !m.items ? '' : `${pill(AGENDA, m.agenda_status)}${m.agenda_late ? '<span class="pill red">Published late</span>' : ''}<span class="pill">${m.items} ${m.items === 1 ? 'item' : 'items'}</span>`}
              ${m.minutes_status !== 'none' || (local.tab === 'past' && !m.external) ? pill(MINUTES, m.minutes_status) : ''}
              ${m.open_actions ? `<span class="pill violet">${m.open_actions} open action ${m.open_actions === 1 ? 'item' : 'items'}</span>` : ''}</div>
            ${warnHtml(m.warnings.filter((w) => w.level !== 'info' || m.submitted))}
          </div></a>`).join('') : noBoards ? '' : `<div class="card card-b">${emptyNote('calendar', local.tab === 'past' ? 'No past meetings yet.' : 'No upcoming meetings scheduled.')}</div>`}</div>`;
  }

  function meetingModal(m = null) {
    const { modal, esc, api, toast } = C();
    const boards = local.boards.filter((b) => b.active || b.id === m?.board_id);
    if (!boards.length) { location.hash = '#/meetings/boards'; toast('Add a board first'); return; }
    const md = modal(`
      <h2>${m ? 'Edit meeting' : 'Schedule a meeting'}</h2>
      <div class="grid-2">
        <label class="field"><span>Board</span><select class="select" id="mfBoard">${boards.map((b) => `<option value="${b.id}" ${b.id === m?.board_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Type</span><select class="select" id="mfKind">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${k === m?.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Date and time</span><input class="input" id="mfWhen" type="datetime-local" value="${esc(m?.starts_at || '')}" required></label>
        <label class="field"><span>Place</span><input class="input" id="mfLoc" value="${esc(m?.location || '')}" placeholder="Defaults to the board's usual place"></label>
      </div>
      <label class="field"><span>Title (optional)</span><input class="input" id="mfTitle" value="${esc(m?.title || '')}" placeholder="e.g. Budget hearing"></label>
      <label class="field" id="mfPurposeWrap"><span>Purpose / subject matter</span><textarea class="textarea" id="mfPurpose" rows="2" placeholder="Required for special meetings: what the meeting was called to consider">${esc(m?.purpose || '')}</textarea>
        <small>Mississippi law requires the notice of a called special meeting to state its subject matter (Miss. Code Ann. § 25-41-13).</small></label>
      <div class="grid-2" id="mfSpecial">
        <label class="field"><span>Meeting was called at</span><input class="input" id="mfCalled" type="datetime-local" value="${esc(m?.called_local || '')}"><small>Leave blank to use the time you save this.</small></label>
        <label class="field"><span>Notice posted at City Hall at</span><input class="input" id="mfPosted" type="datetime-local" value="${esc(m?.posted_local || '')}"><small>When the paper notice went up. Publishing the agenda here records the online posting.</small></label>
      </div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="mfSave">${m ? 'Save' : 'Schedule'}</button></div>`);
    const sync = () => { const sp = md.querySelector('#mfKind').value !== 'regular'; md.querySelector('#mfSpecial').hidden = !sp; };
    md.querySelector('#mfKind').onchange = sync; sync();
    md.querySelector('#mfSave').onclick = async () => {
      const body = { board_id: md.querySelector('#mfBoard').value, kind: md.querySelector('#mfKind').value, starts_at: md.querySelector('#mfWhen').value.slice(0, 16),
        location: md.querySelector('#mfLoc').value, title: md.querySelector('#mfTitle').value, purpose: md.querySelector('#mfPurpose').value };
      if (!body.starts_at) { md.querySelector('#mfWhen').focus(); return; }
      if (body.kind !== 'regular') {
        if (md.querySelector('#mfCalled').value) body.called_at = md.querySelector('#mfCalled').value.slice(0, 16);
        if (md.querySelector('#mfPosted').value || m) body.notice_posted_at = md.querySelector('#mfPosted').value.slice(0, 16) || null;
      }
      try {
        const r = m ? await api(`/meetings/${m.id}`, { method: 'PATCH', body }) : await api('/meetings', { method: 'POST', body });
        md.remove(); toast(m ? 'Saved' : 'Meeting scheduled');
        if (m) renderMeeting(C().$('#page'), m.id); else location.hash = `#/meetings/${r.meeting.id}`;
      } catch (e) { toast(e.message); }
    };
  }

  /* ---------------- One meeting ---------------- */

  // UTC timestamp to the browser's local "YYYY-MM-DDTHH:MM" for datetime-local inputs.
  const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

  async function renderMeeting(page, id) {
    const { api, can, esc, icon, pill, $, ago } = C();
    const data = await api(`/meetings/${id}`);
    const m = data.meeting;
    local.current = data;
    $('#pageTitle').textContent = m.title || m.board;
    $('#pageSub').textContent = `${KINDS[m.kind]} meeting · ${fmtDay(m.starts_at)}`;
    $('#pageActions').innerHTML = `<a class="btn" href="#/meetings/${data.now > m.starts_at ? 'past' : 'upcoming'}">All meetings</a>
      ${can('meetings.manage') ? `<button class="btn" id="mtEdit">${icon('pen')} Edit</button>` : ''}`;
    $('#mtEdit')?.addEventListener('click', () => meetingModal({ ...m, called_local: toLocalInput(m.called_at), posted_local: toLocalInput(m.notice_posted_at) }));
    const started = data.now >= m.starts_at;
    page.innerHTML = `
      <section class="card card-b mt-head">
        <div class="mt-date big"><b>${wallDate(m.starts_at).getDate()}</b><small>${wallDate(m.starts_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</small></div>
        <div class="grow">
          <h2>${esc(m.board)}${m.title ? `: ${esc(m.title)}` : ''}</h2>
          <div class="muted">${esc(fmtWhen(m.starts_at))}${m.location ? ` · ${esc(m.location)}` : ''}</div>
          ${m.purpose ? `<div style="margin-top:6px"><b>Purpose:</b> ${esc(m.purpose)}</div>` : ''}
          <div class="mt-pills">${pill(STATUS, m.status)}<span class="pill">${esc(KINDS[m.kind])}</span>${pill(AGENDA, m.agenda_status)}${pill(MINUTES, m.minutes_status)}</div>
        </div>
        ${m.historical || m.external ? `<div class="mt-note" style="flex-basis:100%;margin:0;background:var(--paper-2);color:var(--muted)">${icon('calendar')}<span>${m.external ? `The ${esc(m.board)} is another government's body. It is listed for residents' information; the city doesn't keep its agendas or minutes.` : 'A past meeting added after the fact, so there are no notice or minutes deadlines.'}</span></div>` : `<div class="facts mt-facts">
          <div class="fact"><small>Agenda due</small><b>${esc(fmtWhen(data.deadlines.agendaBy))}</b><small>${data.deadlines.agendaHours} ${data.deadlines.agendaHours === 1 ? 'hour' : 'hours'} before</small></div>
          <div class="fact"><small>Minutes due</small><b>${esc(wallDate(data.deadlines.minutesBy).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</b><small>${data.rules.minutesDays} days after</small></div>
        </div>`}
        ${can('meetings.manage') && m.status === 'scheduled' ? `<div class="mt-status">${started ? `<button class="btn btn-sm btn-dark" data-st="held">${icon('check')} Mark held</button>` : ''}
          <button class="btn btn-sm" data-st="postponed">Postpone</button><button class="btn btn-sm btn-danger" data-st="cancelled">Cancel meeting</button></div>`
          : can('meetings.manage') && m.status !== 'scheduled' ? `<div class="mt-status"><button class="btn btn-sm" data-st="scheduled">Set back to scheduled</button></div>` : ''}
      </section>
      ${data.warnings.length ? `<div class="stack" style="gap:8px;margin-top:14px">${warnHtml(data.warnings)}</div>` : ''}
      <div class="cols cols-21" style="margin-top:16px">
        <div class="stack">
          ${m.record_text ? '<div class="card" id="mtRecord"></div>' : ''}
          <div class="card" id="mtAgenda"></div>
          <div class="card" id="mtMinutes"></div>
        </div>
        <div class="stack">
          <div class="card" id="mtActions"></div>
          <div class="card"><div class="card-h"><h2>History</h2></div><div class="card-b" id="mtHistory"><div class="spin"></div></div></div>
        </div>
      </div>`;
    page.querySelectorAll('[data-st]').forEach((b) => b.addEventListener('click', async () => {
      const st = b.dataset.st;
      if (st === 'cancelled' && !b.dataset.confirm) { b.dataset.confirm = '1'; b.textContent = 'Click again to cancel'; return; }
      try { await api(`/meetings/${id}`, { method: 'PATCH', body: { status: st } }); C().toast('Saved'); renderMeeting(page, id); } catch (e) { C().toast(e.message); }
    }));
    if (m.record_text) drawRecord(data);
    drawAgenda(data);
    drawMinutes(data);
    drawActions(data);
    api(`/meetings/${id}/history`).then(({ events }) => {
      $('#mtHistory').innerHTML = events.length ? `<div class="list">${events.slice(0, 40).map((e) => `<div class="list-item"><div class="grow"><div class="title" style="font-weight:500">${esc(e.summary)}</div><div class="meta">${esc(e.actor_name)} · ${ago(e.at)}</div></div></div>`).join('')}</div>` : '<div class="faint">Nothing yet.</div>';
    }).catch(() => {});
  }

  const reload = () => renderMeeting(C().$('#page'), local.current.meeting.id);

  /* ---------------- Record from another source ---------------- */

  // A news recap or other account of the meeting. Residents see it labeled with its source; it is not the minutes.
  function drawRecord(data) {
    const { $, esc, icon, can, api, toast } = C();
    const m = data.meeting;
    $('#mtRecord').innerHTML = `
      <div class="card-h"><h2>Meeting notes</h2><span class="pill blue">${esc(m.record_source)}</span>
        ${m.record_url ? `<a class="btn btn-sm btn-ghost" style="margin-left:auto" href="${esc(m.record_url)}" target="_blank" rel="noopener">${icon('external')} Original</a>` : ''}</div>
      <div class="card-b">
        <div class="mt-warn info" style="margin:0 0 10px">${icon('alert')}<span>An account of the meeting by ${esc(m.record_source)}, not the official minutes. Residents see it labeled that way, and the AI City Clerk cites it as a news report.</span></div>
        <details><summary class="section-title" style="cursor:pointer">Read the notes (${(m.record_text.split(/\s+/).length).toLocaleString()} words)</summary><div class="mt-preview" style="margin-top:8px">${doc(m.record_text)}</div></details>
        ${can('meetings.manage') && m.minutes_status !== 'approved' && !m.external ? '<button class="btn btn-sm" id="recNotes" style="margin-top:10px">Use as notes for drafting minutes</button>' : ''}
      </div>`;
    $('#recNotes')?.addEventListener('click', async () => {
      try { await api(`/meetings/${m.id}/notes`, { method: 'PUT', body: { notes: m.record_text } }); toast('Copied into the typed notes'); reload(); } catch (e) { toast(e.message); }
    });
  }

  /* ---------------- Agenda ---------------- */

  function drawAgenda(data) {
    const { can, esc, icon, pill, $ } = C();
    const m = data.meeting;
    const manage = can('meetings.manage');
    const me = C().state.me;
    const accepted = data.items.filter((i) => i.status === 'accepted');
    const submitted = data.items.filter((i) => i.status === 'submitted');
    const other = data.items.filter((i) => ['returned', 'withdrawn'].includes(i.status));
    const mine = (i) => me.user && i.submitted_by_id === me.user.id;
    const files = (i) => data.files.filter((f) => f.item_id === i.id);
    const fileLinks = (i) => files(i).map((f) => `<span class="mt-file"><a href="#" data-file="${f.id}">${icon('file')} ${esc(f.file_name)}</a> <small class="faint">${bytes(f.bytes)}</small>${manage || (mine(i) && i.status === 'submitted') ? ` <button class="btn-x" data-delfile="${f.id}" title="Remove">${icon('x')}</button>` : ''}</span>`).join('');
    const itemRow = (i, n) => `
      <div class="mt-item" data-item="${i.id}">
        ${n != null ? `<div class="mt-num">${n}</div>` : ''}
        <div class="grow">
          <div class="title">${esc(i.title)}</div>
          <div class="mt-pills">${pill(ITEM_TYPES, i.type)}${i.status !== 'accepted' ? pill(ITEM_STATUS, i.status) : ''}${i.presenter ? `<span class="pill">${esc(i.presenter)}</span>` : ''}${i.department ? `<span class="pill">${esc(i.department)}</span>` : ''}</div>
          ${i.description ? `<p class="muted mt-desc">${esc(i.description)}</p>` : ''}
          ${i.recommended_action ? `<p class="mt-desc"><b>Recommended action:</b> ${esc(i.recommended_action)}</p>` : ''}
          ${i.review_note && i.status === 'returned' ? `<p class="mt-desc" style="color:var(--red)"><b>Clerk's note:</b> ${esc(i.review_note)}</p>` : ''}
          <div class="mt-files">${fileLinks(i)}</div>
          <div class="faint" style="font-size:12px">Submitted by ${esc(i.submitted_by)}</div>
        </div>
        <div class="mt-item-actions">
          ${manage && i.status === 'accepted' ? `<button class="btn btn-sm btn-ghost" data-up="${i.id}" title="Move up">${icon('up')}</button><button class="btn btn-sm btn-ghost" data-down="${i.id}" title="Move down">${icon('down')}</button>` : ''}
          ${manage && i.status === 'submitted' ? `<button class="btn btn-sm btn-dark" data-accept="${i.id}">${icon('check')} Accept</button><button class="btn btn-sm" data-return="${i.id}">Return</button>` : ''}
          ${manage || (mine(i) && i.status !== 'accepted') ? `<button class="btn btn-sm btn-ghost" data-edit="${i.id}" title="Edit">${icon('pen')}</button>` : ''}
        </div>
      </div>`;
    const published = m.agenda_published_at;
    $('#mtAgenda').innerHTML = `
      <div class="card-h"><h2>Agenda</h2>${pill(AGENDA, m.agenda_status)}
        <div style="margin-left:auto;display:flex;gap:8px">${can('meetings.submit') && m.status !== 'cancelled' ? `<button class="btn btn-sm" id="agAdd">${icon('plus')} ${manage ? 'Add item' : 'Submit an item'}</button>` : ''}
        <button class="btn btn-sm btn-ghost" id="agPreview">Preview</button></div></div>
      <div class="card-b">
        ${published ? `<div class="mt-note">${icon('globe')}<span>Published ${esc(new Date(published).toLocaleString())} by ${esc(m.agenda_published_by)}${m.agenda_late ? ' <span class="pill red">late</span>' : ''}. Residents see it on the <a href="${publicUrl(m.id)}" target="_blank" rel="noopener">public meetings page</a> and the AI City Clerk can cite it.${m.agenda_status !== 'published' ? ' You are revising it: residents keep seeing the published version until the revision is approved.' : ''}</span></div>` : ''}
        ${accepted.length ? accepted.map((i, k) => itemRow(i, k + 1)).join('') : '<div class="faint">No items on the agenda yet.</div>'}
        ${submitted.length ? `<div class="section-title" style="margin-top:16px">Submitted, waiting for the clerk (${submitted.length})</div>${submitted.map((i) => itemRow(i)).join('')}` : ''}
        ${other.length ? `<details style="margin-top:12px"><summary class="section-title" style="cursor:pointer">Returned or withdrawn (${other.length})</summary>${other.map((i) => itemRow(i)).join('')}</details>` : ''}
      </div>
      <div class="drawer-f" style="border-top:1px solid var(--line)">
        <div class="right">
          ${manage && m.agenda_status === 'published' ? `<button class="btn" id="agRevise">${icon('pen')} Revise agenda</button>` : ''}
          ${manage && m.agenda_status === 'ready' ? '<button class="btn" id="agDraft">Back to draft</button>' : ''}
          ${manage && m.agenda_status === 'draft' && !can('meetings.approve') ? '<button class="btn btn-primary" id="agReady">Send for approval</button>' : ''}
          ${manage && m.agenda_status === 'draft' && can('meetings.approve') ? '<button class="btn" id="agReady">Send for approval</button>' : ''}
          ${can('meetings.approve') && m.agenda_status !== 'published' && m.status !== 'cancelled' ? `<button class="btn btn-primary" id="agPublish">${icon('check')} Approve &amp; publish</button>` : ''}
        </div>
      </div>`;
    const card = $('#mtAgenda');
    const byId = (id) => data.items.find((i) => i.id === id);
    card.querySelector('#agAdd')?.addEventListener('click', () => itemModal(m));
    card.querySelector('#agPreview').onclick = previewAgenda;
    card.querySelector('#agRevise')?.addEventListener('click', () => agendaStatus('draft'));
    card.querySelector('#agDraft')?.addEventListener('click', () => agendaStatus('draft'));
    card.querySelector('#agReady')?.addEventListener('click', () => agendaStatus('ready'));
    card.querySelector('#agPublish')?.addEventListener('click', () => publishAgenda(m));
    card.onclick = async (e) => {
      const t = e.target.closest('[data-up],[data-down],[data-accept],[data-return],[data-edit],[data-file],[data-delfile]');
      if (!t) return;
      e.preventDefault();
      const { api, toast } = C();
      try {
        if (t.dataset.up || t.dataset.down) {
          const ids = accepted.map((i) => i.id);
          const k = ids.indexOf(t.dataset.up || t.dataset.down);
          const j = t.dataset.up ? k - 1 : k + 1;
          if (j < 0 || j >= ids.length) return;
          [ids[k], ids[j]] = [ids[j], ids[k]];
          await api(`/meetings/${m.id}/items/order`, { method: 'POST', body: { order: ids } });
          reload();
        } else if (t.dataset.accept) {
          await api(`/meetings/${m.id}/items/${t.dataset.accept}`, { method: 'PATCH', body: { status: 'accepted' } }); toast('Added to the agenda'); reload();
        } else if (t.dataset.return) {
          returnModal(m, byId(t.dataset.return));
        } else if (t.dataset.edit) {
          itemModal(m, byId(t.dataset.edit));
        } else if (t.dataset.file) {
          openFile(t.dataset.file);
        } else if (t.dataset.delfile) {
          await api(`/meetings/files/${t.dataset.delfile}`, { method: 'DELETE' }); toast('Removed'); reload();
        }
      } catch (err) { toast(err.message); }
    };
  }

  async function openFile(id) {
    const res = await fetch(`${C().apiBase}/meetings/files/${id}`);
    if (!res.ok) { C().toast('Could not open file'); return; }
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  }

  async function agendaStatus(st) {
    try { await C().api(`/meetings/${local.current.meeting.id}/agenda/${st}`, { method: 'POST' }); C().toast(st === 'ready' ? 'Sent for approval' : 'Agenda is a draft again'); reload(); } catch (e) { C().toast(e.message); }
  }

  async function previewAgenda() {
    const { api, modal } = C();
    const { text } = await api(`/meetings/${local.current.meeting.id}/agenda/preview`);
    modal(`<h2>Agenda preview</h2><p class="muted" style="margin:0">This is what residents will see once it is approved and published.</p>
      <div class="mt-preview">${doc(text)}</div><div class="row"><button class="btn btn-primary" data-close>Close</button></div>`);
  }

  async function publishAgenda(m, acknowledgeLate = false, reason = '') {
    const { api, modal, toast, esc } = C();
    if (!acknowledgeLate) {
      const { text } = await api(`/meetings/${m.id}/agenda/preview`);
      const md = modal(`<h2>Approve and publish this agenda?</h2>
        <p class="muted" style="margin:0">It goes on the public meetings page and into the knowledge base, so the AI City Clerk can answer questions about it. Your name is recorded as the approver.</p>
        <div class="mt-preview">${doc(text)}</div>
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pubGo">Approve &amp; publish</button></div>`);
      md.querySelector('#pubGo').onclick = async () => { md.remove(); await doPublish(false); };
      return;
    }
    await doPublish(true);

    async function doPublish(ack) {
      try {
        await api(`/meetings/${m.id}/agenda/publish`, { method: 'POST', body: { acknowledgeLate: ack, reason } });
        toast('Agenda published'); reload();
      } catch (e) {
        if (!/late/i.test(e.message)) { toast(e.message); return; }
        const md = modal(`<h2>This agenda is late</h2>
          <div class="mt-warn error">${C().icon('alert')}<span>${esc(e.message.replace(/^This agenda is late\.\s*/, ''))}</span></div>
          <p class="muted" style="margin:0">Publishing late can make actions taken at the meeting open to challenge. Consider rescheduling the meeting. If you publish anyway, it is marked late and your reason is recorded.</p>
          <label class="field"><span>Reason</span><textarea class="textarea" id="lateWhy" rows="2" placeholder="e.g. Emergency repair contract; meeting was called today"></textarea></label>
          <div class="row"><button class="btn" data-close>Don't publish</button><button class="btn btn-danger" id="lateGo">Publish anyway</button></div>`);
        md.querySelector('#lateGo').onclick = async () => {
          const why = md.querySelector('#lateWhy').value.trim();
          if (!why) { md.querySelector('#lateWhy').focus(); return; }
          md.remove(); reason = why; await publishAgenda(m, true, why);
        };
      }
    }
  }

  function returnModal(m, item) {
    const { modal, api, toast, esc } = C();
    const md = modal(`<h2>Return "${esc(item.title)}"</h2><p class="muted" style="margin:0">The person who submitted it sees your note and can change and resubmit it.</p>
      <label class="field"><span>Note</span><textarea class="textarea" id="rtNote" rows="3" placeholder="e.g. Please attach the bid tabulation"></textarea></label>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="rtGo">Return item</button></div>`);
    md.querySelector('#rtGo').onclick = async () => {
      try { await api(`/meetings/${m.id}/items/${item.id}`, { method: 'PATCH', body: { status: 'returned', review_note: md.querySelector('#rtNote').value } }); md.remove(); toast('Returned'); reload(); } catch (e) { toast(e.message); }
    };
  }

  function itemModal(m, item = null) {
    const { modal, api, toast, esc, can, state } = C();
    const manage = can('meetings.manage');
    const deptDefault = item?.department_id || state.city.department_id || '';
    const md = modal(`
      <h2>${item ? 'Edit agenda item' : manage ? 'Add an agenda item' : 'Submit an agenda item'}</h2>
      ${!manage && !item ? '<p class="muted" style="margin:0">The City Clerk reviews submitted items and places them on the agenda.</p>' : ''}
      <label class="field"><span>Title</span><input class="input" id="itTitle" value="${esc(item?.title || '')}" placeholder="e.g. Award of the Pine Street paving contract" required></label>
      <div class="grid-2">
        <label class="field"><span>Type</span><select class="select" id="itType">${Object.entries(ITEM_TYPES).map(([k, [l]]) => `<option value="${k}" ${k === (item?.type || 'action') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Presenter</span><input class="input" id="itPresenter" value="${esc(item?.presenter || '')}" placeholder="Name and title"></label>
        <label class="field"><span>Department</span><select class="select" id="itDept"><option value="">None</option>${(local.departments || []).map((d) => `<option value="${d.id}" ${d.id === deptDefault ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Background</span><textarea class="textarea" id="itDesc" rows="3">${esc(item?.description || '')}</textarea></label>
      <label class="field"><span>Recommended action</span><textarea class="textarea" id="itRec" rows="2" placeholder="e.g. Approve the low bid from Gulf Coast Paving for $184,000">${esc(item?.recommended_action || '')}</textarea></label>
      <label class="field"><span>Attachments</span><input type="file" id="itFiles" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.txt,.csv"><small>Staff reports, bids, maps, ordinances. Published with the agenda.</small></label>
      <div class="row">
        ${item && item.status !== 'withdrawn' && (manage || item.status !== 'accepted') ? '<button class="btn btn-danger" id="itWithdraw" style="margin-right:auto">Withdraw</button>' : ''}
        ${item && item.status === 'returned' ? '<button class="btn" id="itResubmit">Resubmit</button>' : ''}
        <button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="itSave">${item ? 'Save' : manage ? 'Add to agenda' : 'Submit'}</button></div>`);
    const body = () => ({ title: md.querySelector('#itTitle').value, type: md.querySelector('#itType').value, presenter: md.querySelector('#itPresenter').value,
      department_id: md.querySelector('#itDept').value, description: md.querySelector('#itDesc').value, recommended_action: md.querySelector('#itRec').value });
    const upload = async (itemId) => {
      const files = [...md.querySelector('#itFiles').files];
      if (!files.length) return;
      const fd = new FormData();
      files.forEach((f) => fd.append('file', f));
      await api(`/meetings/${m.id}/items/${itemId}/files`, { method: 'POST', body: fd });
    };
    md.querySelector('#itSave').onclick = async () => {
      const b = body();
      if (!b.title.trim()) { md.querySelector('#itTitle').focus(); return; }
      md.querySelector('#itSave').disabled = true;
      try {
        const r = item ? await api(`/meetings/${m.id}/items/${item.id}`, { method: 'PATCH', body: b }) : await api(`/meetings/${m.id}/items`, { method: 'POST', body: b });
        await upload(r.item.id);
        md.remove(); toast(item ? 'Saved' : r.item.status === 'accepted' ? 'Added to the agenda' : 'Submitted to the clerk'); reload();
      } catch (e) { toast(e.message); md.querySelector('#itSave').disabled = false; }
    };
    const setStatus = async (status, msg) => {
      try { await api(`/meetings/${m.id}/items/${item.id}`, { method: 'PATCH', body: { ...body(), status } }); md.remove(); toast(msg); reload(); } catch (e) { toast(e.message); }
    };
    md.querySelector('#itWithdraw')?.addEventListener('click', () => setStatus('withdrawn', 'Withdrawn'));
    md.querySelector('#itResubmit')?.addEventListener('click', () => setStatus('submitted', 'Resubmitted to the clerk'));
  }

  /* ---------------- Recording, transcript and minutes ---------------- */

  function drawMinutes(data) {
    const { can, esc, icon, pill, $ } = C();
    const m = data.meeting;
    const manage = can('meetings.manage');
    const recordings = data.files.filter((f) => f.kind === 'recording');
    const prog = m.transcript_progress;
    const s = m.minutes_suggestions;
    const staffOptions = (name) => `<option value="">Unassigned</option>${(local.staff || []).map((p) => `<option value="${p.id}" ${name && p.name.toLowerCase() === name.toLowerCase() ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
    $('#mtMinutes').innerHTML = `
      <div class="card-h"><h2>Minutes</h2>${pill(MINUTES, m.minutes_status)}</div>
      <div class="card-b stack" style="gap:14px">
        ${m.minutes_approved_at ? `<div class="mt-note">${icon('check')}<span>Approved ${esc(new Date(m.minutes_approved_at).toLocaleString())} by ${esc(m.minutes_approved_by)} and published.${m.minutes_status === 'draft' ? ' You are correcting them: residents keep seeing the approved version until the correction is approved.' : ''}</span></div>` : ''}
        ${manage && m.minutes_status !== 'approved' ? `
        <div class="mt-step"><div class="mt-step-n">1</div><div class="grow">
          <b>Source</b>
          <div class="seg" id="srcSeg" style="margin:8px 0"><button data-v="rec" class="${m.minutes_source === "clerk's notes" ? '' : 'on'}">${icon('mic')} Recording</button><button data-v="notes" class="${m.minutes_source === "clerk's notes" ? 'on' : ''}">${icon('pen')} Typed notes</button></div>
          <div id="srcRec" ${m.minutes_source === "clerk's notes" ? 'hidden' : ''}>
            ${recordings.map((f) => `<div class="mt-file-row">${icon('mic')}<a href="#" data-file="${f.id}">${esc(f.file_name)}</a><small class="faint">${bytes(f.bytes)}</small>
              <button class="btn btn-sm" data-transcribe="${f.id}">${prog && prog.fileId === f.id && prog.done < prog.total ? `Resume (${prog.done}/${prog.total})` : m.transcript ? 'Transcribe again' : 'Transcribe'}</button></div>`).join('')}
            <label class="btn btn-sm" style="margin-top:6px">${icon('upload')} Upload a recording<input type="file" id="recFile" accept="audio/*,video/*,.mp3,.m4a,.wav,.mp4,.mov,.webm,.ogg" hidden></label>
            <small class="faint" style="display:block;margin-top:6px">Audio or video of the meeting. MP3 is transcribed on the server in two-minute segments; other formats are converted to audio in your browser first. The file is kept with the meeting's records.</small>
            <div id="recProgress"></div>
            ${m.transcript ? `<details style="margin-top:10px"><summary class="section-title" style="cursor:pointer">Transcript (${m.transcript.split(/\s+/).length.toLocaleString()} words${m.transcript_status === 'transcribing' ? ', incomplete' : ''})</summary>
              <textarea class="textarea" id="trText" rows="10" style="margin-top:8px">${esc(m.transcript)}</textarea>
              <button class="btn btn-sm" id="trSave" style="margin-top:6px">Save transcript</button></details>` : ''}
          </div>
          <div id="srcNotes" ${m.minutes_source === "clerk's notes" ? '' : 'hidden'}>
            <textarea class="textarea" id="notesText" rows="8" placeholder="Type what happened: who was present, each item, motions (who moved, who seconded), votes by name, and what staff were asked to do.">${esc(m.notes || '')}</textarea>
            <button class="btn btn-sm" id="notesSave" style="margin-top:6px">Save notes</button>
          </div>
        </div></div>
        <div class="mt-step"><div class="mt-step-n">2</div><div class="grow">
          <b>Draft</b><p class="muted" style="margin:4px 0 8px">The AI drafts minutes in the usual format: attendance, each item, motions with who moved and seconded, vote tallies by name, and action items. You review and edit; nothing is published until it is approved.</p>
          <button class="btn ${m.minutes_draft ? '' : 'btn-primary'}" id="draftGo">${icon('spark')} ${m.minutes_draft ? 'Draft again from the source' : 'Draft minutes'}</button>
        </div></div>` : ''}
        ${m.minutes_draft && m.minutes_status === 'draft' ? `
        <div class="mt-step"><div class="mt-step-n">${manage ? 3 : ''}</div><div class="grow">
          <b>Review and approve</b>
          ${s?.error ? `<div class="mt-warn warn">${icon('alert')}<span>${esc(s.error)}</span></div>` : ''}
          ${s?.checks?.length ? `<div class="mt-warn warn" style="margin-top:8px">${icon('alert')}<div><b>Check before approving</b><ul style="margin:4px 0 0;padding-left:18px">${s.checks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div></div>` : ''}
          ${s?.model ? `<small class="faint">Drafted from the ${esc(m.minutes_source)} by ${esc(s.model)}.</small>` : ''}
          <div class="seg" id="minSeg" style="margin:8px 0"><button data-v="edit" class="on">Edit</button><button data-v="view">Preview</button></div>
          <textarea class="textarea mt-editor" id="minText" rows="22" ${manage ? '' : 'readonly'}>${esc(m.minutes_draft)}</textarea>
          <div id="minView" hidden></div>
          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            ${manage ? '<button class="btn" id="minSave">Save draft</button>' : ''}
            ${can('meetings.approve') ? `<button class="btn btn-primary" id="minApprove">${icon('check')} Approve &amp; publish minutes</button>` : ''}
          </div>
        </div></div>` : ''}
        ${m.minutes_status === 'approved' ? `<div class="mt-preview" style="max-height:520px">${doc(m.minutes_approved)}</div>
          ${manage ? '<div><button class="btn btn-sm" id="minReopen">Reopen for correction</button></div>' : ''}` : ''}
        ${!manage && m.minutes_status === 'none' ? '<div class="faint">The clerk has not drafted minutes for this meeting yet.</div>' : ''}
        ${manage && s?.actions?.length ? `<div><div class="section-title">Action items the AI found</div><p class="faint" style="margin:2px 0 8px;font-size:12.5px">Assign the ones that should be tracked.</p>
          ${s.actions.map((a, k) => `<div class="mt-sugg" data-k="${k}"><div class="grow"><b>${esc(a.title)}</b>${a.assignee_name ? ` <span class="faint">· ${esc(a.assignee_name)}</span>` : ''}</div>
            <select class="select" data-who>${staffOptions(a.assignee_name)}</select><input class="input" type="date" data-due value="${esc(a.due_date || '')}"><button class="btn btn-sm" data-addsugg="${k}">${icon('plus')} Track</button></div>`).join('')}</div>` : ''}
      </div>`;
    const card = $('#mtMinutes');
    card.querySelector('#srcSeg')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      card.querySelectorAll('#srcSeg button').forEach((x) => x.classList.toggle('on', x === b));
      card.querySelector('#srcRec').hidden = b.dataset.v !== 'rec'; card.querySelector('#srcNotes').hidden = b.dataset.v !== 'notes';
    });
    card.querySelector('#minSeg')?.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      card.querySelectorAll('#minSeg button').forEach((x) => x.classList.toggle('on', x === b));
      const view = b.dataset.v === 'view';
      card.querySelector('#minText').hidden = view; card.querySelector('#minView').hidden = !view;
      if (view) card.querySelector('#minView').innerHTML = `<div class="mt-preview">${doc(card.querySelector('#minText').value)}</div>`;
    });
    card.querySelector('#recFile')?.addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadRecording(m, f); });
    card.onclick = async (e) => {
      const fl = e.target.closest('[data-file]'); if (fl) { e.preventDefault(); openFile(fl.dataset.file); return; }
      const tr = e.target.closest('[data-transcribe]'); if (tr) { const f = recordings.find((x) => x.id === tr.dataset.transcribe); transcribe(m, f, local.pendingFile?.id === f.id ? local.pendingFile.file : null); return; }
      const sg = e.target.closest('[data-addsugg]');
      if (sg) {
        const row = sg.closest('.mt-sugg');
        const a = s.actions[Number(sg.dataset.addsugg)];
        try {
          await C().api(`/meetings/${m.id}/actions`, { method: 'POST', body: { title: a.title, assignee_id: row.querySelector('[data-who]').value || null, due_date: row.querySelector('[data-due]').value || null } });
          C().toast('Action item added'); sg.disabled = true; sg.textContent = 'Tracked'; refreshActions();
        } catch (err) { C().toast(err.message); }
      }
    };
    const { api, toast } = C();
    card.querySelector('#trSave')?.addEventListener('click', async () => {
      try { await api(`/meetings/${m.id}/transcript`, { method: 'PUT', body: { text: card.querySelector('#trText').value } }); toast('Transcript saved'); } catch (err) { toast(err.message); }
    });
    card.querySelector('#notesSave')?.addEventListener('click', async () => {
      try { await api(`/meetings/${m.id}/notes`, { method: 'PUT', body: { notes: card.querySelector('#notesText').value } }); toast('Notes saved'); } catch (err) { toast(err.message); }
    });
    card.querySelector('#draftGo')?.addEventListener('click', async (e) => {
      const notes = !card.querySelector('#srcNotes').hidden;
      const btn = e.target.closest('button');
      if (m.minutes_draft && !btn.dataset.confirm) { btn.dataset.confirm = '1'; btn.textContent = 'This replaces the current draft. Click again'; return; }
      btn.disabled = true; btn.innerHTML = '<span class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:-2px"></span> Drafting… this can take a minute';
      try {
        await api(`/meetings/${m.id}/minutes/draft`, { method: 'POST', body: notes ? { source: 'notes', notes: card.querySelector('#notesText').value } : { source: 'transcript' } });
        toast('Draft ready for your review'); reload();
      } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Draft minutes'; }
    });
    card.querySelector('#minSave')?.addEventListener('click', async () => {
      try { await api(`/meetings/${m.id}/minutes`, { method: 'PUT', body: { text: card.querySelector('#minText').value } }); toast('Draft saved'); } catch (err) { toast(err.message); }
    });
    card.querySelector('#minApprove')?.addEventListener('click', async () => {
      const text = card.querySelector('#minText').value;
      const md = C().modal(`<h2>Approve and publish these minutes?</h2>
        <p class="muted" style="margin:0">Residents will see them on the public meetings page and the AI City Clerk will cite them. Your name is recorded as the approver.</p>
        <div class="mt-preview">${doc(text)}</div>
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="apGo">Approve &amp; publish</button></div>`);
      md.querySelector('#apGo').onclick = async () => {
        try {
          if (manage && text !== m.minutes_draft) await api(`/meetings/${m.id}/minutes`, { method: 'PUT', body: { text } });
          await api(`/meetings/${m.id}/minutes/approve`, { method: 'POST' });
          md.remove(); toast('Minutes approved and published'); reload();
        } catch (err) { toast(err.message); }
      };
    });
    card.querySelector('#minReopen')?.addEventListener('click', async () => {
      try { await api(`/meetings/${m.id}/minutes/reopen`, { method: 'POST' }); toast('Reopened for correction'); reload(); } catch (err) { toast(err.message); }
    });
  }

  function progressBar(label, pct) {
    const el = C().$('#recProgress');
    if (el) el.innerHTML = `<div class="q-item" style="margin-top:10px"><span class="ext txt">${C().icon('mic')}</span><div style="min-width:0"><strong>${C().esc(label)}</strong><div class="prog"><i style="width:${Math.round(pct)}%"></i></div></div><div><div class="spin"></div></div></div>`;
  }

  // Upload in parts straight to R2 through the Worker, so large video files work.
  async function uploadRecording(m, file) {
    const { api, toast, apiBase } = C();
    try {
      progressBar(`Uploading ${file.name}…`, 1);
      const start = await api(`/meetings/${m.id}/recording`, { method: 'POST', body: { file_name: file.name, mime: file.type || '', bytes: file.size } });
      const parts = [];
      for (let n = 1; n <= start.parts; n++) {
        const blob = file.slice((n - 1) * start.partSize, n * start.partSize);
        const res = await fetch(`${apiBase}/meetings/${m.id}/recording/${start.fileId}?part=${n}`, { method: 'PUT', body: blob });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || 'Upload failed');
        parts.push(j);
        progressBar(`Uploading ${file.name}… ${Math.round((n / start.parts) * 100)}%`, (n / start.parts) * 100);
      }
      const done = await api(`/meetings/${m.id}/recording/${start.fileId}/complete`, { method: 'POST', body: { parts } });
      toast('Recording saved. Transcribing…');
      local.pendingFile = { id: start.fileId, file };
      await transcribe(m, done.file, file);
    } catch (e) { toast(e.message); progressBar(e.message, 0); }
  }

  const isMp3 = (f) => /mpeg|mp3/i.test(f.mime || '') || /\.mp3$/i.test(f.file_name);

  async function transcribe(m, f, file) {
    const { api, toast, apiBase } = C();
    const prog = local.current.meeting.transcript_progress;
    const from = prog && prog.fileId === f.id && prog.done < prog.total ? prog.done : 0;
    try {
      if (isMp3(f)) {
        let total = Infinity;
        for (let seq = from; seq < total; seq++) {
          const r = await api(`/meetings/${m.id}/transcribe`, { method: 'POST', body: { fileId: f.id, seq } });
          total = r.total;
          progressBar(`Transcribing ${f.file_name}: segment ${seq + 1} of ${total} (${r.words.toLocaleString()} words so far)`, ((seq + 1) / total) * 100);
        }
      } else {
        progressBar(`Converting ${f.file_name} to audio in your browser…`, 2);
        if (!file) {
          const res = await fetch(`${apiBase}/meetings/files/${f.id}`);
          if (!res.ok) throw new Error('Could not load the recording');
          file = await res.blob();
        }
        const audio = await decodeAudio(file);
        const total = Math.max(1, Math.ceil(audio.length / (16000 * WAV_SECONDS)));
        for (let seq = from; seq < total; seq++) {
          const wav = wavSegment(audio, seq);
          const res = await fetch(`${apiBase}/meetings/${m.id}/transcribe?seq=${seq}&total=${total}&fileId=${f.id}&source=${encodeURIComponent(f.file_name)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
          const r = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(r.error || 'Transcription failed');
          progressBar(`Transcribing ${f.file_name}: segment ${seq + 1} of ${total} (${r.words.toLocaleString()} words so far)`, ((seq + 1) / total) * 100);
        }
      }
      toast('Transcript ready. Draft the minutes next.');
      reload();
    } catch (e) {
      toast(e.message);
      progressBar(`${e.message} Click Resume to continue.`, 0);
      setTimeout(reload, 1500);
    }
  }

  // Decoded at 16 kHz, the rate Whisper uses. Browsers decode the audio track of video files too.
  async function decodeAudio(blob) {
    if (blob.size > 1.5e9) throw new Error('This file is too large to convert in the browser. Export the audio as an MP3 and upload that.');
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Ctx(1, 16000, 16000);
    try { return await ctx.decodeAudioData(await blob.arrayBuffer()); } catch { throw new Error("Your browser couldn't read the audio in this file. Export the audio as an MP3 and upload that."); }
  }

  // One segment as a 16-bit mono WAV file, channels mixed down.
  function wavSegment(audio, seq) {
    const per = 16000 * WAV_SECONDS;
    const start = seq * per;
    const n = Math.min(per, audio.length - start);
    const chans = [...Array(audio.numberOfChannels)].map((_, i) => audio.getChannelData(i));
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      let x = 0;
      for (const c of chans) x += c[start + i];
      x = Math.max(-1, Math.min(1, x / chans.length));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* ---------------- Action items ---------------- */

  function actionRow(a, { showMeeting = false } = {}) {
    const { esc, pill, can, state } = C();
    const editable = can('meetings.manage') || (state.city.staff_id && a.assignee_id === state.city.staff_id);
    const overdue = a.due_date && ['open', 'in_progress'].includes(a.status) && a.due_date < new Date().toISOString().slice(0, 10);
    return `<div class="list-item" data-action="${a.id}"><div class="grow">
      <div class="title">${esc(a.title)}</div>
      <div class="meta">${esc(a.assignee || 'Unassigned')}${a.due_date ? ` · due ${esc(a.due_date)}` : ''}${overdue ? ' <span class="pill red">Overdue</span>' : ''}${showMeeting ? ` · <a href="#/meetings/${a.meeting_id}">${esc(a.board)}, ${esc(fmtDay(a.meeting_starts_at))}</a>` : ''}</div>
      ${a.details ? `<div class="faint" style="font-size:12.5px;margin-top:2px">${esc(a.details)}</div>` : ''}</div>
      ${editable ? `<select class="select" data-astatus="${a.id}" style="width:auto">${Object.entries(ACTION_STATUS).map(([k, [l]]) => `<option value="${k}" ${k === a.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${can('meetings.manage') ? `<button class="btn btn-sm btn-ghost" data-aedit="${a.id}" title="Edit">${C().icon('pen')}</button>` : ''}` : pill(ACTION_STATUS, a.status)}</div>`;
  }

  function bindActions(el, actions, after) {
    el.addEventListener('change', async (e) => {
      const s = e.target.closest('[data-astatus]'); if (!s) return;
      try { await C().api(`/meetings/actions/${s.dataset.astatus}`, { method: 'PATCH', body: { status: s.value } }); C().toast('Updated'); after(); } catch (err) { C().toast(err.message); }
    });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-aedit]'); if (b) actionModal(null, actions.find((a) => a.id === b.dataset.aedit), after); });
  }

  function drawActions(data) {
    const { $, can, icon } = C();
    $('#mtActions').innerHTML = `<div class="card-h"><h2>Action items</h2>${can('meetings.manage') ? `<button class="btn btn-sm" id="acAdd" style="margin-left:auto">${icon('plus')} Add</button>` : ''}</div>
      <div class="card-b"><div class="list">${data.actions.length ? data.actions.map((a) => actionRow(a)).join('') : '<div class="faint">Follow-up work assigned at this meeting appears here.</div>'}</div></div>`;
    $('#acAdd')?.addEventListener('click', () => actionModal(data.meeting, null, refreshActions));
    bindActions($('#mtActions'), data.actions, refreshActions);
  }

  async function refreshActions() {
    const data = await C().api(`/meetings/${local.current.meeting.id}`);
    local.current = data;
    drawActions(data);
  }

  function actionModal(meeting, a, after) {
    const { modal, esc, api, toast } = C();
    const md = modal(`<h2>${a ? 'Edit action item' : 'Add an action item'}</h2>
      <label class="field"><span>What needs to be done</span><input class="input" id="acTitle" value="${esc(a?.title || '')}"></label>
      <div class="grid-2">
        <label class="field"><span>Assigned to</span><select class="select" id="acWho"><option value="">Unassigned</option>${(local.staff || []).map((p) => `<option value="${p.id}" ${p.id === a?.assignee_id ? 'selected' : ''}>${esc(p.name)}${p.department ? ` · ${esc(p.department)}` : ''}</option>`).join('')}</select></label>
        <label class="field"><span>Due</span><input class="input" type="date" id="acDue" value="${esc(a?.due_date || '')}"></label>
      </div>
      <label class="field"><span>Details</span><textarea class="textarea" id="acDetails" rows="2">${esc(a?.details || '')}</textarea></label>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="acSave">${a ? 'Save' : 'Add'}</button></div>`);
    md.querySelector('#acSave').onclick = async () => {
      const body = { title: md.querySelector('#acTitle').value, assignee_id: md.querySelector('#acWho').value || null, due_date: md.querySelector('#acDue').value || null, details: md.querySelector('#acDetails').value };
      if (!body.title.trim()) { md.querySelector('#acTitle').focus(); return; }
      try {
        if (a) await api(`/meetings/actions/${a.id}`, { method: 'PATCH', body }); else await api(`/meetings/${meeting.id}/actions`, { method: 'POST', body });
        md.remove(); toast('Saved'); after();
      } catch (e) { toast(e.message); }
    };
  }

  async function renderActions(page) {
    const { api, esc, emptyNote, state } = C();
    const qs = { open: 'open=1', mine: 'mine=1&open=1', all: '' }[local.actionFilter];
    const { actions } = await api(`/meetings/actions?${qs}`);
    page.innerHTML = `${tabBar()}
      <div class="chips" id="acFilter" style="margin-bottom:12px">${[['open', 'Open'], ...(state.city.staff_id ? [['mine', 'Assigned to me']] : []), ['all', 'All']].map(([k, l]) => `<button class="chip ${local.actionFilter === k ? 'on' : ''}" data-v="${k}">${l}</button>`).join('')}</div>
      <div class="card"><div class="card-b"><div class="list">${actions.length ? actions.map((a) => actionRow(a, { showMeeting: true })).join('') : emptyNote('check', 'No action items here.')}</div></div></div>`;
    page.querySelector('#acFilter').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; local.actionFilter = c.dataset.v; renderActions(page); };
    bindActions(page, actions, () => renderActions(page));
    void esc;
  }

  /* ---------------- Boards and members ---------------- */

  async function renderBoards(page) {
    const { esc, icon, can, emptyNote, $ } = C();
    const manage = can('meetings.manage');
    if (manage) {
      $('#pageActions').innerHTML = `<button class="btn btn-primary" id="bdNew">${icon('plus')} Add a board</button>`;
      $('#bdNew').onclick = () => boardModal();
    }
    page.innerHTML = `${tabBar()}<div class="stack">${local.boards.length ? local.boards.map((b) => `
      <div class="card" ${b.active ? '' : 'style="opacity:.6"'}><div class="card-h"><h2>${esc(b.name)}</h2><span class="pill">${esc(BOARD_KINDS[b.kind] || b.kind)}</span>${b.external ? '<span class="pill violet">Another government</span>' : ''}${b.active ? '' : '<span class="pill">Inactive</span>'}
        ${manage ? `<div style="margin-left:auto;display:flex;gap:8px"><button class="btn btn-sm" data-bedit="${b.id}">${icon('pen')} Edit</button><button class="btn btn-sm" data-madd="${b.id}">${icon('plus')} Add member</button></div>` : ''}</div>
        <div class="card-b">
          ${b.schedule || b.location ? `<p class="muted" style="margin:0 0 10px">${esc([b.schedule, b.location].filter(Boolean).join(' · '))}</p>` : ''}
          <table class="table"><thead><tr><th>Name</th><th>Seat</th><th class="hide-sm">Role</th><th>Votes</th><th class="hide-sm">Term ends</th></tr></thead><tbody>
          ${b.members.length ? b.members.map((x) => `<tr data-member="${x.id}" data-board="${b.id}" ${x.active ? '' : 'style="opacity:.5"'} ${manage ? 'class="clickable"' : ''}><td><strong>${esc(x.name)}</strong>${x.active ? '' : ' <span class="pill">Former</span>'}</td><td>${esc(x.seat || '—')}</td><td class="hide-sm">${esc(ROLES[x.role] || x.role)}</td><td>${x.voting ? 'Yes' : 'No'}</td><td class="hide-sm muted">${esc(x.term_ends || '—')}</td></tr>`).join('')
            : `<tr><td colspan="5" class="faint">No members yet. Members' names are used when drafting minutes and checking votes.</td></tr>`}</tbody></table>
        </div></div>`).join('') : `<div class="card card-b">${emptyNote('users', 'No boards yet. Start with the governing board, for example the Board of Aldermen.')}</div>`}</div>`;
    page.onclick = (e) => {
      const be = e.target.closest('[data-bedit]'); if (be) { boardModal(local.boards.find((b) => b.id === be.dataset.bedit)); return; }
      const ma = e.target.closest('[data-madd]'); if (ma) { memberModal(ma.dataset.madd); return; }
      const mr = e.target.closest('tr[data-member]');
      if (mr && manage) memberModal(mr.dataset.board, local.boards.find((b) => b.id === mr.dataset.board).members.find((x) => x.id === mr.dataset.member));
    };
  }

  function boardModal(b = null) {
    const { modal, esc, api, toast } = C();
    const md = modal(`<h2>${b ? esc(b.name) : 'Add a board'}</h2>
      <div class="grid-2">
        <label class="field"><span>Name</span><input class="input" id="bdName" value="${esc(b?.name || '')}" placeholder="e.g. Board of Aldermen"></label>
        <label class="field"><span>Type</span><select class="select" id="bdKind">${Object.entries(BOARD_KINDS).map(([k, l]) => `<option value="${k}" ${k === (b?.kind || 'board') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Regular meeting schedule</span><input class="input" id="bdSched" value="${esc(b?.schedule || '')}" placeholder="e.g. First and third Tuesday of each month, 6 pm"><small>The schedule recorded in the minutes. Meetings on it are regular meetings.</small></label>
      <label class="field"><span>Usual meeting place</span><input class="input" id="bdLoc" value="${esc(b?.location || '')}" placeholder="e.g. City Hall boardroom"></label>
      <label class="field"><span>Description</span><textarea class="textarea" id="bdDesc" rows="2">${esc(b?.description || '')}</textarea></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bdExternal" ${b?.external ? 'checked' : ''}> Another government's body (for example the county board of supervisors)</label>
      <small class="faint">Listed for residents' information, without notice or minutes deadlines for the clerk.</small>
      <div class="row">${b ? `<button class="btn ${b.active ? 'btn-danger' : ''}" id="bdActive" style="margin-right:auto">${b.active ? 'Mark inactive' : 'Reactivate'}</button>` : ''}
        <button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="bdSave">${b ? 'Save' : 'Add board'}</button></div>`);
    const save = async (extra = {}) => {
      const body = { name: md.querySelector('#bdName').value, kind: md.querySelector('#bdKind').value, schedule: md.querySelector('#bdSched').value, location: md.querySelector('#bdLoc').value, description: md.querySelector('#bdDesc').value, external: md.querySelector('#bdExternal').checked, ...extra };
      if (!body.name.trim()) { md.querySelector('#bdName').focus(); return; }
      try { if (b) await api(`/meetings/boards/${b.id}`, { method: 'PATCH', body }); else await api('/meetings/boards', { method: 'POST', body }); md.remove(); toast('Saved'); await lookups(); renderBoards(C().$('#page')); } catch (e) { toast(e.message); }
    };
    md.querySelector('#bdSave').onclick = () => save();
    md.querySelector('#bdActive')?.addEventListener('click', () => save({ active: !b.active }));
  }

  function memberModal(boardId, x = null) {
    const { modal, esc, api, toast } = C();
    const md = modal(`<h2>${x ? esc(x.name) : 'Add a member'}</h2>
      <div class="grid-2">
        <label class="field"><span>Name</span><input class="input" id="mbName" value="${esc(x?.name || '')}"></label>
        <label class="field"><span>Seat</span><input class="input" id="mbSeat" value="${esc(x?.seat || '')}" placeholder="e.g. Ward 2 Alderman, Mayor"></label>
        <label class="field"><span>Role</span><select class="select" id="mbRole">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${k === (x?.role || 'member') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Term ends</span><input class="input" type="date" id="mbTerm" value="${esc(x?.term_ends || '')}"></label>
      </div>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="mbVoting" ${x ? (x.voting ? 'checked' : '') : 'checked'}> Votes on motions</label>
      <small class="faint">In Mississippi code-charter towns the mayor presides and votes only to break a tie; uncheck "votes" for the mayor if that applies.</small>
      <div class="row">${x ? `<button class="btn ${x.active ? 'btn-danger' : ''}" id="mbActive" style="margin-right:auto">${x.active ? 'No longer serving' : 'Serving again'}</button>` : ''}
        <button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="mbSave">${x ? 'Save' : 'Add member'}</button></div>`);
    const save = async (extra = {}) => {
      const body = { name: md.querySelector('#mbName').value, seat: md.querySelector('#mbSeat').value, role: md.querySelector('#mbRole').value, term_ends: md.querySelector('#mbTerm').value, voting: md.querySelector('#mbVoting').checked, ...extra };
      if (!body.name.trim()) { md.querySelector('#mbName').focus(); return; }
      try { if (x) await api(`/meetings/members/${x.id}`, { method: 'PATCH', body }); else await api(`/meetings/boards/${boardId}/members`, { method: 'POST', body }); md.remove(); toast('Saved'); await lookups(); renderBoards(C().$('#page')); } catch (e) { toast(e.message); }
    };
    md.querySelector('#mbSave').onclick = () => save();
    md.querySelector('#mbActive')?.addEventListener('click', () => save({ active: !x.active }));
  }

  /* ---------------- Notice rules ---------------- */

  async function renderRules(page) {
    const { api, esc, can, toast, icon } = C();
    const { rules, defaults } = await api('/meetings/settings');
    const edit = can('settings.edit');
    const field = (k, label, help, unit = 'hours') => `<label class="field"><span>${label}</span><div style="display:flex;gap:8px;align-items:center"><input class="input" name="${k}" type="number" min="0" step="0.5" value="${esc(rules[k] ?? '')}" ${edit ? '' : 'disabled'} style="width:120px"><span class="muted">${unit}</span></div><small>${help} Default: ${esc(defaults[k] ?? 'none')}.</small></label>`;
    page.innerHTML = `${tabBar()}
      <form class="card" id="ruleForm" style="max-width:860px"><div class="card-h"><h2>Public notice rules</h2></div><div class="card-b stack" style="gap:14px">
        <p class="muted" style="margin:0">${esc(rules.basis || defaults.basis)}</p>
        <div class="grid-2">
          ${field('regularHours', 'Regular meeting agenda', 'How long before a regular meeting its agenda must be published. Set by the city\'s rules of procedure.')}
          ${field('specialHours', 'Special meeting notice', 'How long before a called special meeting its notice and agenda must be online. Miss. Code Ann. § 25-41-13(1)(b): at least 1 hour (municipalities of 25,000 or more).')}
          ${field('workSessionHours', 'Work session notice', 'Work sessions off the regular schedule are called special meetings for notice purposes.')}
          ${field('postWithinHours', 'Post notice of a called meeting within', 'After a special meeting is called. Miss. Code Ann. § 25-41-13(1)(a): within 1 hour. Leave blank if your state has no such rule.')}
          ${field('minutesDays', 'Minutes due within', 'After the meeting. Miss. Code Ann. § 25-41-11: not more than 30 days.', 'days')}
        </div>
        <p class="faint" style="margin:0;font-size:12.5px">The dashboard warns the clerk as deadlines approach, and an agenda published after its deadline needs the approver to confirm and give a reason. Both are recorded in the meeting's history.</p>
        ${edit ? `<div><button class="btn btn-primary" type="submit">${icon('check')} Save rules</button></div>` : '<p class="faint" style="margin:0">Only administrators can change these.</p>'}
      </div></form>`;
    page.querySelector('#ruleForm').onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try { await api('/meetings/settings', { method: 'PUT', body }); toast('Notice rules saved'); } catch (err) { toast(err.message); }
    };
  }

  /* ---------------- Styles ---------------- */

  function injectStyle() {
    if (document.getElementById('mtStyle')) return;
    const s = document.createElement('style');
    s.id = 'mtStyle';
    s.textContent = `
      .mt-row { display: flex; gap: 14px; padding: 14px 16px; color: inherit; text-decoration: none; align-items: flex-start; }
      .mt-row:hover { border-color: var(--line-2); box-shadow: var(--shadow); }
      .mt-row .title { font-weight: 600; } .mt-row .meta { color: var(--muted); font-size: 13px; margin-top: 2px; }
      .mt-date { flex: none; width: 52px; text-align: center; border: 1px solid var(--line); border-radius: 12px; padding: 6px 0; background: var(--paper); }
      .mt-date b { display: block; font: 700 20px/1.1 var(--font-display); } .mt-date small { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
      .mt-date.big { width: 70px; } .mt-date.big b { font-size: 28px; }
      .mt-pills { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
      .mt-warn { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; padding: 8px 10px; border-radius: 10px; margin-top: 8px; background: var(--paper-2); }
      .mt-warn .icon { flex: none; width: 16px; height: 16px; margin-top: 1px; }
      .mt-warn.error { background: var(--red-soft); color: var(--red); } .mt-warn.warn { background: var(--amber-soft); color: var(--amber); } .mt-warn.info { background: var(--blue-soft); color: var(--blue-ink); }
      .mt-head { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; } .mt-head h2 { margin: 0 0 4px; font: 700 20px/1.2 var(--font-display); }
      .mt-head .grow { flex: 1; min-width: 240px; } .mt-facts { grid-template-columns: repeat(2, minmax(140px, 1fr)); margin: 0; }
      .mt-status { display: flex; gap: 8px; flex-basis: 100%; justify-content: flex-end; flex-wrap: wrap; }
      .mt-item { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); align-items: flex-start; } .mt-item:last-child { border-bottom: 0; }
      .mt-item .title { font-weight: 600; } .mt-num { flex: none; width: 28px; height: 28px; border-radius: 8px; background: var(--paper-2); display: grid; place-items: center; font-weight: 700; font-size: 13px; }
      .mt-item .grow { flex: 1; min-width: 0; } .mt-desc { margin: 6px 0 0; font-size: 13.5px; white-space: pre-wrap; }
      .mt-item-actions { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
      .mt-files { display: flex; gap: 10px; flex-wrap: wrap; margin: 6px 0 2px; font-size: 13px; } .mt-file a { display: inline-flex; gap: 4px; align-items: center; }
      .mt-file .icon, .mt-file-row .icon { width: 14px; height: 14px; }
      .btn-x { border: 0; background: none; cursor: pointer; color: var(--faint); padding: 0 2px; } .btn-x .icon { width: 12px; height: 12px; }
      .mt-file-row { display: flex; gap: 8px; align-items: center; padding: 6px 0; font-size: 13.5px; } .mt-file-row .btn { margin-left: auto; }
      .mt-note { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; padding: 10px 12px; border-radius: 10px; background: var(--green-soft); color: var(--green); margin-bottom: 10px; }
      .mt-note .icon { flex: none; width: 16px; height: 16px; margin-top: 1px; }
      .mt-step { display: flex; gap: 12px; } .mt-step-n { flex: none; width: 24px; height: 24px; border-radius: 50%; background: var(--ink); color: #fff; display: grid; place-items: center; font-size: 12px; font-weight: 700; }
      .mt-step-n:empty { display: none; } .mt-step .grow { flex: 1; min-width: 0; }
      .mt-editor { font: 13px/1.55 var(--font-mono); }
      .mt-preview { border: 1px solid var(--line); border-radius: 12px; padding: 4px 16px; max-height: 60vh; overflow: auto; background: var(--paper); }
      .mt-doc h3 { font: 700 17px/1.3 var(--font-display); margin: 14px 0 6px; } .mt-doc h4 { font-size: 15px; margin: 14px 0 4px; } .mt-doc h5 { font-size: 14px; margin: 10px 0 4px; }
      .mt-doc p { margin: 6px 0; font-size: 14px; }
      .mt-sugg { display: flex; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); flex-wrap: wrap; } .mt-sugg .grow { flex: 1; min-width: 180px; font-size: 13.5px; }
      .mt-sugg .select, .mt-sugg .input { width: auto; }
      tr.clickable { cursor: pointer; } tr.clickable:hover td { background: var(--paper); }
    `;
    document.head.appendChild(s);
  }

  C().addPage('meetings', { title: 'Meetings', sub: 'Agendas, minutes and action items for boards and commissions', icon: 'calendar', render, perm: 'meetings.view' }, 'Government');
  C().addAuditType('meeting', 'Meetings');
  C().addAuditType('board', 'Boards');
})();
