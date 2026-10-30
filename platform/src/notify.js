// Messages to residents: email (Resend), text messages and phone calls (Twilio).
// Every message is written to the city's outbox, sent or not, so staff can see exactly what a resident was told.
// Without provider keys the message is recorded as not sent, and nothing leaves the platform.
//   RESEND_API_KEY, NOTIFY_FROM_EMAIL                       email
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM       text messages and calls

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function channels(env) {
  return { email: !!(env.RESEND_API_KEY && env.NOTIFY_FROM_EMAIL), sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM), call: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) };
}

function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : null;
}

function emailHtml({ city, subject, body, link, linkLabel }) {
  const color = city.settings.brandColor || '#1f5c46';
  const paras = body.split(/\n{2,}/).map((p) => (/^[-•] /m.test(p)
    ? `<ul style="padding-left:20px;margin:0 0 14px">${p.split('\n').map((l) => `<li style="margin:4px 0">${esc(l.replace(/^[-•]\s*/, ''))}</li>`).join('')}</ul>`
    : `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`)).join('');
  return `<!doctype html><html><body style="margin:0;background:#f3f1ea;font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0b1324">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:${esc(color)};color:#fff;border-radius:14px 14px 0 0;padding:16px 22px;font-weight:700">${esc(city.name)}</div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:22px">
      <h1 style="font-size:19px;margin:0 0 14px">${esc(subject)}</h1>${paras}
      ${link ? `<p style="margin:20px 0 6px"><a href="${esc(link)}" style="display:inline-block;background:${esc(color)};color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:10px">${esc(linkLabel || 'Open')}</a></p>` : ''}
    </div>
    <p style="font-size:12px;color:#5e6779;margin:14px 4px">${esc(city.settings.address || '')}${city.settings.phone ? ` · ${esc(city.settings.phone)}` : ''}<br>Sent by City Hall OS on behalf of ${esc(city.name)}.</p>
  </div></body></html>`;
}

async function sendEmail(env, city, to, msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.NOTIFY_FROM_EMAIL.includes('<') ? env.NOTIFY_FROM_EMAIL : `${city.name} <${env.NOTIFY_FROM_EMAIL}>`,
      to: [to], subject: msg.subject, html: emailHtml({ city, ...msg }),
      text: `${msg.body}${msg.link ? `\n\n${msg.linkLabel || 'Open'}: ${msg.link}` : ''}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Resend ${res.status}`);
  return data.id;
}

async function twilio(env, path, params) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Twilio ${res.status}`);
  return data.sid;
}

// msg: { subject, body, sms, voice, link, linkLabel }. to: { email, phone, pref }.
// Sends on the preferred channel. A phone call is always followed by a text or email with the details.
export async function notify(env, store, city, { entityType, entityId, to, msg }) {
  const pref = to.pref || (to.email ? 'email' : 'sms');
  const plan = pref === 'call' ? ['call', to.phone ? 'sms' : 'email'] : [pref];
  const results = [];
  for (const ch of plan) {
    const addr = ch === 'email' ? to.email : e164(to.phone);
    const text = ch === 'email' ? msg.body : ch === 'sms' ? `${city.settings.shortName} City Hall: ${msg.sms || msg.subject}${msg.link ? ` ${msg.link}` : ''}` : msg.voice || msg.sms || msg.subject;
    let status = 'not_configured'; let providerId = null; let error = null;
    if (!addr) { status = 'failed'; error = `No ${ch === 'email' ? 'email address' : 'valid phone number'} on file`; }
    else if (channels(env)[ch]) {
      try {
        if (ch === 'email') providerId = await sendEmail(env, city, addr, msg);
        else if (ch === 'sms') providerId = await twilio(env, 'Messages.json', { To: addr, From: env.TWILIO_FROM, Body: text.slice(0, 1500) });
        else {
          const say = `<Response><Pause length="1"/><Say voice="Polly.Joanna">Hello, this is the ${esc(city.name)}. ${esc(text)} We have also sent you the details in writing. Thank you.</Say></Response>`;
          providerId = await twilio(env, 'Calls.json', { To: addr, From: env.TWILIO_FROM, Twiml: say });
        }
        status = 'sent';
      } catch (e) { status = 'failed'; error = e.message.slice(0, 300); }
    }
    await store.recordOutbox({ entity_type: entityType, entity_id: entityId, channel: ch, to_addr: addr || to.email || to.phone || null, subject: msg.subject, body: ch === 'email' ? `${msg.body}${msg.link ? `\n\n${msg.link}` : ''}` : text, status, provider_id: providerId, error });
    results.push({ channel: ch, status, error });
  }
  return results;
}
