// Public Works dispatcher, the city's side: crews, work orders, the dispatch board, the map, the field view
// and the dispatcher's suggestions. These methods run inside each city's CityStore (store.js mixes them in),
// next to the service requests they schedule. A request can have several work orders, and its status follows them.
// The dispatcher only suggests (likely duplicates, priority, crew); staff accept or dismiss every suggestion.

const now = () => new Date().toISOString();
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const CLOSED = ['resolved', 'closed'];
const LEVELS = ['low', 'normal', 'high', 'urgent'];
const DISPATCHER = { type: 'ai', id: null, name: 'Public Works dispatcher' };
const WO_FIELDS = ['title', 'crew_id', 'scheduled_date', 'status', 'materials', 'labor_notes', 'labor_hours', 'completion_note'];

export const DISPATCH_TABLES = ['crews', 'crew_members', 'work_orders', 'work_order_photos', 'request_locations', 'dispatch_suggestions'];

export const DISPATCH_MIGRATION = `
  -- Named crews of people from the staff directory, per department.
  CREATE TABLE crews (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department_id TEXT NOT NULL REFERENCES departments(id),
    lead_id TEXT REFERENCES staff(id),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (department_id, name)
  );
  CREATE TABLE crew_members (
    crew_id TEXT NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
    staff_id TEXT NOT NULL REFERENCES staff(id),
    PRIMARY KEY (crew_id, staff_id)
  );
  CREATE INDEX crew_members_staff ON crew_members (staff_id);

  -- Scheduled field work. Numbered per city from WO-1001.
  CREATE TABLE work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT NOT NULL UNIQUE,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    department_id TEXT NOT NULL REFERENCES departments(id),
    crew_id TEXT REFERENCES crews(id),
    title TEXT NOT NULL,
    scheduled_date TEXT, -- YYYY-MM-DD in the city's time zone
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'done', 'cancelled')),
    materials TEXT,
    labor_notes TEXT,
    labor_hours REAL,
    completion_note TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );
  CREATE INDEX work_orders_request ON work_orders (request_id);
  CREATE INDEX work_orders_schedule ON work_orders (department_id, scheduled_date);
  CREATE INDEX work_orders_crew ON work_orders (crew_id, scheduled_date);
  INSERT INTO sqlite_sequence (name, seq) VALUES ('work_orders', 1000);

  CREATE TABLE work_order_photos (
    id INTEGER PRIMARY KEY,
    work_order_id INTEGER NOT NULL REFERENCES work_orders(id),
    kind TEXT NOT NULL CHECK (kind IN ('before', 'after')),
    file_key TEXT NOT NULL,
    taken_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX work_order_photos_order ON work_order_photos (work_order_id);

  -- Where a typed address is, from the geocoder. Requests sent with GPS keep their own coordinates.
  CREATE TABLE request_locations (
    request_id INTEGER PRIMARY KEY REFERENCES requests(id),
    latitude REAL,
    longitude REAL,
    matched TEXT,
    source TEXT NOT NULL,
    found INTEGER NOT NULL,
    at TEXT NOT NULL
  );

  -- The dispatcher's suggestions. Nothing changes until staff accept one; a dismissed one is not suggested again.
  CREATE TABLE dispatch_suggestions (
    id INTEGER PRIMARY KEY,
    request_id INTEGER NOT NULL REFERENCES requests(id),
    kind TEXT NOT NULL CHECK (kind IN ('duplicate', 'priority', 'crew')),
    value TEXT NOT NULL,
    reason TEXT NOT NULL,
    data TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed', 'expired')),
    created_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    UNIQUE (request_id, kind, value)
  );
  CREATE INDEX dispatch_suggestions_open ON dispatch_suggestions (status, request_id);
`;

/* ---------------- Helpers ---------------- */

export function longDate(d) {
  return d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '';
}
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
export const validDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && addDays(d, 0) === d;

function metres(a, b) {
  const r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(x));
}
const located = (x) => x.lat != null && x.lng != null;

// "123 N. Pine Street, Wiggins MS" and "123 north pine st" are the same place.
const ABBR = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', boulevard: 'blvd', highway: 'hwy', court: 'ct', place: 'pl',
  circle: 'cir', parkway: 'pkwy', north: 'n', south: 's', east: 'e', west: 'w', '&': 'and' };
export function normalizePlace(s, cityWords = []) {
  const words = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => ABBR[w] || w).filter((w) => !cityWords.includes(w) && !['ms', 'mississippi', 'near', 'by', 'at', 'the', 'in', 'front', 'of'].includes(w));
  return words.join(' ');
}

function diff(before, after, fields) {
  const out = {};
  for (const f of fields) if (f in after && (before[f] ?? null) !== (after[f] ?? null)) out[f] = [before[f] ?? null, after[f] ?? null];
  return out;
}

const WO_SELECT = `SELECT w.*, c.name AS crew, d.name AS department, r.ref AS request_ref, r.category, r.location, r.priority, r.type_key,
    r.status AS request_status, COALESCE(r.latitude, l.latitude) AS lat, COALESCE(r.longitude, l.longitude) AS lng,
    (SELECT COUNT(*) FROM work_order_photos p WHERE p.work_order_id = w.id) AS photos
  FROM work_orders w JOIN requests r ON r.id = w.request_id JOIN departments d ON d.id = w.department_id
  LEFT JOIN crews c ON c.id = w.crew_id LEFT JOIN request_locations l ON l.request_id = r.id AND l.found = 1`;
const OPEN_REQUESTS = `SELECT r.id, r.ref, r.type_key, r.category, r.department_id, d.name AS department, r.description, r.summary, r.location,
    r.priority, t.priority AS base_priority, r.status, r.name, r.contact, r.source, r.created_at, r.photo_key IS NOT NULL AS photo,
    COALESCE(r.latitude, l.latitude) AS lat, COALESCE(r.longitude, l.longitude) AS lng,
    CASE WHEN r.latitude IS NOT NULL THEN 'gps' WHEN l.found = 1 THEN 'geocoded' WHEN l.found = 0 THEN 'not_found' ELSE 'pending' END AS located_by
  FROM requests r JOIN departments d ON d.id = r.department_id LEFT JOIN request_types t ON t.key = r.type_key
  LEFT JOIN request_locations l ON l.request_id = r.id
  WHERE r.status NOT IN ('resolved', 'closed')`;
const ACTIVE_WO = "SELECT DISTINCT request_id FROM work_orders WHERE status IN ('scheduled', 'in_progress')";
const inList = (col, ids) => `${col} IN (${ids.map(() => '?').join(', ') || "''"})`;

// What residents see on the tracking page when work changes a request's status.
const PUBLIC_STATUS = {
  new: 'Back in the queue to be scheduled', assigned: 'Assigned to a crew', in_progress: 'Work has started',
  resolved: (today) => `Completed${today ? ` on ${longDate(today)}` : ''}`,
};

/* ---------------- Store methods ---------------- */

export const dispatchMethods = {
  /* Crews */

  crews({ departmentIds } = {}) {
    const rows = this.all(`SELECT c.*, d.name AS department, s.name AS lead FROM crews c JOIN departments d ON d.id = c.department_id
      LEFT JOIN staff s ON s.id = c.lead_id ORDER BY c.active DESC, d.sort, c.name`).filter((c) => !departmentIds || departmentIds.includes(c.department_id));
    const members = this.all('SELECT m.crew_id, s.id, s.name, s.title, s.phone, s.active FROM crew_members m JOIN staff s ON s.id = m.staff_id ORDER BY s.name');
    return rows.map((c) => ({ ...c, members: members.filter((x) => x.crew_id === c.id).map(({ crew_id, ...x }) => x) }));
  },

  crew(id) { return this.crews().find((c) => c.id === id) || null; },

  saveCrew(id, p, actor) {
    const before = id ? this.crew(id) : null;
    if (id && !before) return null;
    const next = {
      name: p.name ?? before?.name, department_id: p.department_id ?? before?.department_id,
      lead_id: 'lead_id' in p ? p.lead_id || null : before?.lead_id ?? null, active: 'active' in p ? (p.active ? 1 : 0) : before?.active ?? 1,
    };
    if (!next.name) throw new Error('Name the crew');
    if (!this.one('SELECT id FROM departments WHERE id = ?', next.department_id)) throw new Error('Choose a department');
    if (before && next.department_id !== before.department_id && this.one("SELECT id FROM work_orders WHERE crew_id = ? AND status IN ('scheduled', 'in_progress')", id)) {
      throw new Error("This crew has open work orders, so it can't move to another department");
    }
    const memberIds = [...new Set(p.members ?? before?.members.map((m) => m.id) ?? [])];
    if (next.lead_id && !memberIds.includes(next.lead_id)) memberIds.push(next.lead_id);
    for (const sid of memberIds) {
      const s = this.staffMember(sid);
      if (!s || !s.active) throw new Error('Crew members must be active people in the staff directory');
    }
    if (this.one('SELECT id FROM crews WHERE department_id = ? AND name = ? AND id != ?', next.department_id, next.name, id || '')) {
      throw new Error('That department already has a crew with this name');
    }
    const crewId = id || uid('cr');
    const names = (ids) => ids.map((x) => this.staffMember(x)?.name).filter(Boolean).sort().join(', ') || null;
    const t = now();
    this.tx(() => {
      if (before) {
        this.run('UPDATE crews SET name = ?, department_id = ?, lead_id = ?, active = ?, updated_at = ? WHERE id = ?', next.name, next.department_id, next.lead_id, next.active, t, id);
      } else {
        this.run('INSERT INTO crews (id, name, department_id, lead_id, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', crewId, next.name, next.department_id, next.lead_id, next.active, t, t);
      }
      this.run('DELETE FROM crew_members WHERE crew_id = ?', crewId);
      for (const sid of memberIds) this.run('INSERT INTO crew_members (crew_id, staff_id) VALUES (?, ?)', crewId, sid);
      const changes = diff(before ? { ...before, members: names(before.members.map((m) => m.id)), lead_id: before.lead_id } : {},
        { ...next, members: names(memberIds) }, ['name', 'department_id', 'lead_id', 'active', 'members']);
      if (before && !Object.keys(changes).length) return;
      this.log(actor, before ? 'crew.update' : 'crew.create', 'crew', crewId,
        before ? `Updated crew ${next.name}${changes.members ? `: ${names(memberIds) || 'no members'}` : ''}${changes.active ? (next.active ? ' (reactivated)' : ' (retired)') : ''}`
          : `Created crew ${next.name} (${memberIds.length} ${memberIds.length === 1 ? 'person' : 'people'})`, changes);
    });
    return this.crew(crewId);
  },

  /* Work orders */

  workOrder(id) {
    const w = this.one(`${WO_SELECT} WHERE w.id = ?`, id);
    return w && { ...w, photo_list: this.all('SELECT id, kind, taken_by, created_at FROM work_order_photos WHERE work_order_id = ? ORDER BY id', id) };
  },

  workOrdersFor(requestId) {
    return this.all(`${WO_SELECT} WHERE w.request_id = ? ORDER BY w.id`, requestId).map((w) => this.workOrder(w.id));
  },

  workOrderPhotoKey(workOrderId, photoId) {
    return this.one('SELECT p.file_key, w.department_id FROM work_order_photos p JOIN work_orders w ON w.id = p.work_order_id WHERE p.id = ? AND p.work_order_id = ?', photoId, workOrderId);
  },

  // Returns { workOrder, notices }: notices are the resident messages the Worker sends.
  createWorkOrder(p, actor, today) {
    const r = this.one('SELECT r.*, d.name AS department FROM requests r JOIN departments d ON d.id = r.department_id WHERE r.id = ?', p.request_id);
    if (!r) throw Object.assign(new Error('Request not found'), { status: 404 });
    if (r.status === 'closed') throw new Error('This request is closed. Reopen it before scheduling work.');
    const crew = p.crew_id ? this.one('SELECT * FROM crews WHERE id = ? AND active = 1', p.crew_id) : null;
    if (p.crew_id && !crew) throw new Error('Unknown crew');
    if (crew && crew.department_id !== r.department_id) throw new Error(`${crew.name} isn't a ${r.department} crew`);
    if (p.scheduled_date && !validDate(p.scheduled_date)) throw new Error('Choose a valid date');
    const date = p.scheduled_date || null;
    const t = now();
    return this.tx(() => {
      const { id } = this.one(`INSERT INTO work_orders (ref, request_id, department_id, crew_id, title, scheduled_date, materials, labor_notes, labor_hours, created_by, created_at, updated_at)
        VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      r.id, r.department_id, crew?.id ?? null, p.title || r.category, date, p.materials ?? null, p.labor_notes ?? null, p.labor_hours ?? null, actor.name, t, t);
      const ref = `WO-${id}`;
      this.run('UPDATE work_orders SET ref = ? WHERE id = ?', ref, id);
      const what = [crew?.name, date && longDate(date)].filter(Boolean).join(', ');
      this.log(actor, 'work_order.create', 'work_order', ref, `${ref} created for ${r.ref}${what ? `: ${what}` : ''}`,
        { request: [null, r.ref], crew_id: [null, crew?.id ?? null], scheduled_date: [null, date] });
      const notices = this.followWork(r.id, actor, {
        why: `${ref} created`, staffNote: `${ref} created${what ? `: ${what}` : ' (not scheduled yet)'}`,
        publicNote: date ? `Scheduled for ${longDate(date)}` : null, notice: date ? { kind: 'scheduled', date } : null, today,
      });
      return { workOrder: this.workOrder(id), notices };
    });
  },

  updateWorkOrder(id, p, actor, today) {
    const before = this.one('SELECT * FROM work_orders WHERE id = ?', id);
    if (!before) return null;
    const next = { ...before };
    for (const k of WO_FIELDS) if (k in p) next[k] = p[k];
    if (!['scheduled', 'in_progress', 'done', 'cancelled'].includes(next.status)) throw new Error('Invalid status');
    if (next.scheduled_date && !validDate(next.scheduled_date)) throw new Error('Choose a valid date');
    if (next.crew_id !== before.crew_id && next.crew_id) {
      const crew = this.one('SELECT * FROM crews WHERE id = ? AND active = 1', next.crew_id);
      if (!crew) throw new Error('Unknown crew');
      if (crew.department_id !== before.department_id) throw new Error(`${crew.name} belongs to another department`);
    }
    const t = now();
    if (next.status === 'done' && before.status !== 'done') {
      const photos = this.one('SELECT COUNT(*) AS n FROM work_order_photos WHERE work_order_id = ?', id).n;
      if (!photos && !String(next.completion_note || '').trim()) throw new Error('Add a before or after photo, or a note about the work, to mark this job done');
      next.completed_at = t;
    }
    if (next.status !== 'done') next.completed_at = null;
    if (next.status === 'in_progress' && !before.started_at) next.started_at = t;
    const changes = diff(before, next, WO_FIELDS);
    if (!Object.keys(changes).length) return { workOrder: this.workOrder(id), notices: [] };

    const words = [];
    if (changes.status) words.push({ scheduled: 'Back to scheduled', in_progress: 'Started', done: 'Done', cancelled: 'Cancelled' }[next.status]);
    if (changes.crew_id) words.push(`Crew: ${next.crew_id ? this.one('SELECT name FROM crews WHERE id = ?', next.crew_id).name : 'none'}`);
    if (changes.scheduled_date) words.push(next.scheduled_date ? `Date: ${longDate(next.scheduled_date)}` : 'Date removed');
    for (const [k, label] of [['title', 'Title'], ['materials', 'Materials'], ['labor_notes', 'Labor notes'], ['labor_hours', 'Labor hours'], ['completion_note', 'Completion note']]) {
      if (changes[k]) words.push(`${label} updated`);
    }
    const open = ['scheduled', 'in_progress'].includes(next.status);
    const dated = changes.scheduled_date && next.scheduled_date && open;
    return this.tx(() => {
      this.run(`UPDATE work_orders SET title = ?, crew_id = ?, scheduled_date = ?, status = ?, materials = ?, labor_notes = ?, labor_hours = ?, completion_note = ?,
        started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      next.title, next.crew_id, next.scheduled_date, next.status, next.materials, next.labor_notes, next.labor_hours, next.completion_note,
      next.started_at, next.completed_at, t, id);
      this.log(actor, 'work_order.update', 'work_order', before.ref, `${before.ref}: ${words.join(' · ')}`, changes);
      const note = changes.status && next.status === 'done' && next.completion_note ? ` — ${next.completion_note}` : '';
      const notices = this.followWork(before.request_id, actor, {
        why: `${before.ref} ${words[0].toLowerCase()}`, staffNote: `${before.ref}: ${words.join(' · ')}${note}`,
        publicNote: dated ? `${before.scheduled_date ? 'Rescheduled' : 'Scheduled'} for ${longDate(next.scheduled_date)}` : null,
        notice: dated ? { kind: before.scheduled_date ? 'rescheduled' : 'scheduled', date: next.scheduled_date } : null, today,
      });
      return { workOrder: this.workOrder(id), notices };
    });
  },

  addWorkOrderPhoto(id, kind, key, actor) {
    const w = this.one('SELECT * FROM work_orders WHERE id = ?', id);
    if (!w) return null;
    const t = now();
    this.tx(() => {
      this.run('INSERT INTO work_order_photos (work_order_id, kind, file_key, taken_by, created_at) VALUES (?, ?, ?, ?, ?)', id, kind, key, actor.name, t);
      this.run('UPDATE work_orders SET updated_at = ? WHERE id = ?', t, id);
      this.log(actor, 'work_order.photo', 'work_order', w.ref, `Added ${kind === 'after' ? 'an' : 'a'} ${kind} photo to ${w.ref}`);
      this.run('INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) SELECT id, ?, ?, ?, ?, status, ?, 0 FROM requests WHERE id = ?',
        t, actor.type, actor.id ?? null, actor.name, `${w.ref}: ${kind} photo added`, w.request_id);
    });
    return this.workOrder(id);
  },

  // A request's status follows its work orders: all done → resolved, any started → in progress, otherwise assigned.
  // Writes the staff and resident timeline entries and returns the resident messages to send.
  followWork(requestId, actor, { why, staffNote, publicNote, notice, today }) {
    const r = this.one('SELECT r.*, d.name AS department FROM requests r JOIN departments d ON d.id = r.department_id WHERE r.id = ?', requestId);
    const wos = this.all("SELECT status FROM work_orders WHERE request_id = ? AND status != 'cancelled'", requestId);
    let status = r.status;
    if (r.status !== 'closed') {
      if (wos.length) status = wos.every((w) => w.status === 'done') ? 'resolved' : wos.some((w) => w.status !== 'scheduled') ? 'in_progress' : 'assigned';
      else if (['assigned', 'in_progress'].includes(r.status)) status = 'new';
    }
    const t = now();
    const changed = status !== r.status;
    this.run('UPDATE requests SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?', status, t, CLOSED.includes(status) ? r.closed_at || t : null, requestId);
    if (changed) this.log(actor, 'request.update', 'request', r.ref, `${r.ref}: Status: ${status.replace(/_/g, ' ')} (${why})`, { status: [r.status, status] });
    const event = (note, pub) => this.run('INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      requestId, t, actor.type, actor.id ?? null, actor.name, status, note, pub ? 1 : 0);
    if (staffNote) event(staffNote, false);
    if (publicNote || changed) {
      const words = PUBLIC_STATUS[status];
      event(publicNote || (typeof words === 'function' ? words(today) : words) || status.replace(/_/g, ' '), true);
    }
    const notices = [];
    if (notice) notices.push({ ...notice, department: r.department, to: this.noticeTargets(requestId) });
    if (changed && status === 'resolved') notices.push({ kind: 'completed', date: today, department: r.department, to: this.noticeTargets(requestId) });
    return notices;
  },

  // The resident on the request, plus anyone whose report was merged into it as a duplicate.
  noticeTargets(requestId) {
    return this.all(`SELECT id, ref, category, location, contact FROM requests WHERE contact IS NOT NULL AND (id = ? OR id IN
      (SELECT request_id FROM dispatch_suggestions WHERE kind = 'duplicate' AND status = 'accepted' AND value = ?))`, requestId, String(requestId));
  },

  // The next scheduled date, for the resident tracking page.
  workSchedule(ref) {
    const row = this.one(`SELECT MIN(w.scheduled_date) AS d FROM work_orders w JOIN requests r ON r.id = w.request_id
      WHERE r.ref = ? AND w.status IN ('scheduled', 'in_progress') AND w.scheduled_date IS NOT NULL`, ref);
    return { scheduled_for: row?.d || null };
  },

  /* Board, map and field view */

  board({ departmentIds, from, to }) {
    const crews = this.crews({ departmentIds }).filter((c) => c.active);
    const workOrders = this.all(`${WO_SELECT} WHERE ${inList('w.department_id', departmentIds)} AND ((w.scheduled_date BETWEEN ? AND ?)
      OR (w.status IN ('scheduled', 'in_progress') AND (w.scheduled_date IS NULL OR w.scheduled_date < ?))) ORDER BY w.scheduled_date, w.id`, ...departmentIds, from, to, from);
    const unscheduled = this.all(`${OPEN_REQUESTS} AND ${inList('r.department_id', departmentIds)} AND r.id NOT IN (${ACTIVE_WO})
      ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r.id`, ...departmentIds);
    return { crews, workOrders, unscheduled, suggestions: this.openSuggestions(unscheduled.map((r) => r.id)) };
  },

  mapPoints({ departmentIds }) {
    const requests = this.all(`${OPEN_REQUESTS} AND ${inList('r.department_id', departmentIds)} ORDER BY r.id DESC`, ...departmentIds);
    const wos = this.all(`${WO_SELECT} WHERE w.status IN ('scheduled', 'in_progress') AND ${inList('w.department_id', departmentIds)} ORDER BY w.scheduled_date`, ...departmentIds);
    const withWork = requests.map((r) => ({ ...r, workOrders: wos.filter((w) => w.request_id === r.id) }));
    return { located: withWork.filter(located), unlocated: withWork.filter((r) => !located(r)) };
  },

  // Today's jobs for the crews this person is on (or the whole department if they aren't on one), including overdue ones.
  fieldWork({ staffId, departmentIds, date }) {
    const crewIds = staffId ? this.all('SELECT m.crew_id FROM crew_members m JOIN crews c ON c.id = m.crew_id WHERE m.staff_id = ? AND c.active = 1', staffId).map((x) => x.crew_id) : [];
    const scope = crewIds.length ? inList('w.crew_id', crewIds) : inList('w.department_id', departmentIds);
    const rows = this.all(`${WO_SELECT} WHERE ${scope} AND w.scheduled_date IS NOT NULL AND (
      (w.status IN ('scheduled', 'in_progress') AND w.scheduled_date <= ?) OR (w.status = 'done' AND w.scheduled_date = ?))
      ORDER BY w.status = 'done', w.scheduled_date, w.id`, ...(crewIds.length ? crewIds : departmentIds), date, date);
    const requests = new Map(rows.map((w) => [w.request_id, this.one('SELECT description, name, contact, photo_key IS NOT NULL AS photo FROM requests WHERE id = ?', w.request_id)]));
    return {
      mine: crewIds.length > 0,
      crews: crewIds.map((id) => this.one('SELECT name FROM crews WHERE id = ?', id).name),
      workOrders: rows.map((w) => ({ ...this.workOrder(w.id), request: requests.get(w.request_id) })),
    };
  },

  /* Geocoding */

  pendingGeocodes(limit = 5) {
    return this.all(`SELECT r.id, r.location FROM requests r LEFT JOIN request_locations l ON l.request_id = r.id
      WHERE r.latitude IS NULL AND COALESCE(r.location, '') != '' AND l.request_id IS NULL AND r.status NOT IN ('resolved', 'closed')
      ORDER BY r.id DESC LIMIT ?`, limit);
  },

  // The middle of the city's located reports, to reject geocoder matches in the wrong town.
  locationAnchor() {
    const pts = this.all(`SELECT COALESCE(r.latitude, l.latitude) AS lat, COALESCE(r.longitude, l.longitude) AS lng FROM requests r
      LEFT JOIN request_locations l ON l.request_id = r.id AND l.found = 1 WHERE COALESCE(r.latitude, l.latitude) IS NOT NULL`);
    if (!pts.length) return null;
    const mid = (k) => pts.map((p) => p[k]).sort((a, b) => a - b)[Math.floor(pts.length / 2)];
    return { lat: mid('lat'), lng: mid('lng') };
  },

  saveRequestLocation(requestId, loc) {
    const r = this.one('SELECT ref FROM requests WHERE id = ?', requestId);
    if (!r) return;
    this.tx(() => {
      this.run('INSERT OR REPLACE INTO request_locations (request_id, latitude, longitude, matched, source, found, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        requestId, loc.lat ?? null, loc.lng ?? null, loc.matched ?? null, loc.source, loc.lat != null ? 1 : 0, now());
      if (loc.lat != null) {
        this.log({ type: 'system', id: null, name: 'Geocoder' }, 'request.geocode', 'request', r.ref, `Placed ${r.ref} on the map at ${loc.matched || 'the typed address'} (${loc.source})`,
          { latitude: [null, loc.lat], longitude: [null, loc.lng] });
      }
    });
  },

  /* The dispatcher's suggestions */

  openSuggestions(requestIds) {
    if (!requestIds.length) return [];
    return this.all(`SELECT s.*, r.ref FROM dispatch_suggestions s JOIN requests r ON r.id = s.request_id
      WHERE s.status = 'open' AND ${inList('s.request_id', requestIds)} ORDER BY s.id`, ...requestIds)
      .map((s) => ({ ...s, data: s.data ? JSON.parse(s.data) : null }));
  },

  suggestion(id) {
    const s = this.one('SELECT s.*, r.ref, r.department_id FROM dispatch_suggestions s JOIN requests r ON r.id = s.request_id WHERE s.id = ?', id);
    return s && { ...s, data: s.data ? JSON.parse(s.data) : null };
  },

  // Looks at every open, unscheduled request in these departments and records new suggestions.
  // Suggestions that no longer apply expire; dismissed ones are never suggested again.
  refreshSuggestions({ departmentIds, today, cityWords = [] }) {
    const open = this.all(`${OPEN_REQUESTS} AND ${inList('r.department_id', departmentIds)} ORDER BY r.id`, ...departmentIds);
    const busy = new Set(this.all(ACTIVE_WO).map((x) => x.request_id));
    const crews = this.crews({ departmentIds }).filter((c) => c.active);
    const booked = this.all(`${WO_SELECT} WHERE w.status IN ('scheduled', 'in_progress') AND w.crew_id IS NOT NULL AND w.scheduled_date >= ?`, today);
    const history = this.all("SELECT w.crew_id, r.type_key, COUNT(*) AS n FROM work_orders w JOIN requests r ON r.id = w.request_id WHERE w.status = 'done' GROUP BY 1, 2");
    const place = new Map(open.map((r) => [r.id, normalizePlace(r.location, cityWords)]));
    const found = [];
    for (const r of open.filter((x) => !busy.has(x.id))) {
      // Likely duplicates: an earlier open report of the same kind of problem at the same spot.
      const matches = open.filter((o) => o.id < r.id && o.department_id === r.department_id && Date.parse(r.created_at) - Date.parse(o.created_at) < 60 * 864e5)
        .map((o) => {
          if (located(r) && located(o)) {
            const m = metres(r, o);
            return m <= (o.type_key === r.type_key ? 80 : 20) ? { o, m } : null;
          }
          return o.type_key === r.type_key && place.get(r.id) && place.get(r.id) === place.get(o.id) ? { o, m: null } : null;
        }).filter(Boolean).sort((a, b) => (a.m ?? 0) - (b.m ?? 0) || a.o.id - b.o.id);
      if (matches.length) {
        const { o, m } = matches[0];
        const days = Math.round((Date.parse(r.created_at) - Date.parse(o.created_at)) / 864e5);
        found.push({ r, kind: 'duplicate', value: String(o.id), data: { ref: o.ref, metres: m == null ? null : Math.round(m) },
          reason: `${o.ref} (${o.category.toLowerCase()}) was reported ${m == null ? 'at the same address' : `${Math.round(m)} m away`}${days ? `, ${days} day${days === 1 ? '' : 's'} earlier` : ' the same day'}${busy.has(o.id) ? ' and is already scheduled' : ''}.` });
      }

      // Priority: hazard wording, several reports of the same spot, and long waits. The dispatcher only suggests raising it.
      // Bumps count from the request type's usual priority, so an accepted raise isn't raised again on the next look.
      const why = [];
      const base = LEVELS.indexOf(r.base_priority || 'normal');
      let level = LEVELS.indexOf(r.priority);
      const text = `${r.description} ${r.summary || ''}`;
      if (/\b(injur\w*|sinkhole|gushing|main break|collapsed?|exposed wires?|sewage (in|into|inside) (my|the|our) (house|home)|no water at all|car (fell|stuck) in)\b/i.test(text)) {
        level = Math.max(level, 3); why.push('the description mentions a serious hazard');
      } else if (/\b(danger\w*|hazard\w*|unsafe|blocking|blocked|can'?t (get|pass|drive)|school|children|kids|deep|flooding|no water|wreck)\b/i.test(text)) {
        level = Math.max(level, 2); why.push('the description mentions a safety concern');
      }
      const reports = open.filter((o) => o.id !== r.id && o.department_id === r.department_id && o.type_key === r.type_key && located(o) && located(r) && metres(o, r) <= 80).length;
      if (reports >= 2) { level = Math.min(3, Math.max(level, base + 1)); why.push(`${reports + 1} residents reported this spot`); }
      const waited = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(r.created_at)) / 864e5);
      if (waited >= 10) { level = Math.min(3, Math.max(level, base + 1)); why.push(`it has waited ${waited} days with nothing scheduled`); }
      if (level > LEVELS.indexOf(r.priority)) {
        found.push({ r, kind: 'priority', value: LEVELS[level], data: null, reason: `Raise to ${LEVELS[level]}: ${why.join('; ')}.` });
      }

      // Crew: work already booked nearby, experience with this kind of job, and the lightest schedule.
      const options = crews.filter((c) => c.department_id === r.department_id && c.members.length).map((c) => {
        const mine = booked.filter((w) => w.crew_id === c.id);
        const near = located(r) ? mine.filter((w) => located(w) && w.scheduled_date && metres(w, r) <= 800)
          .sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0] : null;
        const done = history.find((h) => h.crew_id === c.id && h.type_key === r.type_key)?.n || 0;
        const week = mine.filter((w) => w.scheduled_date && w.scheduled_date <= addDays(today, 7)).length;
        return { c, near, done, week, mine, score: (near ? 3 : 0) + Math.min(done, 4) * 0.5 - week * 0.4 };
      }).sort((a, b) => b.score - a.score || a.week - b.week || a.c.name.localeCompare(b.c.name));
      if (options.length) {
        const best = options[0];
        let date = best.near?.scheduled_date;
        if (!date) {
          date = LEVELS.indexOf(r.priority) >= 3 || level >= 3 ? today : addDays(today, 1);
          for (let i = 0; i < 14 && (weekday(date) % 6 === 0 || best.mine.filter((w) => w.scheduled_date === date).length >= 4); i++) date = addDays(date, 1);
        }
        const parts = [];
        if (best.near) parts.push(`already working ${Math.round(metres(best.near, r))} m away that day (${best.near.ref})`);
        if (best.done) parts.push(`has finished ${best.done} similar job${best.done === 1 ? '' : 's'}`);
        if (options.length > 1 && !best.near) parts.push(best.week ? `lightest schedule this week (${best.week} job${best.week === 1 ? '' : 's'})` : 'nothing else booked this week');
        if (!parts.length) parts.push(best.week ? `${best.week} job${best.week === 1 ? '' : 's'} booked this week` : 'nothing else booked this week');
        found.push({ r, kind: 'crew', value: best.c.id, data: { crew: best.c.name, date },
          reason: `${best.c.name} on ${shortDate(date)}: ${parts.join('; ')}.` });
      }
    }

    const existing = new Map(this.all(`SELECT * FROM dispatch_suggestions WHERE ${inList('request_id', open.map((r) => r.id))}`, ...open.map((r) => r.id))
      .map((s) => [`${s.request_id}|${s.kind}|${s.value}`, s]));
    const keep = new Set();
    const t = now();
    this.tx(() => {
      for (const f of found) {
        const key = `${f.r.id}|${f.kind}|${f.value}`;
        const s = existing.get(key);
        const data = f.data ? JSON.stringify(f.data) : null;
        if (!s) {
          const { id } = this.one('INSERT INTO dispatch_suggestions (request_id, kind, value, reason, data, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', f.r.id, f.kind, f.value, f.reason, data, t);
          keep.add(id);
          this.log(DISPATCHER, 'dispatch.suggest', 'request', f.r.ref, `Suggested for ${f.r.ref}: ${f.kind === 'duplicate' ? `likely duplicate of ${f.data.ref}` : f.reason}`);
        } else if (s.status === 'open') {
          keep.add(s.id);
          if (s.reason !== f.reason || s.data !== data) this.run('UPDATE dispatch_suggestions SET reason = ?, data = ? WHERE id = ?', f.reason, data, s.id);
        }
      }
      // Anything else still open in these departments no longer applies (scheduled, closed, moved, or the situation changed).
      const stale = this.all(`SELECT s.id FROM dispatch_suggestions s JOIN requests r ON r.id = s.request_id WHERE s.status = 'open' AND ${inList('r.department_id', departmentIds)}`, ...departmentIds)
        .filter((s) => !keep.has(s.id));
      for (const s of stale) this.run("UPDATE dispatch_suggestions SET status = 'expired', decided_at = ? WHERE id = ?", t, s.id);
    });
  },

  // Staff accept or dismiss a suggestion. Accepting a crew suggestion schedules the work (see createWorkOrder).
  decideSuggestion(id, decision, actor, { today, date } = {}) {
    const s = this.suggestion(id);
    if (!s) return null;
    if (s.status !== 'open') throw new Error(`This suggestion was already ${s.status}`);
    const r = this.one('SELECT r.*, d.name AS department FROM requests r JOIN departments d ON d.id = r.department_id WHERE r.id = ?', s.request_id);
    const t = now();
    const settle = (status) => {
      this.run('UPDATE dispatch_suggestions SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', status, t, actor.name, id);
      this.log(actor, status === 'accepted' ? 'dispatch.accept' : 'dispatch.dismiss', 'request', r.ref,
        `${status === 'accepted' ? 'Accepted' : 'Dismissed'} the dispatcher's suggestion for ${r.ref}: ${s.reason}`, { suggestion: [s.kind, s.value] });
    };
    if (decision === 'dismiss') {
      this.tx(() => settle('dismissed'));
      return { suggestion: this.suggestion(id), notices: [] };
    }

    if (s.kind === 'crew') {
      const result = this.createWorkOrder({ request_id: r.id, crew_id: s.value, scheduled_date: date || s.data?.date }, actor, today);
      this.tx(() => settle('accepted'));
      return { suggestion: this.suggestion(id), ...result };
    }

    let notices = [];
    this.tx(() => {
      settle('accepted');
      if (s.kind === 'priority' && s.value !== r.priority) {
        this.run('UPDATE requests SET priority = ?, updated_at = ? WHERE id = ?', s.value, t, r.id);
        this.run('INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
          r.id, t, actor.type, actor.id ?? null, actor.name, r.status, `Priority: ${s.value} (dispatcher's suggestion)`);
        this.log(actor, 'request.update', 'request', r.ref, `${r.ref}: Priority: ${s.value} (dispatcher's suggestion)`, { priority: [r.priority, s.value] });
      }
      if (s.kind === 'duplicate' && r.status !== 'closed') {
        const original = this.one('SELECT id, ref FROM requests WHERE id = ?', Number(s.value));
        this.run('UPDATE requests SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?', 'closed', t, r.closed_at || t, r.id);
        this.run('INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
          r.id, t, actor.type, actor.id ?? null, actor.name, 'closed', `Already reported as ${original.ref}. Updates on ${original.ref} cover this report too.`);
        this.run("INSERT INTO request_events (request_id, at, actor_type, actor_id, actor_name, status, note, public) SELECT id, ?, ?, ?, ?, status, ?, 0 FROM requests WHERE id = ?",
          t, actor.type, actor.id ?? null, actor.name, `${r.ref} merged into this request as a duplicate`, original.id);
        this.log(actor, 'request.update', 'request', r.ref, `${r.ref}: Status: closed (duplicate of ${original.ref})`, { status: [r.status, 'closed'] });
        this.run("UPDATE dispatch_suggestions SET status = 'expired', decided_at = ? WHERE request_id = ? AND status = 'open'", t, r.id);
        if (r.contact) notices = [{ kind: 'merged', original: original.ref, department: r.department, to: [{ id: r.id, ref: r.ref, category: r.category, location: r.location, contact: r.contact }] }];
      }
    });
    return { suggestion: this.suggestion(id), notices };
  },
};
