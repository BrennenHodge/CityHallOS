// The commercial certificate of occupancy application (City of Wiggins, revised 11/2021), with the city's list of
// typical CO inspection requirements (revised 1/29/2018) turned into questions: change of occupancy and the Life Safety
// Plan, other permits, flood zone, and a readiness checklist for the common safety items the inspector checks.
// Section B of the paper form (zoning, use, use classification, type of construction) is filled in by Planning & Building.
import { CONTACT_PREF, YES_NO, defineForm, f, has, ownerAsks, party, signFields } from '../engine.js';

// Occupancy groups from the 2003 International Building Code, Chapter 3, in plain words.
export const OCCUPANCY_GROUPS = [
  ['assembly', 'Assembly: people gather (church, event hall, gym, theater, larger restaurant or bar)'],
  ['business', 'Business: offices and services (office, salon, clinic, bank)'],
  ['mercantile', 'Retail store'],
  ['educational', 'Educational: school or daycare'],
  ['institutional', 'Institutional: care where people may not leave on their own (assisted living, nursing home, hospital)'],
  ['factory', 'Factory or workshop'],
  ['storage', 'Storage or warehouse'],
  ['residential', 'Residential: apartments, hotel or motel'],
  ['other', 'Other or not sure'],
];
// Changing to one of these needs a Life Safety Plan from a design professional (requirements page, section B.1).
const LIFE_SAFETY = ['assembly', 'educational', 'institutional'];

export const PERMITS = [
  ['privilege', 'Privilege license (business license)'], ['health', 'Health Department permit'], ['mdot', 'MDOT permit (state highway driveway)'],
  ['sign', 'Sign permit'], ['building', 'Building permit'], ['none', 'None of these yet'],
];

// The common safety and code items the inspector checks (requirements page, section A.4).
export const READY = [
  ['parking', 'Accessible (handicapped) parking'],
  ['entrance', 'At least one accessible entrance to all areas'],
  ['restroom', 'At least one accessible restroom'],
  ['restrooms_work', 'All restrooms work'],
  ['exits', 'Exit doors marked, with push or lever handles'],
  ['exit_lighting', 'Whole exit path well lit'],
  ['extinguisher', 'Fire extinguisher (at least 5 lb) inspected and tagged'],
  ['panels', 'Electrical panels clear: nothing stored, 36 in. open in front'],
  ['wiring', 'No exposed wiring; outlets and equipment covered'],
  ['gfci', 'GFCI outlets in bathrooms, kitchens, outdoors and wet areas'],
  ['trip', 'No tripping hazards'],
];
const SHORT = { parking: 'accessible parking', entrance: 'an accessible entrance', restroom: 'an accessible restroom', restrooms_work: 'working restrooms',
  exits: 'marked exits with push or lever handles', exit_lighting: 'exit path lighting', extinguisher: 'a tagged fire extinguisher', panels: 'clear electrical panels',
  wiring: 'covered wiring', gfci: 'GFCI outlets in wet areas', trip: 'no tripping hazards' };

export const DOC_KINDS = [['life_safety_plan', 'Life Safety Plan'], ['floor_plan', 'Floor plan'], ['other', 'Other document']];

const CHANGE = { change_of_use: true };
const NEEDS_PLAN = { change_of_use: true, new_occupancy: LIFE_SAFETY };

const SECTIONS = [
  { id: 'business', title: 'Business', fields: [
    f('business_name', 'Business name', 'text', { required: 'Enter the name of the business.' }),
    f('property_address', 'Building address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address of the building.' }),
    f('business_description', 'Brief description of business', 'longtext', { required: 'Briefly describe the business.', placeholder: 'e.g. Hair salon with 4 chairs, open Tuesday to Saturday' }),
    f('business_phone', 'Business telephone', 'phone', { half: true, optional: true }),
    f('floor_area', 'Approximate floor area (sq ft)', 'number', { half: true, required: 'Enter the approximate floor area of the business.', help: 'The space the business will use.' }),
    f('multi_tenant', 'Is this one unit in a multi-tenant building?', 'bool', { required: 'Tell us whether the business is one unit in a multi-tenant building.',
      help: 'Units under 2,000 sq ft in a multi-tenant building have a lower fee.' }),
    f('permit_number', 'Building permit number (if applicable)', 'text', { optional: true, help: 'If a building permit was issued for work on this space. Leave blank if not.' }),
  ] },
  { id: 'contact', title: 'Contact', fields: [
    f('applicant_name', 'Contact person', 'text', { required: 'Enter the name of the person City Hall should contact.' }),
    f('applicant_phone', 'Contact phone', 'phone', { half: true, reach: 'applicant' }),
    f('applicant_email', 'Email', 'email', { half: true, optional: true }),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'owner', title: 'Building owner', fields: party('owner', 'Building owner', { required: true, reach: true, help: 'The person or company that owns the building. Can be the business.' }) },
  { id: 'use', title: 'Use of the building', fields: [
    f('change_of_use', 'Is the business changing how the building is used?', 'bool', { required: 'Tell us whether the business changes how the building is used.',
      explain: 'The building code (2003 International Building Code, Chapter 3) sorts buildings by occupancy: how they are used, like a store, an office, a restaurant or church, a school, or a warehouse. If the space is changing from one kind of use to another (for example a store becoming a restaurant, or a house becoming an office), it generally has to meet the code for the new use. Changing to an assembly, educational or institutional use needs a Life Safety Plan from a design professional. Planning & Building can allow less when the new use is much less hazardous.' }),
    f('previous_use', 'How was the space used before?', 'text', { when: CHANGE, optional: true, placeholder: 'e.g. Retail store' }),
    f('new_occupancy', 'New use', 'select', { when: CHANGE, options: OCCUPANCY_GROUPS, required: 'Choose which best describes the new use.' }),
  ] },
  { id: 'ready', title: 'Ready for inspection', fields: [
    f('work_complete', 'Is all construction and renovation finished?', 'bool', { required: 'Tell us whether all construction and renovation is finished.', help: 'Choose yes if no work was needed. The inspection is scheduled once work is done.' }),
    f('already_open', 'Is the business already open at this location?', 'bool', { required: 'Tell us whether the business is already open here.', help: 'The fee is doubled when a business opens before the certificate is issued.' }),
    f('permits_have', 'Other permits you already have', 'multi', { options: PERMITS, required: 'Tell us which other permits you already have, or choose "None of these yet".',
      explain: 'Before a certificate of occupancy is issued, City Hall checks that the other permits the business needs are in place. A privilege license is the city business license. A Health Department permit is needed for food service and some other businesses. An MDOT permit is needed for a driveway onto a state highway. A sign permit is needed for any new sign. Not every business needs all of these.' }),
    f('ready_checks', "Safety items I've checked", 'multi', { options: READY, optional: true,
      explain: 'These are the common safety and code items the inspector checks. Fire extinguishers: at least one 5 lb extinguisher, inspected and tagged (a 3-A:40-BC is typical for insurance), and enough of the right type in the right places. Electrical panels: nothing stored in front, with 18 in. clear on both sides and 36 in. in front. All visible wiring in conduit. GFCI outlets in every bathroom and kitchen, outdoors, and anywhere that can get wet. Most buildings need two restrooms.' }),
  ] },
  { id: 'documents', title: 'Documents', fields: [
    f('files', 'Attachments', 'files', { kinds: DOC_KINDS }),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: signFields({
    certify: 'I certify that the information on this application is true and correct, and that the building will be ready for inspection when I ask City Hall to schedule it.',
  }) },
];

const [, , , ownerMailing] = ownerAsks();

const ASKS = [
  { id: 'business_name', fields: ['business_name'], prompt: "What's the name of the business?" },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the address of the building where the business will be?" },
  { id: 'business_description', fields: ['business_description'], ai: true, prompt: 'In a sentence or two, what does the business do? For example: "a hair salon with 4 chairs" or "a sandwich shop with seating for 20".' },
  { id: 'floor_area', fields: ['floor_area'], prompt: 'About how many square feet is the business space?' },
  { id: 'multi_tenant', fields: ['multi_tenant'], prompt: 'Is the business one unit in a building with other tenants, like a strip center?', choices: YES_NO },
  { id: 'change_of_use', fields: ['change_of_use'], prompt: 'Is the space changing to a different kind of use? For example, a store becoming a restaurant or church, or a house becoming an office.',
    choices: [['yes', 'Yes, a different use'], ['no', 'No, the same kind of use']] },
  { id: 'previous_use', when: CHANGE, fields: ['previous_use'], optional: true, prompt: 'What was the space used for before?', choices: [['__skip', "I don't know"]] },
  { id: 'new_occupancy', when: CHANGE, fields: ['new_occupancy'], prompt: 'Which best describes the new use?', choices: OCCUPANCY_GROUPS },
  { id: 'life_safety_plan', when: NEEDS_PLAN, fields: [], upload: ['life_safety_plan'], done: (d, files, asked) => files.some((x) => x.kind === 'life_safety_plan') || asked.includes('life_safety_plan'),
    prompt: 'Changing to this kind of use needs a Life Safety Plan prepared by an architect or engineer, and Planning & Building must approve it before the certificate is issued. Please upload it. If you don\'t have it yet, you can add it later.',
    choices: [['__skip', "I'll add it later"]] },
  { id: 'permit_number', fields: ['permit_number'], optional: true, prompt: 'Was a building permit issued for work on this space? If so, what\'s the permit number?', choices: [['__skip', 'No building permit']] },
  { id: 'work_complete', fields: ['work_complete'], prompt: 'Is all construction and renovation finished?', choices: [['yes', 'Yes, or no work was needed'], ['no', 'Not yet']] },
  { id: 'already_open', fields: ['already_open'], prompt: 'Is the business already open at this location?', choices: YES_NO },
  { id: 'permits_have', fields: ['permits_have'], prompt: 'Which of these does the business already have? Tap one, or type all that apply.', choices: PERMITS },
  { id: 'applicant', fields: ['applicant_name', 'applicant_phone'], alt: ['applicant_email'], ai: true, done: (d) => has(d.applicant_name) && (has(d.applicant_phone) || has(d.applicant_email)),
    prompt: 'Who should City Hall contact about this? Give a name, phone number and email.' },
  { id: 'business_phone', fields: ['business_phone'], optional: true, prompt: "What's the business phone number?", choices: [['__skip', 'Same as mine, or none yet']] },
  { id: 'owner_name', fields: ['owner_name'], prompt: 'Who owns the building? Give the full name of the person or company.' },
  { ...ownerMailing, prompt: "What's the building owner's mailing address, including city, state and ZIP?" },
  { id: 'owner_contact', fields: ['owner_phone'], alt: ['owner_cell', 'owner_email'], ai: true, prompt: "What's the building owner's phone number?" },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates, like when to expect the inspection?', choices: CONTACT_PREF },
  { id: 'ready_checks', fields: ['ready_checks'], optional: true,
    prompt: 'The inspector checks common safety items: accessible parking, entrance and restroom, working restrooms, marked exits with push or lever handles, exit lighting, a tagged fire extinguisher (at least 5 lb), clear electrical panels, covered wiring, GFCI outlets in wet areas, and no tripping hazards. Are all of these ready? You can also check them off one by one on the form.',
    choices: [['__all', 'Yes, all are ready'], ['__skip', 'Not all yet']] },
  { id: 'sign', fields: ['certify', 'signature_name'], prompt: 'Last step. Review the application, then type your full name to sign it. By signing you certify the information is true and correct and the building will be ready for inspection when you ask for it.' },
];

// The business contact is who City Hall reaches.
function contact(d) {
  const c = { name: d.applicant_name || d.business_name || null, email: d.applicant_email || null, phone: d.applicant_phone || d.business_phone || null };
  return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
}

// Published fee: $100; $50 for a unit under 2,000 sq ft in a multi-tenant building. Doubled if already open.
function fee(d, cfg) {
  const fees = cfg?.fees || {};
  const maxSmall = fees.smallMaxSqFt ?? 2000;
  const area = Number(d.floor_area) || 0;
  const small = d.multi_tenant === true && area > 0 && area < maxSmall;
  const base = small ? fees.multiTenantSmall ?? 50 : fees.flat ?? 100;
  const lines = [{ label: small ? `Commercial certificate of occupancy, multi-tenant unit under ${maxSmall.toLocaleString()} sq ft` : 'Commercial certificate of occupancy', amount: base }];
  const doubled = d.already_open === true && fees.doubleIfStarted !== false;
  if (doubled) lines.push({ label: 'Doubled because the business is already open', amount: base });
  const notes = ['City Hall confirms the fee when it reviews the application.'];
  if (d.multi_tenant === true && !(area > 0)) notes.unshift(`If the unit is under ${maxSmall.toLocaleString()} sq ft, the fee is $${fees.multiTenantSmall ?? 50}.`);
  return { total: doubled ? base * 2 : base, lines, notes: [...notes, ...(fees.notes || [])], source: fees.source || null };
}

function check(d, ctx, { add }) {
  const kinds = new Set((ctx.files || []).map((x) => x.kind));
  if (d.change_of_use && LIFE_SAFETY.includes(d.new_occupancy) && !kinds.has('life_safety_plan')) {
    add('warning', 'files', 'Changing to an assembly, educational or institutional use needs a complete Life Safety Plan prepared by a design professional. Planning & Building must approve it before the certificate is issued. Upload it when you have it.');
  }
  if (d.change_of_use) add('info', 'change_of_use', 'When a building changes occupancy it generally must meet the 2003 IBC requirements for the new use. Planning & Building may allow less if the new use is much less hazardous.');
  if (d.work_complete === false) add('warning', 'work_complete', 'The inspection can only be scheduled once all construction and renovation is finished. You can submit now, then call Planning & Building when the work is done.');
  if (d.already_open) add('warning', 'already_open', 'The business is already open here, so the published fee schedule doubles the fee.');

  const permits = d.permits_have || [];
  if (permits.includes('none') && permits.length > 1) add('error', 'permits_have', 'You chose "None of these yet" and also listed permits. Choose one or the other.');
  const missing = PERMITS.filter(([k]) => !['none', 'building'].includes(k) && !permits.includes(k)).map(([, l]) => l.replace(/ \(.*\)$/, ''));
  if (has(permits) && missing.length) add('info', 'permits_have', `City Hall will check that the other permits this business needs are in place. Not listed yet: ${missing.join(', ')}. Not every business needs all of them.`);

  const checked = d.ready_checks || [];
  const open = READY.filter(([k]) => !checked.includes(k)).map(([k]) => SHORT[k]);
  if (open.length === READY.length) add('info', 'ready_checks', 'The inspector will check the common safety items on the list (accessible parking and restrooms, exits, fire extinguisher, electrical). Check them off as you get them ready.');
  else if (open.length) add('warning', 'ready_checks', `The inspector will check these items you haven't checked off yet: ${open.join(', ')}. Get them ready before the inspection.`);

  if (!has(d.permit_number)) add('info', 'permit_number', 'No building permit number given. If work was done on this space, City Hall will look up the permit.');
  const sc = ctx.screen;
  if (sc?.flood?.checked && sc.flood.sfha) {
    add('warning', 'property_address', `FEMA maps show this property in flood zone ${sc.flood.zone}. Planning & Building checks the flood zone first, and floodplain requirements may apply before a certificate is issued.`);
  }
}

// Reading answers the generic reader can't place.
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PERMIT_WORDS = { privilege: /privilege|business licen[cs]e/i, health: /health/i, mdot: /\bmdot\b|highway|driveway|transportation/i, sign: /\bsign\b/i, building: /building|construction/i };
const READY_WORDS = { parking: /parking/i, entrance: /entrance|entry|ramp/i, restroom: /accessible (rest|bath)room|ada (rest|bath)room|handicap\w* (rest|bath)room/i, restrooms_work: /restrooms? work|working (rest|bath)rooms?|toilets?/i,
  exits: /exit (doors?|signs?)|marked|lever|push/i, exit_lighting: /light/i, extinguisher: /extinguisher/i, panels: /panel/i, wiring: /wir(e|ing)|conduit|cover/i, gfci: /gfci|gfi/i, trip: /trip/i };
const pickMany = (words, t) => Object.entries(words).filter(([, re]) => re.test(t)).map(([k]) => k);

const parse = {
  permits_have: (t) => {
    if (/\b(none|no(ne)? of (them|these)|nothing|not yet|don'?t have any)\b/i.test(t) && !/\bbut\b/i.test(t)) return { permits_have: ['none'] };
    const v = pickMany(PERMIT_WORDS, t);
    return v.length ? { permits_have: v } : {};
  },
  // "Yes, all are ready", "all but the GFCI outlets", or a list of the items that are ready. "Not all yet" is no answer.
  ready_checks: (t) => {
    if (/^\s*(no|nope)\b|\bnot (all|every|yet|really|sure)\b/i.test(t)) return {};
    const named = pickMany(READY_WORDS, t);
    if (/\b(all|every|everything|yes)\b/i.test(t)) {
      const except = /\b(but|except|other than|besides|not)\b/i.test(t) ? named : [];
      return { ready_checks: READY.map(([k]) => k).filter((k) => !except.includes(k)) };
    }
    return named.length ? { ready_checks: named } : {};
  },
  applicant: (t) => {
    const out = {};
    const e = t.match(EMAIL); if (e) out.applicant_email = e[0];
    const p = t.match(PHONE); if (p) out.applicant_phone = p[0];
    const name = t.replace(EMAIL, '').replace(PHONE, '').split(/[,;\n]/).map((x) => x.replace(/\b(and|my|number|phone|email|is)\b/gi, ' ').trim()).find(Boolean);
    if (name) out.applicant_name = name.replace(/^(it'?s|i'?m|me,?|my name is|this is|name:?)\s+/i, '').replace(/\s+/g, ' ').replace(/[.]$/, '');
    return out;
  },
};

const CO = '(?:certificate of occupancy|occupancy (?:certificate|permit)|c\\.?o\\.?(?=\\s|$|[,.?!]))';
const BUSINESS = '(?:business|store|shop|restaurant|cafe|salon|barber ?shop|office|commercial|church|daycare|day care|warehouse|tenant|suite|storefront|clinic|gym|bar)';

export default defineForm({
  kind: 'co_commercial', title: 'Commercial certificate of occupancy', short: 'Commercial CO', code: 'CC', icon: 'store',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/287',
  intro: 'A commercial certificate of occupancy is the city\'s OK to open a business in a building, after construction or a change of use. It is issued after the building passes an inspection.',
  detect: new RegExp(`\\b(?:commercial|business) ${CO}|\\b${CO}.{0,40}\\b${BUSINESS}\\b|\\b${BUSINESS}\\b.{0,40}\\b${CO}|\\b(?:open|opening|move|moving|relocat\\w*)\\b(?:\\s+[\\w']+){0,3}\\s+${BUSINESS}\\b|\\bnew ${BUSINESS} (?:location|space|building)\\b`, 'i'),
  addressField: 'property_address', descriptionField: 'business_description', nameField: 'business_name',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, contact, fee, check, parse,
  fillable: ['permit_number'],
  review: 'Compare the business description with the new use chosen, and any Life Safety Plan with that use. For staff: flood zone; other permits (privilege license, Health Department, MDOT, sign); conforming structure (Section 7.3, Table 3.5.2); use permitted per Table 3.2 (conditional use if required); parking per Table 5.3.3-1; screening (Sections 5.3.6 and 5.3.7); grease traps and backflow preventers (Section 5.3.9); and the inspection checklist.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is checking the application and setting the fee'],
    fees_due: ['Complete · fee due', 'Pay the fee at City Hall. The inspection is scheduled after that'],
    in_review: ['Inspection', 'Call Planning & Building to schedule the inspection once all construction and renovation is finished'],
    issued: ['Certificate issued', 'Post the certificate where customers can see it'], closed: ['Closed', 'This application is closed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Inspection'], ['issued', 'Certificate']],
  issue: {
    noun: 'certificate', title: 'CERTIFICATE OF OCCUPANCY', numberLabel: 'Certificate number', action: 'Issue certificate', post: true,
    after: 'Post the certificate of occupancy in a visible place in the business, such as near the main entrance. A new change of use or major renovation needs a new certificate.',
    inspections: ['Final / CO inspection'],
    rows: (app, label) => {
      const d = app.data;
      return [
        ['Business', d.business_name], ['Building address', app.screen?.matchedAddress || d.property_address], ['Description', d.business_description],
        ['Use', d.change_of_use ? `${label(OCCUPANCY_GROUPS, d.new_occupancy).replace(/:.*$/, '')} (change of use${d.previous_use ? ` from ${d.previous_use}` : ''})` : 'No change of use'],
        ['Floor area', d.floor_area ? `${Number(d.floor_area).toLocaleString()} sq ft${d.multi_tenant ? ' (unit in a multi-tenant building)' : ''}` : ''],
        ['Building owner', d.owner_name], ['Building permit', d.permit_number],
      ];
    },
  },
  nextSteps: ['Planning & Building checks that the application is complete and sets the fee.', "Pay the fee at City Hall. You'll be told the amount.",
    'When all construction and renovation is finished, call Planning & Building at (228) 385-2350 ext. 103 to schedule the inspection.',
    'Once the inspection passes, Planning & Building issues the certificate of occupancy. Post it where customers can see it.'],
  copyKeys: /^(applicant_|owner_|business_|contact_pref)/,
});
