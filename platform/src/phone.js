// Text messages and phone calls through Twilio: the same AI City Clerk, problem reports and request tracking
// as the website chat. Each city's Twilio number points its webhooks at:
//   SMS:   POST /api/{city}/twilio/sms
//   Voice: POST /api/{city}/twilio/voice
// Requests are checked against Twilio's signature with TWILIO_AUTH_TOKEN.
import { recordReply, respond, summarize } from './reply.js';

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const twiml = (inner) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, { headers: { 'Content-Type': 'text/xml' } });
const VOICE = 'Polly.Joanna-Neural';
const say = (text) => `<Say voice="${VOICE}">${xmlEsc(text)}</Say>`;
const REF = /\b([A-Z]{2,5}-\d{4,})\b/i;
const WANTS_PERSON = /\b(person|human|operator|representative|real person|someone|staff member|transfer me|talk to (a|an|the|somebody))\b/i;
const DONE = /^(no|nope|nah|that'?s (all|it)|that is all|good ?bye|bye|no thanks?( you)?|i'?m (good|done|all set))\b/i;

// Reply text without markdown, citation numbers or control tokens.
export function plain(text) {
  return String(text)
    .replace(/<<[A-Z_]+>>/g, '')
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*•]\s+/gm, '- ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Plain text that reads well aloud: no web addresses, phone numbers digit by digit.
export function spoken(text) {
  return plain(text)
    .replace(/\(?https?:\/\/\S+\)?/g, '')
    .replace(/\b(\d{3})[-. ](\d{3})[-. ](\d{4})\b/g, (_, a, b, c) => `${[...a].join(' ')}, ${[...b].join(' ')}, ${[...c].join(' ')}`)
    .replace(/\b911\b/g, '9 1 1')
    .replace(/&/g, ' and ')
    .replace(/^- /gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// "WIG-1001" read aloud as "W I G, 1 0 0 1".
const spellRef = (ref) => ref.split('-').map((part) => [...part].join(' ')).join(', ');

// Cuts a long reply at a sentence boundary, so a text stays readable on a phone.
function brief(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

async function signatureValid(env, url, params, given) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TWILIO_AUTH_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...sig));
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Text and phone channels are configured when the Twilio account is.
export const phoneConfigured = (env) => !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);

export async function phoneRoute(request, env, ctx, city, store, url, kind, step, hooks) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const params = Object.fromEntries([...(await request.formData()).entries()].filter(([, v]) => typeof v === 'string'));
  if (env.TWILIO_AUTH_TOKEN) {
    if (!(await signatureValid(env, url.toString(), params, request.headers.get('X-Twilio-Signature')))) return new Response('Invalid signature', { status: 403 });
  } else if (env.TWILIO_ALLOW_UNSIGNED !== '1') { // set only in .dev.vars, for trying calls and texts locally
    return new Response('Text and voice are not set up yet', { status: 503 });
  }
  const from = String(params.From || '').slice(0, 40);
  if (!from) return new Response('Missing caller', { status: 400 });
  if (kind === 'sms') return sms(env, ctx, city, store, url, from, String(params.Body || '').trim().slice(0, 1200), hooks);
  if (kind === 'voice' && !step) return voiceStart(city, url);
  if (kind === 'voice' && step === 'turn') return voiceTurn(env, ctx, city, store, url, from, params, hooks);
  return new Response('Not found', { status: 404 });
}

/* ---------------- Text messages ---------------- */

async function sms(env, ctx, city, store, url, from, body, hooks) {
  const s = city.settings;
  const recent = await store.findConversation('sms', from, new Date(Date.now() - 24 * 36e5).toISOString());
  const flow = recent?.flow ? JSON.parse(recent.flow) : null;
  const { convoId, history } = await store.beginTurn({ convoId: recent?.id || null, channel: 'sms', contact: from, question: body || '(empty message)' });
  const reply = async (text, flag = 'action') => { await store.addReply(convoId, text, flag); return twiml(`<Message>${xmlEsc(text.slice(0, 1500))}</Message>`); };

  if (!body) return reply(`Hi, this is ${s.assistantName} for the ${s.cityName}. Ask me a question about city services, or tell me about a problem to report.`);

  const ref = body.match(REF);
  if (ref && (/^\s*(track|status|check)\b/i.test(body) || body.trim().toUpperCase() === ref[1].toUpperCase())) {
    const r = await store.trackRequest(ref[1].toUpperCase());
    return reply(r ? `${r.ref} (${r.category}) is ${r.status.replace(/_/g, ' ')}. Last update ${new Date(r.updated_at).toLocaleDateString('en-US', { timeZone: city.timezone })}.`
      : `I couldn't find a request numbered ${ref[1].toUpperCase()}. Check the number and try again.`);
  }
  if (WANTS_PERSON.test(body) && body.split(/\s+/).length < 12) {
    await store.flagConversation(convoId, 'needs_review');
    return reply(`I've asked City Hall staff to follow up with you by text.${s.phone ? ` You can also call City Hall at ${s.phone}${s.hours ? ` (${s.hours})` : ''}.` : ''}`, 'needs_staff');
  }

  if (flow?.name === 'report') {
    if (/^\s*(cancel|stop report|never ?mind)\s*$/i.test(body)) { await store.setFlow(convoId, null); return reply("OK, I won't file that report. What else can I help with?"); }
    if (flow.step === 'location') {
      await store.setFlow(convoId, { ...flow, location: body.slice(0, 300), step: 'details' });
      return reply('Got it. Anything else the crew should know? Reply SKIP if not.');
    }
    await store.setFlow(convoId, null);
    const created = await fileReport(env, ctx, city, store, convoId, from, flow, /^\s*skip\s*$/i.test(body) ? '' : body, 'sms', hooks);
    return reply(`Thanks. Your request ${created.ref} is with ${created.department}. Reply ${created.ref} anytime to check on it.`);
  }

  const r = await respond(env, city, store, { convoId, question: body, history, channel: 'sms' });
  if (r.type) {
    await store.setFlow(convoId, { name: 'report', type: r.type.key, description: body, step: 'location' });
    await recordReply(env, store, convoId, r);
    return twiml(`<Message>${xmlEsc(plain(r.answer))}</Message>`);
  }
  await recordReply(env, store, convoId, r);
  const link = r.used.map((u) => u.url).find((u) => /^https?:/.test(u || ''));
  const text = brief(plain(r.answer), 600) + (link && !r.flags.emergency ? `\n\nMore: ${link}` : '');
  return twiml(`<Message>${xmlEsc(text.slice(0, 1500))}</Message>`);
}

async function fileReport(env, ctx, city, store, convoId, from, flow, details, channel, hooks) {
  const types = await store.requestTypes();
  const type = types.find((t) => t.key === flow.type) || types.find((t) => t.key === 'other');
  const description = [flow.description, details].filter(Boolean).join('\n').slice(0, 2000);
  const created = await store.createRequest({
    type_key: type.key, description, summary: summarize(type.label, flow.location, description), location: flow.location,
    name: null, contact: from, convo_id: convoId, source: channel,
  }, { type: 'resident', id: null, name: `Resident by ${channel === 'sms' ? 'text' : 'phone'}` }, city.settings.requestPrefix);
  if (hooks?.requestCreated) ctx.waitUntil(hooks.requestCreated(env, city, store, created.id));
  return created;
}

/* ---------------- Phone calls ---------------- */

const turnUrl = (url) => `${url.origin}${url.pathname.replace(/\/voice(\/turn)?$/, '/voice/turn')}`;
const gather = (url, prompt) =>
  `<Gather input="speech" action="${xmlEsc(turnUrl(url))}" method="POST" speechTimeout="auto" language="en-US" actionOnEmptyResult="true">${say(prompt)}</Gather>`;

function voiceStart(city, url) {
  const s = city.settings;
  return twiml(gather(url, `Hello, you've reached ${s.assistantName}, the automated assistant for the ${s.cityName}. ` +
    'I can answer questions about city services, permits and utilities, or take a report about a problem. If this is an emergency, hang up and dial 9 1 1. How can I help you?'));
}

async function voiceTurn(env, ctx, city, store, url, from, params, hooks) {
  const s = city.settings;
  const heard = String(params.SpeechResult || '').trim().slice(0, 600);
  const callSid = String(params.CallSid || '');
  const recent = await store.findConversation('voice', from, new Date(Date.now() - 2 * 36e5).toISOString());
  const flow = recent?.flow ? JSON.parse(recent.flow) : null;
  const sameCall = flow?.callSid === callSid;

  if (!heard) {
    const silences = (sameCall ? flow.silences || 0 : 0) + 1;
    if (recent && sameCall) await store.setFlow(recent.id, { ...flow, silences });
    if (silences >= 2) return twiml(`${say('Thanks for calling. Goodbye.')}<Hangup/>`);
    return twiml(gather(url, "Sorry, I didn't catch that. What can I help you with?"));
  }

  const { convoId, history } = await store.beginTurn({ convoId: sameCall ? recent.id : null, channel: 'voice', contact: from, question: heard });
  const state = sameCall ? flow : { callSid };
  const reply = async (text, next, flag = 'action') => {
    await store.addReply(convoId, text, flag);
    await store.setFlow(convoId, { ...next, callSid, silences: 0 });
    return twiml(gather(url, text));
  };

  if (DONE.test(heard) && state.name !== 'report') {
    await store.addReply(convoId, 'Thanks for calling. Goodbye.');
    return twiml(`${say(`Thanks for calling the ${s.cityName}. Goodbye.`)}<Hangup/>`);
  }
  if (WANTS_PERSON.test(heard)) {
    await store.flagConversation(convoId, 'needs_review');
    if (s.phone && hooks?.isOpen?.(city)) {
      await store.addReply(convoId, 'Transferred the call to City Hall.', 'needs_staff');
      return twiml(`${say('Connecting you to City Hall now.')}<Dial>${xmlEsc(s.phone)}</Dial>`);
    }
    return reply(`City Hall is closed right now${s.hours ? `. Office hours are ${s.hours}` : ''}. I've flagged your call so staff can follow up. Is there anything I can help with in the meantime?`, state, 'needs_staff');
  }

  if (state.name === 'report') {
    if (state.step === 'location') return reply('Got it. Is there anything else the crew should know? If not, just say no.', { ...state, location: heard, step: 'details' });
    const created = await fileReport(env, ctx, city, store, convoId, from, state, DONE.test(heard) ? '' : heard, 'voice', hooks);
    return reply(`Thank you. Your request number is ${spellRef(created.ref)}, and it's been sent to ${created.department}. Is there anything else I can help with?`, { callSid });
  }

  const r = await respond(env, city, store, { convoId, question: heard, history, channel: 'voice' });
  await recordReply(env, store, convoId, r);
  if (r.type) {
    await store.setFlow(convoId, { name: 'report', type: r.type.key, description: heard, step: 'location', callSid, silences: 0 });
    return twiml(gather(url, spoken(r.answer)));
  }
  await store.setFlow(convoId, { callSid, silences: 0 });
  return twiml(gather(url, `${spoken(r.answer)} Is there anything else I can help with?`));
}
