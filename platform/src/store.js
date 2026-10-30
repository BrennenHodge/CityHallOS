// One city's data: a Durable Object with its own SQLite database.
// Every city gets a separate store, so one city's queries can never read another city's records,
// and each city can be backed up, restored, exported or deleted on its own.
// Every change made by staff, residents or the AI is written to that city's append-only audit log.
import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_DEPARTMENTS, DEFAULT_REQUEST_TYPES } from './templates.js';

const now = () => new Date().toISOString();
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
// Rows imported from the old shared database used "YYYY-MM-DD HH:MM:SS" in UTC.
const iso = (s) => (!s ? null : /T/.test(s) ? s : s.replace(' ', 'T') + '.000Z');

// Schema changes are appended, never edited: each store applies the ones it hasn't run yet.
const MIGRATIONS = [
  `
  CREATE TABLE departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    phone TEXT,
    email TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE request_types (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    department_id TEXT NOT NULL REFERENCES departments(id),
    priority TEXT NOT NULL DEFAULT 'normal',
    active INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

  -- People requests can be assigned to. user_id links to a dashboard account in the platform database.
  CREATE TABLE staff (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT,
    department_id TEXT REFERENCES departments(id),
    email TEXT,
    phone TEXT,
    user_id TEXT UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General',
    source_url TEXT,
    authority TEXT NOT NULL DEFAULT 'official-city',
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
    verification TEXT NOT NULL DEFAULT 'official_unverified'
      CHECK (verification IN ('verified_current', 'official_unverified', 'historical', 'secondary', 'unverified')),
    as_of TEXT,
    file_key TEXT,
    file_name TEXT,
    mime TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    chars INTEGER NOT NULL DEFAULT 0,
    chunks INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
    error TEXT,
    notes TEXT,
    created_by TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX documents_category ON documents (category);

  -- The passages the AI reads. chunks_fts is a search index over this table, kept in sync by triggers.
  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ord INTEGER NOT NULL,
    title TEXT NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    UNIQUE (doc_id, ord)
  );
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    title, heading, text, content = 'chunks', content_rowid = 'id', tokenize = 'porter unicode61'
  );
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (new.id, new.title, new.heading, new.text);
  END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts (chunks_fts, rowid, title, heading, text) VALUES ('delete', old.id, old.title, old.heading, old.text);
  END;
  CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts (chunks_fts, rowid, title, heading, text) VALUES ('delete', old.id, old.title, old.heading, old.text);
    INSERT INTO chunks_fts (rowid, title, heading, text) VALUES (new.id, new.title, new.heading, new.text);
  END;

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'voice', 'sms', 'staff-test')),
    contact TEXT,
    page_url TEXT,
    status TEXT NOT NULL DEFAULT 'answered' CHECK (status IN ('answered', 'needs_review', 'reviewed', 'emergency')),
    messages INTEGER NOT NULL DEFAULT 0,
    first_question TEXT,
    started_at TEXT NOT NULL,
    last_at TEXT NOT NULL
  );
  CREATE INDEX conversations_last ON conversations (last_at);
  CREATE INDEX conversations_status ON conversations (status, last_at);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    convo_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    sources TEXT,
    flag TEXT,
    model TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_convo ON messages (convo_id, id);

  CREATE TABLE citations (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    convo_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX citations_doc ON citations (doc_id);
  CREATE INDEX citations_created ON citations (created_at);

  -- Numbered per city: the first request in every city is {prefix}-1001.
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    type_key TEXT NOT NULL,
    category TEXT NOT NULL,
    department_id TEXT NOT NULL REFERENCES departments(id),
    description TEXT NOT NULL,
    summary TEXT,
    location TEXT,
    latitude REAL,
    longitude REAL,
    name TEXT,
    contact TEXT,
    photo_key TEXT,
    status TEXT NOT NULL DEFAULT 'new'
      CHECK (status IN ('new', 'needs_info', 'assigned', 'in_progress', 'awaiting_review', 'resolved', 'closed')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assignee_id TEXT REFERENCES staff(id),
    source TEXT NOT NULL DEFAULT 'web',
    convo_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX requests_status ON requests (status, id);
  CREATE INDEX requests_department ON requests (department_id, status);
  INSERT INTO sqlite_sequence (name, seq) VALUES ('requests', 1000);

  -- The timeline residents and staff see on a request.
  CREATE TABLE request_events (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    actor_name TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    public INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX request_events_request ON request_events (request_id, id);

  -- Who did what, when. Rows can be added but never changed or removed.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('staff', 'operator', 'resident', 'ai', 'system')),
    actor_id TEXT,
    actor_name TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    summary TEXT NOT NULL,
    changes TEXT
  );
  CREATE INDEX audit_at ON audit_log (id);
  CREATE INDEX audit_entity ON audit_log (entity_type, entity_id, id);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  `,
  `
  -- Permit applications. A draft belongs to whoever holds its secret link (token_hash); it gets a reference
  -- number ({prefix}-BP-1001) when it is submitted. Every answer lives once, in data.
  CREATE TABLE permits (
    id TEXT PRIMARY KEY,
    ref TEXT UNIQUE,
    kind TEXT NOT NULL DEFAULT 'construction',
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft', 'submitted', 'needs_info', 'fees_due', 'in_review', 'issued', 'closed', 'denied', 'withdrawn')),
    token_hash TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    asked TEXT NOT NULL DEFAULT '[]',
    screen TEXT,
    checks TEXT,
    review TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    applicant TEXT,
    address TEXT,
    contact TEXT,
    fee_estimate REAL,
    fee_assessed REAL,
    fee_paid REAL,
    receipt TEXT,
    permit_number TEXT UNIQUE,
    conditions TEXT,
    issued_by TEXT,
    assignee_id TEXT REFERENCES staff(id),
    convo_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    reminders INTEGER NOT NULL DEFAULT 0,
    auto_returns INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    applicant_at TEXT NOT NULL,
    submitted_at TEXT,
    decided_at TEXT
  );
  CREATE INDEX permits_status ON permits (status, updated_at);

  CREATE TABLE permit_files (
    id TEXT PRIMARY KEY,
    permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    file_key TEXT NOT NULL,
    text TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX permit_files_permit ON permit_files (permit_id);

  -- The application's timeline. public rows are shown to the applicant.
  CREATE TABLE permit_events (
    id INTEGER PRIMARY KEY,
    permit_id TEXT NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT,
    note TEXT,
    data TEXT,
    public INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX permit_events_permit ON permit_events (permit_id, id);

  -- Every email, text and call to a resident, sent or not.
  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'call')),
    to_addr TEXT,
    subject TEXT,
    body TEXT,
    status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
    provider_id TEXT,
    error TEXT
  );
  CREATE INDEX outbox_entity ON outbox (entity_type, entity_id, id);
  INSERT OR IGNORE INTO meta (key, value) VALUES ('permit_seq', '1000');
  `,
];

const PERMIT_JSON = ['data', 'asked', 'screen', 'checks', 'review', 'contact'];
const parsePermit = (p) => p && Object.fromEntries(Object.entries(p).map(([k, v]) => [k, PERMIT_JSON.includes(k) && v ? JSON.parse(v) : v]));
const PERMIT_LIST = `SELECT p.id, p.ref, p.kind, p.status, p.applicant, p.address, p.contact, p.progress, p.fee_estimate, p.fee_assessed, p.fee_paid, p.permit_number,
  p.checks, p.review, p.created_at, p.updated_at, p.submitted_at, p.decided_at, p.assignee_id, s.name AS assignee FROM permits p LEFT JOIN staff s ON s.id = p.assignee_id`;

const DOC_COLS = 'id, title, category, source_url, authority, visibility, verification, as_of, file_name, mime, bytes, chars, chunks, status, error, notes, created_by, updated_by, created_at, updated_at';
const DOC_FIELDS = ['title', 'category', 'source_url', 'authority', 'visibility', 'verification', 'as_of', 'notes'];
const REQUEST_SELECT = `SELECT r.*, d.name AS department, s.name AS assignee FROM requests r
  JOIN departments d ON d.id = r.department_id LEFT JOIN staff s ON s.id = r.assignee_id`;
const CLOSED = ['resolved', 'closed'];

// Field-by-field differences, for the audit log.
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) if (f in after && (before[f] ?? null) !== (after[f] ?? null)) out[f] = [before[f] ?? null, after[f] ?? null];
  return out;
}

export class CityStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  migrate() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const v = Number(this.one("SELECT value FROM meta WHERE key = 'schema_version'")?.value || 0);
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(MIGRATIONS[i]);
        this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", String(i + 1));
      });
    }
  }

  all(sql, ...b) { return this.sql.exec(sql, ...b).toArray(); }
  one(sql, ...b) { return this.sql.exec(sql, ...b).toArray()[0] || null; }
  run(sql, ...b) { return this.sql.exec(sql, ...b); }
  tx(fn) { return this.ctx.storage.transactionSync(fn); }

  log(actor, action, entityType, entityId, summary, changes) {
    this.run(
      'INSERT INTO audit_log (at, actor_type, actor_id, actor_name, action, entity_type, entity_id, summary, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now(), actor.type, actor.id ?? null, actor.name, action, entityType, entityId == null ? null : String(entityId), summary,
      changes && Object.keys(changes).length ? JSON.stringify(changes) : null,
    );
  }

  /* ---------------- Setup ---------------- */

  // Called once when the city is added to the platform. Safe to call again.
  init(cityId, actor) {
    return this.tx(() => {
      const existing = this.one("SELECT value FROM meta WHERE key = 'city_id'")?.value;
      if (existing && existing !== cityId) throw new Error(`This store belongs to ${existing}`);
      if (existing) return { created: false };
      this.run("INSERT INTO meta (key, value) VALUES ('city_id', ?)", cityId);
      DEFAULT_DEPARTMENTS.forEach((d, i) => this.run('INSERT INTO departments (id, name, sort) VALUES (?, ?, ?)', d.id, d.name, i));
      DEFAULT_REQUEST_TYPES.forEach((t, i) => this.run(
        'INSERT INTO request_types (key, label, department_id, priority, sort) VALUES (?, ?, ?, ?, ?)', t.key, t.label, t.department_id, t.priority || 'normal', i));
      this.log(actor, 'city.create', 'city', cityId, 'City data store created with default departments and request types');
      return { created: true };
    });
  }

  departments() { return this.all('SELECT * FROM departments ORDER BY sort, name'); }
  requestTypes() {
    return this.all(`SELECT t.key, t.label, t.priority, t.department_id, d.name AS department FROM request_types t
      JOIN departments d ON d.id = t.department_id WHERE t.active = 1 ORDER BY t.sort`);
  }

  /* ---------------- Staff directory ---------------- */

  staff() {
    return this.all(`SELECT s.*, d.name AS department FROM staff s LEFT JOIN departments d ON d.id = s.department_id
      ORDER BY s.active DESC, s.name`);
  }
  staffMember(id) { return this.one('SELECT * FROM staff WHERE id = ?', id); }
  staffByUser(userId) { return this.one('SELECT * FROM staff WHERE user_id = ?', userId); }

  addStaff(p, actor, note) {
    const id = uid('s');
    const t = now();
    this.tx(() => {
      this.run('INSERT INTO staff (id, name, title, department_id, email, phone, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, p.name, p.title ?? null, p.department_id ?? null, p.email ?? null, p.phone ?? null, p.user_id ?? null, t, t);
      this.log(actor, 'staff.create', 'staff', id, `Added ${p.name} to the staff directory${note ? `. ${note}` : ''}`);
    });
    return this.staffMember(id);
  }

  updateStaff(id, p, actor, note) {
    const before = this.staffMember(id);
    if (!before) return null;
    const next = { ...before, ...p };
    const changes = diff(before, next, ['name', 'title', 'department_id', 'email', 'phone', 'active']);
    this.tx(() => {
      this.run('UPDATE staff SET name = ?, title = ?, department_id = ?, email = ?, phone = ?, user_id = ?, active = ?, updated_at = ? WHERE id = ?',
        next.name, next.title, next.department_id, next.email, next.phone, next.user_id, next.active, now(), id);
      if (Object.keys(changes).length || note) this.log(actor, 'staff.update', 'staff', id, note || `Updated ${next.name}`, changes);
    });
    return this.staffMember(id);
  }

  // For changes recorded by the Worker, such as dashboard access granted in the platform database.
  record(actor, action, entityType, entityId, summary, changes) {
    this.log(actor, action, entityType, entityId, summary, changes);
  }

  /* ---------------- Knowledge base ---------------- */

  listDocuments({ q, category } = {}) {
    let sql = `SELECT ${DOC_COLS} FROM documents WHERE 1 = 1`;
    const args = [];
    if (category) { sql += ' AND category = ?'; args.push(category); }
    if (q) { sql += ' AND (title LIKE ? OR notes LIKE ? OR file_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return this.all(sql + ' ORDER BY updated_at DESC', ...args);
  }

  documentRow(id) { return this.one('SELECT * FROM documents WHERE id = ?', id); }

  getDocument(id) {
    const doc = this.one(`SELECT ${DOC_COLS}, file_key FROM documents WHERE id = ?`, id);
    if (!doc) return null;
    const chunks = this.all('SELECT heading, text FROM chunks WHERE doc_id = ? ORDER BY ord', id);
    const cited = this.one('SELECT COUNT(*) AS n FROM citations WHERE doc_id = ?', id).n;
    return { document: { ...doc, cited }, chunks };
  }

  createDocument(d, actor) {
    const t = now();
    this.tx(() => {
      this.run(`INSERT INTO documents (id, title, category, source_url, authority, visibility, verification, as_of, file_key, file_name, mime, bytes, notes, status, created_by, updated_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
      d.id, d.title, d.category, d.source_url, d.authority, d.visibility, d.verification, d.as_of, d.file_key, d.file_name, d.mime, d.bytes, d.notes,
      actor.name, actor.name, t, t);
      this.log(actor, 'document.create', 'document', d.id, `Added "${d.title}" to the knowledge base`,
        { category: [null, d.category], visibility: [null, d.visibility], verification: [null, d.verification] });
    });
    return this.documentRow(d.id);
  }

  // Replaces a document's passages and marks it ready.
  indexDocument(id, chunks, chars, actor, reason) {
    const doc = this.documentRow(id);
    if (!doc) return null;
    this.tx(() => {
      this.run('DELETE FROM chunks WHERE doc_id = ?', id);
      chunks.forEach((c, i) => this.run('INSERT INTO chunks (doc_id, ord, title, heading, text) VALUES (?, ?, ?, ?, ?)', id, i, doc.title, c.heading || '', c.text));
      this.run("UPDATE documents SET status = 'ready', error = NULL, chars = ?, chunks = ?, updated_at = ? WHERE id = ?", chars, chunks.length, now(), id);
      if (reason) this.log(actor, 'document.reindex', 'document', id, `${reason} "${doc.title}" (${chunks.length} passages)`);
    });
    return this.documentRow(id);
  }

  failDocument(id, error) {
    this.run("UPDATE documents SET status = 'error', error = ?, updated_at = ? WHERE id = ?", String(error).slice(0, 300), now(), id);
    return this.documentRow(id);
  }

  updateDocument(id, patch, actor) {
    const before = this.documentRow(id);
    if (!before) return null;
    const next = { ...before, ...patch };
    const changes = diff(before, next, DOC_FIELDS);
    if (!Object.keys(changes).length) return before;
    this.tx(() => {
      this.run(`UPDATE documents SET title = ?, category = ?, source_url = ?, authority = ?, visibility = ?, verification = ?, as_of = ?, notes = ?,
        updated_by = ?, updated_at = ? WHERE id = ?`,
      next.title, next.category, next.source_url, next.authority, next.visibility, next.verification, next.as_of, next.notes, actor.name, now(), id);
      if (changes.title) this.run('UPDATE chunks SET title = ? WHERE doc_id = ?', next.title, id);
      const what = Object.keys(changes).map((k) => ({ verification: 'verification', visibility: 'who can see it', as_of: 'date', source_url: 'link', authority: 'source type' }[k] || k));
      this.log(actor, 'document.update', 'document', id, `Changed ${what.join(', ')} on "${next.title}"`, changes);
    });
    return this.documentRow(id);
  }

  deleteDocument(id, actor) {
    const doc = this.documentRow(id);
    if (!doc) return null;
    this.tx(() => {
      this.run('DELETE FROM chunks WHERE doc_id = ?', id);
      this.run('DELETE FROM citations WHERE doc_id = ?', id);
      this.run('DELETE FROM documents WHERE id = ?', id);
      this.log(actor, 'document.delete', 'document', id, `Deleted "${doc.title}" from the knowledge base`,
        { title: [doc.title, null], category: [doc.category, null], file_name: [doc.file_name, null] });
    });
    return doc;
  }

  listForms() {
    return this.all(`SELECT id, title, notes, as_of, source_url, verification, file_key IS NOT NULL AS has_file FROM documents
      WHERE visibility = 'public' AND status = 'ready' AND category = 'Permits & Forms' AND source_url LIKE '%DocumentCenter%' ORDER BY title`);
  }

  // BM25 candidates for the reranker. Title matches count most, then headings, then body text.
  searchChunks(match, { includeInternal = false, limit = 40 } = {}) {
    const vis = includeInternal ? '' : "AND d.visibility = 'public'";
    try {
      return this.all(`SELECT c.id, c.doc_id, c.ord, c.heading, c.text, c.title, bm25(chunks_fts, 6.0, 3.0, 1.0) AS bm,
          d.category, d.source_url, d.authority, d.verification, d.as_of, d.visibility, d.file_key
        FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN documents d ON d.id = c.doc_id
        WHERE chunks_fts MATCH ? AND d.status = 'ready' ${vis} ORDER BY bm LIMIT ?`, match, limit);
    } catch (e) {
      console.log('search failed', e.message);
      return [];
    }
  }

  /* ---------------- Conversations ---------------- */

  // Records the resident's message and returns the recent history, starting a conversation if needed.
  beginTurn({ convoId, channel, pageUrl, contact, question }) {
    const t = now();
    let history = [];
    if (convoId && this.one('SELECT id FROM conversations WHERE id = ?', convoId)) {
      history = this.all('SELECT role, content FROM messages WHERE convo_id = ? ORDER BY id DESC LIMIT 6', convoId).reverse();
    } else {
      convoId = uid('c');
      this.run('INSERT INTO conversations (id, channel, contact, page_url, first_question, started_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        convoId, channel, contact ?? null, pageUrl ?? null, question, t, t);
    }
    this.run("INSERT INTO messages (convo_id, role, content, created_at) VALUES (?, 'user', ?, ?)", convoId, question, t);
    return { convoId, history };
  }

  finishTurn({ convoId, answer, sources, flag, model, status, citedDocIds }) {
    this.tx(() => {
      const t = now();
      const { id } = this.one("INSERT INTO messages (convo_id, role, content, sources, flag, model, created_at) VALUES (?, 'assistant', ?, ?, ?, ?, ?) RETURNING id",
        convoId, answer, JSON.stringify(sources), flag, model, t);
      this.run(`UPDATE conversations SET messages = messages + 2, last_at = ?${status ? ', status = ?' : ''} WHERE id = ?`, ...(status ? [t, status, convoId] : [t, convoId]));
      for (const docId of new Set(citedDocIds)) {
        if (this.one('SELECT 1 AS x FROM documents WHERE id = ?', docId)) {
          this.run('INSERT INTO citations (doc_id, convo_id, message_id, created_at) VALUES (?, ?, ?, ?)', docId, convoId, id, t);
        }
      }
    });
  }

  listConversations({ status } = {}) {
    const args = [];
    let where = "channel != 'staff-test'";
    if (status) { where += ' AND status = ?'; args.push(status); }
    return this.all(`SELECT id, channel, page_url, status, messages, first_question, started_at, last_at FROM conversations WHERE ${where} ORDER BY last_at DESC LIMIT 200`, ...args);
  }

  getConversation(id) {
    const conversation = this.one('SELECT * FROM conversations WHERE id = ?', id);
    if (!conversation) return null;
    const messages = this.all('SELECT role, content, sources, flag, model, created_at FROM messages WHERE convo_id = ? ORDER BY id', id)
      .map((m) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : [] }));
    const requests = this.all('SELECT id, ref, category, status FROM requests WHERE convo_id = ?', id);
    return { conversation, messages, requests };
  }

  setConversationStatus(id, status, actor) {
    const c = this.one('SELECT status, first_question FROM conversations WHERE id = ?', id);
    if (!c) return null;
    if (c.status !== status) {
      this.tx(() => {
        this.run('UPDATE conversations SET status = ? WHERE id = ?', status, id);
        this.log(actor, 'conversation.status', 'conversation', id, `Marked "${(c.first_question || 'conversation').slice(0, 80)}" ${status.replace('_', ' ')}`, { status: [c.status, status] });
      });
    }
    return this.getConversation(id);
  }

  /* ---------------- Service requests ---------------- */

  createRequest(r, actor, prefix) {
    const type = this.one('SELECT * FROM request_types WHERE key = ? AND active = 1', r.type_key) || this.one("SELECT * FROM request_types WHERE key = 'other'");
    const dept = this.one('SELECT name FROM departments WHERE id = ?', type.department_id);
    const t = now();
    const convoId = r.convo_id && this.one('SELECT id FROM conversations WHERE id = ?', r.convo_id) ? r.convo_id : null;
    const priority = /\b(urgent|danger|hazard|unsafe|blocking)\b/i.test(r.description) ? 'high' : type.priority;
    const gps = String(r.location || '').match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    return this.tx(() => {
      const { id } = this.one(`INSERT INTO requests (ref, type_key, category, department_id, description, summary, location, latitude, longitude, name, contact, priority, source, convo_id, created_at, updated_at)
        VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      type.key, type.label, type.department_id, r.description, r.summary, r.location, gps ? Number(gps[1]) : null, gps ? Number(gps[2]) : null,
      r.name, r.contact, priority, r.source, convoId, t, t);
      const ref = `${prefix}-${id}`;
      this.run('UPDATE requests SET ref = ? WHERE id = ?', ref, id);
      this.run('INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        id, t, actor.type, actor.id ?? null, actor.name, 'new', `${actor.type === 'staff' || actor.type === 'operator' ? 'Logged by staff' : 'Submitted by resident'}. Routed to ${dept.name}.`);
      this.log(actor, 'request.create', 'request', ref, `${ref} created: ${type.label}${r.location ? ` at ${r.location}` : ''}, routed to ${dept.name}`);
      if (convoId) {
        this.run("INSERT INTO messages (convo_id, role, content, flag, model, created_at) VALUES (?, 'assistant', ?, 'action', 'workflow', ?)",
          convoId, `Created service request ${ref} (${type.label}) and routed it to ${dept.name}.`, t);
      }
      return { id, ref, department: dept.name };
    });
  }

  setRequestPhoto(id, key) { this.run('UPDATE requests SET photo_key = ? WHERE id = ?', key, id); }
  requestPhotoKey(id) { return this.one('SELECT photo_key, department_id FROM requests WHERE id = ?', id); }

  // What a resident can see with only the reference number.
  trackRequest(ref) {
    const r = this.one('SELECT r.id, r.ref, r.category, r.status, r.created_at, r.updated_at, d.name AS department FROM requests r JOIN departments d ON d.id = r.department_id WHERE r.ref = ?', ref);
    if (!r) return null;
    const updates = this.all('SELECT at, status, note FROM request_events WHERE request_id = ? AND public = 1 ORDER BY id', r.id);
    const { id, ...rest } = r;
    return { ...rest, updates };
  }

  listRequests({ departmentId } = {}) {
    const rows = departmentId
      ? this.all(`${REQUEST_SELECT} WHERE r.department_id = ? ORDER BY r.id DESC LIMIT 300`, departmentId)
      : this.all(`${REQUEST_SELECT} ORDER BY r.id DESC LIMIT 300`);
    return rows.map((r) => this.withHistory(r));
  }

  getRequest(id) {
    const r = this.one(`${REQUEST_SELECT} WHERE r.id = ?`, id);
    return r && this.withHistory(r);
  }

  withHistory(r) {
    const history = this.all('SELECT at, status, actor_name AS by, note, public FROM request_events WHERE request_id = ? ORDER BY id', r.id);
    const { photo_key, ...rest } = r;
    return { ...rest, photo: !!photo_key, history };
  }

  updateRequest(id, p, actor) {
    const before = this.one('SELECT * FROM requests WHERE id = ?', id);
    if (!before) return null;
    const next = {
      status: p.status ?? before.status, priority: p.priority ?? before.priority,
      assignee_id: 'assignee_id' in p ? p.assignee_id : before.assignee_id, department_id: p.department_id ?? before.department_id,
    };
    if (next.assignee_id && !this.staffMember(next.assignee_id)) throw new Error('Unknown staff member');
    if (!this.one('SELECT id FROM departments WHERE id = ?', next.department_id)) throw new Error('Unknown department');
    const changes = diff(before, next, ['status', 'priority', 'assignee_id', 'department_id']);
    const words = [];
    if (changes.status) words.push(`Status: ${next.status.replace(/_/g, ' ')}`);
    if (changes.assignee_id) words.push(`Assigned to ${next.assignee_id ? this.staffMember(next.assignee_id).name : 'nobody'}`);
    if (changes.priority) words.push(`Priority: ${next.priority}`);
    if (changes.department_id) words.push(`Moved to ${this.one('SELECT name FROM departments WHERE id = ?', next.department_id).name}`);
    if (!words.length && !p.note) return this.getRequest(id);
    const t = now();
    this.tx(() => {
      const closedAt = CLOSED.includes(next.status) ? (before.closed_at || t) : null;
      this.run('UPDATE requests SET status = ?, priority = ?, assignee_id = ?, department_id = ?, updated_at = ?, closed_at = ? WHERE id = ?',
        next.status, next.priority, next.assignee_id, next.department_id, t, closedAt, id);
      const note = [words.join(' · '), p.note].filter(Boolean).join(' — ');
      // Status changes are shown to the resident on the tracking page; staff notes stay internal.
      this.run('INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        id, t, actor.type, actor.id ?? null, actor.name, next.status, note, changes.status ? 1 : 0);
      this.log(actor, 'request.update', 'request', before.ref, `${before.ref}: ${note}`, changes);
    });
    return this.getRequest(id);
  }

  /* ---------------- Permit applications ---------------- */

  createPermit({ id, tokenHash, kind, data, convoId }) {
    const t = now();
    const convo = convoId && this.one('SELECT id FROM conversations WHERE id = ?', convoId) ? convoId : null;
    this.run('INSERT INTO permits (id, kind, token_hash, data, convo_id, created_at, updated_at, applicant_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, kind, tokenHash, JSON.stringify(data || {}), convo, t, t, t);
    this.run("INSERT INTO permit_events (permit_id, at, actor_type, actor_name, kind, status, note, public) VALUES (?, ?, 'resident', 'Applicant', 'status', 'draft', 'Application started', 1)", id, t);
    return this.permit(id);
  }

  permitRow(id) { return parsePermit(this.one('SELECT * FROM permits WHERE id = ?', id)); }

  permit(id) {
    const p = this.permitRow(id);
    if (!p) return null;
    return { ...p, files: this.permitFiles(id) };
  }

  permitFiles(id) { return this.all('SELECT id, kind, name, mime, bytes, created_at, text IS NOT NULL AS has_text FROM permit_files WHERE permit_id = ? ORDER BY created_at', id); }
  permitFileTexts(id) { return this.all('SELECT kind, name, text FROM permit_files WHERE permit_id = ? AND text IS NOT NULL', id); }
  permitFile(permitId, fileId) { return this.one('SELECT * FROM permit_files WHERE permit_id = ? AND id = ?', permitId, fileId); }

  // Saves answers and everything computed from them. Not audited per keystroke; status changes are.
  savePermit(id, p, { byApplicant = true } = {}) {
    const sets = []; const args = [];
    for (const [k, v] of Object.entries(p)) { sets.push(`${k} = ?`); args.push(PERMIT_JSON.includes(k) && v != null ? JSON.stringify(v) : v); }
    const t = now();
    sets.push('updated_at = ?'); args.push(t);
    if (byApplicant) { sets.push('applicant_at = ?'); args.push(t); }
    this.run(`UPDATE permits SET ${sets.join(', ')} WHERE id = ?`, ...args, id);
    return this.permit(id);
  }

  addPermitFile(f) {
    this.run('INSERT INTO permit_files (id, permit_id, kind, name, mime, bytes, file_key, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      f.id, f.permit_id, f.kind, f.name, f.mime, f.bytes, f.file_key, f.text ?? null, now());
    this.run('UPDATE permits SET updated_at = ?, applicant_at = ? WHERE id = ?', now(), now(), f.permit_id);
    return this.permitFiles(f.permit_id);
  }

  savePermitFileText(permitId, fileId, text) { this.run('UPDATE permit_files SET text = ? WHERE permit_id = ? AND id = ?', text, permitId, fileId); }

  // The stored copy of a city document, by the address it was published at.
  documentFileBySource(url) {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    return this.one('SELECT file_key FROM documents WHERE source_url LIKE ? AND file_key IS NOT NULL ORDER BY updated_at DESC', `%${path}%`)?.file_key || null;
  }

  removePermitFile(permitId, fileId) {
    const f = this.permitFile(permitId, fileId);
    if (f) this.run('DELETE FROM permit_files WHERE id = ?', fileId);
    return f;
  }

  permitEvent(id, { actor, kind, status = null, note = null, data = null, isPublic = false }) {
    this.run('INSERT INTO permit_events (permit_id, at, actor_type, actor_name, kind, status, note, data, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, now(), actor.type, actor.name, kind, status, note, data ? JSON.stringify(data) : null, isPublic ? 1 : 0);
  }

  // Gives the application its reference number the first time it is submitted.
  submitPermit(id, prefix, actor) {
    return this.tx(() => {
      const p = this.permitRow(id);
      let ref = p.ref;
      if (!ref) {
        const n = Number(this.one("SELECT value FROM meta WHERE key = 'permit_seq'").value) + 1;
        this.run("UPDATE meta SET value = ? WHERE key = 'permit_seq'", String(n));
        ref = `${prefix}-BP-${n}`;
      }
      const t = now();
      const again = p.status === 'needs_info';
      this.run("UPDATE permits SET ref = ?, status = 'submitted', submitted_at = ?, updated_at = ?, applicant_at = ? WHERE id = ?", ref, t, t, t, id);
      this.permitEvent(id, { actor, kind: 'status', status: 'submitted', note: again ? 'Corrections submitted by the applicant' : 'Application submitted', isPublic: true });
      this.log(actor, again ? 'permit.resubmit' : 'permit.submit', 'permit', ref,
        `${ref} ${again ? 'resubmitted with corrections' : 'submitted'}: ${String(p.data.description || 'construction permit').slice(0, 80)}${p.address ? ` at ${p.address}` : ''}`);
      return this.permit(id);
    });
  }

  // Staff and AI decisions. patch holds the columns that change with the status.
  setPermitStatus(id, status, actor, { note = null, publicNote = null, patch = {}, kind = 'status', data = null } = {}) {
    return this.tx(() => {
      const before = this.permitRow(id);
      const cols = { status, ...patch };
      if (['issued', 'denied'].includes(status)) cols.decided_at = now();
      const sets = Object.keys(cols).map((k) => `${k} = ?`);
      this.run(`UPDATE permits SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(cols), now(), id);
      if (publicNote || status !== before.status) this.permitEvent(id, { actor, kind, status, note: publicNote, data, isPublic: true });
      if (note) this.permitEvent(id, { actor, kind: 'note', status, note });
      const changes = { status: [before.status, status] };
      for (const k of Object.keys(patch)) if (before[k] !== patch[k]) changes[k] = [before[k] ?? null, patch[k]];
      this.log(actor, `permit.${kind === 'status' ? status : kind}`, 'permit', before.ref || id,
        `${before.ref || 'Draft'}: ${status.replace(/_/g, ' ')}${publicNote ? ` (${publicNote.slice(0, 120)})` : ''}`, changes);
      return this.permit(id);
    });
  }

  permitNote(id, actor, note, isPublic = false) {
    const p = this.permitRow(id);
    this.permitEvent(id, { actor, kind: 'note', status: p.status, note, isPublic });
    this.log(actor, 'permit.note', 'permit', p.ref || id, `${p.ref}: ${isPublic ? 'message to applicant' : 'note'}`);
  }

  assignPermit(id, assigneeId, actor) {
    const p = this.permitRow(id);
    if (assigneeId && !this.staffMember(assigneeId)) throw new Error('Unknown staff member');
    this.run('UPDATE permits SET assignee_id = ?, updated_at = ? WHERE id = ?', assigneeId, now(), id);
    const name = assigneeId ? this.staffMember(assigneeId).name : 'nobody';
    this.permitEvent(id, { actor, kind: 'note', status: p.status, note: `Assigned to ${name}` });
    this.log(actor, 'permit.assign', 'permit', p.ref, `${p.ref}: assigned to ${name}`, { assignee_id: [p.assignee_id, assigneeId] });
  }

  listPermits({ status } = {}) {
    const rows = status ? this.all(`${PERMIT_LIST} WHERE p.status = ? ORDER BY p.updated_at DESC LIMIT 300`, status)
      : this.all(`${PERMIT_LIST} WHERE p.status != 'draft' ORDER BY p.updated_at DESC LIMIT 300`);
    return rows.map(parsePermit);
  }

  permitForStaff(id) {
    const p = this.permit(id);
    if (!p) return null;
    const { token_hash, ...rest } = p;
    return {
      ...rest,
      assignee: rest.assignee_id ? this.staffMember(rest.assignee_id)?.name : null,
      events: this.all('SELECT at, actor_type, actor_name, kind, status, note, data, public FROM permit_events WHERE permit_id = ? ORDER BY id', id)
        .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null })),
      outbox: this.all("SELECT at, channel, to_addr, subject, body, status, error FROM outbox WHERE entity_type = 'permit' AND entity_id = ? ORDER BY id", id),
    };
  }

  permitPublicEvents(id) {
    return this.all('SELECT at, kind, status, note, data FROM permit_events WHERE permit_id = ? AND public = 1 ORDER BY id', id).map((e) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  }

  // What anyone can see with the reference number alone.
  trackPermit(ref) {
    const p = this.one('SELECT id, ref, kind, status, permit_number, submitted_at, updated_at, decided_at FROM permits WHERE ref = ?', ref);
    if (!p) return null;
    const updates = this.all("SELECT at, status, kind FROM permit_events WHERE permit_id = ? AND public = 1 AND kind = 'status' ORDER BY id", p.id);
    const { id, ...rest } = p;
    return { ...rest, type: 'permit', updates };
  }

  recordOutbox(o) {
    this.run('INSERT INTO outbox (at, entity_type, entity_id, channel, to_addr, subject, body, status, provider_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      now(), o.entity_type, o.entity_id, o.channel, o.to_addr, o.subject, o.body, o.status, o.provider_id, o.error);
  }

  // Applications waiting on the applicant: unfinished drafts with contact details, and corrections not yet made.
  permitsNeedingReminder() {
    const day = 864e5;
    const draftCut = new Date(Date.now() - 2 * day).toISOString();
    const infoCut = new Date(Date.now() - 4 * day).toISOString();
    return this.all(`SELECT id FROM permits WHERE contact IS NOT NULL AND reminders < 2 AND (
        (status = 'draft' AND applicant_at < ? AND progress >= 15) OR (status = 'needs_info' AND applicant_at < ?))`, draftCut, infoCut)
      .map((r) => this.permitRow(r.id))
      .filter((p) => !p.reminders || p.updated_at < new Date(Date.now() - 3 * day).toISOString());
  }

  /* ---------------- Overview, audit, export ---------------- */

  overview(tzModifier = '+0 minutes') {
    const one = (sql, ...a) => this.one(sql, ...a) || {};
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const real = "channel != 'staff-test'";
    return {
      knowledge: {
        ...one("SELECT COUNT(*) AS n, COALESCE(SUM(chunks),0) AS chunks, COALESCE(SUM(chars),0) AS chars, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(status='error'),0) AS errors FROM documents"),
        categories: this.all('SELECT category, COUNT(*) AS n, COALESCE(SUM(chunks),0) AS chunks FROM documents GROUP BY category ORDER BY n DESC'),
      },
      conversations: one(`SELECT COUNT(*) AS n FROM conversations WHERE ${real}`).n,
      questions: one(`SELECT COUNT(*) AS n FROM messages m JOIN conversations v ON v.id = m.convo_id WHERE v.${real} AND m.role = 'user'`).n,
      needsReview: one(`SELECT COUNT(*) AS n FROM conversations WHERE status = 'needs_review' AND ${real}`).n,
      requests: one('SELECT COUNT(*) AS n FROM requests').n,
      openRequests: one("SELECT COUNT(*) AS n FROM requests WHERE status NOT IN ('resolved','closed')").n,
      topDocuments: this.all('SELECT d.id, d.title, d.category, COUNT(*) AS n FROM citations c JOIN documents d ON d.id = c.doc_id GROUP BY d.id ORDER BY n DESC LIMIT 6'),
      recentQuestions: this.all(`SELECT id, first_question, status, last_at, channel FROM conversations WHERE ${real} ORDER BY last_at DESC LIMIT 8`),
      byDay: this.all(`SELECT substr(datetime(started_at, ?), 1, 10) AS day, COUNT(*) AS n FROM conversations WHERE ${real} AND started_at >= ? GROUP BY day ORDER BY day`, tzModifier, since),
      recentRequests: this.all('SELECT r.id, r.ref, r.category, d.name AS department, r.status, r.location, r.created_at FROM requests r JOIN departments d ON d.id = r.department_id ORDER BY r.id DESC LIMIT 5'),
      unanswered: this.all(`SELECT id, first_question, last_at FROM conversations WHERE status = 'needs_review' AND ${real} ORDER BY last_at DESC LIMIT 5`),
      permits: {
        ...one("SELECT COALESCE(SUM(status = 'draft'), 0) AS drafts, COALESCE(SUM(status IN ('submitted', 'needs_info', 'fees_due', 'in_review')), 0) AS open, COALESCE(SUM(status = 'submitted'), 0) AS toReview, COALESCE(SUM(status = 'issued'), 0) AS issued FROM permits"),
        recent: this.all("SELECT id, ref, status, address, applicant, submitted_at FROM permits WHERE status != 'draft' ORDER BY updated_at DESC LIMIT 5"),
      },
    };
  }

  audit({ before, limit = 100, entityType, entityId } = {}) {
    const where = [];
    const args = [];
    if (before) { where.push('id < ?'); args.push(Number(before)); }
    if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
    if (entityId) { where.push('entity_id = ?'); args.push(String(entityId)); }
    const rows = this.all(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...args, Math.min(limit, 500));
    return rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(r.changes) : null }));
  }

  // Everything this city has, for backups or when a city wants its data.
  exportAll() {
    const tables = ['meta', 'departments', 'request_types', 'staff', 'documents', 'chunks', 'conversations', 'messages', 'citations', 'requests', 'request_events',
      'permits', 'permit_files', 'permit_events', 'outbox', 'audit_log'];
    return Object.fromEntries(tables.map((t) => [t, this.all(`SELECT * FROM ${t}`)
      .map(({ token_hash, ...r }) => r)]));
  }

  stats() {
    return {
      ...Object.fromEntries(['documents', 'chunks', 'conversations', 'requests', 'permits', 'audit_log'].map((t) => [t, this.one(`SELECT COUNT(*) AS n FROM ${t}`).n])),
      bytes: this.ctx.storage.sql.databaseSize,
      schema: Number(this.one("SELECT value FROM meta WHERE key = 'schema_version'")?.value || 0),
    };
  }

  /* ---------------- One-time move from the original shared database ---------------- */

  async importLegacy(slug, prefix, actor) {
    if (this.one("SELECT value FROM meta WHERE key = 'legacy_import'")) return { skipped: true, ...this.stats() };
    const db = this.env.DB;
    const q = async (sql) => (await db.prepare(sql).bind(slug).all()).results;
    const docs = await q('SELECT * FROM documents WHERE city = ?');
    const chunks = await q('SELECT doc_id, ord, heading, text FROM chunks_fts WHERE city = ?');
    const convos = await q('SELECT * FROM conversations WHERE city = ?');
    const msgs = await q('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.convo_id WHERE c.city = ? ORDER BY m.id');
    const cites = await q('SELECT * FROM citations WHERE city = ?');
    const reqs = await q('SELECT * FROM requests WHERE city = ? ORDER BY id');
    const docTitle = new Map(docs.map((d) => [d.id, d.title]));
    // Files move under this city's permanent id, like every new upload.
    const cityId = this.one("SELECT value FROM meta WHERE key = 'city_id'").value;
    const moved = new Map();
    for (const d of docs) {
      if (!d.file_key || d.file_key.startsWith(`${cityId}/`)) continue;
      const obj = await this.env.FILES.get(d.file_key);
      if (!obj) continue;
      const key = `${cityId}/documents/${d.id}/${d.file_key.split('/').pop()}`;
      await this.env.FILES.put(key, obj.body, { httpMetadata: obj.httpMetadata });
      moved.set(d.id, key);
    }
    this.tx(() => {
      for (const d of docs) {
        this.run(`INSERT INTO documents (id, title, category, source_url, authority, visibility, verification, as_of, file_key, file_name, mime, bytes, chars, chunks, status, error, notes, created_by, updated_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.id, d.title, d.category, d.source_url, d.authority, d.visibility, d.verification, d.as_of, moved.get(d.id) || d.file_key, d.file_name, d.mime, d.bytes, d.chars, d.chunks,
        d.status, d.error, d.notes, 'Initial import', 'Initial import', iso(d.created_at), iso(d.updated_at));
      }
      for (const c of chunks) {
        if (docTitle.has(c.doc_id)) this.run('INSERT INTO chunks (doc_id, ord, title, heading, text) VALUES (?, ?, ?, ?, ?)', c.doc_id, Number(c.ord), docTitle.get(c.doc_id), c.heading || '', c.text);
      }
      for (const c of convos) {
        this.run('INSERT INTO conversations (id, channel, page_url, status, messages, first_question, started_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          c.id, c.channel, c.page_url, c.status, c.messages, c.first_question, iso(c.started_at), iso(c.last_at));
      }
      for (const m of msgs) {
        this.run('INSERT INTO messages (convo_id, role, content, sources, flag, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          m.convo_id, m.role, m.content, m.sources, m.flag, m.model, iso(m.created_at));
      }
      for (const c of cites) {
        if (docTitle.has(c.doc_id)) this.run('INSERT INTO citations (doc_id, convo_id, created_at) VALUES (?, ?, ?)', c.doc_id, c.convo_id, iso(c.created_at));
      }
      const deptByName = new Map(this.departments().map((d) => [d.name, d.id]));
      for (const r of reqs) {
        const type = this.one('SELECT key FROM request_types WHERE label = ?', r.category)?.key || 'other';
        const { id } = this.one(`INSERT INTO requests (ref, type_key, category, department_id, description, summary, location, name, contact, photo_key, status, priority, source, convo_id, created_at, updated_at)
          VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        type, r.category, deptByName.get(r.department) || 'city-hall', r.description, r.summary, r.location, r.name, r.contact, r.photo_key,
        r.status, r.priority, r.convo_id ? 'chat' : 'web', r.convo_id, iso(r.created_at), iso(r.updated_at));
        this.run('UPDATE requests SET ref = ? WHERE id = ?', `${prefix}-${id}`, id);
        for (const h of JSON.parse(r.history || '[]')) {
          this.run("INSERT INTO request_events (request_id, at, actor_type, actor_name, status, note, public) VALUES (?, ?, 'system', ?, ?, ?, 0)", id, h.at, h.by, h.status, h.note);
        }
      }
      this.run("INSERT INTO meta (key, value) VALUES ('legacy_import', ?)", now());
      this.log(actor, 'city.import', 'city', null, `Moved ${docs.length} documents (${chunks.length} passages), ${convos.length} conversations and ${reqs.length} requests from the original shared database`);
    });
    for (const d of docs) if (moved.has(d.id)) await this.env.FILES.delete(d.file_key);
    return { ...this.stats(), filesMoved: moved.size };
  }
}
