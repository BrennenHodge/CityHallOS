// Business license records in a city's store: settings, applications with their timelines, and the license registry.
// Mixed into CityStore (src/store.js), so these run inside the city's own database. Every change is audited.
import { normalizeConfig, reminderDate, addDays } from './licensing-rules.js';

const now = () => new Date().toISOString();

// Fields an applicant gives and staff can correct.
export const APP_FIELDS = ['business_name', 'dba', 'description', 'class_key', 'entity_type', 'owner_name', 'phone', 'email', 'mailing_address',
  'location', 'inside_limits', 'home_based', 'home', 'employees', 'sos_id', 'dor_account', 'state_licenses', 'start_date'];
const LICENSE_FIELDS = ['business_name', 'dba', 'class_key', 'class_label', 'owner_name', 'phone', 'email', 'location', 'home_based'];

function diff(before, after, fields) {
  const out = {};
  for (const f of fields) if (f in after && (before[f] ?? null) !== (after[f] ?? null)) out[f] = [before[f] ?? null, after[f] ?? null];
  return out;
}

const STATUS_SQL = "CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_on < ? THEN 'expired' ELSE 'active' END";

export const licensingStore = {
  /* ---------------- Settings ---------------- */

  licConfig() {
    const row = this.one("SELECT value, updated_by, updated_at FROM license_settings WHERE key = 'config'");
    return { config: normalizeConfig(row ? JSON.parse(row.value) : {}), configured: !!row, updated_by: row?.updated_by || null, updated_at: row?.updated_at || null };
  },

  licSaveConfig(raw, actor) {
    const { config: before, configured } = this.licConfig();
    const next = normalizeConfig(raw);
    const changes = {};
    for (const k of Object.keys(next)) if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) changes[k] = [configured ? before[k] : null, next[k]];
    if (configured && !Object.keys(changes).length) return this.licConfig();
    this.tx(() => {
      this.run("INSERT OR REPLACE INTO license_settings (key, value, updated_by, updated_at) VALUES ('config', ?, ?, ?)", JSON.stringify(next), actor.name, now());
      this.log(actor, 'license.settings', 'license', 'settings',
        configured ? `Changed ${Object.keys(changes).join(', ')} in business license settings` : 'Set up business license settings', changes);
    });
    return this.licConfig();
  },

  /* ---------------- Applications ---------------- */

  licEvent(appId, actor, status, note, isPublic) {
    this.run('INSERT INTO license_events (application_id, at, actor_type, actor_id, actor_name, status, note, public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      appId, now(), actor.type, actor.id ?? null, actor.name, status, note ?? null, isPublic ? 1 : 0);
  },

  licCreateApplication(a, actor, prefix) {
    const t = now();
    const convoId = a.convo_id && this.one('SELECT id FROM conversations WHERE id = ?', a.convo_id) ? a.convo_id : null;
    const licenseId = a.license_id && this.one('SELECT id FROM licenses WHERE id = ?', a.license_id) ? a.license_id : null;
    const pay = a.payment || null; // paid online when the application was sent
    return this.tx(() => {
      const { id } = this.one(`INSERT INTO license_applications (ref, kind, license_id, business_name, dba, description, class_key, entity_type, owner_name, phone, email,
          mailing_address, location, inside_limits, home_based, home, employees, sos_id, dor_account, state_licenses, start_date, source, convo_id,
          fee_cents, fee_lines, paid_cents, payment_method, payment_ref, card_last4, paid_at, created_at, updated_at)
        VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      a.kind, licenseId, a.business_name, a.dba ?? null, a.description ?? null, a.class_key ?? null, a.entity_type ?? null, a.owner_name ?? null,
      a.phone ?? null, a.email ?? null, a.mailing_address ?? null, a.location ?? null, a.inside_limits ?? null, a.home_based ? 1 : 0, a.home ?? null,
      a.employees ?? null, a.sos_id ?? null, a.dor_account ?? null, a.state_licenses ?? null, a.start_date ?? null, a.source, convoId,
      pay ? pay.fee_cents : null, pay ? JSON.stringify(pay.lines) : null, pay ? pay.amount_cents : null, pay ? 'card' : null, pay?.id ?? null, pay?.last4 ?? null, pay ? t : null, t, t);
      const ref = `${prefix}-BL-${id}`;
      this.run('UPDATE license_applications SET ref = ? WHERE id = ?', ref, id);
      const byStaff = actor.type === 'staff' || actor.type === 'operator';
      this.licEvent(id, actor, 'submitted', `${a.kind === 'renewal' ? 'Renewal application' : 'Application'} ${byStaff ? 'taken by City Hall staff' : 'submitted'}. City Hall staff review every application.`, true);
      if (pay) this.licEvent(id, actor, 'submitted', `Paid $${(pay.amount_cents / 100).toFixed(2)} online by ${pay.brand} ending ${pay.last4} (payment ${pay.id}). City Hall confirms the fee during review.`, true);
      this.log(actor, 'license.apply', 'license', ref, `${ref}: ${a.kind === 'renewal' ? 'renewal' : 'new'} business license application for ${a.business_name}${pay ? `, paid $${(pay.amount_cents / 100).toFixed(2)} online` : ''}`,
        pay ? { paid_cents: [null, pay.amount_cents], payment_method: [null, 'card'] } : null);
      if (convoId) {
        this.run("INSERT INTO messages (convo_id, role, content, flag, model, created_at) VALUES (?, 'assistant', ?, 'action', 'workflow', ?)",
          convoId, `Took business license application ${ref} for ${a.business_name}. City Hall staff will review it.`, t);
      }
      return { id, ref };
    });
  },

  licApplications({ status, q } = {}) {
    const where = [];
    const args = [];
    if (status === 'open') where.push("a.status IN ('submitted', 'in_review', 'needs_info', 'awaiting_payment', 'paid')");
    else if (status) { where.push('a.status = ?'); args.push(status); }
    if (q) { where.push('(a.business_name LIKE ? OR a.dba LIKE ? OR a.owner_name LIKE ? OR a.ref LIKE ?)'); args.push(...Array(4).fill(`%${q}%`)); }
    return this.all(`SELECT a.id, a.ref, a.kind, a.status, a.business_name, a.dba, a.class_key, a.owner_name, a.location, a.home_based, a.inside_limits,
        a.fee_cents, a.source, a.created_at, a.updated_at, l.number AS license_number
      FROM license_applications a LEFT JOIN licenses l ON l.id = a.license_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 300`, ...args);
  },

  licApplicationRow(id) {
    return typeof id === 'string' && /-BL-/i.test(id)
      ? this.one('SELECT * FROM license_applications WHERE ref = ?', id.toUpperCase())
      : this.one('SELECT * FROM license_applications WHERE id = ?', Number(id));
  },

  licApplication(id, today) {
    const a = this.licApplicationRow(id);
    if (!a) return null;
    const history = this.all('SELECT at, status, actor_type, actor_name AS by, note, public FROM license_events WHERE application_id = ? ORDER BY id', a.id);
    const license = a.license_id ? this.one(`SELECT *, ${STATUS_SQL} AS status FROM licenses WHERE id = ?`, today, a.license_id) : null;
    return { ...a, history, license };
  },

  // What the applicant sees with the reference number.
  licTrack(ref, today) {
    const a = this.one('SELECT * FROM license_applications WHERE ref = ?', ref);
    if (!a) return null;
    const updates = this.all('SELECT at, status, note FROM license_events WHERE application_id = ? AND public = 1 ORDER BY id', a.id);
    const license = a.license_id && a.status === 'issued'
      ? this.one(`SELECT number, issued_on, expires_on, ${STATUS_SQL} AS status FROM licenses WHERE id = ?`, today, a.license_id) : null;
    return {
      ref: a.ref, kind: a.kind, status: a.status, business_name: a.business_name, class_key: a.class_key, created_at: a.created_at, updated_at: a.updated_at,
      fee_cents: ['awaiting_payment', 'paid', 'issued'].includes(a.status) || a.paid_cents ? a.fee_cents : null,
      paid_cents: a.paid_cents || 0, refunded_cents: a.refunded_cents || 0, card_last4: a.card_last4,
      balance_cents: a.status === 'awaiting_payment' ? Math.max(0, (a.fee_cents || 0) - (a.paid_cents || 0)) : 0,
      paid: !!a.paid_at, decision_reason: a.status === 'denied' ? a.decision_reason : null, license, updates,
    };
  },

  // The applicant answering a request for more information from the tracking page or the chat.
  licReply(ref, message, actor) {
    const a = this.one('SELECT id, status FROM license_applications WHERE ref = ?', ref);
    if (!a) return null;
    if (!['submitted', 'in_review', 'needs_info'].includes(a.status)) return { error: 'This application is no longer taking replies. Please call City Hall.' };
    const status = a.status === 'needs_info' ? 'in_review' : a.status;
    this.tx(() => {
      this.run('UPDATE license_applications SET status = ?, updated_at = ? WHERE id = ?', status, now(), a.id);
      this.licEvent(a.id, actor, status, `Applicant replied: ${message}`, true);
      this.log(actor, 'license.reply', 'license', ref, `${ref}: applicant replied`, a.status !== status ? { status: [a.status, status] } : null);
    });
    return { ok: true, status };
  },

  licEditApplication(id, patch, actor) {
    const before = this.licApplicationRow(id);
    if (!before) return null;
    const next = { ...before, ...patch };
    const changes = diff(before, next, APP_FIELDS);
    if (!Object.keys(changes).length) return before;
    this.tx(() => {
      this.run(`UPDATE license_applications SET ${APP_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...APP_FIELDS.map((f) => next[f] ?? null), now(), before.id);
      const what = Object.keys(changes).map((k) => k.replace(/_/g, ' ')).join(', ');
      this.licEvent(before.id, actor, before.status, `Corrected ${what}`, false);
      this.log(actor, 'license.edit', 'license', before.ref, `${before.ref}: corrected ${what}`, changes);
    });
    return this.licApplicationRow(before.id);
  },

  // A status change with the fields it sets. `note` goes on the timeline; `publicNote` is shown to the applicant.
  licTransition(id, status, { fields = {}, note = null, isPublic = false, summary }, actor) {
    const before = this.licApplicationRow(id);
    if (!before) return null;
    const next = { ...before, ...fields, status };
    const cols = ['status', ...Object.keys(fields)];
    const changes = diff(before, next, cols);
    this.tx(() => {
      this.run(`UPDATE license_applications SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map((c) => next[c] ?? null), now(), before.id);
      this.licEvent(before.id, actor, status, note, isPublic);
      this.log(actor, `license.${status === before.status ? 'note' : status}`, 'license', before.ref, `${before.ref}: ${summary}`, changes);
    });
    return this.licApplicationRow(before.id);
  },

  // Issues a new license, or renews an existing one in place so it keeps its number.
  licIssue(id, { period, classLabel, note }, actor, prefix) {
    const a = this.licApplicationRow(id);
    if (!a) return null;
    const t = now();
    return this.tx(() => {
      const values = { business_name: a.business_name, dba: a.dba, class_key: a.class_key, class_label: classLabel, owner_name: a.owner_name,
        phone: a.phone, email: a.email, location: a.location, home_based: a.home_based };
      let license;
      if (a.license_id) {
        const before = this.one('SELECT * FROM licenses WHERE id = ?', a.license_id);
        const after = { ...before, ...values, issued_on: period.start, expires_on: period.end, fee_cents: a.fee_cents, application_id: a.id };
        const changes = diff(before, after, [...LICENSE_FIELDS, 'issued_on', 'expires_on', 'fee_cents']);
        this.run(`UPDATE licenses SET ${[...LICENSE_FIELDS, 'issued_on', 'expires_on', 'fee_cents', 'application_id'].map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          ...[...LICENSE_FIELDS, 'issued_on', 'expires_on', 'fee_cents', 'application_id'].map((c) => after[c] ?? null), t, before.id);
        this.log(actor, 'license.renew', 'license', before.number, `Renewed ${before.number} for ${a.business_name} through ${period.end} (${a.ref})`, changes);
        license = { id: before.id, number: before.number };
      } else {
        const { id: lid } = this.one(`INSERT INTO licenses (number, ${LICENSE_FIELDS.join(', ')}, issued_on, expires_on, fee_cents, application_id, source, created_at, updated_at)
          VALUES ('', ${LICENSE_FIELDS.map(() => '?').join(', ')}, ?, ?, ?, ?, 'issued', ?, ?) RETURNING id`,
        ...LICENSE_FIELDS.map((c) => values[c] ?? null), period.start, period.end, a.fee_cents, a.id, t, t);
        const number = `${prefix}-LIC-${lid}`;
        this.run('UPDATE licenses SET number = ? WHERE id = ?', number, lid);
        this.log(actor, 'license.issue', 'license', number, `Issued ${number} to ${a.business_name}, ${period.start} to ${period.end} (${a.ref})`,
          { status: [null, 'active'], expires_on: [null, period.end] });
        license = { id: lid, number };
      }
      this.run("UPDATE license_applications SET status = 'issued', license_id = ?, period_start = ?, period_end = ?, decided_at = ?, updated_at = ? WHERE id = ?",
        license.id, period.start, period.end, t, t, a.id);
      this.licEvent(a.id, actor, 'issued', `License ${license.number} issued by City Hall, valid ${period.start} through ${period.end}.${note ? ` ${note}` : ''}`, true);
      this.log(actor, 'license.issued', 'license', a.ref, `${a.ref}: issued license ${license.number}`, { status: [a.status, 'issued'] });
      return license;
    });
  },

  /* ---------------- Registry ---------------- */

  licRegistry({ status, q, today }) {
    const where = [];
    const args = [today];
    if (status === 'active') { where.push('revoked_at IS NULL AND expires_on >= ?'); args.push(today); }
    if (status === 'expired') { where.push('revoked_at IS NULL AND expires_on < ?'); args.push(today); }
    if (status === 'revoked') where.push('revoked_at IS NOT NULL');
    if (status === 'expiring') { where.push('revoked_at IS NULL AND expires_on >= ? AND expires_on <= ?'); args.push(today, addDays(today, 62)); }
    if (q) { where.push('(business_name LIKE ? OR dba LIKE ? OR owner_name LIKE ? OR number LIKE ? OR location LIKE ?)'); args.push(...Array(5).fill(`%${q}%`)); }
    return this.all(`SELECT *, ${STATUS_SQL} AS status FROM licenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY business_name COLLATE NOCASE LIMIT 500`, ...args);
  },

  licLicense(id, today) {
    const l = typeof id === 'string' && /-LIC-/i.test(id)
      ? this.one(`SELECT *, ${STATUS_SQL} AS status FROM licenses WHERE number = ?`, today, id.toUpperCase())
      : this.one(`SELECT *, ${STATUS_SQL} AS status FROM licenses WHERE id = ?`, today, Number(id));
    if (!l) return null;
    const applications = this.all('SELECT id, ref, kind, status, period_start, period_end, fee_cents, created_at FROM license_applications WHERE license_id = ? ORDER BY id DESC', l.id);
    return { ...l, applications };
  },

  // The public "is this business licensed?" lookup. Contact details are never included.
  licLookup(q, today) {
    const like = `%${q}%`;
    return this.all(`SELECT number, business_name, dba, class_label, location, home_based, issued_on, expires_on, ${STATUS_SQL} AS status FROM licenses
      WHERE business_name LIKE ? OR dba LIKE ? OR number = ? ORDER BY business_name COLLATE NOCASE LIMIT 25`, today, like, like, q.toUpperCase());
  },

  // Adds a license issued before City Hall OS, from the paper register.
  licImport(l, actor, prefix) {
    const t = now();
    return this.tx(() => {
      if (l.number && this.one('SELECT 1 AS x FROM licenses WHERE number = ?', l.number)) throw new Error(`License ${l.number} is already in the registry`);
      const { id } = this.one(`INSERT INTO licenses (number, ${LICENSE_FIELDS.join(', ')}, issued_on, expires_on, fee_cents, source, created_at, updated_at)
        VALUES ('', ${LICENSE_FIELDS.map(() => '?').join(', ')}, ?, ?, ?, 'imported', ?, ?) RETURNING id`,
      ...LICENSE_FIELDS.map((c) => l[c] ?? null), l.issued_on, l.expires_on, l.fee_cents ?? null, t, t);
      const number = l.number || `${prefix}-LIC-${id}`;
      this.run('UPDATE licenses SET number = ? WHERE id = ?', number, id);
      this.log(actor, 'license.import', 'license', number, `Added ${number} (${l.business_name}) to the registry from earlier records, expires ${l.expires_on}`);
      return { id, number };
    });
  },

  licSetRevoked(id, revoke, reason, actor) {
    const l = this.one('SELECT * FROM licenses WHERE id = ?', Number(id));
    if (!l) return null;
    const t = now();
    this.tx(() => {
      this.run('UPDATE licenses SET revoked_at = ?, revoke_reason = ?, updated_at = ? WHERE id = ?', revoke ? t : null, revoke ? reason : null, t, l.id);
      this.log(actor, revoke ? 'license.revoke' : 'license.reinstate', 'license', l.number,
        revoke ? `Revoked ${l.number} (${l.business_name}): ${reason}` : `Reinstated ${l.number} (${l.business_name})${reason ? `: ${reason}` : ''}`,
        { revoked_at: [l.revoked_at, revoke ? t : null], revoke_reason: [l.revoke_reason, revoke ? reason : null] });
    });
    return l.id;
  },

  /* ---------------- Renewal notices (§ 27-17-465) ---------------- */

  // Active licenses whose renewal notice is due today and hasn't gone out for this term, and lapsed licenses that haven't been told.
  licNoticesDue(today) {
    const open = "SELECT 1 FROM license_applications a WHERE a.license_id = l.id AND a.status IN ('submitted', 'in_review', 'needs_info', 'awaiting_payment', 'paid')";
    const renew = this.all(`SELECT * FROM licenses l WHERE revoked_at IS NULL AND expires_on >= ? AND expires_on <= ?
      AND (reminded_for IS NULL OR reminded_for != expires_on) AND NOT EXISTS (${open})`, today, addDays(today, 70))
      .filter((l) => reminderDate(l.expires_on) <= today);
    const lapsed = this.all(`SELECT * FROM licenses l WHERE revoked_at IS NULL AND expires_on < ? AND expires_on >= ?
      AND (lapsed_notice_for IS NULL OR lapsed_notice_for != expires_on) AND NOT EXISTS (${open})`, today, addDays(today, -60));
    return { renew, lapsed };
  },

  licMarkNotice(id, kind, result, actor) {
    const l = this.one('SELECT * FROM licenses WHERE id = ?', id);
    if (!l) return;
    const col = kind === 'lapsed' ? 'lapsed_notice_for' : 'reminded_for';
    this.tx(() => {
      this.run(`UPDATE licenses SET ${col} = ?, reminder_result = ? WHERE id = ?`, l.expires_on, result, id);
      this.log(actor, kind === 'lapsed' ? 'license.lapsed_notice' : 'license.reminder', 'license', l.number,
        `${kind === 'lapsed' ? 'Expired-license notice' : 'Renewal notice'} for ${l.number} (${l.business_name}, expires ${l.expires_on}): ${result}`);
    });
  },

  licSummary(today) {
    const one = (sql, ...a) => this.one(sql, ...a).n;
    return {
      open: one("SELECT COUNT(*) AS n FROM license_applications WHERE status IN ('submitted', 'in_review', 'needs_info', 'awaiting_payment', 'paid')"),
      toReview: one("SELECT COUNT(*) AS n FROM license_applications WHERE status IN ('submitted', 'in_review', 'paid')"),
      byStatus: this.all('SELECT status, COUNT(*) AS n FROM license_applications GROUP BY status'),
      active: one('SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NULL AND expires_on >= ?', today),
      expiring: one('SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NULL AND expires_on >= ? AND expires_on <= ?', today, addDays(today, 62)),
      expired: one('SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NULL AND expires_on < ?', today),
      revoked: one('SELECT COUNT(*) AS n FROM licenses WHERE revoked_at IS NOT NULL'),
    };
  },
};
