// Resident accounts: sign in with a phone number and a texted code. No passwords; everyone has a phone.
//
// A signed-in resident's applications follow them to any device (My applications), and their name, email and
// mailing address fill in new applications. Without an account everything still works through each
// application's secret link; signing in just keeps those links for you.
//
//   POST /api/{city}/me/code    { phone }          text a 6-digit code (valid 10 minutes, 5 tries)
//   POST /api/{city}/me/verify  { phone, code }    sign in → { token }; the browser sends it as X-Resident-Token
//   GET  /api/{city}/me                            profile and applications
//   PATCH /api/{city}/me        { name, email, mailing }
//   POST /api/{city}/me/claim   { applications: [{ id, token }] }   add applications started on this device
//   POST /api/{city}/me/logout
import { sha256 } from './auth.js';
import { notify, channels } from './notify.js';
import { formFor } from './permits/forms/index.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...CORS } });
const fail = (status, error) => json({ error }, status);

// US numbers only, stored as 10 digits.
export function normalPhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? ten : null;
}
const pretty = (p) => `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;

export async function residentFrom(request, store) {
  const token = request.headers.get('X-Resident-Token');
  if (!token || token.length < 20) return null;
  const r = await store.residentBySession(await sha256(token));
  return r ? { ...r, phone: pretty(r.phone) } : null;
}

function profileView(r) {
  return { id: r.id, phone: r.phone, name: r.name, email: r.email, mailing: r.mailing };
}

export async function residentRoute({ request, env, url, city, store, sub, tokenFor }) {
  const m = request.method;
  const b = m === 'POST' || m === 'PATCH' ? await request.json().catch(() => ({})) : {};
  const ip = request.headers.get('CF-Connecting-IP') || 'anon';

  if (sub === 'code' && m === 'POST') {
    if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: `resident:${ip}` })).success) return fail(429, 'Too many tries. Please wait a minute.');
    const phone = normalPhone(b.phone);
    if (!phone) return fail(400, 'Enter a 10-digit U.S. phone number.');
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0');
    if (!(await store.saveResidentCode(phone, await sha256(`${phone}:${code}`)))) return fail(429, 'Too many codes sent to this number. Try again in an hour, or call City Hall.');
    const [r] = await notify(env, store, city, {
      entityType: 'resident', entityId: null, to: { phone, pref: 'sms' },
      msg: { subject: 'Sign-in code', sms: `Your sign-in code is ${code}. It expires in 10 minutes. Don't share it with anyone.`, secret: true },
    });
    // Local development has no text messages, so the code comes back in the response there.
    const dev = env.DEV_SHOW_CODES === '1' && r.status !== 'sent';
    if (r.status !== 'sent' && !dev) return fail(503, `Text messages aren't set up for ${city.settings.shortName} yet, so sign-in isn't available. Your applications are still saved on this device.`);
    return json({ sent: true, phone: pretty(phone), ...(dev ? { devCode: code } : {}), sms: channels(env).sms });
  }

  if (sub === 'verify' && m === 'POST') {
    if (env.LOGIN_LIMIT && !(await env.LOGIN_LIMIT.limit({ key: `resident:${ip}` })).success) return fail(429, 'Too many tries. Please wait a minute.');
    const phone = normalPhone(b.phone);
    const code = String(b.code || '').replace(/\D/g, '');
    if (!phone || code.length !== 6) return fail(400, 'Enter the 6-digit code we texted you.');
    const r = await store.verifyResidentCode(phone, await sha256(`${phone}:${code}`));
    if (!r) return fail(400, "That code didn't work. Check it, or tap Send a new code.");
    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await store.createResidentSession(await sha256(token), r.id);
    return json({ token, profile: profileView({ ...r, phone: pretty(r.phone) }) });
  }

  const me = await residentFrom(request, store);
  if (!me) return fail(401, 'Please sign in with your phone number');

  if (!sub && m === 'GET') {
    const apps = await Promise.all((await store.residentPermits(me.id)).filter((p) => formFor(p.kind)).map(async (p) => ({
      ...p, title: formFor(p.kind).short, token: await tokenFor(env, p.id),
    })));
    return json({ profile: profileView(me), applications: apps });
  }

  if (!sub && m === 'PATCH') {
    const clean = (v, max) => (v == null ? undefined : String(v).trim().slice(0, max) || null);
    const mail = b.mailing && typeof b.mailing === 'object' ? Object.fromEntries(['street', 'city', 'state', 'zip'].map((k) => [k, clean(b.mailing[k], 120) || null])) : me.mailing;
    const email = clean(b.email, 200);
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return fail(400, "That email address doesn't look right.");
    const r = await store.updateResident(me.id, { name: clean(b.name, 120) ?? me.name, email: email === undefined ? me.email : email, mailing: mail?.street ? mail : null });
    return json({ profile: profileView({ ...r, phone: me.phone }) });
  }

  if (sub === 'claim' && m === 'POST') {
    let n = 0;
    for (const a of (Array.isArray(b.applications) ? b.applications : []).slice(0, 20)) {
      const p = a?.id && await store.permit(String(a.id));
      if (p && p.token_hash === await sha256(String(a.token || ''))) { await store.claimPermit(p.id, me.id); n++; }
    }
    return json({ claimed: n });
  }

  if (sub === 'logout' && m === 'POST') {
    await store.endResidentSession(await sha256(request.headers.get('X-Resident-Token')));
    return json({ ok: true });
  }

  return fail(404, 'Not found');
}
