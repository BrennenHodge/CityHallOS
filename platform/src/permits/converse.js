// Turns a resident's chat message into application answers. Simple answers (a choice, yes or no, a phone
// number, an amount) are parsed by rules; free-form ones ("a 24 by 30 detached garage behind my house")
// also go to the AI, which may only fill fields the resident actually stated.
import { completeJson } from '../assistant.js';
import { FIELDS, SECTIONS, coerce, splitAddress } from './construction.js';

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const num = (s) => Number(String(s).replace(/,/g, ''));
const STREET = /^\d+\s+[\w .'-]*\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|hwy|highway|ct|court|cir|circle|way|pl|place|pkwy|trl|trail)\b/i;

function money(text) {
  const m = String(text).match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/i);
  if (!m) return undefined;
  const mult = /^(k|thousand)$/i.test(m[2] || '') ? 1000 : /^(m|million)$/i.test(m[2] || '') ? 1e6 : 1;
  return num(m[1]) * mult;
}

function dims(text) {
  const out = {};
  const wl = text.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)/i);
  if (wl) { out.width = num(wl[1]); out.length = num(wl[2]); }
  const st = text.match(/(\d+|one|two|three)[\s-]*(?:story|stories|storey|floors?)\b/i);
  if (st) out.stories = { one: 1, two: 2, three: 3 }[st[1].toLowerCase()] || num(st[1]);
  else if (/\bsingle[\s-]story\b/i.test(text)) out.stories = 1;
  const h = text.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)?\s*(?:tall|high)\b|\bheight\D{0,12}(\d+(?:\.\d+)?)/i);
  if (h) out.height = num(h[1] || h[2]);
  return out;
}

// Keyword reading of a project description. The AI does this better; this keeps working without it.
function describe(text) {
  const t = text.toLowerCase();
  const out = { description: text.trim(), ...dims(text) };
  if (/\b(tear down|demolish|demolition|demo)\b/.test(t)) out.construction_type = 'demolition';
  else if (/\b(add(ing)? (a |an )?(room|addition|on)|addition|extend|expand)\b/.test(t)) out.construction_type = 'addition';
  else if (/\b(remodel|renovat|alter|repair|replace|convert|finish)\w*/.test(t)) out.construction_type = 'remodel';
  else if (/\b(build|new|construct|put up|install|erect)\w*/.test(t)) out.construction_type = 'new';
  if (/\b(garage|carport)\b/.test(t)) out.occupancy = 'garage';
  else if (/\b(shed|storage|barn|workshop)\b/.test(t)) out.occupancy = 'storage';
  else if (/\b(duplex|apartment|triplex|fourplex|multi-?family)\b/.test(t)) out.occupancy = 'multi_family';
  else if (/\b(store|office|restaurant|shop|business|commercial|warehouse|church)\b/.test(t)) out.occupancy = 'commercial';
  else if (/\b(house|home|residence|bedroom|bathroom|kitchen|porch|deck)\b/.test(t)) out.occupancy = 'single_family';
  if (/\b(detached|accessory|shed|carport)\b/.test(t)) out.planned_work = ['accessory'];
  return out;
}

// Rule-based reading of an answer to one question. Returns { field: value } with raw values.
export function quickParse(ask, text) {
  const t = text.trim();
  const low = t.toLowerCase();
  const pick = (choices) => {
    const c = choices.find(([v, l]) => low === v.toLowerCase() || low === l.toLowerCase())
      || choices.find(([v, l]) => low.includes(l.toLowerCase()) || l.toLowerCase().includes(low) && low.length > 2)
      || (/^(y|yes|yeah|yep|sure|correct|i am|i do|it is|same)\b/.test(low) && choices.find(([v]) => v === 'yes'))
      || (/^(n|no|nope|not|different)\b/.test(low) && choices.find(([v]) => v === 'no'));
    return c?.[0];
  };
  switch (ask.id) {
    case 'project': return describe(t);
    case 'job_address': return { job_address: t };
    case 'parcel_number':
      // A corrected street address, typed right after the address match was shown.
      if (STREET.test(t)) return { job_address: t };
      return /\b(don'?t know|not sure|no idea|unknown|skip)\b/i.test(t) ? {} : { parcel_number: t.replace(/^(parcel|#|number|is|:|\s)+/i, '') };
    case 'owner_name': return { owner_name: t.replace(/^(my name is|it'?s|i'?m|name:?)\s+/i, '').replace(/[.]$/, '') };
    case 'owner_mailing': {
      const p = splitAddress(t);
      return p ? { owner_address: p.street, owner_city: p.city, owner_state: p.state, owner_zip: p.zip } : {};
    }
    case 'owner_contact': case 'contractor_contact': case 'applicant': {
      const pre = { owner_contact: 'owner', contractor_contact: 'contractor', applicant: 'applicant' }[ask.id];
      const out = {};
      const e = t.match(EMAIL); if (e) out[`${pre}_email`] = e[0];
      const phones = t.match(PHONE) || [];
      if (phones[0]) out[`${pre}_phone`] = phones[0];
      if (phones[1] && pre !== 'applicant') out[`${pre}_cell`] = phones[1];
      if (pre === 'applicant') { const n = t.replace(EMAIL, '').replace(PHONE, '').replace(/[,;]|\band\b/g, ' ').trim(); if (n) out.applicant_name = n.replace(/\s+/g, ' '); }
      if (pre === 'contractor') { const p = splitAddress(t.replace(EMAIL, '').replace(PHONE, '').replace(/^[\s,;]+|[\s,;]+$/g, '')); if (p) Object.assign(out, { contractor_address: p.street, contractor_city: p.city, contractor_state: p.state, contractor_zip: p.zip }); }
      return out;
    }
    case 'contractor': {
      const cor = t.match(/\b(?:cor|certificate)[^\d]{0,20}(\d[\w-]{2,})/i) || t.match(/#\s*(\d[\w-]{2,})/);
      const name = t.replace(cor?.[0] || '', '').replace(/[,;.]+\s*$|\b(and|with)\s*$/i, '').trim();
      return { contractor_name: name || undefined, contractor_cor: cor?.[1] };
    }
    case 'size': return dims(t);
    case 'area': { const n = /\b(none|no|zero)\b/i.test(t) ? 0 : t.match(/\d[\d,]*/) ? num(t.match(/\d[\d,]*/)[0]) : undefined; return n === undefined ? {} : { area_heated: n }; }
    case 'setbacks': {
      const out = {};
      for (const k of ['front', 'side', 'rear']) { const m = t.match(new RegExp(`${k}\\D{0,12}(\\d+(?:\\.\\d+)?)|(\\d+(?:\\.\\d+)?)\\s*(?:'|ft|feet)?\\s*(?:from the |on the |to the )?${k}`, 'i')); if (m) out[`setback_${k}`] = num(m[1] || m[2]); }
      if (!Object.keys(out).length) { const n = t.match(/\d+(?:\.\d+)?/g) || []; if (n.length >= 3) Object.assign(out, { setback_front: num(n[0]), setback_side: num(n[1]), setback_rear: num(n[2]) }); }
      return out;
    }
    case 'design_detail': return { dp_firm: t };
    case 'valuation': { const v = money(t); return v ? { valuation: v } : {}; }
    case 'sign': return /^(i agree|yes|ok|okay)$/i.test(t) ? {} : { signature_name: t.replace(/^(\/s\/|signed:?)\s*/i, ''), certify: true };
    case 'owner_ack': { const c = pick(ask.choices); return c === 'yes' ? { owner_ack: true } : c === 'no' ? { builder: 'contractor', owner_ack: null, owner_exemption: null } : {}; }
    case 'hazmat_ack': return pick([['yes', 'Yes, I agree'], ['no', 'No']]) === 'yes' ? { hazmat_ack: true } : {};
    default:
      if (ask.choices) {
        const c = pick(ask.choices);
        if (c && !c.startsWith('__')) return { [ask.fields[0]]: FIELDS[ask.fields[0]].type === 'bool' ? c === 'yes' : c };
      }
      return {};
  }
}

// Asks whose answers are free-form enough to send to the AI as well.
const AI_ASKS = new Set(['project', 'applicant', 'owner_mailing', 'contractor', 'contractor_contact', 'size', 'setbacks', 'design_detail', 'owner_contact']);

function fieldList() {
  return SECTIONS.flatMap((s) => s.fields).filter((x) => !['files', 'signature', 'check'].includes(x.type))
    .map((x) => `- ${x.key} (${x.type}${x.options ? `: ${x.options.map(([v]) => v).join(' | ')}` : ''}): ${x.label}`).join('\n');
}

const SYSTEM = `You help residents fill out a city construction permit application by reading their chat messages.
Return JSON only: {"updates": {field_key: value}, "reply": "..."}.
Rules:
- Only include fields the resident clearly stated in THIS message. Never guess, never fill a field from general assumptions.
- Use the exact option values listed for select fields. planned_work is an array of option values.
- Numbers are plain numbers in feet, square feet or dollars (no units).
- "description" should be the resident's project description in their own words, cleaned up into one or two sentences.
- reply: one short, warm sentence acknowledging what you understood. If the resident asked a question, answer it briefly and plainly in general terms; say City Hall confirms anything specific to their property. Never say a permit is approved or a project is allowed. Do not ask the next question; the app does that.`;

export async function aiParse(env, ask, text, data) {
  const current = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && v !== ''));
  const user = `Fields:\n${fieldList()}\n\nAlready answered: ${JSON.stringify(current)}\n\nQuestion the app asked: ${typeof ask?.prompt === 'string' ? ask.prompt : ask?.id || 'none'}\nResident's message: ${text}`;
  const out = await completeJson(env, SYSTEM, user);
  const updates = out && typeof out.updates === 'object' ? out.updates : {};
  return { updates, reply: typeof out?.reply === 'string' ? out.reply.slice(0, 600) : null };
}

// Reads one message into clean updates. Rules first; the AI fills what the rules missed.
export async function readMessage(env, ask, text, data) {
  const raw = ask ? quickParse(ask, text) : {};
  let reply = null;
  const looksLikeQuestion = /\?\s*$/.test(text) || /^(what|why|how|do i|does|can i|is it|which)\b/i.test(text.trim());
  const needAi = !ask || AI_ASKS.has(ask.id) || looksLikeQuestion || !Object.values(raw).some((v) => v !== undefined);
  if (needAi && text.length > 1) {
    try {
      const ai = await aiParse(env, ask, text, data);
      reply = ai.reply;
      for (const [k, v] of Object.entries(ai.updates)) if (raw[k] === undefined && FIELDS[k]) raw[k] = v;
    } catch (e) {
      console.log('permit ai parse failed', e.message);
    }
  }
  // A question isn't an answer: don't let "what's a setback?" become the setbacks.
  if (looksLikeQuestion && ask && !['project'].includes(ask.id)) for (const k of ask.fields) if (typeof raw[k] === 'string' && raw[k] === text.trim()) delete raw[k];
  // One number given once fills one field, even if the rules and the AI each placed it.
  const digits = (x) => String(x || '').replace(/\D/g, '').slice(-10);
  for (const pre of ['owner', 'contractor']) {
    const phone = raw[`${pre}_phone`] ?? data[`${pre}_phone`];
    if (raw[`${pre}_cell`] && phone && digits(raw[`${pre}_cell`]) === digits(phone)) delete raw[`${pre}_cell`];
  }
  const updates = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (k === 'builder' || k === 'owner_ack' || k === 'owner_exemption') { updates[k] = v === null ? null : coerce(k, v) ?? v; continue; }
    const c = coerce(k, v);
    if (c !== undefined) updates[k] = c;
  }
  return { updates, reply, question: looksLikeQuestion };
}

