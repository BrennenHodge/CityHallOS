// Public Works dispatcher, the Worker's side: API routes for the dispatch board, crews, work orders, the map and
// the field view, plus geocoding typed addresses and telling residents when their report is scheduled or done.
// The data and the rules live in dispatch-store.js, inside each city's store.
import { addDays, longDate, validDate } from './dispatch-store.js';

export const DISPATCH_RESOURCES = new Set(['dispatch', 'crews', 'work-orders', 'field']);

// Departments that get a dispatch board even before they have crews. Any department with a crew gets one too.
const DISPATCH_DEPARTMENTS = ['public-works', 'water-sewer'];

const clean = (v, max = 300) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);

// Today's date where the city is, as YYYY-MM-DD.
export function cityDate(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// The departments this person dispatches for: their own, or for administrators every department with field work.
async function scope(store, me, url) {
  if (me.departmentId) return [me.departmentId];
  const [departments, crews] = await Promise.all([store.departments(), store.crews()]);
  const withCrews = new Set(crews.filter((c) => c.active).map((c) => c.department_id));
  const ids = departments.filter((d) => d.active && (DISPATCH_DEPARTMENTS.includes(d.id) || withCrews.has(d.id))).map((d) => d.id);
  const want = url.searchParams.get('department');
  return want && ids.includes(want) ? [want] : ids;
}

const redactRequest = (r, me) => (me.can('residents.contact') || !r ? r : { ...r, name: r.name ? 'Hidden' : null, contact: r.contact ? 'Hidden' : null });

export async function dispatchRoute(request, { env, ctx, url, city, store, me, need, json, fail, parts }) {
  const m = request.method;
  const [, res, id, sub, subId] = parts;
  const today = cityDate(city.timezone);
  const ownDept = (deptId) => !me.departmentId || deptId === me.departmentId;
  const send = (notices) => { if (notices?.length) ctx.waitUntil(tellResidents(env, store, city, url, notices)); };
  const body = async () => request.json().catch(() => ({}));
  const attempt = async (fn) => {
    try { return await fn(); } catch (e) { if (e.status) throw e; return fail(400, e.message); }
  };

  if (res === 'dispatch') {
    // GET /dispatch/board?week=YYYY-MM-DD&department=id: this week by crew, plus everything not scheduled yet.
    if (id === 'board' && m === 'GET') {
      need('dispatch.view');
      const departmentIds = await scope(store, me, url);
      const day = validDate(url.searchParams.get('week')) ? url.searchParams.get('week') : today;
      const from = addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7)); // Monday
      if (departmentIds.length) {
        await store.refreshSuggestions({ departmentIds, today, cityWords: cityWords(city) });
        ctx.waitUntil(geocodePending(env, city, store));
      }
      const board = departmentIds.length ? await store.board({ departmentIds, from, to: addDays(from, 6) }) : { crews: [], workOrders: [], unscheduled: [], suggestions: [] };
      const departments = (await store.departments()).filter((d) => departmentIds.includes(d.id)).map(({ id: did, name }) => ({ id: did, name }));
      return json({ today, from, to: addDays(from, 6), departments, ...board, unscheduled: board.unscheduled.map((r) => redactRequest(r, me)) });
    }
    if (id === 'map' && m === 'GET') {
      need('dispatch.view');
      const departmentIds = await scope(store, me, url);
      ctx.waitUntil(geocodePending(env, city, store));
      const pts = await store.mapPoints({ departmentIds });
      return json({ today, located: pts.located.map((r) => redactRequest(r, me)), unlocated: pts.unlocated.map((r) => redactRequest(r, me)) });
    }
    // POST /dispatch/suggestions/:id { decision: 'accept' | 'dismiss', date }
    if (id === 'suggestions' && sub && m === 'POST') {
      need('dispatch.manage');
      const s = await store.suggestion(Number(sub));
      if (!s) return fail(404, 'Suggestion not found');
      if (!ownDept(s.department_id)) return fail(403, 'This request belongs to another department');
      const b = await body();
      if (!['accept', 'dismiss'].includes(b.decision)) return fail(400, 'Accept or dismiss');
      if (b.date && !validDate(b.date)) return fail(400, 'Choose a valid date');
      return attempt(async () => {
        const result = await store.decideSuggestion(s.id, b.decision, me.actor, { today, date: b.date });
        send(result.notices);
        return json({ suggestion: result.suggestion, workOrder: result.workOrder || null });
      });
    }
  }

  if (res === 'crews') {
    if (!id && m === 'GET') {
      need('dispatch.view');
      return json({ crews: await store.crews({ departmentIds: me.departmentId ? [me.departmentId] : undefined }) });
    }
    if ((m === 'POST' && !id) || (m === 'PATCH' && id && !sub)) {
      need('dispatch.manage');
      const b = await body();
      const before = id ? await store.crew(id) : null;
      if (id && !before) return fail(404, 'Crew not found');
      const deptId = clean(b.department_id, 60) || before?.department_id || me.departmentId;
      if (!ownDept(deptId) || (before && !ownDept(before.department_id))) return fail(403, 'You can only manage crews in your own department');
      const p = {};
      if ('name' in b || !id) p.name = clean(b.name, 80);
      if (deptId) p.department_id = deptId;
      if ('lead_id' in b) p.lead_id = clean(b.lead_id, 20);
      if (Array.isArray(b.members)) p.members = b.members.map((x) => clean(x, 20)).filter(Boolean).slice(0, 40);
      if ('active' in b) p.active = !!b.active;
      return attempt(async () => json({ crew: await store.saveCrew(id || null, p, me.actor) }, id ? 200 : 201));
    }
  }

  if (res === 'work-orders') {
    // GET /work-orders?request_id=: the work on one request, for the request drawer.
    if (!id && m === 'GET') {
      need('dispatch.view');
      const requestId = Number(url.searchParams.get('request_id'));
      const r = requestId && await store.getRequest(requestId);
      if (!r || !ownDept(r.department_id)) return fail(404, 'Request not found');
      const [workOrders, crews] = await Promise.all([store.workOrdersFor(requestId), store.crews({ departmentIds: [r.department_id] })]);
      return json({ workOrders, crews: crews.filter((c) => c.active), suggestions: await store.openSuggestions([requestId]) });
    }
    if (!id && m === 'POST') {
      need('dispatch.manage');
      const b = await body();
      const r = await store.getRequest(Number(b.request_id));
      if (!r) return fail(404, 'Request not found');
      if (!ownDept(r.department_id)) return fail(403, 'This request belongs to another department');
      return attempt(async () => {
        const { workOrder, notices } = await store.createWorkOrder({
          request_id: r.id, crew_id: clean(b.crew_id, 20), scheduled_date: clean(b.scheduled_date, 10), title: clean(b.title, 160),
          materials: clean(b.materials, 1000), labor_notes: clean(b.labor_notes, 1000), labor_hours: hours(b.labor_hours),
        }, me.actor, today);
        send(notices);
        return json({ workOrder }, 201);
      });
    }
    const wo = id && await store.workOrder(Number(id));
    if (id && (!wo || !ownDept(wo.department_id))) return fail(404, 'Work order not found');
    if (id && !sub && m === 'GET') { need('dispatch.view'); return json({ workOrder: wo }); }
    if (id && !sub && m === 'PATCH') {
      need('dispatch.manage');
      const b = await body();
      const p = {};
      for (const [k, max] of [['title', 160], ['materials', 1000], ['labor_notes', 1000], ['completion_note', 1000]]) if (k in b) p[k] = clean(b[k], max);
      if ('title' in p && !p.title) delete p.title;
      if ('crew_id' in b) p.crew_id = clean(b.crew_id, 20);
      if ('scheduled_date' in b) p.scheduled_date = clean(b.scheduled_date, 10);
      if ('labor_hours' in b) p.labor_hours = hours(b.labor_hours);
      if (b.status) p.status = String(b.status);
      return attempt(async () => {
        const { workOrder, notices } = await store.updateWorkOrder(wo.id, p, me.actor, today);
        send(notices);
        return json({ workOrder });
      });
    }
    // POST /work-orders/:id/photos (multipart: kind = before | after, photo)
    if (sub === 'photos' && !subId && m === 'POST') {
      need('dispatch.manage');
      const form = await request.formData().catch(() => null);
      const f = form?.get('photo');
      const kind = form?.get('kind') === 'before' ? 'before' : 'after';
      if (!f || typeof f !== 'object' || !f.size) return fail(400, 'Attach a photo');
      if (!/^image\//.test(f.type) || f.size > 10 * 1024 * 1024) return fail(400, 'Photos must be images under 10 MB');
      const ext = ({ 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' })[f.type] || 'jpg';
      const key = `${city.id}/work-orders/${wo.id}/${kind}-${Date.now()}.${ext}`;
      await env.FILES.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
      return json({ workOrder: await store.addWorkOrderPhoto(wo.id, kind, key, me.actor) }, 201);
    }
    if (sub === 'photos' && subId && m === 'GET') {
      need('dispatch.view');
      const p = await store.workOrderPhotoKey(wo.id, Number(subId));
      const obj = p && await env.FILES.get(p.file_key);
      if (!obj) return fail(404, 'No photo');
      return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' } });
    }
  }

  // GET /field?date=YYYY-MM-DD: my work today, for crews in the field.
  if (res === 'field' && !id && m === 'GET') {
    need('dispatch.manage');
    const date = validDate(url.searchParams.get('date')) ? url.searchParams.get('date') : today;
    const work = await store.fieldWork({ staffId: me.staffId, departmentIds: await scope(store, me, url), date });
    return json({ today, date, ...work, workOrders: work.workOrders.map((w) => ({ ...w, request: redactRequest(w.request, me) })) });
  }
  return fail(404, 'Not found');
}

function hours(v) {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 4) / 4;
}

// Words in the city's name, so "Pine St, Wiggins" and "Pine St" match when looking for duplicates.
const cityWords = (city) => [...String(city.settings.shortName || '').toLowerCase().split(/\s+/), String(city.state || '').toLowerCase()].filter(Boolean);

// Runs after the hook into each request creation (index.js) and when the board or map loads.
export async function afterRequestCreated(env, city, store) {
  await geocodePending(env, city, store);
}

/* ---------------- Geocoding typed addresses ---------------- */

// Free public geocoders, no keys or contracts: the US Census Bureau geocoder for street addresses, and
// OpenStreetMap's Nominatim (within its usage policy: identified, a few lookups at a time) for landmarks it misses.
// Matches more than 40 km from the city's other reports are rejected, and anything not found goes on the "no location" list.
async function geocodePending(env, city, store) {
  if (env.GEOCODER === 'off') return;
  try {
    const pending = await store.pendingGeocodes(4);
    if (!pending.length) return;
    const anchor = await store.locationAnchor();
    for (const p of pending) {
      const loc = await geocode(city, p.location, anchor);
      if (loc) await store.saveRequestLocation(p.id, loc);
    }
  } catch (e) {
    console.log('geocode error', e.message);
  }
}

async function geocode(city, text, anchor) {
  const short = city.settings.shortName || city.name;
  const address = text.toLowerCase().includes(short.toLowerCase()) ? text : `${text}, ${short}, ${city.state}`;
  const near = (lat, lng) => !anchor || Math.hypot((lat - anchor.lat) * 111, (lng - anchor.lng) * 111 * Math.cos((anchor.lat * Math.PI) / 180)) <= 40;
  const tries = [
    async () => {
      const u = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=${encodeURIComponent(address)}`;
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const hit = r.ok && (await r.json())?.result?.addressMatches?.[0];
      return hit && hit.addressComponents?.state === city.state ? { lat: hit.coordinates.y, lng: hit.coordinates.x, matched: hit.matchedAddress, source: 'US Census geocoder' } : null;
    },
    async () => {
      const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
      const r = await fetch(u, { headers: { 'User-Agent': 'CityHallOS/1.0 (https://cityhallos.com; municipal service requests)' }, signal: AbortSignal.timeout(8000) });
      const hit = r.ok && (await r.json())?.[0];
      return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), matched: hit.display_name.split(',').slice(0, 3).join(','), source: 'OpenStreetMap' } : null;
    },
  ];
  for (const t of tries) {
    try {
      const hit = await t();
      if (hit && near(hit.lat, hit.lng)) return hit;
    } catch (e) {
      console.log('geocoder unavailable', e.message);
      return null; // not recorded, so it's tried again on the next board or map load
    }
  }
  return { source: 'not found', lat: null };
}

/* ---------------- Telling residents ---------------- */

// HOOK(notify.js): resident messages go through notify() from platform/src/notify.js (email via Resend, texts and calls
// via Twilio, every message recorded in the outbox). That module is being added on main by the Permitting branch;
// once it lands, replace this stub with `import { notify } from './notify.js';` and delete it. Nothing else changes.
async function notify(env, store, city, { entityType, entityId, to, msg }) {
  console.log(`[notify.js not merged yet] ${entityType} ${entityId} → ${to.email || to.phone}: ${msg.subject}`);
  return [];
}

// "Jane, 601-555-0123" or "jane@example.com" → { email, phone }.
export function contactOf(s) {
  const text = String(s || '');
  const email = text.match(/[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}/i)?.[0] || null;
  const phone = text.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0] || null;
  return email || phone ? { email, phone } : null;
}

export function residentMessage(city, origin, n, t) {
  const what = `${t.category.toLowerCase()}${t.location ? ` at ${t.location}` : ''}`;
  const link = city.settings.publicSite || `${origin}/${city.slug}`;
  const phone = city.settings.phone ? ` or call City Hall at ${city.settings.phone}` : '';
  const base = { link, linkLabel: 'Track your request' };
  if (n.kind === 'scheduled' || n.kind === 'rescheduled') {
    const when = longDate(n.date);
    return {
      ...base, subject: `${t.ref} is ${n.kind === 'rescheduled' ? 'rescheduled' : 'scheduled'} for ${when}`,
      body: `Your report of a ${what} (${t.ref}) is ${n.kind === 'rescheduled' ? 'now ' : ''}scheduled for ${when}. A ${n.department} crew will take care of it that day, weather permitting.\n\nYou can check on it any time with your request number, ${t.ref}.`,
      sms: `${t.ref} (${t.category}) is ${n.kind === 'rescheduled' ? 'now ' : ''}scheduled for ${when}.`,
      voice: `Your report, number ${t.ref.split('').join(' ')}, is scheduled for ${when}.`,
    };
  }
  if (n.kind === 'completed') {
    return {
      ...base, subject: `${t.ref} is complete`,
      body: `${n.department} has completed the work on your report of a ${what} (${t.ref}). Thank you for letting us know.\n\nIf the problem isn't fixed, reply to this message${phone} and mention ${t.ref}.`,
      sms: `${t.ref} (${t.category}) has been completed. Thank you for reporting it.`,
      voice: `The work on your report, number ${t.ref.split('').join(' ')}, has been completed. Thank you for reporting it.`,
    };
  }
  return {
    ...base, subject: `${t.ref} was already reported as ${n.original}`,
    body: `Thank you for your report of a ${what} (${t.ref}). Another resident reported the same problem as ${n.original}, so ${n.department} is handling them together. You'll hear from us when it's scheduled and when it's done.`,
    sms: `${t.ref} was already reported as ${n.original}. ${n.department} is handling them together and will update you.`,
    voice: `Your report was already reported by a neighbor, and the city is handling them together.`,
  };
}

async function tellResidents(env, store, city, url, notices) {
  for (const n of notices) {
    for (const t of n.to) {
      const to = contactOf(t.contact);
      if (!to) continue;
      try {
        await notify(env, store, city, { entityType: 'request', entityId: t.ref, to, msg: residentMessage(city, url.origin, n, t) });
      } catch (e) {
        console.log('notify failed', t.ref, e.message);
      }
    }
  }
}
