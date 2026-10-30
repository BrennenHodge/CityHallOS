// Permit applications: the resident's guided application and City Hall's review.
//
// Residents need no account. Each application has a secret link (/{city}/#permit={id}.{token}); the browser
// sends the token in X-Permit-Token. Answers autosave, so an application can be finished later on any device
// that has the link. Staff work submitted applications from the dashboard.
//
//   draft → submitted → (needs_info ⇄ submitted) → fees_due → in_review → issued → closed
//                                                              ↘ denied        (or withdrawn by the applicant)
// The AI reads answers, checks completeness and drafts correction requests. Only staff accept fees,
// approve, issue or deny.
import { search } from '../search.js';
import { completeJson, modelName } from '../assistant.js';
import { sha256 } from '../auth.js';
import { extractText } from '../ingest.js';
import { notify } from '../notify.js';
import {
  ASKS, DOC_KINDS, FIELDS, KIND, askView, check, coerce, contactFor, derive, feeEstimate, matches, nextAsk, progress, publicSchema,
} from './construction.js';
import { readMessage, quickParse } from './converse.js';
import { screenAddress, screenSummary } from './screen.js';
import { applicationPdf, permitPdf } from './pdf.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const now = () => new Date().toISOString();
const EDITABLE = ['draft', 'needs_info'];
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const label = (opts, v) => (opts.find(([k]) => k === v) || [])[1] || v;
const AI = { type: 'ai', name: 'City Hall OS assistant' };
const RESIDENT = { type: 'resident', name: 'Applicant' };

export const config = (city) => ({ autoReturn: false, department: 'planning-building', ...(city.settings.permits?.construction || {}) });

/* ---------------- Secret links ---------------- */

// The token is derived from the application id, so City Hall can send the link again later without storing it.
async function tokenFor(env, id) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`permit-link:${env.LINK_SECRET || env.ADMIN_KEY}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 32);
}

async function linkFor(env, city, id, origin) {
  return `${origin || env.APP_ORIGIN || 'https://app.cityhallos.com'}/${city.slug}/#permit=${id}.${await tokenFor(env, id)}`;
}

async function residentPermit(request, store, id) {
  const token = request.headers.get('X-Permit-Token') || new URL(request.url).searchParams.get('token') || '';
  const p = token && await store.permit(id);
  if (!p || p.token_hash !== await sha256(token)) return null;
  return p;
}

/* ---------------- Computing from answers ---------------- */

// Everything that follows from the answers, saved alongside them.
function recompute(p, city) {
  const cfg = config(city);
  const data = derive(p.data, { matchedAddress: p.screen?.matchedAddress });
  const checks = check(data, { files: p.files, screen: p.screen, cfg });
  const fee = feeEstimate(data, cfg);
  const contact = contactFor(data);
  return {
    data, checks, progress: Math.min(p.status === 'draft' ? 99 : 100, progress(data, p.files)), fee_estimate: fee?.total ?? null,
    applicant: contact.name || data.owner_name || null, address: p.screen?.matchedAddress || data.job_address || null,
    contact: contact.email || contact.phone ? contact : null,
  };
}

async function saveAnswers(env, store, city, p, updates) {
  const data = { ...p.data };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete data[k]; else data[k] = v;
  }
  if (updates.signature_name && !data.signed_at) data.signed_at = now();
  if ('signature_name' in updates && !updates.signature_name) delete data.signed_at;
  if (data.owner_same_mailing === false && p.data.owner_same_mailing === true) for (const k of ['owner_address', 'owner_city', 'owner_state', 'owner_zip']) delete data[k];
  let screen = p.screen;
  if (data.job_address && data.job_address !== p.data.job_address) {
    screen = await screenAddress(data.job_address, city);
    if (screen.matchedAddress && data.owner_same_mailing) for (const k of ['owner_address', 'owner_city', 'owner_state', 'owner_zip']) delete data[k];
  }
  if (!data.job_address) screen = null;
  const next = { ...p, data, screen };
  return store.savePermit(p.id, { ...recompute(next, city), screen });
}

function residentView(p, city, extra = {}) {
  const cfg = config(city);
  const ask = EDITABLE.includes(p.status) ? askView(nextAsk(p.data, p.files, p.asked), p.data) : null;
  const corrections = p.status === 'needs_info' ? (p.review?.returned || null) : null;
  return {
    id: p.id, ref: p.ref, status: p.status, editable: EDITABLE.includes(p.status), data: p.data, files: p.files, progress: p.progress,
    ask, checks: p.checks || [], review: p.review ? { at: p.review.at, issues: (p.review.issues || []).filter((i) => i.for !== 'staff'), hash: p.review.hash } : null,
    fee: feeEstimate(p.data, cfg), fee_assessed: p.fee_assessed, fee_paid: p.fee_paid, permit_number: p.permit_number,
    screen: p.screen ? { matchedAddress: p.screen.matchedAddress, jurisdiction: p.screen.jurisdiction, flood: p.screen.flood } : null,
    corrections, payment: cfg.paymentInstructions || null, submitted_at: p.submitted_at, decided_at: p.decided_at,
    ...extra,
  };
}

async function dataHash(p) { return sha256(JSON.stringify([p.data, p.files.map((f) => f.id)])); }

/* ---------------- AI review ---------------- */

// Blank answers the AI may copy from an attached document, so nothing printed on a deed has to be typed again.
const FILLABLE = ['parcel_number', 'contractor_cor', 'dp_license'];

const REVIEW_SYSTEM = `You are the intake reviewer for a city Planning & Building department. You read a construction permit application before a permit technician does and list what is missing, inconsistent or unclear, so the applicant can fix it before review.
Return JSON only: {"summary": "...", "issues": [{"field": "field_key or files", "level": "error|warning|info", "for": "applicant|staff", "message": "..."}], "fills": {"field_key": "value"}}
- summary: two or three sentences for staff: what is being built, where, by whom, the valuation, and the main open items.
- issues for the applicant: things they must add or fix, written to the resident in plain words ("Your deed lists Mary Smith, but the owner on the application is John Smith. ..."). Use "error" only for something clearly missing or contradictory that a technician would send back.
- issues for staff: things to verify during review (zoning setbacks for the district, floodplain, whether plans are adequate, valuation reasonableness). Never decide compliance, never say the permit is approved or allowed.
- Compare uploaded documents with the answers: owner name and property address on the proof of ownership, and whether a "site plan" actually shows the building and property lines.
- Do not repeat problems already listed under "Rule checks". Be specific and brief. At most 8 issues.
- fills: answers the applicant left blank that an attached document states plainly (for example the tax parcel number printed on a deed, or a contractor's COR number on a license). Only these fields: ${FILLABLE.join(', ')}. Copy the value exactly. Leave fills empty if unsure.`;


async function aiReview(env, store, city, p) {
  const files = await store.permitFileTexts(p.id);
  const hits = await search(env, store, city.settings, 'construction permit application requirements plans setbacks floodplain', { limit: 4 }).catch(() => []);
  const fields = Object.entries(p.data).filter(([k]) => FIELDS[k] && matches(FIELDS[k].when, p.data)).map(([k, v]) => `${k} (${FIELDS[k].label}): ${Array.isArray(v) ? v.join(', ') : v}`);
  const user = [
    `City: ${city.name}, ${city.settings.state}.`,
    `Application answers:\n${fields.join('\n')}`,
    `Attachments: ${p.files.map((f) => `${label(DOC_KINDS, f.kind)} "${f.name}"`).join('; ') || 'none'}`,
    files.length ? `Text read from attachments:\n${files.map((f) => `--- ${label(DOC_KINDS, f.kind)} "${f.name}" ---\n${f.text.slice(0, 2500)}`).join('\n')}` : '',
    `Address screen: ${JSON.stringify({ matched: p.screen?.matchedAddress, jurisdiction: p.screen?.jurisdiction, flood: p.screen?.flood })}`,
    `Rule checks already found:\n${(p.checks || []).map((c) => `- [${c.level}] ${c.message}`).join('\n') || 'none'}`,
    hits.length ? `City documents (for context, may be dated):\n${hits.map((h) => `${h.doc.title}: ${h.text.slice(0, 600)}`).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const out = await completeJson(env, REVIEW_SYSTEM, user, 1800);
  const issues = (Array.isArray(out.issues) ? out.issues : []).slice(0, 10).map((i) => ({
    field: FIELDS[i.field] || i.field === 'files' ? i.field : null, level: ['error', 'warning', 'info'].includes(i.level) ? i.level : 'warning',
    for: i.for === 'staff' ? 'staff' : 'applicant', message: String(i.message || '').slice(0, 500), source: 'ai',
  })).filter((i) => i.message)
    // A rule check already covers that field; the AI repeating it adds noise.
    .filter((i) => !(i.for === 'applicant' && i.field && (p.checks || []).some((c) => c.field === i.field && c.level !== 'info')));
  const fills = Object.fromEntries(Object.entries(out.fills && typeof out.fills === 'object' ? out.fills : {})
    .filter(([k, v]) => FILLABLE.includes(k) && v != null && String(v).trim() && (p.data[k] == null || p.data[k] === ''))
    .map(([k, v]) => [k, String(v).trim().slice(0, 60)]));
  // Anything a fill just answered is no longer an issue.
  const open = issues.filter((i) => !(i.field in fills) && !Object.values(fills).some((v) => i.message.includes(v)));
  return { summary: String(out.summary || '').slice(0, 1200), issues: open, fills, at: now(), model: modelName(env), hash: await dataHash(p) };
}

/* ---------------- Telling the applicant ---------------- */

async function tell(env, store, city, p, kind, extra = {}, origin) {
  const to = p.contact;
  if (!to) return;
  const link = await linkFor(env, city, p.id, origin);
  const cfg = config(city);
  const ref = p.ref || 'your application';
  const where = p.address ? ` for ${p.address}` : '';
  const m = {
    received: {
      subject: `We received your permit application ${ref}`,
      body: `Thank you. We received your construction permit application ${ref}${where}.\n\nWhat happens next:\n- Planning & Building checks that the application is complete.\n- You'll be told the permit fee and how to pay it.\n- The Land Code Administrator reviews zoning, floodplain and code requirements.\n- When it's approved, the permit is issued and you post it at the job site.\n\nWe'll contact you at each step.`,
      sms: `We received construction permit application ${ref}. We'll text you at each step. Details:`, voice: `We received your construction permit application, reference ${ref.split('').join(' ')}. We will contact you at each step.`, linkLabel: 'View your application',
    },
    needs_info: {
      subject: `Permit application ${ref} needs a few changes`,
      body: `Before review can continue, please update your application:\n\n${(extra.items || []).map((i) => `- ${i}`).join('\n')}${extra.message ? `\n\n${extra.message}` : ''}\n\nYour answers are saved, so you only need to change what's listed, then resubmit.`,
      sms: `Permit application ${ref} needs changes before review (${(extra.items || []).length || 1} item${(extra.items || []).length === 1 ? '' : 's'}). Open it here:`, voice: 'Your construction permit application needs a few changes before review can continue.', linkLabel: 'Fix your application',
    },
    fees_due: {
      subject: `Permit application ${ref} is complete: fee due`,
      body: `Your application ${ref} is complete. The permit fee is ${money(extra.fee)}.\n\n${cfg.paymentInstructions || `Pay at City Hall${city.settings.address ? `, ${city.settings.address}` : ''}.`}\n\nReview starts as soon as the fee is paid.`,
      sms: `Permit application ${ref} is complete. Fee due: ${money(extra.fee)}. How to pay:`, voice: `Your construction permit application is complete. The permit fee is ${money(extra.fee)}. Review starts as soon as the fee is paid.`, linkLabel: 'See payment details',
    },
    in_review: {
      subject: `Payment received for ${ref}`,
      body: `We received your payment of ${money(extra.amount)}${extra.receipt ? ` (receipt ${extra.receipt})` : ''}. The Land Code Administrator is now reviewing your application for zoning, floodplain and code requirements.`,
      sms: `Payment received for ${ref}. Your application is now under review.`, voice: 'We received your payment. Your application is now under review.', linkLabel: 'View your application',
    },
    issued: {
      subject: `Permit ${p.permit_number} has been issued`,
      body: `Your construction permit ${p.permit_number}${where} has been issued.${p.conditions ? `\n\nConditions: ${p.conditions}` : ''}\n\nPrint the permit and post it at the job site where it can be seen from the street. Call City Hall${city.settings.phone ? ` at ${city.settings.phone}` : ''} to schedule each required inspection before covering any work.`,
      sms: `Permit ${p.permit_number} is issued. Print it and post it at the job site. Download it here:`, voice: 'Good news. Your construction permit has been issued. Please print it and post it at the job site.', linkLabel: 'Download your permit',
    },
    denied: {
      subject: `Permit application ${ref} was not approved`,
      body: `Your construction permit application ${ref} was not approved.\n\nReason: ${extra.reason}\n\nPlease contact City Hall${city.settings.phone ? ` at ${city.settings.phone}` : ''} to talk about your options, including changes to the project or an appeal.`,
      sms: `Permit application ${ref} was not approved. Details:`, voice: 'Your construction permit application was not approved. We have sent you the reason in writing.', linkLabel: 'View details',
    },
    closed: { subject: `Permit ${p.permit_number || ref} is closed`, body: `Permit ${p.permit_number || ref} is closed.${extra.note ? `\n\n${extra.note}` : ''} Thank you.`, sms: `Permit ${p.permit_number || ref} is closed. Thank you.`, linkLabel: 'View' },
    message: { subject: `A message about ${ref}`, body: extra.message, sms: `Message about ${ref}: ${String(extra.message).slice(0, 300)}`, voice: `City Hall has a message about your permit application. ${extra.message}`, linkLabel: 'Open your application' },
    inspection: { subject: `Inspection result for ${p.permit_number || ref}`, body: `${extra.type ? `${extra.type} inspection` : 'Inspection'}: ${extra.result}.${extra.note ? `\n\n${extra.note}` : ''}`, sms: `${extra.type || 'Inspection'} for ${p.permit_number || ref}: ${extra.result}.`, linkLabel: 'View your permit' },
    reminder_draft: {
      subject: 'Finish your construction permit application',
      body: `Your construction permit application${where} is ${p.progress}% done. Your answers are saved. Pick up where you left off.`,
      sms: `Your permit application is ${p.progress}% done. Finish it here:`, linkLabel: 'Finish your application',
    },
    reminder_info: {
      subject: `Reminder: ${ref} is waiting on changes`,
      body: `City Hall is still waiting on changes to permit application ${ref}. Review can't continue until it's updated and resubmitted.`,
      sms: `Reminder: permit application ${ref} is waiting on your changes:`, linkLabel: 'Fix your application',
    },
    resume: {
      subject: 'Your permit application link',
      body: `Here's the link to your construction permit application${where}. Your answers save automatically, so you can finish it on any device.`,
      sms: 'Your permit application link (answers save automatically):', linkLabel: 'Open your application',
    },
  }[kind];
  return notify(env, store, city, { entityType: 'permit', entityId: p.id, to: extra.pref ? { ...to, pref: extra.pref } : to, msg: { ...m, link } });
}

// Let the permit department know a new application arrived.
async function tellStaff(env, store, city, p, origin) {
  const dept = (await store.departments()).find((d) => d.id === config(city).department);
  if (!dept?.email) return;
  await notify(env, store, city, {
    entityType: 'permit', entityId: p.id, to: { email: dept.email, pref: 'email' },
    msg: {
      subject: `New permit application ${p.ref}${p.address ? `: ${p.address}` : ''}`,
      body: `${p.applicant || 'An applicant'} submitted construction permit application ${p.ref}.\n\n${p.review?.summary || p.data.description || ''}`,
      link: `${origin || env.APP_ORIGIN || ''}/#/permits`, linkLabel: 'Open in the dashboard',
    },
  });
}

/* ---------------- After submission ---------------- */

async function afterSubmit(env, store, city, id, origin) {
  let p = await store.permit(id);
  try {
    if (p.data.job_address && !p.screen?.jurisdiction?.checked) {
      p = await store.savePermit(id, { screen: await screenAddress(p.data.job_address, city) }, { byApplicant: false });
      p = await store.savePermit(id, recompute(p, city), { byApplicant: false });
    }
    let review = p.review;
    if (!review || review.hash !== await dataHash(p)) review = await aiReview(env, store, city, p);
    if (Object.keys(review.fills || {}).length) {
      p = await saveAnswers(env, store, city, p, review.fills);
      await store.permitNote(id, AI, `Filled in from the attached documents: ${Object.entries(review.fills).map(([k, v]) => `${FIELDS[k].label} ${v}`).join('; ')}`, true);
    }
    p = await store.savePermit(id, { review }, { byApplicant: false });
  } catch (e) {
    console.log('permit review failed', e.stack || e.message);
  }
  const cfg = config(city);
  const blocking = (p.review?.issues || []).filter((i) => i.for === 'applicant' && i.level === 'error');
  if (cfg.autoReturn && blocking.length && !p.data.applicant_note && p.auto_returns < 1) {
    const items = blocking.map((i) => i.message);
    p = await store.setPermitStatus(id, 'needs_info', AI, {
      publicNote: 'Returned by the automated completeness check', data: { items, by: 'ai' },
      patch: { auto_returns: p.auto_returns + 1, review: JSON.stringify({ ...p.review, returned: { items, at: now(), by: 'City Hall OS automated check' } }) },
    });
    await tell(env, store, city, p, 'needs_info', { items }, origin);
    return;
  }
  await tell(env, store, city, p, 'received', {}, origin);
  await tellStaff(env, store, city, p, origin);
}

/* ---------------- Routes ---------------- */

export async function permitRoute({ request, env, ctx, url, city, store, me, parts }) {
  const [id, sub, subId] = parts;
  const m = request.method;
  const origin = url.origin;
  const hasToken = !!(request.headers.get('X-Permit-Token') || url.searchParams.get('token'));

  if (!id && m === 'GET' && !me) return fail(401, 'Please sign in');
  if (id === 'schema' && m === 'GET') {
    const cfg = config(city);
    return json({ ...publicSchema(), enabled: cfg.enabled !== false, payment: cfg.paymentInstructions || null, feeSource: cfg.fees?.source || null }, 200, { 'Cache-Control': 'public, max-age=300' });
  }

  // Start an application. An opening message ("a 24x30 garage behind my house") is read right away.
  if (!id && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const pid = uid('p');
    const token = await tokenFor(env, pid);
    let p = await store.createPermit({ id: pid, tokenHash: await sha256(token), kind: KIND, data: {}, convoId: typeof b.convoId === 'string' ? b.convoId.slice(0, 20) : null });
    // Reuse answers from an earlier application on this device: owner and contractor details are typed once.
    if (b.copyFrom?.id && b.copyFrom?.token) {
      const prev = await store.permit(String(b.copyFrom.id));
      if (prev && prev.token_hash === await sha256(String(b.copyFrom.token))) {
        const keep = Object.keys(FIELDS).filter((k) => /^(owner_|contractor_|applicant_|contact_pref|dp_|design_pro|builder)/.test(k) && !['owner_exemption', 'owner_ack'].includes(k));
        p = await saveAnswers(env, store, city, p, Object.fromEntries(keep.filter((k) => prev.data[k] != null).map((k) => [k, prev.data[k]])));
      }
    }
    let reply = null;
    if (b.opening && String(b.opening).trim().length > 3) {
      const r = await readMessage(env, ASKS[0], String(b.opening).slice(0, 1200), p.data);
      p = await saveAnswers(env, store, city, p, r.updates);
      reply = ackFor(r.updates, r.reply);
    }
    p = await store.savePermit(pid, recompute(p, city));
    return json({ ...residentView(p, city, { reply }), token }, 201);
  }

  if (!id) {
    if (!me.can('permits.view')) return fail(403, "Your role doesn't allow this");
    const redact = !me.can('residents.contact');
    const permits = (await store.listPermits({ status: url.searchParams.get('status') })).map((p) => ({
      ...p, checks: undefined, review: undefined, contact: redact ? null : p.contact, applicant: redact && p.applicant ? 'Hidden' : p.applicant,
      errors: (p.checks || []).filter((c) => c.level === 'error').length, concerns: (p.review?.issues || []).filter((i) => i.level !== 'info').length,
      summary: p.review?.summary || null,
    }));
    return json({ permits });
  }

  // The applicant, with the secret link.
  if (hasToken) {
    const p = await residentPermit(request, store, id);
    if (!p) return fail(404, 'Application not found. Check your link, or call City Hall.');
    return applicantRoute({ request, env, ctx, city, store, p, sub, subId, m, origin, url });
  }

  // Staff.
  if (!me) return fail(401, 'Please sign in');
  if (!me.can('permits.view')) return fail(403, "Your role doesn't allow this");
  const p = await store.permitForStaff(id);
  if (!p || p.status === 'draft') return fail(404, 'Application not found');
  const canEdit = me.can('permits.edit') && (!me.departmentId || me.departmentId === config(city).department);
  if (!sub && m === 'GET') return json(staffView(p, me, city, canEdit));
  if (sub === 'files' && subId && m === 'GET') return fileResponse(env, store, id, subId);
  if (sub === 'pdf' && m === 'GET') return pdfResponse(env, store, city, p, 'application');
  if (sub === 'permit.pdf' && m === 'GET') return pdfResponse(env, store, city, p, 'permit');
  if (!canEdit) return fail(403, "Your role doesn't allow this");
  if (sub === 'review' && m === 'POST') {
    const review = await aiReview(env, store, city, p);
    await store.savePermit(id, { review: { ...p.review, ...review } }, { byApplicant: false });
    await store.record(me.actor, 'permit.ai_review', 'permit', p.ref, `${p.ref}: re-ran the AI completeness review`);
    return json(staffView(await store.permitForStaff(id), me, city, canEdit));
  }
  if (sub === 'actions' && m === 'POST') return staffAction(request, env, ctx, city, store, p, me, origin, canEdit);
  return fail(404, 'Not found');
}

function staffView(p, me, city, canEdit) {
  const redact = !me.can('residents.contact');
  const hide = (v) => (redact && v ? 'Hidden' : v);
  const data = redact ? Object.fromEntries(Object.entries(p.data).map(([k, v]) => [k, /(_phone|_cell|_email)$/.test(k) ? hide(v) : v])) : p.data;
  return {
    ...p, data, contact: redact ? null : p.contact, outbox: redact ? p.outbox.map((o) => ({ ...o, to_addr: hide(o.to_addr), body: hide(o.body) })) : p.outbox,
    fee: feeEstimate(p.data, config(city)), canEdit, schema: publicSchema(),
    suggestedPermitNumber: `${city.settings.requestPrefix}-${new Date().getFullYear()}-${(p.ref || '').split('-').pop()}`,
  };
}

// Acknowledgment for answers the rules understood, when the AI didn't write one.
function ackFor(updates, aiReply) {
  if (aiReply) return aiReply;
  const keys = Object.keys(updates).filter((k) => FIELDS[k] && !['description', 'certify', 'signature_name'].includes(k) && !FIELDS[k].label.endsWith('?') && FIELDS[k].type !== 'check');
  if (!keys.length) return Object.keys(updates).length ? 'Got it.' : null;
  const shown = keys.slice(0, 4).map((k) => {
    const f = FIELDS[k]; const v = updates[k];
    const val = f.options ? (Array.isArray(v) ? v.map((x) => label(f.options, x)).join(', ') : label(f.options, v)) : f.type === 'money' ? money(v) : f.type === 'bool' ? (v ? 'yes' : 'no') : v;
    return `${f.label.replace(/ \(.*\)$/, '')}: **${val}**`;
  });
  return `Got it. ${shown.join(' · ')}`;
}

async function applicantRoute({ request, env, ctx, city, store, p, sub, subId, m, origin }) {
  const view = (q, extra) => json(residentView(q, city, extra));

  if (!sub && m === 'GET') return json(residentView(p, city, { events: await store.permitPublicEvents(p.id) }));
  if (sub === 'files' && subId && m === 'GET') return fileResponse(env, store, p.id, subId);
  if (sub === 'pdf' && m === 'GET') return pdfResponse(env, store, city, p, 'application');
  if (sub === 'permit.pdf' && m === 'GET') return p.status === 'issued' || p.status === 'closed' ? pdfResponse(env, store, city, p, 'permit') : fail(400, 'The permit has not been issued yet');

  if (sub === 'send-link' && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const target = { ...(p.contact || {}) };
    if (b.email) target.email = String(b.email).trim().slice(0, 200);
    if (b.phone) target.phone = String(b.phone).trim().slice(0, 40);
    if (!target.email && !target.phone) return fail(400, 'Add an email address or phone number first');
    const pref = b.email ? 'email' : b.phone ? 'sms' : target.pref === 'call' ? 'sms' : target.pref;
    const results = await tell(env, store, city, { ...p, contact: target }, 'resume', { pref }, origin);
    return json({ results });
  }

  if (sub === 'inspections' && m === 'POST') {
    if (p.status !== 'issued') return fail(400, 'Inspections can be requested once the permit is issued');
    const b = await request.json().catch(() => ({}));
    const type = String(b.type || 'Inspection').slice(0, 60);
    const note = `${type} inspection requested${b.date ? ` for ${String(b.date).slice(0, 40)}` : ''}${b.notes ? `: ${String(b.notes).slice(0, 400)}` : ''}`;
    await store.permitNote(p.id, RESIDENT, note, true);
    await store.record(RESIDENT, 'permit.inspection_request', 'permit', p.ref, `${p.ref}: ${note}`);
    return json(residentView(await store.permit(p.id), city, { events: await store.permitPublicEvents(p.id) }));
  }

  if (sub === 'withdraw' && m === 'POST') {
    if (!['draft', 'submitted', 'needs_info', 'fees_due'].includes(p.status)) return fail(400, 'This application can no longer be withdrawn online. Call City Hall.');
    return view(await store.setPermitStatus(p.id, 'withdrawn', RESIDENT, { publicNote: 'Withdrawn by the applicant' }));
  }

  if (!EDITABLE.includes(p.status)) return fail(400, 'This application has been submitted. Call City Hall to change it.');

  // Autosave from the form: { data: { field: value } }.
  if (!sub && m === 'PATCH') {
    const b = await request.json().catch(() => ({}));
    const updates = {};
    for (const [k, v] of Object.entries(b.data || {})) {
      if (!FIELDS[k] || FIELDS[k].type === 'files') continue;
      const c = coerce(k, v);
      if (c !== undefined) updates[k] = c;
    }
    if ('applicant_note' in (b.data || {})) updates.applicant_note = String(b.data.applicant_note || '').slice(0, 1000) || null;
    const before = p.data.job_address;
    const q = await saveAnswers(env, store, city, p, updates);
    return view(q, { screenNote: q.data.job_address !== before && q.screen ? screenSummary(q.screen, city) : null });
  }

  // One chat message: read it into answers, then ask the next question.
  if (sub === 'message' && m === 'POST') {
    if (env.CHAT_LIMIT) {
      const { success } = await env.CHAT_LIMIT.limit({ key: `${city.id}:${request.headers.get('CF-Connecting-IP') || 'anon'}` });
      if (!success) return fail(429, 'Too many messages. Please wait a minute and try again.');
    }
    const b = await request.json().catch(() => ({}));
    const text = String(b.text || '').trim().slice(0, 1200);
    const asked = [...(p.asked || [])];
    const ask = ASKS.find((a) => a.id === b.ask) || nextAsk(p.data, p.files, asked);
    let updates = {}; let reply = null; let understood = true;
    if (b.choice) {
      if (b.choice === '__skip') asked.push(ask.id);
      else if (b.choice === '__bring') updates.bring_ownership_proof = true;
      else {
        const c = ask.choices?.find(([v]) => v === b.choice);
        updates = quickParse(ask, c ? c[1] : String(b.choice));
        for (const [k, v] of Object.entries(updates)) { if (v !== null && FIELDS[k]) { const cv = coerce(k, v); if (cv === undefined) delete updates[k]; else updates[k] = cv; } }
      }
    } else if (text) {
      const r = await readMessage(env, ask, text, p.data);
      updates = r.updates; reply = r.reply;
      understood = Object.keys(updates).length > 0 || r.question;
      if (ask?.optional && !Object.keys(updates).length && /\b(don'?t know|not sure|no idea|skip)\b/i.test(text)) { asked.push(ask.id); understood = true; }
    }
    if (ask && (ask.optional || ask.id === 'plans') && Object.keys(updates).length && !asked.includes(ask.id)) asked.push(ask.id);
    const before = p.data.job_address;
    let q = await saveAnswers(env, store, city, { ...p, asked }, updates);
    if (JSON.stringify(asked) !== JSON.stringify(p.asked || [])) q = await store.savePermit(p.id, { asked });
    const lines = [];
    const ack = b.choice ? null : ackFor(updates, reply);
    if (ack) lines.push(ack);
    else if (!understood) lines.push("Sorry, I didn't catch that.");
    if (q.data.job_address !== before && q.screen) lines.push(screenSummary(q.screen, city));
    const fee = feeEstimate(q.data, config(city));
    if (updates.valuation && fee) lines.push(`Based on the published fee schedule, the permit fee would be about **${money(fee.total)}**. City Hall confirms the final amount.`);
    const next = askView(nextAsk(q.data, q.files, q.asked), q.data);
    if (!next) lines.push("That's everything the application asks for. Review it on the right, then tap **Check my application**. I'll look for anything City Hall would send back.");
    return view(q, { reply: lines.join('\n\n'), changed: Object.keys(updates) });
  }

  if (sub === 'files' && !subId && m === 'POST') {
    if (p.files.length >= 25) return fail(400, 'An application can have up to 25 attachments');
    const form = await request.formData();
    const file = form.get('file');
    const kind = DOC_KINDS.some(([k]) => k === form.get('kind')) ? form.get('kind') : 'other';
    if (!file || typeof file !== 'object' || !file.size) return fail(400, 'Choose a file');
    if (file.size > 15 * 1024 * 1024) return fail(400, 'Files must be 15 MB or smaller');
    if (!/^(application\/pdf|image\/)/.test(file.type || '')) return fail(400, 'Upload a PDF or a photo');
    const fid = uid('f');
    const key = `${city.id}/permits/${p.id}/${fid}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: file.type } });
    await store.addPermitFile({ id: fid, permit_id: p.id, kind, name: file.name.slice(0, 160), mime: file.type, bytes: bytes.length, file_key: key });
    // Read the file in the background so the AI can compare it with the answers (owner name, address).
    ctx.waitUntil((async () => {
      try {
        const text = await extractText(env, { bytes, name: file.name, mime: file.type });
        if (text) await store.savePermitFileText(p.id, fid, text.slice(0, 6000));
      } catch (e) { console.log('permit file text', e.message); }
    })());
    const asked = kind !== 'ownership_proof' && !(p.asked || []).includes('plans') ? [...(p.asked || []), 'plans'] : p.asked;
    let q = await store.permit(p.id);
    q = await store.savePermit(p.id, { ...recompute(q, city), asked });
    return view(q, { reply: `Attached **${file.name}** as ${label(DOC_KINDS, kind).toLowerCase()}.` });
  }

  if (sub === 'files' && subId && m === 'DELETE') {
    const f = await store.removePermitFile(p.id, subId);
    if (f) await env.FILES.delete(f.file_key);
    const q = await store.permit(p.id);
    return view(await store.savePermit(p.id, recompute(q, city)));
  }

  // Check before submitting: the rules, plus the AI reading the whole application and its documents.
  if (sub === 'check' && m === 'POST') {
    const fresh = await store.savePermit(p.id, recompute(p, city));
    let review = null;
    try { review = await aiReview(env, store, city, fresh); } catch (e) { console.log('ai review failed', e.message); }
    let q = fresh;
    if (review && Object.keys(review.fills).length) {
      q = await saveAnswers(env, store, city, fresh, review.fills);
      review = { ...review, hash: await dataHash(q) };
    }
    q = review ? await store.savePermit(p.id, { review }) : q;
    return view(q, { reviewed: !!review, filled: review?.fills || {} });
  }

  if (sub === 'submit' && m === 'POST') {
    const fresh = await store.savePermit(p.id, recompute(p, city));
    const errors = fresh.checks.filter((c) => c.level === 'error');
    if (errors.length) return fail(400, 'Some required answers are missing.', { checks: fresh.checks });
    const q = await store.submitPermit(p.id, city.settings.requestPrefix, { type: 'resident', name: fresh.applicant || 'Applicant' });
    if (q.convo_id) await store.record(RESIDENT, 'permit.link', 'conversation', q.convo_id, `Permit application ${q.ref} started from this conversation`);
    ctx.waitUntil(afterSubmit(env, store, city, p.id, origin));
    return view(q, { events: await store.permitPublicEvents(p.id) });
  }

  return fail(404, 'Not found');
}

/* ---------------- Staff decisions ---------------- */

async function staffAction(request, env, ctx, city, store, p, me, origin) {
  const b = await request.json().catch(() => ({}));
  const a = b.action;
  const text = (v, max = 1500) => String(v ?? '').trim().slice(0, max);
  const is = (...s) => s.includes(p.status);
  let q = null;
  let tellKind = null; let tellExtra = {};

  if (a === 'request_info') {
    if (!is('submitted', 'fees_due', 'in_review')) return fail(400, 'Corrections can be requested on an open application');
    const items = (Array.isArray(b.items) ? b.items : []).map((x) => text(x, 400)).filter(Boolean).slice(0, 15);
    if (!items.length && !text(b.message)) return fail(400, 'List what the applicant needs to change');
    q = await store.setPermitStatus(p.id, 'needs_info', me.actor, {
      publicNote: 'City Hall asked for changes', data: { items, message: text(b.message) || null },
      patch: { review: JSON.stringify({ ...(p.review || {}), returned: { items, message: text(b.message) || null, at: now(), by: me.actor.name } }) },
    });
    tellKind = 'needs_info'; tellExtra = { items, message: text(b.message) };
  } else if (a === 'accept') {
    if (!is('submitted')) return fail(400, 'Only a submitted application can be marked complete');
    const fee = Number(b.fee);
    if (!(fee >= 0)) return fail(400, 'Enter the permit fee');
    q = await store.setPermitStatus(p.id, fee > 0 ? 'fees_due' : 'in_review', me.actor, { publicNote: fee > 0 ? `Application complete. Permit fee: ${money(fee)}` : 'Application complete. No fee due.', patch: { fee_assessed: fee }, note: text(b.note) || null });
    tellKind = fee > 0 ? 'fees_due' : 'in_review'; tellExtra = { fee, amount: 0 };
  } else if (a === 'payment') {
    if (!is('fees_due')) return fail(400, 'No fee is due on this application');
    const amount = Number(b.amount);
    if (!(amount > 0)) return fail(400, 'Enter the amount received');
    q = await store.setPermitStatus(p.id, 'in_review', me.actor, { publicNote: `Payment of ${money(amount)} received`, patch: { fee_paid: amount, receipt: text(b.receipt, 60) || null } });
    tellKind = 'in_review'; tellExtra = { amount, receipt: text(b.receipt, 60) };
  } else if (a === 'issue') {
    if (!is('in_review')) return fail(400, 'An application must be under review (fees paid) before the permit is issued');
    const number = text(b.permit_number, 40);
    if (!number) return fail(400, 'Enter the permit number');
    try {
      q = await store.setPermitStatus(p.id, 'issued', me.actor, { publicNote: `Permit ${number} issued`, patch: { permit_number: number, conditions: text(b.conditions, 1500) || null, issued_by: me.actor.name } });
    } catch (e) { return fail(409, /UNIQUE/.test(e.message) ? 'That permit number is already used' : e.message); }
    tellKind = 'issued';
  } else if (a === 'deny') {
    if (!is('submitted', 'needs_info', 'fees_due', 'in_review')) return fail(400, 'This application is already decided');
    if (!text(b.reason)) return fail(400, 'Give the reason');
    q = await store.setPermitStatus(p.id, 'denied', me.actor, { publicNote: `Not approved: ${text(b.reason)}` });
    tellKind = 'denied'; tellExtra = { reason: text(b.reason) };
  } else if (a === 'close') {
    if (!is('issued')) return fail(400, 'Only an issued permit can be closed');
    q = await store.setPermitStatus(p.id, 'closed', me.actor, { publicNote: text(b.note) || 'Final inspection passed. Permit closed.' });
    tellKind = 'closed'; tellExtra = { note: text(b.note) };
  } else if (a === 'inspection') {
    if (!is('issued')) return fail(400, 'Inspections are recorded on issued permits');
    const result = b.result === 'failed' ? 'Did not pass' : 'Passed';
    const note = `${text(b.type, 60) || 'Inspection'}: ${result}${text(b.note) ? `. ${text(b.note)}` : ''}`;
    await store.permitNote(p.id, me.actor, note, true);
    q = await store.permit(p.id);
    tellKind = 'inspection'; tellExtra = { type: text(b.type, 60), result: result.toLowerCase(), note: text(b.note) };
  } else if (a === 'note') {
    if (!text(b.note)) return fail(400, 'Write a note');
    await store.permitNote(p.id, me.actor, text(b.note), !!b.public);
    q = await store.permit(p.id);
    if (b.public) { tellKind = 'message'; tellExtra = { message: text(b.note) }; }
  } else if (a === 'assign') {
    try { await store.assignPermit(p.id, b.assignee_id || null, me.actor); } catch (e) { return fail(400, e.message); }
    q = await store.permit(p.id);
  } else {
    return fail(400, 'Unknown action');
  }
  if (tellKind && b.notify !== false) ctx.waitUntil(tell(env, store, city, q, tellKind, tellExtra, origin).catch((e) => console.log('notify failed', e.message)));
  return json(staffView(await store.permitForStaff(p.id), me, city, true));
}

/* ---------------- Files and PDFs ---------------- */

async function fileResponse(env, store, permitId, fileId) {
  const f = await store.permitFile(permitId, fileId);
  const obj = f && await env.FILES.get(f.file_key);
  if (!obj) return fail(404, 'File not found');
  return new Response(obj.body, { headers: { 'Content-Type': f.mime || 'application/octet-stream', 'Content-Disposition': `inline; filename="${f.name.replace(/"/g, '')}"`, 'Cache-Control': 'private, no-store', ...CORS } });
}

// The city's blank form: cached in R2, found in the knowledge base, or downloaded from the city's site.
async function template(env, store, city) {
  const cfg = config(city);
  if (!cfg.pdfTemplate) return null;
  const key = `${city.id}/permits/templates/${cfg.pdfTemplate}.pdf`;
  const cached = await env.FILES.get(key);
  if (cached) return new Uint8Array(await cached.arrayBuffer());
  let bytes = null;
  const docKey = cfg.formUrl && await store.documentFileBySource(cfg.formUrl);
  if (docKey) { const o = await env.FILES.get(docKey); if (o) bytes = new Uint8Array(await o.arrayBuffer()); }
  if (!bytes && cfg.formUrl) {
    const r = await fetch(cfg.formUrl, { headers: { 'User-Agent': 'CityHallOS' } }).catch(() => null);
    if (r?.ok && (r.headers.get('Content-Type') || '').includes('pdf')) bytes = new Uint8Array(await r.arrayBuffer());
  }
  if (bytes) await env.FILES.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  return bytes;
}

async function pdfResponse(env, store, city, p, which) {
  const full = p.files ? p : await store.permit(p.id);
  const bytes = which === 'permit' ? await permitPdf(full, city) : await applicationPdf(full, city, await template(env, store, city));
  const name = which === 'permit' ? `permit-${full.permit_number}.pdf` : `${full.ref || 'draft'}-construction-permit-application.pdf`;
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'private, no-store', ...CORS } });
}

/* ---------------- Daily reminders ---------------- */

export async function sendPermitReminders(env, city, store) {
  const due = await store.permitsNeedingReminder();
  for (const p of due) {
    await tell(env, store, city, p, p.status === 'draft' ? 'reminder_draft' : 'reminder_info');
    await store.savePermit(p.id, { reminders: p.reminders + 1 }, { byApplicant: false });
    if (p.ref) await store.permitNote(p.id, { type: 'system', name: 'City Hall OS' }, 'Reminder sent to the applicant');
  }
  return due.length;
}

