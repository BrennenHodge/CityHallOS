// The construction permit application: one definition that drives the guided conversation, the on-screen
// form, the completeness checks, the fee estimate and the filled-in city PDF. Every answer is stored once,
// under one key, and everything else (the PDF, page 3 owner certification, the review packet, notifications)
// reads it from there.

export const KIND = 'construction';
export const TITLE = 'Construction permit';

const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');

export const CONSTRUCTION_TYPES = [['new', 'New construction'], ['addition', 'Addition'], ['remodel', 'Remodel / alteration'], ['demolition', 'Demolition'], ['other', 'Other']];
export const PLANNED_WORK = [['excavation', 'Excavation'], ['foundation', 'Foundation'], ['paving', 'Paving'], ['utilities', 'Utilities'], ['electrical', 'Electrical'],
  ['plumbing', 'Plumbing'], ['hvac', 'HVAC / mechanical'], ['steel_frame', 'Steel frame'], ['masonry', 'Masonry'], ['wood_frame', 'Wood frame'],
  ['accessory', 'Accessory structure'], ['drainage', 'Underground drainage'], ['other', 'Other']];
export const OCCUPANCY = [['single_family', 'Single family'], ['multi_family', 'Multi-family'], ['storage', 'Storage'], ['garage', 'Garage / carport'],
  ['commercial', 'Commercial'], ['other', 'Other']];
export const ZONING = [['R-1', 'R-1'], ['R-2', 'R-2'], ['R-3', 'R-3'], ['R-4', 'R-4'], ['R-0', 'R-0'], ['C-1', 'C-1'], ['C-2', 'C-2'], ['C-3', 'C-3'], ['I-1', 'I-1'],
  ['unknown', 'Not sure (City Hall will confirm)']];
export const EXEMPTIONS = [
  ['commercial_own', 'A commercial project on my property that is not for sale, lease, public use or assembly'],
  ['under_50k', 'A commercial project or new residential building under $50,000 on my property'],
  ['remodel_under_10k', 'A residential remodel under $10,000 on my property'],
  ['principal_residence', 'A new residence, residential addition or residential accessory structure on my property that will be my principal residence'],
];
export const DOC_KINDS = [['ownership_proof', 'Proof of ownership'], ['site_plan', 'Site plan'], ['foundation', 'Foundation plan'], ['floor_plan', 'Floor plan'],
  ['electrical', 'Electrical plan'], ['mechanical', 'Mechanical plan'], ['plumbing', 'Plumbing plan'], ['fire_sprinkler', 'Fire sprinkler'], ['irrigation', 'Irrigation'],
  ['landscaping', 'Landscaping'], ['structural', 'Structural'], ['specifications', 'Specifications'], ['other', 'Other document']];

const BUILDS = ['new', 'addition'];
const RESIDENTIAL = ['single_family', 'multi_family', 'storage', 'garage'];

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

const f = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

export const SECTIONS = [
  { id: 'project', title: 'Project', fields: [
    f('description', 'Detailed description of the work', 'longtext', { placeholder: 'e.g. Build a 24 × 30 ft detached two-car garage behind the house' }),
    f('project_name', 'Project name', 'text', { placeholder: 'e.g. Smith detached garage', help: 'A short name for the project. Optional.' }),
    f('construction_type', 'Construction type', 'select', { options: CONSTRUCTION_TYPES }),
    f('construction_type_other', 'Describe the other type of work', 'text', { when: { construction_type: 'other' } }),
    f('planned_work', 'Planned work (check all that apply)', 'multi', { options: PLANNED_WORK }),
    f('planned_work_other', 'Other planned work', 'text', { when: { planned_work: { has: 'other' } } }),
    f('work_started', 'Has any of the work already started?', 'bool', { help: 'Fees are doubled when construction has already begun.' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('job_address', 'Job address', 'address', { placeholder: 'Street address in Wiggins' }),
    f('parcel_number', 'Tax parcel number', 'text', { help: 'On your property tax bill or the county tax parcel card. Leave blank if you don\'t know it.' }),
  ] },
  { id: 'owner', title: 'Owner & contact', fields: [
    f('applicant_role', 'Who is filling out this application?', 'select', { options: [['owner', 'The property owner'], ['contractor', 'The contractor'], ['other', 'Someone else for the owner']] }),
    f('applicant_name', 'Your full name', 'text', { when: { applicant_role: 'other' } }),
    f('applicant_phone', 'Your phone', 'phone', { when: { applicant_role: 'other' } }),
    f('applicant_email', 'Your email', 'email', { when: { applicant_role: 'other' } }),
    f('owner_name', 'Property owner', 'text', { help: 'As shown on the deed or tax records.' }),
    f('owner_same_mailing', "Owner's mailing address is the job address", 'bool'),
    f('owner_address', 'Owner mailing address', 'text', { when: { owner_same_mailing: false } }),
    f('owner_city', 'City', 'text', { when: { owner_same_mailing: false }, half: true }),
    f('owner_state', 'State', 'state', { when: { owner_same_mailing: false }, half: true }),
    f('owner_zip', 'ZIP', 'zip', { when: { owner_same_mailing: false }, half: true }),
    f('owner_phone', 'Owner phone', 'phone', { half: true }),
    f('owner_cell', 'Owner cell', 'phone', { half: true }),
    f('owner_email', 'Owner email', 'email'),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: [['email', 'Email'], ['sms', 'Text message'], ['call', 'Phone call']] }),
  ] },
  { id: 'builder', title: "Who's building it", fields: [
    f('builder', 'Who will do the work?', 'select', { options: [['contractor', 'A licensed contractor'], ['owner', 'The owner (owner-builder)']] }),
    f('contractor_name', 'Contractor', 'text', { when: { builder: 'contractor' } }),
    f('contractor_cor', 'MS Certificate of Responsibility (COR) number', 'text', { when: { builder: 'contractor' }, help: 'Issued by the Mississippi State Board of Contractors.' }),
    f('contractor_address', 'Contractor mailing address', 'text', { when: { builder: 'contractor' } }),
    f('contractor_city', 'City', 'text', { when: { builder: 'contractor' }, half: true }),
    f('contractor_state', 'State', 'state', { when: { builder: 'contractor' }, half: true }),
    f('contractor_zip', 'ZIP', 'zip', { when: { builder: 'contractor' }, half: true }),
    f('contractor_phone', 'Contractor phone', 'phone', { when: { builder: 'contractor' }, half: true }),
    f('contractor_cell', 'Contractor cell', 'phone', { when: { builder: 'contractor' }, half: true }),
    f('contractor_email', 'Contractor email', 'email', { when: { builder: 'contractor' } }),
    f('owner_exemption', 'Owner-builder exception that applies', 'radio', { when: { builder: 'owner' }, options: EXEMPTIONS }),
    f('owner_ack', 'I have read the Owner\'s Construction Permit Responsibilities, I am familiar with the applicable codes, ordinances and state laws, the work must pass city inspections, and the Building Official may require a licensed contractor', 'check', { when: { builder: 'owner' } }),
  ] },
  { id: 'building', title: 'Building', fields: [
    f('stories', 'Stories', 'number', { half: true }),
    f('width', 'Max width (ft)', 'number', { half: true }),
    f('length', 'Length (ft)', 'number', { half: true }),
    f('height', 'Height (ft)', 'number', { half: true }),
    f('area_under_roof', 'Under roof (sq ft)', 'number', { half: true }),
    f('area_heated', 'Heated / cooled (sq ft)', 'number', { half: true }),
    f('area_accessory', 'Accessory (sq ft)', 'number', { half: true }),
    f('area_total', 'Total (sq ft)', 'number', { half: true }),
    f('occupancy', 'Occupancy', 'select', { options: OCCUPANCY }),
    f('occupancy_commercial', 'Commercial use', 'text', { when: { occupancy: 'commercial' } }),
    f('occupancy_other', 'Other use', 'text', { when: { occupancy: 'other' } }),
  ] },
  { id: 'zoning', title: 'Zoning & setbacks', fields: [
    f('zoning', 'Zoning district', 'select', { options: ZONING }),
    f('setback_front', 'Front setback (ft)', 'number', { half: true, help: 'Distance from the building to the front property line.' }),
    f('setback_side', 'Side setback (ft)', 'number', { half: true }),
    f('setback_rear', 'Rear setback (ft)', 'number', { half: true }),
  ] },
  { id: 'design', title: 'Design professional', fields: [
    f('design_pro', 'Design professional', 'select', { options: [['architect', 'Architect'], ['engineer', 'Engineer'], ['designer', 'Designer'], ['none', 'Not applicable']] }),
    f('dp_firm', 'Firm', 'text', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_principal', 'Named principal', 'text', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_license', 'License number', 'text', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_address', 'Mailing address', 'text', { when: { design_pro: ['architect', 'engineer', 'designer'] } }),
    f('dp_city', 'City', 'text', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_state', 'State', 'state', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_zip', 'ZIP', 'zip', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_phone', 'Phone', 'phone', { when: { design_pro: ['architect', 'engineer', 'designer'] }, half: true }),
    f('dp_email', 'Email', 'email', { when: { design_pro: ['architect', 'engineer', 'designer'] } }),
  ] },
  { id: 'cost', title: 'Valuation', fields: [
    f('valuation', 'Total contract price or valuation of the work', 'money', { help: 'Materials and labor. The permit fee is based on this amount.' }),
  ] },
  { id: 'documents', title: 'Documents', fields: [
    f('files', 'Attachments', 'files', { kinds: DOC_KINDS }),
    f('bring_ownership_proof', "I'll bring proof of ownership to City Hall instead", 'check'),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: [
    f('hazmat_ack', 'If there is lead, asbestos or other hazardous material on site, I will follow Mississippi Department of Environmental Quality (MDEQ) rules to remove it properly. MDEQ: (601) 961-5164.', 'check'),
    f('certify', 'I certify that I have read this application, the information is true and correct, I will comply with all applicable codes, ordinances and state laws, and I am the owner or authorized to act as the owner\'s agent for this work.', 'check'),
    f('signature_name', 'Type your full name to sign', 'signature'),
  ] },
];

export const FIELDS = Object.fromEntries(SECTIONS.flatMap((s) => s.fields.map((x) => [x.key, { ...x, section: s.id }])));

// Turn whatever arrived (from the form, the conversation or the AI) into a clean value for a field, or undefined.
export function coerce(key, value) {
  const fd = FIELDS[key];
  if (!fd || value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim().slice(0, fd.type === 'longtext' ? 2000 : 300);
  switch (fd.type) {
    case 'number': case 'money': {
      const n = Number(String(value).replace(/[$,\s]|sq\.?\s*ft|feet|ft/gi, ''));
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
    }
    case 'bool': case 'check':
      if (typeof value === 'boolean') return value;
      if (/^(y|yes|true|1|yeah|yep|correct|same|it is)$/i.test(s)) return true;
      if (/^(n|no|false|0|nope|different|not)$/i.test(s)) return false;
      return undefined;
    case 'select': case 'radio': {
      const opt = fd.options.find(([v, l]) => v.toLowerCase() === s.toLowerCase() || l.toLowerCase() === s.toLowerCase());
      return opt ? opt[0] : undefined;
    }
    case 'multi': {
      const list = (Array.isArray(value) ? value : s.split(/\s*,\s*/)).map((x) => String(x).toLowerCase());
      const out = fd.options.filter(([v, l]) => list.includes(v) || list.includes(l.toLowerCase())).map(([v]) => v);
      return out;
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

/* ---------------- Derived values: answers reused instead of asked again ---------------- */

// Splits "123 Main St, Wiggins, MS 39577" into parts.
export function splitAddress(a) {
  const m = String(a || '').match(/^(.*?),\s*([^,]+?),\s*([A-Za-z]{2})\.?\s+(\d{5})(?:-\d{4})?\s*$/);
  return m ? { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] } : null;
}

// Fills values that follow from other answers. Only fills blanks, so anything the applicant typed wins.
export function derive(d, ctx = {}) {
  const out = { ...d };
  const blank = (k) => out[k] == null || out[k] === '';
  if (out.applicant_role === 'contractor' && blank('builder')) out.builder = 'contractor';
  if (out.owner_same_mailing === true) {
    const p = splitAddress(ctx.matchedAddress || out.job_address);
    if (p) Object.assign(out, { owner_address: p.street, owner_city: p.city, owner_state: p.state, owner_zip: p.zip });
  }
  const w = Number(out.width); const l = Number(out.length); const st = Number(out.stories) || 1;
  if (w > 0 && l > 0 && blank('area_under_roof')) out.area_under_roof = Math.round(w * l * st);
  if (blank('area_total') && Number(out.area_under_roof) > 0) out.area_total = Number(out.area_under_roof) + (Number(out.area_accessory) || 0);
  if (out.occupancy && ['garage', 'storage'].includes(out.occupancy) && BUILDS.includes(out.construction_type) && Array.isArray(out.planned_work)
    && !out.planned_work.includes('accessory') && /detached|accessory|shed|separate/i.test(out.description || '')) {
    out.planned_work = [...out.planned_work, 'accessory'];
  }
  if (blank('project_name') && out.description && out.owner_name) {
    const what = ({ garage: 'garage', storage: 'storage building', single_family: 'residence', commercial: 'commercial building' })[out.occupancy];
    const type = ({ new: '', addition: 'addition', remodel: 'remodel', demolition: 'demolition' })[out.construction_type];
    if (what || type) out.project_name = `${out.owner_name.split(' ').slice(-1)[0]} ${[what, type].filter(Boolean).join(' ')}`.trim();
  }
  return out;
}

// Who City Hall contacts about the application, from answers already given.
export function contactFor(d) {
  const role = d.applicant_role;
  const pick = (name, email, phone) => ({ name: name || null, email: email || null, phone: phone || null });
  const c = role === 'contractor' ? pick(d.contractor_name, d.contractor_email, d.contractor_cell || d.contractor_phone)
    : role === 'other' ? pick(d.applicant_name, d.applicant_email, d.applicant_phone)
      : pick(d.owner_name, d.owner_email, d.owner_cell || d.owner_phone);
  const pref = d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null);
  return { ...c, pref };
}

/* ---------------- Fees ---------------- */

// Construction permit fee from a city's published valuation tiers.
// Each tier: { upTo, fee } flat, or { upTo, base, over, per: 1000, add } = base + add for each `per` (or fraction) above `over`.
export function permitFee(valuation, tiers) {
  const v = Number(valuation);
  if (!(v > 0) || !Array.isArray(tiers) || !tiers.length) return null;
  const t = tiers.find((x) => x.upTo == null || v <= x.upTo) || tiers.at(-1);
  if (t.fee != null) return t.fee;
  return Math.round((t.base + Math.ceil(Math.max(0, v - t.over) / (t.per || 1000)) * t.add) * 100) / 100;
}

export function feeEstimate(d, cfg) {
  const fees = cfg?.fees;
  const permit = permitFee(d.valuation, fees?.tiers);
  if (permit == null) return null;
  const doubled = !!(d.work_started && fees.doubleIfStarted);
  const total = doubled ? permit * 2 : permit;
  const lines = [{ label: `Construction permit (valuation $${Number(d.valuation).toLocaleString()})`, amount: permit }];
  if (doubled) lines.push({ label: 'Doubled because work has already started', amount: permit });
  if (fees.planReviewShare) lines.push({ label: `Plan review deposit: ${Math.round(fees.planReviewShare * 100)}% of the permit fee, paid with the application and applied to the permit`, amount: null, note: Math.round(total * fees.planReviewShare * 100) / 100 });
  return { total, lines, notes: fees.notes || [], source: fees.source || null };
}

/* ---------------- Completeness checks ---------------- */

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PHONE = (s) => String(s || '').replace(/\D/g, '').length >= 10;
const has = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length);

// Rule checks that run on every save. level: 'error' blocks submission, 'warning' is shown to the
// applicant and staff, 'info' is context for staff. ctx: { files, screen, cfg }.
export function check(d, ctx = {}) {
  const out = [];
  const add = (level, field, message) => out.push({ level, field, message, source: 'rules' });
  const need = (k, msg) => { if (matches(FIELDS[k].when, d) && !has(d[k])) add('error', k, msg || `${FIELDS[k].label} is required.`); };
  const kinds = new Set((ctx.files || []).map((x) => x.kind));
  const build = BUILDS.includes(d.construction_type);

  need('description', 'Describe the work you plan to do.');
  need('construction_type', 'Choose the construction type.');
  if (d.construction_type === 'other') need('construction_type_other');
  need('job_address', 'Enter the address where the work will be done.');
  need('applicant_role', 'Tell us who is filling out the application.');
  if (d.applicant_role === 'other') {
    need('applicant_name');
    if (!has(d.applicant_phone) && !has(d.applicant_email)) add('error', 'applicant_phone', 'Give a phone number or email for yourself.');
  }
  need('owner_name', "Enter the property owner's name.");
  if (d.owner_same_mailing === false) { need('owner_address'); need('owner_city'); need('owner_state'); need('owner_zip'); }
  if (!has(d.owner_same_mailing)) add('error', 'owner_same_mailing', "Tell us whether the owner's mailing address is the job address.");
  if (!has(d.owner_phone) && !has(d.owner_cell) && !has(d.owner_email)) add('error', 'owner_phone', 'Give a phone number or email for the owner.');
  need('builder', 'Tell us who will do the work.');
  if (d.builder === 'contractor') {
    need('contractor_name', "Enter the contractor's name.");
    if (!has(d.contractor_phone) && !has(d.contractor_cell) && !has(d.contractor_email)) add('error', 'contractor_phone', "Give the contractor's phone number or email.");
    if (!has(d.contractor_cor)) add(Number(d.valuation) > 10000 ? 'warning' : 'info', 'contractor_cor', "Add the contractor's Mississippi Certificate of Responsibility (COR) number, or City Hall will ask for it.");
  }
  if (d.builder === 'owner') {
    need('owner_exemption', 'Choose which owner-builder exception applies, or use a licensed contractor.');
    need('owner_ack', "Read and accept the Owner's Construction Permit Responsibilities.");
    const v = Number(d.valuation) || 0;
    const res = RESIDENTIAL.includes(d.occupancy);
    if (d.owner_exemption === 'remodel_under_10k' && (d.construction_type !== 'remodel' || v >= 10000)) {
      add('error', 'owner_exemption', `The "residential remodel under $10,000" exception doesn't fit ${d.construction_type ? `a ${(CONSTRUCTION_TYPES.find(([k]) => k === d.construction_type) || [])[1].toLowerCase()} project` : 'a project'} valued at $${v.toLocaleString()}. Choose another exception or a licensed contractor.`);
    }
    if (d.owner_exemption === 'under_50k' && v >= 50000) add('error', 'owner_exemption', `The "under $50,000" exception doesn't fit a project valued at $${v.toLocaleString()}.`);
    if (d.owner_exemption === 'commercial_own' && d.occupancy && d.occupancy !== 'commercial') add('warning', 'owner_exemption', 'The commercial exception was chosen, but the occupancy is not commercial.');
    if (d.owner_exemption === 'principal_residence' && d.occupancy && !res) add('warning', 'owner_exemption', 'The principal-residence exception was chosen for a project that is not residential.');
  }
  if (d.contact_pref === 'email' && !has(contactFor(d).email)) add('error', 'contact_pref', 'You chose email updates. Add an email address, or choose text or phone.');
  if (['sms', 'call'].includes(d.contact_pref) && !has(contactFor(d).phone)) add('error', 'contact_pref', 'You chose text or phone updates. Add a phone number, or choose email.');

  for (const k of ['owner_email', 'contractor_email', 'applicant_email', 'dp_email']) if (has(d[k]) && !EMAIL.test(d[k])) add('error', k, `${FIELDS[k].label} doesn't look like an email address.`);
  for (const k of ['owner_phone', 'owner_cell', 'contractor_phone', 'contractor_cell', 'applicant_phone', 'dp_phone']) if (has(d[k]) && !PHONE(d[k])) add('error', k, `${FIELDS[k].label} needs a 10-digit number.`);
  for (const k of ['owner_zip', 'contractor_zip', 'dp_zip']) if (has(d[k]) && !/^\d{5}(-\d{4})?$/.test(d[k])) add('error', k, `${FIELDS[k].label.replace(/^ZIP$/, 'ZIP code')} should be 5 digits.`);

  if (build || d.construction_type === 'remodel') {
    if (build) { need('stories', 'Enter the number of stories.'); need('width', 'Enter the maximum width.'); need('length', 'Enter the length.'); }
    if (build && !has(d.height)) add('warning', 'height', 'Add the building height.');
  }
  if (d.construction_type !== 'demolition') need('occupancy', 'Choose the occupancy (how the building will be used).');
  if (d.occupancy === 'commercial') need('occupancy_commercial', 'Describe the commercial use.');
  if (!(Number(d.valuation) > 0)) add('error', 'valuation', 'Enter the total contract price or valuation of the work.');

  const w = Number(d.width); const l = Number(d.length); const st = Number(d.stories) || 1;
  if (w > 0 && l > 0 && Number(d.area_under_roof) > 0) {
    const calc = w * l * st;
    if (Math.abs(calc - d.area_under_roof) / calc > 0.35) add('warning', 'area_under_roof', `Area under roof (${d.area_under_roof} sq ft) is far from width × length × stories (${Math.round(calc)} sq ft). Check the dimensions.`);
  }
  if (Number(d.area_heated) > Number(d.area_total) && Number(d.area_total) > 0) add('warning', 'area_heated', 'Heated area is larger than the total area.');
  const area = Number(d.area_total) || Number(d.area_under_roof) || 0;
  if (build && area > 0 && Number(d.valuation) > 0 && Number(d.valuation) / area < 10) {
    add('warning', 'valuation', `A valuation of $${Number(d.valuation).toLocaleString()} for ${area.toLocaleString()} sq ft is unusually low. City Hall may adjust the valuation used for the fee.`);
  }
  if (build && (!has(d.setback_front) || !has(d.setback_side) || !has(d.setback_rear))) add('warning', 'setback_front', 'Add the front, side and rear setbacks so the zoning review can start right away.');
  if (!has(d.zoning) || d.zoning === 'unknown') add('info', 'zoning', 'Zoning district not given. The Land Code Administrator will confirm it.');
  if (!has(d.parcel_number)) add('warning', 'parcel_number', "Add the tax parcel number if you have it. Otherwise City Hall looks it up, which can slow the review.");
  if (!has(d.design_pro)) add('warning', 'design_pro', 'Say whether an architect, engineer or designer prepared the plans (or "Not applicable").');

  if (!kinds.has('ownership_proof')) {
    if (d.bring_ownership_proof) add('warning', 'files', 'Proof of ownership will be brought to City Hall. Review starts once it is received.');
    else add('error', 'files', 'Attach proof of ownership (deed or tax parcel card), or check that you will bring it to City Hall.');
  }
  if (build && !kinds.has('site_plan')) add('warning', 'files', 'Attach a site plan showing the building and its distance to each property line. Plans are required for most new buildings and additions.');

  if (d.work_started) add('warning', 'work_started', 'Work has already started, so the published fee schedule doubles the permit fee.');
  if (build && area > 0 && area < 200 && st <= 1 && ['storage', 'garage'].includes(d.occupancy)) {
    add('info', 'construction_type', 'One-story accessory buildings under 200 sq ft may be exempt from a construction permit under the Land Development Code. City Hall will confirm, and floodplain rules can still apply.');
  }

  const sc = ctx.screen;
  if (sc?.jurisdiction?.checked && sc.jurisdiction.inCity === false) {
    add('warning', 'job_address', `The U.S. Census geocoder places this address ${sc.jurisdiction.place ? `in ${sc.jurisdiction.place}` : 'outside city limits'}${sc.jurisdiction.county ? `, ${sc.jurisdiction.county}` : ''}. If it is outside city limits, the county issues the permit.`);
  }
  if (sc?.flood?.checked && sc.flood.sfha) {
    add('warning', 'job_address', `FEMA maps show this property in flood zone ${sc.flood.zone}. A floodplain development permit and elevation information will likely be required.`);
  }

  need('hazmat_ack', 'Accept the hazardous materials certification.');
  need('certify', "Accept the applicant's certification.");
  need('signature_name', 'Type your full name to sign.');
  return out;
}

// Share of the application that is filled in, for progress bars.
export function progress(d, files = []) {
  const keys = Object.values(FIELDS).filter((x) => matches(x.when, d) && !['project_name', 'planned_work_other', 'bring_ownership_proof', 'construction_type_other', 'owner_cell', 'contractor_cell', 'area_accessory', 'area_heated'].includes(x.key));
  const filled = keys.filter((x) => (x.key === 'files' ? files.length > 0 : has(d[x.key]))).length;
  return Math.round((filled / keys.length) * 100);
}

/* ---------------- The guided conversation ---------------- */

const yes = [['yes', 'Yes'], ['no', 'No']];

// Questions in order. Each is skipped once its fields are answered (or it doesn't apply).
export const ASKS = [
  { id: 'project', fields: ['description'], prompt: 'Tell me about your project. What are you building or changing? Size and use help, like "a 24 by 30 foot detached garage".' },
  { id: 'construction_type', fields: ['construction_type'], prompt: 'What type of work is it?', choices: CONSTRUCTION_TYPES },
  { id: 'job_address', fields: ['job_address'], prompt: "What's the street address of the property where the work will be done?" },
  { id: 'parcel_number', fields: ['parcel_number'], optional: true, prompt: "Do you know the tax parcel number? It's on the property tax bill. If not, tap \"I don't know\" and City Hall will look it up.", choices: [['__skip', "I don't know"]] },
  { id: 'work_started', fields: ['work_started'], prompt: 'Has any of the work already started?', choices: yes },
  { id: 'applicant_role', fields: ['applicant_role'], prompt: 'Are you the property owner?', choices: [['owner', "Yes, I'm the owner"], ['contractor', "I'm the contractor"], ['other', "I'm applying for the owner"]] },
  { id: 'applicant', when: { applicant_role: 'other' }, fields: ['applicant_name', 'applicant_phone'], prompt: "What's your name, and a phone number or email where City Hall can reach you?" },
  { id: 'owner_name', fields: ['owner_name'], prompt: (d) => (d.applicant_role === 'owner' ? "What's your full name, as it appears on the deed?" : "What's the property owner's full name, as it appears on the deed?") },
  { id: 'owner_same_mailing', fields: ['owner_same_mailing'], prompt: (d) => `Is the owner's mailing address the same as the job address${d.job_address ? ` (${d.job_address})` : ''}?`, choices: yes },
  { id: 'owner_mailing', when: { owner_same_mailing: false }, fields: ['owner_address', 'owner_city', 'owner_state', 'owner_zip'], prompt: "What's the owner's mailing address, including city, state and ZIP?" },
  { id: 'owner_contact', fields: ['owner_phone'], alt: ['owner_cell', 'owner_email'], prompt: (d) => (d.applicant_role === 'owner' ? "What's the best phone number and email for you?" : "What's the owner's phone number and email?") },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates about this application?', choices: [['email', 'Email'], ['sms', 'Text message'], ['call', 'Phone call']] },
  { id: 'builder', fields: ['builder'], prompt: 'Will a licensed contractor do the work, or will the owner do it as an owner-builder?', choices: [['contractor', 'Licensed contractor'], ['owner', 'Owner-builder']] },
  { id: 'contractor', when: { builder: 'contractor' }, fields: ['contractor_name'], prompt: "What's the contractor's company name and Mississippi Certificate of Responsibility (COR) number?" },
  { id: 'contractor_contact', when: { builder: 'contractor' }, fields: ['contractor_phone'], alt: ['contractor_cell', 'contractor_email'], prompt: "What's the contractor's phone, email and mailing address?" },
  { id: 'owner_exemption', when: { builder: 'owner' }, fields: ['owner_exemption'], prompt: 'Mississippi requires a licensed contractor unless the owner meets one of these exceptions. Which one applies?', choices: EXEMPTIONS },
  { id: 'owner_ack', when: { builder: 'owner' }, fields: ['owner_ack'], prompt: "As an owner-builder you may be financially responsible for injuries to workers, for withholding taxes, and for structural defects for years after construction, and the Building Official can require a licensed contractor if the work isn't up to code. Do you accept these responsibilities?", choices: [['yes', 'I accept'], ['no', "I'll use a contractor"]] },
  { id: 'size', when: { construction_type: BUILDS }, fields: ['stories', 'width', 'length'], prompt: 'How big will it be? Give the number of stories, the width and length, and the height in feet.' },
  { id: 'occupancy', when: { construction_type: { not: 'demolition' } }, fields: ['occupancy'], prompt: 'How will the building be used?', choices: OCCUPANCY },
  { id: 'area', when: { construction_type: BUILDS }, fields: ['area_heated'], prompt: (d) => `${d.area_under_roof ? `That's about ${Number(d.area_under_roof).toLocaleString()} sq ft under roof. ` : ''}How much of it will be heated or cooled, in square feet?`, choices: [['0', 'None']] },
  { id: 'zoning', fields: ['zoning'], prompt: 'Do you know the zoning district? If not, choose "Not sure" and the Land Code Administrator will confirm it.', choices: ZONING },
  { id: 'setbacks', when: { construction_type: BUILDS }, fields: ['setback_front', 'setback_side', 'setback_rear'], prompt: 'How far will the building be from the front, side and rear property lines, in feet?' },
  { id: 'design_pro', fields: ['design_pro'], prompt: 'Did an architect, engineer or designer prepare the plans?', choices: [['architect', 'Architect'], ['engineer', 'Engineer'], ['designer', 'Designer'], ['none', 'Not applicable']] },
  { id: 'design_detail', when: { design_pro: ['architect', 'engineer', 'designer'] }, fields: ['dp_firm'], prompt: "What's the firm, the named principal, license number, and their phone or email?" },
  { id: 'valuation', fields: ['valuation'], prompt: "What's the total contract price, or the estimated value of the work including materials and labor?" },
  { id: 'ownership_proof', fields: [], upload: ['ownership_proof'], done: (d, files) => files.some((x) => x.kind === 'ownership_proof') || !!d.bring_ownership_proof,
    prompt: 'Please upload proof of ownership: a deed or the tax parcel card. A phone photo is fine.', choices: [['__bring', "I'll bring it to City Hall"]] },
  { id: 'plans', when: { construction_type: BUILDS }, fields: [], upload: ['site_plan', 'floor_plan', 'foundation', 'structural', 'electrical', 'plumbing', 'mechanical', 'other'],
    done: (d, files, asked) => files.some((x) => x.kind !== 'ownership_proof') || asked.includes('plans'),
    prompt: 'Now your plans. At minimum, a site plan showing the building and its distance to each property line. Add floor, foundation or other plans if you have them.', choices: [['__skip', "I'll add plans later"]] },
  { id: 'hazmat_ack', fields: ['hazmat_ack'], prompt: 'If there is lead, asbestos or other hazardous material on the site, will you follow MDEQ rules to remove it properly?', choices: [['yes', 'Yes, I agree']] },
  { id: 'sign', fields: ['certify', 'signature_name'], prompt: 'Last step. Review the application on the right, then type your full name to sign it. By signing you certify the information is true and correct and that you are the owner or authorized to act for the owner.' },
];

// The next question to ask, given what's answered. `asked` lists optional asks already shown.
export function nextAsk(d, files = [], asked = []) {
  for (const a of ASKS) {
    if (!matches(a.when, d)) continue;
    if (a.done ? a.done(d, files, asked) : a.fields.every((k) => has(d[k])) || (a.alt || []).some((k) => has(d[k]))) continue;
    if (a.optional && asked.includes(a.id)) continue;
    return a;
  }
  return null;
}

export function askView(a, d) {
  if (!a) return null;
  return { id: a.id, prompt: typeof a.prompt === 'function' ? a.prompt(d) : a.prompt, fields: a.fields, choices: a.choices || null, upload: a.upload || null };
}

// What the browser needs to draw the form. Functions stay on the server.
export function publicSchema() {
  return { kind: KIND, title: TITLE, sections: SECTIONS, docKinds: DOC_KINDS };
}
