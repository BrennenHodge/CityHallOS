/*!
 * City Hall OS: business license add-on for the AI City Clerk chat (embed.js loads it).
 * Guided applications and renewals, application tracking and "is this business licensed?" lookup.
 * The assistant only collects and explains; City Hall staff review, assess the fee and issue every license.
 */
(() => {
  if (!window.__cityhallosRegister) return;
  window.__cityhallosRegister((c) => {
    const { API, ORIGIN, CITY, esc, md, state, persist, push, bot, card, drawFlowHint, focusInput } = c;
    const BADGE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h5"/><circle cx="15" cy="16" r="2.2"/></svg>';
    const REF = /\b[A-Z]{2,5}-BL-\d{3,}\b/i;
    const LIC = /\b[A-Z]{2,5}-LIC-\d{3,}\b/i;
    const STATUS = { submitted: 'Received', in_review: 'Under review', needs_info: 'More information needed', awaiting_payment: 'Fee assessed, payment due',
      paid: 'Paid, license being prepared', issued: 'License issued', denied: 'Not approved', withdrawn: 'Withdrawn' };
    const STEPS = ['submitted', 'in_review', 'awaiting_payment', 'issued'];
    const LIC_STATUS = { active: 'Active', expired: 'Expired', revoked: 'Revoked' };
    const money = (cents) => `$${(cents / 100).toFixed(2)}`;
    const day = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    const trackPage = (ref) => `${ORIGIN}/licenses.html?city=${encodeURIComponent(CITY)}&ref=${encodeURIComponent(ref)}`;
    const phone = () => c.cfg()?.phone || 'City Hall';

    const post = async (path, body) => {
      const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      return data;
    };
    const setFlow = (f) => { state.flow = f; persist(); drawFlowHint(); };

    /* ---------------- Guided application ---------------- */

    // One step: send the answer, show what the server explains, then ask the next missing question.
    async function step(body) {
      const f = state.flow;
      if (!f || c.busy()) return;
      c.busy(true);
      const pending = bot('', { pending: true });
      try {
        const r = await post('/licenses/intake', { draft: f.draft, ...body });
        state.items.splice(state.items.indexOf(pending), 1);
        f.draft = r.draft;
        if (r.intro) bot(r.intro);
        for (const n of r.notes || []) bot(n);
        if (r.error) bot(r.error);
        if (r.ask) {
          f.field = r.ask.field;
          const choices = (r.ask.choices || []).map(([v, l]) => `<button class="btn" data-act="lic-choice" data-v="${esc(v)}">${esc(l)}</button>`).join('');
          bot(r.ask.text, { buttons: choices + (r.ask.optional ? '<button class="btn" data-act="lic-skip">Skip</button>' : '') });
        } else if (r.ready) {
          f.field = null;
          const pay = r.payments?.enabled ? r.review.payNow : null;
          f.payNow = pay ? pay.cents : null;
          f.testMode = !!r.payments?.testMode;
          card(`<h3>Ready to send to City Hall</h3>
            ${r.review.rows.map(([k, v]) => `<div class="row"><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}
            ${pay ? `<div style="border-top:1px dashed var(--line);padding-top:8px;display:grid;gap:4px">${pay.lines.map((l) => `<div class="row"><b>Fee</b><span>${esc(l.label)}: ${money(l.cents)}</span></div>`).join('')}
              <div class="row"><b>Due now</b><span><strong>${money(pay.cents)}</strong> for ${day(pay.period.start)} to ${day(pay.period.end)}</span></div></div>`
              : r.review.estimate ? `<div class="row"><b>Estimated fee</b><span>${esc(r.review.estimate)}</span></div>` : ''}
            <div style="font-size:13px;color:var(--muted)">${pay ? "Pay now and City Hall gets your application with the fee paid. Staff review it, confirm the fee and issue the license; if they can't approve it, your payment is refunded."
              : 'City Hall sets the fee for this application during review. You can pay online once it is set, or by cash or check at City Hall.'}</div>
            <div class="actions" style="margin-top:2px">${pay ? `<button class="btn primary" data-act="lic-pay-open">Pay ${money(pay.cents)} and send</button><button class="btn" data-act="lic-submit">Send now, pay later</button>`
              : '<button class="btn primary" data-act="lic-submit">Send application</button>'}<button class="btn" data-act="cancel-flow">Cancel</button></div>`);
        } else {
          bot(`I still need ${r.missing.join(', ').replace(/_/g, ' ')}. Please call City Hall at ${phone()} if you're stuck.`);
        }
      } catch (e) {
        pending.pending = false;
        pending.text = `${e.message} You can also apply at City Hall, ${phone()}.`;
      }
      c.busy(false);
      persist(); c.drawLog(); drawFlowHint(); focusInput();
    }

    function start(message) {
      setFlow({ name: 'license', draft: {}, field: null });
      step(message ? { message } : {});
    }

    /* ---------------- Card payment ---------------- */

    // The card form. Card details stay in these inputs and go straight to City Hall OS when the resident pays;
    // they are never typed into the chat, saved in the conversation or sent to the AI.
    const payForm = (cents, ref, testMode) => `<style>.pay{display:grid;gap:8px}.pay label{display:grid;gap:3px;font-size:12.5px;font-weight:600;color:var(--muted)}
      .pay input{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:var(--paper);font-size:14.5px;color:var(--ink);width:100%}
      .pay input:focus{border-color:var(--brand);background:#fff;outline:none}.pay .two{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
      .pay .err{color:#b42318;font-size:13px}</style>
      <form class="pay" data-pay="${esc(ref || '')}" data-cents="${cents}" autocomplete="on">
        <h3 style="display:flex;justify-content:space-between;align-items:center">Pay ${money(cents)}${testMode ? '<span class="tag">Test mode</span>' : ''}</h3>
        <label>Name on card<input name="name" autocomplete="cc-name" required></label>
        <label>Card number<input name="number" inputmode="numeric" autocomplete="cc-number" placeholder="1234 1234 1234 1234" required></label>
        <div class="two"><label>Expires<input name="exp" autocomplete="cc-exp" placeholder="MM/YY" required></label>
          <label>Security code<input name="cvc" inputmode="numeric" autocomplete="cc-csc" placeholder="CVC" required></label>
          <label>ZIP<input name="zip" inputmode="numeric" autocomplete="postal-code" placeholder="39577"></label></div>
        <div class="err" hidden></div>
        ${testMode ? '<div style="font-size:12px;color:var(--muted)">No card processor is connected yet, so only test cards are accepted, such as 4242 4242 4242 4242 with any future date and any security code.</div>' : ''}
        <div class="actions" style="margin-top:2px"><button class="btn primary" type="button" data-act="lic-pay">Pay ${money(cents)}</button><button class="btn" type="button" data-act="lic-pay-cancel">Not now</button></div>
      </form>`;

    async function pay(el) {
      const form = el.closest('form.pay');
      const err = form.querySelector('.err');
      const details = Object.fromEntries(['name', 'number', 'exp', 'cvc', 'zip'].map((k) => [k, form.elements[k].value.trim()]));
      if (!details.number || !details.exp || !details.cvc) { err.textContent = 'Enter the card number, expiration date and security code.'; err.hidden = false; return; }
      el.disabled = true; el.textContent = 'Paying…'; err.hidden = true;
      const ref = form.dataset.pay;
      const expectCents = Number(form.dataset.cents);
      try {
        if (ref) {
          const r = await post(`/licenses/track/${encodeURIComponent(ref)}/pay`, { card: details, expectCents });
          dropPayForms();
          receipt(r.paid, `Payment received for **${ref}**. City Hall staff will issue your license and let you know.`);
        } else {
          await submit({ details, expectCents });
        }
      } catch (e) {
        el.disabled = false; el.textContent = `Pay ${money(expectCents)}`;
        err.textContent = e.message; err.hidden = false;
      }
    }

    const paidHtml = (p, text) => `<div style="display:flex;gap:10px;align-items:center"><span style="width:34px;height:34px;border-radius:10px;background:var(--brand);color:#fff;display:grid;place-items:center">✓</span>
      <div><h3>Paid ${money(p.amount_cents)}</h3><div style="font-size:13px;color:var(--muted)">${esc(p.brand)} ending ${esc(p.last4)} · receipt ${esc(p.id)}</div></div></div>
      <div style="font-size:13.5px">${text}</div>`;
    const receipt = (p, text) => card(paidHtml(p, md(text)));
    const dropPayForms = () => { state.items = state.items.filter((it) => !(it.kind === 'card' && it.html.includes('form class="pay"'))); persist(); };

    async function submit(payment) {
      const f = state.flow;
      if (!f || c.busy()) return;
      c.busy(true);
      try {
        const r = await post('/licenses/applications', { draft: f.draft, convoId: state.convoId, source: c.PAGE ? 'portal' : 'web', ...(payment ? { payment: payment.details, expectCents: payment.expectCents } : {}) });
        setFlow(null);
        dropPayForms();
        // The review card's buttons are spent once it is sent.
        for (const it of state.items) if (it.kind === 'card' && it.html.includes('data-act="lic-submit"')) it.html = it.html.replace(/<div class="actions" style="margin-top:2px">[\s\S]*$/, '');
        card(`<h3>Application sent to City Hall${r.paid ? ' and paid' : ''}</h3>
          <div class="ref">${esc(r.ref)}</div>
          ${r.paid ? `<div class="row"><b>Paid</b><span>${money(r.paid.amount_cents)} · ${esc(r.paid.brand)} ending ${esc(r.paid.last4)}</span></div><div class="row"><b>Receipt</b><span>${esc(r.paid.id)}</span></div>` : ''}
          <div style="font-size:13.5px">Save this number. City Hall staff will review your application${r.paid ? ', confirm the fee and issue your license' : ' and let you know the fee'}, or tell you if anything else is needed. Type the number here any time to check on it.</div>
          <div class="actions"><a class="btn" href="${esc(r.trackUrl)}" target="_blank" rel="noopener">Open the tracking page</a></div>`);
      } catch (e) {
        c.busy(false);
        if (payment) throw e;
        bot(`Sorry, that didn't go through (${esc(e.message)}). Please try again, or call City Hall at ${phone()}.`);
      }
      c.busy(false);
      persist(); drawFlowHint();
    }

    /* ---------------- Tracking and lookup ---------------- */

    async function track(ref) {
      const pending = bot('', { pending: true });
      try {
        const res = await fetch(`${API}/licenses/track/${encodeURIComponent(ref.toUpperCase())}`);
        const r = await res.json();
        state.items.splice(state.items.indexOf(pending), 1);
        if (!res.ok) { bot(`I couldn't find a business license application numbered **${esc(ref.toUpperCase())}**. Check the number, or call City Hall at ${phone()}.`); return; }
        const at = Math.max(0, STEPS.indexOf(r.status === 'needs_info' ? 'in_review' : r.status === 'paid' ? 'awaiting_payment' : r.status));
        const last = r.updates.slice(-3).reverse();
        card(`<div class="ref">${esc(r.ref)}</div><h3>${esc(STATUS[r.status] || r.status)}</h3>
          ${['denied', 'withdrawn'].includes(r.status) ? '' : `<div class="progress">${STEPS.map((s, i) => `<i class="${i <= at ? 'on' : ''}"></i>`).join('')}</div>`}
          <div class="row"><b>Business</b><span>${esc(r.business_name)}</span></div>
          <div class="row"><b>Type</b><span>${r.kind === 'renewal' ? 'Renewal' : 'New license'}${r.class_label ? ` · ${esc(r.class_label)}` : ''}</span></div>
          ${r.fee_cents != null ? `<div class="row"><b>Fee</b><span>${money(r.fee_cents)}${r.paid ? ' · paid' : ''}</span></div>` : ''}
          ${r.license ? `<div class="row"><b>License</b><span>${esc(r.license.number)} · valid through ${day(r.license.expires_on)}</span></div>` : ''}
          ${r.decision_reason ? `<div class="row"><b>Reason</b><span>${esc(r.decision_reason)}</span></div>` : ''}
          ${r.next ? `<div style="font-size:13.5px">${esc(r.next)}</div>` : ''}
          ${last.length ? `<div style="font-size:12.5px;color:var(--muted)">${last.map((u) => `${new Date(u.at).toLocaleDateString()}: ${esc(u.note || STATUS[u.status])}`).join('<br>')}</div>` : ''}
          <div class="actions">
            ${r.certificate ? `<a class="btn primary" href="${esc(`${API}/licenses/track/${r.ref}/certificate`)}" target="_blank" rel="noopener">Download license (PDF)</a>` : ''}
            ${r.canPay && r.payments?.enabled ? `<button class="btn primary" data-act="lic-pay-open" data-ref="${esc(r.ref)}" data-cents="${r.balance_cents}" data-test="${r.payments.testMode ? 1 : ''}">Pay ${money(r.balance_cents)} now</button>` : ''}
            ${r.status === 'needs_info' ? `<button class="btn primary" data-act="lic-reply" data-ref="${esc(r.ref)}">Reply to City Hall</button>` : ''}
            <a class="btn" href="${esc(trackPage(r.ref))}" target="_blank" rel="noopener">Tracking page</a>
          </div>`);
      } catch {
        pending.pending = false; pending.text = 'I could not check that right now. Please try again in a moment.'; persist(); c.drawLog();
      }
    }

    async function lookup(q) {
      const pending = bot('', { pending: true });
      try {
        const res = await fetch(`${API}/licenses/lookup?q=${encodeURIComponent(q)}`);
        const r = await res.json();
        state.items.splice(state.items.indexOf(pending), 1);
        if (!res.ok) { bot(esc(r.error || 'Please try a different name.')); return; }
        if (!r.results.length) { bot(`I didn't find a business license matching **${esc(q)}**. The registry may not include licenses issued on paper yet, so City Hall (${phone()}) can confirm.`); return; }
        card(`<h3>Business licenses matching "${esc(q)}"</h3><div class="forms">${r.results.map((l) => `
          <div class="src"><span class="n">${BADGE.replace(/18/g, '12')}</span><span><strong>${esc(l.business_name)}${l.dba ? ` (${esc(l.dba)})` : ''}</strong>
          <small>${esc(l.number)} · ${esc(l.location || '')}<br>${l.status === 'active' ? `Active through ${day(l.expires_on)}` : l.status === 'expired' ? `Expired ${day(l.expires_on)}` : 'Revoked'}
          ${l.status !== 'active' ? `<span class="tag">${LIC_STATUS[l.status]}</span>` : ''}</small></span></div>`).join('')}</div>`);
      } catch {
        pending.pending = false; pending.text = 'I could not search the registry right now. Please try again in a moment.'; persist(); c.drawLog();
      }
    }

    async function reply(ref, message) {
      try {
        await post(`/licenses/track/${encodeURIComponent(ref)}/reply`, { message });
        bot(`Thanks. I added your reply to **${esc(ref)}** for City Hall staff.`);
      } catch (e) {
        bot(`${esc(e.message)} You can also call City Hall at ${phone()}.`);
      }
    }

    // The last thing the resident typed before item i, to give the intake a head start.
    const askedBefore = (i) => [...state.items].slice(0, i).reverse().find((x) => x.role === 'user')?.text || '';

    return {
      tiles: () => `<button class="tile" data-act="lic-start"><span>${BADGE}</span>Business license</button>`,

      actions(it, i) {
        if (!it.flags?.offerLicense || it.licenseOffered) return '';
        return `<div class="actions"><button class="btn primary" data-act="lic-from" data-i="${i}">${BADGE.replace(/18/g, '15')} Apply or renew</button>
          <button class="btn" data-act="lic-lookup">Is a business licensed?</button></div>`;
      },

      hint(f) {
        if (f.name === 'license') return { label: 'Business license application', placeholder: 'Type your answer, or ask a question' };
        if (f.name === 'license-track') return { label: 'Checking a license application', placeholder: 'Your reference number, like ABC-BL-1001' };
        if (f.name === 'license-lookup') return { label: 'Business license lookup', placeholder: 'Business name or license number' };
        if (f.name === 'license-reply') return { label: `Replying on ${f.ref}`, placeholder: 'Your reply to City Hall' };
        return null;
      },

      click(a, el) {
        if (a === 'lic-start') { push({ role: 'user', text: 'Business license' }); start(''); return true; }
        if (a === 'lic-from') {
          const it = state.items[Number(el.dataset.i)];
          if (it) it.licenseOffered = true;
          start(askedBefore(Number(el.dataset.i)));
          return true;
        }
        if (a === 'lic-choice' && state.flow?.name === 'license') { push({ role: 'user', text: el.textContent.trim() }); step({ field: state.flow.field, answer: el.dataset.v }); return true; }
        if (a === 'lic-skip' && state.flow?.name === 'license') { push({ role: 'user', text: 'Skip' }); step({ field: state.flow.field, answer: 'skip' }); return true; }
        if (a === 'lic-submit') { submit(); return true; }
        if (a === 'lic-pay-open') {
          const cents = el.dataset.ref ? Number(el.dataset.cents) : state.flow?.payNow;
          if (!cents) return true;
          card(payForm(cents, el.dataset.ref || '', el.dataset.ref ? !!el.dataset.test : state.flow?.testMode));
          return true;
        }
        if (a === 'lic-pay') { pay(el); return true; }
        if (a === 'lic-pay-cancel') {
          dropPayForms(); c.drawLog();
          return true;
        }
        if (a === 'lic-lookup') { setFlow({ name: 'license-lookup' }); bot("What's the name of the business, or its license number?"); focusInput(); return true; }
        if (a === 'lic-reply') { setFlow({ name: 'license-reply', ref: el.dataset.ref }); bot(`What would you like to tell City Hall about **${esc(el.dataset.ref)}**?`); focusInput(); return true; }
        return false;
      },

      input(text) {
        const f = state.flow;
        if (f?.name === 'license') {
          push({ role: 'user', text });
          // A question in the middle of the application goes to the AI City Clerk, then the application picks up again.
          if (/\?\s*$/.test(text) && text.split(/\s+/).length > 2 && f.field) {
            c.ask(text).then(() => { if (state.flow?.name === 'license') step({ resume: true }); });
            return true;
          }
          step(f.field ? { field: f.field, answer: text } : { message: text });
          return true;
        }
        if (f?.name === 'license-lookup') { push({ role: 'user', text }); setFlow(null); lookup(text.trim()); return true; }
        if (f?.name === 'license-reply') { push({ role: 'user', text }); setFlow(null); reply(f.ref, text); return true; }
        if (f?.name === 'license-track' || (!f && REF.test(text))) {
          push({ role: 'user', text });
          setFlow(null);
          track((text.match(REF) || [text.trim()])[0]);
          return true;
        }
        if (!f && LIC.test(text) && /\brenew/i.test(text)) { push({ role: 'user', text }); start(text); return true; }
        return false;
      },
    };
  });
})();
