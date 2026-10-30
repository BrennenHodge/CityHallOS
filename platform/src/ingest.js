// Turning uploaded files, URLs and notes into searchable text.
import { extractText as unpdfText, getDocumentProxy } from 'unpdf';

const TEXT_EXT = /\.(txt|md|markdown|csv|json|tsv)$/i;
const MAX_CHUNK = 1400;

export async function extractText(env, { bytes, name, mime }) {
  const lower = (name || '').toLowerCase();
  mime = (mime || '').toLowerCase();
  if (TEXT_EXT.test(lower) || (mime.startsWith('text/') && !mime.includes('html'))) {
    return new TextDecoder().decode(bytes);
  }
  const type = mime || guessMime(lower);
  // Large PDFs go to Workers AI so parsing doesn't exceed the Worker's CPU limit.
  // The dashboard extracts PDF text in the browser, so this path is mostly for API uploads.
  if (type === 'application/pdf' && bytes.length < 3_000_000) {
    const text = await pdfText(bytes).catch((e) => { console.log('unpdf failed', e.message); return ''; });
    if (text.replace(/\s/g, '').length > 200) return text;
  }
  const [result] = await env.AI.toMarkdown([{ name: name || 'upload', blob: new Blob([bytes], { type }) }]);
  if (!result || result.format === 'error') {
    throw new Error(result?.error || 'Could not read this file type');
  }
  return cleanMarkdown(result.data || '', type);
}

// Text layer of a PDF, one "## Page N" section per page. Scanned PDFs come back empty.
async function pdfText(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await unpdfText(pdf, { mergePages: false });
  return text.map((t, i) => `## Page ${i + 1}\n\n${t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()}`).join('\n\n');
}

export function guessMime(name) {
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return {
    pdf: 'application/pdf', html: 'text/html', htm: 'text/html', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', webp: 'image/webp', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain',
    md: 'text/markdown', json: 'application/json', xml: 'application/xml',
  }[ext] || 'application/octet-stream';
}

function cleanMarkdown(md, type) {
  let t = md.replace(/\r/g, '');
  if (type.includes('html')) {
    // Drop navigation-style lines: bare links and image references.
    t = t.split('\n').filter((l) => !/^\s*(!?\[[^\]]*\]\([^)]*\)\s*)+$/.test(l)).join('\n');
  }
  // toMarkdown wraps PDFs in a metadata header; keep only the page contents.
  t = t.replace(/^#+\s*Metadata[\s\S]*?(?=^#+\s*Contents)/m, '').replace(/^#+\s*Contents\s*$/m, '');
  return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Split text into overlapping, heading-aware chunks sized for retrieval.
export function chunkText(text) {
  const lines = text.split('\n');
  const sections = [];
  let heading = '';
  let buf = [];
  const flush = () => { if (buf.join('').trim()) sections.push({ heading, body: buf.join('\n').trim() }); buf = []; };
  for (const line of lines) {
    const h = line.match(/^#{1,4}\s+(.+)/);
    if (h) { flush(); heading = h[1].replace(/[*_`]/g, '').trim().slice(0, 140); continue; }
    buf.push(line);
  }
  flush();

  const chunks = [];
  for (const s of sections) {
    const paras = s.body.split(/\n\s*\n/).flatMap((p) => (p.length > MAX_CHUNK ? splitLong(p) : [p]));
    let cur = '';
    for (const p of paras) {
      if (cur && cur.length + p.length + 2 > MAX_CHUNK) {
        chunks.push({ heading: s.heading, text: cur.trim() });
        const tail = cur.slice(-200);
        cur = tail.slice(tail.indexOf(' ') + 1) + '\n\n' + p;
      } else {
        cur = cur ? cur + '\n\n' + p : p;
      }
    }
    if (cur.trim().length > 20) chunks.push({ heading: s.heading, text: cur.trim() });
  }
  return chunks;
}

function splitLong(p) {
  const out = [];
  const sentences = p.match(/[^.!?\n]+[.!?]*\s*/g) || [p];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > MAX_CHUNK && cur) { out.push(cur); cur = ''; }
    if (s.length > MAX_CHUNK) { for (let i = 0; i < s.length; i += MAX_CHUNK) out.push(s.slice(i, i + MAX_CHUNK)); continue; }
    cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

// Replace a document's chunks in the search index.
export async function indexDocument(env, doc, text) {
  await env.DB.prepare('DELETE FROM chunks_fts WHERE doc_id = ?').bind(doc.id).run();
  const chunks = chunkText(text);
  const stmt = env.DB.prepare(
    'INSERT INTO chunks_fts (title, heading, text, doc_id, city, visibility, ord) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < chunks.length; i += 50) {
    await env.DB.batch(chunks.slice(i, i + 50).map((c, j) =>
      stmt.bind(doc.title, c.heading, c.text, doc.id, doc.city, doc.visibility, i + j)));
  }
  return chunks.length;
}
