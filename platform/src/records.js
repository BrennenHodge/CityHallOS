// Records assistant: public records requests from intake to release.
//
// Residents ask through the chat widget or the portal; the AI helps them narrow a vague request. Staff work the queue:
// assign, gather records, estimate the actual-cost fee, request payment, review each file for redactions, and release.
// The AI only suggests (likely responsive documents, letter drafts, possible redactions). Staff make every release
// decision, and nothing reaches a requester until a staff member approves and sends it.
// Deadline and fee rules are per city (records-rules.js); every action is in the audit log.
import { search } from './search.js';
import { generate } from './assistant.js';
import { extractText, guessMime } from './ingest.js';
import { addWorkingDays, deadlineState, defaultRecordsSettings, estimateFees, findRedactions, localDay, money } from './records-rules.js';
import { OPEN_STATUSES } from './records-store.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status, error) => json({ error }, status);
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clean = (v, max = 300) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const AI_ACTOR = { type: 'ai', id: null, name: 'Records assistant' };

export const FORMATS = { electronic: 'Electronic copies', paper: 'Paper copies', inspection: 'Inspect in person' };
export const OUTCOMES = ['fulfilled', 'partial', 'denied', 'no_records', 'withdrawn'];

// Questions that should start a records request rather than get an answer from the knowledge base.
export const wantsRecords = (text) => /\b(public records?|open records?|records? request|foia|freedom of information|25-61)\b/i.test(text)
  || /\b(copies|copy|obtain|request)\b.{0,40}\b(records?|emails?|minutes|contracts?|invoices?|police reports?|incident reports?|personnel files?)\b/i.test(text);

export function recordsIntro(s) {
  return `You can request public records from the City of ${s.shortName} under state law. I'll help you describe what you need, ` +
    'and you\'ll get a tracking number and a link to follow your request. Tap **Request public records** below to start.';
}

export async function recordsSettings(city, store) {
  const d = defaultRecordsSettings(city.state);
  const stored = (await store.records('getSettings')) || {};
  return { ...d, ...stored, fees: { ...d.fees, ...(stored.fees || {}) } };
}

const today = (city) => localDay(new Date().toISOString(), city.timezone);
const trackLink = (url, city, r, key) => `${url.origin}/records?city=${encodeURIComponent(city.slug)}&ref=${encodeURIComponent(r.ref)}${key ? `&key=${key}` : ''}`;

/* ---------------- Notices to requesters ---------------- */

// NOTIFY HOOK. Requester notices (acknowledgment, fee estimate, extension, delivery) go through notify.js once it is on
// main: email via Resend, SMS via Twilio, every message kept in the outbox. Replace the marked line with
//   await notify(env, store, city, { entityType: 'records_request', entityId: r.ref, to: { email: r.email, phone: r.phone }, msg: { subject, text } });
// Until then the notice is recorded on the request's timeline, and the requester reads every sent letter on their
// tracking page (the link they got when they submitted).
async function sendToRequester(env, store, city, r, actor, { subject, text }) {
  const to = [r.email, r.phone].filter(Boolean).join(' / ') || 'no email or phone on file';
  // --- replace with notify(...) when notify.js lands ---
  await store.records('noticeLogged', r.id, actor, `Notice "${subject}" for ${to}: shown on the tracking page; email and text delivery isn't connected yet.`);
  return text.length ? 'tracking page' : '';
}

/* ---------------- AI helpers ---------------- */

async function complete(env, system, user, ms = 20000) {
  let out = '';
  const run = (async () => { for await (const t of generate(env, system, [{ role: 'user', content: user }])) out += t; })();
  await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(new Error('AI timed out')), ms))]);
  return out.replace(/<<[A-Z_]+>>/g, '').trim();
}

// Plain checks that always run; the AI adds a plainer rewrite when it's available.
function scopeIssues(text, from, to, askDates = true) {
  const words = text.split(/\s+/).filter(Boolean).length;
  const out = [];
  if (askDates && !from && !to && !/\b(19|20)\d\d\b/.test(text)) out.push('What dates should the search cover? A narrower range is faster and usually costs less.');
  if (words < 6) out.push('Which records, specifically? For example a type of document (minutes, contracts, emails, reports), a subject, an address or a case number.');
  if (/\b(all|any|every|everything)\b/i.test(text) && /\b(emails?|records|documents|files|correspondence)\b/i.test(text)) {
    out.push('Can you name the people, departments or subjects involved? "All emails" style requests take much longer to search and review.');
  }
  return out;
}

async function assistScope(env, city, b) {
  const text = clean(b.records, 2000) || '';
  // The chat asks for dates as its next step, so it skips that question here.
  const questions = scopeIssues(text, b.date_from, b.date_to, !b.skipDates);
  let suggestion = null;
  if (text && questions.length) {
    try {
      const raw = await complete(env,
        `You help residents of the City of ${city.settings.shortName}, ${city.settings.state} write clear public records requests. ` +
        'Rewrite the resident\'s request as one sentence a records clerk could search more easily: name the kind of record (minutes, contracts, ' +
        'invoices, emails between named offices) when their words imply it. Keep their meaning; do not add records, people or dates they did not mention, ' +
        'do not say whether records exist, and do not give legal advice. If it can\'t be made more specific without guessing, reply NONE. ' +
        'Otherwise reply with only the rewritten request.',
        `Request: ${text}\nDate range: ${b.date_from || 'not given'} to ${b.date_to || 'not given'}`, 12000);
      const line = raw.split('\n').find((l) => l.trim())?.replace(/^["']|["']$/g, '').trim() || '';
      // A rewrite that only rephrases the same words isn't worth offering.
      suggestion = !/^none\b/i.test(line) && line.toLowerCase() !== text.toLowerCase() && line.length > text.length ? line.slice(0, 400) : null;
    } catch (e) {
      console.log('records assist', e.message);
    }
  }
  return { clear: !questions.length, questions, suggestion };
}

// Likely responsive documents in the knowledge base, offered to staff as suggestions.
async function findDocuments(env, city, store, r) {
  const q = [r.summary || r.records, r.date_from && r.date_from.slice(0, 4), r.date_to && r.date_to.slice(0, 4)].filter(Boolean).join(' ');
  const hits = await search(env, store, city.settings, q, { includeInternal: true, limit: 8 });
  const seen = new Set();
  const items = [];
  for (const h of hits) {
    if (seen.has(h.doc.id)) continue;
    seen.add(h.doc.id);
    items.push({ docId: h.doc.id, title: h.doc.title, category: h.doc.category, heading: h.heading, excerpt: h.text.slice(0, 300),
      score: Math.round(h.score * 1000) / 1000, visibility: h.doc.visibility, as_of: h.doc.as_of });
  }
  return store.records('addSuggestions', r.id, items, AI_ACTOR);
}

/* ---------------- Letters ---------------- */

// "November 10, 2026": how dates read in a letter.
const longDate = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

function letterFacts(city, settings, r, extra = {}) {
  const s = city.settings;
  return {
    city: s.cityName, custodian: settings.custodian || 'City Clerk', phone: s.phone, address: s.address, statute: settings.statute,
    feeStatute: settings.feeStatute, ref: r.ref, name: r.name, received: longDate(localDay(r.received_at, city.timezone)),
    due: longDate(r.extended_due || r.due_date), records: r.summary || r.records,
    dates: r.date_from || r.date_to ? `${r.date_from ? longDate(r.date_from) : 'the beginning'} to ${r.date_to ? longDate(r.date_to) : 'the present'}` : null,
    format: FORMATS[r.format], ...extra,
  };
}

// The deterministic version of each letter. The AI drafts from the same facts; this is used when it can't.
function templateLetter(kind, f) {
  const sign = signature(f);
  const law = f.statute ? ` under the Public Records Act (${f.statute})` : '';
  const what = `${f.records}${f.dates ? ` (${f.dates})` : ''}`;
  const L = {
    acknowledgment: [`We received your public records request ${f.ref}`,
      `Dear ${f.name},\n\nThe ${f.city} received your public records request${law} on ${f.received}, for: ${what}.\n\nYour reference number is ${f.ref}. ` +
      `We will respond by ${f.due}. If we need to clarify the request or a fee applies, we will contact you before then. You can follow your request with the tracking link we sent you.${sign}`],
    fee_estimate: [`Fee estimate for public records request ${f.ref}`,
      `Dear ${f.name},\n\nThe estimated cost to respond to request ${f.ref} is ${f.fee}. ${f.feeLines ? `\n\n${f.feeLines}\n\n` : ''}` +
      `This is the city's actual cost of searching, reviewing and copying the records${f.feeStatute ? ` (${f.feeStatute})` : ''}. ` +
      `${f.prepay ? 'Payment is needed before the records are released. ' : ''}Please contact ${f.custodian}${f.phone ? ` at ${f.phone}` : ''} to pay or to narrow the request.${sign}`],
    response: [`Records for your public records request ${f.ref}`,
      `Dear ${f.name},\n\nIn response to request ${f.ref} for ${what}, the records are ready. ${f.fileCount ? `${f.fileCount} ${f.fileCount === 1 ? 'file is' : 'files are'} available to download from your tracking link.` : ''}${sign}`],
    denial: [`Response to public records request ${f.ref}`,
      `Dear ${f.name},\n\nThe ${f.city} has reviewed request ${f.ref} for ${what}. ${f.partial ? 'Some records are released and some are withheld.' : 'The records are withheld.'} ` +
      `The records withheld are exempt under: ${f.exemptions || '[cite the specific exemption]'}.${f.reason ? `\n\n${f.reason}` : ''}${sign}`],
  };
  const [subject, body] = L[kind] || [`About your public records request ${f.ref}`, `Dear ${f.name},\n\n${sign}`];
  return { subject, body };
}

// The AI writes the middle of acknowledgment and response letters from the facts; greeting and signature are fixed.
// Fee and denial letters stay word-for-word templates: amounts and cited exemptions have to be exact.
const signature = (f) => `\n\nSincerely,\n${f.custodian}\n${f.city}${f.phone ? `\n${f.phone}` : ''}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const intact = (text, v) => !v || new RegExp(`(^|[\\s(])${escapeRe(v)}([\\s.,;:)]|$)`).test(text);

async function draftLetter(env, city, store, settings, r, kind, extra = {}) {
  const facts = letterFacts(city, settings, r, extra);
  const base = templateLetter(kind, facts);
  let body = base.body;
  let by = 'template';
  if (['acknowledgment', 'response'].includes(kind)) {
    try {
      const out = (await complete(env,
        "You draft letters from a city clerk's office to people who made public records requests. Write only the body paragraphs: no greeting, " +
        'no closing and no signature. Be short, plain and courteous. Use only the facts given. Do not invent dates, amounts, exemptions or records, ' +
        'do not say records exist unless the facts say so, and do not give legal advice. Copy dates and reference numbers exactly.',
        `Letter type: ${kind}\nFacts:\n${Object.entries(facts).filter(([, v]) => v != null && v !== '').map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n\nA correct version to improve on:\n${base.body}`))
        .replace(/^dear [^\n]*\n+/i, '').replace(/\n+(sincerely|regards|best regards|respectfully)[\s\S]*$/i, '').trim()
        // The model sometimes drops the space before a number ("by2026-11-10").
        .replace(/([A-Za-z,])(\d{4}-\d{2}-\d{2}|\d{1,2}, \d{4})/g, '$1 $2');
      // Keep the AI's version only if the reference number and the due date came through exactly.
      if (out.length > 60 && intact(out, r.ref) && (kind !== 'acknowledgment' || intact(out, facts.due))) {
        body = `Dear ${r.name},\n\n${out}${signature(facts)}`;
        by = 'ai';
      }
    } catch (e) {
      console.log('records draft', e.message);
    }
  }
  return store.records('addLetter', r.id, { kind, subject: base.subject, body, drafted_by: by }, by === 'ai' ? AI_ACTOR : { type: 'system', name: 'Records assistant' });
}

/* ---------------- Public: intake, scope help, tracking, downloads ---------------- */

export async function recordsPublic(request, env, ctx, city, store, me, parts, url) {
  const [, , id, a, b] = parts;
  const m = request.method;
  if (!id && m === 'POST') return intake(request, env, ctx, city, store, me, url);
  if (id === 'assist' && m === 'POST') {
    if (env.CHAT_LIMIT && !me && !(await env.CHAT_LIMIT.limit({ key: `${city.id}:${request.headers.get('CF-Connecting-IP') || 'anon'}` })).success) return fail(429, 'Too many messages. Please wait a minute.');
    return json(await assistScope(env, city, await request.json().catch(() => ({}))));
  }
  if (id === 'track' && a && m === 'GET') {
    const t = await store.records('track', String(a).toUpperCase().trim(), url.searchParams.get('key'));
    if (!t) return fail(404, 'No records request with that number');
    const settings = await recordsSettings(city, store);
    return json({ ...t, city: city.settings.cityName, custodian: settings.custodian, phone: city.settings.phone, formats: FORMATS }, 200, { 'Cache-Control': 'no-store' });
  }
  if (id === 'download' && a && b && m === 'GET') {
    const t = await store.records('track', String(a).toUpperCase(), url.searchParams.get('key'));
    const f = t?.verified && t.files.find((x) => x.id === b);
    const row = f && await store.records('file', b);
    const obj = row && await env.FILES.get(row.file_key);
    if (!obj) return fail(404, 'File not found');
    return new Response(obj.body, { headers: { 'Content-Type': row.mime || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', ...CORS } });
  }
  return null;
}

function intakeInput(b) {
  const p = {
    records: clean(b.records, 4000), summary: clean(b.summary, 1000), date_from: isDay(b.date_from) ? b.date_from : null, date_to: isDay(b.date_to) ? b.date_to : null,
    format: FORMATS[b.format] ? b.format : 'electronic', name: clean(b.name, 120), email: clean(b.email, 200)?.toLowerCase() ?? null, phone: clean(b.phone, 40),
    address: clean(b.address, 300), organization: clean(b.organization, 160), convo_id: clean(b.convoId, 20),
  };
  if (!p.records || p.records.length < 8) throw Object.assign(new Error('Please describe the records you want'), { status: 400 });
  if (!p.name) throw Object.assign(new Error('Please give your name'), { status: 400 });
  if (!p.email && !p.phone && !p.address) throw Object.assign(new Error('Please give an email, phone number or mailing address so the city can respond'), { status: 400 });
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) throw Object.assign(new Error('That email address doesn\'t look right'), { status: 400 });
  if (p.date_from && p.date_to && p.date_from > p.date_to) throw Object.assign(new Error('The start date is after the end date'), { status: 400 });
  return p;
}

async function intake(request, env, ctx, city, store, me, url) {
  const b = await request.json().catch(() => ({}));
  let p;
  try { p = intakeInput(b); } catch (e) { return fail(e.status || 400, e.message); }
  const byStaff = me?.can('records.manage') && b.source !== 'chat';
  if (env.CHAT_LIMIT && !me && !(await env.CHAT_LIMIT.limit({ key: `${city.id}:${request.headers.get('CF-Connecting-IP') || 'anon'}` })).success) return fail(429, 'Too many requests. Please wait a minute.');
  const settings = await recordsSettings(city, store);
  if (byStaff && isDay(b.received) && b.received > today(city)) return fail(400, "The date received can't be in the future");
  // Staff logging a request that came by mail or email date it from when the city received it.
  const receivedAt = isDay(b.received) && byStaff ? `${b.received}T17:00:00.000Z` : new Date().toISOString();
  const dueDate = addWorkingDays(localDay(receivedAt, city.timezone), settings.responseDays, settings);
  const source = byStaff ? (['email', 'mail', 'counter', 'phone'].includes(b.source) ? b.source : 'staff') : p.convo_id ? 'chat' : 'web';
  const actor = byStaff ? me.actor : { type: 'resident', id: null, name: p.convo_id ? `Resident via ${city.settings.assistantName}` : 'Resident' };
  const created = await store.records('create', { ...p, source }, actor, city.settings.requestPrefix, { receivedAt, dueDate });
  // Ready for staff when they open it: likely documents and an acknowledgment draft. Both are only suggestions.
  ctx.waitUntil((async () => {
    const r = await store.records('raw', created.id);
    await findDocuments(env, city, store, r).catch((e) => console.log('records find', e.message));
    await draftLetter(env, city, store, settings, r, 'acknowledgment').catch((e) => console.log('records ack draft', e.message));
  })());
  return json({ ref: created.ref, due: dueDate, statute: settings.statute, trackUrl: trackLink(url, city, created, created.accessKey), key: created.accessKey }, 201);
}

/* ---------------- Staff ---------------- */

const hideContact = (r) => ({ ...r, name: r.name ? 'Hidden' : null, email: r.email ? 'Hidden' : null, phone: r.phone ? 'Hidden' : null, address: r.address ? 'Hidden' : null });

export async function recordsStaff(request, env, ctx, city, store, me, need, parts, url) {
  const [, , id, sub, subId, action] = parts;
  const m = request.method;
  const body = async () => (request.headers.get('Content-Type') || '').includes('json') ? request.json().catch(() => ({})) : {};
  const settings = await recordsSettings(city, store);
  const shown = (r) => (me.can('records.manage') || me.can('residents.contact') ? r : hideContact(r));
  const withDeadline = (r) => ({ ...shown(r), deadline: deadlineState(r, settings, today(city)) });

  if (!id && m === 'GET') {
    need('records.view');
    return json({ requests: (await store.records('list')).map(withDeadline), settings: publicSettings(settings), today: today(city) });
  }
  if (!id && m === 'POST') { need('records.manage'); return intake(request, env, ctx, city, store, me, url); }
  if (id === 'settings' && m === 'GET') { need('records.view'); return json(settings); }
  if (id === 'settings' && m === 'PUT') { need('settings.edit'); return saveSettings(await body(), city, store, me, settings); }
  if (id === 'export' && m === 'GET') { need('records.manage'); return exportLog(city, store, me, url); }

  const rid = Number(id);
  const r = Number.isInteger(rid) && await store.records('raw', rid);
  if (!r) return fail(404, 'Records request not found');

  if (!sub && m === 'GET') {
    need('records.view');
    const full = await store.records('get', rid);
    return json({ ...full, request: withDeadline(full.request), settings: publicSettings(settings),
      trackUrl: me.can('records.manage') ? trackLink(url, city, r, r.access_key) : null });
  }

  need('records.manage');
  const b = await body();
  const done = async () => { const full = await store.records('get', rid); return json({ ...full, request: withDeadline(full.request) }); };
  const closed = r.status === 'closed';
  try {
    if (!sub && m === 'PATCH') {
      const patch = {};
      if (OPEN_STATUSES.includes(b.status)) patch.status = b.status;
      if ('assignee_id' in b) patch.assignee_id = clean(b.assignee_id, 20);
      if ('department_id' in b) patch.department_id = clean(b.department_id, 60);
      if ('summary' in b) patch.summary = clean(b.summary, 1000);
      if (b.note) patch.note = clean(b.note, 1000);
      await store.records('update', rid, patch, me.actor);
      return done();
    }
    if (closed && !(sub === 'files' && m === 'GET')) return fail(400, 'This request is closed');

    if (sub === 'find' && m === 'POST') {
      const n = await findDocuments(env, city, store, r);
      return json({ added: n, ...(await store.records('get', rid)) });
    }
    if (sub === 'draft' && m === 'POST') {
      if (!['acknowledgment', 'fee_estimate', 'response', 'denial'].includes(b.kind)) return fail(400, 'Choose a letter type');
      await draftLetter(env, city, store, settings, r, b.kind, letterExtras(b, r, settings, await store.records('get', rid)));
      return done();
    }
    if (sub === 'suggestions' && subId && m === 'POST') {
      if (!['accepted', 'rejected'].includes(b.decision)) return fail(400, 'Accept or reject');
      const s = await store.records('decideSuggestion', subId, b.decision, me.actor);
      if (!s || s.request_id !== rid) return fail(404, 'Suggestion not found');
      if (b.decision === 'accepted') await attachDocument(env, city, store, me, r, s.payload.docId);
      return done();
    }
    if (sub === 'files' && !subId && m === 'POST') { await uploadFiles(request, env, city, store, me, r); return done(); }
    if (sub === 'files' && subId) {
      const f = await store.records('file', subId);
      if (!f || f.request_id !== rid) return fail(404, 'File not found');
      if (m === 'GET') {
        const obj = await env.FILES.get(f.file_key);
        if (!obj) return fail(404, 'File not found');
        return new Response(obj.body, { headers: { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${f.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store' } });
      }
      if (m === 'PATCH') { await store.records('reviewFile', subId, { status: ['approved', 'withheld', 'review'].includes(b.status) ? b.status : null, flags: b.flags }, me.actor); return done(); }
      if (m === 'DELETE') { const gone = await store.records('removeFile', subId, me.actor); await env.FILES.delete(gone.file_key); return done(); }
    }
    if (sub === 'letters' && subId) {
      const l = await store.records('letter', subId);
      if (!l || l.request_id !== rid) return fail(404, 'Letter not found');
      if (m === 'PATCH') {
        await store.records('updateLetter', subId, { subject: clean(b.subject, 200) ?? undefined, body: clean(b.body, 8000) ?? undefined,
          status: ['approved', 'discarded', 'draft'].includes(b.status) ? b.status : undefined }, me.actor);
        return done();
      }
      if (action === 'send' && m === 'POST') return sendLetter(env, city, store, me, r, l, done);
    }
    if (sub === 'extend' && m === 'POST') return extend(env, city, store, me, r, b, settings, done);
    if (sub === 'fee' && m === 'POST') {
      if (b.action === 'waive') { await store.records('setFee', rid, { cents: 0, lines: [], status: 'waived' }, me.actor); return done(); }
      if (b.action === 'paid') {
        const cents = Math.round(Number(b.amount) * 100);
        if (!(cents >= 0)) return fail(400, 'Enter the amount received');
        await store.records('markPaid', rid, { cents, note: clean(b.note, 300) }, me.actor);
        return done();
      }
      const est = estimateFees(b, settings.fees);
      if (!est.cents) return fail(400, 'This estimate comes to $0.00. Set the fee schedule in Records settings, or waive the fee.');
      await store.records('setFee', rid, { cents: est.cents, lines: est.lines, status: 'estimated', note: money(est.cents) }, me.actor);
      await draftLetter(env, city, store, settings, { ...r, fee_cents: est.cents }, 'fee_estimate', feeExtras(est, settings));
      return done();
    }
    if (sub === 'release' && m === 'POST') return release(env, city, store, me, r, b, settings, url, done);
  } catch (e) {
    return fail(400, e.message);
  }
  return fail(404, 'Not found');
}

const publicSettings = (s) => ({ statute: s.statute, responseDays: s.responseDays, extensionDays: s.extensionDays, extensionNote: s.extensionNote,
  warnDays: s.warnDays, confirmed: s.confirmed, exemptions: s.exemptions, fees: s.fees, custodian: s.custodian, feeStatute: s.feeStatute });

const feeExtras = (est, settings) => ({ fee: money(est.cents), feeLines: est.lines.map((l) => `- ${l.label}: ${l.qty} ${l.unit}${l.qty === 1 ? '' : 's'} × ${money(l.rate * 100)} = ${money(l.cents)}`).join('\n'), prepay: settings.fees.prepay });

function letterExtras(b, r, settings, full) {
  const ex = (Array.isArray(b.exemptions) ? b.exemptions : []).map((x) => clean(x, 300)).filter(Boolean);
  return {
    fileCount: full.files.filter((f) => f.status === 'approved').length, exemptions: ex.join('; '), reason: clean(b.reason, 1000), partial: b.kind === 'denial' && b.partial,
    ...(r.fee_cents ? feeExtras({ cents: r.fee_cents, lines: JSON.parse(r.fee_lines || '[]') }, settings) : {}),
  };
}

async function attachDocument(env, city, store, me, r, docId) {
  const found = await store.getDocument(docId);
  if (!found) throw new Error('That document is no longer in the knowledge base');
  const { document: doc, chunks } = found;
  const text = chunks.map((c) => c.text).join('\n\n');
  const fid = uid('f');
  let bytes; let name; let mime;
  const obj = doc.file_key && await env.FILES.get(doc.file_key);
  if (obj) {
    bytes = new Uint8Array(await obj.arrayBuffer());
    name = doc.file_name || `${doc.title}.pdf`;
    mime = doc.mime || guessMime(name);
  } else {
    bytes = new TextEncoder().encode(`${doc.title}\n${doc.source_url ? `Source: ${doc.source_url}\n` : ''}\n${text}`);
    name = `${doc.title.replace(/[^\w .-]+/g, '').slice(0, 80) || 'document'}.txt`;
    mime = 'text/plain';
  }
  const key = `${city.id}/records/${r.id}/${fid}-${name.replace(/[^\w.-]+/g, '_')}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
  const flags = findRedactions(text);
  if (doc.visibility === 'internal') flags.unshift({ type: 'internal', label: 'Staff-only document in the knowledge base', count: 1, examples: ['Check that it can be released'], status: 'pending' });
  await store.records('addFile', r.id, { id: fid, name, mime, bytes: bytes.length, file_key: key, doc_id: doc.id, source: 'knowledge', flags }, me.actor);
}

async function uploadFiles(request, env, city, store, me, r) {
  const form = await request.formData();
  const files = form.getAll('file').filter((f) => typeof f === 'object' && f.size);
  if (!files.length) throw new Error('Attach at least one file');
  const texts = form.getAll('text');
  for (const [i, f] of files.entries()) {
    if (f.size > 50 * 1024 * 1024) throw new Error(`${f.name} is larger than 50 MB`);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const mime = f.type || guessMime(f.name);
    let text = typeof texts[i] === 'string' && texts[i].length > 20 ? texts[i] : '';
    if (!text) text = await extractText(env, { bytes, name: f.name, mime }).catch(() => '');
    const flags = text.replace(/\s/g, '').length > 30 ? findRedactions(text)
      : [{ type: 'unreadable', label: 'No readable text: check the whole file by eye', count: 1, examples: [], status: 'pending' }];
    const fid = uid('f');
    const key = `${city.id}/records/${r.id}/${fid}-${f.name.replace(/[^\w.-]+/g, '_')}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: mime } });
    await store.records('addFile', r.id, { id: fid, name: f.name.slice(0, 200), mime, bytes: bytes.length, file_key: key, source: 'upload', flags }, me.actor);
  }
}

async function sendLetter(env, city, store, me, r, l, done) {
  if (l.status !== 'approved') return fail(400, 'Approve the letter before sending it');
  if (['response', 'denial'].includes(l.kind)) return fail(400, 'Response letters are sent when you release the records');
  if (l.kind === 'fee_estimate' && !['estimated', 'requested'].includes(r.fee_status)) return fail(400, 'Estimate the fee first');
  const channels = await sendToRequester(env, store, city, r, me.actor, { subject: l.subject, text: l.body });
  await store.records('letterSent', l.id, me.actor, channels);
  if (l.kind === 'acknowledgment') await store.records('acknowledge', r.id, me.actor);
  if (l.kind === 'fee_estimate' && r.fee_status === 'estimated') {
    await store.records('setFee', r.id, { cents: r.fee_cents, lines: JSON.parse(r.fee_lines || '[]'), status: 'requested', note: money(r.fee_cents) }, me.actor);
  }
  return done();
}

// The written explanation goes to the requester as staff wrote it. Past the statute's extended limit only by agreement.
async function extend(env, city, store, me, r, b, settings, done) {
  const reason = clean(b.reason, 1000);
  if (!reason || reason.length < 10) return fail(400, 'Explain why the records cannot be produced by the original date. The requester receives this in writing.');
  const received = localDay(r.received_at, city.timezone);
  const limit = addWorkingDays(received, settings.extensionDays, settings);
  const due = isDay(b.due) ? b.due : limit;
  if (due <= (r.extended_due || r.due_date)) return fail(400, 'Choose a date after the current due date');
  if (due > limit && !b.agreed) return fail(400, `${settings.statute || 'The rule'} allows up to ${settings.extensionDays} working days (${limit}). A later date needs the requester's agreement.`);
  await store.records('extend', r.id, { due, reason, agreed: !!b.agreed && due > limit }, me.actor);
  const text = `Dear ${r.name},\n\nWe cannot produce the records for request ${r.ref} by ${longDate(r.extended_due || r.due_date)}. ${reason}\n\nWe will respond by ${longDate(due)}.\n\nSincerely,\n${settings.custodian}\n${city.settings.cityName}`;
  const lid = await store.records('addLetter', r.id, { kind: 'extension', subject: `New response date for public records request ${r.ref}`, body: text, drafted_by: 'staff' }, me.actor);
  await store.records('updateLetter', lid, { status: 'approved' }, me.actor);
  await store.records('letterSent', lid, me.actor, await sendToRequester(env, store, city, r, me.actor, { subject: `New response date for ${r.ref}`, text }));
  return done();
}

// Closing the request: the approved files are released and the approved response letter goes to the requester.
async function release(env, city, store, me, r, b, settings, url, done) {
  const outcome = OUTCOMES.includes(b.outcome) ? b.outcome : null;
  if (!outcome) return fail(400, 'Choose the outcome');
  const exemptions = (Array.isArray(b.exemptions) ? b.exemptions : []).map((x) => clean(x, 300)).filter(Boolean);
  const reason = clean(b.reason, 2000);
  const full = await store.records('get', r.id);
  const approved = full.files.filter((f) => f.status === 'approved');
  const releasing = ['fulfilled', 'partial'].includes(outcome);
  if (['partial', 'denied'].includes(outcome) && !exemptions.length) return fail(400, `Cite the specific exemption for what is withheld${settings.statute ? ` (${settings.statute}(3))` : ''}`);
  if (releasing && full.files.some((f) => f.status === 'review')) return fail(400, 'Approve or withhold every file before releasing');
  if (releasing && !approved.length && r.format !== 'inspection') return fail(400, 'Approve at least one file to release');
  const letter = b.letterId ? await store.records('letter', b.letterId) : null;
  if (outcome !== 'withdrawn') {
    if (!letter || letter.request_id !== r.id || !['response', 'denial'].includes(letter.kind)) return fail(400, 'Choose the response letter to send');
    if (letter.status !== 'approved') return fail(400, 'Approve the response letter before releasing');
  }
  if (releasing && r.fee_cents > 0 && settings.fees.prepay && !['paid', 'waived'].includes(r.fee_status)) return fail(400, 'Record the payment, or waive the fee, before releasing');
  await store.records('close', r.id, { outcome, exemptions, reason }, me.actor);
  if (letter) {
    const link = releasing && approved.length ? `\n\nDownload the records: ${trackLink(url, city, r, r.access_key)}` : '';
    const channels = await sendToRequester(env, store, city, r, me.actor, { subject: letter.subject, text: letter.body + link });
    await store.records('letterSent', letter.id, me.actor, channels);
  }
  return done();
}

/* ---------------- Settings and the request log ---------------- */

async function saveSettings(b, city, store, me, current) {
  const next = { ...current, fees: { ...current.fees } };
  const changes = {};
  const set = (k, v, from = current[k]) => { if (JSON.stringify(from ?? null) !== JSON.stringify(v ?? null)) changes[k] = [from ?? null, v ?? null]; };
  const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
  for (const [k, lo, hi] of [['responseDays', 1, 60], ['extensionDays', 1, 120], ['warnDays', 0, 10]]) {
    if (k in b && int(b[k], lo, hi) != null) { set(k, int(b[k], lo, hi)); next[k] = int(b[k], lo, hi); }
  }
  for (const [k, max] of [['statute', 120], ['feeStatute', 120], ['extensionNote', 300], ['custodian', 120]]) if (k in b) { const v = clean(b[k], max) || ''; set(k, v); next[k] = v; }
  if (['MS', 'US', 'none'].includes(b.holidays)) { set('holidays', b.holidays); next.holidays = b.holidays; }
  if (Array.isArray(b.closures)) { const v = [...new Set(b.closures.filter(isDay))].sort(); set('closures', v); next.closures = v; }
  if (Array.isArray(b.exemptions)) { const v = b.exemptions.map((x) => clean(x, 300)).filter(Boolean).slice(0, 40); set('exemptions', v); next.exemptions = v; }
  if (b.fees && typeof b.fees === 'object') {
    for (const k of ['searchHourly', 'reviewHourly', 'perPage', 'perMedia', 'mailing']) {
      if (k in b.fees) { const v = Math.max(0, Math.round(Number(b.fees[k]) * 100) / 100 || 0); set(`fees.${k}`, v, current.fees[k]); next.fees[k] = v; }
    }
    if ('prepay' in b.fees) { set('fees.prepay', !!b.fees.prepay, current.fees.prepay); next.fees.prepay = !!b.fees.prepay; }
  }
  if (b.confirmed) { set('confirmed', true); next.confirmed = true; }
  if (Object.keys(changes).length) await store.records('saveSettings', next, me.actor, changes);
  return json(await recordsSettings(city, store));
}

const CSV_COLS = ['ref', 'received_at', 'name', 'organization', 'records', 'date_from', 'date_to', 'format', 'source', 'status', 'outcome', 'due_date', 'extended_due',
  'extension_reason', 'acknowledged_at', 'fee_status', 'fee', 'paid', 'released_files', 'exemptions', 'denial_reason', 'closed_at', 'assignee'];

async function exportLog(city, store, me, url) {
  const rows = (await store.records('log')).map((r) => ({ ...r, fee: (r.fee_cents / 100).toFixed(2), paid: (r.paid_cents / 100).toFixed(2) }));
  await store.record(me.actor, 'records.export', 'records_request', null, `Downloaded the public records log (${rows.length} requests)`);
  const stamp = new Date().toISOString().slice(0, 10);
  if (url.searchParams.get('format') === 'json') {
    return json({ city: city.settings.cityName, exported_at: new Date().toISOString(), requests: rows }, 200, { 'Content-Disposition': `attachment; filename="${city.slug}-records-log-${stamp}.json"` });
  }
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => cell(r[c])).join(','))].join('\r\n');
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${city.slug}-records-log-${stamp}.csv"`, ...CORS } });
}
