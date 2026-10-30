/* City Hall OS: Public Works dispatcher. The dispatch board, crews, work orders, the map and the field view.
   Loaded after dashboard.js and plugs in through window.CHOS (see "Feature modules" there). */
((C) => {
  const { $, $$, esc, icon, pill, toast, api, can, modal, openDrawer, closeDrawer, emptyNote, ago, REQ_STATUS } = C;
  const WO_STATUS = { scheduled: ['Scheduled', 'blue'], in_progress: ['In progress', 'amber'], done: ['Done', 'green'], cancelled: ['Cancelled', ''] };
  const PRIORITY = { urgent: ['Urgent', 'red'], high: ['High', 'amber'], normal: ['Normal', ''], low: ['Low', ''] };
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4';
  const d = { board: null, dept: '', week: '', fieldDate: '', notes: {} };

  // Icons this module uses, added to the dashboard's sprite.
  document.querySelector('svg[aria-hidden] symbol')?.parentNode.insertAdjacentHTML('beforeend', `
    <symbol id="i-truck" viewBox="0 0 24 24"><path d="M3 6h11v9H3zM14 9h4l3 3v3h-7"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/></symbol>
    <symbol id="i-map" viewBox="0 0 24 24"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></symbol>
    <symbol id="i-pin" viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/></symbol>
    <symbol id="i-camera" viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/></symbol>
    <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></symbol>
    <symbol id="i-chevron-l" viewBox="0 0 24 24"><path d="m15 6-6 6 6 6"/></symbol>
    <symbol id="i-chevron-r" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>`);

  /* ---------------- Dates ---------------- */

  const day = (s) => new Date(`${s}T12:00:00Z`);
  const addDays = (s, n) => new Date(day(s).getTime() + n * 864e5).toISOString().slice(0, 10);
  const fmtDay = (s, o = { weekday: 'short', month: 'short', day: 'numeric' }) => (s ? day(s).toLocaleDateString(undefined, { ...o, timeZone: 'UTC' }) : '');
  const nextWorkday = (s) => { let x = addDays(s, 1); while ([0, 6].includes(day(x).getUTCDay())) x = addDays(x, 1); return x; };
  const weekDays = (from) => [...Array(7)].map((_, i) => addDays(from, i));

  /* ---------------- Shared pieces ---------------- */

  // Opens a request's drawer on the Service requests page.
  const goRequest = (id) => {
    C.state.reqId = id;
    if (location.hash === '#/requests') C.rerender(); else location.hash = '#/requests';
  };
  // Resident GPS arrives as "GPS 30.85712, -89.13541"; the map and Directions link use the coordinates.
  const place = (loc) => (/^GPS\s/i.test(loc || '') ? 'GPS pin from resident' : loc || 'No location given');
  const prio = (p) => (p && p !== 'normal' ? pill(PRIORITY, p) : '');
  const directions = (x) => (x.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${x.lat},${x.lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${x.location || ''}, ${C.state.city.shortName}, ${C.state.city.state}`)}`);

  function suggestionBox(list) {
    if (!list.length) return '';
    const accept = { duplicate: (s) => `Merge into ${esc(s.data.ref)}`, priority: (s) => `Raise to ${esc(s.value)}`, crew: () => 'Schedule' };
    const dismiss = { duplicate: 'Not a duplicate', priority: 'Keep priority', crew: 'Dismiss' };
    const title = { duplicate: 'Likely duplicate', priority: 'Priority', crew: 'Crew' };
    return `<div class="pw-suggest">${list.map((s) => `
      <div class="pw-sg" data-sid="${s.id}"><div class="pw-sg-t">${icon('spark')}<b>${title[s.kind]}</b><span>${esc(s.reason)}</span></div>
        ${can('dispatch.manage') ? `<div class="pw-sg-a"><button class="btn btn-sm" data-accept="${s.id}" data-date="${esc(s.data?.date || '')}">${accept[s.kind](s)}</button>
          <button class="btn btn-sm btn-ghost" data-dismiss="${s.id}">${dismiss[s.kind]}</button></div>` : ''}</div>`).join('')}
      <small class="faint">Suggested by the dispatcher. Nothing changes until you accept.</small></div>`;
  }

  // Wires the accept and dismiss buttons inside el; then() reloads whatever is showing.
  function bindSuggestions(el, then) {
    if (el.pwSuggest) el.removeEventListener('click', el.pwSuggest);
    el.pwSuggest = async (e) => {
      const a = e.target.closest('[data-accept], [data-dismiss]');
      if (!a) return;
      e.stopPropagation();
      a.disabled = true;
      try {
        const id = a.dataset.accept || a.dataset.dismiss;
        const { workOrder } = await api(`/dispatch/suggestions/${id}`, { method: 'POST', body: { decision: a.dataset.accept ? 'accept' : 'dismiss', date: a.dataset.date || undefined } });
        toast(workOrder ? `${workOrder.ref} scheduled for ${fmtDay(workOrder.scheduled_date)}` : a.dataset.accept ? 'Suggestion accepted' : 'Suggestion dismissed');
        C.refreshBadges();
        then();
      } catch (err) { toast(err.message); a.disabled = false; }
    };
    el.addEventListener('click', el.pwSuggest);
  }

  async function staffList() {
    if (!C.state.staff) C.state.staff = (await api('/staff')).staff.filter((p) => p.active);
    return C.state.staff;
  }

  // New work order for a request: crew, date, materials and labor notes.
  async function scheduleModal(r, { crews, date, then } = {}) {
    if (!crews) crews = (await api(`/work-orders?request_id=${r.id}`)).crews;
    const today = d.board?.today || new Date().toISOString().slice(0, 10);
    const m = modal(`
      <h2>Schedule work</h2>
      <p class="muted" style="margin:0"><span class="mono">${esc(r.ref)}</span> · ${esc(r.category)} · ${esc(place(r.location))}</p>
      <div class="grid-2">
        <label class="field"><span>Crew</span><select class="select" id="woCrew"><option value="">No crew yet</option>${crews.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Date</span><input class="input" id="woDate" type="date" value="${esc(date || nextWorkday(today))}" min="${esc(today)}"></label>
      </div>
      ${crews.length ? '' : `<small class="faint">${esc(r.department)} has no crews yet. Add one from the dispatch board.</small>`}
      <label class="field"><span>Job</span><input class="input" id="woTitle" value="${esc(r.category)}" maxlength="160"></label>
      <label class="field"><span>Materials</span><input class="input" id="woMat" placeholder="e.g. 3 bags cold patch, 1 stop sign"></label>
      <label class="field"><span>Labor notes</span><textarea class="textarea" id="woLabor" rows="2" placeholder="Crew size, equipment, traffic control"></textarea></label>
      <small class="faint">The resident who reported ${esc(r.ref)} is told the date.</small>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="woSave">${icon('calendar')} Schedule</button></div>`);
    m.querySelector('#woSave').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const { workOrder } = await api('/work-orders', { method: 'POST', body: {
          request_id: r.id, crew_id: m.querySelector('#woCrew').value || null, scheduled_date: m.querySelector('#woDate').value || null,
          title: m.querySelector('#woTitle').value, materials: m.querySelector('#woMat').value, labor_notes: m.querySelector('#woLabor').value,
        } });
        m.remove();
        toast(`${workOrder.ref} ${workOrder.scheduled_date ? `scheduled for ${fmtDay(workOrder.scheduled_date)}` : 'created'}`);
        C.refreshBadges();
        then?.();
      } catch (err) { toast(err.message); e.target.disabled = false; }
    };
  }

  /* ---------------- Work order drawer ---------------- */

  async function openWorkOrder(id, then) {
    const [{ workOrder: w }] = await Promise.all([api(`/work-orders/${id}`)]);
    const { crews } = await api(`/work-orders?request_id=${w.request_id}`);
    const edit = can('dispatch.manage');
    const dr = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(w.ref)} · ${esc(w.request_ref)}</div><h2>${esc(w.title)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${pill(WO_STATUS, w.status)}${prio(w.priority)}<span class="pill">${esc(w.department)}</span>${w.crew ? `<span class="pill">${esc(w.crew)}</span>` : ''}</div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        <div class="card card-b"><div class="section-title">Location</div><p style="margin:6px 0 0">${esc(place(w.location))} · <a href="${esc(directions(w))}" target="_blank" rel="noopener">Directions</a></p>
          <p style="margin:6px 0 0"><a href="#/requests" id="woReq">Open request ${esc(w.request_ref)}</a></p></div>
        ${edit ? `<div class="field"><span>Status</span><div class="status-steps">${Object.entries(WO_STATUS).map(([k, [l]]) => `<button class="btn btn-sm ${k === w.status ? 'btn-dark' : ''}" data-st="${k}">${l}</button>`).join('')}</div></div>
        <div class="grid-2">
          <label class="field"><span>Crew</span><select class="select" id="wCrew"><option value="">No crew</option>${crews.map((c) => `<option value="${esc(c.id)}" ${c.id === w.crew_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Date</span><input class="input" type="date" id="wDate" value="${esc(w.scheduled_date || '')}"></label>
        </div>
        <label class="field"><span>Job</span><input class="input" id="wTitle" value="${esc(w.title)}" maxlength="160"></label>
        <label class="field"><span>Materials</span><input class="input" id="wMat" value="${esc(w.materials || '')}"></label>
        <div class="grid-2"><label class="field"><span>Labor notes</span><input class="input" id="wLabor" value="${esc(w.labor_notes || '')}"></label>
          <label class="field"><span>Labor hours</span><input class="input" id="wHours" type="number" min="0" step="0.25" value="${w.labor_hours ?? ''}"></label></div>
        <label class="field"><span>Completion note</span><textarea class="textarea" id="wNote" rows="2" placeholder="What was done. A note or a photo is needed to mark the job done.">${esc(w.completion_note || '')}</textarea></label>`
        : `<div class="grid-2"><div class="field"><span>Date</span><b>${esc(w.scheduled_date ? fmtDay(w.scheduled_date, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Not scheduled')}</b></div>
            <div class="field"><span>Crew</span><b>${esc(w.crew || 'No crew')}</b></div></div>
          ${[['Materials', w.materials], ['Labor notes', w.labor_notes], ['Completion note', w.completion_note]].filter(([, v]) => v).map(([k, v]) => `<div class="field"><span>${k}</span><div>${esc(v)}</div></div>`).join('')}`}
        <div class="section-title">Photos</div>
        <div class="pw-photos" id="wPhotos">${photoTiles(w)}</div>
        ${edit ? photoButtons() : ''}
      </div>
      ${edit ? '<div class="drawer-f"><div class="right"><button class="btn btn-primary" id="wSave">Save</button></div></div>' : ''}`);
    loadPhotos(dr, w);
    dr.querySelector('#woReq').onclick = (e) => { e.preventDefault(); goRequest(w.request_id); };
    if (!edit) return;
    let status = w.status;
    dr.querySelector('.status-steps').onclick = (e) => {
      const b = e.target.closest('[data-st]'); if (!b) return;
      status = b.dataset.st; $$('[data-st]', dr).forEach((x) => x.classList.toggle('btn-dark', x === b));
    };
    bindPhotoButtons(dr, w, () => openWorkOrder(id, then));
    dr.querySelector('#wSave').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const { workOrder } = await api(`/work-orders/${w.id}`, { method: 'PATCH', body: {
          status, crew_id: $('#wCrew').value || null, scheduled_date: $('#wDate').value || null, title: $('#wTitle').value,
          materials: $('#wMat').value, labor_notes: $('#wLabor').value, labor_hours: $('#wHours').value, completion_note: $('#wNote').value,
        } });
        toast(`${workOrder.ref} saved`);
        C.refreshBadges();
        closeDrawer();
        then?.();
      } catch (err) { toast(err.message); e.target.disabled = false; }
    };
  }

  const photoTiles = (w) => (w.photo_list?.length
    ? w.photo_list.map((p) => `<figure><img data-pid="${p.id}" alt="${esc(p.kind)} photo"><figcaption>${esc(p.kind === 'before' ? 'Before' : 'After')} · ${esc(p.taken_by || '')} · ${ago(p.created_at)}</figcaption></figure>`).join('')
    : '<span class="faint" style="font-size:12.5px">No photos yet.</span>');
  const photoButtons = () => `<div class="pw-photo-btns">
    <label class="btn">${icon('camera')} Before photo<input type="file" accept="image/*" capture="environment" data-kind="before" hidden></label>
    <label class="btn">${icon('camera')} After photo<input type="file" accept="image/*" capture="environment" data-kind="after" hidden></label></div>`;

  function loadPhotos(el, w) {
    $$('img[data-pid]', el).forEach((img) => {
      fetch(`${C.apiBase}/work-orders/${w.id}/photos/${img.dataset.pid}`).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b) img.src = URL.createObjectURL(b); });
    });
  }

  // Phone photos are large; shrink them to 1600 px before they go over a cell connection.
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5e6) return file;
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
    } catch {
      return file;
    }
  }

  function bindPhotoButtons(el, w, then) {
    $$('input[type=file][data-kind]', el).forEach((input) => {
      input.onchange = async () => {
        const f = input.files[0]; if (!f) return;
        const label = input.closest('label'); label.classList.add('busy');
        try {
          const fd = new FormData();
          fd.append('kind', input.dataset.kind);
          fd.append('photo', await shrink(f));
          await api(`/work-orders/${w.id}/photos`, { method: 'POST', body: fd });
          toast(`${input.dataset.kind === 'before' ? 'Before' : 'After'} photo added to ${w.ref}`);
          then();
        } catch (err) { toast(err.message); label.classList.remove('busy'); }
      };
    });
  }

  /* ---------------- Dispatch board ---------------- */

  async function renderBoard(page) {
    const qs = new URLSearchParams({ ...(d.week ? { week: d.week } : {}), ...(d.dept ? { department: d.dept } : {}) });
    const b = d.board = await api(`/dispatch/board?${qs}`);
    // Weekends only show when something is booked on them.
    const days = weekDays(b.from).filter((x, i) => i < 5 || x === b.today || b.workOrders.some((w) => w.scheduled_date === x));
    const manage = can('dispatch.manage');
    $('#pageActions').innerHTML = `
      ${b.departments.length > 1 ? `<select class="select" id="pwDept" style="width:auto" aria-label="Department"><option value="">All field departments</option>${b.departments.map((x) => `<option value="${esc(x.id)}" ${x.id === d.dept ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : ''}
      <a class="btn" href="#/worksmap">${icon('map')} Map</a>
      <button class="btn" id="pwCrews">${icon('users')} Crews</button>`;
    if (!b.departments.length) { page.innerHTML = `<div class="card">${emptyNote('truck', 'No department is set up for field work yet.')}</div>`; return; }

    const byReq = (id) => b.suggestions.filter((s) => s.request_id === id);
    const today = b.workOrders.filter((w) => w.scheduled_date === b.today);
    const overdue = b.workOrders.filter((w) => ['scheduled', 'in_progress'].includes(w.status) && w.scheduled_date && w.scheduled_date < b.today);
    const earlier = b.workOrders.filter((w) => !w.scheduled_date || w.scheduled_date < b.from);
    const rows = [...b.crews.map((c) => ({ id: c.id, name: c.name, sub: `${c.members.length} ${c.members.length === 1 ? 'person' : 'people'}${b.departments.length > 1 && !d.dept ? ` · ${c.department}` : ''}` })),
      ...(b.workOrders.some((w) => !w.crew_id) ? [{ id: null, name: 'No crew', sub: 'Needs a crew' }] : [])];
    const chip = (w) => `<button class="pw-wo s-${w.status} ${['scheduled', 'in_progress'].includes(w.status) && w.scheduled_date && w.scheduled_date < b.today ? 'late' : ''}" data-wo="${w.id}">
      <span class="mono">${esc(w.ref)}</span><b>${esc(w.title)}</b>${w.location ? `<small>${esc(place(w.location))}</small>` : ''}
      <span class="pw-wo-f">${pill(WO_STATUS, w.status)}${prio(w.priority)}${w.photos ? `<span class="pill">${icon('camera')}${w.photos}</span>` : ''}</span></button>`;

    page.innerHTML = `
      <div class="pw-kpis">
        <div><b>${today.length}</b><span>Today</span></div>
        <div><b>${today.filter((w) => w.status === 'in_progress').length}</b><span>In progress</span></div>
        <div><b>${today.filter((w) => w.status === 'done').length}</b><span>Done today</span></div>
        <div class="${overdue.length ? 'warn' : ''}"><b>${overdue.length}</b><span>Overdue</span></div>
        <div><b>${b.unscheduled.length}</b><span>Not scheduled</span></div>
      </div>
      <div class="pw-layout">
        <section class="card pw-unsched">
          <div class="card-h"><h2>Not scheduled</h2><span class="pill">${b.unscheduled.length}</span></div>
          <div class="card-b">${b.unscheduled.length ? b.unscheduled.map((r) => `
            <div class="pw-req" data-req="${r.id}">
              <div class="top"><span class="mono">${esc(r.ref)}</span>${pill(REQ_STATUS, r.status)}${prio(r.priority)}${r.photo ? '<span class="pill">Photo</span>' : ''}</div>
              <strong>${esc(r.category)}</strong>
              <p>${esc(place(r.location))}${r.located_by === 'not_found' ? ' · <span class="faint">not on map</span>' : ''}</p>
              <div class="foot"><span>${esc(r.department)}</span><span>·</span><span>${ago(r.created_at)}</span></div>
              ${suggestionBox(byReq(r.id))}
              ${manage ? `<div class="pw-req-a"><button class="btn btn-sm" data-schedule="${r.id}">${icon('calendar')} Schedule…</button></div>` : ''}
            </div>`).join('') : emptyNote('check', 'Everything reported is scheduled.')}</div>
        </section>
        <section class="card pw-week">
          <div class="card-h"><h2>${b.from === addDays(b.today, -((day(b.today).getUTCDay() + 6) % 7)) ? 'This week' : `Week of ${fmtDay(b.from, { month: 'long', day: 'numeric' })}`}</h2>
            <div class="more pw-weeknav"><button class="btn btn-sm" data-week="${addDays(b.from, -7)}" aria-label="Previous week">${icon('chevron-l')}</button>
              <button class="btn btn-sm" data-week="">Today</button><button class="btn btn-sm" data-week="${addDays(b.from, 7)}" aria-label="Next week">${icon('chevron-r')}</button></div></div>
          <div class="card-b">${rows.length ? `<div class="pw-grid" style="--cols:${days.length + (earlier.length ? 1 : 0)}">
            <div class="pw-gh"></div>${earlier.length ? '<div class="pw-gh">Earlier</div>' : ''}${days.map((x) => `<div class="pw-gh ${x === b.today ? 'today' : ''}">${esc(fmtDay(x, { weekday: 'short' }))}<small>${esc(fmtDay(x, { month: 'short', day: 'numeric' }))}</small></div>`).join('')}
            ${rows.map((row) => `<div class="pw-crew"><b>${esc(row.name)}</b><small>${esc(row.sub)}</small></div>
              ${earlier.length ? `<div class="pw-cell">${earlier.filter((w) => w.crew_id === row.id).map(chip).join('')}</div>` : ''}
              ${days.map((x) => `<div class="pw-cell ${x === b.today ? 'today' : ''}">${b.workOrders.filter((w) => w.crew_id === row.id && w.scheduled_date === x).map(chip).join('')}</div>`).join('')}`).join('')}
          </div>` : emptyNote('users', manage ? 'Add a crew to start scheduling work.' : 'No crews yet.')}</div>
        </section>
      </div>`;

    $('#pwDept')?.addEventListener('change', (e) => { d.dept = e.target.value; renderBoard(page); });
    $('#pwCrews').onclick = () => crewsModal(b, () => renderBoard(page));
    page.onclick = async (e) => {
      const wk = e.target.closest('[data-week]');
      if (wk) { d.week = wk.dataset.week; renderBoard(page); return; }
      const w = e.target.closest('[data-wo]');
      if (w) { openWorkOrder(Number(w.dataset.wo), () => renderBoard(page)); return; }
      const s = e.target.closest('[data-schedule]');
      if (s) {
        const r = b.unscheduled.find((x) => x.id === Number(s.dataset.schedule));
        scheduleModal(r, { crews: b.crews.filter((c) => c.department_id === r.department_id), then: () => renderBoard(page) });
        return;
      }
      const rq = e.target.closest('[data-req]');
      if (rq && !e.target.closest('button, a')) goRequest(Number(rq.dataset.req));
    };
    bindSuggestions(page, () => renderBoard(page));
  }

  /* ---------------- Crews ---------------- */

  async function crewsModal(b, then) {
    const [staff, { crews }] = await Promise.all([staffList(), api('/crews')]);
    const manage = can('dispatch.manage');
    const depts = b.departments;
    const m = modal(`
      <h2>Crews</h2>
      <p class="muted" style="margin:0">Named crews of people from the staff directory. Work orders are scheduled by crew.</p>
      <div class="list pw-crews">${crews.length ? crews.map((c) => `
        <div class="list-item ${manage ? 'clickable' : ''}" data-crew="${esc(c.id)}"><div class="grow"><div class="title">${esc(c.name)} ${c.active ? '' : '<span class="pill">Retired</span>'}</div>
          <div class="meta">${esc(c.department)} · ${c.members.map((x) => esc(x.name) + (x.id === c.lead_id ? ' (lead)' : '')).join(', ') || 'No members'}</div></div>${manage ? icon('pen') : ''}</div>`).join('')
        : emptyNote('users', 'No crews yet.')}</div>
      <div class="row"><button class="btn" data-close>Close</button>${manage ? `<button class="btn btn-primary" id="crNew">${icon('plus')} New crew</button>` : ''}</div>`);
    const edit = (c) => {
      m.remove();
      const deptId = c?.department_id || C.state.city.department_id || depts[0]?.id;
      const e2 = modal(`
        <h2>${c ? `Edit ${esc(c.name)}` : 'New crew'}</h2>
        <div class="grid-2"><label class="field"><span>Name</span><input class="input" id="crName" value="${esc(c?.name || '')}" placeholder="e.g. Street Crew 1" maxlength="80"></label>
          <label class="field"><span>Department</span><select class="select" id="crDept" ${C.state.city.department_id ? 'disabled' : ''}>${depts.map((x) => `<option value="${esc(x.id)}" ${x.id === deptId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label></div>
        <div class="field"><span>Members</span><div class="pw-members" id="crMembers">${staff.slice().sort((a, z) => (z.department_id === deptId) - (a.department_id === deptId) || a.name.localeCompare(z.name)).map((p) => `
          <label><input type="checkbox" value="${esc(p.id)}" ${c?.members.some((x) => x.id === p.id) ? 'checked' : ''}><span>${esc(p.name)}<small>${esc([p.title, p.department].filter(Boolean).join(' · '))}</small></span>
            <input type="radio" name="crLead" value="${esc(p.id)}" title="Crew lead" ${c?.lead_id === p.id ? 'checked' : ''}></label>`).join('') || '<span class="faint">Add people under Staff &amp; access first.</span>'}</div>
          <small>Tick the people on this crew. The round button marks the crew lead.</small></div>
        ${c ? `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="crActive" ${c.active ? 'checked' : ''}> Active</label>` : ''}
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="crSave">Save crew</button></div>`);
      e2.querySelector('#crSave').onclick = async (ev) => {
        ev.target.disabled = true;
        const members = $$('#crMembers input[type=checkbox]:checked', e2).map((x) => x.value);
        const lead = $('#crMembers input[name=crLead]:checked', e2)?.value || null;
        try {
          await api(c ? `/crews/${c.id}` : '/crews', { method: c ? 'PATCH' : 'POST', body: {
            name: $('#crName', e2).value, department_id: $('#crDept', e2).value, members, lead_id: lead,
            ...(c ? { active: $('#crActive', e2).checked } : {}),
          } });
          e2.remove(); toast('Crew saved'); then();
        } catch (err) { toast(err.message); ev.target.disabled = false; }
      };
    };
    m.querySelector('#crNew')?.addEventListener('click', () => edit(null));
    if (manage) m.querySelector('.pw-crews').onclick = (e) => { const it = e.target.closest('[data-crew]'); if (it) edit(crews.find((c) => c.id === it.dataset.crew)); };
  }

  /* ---------------- Map ---------------- */

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (!document.querySelector('link[data-leaflet]')) {
      document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${LEAFLET}/leaflet.min.css" data-leaflet>`);
    }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${LEAFLET}/leaflet.min.js`;
      s.onload = () => resolve(window.L);
      s.onerror = () => reject(new Error("The map couldn't load. Check the internet connection and try again."));
      document.head.appendChild(s);
    });
  }

  const pointState = (r) => (r.workOrders.some((w) => w.status === 'in_progress') ? 'in_progress' : r.workOrders.length ? 'scheduled' : 'unscheduled');
  const POINT = { unscheduled: ['Not scheduled', '#b42318'], scheduled: ['Scheduled', '#2450e0'], in_progress: ['In progress', '#a35f00'] };

  async function renderMap(page) {
    const qs = d.dept ? `?department=${encodeURIComponent(d.dept)}` : '';
    const [L, data] = await Promise.all([loadLeaflet(), api(`/dispatch/map${qs}`)]);
    d.mapFilter ??= '';
    $('#pageActions').innerHTML = `<a class="btn" href="#/dispatch">${icon('truck')} Dispatch board</a>`;
    const counts = Object.fromEntries(Object.keys(POINT).map((k) => [k, data.located.filter((r) => pointState(r) === k).length]));
    page.innerHTML = `
      <div class="toolbar" style="margin-top:0"><div class="chips" id="mFilter">
        <button class="chip ${!d.mapFilter ? 'on' : ''}" data-v="">All <b>${data.located.length}</b></button>
        ${Object.entries(POINT).map(([k, [l, c]]) => `<button class="chip ${d.mapFilter === k ? 'on' : ''}" data-v="${k}"><i class="pw-dot" style="background:${c}"></i>${l} <b>${counts[k]}</b></button>`).join('')}
      </div></div>
      <div class="pw-maplayout">
        <div class="card pw-map" id="pwMap"></div>
        <section class="card"><div class="card-h"><h2>No location</h2><span class="pill">${data.unlocated.length}</span></div>
          <div class="card-b"><p class="faint" style="margin:0 0 8px;font-size:12.5px">Reports without GPS whose address couldn't be placed on the map.</p>
          <div class="list">${data.unlocated.length ? data.unlocated.map((r) => `
            <div class="list-item clickable" data-req="${r.id}"><div class="grow"><div class="title">${esc(r.category)}</div>
              <div class="meta"><span class="mono">${esc(r.ref)}</span> · ${esc(r.location || 'No location given')}${r.located_by === 'pending' && r.location ? ' · finding it…' : ''}</div></div>
              ${r.workOrders.length ? pill(WO_STATUS, r.workOrders[0].status) : prio(r.priority)}</div>`).join('') : emptyNote('pin', 'Every open report is on the map.')}</div></div></section>
      </div>`;
    const map = L.map('pwMap', { scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const shown = data.located.filter((r) => !d.mapFilter || pointState(r) === d.mapFilter);
    const marks = shown.map((r) => {
      const st = pointState(r);
      return L.circleMarker([r.lat, r.lng], {
        radius: r.priority === 'urgent' ? 11 : r.priority === 'high' ? 9 : 7, color: '#fff', weight: 2, fillColor: POINT[st][1], fillOpacity: 0.9,
      }).bindPopup(`<div class="pw-pop"><span class="mono">${esc(r.ref)}</span><b>${esc(r.category)}</b><div>${esc(place(r.location))}</div>
        <div class="pw-pop-p">${pill(REQ_STATUS, r.status)}${prio(r.priority)}${r.located_by === 'geocoded' ? '<span class="pill" title="Placed from the typed address">Address</span>' : ''}</div>
        ${r.workOrders.map((w) => `<div><a href="#" data-wo="${w.id}">${esc(w.ref)}</a> ${esc(w.crew || 'No crew')} · ${esc(w.scheduled_date ? fmtDay(w.scheduled_date) : 'no date')}</div>`).join('')}
        <div class="pw-pop-a"><a href="#/requests" data-open="${r.id}">Open request</a>${!r.workOrders.length && can('dispatch.manage') ? ` · <a href="#" data-sched="${r.id}">Schedule</a>` : ''}</div></div>`).addTo(map);
    });
    if (marks.length) map.fitBounds(L.featureGroup(marks).getBounds().pad(0.2), { maxZoom: 16 });
    else map.setView([39.5, -98.35], 4);
    setTimeout(() => map.invalidateSize(), 50);
    $('#mFilter').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; d.mapFilter = c.dataset.v; renderMap(page); };
    page.onclick = (e) => {
      const o = e.target.closest('[data-open], [data-req]');
      if (o) { e.preventDefault(); goRequest(Number(o.dataset.open || o.dataset.req)); return; }
      const w = e.target.closest('[data-wo]');
      if (w) { e.preventDefault(); openWorkOrder(Number(w.dataset.wo), () => renderMap(page)); return; }
      const s = e.target.closest('[data-sched]');
      if (s) { e.preventDefault(); scheduleModal(data.located.find((r) => r.id === Number(s.dataset.sched)), { then: () => renderMap(page) }); }
    };
  }

  /* ---------------- Field view (phones) ---------------- */

  async function renderField(page) {
    const data = await api(`/field${d.fieldDate ? `?date=${d.fieldDate}` : ''}`);
    const isToday = data.date === data.today;
    $('#pageActions').innerHTML = '';
    const open = data.workOrders.filter((w) => w.status !== 'done');
    const done = data.workOrders.filter((w) => w.status === 'done');
    const job = (w) => {
      const late = w.scheduled_date < data.date;
      const contact = w.request?.contact && w.request.contact !== 'Hidden' ? w.request.contact : '';
      const tel = contact.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
      return `<article class="card pw-job s-${w.status}" data-job="${w.id}">
        <div class="pw-job-h"><span class="mono">${esc(w.ref)} · ${esc(w.request_ref)}</span>${pill(WO_STATUS, w.status)}${prio(w.priority)}${late ? `<span class="pill red">Due ${esc(fmtDay(w.scheduled_date))}</span>` : ''}</div>
        <h3>${esc(w.title)}</h3>
        <a class="pw-loc" href="${esc(directions(w))}" target="_blank" rel="noopener">${icon('pin')}<span>${esc(place(w.location))}</span><b>Directions</b></a>
        ${w.request?.description ? `<p class="pw-desc">${esc(w.request.description)}</p>` : ''}
        ${[['Materials', w.materials], ['Labor', w.labor_notes], ['Crew', !data.mine || data.crews.length > 1 ? w.crew : '']].filter(([, v]) => v).map(([k, v]) => `<div class="pw-kv"><b>${k}</b><span>${esc(v)}</span></div>`).join('')}
        ${contact ? `<div class="pw-kv"><b>Resident</b><span>${esc([w.request.name, contact].filter(Boolean).join(' · '))}${tel ? ` · <a href="tel:${esc(tel.replace(/[^\d+]/g, ''))}">Call</a>` : ''}</span></div>` : ''}
        ${w.photo_list.length ? `<div class="pw-photos">${photoTiles(w)}</div>` : ''}
        ${w.status === 'done' ? (w.completion_note ? `<div class="pw-kv"><b>Done</b><span>${esc(w.completion_note)}</span></div>` : '') : `
          ${photoButtons()}
          <textarea class="textarea" data-note rows="2" placeholder="What was done (or add a photo)">${esc(d.notes[w.id] ?? w.completion_note ?? '')}</textarea>
          <div class="pw-job-a">${w.status === 'scheduled' ? '<button class="btn btn-lg" data-act="in_progress">Start</button>' : ''}
            <button class="btn btn-primary btn-lg" data-act="done">${icon('check')} Mark done</button></div>`}
      </article>`;
    };
    page.innerHTML = `
      <div class="pw-field">
        <div class="pw-field-h">
          <button class="btn btn-sm" data-day="${addDays(data.date, -1)}" aria-label="Previous day">${icon('chevron-l')}</button>
          <div><h2>${isToday ? 'Today' : esc(fmtDay(data.date, { weekday: 'long' }))}</h2><small>${esc(fmtDay(data.date, { month: 'long', day: 'numeric' }))}${data.mine ? ` · ${esc(data.crews.join(', '))}` : ''}</small></div>
          <button class="btn btn-sm" data-day="${addDays(data.date, 1)}" aria-label="Next day">${icon('chevron-r')}</button>
        </div>
        ${!data.mine ? `<p class="faint" style="margin:0">You're not on a crew, so this shows all of your department's field work.</p>` : ''}
        ${open.length ? open.map(job).join('') : `<div class="card">${emptyNote('check', isToday ? 'Nothing left for today.' : 'Nothing scheduled.')}</div>`}
        ${done.length ? `<div class="section-title">Done</div>${done.map(job).join('')}` : ''}
      </div>`;
    loadPhotosAll(page, data.workOrders);
    page.onclick = async (e) => {
      const dy = e.target.closest('[data-day]');
      if (dy) { d.fieldDate = dy.dataset.day === data.today ? '' : dy.dataset.day; renderField(page); return; }
      const a = e.target.closest('[data-act]');
      if (!a) return;
      const card = a.closest('[data-job]');
      const w = data.workOrders.find((x) => x.id === Number(card.dataset.job));
      a.disabled = true;
      try {
        const body = { status: a.dataset.act };
        const note = card.querySelector('[data-note]')?.value.trim();
        if (note) body.completion_note = note;
        await api(`/work-orders/${w.id}`, { method: 'PATCH', body });
        delete d.notes[w.id];
        toast(a.dataset.act === 'done' ? `${w.ref} done. The resident will be told.` : `${w.ref} started`);
        renderField(page);
      } catch (err) { toast(err.message); a.disabled = false; }
    };
    // Notes typed before adding a photo survive the reload.
    const keepNotes = () => $$('[data-job]', page).forEach((c) => { const n = c.querySelector('[data-note]'); if (n) d.notes[c.dataset.job] = n.value; });
    $$('[data-job]', page).forEach((card) => bindPhotoButtons(card, data.workOrders.find((x) => x.id === Number(card.dataset.job)), () => { keepNotes(); renderField(page); }));
  }

  function loadPhotosAll(el, list) {
    for (const w of list) { const card = el.querySelector(`[data-job="${w.id}"]`); if (card) loadPhotos(card, w); }
  }

  /* ---------------- Work on a service request (request drawer) ---------------- */

  C.onRequestDrawer(async (drawer, r) => {
    if (!can('dispatch.view')) return;
    const anchor = [...drawer.querySelectorAll('.drawer-b > .section-title')].find((x) => x.textContent === 'History');
    if (!anchor) return;
    const box = document.createElement('div');
    box.className = 'pw-panel';
    anchor.before(box);
    const draw = async () => {
      let data;
      try { data = await api(`/work-orders?request_id=${r.id}`); } catch { box.remove(); return; }
      const manage = can('dispatch.manage') && !['closed'].includes(r.status);
      box.innerHTML = `<div class="section-title">Field work</div>
        ${data.workOrders.length ? `<div class="list">${data.workOrders.map((w) => `
          <div class="list-item clickable" data-wo="${w.id}"><div class="grow"><div class="title">${esc(w.title)}</div>
            <div class="meta"><span class="mono">${esc(w.ref)}</span> · ${esc(w.crew || 'No crew')} · ${esc(w.scheduled_date ? fmtDay(w.scheduled_date) : 'No date')}${w.photos ? ` · ${w.photos} photo${w.photos === 1 ? '' : 's'}` : ''}</div></div>${pill(WO_STATUS, w.status)}</div>`).join('')}</div>`
          : '<p class="faint" style="margin:0;font-size:12.5px">No work orders yet.</p>'}
        ${suggestionBox(data.suggestions)}
        ${manage ? `<div><button class="btn btn-sm" id="pwSched">${icon('calendar')} ${data.workOrders.length ? 'Add a work order' : 'Schedule work'}</button></div>` : ''}`;
      const reopen = async () => {
        const { requests } = await api('/requests');
        const fresh = requests.find((x) => x.id === r.id);
        if (fresh) C.openRequest(fresh); else closeDrawer();
      };
      box.querySelector('#pwSched')?.addEventListener('click', () => scheduleModal(r, { crews: data.crews, then: reopen }));
      box.onclick = (e) => { const w = e.target.closest('[data-wo]'); if (w) openWorkOrder(Number(w.dataset.wo), reopen); };
      bindSuggestions(box, reopen);
    };
    draw();
  });

  /* ---------------- Pages ---------------- */

  C.addPage('dispatch', { title: 'Dispatch board', sub: "Today's and this week's field work by crew", icon: 'truck', render: renderBoard, perm: 'dispatch.view' }, 'Field work');
  C.addPage('worksmap', { title: 'Work map', sub: 'Open requests and work orders', icon: 'map', render: renderMap, perm: 'dispatch.view' }, 'Field work');
  C.addPage('field', { title: 'My work', sub: 'Jobs for your crew', icon: 'check', render: renderField, perm: 'dispatch.manage' }, 'Field work');
  C.addAuditType('work_order', 'Work orders');
  C.addAuditType('crew', 'Crews');
})(window.CHOS);
