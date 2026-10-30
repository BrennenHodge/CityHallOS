// Business (privilege) license rules for Mississippi cities: settings, fees, license periods and penalties.
//
// Mississippi Code Annotated, Title 27, Chapter 17 ("Local Privilege Taxes"):
//   § 27-17-3    "Business" is any activity carried on for gain or advantage. An employee is full-time (30 or more hours a
//                week); partners of professional firms count, seasonal workers don't.
//   § 27-17-5    Each municipality levies and collects the privilege tax on businesses within it. Outside city limits the
//                tax belongs to the county.
//   § 27-17-9    A person must apply for, pay for and get the license from the city's tax collector before starting the
//                business. The tax is set by full-time employees: $20 for 3 or fewer, $30 for 4 to 10, and $30 plus $3 for
//                each employee over 10 up to $150 (manufacturers with 11 or more: $80).
//   § 27-17-453  The written application gives the business name (and each partner), the business office address, the
//                location of the place of business, the nature of the business and total employees over the prior 12
//                months. Renewals need no notary.
//   § 27-17-455  The officer checks the application and the tax, may ask for more information, then issues the license
//                dated the first day of the month of issuance, countersigns it and records it in a register. A duplicate
//                is kept as a public record. No license runs longer than one year.
//   § 27-17-463  Licenses expire September 30 each year unless the city adopts an ordinance making them expire one year
//                from issuance. A license for part of a year is prorated to the next September 30.
//   § 27-17-465  The collector sends a renewal notice on or before the first day of the month before the license expires.
//                Not receiving one doesn't excuse penalties.
//   § 27-17-467  Late: the tax plus a 10% penalty, then 1% a month or part of a month while it stays unpaid.
//
// The amounts in § 27-17-9 are offered as a template (STATE_SCHEDULE). What a city actually charges, its license classes,
// term and wording are that city's own settings, kept in its store and changed by its administrators.

export const DEFAULT_CONFIG = {
  departmentId: 'city-hall',  // the department whose staff work licenses
  officerName: '',
  officerTitle: 'City Clerk',
  term: 'fiscal',             // 'fiscal': every license expires on expiresOn (§ 27-17-463); 'anniversary': one year from issuance
  expiresOn: '09-30',
  prorate: true,
  penaltyInitialPct: 10,      // § 27-17-467
  penaltyMonthlyPct: 1,
  requirements: '',           // what applicants need, in the city's words; residents and the AI see it
  homeRules: '',              // the city's home-based business (home occupation) rules
  certificateNote: 'Issued under Miss. Code Ann. § 27-17. Valid only for the business and location shown on this license.',
  classes: [],
};

// Fee types: 'flat' (amount), 'employees' (tiers by full-time employees), 'assessed' (City Hall sets the amount).
// A tier with upTo null covers everyone above the previous tier; perExtra is charged for each employee over the previous tier.
export const STATE_SCHEDULE = [
  { key: 'general', label: 'General business', description: 'Most businesses, priced by full-time employees (Miss. Code Ann. § 27-17-9).',
    fee: { type: 'employees', tiers: [{ upTo: 3, amount: 20 }, { upTo: 10, amount: 30 }, { upTo: null, amount: 30, perExtra: 3, max: 150 }] } },
  { key: 'manufacturer', label: 'Manufacturer', description: 'Businesses that make products for sale from materials they own (§ 27-17-3, § 27-17-9).',
    fee: { type: 'employees', tiers: [{ upTo: 3, amount: 20 }, { upTo: 10, amount: 30 }, { upTo: null, amount: 80 }] } },
  { key: 'other', label: 'Other or not sure', description: 'City Hall reviews the business and sets the fee.', fee: { type: 'assessed' } },
];

export const APPLICATION_STATUS = {
  submitted: 'Received', in_review: 'Under review', needs_info: 'More information needed', awaiting_payment: 'Fee assessed, payment due',
  paid: 'Paid, license being prepared', issued: 'License issued', denied: 'Not approved', withdrawn: 'Withdrawn',
};
export const OPEN_STATUSES = ['submitted', 'in_review', 'needs_info', 'awaiting_payment', 'paid'];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const text = (v, max) => String(v ?? '').trim().slice(0, max);

// Settings as saved, filled out with defaults and made safe to use.
export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...raw };
  const classes = (Array.isArray(c.classes) ? c.classes : []).slice(0, 40).map((k, i) => {
    const type = ['flat', 'employees', 'assessed'].includes(k?.fee?.type) ? k.fee.type : 'assessed';
    const fee = { type };
    if (type === 'flat') fee.amount = Math.max(0, num(k.fee.amount));
    if (type === 'employees') {
      fee.tiers = (Array.isArray(k.fee.tiers) ? k.fee.tiers : []).slice(0, 12).map((t) => ({
        upTo: t.upTo === null || t.upTo === '' || t.upTo === undefined ? null : Math.max(0, Math.floor(num(t.upTo))),
        amount: Math.max(0, num(t.amount)),
        ...(num(t.perExtra) ? { perExtra: Math.max(0, num(t.perExtra)) } : {}),
        ...(num(t.max) ? { max: Math.max(0, num(t.max)) } : {}),
      })).sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
    }
    const label = text(k?.label, 80) || `Class ${i + 1}`;
    const key = text(k?.key, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    return { key, label, description: text(k?.description, 300), fee };
  });
  return {
    departmentId: text(c.departmentId, 60) || 'city-hall',
    officerName: text(c.officerName, 120),
    officerTitle: text(c.officerTitle, 120) || 'City Clerk',
    term: c.term === 'anniversary' ? 'anniversary' : 'fiscal',
    expiresOn: /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(c.expiresOn) ? c.expiresOn : '09-30',
    prorate: c.prorate !== false,
    penaltyInitialPct: Math.max(0, num(c.penaltyInitialPct, 10)),
    penaltyMonthlyPct: Math.max(0, num(c.penaltyMonthlyPct, 1)),
    requirements: text(c.requirements, 4000),
    homeRules: text(c.homeRules, 4000),
    certificateNote: text(c.certificateNote, 400),
    classes: classes.filter((k, i) => classes.findIndex((x) => x.key === k.key) === i),
  };
}

/* ---------------- Dates (YYYY-MM-DD, compared as strings) ---------------- */

const D = (s) => new Date(`${s}T00:00:00Z`);
const ymd = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => ymd(new Date(D(s).getTime() + n * 864e5));
export const firstOfMonth = (s) => `${s.slice(0, 7)}-01`;
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(D(s).getTime());

// Today's date in the city's time zone.
export function cityToday(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return ymd(new Date());
  }
}

// Months, counting a part of a month as a whole one, from the day after `from` through `to`.
function monthsOrPart(from, to) {
  if (to <= from) return 0;
  const a = D(from); const b = D(to);
  let m = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() > a.getUTCDate()) m += 1;
  return Math.max(1, m);
}

// The dates a license covers. § 27-17-455: dated the first day of the month it is issued. A renewal paid before the old
// license runs out starts the day after it expires.
export function licensePeriod(cfg, { today, renewingExpires = null }) {
  const start = renewingExpires && renewingExpires >= today ? addDays(renewingExpires, 1) : firstOfMonth(today);
  let end;
  if (cfg.term === 'anniversary') {
    const [y, m] = start.split('-').map(Number);
    end = addDays(`${y + 1}-${String(m).padStart(2, '0')}-${start.slice(8)}`, -1);
  } else {
    const [mm, dd] = cfg.expiresOn.split('-').map(Number);
    const y = Number(start.slice(0, 4));
    const candidate = (yy) => `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(dd, lastDay(yy, mm))).padStart(2, '0')}`;
    end = candidate(y) >= start ? candidate(y) : candidate(y + 1);
  }
  // Calendar months covered, for proration (§ 27-17-463).
  const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + (Number(end.slice(5, 7)) - Number(start.slice(5, 7))) + 1;
  return { start, end, months: Math.min(12, Math.max(1, months)) };
}

// The first day the renewal notice is due: the first day of the month before the month of expiration (§ 27-17-465).
export function reminderDate(expiresOn) {
  const [y, m] = expiresOn.split('-').map(Number);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`;
}

/* ---------------- Fees ---------------- */

export const dollars = (cents) => (cents == null ? '' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// The annual fee for a class, or null when City Hall sets it.
export function annualFee(cls, employees) {
  if (!cls) return null;
  const f = cls.fee;
  if (f.type === 'flat') return Math.round(f.amount * 100);
  if (f.type !== 'employees' || !f.tiers?.length || employees == null) return null;
  const e = Math.max(0, Math.floor(employees));
  let prev = 0;
  for (const t of f.tiers) {
    if (t.upTo === null || e <= t.upTo) {
      let amt = t.amount + (t.perExtra || 0) * Math.max(0, e - prev);
      if (t.max) amt = Math.min(amt, t.max);
      return Math.round(amt * 100);
    }
    prev = t.upTo;
  }
  return null;
}

// Plain-language fee for residents, e.g. "$20 for 3 or fewer full-time employees; $30 for 4 to 10; ..."
export function describeFee(cls) {
  const f = cls?.fee;
  if (!f || f.type === 'assessed') return 'Set by City Hall after review';
  if (f.type === 'flat') return `${dollars(Math.round(f.amount * 100))} a year`;
  let prev = 0;
  return f.tiers.map((t) => {
    const who = t.upTo === null ? `${prev + 1} or more` : prev === 0 ? `${t.upTo} or fewer` : `${prev + 1} to ${t.upTo}`;
    const base = dollars(Math.round(t.amount * 100));
    const extra = t.perExtra ? ` plus ${dollars(Math.round(t.perExtra * 100))} for each over ${prev}${t.max ? `, up to ${dollars(Math.round(t.max * 100))}` : ''}` : '';
    prev = t.upTo ?? prev;
    return `${base}${extra} for ${who} full-time employees`;
  }).join('; ');
}

// What staff are offered when they assess an application. Staff can change any line before it is saved.
export function suggestFee(cfg, app, { today, license = null }) {
  const cls = cfg.classes.find((c) => c.key === app.class_key);
  const renewingExpires = app.kind === 'renewal' && license ? license.expires_on : null;
  const period = licensePeriod(cfg, { today, renewingExpires });
  const lines = [];
  const notes = [];
  const yearly = annualFee(cls, app.employees);
  let base = yearly;
  if (yearly == null) {
    notes.push(cls ? `${cls.label} fees are set by City Hall.` : 'Choose a license class, or enter the fee.');
  } else if (cfg.term === 'fiscal' && cfg.prorate && period.months < 12) {
    base = Math.round((yearly * period.months) / 12);
    lines.push({ label: `${cls.label}: ${dollars(yearly)} a year, prorated for ${period.months} month${period.months === 1 ? '' : 's'} (§ 27-17-463)`, cents: base });
  } else {
    lines.push({ label: `${cls.label}${cls.fee.type === 'employees' ? ` (${app.employees} full-time employee${app.employees === 1 ? '' : 's'})` : ''}`, cents: base });
  }
  // § 27-17-467: a lapsed renewal, or a business that opened before getting its license.
  const lateSince = app.kind === 'renewal' && license && license.expires_on < today ? license.expires_on
    : app.kind === 'new' && isDate(app.start_date) && app.start_date < firstOfMonth(app.created_at?.slice(0, 10) || today) ? app.start_date : null;
  if (lateSince && base) {
    const months = monthsOrPart(lateSince, today);
    if (months) {
      const pct = cfg.penaltyInitialPct + cfg.penaltyMonthlyPct * (months - 1);
      lines.push({ label: `Late penalty: ${pct}% (${months} month${months === 1 ? '' : 's'} since ${lateSince}, § 27-17-467)`, cents: Math.round((base * pct) / 100), penalty: true });
    }
  }
  return { lines, total_cents: lines.reduce((s, l) => s + l.cents, 0), needsAmount: yearly == null, period, notes };
}
