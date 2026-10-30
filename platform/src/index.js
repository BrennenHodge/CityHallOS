// City Hall OS platform API: knowledge base, AI City Clerk chat, service requests.
import { extractText, guessMime, indexDocument } from './ingest.js';
import { search } from './search.js';
import { buildUserMessage, detectReport, generate, isEmergency, modelName, systemPrompt, tokenFilter } from './assistant.js';
import { DEFAULT_SETTINGS, REQUEST_TYPES } from './cities.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status, error) => json({ error }, status);
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);

// Source numbers cited in an answer: [2], [2][3], and the occasional [2, 3] or [2-4].
function citedNumbers(text) {
  const out = new Set();
  for (const [, inner] of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
    for (const part of inner.split(',')) {
      const [a, b] = part.split(/[–-]/).map((x) => Number(x.trim()));
      for (let n = a; n <= (b || a) && n - a < 20; n++) out.add(n);
    }
  }
  return out;
}

function authorized(request, env) {
  const got = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY || got.length !== env.ADMIN_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ env.ADMIN_KEY.charCodeAt(i);
  return diff === 0;
}

async function getCity(env, slug) {
  const row = await env.DB.prepare('SELECT slug, name, settings FROM cities WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  return { slug: row.slug, name: row.name, settings: { ...DEFAULT_SETTINGS[slug], ...JSON.parse(row.settings || '{}') } };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      console.log('error', e.stack || e.message);
      return fail(500, e.message || 'Server error');
    }
  },
};

async function route(request, env, ctx, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const m = request.method;
  if (parts[0] === 'auth' && parts[1] === 'check') return authorized(request, env) ? json({ ok: true }) : fail(401, 'Invalid access code');

  const city = await getCity(env, parts[0]);
  if (!city) return fail(404, 'Unknown city');
  const [, res, id, sub] = parts;
  const admin = authorized(request, env);
  const need = () => (admin ? null : fail(401, 'Staff access code required'));

  // Public, for the embedded widget.
  if (res === 'config' && m === 'GET') return json(publicConfig(city), 200, { 'Cache-Control': 'public, max-age=60' });
  if (res === 'chat' && m === 'POST') return chat(request, env, ctx, city, admin);
  if (res === 'requests' && m === 'POST' && !id) return createRequest(request, env, city);
  if (res === 'track' && m === 'GET' && id) return trackRequest(env, city, id);
  if (res === 'forms' && m === 'GET') return listForms(env, city);
  if (res === 'documents' && id && sub === 'file' && m === 'GET') return documentFile(env, city, id, admin);

  // Staff only.
  const denied = need();
  if (denied) return denied;
  if (res === 'overview' && m === 'GET') return overview(env, city);
  if (res === 'search' && m === 'GET') return searchPreview(env, city, url);
  if (res === 'documents') {
    if (!id && m === 'GET') return listDocuments(env, city, url);
    if (!id && m === 'POST') return addDocuments(request, env, city);
    if (id && !sub && m === 'GET') return getDocument(env, city, id);
    if (id && !sub && m === 'PATCH') return updateDocument(request, env, city, id);
    if (id && !sub && m === 'DELETE') return deleteDocument(env, city, id);
    if (id && sub === 'reprocess' && m === 'POST') return reprocessDocument(env, city, id);
  }
  if (res === 'conversations') {
    if (!id && m === 'GET') return listConversations(env, city, url);
    if (id && m === 'GET') return getConversation(env, city, id);
    if (id && m === 'PATCH') return updateConversation(request, env, city, id);
  }
  if (res === 'requests') {
    if (!id && m === 'GET') return listRequests(env, city);
    if (id && sub === 'photo' && m === 'GET') return requestPhoto(env, city, id);
    if (id && m === 'PATCH') return updateRequest(request, env, city, id);
  }
  if (res === 'settings' && m === 'PUT') return saveSettings(request, env, city);
  if (res === 'settings' && m === 'GET') return json(city.settings);
  return fail(404, 'Not found');
}

function publicConfig(city) {
  const s = city.settings;
  return {
    city: city.slug, cityName: s.cityName, assistantName: s.assistantName, tagline: s.tagline, greeting: s.greeting,
    brandColor: s.brandColor, suggestions: s.suggestions, phone: s.phone, policeNonEmergency: s.policeNonEmergency,
    requestTypes: REQUEST_TYPES.map(({ key, label }) => ({ key, label })),
  };
}

/* ---------------- Chat ---------------- */

async function chat(request, env, ctx, city, admin) {
  const body = await request.json().catch(() => ({}));
  const question = String(body.message || '').trim().slice(0, 1200);
  if (!question) return fail(400, 'Message is required');
  const staff = admin && body.mode === 'staff';

  if (env.CHAT_LIMIT && !staff) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const { success } = await env.CHAT_LIMIT.limit({ key: `${city.slug}:${ip}` });
    if (!success) return fail(429, 'Too many messages. Please wait a minute and try again.');
  }

  let convoId = typeof body.convoId === 'string' && /^c[a-f0-9]{12}$/.test(body.convoId) ? body.convoId : null;
  let history = [];
  if (convoId) {
    const exists = await env.DB.prepare('SELECT id FROM conversations WHERE id = ? AND city = ?').bind(convoId, city.slug).first();
    if (!exists) convoId = null;
    else {
      const { results } = await env.DB.prepare(
        'SELECT role, content FROM messages WHERE convo_id = ? ORDER BY id DESC LIMIT 6'
      ).bind(convoId).all();
      history = results.reverse();
    }
  }
  if (!convoId) {
    convoId = uid('c');
    await env.DB.prepare(
      'INSERT INTO conversations (id, city, channel, page_url, first_question) VALUES (?, ?, ?, ?, ?)'
    ).bind(convoId, city.slug, staff ? 'staff-test' : (['voice', 'sms'].includes(body.channel) ? body.channel : 'web'), String(body.pageUrl || '').slice(0, 300), question).run();
  }
  await env.DB.prepare('INSERT INTO messages (convo_id, role, content) VALUES (?, ?, ?)').bind(convoId, 'user', question).run();

  const s = city.settings;
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const run = async () => {
    let answer = '';
    let sources = [];
    let flags = { needsStaff: false, offerReport: false, emergency: false };
    let reportType = null;
    try {
      reportType = isEmergency(question) ? null : detectReport(question);
      if (reportType) {
        const type = REQUEST_TYPES.find((t) => t.key === reportType);
        flags.offerReport = true;
        answer = `Thanks for letting us know. I can send this straight to **${type.department}** as a "${type.label.toLowerCase()}" request. ` +
          `Tap **Report this issue** below to add the location and any details, and you'll get a tracking number.`;
        await send('meta', { convoId, sources: [] });
        await send('delta', { t: answer });
      } else if (isEmergency(question)) {
        flags.emergency = true;
        answer = `**If this is an emergency, call 911 now.** I'm an automated assistant and can't dispatch help.\n\n` +
          `For a non-emergency police matter, call Wiggins Police at ${s.policeNonEmergency}. For anything else, City Hall is at ${s.phone}.`;
        await send('meta', { convoId, sources: [] });
        await send('delta', { t: answer });
      } else {
        // Short follow-ups ("what about fences?") search better with the previous question attached.
        const lastUser = [...history].reverse().find((h) => h.role === 'user');
        const q = question.split(/\s+/).length < 6 && lastUser ? `${lastUser.content} ${question}` : question;
        const hits = await search(env, city.slug, q, { includeInternal: staff, limit: 6 });
        sources = [
          { n: 1, title: 'City Hall contact information', category: 'City profile', url: s.website, as_of: 'current', authority: 'staff-note' },
          ...hits.map((h, i) => ({
            n: i + 2, docId: h.doc.id, title: h.doc.title, heading: h.heading, category: h.doc.category,
            url: h.doc.source_url || (h.doc.file_key ? `/api/${city.slug}/documents/${h.doc.id}/file` : null),
            as_of: h.doc.as_of, authority: h.doc.authority, verification: h.doc.verification, visibility: h.doc.visibility,
            ...(staff ? { score: Math.round(h.score * 1000) / 1000, excerpt: h.text.slice(0, 400) } : {}),
          })),
        ];
        await send('meta', { convoId, sources });
        const messages = [
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: buildUserMessage(s, question, hits) },
        ];
        const filter = tokenFilter();
        for await (const piece of generate(env, systemPrompt(s), messages)) {
          const out = filter.push(piece);
          if (out) { answer += out; await send('delta', { t: out }); }
        }
        const tail = filter.end();
        if (tail) { answer += tail; await send('delta', { t: tail }); }
        flags = { ...flags, ...filter.flags };
        // A well-sourced answer doesn't need a staff follow-up even if the model asked for one.
        if ([...citedNumbers(answer)].filter((n) => n > 1).length >= 2) flags.needsStaff = false;
        if (!citedNumbers(answer).size && !flags.offerReport) flags.needsStaff = true;
      }
    } catch (e) {
      console.log('chat error', e.stack || e.message);
      flags.needsStaff = true;
      const msg = `Sorry, I had trouble answering just now. Please try again, or call City Hall at ${s.phone}.`;
      answer += (answer ? '\n\n' : '') + msg;
      await send('delta', { t: msg }).catch(() => {});
    }

    const cited = citedNumbers(answer);
    const used = sources.filter((x) => cited.has(x.n));
    const flag = flags.emergency ? 'emergency' : flags.needsStaff ? 'needs_staff' : flags.offerReport ? 'report' : null;
    await send('done', { convoId, flags, cited: [...cited], reportType }).catch(() => {});
    await writer.close().catch(() => {});

    const status = flags.emergency ? 'emergency' : flags.needsStaff ? 'needs_review' : null;
    const stmts = [
      env.DB.prepare('INSERT INTO messages (convo_id, role, content, sources, flag, model) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(convoId, 'assistant', answer, JSON.stringify(used.length ? used : sources.slice(0, 3)), flag, flags.emergency ? 'rule' : modelName(env)),
      env.DB.prepare(
        `UPDATE conversations SET messages = messages + 2, last_at = datetime('now')${status ? ', status = ?' : ''} WHERE id = ?`
      ).bind(...(status ? [status, convoId] : [convoId])),
      ...used.filter((u) => u.docId).map((u) =>
        env.DB.prepare('INSERT INTO citations (city, doc_id, convo_id) VALUES (?, ?, ?)').bind(city.slug, u.docId, convoId)),
    ];
    await env.DB.batch(stmts);
  };
  ctx.waitUntil(run());
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
  });
}

/* ---------------- Knowledge base ---------------- */

const DOC_COLS = 'id, title, category, source_url, authority, visibility, verification, as_of, file_name, mime, bytes, chars, chunks, status, error, notes, added_by, created_at, updated_at';

async function listDocuments(env, city, url) {
  const q = url.searchParams.get('q');
  const cat = url.searchParams.get('category');
  let sql = `SELECT ${DOC_COLS} FROM documents WHERE city = ?`;
  const args = [city.slug];
  if (cat) { sql += ' AND category = ?'; args.push(cat); }
  if (q) { sql += ' AND (title LIKE ? OR notes LIKE ? OR file_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY updated_at DESC';
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return json({ documents: results });
}

async function getDocument(env, city, id) {
  const doc = await env.DB.prepare(`SELECT ${DOC_COLS}, file_key FROM documents WHERE id = ? AND city = ?`).bind(id, city.slug).first();
  if (!doc) return fail(404, 'Document not found');
  const { results } = await env.DB.prepare('SELECT heading, text FROM chunks_fts WHERE doc_id = ? ORDER BY CAST(ord AS INTEGER)').bind(id).all();
  const cited = await env.DB.prepare('SELECT COUNT(*) AS n FROM citations WHERE doc_id = ?').bind(id).first();
  return json({ document: { ...doc, cited: cited.n }, chunks: results });
}

function clean(v, max = 300) { return v == null || v === '' ? null : String(v).trim().slice(0, max); }

async function addDocuments(request, env, city) {
  const ct = request.headers.get('Content-Type') || '';
  const created = [];
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const meta = Object.fromEntries(['title', 'category', 'source_url', 'authority', 'visibility', 'as_of', 'notes', 'text'].map((k) => [k, form.get(k)]));
    const files = form.getAll('file').filter((f) => typeof f === 'object');
    if (!files.length) return fail(400, 'Attach at least one file');
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length > 50 * 1024 * 1024) { created.push({ title: f.name, status: 'error', error: 'File is larger than 50 MB' }); continue; }
      const title = files.length === 1 && meta.title ? meta.title : prettyName(f.name);
      created.push(await ingest(env, city, { ...meta, title, bytes, file_name: f.name, mime: f.type || guessMime(f.name) }));
    }
  } else {
    const body = await request.json();
    if (body.url) {
      const r = await fetch(body.url, { headers: { 'User-Agent': 'CityHallOS knowledge import' }, redirect: 'follow' });
      if (!r.ok) return fail(400, `Could not fetch that URL (${r.status})`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const mime = (r.headers.get('Content-Type') || 'text/html').split(';')[0];
      const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'page') + (mime.includes('html') ? '.html' : '');
      created.push(await ingest(env, city, { ...body, title: body.title || prettyName(name), source_url: body.source_url || body.url, bytes, file_name: name, mime }));
    } else if (body.text) {
      created.push(await ingest(env, city, { ...body, title: body.title || 'Staff note', authority: body.authority || 'staff-note' }));
    } else {
      return fail(400, 'Send a file, a URL, or text');
    }
  }
  return json({ documents: created }, 201);
}

const VERIFICATION = ['verified_current', 'official_unverified', 'historical', 'secondary', 'unverified'];
function defaultVerification(authority) {
  return { 'media-report': 'secondary', 'curated-research': 'unverified', 'staff-note': 'verified_current' }[authority] || 'official_unverified';
}

function prettyName(name) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
}

async function ingest(env, city, d) {
  const id = uid('d');
  const doc = {
    id, city: city.slug, title: clean(d.title, 200) || 'Untitled document', category: clean(d.category, 60) || 'General',
    source_url: clean(d.source_url, 500), authority: clean(d.authority, 40) || 'official-city',
    visibility: d.visibility === 'internal' ? 'internal' : 'public', as_of: clean(d.as_of, 40), notes: clean(d.notes, 2000),
    verification: VERIFICATION.includes(d.verification) ? d.verification : defaultVerification(d.authority),
    file_name: clean(d.file_name, 200), mime: clean(d.mime, 120), bytes: d.bytes?.length || 0,
  };
  let fileKey = null;
  if (d.bytes) {
    fileKey = `${city.slug}/${id}/${(doc.file_name || 'file').replace(/[^\w.-]+/g, '_')}`;
    await env.FILES.put(fileKey, d.bytes, { httpMetadata: { contentType: doc.mime || 'application/octet-stream' } });
  }
  await env.DB.prepare(
    `INSERT INTO documents (id, city, title, category, source_url, authority, visibility, verification, as_of, file_key, file_name, mime, bytes, notes, added_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staff', 'processing')`
  ).bind(doc.id, doc.city, doc.title, doc.category, doc.source_url, doc.authority, doc.visibility, doc.verification, doc.as_of, fileKey,
    doc.file_name, doc.mime, doc.bytes, doc.notes).run();

  return process(env, doc, d.text ? String(d.text) : null, d.bytes);
}

async function process(env, doc, text, bytes) {
  try {
    if (!text) text = await extractText(env, { bytes, name: doc.file_name, mime: doc.mime });
    if (!text || text.replace(/\s/g, '').length < 30) {
      throw new Error('No readable text found. If this is a scanned document, paste its text in the document details.');
    }
    const n = await indexDocument(env, doc, text);
    await env.DB.prepare(
      "UPDATE documents SET status = 'ready', error = NULL, chars = ?, chunks = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(text.length, n, doc.id).run();
    return { ...doc, status: 'ready', chars: text.length, chunks: n };
  } catch (e) {
    await env.DB.prepare("UPDATE documents SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(String(e.message).slice(0, 300), doc.id).run();
    return { ...doc, status: 'error', error: e.message };
  }
}

async function updateDocument(request, env, city, id) {
  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ? AND city = ?').bind(id, city.slug).first();
  if (!doc) return fail(404, 'Document not found');
  const b = await request.json();
  const next = {
    title: clean(b.title, 200) ?? doc.title, category: clean(b.category, 60) ?? doc.category,
    source_url: 'source_url' in b ? clean(b.source_url, 500) : doc.source_url, authority: clean(b.authority, 40) ?? doc.authority,
    visibility: b.visibility ? (b.visibility === 'internal' ? 'internal' : 'public') : doc.visibility,
    as_of: 'as_of' in b ? clean(b.as_of, 40) : doc.as_of, notes: 'notes' in b ? clean(b.notes, 2000) : doc.notes,
    verification: VERIFICATION.includes(b.verification) ? b.verification : doc.verification,
  };
  await env.DB.prepare(
    `UPDATE documents SET title = ?, category = ?, source_url = ?, authority = ?, visibility = ?, verification = ?, as_of = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(next.title, next.category, next.source_url, next.authority, next.visibility, next.verification, next.as_of, next.notes, id).run();
  await env.DB.prepare('UPDATE chunks_fts SET title = ?, visibility = ? WHERE doc_id = ?').bind(next.title, next.visibility, id).run();
  if (b.text) await process(env, { ...doc, ...next }, String(b.text));
  return getDocument(env, city, id);
}

async function deleteDocument(env, city, id) {
  const doc = await env.DB.prepare('SELECT file_key FROM documents WHERE id = ? AND city = ?').bind(id, city.slug).first();
  if (!doc) return fail(404, 'Document not found');
  if (doc.file_key) await env.FILES.delete(doc.file_key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks_fts WHERE doc_id = ?').bind(id),
    env.DB.prepare('DELETE FROM citations WHERE doc_id = ?').bind(id),
    env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function reprocessDocument(env, city, id) {
  const doc = await env.DB.prepare('SELECT * FROM documents WHERE id = ? AND city = ?').bind(id, city.slug).first();
  if (!doc?.file_key) return fail(400, 'This document has no file to reprocess');
  const obj = await env.FILES.get(doc.file_key);
  if (!obj) return fail(404, 'Stored file is missing');
  return json({ document: await process(env, doc, null, new Uint8Array(await obj.arrayBuffer())) });
}

async function documentFile(env, city, id, admin) {
  const doc = await env.DB.prepare('SELECT file_key, file_name, mime, visibility FROM documents WHERE id = ? AND city = ?').bind(id, city.slug).first();
  if (!doc?.file_key || (doc.visibility !== 'public' && !admin)) return fail(404, 'File not found');
  const obj = await env.FILES.get(doc.file_key);
  if (!obj) return fail(404, 'File not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(doc.file_name || 'document').replace(/"/g, '')}"`,
      'Cache-Control': 'public, max-age=3600', ...CORS,
    },
  });
}

async function listForms(env, city) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, notes, as_of, source_url, verification, file_key IS NOT NULL AS has_file FROM documents
      WHERE city = ? AND visibility = 'public' AND status = 'ready' AND category = 'Permits & Forms' AND source_url LIKE '%DocumentCenter%'
      ORDER BY title`
  ).bind(city.slug).all();
  return json({ forms: results.map((f) => ({ id: f.id, title: f.title, description: f.notes, as_of: f.as_of, verification: f.verification,
    url: f.source_url || (f.has_file ? `/api/${city.slug}/documents/${f.id}/file` : null) })) }, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function searchPreview(env, city, url) {
  const q = url.searchParams.get('q') || '';
  const hits = await search(env, city.slug, q, { includeInternal: true, limit: 8 });
  return json({
    results: hits.map((h) => ({ docId: h.doc.id, title: h.doc.title, category: h.doc.category, heading: h.heading, score: h.score, text: h.text })),
  });
}

/* ---------------- Conversations ---------------- */

async function listConversations(env, city, url) {
  const status = url.searchParams.get('status');
  const args = [city.slug];
  let where = "city = ? AND channel != 'staff-test'";
  if (status) { where += ' AND status = ?'; args.push(status); }
  const { results } = await env.DB.prepare(
    `SELECT id, channel, page_url, status, messages, first_question, started_at, last_at FROM conversations WHERE ${where} ORDER BY last_at DESC LIMIT 200`
  ).bind(...args).all();
  return json({ conversations: results });
}

async function getConversation(env, city, id) {
  const convo = await env.DB.prepare('SELECT * FROM conversations WHERE id = ? AND city = ?').bind(id, city.slug).first();
  if (!convo) return fail(404, 'Conversation not found');
  const { results } = await env.DB.prepare('SELECT role, content, sources, flag, model, created_at FROM messages WHERE convo_id = ? ORDER BY id').bind(id).all();
  const { results: reqs } = await env.DB.prepare('SELECT id, category, status FROM requests WHERE convo_id = ?').bind(id).all();
  return json({
    conversation: convo,
    messages: results.map((r) => ({ ...r, sources: r.sources ? JSON.parse(r.sources) : [] })),
    requests: reqs.map((r) => ({ ...r, ref: refOf(city, r.id) })),
  });
}

async function updateConversation(request, env, city, id) {
  const b = await request.json();
  const status = ['answered', 'needs_review', 'reviewed', 'emergency'].includes(b.status) ? b.status : null;
  if (!status) return fail(400, 'Invalid status');
  await env.DB.prepare('UPDATE conversations SET status = ? WHERE id = ? AND city = ?').bind(status, id, city.slug).run();
  return getConversation(env, city, id);
}

/* ---------------- Service requests ---------------- */

const REQUEST_STATUSES = ['new', 'needs_info', 'assigned', 'in_progress', 'awaiting_review', 'resolved', 'closed'];
const refOf = (city, id) => `${city.settings.requestPrefix}-${1000 + Number(id)}`;
const idOf = (city, ref) => {
  const m = String(ref).toUpperCase().match(/^(?:[A-Z]+-)?(\d+)$/);
  return m ? Number(m[1]) - 1000 : NaN;
};

function summarize(label, location, description) {
  const text = description.split(/\n+/).map((p) => p.trim().replace(/[.!?]?$/, '.')).join(' ');
  return `${label}${location ? ` at ${location}` : ''}. ${text.length > 200 ? text.slice(0, 197) + '…' : text}`;
}

async function createRequest(request, env, city) {
  const ct = request.headers.get('Content-Type') || '';
  let b; let photo = null;
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    b = Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string'));
    const f = form.get('photo');
    if (f && typeof f === 'object' && f.size) photo = f;
  } else {
    b = await request.json();
  }
  const type = REQUEST_TYPES.find((t) => t.key === b.category) || REQUEST_TYPES.at(-1);
  const description = clean(b.description, 2000);
  if (!description) return fail(400, 'Please describe the issue');
  const location = clean(b.location, 300);
  const history = [{ at: new Date().toISOString(), status: 'new', by: b.convoId ? 'AI City Clerk' : 'Web form', note: `Submitted by resident. Routed to ${type.department}.` }];
  const row = await env.DB.prepare(
    `INSERT INTO requests (city, category, department, description, location, name, contact, priority, convo_id, summary, history)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
  ).bind(city.slug, type.label, type.department, description, location, clean(b.name, 120), clean(b.contact, 160),
    /\b(urgent|danger|hazard|unsafe|blocking)\b/i.test(description) ? 'high' : type.priority || 'normal', clean(b.convoId, 20),
    summarize(type.label, location, description),
    JSON.stringify(history)).first();
  if (photo && photo.size < 10 * 1024 * 1024 && /^image\//.test(photo.type)) {
    const key = `${city.slug}/requests/${row.id}/${photo.name.replace(/[^\w.-]+/g, '_')}`;
    await env.FILES.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
    await env.DB.prepare('UPDATE requests SET photo_key = ? WHERE id = ?').bind(key, row.id).run();
  }
  if (b.convoId) {
    await env.DB.prepare('INSERT INTO messages (convo_id, role, content, flag, model) VALUES (?, ?, ?, ?, ?)').bind(
      b.convoId, 'assistant', `Created service request ${refOf(city, row.id)} (${type.label}) and routed it to ${type.department}.`, 'action', 'workflow').run().catch(() => {});
  }
  return json({ ref: refOf(city, row.id), department: type.department, status: 'new' }, 201);
}

async function trackRequest(env, city, ref) {
  const r = await env.DB.prepare('SELECT id, category, department, status, created_at, updated_at FROM requests WHERE id = ? AND city = ?')
    .bind(idOf(city, ref), city.slug).first();
  if (!r) return fail(404, 'No request with that number');
  return json({ ref: refOf(city, r.id), category: r.category, department: r.department, status: r.status, created_at: r.created_at, updated_at: r.updated_at });
}

async function listRequests(env, city) {
  const { results } = await env.DB.prepare('SELECT * FROM requests WHERE city = ? ORDER BY id DESC LIMIT 300').bind(city.slug).all();
  return json({ requests: results.map((r) => ({ ...r, ref: refOf(city, r.id), history: JSON.parse(r.history || '[]'), photo: !!r.photo_key })) });
}

async function updateRequest(request, env, city, id) {
  const r = await env.DB.prepare('SELECT * FROM requests WHERE id = ? AND city = ?').bind(id, city.slug).first();
  if (!r) return fail(404, 'Request not found');
  const b = await request.json();
  const status = REQUEST_STATUSES.includes(b.status) ? b.status : r.status;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : r.priority;
  const assignee = 'assignee' in b ? clean(b.assignee, 80) : r.assignee;
  const department = clean(b.department, 80) || r.department;
  const history = JSON.parse(r.history || '[]');
  const changes = [];
  if (status !== r.status) changes.push(`Status: ${status.replace(/_/g, ' ')}`);
  if (assignee !== r.assignee) changes.push(`Assigned to ${assignee || 'nobody'}`);
  if (priority !== r.priority) changes.push(`Priority: ${priority}`);
  if (department !== r.department) changes.push(`Moved to ${department}`);
  if (b.note || changes.length) history.push({ at: new Date().toISOString(), status, by: 'Staff', note: [changes.join(' · '), clean(b.note, 1000)].filter(Boolean).join(' — ') });
  await env.DB.prepare(
    `UPDATE requests SET status = ?, priority = ?, assignee = ?, department = ?, history = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(status, priority, assignee, department, JSON.stringify(history), id).run();
  const row = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  return json({ request: { ...row, ref: refOf(city, row.id), history, photo: !!row.photo_key } });
}

async function requestPhoto(env, city, id) {
  const r = await env.DB.prepare('SELECT photo_key FROM requests WHERE id = ? AND city = ?').bind(id, city.slug).first();
  const obj = r?.photo_key && (await env.FILES.get(r.photo_key));
  if (!obj) return fail(404, 'No photo');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', ...CORS } });
}

/* ---------------- Overview & settings ---------------- */

async function overview(env, city) {
  const c = city.slug;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(c, ...a);
  const [docs, cats, convos, msgs, review, reqs, reqOpen, topDocs, recentQ, byDay, recentReqs, unanswered] = await env.DB.batch([
    q("SELECT COUNT(*) AS n, COALESCE(SUM(chunks),0) AS chunks, COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(bytes),0) AS bytes, SUM(status='error') AS errors FROM documents WHERE city = ?"),
    q('SELECT category, COUNT(*) AS n, COALESCE(SUM(chunks),0) AS chunks FROM documents WHERE city = ? GROUP BY category ORDER BY n DESC'),
    q("SELECT COUNT(*) AS n FROM conversations WHERE city = ? AND channel != 'staff-test'"),
    q("SELECT COUNT(*) AS n FROM messages m JOIN conversations v ON v.id = m.convo_id WHERE v.city = ? AND v.channel != 'staff-test' AND m.role = 'user'"),
    q("SELECT COUNT(*) AS n FROM conversations WHERE city = ? AND status = 'needs_review' AND channel != 'staff-test'"),
    q('SELECT COUNT(*) AS n FROM requests WHERE city = ?'),
    q("SELECT COUNT(*) AS n FROM requests WHERE city = ? AND status NOT IN ('resolved','closed')"),
    q('SELECT d.id, d.title, d.category, COUNT(*) AS n FROM citations c JOIN documents d ON d.id = c.doc_id WHERE c.city = ? GROUP BY d.id ORDER BY n DESC LIMIT 6'),
    q("SELECT id, first_question, status, last_at, channel FROM conversations WHERE city = ? AND channel != 'staff-test' ORDER BY last_at DESC LIMIT 8"),
    q("SELECT substr(started_at,1,10) AS day, COUNT(*) AS n FROM conversations WHERE city = ? AND channel != 'staff-test' AND started_at >= datetime('now','-13 days') GROUP BY day ORDER BY day"),
    q('SELECT id, category, department, status, location, created_at FROM requests WHERE city = ? ORDER BY id DESC LIMIT 5'),
    q("SELECT id, first_question, last_at FROM conversations WHERE city = ? AND status = 'needs_review' AND channel != 'staff-test' ORDER BY last_at DESC LIMIT 5"),
  ]);
  const one = (r) => r.results[0] || {};
  return json({
    city: { slug: c, name: city.settings.cityName },
    model: modelName(env),
    knowledge: { ...one(docs), categories: cats.results },
    conversations: one(convos).n, questions: one(msgs).n, needsReview: one(review).n,
    requests: one(reqs).n, openRequests: one(reqOpen).n,
    topDocuments: topDocs.results, recentQuestions: recentQ.results, byDay: byDay.results,
    recentRequests: recentReqs.results.map((r) => ({ ...r, ref: refOf(city, r.id) })), unanswered: unanswered.results,
  });
}

async function saveSettings(request, env, city) {
  const b = await request.json();
  const allowed = ['assistantName', 'tagline', 'greeting', 'brandColor', 'suggestions', 'phone', 'address', 'hours', 'website', 'policeNonEmergency', 'profileNotes'];
  const stored = JSON.parse((await env.DB.prepare('SELECT settings FROM cities WHERE slug = ?').bind(city.slug).first()).settings || '{}');
  for (const k of allowed) {
    if (!(k in b)) continue;
    stored[k] = k === 'suggestions' ? (Array.isArray(b[k]) ? b[k].map((x) => clean(x, 100)).filter(Boolean).slice(0, 6) : []) : clean(b[k], 1200);
  }
  if (stored.brandColor && !/^#[0-9a-f]{6}$/i.test(stored.brandColor)) delete stored.brandColor;
  await env.DB.prepare('UPDATE cities SET settings = ? WHERE slug = ?').bind(JSON.stringify(stored), city.slug).run();
  return json((await getCity(env, city.slug)).settings);
}
