// Applications residents fill out online: the guided application and City Hall's review, for every form in forms/.
//
// Residents need no account. Each application has a secret link (/{city}/#permit={id}.{token}); the browser
// sends the token in X-Permit-Token. Answers autosave, so an application can be finished later on any device
// that has the link. A resident who signs in with their phone number also finds every application they started
// under My applications (residents.js). Staff work submitted applications from the dashboard.
//
//   draft → submitted → (needs_info ⇄ submitted) → fees_due → in_review → issued → closed
//                                                              ↘ denied        (or withdrawn by the applicant)
// The AI reads answers, answers questions, checks completeness and drafts correction requests. Only staff accept
// fees, approve, issue or deny.
import { search } from '../search.js';
import { completeJson, modelName } from '../assistant.js';
import { sha256 } from '../auth.js';
import { extractText } from '../ingest.js';
import { notify } from '../notify.js';
import { residentFrom } from '../residents.js';
import { matches } from './engine.js';
import { FORMS, detectForm, formFor } from './forms/index.js';
import { looksLikeQuestion, quickParse, readMessage } from './converse.js';
import { screenAddress, screenSummary } from './screen.js';
import { applicationPdf, issuedPdf } from './pdf.js';

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

// A city's options for one form: settings.permits[kind] (fees, PDF template, payment instructions, autoReturn).
export const config = (city, kind = 'construction') => ({ autoReturn: false, department: formFor(kind)?.department || 'planning-building', ...(city.settings.permits?.[kind] || {}) });
export const enabledForms = (city) => FORMS.filter((x) => config(city, x.kind).enabled !== false);

/* ---------------- Secret links ---------------- */

// The token is derived from the application id, so City Hall can send the link again later without storing it.
export async function tokenFor(env, id) {
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
  const form = formFor(p.kind);
  const cfg = config(city, p.kind);
  const data = form.derive(p.data, { matchedAddress: p.screen?.matchedAddress });
  const checks = form.check(data, { files: p.files, screen: p.screen, cfg });
  const fee = form.feeEstimate(data, cfg);
  const contact = form.contactFor(data);
  return {
    data, checks, progress: Math.min(p.status === 'draft' ? 99 : 100, form.progress(data, p.files)), fee_estimate: fee?.total ?? null,
    applicant: contact.name || data.owner_name || null, address: p.screen?.matchedAddress || (form.addressField && data[form.addressField]) || null,
    contact: contact.email || contact.phone ? contact : null,
  };
}

// A signed-in resident's details fill the person they said they are: the owner, or the applicant applying for them.
function fromProfile(form, data, profile) {
  if (!profile || !data.applicant_role) return {};
  const pre = data.applicant_role === 'owner' ? 'owner' : data.applicant_role === 'contractor' ? 'contractor' : 'applicant';
  const out = {};
  const put = (k, v) => { if (v && form.FIELDS[k] && (data[k] == null || data[k] === '')) out[k] = v; };
  put(`${pre}_name`, profile.name); put(`${pre}_email`, profile.email);
  put(form.FIELDS[`${pre}_cell`] ? `${pre}_cell` : `${pre}_phone`, profile.phone);
  if (profile.mailing && form.FIELDS[`${pre}_address`] && !data.owner_same_mailing) {
    put(`${pre}_address`, profile.mailing.street); put(`${pre}_city`, profile.mailing.city); put(`${pre}_state`, profile.mailing.state); put(`${pre}_zip`, profile.mailing.zip);
  }
  if (Object.keys(out).length && form.FIELDS.contact_pref && !data.contact_pref) out.contact_pref = profile.email ? 'email' : 'sms';
  return out;
}

async function saveAnswers(env, store, city, p, updates, { profile } = {}) {
  const form = formFor(p.kind);
  const addrKey = form.addressField;
  let data = { ...p.data };
  for (const [k, v] of Object.entries(updates)) {
    if (v === null) delete data[k]; else data[k] = v;
  }
  if ('applicant_role' in updates && profile) Object.assign(data, fromProfile(form, data, profile));
  if (updates.signature_name && !data.signed_at) data.signed_at = now();
  if ('signature_name' in updates && !updates.signature_name) delete data.signed_at;
  if (data.owner_same_mailing === false && p.data.owner_same_mailing === true) for (const k of ['owner_address', 'owner_city', 'owner_state', 'owner_zip']) delete data[k];
  let screen = p.screen;
  if (addrKey && data[addrKey] && data[addrKey] !== p.data[addrKey]) {
    screen = await screenAddress(data[addrKey], city);
    if (screen.matchedAddress && data.owner_same_mailing) for (const k of ['owner_address', 'owner_city', 'owner_state', 'owner_zip']) delete data[k];
  }
  if (!addrKey || !data[addrKey]) screen = null;
  data = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  const next = { ...p, data, screen };
  return store.savePermit(p.id, { ...recompute(next, city), screen });
}

function residentView(p, city, extra = {}) {
  const form = formFor(p.kind);
  const cfg = config(city, p.kind);
  const ask = EDITABLE.includes(p.status) ? form.askView(form.nextAsk(p.data, p.files, p.asked), p.data) : null;
  const corrections = p.status === 'needs_info' ? (p.review?.returned || null) : null;
  return {
    id: p.id, kind: p.kind, ref: p.ref, status: p.status, editable: EDITABLE.includes(p.status), data: p.data, files: p.files, progress: p.progress,
    ask, checks: p.checks || [], review: p.review ? { at: p.review.at, issues: (p.review.issues || []).filter((i) => i.for !== 'staff'), hash: p.review.hash } : null,
    fee: form.feeEstimate(p.data, cfg), fee_assessed: p.fee_assessed, fee_paid: p.fee_paid, permit_number: p.permit_number,
    screen: p.screen ? { matchedAddress: p.screen.matchedAddress, jurisdiction: p.screen.jurisdiction, flood: p.screen.flood } : null,
    corrections, payment: cfg.paymentInstructions || city.settings.permits?.construction?.paymentInstructions || null, submitted_at: p.submitted_at, decided_at: p.decided_at,
    signedIn: !!p.resident_id,
    ...extra,
  };
}

async function dataHash(p) { return sha256(JSON.stringify([p.data, p.files.map((f) => f.id)])); }

/* ---------------- AI review ---------------- */

const REVIEW_SYSTEM = (form, city) => `You are the intake reviewer for the ${city.name} ${form.departmentName || 'Planning & Building'} department. You read a ${form.title.toLowerCase()} before staff do and list what is missing, inconsistent or unclear, so the applicant can fix it before review.
Return JSON only: {"summary": "...", "issues": [{"field": "field_key or files", "level": "error|warning|info", "for": "applicant|staff", "message": "..."}], "fills": {"field_key": "value"}}
- summary: two or three sentences for staff: what is requested, where, by whom, and the main open items.
- issues for the applicant: things they must add or fix, written to the resident in plain words ("Your deed lists Mary Smith, but the owner on the application is John Smith. ..."). Use "error" only for something clearly missing or contradictory that staff would send back.
- issues for staff: things to verify during review. Never decide compliance, never say the application is approved or allowed.
- ${form.review || 'Compare uploaded documents with the answers: owner name and property address.'}
- Do not repeat problems already listed under "Rule checks". Be specific and brief. At most 8 issues.
- fills: answers the applicant left blank that an attached document states plainly. Only these fields: ${(form.fillable || []).join(', ') || 'none'}. Copy the value exactly. Leave fills empty if unsure.`;

async function aiReview(env, store, city, p) {
  const form = formFor(p.kind);
  const files = await store.permitFileTexts(p.id);
  const hits = await search(env, store, city.settings, `${form.title} requirements`, { limit: 4 }).catch(() => []);
  const F = form.FIELDS;
  const fields = Object.entries(p.data).filter(([k]) => F[k] && matches(F[k].when, p.data)).map(([k, v]) => `${k} (${F[k].label}): ${Array.isArray(v) ? v.join(', ') : v}`);
  const kinds = form.docKinds || [];
  const user = [
    `City: ${city.name}, ${city.settings.state}.`,
    `Application answers:\n${fields.join('\n')}`,
    `Attachments: ${p.files.map((f) => `${label(kinds, f.kind)} "${f.name}"`).join('; ') || 'none'}`,
    files.length ? `Text read from attachments:\n${files.map((f) => `--- ${label(kinds, f.kind)} "${f.name}" ---\n${f.text.slice(0, 2500)}`).join('\n')}` : '',
    `Address screen: ${JSON.stringify({ matched: p.screen?.matchedAddress, jurisdiction: p.screen?.jurisdiction, flood: p.screen?.flood })}`,
    `Rule checks already found:\n${(p.checks || []).map((c) => `- [${c.level}] ${c.message}`).join('\n') || 'none'}`,
    hits.length ? `City documents (for context, may be dated):\n${hits.map((h) => `${h.doc.title}: ${h.text.slice(0, 600)}`).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const out = await completeJson(env, REVIEW_SYSTEM(form, city), user, 1800);
  const fillable = form.fillable || [];
  const issues = (Array.isArray(out.issues) ? out.issues : []).slice(0, 10).map((i) => ({
    field: F[i.field] || i.field === 'files' ? i.field : null, level: ['error', 'warning', 'info'].includes(i.level) ? i.level : 'warning',
    for: i.for === 'staff' ? 'staff' : 'applicant', message: String(i.message || '').slice(0, 500), source: 'ai',
  })).filter((i) => i.message)
    // A rule check already covers that field; the AI repeating it adds noise.
    .filter((i) => !(i.for === 'applicant' && i.field && (p.checks || []).some((c) => c.field === i.field && c.level !== 'info')));
  const fills = Object.fromEntries(Object.entries(out.fills && typeof out.fills === 'object' ? out.fills : {})
    .filter(([k, v]) => fillable.includes(k) && v != null && String(v).trim() && (p.data[k] == null || p.data[k] === ''))
    .map(([k, v]) => [k, String(v).trim().slice(0, 60)]));
  // Anything a fill just answered is no longer an issue.
  const open = issues.filter((i) => !(i.field in fills) && !Object.values(fills).some((v) => i.message.includes(v)));
  return { summary: String(out.summary || '').slice(0, 1200), issues: open, fills, at: now(), model: modelName(env), hash: await dataHash(p) };
}

/* ---------------- Telling the applicant ---------------- */

async function tell(env, store, city, p, kind, extra = {}, origin) {
  const to = p.contact;
  if (!to) return;
  const form = formFor(p.kind);
  const link = await linkFor(env, city, p.id, origin);
  const cfg = config(city, p.kind);
  const title = form.short.toLowerCase().replace(/\bco\b/, 'certificate of occupancy');
  const what = `${title} application`;
  const ref = p.ref || 'your application';
  const where = p.address ? ` for ${p.address}` : '';
  const noun = form.issue.noun;
  const number = p.permit_number ? `${noun === 'permit' ? 'Permit' : noun === 'certificate' ? 'Certificate' : 'Approval'} ${p.permit_number}` : ref;
  const call = city.settings.phone ? ` at ${city.settings.phone}` : '';
  const m = {
    received: {
      subject: `We received your ${what} ${ref}`,
      body: `Thank you. We received your ${what} ${ref}${where}.${form.nextSteps?.length ? `\n\nWhat happens next:\n${form.nextSteps.map((x) => `- ${x}`).join('\n')}` : ''}\n\nWe'll contact you at each step.`,
      sms: `We received ${what} ${ref}. We'll text you at each step. Details:`, voice: `We received your ${what}, reference ${ref.split('').join(' ')}. We will contact you at each step.`, linkLabel: 'View your application',
    },
    needs_info: {
      subject: `Application ${ref} needs a few changes`,
      body: `Before review can continue, please update your ${what}:\n\n${(extra.items || []).map((i) => `- ${i}`).join('\n')}${extra.message ? `\n\n${extra.message}` : ''}\n\nYour answers are saved, so you only need to change what's listed, then resubmit.`,
      sms: `Application ${ref} needs changes before review (${(extra.items || []).length || 1} item${(extra.items || []).length === 1 ? '' : 's'}). Open it here:`, voice: `Your ${what} needs a few changes before review can continue.`, linkLabel: 'Fix your application',
    },
    fees_due: {
      subject: `Application ${ref} is complete: fee due`,
      body: `Your ${what} ${ref} is complete. The fee is ${money(extra.fee)}.\n\n${cfg.paymentInstructions || config(city).paymentInstructions || `Pay at City Hall${city.settings.address ? `, ${city.settings.address}` : ''}.`}\n\nReview starts as soon as the fee is paid.`,
      sms: `Application ${ref} is complete. Fee due: ${money(extra.fee)}. How to pay:`, voice: `Your ${what} is complete. The fee is ${money(extra.fee)}. Review starts as soon as the fee is paid.`, linkLabel: 'See payment details',
    },
    in_review: {
      subject: extra.amount ? `Payment received for ${ref}` : `Application ${ref} is under review`,
      body: `${extra.amount ? `We received your payment of ${money(extra.amount)}${extra.receipt ? ` (receipt ${extra.receipt})` : ''}. ` : ''}${form.statuses.in_review[1]}.`,
      sms: `${extra.amount ? `Payment received for ${ref}. ` : ''}${form.statuses.in_review[0]}: ${ref}.`, voice: `${extra.amount ? 'We received your payment. ' : ''}Your application is now under review.`, linkLabel: 'View your application',
    },
    issued: {
      subject: `${number} ${noun === 'approval' ? 'is approved' : 'has been issued'}`,
      body: `Your ${title} ${p.permit_number ? `${p.permit_number} ` : ''}${where} ${noun === 'approval' ? 'was approved' : 'has been issued'}.${p.conditions ? `\n\nConditions: ${p.conditions}` : ''}${form.issue.after ? `\n\n${form.issue.after}` : ''}`,
      sms: `${number} ${noun === 'approval' ? 'is approved' : 'is issued'}. Download it here:`, voice: `Good news. Your ${title} ${noun === 'approval' ? 'was approved' : 'has been issued'}.`, linkLabel: `Download your ${noun}`,
    },
    denied: {
      subject: `Application ${ref} was not approved`,
      body: `Your ${what} ${ref} was not approved.\n\nReason: ${extra.reason}\n\nPlease contact City Hall${call} to talk about your options, including changes to the request or an appeal.`,
      sms: `Application ${ref} was not approved. Details:`, voice: `Your ${what} was not approved. We have sent you the reason in writing.`, linkLabel: 'View details',
    },
    closed: { subject: `${number} is closed`, body: `${number} is closed.${extra.note ? `\n\n${extra.note}` : ''} Thank you.`, sms: `${number} is closed. Thank you.`, linkLabel: 'View' },
    message: { subject: `A message about ${ref}`, body: extra.message, sms: `Message about ${ref}: ${String(extra.message).slice(0, 300)}`, voice: `City Hall has a message about your application. ${extra.message}`, linkLabel: 'Open your application' },
    inspection: { subject: `Inspection result for ${number}`, body: `${extra.type ? `${extra.type} inspection` : 'Inspection'}: ${extra.result}.${extra.note ? `\n\n${extra.note}` : ''}`, sms: `${extra.type || 'Inspection'} for ${number}: ${extra.result}.`, linkLabel: 'View your application' },
    reminder_draft: {
      subject: `Finish your ${what}`,
      body: `Your ${what}${where} is ${p.progress}% done. Your answers are saved. Pick up where you left off.`,
      sms: `Your ${what} is ${p.progress}% done. Finish it here:`, linkLabel: 'Finish your application',
    },
    reminder_info: {
      subject: `Reminder: ${ref} is waiting on changes`,
      body: `City Hall is still waiting on changes to ${what} ${ref}. Review can't continue until it's updated and resubmitted.`,
      sms: `Reminder: application ${ref} is waiting on your changes:`, linkLabel: 'Fix your application',
    },
    resume: {
      subject: 'Your application link',
      body: `Here's the link to your ${what}${where}. Your answers save automatically, so you can finish it on any device.`,
      sms: `Your ${what} link (answers save automatically):`, linkLabel: 'Open your application',
    },
  }[kind];
  return notify(env, store, city, { entityType: 'permit', entityId: p.id, to: extra.pref ? { ...to, pref: extra.pref } : to, msg: { ...m, link } });
}

// Let the form's department know a new application arrived.
async function tellStaff(env, store, city, p, origin) {
  const form = formFor(p.kind);
  const dept = (await store.departments()).find((d) => d.id === config(city, p.kind).department);
  if (!dept?.email) return;
  await notify(env, store, city, {
    entityType: 'permit', entityId: p.id, to: { email: dept.email, pref: 'email' },
    msg: {
      subject: `New ${form.short.toLowerCase()} application ${p.ref}${p.address ? `: ${p.address}` : ''}`,
      body: `${p.applicant || 'An applicant'} submitted ${form.title.toLowerCase()} ${p.ref}.\n\n${p.review?.summary || p.data[form.descriptionField] || ''}`,
      link: `${origin || env.APP_ORIGIN || ''}/#/permits`, linkLabel: 'Open in the dashboard',
    },
  });
}

/* ---------------- After submission ---------------- */

async function afterSubmit(env, store, city, id, origin) {
  let p = await store.permit(id);
  const form = formFor(p.kind);
  try {
    const addr = form.addressField && p.data[form.addressField];
    if (addr && !p.screen?.jurisdiction?.checked) {
      p = await store.savePermit(id, { screen: await screenAddress(addr, city) }, { byApplicant: false });
      p = await store.savePermit(id, recompute(p, city), { byApplicant: false });
    }
    let review = p.review;
    if (!review || review.hash !== await dataHash(p)) review = await aiReview(env, store, city, p);
    if (Object.keys(review.fills || {}).length) {
      p = await saveAnswers(env, store, city, p, review.fills);
      await store.permitNote(id, AI, `Filled in from the attached documents: ${Object.entries(review.fills).map(([k, v]) => `${form.FIELDS[k].label} ${v}`).join('; ')}`, true);
    }
    p = await store.savePermit(id, { review }, { byApplicant: false });
  } catch (e) {
    console.log('application review failed', e.stack || e.message);
  }
  const cfg = config(city, p.kind);
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

// The forms a city takes online, for the chat's "Applications & forms" list.
export function formList(city) {
  return enabledForms(city).map((x) => {
    const fee = x.feeEstimate({}, config(city, x.kind));
    return { kind: x.kind, title: x.title, short: x.short, icon: x.icon || 'file', intro: x.intro || '', formUrl: x.formUrl, formUrls: x.formUrls || [x.formUrl], fee: fee?.total ?? null };
  });
}

export async function permitRoute({ request, env, ctx, url, city, store, me, parts }) {
  const [id, sub, subId] = parts;
  const m = request.method;
  const origin = url.origin;
  const hasToken = !!(request.headers.get('X-Permit-Token') || url.searchParams.get('token'));

  if (id === 'schema' && m === 'GET') {
    const form = formFor(sub || url.searchParams.get('kind') || 'construction');
    if (!form) return fail(404, 'Unknown application');
    const cfg = config(city, form.kind);
    return json({ ...form.publicSchema(), enabled: cfg.enabled !== false, payment: cfg.paymentInstructions || null, feeSource: cfg.fees?.source || null }, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (id === 'forms' && m === 'GET') return json({ forms: formList(city) }, 200, { 'Cache-Control': 'public, max-age=300' });
  if (!id && m === 'GET' && !me) return fail(401, 'Please sign in');

  // Start an application. An opening message ("a 24x30 garage behind my house") is read right away.
  if (!id && m === 'POST') {
    const b = await request.json().catch(() => ({}));
    const form = formFor(b.kind || 'construction');
    if (!form || config(city, form.kind).enabled === false) return fail(400, "That application isn't available online. Call City Hall.");
    const resident = await residentFrom(request, store);
    const pid = uid('p');
    const token = await tokenFor(env, pid);
    let p = await store.createPermit({ id: pid, tokenHash: await sha256(token), kind: form.kind, data: {}, convoId: typeof b.convoId === 'string' ? b.convoId.slice(0, 20) : null, residentId: resident?.id || null });
    // Reuse answers from an earlier application on this device: owner and contractor details are typed once.
    let reused = null;
    if (b.copyFrom?.id && b.copyFrom?.token) {
      const prev = await store.permit(String(b.copyFrom.id));
      if (prev && prev.token_hash === await sha256(String(b.copyFrom.token))) {
        const re = form.copyKeys || /^(owner_|applicant_|contractor_|contact_pref$|applicant_role$)/;
        const keep = Object.keys(form.FIELDS).filter((k) => re.test(k) && !['owner_exemption', 'owner_ack'].includes(k) && formFor(prev.kind).FIELDS[k]);
        const copied = Object.fromEntries(keep.filter((k) => prev.data[k] != null).map((k) => [k, prev.data[k]]));
        if (Object.keys(copied).length) { p = await saveAnswers(env, store, city, p, copied); reused = prev.ref || formFor(prev.kind).short; }
      }
    }
    let reply = null;
    if (b.opening && String(b.opening).trim().length > 3) {
      const r = await readMessage(env, form, city, form.asks[0]?.ai ? form.asks[0] : null, String(b.opening).slice(0, 1200), p.data);
      p = await saveAnswers(env, store, city, p, r.updates, { profile: resident });
      reply = ackFor(form, r.updates, r.question ? null : r.reply);
    }
    p = await store.savePermit(pid, recompute(p, city));
    return json({ ...residentView(p, city, { reply, reused }), token }, 201);
  }

  if (!id) {
    if (!me.can('permits.view')) return fail(403, "Your role doesn't allow this");
    const redact = !me.can('residents.contact');
    const permits = (await store.listPermits({ status: url.searchParams.get('status'), kind: url.searchParams.get('kind') })).map((p) => ({
      ...p, checks: undefined, review: undefined, contact: redact ? null : p.contact, applicant: redact && p.applicant ? 'Hidden' : p.applicant,
      title: formFor(p.kind)?.short || p.kind,
      errors: (p.checks || []).filter((c) => c.level === 'error').length, concerns: (p.review?.issues || []).filter((i) => i.level !== 'info').length,
      summary: p.review?.summary || null,
    }));
    return json({ permits, forms: FORMS.map((x) => ({ kind: x.kind, short: x.short })) });
  }

  // The applicant, with the secret link.
  if (hasToken) {
    const p = await residentPermit(request, store, id);
    if (!p) return fail(404, 'Application not found. Check your link, or call City Hall.');
    if (!formFor(p.kind)) return fail(400, 'This application type is no longer available online. Call City Hall.');
    return applicantRoute({ request, env, ctx, city, store, p, sub, subId, m, origin, url });
  }

  // Staff.
  if (!me) return fail(401, 'Please sign in');
  if (!me.can('permits.view')) return fail(403, "Your role doesn't allow this");
  const p = await store.permitForStaff(id);
  if (!p || p.status === 'draft') return fail(404, 'Application not found');
  const canEdit = me.can('permits.edit') && (!me.departmentId || me.departmentId === config(city, p.kind).department);
  if (!sub && m === 'GET') return json(staffView(p, me, city, canEdit));
  if (sub === 'files' && subId && m === 'GET') return fileResponse(env, store, id, subId);
  if (sub === 'pdf' && m === 'GET') return pdfResponse(env, store, city, p, 'application');
  if (sub === 'permit.pdf' && m === 'GET') return pdfResponse(env, store, city, p, 'issued');
  if (!canEdit) return fail(403, "Your role doesn't allow this");
  if (sub === 'review' && m === 'POST') {
    const review = await aiReview(env, store, city, p);
    await store.savePermit(id, { review: { ...p.review, ...review } }, { byApplicant: false });
    await store.record(me.actor, 'permit.ai_review', 'permit', p.ref, `${p.ref}: re-ran the AI completeness review`);
    return json(staffView(await store.permitForStaff(id), me, city, canEdit));
  }
  if (sub === 'actions' && m === 'POST') return staffAction(request, env, ctx, city, store, p, me, origin);
  return fail(404, 'Not found');
}

function staffView(p, me, city, canEdit) {
  const form = formFor(p.kind);
  const redact = !me.can('residents.contact');
  const hide = (v) => (redact && v ? 'Hidden' : v);
  const data = redact ? Object.fromEntries(Object.entries(p.data).map(([k, v]) => [k, /(_phone|_cell|_email)$/.test(k) ? hide(v) : v])) : p.data;
  return {
    ...p, data, contact: redact ? null : p.contact, outbox: redact ? p.outbox.map((o) => ({ ...o, to_addr: hide(o.to_addr), body: hide(o.body) })) : p.outbox,
    fee: form.feeEstimate(p.data, config(city, p.kind)), canEdit, schema: form.publicSchema(),
    suggestedPermitNumber: `${city.settings.requestPrefix}-${new Date().getFullYear()}-${(p.ref || '').split('-').pop()}`,
  };
}

// Acknowledgment for answers the rules understood, when the AI didn't write one.
function ackFor(form, updates, aiReply) {
  if (aiReply) return aiReply;
  const F = form.FIELDS;
  const keys = Object.keys(updates).filter((k) => F[k] && !['longtext', 'signature', 'check'].includes(F[k].type) && !F[k].label.endsWith('?') && updates[k] !== null);
  if (!keys.length) return Object.keys(updates).length ? 'Got it.' : null;
  const shown = keys.slice(0, 4).map((k) => {
    const fd = F[k]; const v = updates[k];
    const val = fd.options ? (Array.isArray(v) ? v.map((x) => label(fd.options, x)).join(', ') : label(fd.options, v)) : fd.type === 'money' ? money(v) : fd.type === 'bool' ? (v ? 'yes' : 'no') : v;
    return `${fd.label.replace(/ \(.*\)$/, '')}: **${val}**`;
  });
  return `Got it. ${shown.join(' · ')}`;
}

async function applicantRoute({ request, env, ctx, city, store, p, sub, subId, m, origin }) {
  const form = formFor(p.kind);
  const view = (q, extra) => json(residentView(q, city, extra));
  const resident = await residentFrom(request, store);
  // A signed-in resident who opens an application from a link keeps it in My applications.
  if (resident && !p.resident_id) { await store.claimPermit(p.id, resident.id); p.resident_id = resident.id; }

  if (!sub && m === 'GET') return json(residentView(p, city, { events: await store.permitPublicEvents(p.id) }));
  if (sub === 'files' && subId && m === 'GET') return fileResponse(env, store, p.id, subId);
  if (sub === 'pdf' && m === 'GET') return pdfResponse(env, store, city, p, 'application');
  if (sub === 'permit.pdf' && m === 'GET') return p.status === 'issued' || p.status === 'closed' ? pdfResponse(env, store, city, p, 'issued') : fail(400, `The ${form.issue.noun} has not been issued yet`);

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
    // Certificates of occupancy are inspected before they're issued; permits after.
    if (!form.issue.inspections || !(p.status === 'issued' || (p.status === 'in_review' && form.issue.noun === 'certificate'))) return fail(400, "Inspections can't be requested at this stage. Call City Hall.");
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
      if (!form.FIELDS[k] || form.FIELDS[k].type === 'files') continue;
      const c = form.coerce(k, v);
      if (c !== undefined) updates[k] = c;
    }
    if ('applicant_note' in (b.data || {})) updates.applicant_note = String(b.data.applicant_note || '').slice(0, 1000) || null;
    const addr = form.addressField;
    const before = addr && p.data[addr];
    const q = await saveAnswers(env, store, city, p, updates, { profile: resident });
    return view(q, { screenNote: addr && q.data[addr] !== before && q.screen ? screenSummary(q.screen, city) : null, changed: Object.keys(q.data).filter((k) => JSON.stringify(q.data[k]) !== JSON.stringify(p.data[k]) && !(k in updates)) });
  }

  // One chat message: read it into answers (or answer the resident's question), then ask the next question.
  if (sub === 'message' && m === 'POST') {
    if (env.CHAT_LIMIT) {
      const { success } = await env.CHAT_LIMIT.limit({ key: `${city.id}:${request.headers.get('CF-Connecting-IP') || 'anon'}` });
      if (!success) return fail(429, 'Too many messages. Please wait a minute and try again.');
    }
    const b = await request.json().catch(() => ({}));
    const text = String(b.text || '').trim().slice(0, 1200);
    const asked = [...(p.asked || [])];
    const ask = form.asks.find((a) => a.id === b.ask) || form.nextAsk(p.data, p.files, asked);
    let updates = {}; let reply = null; let understood = true; let question = false;
    if (b.choice) {
      if (b.choice === '__skip') asked.push(ask.id);
      else if (b.choice.startsWith('__bring')) {
        // "I'll bring it to City Hall": the bring_* checkbox that goes with this upload question.
        const bring = Object.keys(form.FIELDS).filter((x) => /^bring_/.test(x));
        const k = ask.bring || bring.find((x) => (ask.upload || []).some((u) => x.includes(u.split('_')[0]))) || bring[0];
        if (k) updates[k] = true; else asked.push(ask.id);
      }
      else {
        const c = ask.choices?.find(([v]) => v === b.choice);
        updates = quickParse(form, ask, c ? c[1] : String(b.choice), p.data);
        for (const [k, v] of Object.entries(updates)) { if (v !== null && form.FIELDS[k]) { const cv = form.coerce(k, v); if (cv === undefined) delete updates[k]; else updates[k] = cv; } }
      }
    } else if (text) {
      // Questions are answered from the field explanations and the city's own documents.
      const sources = looksLikeQuestion(text) ? await search(env, store, city.settings, `${form.short} ${text}`, { limit: 4 }).catch(() => []) : [];
      const r = await readMessage(env, form, city, ask, text, p.data, { sources });
      updates = r.updates; reply = r.reply; question = r.question;
      understood = Object.keys(updates).length > 0 || r.question;
      // Any reply to an optional question that isn't a question moves on ("not yet", "I don't know").
      if (ask?.optional && !Object.keys(updates).length && !r.question) { asked.push(ask.id); understood = true; }
    }
    if (ask && (ask.optional || ask.upload) && Object.keys(updates).length && !asked.includes(ask.id)) asked.push(ask.id);
    const addr = form.addressField;
    const before = addr && p.data[addr];
    let q = await saveAnswers(env, store, city, { ...p, asked }, updates, { profile: resident });
    if (JSON.stringify(asked) !== JSON.stringify(p.asked || [])) q = await store.savePermit(p.id, { asked });
    const lines = [];
    const ack = b.choice ? null : ackFor(form, updates, reply);
    if (ack) lines.push(ack);
    else if (!understood) lines.push("Sorry, I didn't catch that. You can answer in your own words, or ask me what anything means.");
    if (addr && q.data[addr] !== before && q.screen) lines.push(screenSummary(q.screen, city));
    const fee = form.feeEstimate(q.data, config(city, p.kind));
    const feeField = Object.keys(updates).some((k) => ['money', 'number'].includes(form.FIELDS[k]?.type));
    if (fee && fee.total > 0 && feeField && fee.total !== form.feeEstimate(p.data, config(city, p.kind))?.total) lines.push(`Based on the published fee schedule, the fee would be about **${money(fee.total)}**. City Hall confirms the final amount.`);
    const next = form.askView(form.nextAsk(q.data, q.files, q.asked), q.data);
    if (!next && !question) lines.push("That's everything the application asks for. Review it, then tap **Check my application**. I'll look for anything City Hall would send back.");
    // Asking for a different application ("I need a construction permit instead") offers to start it.
    const other = text && !Object.keys(updates).length ? detectForm(text) : null;
    const suggest = other && other !== p.kind && config(city, other).enabled !== false ? { kind: other, title: formFor(other).title } : null;
    return view(q, { reply: lines.join('\n\n'), changed: Object.keys(updates), question, suggest });
  }

  if (sub === 'files' && !subId && m === 'POST') {
    if (p.files.length >= 25) return fail(400, 'An application can have up to 25 attachments');
    const fdata = await request.formData();
    const file = fdata.get('file');
    const kinds = form.docKinds || [['other', 'Document']];
    const kind = kinds.some(([k]) => k === fdata.get('kind')) ? fdata.get('kind') : kinds.at(-1)[0];
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
      } catch (e) { console.log('application file text', e.message); }
    })());
    // An upload answers the upload question it belongs to.
    const uploadAsk = form.asks.find((a) => (a.upload || []).includes(kind) && !(p.asked || []).includes(a.id));
    const asked = uploadAsk ? [...(p.asked || []), uploadAsk.id] : p.asked;
    let q = await store.permit(p.id);
    q = await store.savePermit(p.id, { ...recompute(q, city), asked });
    return view(q, { reply: `Attached **${file.name}** as ${label(kinds, kind).toLowerCase()}.` });
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
    const q = await store.submitPermit(p.id, city.settings.requestPrefix, { type: 'resident', name: fresh.applicant || 'Applicant' }, { code: form.code, title: form.short });
    if (q.convo_id) await store.record(RESIDENT, 'permit.link', 'conversation', q.convo_id, `${form.title} ${q.ref} started from this conversation`);
    ctx.waitUntil(afterSubmit(env, store, city, p.id, origin));
    return view(q, { events: await store.permitPublicEvents(p.id) });
  }

  return fail(404, 'Not found');
}

/* ---------------- Staff decisions ---------------- */

async function staffAction(request, env, ctx, city, store, p, me, origin) {
  const form = formFor(p.kind);
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
    if (!(fee >= 0)) return fail(400, 'Enter the fee');
    q = await store.setPermitStatus(p.id, fee > 0 ? 'fees_due' : 'in_review', me.actor, { publicNote: fee > 0 ? `Application complete. Fee: ${money(fee)}` : 'Application complete. No fee due.', patch: { fee_assessed: fee }, note: text(b.note) || null });
    tellKind = fee > 0 ? 'fees_due' : 'in_review'; tellExtra = { fee, amount: 0 };
  } else if (a === 'payment') {
    if (!is('fees_due')) return fail(400, 'No fee is due on this application');
    const amount = Number(b.amount);
    if (!(amount > 0)) return fail(400, 'Enter the amount received');
    q = await store.setPermitStatus(p.id, 'in_review', me.actor, { publicNote: `Payment of ${money(amount)} received`, patch: { fee_paid: amount, receipt: text(b.receipt, 60) || null } });
    tellKind = 'in_review'; tellExtra = { amount, receipt: text(b.receipt, 60) };
  } else if (a === 'issue') {
    if (!is('in_review')) return fail(400, 'An application must be under review (fees paid) before it is approved');
    const number = text(b.permit_number, 40);
    if (!number) return fail(400, `Enter the ${form.issue.numberLabel.toLowerCase()}`);
    try {
      q = await store.setPermitStatus(p.id, 'issued', me.actor, { publicNote: `${form.issue.noun === 'approval' ? 'Approved' : 'Issued'}: ${number}`, patch: { permit_number: number, conditions: text(b.conditions, 1500) || null, issued_by: me.actor.name } });
    } catch (e) { return fail(409, /UNIQUE/.test(e.message) ? 'That number is already used' : e.message); }
    tellKind = 'issued';
  } else if (a === 'deny') {
    if (!is('submitted', 'needs_info', 'fees_due', 'in_review')) return fail(400, 'This application is already decided');
    if (!text(b.reason)) return fail(400, 'Give the reason');
    q = await store.setPermitStatus(p.id, 'denied', me.actor, { publicNote: `Not approved: ${text(b.reason)}` });
    tellKind = 'denied'; tellExtra = { reason: text(b.reason) };
  } else if (a === 'close') {
    if (!is('issued')) return fail(400, 'Only an issued permit can be closed');
    q = await store.setPermitStatus(p.id, 'closed', me.actor, { publicNote: text(b.note) || (form.issue.inspections ? 'Final inspection passed. Closed.' : 'Closed.') });
    tellKind = 'closed'; tellExtra = { note: text(b.note) };
  } else if (a === 'inspection') {
    if (!is('issued', 'in_review')) return fail(400, 'Inspections are recorded on applications under review or issued');
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

// The city's blank fillable form: cached in R2, found in the knowledge base, or downloaded from the city's site.
async function template(env, store, city, kind) {
  const cfg = config(city, kind);
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
  const form = formFor(full.kind);
  const bytes = which === 'issued' ? await issuedPdf(full, city, form) : await applicationPdf(full, city, form, config(city, full.kind), await template(env, store, city, full.kind));
  const slug = form.short.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const name = which === 'issued' ? `${slug}-${full.permit_number}.pdf` : `${full.ref || 'draft'}-${slug}-application.pdf`;
  return new Response(bytes, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'private, no-store', ...CORS } });
}

/* ---------------- Daily reminders ---------------- */

export async function sendPermitReminders(env, city, store) {
  const due = (await store.permitsNeedingReminder()).filter((p) => formFor(p.kind));
  for (const p of due) {
    await tell(env, store, city, p, p.status === 'draft' ? 'reminder_draft' : 'reminder_info');
    await store.savePermit(p.id, { reminders: p.reminders + 1 }, { byApplicant: false });
    if (p.ref) await store.permitNote(p.id, { type: 'system', name: 'City Hall OS' }, 'Reminder sent to the applicant');
  }
  return due.length;
}
