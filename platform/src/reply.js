// The AI City Clerk's reply to a resident, shared by the website chat, text messages and phone calls.
import { search } from './search.js';
import { buildUserMessage, detectReport, generate, isEmergency, modelName, systemPrompt, tokenFilter } from './assistant.js';
import { recordsIntro, wantsRecords } from './records.js';
import { isLicenseQuestion, licensingSources } from './licensing.js';
import { matchServices } from './services.js';
import { enabledForms, formList } from './permits/routes.js';
import { detectForm } from './permits/forms/index.js';

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
  let flags = { needsStaff: false, offerReport: false, emergency: false, offerForm: null, offerRecords: false, offerLicense: false, links: [] };
  const online = formList(city);
  let reportType = null;
  let type = null;
  try {
    const emergency = isEmergency(question);
    flags.offerRecords = !emergency && wantsRecords(question);
    type = emergency || flags.offerRecords ? null : (await store.requestTypes()).find((t) => t.key === detectReport(question)) || null;
    if (flags.offerRecords) {
      // Public records requests have their own form (records.js): the website chat opens it, texts and calls get the link.
      answer = ['web', 'staff-test'].includes(channel)
        ? recordsIntro(s)
        : `You can request public records from the City of ${s.shortName} online at ${env.APP_ORIGIN || 'https://app.cityhallos.com'}/records?city=${city.slug}. You'll get a tracking number and a link to follow your request.`;
      await emit('meta', { convoId, sources: [] });
      await emit('delta', { t: answer });
    } else if (type) {
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
      // Business license questions also get the city's license classes, fees and rules (licensing.js) as a source.
      flags.offerLicense = isLicenseQuestion(q);
      const hits = [...(flags.offerLicense ? await licensingSources(store, city, env.APP_ORIGIN || 'https://app.cityhallos.com') : []),
        ...(await search(env, store, s, q, { includeInternal, limit: 6 }))];
      // A city PDF form among the sources links to its online application instead.
      const formOf = (url) => online.find((x) => url && x.formUrls.includes(url))?.kind || null;
      sources = [
        { n: 1, title: 'City Hall contact information', category: 'City profile', url: s.website || null, as_of: 'current', authority: 'staff-note' },
        ...hits.map((h, i) => ({
          n: i + 2, docId: h.doc.id, title: h.doc.title, heading: h.heading, category: h.doc.category,
          url: h.doc.source_url || (h.doc.file_key ? `/api/${city.slug}/documents/${h.doc.id}/file` : null),
          as_of: h.doc.as_of, authority: h.doc.authority, verification: h.doc.verification, visibility: h.doc.visibility, form: formOf(h.doc.source_url),
          ...(includeInternal ? { score: Math.round(h.score * 1000) / 1000, excerpt: h.text.slice(0, 400) } : {}),
        })),
      ];
      await emit('meta', { convoId, sources });
      const messages = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: buildUserMessage(s, question, hits) },
      ];
      const filter = tokenFilter();
      for await (const piece of generate(env, systemPrompt(s, channel, online), messages)) {
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
  const cited = citedNumbers(answer);
  // Offer the online application the resident needs: what they asked for, or the city form the answer cites.
  // Records requests and business licenses have their own forms (records.js, licensing.js).
  if (!flags.emergency && !reportType && !flags.offerRecords && !flags.offerLicense) {
    const kinds = enabledForms(city).map((x) => x.kind);
    const citedForm = sources.find((x) => cited.has(x.n) && x.form)?.form;
    flags.offerForm = [flags.formToken, detectForm(question), citedForm].find((k) => k && kinds.includes(k)) || null;
  }
  delete flags.formToken;
  // Online services the resident asked about (paying a water bill...) get their direct link as a button.
  if (!flags.emergency && !reportType) flags.links = matchServices(s, question);
  return { answer, sources, used: sources.filter((x) => cited.has(x.n)), cited, flags, reportType, type };
}

// Saves the reply to the conversation, with the sources it cited.
export async function recordReply(env, store, convoId, r) {
  await store.finishTurn({
    convoId, answer: r.answer,
    sources: (r.used.length ? r.used : r.sources.slice(0, 3)).map(({ score, excerpt, ...x }) => x),
    flag: r.flags.emergency ? 'emergency' : r.flags.needsStaff ? 'needs_staff' : r.flags.offerReport ? 'report' : null,
    model: r.flags.emergency || r.reportType || r.flags.offerRecords ? 'rule' : modelName(env),
    status: r.flags.emergency ? 'emergency' : r.flags.needsStaff ? 'needs_review' : null,
    citedDocIds: r.used.filter((u) => u.docId).map((u) => u.docId),
  });
}
