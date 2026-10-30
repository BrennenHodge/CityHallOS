// The AI City Clerk's reply to a resident, shared by the website chat, text messages and phone calls.
import { search } from './search.js';
import { buildUserMessage, detectPermit, detectReport, generate, isEmergency, modelName, systemPrompt, tokenFilter } from './assistant.js';

// A one-line summary staff see on a request card.
export function summarize(label, location, description) {
  const text = description.split(/\n+/).map((p) => p.trim().replace(/[.!?]?$/, '.')).join(' ');
  return `${label}${location ? ` at ${location}` : ''}. ${text.length > 200 ? text.slice(0, 197) + '…' : text}`;
}

// Source numbers cited in an answer: [2], [2][3], and the occasional [2, 3] or [2-4].
export function citedNumbers(text) {
  const out = new Set();
  for (const [, inner] of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
    for (const part of inner.split(',')) {
      const [a, b] = part.split(/[–-]/).map((x) => Number(x.trim()));
      for (let n = a; n <= (b || a) && n - a < 20; n++) out.add(n);
    }
  }
  return out;
}

// The AI City Clerk's reply to one resident message, on any channel. With send(), the reply streams as it is written.
export async function respond(env, city, store, { convoId, question, history = [], includeInternal = false, channel = 'web', send = null }) {
  const s = city.settings;
  const emit = async (event, data) => { if (send) await send(event, data); };
  let answer = '';
  let sources = [];
  let flags = { needsStaff: false, offerReport: false, emergency: false, offerPermit: false };
  let reportType = null;
  let type = null;
  try {
    const emergency = isEmergency(question);
    type = emergency ? null : (await store.requestTypes()).find((t) => t.key === detectReport(question)) || null;
    if (type) {
      reportType = type.key;
      flags.offerReport = true;
      answer = channel === 'web'
        ? `Thanks for letting us know. I can send this straight to **${type.department}** as a "${type.label.toLowerCase()}" request. ` +
          `Tap **Report this issue** below to add the location and any details, and you'll get a tracking number.`
        : `Thanks for letting us know. I can send this to ${type.department} as a "${type.label.toLowerCase()}" request. What's the address or nearest intersection?`;
      await emit('meta', { convoId, sources: [] });
      await emit('delta', { t: answer });
    } else if (emergency) {
      flags.emergency = true;
      answer = `**If this is an emergency, call 911 now.** I'm an automated assistant and can't dispatch help.\n\n` +
        (s.policeNonEmergency ? `For a non-emergency police matter, call ${s.shortName} Police at ${s.policeNonEmergency}. ` : '') +
        (s.phone ? `For anything else, City Hall is at ${s.phone}.` : '');
      await emit('meta', { convoId, sources: [] });
      await emit('delta', { t: answer });
    } else {
      // Short follow-ups ("what about fences?") search better with the previous question attached.
      const lastUser = [...history].reverse().find((h) => h.role === 'user');
      const q = question.split(/\s+/).length < 6 && lastUser ? `${lastUser.content} ${question}` : question;
      const hits = await search(env, store, s, q, { includeInternal, limit: 6 });
      sources = [
        { n: 1, title: 'City Hall contact information', category: 'City profile', url: s.website || null, as_of: 'current', authority: 'staff-note' },
        ...hits.map((h, i) => ({
          n: i + 2, docId: h.doc.id, title: h.doc.title, heading: h.heading, category: h.doc.category,
          url: h.doc.source_url || (h.doc.file_key ? `/api/${city.slug}/documents/${h.doc.id}/file` : null),
          as_of: h.doc.as_of, authority: h.doc.authority, verification: h.doc.verification, visibility: h.doc.visibility,
          ...(includeInternal ? { score: Math.round(h.score * 1000) / 1000, excerpt: h.text.slice(0, 400) } : {}),
        })),
      ];
      await emit('meta', { convoId, sources });
      const messages = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: buildUserMessage(s, question, hits) },
      ];
      const filter = tokenFilter();
      for await (const piece of generate(env, systemPrompt(s, channel), messages)) {
        const out = filter.push(piece);
        if (out) { answer += out; await emit('delta', { t: out }); }
      }
      const tail = filter.end();
      if (tail) { answer += tail; await emit('delta', { t: tail }); }
      flags = { ...flags, ...filter.flags };
      // A well-sourced answer doesn't need a staff follow-up even if the model asked for one.
      if ([...citedNumbers(answer)].filter((n) => n > 1).length >= 2) flags.needsStaff = false;
      if (!citedNumbers(answer).size && !flags.offerReport) flags.needsStaff = true;
    }
  } catch (e) {
    console.log('chat error', e.stack || e.message);
    flags.needsStaff = true;
    const msg = `Sorry, I had trouble answering just now. Please try again${s.phone ? `, or call City Hall at ${s.phone}` : ''}.`;
    answer += (answer ? '\n\n' : '') + msg;
    await emit('delta', { t: msg }).catch(() => {});
  }
  // Building questions on the website can open the guided permit application.
  flags.offerPermit = ['web', 'staff-test'].includes(channel) && !flags.emergency && !reportType && s.permits?.construction?.enabled !== false && !!detectPermit(question);
  const cited = citedNumbers(answer);
  return { answer, sources, used: sources.filter((x) => cited.has(x.n)), cited, flags, reportType, type };
}

// Saves the reply to the conversation, with the sources it cited.
export async function recordReply(env, store, convoId, r) {
  await store.finishTurn({
    convoId, answer: r.answer,
    sources: (r.used.length ? r.used : r.sources.slice(0, 3)).map(({ score, excerpt, ...x }) => x),
    flag: r.flags.emergency ? 'emergency' : r.flags.needsStaff ? 'needs_staff' : r.flags.offerReport ? 'report' : null,
    model: r.flags.emergency || r.reportType ? 'rule' : modelName(env),
    status: r.flags.emergency ? 'emergency' : r.flags.needsStaff ? 'needs_review' : null,
    citedDocIds: r.used.filter((u) => u.docId).map((u) => u.docId),
  });
}
