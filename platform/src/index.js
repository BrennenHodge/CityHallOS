// City Hall OS platform API: knowledge base, AI City Clerk chat, service requests, staff accounts.
//
// Data lives in two places (see ARCHITECTURE.md):
//   env.DB          the platform database: cities, staff accounts, roles, sessions
//   env.CITY_STORE  one database per city: knowledge base, conversations, requests, audit log
import { chunkText, extractText, guessMime } from './ingest.js';
import { search } from './search.js';
import { buildUserMessage, detectPermit, detectReport, generate, isEmergency, modelName, systemPrompt, tokenFilter } from './assistant.js';
import { STATE_NAMES, defaultSettings } from './templates.js';
import {
  ROLES, access, createSession, createSetupToken, isOperatorKey, platformAudit, sessionCookie, sessionFrom, sha256,
} from './auth.js';
import { permitRoute, sendPermitReminders } from './permits/routes.js';

export { CityStore } from './store.js';
export { AuthService } from './auth.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Permit-Token',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status, error) => json({ error }, status);
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const now = () => new Date().toISOString();
const httpError = (status, message) => Object.assign(new Error(message), { status });

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

/* ---------------- Cities ---------------- */

const cityCache = new Map();

function toCity(row) {
  const stored = JSON.parse(row.settings || '{}');
  const shortName = stored.shortName || row.name.replace(/^(City|Town|Village) of /i, '');
  const settings = {
    ...defaultSettings({ name: row.name, shortName }), ...stored,
    cityName: row.name, county: row.county, state: STATE_NAMES[row.state] || row.state, stateAbbr: row.state,
  };
  return { id: row.id, slug: row.slug, name: row.name, state: row.state, county: row.county, timezone: row.timezone, status: row.status, settings };
}

async function getCity(env, slug) {
  const hit = cityCache.get(slug);
  if (hit && Date.now() - hit.at < 30_000) return hit.city;
  const row = await env.DB.prepare('SELECT * FROM cities WHERE slug = ?').bind(slug).first();
  const city = row ? toCity(row) : null;
  cityCache.set(slug, { city, at: Date.now() });
  return city;
}

// The only way to reach a city's records: the store named after its permanent id.
const storeFor = (env, city) => env.CITY_STORE.get(env.CITY_STORE.idFromName(city.id));
const authService = (env) => env.AUTH.get(env.AUTH.idFromName('auth'));

// SQLite datetime() modifier that turns UTC timestamps into the city's local time.
function tzModifier(tz) {
  try {
    const d = new Date();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(d).map((x) => [x.type, Number(x.value)]));
    const off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - d.getTime()) / 60000);
    return `${off >= 0 ? '+' : ''}${off} minutes`;
  } catch {
    return '+0 minutes';
  }
}

/* ---------------- Who is asking ---------------- */

async function who(request, env, city) {
  const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (bearer && isOperatorKey(env, bearer)) return access({ operator: true, via: 'key' });
  const s = await sessionFrom(env, request);
  if (!s) return null;
  if (s.operator) return access({ operator: true });
  if (!city) return access({ user: s.user });
  const m = await env.DB.prepare('SELECT role, department_id, staff_id FROM memberships WHERE user_id = ? AND city_id = ?').bind(s.user.id, city.id).first();
  return m ? access({ user: s.user, role: m.role, departmentId: m.department_id, staffId: m.staff_id }) : null;
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
      const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
      return fail(e.status || 500, e.status || local ? e.message : 'Something went wrong. Please try again.');
    }
  },

  // Daily: remind applicants about unfinished permit applications and requested corrections.
  async scheduled(event, env, ctx) {
    const { results } = await env.DB.prepare("SELECT * FROM cities WHERE status = 'active'").all();
    for (const row of results) {
      const city = toCity(row);
      try {
        const n = await sendPermitReminders(env, city, storeFor(env, city));
        if (n) console.log(`${city.slug}: sent ${n} permit reminders`);
      } catch (e) {
        console.log(`${city.slug}: reminders failed`, e.stack || e.message);
      }
    }
  },
};

async function route(request, env, ctx, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const m = request.method;

  // Cookie-authenticated changes must come from the dashboard itself. Browsers say so in Sec-Fetch-Site;
  // older ones only send Origin.
  if (m !== 'GET' && request.headers.get('Cookie')?.includes('chos_session')) {
    const site = request.headers.get('Sec-Fetch-Site');
    const origin = request.headers.get('Origin');
    if (site ? !['same-origin', 'none'].includes(site) : origin && origin !== url.origin) return fail(403, 'Cross-site request blocked');
  }

  if (parts[0] === 'auth') return authRoute(request, env, url, parts[1], m);
  if (parts[0] === 'platform') return platformRoute(request, env, url, parts.slice(1), m);

  const city = await getCity(env, parts[0]);
  if (!city || city.status === 'archived') return fail(404, 'Unknown city');
  const [, res, id, sub] = parts;
  const store = storeFor(env, city);
  const signedIn = request.headers.get('Authorization') || request.headers.get('Cookie')?.includes('chos_session');
  const me = signedIn ? await who(request, env, city) : null;

  // Public, for the embedded widget, the portal, voice and SMS.
  if (city.status !== 'suspended' || me) {
    if (res === 'config' && m === 'GET') return publicConfig(city, store);
    if (res === 'chat' && m === 'POST') return chat(request, env, ctx, city, store, me);
    if (res === 'requests' && m === 'POST' && !id) return createRequest(request, env, city, store, me);
    if (res === 'track' && m === 'GET' && id) return trackRequest(store, id);
    if (res === 'forms' && m === 'GET') return listForms(city, store);
    if (res === 'documents' && id && sub === 'file' && m === 'GET') return documentFile(env, store, id, me);
    if (res === 'permits' && (id || m === 'POST')) return permitRoute({ request, env, ctx, url, city, store, me, parts: parts.slice(2) });
  }

  // Staff only. Each route names the permission it needs.
  if (!me) return fail(401, 'Please sign in');
  const need = (perm) => { if (!me.can(perm)) throw httpError(403, "Your role doesn't allow this"); };

  if (res === 'overview' && m === 'GET') { need('overview'); return overview(env, city, store); }
  if (res === 'search' && m === 'GET') { need('assistant.test'); return searchPreview(env, city, store, url); }
  if (res === 'documents') {
    if (!id && m === 'GET') { need('knowledge.view'); return json({ documents: await store.listDocuments({ q: url.searchParams.get('q'), category: url.searchParams.get('category') }) }); }
    if (!id && m === 'POST') { need('knowledge.edit'); return addDocuments(request, env, city, store, me); }
    if (id && !sub && m === 'GET') { need('knowledge.view'); return getDocument(store, id); }
    if (id && !sub && m === 'PATCH') { need('knowledge.edit'); return updateDocument(request, env, store, id, me); }
    if (id && !sub && m === 'DELETE') { need('knowledge.edit'); return deleteDocument(env, store, id, me); }
    if (id && sub === 'reprocess' && m === 'POST') { need('knowledge.edit'); return reprocessDocument(env, store, id, me); }
  }
  if (res === 'conversations') {
    if (!id && m === 'GET') { need('conversations.view'); return json({ conversations: await store.listConversations({ status: url.searchParams.get('status') }) }); }
    if (id && m === 'GET') { need('conversations.view'); return getConversation(store, id); }
    if (id && m === 'PATCH') { need('conversations.review'); return updateConversation(request, store, id, me); }
  }
  if (res === 'requests') {
    if (!id && m === 'GET') { need('requests.view'); return listRequests(store, me); }
    if (id && sub === 'photo' && m === 'GET') { need('requests.view'); return requestPhoto(env, store, id, me); }
    if (id && !sub && m === 'PATCH') { need('requests.edit'); return updateRequest(request, store, id, me); }
  }
  if (res === 'permits') return permitRoute({ request, env, ctx, url, city, store, me, parts: parts.slice(2) });
  if (res === 'departments' && m === 'GET') return json({ departments: await store.departments() });
  if (res === 'staff') {
    if (!id && m === 'GET') { need('requests.view'); return listStaff(env, city, store, me); }
    if (!id && m === 'POST') { need('staff.manage'); return addStaff(request, env, city, store, me, url); }
    if (id && !sub && m === 'PATCH') { need('staff.manage'); return updateStaff(request, env, city, store, id, me, url); }
    if (id && sub === 'setup-link' && m === 'POST') { need('staff.manage'); return newSetupLink(env, city, store, id, me, url); }
  }
  if (res === 'audit' && m === 'GET') {
    need('audit.view');
    return json({ events: await store.audit({ before: url.searchParams.get('before'), entityType: url.searchParams.get('type'), entityId: url.searchParams.get('id') }) });
  }
  if (res === 'settings' && m === 'GET') return json(city.settings);
  if (res === 'settings' && m === 'PUT') { need('settings.edit'); return saveSettings(request, env, city, store, me); }
  if (res === 'export' && m === 'GET') {
    need('export');
    await store.record(me.actor, 'city.export', 'city', city.id, "Downloaded a full export of the city's data");
    return json({ city: { id: city.id, slug: city.slug, name: city.name, settings: city.settings }, exported_at: now(), ...(await store.exportAll()) }, 200,
      { 'Content-Disposition': `attachment; filename="${city.slug}-export-${now().slice(0, 10)}.json"` });
  }
  return fail(404, 'Not found');
}

async function publicConfig(city, store) {
  const s = city.settings;
  return json({
    city: city.slug, cityName: s.cityName, assistantName: s.assistantName, tagline: s.tagline, greeting: s.greeting,
    brandColor: s.brandColor, suggestions: s.suggestions, phone: s.phone, policeNonEmergency: s.policeNonEmergency,
    requestTypes: (await store.requestTypes()).map(({ key, label }) => ({ key, label })),
    permits: s.permits?.construction?.enabled !== false,
  }, 200, { 'Cache-Control': 'public, max-age=60' });
}

/* ---------------- Sign-in ---------------- */

async function authRoute(request, env, url, action, m) {
  const body = m === 'POST' ? await request.json().catch(() => ({})) : {};
  const ip = request.headers.get('CF-Connecting-IP') || 'anon';
  const limited = async () => env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: `login:${ip}` })).success;

  if (action === 'check' && m === 'GET') return (await who(request, env, null)) ? json({ ok: true }) : fail(401, 'Not signed in');

  if (action === 'login' && m === 'POST') {
    if (await limited()) return fail(429, 'Too many attempts. Please wait a minute.');
    const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
    const password = String(body.password || '');
    if (!email || !password) return fail(400, 'Enter your email and password');
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    const result = await authService(env).verify(email, password, user?.password_hash || null);
    if (result === 'locked') return fail(429, 'Too many failed attempts. Try again in 15 minutes, or ask your administrator for a new setup link.');
    if (result !== 'ok' || user.status !== 'active') return fail(401, "That email and password don't match an active account.");
    const token = await createSession(env, request, { userId: user.id });
    await env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run();
    await platformAudit(env, request, { type: 'staff', id: user.id, name: user.name }, 'auth.login', `${user.name} signed in`);
    return json(await meFor(env, { user: { id: user.id, name: user.name, email: user.email } }), 200, { 'Set-Cookie': sessionCookie(token, request) });
  }

  if (action === 'operator' && m === 'POST') {
    if (await limited()) return fail(429, 'Too many attempts. Please wait a minute.');
    if (!isOperatorKey(env, String(body.code || '').trim())) return fail(401, 'That access code is not valid.');
    const token = await createSession(env, request, { operator: true });
    await platformAudit(env, request, { type: 'operator', name: 'City Hall OS support' }, 'auth.operator', 'Operator signed in with the platform access code');
    return json(await meFor(env, { operator: true }), 200, { 'Set-Cookie': sessionCookie(token, request) });
  }

  if (action === 'logout' && m === 'POST') {
    const s = await sessionFrom(env, request);
    if (s) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.sessionId).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(null, request) });
  }

  if (action === 'me' && m === 'GET') {
    const bearer = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const s = bearer && isOperatorKey(env, bearer) ? { operator: true } : await sessionFrom(env, request);
    return s ? json(await meFor(env, s)) : fail(401, 'Not signed in');
  }

  // Setup links: a new account choosing its password, or a reset.
  if (action === 'setup') {
    const token = m === 'GET' ? url.searchParams.get('token') : body.token;
    const row = token && await env.DB.prepare(
      'SELECT t.id, t.expires_at, t.used_at, u.id AS user_id, u.name, u.email FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?'
    ).bind(await sha256(String(token))).first();
    if (!row || row.used_at || row.expires_at < now()) return fail(400, 'This link has expired or was already used. Ask your administrator for a new one.');
    if (m === 'GET') return json({ name: row.name, email: row.email });
    const password = String(body.password || '');
    if (password.length < 10) return fail(400, 'Use at least 10 characters.');
    const hash = await authService(env).hash(password);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?, status = 'active', last_login_at = ? WHERE id = ?").bind(hash, now(), row.user_id),
      env.DB.prepare('UPDATE auth_tokens SET used_at = ? WHERE id = ?').bind(now(), row.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.user_id),
    ]);
    await platformAudit(env, request, { type: 'staff', id: row.user_id, name: row.name }, 'auth.password', `${row.name} set a password`);
    const session = await createSession(env, request, { userId: row.user_id });
    return json(await meFor(env, { user: { id: row.user_id, name: row.name, email: row.email } }), 200, { 'Set-Cookie': sessionCookie(session, request) });
  }
  return fail(404, 'Not found');
}

// The signed-in person and the cities they can open, with their role in each.
async function meFor(env, s) {
  const profile = (c) => ({
    slug: c.slug, name: c.name, shortName: c.settings.shortName, county: c.county, state: c.settings.state,
    publicSite: c.settings.publicSite, brandColor: c.settings.brandColor, requestPrefix: c.settings.requestPrefix, status: c.status,
  });
  let cities;
  if (s.operator) {
    const { results } = await env.DB.prepare("SELECT * FROM cities WHERE status != 'archived' ORDER BY name").all();
    cities = results.map((r) => ({ ...profile(toCity(r)), role: 'admin', perms: ['*'] }));
  } else {
    const { results } = await env.DB.prepare(
      `SELECT c.*, m.role, m.department_id, m.staff_id FROM memberships m JOIN cities c ON c.id = m.city_id
       WHERE m.user_id = ? AND c.status IN ('active', 'onboarding', 'suspended') ORDER BY c.name`
    ).bind(s.user.id).all();
    cities = results.map((r) => ({ ...profile(toCity(r)), role: r.role, perms: ROLES[r.role].perms, department_id: r.department_id, staff_id: r.staff_id }));
  }
  return {
    operator: !!s.operator, user: s.user || null, cities,
    roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description })),
  };
}

/* ---------------- Platform operator ---------------- */

async function platformRoute(request, env, url, parts, m) {
  const me = await who(request, env, null);
  if (!me?.operator) return fail(401, 'City Hall OS operator access required');
  const [res, slug, action] = parts;
  if (res !== 'cities') return fail(404, 'Not found');

  if (!slug && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM cities ORDER BY name').all();
    const cities = await Promise.all(results.map(async (r) => {
      const c = toCity(r);
      return { id: c.id, slug: c.slug, name: c.name, state: c.state, county: c.county, status: c.status, timezone: c.timezone,
        stats: url.searchParams.get('stats') ? await storeFor(env, c).stats() : undefined };
    }));
    return json({ cities });
  }

  if (!slug && m === 'POST') {
    const b = await request.json();
    const state = String(b.state || '').toUpperCase();
    const name = String(b.name || '').trim();
    const shortName = String(b.shortName || name.replace(/^(City|Town|Village) of /i, '')).trim();
    const newSlug = String(b.slug || shortName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = String(b.id || `${state.toLowerCase()}-${shortName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    if (!name || !STATE_NAMES[state]) return fail(400, 'A name and a two-letter state are required');
    if (!/^[a-z0-9-]{2,40}$/.test(newSlug) || !/^[a-z]{2}-[a-z0-9-]{2,40}$/.test(id)) return fail(400, 'Invalid slug or id');
    if (await env.DB.prepare('SELECT 1 FROM cities WHERE id = ? OR slug = ?').bind(id, newSlug).first()) return fail(409, 'A city with that id or slug already exists');
    const settings = { ...defaultSettings({ name, shortName, prefix: b.requestPrefix }), ...(b.settings || {}) };
    delete settings.cityName;
    await env.DB.prepare('INSERT INTO cities (id, slug, name, state, county, timezone, status, settings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, newSlug, name, state, b.county || null, b.timezone || 'America/Chicago', b.status || 'onboarding', JSON.stringify(settings)).run();
    await storeFor(env, { id }).init(id, me.actor);
    await platformAudit(env, request, me.actor, 'city.create', `Added ${name}, ${state}`, id);
    return json({ city: toCity(await env.DB.prepare('SELECT * FROM cities WHERE id = ?').bind(id).first()) }, 201);
  }

  const city = slug && await getCity(env, slug);
  if (!city) return fail(404, 'Unknown city');
  if (action === 'import-legacy' && m === 'POST') {
    const store = storeFor(env, city);
    await store.init(city.id, me.actor);
    return json(await store.importLegacy(city.slug, city.settings.requestPrefix, me.actor));
  }
  if (action === 'status' && m === 'PUT') {
    const { status } = await request.json();
    if (!['onboarding', 'active', 'suspended', 'archived'].includes(status)) return fail(400, 'Invalid status');
    await env.DB.prepare('UPDATE cities SET status = ?, updated_at = ? WHERE id = ?').bind(status, now(), city.id).run();
    cityCache.delete(city.slug);
    await storeFor(env, city).record(me.actor, 'city.status', 'city', city.id, `City status set to ${status}`, { status: [city.status, status] });
    return json({ ok: true });
  }
  return fail(404, 'Not found');
}

/* ---------------- Chat ---------------- */

async function chat(request, env, ctx, city, store, me) {
  const body = await request.json().catch(() => ({}));
  const question = String(body.message || '').trim().slice(0, 1200);
  if (!question) return fail(400, 'Message is required');
  const staff = me?.can('assistant.test') && body.mode === 'staff';

  if (env.CHAT_LIMIT && !me) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const { success } = await env.CHAT_LIMIT.limit({ key: `${city.id}:${ip}` });
    if (!success) return fail(429, 'Too many messages. Please wait a minute and try again.');
  }

  const channel = staff ? 'staff-test' : ['voice', 'sms'].includes(body.channel) ? body.channel : 'web';
  const { convoId, history } = await store.beginTurn({
    convoId: typeof body.convoId === 'string' && /^c[a-f0-9]{12}$/.test(body.convoId) ? body.convoId : null,
    channel, pageUrl: String(body.pageUrl || '').slice(0, 300) || null,
    contact: channel === 'web' ? null : String(body.from || '').slice(0, 40) || null, question,
  });

  const s = city.settings;
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (event, data) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const run = async () => {
    let answer = '';
    let sources = [];
    let flags = { needsStaff: false, offerReport: false, emergency: false, offerPermit: false };
    let reportType = null;
    try {
      const emergency = isEmergency(question);
      const type = emergency ? null : (await store.requestTypes()).find((t) => t.key === detectReport(question));
      if (type) {
        reportType = type.key;
        flags.offerReport = true;
        answer = `Thanks for letting us know. I can send this straight to **${type.department}** as a "${type.label.toLowerCase()}" request. ` +
          `Tap **Report this issue** below to add the location and any details, and you'll get a tracking number.`;
        await send('meta', { convoId, sources: [] });
        await send('delta', { t: answer });
      } else if (emergency) {
        flags.emergency = true;
        answer = `**If this is an emergency, call 911 now.** I'm an automated assistant and can't dispatch help.\n\n` +
          (s.policeNonEmergency ? `For a non-emergency police matter, call ${s.shortName} Police at ${s.policeNonEmergency}. ` : '') +
          (s.phone ? `For anything else, City Hall is at ${s.phone}.` : '');
        await send('meta', { convoId, sources: [] });
        await send('delta', { t: answer });
      } else {
        // Short follow-ups ("what about fences?") search better with the previous question attached.
        const lastUser = [...history].reverse().find((h) => h.role === 'user');
        const q = question.split(/\s+/).length < 6 && lastUser ? `${lastUser.content} ${question}` : question;
        const hits = await search(env, store, s, q, { includeInternal: staff, limit: 6 });
        sources = [
          { n: 1, title: 'City Hall contact information', category: 'City profile', url: s.website || null, as_of: 'current', authority: 'staff-note' },
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
      const msg = `Sorry, I had trouble answering just now. Please try again${s.phone ? `, or call City Hall at ${s.phone}` : ''}.`;
      answer += (answer ? '\n\n' : '') + msg;
      await send('delta', { t: msg }).catch(() => {});
    }

    flags.offerPermit = !flags.emergency && !reportType && s.permits?.construction?.enabled !== false && detectPermit(question);
    const cited = citedNumbers(answer);
    const used = sources.filter((x) => cited.has(x.n));
    await send('done', { convoId, flags, cited: [...cited], reportType }).catch(() => {});
    await writer.close().catch(() => {});

    await store.finishTurn({
      convoId, answer,
      sources: (used.length ? used : sources.slice(0, 3)).map(({ score, excerpt, ...x }) => x),
      flag: flags.emergency ? 'emergency' : flags.needsStaff ? 'needs_staff' : flags.offerReport ? 'report' : null,
      model: flags.emergency || reportType ? 'rule' : modelName(env),
      status: flags.emergency ? 'emergency' : flags.needsStaff ? 'needs_review' : null,
      citedDocIds: used.filter((u) => u.docId).map((u) => u.docId),
    });
  };
  ctx.waitUntil(run());
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...CORS },
  });
}

/* ---------------- Knowledge base ---------------- */

function clean(v, max = 300) { return v == null || v === '' ? null : String(v).trim().slice(0, max); }

const VERIFICATION = ['verified_current', 'official_unverified', 'historical', 'secondary', 'unverified'];
function defaultVerification(authority) {
  return { 'media-report': 'secondary', 'curated-research': 'unverified', 'staff-note': 'verified_current' }[authority] || 'official_unverified';
}

function prettyName(name) {
  return name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
}

async function getDocument(store, id) {
  const found = await store.getDocument(id);
  return found ? json(found) : fail(404, 'Document not found');
}

async function addDocuments(request, env, city, store, me) {
  const ct = request.headers.get('Content-Type') || '';
  const created = [];
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const meta = Object.fromEntries(['title', 'category', 'source_url', 'authority', 'visibility', 'verification', 'as_of', 'notes', 'text'].map((k) => [k, form.get(k)]));
    const files = form.getAll('file').filter((f) => typeof f === 'object');
    if (!files.length) return fail(400, 'Attach at least one file');
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length > 50 * 1024 * 1024) { created.push({ title: f.name, status: 'error', error: 'File is larger than 50 MB' }); continue; }
      const title = files.length === 1 && meta.title ? meta.title : prettyName(f.name);
      created.push(await ingest(env, city, store, me, { ...meta, title, bytes, file_name: f.name, mime: f.type || guessMime(f.name) }));
    }
  } else {
    const body = await request.json();
    if (body.url) {
      if (!/^https?:\/\//i.test(body.url)) return fail(400, 'Enter a web address starting with http:// or https://');
      const r = await fetch(body.url, { headers: { 'User-Agent': 'CityHallOS knowledge import' }, redirect: 'follow' });
      if (!r.ok) return fail(400, `Could not fetch that URL (${r.status})`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const mime = (r.headers.get('Content-Type') || 'text/html').split(';')[0];
      const name = decodeURIComponent(new URL(r.url).pathname.split('/').pop() || 'page') + (mime.includes('html') ? '.html' : '');
      created.push(await ingest(env, city, store, me, { ...body, title: body.title || prettyName(name), source_url: body.source_url || body.url, bytes, file_name: name, mime }));
    } else if (body.text) {
      created.push(await ingest(env, city, store, me, { ...body, title: body.title || 'Staff note', authority: body.authority || 'staff-note' }));
    } else {
      return fail(400, 'Send a file, a URL, or text');
    }
  }
  return json({ documents: created }, 201);
}

async function ingest(env, city, store, me, d) {
  const id = uid('d');
  const authority = clean(d.authority, 40) || 'official-city';
  const doc = {
    id, title: clean(d.title, 200) || 'Untitled document', category: clean(d.category, 60) || 'General',
    source_url: clean(d.source_url, 500), authority, visibility: d.visibility === 'internal' ? 'internal' : 'public',
    as_of: clean(d.as_of, 40), notes: clean(d.notes, 2000),
    verification: VERIFICATION.includes(d.verification) ? d.verification : defaultVerification(authority),
    file_name: clean(d.file_name, 200), mime: clean(d.mime, 120), bytes: d.bytes?.length || 0, file_key: null,
  };
  if (d.bytes) {
    doc.file_key = `${city.id}/documents/${id}/${(doc.file_name || 'file').replace(/[^\w.-]+/g, '_')}`;
    await env.FILES.put(doc.file_key, d.bytes, { httpMetadata: { contentType: doc.mime || 'application/octet-stream' } });
  }
  await store.createDocument(doc, me.actor);
  return processDocument(env, store, doc, d.text ? String(d.text) : null, d.bytes, me);
}

async function processDocument(env, store, doc, text, bytes, me, reason) {
  try {
    if (!text) text = await extractText(env, { bytes, name: doc.file_name, mime: doc.mime });
    if (!text || text.replace(/\s/g, '').length < 30) {
      throw new Error('No readable text found. If this is a scanned document, paste its text in the document details.');
    }
    return await store.indexDocument(doc.id, chunkText(text), text.length, me.actor, reason);
  } catch (e) {
    return store.failDocument(doc.id, e.message);
  }
}

async function updateDocument(request, env, store, id, me) {
  const doc = await store.documentRow(id);
  if (!doc) return fail(404, 'Document not found');
  const b = await request.json();
  const patch = {};
  if (b.title !== undefined) patch.title = clean(b.title, 200) ?? doc.title;
  if (b.category !== undefined) patch.category = clean(b.category, 60) ?? doc.category;
  if (b.authority !== undefined) patch.authority = clean(b.authority, 40) ?? doc.authority;
  if (b.visibility) patch.visibility = b.visibility === 'internal' ? 'internal' : 'public';
  if (VERIFICATION.includes(b.verification)) patch.verification = b.verification;
  for (const [k, max] of [['source_url', 500], ['as_of', 40], ['notes', 2000]]) if (k in b) patch[k] = clean(b[k], max);
  await store.updateDocument(id, patch, me.actor);
  if (b.text) await processDocument(env, store, { ...doc, ...patch }, String(b.text), null, me, 'Replaced the text of');
  return getDocument(store, id);
}

async function deleteDocument(env, store, id, me) {
  const doc = await store.deleteDocument(id, me.actor);
  if (!doc) return fail(404, 'Document not found');
  if (doc.file_key) await env.FILES.delete(doc.file_key);
  return json({ ok: true });
}

async function reprocessDocument(env, store, id, me) {
  const doc = await store.documentRow(id);
  if (!doc?.file_key) return fail(400, 'This document has no file to reprocess');
  const obj = await env.FILES.get(doc.file_key);
  if (!obj) return fail(404, 'Stored file is missing');
  return json({ document: await processDocument(env, store, doc, null, new Uint8Array(await obj.arrayBuffer()), me, 'Re-indexed') });
}

async function documentFile(env, store, id, me) {
  const doc = await store.documentRow(id);
  if (!doc?.file_key || (doc.visibility !== 'public' && !me?.can('knowledge.view'))) return fail(404, 'File not found');
  const obj = await env.FILES.get(doc.file_key);
  if (!obj) return fail(404, 'File not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${(doc.file_name || 'document').replace(/"/g, '')}"`,
      'Cache-Control': doc.visibility === 'public' ? 'public, max-age=3600' : 'private, no-store', ...CORS,
    },
  });
}

async function listForms(city, store) {
  const forms = await store.listForms();
  return json({ forms: forms.map((f) => ({ id: f.id, title: f.title, description: f.notes, as_of: f.as_of, verification: f.verification,
    url: f.source_url || (f.has_file ? `/api/${city.slug}/documents/${f.id}/file` : null) })) }, 200, { 'Cache-Control': 'public, max-age=300' });
}

async function searchPreview(env, city, store, url) {
  const hits = await search(env, store, city.settings, url.searchParams.get('q') || '', { includeInternal: true, limit: 8 });
  return json({
    results: hits.map((h) => ({ docId: h.doc.id, title: h.doc.title, category: h.doc.category, heading: h.heading, score: h.score, text: h.text })),
  });
}

/* ---------------- Conversations ---------------- */

async function getConversation(store, id) {
  const found = await store.getConversation(id);
  return found ? json(found) : fail(404, 'Conversation not found');
}

async function updateConversation(request, store, id, me) {
  const b = await request.json();
  if (!['answered', 'needs_review', 'reviewed', 'emergency'].includes(b.status)) return fail(400, 'Invalid status');
  const found = await store.setConversationStatus(id, b.status, me.actor);
  return found ? json(found) : fail(404, 'Conversation not found');
}

/* ---------------- Service requests ---------------- */

const REQUEST_STATUSES = ['new', 'needs_info', 'assigned', 'in_progress', 'awaiting_review', 'resolved', 'closed'];

function summarize(label, location, description) {
  const text = description.split(/\n+/).map((p) => p.trim().replace(/[.!?]?$/, '.')).join(' ');
  return `${label}${location ? ` at ${location}` : ''}. ${text.length > 200 ? text.slice(0, 197) + '…' : text}`;
}

// Resident contact details are only shown to roles that work requests.
const redact = (r, me) => (me.can('residents.contact') ? r : { ...r, name: r.name ? 'Hidden' : null, contact: r.contact ? 'Hidden' : null });

async function createRequest(request, env, city, store, me) {
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
  const description = clean(b.description, 2000);
  if (!description) return fail(400, 'Please describe the issue');
  const types = await store.requestTypes();
  const type = types.find((t) => t.key === b.category) || types.find((t) => t.key === 'other');
  const location = clean(b.location, 300);
  const byStaff = me?.can('requests.create');
  const convoId = clean(b.convoId, 20);
  const actor = byStaff ? me.actor : { type: 'resident', id: null, name: convoId ? `Resident via ${city.settings.assistantName}` : 'Resident' };
  const created = await store.createRequest({
    type_key: type.key, description, summary: summarize(type.label, location, description), location,
    name: clean(b.name, 120), contact: clean(b.contact, 160), convo_id: convoId,
    source: byStaff ? 'staff' : convoId ? 'chat' : ['voice', 'sms'].includes(b.channel) ? b.channel : 'web',
  }, actor, city.settings.requestPrefix);
  if (photo && photo.size < 10 * 1024 * 1024 && /^image\//.test(photo.type)) {
    const key = `${city.id}/requests/${created.id}/${photo.name.replace(/[^\w.-]+/g, '_')}`;
    await env.FILES.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
    await store.setRequestPhoto(created.id, key);
  }
  return json({ ref: created.ref, department: created.department, status: 'new' }, 201);
}

async function trackRequest(store, ref) {
  ref = String(ref).toUpperCase().trim();
  if (/-BP-\d+$/.test(ref)) {
    const p = await store.trackPermit(ref);
    return p ? json(p) : fail(404, 'No permit application with that number');
  }
  const r = await store.trackRequest(ref);
  return r ? json(r) : fail(404, 'No request with that number');
}

async function listRequests(store, me) {
  const requests = await store.listRequests({ departmentId: me.departmentId });
  return json({ requests: requests.map((r) => redact(r, me)) });
}

async function updateRequest(request, store, id, me) {
  const r = await store.getRequest(Number(id));
  if (!r) return fail(404, 'Request not found');
  if (me.departmentId && r.department_id !== me.departmentId) return fail(403, 'This request belongs to another department');
  const b = await request.json();
  const patch = {};
  if (REQUEST_STATUSES.includes(b.status)) patch.status = b.status;
  if (['low', 'normal', 'high', 'urgent'].includes(b.priority)) patch.priority = b.priority;
  if ('assignee_id' in b) patch.assignee_id = clean(b.assignee_id, 20);
  if (b.department_id) patch.department_id = clean(b.department_id, 60);
  if (b.note) patch.note = clean(b.note, 1000);
  try {
    return json({ request: redact(await store.updateRequest(Number(id), patch, me.actor), me) });
  } catch (e) {
    return fail(400, e.message);
  }
}

async function requestPhoto(env, store, id, me) {
  const r = await store.requestPhotoKey(Number(id));
  if (r && me.departmentId && r.department_id !== me.departmentId) return fail(404, 'No photo');
  const obj = r?.photo_key && (await env.FILES.get(r.photo_key));
  if (!obj) return fail(404, 'No photo');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, no-store' } });
}

/* ---------------- Staff and roles ---------------- */

async function listStaff(env, city, store, me) {
  const [staff, { results: members }] = await Promise.all([
    store.staff(),
    env.DB.prepare(`SELECT m.staff_id, m.role, u.email, u.status, u.last_login_at FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.city_id = ?`).bind(city.id).all(),
  ]);
  const byStaff = new Map(members.map((x) => [x.staff_id, x]));
  const manage = me.can('staff.manage');
  return json({
    staff: staff.map((s) => {
      const a = byStaff.get(s.id);
      return { ...s, has_access: !!a, access: manage && a ? { role: a.role, email: a.email, status: a.status, last_login_at: a.last_login_at } : null };
    }),
    roles: Object.entries(ROLES).map(([key, r]) => ({ key, label: r.label, description: r.description })),
  });
}

function staffInput(b) {
  return {
    name: clean(b.name, 120), title: clean(b.title, 120), department_id: clean(b.department_id, 60),
    email: clean(b.email, 200)?.toLowerCase() ?? null, phone: clean(b.phone, 40),
  };
}

// Gives a directory entry dashboard access with a role. Returns a setup link when the person has no password yet.
async function grantAccess(env, city, store, me, staff, role, url) {
  if (!ROLES[role]) throw httpError(400, 'Choose a role');
  if (!staff.email) throw httpError(400, 'An email address is needed for dashboard access');
  if (role === 'department' && !staff.department_id) throw httpError(400, 'Choose a department for department staff');
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(staff.email).first();
  if (!user) {
    user = { id: uid('u'), email: staff.email, name: staff.name, status: 'invited' };
    await env.DB.prepare("INSERT INTO users (id, email, name, status) VALUES (?, ?, ?, 'invited')").bind(user.id, user.email, user.name).run();
  }
  if (await env.DB.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND city_id = ?').bind(user.id, city.id).first()) {
    throw httpError(409, `${staff.email} already has access to ${city.name}`);
  }
  await env.DB.prepare('INSERT INTO memberships (user_id, city_id, role, department_id, staff_id) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, city.id, role, role === 'department' ? staff.department_id : null, staff.id).run();
  await store.updateStaff(staff.id, { user_id: user.id }, me.actor, `Gave ${staff.name} dashboard access as ${ROLES[role].label}`);
  if (user.status === 'active') return null;
  return `${url.origin}/#/setup/${await createSetupToken(env, user.id)}`;
}

async function addStaff(request, env, city, store, me, url) {
  const b = await request.json();
  const p = staffInput(b);
  if (!p.name) return fail(400, 'Enter a name');
  if (b.role && !p.email) return fail(400, 'An email address is needed for dashboard access');
  if (b.role === 'department' && !p.department_id) return fail(400, 'Choose a department for department staff');
  const staff = await store.addStaff(p, me.actor);
  const setupUrl = b.role ? await grantAccess(env, city, store, me, staff, b.role, url) : null;
  return json({ staff: await store.staffMember(staff.id), setupUrl }, 201);
}

async function updateStaff(request, env, city, store, id, me, url) {
  const staff = await store.staffMember(id);
  if (!staff) return fail(404, 'Staff member not found');
  const b = await request.json();
  const membership = staff.user_id && await env.DB.prepare('SELECT * FROM memberships WHERE user_id = ? AND city_id = ?').bind(staff.user_id, city.id).first();
  if (me.user && staff.user_id === me.user.id && (('role' in b && b.role !== membership?.role) || b.active === false)) {
    return fail(400, "You can't change your own access. Ask another administrator.");
  }

  const input = staffInput(b);
  const patch = Object.fromEntries(Object.entries(input).filter(([k]) => k in b));
  if ('active' in b) patch.active = b.active ? 1 : 0;
  if (membership && 'email' in patch && patch.email !== staff.email) return fail(400, "The email of someone with dashboard access can't be changed here");
  const role = b.active === false ? '' : 'role' in b ? b.role || '' : membership?.role || '';
  const deptId = 'department_id' in patch ? patch.department_id : staff.department_id;
  if (role && !ROLES[role]) return fail(400, 'Choose a role');
  if (role === 'department' && !deptId) return fail(400, 'Choose a department for department staff');
  let updated = await store.updateStaff(id, patch, me.actor);

  let setupUrl = null;
  if (membership && !role) {
    await env.DB.prepare('DELETE FROM memberships WHERE user_id = ? AND city_id = ?').bind(staff.user_id, city.id).run();
    await store.record(me.actor, 'access.revoke', 'staff', id, `Removed ${staff.name}'s dashboard access`, { role: [membership.role, null] });
  } else if (membership && (role !== membership.role || (role === 'department' && deptId !== membership.department_id))) {
    await env.DB.prepare('UPDATE memberships SET role = ?, department_id = ? WHERE user_id = ? AND city_id = ?')
      .bind(role, role === 'department' ? deptId : null, staff.user_id, city.id).run();
    await store.record(me.actor, 'access.role', 'staff', id, `Changed ${staff.name}'s role to ${ROLES[role].label}`, { role: [membership.role, role] });
  } else if (!membership && role) {
    if (staff.user_id) { // had access before; the account still exists
      await env.DB.prepare('INSERT INTO memberships (user_id, city_id, role, department_id, staff_id) VALUES (?, ?, ?, ?, ?)')
        .bind(staff.user_id, city.id, role, role === 'department' ? deptId : null, id).run();
      await store.record(me.actor, 'access.grant', 'staff', id, `Gave ${staff.name} dashboard access as ${ROLES[role].label}`, { role: [null, role] });
    } else {
      setupUrl = await grantAccess(env, city, store, me, updated, role, url);
    }
  }
  updated = await store.staffMember(id);
  return json({ staff: updated, setupUrl });
}

async function newSetupLink(env, city, store, id, me, url) {
  const staff = await store.staffMember(id);
  const membership = staff?.user_id && await env.DB.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND city_id = ?').bind(staff.user_id, city.id).first();
  if (!membership) return fail(400, 'This person has no dashboard access');
  const token = await createSetupToken(env, staff.user_id);
  await store.record(me.actor, 'access.setup_link', 'staff', id, `Created a password setup link for ${staff.name}`);
  return json({ setupUrl: `${url.origin}/#/setup/${token}` });
}

/* ---------------- Overview & settings ---------------- */

async function overview(env, city, store) {
  const o = await store.overview(tzModifier(city.timezone));
  return json({ ...o, city: { slug: city.slug, name: city.settings.cityName }, model: modelName(env) });
}

const EDITABLE_SETTINGS = ['shortName', 'assistantName', 'tagline', 'greeting', 'brandColor', 'suggestions', 'phone', 'address', 'hours', 'website',
  'publicSite', 'policeNonEmergency', 'profileNotes', 'disambiguation'];

async function saveSettings(request, env, city, store, me) {
  const b = await request.json();
  const row = await env.DB.prepare('SELECT settings FROM cities WHERE id = ?').bind(city.id).first();
  const stored = JSON.parse(row.settings || '{}');
  const changes = {};
  for (const k of EDITABLE_SETTINGS) {
    if (!(k in b)) continue;
    const v = k === 'suggestions' ? (Array.isArray(b[k]) ? b[k].map((x) => clean(x, 100)).filter(Boolean).slice(0, 6) : []) : clean(b[k], 1200) ?? '';
    if ((k === 'brandColor' && !/^#[0-9a-f]{6}$/i.test(v)) || (k === 'shortName' && !v)) continue;
    if (JSON.stringify(city.settings[k] ?? '') !== JSON.stringify(v)) changes[k] = [city.settings[k] ?? null, v];
    stored[k] = v;
  }
  if (b.permits && typeof b.permits === 'object') {
    const next = permitSettings(b.permits, stored.permits || {});
    if (JSON.stringify(next) !== JSON.stringify(stored.permits || {})) changes.permits = [stored.permits || null, next];
    stored.permits = next;
  }
  await env.DB.prepare('UPDATE cities SET settings = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(stored), now(), city.id).run();
  cityCache.delete(city.slug);
  if (Object.keys(changes).length) {
    await store.record(me.actor, 'settings.update', 'settings', null, `Changed ${Object.keys(changes).join(', ')} in Settings`, changes);
  }
  return json((await getCity(env, city.slug)).settings);
}

// Permit options staff can change. Fee tiers follow the shape permitFee() in permits/construction.js reads.
function permitSettings(input, current) {
  const c = { ...(current.construction || {}) };
  const b = input.construction || {};
  if ('enabled' in b) c.enabled = !!b.enabled;
  if ('autoReturn' in b) c.autoReturn = !!b.autoReturn;
  if ('paymentInstructions' in b) c.paymentInstructions = clean(b.paymentInstructions, 600) ?? '';
  if ('department' in b) c.department = clean(b.department, 60) ?? 'planning-building';
  if ('formUrl' in b) c.formUrl = clean(b.formUrl, 500);
  if ('pdfTemplate' in b) c.pdfTemplate = clean(b.pdfTemplate, 60);
  if (b.fees && typeof b.fees === 'object') {
    const tiers = (Array.isArray(b.fees.tiers) ? b.fees.tiers : []).slice(0, 20).map((t) => ({
      upTo: t.upTo == null ? null : Number(t.upTo),
      ...(t.fee != null ? { fee: Number(t.fee) } : { base: Number(t.base), over: Number(t.over), per: Number(t.per) || 1000, add: Number(t.add) }),
    })).filter((t) => Object.values(t).every((v) => v === null || Number.isFinite(v)));
    c.fees = {
      tiers, doubleIfStarted: !!b.fees.doubleIfStarted, planReviewShare: Number(b.fees.planReviewShare) || 0,
      notes: (Array.isArray(b.fees.notes) ? b.fees.notes : []).map((x) => clean(x, 300)).filter(Boolean).slice(0, 10), source: clean(b.fees.source, 300),
    };
  }
  return { ...current, construction: c };
}
