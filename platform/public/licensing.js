/* City Hall OS staff dashboard: Business licenses. The review queue, the license registry and the city's license settings.
   Loaded after dashboard.js, which provides window.CHOS. Staff decide every application; each change is in Activity. */
(() => {
  const C = window.CHOS;
  if (!C) return;
  const { esc, icon, pill, ago, toDate, toast, modal, openDrawer, closeDrawer, can, emptyNote, kpi } = C;
  const api = (path, opts) => C.api(`/licenses${path}`, opts);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const APP = { submitted: ['New', 'blue'], in_review: ['In review', 'violet'], needs_info: ['Waiting on applicant', 'amber'], awaiting_payment: ['Payment due', 'amber'],
    paid: ['Paid, ready to issue', 'green'], issued: ['Issued', 'green'], denied: ['Denied', 'red'], withdrawn: ['Withdrawn', ''] };
  const LIC = { active: ['Active', 'green'], expired: ['Expired', 'amber'], revoked: ['Revoked', 'red'] };
  const OPEN = ['submitted', 'in_review', 'needs_info', 'awaiting_payment', 'paid'];
  const ENTITY = { sole_proprietor: 'Sole proprietor', llc: 'LLC', corporation: 'Corporation', partnership: 'Partnership', nonprofit: 'Nonprofit' };
  const LIMITS = { yes: ['Inside city limits', 'green'], no: ['Outside city limits', 'red'], unsure: ['City limits not confirmed', 'amber'] };
  const SOURCE = { chat: 'AI intake', portal: 'Portal', web: 'Website', counter: 'At the counter' };
  const money = (c) => (c == null ? '—' : `$${(c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const day = (s) => (s ? new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—');
  const toCents = (v) => Math.round(Number(String(v).replace(/[$,\s]/g, '')) * 100);
  const netPaid = (a) => (a.paid_cents || 0) - (a.refunded_cents || 0);
  const paidBy = (a) => (a.payment_method === 'card' ? `card ending ${a.card_last4} online` : a.payment_method);
  const ui = { tab: 'applications', appFilter: 'open', regFilter: 'active', q: '', settings: null };

  C.addPage('licenses', { title: 'Business licenses', sub: 'Privilege license applications, renewals and the license registry', icon: 'badge', render, perm: 'licenses.view' }, 'Residents', 'navLic');

  // The nav badge counts applications waiting on staff. Staff of other departments don't see the page.
  C.onShell(async () => {
    if (!can('licenses.view')) return;
    try {
      const s = await api('/summary');
      const b = $('#navLic'); if (b) { b.textContent = s.toReview; b.hidden = !s.toReview; }
    } catch (e) {
      if (/another department/.test(e.message)) $('.nav a[data-route="licenses"]')?.remove();
    }
  });
  const refreshBadge = async () => { try { const s = await api('/summary'); const b = $('#navLic'); if (b) { b.textContent = s.toReview; b.hidden = !s.toReview; } } catch { /* page shows errors */ } };

  /* ---------------- Page ---------------- */

  async function render(page) {
    const s = await api('/summary');
    const manage = can('licenses.manage');
    page.innerHTML = `
      ${!s.configured ? `<div class="card card-b" style="margin-bottom:16px;background:var(--amber-soft);border-color:#f2d9a6;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        ${icon('alert')}<div style="flex:1;min-width:240px"><b>License classes and fees aren't set up yet.</b><div class="muted" style="font-size:13px">Applications still come in, and staff enter each fee by hand until the fee schedule is set.
        ${can('licenses.settings') ? '' : ' An administrator can set it up.'}</div></div>
        ${can('licenses.settings') ? '<button class="btn btn-primary btn-sm" data-tab="settings">Set up fees</button>' : ''}</div>` : ''}
      <div class="kpis">
        ${kpi('clipboard', 'Open applications', s.open, `${s.toReview} waiting on staff`)}
        ${kpi('badge', 'Active licenses', s.active, 'In the registry')}
        ${kpi('refresh', 'Expiring soon', s.expiring, 'In the next two months')}
        ${kpi('alert', 'Expired', s.expired, `${s.revoked} revoked`)}
      </div>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div class="seg" id="licTabs">${[['applications', 'Applications'], ['registry', 'Registry'], ['settings', 'Settings']]
          .map(([k, l]) => `<button type="button" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="faint" style="font-size:12.5px">Miss. Code Ann. § 27-17 · City Hall staff decide every application</span>
      </div>
      <div id="licBody"></div>`;
    page.onclick = (e) => { const t = e.target.closest('[data-tab]'); if (t) { ui.tab = t.dataset.tab; ui.q = ''; render(page); } };
    $('#pageActions').innerHTML = manage ? `<button class="btn btn-primary" id="licNew">${icon('plus')} Take an application</button>` : '';
    $('#licNew')?.addEventListener('click', () => counterModal());
    const body = $('#licBody');
    if (ui.tab === 'registry') return drawRegistry(body);
    if (ui.tab === 'settings') return drawSettings(body);
    return drawApplications(body);
  }
  const rerender = () => render($('#page'));

  /* ---------------- Applications ---------------- */

  const APP_FILTERS = [['open', 'Open'], ['submitted', 'New'], ['needs_info', 'Waiting on applicant'], ['awaiting_payment', 'Payment due'], ['paid', 'Ready to issue'],
    ['issued', 'Issued'], ['denied', 'Denied'], ['', 'All']];

  async function drawApplications(body) {
    const qs = new URLSearchParams({ ...(ui.appFilter ? { status: ui.appFilter } : {}), ...(ui.q ? { q: ui.q } : {}) });
    const { applications } = await api(`/applications?${qs}`);
    body.innerHTML = `
      <div class="toolbar">
        <div class="search">${icon('search')}<input class="input" id="appQ" placeholder="Search business, owner or number" value="${esc(ui.q)}"></div>
        <div class="chips" id="appChips">${APP_FILTERS.map(([v, l]) => `<button class="chip ${ui.appFilter === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
      </div>
      <div class="card" style="overflow:hidden"><table class="table">
        <thead><tr><th>Application</th><th>Business</th><th class="hide-sm">Class</th><th class="hide-sm">Received</th><th>Status</th></tr></thead>
        <tbody id="appRows">${applications.length ? applications.map((a) => `<tr data-id="${a.id}">
          <td><span class="mono">${esc(a.ref)}</span><div class="faint" style="font-size:12px">${a.kind === 'renewal' ? `Renewal${a.license_number ? ` of ${esc(a.license_number)}` : ''}` : 'New'} · ${esc(SOURCE[a.source] || a.source)}</div></td>
          <td><strong>${esc(a.business_name)}</strong><div class="faint" style="font-size:12.5px">${esc([a.owner_name, a.home_based ? 'Home-based' : a.location].filter(Boolean).join(' · '))}</div></td>
          <td class="hide-sm">${esc(a.class_label || '—')}</td>
          <td class="hide-sm muted">${ago(a.created_at)}</td>
          <td>${pill(APP, a.status)}${a.inside_limits && a.inside_limits !== 'yes' ? ` ${pill(LIMITS, a.inside_limits)}` : ''}</td></tr>`).join('')
          : `<tr><td colspan="5">${emptyNote('badge', ui.appFilter === 'open' ? 'No open applications. New ones from the chat, the portal and the counter appear here.' : 'Nothing matches.')}</td></tr>`}</tbody></table></div>`;
    let t;
    $('#appQ').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value.trim(); drawApplications(body).then(() => { const i = $('#appQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
    $('#appChips').onclick = (e) => { const c = e.target.closest('.chip'); if (c) { ui.appFilter = c.dataset.v; drawApplications(body); } };
    $('#appRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openApplication(Number(tr.dataset.id)); };
    if (ui.openApp) { const id = ui.openApp; ui.openApp = null; openApplication(id); }
  }

  const row = (k, v) => (v || v === 0 ? `<div style="display:grid;grid-template-columns:150px 1fr;gap:8px;font-size:13.5px;padding:3px 0"><span class="muted">${k}</span><span>${v}</span></div>` : '');

  // What staff should check before assessing, from what the applicant told us (§ 27-17-453).
  function checklist(a) {
    const item = (okay, text, warn) => `<div style="display:flex;gap:8px;font-size:13.5px;padding:3px 0"><span style="color:var(--${okay === true ? 'green' : okay === false ? 'red' : 'amber'})">${okay === true ? '✓' : '!'}</span><span>${text}${warn ? ` <span class="faint">${warn}</span>` : ''}</span></div>`;
    const home = a.home || {};
    return [
      item(a.inside_limits === 'yes' ? true : a.inside_limits === 'no' ? false : null, LIMITS[a.inside_limits]?.[0] || 'City limits not answered', a.inside_limits === 'no' ? 'Outside city limits the county issues the license (§ 27-17-5).' : a.inside_limits !== 'yes' ? 'Check the address.' : ''),
      item(a.employees != null ? true : null, a.employees != null ? `${a.employees} full-time employee${a.employees === 1 ? '' : 's'} (30+ hours a week)` : 'Number of employees not given', a.employees == null ? 'Needed to set the fee.' : ''),
      item(a.class_label ? true : null, a.class_label ? `Class: ${esc(a.class_label)}` : 'No license class chosen'),
      item(a.sos_id ? true : null, a.sos_id ? `Secretary of State ID: ${esc(a.sos_id)}` : 'Secretary of State registration not given', a.entity_type && a.entity_type !== 'sole_proprietor' ? 'LLCs, corporations and partnerships register with the Secretary of State.' : ''),
      item(a.dor_account ? true : null, a.dor_account ? `Revenue account: ${esc(a.dor_account)}` : 'Department of Revenue account not given'),
      item(a.state_licenses ? true : null, a.state_licenses ? `State licenses: ${esc(a.state_licenses)}` : 'State licenses not listed'),
      a.home_based ? item(!(home.customers || home.workers || home.outside), `Home-based: ${[home.customers && 'customers visit', home.workers && 'non-resident workers', home.outside && 'sign or outside storage'].filter(Boolean).join(', ') || 'no customers, outside workers or outside storage'}`, 'Check the home business rules.') : '',
    ].join('');
  }

  async function openApplication(id) {
    const { application: a } = await api(`/applications/${id}`);
    const manage = can('licenses.manage');
    const open = OPEN.includes(a.status);
    const lines = a.fee_lines || a.suggested?.lines || [];
    const sug = a.suggested;
    const d = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(a.ref)}</div><h2>${esc(a.business_name)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${pill(APP, a.status)}<span class="pill">${a.kind === 'renewal' ? 'Renewal' : 'New license'}</span><span class="pill">${esc(SOURCE[a.source] || a.source)}</span><span class="pill">Received ${ago(a.created_at)}</span></div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        <div class="card card-b"><div class="section-title" style="display:flex;justify-content:space-between">Application${manage && open && a.status !== 'paid' ? '<button class="btn btn-ghost btn-sm" id="aEdit">' + icon('pen') + ' Correct</button>' : ''}</div>
          ${row('What it does', a.description ? `<span style="white-space:pre-wrap">${esc(a.description)}</span>` : '')}
          ${row('Doing business as', esc(a.dba))}
          ${row('Class', esc(a.class_label || ''))}
          ${row('Owner', esc(a.owner_name))}
          ${row('Set up as', esc(ENTITY[a.entity_type] || ''))}
          ${row('Business address', a.location ? `${esc(a.location)} · <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.location}, ${C.state.city.shortName}, ${C.state.city.state}`)}" target="_blank" rel="noopener">Map</a>` : '')}
          ${row('Mailing address', esc(a.mailing_address))}
          ${row('Starts', esc(a.start_date))}
          ${row('Phone', esc(a.phone))}${row('Email', esc(a.email))}
          ${a.convo_id ? `<p style="margin:8px 0 0"><a href="#/conversations" id="aConvo">View the chat conversation</a></p>` : ''}
        </div>
        ${a.license ? `<div class="card card-b"><div class="section-title">License being renewed</div>${row('Number', `<span class="mono">${esc(a.license.number)}</span> ${pill(LIC, a.license.status)}`)}${row('Expires', day(a.license.expires_on))}</div>` : ''}
        <div class="card card-b"><div class="section-title">Check before assessing</div><div style="margin-top:6px">${checklist(a)}</div></div>
        ${a.fee_cents != null ? `<div class="card card-b"><div class="section-title">Fee</div>${(a.fee_lines || []).map((l) => row(esc(l.label), money(l.cents))).join('')}${row('<b>Total</b>', `<b>${money(a.fee_cents)}</b>`)}
          ${a.paid_at ? row('Paid', `${money(a.paid_cents)} by ${esc(paidBy(a))}${a.payment_ref ? ` · ${esc(a.payment_ref)}` : ''}${a.receipt_no ? `, receipt ${esc(a.receipt_no)}` : ''} · ${toDate(a.paid_at).toLocaleDateString()}`) : ''}
          ${a.refunded_cents ? row('Refunded', `${money(a.refunded_cents)}${a.refund_ref ? ` · ${esc(a.refund_ref)}` : ''}`) : ''}
          ${OPEN.includes(a.status) && a.fee_cents > netPaid(a) ? row('<b>Balance due</b>', `<b>${money(a.fee_cents - netPaid(a))}</b>`) : ''}
          ${a.period_start ? row('License period', `${day(a.period_start)} to ${day(a.period_end)}`) : ''}</div>` : ''}
        ${a.decision_reason ? `<div class="card card-b"><div class="section-title">Reason given</div><p style="margin:6px 0 0">${esc(a.decision_reason)}</p></div>` : ''}
        ${manage && open ? actionsHtml(a, lines, sug) : ''}
        ${a.status === 'issued' && a.license ? `<a class="btn" href="${esc(C.API)}/licenses/registry/${a.license.id}/certificate" target="_blank" rel="noopener">${icon('file')} Print license certificate</a>` : ''}
        <div class="section-title">History</div>
        <div class="timeline">${a.history.slice().reverse().map((h) => `<div class="tl"><i></i><div><b>${esc(h.note || (APP[h.status] || [h.status])[0])}</b><small>${esc(h.by)} · ${toDate(h.at).toLocaleString()}${h.public ? ' · shown to applicant' : ''}</small></div></div>`).join('')}</div>
      </div>`);
    d.querySelector('#aConvo')?.addEventListener('click', () => { C.state.convoId = a.convo_id; });
    d.querySelector('#aEdit')?.addEventListener('click', () => editModal(a));
    if (manage && open) wireActions(d, a);
  }

  function actionsHtml(a, lines, sug) {
    const canAssess = ['submitted', 'in_review', 'needs_info', 'awaiting_payment'].includes(a.status);
    return `<div class="card card-b stack" style="gap:14px">
      <div class="section-title">Next step</div>
      ${a.paid_cents && a.status === 'submitted' ? `<small>The applicant paid ${money(a.paid_cents)} online from the city's fee schedule. Confirm the fee below; if it changes, they owe the difference or the overpayment goes back to their card.</small>` : ''}
      ${['submitted', 'needs_info'].includes(a.status) ? `<div><button class="btn btn-dark" data-do="review">${icon('check')} Start review</button></div>` : ''}
      ${a.status !== 'paid' ? `<label class="field"><span>Ask the applicant for something</span><textarea class="textarea" id="aInfo" rows="2" placeholder="e.g. Please bring a copy of your Secretary of State certificate."></textarea>
        <small>Shown on their tracking page${a.phone || a.email ? ' and sent to them' : ''}.</small></label>
        <div><button class="btn" data-do="request_info">${icon('send')} Request information</button></div>` : ''}
      ${canAssess ? `<div class="field"><span>${a.fee_cents != null ? 'Reassess the fee' : 'Assess the fee'}</span>
        <div id="aLines" class="stack" style="gap:6px">${lines.map((l) => lineRow(l)).join('')}</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px"><button class="btn btn-sm" id="aAddLine" type="button">${icon('plus')} Add a line</button>
          <span class="muted" style="margin-left:auto">Total <b id="aTotal">${money(lines.reduce((x, l) => x + l.cents, 0))}</b></span></div>
        ${sug ? `<small>License period if issued now: ${day(sug.period.start)} to ${day(sug.period.end)}.${sug.notes.length ? ` ${esc(sug.notes.join(' '))}` : ''}</small>` : ''}
        <div style="margin-top:8px"><button class="btn btn-primary" data-do="assess">${icon('check')} ${a.paid_cents && a.fee_cents === netPaid(a) ? 'Confirm fee' : a.fee_cents != null ? 'Save new fee' : 'Assess fee'}</button></div></div>` : ''}
      ${a.status === 'awaiting_payment' ? `<div class="field"><span>Record payment at the counter</span>
        <div class="grid-2">
          <label class="field"><span>Method</span><select class="select" id="pMethod"><option value="cash">Cash</option><option value="check">Check</option></select></label>
          <label class="field"><span>Amount</span><input class="input" id="pAmount" value="${((a.fee_cents - netPaid(a)) / 100).toFixed(2)}"></label>
          <label class="field" id="pCheckF" hidden><span>Check number</span><input class="input" id="pCheck"></label>
          <label class="field"><span>Receipt number</span><input class="input" id="pReceipt" placeholder="Optional"></label>
        </div><div style="margin-top:8px"><button class="btn btn-primary" data-do="payment">${icon('check')} Record ${money(a.fee_cents - netPaid(a))} paid</button></div></div>` : ''}
      ${a.status === 'paid' || (a.status === 'awaiting_payment' && a.fee_cents <= netPaid(a)) ? `<div class="field"><span>Issue the license</span>
        ${a.inside_limits !== 'yes' ? `<small style="color:var(--red)">The address is ${a.inside_limits === 'no' ? 'outside' : 'not confirmed inside'} city limits.</small>` : ''}
        ${a.license?.status === 'revoked' ? '<small style="color:var(--red)">The license being renewed is revoked. Issuing reinstates it.</small>' : ''}
        <div style="margin-top:6px"><button class="btn btn-primary" data-do="issue">${icon('badge')} Issue license</button></div></div>` : ''}
      <label class="field"><span>Internal note</span><textarea class="textarea" id="aNote" rows="2" placeholder="Visible to staff only"></textarea></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-do="note">Add note</button>
        <button class="btn btn-danger" data-do="deny" style="margin-left:auto">Deny</button><button class="btn btn-ghost" data-do="withdraw">Withdrawn</button></div>
    </div>`;
  }

  const lineRow = (l) => `<div class="aline" style="display:grid;grid-template-columns:1fr 110px 32px;gap:6px">
    <input class="input" data-k="label" value="${esc(l.label)}"><input class="input" data-k="amount" value="${(l.cents / 100).toFixed(2)}" inputmode="decimal">
    <button class="btn btn-ghost btn-sm" type="button" data-rm aria-label="Remove line">${icon('x')}</button></div>`;

  function wireActions(d, a) {
    const total = () => $$('.aline', d).reduce((x, r) => x + (toCents(r.querySelector('[data-k=amount]').value) || 0), 0);
    const showTotal = () => { const t = d.querySelector('#aTotal'); if (t) t.textContent = money(total()); };
    d.querySelector('#aLines')?.addEventListener('input', showTotal);
    d.querySelector('#aLines')?.addEventListener('click', (e) => { if (e.target.closest('[data-rm]')) { e.target.closest('.aline').remove(); showTotal(); } });
    d.querySelector('#aAddLine')?.addEventListener('click', () => { d.querySelector('#aLines').insertAdjacentHTML('beforeend', lineRow({ label: 'Fee', cents: 0 })); });
    d.querySelector('#pMethod')?.addEventListener('change', (e) => { d.querySelector('#pCheckF').hidden = e.target.value !== 'check'; });
    const send = async (body, msg) => {
      try {
        const r = await api(`/applications/${a.id}`, { method: 'PATCH', body });
        toast(msg); refreshBadge();
        if (body.action === 'issue') ui.appFilter = 'issued';
        await rerender(); openApplication(r.application.id);
        if (body.action === 'issue' && r.application.license) window.open(`${C.API}/licenses/registry/${r.application.license.id}/certificate`, '_blank', 'noopener');
      } catch (e) { toast(e.message); }
    };
    d.querySelector('.drawer-b').addEventListener('click', (e) => {
      const b = e.target.closest('[data-do]');
      if (!b) return;
      const act = b.dataset.do;
      if (act === 'review') send({ action: 'review' }, 'Review started');
      if (act === 'request_info') { const m = d.querySelector('#aInfo').value.trim(); if (!m) { d.querySelector('#aInfo').focus(); return; } send({ action: 'request_info', message: m }, 'Sent to the applicant'); }
      if (act === 'assess') {
        const lines = $$('.aline', d).map((r) => ({ label: r.querySelector('[data-k=label]').value, cents: toCents(r.querySelector('[data-k=amount]').value) }));
        if (!lines.length || lines.some((l) => !Number.isFinite(l.cents))) { toast('Enter each fee as an amount, like 20.00'); return; }
        send({ action: 'assess', lines }, `Fee set at ${money(lines.reduce((x, l) => x + l.cents, 0))}`);
      }
      if (act === 'payment') {
        send({ action: 'payment', method: d.querySelector('#pMethod').value, amount_cents: toCents(d.querySelector('#pAmount').value),
          check_number: d.querySelector('#pCheck').value, receipt_no: d.querySelector('#pReceipt').value }, 'Payment recorded');
      }
      if (act === 'issue') send({ action: 'issue', confirm: a.license?.status === 'revoked' }, 'License issued');
      if (act === 'note') { const n = d.querySelector('#aNote').value.trim(); if (!n) { d.querySelector('#aNote').focus(); return; } send({ action: 'note', note: n }, 'Note added'); }
      if (act === 'deny' || act === 'withdraw') {
        const m = modal(`<h2>${act === 'deny' ? `Deny ${esc(a.ref)}` : `Mark ${esc(a.ref)} withdrawn`}</h2>
          <p class="muted" style="margin:0">${act === 'deny' ? 'The applicant sees this reason on their tracking page.' : 'For when the applicant no longer wants the license.'}</p>
          <label class="field"><span>${act === 'deny' ? 'Reason' : 'Note (optional)'}</span><textarea class="textarea" id="dReason" rows="3"></textarea></label>
          <div class="row"><button class="btn" data-close>Cancel</button><button class="btn ${act === 'deny' ? 'btn-danger' : 'btn-primary'}" id="dGo">${act === 'deny' ? 'Deny application' : 'Mark withdrawn'}</button></div>`);
        m.querySelector('#dGo').onclick = () => {
          const reason = m.querySelector('#dReason').value.trim();
          if (act === 'deny' && !reason) { m.querySelector('#dReason').focus(); return; }
          m.remove();
          send(act === 'deny' ? { action: 'deny', reason } : { action: 'withdraw', note: reason }, act === 'deny' ? 'Application denied' : 'Marked withdrawn');
        };
      }
    });
  }

  async function editModal(a) {
    const s = ui.settings || (ui.settings = await api('/settings'));
    const classes = s.config.classes;
    const m = modal(`
      <h2>Correct ${esc(a.ref)}</h2>
      <div class="grid-2">
        <label class="field"><span>Business name</span><input class="input" name="business_name" value="${esc(a.business_name)}"></label>
        <label class="field"><span>Doing business as</span><input class="input" name="dba" value="${esc(a.dba || '')}"></label>
        <label class="field"><span>License class</span><select class="select" name="class_key"><option value="">Not chosen</option>${classes.map((c) => `<option value="${esc(c.key)}" ${c.key === a.class_key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Full-time employees</span><input class="input" name="employees" type="number" min="0" value="${a.employees ?? ''}"></label>
        <label class="field"><span>Owner</span><input class="input" name="owner_name" value="${esc(a.owner_name || '')}"></label>
        <label class="field"><span>Business address</span><input class="input" name="location" value="${esc(a.location || '')}"></label>
        <label class="field"><span>City limits</span><select class="select" name="inside_limits">${Object.entries(LIMITS).map(([k, [l]]) => `<option value="${k}" ${k === a.inside_limits ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Secretary of State ID</span><input class="input" name="sos_id" value="${esc(a.sos_id || '')}"></label>
        <label class="field"><span>Revenue account</span><input class="input" name="dor_account" value="${esc(a.dor_account || '')}"></label>
        <label class="field"><span>State licenses</span><input class="input" name="state_licenses" value="${esc(a.state_licenses || '')}"></label>
        ${can('residents.contact') ? `<label class="field"><span>Phone</span><input class="input" name="phone" value="${esc(a.phone || '')}"></label>
        <label class="field"><span>Email</span><input class="input" name="email" value="${esc(a.email || '')}"></label>` : ''}
      </div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="eSave">Save corrections</button></div>`);
    m.querySelector('#eSave').onclick = async () => {
      const fields = {};
      $$('[name]', m).forEach((el) => { const v = el.value.trim(); if (String(a[el.name] ?? '') !== v) fields[el.name] = el.name === 'employees' ? (v === '' ? null : Number(v)) : v; });
      if (!Object.keys(fields).length) { m.remove(); return; }
      try {
        await api(`/applications/${a.id}`, { method: 'PATCH', body: { action: 'edit', fields } });
        m.remove(); toast('Corrected'); await rerender(); openApplication(a.id);
      } catch (e) { toast(e.message); }
    };
  }

  // An application taken by phone or at the counter.
  async function counterModal(prefill = {}) {
    const s = ui.settings || (ui.settings = await api('/settings'));
    const classes = s.config.classes;
    const m = modal(`
      <h2>Take an application</h2>
      <p class="muted" style="margin:0">For applications made by phone, by mail or at the counter.</p>
      <div class="grid-2">
        <label class="field"><span>Business name</span><input class="input" name="business_name" value="${esc(prefill.business_name || '')}" required></label>
        <label class="field"><span>Owner</span><input class="input" name="owner_name" required></label>
        <label class="field" style="grid-column:1/-1"><span>What the business does</span><input class="input" name="description"></label>
        <label class="field"><span>License class</span><select class="select" name="class_key"><option value="">Not chosen</option>${classes.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field"><span>Full-time employees</span><input class="input" name="employees" type="number" min="0"></label>
        <label class="field"><span>Business address</span><input class="input" name="location" required></label>
        <label class="field"><span>City limits</span><select class="select" name="inside_limits">${Object.entries(LIMITS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field"><span>Set up as</span><select class="select" name="entity_type"><option value="">Not given</option>${Object.entries(ENTITY).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field"><span>Run from home</span><select class="select" name="home_based"><option value="no">No</option><option value="yes">Yes</option></select></label>
        <label class="field"><span>Phone</span><input class="input" name="phone"></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email"></label>
        <label class="field"><span>Secretary of State ID</span><input class="input" name="sos_id"></label>
        <label class="field"><span>Revenue account</span><input class="input" name="dor_account"></label>
        <label class="field"><span>State licenses</span><input class="input" name="state_licenses"></label>
        <label class="field"><span>Start date</span><input class="input" name="start_date" type="date"></label>
      </div>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="cSave">Create application</button></div>`);
    m.querySelector('#cSave').onclick = async () => {
      const draft = { kind: 'new' };
      $$('[name]', m).forEach((el) => { if (el.value.trim()) draft[el.name] = el.value.trim(); });
      draft.home_based = draft.home_based === 'yes';
      if (draft.employees) draft.employees = Number(draft.employees);
      try {
        const r = await C.api('/licenses/applications', { method: 'POST', body: { draft } });
        m.remove(); toast(`${r.ref} created`); refreshBadge();
        ui.tab = 'applications'; ui.appFilter = 'open'; await rerender();
        const { applications } = await api(`/applications?q=${encodeURIComponent(r.ref)}`);
        if (applications[0]) openApplication(applications[0].id);
      } catch (e) { toast(e.message); }
    };
  }

  /* ---------------- Registry ---------------- */

  const REG_FILTERS = [['active', 'Active'], ['expiring', 'Expiring in 2 months'], ['expired', 'Expired'], ['revoked', 'Revoked'], ['', 'All']];

  async function drawRegistry(body) {
    const qs = new URLSearchParams({ ...(ui.regFilter ? { status: ui.regFilter } : {}), ...(ui.q ? { q: ui.q } : {}) });
    const { licenses } = await api(`/registry?${qs}`);
    const manage = can('licenses.manage');
    body.innerHTML = `
      <div class="toolbar">
        <div class="search">${icon('search')}<input class="input" id="regQ" placeholder="Search business, owner, address or number" value="${esc(ui.q)}"></div>
        <div class="chips" id="regChips">${REG_FILTERS.map(([v, l]) => `<button class="chip ${ui.regFilter === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div>
        ${manage ? `<span style="margin-left:auto;display:flex;gap:8px"><button class="btn btn-sm" id="regImport">${icon('plus')} Add an existing license</button><button class="btn btn-sm" id="regNotices">${icon('mail')} Send renewal notices</button></span>` : ''}
      </div>
      <div class="card" style="overflow:hidden"><table class="table">
        <thead><tr><th>License</th><th>Business</th><th class="hide-sm">Class</th><th>Expires</th><th class="hide-sm">Renewal notice</th></tr></thead>
        <tbody id="regRows">${licenses.length ? licenses.map((l) => `<tr data-id="${l.id}">
          <td><span class="mono">${esc(l.number)}</span><div style="margin-top:3px">${pill(LIC, l.status)}</div></td>
          <td><strong>${esc(l.business_name)}</strong>${l.dba ? ` <span class="faint">(${esc(l.dba)})</span>` : ''}<div class="faint" style="font-size:12.5px">${esc([l.owner_name, l.location].filter(Boolean).join(' · '))}</div></td>
          <td class="hide-sm">${esc(l.class_label || '—')}</td>
          <td>${day(l.expires_on)}</td>
          <td class="hide-sm muted" style="font-size:12.5px">${l.reminded_for === l.expires_on ? esc(l.reminder_result || 'Sent') : '—'}</td></tr>`).join('')
          : `<tr><td colspan="5">${emptyNote('badge', ui.regFilter === 'active' ? 'No active licenses yet. Issued licenses appear here; add licenses from the paper register with "Add an existing license".' : 'Nothing matches.')}</td></tr>`}</tbody></table></div>
      <p class="faint" style="font-size:12.5px">Renewal notices go out automatically each morning from the first day of the month before a license expires (Miss. Code Ann. § 27-17-465), and once more after it lapses.
        Residents can check any business at <a href="/licenses.html?city=${esc(C.state.city.slug)}" target="_blank" rel="noopener">the public lookup</a>.</p>`;
    let t;
    $('#regQ').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value.trim(); drawRegistry(body).then(() => { const i = $('#regQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
    $('#regChips').onclick = (e) => { const c = e.target.closest('.chip'); if (c) { ui.regFilter = c.dataset.v; drawRegistry(body); } };
    $('#regRows').onclick = (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) openLicense(Number(tr.dataset.id)); };
    $('#regImport')?.addEventListener('click', importModal);
    $('#regNotices')?.addEventListener('click', async () => {
      try {
        const r = await api('/notices', { method: 'POST', body: {} });
        toast(r.renewal + r.lapsed ? `${r.renewal} renewal and ${r.lapsed} expired notices due${r.notSent ? `; ${r.notSent} could not be sent, see the registry` : ''}` : 'No notices are due today');
        drawRegistry(body);
      } catch (e) { toast(e.message); }
    });
  }

  async function openLicense(id) {
    const { license: l } = await api(`/registry/${id}`);
    const manage = can('licenses.manage');
    const open = l.applications.find((x) => OPEN.includes(x.status));
    const d = openDrawer(`
      <div class="drawer-h"><div><div class="section-title mono">${esc(l.number)}</div><h2>${esc(l.business_name)}</h2>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${pill(LIC, l.status)}<span class="pill">${l.source === 'imported' ? 'From earlier records' : 'Issued in City Hall OS'}</span></div></div>
        <button class="btn btn-ghost btn-sm close" aria-label="Close">${icon('x')}</button></div>
      <div class="drawer-b">
        <div class="card card-b">
          ${row('Doing business as', esc(l.dba))}${row('Class', esc(l.class_label || ''))}${row('Owner', esc(l.owner_name))}
          ${row('Business address', esc(l.location))}${row('Home-based', l.home_based ? 'Yes (address hidden in the public lookup)' : '')}
          ${row('Valid', `${day(l.issued_on)} to ${day(l.expires_on)}`)}${row('Privilege tax paid', l.fee_cents != null ? money(l.fee_cents) : '')}
          ${row('Phone', esc(l.phone))}${row('Email', esc(l.email))}
          ${row('Renewal notice', l.reminded_for === l.expires_on ? esc(l.reminder_result) : l.lapsed_notice_for === l.expires_on ? `Expired notice: ${esc(l.reminder_result)}` : '')}
          ${l.revoked_at ? row('Revoked', `${toDate(l.revoked_at).toLocaleDateString()}: ${esc(l.revoke_reason)}`) : ''}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn" href="${esc(C.API)}/licenses/registry/${l.id}/certificate" target="_blank" rel="noopener">${icon('file')} Print certificate</a>
          ${manage && !open ? `<button class="btn btn-primary" id="lRenew">${icon('refresh')} Start a renewal</button>` : ''}
          ${open ? `<button class="btn" data-app="${open.id}">Open renewal ${esc(open.ref)}</button>` : ''}
          ${manage ? (l.revoked_at ? '<button class="btn" id="lReinstate">Reinstate</button>' : '<button class="btn btn-danger" id="lRevoke" style="margin-left:auto">Revoke</button>') : ''}
        </div>
        <div class="section-title">Applications</div>
        <div class="list">${l.applications.length ? l.applications.map((x) => `<div class="list-item clickable" data-app="${x.id}"><div class="grow"><div class="title"><span class="mono">${esc(x.ref)}</span> · ${x.kind === 'renewal' ? 'Renewal' : 'New license'}</div>
          <div class="meta">${x.period_start ? `${day(x.period_start)} to ${day(x.period_end)} · ` : ''}${money(x.fee_cents)} · ${ago(x.created_at)}</div></div>${pill(APP, x.status)}</div>`).join('') : emptyNote('file', 'Added from earlier records; no applications in City Hall OS yet.')}</div>
      </div>`);
    d.querySelector('.drawer-b').addEventListener('click', (e) => {
      const x = e.target.closest('[data-app]');
      if (x) { closeDrawer(); ui.tab = 'applications'; ui.appFilter = ''; ui.openApp = Number(x.dataset.app); rerender(); }
    });
    d.querySelector('#lRenew')?.addEventListener('click', async () => {
      try {
        const r = await api(`/registry/${l.id}/renew`, { method: 'POST' });
        toast(`${r.ref} started`); refreshBadge(); closeDrawer(); ui.tab = 'applications'; ui.appFilter = 'open'; ui.openApp = r.id; rerender();
      } catch (e) { toast(e.message); }
    });
    const revoke = (action) => {
      const m = modal(`<h2>${action === 'revoke' ? `Revoke ${esc(l.number)}` : `Reinstate ${esc(l.number)}`}</h2>
        <p class="muted" style="margin:0">${action === 'revoke' ? 'The public lookup will show this license as revoked.' : 'The license becomes active again until it expires.'}</p>
        <label class="field"><span>${action === 'revoke' ? 'Reason' : 'Note (optional)'}</span><textarea class="textarea" id="rReason" rows="3"></textarea></label>
        <div class="row"><button class="btn" data-close>Cancel</button><button class="btn ${action === 'revoke' ? 'btn-danger' : 'btn-primary'}" id="rGo">${action === 'revoke' ? 'Revoke license' : 'Reinstate'}</button></div>`);
      m.querySelector('#rGo').onclick = async () => {
        const reason = m.querySelector('#rReason').value.trim();
        if (action === 'revoke' && !reason) { m.querySelector('#rReason').focus(); return; }
        try { await api(`/registry/${l.id}`, { method: 'PATCH', body: { action, reason } }); m.remove(); toast(action === 'revoke' ? 'License revoked' : 'License reinstated'); await rerender(); openLicense(l.id); } catch (e) { toast(e.message); }
      };
    };
    d.querySelector('#lRevoke')?.addEventListener('click', () => revoke('revoke'));
    d.querySelector('#lReinstate')?.addEventListener('click', () => revoke('reinstate'));
  }

  async function importModal() {
    const s = ui.settings || (ui.settings = await api('/settings'));
    const m = modal(`
      <h2>Add an existing license</h2>
      <p class="muted" style="margin:0">For licenses issued before City Hall OS, from the paper register, so renewals and the public lookup include them.</p>
      <div class="grid-2">
        <label class="field"><span>License number</span><input class="input" name="number" placeholder="Leave blank to number it automatically"></label>
        <label class="field"><span>Business name</span><input class="input" name="business_name" required></label>
        <label class="field"><span>Owner</span><input class="input" name="owner_name"></label>
        <label class="field"><span>Class</span><select class="select" name="class_key"><option value="">Not set</option>${s.config.classes.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select></label>
        <label class="field" style="grid-column:1/-1"><span>Business address</span><input class="input" name="location"></label>
        <label class="field"><span>Issued</span><input class="input" name="issued_on" type="date" required></label>
        <label class="field"><span>Expires</span><input class="input" name="expires_on" type="date" required></label>
        <label class="field"><span>Fee paid</span><input class="input" name="fee" placeholder="e.g. 30.00"></label>
        <label class="field"><span>Run from home</span><select class="select" name="home_based"><option value="no">No</option><option value="yes">Yes</option></select></label>
        <label class="field"><span>Phone</span><input class="input" name="phone"></label>
        <label class="field"><span>Email</span><input class="input" name="email" type="email"></label>
      </div>
      <small class="faint">Phone and email are used for renewal notices.</small>
      <div class="row"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="iSave">Add to registry</button></div>`);
    m.querySelector('#iSave').onclick = async () => {
      const b = {};
      $$('[name]', m).forEach((el) => { if (el.value.trim()) b[el.name] = el.value.trim(); });
      if (b.fee) b.fee_cents = toCents(b.fee);
      try { await api('/registry', { method: 'POST', body: b }); m.remove(); toast('Added to the registry'); ui.tab = 'registry'; ui.regFilter = ''; rerender(); } catch (e) { toast(e.message); }
    };
  }

  /* ---------------- Settings ---------------- */

  async function drawSettings(body) {
    const s = ui.settings = await api('/settings');
    const c = structuredClone(s.config);
    const edit = s.canEdit;
    const dis = edit ? '' : 'disabled';
    const num = 'style="width:76px"';
    const tierRow = (t, i) => `<div class="tier" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px" data-i="${i}">
      <span>Up to</span><input class="input" ${num} data-k="upTo" value="${t.upTo ?? ''}" placeholder="any" ${dis}><span>employees: $</span><input class="input" ${num} data-k="amount" value="${t.amount}" ${dis}>
      <span>plus $</span><input class="input" ${num} data-k="perExtra" value="${t.perExtra || ''}" placeholder="0" title="For each employee over the previous tier" ${dis}><span>per extra employee, up to $</span><input class="input" ${num} data-k="max" value="${t.max || ''}" placeholder="no cap" ${dis}>
      ${edit ? `<button class="btn btn-ghost btn-sm" type="button" data-rm-tier aria-label="Remove tier">${icon('x')}</button>` : ''}</div>`;
    const classCard = (k, i) => `<div class="card card-b stack lclass" style="gap:10px" data-i="${i}">
      <div class="grid-2">
        <label class="field"><span>Class name</span><input class="input" data-k="label" value="${esc(k.label)}" ${dis}></label>
        <label class="field"><span>Fee</span><select class="select" data-k="type" ${dis}>${[['employees', 'By full-time employees'], ['flat', 'Flat amount a year'], ['assessed', 'Set by staff']].map(([v, l]) => `<option value="${v}" ${k.fee.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Description residents see</span><input class="input" data-k="description" value="${esc(k.description)}" ${dis}></label>
      ${k.fee.type === 'flat' ? `<label class="field"><span>Amount a year ($)</span><input class="input" data-k="amount" value="${k.fee.amount ?? 0}" style="max-width:160px" ${dis}></label>` : ''}
      ${k.fee.type === 'employees' ? `<div class="stack" style="gap:6px">${(k.fee.tiers || []).map(tierRow).join('')}${edit ? `<div><button class="btn btn-sm" type="button" data-add-tier>${icon('plus')} Add a tier</button></div>` : ''}</div>` : ''}
      ${edit ? `<div><button class="btn btn-ghost btn-sm btn-danger" type="button" data-rm-class>${icon('trash')} Remove class</button></div>` : ''}
    </div>`;
    const draw = () => {
      body.innerHTML = `
        <form class="stack" id="lsForm" style="max-width:900px;margin-top:16px">
          ${!edit ? '<div class="card card-b muted">Only administrators can change license settings.</div>' : ''}
          <div class="card"><div class="card-h"><h2>License classes and fees</h2>${edit ? '<button class="btn btn-sm" type="button" id="lsState">Load the state schedule (§ 27-17-9)</button>' : ''}</div>
            <div class="card-b stack" style="gap:12px">
              <p class="muted" style="margin:0">Enter the fees from your city's adopted privilege tax schedule. The state schedule in Miss. Code Ann. § 27-17-9 is available as a starting point.
                The AI quotes these to residents as the city's fees, and staff can adjust any fee when they assess an application.</p>
              <div class="stack" id="lsClasses" style="gap:12px">${c.classes.map(classCard).join('') || emptyNote('badge', 'No classes yet. Staff will enter every fee by hand.')}</div>
              ${edit ? `<div><button class="btn btn-sm" type="button" id="lsAddClass">${icon('plus')} Add a class</button></div>` : ''}
            </div></div>
          <div class="card"><div class="card-h"><h2>Term, penalties and wording</h2></div><div class="card-b stack" style="gap:14px">
            <div class="grid-2">
              <label class="field"><span>Licenses expire</span><select class="select" name="term" ${dis}><option value="fiscal" ${c.term === 'fiscal' ? 'selected' : ''}>On the same date each year</option><option value="anniversary" ${c.term === 'anniversary' ? 'selected' : ''}>One year after issuance (by ordinance)</option></select>
                <small>State law: September 30 each year unless the city adopted an ordinance for one year from issuance (§ 27-17-463).</small></label>
              <label class="field"><span>Expiration date (month-day)</span><input class="input" name="expiresOn" value="${esc(c.expiresOn)}" placeholder="09-30" ${dis}></label>
              <label class="field"><span>Late penalty (%)</span><input class="input" name="penaltyInitialPct" value="${c.penaltyInitialPct}" ${dis}><small>§ 27-17-467: 10%, then 1% a month.</small></label>
              <label class="field"><span>Each month after (%)</span><input class="input" name="penaltyMonthlyPct" value="${c.penaltyMonthlyPct}" ${dis}></label>
            </div>
            <label class="field" style="display:flex;gap:8px;align-items:center;flex-direction:row"><input type="checkbox" name="prorate" ${c.prorate ? 'checked' : ''} ${dis}><span style="margin:0">Prorate licenses issued partway through the year (§ 27-17-463)</span></label>
            <div class="grid-2">
              <label class="field"><span>Licensing department</span><select class="select" name="departmentId" ${dis}>${s.departments.map((x) => `<option value="${esc(x.id)}" ${x.id === c.departmentId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select><small>Department staff here can work applications.</small></label>
              <label class="field"><span>Officer who signs licenses</span><input class="input" name="officerName" value="${esc(c.officerName)}" placeholder="Name" ${dis}></label>
              <label class="field"><span>Officer's title</span><input class="input" name="officerTitle" value="${esc(c.officerTitle)}" ${dis}></label>
            </div>
            <label class="field"><span>What applicants need</span><textarea class="textarea" name="requirements" rows="3" placeholder="e.g. Photo ID; Secretary of State certificate for LLCs and corporations; sales tax permit if you sell goods; zoning approval for a new location." ${dis}>${esc(c.requirements)}</textarea><small>Shown at the start of every application and given to the AI as the city's own rules.</small></label>
            <label class="field"><span>Home-based business rules</span><textarea class="textarea" name="homeRules" rows="3" placeholder="The city's home occupation rules, in plain language." ${dis}>${esc(c.homeRules)}</textarea></label>
            <label class="field"><span>Note printed on the license</span><input class="input" name="certificateNote" value="${esc(c.certificateNote)}" ${dis}></label>
          </div></div>
          ${s.updated_at ? `<p class="faint" style="font-size:12.5px;margin:0">Last changed by ${esc(s.updated_by)} ${ago(s.updated_at)}.</p>` : ''}
          ${edit ? `<div><button class="btn btn-primary" type="submit">${icon('check')} Save license settings</button></div>` : ''}
        </form>`;
      if (!edit) return;
      const f = $('#lsForm');
      $('#lsState').onclick = () => { readClasses(); c.classes = structuredClone(s.stateSchedule); draw(); toast('State schedule loaded. Check it against your ordinance, then save.'); };
      $('#lsAddClass').onclick = () => { readClasses(); c.classes.push({ key: '', label: 'New class', description: '', fee: { type: 'flat', amount: 0 } }); draw(); };
      $('#lsClasses').onclick = (e) => {
        const card = e.target.closest('.lclass'); if (!card) return;
        const i = Number(card.dataset.i);
        if (e.target.closest('[data-rm-class]')) { readClasses(); c.classes.splice(i, 1); draw(); }
        if (e.target.closest('[data-add-tier]')) { readClasses(); (c.classes[i].fee.tiers ||= []).push({ upTo: null, amount: 0 }); draw(); }
        if (e.target.closest('[data-rm-tier]')) { readClasses(); c.classes[i].fee.tiers.splice(Number(e.target.closest('.tier').dataset.i), 1); draw(); }
      };
      $('#lsClasses').onchange = (e) => { if (e.target.dataset.k === 'type') { readClasses(); draw(); } };
      f.onsubmit = async (e) => {
        e.preventDefault();
        readClasses();
        const v = Object.fromEntries(new FormData(f).entries());
        const bodyOut = { ...v, prorate: f.prorate.checked, penaltyInitialPct: Number(v.penaltyInitialPct), penaltyMonthlyPct: Number(v.penaltyMonthlyPct), classes: c.classes };
        try { ui.settings = null; await api('/settings', { method: 'PUT', body: bodyOut }); toast('License settings saved'); rerender(); } catch (err) { toast(err.message); }
      };
    };
    // Copies what's typed in the class cards back into c.classes.
    const readClasses = () => {
      $$('.lclass', body).forEach((card) => {
        const k = c.classes[Number(card.dataset.i)];
        const val = (key) => card.querySelector(`:scope > .grid-2 [data-k="${key}"], :scope > label [data-k="${key}"]`)?.value;
        k.label = val('label') ?? k.label;
        k.description = val('description') ?? k.description;
        const type = val('type') || k.fee.type;
        const tiers = $$('.tier', card).map((t) => Object.fromEntries(['upTo', 'amount', 'perExtra', 'max'].map((x) => {
          const raw = t.querySelector(`[data-k="${x}"]`).value.trim();
          return [x, raw === '' ? (x === 'upTo' ? null : 0) : Number(raw)];
        })));
        k.fee = type === 'flat' ? { type, amount: Number(val('amount') ?? k.fee.amount ?? 0) } : type === 'employees' ? { type, tiers: k.fee.type === 'employees' ? tiers : [{ upTo: null, amount: 0 }] } : { type };
      });
    };
    draw();
  }
})();
