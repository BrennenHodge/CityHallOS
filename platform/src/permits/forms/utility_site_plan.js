// The utility site plan review application (City of Wiggins form, revised 6/07/2022). Utility companies and their
// contractors file it before boring, trenching, cutting a road or building a utility structure (a pump station, a cell
// tower) in the city. The Land Code Administrator reviews the plans and issues a site plan approval.
import { CONTACT_PREF, YES_NO, ZONES_UNSURE, defineForm, f, party } from '../engine.js';

export const UTILITY_WORK = [['boring', 'Underground boring'], ['trenching', 'Open trenching'], ['surface', 'Surface structures (buildings)'], ['road_cuts', 'Road cuts'],
  ['manholes', 'Manholes, handholes, etc.'], ['pump_station', 'Pump station'], ['cell_tower', 'Cell tower'], ['other', 'Other']];
export const DOC_KINDS = [['plans', 'Construction plans with location map'], ['location_map', 'Location map'], ['mdot_permit', 'MDOT permit'],
  ['other_permit', 'Other required permit'], ['other', 'Other document']];
const PLAN_KINDS = ['plans', 'location_map'];
const PERMIT_KINDS = ['mdot_permit', 'other_permit'];

// Road cuts and work in a state highway right-of-way usually come with an MDOT or other permit to attach.
const needsPermitCopy = (d) => (d.construction_types || []).includes('road_cuts') || d.state_row === true;

const SECTIONS = [
  { id: 'project', title: 'Project', fields: [
    f('construction_types', 'Construction type (check all that apply)', 'multi', { options: UTILITY_WORK, required: 'Choose the type of construction.',
      explain: 'Underground boring runs a line under the ground (and under driveways or streets) without digging a trench. Open trenching digs a trench and lays the line in it. A road cut is cutting into the pavement of a street. Handholes and manholes are the access boxes and vaults along a line.' }),
    f('construction_other', 'Other construction', 'text', { when: { construction_types: { has: 'other' } }, required: 'Describe the other type of construction.' }),
    f('description', 'What will be constructed?', 'longtext', { placeholder: 'e.g. 1,200 ft of 2-inch PE gas main with two service taps', required: 'Describe what will be constructed.' }),
    f('utility_location', 'Location of the utility in detail', 'longtext', { placeholder: 'e.g. North side of Pine St, 5 ft behind the curb, 4-inch PVC conduit, 36 in deep, bored under driveways',
      required: 'Describe where the utility will go: side of street, type and depth.',
      explain: 'Say exactly where the line or structure goes so the city can check it against streets, other utilities and property lines: which side of the street, how far from the curb or property line, what it is (fiber, gas main, power conduit, water line) and its size, how deep it will be, and where it starts and ends.' }),
    f('state_row', 'Is any of the work in a state highway right-of-way?', 'bool', { help: 'For example along U.S. Highway 49 or Highway 26.',
      explain: 'A right-of-way is the strip of public land along a road, including the shoulders and ditches. Along state highways like U.S. 49 and Highway 26 it belongs to the Mississippi Department of Transportation (MDOT), which issues its own permit for utility work there.' }),
    f('existing_structures', 'Existing buildings and structures on the site', 'longtext', { placeholder: 'e.g. None, public right-of-way only. Or: one-story office building and a gravel parking lot',
      required: 'List the buildings and structures on the site now, or say "none".' }),
    f('project_cost', 'Estimated total project cost', 'money', { required: 'Enter the estimated total project cost. The city requires it.' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('property_address', 'Address of subject property', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address of the property.',
      help: 'For work along a street, give the nearest street address and describe the full route under "Location of the utility".' }),
    f('zoning', 'Zoning district', 'select', { options: ZONES_UNSURE, explain: 'Every lot in Wiggins is in a zoning district (R-1 is single-family residential, C-2 is general commercial, and so on). If you don\'t know it, choose "Not sure" and the Land Code Administrator will confirm it.' }),
  ] },
  { id: 'utility', title: 'Utility company', fields: [
    ...party('utility', 'Utility company', { required: true, reach: true }),
    f('utility_contact', 'Contact person at the utility company', 'text', { optional: true }),
  ] },
  { id: 'applicant', title: 'Applicant', fields: [
    f('applicant_role', 'Who is filling out this application?', 'select', { options: [['utility', 'I work for the utility company'], ['other', 'A contractor or consultant for it']], required: 'Tell us who is filling out the application.' }),
    ...party('applicant', 'Applicant (if other than the utility company)', { when: { applicant_role: 'other' }, required: true, reach: true }),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'documents', title: 'Documents', fields: [
    f('files', 'Attachments', 'files', { kinds: DOC_KINDS, help: 'Construction plans with a location map, and copies of all MDOT or other required permits.' }),
    f('bring_plans', "I'll bring the construction plans to City Hall instead", 'check'),
  ] },
];

const ASKS = [
  { id: 'construction_types', fields: ['construction_types'], ai: true, prompt: 'What kind of work is it? Tell me everything that applies, like boring, trenching or a road cut.', choices: UTILITY_WORK },
  { id: 'construction_other', when: { construction_types: { has: 'other' } }, fields: ['construction_other'], prompt: 'What other kind of construction is it?' },
  { id: 'description', fields: ['description'], ai: true, prompt: 'What will be constructed? For example, "1,200 feet of 2-inch gas main" or "a 150-foot monopole cell tower with an equipment shelter".' },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the address of the property? For work along a street, give the nearest street address. You can describe the full route next." },
  { id: 'utility_location', fields: ['utility_location'], ai: true, prompt: 'Describe where the utility will go: which side of the street, what type it is, and how deep. For example, "north side of Pine St, 4-inch PVC conduit, 36 inches deep, bored under the driveways".' },
  { id: 'state_row', fields: ['state_row'], prompt: 'Is any of the work in a state highway right-of-way, like along Highway 49 or Highway 26?', choices: YES_NO },
  { id: 'existing_structures', fields: ['existing_structures'], prompt: 'What buildings or structures are on the site now? Say "none" if it\'s open land or right-of-way.' },
  { id: 'zoning', fields: ['zoning'], prompt: 'Do you know the zoning district? If not, choose "Not sure" and the Land Code Administrator will confirm it.', choices: ZONES_UNSURE },
  { id: 'project_cost', fields: ['project_cost'], prompt: "What's the estimated total cost of the project?" },
  { id: 'applicant_role', fields: ['applicant_role'], prompt: 'Do you work for the utility company, or are you a contractor or consultant for it?', choices: [['utility', 'I work for the utility'], ['other', "I'm a contractor or consultant"]] },
  { id: 'utility_name', fields: ['utility_name'], prompt: (d) => (d.applicant_role === 'utility' ? 'Which utility company do you work for?' : 'Which utility company is the work for?') },
  { id: 'utility_mailing', fields: ['utility_address', 'utility_city', 'utility_state', 'utility_zip'], ai: true, prompt: "What's the utility company's mailing address, including city, state and ZIP?" },
  { id: 'utility_contact', fields: ['utility_phone'], alt: ['utility_cell', 'utility_email'], ai: true,
    prompt: (d) => (d.applicant_role === 'utility' ? "What's your name, phone number and email, so City Hall can reach you?" : "What's the utility company's phone number and email? Add a contact person's name if you have one.") },
  { id: 'applicant', when: { applicant_role: 'other' }, fields: ['applicant_name', 'applicant_phone'], alt: ['applicant_email'], ai: true, prompt: "What's your name or company, and a phone number or email where City Hall can reach you?" },
  { id: 'applicant_mailing', when: { applicant_role: 'other' }, fields: ['applicant_address', 'applicant_city', 'applicant_state', 'applicant_zip'], ai: true, prompt: "What's your mailing address, including city, state and ZIP?" },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates?', choices: CONTACT_PREF },
  // bring: the field the "I'll bring it" button sets.
  { id: 'plans', fields: [], upload: PLAN_KINDS, bring: 'bring_plans', done: (d, files) => files.some((x) => PLAN_KINDS.includes(x.kind)) || !!d.bring_plans,
    prompt: 'Please upload the construction plans with a location map. A PDF is best.', choices: [['__bring', "I'll bring them to City Hall"]] },
  { id: 'permits', fields: [], upload: PERMIT_KINDS, optional: true, done: (d, files, asked) => !needsPermitCopy(d) || files.some((x) => PERMIT_KINDS.includes(x.kind)) || asked.includes('permits'),
    prompt: (d) => `${d.state_row ? 'Work in a state highway right-of-way' : 'Road cuts'} usually need an MDOT or other permit. Please upload a copy of each permit you have.`, choices: [['__skip', "I'll send them later"]] },
];

// The applicant if a contractor or consultant is applying, otherwise the utility company.
function contact(d) {
  const pick = (name, email, phone) => ({ name: name || null, email: email || null, phone: phone || null });
  const c = d.applicant_role === 'other' ? pick(d.applicant_name, d.applicant_email, d.applicant_cell || d.applicant_phone)
    : pick(d.utility_contact || d.utility_name, d.utility_email, d.utility_cell || d.utility_phone);
  return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
}

function fee(d, cfg) {
  const amount = cfg?.fees?.flat ?? 250;
  return {
    total: amount, lines: [{ label: cfg?.fees?.label || 'Site plan review', amount }],
    notes: cfg?.fees?.notes || ['The published fee is doubled if construction has already started.'], source: cfg?.fees?.source || null,
  };
}

function check(d, ctx, { add }) {
  const kinds = new Set((ctx.files || []).map((x) => x.kind));
  if (!PLAN_KINDS.some((k) => kinds.has(k))) {
    if (d.bring_plans) add('warning', 'files', 'The construction plans will be brought to City Hall. Review starts once they are received.');
    else add('error', 'files', "Attach the construction plans with a location map, or check that you'll bring them to City Hall.");
  } else if (!kinds.has('plans')) {
    add('warning', 'files', 'Only a location map is attached. Attach the construction plans too.');
  }
  if (needsPermitCopy(d) && !PERMIT_KINDS.some((k) => kinds.has(k))) {
    add('warning', 'files', `${d.state_row ? 'Work in a state highway right-of-way' : 'Road cuts'} usually need an MDOT or other permit. Attach a copy, or City Hall will ask for it.`);
  }
  if (d.zoning === 'unknown' || !d.zoning) add('info', 'zoning', 'Zoning district not given. The Land Code Administrator will confirm it.');
  if ((d.construction_types || []).includes('cell_tower')) add('info', 'construction_types', 'Cell tower: check the zoning district rules for towers, which may need Planning Commission or Board of Aldermen approval.');
}

// Keyword reading of the construction types. The AI does this better; this keeps working without it.
function workTypes(text) {
  const t = text.toLowerCase();
  const out = [];
  if (/\bbor(e|ed|ing)\b|directional drill|\bhdd\b/.test(t)) out.push('boring');
  if (/\btrench\w*|open[- ]cut\b|\bdig\w*/.test(t)) out.push('trenching');
  if (/\b(surface structure|building|shelter|cabinet|substation)s?\b/.test(t)) out.push('surface');
  if (/\broad cut|street cut|cut(ting)? (the |into the )?(road|street|pavement)/.test(t)) out.push('road_cuts');
  if (/\b(man|hand)[- ]?holes?\b|\bvaults?\b|\bpull box/.test(t)) out.push('manholes');
  if (/\b(pump|lift) station\b/.test(t)) out.push('pump_station');
  if (/\bcell (phone )?tower|\bmonopole\b|\bcommunications? tower\b/.test(t)) out.push('cell_tower');
  if (/^other\b/.test(t)) out.push('other');
  return out.length ? { construction_types: out } : {};
}

const PHONES = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
const EMAIL_IN = /[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/i;

const parse = {
  construction_types: (t) => workTypes(t),
  description: (t) => ({ description: t.trim(), ...workTypes(t) }),
  utility_location: (t) => ({ utility_location: t.trim() }),
  // Phone and email, and whatever is left as the contact person's name.
  utility_contact: (t) => {
    const email = t.match(EMAIL_IN)?.[0]; const phones = t.match(PHONES) || [];
    const name = t.replace(EMAIL_IN, '').replace(PHONES, '').replace(/[,;]|\b(and|phone|cell|email|is|at|my name is|i'?m)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return { utility_email: email, utility_phone: phones[0], utility_cell: phones[1], utility_contact: /[a-z]{2,}/i.test(name) ? name : undefined };
  },
  plans: (t) => (/\bbring\b|\bdrop (them |it )?off\b|in person/i.test(t) ? { bring_plans: true } : {}),
};

const money = (v) => (v ? `$${Number(v).toLocaleString()}` : '');

export default defineForm({
  kind: 'utility_site_plan', title: 'Utility site plan review application', short: 'Utility site plan', code: 'US', icon: 'clipboard',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/299',
  intro: 'Utility companies and their contractors file this before boring, trenching, cutting a road or building a utility structure like a pump station or cell tower in Wiggins. The Land Code Administrator reviews the plans.',
  detect: /\butility site plan|\b(directional )?boring permit|\b(bor(e|ing)|trench\w*|road cut\w*|street cut\w*)\b.{0,40}\b(right[- ]of[- ]way|\bROW\b|street|road|highway|hwy)\b|\b(right[- ]of[- ]way)\b.{0,40}\b(bor(e|ing)|trench\w*)\b|\b(build|install|erect|put up|new|construct)\w*\b.{0,30}\bcell (phone )?tower|\bcell (phone )?tower\b.{0,40}\b(permit|site plan|approval|build|install|construct\w*)\b|\b(fiber|conduit|gas main|water main|sewer main|force main|duct bank|handholes?|manholes?|pump station|lift station)\b.{0,40}\b(install\w*|lay\w*|bur(y|ied)|bor(e|ing)|trench\w*|permit|site plan)\b/i,
  addressField: 'property_address', descriptionField: 'description',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, contact, fee, check, parse,
  fillable: ['project_cost', 'utility_location', 'existing_structures', 'zoning'],
  review: 'Compare the plans with the answers: the location map should show the same street and side, and the depth and type of the utility should match the description. For staff: conflicts with other utilities and drainage, MDOT permits for state highway right-of-way, and restoration of any road cuts.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is checking that it is complete'],
    fees_due: ['Complete · fee due', 'Review starts once the site plan review fee is paid'],
    in_review: ['Under review', 'The Land Code Administrator is reviewing the site plan'],
    issued: ['Site plan approved', 'Keep a copy of the approval at the job site'],
    denied: ['Not approved', 'Contact City Hall about changes to the plans'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Review'], ['issued', 'Approved']],
  issue: {
    noun: 'approval', title: 'SITE PLAN APPROVAL', numberLabel: 'Approval number', action: 'Approve site plan', post: true, inspections: null,
    after: 'Keep a copy of this approval at the job site. Work must follow the approved plans and any MDOT or other required permits. Changes to the location, depth or type of the utility need City Hall\'s approval first.',
    rows: (app, label) => {
      const d = app.data;
      return [
        ['Property', app.screen?.matchedAddress || d.property_address], ['Zoning', d.zoning && d.zoning !== 'unknown' ? d.zoning : ''],
        ['Construction', (d.construction_types || []).map((k) => (k === 'other' ? d.construction_other || 'Other' : label(UTILITY_WORK, k))).join(', ')],
        ['What will be constructed', d.description], ['Location', d.utility_location],
        ['Utility company', d.utility_name], ['Applicant', d.applicant_role === 'other' ? d.applicant_name : ''],
        ['Estimated cost', money(d.project_cost)],
      ];
    },
  },
  nextSteps: ['Planning & Building checks that the application and plans are complete.', "You'll be told the site plan review fee and how to pay it.",
    'The Land Code Administrator reviews the plans.', "When it's approved, you download the approval and keep a copy at the job site."],
  copyKeys: /^(utility_|applicant_|contact_pref)/,
});
