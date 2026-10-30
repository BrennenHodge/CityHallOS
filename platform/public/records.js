/* City Hall OS staff dashboard: public records requests. Adds the "Public records" page through window.CHOS (dashboard.js). */
(() => {
  const k = window.CHOS;
  const { api, esc, icon, pill, fmt, ago, toDate, toast, modal, openDrawer, emptyNote, kpi, can } = k;
  const state = k.state;
  const bytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${Math.round(n / 1e3)} KB` : n ? `${n} B` : '');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const STATUS = { new: ['New', 'blue'], acknowledged: ['Acknowledged', 'violet'], in_progress: ['Gathering records', 'amber'], awaiting_payment: ['Awaiting payment', 'amber'],
    ready: ['Ready to release', 'green'], closed: ['Closed', ''] };
  const OUTCOME = { fulfilled: ['Released', 'green'], partial: ['Released in part', 'amber'], denied: ['Denied', 'red'], no_records: ['No records', ''], withdrawn: ['Withdrawn', ''] };
  const DEADLINE = { overdue: 'red', due_soon: 'amber', on_track: '' };
  const FORMATS = { electronic: 'Electronic copies', paper: 'Paper copies', inspection: 'Inspect in person' };
  const LETTERS = { acknowledgment: 'Acknowledgment', extension: 'Extension notice', fee_estimate: 'Fee estimate', response: 'Response', denial: 'Denial', other: 'Letter' };
  const FILE_STATUS = { review: ['Needs review', 'amber'], approved: ['Approved for release', 'green'], withheld: ['Withheld', 'red'], released: ['Released', 'blue'] };
  const money = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
  const day = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const view = { filter: 'open', q: '', data: null, openId: null };

  const style = document.createElement('style');
  style.textContent = `
    .rec-banner { display:flex; gap:10px; align-items:center; padding:12px 14px; border-radius:12px; background:var(--amber-soft); border:1px solid #f1d9a6; margin-bottom:14px; font-size:13.5px }
    .rec-text { white-space:pre-wrap; margin:6px 0 0 }
    .rec-flags { display:grid; gap:6px; margin-top:8px }
    .rec-flag { display:grid; grid-template-columns:1fr auto; gap:8px; align-items:center; font-size:12.5px; padding:6px 8px; border-radius:8px; background:var(--paper-2) }
    .rec-flag small { display:block; color:var(--muted); font-family:"JetBrains Mono",ui-monospace,monospace; font-size:11.5px; word-break:break-all }
    .rec-item { border:1px solid var(--line); border-radius:12px; padding:12px; display:grid; gap:8px }
    .rec-item .head { display:flex; gap:8px; align-items:center; flex-wrap:wrap }
    .rec-item .head strong { margin-right:auto; min-width:0; overflow-wrap:anywhere }
    .rec-btns { display:flex; gap:6px; flex-wrap:wrap }
    .rec-due { font-weight:600 }
    .rec-checks { display:grid; gap:6px; max-height:200px; overflow:auto; padding:8px; border:1px solid var(--line-2); border-radius:10px }
    .rec-checks label { display:flex; gap:8px; align-items:flex-start; font-size:13px }
    .rec-section { display:grid; gap:10px }
  `;
  document.head.appendChild(style);

  const deadlinePill = (r) => {
    const d = r.deadline;
    if (!d || d.state === 'closed') return r.outcome ? pill(OUTCOME, r.outcome) : '';
    const words = d.left < 0 ? `${-d.left} working ${d.left === -1 ? 'day' : 'days'} overdue` : d.left === 0 ? 'Due today' : `${d.left} working ${d.left === 1 ? 'day' : 'days'} left`;
    return `<span class="pill ${DEADLINE[d.state]}"><span class="dot"></span>${esc(words)}</span>`;
  };

  /* ---------------- Queue ---------------- */

  async function renderRecords(page) {
    const data = await api('/records');
    view.data = data;
    const manage = can('records.manage');
    $('#pageActions').innerHTML = [
      can('settings.edit') ? `<button class="btn" id="recSettings">${icon('gear')} Rules &amp; fees</button>` : '',
      manage ? `<a class="btn" href="${k.API}/records/export?format=csv" download>${icon('file')} Export log</a>` : '',
      manage ? `<button class="btn btn-primary" id="recNew">${icon('plus')} Log a request</button>` : '',
    ].join('');
    $('#recSettings')?.addEventListener('click', settingsModal);
    $('#recNew')?.addEventListener('click', newRequestModal);
    const rs = data.requests;
    const open = rs.filter((r) => r.status !== 'closed');
    const soon = open.filter((r) => r.deadline.state === 'due_soon');
    const late = open.filter((r) => r.deadline.state === 'overdue');
    const year = String(new Date().getFullYear());
    const s = data.settings;
    page.innerHTML = `
      ${!s.confirmed ? `<div class="rec-banner">${icon('alert')}<div><b>Confirm your state's response deadline.</b> Requests are counted at ${s.responseDays} working days until an administrator confirms the rule under Rules &amp; fees.</div></div>` : ''}
      ${late.length ? `<div class="rec-banner" style="background:var(--red-soft);border-color:#f4c7c2">${icon('alert')}<div><b>${late.length} ${late.length === 1 ? 'request is' : 'requests are'} past the response deadline.</b> Respond, or send a written extension notice with the reason.</div></div>` : ''}
      <div class="kpis">
        ${kpi('file', 'Open requests', fmt(open.length), `Respond within ${s.responseDays} working days${s.statute ? ` (${esc(s.statute)})` : ''}`)}
        ${kpi('alert', 'Due soon', fmt(soon.length), `Within ${s.warnDays} working ${s.warnDays === 1 ? 'day' : 'days'}`)}
        ${kpi('alert', 'Overdue', fmt(late.length), 'Past the response date')}
        ${kpi('check', `Closed in ${year}`, fmt(rs.filter((r) => r.closed_at?.startsWith(year)).length), `${fmt(rs.filter((r) => r.received_at.startsWith(year)).length)} received this year`)}
      </div>
      <div class="toolbar">
        <div class="search">${icon('search')}<input class="input" id="recQ" placeholder="Search by number, name or records" value="${esc(view.q)}"></div>
        <div class="chips" id="recTabs">${[['open', 'Open'], ['due', 'Due soon & overdue'], ['closed', 'Closed'], ['all', 'All']].map(([v, l]) => `<button class="chip ${view.filter === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
      </div>
      <div class="card" style="overflow:hidden"><table class="table">
        <thead><tr><th>Request</th><th class="hide-sm">Requester</th><th class="hide-sm">Received</th><th>Due</th><th>Status</th></tr></thead>
        <tbody id="recRows"></tbody></table></div>`;
    $('#recQ').oninput = (e) => { view.q = e.target.value; drawRows(); };
    $('#recTabs').onclick = (e) => { const c = e.target.closest('.chip'); if (!c) return; view.filter = c.dataset.v; $$('#recTabs .chip').forEach((x) => x.classList.toggle('on', x === c)); drawRows(); };
    $('#recRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openRecord(Number(tr.dataset.id)); };
    drawRows();
    if (view.openId) openRecord(view.openId);
  }

  function drawRows() {
    const q = view.q.toLowerCase();
    const rows = view.data.requests.filter((r) => ({
      open: r.status !== 'closed', closed: r.status === 'closed', all: true, due: ['due_soon', 'overdue'].includes(r.deadline.state),
    }[view.filter]) && (!q || `${r.ref} ${r.name} ${r.records} ${r.summary || ''} ${r.organization || ''}`.toLowerCase().includes(q)));
    $('#recRows').innerHTML = rows.length ? rows.map((r) => `
      <tr data-id="${r.id}">
        <td><strong class="mono">${esc(r.ref)}</strong><div class="faint" style="font-size:12.5px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.summary || r.records)}</div>
          ${r.pending_suggestions ? `<span class="pill violet" style="margin-top:4px">${icon('spark')} ${r.pending_suggestions} AI ${r.pending_suggestions === 1 ? 'suggestion' : 'suggestions'}</span>` : ''}</td>
        <td class="hide-sm">${esc(r.name)}${r.organization ? `<div class="faint" style="font-size:12.5px">${esc(r.organization)}</div>` : ''}</td>
        <td class="hide-sm muted">${esc(day(r.received_at.slice(0, 10)))}</td>
        <td><div class="rec-due">${esc(day(r.extended_due || r.due_date))}</div>${deadlinePill(r)}</td>
        <td>${pill(STATUS, r.status)}${r.assignee ? `<div class="faint" style="font-size:12.5px;margin-top:4px">${esc(r.assignee)}</div>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="5">${emptyNote('file', view.filter === 'open' ? 'No open records requests.' : 'Nothing matches.')}</td></tr>`;
  }

  /* ---------------- One request ---------------- */

  async function openRecord(id) {
    view.openId = id;
    const d = openDrawer('<div class="drawer-b"><div class="spin"></div></div>');
    try {
      draw(await api(`/records/${id}`));
    } catch (e) {
      d.innerHTML = `<div class="drawer-b"><div class="empty">${icon('alert')}<div>${esc(e.message)}</div></div></div>`;
      view.openId = null;
    }
  }

  async function act(path, opts, msg) {
    try {
      const data = await api(`/records/${view.openId}${path}`, opts);
      if (msg) toast(msg);
      draw(data);
      refreshBadge();
      return data;
    } catch (e) { toast(e.message); return null; }
  }

  function draw(data) {
    const { request: r, events, files, letters, suggestions, settings } = data;
    view.current = data;
    const manage = can('records.manage');
    const closed = r.status === 'closed';
    const pending = suggestions.filter((s) => s.status === 'pending');
    const approvedLetters = letters.filter((l) => ['response', 'denial'].includes(l.kind) && l.status === 'approved');
    const d = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(r.ref)}</div><h2>Public records request</h2>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${pill(STATUS, r.status)}${r.outcome ? pill(OUTCOME, r.outcome) : ''}${deadlinePill(r)}<span class="pill">${esc(FORMATS[r.format])}</span><span class="pill">Via ${esc(r.source)}</span></div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        <div class="facts">
          <div class="fact"><small>Received</small><b>${esc(day(r.received_at.slice(0, 10)))}</b></div>
          <div class="fact"><small>Response due</small><b>${esc(day(r.extended_due || r.due_date))}</b></div>
          <div class="fact"><small>Fee</small><b>${r.fee_status === 'none' ? '—' : r.fee_status === 'waived' ? 'Waived' : `${money(r.fee_cents)} · ${esc(r.fee_status)}`}</b></div>
        </div>
        ${r.extended_due ? `<div class="card card-b"><div class="section-title">Extended from ${esc(day(r.due_date))}</div><p class="rec-text">${esc(r.extension_reason)}</p></div>` : ''}

        <div class="card card-b"><div class="section-title">Records requested</div><p class="rec-text">${esc(r.records)}</p>
          ${r.date_from || r.date_to ? `<p style="margin:8px 0 0"><b>Dates:</b> ${esc(r.date_from || 'any')} to ${esc(r.date_to || 'present')}</p>` : ''}
          <p style="margin:6px 0 0"><b>Requester:</b> ${esc([r.name, r.organization].filter(Boolean).join(', '))}${r.email || r.phone || r.address ? ` · ${esc([r.email, r.phone, r.address].filter(Boolean).join(' · '))}` : ''}</p>
          ${data.trackUrl ? `<p style="margin:6px 0 0"><a href="${esc(data.trackUrl)}" target="_blank" rel="noopener">${icon('external')} Requester's tracking page</a></p>` : ''}
          ${r.convo_id ? `<p style="margin:6px 0 0"><a href="#/conversations" data-convo="${esc(r.convo_id)}">View the chat conversation</a></p>` : ''}
          ${manage && !closed ? `<label class="field" style="margin-top:10px"><span>Scope, as staff understand it</span><textarea class="textarea" id="recSummary" rows="2" placeholder="e.g. Board of Aldermen minutes, Jan–Jun 2025">${esc(r.summary || '')}</textarea><small>Used to search for records and in letters.</small></label>` : r.summary ? `<p style="margin:8px 0 0"><b>Scope:</b> ${esc(r.summary)}</p>` : ''}
        </div>

        ${manage && !closed ? `<div class="grid-2">
          <label class="field"><span>Assigned to</span><select class="select" id="recAssignee"><option value="">Unassigned</option>${(state.staff || []).map((p) => `<option value="${esc(p.id)}" ${p.id === r.assignee_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Status</span><select class="select" id="recStatus">${Object.entries(STATUS).filter(([kk]) => kk !== 'closed').map(([kk, [l]]) => `<option value="${kk}" ${kk === r.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Note</span><input class="input" id="recNote" placeholder="Internal: visible to staff only"></label>
        <div class="rec-btns"><button class="btn btn-primary btn-sm" id="recSave">Save</button><button class="btn btn-sm" id="recExtend">${icon('refresh')} Extend the deadline</button></div>` : `<div class="grid-2"><div class="field"><span>Assigned to</span><b>${esc(r.assignee || 'Unassigned')}</b></div></div>`}

        <div class="rec-section"><div class="section-title" style="display:flex;align-items:center;gap:8px">Likely responsive documents ${manage && !closed ? `<button class="btn btn-sm" id="recFind" style="margin-left:auto">${icon('spark')} Search the knowledge base</button>` : ''}</div>
          ${pending.length ? pending.map((s) => `<div class="rec-item"><div class="head"><strong>${esc(s.payload.title)}</strong><span class="pill violet">${icon('spark')} AI suggestion</span>${s.payload.visibility === 'internal' ? `<span class="pill">${icon('lock')} Staff only</span>` : ''}</div>
              <div class="faint" style="font-size:12.5px">${esc(s.payload.category)}${s.payload.as_of ? ` · ${esc(s.payload.as_of)}` : ''}${s.payload.heading ? ` · ${esc(s.payload.heading)}` : ''}</div>
              <div style="font-size:13px">${esc(s.payload.excerpt)}…</div>
              ${manage && !closed ? `<div class="rec-btns"><button class="btn btn-sm" data-sug="${s.id}" data-d="accepted">${icon('check')} Add to this request</button><button class="btn btn-sm btn-ghost" data-sug="${s.id}" data-d="rejected">Not responsive</button></div>` : ''}</div>`).join('')
            : `<div class="faint" style="font-size:13px">${suggestions.length ? 'No suggestions waiting.' : 'No suggestions yet.'} The AI only suggests; staff decide what is responsive.</div>`}
        </div>

        <div class="rec-section"><div class="section-title" style="display:flex;align-items:center;gap:8px">Records gathered (${files.length}) ${manage && !closed ? `<button class="btn btn-sm" id="recUpload" style="margin-left:auto">${icon('upload')} Add files</button><input type="file" id="recFile" multiple hidden>` : ''}</div>
          ${files.length ? files.map(fileHtml).join('') : '<div class="faint" style="font-size:13px">Add the records you found, or accept a suggestion above. Each file is checked for information that may need redacting.</div>'}
        </div>

        ${manage && !closed ? feeHtml(r, settings) : ''}

        <div class="rec-section"><div class="section-title" style="display:flex;align-items:center;gap:8px">Letters to the requester
          ${manage && !closed ? `<select class="select" id="recDraftKind" style="margin-left:auto;width:auto"><option value="acknowledgment">Acknowledgment</option><option value="response">Response (records released)</option><option value="denial">Denial or partial denial</option><option value="fee_estimate">Fee estimate</option></select><button class="btn btn-sm" id="recDraft">${icon('spark')} Draft</button>` : ''}</div>
          ${letters.length ? letters.map((l) => letterHtml(l, manage && !closed)).join('') : '<div class="faint" style="font-size:13px">Nothing has been sent. Every letter is a draft until a staff member approves and sends it.</div>'}
        </div>

        ${manage && !closed ? `<div class="card card-b rec-section"><div class="section-title">Release and close</div>
          <div class="grid-2">
            <label class="field"><span>Outcome</span><select class="select" id="relOutcome"><option value="fulfilled">Release the approved records</option><option value="partial">Release in part, withhold the rest</option><option value="denied">Deny the request</option><option value="no_records">No responsive records</option><option value="withdrawn">Requester withdrew</option></select></label>
            <label class="field"><span>Letter to send</span><select class="select" id="relLetter">${approvedLetters.length ? approvedLetters.map((l) => `<option value="${l.id}">${esc(LETTERS[l.kind])}: ${esc(l.subject)}</option>`).join('') : '<option value="">Approve a response or denial letter first</option>'}</select></label>
          </div>
          <div id="relExempt" hidden><div class="field"><span>Exemptions relied on (required for withheld records)</span>${exemptionPicker(settings, 'rel')}</div>
            <label class="field"><span>Explanation</span><textarea class="textarea" id="relReason" rows="2"></textarea></label></div>
          <small class="faint">${files.filter((f) => f.status === 'approved').length} approved ${files.filter((f) => f.status === 'approved').length === 1 ? 'file' : 'files'} will be released to the requester's download link. Nothing else leaves City Hall.</small>
          <div class="rec-btns"><button class="btn btn-primary" id="relGo">${icon('send')} Release and close</button></div></div>` : ''}

        <div class="section-title">History</div>
        <div class="timeline">${events.slice().reverse().map((h) => `<div class="tl"><i></i><div><b>${esc(h.note || h.kind)}</b><small>${esc(h.by)}${h.actor_type === 'ai' ? ' (AI)' : ''} · ${toDate(h.at).toLocaleString()}${h.public ? ' · shown to requester' : ''}</small></div></div>`).join('')}</div>
      </div>`);
    d.querySelector('[data-convo]')?.addEventListener('click', (e) => { state.convoId = e.target.dataset.convo; });
    if (!manage) return;
    if (!state.staff) api('/staff').then((x) => { state.staff = x.staff.filter((p) => p.active); if (view.current === data && !closed) draw(data); }).catch(() => {});
    wire(d, data);
  }

  function fileHtml(f) {
    const editable = can('records.manage') && view.current.request.status !== 'closed';
    return `<div class="rec-item" data-file="${f.id}">
      <div class="head"><strong>${esc(f.name)}</strong>${pill(FILE_STATUS, f.status)}<span class="pill">${esc(bytes(f.bytes) || '0 B')}</span>${f.source === 'knowledge' ? '<span class="pill">From knowledge base</span>' : ''}</div>
      ${f.flags.length ? `<div class="rec-flags">${f.flags.map((x, i) => `<div class="rec-flag"><div><b>${esc(x.label)}</b>${x.count > 1 ? ` · ${x.count} found` : ''}${x.examples.map((e) => `<small>${esc(e)}</small>`).join('')}</div>
        ${editable && f.status !== 'released' ? `<select class="select" data-flag="${i}" style="width:auto;font-size:12.5px;padding:4px 8px"><option value="pending" ${x.status === 'pending' ? 'selected' : ''}>Possible redaction</option><option value="redacted" ${x.status === 'redacted' ? 'selected' : ''}>Redacted in this file</option><option value="not_needed" ${x.status === 'not_needed' ? 'selected' : ''}>Not needed</option></select>` : `<span class="pill">${esc({ pending: 'Not reviewed', redacted: 'Redacted', not_needed: 'Not needed' }[x.status])}</span>`}</div>`).join('')}</div>`
        : '<div class="faint" style="font-size:12.5px">No Social Security numbers, account numbers or personal contact details found. Still read it before approving.</div>'}
      ${f.reviewed_by ? `<div class="faint" style="font-size:12px">Reviewed by ${esc(f.reviewed_by)} ${ago(f.reviewed_at)}</div>` : ''}
      <div class="rec-btns">
        <button class="btn btn-sm" data-open-file="${f.id}">${icon('external')} Open</button>
        ${editable && f.status !== 'released' ? `${f.status !== 'approved' ? `<button class="btn btn-sm" data-file-status="approved">${icon('check')} Approve for release</button>` : ''}
          ${f.status !== 'withheld' ? '<button class="btn btn-sm" data-file-status="withheld">Withhold</button>' : ''}
          ${f.status !== 'review' ? '<button class="btn btn-sm btn-ghost" data-file-status="review">Back to review</button>' : ''}
          <button class="btn btn-sm btn-ghost" data-file-remove title="If you redacted a copy, upload it and remove this one">${icon('trash')} Remove</button>` : ''}
      </div></div>`;
  }

  function feeHtml(r, s) {
    const f = s.fees;
    const rates = [['searchHourly', 'search', 'hour'], ['reviewHourly', 'review', 'hour'], ['perPage', 'copies', 'page'], ['perMedia', 'media', 'item'], ['mailing', 'mailing', 'package']]
      .filter(([kk]) => f[kk] > 0).map(([kk, l, u]) => `${l} ${money(f[kk] * 100)}/${u}`);
    return `<div class="card card-b rec-section"><div class="section-title">Fee (actual cost${s.feeStatute ? `, ${esc(s.feeStatute)}` : ''})</div>
      ${r.fee_status !== 'none' ? `<div>${r.fee_status === 'waived' ? '<b>Fees waived.</b>' : `<b>${money(r.fee_cents)}</b> · ${esc({ estimated: 'estimate not sent yet', requested: 'payment requested', paid: `paid ${money(r.paid_cents)}` }[r.fee_status])}`}
        ${r.fee_lines.length ? `<div class="faint" style="font-size:12.5px;margin-top:4px">${r.fee_lines.map((l) => `${esc(l.label)}: ${l.qty} × ${money(l.rate * 100)} = ${money(l.cents)}`).join('<br>')}</div>` : ''}</div>` : ''}
      ${rates.length ? `<small class="faint">City rates: ${esc(rates.join(' · '))}</small>` : '<small class="faint">No fee schedule set. An administrator sets it under Rules &amp; fees.</small>'}
      ${!['paid', 'waived'].includes(r.fee_status) ? `<div class="grid-2">
        <label class="field"><span>Search time (hours)</span><input class="input" id="feeSearch" type="number" min="0" step="0.25"></label>
        <label class="field"><span>Review time (hours)</span><input class="input" id="feeReview" type="number" min="0" step="0.25"></label>
        <label class="field"><span>Pages copied</span><input class="input" id="feePages" type="number" min="0" step="1"></label>
        <label class="field"><span>USB drives or discs</span><input class="input" id="feeMedia" type="number" min="0" step="1"></label>
      </div>
      <label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="feeMail"> Mail the copies</label>
      <div class="rec-btns"><button class="btn btn-sm" id="feeEst">Estimate and draft the letter</button><button class="btn btn-sm btn-ghost" id="feeWaive">Waive fees</button>
        ${r.fee_status === 'requested' ? `<button class="btn btn-sm" id="feePaid">${icon('check')} Record payment</button>` : ''}</div>` : ''}
    </div>`;
  }

  function letterHtml(l, editable) {
    const can2 = editable && ['draft', 'approved'].includes(l.status);
    return `<div class="rec-item" data-letter="${l.id}">
      <div class="head"><strong>${esc(LETTERS[l.kind])}</strong>
        ${l.drafted_by === 'ai' ? `<span class="pill violet">${icon('spark')} AI draft</span>` : ''}
        <span class="pill ${{ draft: 'amber', approved: 'blue', sent: 'green' }[l.status] || ''}">${esc({ draft: 'Draft', approved: `Approved by ${l.approved_by}`, sent: `Sent ${ago(l.sent_at)}` }[l.status] || l.status)}</span></div>
      ${can2 ? `<input class="input" data-subject value="${esc(l.subject)}"><textarea class="textarea" data-body rows="8">${esc(l.body)}</textarea>
        <div class="rec-btns">
          ${l.status === 'draft' ? `<button class="btn btn-sm" data-letter-act="approve">${icon('check')} Approve</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-letter-act="save">Save edits</button>
          ${l.status === 'approved' && ['acknowledgment', 'fee_estimate'].includes(l.kind) ? `<button class="btn btn-sm btn-primary" data-letter-act="send">${icon('send')} Send to requester</button>` : ''}
          ${l.status === 'approved' && ['response', 'denial'].includes(l.kind) ? '<small class="faint">Sent with the records when you release.</small>' : ''}
          <button class="btn btn-sm btn-ghost" data-letter-act="discard">${icon('trash')} Discard</button>
        </div>` : `<div style="font-weight:600;font-size:13.5px">${esc(l.subject)}</div><div class="rec-text" style="font-size:13px">${esc(l.body)}</div>`}
    </div>`;
  }

  function exemptionPicker(s, id) {
    return `<div class="rec-checks" id="${id}Checks">${(s.exemptions || []).map((x) => `<label><input type="checkbox" value="${esc(x)}"> <span>${esc(x)}</span></label>`).join('')}
      <input class="input" id="${id}Other" placeholder="Another exemption: cite the statute"></div>`;
  }
  const exemptions = (root, id) => [...$$(`#${id}Checks input[type=checkbox]:checked`, root).map((c) => c.value), $(`#${id}Other`, root)?.value.trim()].filter(Boolean);

  function wire(d, data) {
    const r = data.request;
    $('#recSave', d)?.addEventListener('click', () => act('', { method: 'PATCH', body: { assignee_id: $('#recAssignee', d).value || null, status: $('#recStatus', d).value, summary: $('#recSummary', d).value, note: $('#recNote', d).value } }, `${r.ref} saved`));
    $('#recExtend', d)?.addEventListener('click', () => extendModal(data));
    $('#recFind', d)?.addEventListener('click', async (e) => {
      e.target.closest('button').disabled = true;
      const res = await act('/find', { method: 'POST' });
      if (res) toast(res.added ? `${res.added} possible ${res.added === 1 ? 'document' : 'documents'} found` : 'Nothing new found in the knowledge base');
    });
    $$('[data-sug]', d).forEach((b) => b.addEventListener('click', () => act(`/suggestions/${b.dataset.sug}`, { method: 'POST', body: { decision: b.dataset.d } }, b.dataset.d === 'accepted' ? 'Added. Review it for redactions.' : 'Marked not responsive')));
    $('#recUpload', d)?.addEventListener('click', () => $('#recFile', d).click());
    $('#recFile', d)?.addEventListener('change', async (e) => {
      const fd = new FormData();
      [...e.target.files].forEach((f) => fd.append('file', f));
      toast('Uploading and checking for redactions…');
      await act('/files', { method: 'POST', body: fd }, 'Added for review');
    });
    $$('[data-file]', d).forEach((el) => {
      const fid = el.dataset.file;
      const flags = () => $$('[data-flag]', el).map((s) => s.value);
      $('[data-open-file]', el).onclick = async () => {
        const res = await fetch(`${k.API}/records/${r.id}/files/${fid}`);
        if (!res.ok) { toast('Could not open the file'); return; }
        window.open(URL.createObjectURL(await res.blob()), '_blank');
      };
      $$('[data-flag]', el).forEach((s) => s.addEventListener('change', () => act(`/files/${fid}`, { method: 'PATCH', body: { flags: flags() } })));
      $$('[data-file-status]', el).forEach((b) => b.addEventListener('click', () => act(`/files/${fid}`, { method: 'PATCH', body: { status: b.dataset.fileStatus, flags: flags() } })));
      $('[data-file-remove]', el)?.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.innerHTML = `${icon('trash')} Click again to remove`; return; }
        act(`/files/${fid}`, { method: 'DELETE' }, 'File removed');
      });
    });
    const num = (id) => $(id, d)?.value || 0;
    $('#feeEst', d)?.addEventListener('click', () => act('/fee', { method: 'POST', body: { searchHours: num('#feeSearch'), reviewHours: num('#feeReview'), pages: num('#feePages'), media: num('#feeMedia'), mailing: $('#feeMail', d).checked } }, 'Estimate saved. Review the fee letter below.'));
    $('#feeWaive', d)?.addEventListener('click', () => act('/fee', { method: 'POST', body: { action: 'waive' } }, 'Fees waived'));
    $('#feePaid', d)?.addEventListener('click', () => paidModal(r));
    $('#recDraft', d)?.addEventListener('click', async (e) => {
      const kind = $('#recDraftKind', d).value;
      if (kind === 'denial') { denialDraftModal(data); return; }
      e.target.closest('button').disabled = true;
      toast('Drafting…');
      await act('/draft', { method: 'POST', body: { kind } }, 'Draft ready. Read it before approving.');
    });
    $$('[data-letter]', d).forEach((el) => {
      const lid = el.dataset.letter;
      const text = () => ({ subject: $('[data-subject]', el)?.value, body: $('[data-body]', el)?.value });
      $$('[data-letter-act]', el).forEach((b) => b.addEventListener('click', async () => {
        const a = b.dataset.letterAct;
        if (a === 'approve') await act(`/letters/${lid}`, { method: 'PATCH', body: { ...text(), status: 'approved' } }, 'Approved');
        if (a === 'save') await act(`/letters/${lid}`, { method: 'PATCH', body: text() }, 'Saved. Edited letters need approval again.');
        if (a === 'discard') await act(`/letters/${lid}`, { method: 'PATCH', body: { status: 'discarded' } }, 'Discarded');
        if (a === 'send') {
          if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.innerHTML = `${icon('send')} Click again to send`; return; }
          await act(`/letters/${lid}/send`, { method: 'POST' }, 'Sent to the requester');
        }
      }));
    });
    const outcome = $('#relOutcome', d);
    if (outcome) {
      const sync = () => { $('#relExempt', d).hidden = !['partial', 'denied'].includes(outcome.value); };
      outcome.onchange = sync; sync();
      $('#relGo', d).addEventListener('click', async (e) => {
        const b = e.target.closest('button');
        if (!b.dataset.confirm) { b.dataset.confirm = '1'; b.innerHTML = `${icon('send')} Click again: this sends to the requester`; return; }
        await act('/release', { method: 'POST', body: { outcome: outcome.value, letterId: $('#relLetter', d).value || null, exemptions: exemptions(d, 'rel'), reason: $('#relReason', d).value } }, `${r.ref} closed`);
        renderRecords($('#page'));
      });
    }
  }

  function extendModal(data) {
    const { request: r, settings: s } = data;
    const m = modal(`
      <h2>Extend the response date</h2>
      <p class="muted" style="margin:0">${s.statute ? `${esc(s.statute)} allows up to ${s.extensionDays} working days from receipt when the requester gets a written explanation. ${esc(s.extensionNote || '')}` : 'Explain the delay to the requester in writing.'}</p>
      <label class="field"><span>Why the records can't be produced by ${esc(day(r.extended_due || r.due_date))}</span><textarea class="textarea" id="exReason" rows="4" placeholder="e.g. The records are stored off site and must be retrieved and reviewed for exempt information."></textarea><small>The requester receives this text.</small></label>
      <div class="grid-2"><label class="field"><span>New date (optional)</span><input class="input" id="exDue" type="date"><small>Leave empty for the latest date the rule allows.</small></label>
        <label class="field" style="align-self:center"><span></span><label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="exAgreed"> The requester agreed to a later date</label></label></div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="exGo">${icon('send')} Extend and notify</button></div>`);
    $('#exGo', m).onclick = async () => {
      const res = await act('/extend', { method: 'POST', body: { reason: $('#exReason', m).value, due: $('#exDue', m).value || null, agreed: $('#exAgreed', m).checked } }, 'Extended. The requester was sent the explanation.');
      if (res) m.remove();
    };
  }

  function denialDraftModal(data) {
    const m = modal(`
      <h2>Draft a denial letter</h2>
      <p class="muted" style="margin:0">A denial must be in writing and cite the specific exemption${data.settings.statute ? ` (${esc(data.settings.statute)}(3))` : ''}.</p>
      <label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="dnPartial"> Partial: some records are released</label>
      <div class="field"><span>Exemptions</span>${exemptionPicker(data.settings, 'dn')}</div>
      <label class="field"><span>Explanation (optional)</span><textarea class="textarea" id="dnReason" rows="3"></textarea></label>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="dnGo">${icon('spark')} Draft</button></div>`);
    $('#dnGo', m).onclick = async () => {
      const ex = exemptions(m, 'dn');
      if (!ex.length) { toast('Choose or type the exemption'); return; }
      $('#dnGo', m).disabled = true;
      const res = await act('/draft', { method: 'POST', body: { kind: 'denial', partial: $('#dnPartial', m).checked, exemptions: ex, reason: $('#dnReason', m).value } }, 'Draft ready. Read it before approving.');
      if (res) m.remove(); else $('#dnGo', m).disabled = false;
    };
  }

  function paidModal(r) {
    const m = modal(`
      <h2>Record payment</h2>
      <div class="grid-2"><label class="field"><span>Amount received</span><input class="input" id="pdAmt" type="number" min="0" step="0.01" value="${(r.fee_cents / 100).toFixed(2)}"></label>
        <label class="field"><span>Receipt or note</span><input class="input" id="pdNote" placeholder="e.g. Check 1042, receipt 5531"></label></div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="pdGo">${icon('check')} Record payment</button></div>`);
    $('#pdGo', m).onclick = async () => { if (await act('/fee', { method: 'POST', body: { action: 'paid', amount: $('#pdAmt', m).value, note: $('#pdNote', m).value } }, 'Payment recorded')) m.remove(); };
  }

  /* ---------------- New request and settings ---------------- */

  function newRequestModal() {
    const m = modal(`
      <h2>Log a records request</h2>
      <p class="muted" style="margin:0">For requests received by email, mail, phone or at the counter. The deadline counts from the date received.</p>
      <label class="field"><span>Records requested</span><textarea class="textarea" id="nrRecords" rows="3"></textarea></label>
      <div class="grid-2">
        <label class="field"><span>From date</span><input class="input" id="nrFrom" type="date"></label>
        <label class="field"><span>To date</span><input class="input" id="nrTo" type="date"></label>
        <label class="field"><span>Format</span><select class="select" id="nrFormat">${Object.entries(FORMATS).map(([kk, l]) => `<option value="${kk}">${l}</option>`).join('')}</select></label>
        <label class="field"><span>Received by</span><select class="select" id="nrSource"><option value="email">Email</option><option value="mail">Mail</option><option value="counter">At the counter</option><option value="phone">Phone</option></select></label>
        <label class="field"><span>Date received</span><input class="input" id="nrReceived" type="date" value="${view.data?.today || new Date().toISOString().slice(0, 10)}"></label>
        <label class="field"><span>Requester name</span><input class="input" id="nrName"></label>
        <label class="field"><span>Email</span><input class="input" id="nrEmail" type="email"></label>
        <label class="field"><span>Phone</span><input class="input" id="nrPhone"></label>
        <label class="field"><span>Mailing address</span><input class="input" id="nrAddress"></label>
        <label class="field"><span>Organization (optional)</span><input class="input" id="nrOrg"></label>
      </div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="nrGo">Create request</button></div>`);
    $('#nrGo', m).onclick = async () => {
      const v = (id) => $(id, m).value.trim();
      try {
        const res = await api('/records', { method: 'POST', body: { records: v('#nrRecords'), date_from: v('#nrFrom'), date_to: v('#nrTo'), format: v('#nrFormat'), source: v('#nrSource'), received: v('#nrReceived'),
          name: v('#nrName'), email: v('#nrEmail'), phone: v('#nrPhone'), address: v('#nrAddress'), organization: v('#nrOrg') } });
        m.remove(); toast(`${res.ref} created. Due ${day(res.due)}.`); refreshBadge(); renderRecords($('#page'));
      } catch (e) { toast(e.message); }
    };
  }

  async function settingsModal() {
    const s = await api('/records/settings');
    const f = s.fees;
    const m = modal(`
      <h2>Records rules &amp; fees</h2>
      <p class="muted" style="margin:0">Response deadlines are set by state law. The defaults for ${esc(k.state.city.state)} are filled in; check them with the city attorney.</p>
      <div class="grid-2">
        <label class="field"><span>Statute</span><input class="input" id="stStatute" value="${esc(s.statute)}" placeholder="e.g. Miss. Code Ann. § 25-61-5"></label>
        <label class="field"><span>Records custodian (signs letters)</span><input class="input" id="stCustodian" value="${esc(s.custodian)}"></label>
        <label class="field"><span>Respond within (working days)</span><input class="input" id="stDays" type="number" min="1" value="${s.responseDays}"></label>
        <label class="field"><span>Extended limit (working days from receipt)</span><input class="input" id="stExt" type="number" min="1" value="${s.extensionDays}"></label>
        <label class="field"><span>Warn staff this many working days before</span><input class="input" id="stWarn" type="number" min="0" value="${s.warnDays}"></label>
        <label class="field"><span>Holidays</span><select class="select" id="stHol"><option value="MS" ${s.holidays === 'MS' ? 'selected' : ''}>Mississippi legal holidays (§ 3-3-7)</option><option value="US" ${s.holidays === 'US' ? 'selected' : ''}>Federal holidays</option><option value="none" ${s.holidays === 'none' ? 'selected' : ''}>Only the closures below</option></select></label>
      </div>
      <label class="field"><span>Other days City Hall is closed</span><input class="input" id="stClosures" value="${esc((s.closures || []).join(', '))}" placeholder="2026-12-24, 2026-12-31"><small>Dates as YYYY-MM-DD, separated by commas. They don't count as working days.</small></label>
      <div class="section-title">Fee schedule: the city's actual cost${s.feeStatute ? ` (${esc(s.feeStatute)})` : ''}</div>
      <div class="grid-2">
        <label class="field"><span>Search, per hour</span><input class="input" id="stFS" type="number" min="0" step="0.01" value="${f.searchHourly}"></label>
        <label class="field"><span>Review, per hour</span><input class="input" id="stFR" type="number" min="0" step="0.01" value="${f.reviewHourly}"></label>
        <label class="field"><span>Copies, per page</span><input class="input" id="stFP" type="number" min="0" step="0.01" value="${f.perPage}"></label>
        <label class="field"><span>USB drive or disc</span><input class="input" id="stFM" type="number" min="0" step="0.01" value="${f.perMedia}"></label>
        <label class="field"><span>Mailing</span><input class="input" id="stFL" type="number" min="0" step="0.01" value="${f.mailing}"></label>
        <label class="field" style="align-self:end"><span></span><label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="stPrepay" ${f.prepay ? 'checked' : ''}> Collect fees before releasing records</label></label>
      </div>
      <label class="field"><span>Exemptions staff can cite</span><textarea class="textarea" id="stEx" rows="5">${esc((s.exemptions || []).join('\n'))}</textarea><small>One per line, with the statute.</small></label>
      ${!s.confirmed ? '<label style="display:flex;gap:8px;font-size:13px"><input type="checkbox" id="stConfirm"> These rules are correct for our city</label>' : ''}
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="stGo">${icon('check')} Save</button></div>`);
    $('#stGo', m).onclick = async () => {
      const v = (id) => $(id, m).value;
      try {
        await api('/records/settings', { method: 'PUT', body: {
          statute: v('#stStatute'), custodian: v('#stCustodian'), responseDays: v('#stDays'), extensionDays: v('#stExt'), warnDays: v('#stWarn'), holidays: v('#stHol'),
          closures: v('#stClosures').split(/[\s,]+/).filter(Boolean), exemptions: v('#stEx').split('\n').map((x) => x.trim()).filter(Boolean),
          fees: { searchHourly: v('#stFS'), reviewHourly: v('#stFR'), perPage: v('#stFP'), perMedia: v('#stFM'), mailing: v('#stFL'), prepay: $('#stPrepay', m).checked },
          confirmed: $('#stConfirm', m)?.checked || undefined,
        } });
        m.remove(); toast('Records rules saved'); renderRecords($('#page'));
      } catch (e) { toast(e.message); }
    };
  }

  // The nav badge counts requests due soon or overdue.
  async function refreshBadge() {
    const b = document.getElementById('navRecords');
    if (!b || !can('records.view')) return;
    try {
      const { requests } = await api('/records');
      const n = requests.filter((r) => ['due_soon', 'overdue'].includes(r.deadline.state)).length;
      b.textContent = n; b.hidden = !n;
    } catch { /* shown on the page itself */ }
  }

  k.addPage('records', { title: 'Public records', sub: 'Records requests, deadlines and releases', icon: 'file', render: renderRecords, perm: 'records.view' }, 'Residents', 'navRecords');
  k.onShell(refreshBadge);
})();
