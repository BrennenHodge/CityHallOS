// The form engine. Every application a city takes online (construction permit, variance, sign permit, certificate of
// occupancy, ...) is one plain definition: sections of fields, the guided questions, completeness checks, derived values
// and the fee. defineForm() turns a definition into everything the routes, the chat, the on-screen form, the staff queue
// and the PDFs need, so a new form is a new file in forms/ and nothing else.
//
// Field names follow one convention across forms so answers can be reused (from a resident's profile, or an earlier
// application on the same device): owner_*, applicant_* (someone applying for the owner), rep_* (who speaks at a
// hearing), contractor_*, each with _name, _address, _city, _state, _zip, _phone, _cell, _email.

export const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
export const ZONES = [['A-R', 'A-R'], ['R-1', 'R-1'], ['R-2', 'R-2'], ['R-3', 'R-3'], ['R-4', 'R-4'], ['R-0', 'R-0'], ['C-1', 'C-1'], ['C-2', 'C-2'], ['C-3', 'C-3'], ['I-1', 'I-1']];
export const ZONES_UNSURE = [...ZONES, ['unknown', 'Not sure (City Hall will confirm)']];
export const YES_NO = [['yes', 'Yes'], ['no', 'No']];
export const CONTACT_PREF = [['email', 'Email'], ['sms', 'Text message'], ['call', 'Phone call']];
export const SIDES = [['north', 'North'], ['south', 'South'], ['east', 'East'], ['west', 'West']];

export const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
export const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);
const tenDigits = (s) => String(s || '').replace(/\D/g, '').length >= 10;

// Shown-if conditions are plain data so the browser and the Worker evaluate them the same way:
// { field: value } equals, { field: [a, b] } one of, { field: { not: value } }, { field: { has: value } } list contains,
// { field: true } answered.
export function matches(cond, d) {
  if (!cond) return true;
  return Object.entries(cond).every(([k, v]) => {
    const x = d[k];
    if (Array.isArray(v)) return v.includes(x);
    if (v && typeof v === 'object' && 'not' in v) return x != null && x !== '' && x !== v.not;
    if (v && typeof v === 'object' && 'has' in v) return Array.isArray(x) && x.includes(v.has);
    if (v === true) return x != null && x !== '' && x !== false && !(Array.isArray(x) && !x.length);
    return x === v;
  });
}

// One field. Types: text, longtext, address, phone, email, state, zip, number, money, select, radio, multi, bool,
// check, signature, files. Extra keys: help, placeholder, half, when, options, required (true or the message),
// optional (left out of the progress bar), explain (longer plain-language help the chat uses to answer "what does this mean?").
export const f = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

// A person or company with a mailing address. reach: require a phone or email.
export function party(prefix, who, { when, cell = true, required = false, reach = false, address = true, help } = {}) {
  const w = when ? { when } : {};
  return [
    f(`${prefix}_name`, who, 'text', { ...w, required: required && `Enter the ${who.toLowerCase()}'s name.`, help }),
    ...(address ? [
      f(`${prefix}_address`, 'Mailing address', 'text', { ...w, required: required && 'Enter the mailing address.' }),
      f(`${prefix}_city`, 'City', 'text', { ...w, half: true, required: required && 'Enter the city.' }),
      f(`${prefix}_state`, 'State', 'state', { ...w, half: true, required: required && 'Enter the state.' }),
      f(`${prefix}_zip`, 'ZIP', 'zip', { ...w, half: true, required: required && 'Enter the ZIP code.' }),
    ] : []),
    f(`${prefix}_phone`, 'Phone', 'phone', { ...w, half: true, reach: reach ? prefix : undefined }),
    ...(cell ? [f(`${prefix}_cell`, 'Cell', 'phone', { ...w, half: true, optional: true })] : []),
    f(`${prefix}_email`, 'Email', 'email', { ...w, optional: !reach }),
  ];
}

// Who is filling it out, the owner's details, and someone applying for them. Used by most applications.
export function ownerAndApplicant({ ownerLabel = 'Property owner', ownerHelp = 'As shown on the deed or tax records.' } = {}) {
  return [
    f('applicant_role', 'Who is filling out this application?', 'select', { options: [['owner', 'The property owner'], ['other', 'Someone else for the owner']], required: 'Tell us who is filling out the application.' }),
    ...party('owner', ownerLabel, { required: true, reach: true, help: ownerHelp }),
    ...party('applicant', 'Applicant (if not the owner)', { when: { applicant_role: 'other' }, required: true, reach: true }),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: CONTACT_PREF }),
  ];
}

// Where the property is, for Planning Commission applications.
export function propertyDetails() {
  return [
    f('street_side', 'The property is on which side of the street?', 'select', { options: SIDES, optional: true }),
    f('between_streets', 'Between which streets?', 'text', { placeholder: 'e.g. Pine St and Magnolia Dr', optional: true }),
    f('subdivision', 'Subdivision', 'text', { optional: true }),
    f('lot', 'Lot', 'text', { half: true, optional: true }),
    f('block', 'Block', 'text', { half: true, optional: true }),
    f('frontage', 'Lot frontage (ft)', 'number', { half: true, help: 'Width of the lot along the street.' }),
    f('frontage_street', 'Along which street?', 'text', { half: true, optional: true }),
    f('frontage2', 'Second frontage (ft), corner lots only', 'number', { half: true, optional: true }),
    f('frontage2_street', 'Along which street?', 'text', { half: true, optional: true }),
    f('lot_depth', 'Lot depth (ft)', 'number', { half: true }),
    f('lot_size', 'Size of property', 'text', { half: true, placeholder: 'e.g. 0.5 acres or 21,780 sq ft' }),
    f('existing_structures', 'Existing buildings and structures on the property', 'longtext', { placeholder: 'e.g. One-story house, detached carport, storage shed' }),
  ];
}

// The signature block. notary: the owner's signature must be notarized (Planning Commission applications).
export function signFields({ certify, notary = false, hazmat = false }) {
  return [
    ...(hazmat ? [f('hazmat_ack', 'If there is lead, asbestos or other hazardous material on site, I will follow Mississippi Department of Environmental Quality (MDEQ) rules to remove it properly. MDEQ: (601) 961-5164.', 'check', { required: 'Accept the hazardous materials certification.' })] : []),
    f('certify', certify, 'check', { required: 'Accept the certification.' }),
    f('signature_name', 'Type your full name to sign', 'signature', { required: 'Type your full name to sign.' }),
    ...(notary ? [f('notary_ack', "I understand the owner's signature must be notarized. I'll print the signature page (PDF button), sign it in front of a notary, and bring it to City Hall or upload a photo of it.", 'check', { required: 'Confirm you will have the signature page notarized.' })] : []),
  ];
}

// The usual guided questions for owner and applicant details.
export function ownerAsks({ ownerWord = 'property owner' } = {}) {
  return [
    { id: 'applicant_role', fields: ['applicant_role'], prompt: `Are you the ${ownerWord}?`, choices: [['owner', `Yes, I'm the ${ownerWord.replace(/^property /, '')}`], ['other', "No, I'm applying for them"]] },
    { id: 'applicant', when: { applicant_role: 'other' }, fields: ['applicant_name', 'applicant_phone'], alt: ['applicant_email'], ai: true, prompt: "What's your name, mailing address, and a phone number or email where City Hall can reach you?" },
    { id: 'owner_name', fields: ['owner_name'], prompt: (d) => (d.applicant_role === 'owner' ? "What's your full name, as it appears on the deed?" : `What's the ${ownerWord}'s full name, as it appears on the deed?`) },
    { id: 'owner_mailing', fields: ['owner_address', 'owner_city', 'owner_state', 'owner_zip'], ai: true, prompt: (d) => `What's ${d.applicant_role === 'owner' ? 'your' : "the owner's"} mailing address, including city, state and ZIP?` },
    { id: 'owner_contact', fields: ['owner_phone'], alt: ['owner_cell', 'owner_email'], ai: true, prompt: (d) => (d.applicant_role === 'owner' ? "What's the best phone number and email for you?" : "What's the owner's phone number and email?") },
    { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates?', choices: CONTACT_PREF },
  ];
}

export const signAsk = (extra = '') => ({ id: 'sign', fields: ['certify', 'signature_name'], prompt: `Last step. Review the application, then type your full name to sign it. By signing you certify the information is true and correct.${extra}` });
export const notaryAsk = { id: 'notary_ack', fields: ['notary_ack'], prompt: "The owner's signature on this application has to be notarized. After you submit, print the signature page (the PDF button), sign it in front of a notary, then bring it to City Hall or upload a photo here. Okay?", choices: [['yes', 'Okay, I understand']] };

/* ---------------- Statuses ---------------- */

const DEFAULT_STATUS = {
  draft: ['Draft', 'Not submitted yet'],
  submitted: ['Submitted', 'City Hall is checking that it is complete'],
  needs_info: ['Changes requested', 'Update the items below and resubmit'],
  fees_due: ['Complete · fee due', 'Review starts once the fee is paid'],
  in_review: ['Under review', 'City Hall is reviewing your application'],
  issued: ['Approved', 'Your application was approved'],
  closed: ['Closed', 'This application is closed'],
  denied: ['Not approved', 'Contact City Hall about your options'],
  withdrawn: ['Withdrawn', 'This application was withdrawn'],
};

/* ---------------- defineForm ---------------- */

// Definition keys:
//   kind, title, short, code (reference number prefix, e.g. VA), icon, department, formUrl (the city's PDF it replaces)
//   intro          one or two sentences the chat says first: what this application is for
//   detect         RegExp: a chat message that means the resident needs this application
//   sections, docKinds, asks
//   addressField   the property address (screened against city limits and flood maps)
//   check(d, ctx, h)  extra rules beyond required fields; h = { add, need, has, label }
//   derive(d, ctx) values that follow from other answers (only fill blanks)
//   contact(d)     who City Hall contacts; default: the applicant if not the owner, else the owner
//   fee(d, cfg)    { total, lines, notes, source }; default: cfg.fees.flat
//   parse          { askId: (text, d) => updates } for answers the generic reader can't handle
//   fillable       field keys the AI may copy from attached documents
//   review         what the AI reviewer should look at, for this application
//   statuses       overrides of DEFAULT_STATUS labels
//   steps          [[key, label]] for the progress tracker
//   issue          { noun, title, numberLabel, action, after, post, inspections, rows(app) }
//   nextSteps      what happens after submitting, one line each
export function defineForm(def) {
  const FIELDS = Object.fromEntries(def.sections.flatMap((s) => s.fields.map((x) => [x.key, { ...x, section: s.id }])));
  const statuses = { ...DEFAULT_STATUS, ...(def.statuses || {}) };
  const issue = { noun: 'approval', title: def.title.toUpperCase(), numberLabel: 'Approval number', action: 'Approve', after: '', post: false, inspections: null, ...(def.issue || {}) };
  const steps = def.steps || [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Review'], ['issued', statuses.issued[0]]];

  function coerce(key, value) {
    const fd = FIELDS[key];
    if (!fd || value === undefined) return undefined;
    if (value === null || value === '') return null;
    const s = String(value).trim().slice(0, fd.type === 'longtext' ? 3000 : 300);
    switch (fd.type) {
      case 'number': case 'money': {
        const n = Number(String(value).replace(/[$,\s]|sq\.?\s*ft|square feet|feet|ft/gi, ''));
        return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
      }
      case 'bool': case 'check':
        if (typeof value === 'boolean') return value;
        if (/^(y|yes|true|1|yeah|yep|correct|same|it is|i agree|okay|ok|i accept|okay, i understand)$/i.test(s)) return true;
        if (/^(n|no|false|0|nope|different|not)$/i.test(s)) return false;
        return undefined;
      case 'select': case 'radio': {
        const opt = fd.options.find(([v, l]) => v.toLowerCase() === s.toLowerCase() || l.toLowerCase() === s.toLowerCase());
        return opt ? opt[0] : undefined;
      }
      case 'multi': {
        const list = (Array.isArray(value) ? value : s.split(/\s*,\s*/)).map((x) => String(x).toLowerCase());
        return fd.options.filter(([v, l]) => list.includes(v.toLowerCase()) || list.includes(l.toLowerCase())).map(([v]) => v);
      }
      case 'state': {
        const up = s.toUpperCase();
        return STATES.includes(up) ? up : up === 'MISSISSIPPI' ? 'MS' : s.slice(0, 20);
      }
      case 'email': return s.toLowerCase();
      case 'files': return undefined; // managed by uploads
      default: return s;
    }
  }

  function derive(d, ctx = {}) {
    let out = { ...d };
    // The owner's mailing address defaults to the property address when the resident says they're the same.
    if (out.owner_same_mailing === true && def.addressField) {
      const p = splitAddress(ctx.matchedAddress || out[def.addressField]);
      if (p) Object.assign(out, { owner_address: p.street, owner_city: p.city, owner_state: p.state, owner_zip: p.zip });
    }
    if (def.derive) out = def.derive(out, ctx);
    return out;
  }

  function contactFor(d) {
    if (def.contact) return def.contact(d);
    const pick = (p) => ({ name: d[`${p}_name`] || null, email: d[`${p}_email`] || null, phone: d[`${p}_cell`] || d[`${p}_phone`] || null });
    const c = d.applicant_role === 'other' && FIELDS.applicant_name ? pick('applicant') : pick('owner');
    return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
  }

  function feeEstimate(d, cfg) {
    if (def.fee) return def.fee(d, cfg || {});
    const flat = cfg?.fees?.flat;
    if (flat == null) return null;
    return { total: flat, lines: [{ label: cfg.fees.label || `${def.title} fee`, amount: flat }], notes: cfg.fees.notes || [], source: cfg.fees.source || null };
  }

  // Rule checks that run on every save. level: 'error' blocks submission, 'warning' is shown to the applicant and
  // staff, 'info' is context for staff. ctx: { files, screen, cfg }.
  function check(d, ctx = {}) {
    const out = [];
    const add = (level, field, message) => out.push({ level, field, message, source: 'rules' });
    const shown = (k) => FIELDS[k] && matches(FIELDS[k].when, d);
    const need = (k, msg) => { if (shown(k) && !has(d[k])) add('error', k, msg || `${FIELDS[k].label} is required.`); };
    for (const fd of Object.values(FIELDS)) {
      if (fd.required && !has(d[fd.key])) need(fd.key, typeof fd.required === 'string' ? fd.required : undefined);
      if (!shown(fd.key) || !has(d[fd.key])) continue;
      if (fd.type === 'email' && !EMAIL.test(d[fd.key])) add('error', fd.key, `${labelFor(fd)} doesn't look like an email address.`);
      if (fd.type === 'phone' && !tenDigits(d[fd.key])) add('error', fd.key, `${labelFor(fd)} needs a 10-digit number.`);
      if (fd.type === 'zip' && !/^\d{5}(-\d{4})?$/.test(d[fd.key])) add('error', fd.key, `${labelFor(fd)} should be 5 digits.`);
    }
    // reach: a phone number or email for this person.
    for (const fd of Object.values(FIELDS).filter((x) => x.reach && shown(x.key))) {
      const p = fd.reach;
      if (![`${p}_phone`, `${p}_cell`, `${p}_email`].some((k) => has(d[k]))) add('error', `${p}_phone`, `Give a phone number or email for the ${(FIELDS[`${p}_name`]?.label || p).toLowerCase().replace(/ \(.*\)$/, '')}.`);
    }
    if (FIELDS.contact_pref) {
      const c = contactFor(d);
      if (d.contact_pref === 'email' && !has(c.email)) add('error', 'contact_pref', 'You chose email updates. Add an email address, or choose text or phone.');
      if (['sms', 'call'].includes(d.contact_pref) && !has(c.phone)) add('error', 'contact_pref', 'You chose text or phone updates. Add a phone number, or choose email.');
    }
    const sc = ctx.screen;
    if (def.addressField && sc?.jurisdiction?.checked && sc.jurisdiction.inCity === false) {
      add('warning', def.addressField, `The U.S. Census geocoder places this address ${sc.jurisdiction.place ? `in ${sc.jurisdiction.place}` : 'outside city limits'}${sc.jurisdiction.county ? `, ${sc.jurisdiction.county}` : ''}. If it is outside city limits, the county handles this instead of City Hall.`);
    }
    if (def.check) def.check(d, ctx, { add, need, has, label: (k) => FIELDS[k]?.label || k });
    // One message per field and level is enough.
    const seen = new Set();
    return out.filter((x) => { const k = `${x.level}:${x.field}:${x.message}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // Share of the application that is filled in, for progress bars.
  function progress(d, files = []) {
    const keys = Object.values(FIELDS).filter((x) => matches(x.when, d) && !x.optional && x.type !== 'check' || x.required && matches(x.when, d));
    if (!keys.length) return 0;
    const filled = keys.filter((x) => (x.type === 'files' ? files.length > 0 : has(d[x.key]))).length;
    return Math.round((filled / keys.length) * 100);
  }

  // The next question to ask, given what's answered. `asked` lists optional asks already shown.
  function nextAsk(d, files = [], asked = []) {
    for (const a of def.asks) {
      if (!matches(a.when, d)) continue;
      if (a.done ? a.done(d, files, asked) : a.fields.every((k) => has(d[k])) || (a.alt || []).some((k) => has(d[k]))) continue;
      if (a.optional && asked.includes(a.id)) continue;
      return a;
    }
    return null;
  }

  function askView(a, d) {
    if (!a) return null;
    const first = FIELDS[a.fields?.[0]];
    return {
      id: a.id, prompt: typeof a.prompt === 'function' ? a.prompt(d) : a.prompt, fields: a.fields, choices: a.choices || null, upload: a.upload || null,
      // Lets the phone keyboard match the answer: numbers, phone, email.
      input: a.fields?.length === 1 && !a.alt && first ? ({ phone: 'tel', email: 'email', number: 'decimal', money: 'decimal', zip: 'numeric' })[first.type] || null : null,
    };
  }

  // What the browser needs to draw the form. Functions stay on the server.
  function publicSchema() {
    return {
      kind: def.kind, title: def.title, short: def.short || def.title, icon: def.icon || 'file', intro: def.intro || '', department: def.departmentName || 'Planning & Building',
      sections: def.sections, docKinds: def.docKinds || [['other', 'Document']], addressField: def.addressField || null,
      statuses, steps, issue: { noun: issue.noun, numberLabel: issue.numberLabel, action: issue.action, post: issue.post, inspections: issue.inspections },
      notary: !!FIELDS.notary_ack, nextSteps: def.nextSteps || [],
    };
  }

  return { ...def, FIELDS, statuses, steps, issue, coerce, derive, contactFor, feeEstimate, check, progress, nextAsk, askView, publicSchema };
}

const labelFor = (fd) => (['Phone', 'Cell', 'Email', 'ZIP'].includes(fd.label) ? `${fd.label === 'ZIP' ? 'ZIP code' : fd.label} for the ${fd.key.split('_')[0].replace('dp', 'design professional').replace('rep', 'representative')}` : fd.label);

// Splits "123 Main St, Wiggins, MS 39577" into parts.
export function splitAddress(a) {
  const m = String(a || '').match(/^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*$/);
  return m ? { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] } : null;
}

// Adds the city's published valuation-based fee: each tier { upTo, fee } flat, or
// { upTo, base, over, per: 1000, add } = base + add for each `per` (or fraction) above `over`.
export function tieredFee(value, tiers) {
  const v = Number(value);
  if (!(v > 0) || !Array.isArray(tiers) || !tiers.length) return null;
  const t = tiers.find((x) => x.upTo == null || v <= x.upTo) || tiers.at(-1);
  if (t.fee != null) return t.fee;
  return Math.round((t.base + Math.ceil(Math.max(0, v - t.over) / (t.per || 1000)) * t.add) * 100) / 100;
}
