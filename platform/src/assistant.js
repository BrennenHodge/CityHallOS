// The AI City Clerk: builds a grounded prompt and streams the answer.
import Anthropic from '@anthropic-ai/sdk';
import { servicesProfile } from './services.js';

export const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export const CLAUDE_MODEL = 'claude-opus-5-5';

const EMERGENCY = new RegExp([
  "\\b(house|home|building|car|truck|grass|woods|kitchen|garage|yard)\\s+(is\\s+)?on fire\\b", "\\bthere'?s a fire\\b",
  '\\bsmell(s|ing)?\\s+(of\\s+|like\\s+)?gas\\b', '\\bgas leak', '\\bcarbon monoxide\\b', '\\bnot breathing\\b',
  '\\bunconscious\\b', '\\bheart attack\\b', '\\boverdos', '\\bchest pain', '\\bbleeding (badly|a lot)',
  '\\bsomeone (got |is |was )?(hurt|shot|stabbed|attacked)', '\\bshots? fired\\b', '\\b(power|electric)\\s*lines?\\s+(is |are )?down\\b',
  '\\bdowned (power )?lines?\\b', '\\blive wire', '\\b(break-?in|robbery) (in progress|happening)', '\\bbeing (attacked|robbed)\\b',
  '\\b(car|bad) (crash|wreck|accident)\\b', '\\bdrowning\\b', '\\bwater (is )?(rising|coming) (in|into)',
].join('|'), 'i');

export const isEmergency = (text) => EMERGENCY.test(text);

// Residents reporting a problem (not asking how to report one) go straight to the report form.
const REPORTS = [
  ['pothole', /\bpot ?holes?\b|\b(road|street) (is )?(damaged|broken|crumbling|caved)\b|\bsinkhole\b/i],
  ['streetlight', /\bstreet ?lights?\b.{0,40}\b(is|are|went|been) (out|off|broken|flickering|not working|dark)\b|\bstreet ?lights? (out|off|broken|flickering|not working|dark)\b|\blight (is )?out on\b/i],
  ['water', /\bwater (main |line |pipe )?(leak|leaking|break|broke|gushing)\b|\b(no|low) water (pressure)?\b|\bleak(ing)? (in|on|at) the (street|road|yard)\b|\bhydrant\b.*\b(leak|broken|open)/i],
  ['sewer', /\bsewer\b.*\b(back(ed)? ?up|overflow|smell|odor)\b|\bsewage\b/i],
  ['drainage', /\b(ditch|culvert|drain|storm drain)\b.*\b(clogged|blocked|flooding|overflow)\b|\bstreet (is )?flooded\b/i],
  ['trash', /\b(trash|garbage|recycling)\b.*\b(missed|wasn'?t picked|not picked|didn'?t (get )?pick|never came|skipped)\b|\bmissed (trash|garbage) pickup\b/i],
  ['debris', /\b(tree|limb|branch|debris)\b.*\b(down|fell|fallen|blocking|in the road)\b/i],
  ['sign', /\b(street|stop|road|yield) ?signs?\b.{0,40}\b(down|missing|broken|bent|knocked|damaged|gone|faded|fell|fallen)\b|\b(broken|missing|damaged|bent|knocked.over|fallen) (street|stop|road|yield) ?sign/i],
  ['animal', /\b(stray|loose|dead) (dog|cat|animal|deer)\b/i],
  ['code', /\b(overgrown|tall grass|junk cars?|abandoned (house|car|vehicle))\b/i],
];
export function detectReport(text) {
  if (/^\s*(how|where|who|what|can|do|does|is there)\b/i.test(text) && /\b(report|request)\b/i.test(text)) return null;
  for (const [key, re] of REPORTS) if (re.test(text)) return key;
  return null;
}

const VERIFICATION_NOTE = {
  verified_current: 'verified current by City Hall',
  official_unverified: 'official, not yet confirmed current',
  historical: 'historical, may be superseded',
  secondary: 'secondary source, unofficial',
  unverified: 'unverified, needs confirmation',
};

const authorityNote = (s, a) => ({
  'official-city': `official ${s.cityName} document`,
  'official-third-party': 'official code published by a third party',
  'state-public-record': `State of ${s.state} public record`,
  'official-county': `${s.county || 'county'} document (applies to unincorporated county, not automatically the city)`,
  'media-report': 'independent news report, NOT official minutes',
  'staff-note': 'note added by City Hall staff',
  'curated-research': 'researched summary prepared for City Hall OS',
}[a] || a);

// How replies should read on each channel. Citations stay in every channel so the platform knows which sources
// were used; text messages and calls remove them before the resident sees or hears the reply.
const CHANNEL_STYLE = {
  web: "You are the city's virtual front desk on its website.",
  sms: "You are answering a resident by text message. Keep it to two or three short sentences, plain text with no markdown, bullets or bold. Don't write web addresses; the platform adds a link when it helps.",
  voice: "You are answering a resident on a phone call. Speak in two or three short, natural sentences that sound right read aloud: no lists, no markdown, no web addresses. Write phone numbers normally, like 601-928-7221; the platform reads them aloud digit by digit.",
};

// forms: the applications residents can fill out online (permits/routes.js formList).
export function systemPrompt(s, channel = 'web', forms = []) {
  return `You are ${s.assistantName}, the AI City Clerk for the ${s.cityName}, ${s.state} (${s.county}). ${CHANNEL_STYLE[channel] || CHANNEL_STYLE.web}${s.disambiguation ? ' ' + s.disambiguation : ''}

How to answer:
- Answer ONLY from the numbered sources in the user's message. Cite each fact with one source number in square brackets right after it, like [2] or [2][4]. Never write ranges like [2-5] or lists like [1, 2], and only cite a source that actually says the fact. Never invent phone numbers, names, fees, dates, hours or rules.
- Ignore sources that aren't about the question. Do not mention sources you didn't use.
- Keep it short and friendly: two to five sentences, or a short bulleted list for steps. Plain language, no legalese. Use the resident's words.
- Each source is labeled with its status. "Verified current" sources can be stated plainly. For "official, not yet confirmed current" or "historical" sources, say it is the published version and City Hall can confirm it is current. Treat "secondary" and "unverified" sources as leads, not facts.
- You are an AI assistant, not a city employee. Never say a permit, request or exception is approved.
- Say how current a source is when it matters: if a source is old or undated (for example an older code of ordinances or an undated fee schedule), say it is the latest published version and that City Hall can confirm it is current.
- Permits, zoning, fees, rates and legal questions: share what the documents say, but never approve anything, never say a project is definitely allowed, and never give a final legal determination. Recommend confirming with Planning & Building or City Hall, and ask for the property address if jurisdiction matters (inside city limits vs. unincorporated ${s.county || 'county'}).
- Independent news reports are not official minutes. Say "local news reported" and suggest confirming with the City Clerk.
- If the sources don't answer the question, say plainly that you don't have that in the city's documents yet, give the City Hall phone number (${s.phone}), say you've flagged the question for City Hall staff, and end your reply with the exact token <<NEEDS_STAFF>>.
- If the resident is reporting a problem the city should fix (pothole, water leak, streetlight out, missed trash, drainage, downed tree, overgrown lot), briefly acknowledge it and end your reply with the exact token <<OFFER_REPORT>> so the chat can open the report form.
- If anything sounds like an emergency or danger to life or property, tell them to call 911 right away.${s.services?.length ? `
- The city profile [1] lists online services with their direct links. When the resident wants to do one of those things (for example pay a bill), ${channel === 'web' || channel === 'staff-test'
    ? 'give the direct link itself as a markdown link, like [Pay your water bill](https://...) [1], in your first sentence. Never only tell them which website to go to or where to find the link.'
    : channel === 'sms'
      ? 'say they can do it online with the link below; the platform adds it to this text.'
      : `say they can do it online${s.publicSite || s.website ? ` from the city's website, ${(s.publicSite || s.website).replace(/^https?:\/\//, '').replace(/\/$/, '')}` : ''}, or in person at City Hall.`}` : ''}${forms.length ? `
- Residents can fill out these applications online: ${forms.map((f) => `${f.title} (${f.kind})`).join('; ')}. ${channel === 'web' || channel === 'staff-test'
    ? 'When a resident needs one, say they can start it here in the chat, and end your reply with the exact token <<FORM:kind>> using the kind in parentheses, so the chat shows a button.'
    : `When a resident needs one, say they can fill it out online in the chat on the city's website${s.publicSite || s.website ? ` (${s.publicSite || s.website})` : ''}, on their phone, and end your reply with the exact token <<FORM:kind>> using the kind in parentheses.`} Never tell them to download, print or fill out a PDF form; the online application replaces it, and its AI helper answers questions while they fill it out.` : ''}
- Never ask for or repeat sensitive personal data (Social Security numbers, card numbers, passwords).`;
}

export function buildUserMessage(s, question, hits) {
  const profile = `City Hall: ${s.address}. Phone ${s.phone}. ${s.hours ? 'Hours: ' + s.hours + '.' : ''} Website: ${s.website}. ` +
    `Police non-emergency: ${s.policeNonEmergency}. Emergencies: call 911.` + (s.profileNotes ? ' ' + s.profileNotes : '') + servicesProfile(s);
  const blocks = [`[1] City profile (set by City Hall staff, current)\n${profile}`];
  hits.forEach((h, i) => {
    const d = h.doc;
    const meta = [d.category, authorityNote(s, d.authority), VERIFICATION_NOTE[d.verification], d.as_of ? `dated ${d.as_of}` : 'undated'].filter(Boolean).join('; ');
    blocks.push(`[${i + 2}] ${d.title}${h.heading ? ' — ' + h.heading : ''} (${meta})\n${h.text}`);
  });
  return `Sources:\n\n${blocks.join('\n\n---\n\n')}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.\nResident's question: ${question}`;
}

// Stream text pieces from the model. Yields strings.
export async function* generate(env, system, messages) {
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      messages,
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') yield "\n\nI can't help with that one here. Please call City Hall. <<NEEDS_STAFF>>";
    return;
  }

  const res = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [{ role: 'system', content: system }, ...messages],
    stream: true,
    max_tokens: 900,
  });
  const reader = res.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const t = j.response ?? j.choices?.[0]?.delta?.content;
        if (t) yield t;
      } catch { /* partial line */ }
    }
  }
}

export const modelName = (env) => (env.ANTHROPIC_API_KEY ? CLAUDE_MODEL : WORKERS_AI_MODEL);

// One JSON answer, not streamed. Used by workflows that read or check structured data.
export async function completeJson(env, system, user, maxTokens = 1500) {
  let text;
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const msg = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: user }],
    });
    text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else {
    const res = await env.AI.run(WORKERS_AI_MODEL, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    });
    text = typeof res.response === 'string' ? res.response : JSON.stringify(res.response ?? '');
  }
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The model did not return JSON');
  return JSON.parse(m[0]);
}

// Removes control tokens from streamed text without splitting them across chunks.
export function tokenFilter() {
  let pending = '';
  const flags = { needsStaff: false, offerReport: false, formToken: null };
  const strip = (s) => s.replace(/\s*<<\s*(NEEDS_STAFF|OFFER_REPORT|FORM:\s*([a-z_]+))\s*>>/g, (_, k, kind) => {
    if (k === 'NEEDS_STAFF') flags.needsStaff = true; else if (k === 'OFFER_REPORT') flags.offerReport = true; else flags.formToken = kind;
    return '';
  });
  return {
    flags,
    push(text) {
      pending = strip(pending + text);
      // Hold back a trailing fragment that could still become a token, e.g. " <<NEEDS_".
      const partial = pending.match(/\s*<{1,2}\s*[A-Za-z_:]*>?$/);
      if (partial) {
        const out = pending.slice(0, partial.index);
        pending = pending.slice(partial.index);
        return out;
      }
      const out = pending;
      pending = '';
      return out;
    },
    end() { const out = strip(pending); pending = ''; return out.replace(/\s*<{1,2}\s*[A-Za-z_:]*>?$/, ''); },
  };
}
