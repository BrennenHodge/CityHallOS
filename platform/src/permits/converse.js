// Turns a resident's chat message into application answers, for any form. Simple answers (a choice, yes or no, a
// phone number, an amount, an address) are read by rules from the field types; free-form ones ("a 24 by 30 detached
// garage behind my house") also go to the AI, which may only fill fields the resident actually stated.
//
// Residents also ask questions mid-application ("what's a setback?", "where do I find my parcel number?"). Those
// are answered from the field's own explanation and the city's documents, and the app then repeats the question.
import { completeJson } from '../assistant.js';
import { splitAddress } from './engine.js';

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const STREET = /^\d+\s+[\w .'-]*\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|hwy|highway|ct|court|cir|circle|way|pl|place|pkwy|trl|trail)\b/i;
const num = (s) => Number(String(s).replace(/,/g, ''));
const SKIP = /\b(don'?t know|not sure|no idea|unknown|skip|n\/a|none)\b/i;

export const looksLikeQuestion = (text) => /\?\s*$/.test(text) || /^(what|why|how|where|who|when|do i|does|can i|should i|is it|is there|which|explain|help|i don'?t understand)\b/i.test(text.trim());

export function money(text) {
  const m = String(text).match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?\b/i);
  if (!m) return undefined;
  const mult = /^(k|thousand)$/i.test(m[2] || '') ? 1000 : /^(m|million)$/i.test(m[2] || '') ? 1e6 : 1;
  return num(m[1]) * mult;
}

function pickChoice(choices, text) {
  const low = text.trim().toLowerCase();
  const c = choices.find(([v, l]) => low === v.toLowerCase() || low === l.toLowerCase())
    || choices.find(([, l]) => low.includes(l.toLowerCase()) || (l.toLowerCase().includes(low) && low.length > 2))
    || (/^(y|yes|yeah|yep|sure|correct|i am|i do|it is|same|ok|okay|all of them|they are|i agree|i accept)\b/.test(low) && choices.find(([v]) => ['yes', 'true'].includes(v)))
    || (/^(n|no|nope|not|different)\b/.test(low) && choices.find(([v]) => ['no', 'false'].includes(v)));
  return c?.[0];
}

// One field from one answer, by its type.
function readField(fd, text) {
  const t = text.trim();
  switch (fd.type) {
    case 'phone': { const m = t.match(PHONE); return m?.[0]; }
    case 'email': { const m = t.match(EMAIL); return m?.[0]; }
    case 'money': return money(t);
    case 'number': { if (/^(none|no|zero)$/i.test(t)) return 0; const m = t.match(/\d[\d,]*(?:\.\d+)?/); return m ? num(m[0]) : undefined; }
    case 'zip': { const m = t.match(/\b\d{5}\b/); return m?.[0]; }
    case 'bool': case 'check': { const c = pickChoice([['yes', 'Yes'], ['no', 'No']], t); return c ? c === 'yes' : undefined; }
    case 'select': case 'radio': return pickChoice(fd.options, t);
    case 'multi': return fd.options.filter(([v, l]) => new RegExp(`\\b${l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t.toLowerCase()) || t.toLowerCase() === v).map(([v]) => v);
    case 'signature': return /^(i agree|yes|ok|okay)$/i.test(t) ? undefined : t.replace(/^(\/s\/|signed:?)\s*/i, '');
    case 'text': return /_name$/.test(fd.key) ? t.replace(/^(my name is|it'?s|i'?m|name:?|this is)\s+/i, '').replace(/[.]$/, '') : t;
    default: return t;
  }
}

// Rule-based reading of an answer to one question. Returns { field: value } with raw values.
export function quickParse(form, ask, text, data = {}) {
  const t = text.trim();
  if (form.parse?.[ask.id]) return form.parse[ask.id](t, data) || {};
  const F = form.FIELDS;
  const keys = [...(ask.fields || []), ...(ask.alt || [])];
  const fields = keys.map((k) => F[k]).filter(Boolean);
  if (ask.choices) {
    const c = pickChoice(ask.choices, t);
    if (c && !c.startsWith('__') && fields[0]) return { [fields[0].key]: ['bool', 'check'].includes(fields[0].type) ? ['yes', 'true'].includes(c) : c };
    if (c) return {};
  }
  // A corrected street address, typed right after the address match was shown.
  if (form.addressField && !ask.fields?.includes(form.addressField) && STREET.test(t) && fields[0]?.type !== 'longtext') return { [form.addressField]: t };
  if (fields.length === 1) {
    const fd = fields[0];
    if (ask.optional && SKIP.test(t) && fd.type !== 'longtext') return {};
    const v = readField(fd, t);
    return v === undefined || (Array.isArray(v) && !v.length) ? {} : { [fd.key]: v };
  }
  const out = {};
  // Contact details: every phone and email in the message, in the order the fields list them.
  const phones = t.match(PHONE) || [];
  const emails = t.match(new RegExp(EMAIL.source, 'g')) || [];
  const pre = keys[0].split('_')[0];
  const phoneFields = Object.values(F).filter((x) => x.type === 'phone' && x.key.startsWith(`${pre}_`));
  phoneFields.forEach((x, i) => { if (phones[i]) out[x.key] = phones[i]; });
  const emailField = Object.values(F).find((x) => x.type === 'email' && x.key.startsWith(`${pre}_`));
  if (emailField && emails[0]) out[emailField.key] = emails[0];
  // A mailing address: street, city, state ZIP into prefix_address, _city, _state, _zip.
  const addr = keys.find((k) => /_address$/.test(k)) || (F[`${pre}_address`] && F[`${pre}_city`] ? `${pre}_address` : null);
  if (addr) {
    const pre = addr.replace(/_address$/, '');
    const p = splitAddress(t.replace(new RegExp(EMAIL.source, 'g'), '').replace(PHONE, '').replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/^.*?(?=\d+\s)/, ''));
    if (p) Object.assign(out, { [addr]: p.street, [`${pre}_city`]: p.city, [`${pre}_state`]: p.state, [`${pre}_zip`]: p.zip });
  }
  return out;
}

function fieldList(form) {
  return Object.values(form.FIELDS).filter((x) => !['files', 'signature', 'check'].includes(x.type))
    .map((x) => `- ${x.key} (${x.type}${x.options ? `: ${x.options.map(([v]) => v).join(' | ')}` : ''}): ${x.label}`).join('\n');
}

const SYSTEM = (form, city) => `You help residents fill out the ${city.name} ${form.title} by reading their chat messages.
Return JSON only: {"updates": {field_key: value}, "reply": "..."}.
Rules:
- Only include fields the resident clearly stated in THIS message. Never guess, never fill a field from general assumptions.
- Use the exact option values listed for select fields. multi fields are arrays of option values.
- Numbers are plain numbers in feet, square feet or dollars (no units).
- longtext answers keep the resident's meaning in their own words, cleaned up into clear sentences.
- reply: one short, warm sentence acknowledging what you understood. Do not ask the next question; the app does that.
- If the resident asked a question (what something means, where to find it, what to put, why it's needed), answer it in "reply" instead: two to four plain sentences a non-expert understands, using the field explanations and city documents given. Give a concrete example of a good answer when it helps. If the documents don't say, give general guidance and say City Hall can confirm. Never invent fees, phone numbers or rules. Never say an application is approved or a project is allowed. When answering a question, leave updates empty unless the message also contained an answer.`;

export async function aiParse(env, form, city, ask, text, data, sources = []) {
  const current = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null && v !== ''));
  const explain = (ask?.fields || []).map((k) => form.FIELDS[k]).filter((x) => x && (x.explain || x.help)).map((x) => `- ${x.label}: ${x.explain || x.help}`);
  const user = [
    `Fields:\n${fieldList(form)}`,
    `Already answered: ${JSON.stringify(current)}`,
    explain.length ? `Explanations of the fields in the current question:\n${explain.join('\n')}` : '',
    sources.length ? `City documents (may be dated; prefer verified sources):\n${sources.map((h) => `${h.doc.title}${h.heading ? ` — ${h.heading}` : ''}: ${h.text.slice(0, 700)}`).join('\n\n')}` : '',
    `Question the app asked: ${typeof ask?.prompt === 'string' ? ask.prompt : form.askView(ask, data)?.prompt || 'none'}`,
    `Resident's message: ${text}`,
  ].filter(Boolean).join('\n\n');
  const out = await completeJson(env, SYSTEM(form, city), user);
  const updates = out && typeof out.updates === 'object' ? out.updates : {};
  return { updates, reply: typeof out?.reply === 'string' ? out.reply.slice(0, 900) : null };
}

// Reads one message into clean updates. Rules first; the AI fills what the rules missed and answers questions.
// sources: the city's documents for a question, searched by the caller.
export async function readMessage(env, form, city, ask, text, data, { sources = [] } = {}) {
  const question = looksLikeQuestion(text);
  const raw = ask && !question ? quickParse(form, ask, text, data) : {};
  let reply = null;
  const needAi = !ask || ask.ai || question || !Object.values(raw).some((v) => v !== undefined);
  if (needAi && text.length > 1) {
    try {
      const ai = await aiParse(env, form, city, ask, text, data, sources);
      reply = ai.reply;
      for (const [k, v] of Object.entries(ai.updates)) if (raw[k] === undefined && form.FIELDS[k]) raw[k] = v;
    } catch (e) {
      console.log('form ai parse failed', e.message);
      if (question) reply = explainFallback(form, ask);
    }
  }
  // A question isn't an answer: don't let "what's a setback?" become the setbacks.
  if (question && ask) for (const k of ask.fields || []) if (typeof raw[k] === 'string' && raw[k].trim() === text.trim()) delete raw[k];
  // One number given once fills one field, even if the rules and the AI each placed it.
  const digits = (x) => String(x || '').replace(/\D/g, '').slice(-10);
  for (const k of Object.keys(raw).filter((x) => /_cell$/.test(x))) {
    const phone = raw[k.replace(/_cell$/, '_phone')] ?? data[k.replace(/_cell$/, '_phone')];
    if (raw[k] && phone && digits(raw[k]) === digits(phone)) delete raw[k];
  }
  const updates = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (v === null) { updates[k] = null; continue; }
    const c = form.coerce(k, v);
    if (c !== undefined) updates[k] = c;
  }
  return { updates, reply, question };
}

// Without the AI, a question about the current step is answered from the fields' own explanations.
function explainFallback(form, ask) {
  const lines = (ask?.fields || []).map((k) => form.FIELDS[k]).filter((x) => x && (x.explain || x.help)).map((x) => `**${x.label}**: ${x.explain || x.help}`);
  return lines.length ? lines.join('\n\n') : "I can't look that up right now. City Hall can explain it, or leave it blank and they'll follow up.";
}
