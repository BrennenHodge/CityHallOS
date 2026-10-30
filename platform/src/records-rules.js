// Public records rules: response deadlines, working days, fees, exemptions and redaction checks.
// Every state's public records law is different, so the rule is a per-city setting. These are the defaults.
//
// Mississippi Public Records Act of 1983, Miss. Code Ann. § 25-61-1 et seq.:
//   § 25-61-5(1)(a)  A public body may not take longer than seven (7) working days after it receives a request to
//                    produce the records or deny the request.
//   § 25-61-5(1)(b)  If it can't produce the records by the seventh working day, it must give the requester a written
//                    explanation of why. Production may then be no later than fourteen (14) working days from receipt of
//                    the original request, unless the public body and the requester mutually agree to a later date.
//   § 25-61-5(3)     A denial must be in writing and state the specific exemption relied on. Denials are kept on file
//                    for at least three years.
//   § 25-61-7(1)     Fees may reimburse, and may never exceed, the actual cost of searching, reviewing and/or duplicating
//                    and, if applicable, mailing the records, and may be collected in advance.
// § 25-61-5 carries a repeal date of July 1, 2028; check that the Legislature has extended it before relying on it after then.
// Working days exclude weekends and the legal holidays in Miss. Code Ann. § 3-3-7.

export const STATE_RULES = {
  MS: {
    statute: 'Miss. Code Ann. § 25-61-5',
    responseDays: 7,
    extensionDays: 14,
    extensionNote: 'With a written explanation to the requester. Later dates only by mutual agreement.',
    feeStatute: 'Miss. Code Ann. § 25-61-7',
    holidays: 'MS',
    exemptions: [
      'Miss. Code Ann. § 25-61-9: third-party trade secrets and confidential commercial or financial information',
      'Miss. Code Ann. § 25-61-11: records made confidential or privileged by another statute or court decision',
      'Miss. Code Ann. § 25-61-12: law enforcement investigative records',
      'Miss. Code Ann. § 25-1-100: personnel records and employment applications',
      'Miss. Code Ann. § 25-1-102: attorney work product',
      '42 U.S.C. § 405(c)(2)(C)(viii): Social Security numbers',
    ],
  },
};

// For states without a built-in rule. Staff confirm it in Records settings; the dashboard says so until they do.
export const GENERIC_RULE = {
  statute: '', responseDays: 5, extensionDays: 10, extensionNote: '', feeStatute: '', holidays: 'US', exemptions: [],
};

export function defaultRecordsSettings(stateAbbr) {
  const rule = STATE_RULES[stateAbbr];
  return {
    ...(rule || GENERIC_RULE),
    confirmed: !!rule,
    warnDays: 2,
    closures: [],
    // The actual cost of each step, set by the city. Zero means not charged.
    fees: { searchHourly: 0, reviewHourly: 0, perPage: 0, perMedia: 0, mailing: 0, prepay: true },
    custodian: 'City Clerk',
  };
}

/* ---------------- Working days ---------------- */

const ymd = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const nth = (y, m, weekday, n) => { const d = utc(y, m, 1); d.setUTCDate(1 + ((weekday - d.getUTCDay() + 7) % 7) + (n - 1) * 7); return d; };
const last = (y, m, weekday) => { const d = utc(y, m + 1, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - weekday + 7) % 7)); return d; };
// A holiday on a Sunday is observed the Monday after; one on a Saturday, the Friday before.
const observed = (d) => { const x = new Date(d); if (x.getUTCDay() === 0) x.setUTCDate(x.getUTCDate() + 1); else if (x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() - 1); return x; };

function holidaysFor(year, kind) {
  const common = [observed(utc(year, 0, 1)), nth(year, 0, 1, 3), nth(year, 1, 1, 3), last(year, 4, 1), observed(utc(year, 6, 4)),
    nth(year, 8, 1, 1), observed(utc(year, 10, 11)), nth(year, 10, 4, 4), observed(utc(year, 11, 25))];
  // Miss. Code Ann. § 3-3-7 adds Confederate Memorial Day, the last Monday of April.
  if (kind === 'MS') return [...common, last(year, 3, 1)];
  // Federal holidays add Juneteenth and Columbus Day.
  if (kind === 'US') return [...common, observed(utc(year, 5, 19)), nth(year, 9, 1, 2)];
  return [];
}

const holidayCache = new Map();
function isHoliday(day, rule) {
  const year = Number(day.slice(0, 4));
  const key = `${rule.holidays}:${year}`;
  if (!holidayCache.has(key)) holidayCache.set(key, new Set(holidaysFor(year, rule.holidays).map(ymd)));
  return holidayCache.get(key).has(day) || (rule.closures || []).includes(day);
}

export function isWorkingDay(day, rule) {
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !isHoliday(day, rule);
}

// The working day `n` working days after `day`. Day one is the first working day after the request arrived.
export function addWorkingDays(day, n, rule) {
  const d = new Date(`${day}T12:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isWorkingDay(ymd(d), rule)) left--;
  }
  return ymd(d);
}

// Working days from `from` until `to`: 0 when due today, negative when overdue.
export function workingDaysUntil(from, to, rule) {
  if (from === to) return 0;
  const sign = from < to ? 1 : -1;
  const d = new Date(`${from}T12:00:00Z`);
  let n = 0;
  for (let guard = 0; ymd(d) !== to && guard < 800; guard++) {
    d.setUTCDate(d.getUTCDate() + sign);
    if (isWorkingDay(ymd(d), rule)) n += sign;
  }
  return n;
}

// The calendar date in the city's time zone.
export function localDay(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

// How close a request is to its deadline, for the staff queue.
export function deadlineState(r, rule, today) {
  const due = r.extended_due || r.due_date;
  if (!due || r.closed_at) return { due, left: null, state: r.closed_at ? 'closed' : 'none' };
  const left = workingDaysUntil(today, due, rule);
  return { due, left, state: left < 0 ? 'overdue' : left <= (rule.warnDays ?? 2) ? 'due_soon' : 'on_track' };
}

/* ---------------- Fees ---------------- */

// The fee estimate from staff's measured or expected effort. Every line is the city's actual cost of that step.
export function estimateFees(input, fees) {
  const n = (v) => Math.max(0, Number(v) || 0);
  const lines = [
    ['Searching for records', n(input.searchHours), 'hour', fees.searchHourly],
    ['Reviewing records', n(input.reviewHours), 'hour', fees.reviewHourly],
    ['Copies', n(input.pages), 'page', fees.perPage],
    ['Electronic media (USB drive or disc)', n(input.media), 'item', fees.perMedia],
    ['Mailing', input.mailing ? 1 : 0, 'package', fees.mailing],
  ].filter(([, qty, , rate]) => qty > 0 && rate > 0)
    .map(([label, qty, unit, rate]) => ({ label, qty, unit, rate, cents: Math.round(qty * rate * 100) }));
  return { lines, cents: lines.reduce((a, l) => a + l.cents, 0) };
}

export const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

/* ---------------- Redaction checks ---------------- */

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const CHECKS = [
  { type: 'ssn', label: 'Social Security number', re: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g },
  { type: 'account', label: 'Card number', re: /\b(?:\d[ -]?){13,19}\b/g, test: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'account', label: 'Account or routing number', re: /\b(?:account|acct|routing|a\/c)(?:\s*(?:number|no\.?|#))?\s*[:#]?\s*([0-9][0-9 -]{4,20}[0-9])/gi },
  { type: 'contact', label: 'Email address', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { type: 'contact', label: 'Phone number', re: /(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g },
  { type: 'contact', label: 'Street address', re: /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Hwy|Highway|Ct|Court|Cir|Circle|Pl|Place|Way)\b\.?/g },
  { type: 'personal', label: 'Date of birth', re: /\b(?:DOB|date of birth|born)\s*[:#]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi },
];

const mask = (s) => { const t = s.trim(); return t.length <= 4 ? '••••' : `${'•'.repeat(Math.min(8, t.length - 4))}${t.slice(-4)}`; };

// Things in a document's text that may need redacting before release. Staff decide; this only points them out.
export function findRedactions(text) {
  if (!text) return [];
  const found = new Map();
  for (const c of CHECKS) {
    for (const m of String(text).matchAll(c.re)) {
      if (c.test && !c.test(m[0])) continue;
      const key = c.label;
      const f = found.get(key) || { type: c.type, label: c.label, count: 0, examples: [], status: 'pending' };
      f.count++;
      if (f.examples.length < 3) {
        const at = m.index;
        const before = text.slice(Math.max(0, at - 40), at).replace(/\s+/g, ' ');
        f.examples.push(`…${before}${mask(m[0])}`);
      }
      found.set(key, f);
    }
  }
  return [...found.values()];
}
