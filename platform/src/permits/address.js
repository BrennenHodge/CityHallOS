// Address suggestions while a resident types, centered on City Hall.
//   Google Places (New)   when GOOGLE_MAPS_API_KEY is set: the best coverage of house numbers, and coordinates on pick.
//   Free fallback         the city's own street names from U.S. Census TIGER maps, plus OpenStreetMap (Photon)
//                         addresses near City Hall. Picked addresses are confirmed by the Census geocoder at screening.

const TIGER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const DAY = 86400;

async function getJson(url, { ms = 8000, ttl = 0, init = {} } = {}) {
  const res = await fetch(url, { ...init, headers: { 'User-Agent': 'CityHallOS address lookup', ...(init.headers || {}) }, signal: AbortSignal.timeout(ms), ...(ttl ? { cf: { cacheTtl: ttl, cacheEverything: true } } : {}) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ---------------- Where the city is ---------------- */

const AREA = new Map();

// City Hall's coordinates and the city-limits box, from the Census geocoder and TIGER place boundaries. Cached per isolate.
export async function cityArea(city) {
  if (AREA.has(city.id)) return AREA.get(city.id);
  const zip = (String(city.settings.address || '').match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || null;
  const area = { center: null, box: null, zip, place: city.settings.shortName || city.name.replace(/^(City|Town|Village) of /i, ''), state: city.state };
  try {
    if (city.settings.address) {
      const d = await getJson(`${CENSUS}?${new URLSearchParams({ address: city.settings.address, benchmark: 'Public_AR_Current', format: 'json' })}`, { ttl: 30 * DAY });
      const c = d.result?.addressMatches?.[0]?.coordinates;
      if (c) area.center = { lat: c.y, lon: c.x };
    }
    if (area.center) {
      const q = new URLSearchParams({ geometry: `${area.center.lon},${area.center.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', returnExtentOnly: 'true', outSR: '4326', f: 'json' });
      const e = (await getJson(`${TIGER}/Places_CouSub_ConCity_SubMCD/MapServer/4/query?${q}`, { ttl: 30 * DAY })).extent;
      if (e && Number.isFinite(e.xmin)) area.box = { w: e.xmin, s: e.ymin, e: e.xmax, n: e.ymax };
    }
  } catch { /* suggestions still work without a center, just less focused */ }
  if (area.center) AREA.set(city.id, area);
  return area;
}

/* ---------------- Street names (free) ---------------- */

const STREETS = new Map();

async function cityStreets(area) {
  if (!area.box) return [];
  const key = `${area.box.w},${area.box.s}`;
  if (STREETS.has(key)) return STREETS.get(key);
  // A little past city limits: addresses on the edge of town still screen correctly.
  const pad = 0.01;
  const env = `${area.box.w - pad},${area.box.s - pad},${area.box.e + pad},${area.box.n + pad}`;
  const names = new Set();
  await Promise.all([6, 8].map(async (layer) => {
    const q = new URLSearchParams({ geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'NAME', returnGeometry: 'false', returnDistinctValues: 'true', f: 'json' });
    const d = await getJson(`${TIGER}/Transportation/MapServer/${layer}/query?${q}`, { ttl: 30 * DAY, ms: 10000 }).catch(() => ({}));
    for (const f of d.features || []) if (f.attributes?.NAME) names.add(f.attributes.NAME);
  }));
  const list = [...names].map((name) => ({ name, words: streetWords(name) }));
  if (list.length) STREETS.set(key, list);
  return list;
}

// Each word of a street name in every form a resident might type it: "1st St N" also matches "first street north".
const SPELL = {
  st: ['street'], ave: ['avenue'], av: ['avenue'], rd: ['road'], dr: ['drive'], ln: ['lane'], ct: ['court'], cir: ['circle'], pl: ['place'],
  blvd: ['boulevard'], hwy: ['highway'], pkwy: ['parkway'], trl: ['trail'], ter: ['terrace'], cv: ['cove'], loop: [], apts: ['apartments'],
  n: ['north'], s: ['south'], e: ['east'], w: ['west'], jr: ['junior'], mlk: [], l: ['luther'],
  '1st': ['first'], '2nd': ['second'], '3rd': ['third'], '4th': ['fourth'], '5th': ['fifth'], '6th': ['sixth'], '7th': ['seventh'], '8th': ['eighth'], '9th': ['ninth'], '10th': ['tenth'],
};
const REVERSE = Object.fromEntries(Object.entries(SPELL).flatMap(([k, vs]) => vs.map((v) => [v, k])));
const DIRS = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);
const norm = (s) => String(s || '').toLowerCase().replace(/[.,#']/g, ' ').replace(/\s+/g, ' ').trim();

function streetWords(name) {
  return norm(name).split(' ').map((w) => [w, ...(SPELL[w] || []), ...(REVERSE[w] ? [REVERSE[w]] : [])]);
}

// "113 first st", "batson", "113 e batson ave wiggins ms" → { number, words }.
function parseQuery(q, area) {
  let t = norm(q).replace(/\b\d{5}(-\d{4})?\b/g, ' ');
  const place = norm(area.place);
  if (place) t = t.replace(new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*$`), ' ');
  t = t.replace(new RegExp(`\\b(${norm(area.state)}|mississippi|usa)\\b`, 'g'), ' ').trim();
  const m = t.match(/^(\d+[a-z]?)\s*(.*)$/);
  return { number: m ? m[1].toUpperCase() : null, words: (m ? m[2] : t).split(' ').filter(Boolean) };
}

function scoreStreet(street, words) {
  if (!words.length) return 0;
  let score = 0; const used = new Set();
  for (const w of words) {
    const i = street.words.findIndex((forms, j) => !used.has(j) && forms.some((f) => f.startsWith(w)));
    if (i < 0) return 0;
    used.add(i);
    score += street.words[i].some((f) => f === w) ? 3 : 2;
    if (i === 0 || (i === 1 && DIRS.has(street.words[0][0]))) score += 2;
  }
  return score - street.words.length * 0.1;
}

function formatted(street, number, area) {
  return `${number ? `${number} ` : ''}${street}, ${area.place}, ${area.state}${area.zip ? ` ${area.zip}` : ''}`;
}

async function photon(q, area) {
  const p = new URLSearchParams({ q, limit: '8', lang: 'en' });
  if (area.center) { p.set('lat', area.center.lat); p.set('lon', area.center.lon); }
  const d = await getJson(`https://photon.komoot.io/api/?${p}`, { ms: 2500, ttl: 7 * DAY }).catch(() => ({}));
  const box = area.box;
  return (d.features || []).filter((f) => {
    const pr = f.properties || {}; const [lon, lat] = f.geometry?.coordinates || [];
    return pr.housenumber && pr.street && (!box || (lon > box.w - 0.03 && lon < box.e + 0.03 && lat > box.s - 0.03 && lat < box.n + 0.03));
  }).map((f) => {
    const pr = f.properties; const [lon, lat] = f.geometry.coordinates;
    const zip = pr.postcode || area.zip;
    const text = `${pr.housenumber} ${pr.street}, ${pr.city || area.place}, ${area.state}${zip ? ` ${zip}` : ''}`;
    return { text, main: `${pr.housenumber} ${pr.street}`, secondary: [pr.name && pr.name !== pr.street ? pr.name : null, `${pr.city || area.place}, ${area.state}`].filter(Boolean).join(' · '), lat, lon, source: 'osm' };
  });
}

async function freeSuggest(q, area) {
  const { number, words } = parseQuery(q, area);
  if (!words.length) return [];
  const [streets, osm] = await Promise.all([cityStreets(area), number ? photon(q, area) : []]);
  const seen = new Set();
  const ranked = streets.map((s) => ({ s, score: scoreStreet(s, words) })).filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.s.name.length - b.s.name.length)
    // "E 5th Ave" and "5th Ave E" are the same street: show it once.
    .filter(({ s }) => { const k = s.words.map((f) => f[0]).sort().join(' '); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 6)
    .map(({ s }) => ({ text: formatted(s.name, number, area), main: number ? `${number} ${s.name}` : s.name, secondary: `${area.place}, ${area.state}${area.zip ? ` ${area.zip}` : ''}`, needsNumber: !number, source: 'census' }));
  const out = [];
  const keys = new Set();
  for (const x of [...osm, ...ranked]) {
    const k = norm(x.main).replace(/\b(street|avenue|drive|road|north|south|east|west)\b/g, (w) => REVERSE[w] || w);
    if (!keys.has(k)) { keys.add(k); out.push(x); }
  }
  return out.slice(0, 6);
}

/* ---------------- Google Places (New) ---------------- */

async function googleSuggest(env, q, area, session) {
  const body = { input: q, includedRegionCodes: ['us'], ...(session ? { sessionToken: session } : {}) };
  if (area.box) body.locationBias = { rectangle: { low: { latitude: area.box.s - 0.05, longitude: area.box.w - 0.05 }, high: { latitude: area.box.n + 0.05, longitude: area.box.e + 0.05 } } };
  else if (area.center) body.locationBias = { circle: { center: { latitude: area.center.lat, longitude: area.center.lon }, radius: 20000 } };
  if (area.center) body.origin = { latitude: area.center.lat, longitude: area.center.lon };
  const d = await getJson('https://places.googleapis.com/v1/places:autocomplete', { ms: 4000, init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY }, body: JSON.stringify(body) } });
  return (d.suggestions || []).map((s) => s.placePrediction).filter(Boolean).slice(0, 6).map((p) => ({
    text: p.text?.text?.replace(/, USA$/, ''), main: p.structuredFormat?.mainText?.text || p.text?.text, secondary: (p.structuredFormat?.secondaryText?.text || '').replace(/, USA$/, ''),
    placeId: p.placeId, miles: p.distanceMeters != null ? Math.round(p.distanceMeters / 160.9) / 10 : null, source: 'google',
  }));
}

// The picked Google place: its postal address and coordinates. Ends the billing session.
export async function placeDetails(env, placeId, session) {
  if (!env.GOOGLE_MAPS_API_KEY || !/^[\w-]{10,300}$/.test(placeId || '')) return null;
  const qs = session ? `?sessionToken=${encodeURIComponent(session)}` : '';
  const d = await getJson(`https://places.googleapis.com/v1/places/${placeId}${qs}`, { ms: 5000, init: { headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'formattedAddress,location' } } }).catch(() => null);
  if (!d?.location) return null;
  return { address: String(d.formattedAddress || '').replace(/, USA$/, ''), lat: d.location.latitude, lon: d.location.longitude };
}

export async function suggestAddresses(env, city, q, session) {
  q = String(q || '').trim().slice(0, 120);
  if (q.length < 2) return { suggestions: [], provider: null };
  const area = await cityArea(city);
  if (env.GOOGLE_MAPS_API_KEY) {
    try { return { suggestions: await googleSuggest(env, q, area, session), provider: 'google' }; } catch { /* fall back to the free lookup */ }
  }
  return { suggestions: await freeSuggest(q, area), provider: 'census' };
}
