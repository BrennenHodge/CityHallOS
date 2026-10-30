// Retrieval: BM25 over the chunk index, then a cross-encoder rerank.

const STOP = new Set(('a an and are as at be but by can could did do does for from get got had has have how i if in into is it its ' +
  'me my of on or our please should so than that the their them then there these they this to us was we what when where ' +
  'which who why will with would you your yours im ive id dont cant whats wheres hows tell know need want like just about ' +
  'any some also more much many there here hi hello hey thanks thank ok okay city wiggins mississippi ms').split(' '));

const SYNONYMS = {
  trash: ['garbage', 'sanitation', 'pickup'], garbage: ['trash', 'sanitation'], pickup: ['garbage', 'trash'],
  water: ['utility', 'utilities'], bill: ['payment', 'billing'], pay: ['payment', 'bill'], payment: ['pay', 'bill'],
  fence: ['fencing', 'accessory'], build: ['construction', 'building', 'permit'], building: ['construction', 'permit'],
  permit: ['application'], business: ['privilege', 'license'], license: ['privilege', 'business'],
  meeting: ['aldermen', 'board', 'agenda'], meetings: ['aldermen', 'board', 'agenda'], council: ['aldermen', 'board'],
  ticket: ['court', 'fine', 'citation'], court: ['municipal', 'fine'], police: ['department', 'officer'],
  mayor: ['berry'], clerk: ['city', 'hall'], zoning: ['district', 'zone', 'land'], zone: ['zoning', 'district'],
  pothole: ['street', 'road'], streetlight: ['light', 'street'], sewer: ['wastewater'], hours: ['open', 'office'],
  park: ['parks', 'recreation'], budget: ['audit', 'financial'], audit: ['financial', 'statements'],
  sign: ['signage'], shed: ['accessory', 'building'], pool: ['swimming', 'accessory'], occupancy: ['certificate'],
};

export function terms(query) {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w));
  const out = new Set(words);
  for (const w of words) for (const s of SYNONYMS[w] || []) out.add(s);
  return [...out].slice(0, 24);
}

export async function search(env, city, query, { includeInternal = false, limit = 6 } = {}) {
  const t = terms(query);
  if (!t.length) return [];
  const match = t.map((w) => (w.length > 3 ? `${w}*` : w)).join(' OR ');
  const vis = includeInternal ? '' : "AND visibility = 'public'";
  const { results } = await env.DB.prepare(
    `SELECT rowid, title, heading, text, doc_id, ord, bm25(chunks_fts, 6.0, 3.0, 1.0) AS bm
       FROM chunks_fts WHERE chunks_fts MATCH ? AND city = ? ${vis}
      ORDER BY bm LIMIT 40`
  ).bind(match, city).all();
  if (!results.length) return [];

  let ranked = results.map((r, i) => ({ ...r, score: -r.bm, rank: i }));
  try {
    const rr = await env.AI.run('@cf/baai/bge-reranker-base', {
      query,
      contexts: results.map((r) => ({ text: `${r.title}. ${r.heading}\n${r.text}`.slice(0, 1800) })),
      top_k: results.length,
    });
    const scores = new Map((rr.response || []).map((x) => [x.id, x.score]));
    if (scores.size) ranked = ranked.map((r, i) => ({ ...r, score: scores.get(i) ?? -10 })).sort((a, b) => b.score - a.score);
  } catch (e) {
    console.log('rerank failed', e.message);
  }

  // At most two chunks per document, so one long PDF can't crowd out the rest.
  const perDoc = new Map();
  const picked = [];
  for (const r of ranked) {
    const n = perDoc.get(r.doc_id) || 0;
    if (n >= 2) continue;
    perDoc.set(r.doc_id, n + 1);
    picked.push(r);
    if (picked.length >= limit) break;
  }

  const ids = [...new Set(picked.map((p) => p.doc_id))];
  const docs = new Map();
  if (ids.length) {
    const { results: rows } = await env.DB.prepare(
      `SELECT id, title, category, source_url, authority, verification, as_of, visibility, file_key FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`
    ).bind(...ids).all();
    for (const d of rows) docs.set(d.id, d);
  }
  return picked.filter((p) => docs.has(p.doc_id)).map((p) => ({ ...p, doc: docs.get(p.doc_id) }));
}
