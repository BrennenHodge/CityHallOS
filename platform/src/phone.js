// Text messages and phone calls: the same AI City Clerk, problem reports and request tracking as the website chat.
// Texts come from Telnyx or Twilio, calls from Twilio. Each city's number points its webhooks at:
//   Telnyx SMS:  POST /api/{city}/telnyx/sms    checked against Telnyx's Ed25519 signature (TELNYX_PUBLIC_KEY)
//   Twilio SMS:  POST /api/{city}/twilio/sms    checked against Twilio's signature (TWILIO_AUTH_TOKEN)
//   Voice:       POST /api/{city}/twilio/voice
import { recordReply, respond, summarize } from './reply.js';
import { telnyxText } from './notify.js';

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
  if (kind === 'sms') {
    const text = await textReply(env, ctx, city, store, from, String(params.Body || '').trim().slice(0, 1200), hooks);
    return twiml(`<Message>${xmlEsc(text.slice(0, 1500))}</Message>`);
  }
  if (kind === 'voice' && !step) return voiceStart(city, url);
  if (kind === 'voice' && step === 'turn') return voiceTurn(env, ctx, city, store, url, from, params, hooks);
  return new Response('Not found', { status: 404 });
}

/* ---------------- Text messages ---------------- */

// Telnyx posts each text as a signed JSON event, and the reply goes back through its API.
export const telnyxConfigured = (env) => !!(env.TELNYX_API_KEY && env.TELNYX_PUBLIC_KEY && env.TELNYX_FROM);

// Opt-out and opt-in words. Telnyx answers these itself and stops or resumes texts to the number.
const OPT_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|start|unstop)\s*$/i;
const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Telnyx signs "timestamp|body" with Ed25519. Events older than five minutes are refused, so they can't be replayed.
async function telnyxSigned(env, raw, sig, ts) {
  if (!sig || !ts || !(Math.abs(Date.now() / 1000 - Number(ts)) <= 300)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', b64bytes(env.TELNYX_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, b64bytes(sig), new TextEncoder().encode(`${ts}|${raw}`));
  } catch { return false; }
}

export async function telnyxRoute(request, env, ctx, city, store, kind, hooks) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (kind !== 'sms') return new Response('Not found', { status: 404 });
  const raw = await request.text();
  if (env.TELNYX_PUBLIC_KEY) {
    if (!(await telnyxSigned(env, raw, request.headers.get('telnyx-signature-ed25519'), request.headers.get('telnyx-timestamp')))) return new Response('Invalid signature', { status: 403 });
  } else if (env.TELNYX_ALLOW_UNSIGNED !== '1') { // set only in .dev.vars, for trying texts locally
    return new Response('Text messages are not set up yet', { status: 503 });
  }
  let event;
  try { event = JSON.parse(raw).data; } catch { return new Response('Bad request', { status: 400 }); }
  const msg = event?.payload;
  // Delivery receipts and other events need no answer.
  if (event?.event_type !== 'message.received' || !msg) return new Response(null, { status: 204 });
  const from = String(msg.from?.phone_number || '').slice(0, 40);
  if (!from) return new Response('Missing sender', { status: 400 });
  const body = String(msg.text || '').trim().slice(0, 1200);
  if (OPT_WORDS.test(body)) return new Response(null, { status: 204 });
  // Without an API key (local development) the reply comes back in the response instead of being texted.
  if (!env.TELNYX_API_KEY) return Response.json({ reply: await textReply(env, ctx, city, store, from, body, hooks) });
  // Telnyx expects a quick answer, so the reply is written and sent after responding, from the number the resident texted.
  const to = msg.to?.[0]?.phone_number || env.TELNYX_FROM;
  ctx.waitUntil(textReply(env, ctx, city, store, from, body, hooks)
    .then((text) => telnyxText(env, { from: to, to: from, text }))
    .catch((e) => console.error(`Telnyx reply to ${city.slug} text failed: ${e.message}`)));
  return new Response(null, { status: 204 });
}

// The reply to one text, as plain text: Twilio sends it back in TwiML, Telnyx through its API.
async function textReply(env, ctx, city, store, from, body, hooks) {
  const s = city.settings;
  const recent = await store.findConversation('sms', from, new Date(Date.now() - 24 * 36e5).toISOString());
  const flow = recent?.flow ? JSON.parse(recent.flow) : null;
  const { convoId, history } = await store.beginTurn({ convoId: recent?.id || null, channel: 'sms', contact: from, question: body || '(empty message)' });
  const reply = async (text, flag = 'action') => { await store.addReply(convoId, text, flag); return text; };

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
    return plain(r.answer);
  }
  await recordReply(env, store, convoId, r);
  // A city form links to its online application, never the PDF.
  const apply = r.flags.offerForm && `${env.APP_ORIGIN || 'https://app.cityhallos.com'}/${city.slug}/#apply=${r.flags.offerForm}`;
  // An online service the resident asked about (paying a water bill...) links straight to it.
  const service = !apply && r.flags.links?.[0];
  const link = apply || service?.url || r.used.filter((u) => !u.form).map((u) => u.url).find((u) => /^https?:/.test(u || ''));
  return brief(plain(r.answer), 600) + (link && !r.flags.emergency ? `\n\n${apply ? 'Apply online' : service ? service.label : 'More'}: ${link}` : '');
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
