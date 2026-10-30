// Meeting secretary: the city store's side. Each function runs inside the city's CityStore (`this`), which
// calls them through CityStore.meetings(op, ...args). Every change is written to the audit log; changes to a
// meeting, its agenda items, files, minutes and action items are logged against the meeting, so its history
// reads in one place.

const now = () => new Date().toISOString();
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const label = (s) => String(s || '').replace(/_/g, ' ');

export const MEETING_TABLES = ['boards', 'board_members', 'meetings', 'agenda_items', 'meeting_files', 'action_items', 'meeting_settings'];

const BOARD_FIELDS = ['name', 'kind', 'description', 'schedule', 'location', 'external', 'active', 'sort'];
const MEMBER_FIELDS = ['name', 'seat', 'role', 'voting', 'staff_id', 'term_ends', 'active', 'sort'];
const MEETING_FIELDS = ['board_id', 'kind', 'title', 'starts_at', 'location', 'purpose', 'status', 'called_at', 'notice_posted_at'];
const ITEM_FIELDS = ['type', 'title', 'description', 'presenter', 'department_id', 'recommended_action', 'status', 'review_note'];
const ACTION_FIELDS = ['title', 'details', 'assignee_id', 'due_date', 'status'];
const ACTION_SELECT = `SELECT a.*, s.name AS assignee, s.email AS assignee_email, s.phone AS assignee_phone, s.notify_pref AS assignee_pref, m.starts_at AS meeting_starts_at, m.kind AS meeting_kind,
  b.name AS board FROM action_items a JOIN meetings m ON m.id = a.meeting_id JOIN boards b ON b.id = m.board_id LEFT JOIN staff s ON s.id = a.assignee_id`;

function diff(before, after, fields) {
  const out = {};
  for (const f of fields) if (f in after && (before[f] ?? null) !== (after[f] ?? null)) out[f] = [before[f] ?? null, after[f] ?? null];
  return out;
}

// A short name for a meeting in the audit log: "Board of Aldermen regular meeting, 2026-11-03 18:00".
function meetingName(store, m) {
  const board = store.one('SELECT name FROM boards WHERE id = ?', m.board_id)?.name || 'Meeting';
  return `${board} ${label(m.kind)} meeting, ${m.starts_at.replace('T', ' ')}`;
}

function updateRow(store, table, id, before, patch, fields) {
  const next = { ...before, ...patch };
  const changes = diff(before, next, fields);
  if (Object.keys(changes).length) {
    const cols = Object.keys(changes);
    store.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => next[c]), now(), id);
  }
  return changes;
}

export const MEETING_OPS = {
  /* ---------------- Notice rules ---------------- */

  settings() {
    const row = this.one("SELECT value FROM meeting_settings WHERE key = 'rules'");
    return row ? JSON.parse(row.value) : null;
  },

  saveSettings(rules, before, actor) {
    const changes = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(rules)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(rules[k])) changes[k] = [before[k] ?? null, rules[k] ?? null];
    }
    this.tx(() => {
      this.run("INSERT OR REPLACE INTO meeting_settings (key, value) VALUES ('rules', ?)", JSON.stringify(rules));
      if (Object.keys(changes).length) this.log(actor, 'meetings.settings', 'settings', 'meetings', 'Changed public notice rules for meetings', changes);
    });
    return rules;
  },

  /* ---------------- Boards and members ---------------- */

  boards({ includeInactive = false } = {}) {
    const boards = this.all(`SELECT * FROM boards ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
    const members = this.all(`SELECT bm.*, s.name AS staff_name FROM board_members bm LEFT JOIN staff s ON s.id = bm.staff_id
      ORDER BY bm.active DESC, bm.sort, CASE bm.role WHEN 'presiding' THEN 0 WHEN 'vice' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, bm.name`);
    return boards.map((b) => ({ ...b, members: members.filter((m) => m.board_id === b.id) }));
  },

  board(id) { return this.one('SELECT * FROM boards WHERE id = ?', id); },

  saveBoard(id, p, actor) {
    return this.tx(() => {
      if (!id) {
        id = uid('b');
        const t = now();
        this.run('INSERT INTO boards (id, name, kind, description, schedule, location, external, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          id, p.name, p.kind || 'board', p.description ?? null, p.schedule ?? null, p.location ?? null, p.external ?? 0, p.sort ?? 0, t, t);
        this.log(actor, 'board.create', 'board', id, `Added the ${p.name}${p.external ? " (another government's body)" : ''}`);
        return this.board(id);
      }
      const before = this.board(id);
      if (!before) return null;
      const changes = updateRow(this, 'boards', id, before, p, BOARD_FIELDS);
      if (Object.keys(changes).length) this.log(actor, 'board.update', 'board', id, `Updated the ${p.name || before.name}`, changes);
      return this.board(id);
    });
  },

  member(id) { return this.one('SELECT * FROM board_members WHERE id = ?', id); },

  saveMember(id, p, actor) {
    return this.tx(() => {
      if (!id) {
        const board = this.board(p.board_id);
        if (!board) throw new Error('Unknown board');
        id = uid('bm');
        const t = now();
        this.run(`INSERT INTO board_members (id, board_id, name, seat, role, voting, staff_id, term_ends, sort, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, board.id, p.name, p.seat ?? null, p.role || 'member', p.voting ?? 1, p.staff_id ?? null,
        p.term_ends ?? null, p.sort ?? 0, t, t);
        this.log(actor, 'board.member_add', 'board', board.id, `Added ${p.name}${p.seat ? ` (${p.seat})` : ''} to the ${board.name}`);
        return this.member(id);
      }
      const before = this.member(id);
      if (!before) return null;
      const changes = updateRow(this, 'board_members', id, before, p, MEMBER_FIELDS);
      if (Object.keys(changes).length) {
        const board = this.board(before.board_id);
        this.log(actor, 'board.member_update', 'board', board.id, `Updated ${p.name || before.name} on the ${board.name}`, changes);
      }
      return this.member(id);
    });
  },

  /* ---------------- Meetings ---------------- */

  list({ from, to, boardId, limit = 200 } = {}) {
    const where = [];
    const args = [];
    if (from) { where.push('m.starts_at >= ?'); args.push(from); }
    if (to) { where.push('m.starts_at < ?'); args.push(to); }
    if (boardId) { where.push('m.board_id = ?'); args.push(boardId); }
    return this.all(`SELECT m.id, m.board_id, b.name AS board, b.external, m.historical, m.record_source, m.kind, m.title, m.starts_at, m.location, m.purpose, m.status, m.called_at,
        m.notice_posted_at, m.agenda_status, m.agenda_published_at, m.agenda_late, m.transcript_status, m.minutes_status, m.minutes_approved_at,
        (SELECT COUNT(*) FROM agenda_items i WHERE i.meeting_id = m.id AND i.status = 'accepted') AS items,
        (SELECT COUNT(*) FROM agenda_items i WHERE i.meeting_id = m.id AND i.status = 'submitted') AS submitted,
        (SELECT COUNT(*) FROM action_items a WHERE a.meeting_id = m.id AND a.status IN ('open', 'in_progress')) AS open_actions
      FROM meetings m JOIN boards b ON b.id = m.board_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.starts_at ${from ? 'ASC' : 'DESC'} LIMIT ?`, ...args, Math.min(limit, 500));
  },

  row(id) { return this.one('SELECT * FROM meetings WHERE id = ?', id); },

  get(id) {
    const m = this.one('SELECT m.*, b.name AS board, b.kind AS board_kind, b.external FROM meetings m JOIN boards b ON b.id = m.board_id WHERE m.id = ?', id);
    if (!m) return null;
    return {
      meeting: { ...m, minutes_suggestions: m.minutes_suggestions ? JSON.parse(m.minutes_suggestions) : null,
        transcript_progress: m.transcript_progress ? JSON.parse(m.transcript_progress) : null },
      members: this.all("SELECT * FROM board_members WHERE board_id = ? AND active = 1 ORDER BY sort, CASE role WHEN 'presiding' THEN 0 WHEN 'vice' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, name", m.board_id),
      items: this.all(`SELECT i.*, d.name AS department FROM agenda_items i LEFT JOIN departments d ON d.id = i.department_id
        WHERE i.meeting_id = ? ORDER BY CASE i.status WHEN 'accepted' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END, i.ord, i.created_at`, id),
      files: this.all("SELECT id, item_id, kind, file_name, mime, bytes, status, created_by, created_at FROM meeting_files WHERE meeting_id = ? AND status = 'ready' ORDER BY created_at", id),
      actions: this.all(`${ACTION_SELECT} WHERE a.meeting_id = ? ORDER BY a.created_at`, id),
    };
  },

  create(p, actor) {
    const id = uid('m');
    const t = now();
    return this.tx(() => {
      this.run(`INSERT INTO meetings (id, board_id, kind, title, starts_at, location, purpose, status, historical, called_at, notice_posted_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, p.board_id, p.kind, p.title ?? null, p.starts_at, p.location ?? null, p.purpose ?? null,
      p.historical ? 'held' : 'scheduled', p.historical ? 1 : 0, p.called_at ?? null, p.notice_posted_at ?? null, actor.name, t, t);
      const m = this.row(id);
      this.log(actor, 'meeting.create', 'meeting', id, `${p.historical ? 'Added the past' : 'Scheduled the'} ${meetingName(this, m)}`,
        { kind: [null, p.kind], starts_at: [null, p.starts_at], location: [null, p.location ?? null] });
      return m;
    });
  },

  update(id, p, actor) {
    const before = this.row(id);
    if (!before) return null;
    return this.tx(() => {
      const changes = updateRow(this, 'meetings', id, before, p, MEETING_FIELDS);
      if (Object.keys(changes).length) {
        const what = changes.status ? `Marked the ${meetingName(this, before)} ${changes.status[1]}` : `Updated the ${meetingName(this, before)}`;
        this.log(actor, 'meeting.update', 'meeting', id, what, changes);
      }
      return this.row(id);
    });
  },

  /* ---------------- Agenda ---------------- */

  item(id) { return this.one('SELECT * FROM agenda_items WHERE id = ?', id); },

  addItem(meetingId, p, actor) {
    const m = this.row(meetingId);
    if (!m) return null;
    const id = uid('ai');
    const t = now();
    return this.tx(() => {
      const ord = (this.one("SELECT MAX(ord) AS n FROM agenda_items WHERE meeting_id = ? AND status = 'accepted'", meetingId)?.n ?? 0) + 1;
      this.run(`INSERT INTO agenda_items (id, meeting_id, ord, type, title, description, presenter, department_id, recommended_action, status,
          submitted_by, submitted_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, meetingId, ord, p.type, p.title, p.description ?? null, p.presenter ?? null, p.department_id ?? null, p.recommended_action ?? null,
      p.status, actor.name, actor.id ?? null, t, t);
      this.log(actor, p.status === 'accepted' ? 'agenda.item_add' : 'agenda.item_submit', 'meeting', meetingId,
        `${p.status === 'accepted' ? 'Added' : 'Submitted'} "${p.title}" (${label(p.type)}) ${p.status === 'accepted' ? 'to' : 'for'} the agenda of the ${meetingName(this, m)}`);
      return this.item(id);
    });
  },

  updateItem(id, p, actor) {
    const before = this.item(id);
    if (!before) return null;
    return this.tx(() => {
      if (p.status === 'accepted' && before.status !== 'accepted') {
        p.ord = (this.one("SELECT MAX(ord) AS n FROM agenda_items WHERE meeting_id = ? AND status = 'accepted'", before.meeting_id)?.n ?? 0) + 1;
        this.run('UPDATE agenda_items SET ord = ? WHERE id = ?', p.ord, id);
      }
      const changes = updateRow(this, 'agenda_items', id, before, p, ITEM_FIELDS);
      if (Object.keys(changes).length) {
        const verb = { accepted: 'Accepted', returned: 'Returned', withdrawn: 'Withdrew', submitted: 'Resubmitted' }[changes.status?.[1]] || 'Updated';
        this.log(actor, changes.status ? `agenda.item_${changes.status[1]}` : 'agenda.item_update', 'meeting', before.meeting_id,
          `${verb} agenda item "${p.title || before.title}"${changes.status?.[1] === 'returned' && p.review_note ? `: ${p.review_note}` : ''}`, changes);
      }
      return this.item(id);
    });
  },

  orderItems(meetingId, ids, actor) {
    const current = this.all("SELECT id, title, ord FROM agenda_items WHERE meeting_id = ? AND status = 'accepted' ORDER BY ord", meetingId);
    if (ids.length !== current.length || !current.every((c) => ids.includes(c.id))) throw new Error('Send every accepted item exactly once');
    if (current.every((c, i) => c.id === ids[i])) return current;
    const title = new Map(current.map((c) => [c.id, c.title]));
    this.tx(() => {
      ids.forEach((id, i) => this.run('UPDATE agenda_items SET ord = ?, updated_at = ? WHERE id = ?', i + 1, now(), id));
      this.log(actor, 'agenda.order', 'meeting', meetingId, 'Reordered the agenda',
        { order: [current.map((c) => c.title), ids.map((id) => title.get(id))] });
    });
    return this.all("SELECT id, title, ord FROM agenda_items WHERE meeting_id = ? AND status = 'accepted' ORDER BY ord", meetingId);
  },

  setAgendaStatus(id, status, actor) {
    const before = this.row(id);
    if (!before) return null;
    if (before.agenda_status === status) return before;
    this.tx(() => {
      this.run('UPDATE meetings SET agenda_status = ?, updated_at = ? WHERE id = ?', status, now(), id);
      const what = status === 'ready' ? 'Sent the agenda for approval' : status === 'draft' && before.agenda_status === 'published'
        ? 'Reopened the published agenda for revision (residents still see the published version)' : 'Returned the agenda to draft';
      this.log(actor, 'agenda.status', 'meeting', id, `${what}: ${meetingName(this, before)}`, { agenda_status: [before.agenda_status, status] });
    });
    return this.row(id);
  },

  // A person with meetings.approve publishes the agenda. The snapshot is what residents and the AI City Clerk see.
  publishAgenda(id, { text, late, lateReason }, actor) {
    const before = this.row(id);
    if (!before) return null;
    const t = now();
    this.tx(() => {
      this.run(`UPDATE meetings SET agenda_status = 'published', agenda_published = ?, agenda_published_at = ?, agenda_published_by = ?, agenda_late = ?,
        notice_posted_at = COALESCE(notice_posted_at, ?), updated_at = ? WHERE id = ?`, text, t, actor.name, late ? 1 : 0, t, t, id);
      const again = !!before.agenda_published_at;
      this.log(actor, again ? 'agenda.republish' : 'agenda.publish', 'meeting', id,
        `${again ? 'Approved and published an amended agenda' : 'Approved and published the agenda'} for the ${meetingName(this, before)}${late ? `. Published late: ${lateReason}` : ''}`,
        { agenda_status: [before.agenda_status, 'published'], ...(late ? { late: [null, lateReason] } : {}) });
    });
    return this.row(id);
  },

  setDocument(id, field, docId) {
    if (!['agenda_doc_id', 'minutes_doc_id', 'record_doc_id'].includes(field)) throw new Error('Unknown document field');
    this.run(`UPDATE meetings SET ${field} = ? WHERE id = ?`, docId, id);
  },

  // An account of the meeting from another source (a news recap, a clerk's summary). Never treated as minutes.
  saveRecord(id, { text, source, url }, actor) {
    const before = this.row(id);
    if (!before) return null;
    this.tx(() => {
      this.run('UPDATE meetings SET record_text = ?, record_source = ?, record_url = ?, updated_at = ? WHERE id = ?', text, source, url, now(), id);
      this.log(actor, 'meeting.record', 'meeting', id, `${before.record_text ? 'Updated' : 'Added'} the meeting record from ${source || 'another source'}`,
        { record_source: [before.record_source, source], record_url: [before.record_url, url], characters: [(before.record_text || '').length, (text || '').length] });
    });
    return this.row(id);
  },

  // A news recap of this meeting already in the knowledge base. Other documents can cite the same article (a note about
  // site plans, say), so only a meetings document that is itself the recap qualifies.
  docBySource(url) {
    return this.one(`SELECT id FROM documents WHERE source_url = ? AND category = 'Meetings & Minutes' AND authority = 'media-report'
      AND (title LIKE '%recap%' OR title LIKE '%meeting record%') ORDER BY chunks DESC LIMIT 1`, url)?.id || null;
  },

  /* ---------------- Files ---------------- */

  file(id) { return this.one('SELECT * FROM meeting_files WHERE id = ?', id); },

  addFile(f, actor) {
    const m = this.row(f.meeting_id);
    if (!m) return null;
    this.tx(() => {
      this.run(`INSERT INTO meeting_files (id, meeting_id, item_id, kind, file_key, file_name, mime, bytes, upload_id, status, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, f.id, f.meeting_id, f.item_id ?? null, f.kind, f.file_key, f.file_name, f.mime ?? null, f.bytes || 0,
      f.upload_id ?? null, f.status || 'ready', actor.name, now());
      if ((f.status || 'ready') === 'ready') this.log(actor, 'meeting.file_add', 'meeting', f.meeting_id, `Attached "${f.file_name}" to the ${meetingName(this, m)}`);
    });
    return this.file(f.id);
  },

  completeFile(id, bytes, actor) {
    const f = this.file(id);
    if (!f) return null;
    this.tx(() => {
      this.run("UPDATE meeting_files SET status = 'ready', bytes = ?, upload_id = NULL WHERE id = ?", bytes, id);
      this.log(actor, 'meeting.recording_add', 'meeting', f.meeting_id, `Uploaded the recording "${f.file_name}" (${Math.round(bytes / 1e6)} MB)`);
    });
    return this.file(id);
  },

  deleteFile(id, actor) {
    const f = this.file(id);
    if (!f) return null;
    this.tx(() => {
      this.run('DELETE FROM meeting_files WHERE id = ?', id);
      if (f.status === 'ready') this.log(actor, 'meeting.file_delete', 'meeting', f.meeting_id, `Removed "${f.file_name}"`, { file_name: [f.file_name, null] });
    });
    return f;
  },

  /* ---------------- Transcript and minutes ---------------- */

  // Transcription runs one audio segment per call, so long recordings show progress and can resume.
  appendTranscript(id, { seq, total, text, source, fileId }, actor) {
    const m = this.row(id);
    if (!m) return null;
    this.tx(() => {
      const start = seq === 0;
      const transcript = start ? text : [m.transcript || '', text].filter(Boolean).join(' ');
      const done = seq + 1 >= total;
      this.run('UPDATE meetings SET transcript = ?, transcript_status = ?, transcript_progress = ?, updated_at = ? WHERE id = ?',
        transcript, done ? 'done' : 'transcribing', JSON.stringify({ source, fileId: fileId ?? null, done: seq + 1, total }), now(), id);
      if (start) this.log(actor, 'meeting.transcribe', 'meeting', id, `Started transcribing ${source} (Workers AI Whisper)`);
      if (done) this.log(actor, 'meeting.transcribed', 'meeting', id, `Finished the transcript: ${transcript.split(/\s+/).filter(Boolean).length} words from ${total} segments`);
    });
    return this.row(id);
  },

  saveTranscript(id, text, actor) {
    const m = this.row(id);
    if (!m) return null;
    this.tx(() => {
      this.run("UPDATE meetings SET transcript = ?, transcript_status = ?, transcript_progress = NULL, updated_at = ? WHERE id = ?", text, text ? 'done' : 'none', now(), id);
      this.log(actor, 'meeting.transcript_edit', 'meeting', id, text ? 'Edited the transcript' : 'Cleared the transcript');
    });
    return this.row(id);
  },

  saveNotes(id, notes, actor) {
    const m = this.row(id);
    if (!m || (m.notes || '') === (notes || '')) return m;
    this.tx(() => {
      this.run('UPDATE meetings SET notes = ?, updated_at = ? WHERE id = ?', notes, now(), id);
      this.log(actor, 'meeting.notes', 'meeting', id, "Saved the clerk's meeting notes");
    });
    return this.row(id);
  },

  // A draft from the AI or typed by the clerk. Drafts are never shown to residents.
  saveMinutesDraft(id, { text, source, suggestions }, actor) {
    const before = this.row(id);
    if (!before) return null;
    if (before.minutes_status === 'approved') throw new Error('These minutes are approved. Reopen them before changing the draft.');
    this.tx(() => {
      this.run(`UPDATE meetings SET minutes_draft = ?, minutes_status = 'draft', updated_at = ?${source ? ', minutes_source = ?, minutes_suggestions = ?' : ''} WHERE id = ?`,
        ...(source ? [text, now(), source, suggestions ? JSON.stringify(suggestions) : null, id] : [text, now(), id]));
      if (source) {
        this.log(actor, 'minutes.draft', 'meeting', id, `Drafted minutes from the ${source} for the ${meetingName(this, before)}`, { minutes_status: [before.minutes_status, 'draft'] });
      } else if ((before.minutes_draft || '') !== text) {
        this.log(actor, 'minutes.edit', 'meeting', id, 'Edited the draft minutes', { characters: [(before.minutes_draft || '').length, text.length] });
      }
    });
    return this.row(id);
  },

  // Only a person can approve minutes, and only approved minutes are ever published.
  approveMinutes(id, actor) {
    const before = this.row(id);
    if (!before) return null;
    if (!before.minutes_draft) throw new Error('There is no draft to approve');
    const t = now();
    this.tx(() => {
      this.run(`UPDATE meetings SET minutes_status = 'approved', minutes_approved = minutes_draft, minutes_approved_at = ?, minutes_approved_by = ?,
        updated_at = ? WHERE id = ?`, t, actor.name, t, id);
      this.log(actor, before.minutes_approved_at ? 'minutes.reapprove' : 'minutes.approve', 'meeting', id,
        `Approved${before.minutes_approved_at ? ' corrected' : ''} minutes for the ${meetingName(this, before)} and published them`, { minutes_status: [before.minutes_status, 'approved'] });
    });
    return this.row(id);
  },

  reopenMinutes(id, actor) {
    const before = this.row(id);
    if (!before || before.minutes_status !== 'approved') return before;
    this.tx(() => {
      this.run("UPDATE meetings SET minutes_status = 'draft', updated_at = ? WHERE id = ?", now(), id);
      this.log(actor, 'minutes.reopen', 'meeting', id, 'Reopened approved minutes for correction (residents still see the approved version)', { minutes_status: ['approved', 'draft'] });
    });
    return this.row(id);
  },

  /* ---------------- Action items ---------------- */

  action(id) { return this.one(`${ACTION_SELECT} WHERE a.id = ?`, id); },

  actions({ status, assigneeId, open } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('a.status = ?'); args.push(status); }
    if (open) where.push("a.status IN ('open', 'in_progress')");
    if (assigneeId) { where.push('a.assignee_id = ?'); args.push(assigneeId); }
    return this.all(`${ACTION_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 0 ELSE 1 END, a.due_date IS NULL, a.due_date, a.created_at DESC LIMIT 300`, ...args);
  },

  addAction(meetingId, p, actor) {
    const m = this.row(meetingId);
    if (!m) return null;
    if (p.assignee_id && !this.one('SELECT id FROM staff WHERE id = ?', p.assignee_id)) throw new Error('Unknown staff member');
    const id = uid('ac');
    const t = now();
    this.tx(() => {
      this.run(`INSERT INTO action_items (id, meeting_id, item_id, title, details, assignee_id, due_date, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, meetingId, p.item_id ?? null, p.title, p.details ?? null, p.assignee_id ?? null, p.due_date ?? null, actor.name, t, t);
      const who = p.assignee_id ? this.one('SELECT name FROM staff WHERE id = ?', p.assignee_id).name : null;
      this.log(actor, 'action.create', 'meeting', meetingId, `Added action item "${p.title}"${who ? `, assigned to ${who}` : ''}`,
        { assignee: [null, who], due_date: [null, p.due_date ?? null] });
    });
    return this.action(id);
  },

  updateAction(id, p, actor) {
    const before = this.one('SELECT * FROM action_items WHERE id = ?', id);
    if (!before) return null;
    if (p.assignee_id && !this.one('SELECT id FROM staff WHERE id = ?', p.assignee_id)) throw new Error('Unknown staff member');
    this.tx(() => {
      const changes = updateRow(this, 'action_items', id, before, p, ACTION_FIELDS);
      if (changes.status) {
        this.run('UPDATE action_items SET completed_at = ? WHERE id = ?', changes.status[1] === 'done' ? now() : null, id);
      }
      if (Object.keys(changes).length) {
        const words = [];
        if (changes.status) words.push(`status ${label(changes.status[1])}`);
        if (changes.assignee_id) words.push(`assigned to ${changes.assignee_id[1] ? this.one('SELECT name FROM staff WHERE id = ?', changes.assignee_id[1]).name : 'nobody'}`);
        if (changes.due_date) words.push(`due ${changes.due_date[1] || 'whenever'}`);
        this.log(actor, 'action.update', 'meeting', before.meeting_id, `Action item "${p.title || before.title}": ${words.join(', ') || 'updated'}`, changes);
      }
    });
    return this.action(id);
  },

  /* ---------------- What residents see ---------------- */

  publicList({ today }) {
    const rows = this.all(`SELECT m.id, b.name AS board, b.external, m.board_id, m.kind, m.title, m.starts_at, m.location, m.purpose, m.status,
        m.agenda_published_at, m.minutes_approved_at, m.record_text IS NOT NULL AS has_record FROM meetings m JOIN boards b ON b.id = m.board_id
      WHERE (m.starts_at >= ? AND m.status != 'held') OR m.agenda_published IS NOT NULL OR m.minutes_approved IS NOT NULL OR m.record_text IS NOT NULL
      ORDER BY m.starts_at DESC LIMIT 500`, today);
    return rows.map(({ agenda_published_at, minutes_approved_at, has_record, ...r }) => ({ ...r, has_agenda: !!agenda_published_at, has_minutes: !!minutes_approved_at, has_record: !!has_record }));
  },

  publicGet(id) {
    const m = this.one(`SELECT m.id, b.name AS board, b.external, m.board_id, m.kind, m.title, m.starts_at, m.location, m.purpose, m.status, m.agenda_published,
        m.agenda_published_at, m.agenda_late, m.minutes_approved, m.minutes_approved_at, m.record_text, m.record_source, m.record_url
      FROM meetings m JOIN boards b ON b.id = m.board_id WHERE m.id = ?`, id);
    if (!m) return null;
    // Attachments become public with the agenda; recordings stay with staff.
    const files = m.agenda_published_at ? this.all(`SELECT f.id, f.item_id, f.file_name, f.mime, f.bytes FROM meeting_files f
      JOIN agenda_items i ON i.id = f.item_id WHERE f.meeting_id = ? AND f.kind = 'attachment' AND f.status = 'ready' AND i.status = 'accepted'`, id) : [];
    return { ...m, files };
  },

  // The file plus whether residents may download it.
  fileAccess(id) {
    const f = this.file(id);
    if (!f || f.status !== 'ready') return null;
    const m = this.row(f.meeting_id);
    const item = f.item_id && this.item(f.item_id);
    return { file: f, public: f.kind === 'attachment' && !!m.agenda_published_at && item?.status === 'accepted' };
  },
};
