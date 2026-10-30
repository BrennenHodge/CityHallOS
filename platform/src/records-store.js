// Public records requests in a city's store. These run inside CityStore (as `this`), through CityStore.records(op, ...args).
// Every change is written to the audit log; the request's timeline keeps what the requester can see apart from staff notes.

const now = () => new Date().toISOString();
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const key = () => crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export const RECORDS_TABLES = ['records_requests', 'records_events', 'records_files', 'records_letters', 'records_suggestions', 'records_settings'];
export const OPEN_STATUSES = ['new', 'acknowledged', 'in_progress', 'awaiting_payment', 'ready'];
const FIELDS = ['status', 'summary', 'assignee_id', 'department_id'];
const SELECT = `SELECT r.*, s.name AS assignee, d.name AS department,
    (SELECT COUNT(*) FROM records_files f WHERE f.request_id = r.id) AS files,
    (SELECT COUNT(*) FROM records_suggestions g WHERE g.request_id = r.id AND g.status = 'pending') AS pending_suggestions
  FROM records_requests r LEFT JOIN staff s ON s.id = r.assignee_id LEFT JOIN departments d ON d.id = r.department_id`;

function event(store, id, actor, kind, note, isPublic) {
  store.run('INSERT INTO records_events (request_id, at, actor_type, actor_id, actor_name, kind, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, now(), actor.type, actor.id ?? null, actor.name, kind, note, isPublic ? 1 : 0);
}

function row(store, id) { return store.one('SELECT * FROM records_requests WHERE id = ?', id); }

function touch(store, id) { store.run('UPDATE records_requests SET updated_at = ? WHERE id = ?', now(), id); }

const shape = (r) => {
  if (!r) return r;
  const { access_key, ...rest } = r;
  return { ...rest, fee_lines: parse(r.fee_lines, []), exemptions: parse(r.exemptions, []) };
};

export const RECORDS = {
  getSettings() { return parse(this.one('SELECT value FROM records_settings WHERE id = 1')?.value); },

  saveSettings(value, actor, changes) {
    this.tx(() => {
      this.run('INSERT INTO records_settings (id, value, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        JSON.stringify(value), now());
      this.log(actor, 'records.settings', 'settings', 'records', `Changed ${Object.keys(changes).join(', ') || 'nothing'} in Records settings`, changes);
    });
    return value;
  },

  create(r, actor, prefix, { receivedAt, dueDate }) {
    const convoId = r.convo_id && this.one('SELECT id FROM conversations WHERE id = ?', r.convo_id) ? r.convo_id : null;
    const accessKey = key();
    const t = now();
    return this.tx(() => {
      const { id } = this.one(`INSERT INTO records_requests (ref, access_key, records, summary, date_from, date_to, format, name, email, phone, address, organization,
          source, convo_id, received_at, due_date, created_at, updated_at)
        VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      accessKey, r.records, r.summary ?? null, r.date_from ?? null, r.date_to ?? null, r.format, r.name, r.email ?? null, r.phone ?? null, r.address ?? null,
      r.organization ?? null, r.source, convoId, receivedAt, dueDate, t, t);
      const ref = `${prefix}-PRR-${id}`;
      this.run('UPDATE records_requests SET ref = ? WHERE id = ?', ref, id);
      event(this, id, actor, 'received', `Request received. A response is due by ${dueDate}.`, true);
      this.log(actor, 'records.create', 'records_request', ref, `${ref} received from ${actor.type === 'resident' ? 'a resident' : 'staff'}: ${r.records.slice(0, 120)}`,
        { due_date: [null, dueDate], source: [null, r.source] });
      if (convoId) {
        this.run("INSERT INTO messages (convo_id, role, content, flag, model, created_at) VALUES (?, 'assistant', ?, 'action', 'workflow', ?)",
          convoId, `Created public records request ${ref}. Response due by ${dueDate}.`, t);
      }
      return { id, ref, accessKey };
    });
  },

  list() { return this.all(`${SELECT} ORDER BY r.id DESC LIMIT 500`).map(shape); },

  get(id) {
    const r = this.one(`${SELECT} WHERE r.id = ?`, id);
    if (!r) return null;
    return {
      request: shape(r),
      events: this.all('SELECT at, kind, actor_name AS by, actor_type, note, public FROM records_events WHERE request_id = ? ORDER BY id', id),
      files: this.all('SELECT id, name, mime, bytes, doc_id, source, flags, status, reviewed_by, reviewed_at, released_at, created_by, created_at FROM records_files WHERE request_id = ? ORDER BY created_at', id)
        .map((f) => ({ ...f, flags: parse(f.flags, []) })),
      letters: this.all("SELECT * FROM records_letters WHERE request_id = ? AND status != 'discarded' ORDER BY created_at", id),
      suggestions: this.all("SELECT * FROM records_suggestions WHERE request_id = ? ORDER BY status = 'pending' DESC, created_at", id)
        .map((s) => ({ ...s, payload: parse(s.payload, {}) })),
    };
  },

  // For notices and the Worker's checks. Includes the access key, so it never goes to the dashboard as is.
  raw(id) { return row(this, id); },
  idForRef(ref) { return this.one('SELECT id FROM records_requests WHERE ref = ?', ref)?.id ?? null; },

  // What the requester sees. With the key from their tracking link: letters sent to them, the fee and released files.
  track(ref, accessKey) {
    const r = this.one('SELECT * FROM records_requests WHERE ref = ?', ref);
    if (!r) return null;
    const full = !!accessKey && accessKey === r.access_key;
    const out = {
      ref: r.ref, status: r.status, outcome: r.outcome, format: r.format, received_at: r.received_at, due_date: r.due_date,
      extended_due: r.extended_due, closed_at: r.closed_at, verified: full,
      updates: this.all('SELECT at, kind, note FROM records_events WHERE request_id = ? AND public = 1 ORDER BY id', r.id),
    };
    if (!full) return out;
    return {
      ...out, records: r.records, date_from: r.date_from, date_to: r.date_to, extension_reason: r.extension_reason,
      fee: { status: r.fee_status, cents: r.fee_cents, lines: parse(r.fee_lines, []), paid_cents: r.paid_cents },
      exemptions: parse(r.exemptions, []), denial_reason: r.denial_reason,
      letters: this.all("SELECT kind, subject, body, sent_at FROM records_letters WHERE request_id = ? AND status = 'sent' ORDER BY sent_at", r.id),
      files: this.all("SELECT id, name, mime, bytes, released_at FROM records_files WHERE request_id = ? AND status = 'released' ORDER BY name", r.id),
    };
  },

  update(id, p, actor) {
    const before = row(this, id);
    if (!before) return null;
    if (before.status === 'closed') throw new Error('This request is closed');
    const next = { ...before, ...p };
    if (next.assignee_id && !this.staffMember(next.assignee_id)) throw new Error('Unknown staff member');
    if (next.department_id && !this.one('SELECT id FROM departments WHERE id = ?', next.department_id)) throw new Error('Unknown department');
    const changes = Object.fromEntries(FIELDS.filter((f) => f in p && (before[f] ?? null) !== (next[f] ?? null)).map((f) => [f, [before[f] ?? null, next[f] ?? null]]));
    if (!Object.keys(changes).length && !p.note) return RECORDS.get.call(this, id);
    const words = [];
    if (changes.status) words.push(`Status: ${next.status.replace(/_/g, ' ')}`);
    if (changes.assignee_id) words.push(`Assigned to ${next.assignee_id ? this.staffMember(next.assignee_id).name : 'nobody'}`);
    if (changes.department_id) words.push(`Department: ${next.department_id ? this.one('SELECT name FROM departments WHERE id = ?', next.department_id).name : 'none'}`);
    if (changes.summary) words.push('Updated the scope summary');
    const note = [words.join(' · '), p.note].filter(Boolean).join(' — ');
    this.tx(() => {
      this.run('UPDATE records_requests SET status = ?, summary = ?, assignee_id = ?, department_id = ?, updated_at = ? WHERE id = ?',
        next.status, next.summary, next.assignee_id, next.department_id, now(), id);
      event(this, id, actor, changes.status ? 'status' : 'note', note, false);
      this.log(actor, 'records.update', 'records_request', before.ref, `${before.ref}: ${note}`, changes);
    });
    return RECORDS.get.call(this, id);
  },

  acknowledge(id, actor) {
    const r = row(this, id);
    if (r.acknowledged_at) return;
    this.tx(() => {
      this.run("UPDATE records_requests SET acknowledged_at = ?, status = CASE WHEN status = 'new' THEN 'acknowledged' ELSE status END, updated_at = ? WHERE id = ?", now(), now(), id);
      event(this, id, actor, 'acknowledged', 'Request acknowledged in writing.', true);
      this.log(actor, 'records.acknowledge', 'records_request', r.ref, `${r.ref}: acknowledgment sent to the requester`, { status: [r.status, r.status === 'new' ? 'acknowledged' : r.status] });
    });
  },

  extend(id, { due, reason, agreed }, actor) {
    const r = row(this, id);
    this.tx(() => {
      this.run('UPDATE records_requests SET extended_due = ?, extension_reason = ?, updated_at = ? WHERE id = ?', due, reason, now(), id);
      event(this, id, actor, 'extended', `Response date moved to ${due}${agreed ? ' by agreement with the requester' : ''}. Reason: ${reason}`, true);
      this.log(actor, 'records.extend', 'records_request', r.ref, `${r.ref}: response date extended to ${due}${agreed ? ' by mutual agreement' : ''}`,
        { due: [r.extended_due || r.due_date, due], extension_reason: [r.extension_reason, reason] });
    });
  },

  setFee(id, { cents, lines, status, note }, actor) {
    const r = row(this, id);
    const nextStatus = status === 'requested' && r.status !== 'closed' ? 'awaiting_payment' : r.status;
    this.tx(() => {
      this.run('UPDATE records_requests SET fee_cents = ?, fee_lines = ?, fee_status = ?, status = ?, updated_at = ? WHERE id = ?',
        cents, JSON.stringify(lines || []), status, nextStatus, now(), id);
      const words = { estimated: `Fee estimate prepared: ${note}`, requested: `Fee estimate sent: ${note}. Payment is needed before the records are released.`, waived: 'Fees waived.' }[status];
      event(this, id, actor, `fee_${status}`, words, status !== 'estimated');
      this.log(actor, `records.fee_${status}`, 'records_request', r.ref, `${r.ref}: ${words}`,
        { fee_status: [r.fee_status, status], fee_cents: [r.fee_cents, cents], ...(nextStatus !== r.status ? { status: [r.status, nextStatus] } : {}) });
    });
  },

  markPaid(id, { cents, note }, actor) {
    const r = row(this, id);
    const nextStatus = r.status === 'awaiting_payment' ? 'in_progress' : r.status;
    this.tx(() => {
      this.run("UPDATE records_requests SET fee_status = 'paid', paid_cents = ?, paid_at = ?, payment_note = ?, status = ?, updated_at = ? WHERE id = ?",
        cents, now(), note, nextStatus, now(), id);
      event(this, id, actor, 'fee_paid', `Payment of $${(cents / 100).toFixed(2)} received.`, true);
      this.log(actor, 'records.fee_paid', 'records_request', r.ref, `${r.ref}: recorded payment of $${(cents / 100).toFixed(2)}${note ? ` (${note})` : ''}`,
        { fee_status: [r.fee_status, 'paid'], paid_cents: [r.paid_cents, cents] });
    });
  },

  addFile(id, f, actor) {
    const r = row(this, id);
    const fid = f.id || uid('f');
    this.tx(() => {
      this.run(`INSERT INTO records_files (id, request_id, name, mime, bytes, file_key, doc_id, source, flags, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, fid, id, f.name, f.mime, f.bytes, f.file_key, f.doc_id ?? null, f.source, JSON.stringify(f.flags || []), actor.name, now());
      const flagged = (f.flags || []).reduce((a, x) => a + x.count, 0);
      event(this, id, actor, 'file', `Added "${f.name}"${f.source === 'knowledge' ? ' from the knowledge base' : ''}${flagged ? `. ${flagged} possible redactions flagged for review` : ''}`, false);
      this.log(actor, 'records.file_add', 'records_request', r.ref, `${r.ref}: added "${f.name}" for review`, { file: [null, f.name], flags: [null, flagged] });
      touch(this, id);
    });
    return fid;
  },

  file(fid) {
    const f = this.one('SELECT * FROM records_files WHERE id = ?', fid);
    return f && { ...f, flags: parse(f.flags, []) };
  },

  // Staff approve or withhold each file, and resolve each possible redaction (redacted or not needed).
  reviewFile(fid, { status, flags }, actor) {
    const f = RECORDS.file.call(this, fid);
    const r = row(this, f.request_id);
    if (f.status === 'released') throw new Error('This file has already been released');
    const nextFlags = f.flags.map((x, i) => (flags && ['redacted', 'not_needed', 'pending'].includes(flags[i]) ? { ...x, status: flags[i] } : x));
    const next = status || f.status;
    if (next === 'approved' && nextFlags.some((x) => x.status === 'pending')) throw new Error('Resolve every possible redaction before approving this file');
    const changes = {};
    if (next !== f.status) changes.status = [f.status, next];
    nextFlags.forEach((x, i) => { if (x.status !== f.flags[i].status) changes[x.label] = [f.flags[i].status, x.status]; });
    if (!Object.keys(changes).length) return;
    this.tx(() => {
      this.run('UPDATE records_files SET status = ?, flags = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', next, JSON.stringify(nextFlags), actor.name, now(), fid);
      const what = next !== f.status ? { approved: 'Approved for release', withheld: 'Withheld', review: 'Returned to review' }[next] : 'Reviewed redactions in';
      event(this, f.request_id, actor, 'file_review', `${what} "${f.name}"`, false);
      this.log(actor, 'records.file_review', 'records_request', r.ref, `${r.ref}: ${what.toLowerCase()} "${f.name}"`, changes);
      touch(this, f.request_id);
    });
  },

  removeFile(fid, actor) {
    const f = RECORDS.file.call(this, fid);
    if (f.status === 'released') throw new Error('Released files stay on the record');
    const r = row(this, f.request_id);
    this.tx(() => {
      this.run('DELETE FROM records_files WHERE id = ?', fid);
      event(this, f.request_id, actor, 'file', `Removed "${f.name}"`, false);
      this.log(actor, 'records.file_remove', 'records_request', r.ref, `${r.ref}: removed "${f.name}" before release`, { file: [f.name, null] });
    });
    return f;
  },

  addSuggestions(id, items, actor) {
    const r = row(this, id);
    const existing = new Set(this.all("SELECT payload FROM records_suggestions WHERE request_id = ? AND kind = 'document'", id).map((s) => parse(s.payload, {}).docId));
    const fresh = items.filter((s) => !existing.has(s.docId));
    if (!fresh.length) return 0;
    this.tx(() => {
      for (const s of fresh) this.run("INSERT INTO records_suggestions (id, request_id, kind, payload, created_at) VALUES (?, ?, 'document', ?, ?)", uid('g'), id, JSON.stringify(s), now());
      this.log(actor, 'records.suggest', 'records_request', r.ref, `${r.ref}: suggested ${fresh.length} possibly responsive documents from the knowledge base`);
    });
    return fresh.length;
  },

  decideSuggestion(sid, status, actor) {
    const s = this.one('SELECT * FROM records_suggestions WHERE id = ?', sid);
    if (!s || s.status !== 'pending') return null;
    const r = row(this, s.request_id);
    const p = parse(s.payload, {});
    this.tx(() => {
      this.run('UPDATE records_suggestions SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?', status, actor.name, now(), sid);
      this.log(actor, `records.suggestion_${status}`, 'records_request', r.ref, `${r.ref}: ${status} the AI suggestion "${p.title}"`, { suggestion: ['pending', status] });
    });
    return { ...s, payload: p };
  },

  addLetter(id, l, actor) {
    const r = row(this, id);
    const lid = uid('l');
    const t = now();
    this.tx(() => {
      this.run('INSERT INTO records_letters (id, request_id, kind, subject, body, drafted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        lid, id, l.kind, l.subject, l.body, l.drafted_by, t, t);
      this.log(actor, 'records.letter_draft', 'records_request', r.ref, `${r.ref}: ${l.drafted_by === 'ai' ? 'AI drafted' : 'drafted'} the ${l.kind.replace('_', ' ')} letter`);
    });
    return lid;
  },

  letter(lid) { return this.one('SELECT * FROM records_letters WHERE id = ?', lid); },

  // Editing an approved letter sends it back to draft: what goes out is exactly what someone approved.
  updateLetter(lid, p, actor) {
    const l = this.one('SELECT * FROM records_letters WHERE id = ?', lid);
    if (!l) return null;
    if (l.status === 'sent') throw new Error('This letter was already sent');
    const r = row(this, l.request_id);
    const subject = p.subject ?? l.subject;
    const body = p.body ?? l.body;
    const edited = subject !== l.subject || body !== l.body;
    const status = p.status || (edited ? 'draft' : l.status);
    const changes = {};
    if (status !== l.status) changes.status = [l.status, status];
    if (subject !== l.subject) changes.subject = [l.subject, subject];
    if (body !== l.body) changes.body = ['(previous text)', '(edited)'];
    if (!Object.keys(changes).length) return l;
    this.tx(() => {
      this.run('UPDATE records_letters SET subject = ?, body = ?, status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?',
        subject, body, status, status === 'approved' ? actor.name : null, status === 'approved' ? now() : null, now(), lid);
      const what = { approved: 'approved', discarded: 'discarded', draft: 'edited' }[status];
      this.log(actor, `records.letter_${status}`, 'records_request', r.ref, `${r.ref}: ${what} the ${l.kind.replace('_', ' ')} letter`, changes);
    });
    return this.one('SELECT * FROM records_letters WHERE id = ?', lid);
  },

  letterSent(lid, actor, channels) {
    const l = this.one('SELECT * FROM records_letters WHERE id = ?', lid);
    const r = row(this, l.request_id);
    this.tx(() => {
      this.run("UPDATE records_letters SET status = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", now(), now(), lid);
      event(this, l.request_id, actor, 'letter', `${l.subject}`, true);
      this.log(actor, 'records.letter_sent', 'records_request', r.ref, `${r.ref}: sent the ${l.kind.replace('_', ' ')} letter to the requester${channels ? ` (${channels})` : ''}`,
        { letter: ['approved', 'sent'] });
    });
  },

  // A notice to the requester, recorded on the timeline whether or not it could be delivered.
  noticeLogged(id, actor, note) { event(this, id, actor, 'notice', note, false); },

  close(id, { outcome, exemptions, reason }, actor) {
    const r = row(this, id);
    const released = this.all("SELECT name FROM records_files WHERE request_id = ? AND status = 'approved'", id).map((f) => f.name);
    const t = now();
    const words = { fulfilled: 'Records released', partial: 'Records released in part', denied: 'Request denied', no_records: 'No responsive records found', withdrawn: 'Request withdrawn' }[outcome];
    this.tx(() => {
      this.run("UPDATE records_files SET status = 'released', released_at = ? WHERE request_id = ? AND status = 'approved'", t, id);
      this.run("UPDATE records_requests SET status = 'closed', outcome = ?, exemptions = ?, denial_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?",
        outcome, exemptions.length ? JSON.stringify(exemptions) : null, reason, t, t, id);
      event(this, id, actor, 'closed', `${words}${released.length ? ` (${released.length} ${released.length === 1 ? 'file' : 'files'})` : ''}.${exemptions.length ? ` Withheld under ${exemptions.join('; ')}.` : ''}`, true);
      this.log(actor, 'records.close', 'records_request', r.ref, `${r.ref}: ${words.toLowerCase()}${released.length ? `: ${released.join(', ')}` : ''}`,
        { status: [r.status, 'closed'], outcome: [null, outcome], ...(exemptions.length ? { exemptions: [null, exemptions.join('; ')] } : {}) });
    });
    return released;
  },

  // Every request and its outcome, for the city's log and export.
  log() {
    return this.all(`SELECT r.ref, r.received_at, r.name, r.organization, r.records, r.date_from, r.date_to, r.format, r.source, r.status, r.outcome,
        r.due_date, r.extended_due, r.extension_reason, r.acknowledged_at, r.fee_status, r.fee_cents, r.paid_cents, r.exemptions, r.denial_reason, r.closed_at,
        s.name AS assignee, (SELECT COUNT(*) FROM records_files f WHERE f.request_id = r.id AND f.status = 'released') AS released_files
      FROM records_requests r LEFT JOIN staff s ON s.id = r.assignee_id ORDER BY r.id`).map((r) => ({ ...r, exemptions: parse(r.exemptions, []).join('; ') }));
  },
};
