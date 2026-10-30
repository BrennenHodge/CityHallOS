/*!
 * City Hall OS: public records requests in the AI City Clerk chat.
 * Loaded by embed.js when /config lists the "records" module. A guided request (the AI helps narrow a vague one),
 * and status for {prefix}-PRR-#### numbers.
 */
window.__cityhallosRegister?.((ctx) => {
  const { API, state, persist, push, bot, card, drawLog, drawFlowHint, focusInput, esc, icon } = ctx;
  const HINTS = { records: 'Describe the records you want', dates: 'e.g. 2025, or 2025-01-01 to 2025-06-30', name: 'Your full name', contact: 'Email address or phone number' };
  const STATUS = { new: 'Received', acknowledged: 'Acknowledged', in_progress: 'Gathering records', awaiting_payment: 'Waiting for payment', ready: 'Ready to release', closed: 'Closed' };
  const OUTCOME = { fulfilled: 'Records released', partial: 'Released in part', denied: 'Denied', no_records: 'No records found', withdrawn: 'Withdrawn' };
  const FORMATS = { electronic: 'Electronic copies', paper: 'Paper copies', inspection: 'Inspect at City Hall' };
  const ymd = (d) => d.toISOString().slice(0, 10);
  const longDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '');
  const pick = (v, label) => `<button class="btn" data-act="rec-pick" data-v="${esc(v)}">${esc(label)}</button>`;
  const phone = () => ctx.cfg()?.phone || 'City Hall';

  function start() {
    state.flow = { name: 'records', step: 'records', records: '', checked: false, date_from: '', date_to: '', format: '', fullName: '', email: '', phone: '' };
    persist(); drawFlowHint();
    bot("I'll help you request public records. **What records are you looking for?** Be as specific as you can: the kind of document (minutes, contracts, emails, reports), the subject, an address or a case number.");
    focusInput();
  }

  function step(name, text, buttons) {
    state.flow.step = name; persist(); drawFlowHint();
    bot(text, buttons ? { buttons } : {});
    focusInput();
  }

  function parseDates(text) {
    const t = text.trim().toLowerCase();
    if (/^(any|all|skip|none|any date|all dates)$/.test(t)) return { from: '', to: '' };
    if (t === 'last12') { const a = new Date(); a.setFullYear(a.getFullYear() - 1); return { from: ymd(a), to: ymd(new Date()) }; }
    const iso = t.match(/\d{4}-\d{2}-\d{2}/g);
    if (iso) return { from: iso[0], to: iso[1] || iso[0] };
    const years = t.match(/\b(?:19|20)\d\d\b/g);
    if (years) return { from: `${years[0]}-01-01`, to: `${years[years.length - 1]}-12-31` };
    return null;
  }

  const askDates = () => step('dates', 'What dates should the search cover? A narrower range is faster and usually costs less.',
    pick(String(new Date().getFullYear()), `This year (${new Date().getFullYear()})`) + pick('last12', 'Last 12 months') + pick('any', 'Any date'));

  async function answer(text, picked) {
    const f = state.flow;
    if (!f) return;
    if (f.step === 'records') {
      if (picked) { if (text !== 'keep') f.records = text; return askDates(); }
      if (f.checked) { f.records = `${f.records} ${text}`.trim(); return askDates(); }
      if (text.length < 8) { bot('Please describe the records in a few more words.'); return; }
      f.records = text;
      ctx.busy(true);
      bot('', { pending: true });
      let help = { clear: true, questions: [] };
      try {
        const res = await fetch(`${API}/records/assist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: text, skipDates: true }) });
        if (res.ok) help = await res.json();
      } catch { /* go on without suggestions */ }
      ctx.busy(false);
      state.items.pop();
      f.checked = true;
      if (help.clear) return askDates();
      persist();
      return bot(`A more specific request is easier for the city to search. ${help.questions.join(' ')}${help.suggestion ? `\n\nOne way to put it: **${help.suggestion}**` : ''}\n\nAdd more detail, or choose below.`, {
        buttons: (help.suggestion ? pick(help.suggestion, 'Use that wording') : '') + pick('keep', 'Keep what I wrote'),
      });
    }
    if (f.step === 'dates') {
      const d = parseDates(text);
      if (!d) { bot("I didn't catch the dates. Type a year like **2025**, a range like **2025-01-01 to 2025-06-30**, or **any**."); return; }
      f.date_from = d.from; f.date_to = d.to;
      return step('format', 'How would you like the records?', pick('electronic', 'Electronic copies') + pick('paper', 'Paper copies') + pick('inspection', 'Look at them at City Hall'));
    }
    if (f.step === 'format') {
      f.format = FORMATS[text] ? text : /paper|print/i.test(text) ? 'paper' : /inspect|look|view|city hall/i.test(text) ? 'inspection' : 'electronic';
      return step('name', 'What name should the request be under?');
    }
    if (f.step === 'name') {
      if (text.trim().length < 2) { bot('Please type your name.'); return; }
      f.fullName = text.trim();
      return step('contact', 'How should the city reach you about this request? An **email address** works best; a phone number is fine too.');
    }
    if (f.step === 'contact') {
      f.email = (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
      f.phone = (text.match(/\+?[\d\s().-]{7,}/) || [''])[0].trim();
      if (!f.email && !f.phone) { bot('I need an email address or phone number so the city can respond.'); return; }
      f.step = 'confirm'; persist(); drawFlowHint();
      card(`<h3>Ready to send</h3>
        <div class="row"><b>Records</b><span>${esc(f.records)}</span></div>
        <div class="row"><b>Dates</b><span>${esc(f.date_from || f.date_to ? `${f.date_from} to ${f.date_to}` : 'Any date')}</span></div>
        <div class="row"><b>Format</b><span>${esc(FORMATS[f.format])}</span></div>
        <div class="row"><b>Name</b><span>${esc(f.fullName)}</span></div>
        <div class="row"><b>Contact</b><span>${esc([f.email, f.phone].filter(Boolean).join(' · '))}</span></div>
        <div style="font-size:12.5px;color:var(--muted)">The city may charge its actual cost of searching, reviewing and copying records. You'll be told the amount before you pay anything.</div>
        <div class="actions" style="margin-top:2px"><button class="btn primary" data-act="rec-submit">${icon('send', 15)} Submit request</button><button class="btn" data-act="cancel-flow">Cancel</button></div>`);
    }
  }

  async function submit(btn) {
    const f = state.flow;
    if (f?.name !== 'records' || f.step !== 'confirm' || ctx.busy()) return;
    ctx.busy(true);
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await fetch(`${API}/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        records: f.records, date_from: f.date_from, date_to: f.date_to, format: f.format, name: f.fullName, email: f.email, phone: f.phone, convoId: state.convoId, source: 'chat' }) });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || 'Could not submit');
      state.flow = null;
      card(`<div style="display:flex;gap:10px;align-items:center"><span style="width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center">${icon('check')}</span><div><h3>Request submitted</h3><div style="font-size:13px;color:var(--muted)">The city will respond by ${esc(longDay(r.due))}</div></div></div>
        <div class="ref">${esc(r.ref)}</div>
        <div style="font-size:13.5px">Keep this link: it shows your request's progress, letters from the city and, when they're released, your records.</div>
        <div class="actions"><a class="btn primary" href="${esc(r.trackUrl)}" target="_blank" rel="noopener">${icon('search', 15)} Open my tracking page</a></div>`);
    } catch (e) {
      bot(`Sorry, that didn't go through (${esc(e.message)}). Please try again, or call City Hall at ${phone()}.`);
      btn.disabled = false; btn.textContent = 'Submit request';
    }
    ctx.busy(false);
    persist(); drawFlowHint();
  }

  async function track(ref) {
    const item = bot('', { pending: true });
    try {
      const res = await fetch(`${API}/records/track/${encodeURIComponent(ref.toUpperCase())}`);
      const r = await res.json();
      state.items.pop();
      if (!res.ok) { bot(`I couldn't find a records request numbered **${esc(ref.toUpperCase())}**. Check the number, or call City Hall at ${phone()}.`); return; }
      card(`<div class="ref">${esc(r.ref)}</div><h3>${esc(r.outcome ? OUTCOME[r.outcome] : STATUS[r.status] || r.status)}</h3>
        <div class="row"><b>Received</b><span>${esc(longDay(r.received_at.slice(0, 10)))}</span></div>
        ${r.closed_at ? '' : `<div class="row"><b>Response due</b><span>${esc(longDay(r.extended_due || r.due_date))}</span></div>`}
        ${r.updates.slice(-3).map((u) => `<div class="row"><b>${esc(new Date(u.at).toLocaleDateString())}</b><span>${esc(u.note)}</span></div>`).join('')}
        <div style="font-size:12.5px;color:var(--muted)">Letters and released records are on the tracking page linked when you submitted the request.</div>`);
    } catch {
      item.pending = false; item.text = 'I could not check that right now. Please try again in a moment.'; persist(); drawLog();
    }
  }

  return {
    tiles: () => `<button class="tile" data-act="records"><span>${icon('file')}</span>Public records</button>`,
    actions: (it) => (it.flags?.offerRecords ? `<div class="actions"><button class="btn primary" data-act="records">${icon('file', 15)} Request public records</button></div>` : ''),
    hint: (f) => (f.name === 'records' ? { label: 'Requesting public records', placeholder: HINTS[f.step] || 'Type your answer' } : null),
    click(a, el) {
      if (a === 'records') { start(); return true; }
      if (a === 'rec-pick') { push({ role: 'user', text: el.textContent.trim() }); answer(el.dataset.v, true); return true; }
      if (a === 'rec-submit') { submit(el); return true; }
      return false;
    },
    input(text) {
      const f = state.flow;
      if (f?.name === 'records' && f.step !== 'confirm') { push({ role: 'user', text }); answer(text); return true; }
      const ref = text.match(/\b[A-Z]{2,5}-PRR-\d{4,6}\b/i);
      if (ref && (f?.name === 'track' || /status|track|update|where|check|^\s*[A-Z]{2,5}-PRR-\d+\s*$/i.test(text))) {
        push({ role: 'user', text });
        state.flow = null; persist(); drawFlowHint();
        track(ref[0]);
        return true;
      }
      return false;
    },
  };
});
