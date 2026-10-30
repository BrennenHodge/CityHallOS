// The Business licensing assistant: city business (privilege) licenses under Miss. Code Ann. § 27-17.
//
// Residents apply or renew through the chat or the portal. The AI asks only for what's still missing and explains what
// the city's own settings and documents say; it never approves anything. Staff review each application, ask for missing
// information, assess the fee, record payment at the counter and issue the license, or deny it with a reason. Issued
// licenses go in the registry, with renewal notices and a public lookup. The legal rules are in licensing-rules.js.
//
//   /api/{city}/licenses/...   public: info, intake, applications (POST), track/{ref}, lookup
//                              staff:  summary, settings, applications, registry, notices
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { generate } from './assistant.js';
import { charge, paymentsInfo, refund } from './payments.js';
import { notify } from './notify.js';
import {
  APPLICATION_STATUS, OPEN_STATUSES, STATE_SCHEDULE, annualFee, cityToday, describeFee, dollars, isDate, licensePeriod, suggestFee,
} from './licensing-rules.js';
import { APP_FIELDS } from './licensing-store.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status, error) => json({ error }, status);
const httpError = (status, message) => Object.assign(new Error(message), { status });
const clean = (v, max = 300) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
const appOrigin = (env, url) => url?.origin || env.APP_ORIGIN || 'https://app.cityhallos.com';
export const trackUrl = (origin, city, ref) => `${origin}/licenses.html?city=${encodeURIComponent(city.slug)}&ref=${encodeURIComponent(ref)}`;

const ENTITY_TYPES = [['sole_proprietor', 'Sole proprietor'], ['llc', 'LLC'], ['corporation', 'Corporation'], ['partnership', 'Partnership'], ['nonprofit', 'Nonprofit']];
const YES_NO = [['yes', 'Yes'], ['no', 'No']];

/* ---------------- Notifications ---------------- */

// Sends a one-paragraph notice by email, or by text when only a phone number is on file, through notify.js (which keeps
// every message in the city's outbox). Callers record the result on the timeline and in the registry, so staff can call or
// mail when a notice couldn't be sent.
async function sendNotice(env, store, city, { entityType, entityId, to, msg }) {
  const results = await notify(env, store, city, {
    entityType, entityId, to: { email: to.email, phone: to.phone, pref: to.email ? 'email' : 'sms' },
    msg: { subject: `${city.settings.shortName} business license ${entityId}`, body: msg, sms: msg },
  }).catch((e) => [{ status: 'failed', error: e.message }]);
  return results.some((x) => x.status === 'sent') ? { sent: true }
    : { sent: false, reason: results.map((x) => x.error || x.status.replace('_', ' ')).join(', ') };
}

async function noticeToApplicant(env, store, city, app, msg, me) {
  if (!app.phone && !app.email) return;
  const r = await sendNotice(env, store, city, { entityType: 'license', entityId: app.ref, to: { name: app.owner_name, email: app.email, phone: app.phone }, msg });
  await store.licTransition(app.id, app.status, {
    note: r.sent ? `Applicant notified: ${msg}` : `Applicant not notified (${r.reason}). Contact them at ${[app.phone, app.email].filter(Boolean).join(' or ')}: "${msg}"`,
    summary: r.sent ? 'notified the applicant' : 'applicant notice not sent',
  }, { type: 'system', name: 'City Hall OS' });
}

/* ---------------- Settings for residents and the AI ---------------- */

const termText = (cfg) => (cfg.term === 'anniversary'
  ? 'Licenses run for one year from the first day of the month they are issued.'
  : `Every license expires on ${new Date(`2000-${cfg.expiresOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })} each year and is renewed annually${cfg.prorate ? '; a license bought partway through the year is prorated' : ''}.`);

function publicInfo(city, { config: cfg, configured }) {
  return {
    configured, cityName: city.settings.cityName, shortName: city.settings.shortName, county: city.county, phone: city.settings.phone,
    prefix: city.settings.requestPrefix, officerTitle: cfg.officerTitle, term: termText(cfg), requirements: cfg.requirements, homeRules: cfg.homeRules,
    penalty: `${cfg.penaltyInitialPct}% plus ${cfg.penaltyMonthlyPct}% a month`,
    classes: cfg.classes.map((c) => ({ key: c.key, label: c.label, description: c.description, fee: describeFee(c) })),
  };
}

// Passages the AI City Clerk reads when a resident asks about business licenses: the city's own settings first, then state law.
export async function licensingSources(store, city, origin) {
  const { config: cfg, configured, updated_at: updatedAt } = await store.licConfig();
  const s = city.settings;
  const lines = [
    `${s.cityName} business (privilege) licenses. City Hall staff review every application, assess the fee and issue the license; the AI assistant cannot approve or issue a license.`,
    `Apply or renew in this chat (say "apply for a business license") or at City Hall${s.address ? `, ${s.address}` : ''}${s.phone ? `, ${s.phone}` : ''}. Payment is by cash or check at City Hall after staff assess the fee.`,
    configured ? termText(cfg) : '',
    configured && cfg.classes.length ? `License classes and fees: ${cfg.classes.map((c) => `${c.label}: ${describeFee(c)}`).join('. ')}.` : 'The city has not entered its license fee schedule here yet; City Hall assesses the fee during review.',
    cfg.requirements ? `What applicants need: ${cfg.requirements}` : '',
    cfg.homeRules ? `Home-based businesses: ${cfg.homeRules}` : '',
    `Check whether a business is licensed: ${origin}/licenses.html?city=${city.slug}`,
  ].filter(Boolean);
  const law = [
    'Mississippi law (Miss. Code Ann. § 27-17-9) requires anyone doing business inside a city to get a privilege license from the city before starting the business. Businesses outside city limits get it from the county instead (§ 27-17-5).',
    'The application gives the business name and each partner, the business office address, the location of the place of business, the nature of the business, and the number of full-time employees (30 or more hours a week) over the past 12 months (§ 27-17-453, § 27-17-3). Renewals do not need to be notarized.',
    'Licenses expire September 30 each year unless the city has adopted an ordinance making them run one year from issuance; a partial-year license is prorated (§ 27-17-463). The city sends a renewal notice by the first day of the month before expiration, but not receiving one does not excuse late penalties (§ 27-17-465).',
    'Late renewals, or starting a business before getting the license, owe the tax plus a 10% penalty and 1% for each month or part of a month it stays unpaid (§ 27-17-467).',
  ];
  const doc = (title, authority, verification, asOf) => ({ id: null, title, category: 'Business licenses', authority, verification, as_of: asOf, visibility: 'public',
    source_url: `${origin}/licenses.html?city=${city.slug}`, file_key: null });
  return [
    { doc: configured ? doc(`Business licenses in ${s.shortName} (set by City Hall)`, 'staff-note', 'verified_current', updatedAt.slice(0, 10))
      : doc(`How to apply for a business license in ${s.shortName}`, 'staff-note', 'verified_current', 'current'), heading: '', text: lines.join('\n'), score: 1 },
    { doc: doc('Mississippi privilege license law, Miss. Code Ann. § 27-17', 'state-public-record', 'official_unverified', 'current as of 2025'), heading: '', text: law.join('\n'), score: 1 },
  ];
}

// "How do I get a business license?", "renew my privilege license", "I want to open a bakery out of my house".
export const isLicenseQuestion = (text) => /\b(business|privilege|occupation(al)?|merchant|vendor'?s?)\s+licen[cs]es?\b|\blicen[cs]e (for|to (open|run|start)) (a |my )?(business|shop|store)\b|\b(open|opening|start|starting|run|running)\s+(a|my|our|an?)\s+(new\s+)?(small\s+)?(business|shop|store|restaurant|salon|bakery|food truck|daycare)\b|\bhome[- ]based business\b|\bhome occupation\b|\b[A-Z]{2,5}-(BL|LIC)-\d{4,}/i.test(text);

/* ---------------- Guided intake ---------------- */

// The questions, in order. The AI fills in what the resident already said; only what's still missing is asked.
function questions(city, cfg) {
  const short = city.settings.shortName;
  const classes = cfg.classes;
  return [
    { field: 'kind', required: true, choices: [['new', 'New license'], ['renewal', 'Renewal']], ask: 'Is this for a **new** business license, or **renewing** a license you already have?' },
    { field: 'license_number', when: (d) => d.kind === 'renewal', ask: `What's your current license number? It's printed on the license, like ${city.settings.requestPrefix}-LIC-1001. If you don't have it handy, type "skip" and City Hall will look it up.` },
    { field: 'business_name', required: true, ask: "What's the name of the business?" },
    { field: 'description', required: true, ask: 'What does the business do? A short description is fine, like "home bakery selling cakes" or "lawn care and landscaping".' },
    { field: 'class_key', required: classes.length > 1, when: () => classes.length > 1, choices: classes.map((c) => [c.key, c.label]),
      ask: `Which kind of license fits best?\n${classes.map((c) => `- **${c.label}**${c.description ? `: ${c.description}` : ''} (${describeFee(c)})`).join('\n')}` },
    { field: 'owner_name', required: true, ask: "What's the owner's full name? For a company, give the name of the person signing for it, and list any partners." },
    { field: 'entity_type', newOnly: true, choices: ENTITY_TYPES, ask: 'How is the business set up?' },
    { field: 'location', required: true, ask: "What's the street address where the business operates? If you work at customers' locations, give your business office address." },
    { field: 'inside_limits', required: true, choices: [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']], ask: `Is that address inside ${short} city limits?` },
    { field: 'home_based', required: true, choices: YES_NO, ask: 'Will you run the business from your home?' },
    { field: 'home_customers', when: (d) => d.home_based, choices: YES_NO, ask: 'Will customers or clients come to your home?' },
    { field: 'home_workers', when: (d) => d.home_based, choices: YES_NO, ask: "Will anyone who doesn't live in the home work there?" },
    { field: 'home_outside', when: (d) => d.home_based, choices: YES_NO, ask: 'Will there be a business sign, or equipment, vehicles or inventory kept outside?' },
    { field: 'employees', required: true, ask: 'How many full-time employees does the business have? Count everyone who works 30 or more hours a week, including owners and partners who work in it. Seasonal workers don\'t count. If it\'s just you, say 1.' },
    { field: 'start_date', newOnly: true, ask: 'When did, or will, the business start operating in the city? A date like "November 15" is fine.' },
    { field: 'sos_id', newOnly: true, ask: 'Is the business registered with the **Mississippi Secretary of State**? If so, what\'s its business ID? Sole proprietors using their own name usually aren\'t registered. Type "none" if it isn\'t.' },
    { field: 'dor_account', newOnly: true, ask: 'Do you have a **Mississippi Department of Revenue** tax account, such as a sales tax permit? Give the account number, or type "none" or "applied".' },
    { field: 'state_licenses', newOnly: true, ask: 'Does the work need any state license or permit, such as a contractor license, a cosmetology license or a health department food permit? List them, or type "none".' },
    { field: 'changes', when: (d) => d.kind === 'renewal', ask: 'Has anything changed since your last license, like the address, the owner or what the business does? Type "no" if nothing changed.' },
    { field: 'phone', required: (d) => !d.email, ask: 'What phone number can City Hall reach you at?' },
    { field: 'email', ask: 'And an email address for updates on your application? Type "skip" if you\'d rather not.' },
  ];
}

const isYes = (t) => /^\s*(y|yes|yeah|yep|yup|sure|correct|right|it is|i will|we will|i do|we do|definitely|of course)\b/i.test(t);
const isNo = (t) => /^\s*(n|no|nope|nah|not|never|none|i won'?t|we won'?t|i don'?t|we don'?t)\b/i.test(t);
const isSkip = (t) => /^\s*(skip|pass|n\/a|later|don'?t know|not sure|unknown)\s*\.?\s*$/i.test(t);
const PHONE = /\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

function parseDate(t, today) {
  const s = String(t).trim();
  if (isDate(s)) return s;
  if (/\b(today|now|right away|immediately)\b/i.test(s)) return today;
  const withYear = /\b\d{4}\b/.test(s) ? s : `${s} ${today.slice(0, 4)}`;
  const d = new Date(`${withYear} 12:00 UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// One answer to one question. Returns { value } or { error }; undefined value means "skipped".
function parseAnswer(q, raw, { today, cfg }) {
  const t = String(raw ?? '').trim();
  if (!t) return { error: 'empty' };
  if (q.choices) {
    if (q.choices === YES_NO || q.field === 'home_based' || q.field.startsWith('home_')) {
      if (isYes(t)) return { value: true };
      if (isNo(t)) return { value: false };
      return { error: 'Please answer yes or no.' };
    }
    const low = t.toLowerCase();
    const hit = q.choices.find(([v, l]) => low === v || low === l.toLowerCase())
      || q.choices.find(([v, l]) => low.includes(l.toLowerCase()) || low.includes(v.replace(/_/g, ' ')));
    if (q.field === 'inside_limits') {
      if (/not sure|unsure|don'?t know|no idea|maybe/i.test(t)) return { value: 'unsure' };
      if (isYes(t) || /inside|within|in (the )?city/i.test(t)) return { value: 'yes' };
      if (isNo(t) || /outside|county/i.test(t)) return { value: 'no' };
    }
    if (q.field === 'kind') {
      if (/renew|already have|existing|again/i.test(t)) return { value: 'renewal' };
      if (/new|first|start|open/i.test(t)) return { value: 'new' };
    }
    if (q.field === 'entity_type' && isSkip(t)) return { value: undefined };
    if (q.field === 'class_key' && !hit) {
      const other = cfg.classes.find((c) => c.fee.type === 'assessed');
      if (/not sure|don'?t know|other/i.test(t) && other) return { value: other.key };
    }
    return hit ? { value: hit[0] } : { error: 'Please pick one of the options.' };
  }
  if (q.field === 'employees') {
    if (/\b(just|only) (me|myself|us)\b|\bmyself\b|^\s*me\s*$/i.test(t)) return { value: 1 };
    if (/\b(none|zero|no employees|no one)\b/i.test(t)) return { value: 0 };
    const n = t.match(/\d+/);
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const w = Object.keys(words).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(t));
    if (n) return { value: Math.min(100000, Number(n[0])) };
    if (w) return { value: words[w] };
    return { error: 'Please give a number of full-time employees, like 1 or 4.' };
  }
  if (q.field === 'phone') {
    const p = t.match(PHONE);
    const e = t.match(EMAIL);
    if (!p && !e) return isSkip(t) ? { value: undefined } : { error: "That doesn't look like a phone number. Please type it like 601-555-0123." };
    return { value: p ? p[0].trim() : undefined, also: e ? { email: e[0] } : {} };
  }
  if (q.field === 'email') {
    if (isSkip(t) || isNo(t)) return { value: undefined };
    const e = t.match(EMAIL);
    return e ? { value: e[0] } : { error: "That doesn't look like an email address. Type it again, or type skip." };
  }
  if (q.field === 'start_date') return isSkip(t) ? { value: undefined } : { value: parseDate(t, today) || t.slice(0, 60) };
  if (q.field === 'license_number') return isSkip(t) ? { value: undefined } : { value: (t.match(/[A-Z]{2,5}-LIC-\d+/i)?.[0] || t).toUpperCase().slice(0, 40) };
  if (['sos_id', 'dor_account', 'state_licenses'].includes(q.field)) return isSkip(t) ? { value: undefined } : { value: isNo(t) ? 'None' : t.slice(0, 300) };
  if (q.field === 'changes') return { value: isNo(t) ? 'No changes' : t.slice(0, 600) };
  if (isSkip(t) && !q.required) return { value: undefined };
  return { value: t.slice(0, q.field === 'description' ? 600 : 200) };
}

const EXTRACT_SYSTEM = `You extract details a resident has given about a city business license application. Reply with one JSON object and nothing else.
Use only these keys, and only for facts the resident clearly stated: kind ("new" or "renewal"), license_number, business_name, description (what the business does), owner_name,
entity_type ("sole_proprietor", "llc", "corporation", "partnership" or "nonprofit"), location (street address), home_based (true or false), employees (integer, full-time),
start_date (YYYY-MM-DD), phone, email. Never guess or fill in anything they didn't say. If nothing applies, reply {}.`;

// Pulls whatever the resident volunteered ("I want to open Sweet Treats, a bakery in my home on Pine St") into the draft.
async function extract(env, message, today) {
  let out = '';
  try {
    for await (const piece of generate(env, EXTRACT_SYSTEM, [{ role: 'user', content: `Today is ${today}.\nResident: ${message}` }])) {
      out += piece;
      if (out.length > 3000) break;
    }
    const m = out.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  } catch (e) {
    console.log('license extract failed', e.message);
    return {};
  }
}

function mergeExtracted(draft, x, qs, ctx) {
  const filled = [];
  for (const q of qs) {
    const v = x[q.field];
    if (v === undefined || v === null || v === '' || draft[q.field] !== undefined) continue;
    const parsed = typeof v === 'boolean' ? { value: v } : parseAnswer(q, String(v), ctx);
    if (!parsed.error && parsed.value !== undefined) { draft[q.field] = parsed.value; filled.push(q.field); }
  }
  return filled;
}

const applies = (q, d) => (!q.when || q.when(d)) && !(q.newOnly && d.kind === 'renewal');
const isRequired = (q, d) => (typeof q.required === 'function' ? q.required(d) : !!q.required);

// The next question, skipping anything answered or skipped already.
function nextQuestion(qs, d) {
  return qs.find((q) => applies(q, d) && d[q.field] === undefined && !(d._skipped || []).includes(q.field)) || null;
}

function review(d, cfg, payNow) {
  const cls = cfg.classes.find((c) => c.key === d.class_key);
  const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');
  const rows = [
    ['Application', d.kind === 'renewal' ? `Renewal${d.license_number ? ` of ${d.license_number}` : ''}` : 'New license'],
    ['Business', d.business_name], ['What it does', d.description], ['License class', cls?.label], ['Owner', d.owner_name],
    ['Set up as', ENTITY_TYPES.find(([k]) => k === d.entity_type)?.[1]], ['Address', d.location],
    ['Inside city limits', { yes: 'Yes', no: 'No', unsure: 'Not sure' }[d.inside_limits]], ['Home-based', yn(d.home_based)],
    ['Full-time employees', d.employees != null ? String(d.employees) : ''], ['Starts', d.start_date],
    ['Secretary of State ID', d.sos_id], ['Revenue account', d.dor_account], ['State licenses', d.state_licenses], ['Changes', d.changes],
    ['Phone', d.phone], ['Email', d.email],
  ];
  if (d.home_based) rows.splice(9, 0, ['At home', [d.home_customers && 'customers visit', d.home_workers && 'non-resident workers', d.home_outside && 'sign or outside storage'].filter(Boolean).join(', ') || 'No customers, outside workers or outside storage']);
  const fee = cls ? annualFee(cls, d.employees) : null;
  return { rows: rows.filter(([, v]) => v), estimate: fee != null ? `${dollars(fee)} a year${cfg.term === 'fiscal' && cfg.prorate ? ', prorated for a partial year' : ''}` : null, payNow };
}

const PUBLIC_DRAFT_KEYS = ['kind', 'license_number', 'business_name', 'description', 'class_key', 'owner_name', 'entity_type', 'location', 'inside_limits', 'home_based',
  'home_customers', 'home_workers', 'home_outside', 'employees', 'start_date', 'sos_id', 'dor_account', 'state_licenses', 'changes', 'phone', 'email', 'dba'];

function cleanDraft(raw) {
  const d = {};
  for (const k of PUBLIC_DRAFT_KEYS) {
    const v = raw?.[k];
    if (v === undefined || v === null || v === '') continue;
    d[k] = typeof v === 'boolean' || typeof v === 'number' ? v : String(v).slice(0, 600);
  }
  if (typeof d.employees === 'string') d.employees = Number.isFinite(Number(d.employees)) ? Number(d.employees) : undefined;
  for (const k of ['home_based', 'home_customers', 'home_workers', 'home_outside']) if (typeof d[k] === 'string') d[k] = d[k] === 'true' || d[k] === 'yes';
  d._skipped = Array.isArray(raw?._skipped) ? raw._skipped.filter((x) => PUBLIC_DRAFT_KEYS.includes(x)) : [];
  return d;
}

// One step of the conversation: { draft, field?, answer?, message? } -> the updated draft and what to ask next.
async function intake(request, env, city, store, limited) {
  const b = await request.json().catch(() => ({}));
  const cfgState = await store.licConfig();
  const cfg = cfgState.config;
  const today = cityToday(city.timezone);
  const qs = questions(city, cfg);
  const d = cleanDraft(b.draft);
  const notes = [];
  const ctx = { today, cfg };
  const start = !b.field && !b.resume;
  let error = null;

  const asked = qs.find((q) => q.field === b.field);
  const answer = clean(b.answer ?? b.message, 1200);
  // Only steps that call the AI count against the rate limit; answering a question doesn't.
  const usesAi = answer && (!asked || (answer.split(/\s+/).length > 7 && !['description', 'changes', 'state_licenses'].includes(asked.field)));
  if (usesAi && await limited()) return fail(429, 'Too many messages. Please wait a minute and try again.');
  if (asked && answer) {
    const p = parseAnswer(asked, answer, ctx);
    if (p.error) error = p.error;
    else {
      if (p.value === undefined) d._skipped.push(asked.field); else d[asked.field] = p.value;
      Object.assign(d, Object.fromEntries(Object.entries(p.also || {}).filter(([k]) => d[k] === undefined)));
    }
    // A long answer often carries more than was asked ("yes, at 12 Pine St, and it's just me").
    if (usesAi) mergeExtracted(d, await extract(env, answer, today), qs, ctx);
  } else if (answer) {
    mergeExtracted(d, await extract(env, answer, today), qs, ctx);
    if (!d.kind && /\brenew/i.test(answer)) d.kind = 'renewal';
    const ref = answer.match(/[A-Z]{2,5}-LIC-\d+/i);
    if (ref && !d.license_number) { d.kind = 'renewal'; d.license_number = ref[0].toUpperCase(); }
  }

  // A renewal with a known license number starts from what the registry already has.
  if (d.kind === 'renewal' && d.license_number && !d._prefilled) {
    const lic = await store.licLicense(d.license_number, today);
    if (lic) {
      for (const [k, v] of Object.entries({ business_name: lic.business_name, dba: lic.dba, class_key: lic.class_key, owner_name: lic.owner_name, location: lic.location,
        home_based: !!lic.home_based, inside_limits: 'yes', phone: lic.phone, email: lic.email })) if (d[k] === undefined && v != null && v !== '') d[k] = v;
      d._prefilled = true;
      notes.push(`I found **${lic.number}** for **${lic.business_name}**, ${lic.status === 'expired' ? `which expired on ${lic.expires_on}` : `valid through ${lic.expires_on}`}. I'll only ask what may have changed.`);
      if (lic.status === 'expired') notes.push(`State law adds a ${cfg.penaltyInitialPct}% late penalty plus ${cfg.penaltyMonthlyPct}% a month after a license expires (Miss. Code Ann. § 27-17-467). City Hall will confirm the amount.`);
      if (lic.status === 'revoked') notes.push('That license was revoked, so City Hall will need to review this renewal before anything else. You can still send it.');
    } else {
      notes.push(`I couldn't find license ${d.license_number} in the registry. That's fine: City Hall will look it up.`);
      d._prefilled = true;
    }
  }

  if (asked?.field === 'inside_limits' && d.inside_limits === 'no') {
    notes.push(`Businesses outside city limits usually get their privilege license from ${city.county || 'the county'} instead of the city (Miss. Code Ann. § 27-17-5). If the business also operates inside ${city.settings.shortName}, you can still send this and City Hall will tell you which applies.`);
  }
  if (asked?.field === 'inside_limits' && d.inside_limits === 'unsure') notes.push('No problem. City Hall will check the address.');
  if (asked?.field === 'home_based' && d.home_based === true) {
    notes.push(cfg.homeRules ? `${city.settings.shortName}'s rules for home-based businesses: ${cfg.homeRules}` : 'City Hall will check the city\'s home business (home occupation) rules for your address. A few quick questions help them do that.');
  }
  if (asked?.field === 'employees' && d.class_key) {
    const fee = annualFee(cfg.classes.find((c) => c.key === d.class_key), d.employees);
    if (fee != null) notes.push(`For that class and ${d.employees} full-time employee${d.employees === 1 ? '' : 's'}, the city's fee schedule shows ${dollars(fee)} a year${cfg.term === 'fiscal' && cfg.prorate ? ', prorated for a partial year' : ''}. City Hall confirms the final amount.`);
  }

  const next = nextQuestion(qs, d);
  const missing = qs.filter((q) => applies(q, d) && isRequired(q, d) && d[q.field] === undefined).map((q) => q.field);
  const s = city.settings;
  const intro = start ? [
    `I can take your business license application and send it to City Hall. City Hall staff review every application and issue the license; I can't approve one.`,
    'Mississippi law requires a city privilege license before a business starts operating inside city limits (Miss. Code Ann. § 27-17-9).',
    termText(cfg),
    cfg.requirements ? `**What you'll need:** ${cfg.requirements}` : '',
    'I\'ll only ask what I still need. You can ask me a question at any point.',
  ].filter(Boolean).join('\n\n') : null;
  // What the applicant pays when they send it: the city's fee schedule for this application, if it sets one.
  let payNow = null;
  if (!next) {
    const lic = d.kind === 'renewal' && d.license_number ? await store.licLicense(d.license_number, today) : null;
    const f = suggestFee(cfg, { ...applicationFromInput({ draft: d }, cfg), created_at: today }, { today, license: lic });
    if (!f.needsAmount && f.total_cents > 0) payNow = { cents: f.total_cents, lines: f.lines, period: f.period };
  }
  return json({
    draft: d, intro, notes, error,
    ask: next ? { field: next.field, text: next.ask, choices: next.choices || null, optional: !isRequired(next, d) } : null,
    ready: !next && !missing.length, missing,
    review: !next ? review(d, cfg, payNow) : null,
    payments: paymentsInfo(env), contact: s.phone,
  });
}

/* ---------------- Applications ---------------- */

const yesNo = (v) => (v === true || v === 1 || ['yes', 'true', '1'].includes(String(v).toLowerCase()) ? 1 : 0);

function applicationFromInput(b, cfg) {
  const d = b.draft ? cleanDraft(b.draft) : b;
  const home = d.home_based ? JSON.stringify({ customers: !!d.home_customers, workers: !!d.home_workers, outside: !!d.home_outside }) : null;
  const employees = Number.isFinite(Number(d.employees)) && d.employees !== '' && d.employees != null ? Math.max(0, Math.floor(Number(d.employees))) : null;
  const classKey = cfg.classes.some((c) => c.key === d.class_key) ? d.class_key : cfg.classes.length === 1 ? cfg.classes[0].key : null;
  const description = [clean(d.description, 600), d.changes && d.changes !== 'No changes' ? `Changes since last license: ${clean(d.changes, 600)}` : null].filter(Boolean).join('\n\n');
  return {
    kind: d.kind === 'renewal' ? 'renewal' : 'new',
    business_name: clean(d.business_name, 200), dba: clean(d.dba, 200), description: description || null, class_key: classKey,
    entity_type: ENTITY_TYPES.some(([k]) => k === d.entity_type) ? d.entity_type : null, owner_name: clean(d.owner_name, 200),
    phone: clean(d.phone, 40), email: clean(d.email, 200)?.toLowerCase() ?? null, mailing_address: clean(d.mailing_address, 300), location: clean(d.location, 300),
    inside_limits: ['yes', 'no', 'unsure'].includes(d.inside_limits) ? d.inside_limits : null, home_based: yesNo(d.home_based), home, employees,
    sos_id: clean(d.sos_id, 80), dor_account: clean(d.dor_account, 80), state_licenses: clean(d.state_licenses, 300),
    start_date: clean(d.start_date, 60), license_number: clean(d.license_number, 40)?.toUpperCase() ?? null,
  };
}

async function submitApplication(request, env, city, store, me, url) {
  const b = await request.json().catch(() => ({}));
  const { config: cfg } = await store.licConfig();
  const a = applicationFromInput(b, cfg);
  const missing = [['business_name', 'the business name'], ['owner_name', "the owner's name"], ['location', 'the business address']].filter(([k]) => !a[k]).map(([, l]) => l);
  if (!a.phone && !a.email) missing.push('a phone number or email');
  if (missing.length) return fail(400, `Please add ${missing.join(', ')}.`);
  const convoId = clean(b.convoId, 20);
  // The chat and the portal say where they are; only the dashboard files counter applications.
  const byStaff = me?.can('licenses.manage') && !convoId && !b.source;
  const actor = byStaff ? me.actor : { type: 'resident', id: null, name: convoId ? `Applicant via ${city.settings.assistantName}` : 'Applicant' };
  const today = cityToday(city.timezone);
  const license = a.license_number ? await store.licLicense(a.license_number, today) : null;
  const { license_number: licenseNumber, ...row } = a;
  if (a.kind === 'renewal' && !license && licenseNumber) row.description = [row.description, `Renewing license number ${licenseNumber} (not found in the registry).`].filter(Boolean).join('\n\n');
  // Paying when sending: the fee comes from the city's schedule, worked out here, never from the browser.
  let payment = null;
  if (b.payment && !byStaff) {
    const f = suggestFee(cfg, { ...row, created_at: today }, { today, license });
    if (f.needsAmount || !f.total_cents) return fail(400, 'City Hall sets the fee for this application during review. Send it without paying, and pay once the fee is set.');
    if (b.expectCents != null && cents(b.expectCents) !== f.total_cents) return fail(409, `The fee is ${dollars(f.total_cents)}. Please check it and try again.`);
    const r = await charge(env, { amountCents: f.total_cents, card: b.payment, description: `${city.settings.cityName} business license for ${row.business_name}` });
    if (!r.ok) return fail(402, r.error);
    payment = { id: r.id, last4: r.last4, brand: r.brand, amount_cents: f.total_cents, fee_cents: f.total_cents, lines: f.lines };
  }
  let created;
  try {
    created = await store.licCreateApplication({
      ...row, license_id: license?.id || null, convo_id: convoId, payment,
      source: byStaff ? 'counter' : convoId ? 'chat' : clean(b.source, 20) === 'portal' ? 'portal' : 'web',
    }, actor, city.settings.requestPrefix);
  } catch (e) {
    if (payment) await refund(env, { id: payment.id, amountCents: payment.amount_cents });
    throw e;
  }
  return json({
    ref: created.ref, status: 'submitted', trackUrl: trackUrl(appOrigin(env, url), city, created.ref),
    paid: payment ? { amount_cents: payment.amount_cents, brand: payment.brand, last4: payment.last4, id: payment.id } : null,
  }, 201);
}

const PUBLIC_STATUS_NOTE = {
  awaiting_payment: (a, s) => `${dollars(a.balance_cents)} is due. Pay online here, or by cash or check at City Hall${s.address ? `, ${s.address}` : ''} with your reference number, ${a.ref}.`,
};

async function track(env, store, city, ref) {
  const today = cityToday(city.timezone);
  const r = await store.licTrack(String(ref).toUpperCase().trim(), today);
  if (!r) return fail(404, 'No business license application with that number');
  const { config: cfg } = await store.licConfig();
  const cls = cfg.classes.find((c) => c.key === r.class_key);
  const s = city.settings;
  return json({
    ...r, class_label: cls?.label || null, status_label: APPLICATION_STATUS[r.status], cityName: s.cityName, cityPhone: s.phone,
    next: r.status === 'awaiting_payment' ? PUBLIC_STATUS_NOTE.awaiting_payment({ ...r }, s)
      : r.status === 'needs_info' ? 'City Hall needs more information. Reply below or call City Hall.'
        : r.status === 'issued' ? 'Download your license below and keep it at your place of business.' : null,
    certificate: r.status === 'issued' && r.license?.status === 'active',
    canPay: r.status === 'awaiting_payment' && r.balance_cents > 0, payments: paymentsInfo(env),
  });
}

/* ---------------- Staff actions ---------------- */

const redactApp = (a, me) => (me.can('residents.contact') ? a : { ...a, phone: a.phone ? 'Hidden' : null, email: a.email ? 'Hidden' : null, mailing_address: a.mailing_address ? 'Hidden' : null });

async function applicationDetail(store, city, id, me) {
  const today = cityToday(city.timezone);
  const a = await store.licApplication(id, today);
  if (!a) return null;
  const { config: cfg } = await store.licConfig();
  const cls = cfg.classes.find((c) => c.key === a.class_key);
  return redactApp({
    ...a, home: a.home ? JSON.parse(a.home) : null, fee_lines: a.fee_lines ? JSON.parse(a.fee_lines) : null, class_label: cls?.label || null,
    suggested: OPEN_STATUSES.includes(a.status) ? suggestFee(cfg, a, { today, license: a.license }) : null,
  }, me);
}

const cents = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const netPaid = (a) => (a.paid_cents || 0) - (a.refunded_cents || 0);

// Refunds part of an online card payment. Returns the fields to save and a timeline note, or null for cash and check.
async function refundCard(env, a, amount) {
  if (a.payment_method !== 'card' && !a.card_last4) return null;
  const r = await refund(env, { id: a.payment_ref, amountCents: amount });
  if (!r.ok) return null;
  return { fields: { refunded_cents: (a.refunded_cents || 0) + amount, refund_ref: r.id }, note: `Refunded ${dollars(amount)} to the card ending ${a.card_last4}.` };
}

// When an application is denied or withdrawn after payment.
async function refundAll(env, a) {
  const paid = netPaid(a);
  if (paid <= 0) return { fields: {}, note: '' };
  return (await refundCard(env, a, paid)) || { fields: {}, note: `${dollars(paid)} was paid by ${a.payment_method}; refund it to the applicant.` };
}

async function act(request, env, city, store, id, me) {
  const b = await request.json().catch(() => ({}));
  const today = cityToday(city.timezone);
  const a = await store.licApplication(id, today);
  if (!a) return fail(404, 'Application not found');
  const { config: cfg } = await store.licConfig();
  const actor = me.actor;
  const open = OPEN_STATUSES.includes(a.status);
  const note = clean(b.note, 1000);
  const s = city.settings;
  const need = (cond, msg) => { if (!cond) throw httpError(400, msg); };

  switch (b.action) {
    case 'review':
      need(['submitted', 'needs_info'].includes(a.status), 'Only new applications, or ones waiting on the applicant, can be moved to review');
      await store.licTransition(a.id, 'in_review', { note: note || 'Review started', isPublic: !note, summary: 'review started' }, actor);
      break;
    case 'request_info': {
      const msg = clean(b.message, 1000);
      need(open && a.status !== 'paid', 'This application is not open for questions');
      need(msg, 'Write what the applicant needs to provide');
      await store.licTransition(a.id, 'needs_info', { note: `City Hall needs more information: ${msg}`, isPublic: true, summary: `asked the applicant for more information: ${msg}` }, actor);
      await noticeToApplicant(env, store, city, { ...a, status: 'needs_info' }, `${s.cityName} needs more information for business license application ${a.ref}: ${msg} Reply at ${trackUrl(appOrigin(env, new URL(request.url)), city, a.ref)} or call ${s.phone}.`, me);
      break;
    }
    case 'assess': {
      need(['submitted', 'in_review', 'needs_info', 'awaiting_payment'].includes(a.status), 'The fee can only be set before payment');
      const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 10).map((l) => ({ label: clean(l.label, 200) || 'Fee', cents: cents(l.cents) }))
        .filter((l) => l.cents != null && l.cents >= 0);
      need(lines.length, 'Enter the fee');
      const total = lines.reduce((x, l) => x + l.cents, 0);
      const paid = netPaid(a);
      const fields = { fee_cents: total, fee_lines: JSON.stringify(lines) };
      let paidNote = '';
      // Overpaid online (the fee came out lower than the schedule estimate): refund the difference to the card.
      if (total < paid) {
        const back = await refundCard(env, a, paid - total);
        if (back) { Object.assign(fields, back.fields); paidNote = ` ${back.note}`; } else paidNote = ` ${dollars(paid - total)} was overpaid; refund it to the applicant.`;
      }
      const status = total <= paid ? 'paid' : 'awaiting_payment';
      const owed = Math.max(0, total - paid);
      await store.licTransition(a.id, status, {
        fields,
        note: `Fee ${paid ? 'confirmed' : 'assessed'}: ${dollars(total)}${lines.length > 1 ? ` (${lines.map((l) => `${l.label} ${dollars(l.cents)}`).join('; ')})` : ''}.`
          + (paid ? ` ${dollars(Math.min(paid, total))} already paid.` : '') + (owed ? ` ${dollars(owed)} is due; pay online or by cash or check at City Hall.` : '') + paidNote,
        isPublic: true, summary: `fee assessed at ${dollars(total)}${owed ? `, ${dollars(owed)} due` : ', paid in full'}`,
      }, actor);
      if (owed) await noticeToApplicant(env, store, city, { ...a, status }, `The fee for ${s.shortName} business license application ${a.ref} is ${dollars(total)}; ${dollars(owed)} is due. Pay at ${trackUrl(appOrigin(env, new URL(request.url)), city, a.ref)} or at City Hall${s.address ? `, ${s.address}` : ''}.`, me);
      break;
    }
    case 'payment': {
      need(a.status === 'awaiting_payment', 'Assess the fee before recording payment');
      const method = ['cash', 'check'].includes(b.method) ? b.method : null;
      const amount = cents(b.amount_cents);
      need(method, 'Choose cash or check');
      const due = a.fee_cents - netPaid(a);
      need(amount === due, `The payment must match the ${dollars(due)} due. Reassess the fee if it should change.`);
      need(method !== 'check' || clean(b.check_number, 40), 'Enter the check number');
      const receipt = clean(b.receipt_no, 40);
      await store.licTransition(a.id, 'paid', {
        fields: { paid_cents: (a.paid_cents || 0) + amount, payment_method: method, payment_ref: method === 'check' ? clean(b.check_number, 40) : null, receipt_no: receipt, paid_at: new Date().toISOString() },
        note: `Payment of ${dollars(amount)} received by ${method}${method === 'check' ? ` #${clean(b.check_number, 40)}` : ''}${receipt ? `, receipt ${receipt}` : ''}.`,
        isPublic: true, summary: `recorded ${dollars(amount)} paid by ${method}`,
      }, actor);
      break;
    }
    case 'issue': {
      need(a.status === 'paid' || (a.status === 'awaiting_payment' && a.fee_cents <= netPaid(a)), 'Record payment before issuing the license');
      need(!(a.license && a.license.revoked_at) || b.confirm, 'This renews a revoked license. Reinstate it first, or confirm to renew anyway.');
      const cls = cfg.classes.find((c) => c.key === a.class_key);
      const period = licensePeriod(cfg, { today, renewingExpires: a.kind === 'renewal' && a.license ? a.license.expires_on : null });
      const license = await store.licIssue(a.id, { period, classLabel: cls?.label || null, note }, actor, s.requestPrefix);
      if (a.license?.revoked_at && b.confirm) await store.licSetRevoked(license.id, false, `Renewed with application ${a.ref}`, actor);
      await noticeToApplicant(env, store, city, { ...a, status: 'issued' }, `${s.cityName} issued business license ${license.number} to ${a.business_name}, valid through ${period.end}. Download it at ${trackUrl(appOrigin(env, new URL(request.url)), city, a.ref)}.`, me);
      break;
    }
    case 'deny': {
      const reason = clean(b.reason, 1000);
      need(open, 'Only open applications can be denied');
      need(reason, 'Give the reason. The applicant sees it.');
      const back = await refundAll(env, a);
      await store.licTransition(a.id, 'denied', { fields: { decision_reason: reason, decided_at: new Date().toISOString(), ...back.fields }, note: `Not approved: ${reason}${back.note ? ` ${back.note}` : ''}`, isPublic: true, summary: `denied: ${reason}` }, actor);
      await noticeToApplicant(env, store, city, { ...a, status: 'denied' }, `${s.cityName} did not approve business license application ${a.ref}: ${reason} Questions? Call ${s.phone}.`, me);
      break;
    }
    case 'withdraw': {
      need(open, 'Only open applications can be withdrawn');
      const back = await refundAll(env, a);
      await store.licTransition(a.id, 'withdrawn', { fields: { decided_at: new Date().toISOString(), ...back.fields }, note: `${note ? `Withdrawn: ${note}` : 'Withdrawn at the applicant\'s request'}${back.note ? ` ${back.note}` : ''}`, isPublic: true, summary: 'withdrawn' }, actor);
      break;
    }
    case 'note':
      need(note, 'Write a note');
      await store.licTransition(a.id, a.status, { note, summary: 'staff note added' }, actor);
      break;
    case 'edit': {
      need(open && a.status !== 'paid', 'Details can only be corrected before payment');
      const input = applicationFromInput({ ...a, home_customers: undefined, ...b.fields }, cfg);
      const patch = Object.fromEntries(Object.entries(input).filter(([k]) => APP_FIELDS.includes(k) && b.fields && k in b.fields));
      if ('class_key' in (b.fields || {}) && !cfg.classes.some((c) => c.key === b.fields.class_key)) need(false, 'Unknown license class');
      await store.licEditApplication(a.id, patch, actor);
      break;
    }
    default:
      return fail(400, 'Unknown action');
  }
  return json({ application: await applicationDetail(store, city, a.id, me) });
}

/* ---------------- Registry ---------------- */

const redactLicense = (l, me) => (me.can('residents.contact') ? l : { ...l, phone: l.phone ? 'Hidden' : null, email: l.email ? 'Hidden' : null });

async function importLicense(request, city, store, me) {
  const b = await request.json().catch(() => ({}));
  const { config: cfg } = await store.licConfig();
  const cls = cfg.classes.find((c) => c.key === b.class_key);
  const l = {
    number: clean(b.number, 40)?.toUpperCase() ?? null, business_name: clean(b.business_name, 200), dba: clean(b.dba, 200), class_key: cls?.key ?? null,
    class_label: cls?.label ?? clean(b.class_label, 80), owner_name: clean(b.owner_name, 200), phone: clean(b.phone, 40), email: clean(b.email, 200)?.toLowerCase() ?? null,
    location: clean(b.location, 300), home_based: yesNo(b.home_based), issued_on: clean(b.issued_on, 10), expires_on: clean(b.expires_on, 10), fee_cents: cents(b.fee_cents),
  };
  if (!l.business_name) return fail(400, 'Enter the business name');
  if (!isDate(l.issued_on) || !isDate(l.expires_on) || l.expires_on < l.issued_on) return fail(400, 'Enter the issued and expiration dates as YYYY-MM-DD');
  try {
    const r = await store.licImport(l, me.actor, city.settings.requestPrefix);
    return json({ license: redactLicense(await store.licLicense(r.id, cityToday(city.timezone)), me) }, 201);
  } catch (e) {
    return fail(409, e.message);
  }
}

// A renewal taken at the counter, prefilled from the license.
async function counterRenewal(city, store, id, me) {
  const today = cityToday(city.timezone);
  const l = await store.licLicense(id, today);
  if (!l) return fail(404, 'License not found');
  const open = l.applications.find((x) => OPEN_STATUSES.includes(x.status));
  if (open) return fail(409, `${open.ref} is already open for this license`);
  const prev = l.application_id ? await store.licApplicationRow(l.application_id) : null;
  const pick = (k) => prev?.[k] ?? null;
  const created = await store.licCreateApplication({
    kind: 'renewal', license_id: l.id, business_name: l.business_name, dba: l.dba, class_key: l.class_key, owner_name: l.owner_name, phone: l.phone, email: l.email,
    location: l.location, home_based: l.home_based, home: pick('home'), description: pick('description'), entity_type: pick('entity_type'), inside_limits: pick('inside_limits') || 'yes',
    employees: pick('employees'), sos_id: pick('sos_id'), dor_account: pick('dor_account'), state_licenses: pick('state_licenses'), source: 'counter',
  }, me.actor, city.settings.requestPrefix);
  return json({ ref: created.ref, id: created.id }, 201);
}

/* ---------------- Certificate ---------------- */

// Standard PDF fonts only cover Windows-1252; anything else becomes "?".
const pdfText = (s) => String(s ?? '').replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, '?');
const longDate = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export async function certificatePdf(city, license, cfg, { issuedBy, origin }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${city.settings.cityName} privilege license ${license.number}`);
  doc.setAuthor(city.settings.cityName);
  doc.setCreator('City Hall OS');
  const page = doc.addPage([792, 612]); // letter, landscape
  const [serif, serifBold, sans, sansBold] = await Promise.all([StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.Helvetica, StandardFonts.HelveticaBold].map((f) => doc.embedFont(f)));
  const hex = /^#([0-9a-f]{6})$/i.test(city.settings.brandColor || '') ? city.settings.brandColor.slice(1) : '1f5c46';
  const brand = rgb(...[0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));
  const ink = rgb(0.05, 0.08, 0.14);
  const muted = rgb(0.37, 0.4, 0.47);
  const W = 792;
  const center = (t, y, font, size, color = ink) => {
    const s = pdfText(t);
    page.drawText(s, { x: (W - font.widthOfTextAtSize(s, size)) / 2, y, size, font, color });
  };
  const fit = (t, font, max, size) => { let z = size; while (z > 10 && font.widthOfTextAtSize(pdfText(t), z) > max) z -= 1; return z; };

  page.drawRectangle({ x: 24, y: 24, width: W - 48, height: 564, borderColor: brand, borderWidth: 3 });
  page.drawRectangle({ x: 34, y: 34, width: W - 68, height: 544, borderColor: brand, borderWidth: 0.8 });
  center(`${city.settings.cityName}, ${city.settings.state}`.toUpperCase(), 536, sansBold, 13, brand);
  center('Privilege License', 494, serifBold, 38);
  center(`License No. ${license.number}`, 466, sans, 13, muted);
  center('This certifies that', 424, serif, 14, muted);
  center(license.business_name, 388, serifBold, fit(license.business_name, serifBold, W - 140, 30));
  if (license.dba) center(`doing business as ${license.dba}`, 366, serif, 13, muted);
  center('has paid the privilege tax and is licensed to do business at', 340, serif, 14, muted);
  center(license.location || '', 314, sansBold, fit(license.location || '', sansBold, W - 140, 16));

  const rows = [
    ['Owner', license.owner_name || ''], ['License class', license.class_label || 'Business'],
    ['Valid from', longDate(license.issued_on)], ['Expires', longDate(license.expires_on)],
    ['Privilege tax paid', license.fee_cents != null ? dollars(license.fee_cents) : ''], ['Issued', `${longDate(license.issued_on)}${issuedBy ? ` by ${issuedBy}` : ''}`],
  ];
  rows.forEach(([k, v], i) => {
    const x = i % 2 === 0 ? 96 : 420;
    const y = 262 - Math.floor(i / 2) * 34;
    page.drawText(pdfText(k.toUpperCase()), { x, y: y + 14, size: 8.5, font: sansBold, color: muted });
    page.drawText(pdfText(v), { x, y, size: fit(v, sans, 290, 12.5), font: sans, color: ink });
  });

  page.drawLine({ start: { x: 460, y: 112 }, end: { x: 700, y: 112 }, thickness: 0.8, color: ink });
  page.drawText(pdfText([cfg.officerName, cfg.officerTitle].filter(Boolean).join(', ')), { x: 460, y: 98, size: 10.5, font: sans, color: ink });
  page.drawText('Countersigned by the officer collecting the tax', { x: 460, y: 85, size: 8.5, font: sans, color: muted });
  const note = pdfText(cfg.certificateNote);
  const words = note.split(' ');
  let line = '';
  let y = 110;
  for (const w of words) {
    if (sans.widthOfTextAtSize(`${line} ${w}`, 9) > 330) { page.drawText(line.trim(), { x: 92, y, size: 9, font: sans, color: muted }); y -= 12; line = ''; }
    line += ` ${w}`;
  }
  if (line.trim()) page.drawText(line.trim(), { x: 92, y, size: 9, font: sans, color: muted });
  page.drawText(pdfText(`Renew before ${longDate(license.expires_on)}. Check this license at ${origin.replace(/^https?:\/\//, '')}/licenses.html?city=${city.slug}`), { x: 92, y: 56, size: 8, font: sans, color: muted });
  return doc.save();
}

async function certificateResponse(env, url, city, store, license, filenameRef) {
  const { config: cfg } = await store.licConfig();
  const app = license.application_id ? await store.licApplication(license.application_id, cityToday(city.timezone)) : null;
  const issuedBy = app?.history?.slice().reverse().find((h) => h.status === 'issued' && h.actor_type !== 'system')?.by || null;
  const bytes = await certificatePdf(city, license, cfg, { issuedBy, origin: appOrigin(env, url) });
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filenameRef}.pdf"`, 'Cache-Control': 'private, no-store', ...CORS },
  });
}

/* ---------------- Renewal notices (§ 27-17-465) ---------------- */

// Sends the renewal notices due today in one city. Run daily by the cron trigger, or by staff from the registry.
export async function runNotices(env, city, store, { today = cityToday(city.timezone), origin } = {}) {
  const { renew, lapsed } = await store.licNoticesDue(today);
  const s = city.settings;
  const system = { type: 'system', name: 'Renewal notices' };
  const link = `${origin || appOrigin(env)}/${city.slug}`;
  const out = { today, renewal: 0, lapsed: 0, sent: 0, notSent: 0 };
  for (const [kind, rows] of [['renewal', renew], ['lapsed', lapsed]]) {
    for (const l of rows) {
      const msg = kind === 'renewal'
        ? `${s.cityName}: business license ${l.number} for ${l.business_name} expires ${longDate(l.expires_on)}. Renew at ${link} (say "renew ${l.number}") or at City Hall. Late renewals owe a penalty under Miss. Code Ann. § 27-17-467.`
        : `${s.cityName}: business license ${l.number} for ${l.business_name} expired ${longDate(l.expires_on)}. Please renew at ${link} or at City Hall${s.phone ? ` (${s.phone})` : ''}. A late penalty applies.`;
      const to = { name: l.owner_name, email: l.email, phone: l.phone };
      const r = !l.email && !l.phone ? { sent: false, reason: 'no phone or email on file' } : await sendNotice(env, store, city, { entityType: 'license', entityId: l.number, to, msg });
      await store.licMarkNotice(l.id, kind, r.sent ? 'sent' : `not sent: ${r.reason}`, system);
      out[kind] += 1;
      out[r.sent ? 'sent' : 'notSent'] += 1;
    }
  }
  return out;
}

/* ---------------- Routes ---------------- */

// Public routes. Returns null when the path isn't one of them.
export async function publicLicensing({ request, env, city, store, me, url, path, m }) {
  const [a, b, c] = path;
  const limited = async () => {
    if (!env.CHAT_LIMIT || me) return false;
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    return !(await env.CHAT_LIMIT.limit({ key: `${city.id}:licenses:${ip}` })).success;
  };
  if (a === 'info' && m === 'GET') return json(publicInfo(city, await store.licConfig()), 200, { 'Cache-Control': 'public, max-age=60' });
  if (a === 'intake' && m === 'POST') return intake(request, env, city, store, limited);
  if (a === 'applications' && !b && m === 'POST') {
    if (await limited()) return fail(429, 'Too many submissions. Please wait a minute and try again.');
    return submitApplication(request, env, city, store, me, url);
  }
  if (a === 'track' && b && !c && m === 'GET') return track(env, store, city, b);
  if (a === 'track' && b && c === 'reply' && m === 'POST') {
    if (await limited()) return fail(429, 'Too many messages. Please wait a minute and try again.');
    const body = await request.json().catch(() => ({}));
    const message = clean(body.message, 1500);
    if (!message) return fail(400, 'Write your reply');
    const r = await store.licReply(String(b).toUpperCase(), message, { type: 'resident', id: null, name: 'Applicant' });
    if (!r) return fail(404, 'No business license application with that number');
    return r.error ? fail(400, r.error) : json(r);
  }
  if (a === 'track' && b && c === 'pay' && m === 'POST') {
    if (await limited()) return fail(429, 'Too many attempts. Please wait a minute and try again.');
    const body = await request.json().catch(() => ({}));
    const app = await store.licApplicationRow(String(b).toUpperCase());
    if (!app) return fail(404, 'No business license application with that number');
    const due = (app.fee_cents || 0) - netPaid(app);
    if (app.status !== 'awaiting_payment' || due <= 0) return fail(400, 'Nothing is due on this application right now.');
    if (body.expectCents != null && cents(body.expectCents) !== due) return fail(409, `The amount due is ${dollars(due)}. Please check it and try again.`);
    const r = await charge(env, { amountCents: due, card: body.card, description: `${city.settings.cityName} business license ${app.ref}` });
    if (!r.ok) return fail(402, r.error);
    await store.licTransition(app.id, 'paid', {
      fields: { paid_cents: (app.paid_cents || 0) + due, payment_method: 'card', payment_ref: r.id, card_last4: r.last4, paid_at: new Date().toISOString() },
      note: `Paid ${dollars(due)} online by ${r.brand} ending ${r.last4} (payment ${r.id}).`, isPublic: true, summary: `applicant paid ${dollars(due)} online`,
    }, { type: 'resident', id: null, name: 'Applicant' });
    return json({ ok: true, paid: { amount_cents: due, brand: r.brand, last4: r.last4, id: r.id } });
  }
  if (a === 'track' && b && c === 'certificate' && m === 'GET') {
    const today = cityToday(city.timezone);
    const app = await store.licApplicationRow(String(b).toUpperCase());
    const license = app?.status === 'issued' && app.license_id ? await store.licLicense(app.license_id, today) : null;
    if (!license || license.status !== 'active' || license.application_id !== app.id) return fail(404, 'No current license for that application');
    return certificateResponse(env, url, city, store, license, license.number);
  }
  if (a === 'lookup' && m === 'GET') {
    const q = clean(url.searchParams.get('q'), 80) || '';
    if (q.length < 2) return fail(400, 'Type at least 2 letters of the business name');
    const rows = await store.licLookup(q, cityToday(city.timezone));
    // Home-based businesses are listed without their home address.
    return json({ results: rows.map(({ home_based: home, location, ...r }) => ({ ...r, location: home ? `Home-based business in ${city.settings.shortName}` : location })) },
      200, { 'Cache-Control': 'public, max-age=60' });
  }
  return null;
}

// Staff routes. `need` throws 403 without the permission.
export async function staffLicensing({ request, env, city, store, me, need, url, path, m }) {
  const [a, b, c] = path;
  need('licenses.view');
  const { config: cfg, configured, updated_by: updatedBy, updated_at: updatedAt } = await store.licConfig();
  // Department staff work licenses only if they are in the licensing department (City Hall unless the city says otherwise).
  if (me.departmentId && me.departmentId !== cfg.departmentId) throw httpError(403, 'Business licenses are handled by another department');
  const today = cityToday(city.timezone);

  if (a === 'summary' && m === 'GET') return json({ ...(await store.licSummary(today)), configured, today });
  if (a === 'settings' && m === 'GET') {
    return json({ config: cfg, configured, updated_by: updatedBy, updated_at: updatedAt, stateSchedule: STATE_SCHEDULE, departments: await store.departments(), canEdit: me.can('licenses.settings') });
  }
  if (a === 'settings' && m === 'PUT') {
    need('licenses.settings');
    const body = await request.json().catch(() => ({}));
    if (body.departmentId && !(await store.departments()).some((d) => d.id === body.departmentId)) return fail(400, 'Unknown department');
    const saved = await store.licSaveConfig({ ...cfg, ...body }, me.actor);
    return json({ ...saved, stateSchedule: STATE_SCHEDULE });
  }
  if (a === 'applications') {
    if (!b && m === 'GET') {
      const rows = await store.licApplications({ status: clean(url.searchParams.get('status'), 20), q: clean(url.searchParams.get('q'), 80) });
      const label = new Map(cfg.classes.map((k) => [k.key, k.label]));
      return json({ applications: rows.map((r) => ({ ...r, class_label: label.get(r.class_key) || null })) });
    }
    if (b && !c && m === 'GET') {
      const detail = await applicationDetail(store, city, b, me);
      return detail ? json({ application: detail }) : fail(404, 'Application not found');
    }
    if (b && !c && m === 'PATCH') { need('licenses.manage'); return act(request, env, city, store, b, me); }
  }
  if (a === 'registry') {
    if (!b && m === 'GET') {
      const rows = await store.licRegistry({ status: clean(url.searchParams.get('status'), 20), q: clean(url.searchParams.get('q'), 80), today });
      return json({ licenses: rows.map((l) => redactLicense(l, me)), today });
    }
    if (!b && m === 'POST') { need('licenses.manage'); return importLicense(request, city, store, me); }
    if (b && !c && m === 'GET') {
      const l = await store.licLicense(b, today);
      return l ? json({ license: redactLicense(l, me) }) : fail(404, 'License not found');
    }
    if (b && !c && m === 'PATCH') {
      need('licenses.manage');
      const body = await request.json().catch(() => ({}));
      const l = await store.licLicense(b, today);
      if (!l) return fail(404, 'License not found');
      const reason = clean(body.reason, 500);
      if (body.action === 'revoke') {
        if (l.revoked_at) return fail(400, 'This license is already revoked');
        if (!reason) return fail(400, 'Give the reason for revoking it');
        await store.licSetRevoked(l.id, true, reason, me.actor);
      } else if (body.action === 'reinstate') {
        if (!l.revoked_at) return fail(400, 'This license is not revoked');
        await store.licSetRevoked(l.id, false, reason, me.actor);
      } else {
        return fail(400, 'Unknown action');
      }
      return json({ license: redactLicense(await store.licLicense(l.id, today), me) });
    }
    if (b && c === 'renew' && m === 'POST') { need('licenses.manage'); return counterRenewal(city, store, b, me); }
    if (b && c === 'certificate' && m === 'GET') {
      const l = await store.licLicense(b, today);
      return l ? certificateResponse(env, url, city, store, l, l.number) : fail(404, 'License not found');
    }
  }
  if (a === 'notices' && m === 'POST') {
    need('licenses.manage');
    const body = await request.json().catch(() => ({}));
    // Support can run the notices as of another date, to check what will go out.
    const asOf = me.operator && isDate(body.asOf) ? body.asOf : today;
    return json(await runNotices(env, city, store, { today: asOf, origin: url.origin }));
  }
  return fail(404, 'Not found');
}

// The daily cron: renewal notices in every active city.
export async function licensingDaily(env, cities) {
  for (const { city, store } of cities) {
    try {
      const r = await runNotices(env, city, store);
      if (r.renewal || r.lapsed) console.log('license notices', city.slug, JSON.stringify(r));
    } catch (e) {
      console.log('license notices failed', city.slug, e.stack || e.message);
    }
  }
}

