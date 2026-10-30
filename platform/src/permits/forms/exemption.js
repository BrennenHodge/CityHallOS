// The construction permit exemption certification. The city has two PDFs, one for commercial and multi-family buildings
// (Oct 2018) and one for residential buildings (rev. 2009); this one form replaces both. The first answer (residential or
// commercial) decides which criteria apply and who signs. There is no fee.
import { CONTACT_PREF, YES_NO, defineForm, f, has, signFields } from '../engine.js';
import { EXEMPTIONS } from './construction.js';

export const PROPERTY_TYPES = [['residential', 'Residential (a house, duplex or mobile home)'], ['commercial', 'Commercial or multi-family (a business, church or apartment building)']];
export const BUILDERS = [['contractor', 'A licensed contractor'], ['owner', 'The owner']];
// The Mississippi State Board of Contractors exceptions that fit commercial work done by the owner.
const OWNER_EXCEPTIONS = EXEMPTIONS.filter(([k]) => ['commercial_own', 'under_50k'].includes(k));

const RES = { property_type: 'residential' };
const COM = { property_type: 'commercial' };
const GC = { builder: 'contractor' };

// The criteria, in the PDF's order. Every one must be true for the work to be exempt. `chat` is the short version the
// chat lists; `type` limits a criterion to one kind of property.
const CRITERIA = [
  { key: 'crit_repair_residential', type: 'residential', label: 'This is a repair or renovation to a residential structure',
    chat: "It's a repair or renovation of an existing home.",
    explain: 'The exemption only covers fixing up or updating a home that is already there, like new shingles, flooring, cabinets, paint or siding. Building something new, or adding on, needs a construction permit.' },
  { key: 'crit_repair_commercial', type: 'commercial', label: 'This is a repair or renovation to a commercial or multi-family residential structure',
    chat: "It's a repair or renovation of an existing commercial or apartment building.",
    explain: 'The exemption only covers fixing up or updating a commercial or apartment building that is already there, like new flooring, ceiling tiles, paint or a new roof covering. Building something new, or adding on, needs a construction permit.' },
  { key: 'crit_no_flood', label: 'No part of the work for this project is in a flood zone',
    chat: 'None of the work is in a flood zone.',
    explain: 'A flood zone is an area FEMA flood maps show as having a high chance of flooding. Work there is never exempt, because the city has to check it against floodplain rules. City Hall checks the address against the FEMA maps.' },
  { key: 'crit_no_enlarge', label: 'This project does not enlarge the envelope or footprint of the structure (minor increases due to the thickness of building materials are not considered an enlargement of the footprint)',
    chat: "The building doesn't get any bigger.",
    explain: "The envelope is the building's outside shell: walls, roof and foundation. The footprint is the ground it covers. The work can't add rooms, porches, decks or height. New siding or brick veneer that makes the walls a little thicker is fine." },
  { key: 'crit_same_use', label: 'The use and occupancy of the structure is not changed',
    chat: 'The building will be used the same way as before.',
    explain: 'Use and occupancy means what the building is used for: a home, a store, an office, storage and so on. Turning a garage into a bedroom, or a house into an office, changes the use and needs a construction permit.' },
  { key: 'crit_no_structural', label: 'No structural walls or members are removed or added',
    chat: 'No structural walls, beams or other structural parts are removed or added.',
    explain: 'Structural parts hold the building up: load-bearing walls, beams, columns, joists, rafters and trusses. Taking one out or adding one needs a construction permit. Replacing drywall, trim or a non-load-bearing wall covering does not count.' },
  { key: 'crit_no_plumbing', label: 'No plumbing fixtures are added',
    chat: 'No plumbing fixtures (sinks, toilets, tubs, showers) are added.',
    explain: 'A plumbing fixture is anything that uses water and drains: sinks, toilets, tubs, showers, water heaters. Swapping an old sink for a new one in the same spot is fine. Adding a new one is not.' },
  { key: 'crit_no_hvac', type: 'commercial', label: 'No HVAC units or additional ducting are added',
    chat: 'No heating or air conditioning units or new ductwork are added.',
    explain: 'HVAC means heating, ventilation and air conditioning. Adding a unit or running new ducts needs a construction permit. Servicing or replacing parts of the existing system does not count.' },
  { key: 'crit_no_electrical', label: 'No electrical circuits are added and the electrical load is not increased',
    chat: "No electrical circuits are added, and the electrical load doesn't go up.",
    explain: 'A circuit is a wire run from the breaker panel. Adding one, or adding something that draws more power (a bigger panel, a new appliance circuit), needs a construction permit. Replacing a light fixture or outlet on an existing circuit is fine.' },
  { key: 'crit_code', label: 'All work will comply with IBC 2003',
    chat: 'All work will meet the building code (IBC 2003).',
    explain: 'IBC 2003 is the 2003 International Building Code, the building code the City of Wiggins has adopted. Even work that doesn\'t need a permit has to be done to code.' },
];
const CRIT_KEYS = CRITERIA.map((c) => c.key);
const critsFor = (type) => CRITERIA.filter((c) => !c.type || c.type === type);

const NOT_EXEMPT = 'This work needs a construction permit instead of an exemption, because one or more of the exemption criteria isn\'t true. Type "construction permit" in the chat to start that application.';

const SECTIONS = [
  { id: 'project', title: 'Project', fields: [
    f('property_type', 'Type of property', 'select', { options: PROPERTY_TYPES, required: 'Tell us whether the property is residential or commercial.',
      explain: 'Residential means a house, duplex or mobile home. Commercial or multi-family means a business, church, school, or an apartment building with three or more units. The two have slightly different exemption rules.' }),
    f('property_address', 'Job address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address where the work will be done.' }),
    f('description', 'Job description', 'longtext', { placeholder: 'e.g. Replace roof shingles and felt on the existing house, same roof line', required: 'Describe the work you plan to do.' }),
  ] },
  { id: 'owner', title: 'Owner & contact', fields: [
    f('applicant_role', 'Who is filling out this certification?', 'select', { options: [['owner', 'The property owner'], ['contractor', 'The contractor']], required: 'Tell us who is filling out the certification.' }),
    f('owner_name', 'Property owner', 'text', { help: 'As shown on the deed or tax records.', required: "Enter the property owner's name." }),
    f('owner_phone', 'Owner phone', 'phone', { half: true, reach: 'owner' }),
    f('owner_cell', 'Owner cell', 'phone', { when: RES, half: true, optional: true }),
    f('owner_email', 'Owner email', 'email', { when: RES, optional: true }),
    f('owner_same_mailing', "Owner's mailing address is the job address", 'bool', { when: RES }),
    f('owner_address', 'Owner mailing address', 'text', { when: { ...RES, owner_same_mailing: false }, required: "Enter the owner's mailing address." }),
    f('owner_city', 'City', 'text', { when: { ...RES, owner_same_mailing: false }, half: true, required: 'Enter the city.' }),
    f('owner_state', 'State', 'state', { when: { ...RES, owner_same_mailing: false }, half: true, required: 'Enter the state.' }),
    f('owner_zip', 'ZIP', 'zip', { when: { ...RES, owner_same_mailing: false }, half: true, required: 'Enter the ZIP code.' }),
    f('contact_pref', 'How should City Hall reach you about this certification?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'builder', title: "Who's doing the work", fields: [
    f('builder', 'Who is doing the work?', 'select', { options: BUILDERS, required: 'Tell us who is doing the work.',
      explain: 'On commercial work, Mississippi requires a licensed contractor unless the owner qualifies for an exception from the State Board of Contractors. On a home, the owner can do the work.' }),
    f('contractor_name', 'Contractor', 'text', { when: GC, required: "Enter the contractor's name." }),
    f('contractor_license', 'MS #', 'text', { when: GC, half: true, help: "The contractor's Mississippi State Board of Contractors license number.",
      explain: 'The MS # is the license number the Mississippi State Board of Contractors gives a contractor. Your contractor can give it to you, and it is listed on the Board\'s website (msboc.us). It is required for commercial work.' }),
    f('contractor_address', 'Contractor mailing address', 'text', { when: GC, optional: true }),
    f('contractor_city', 'City', 'text', { when: GC, half: true, optional: true }),
    f('contractor_state', 'State', 'state', { when: GC, half: true, optional: true }),
    f('contractor_zip', 'ZIP', 'zip', { when: GC, half: true, optional: true }),
    f('contractor_phone', 'Contractor phone', 'phone', { when: GC, half: true }),
    f('contractor_cell', 'Contractor cell', 'phone', { when: GC, half: true, optional: true }),
    f('contractor_email', 'Contractor email', 'email', { when: GC, optional: true }),
    f('owner_exemption', 'Contractor license exception that applies', 'radio', { when: { ...COM, builder: 'owner' }, options: OWNER_EXCEPTIONS,
      required: 'Choose which contractor license exception applies, or use a licensed contractor.',
      explain: 'Mississippi requires a licensed contractor for commercial work, except when the owner does the work on their own property in one of these situations. If neither fits, a licensed contractor must do the work.' }),
  ] },
  { id: 'criteria', title: 'Criteria for exemption', fields: [
    ...CRITERIA.map((c) => f(c.key, c.label, 'check', { ...(c.type ? { when: { property_type: c.type } } : {}), required: `Confirm: ${c.label.replace(/ \(.*\)$/, '')}.`, explain: c.explain })),
    f('criteria_fail', "One or more of these isn't true for my project", 'check', { optional: true, help: 'Then the work needs a construction permit instead.' }),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: signFields({
    certify: 'I certify that the project identified above meets all of the required criteria and is therefore exempt from the requirement for a construction permit under Section 4.4.1 of the City of Wiggins Land Development Code.',
  }).map((x) => (x.key === 'signature_name' ? { ...x, help: 'Commercial work: the contractor signs. Residential work: the owner or the contractor signs.' } : x)) },
];

const criteriaPrompt = (d) => {
  const list = critsFor(d.property_type).map((c, i) => `${i + 1}. ${c.chat}`).join('\n');
  return `To skip the construction permit, **every one** of these has to be true:\n\n${list}\n\nAre all of them true for your project?`;
};

const ASKS = [
  { id: 'property_type', fields: ['property_type'], prompt: 'Is the property a home, or a commercial or multi-family building?', choices: [['residential', 'A home (house, duplex or mobile home)'], ['commercial', 'Commercial or multi-family']] },
  { id: 'description', fields: ['description'], ai: true, prompt: 'What work are you doing? For example, "replace the roof shingles" or "new kitchen cabinets and countertops".' },
  { id: 'criteria', fields: CRIT_KEYS, done: (d) => d.criteria_fail === true || critsFor(d.property_type).every((c) => d[c.key] === true),
    prompt: criteriaPrompt, choices: [['yes', 'Yes, all of these are true'], ['no', "No, one or more isn't true"]] },
  // A dead end on purpose: the chat can't switch forms, so it stays here until they start a construction permit or
  // change their answer.
  { id: 'criteria_stop', when: { criteria_fail: true }, fields: ['criteria_fail'], done: (d) => d.criteria_fail !== true,
    prompt: 'Then this work needs a **construction permit** instead of an exemption. Type "construction permit" and I\'ll start that application for you. If you misread a line and all of them are true, tap below.',
    choices: [['yes', 'Actually, all of them are true']] },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the street address where the work will be done?" },
  { id: 'applicant_role', fields: ['applicant_role'], prompt: 'Are you the property owner or the contractor?', choices: [['owner', "I'm the owner"], ['contractor', "I'm the contractor"]] },
  { id: 'owner_name', fields: ['owner_name'], prompt: (d) => (d.applicant_role === 'owner' ? "What's your full name, as it appears on the deed?" : "What's the property owner's full name, as it appears on the deed?") },
  { id: 'owner_contact', fields: ['owner_phone'], alt: ['owner_cell', 'owner_email'], ai: true,
    prompt: (d) => {
      const you = d.applicant_role === 'owner';
      if (d.property_type === 'commercial') return you ? "What's the best phone number for you?" : "What's the owner's phone number?";
      return you ? "What's the best phone number and email for you?" : "What's the owner's phone number and email?";
    } },
  { id: 'owner_same_mailing', when: RES, fields: ['owner_same_mailing'], prompt: (d) => `Is the owner's mailing address the same as the job address${d.property_address ? ` (${d.property_address})` : ''}?`, choices: YES_NO },
  { id: 'owner_mailing', when: { ...RES, owner_same_mailing: false }, fields: ['owner_address', 'owner_city', 'owner_state', 'owner_zip'], ai: true, prompt: "What's the owner's mailing address, including city, state and ZIP?" },
  { id: 'builder', fields: ['builder'], prompt: (d) => (d.property_type === 'commercial' ? 'Who is doing the work? Commercial work needs a licensed contractor unless the owner qualifies for an exception.' : 'Who is doing the work?'), choices: BUILDERS },
  { id: 'contractor', when: GC, fields: ['contractor_name'], ai: true, prompt: "What's the contractor's company name and Mississippi license number (MS #)?" },
  { id: 'contractor_license', when: { ...COM, ...GC }, fields: ['contractor_license'], prompt: "What's the contractor's Mississippi license number (MS #)? It's required for commercial work. The contractor can give it to you." },
  { id: 'contractor_contact', when: GC, fields: ['contractor_phone'], alt: ['contractor_cell', 'contractor_email'], ai: true, prompt: "What's the contractor's phone number? Add their email and mailing address if you have them." },
  { id: 'owner_exemption', when: { ...COM, builder: 'owner' }, fields: ['owner_exemption'], prompt: 'Mississippi requires a licensed contractor for commercial work unless the owner meets one of these exceptions. Which one applies?', choices: OWNER_EXCEPTIONS },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates?', choices: CONTACT_PREF },
  { id: 'sign', fields: ['certify', 'signature_name'],
    prompt: (d) => (d.property_type === 'commercial' && d.builder === 'contractor'
      ? 'Last step. On commercial work the contractor signs this certification. Review it, then type the contractor\'s full name to sign. By signing, the contractor certifies the project meets every exemption criterion.'
      : 'Last step. Review the certification, then type your full name to sign it. By signing you certify the project meets every exemption criterion.') },
];

// Fills values that follow from other answers. Only fills blanks, so anything the applicant typed wins.
function derive(out) {
  if (out.applicant_role === 'contractor' && (out.builder == null || out.builder === '')) out.builder = 'contractor';
  return out;
}

function contact(d) {
  const pick = (name, email, phone) => ({ name: name || null, email: email || null, phone: phone || null });
  const c = d.applicant_role === 'contractor' ? pick(d.contractor_name, d.contractor_email, d.contractor_cell || d.contractor_phone)
    : pick(d.owner_name, d.owner_email, d.owner_cell || d.owner_phone);
  return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
}

const fee = () => ({ total: 0, lines: [{ label: 'No fee for an exemption certification', amount: 0 }], notes: [], source: null });

// Work the exemption never covers, read from the description. Only a warning: the description may be loose.
const NOT_REPAIR = /\b(add(ing)? (a |an )?(room|bedroom|bathroom|porch|deck|carport|garage|story|addition)|addition|enclos\w+|new (house|home|building|garage|carport|shed|porch|deck)|build(ing)? (a |an )?(new )?(house|home|garage|carport|shed|porch|deck|room)|convert\w*|tear down|demolish)\b/i;
const ADDS_SYSTEMS = /\b(new|add(ing)?|extra|another) (circuit|outlet|breaker|panel|sink|toilet|tub|shower|bathroom|water heater|ac unit|a\/c unit|hvac|duct\w*|heat pump)s?\b|\bpanel upgrade\b/i;

function check(d, ctx, { add, need, has: hasValue }) {
  if (d.criteria_fail === true) add('error', 'criteria_fail', NOT_EXEMPT);

  const sc = ctx.screen;
  if (sc?.flood?.checked && sc.flood.sfha) {
    add('error', 'crit_no_flood', `FEMA flood maps show this property in a flood zone${sc.flood.zone ? ` (zone ${sc.flood.zone})` : ''}. Work in a flood zone isn't exempt, so it needs a construction permit and a floodplain development permit. Type "construction permit" in the chat to start one.`);
  }

  if (d.builder === 'contractor') {
    if (!hasValue(d.contractor_phone) && !hasValue(d.contractor_cell) && !hasValue(d.contractor_email)) add('error', 'contractor_phone', "Give the contractor's phone number or email.");
    if (d.property_type === 'commercial') need('contractor_license', "Enter the contractor's Mississippi license number (MS #). It's required for commercial work.");
    else if (!hasValue(d.contractor_license)) add('info', 'contractor_license', "Add the contractor's Mississippi license number (MS #) if you have it.");
    if (d.property_type === 'commercial' && d.applicant_role === 'owner') {
      add('warning', 'signature_name', 'On commercial work the contractor signs this certification. Have the contractor review and sign it, or City Hall will ask for their signature.');
    }
  }
  if (d.property_type === 'residential' && !hasValue(d.owner_same_mailing)) add('error', 'owner_same_mailing', "Tell us whether the owner's mailing address is the job address.");

  if (NOT_REPAIR.test(d.description || '')) add('warning', 'description', 'The job description sounds like new construction, an addition or a change of use. The exemption only covers repairs and renovations that don\'t enlarge or change the building. If that\'s the case, apply for a construction permit instead.');
  else if (ADDS_SYSTEMS.test(d.description || '')) add('warning', 'description', 'The job description mentions adding plumbing, electrical or HVAC. Adding fixtures, circuits or HVAC units isn\'t exempt and needs a construction permit.');
}

// "Are all the criteria true?" Yes checks every criterion that applies (all of them when the property type isn't known
// here; the ones for the other type stay hidden); no flags the certification as not exempt.
function criteria(text, d = {}) {
  const t = text.trim().toLowerCase();
  if (/\b(not sure|don'?t know|unsure|maybe|idk|which one)\b/.test(t)) return {};
  if (/^(n|no|nope|not)\b|\b(isn'?t|aren'?t|not all|one or more|none of)\b/.test(t)) {
    return { criteria_fail: true, ...Object.fromEntries(CRIT_KEYS.map((k) => [k, null])) };
  }
  if (/^(y|yes|yeah|yep|yup|sure|correct|true|right|all|they are|they're|it does|i certify|i agree|actually)\b/.test(t)) {
    return { criteria_fail: false, ...Object.fromEntries((d.property_type ? critsFor(d.property_type) : CRITERIA).map((c) => [c.key, true])) };
  }
  return {};
}

const parse = {
  description: (t) => ({ description: t.trim() }),
  criteria,
  criteria_stop: criteria,
  contractor: (t) => {
    const lic = t.match(/\b(?:ms|license|lic|number|no)\.?\s*#?\s*[:-]?\s*(\d[\w-]{2,})/i) || t.match(/#\s*(\d[\w-]{2,})/);
    const name = t.replace(lic?.[0] || '', '').replace(/[,;.]+\s*$|\b(and|with)\s*$/i, '').trim();
    return { contractor_name: name || undefined, contractor_license: lic?.[1] };
  },
};

const typeLabel = (k) => (PROPERTY_TYPES.find(([v]) => v === k) || [])[1];

export default defineForm({
  kind: 'exemption', title: 'Construction permit exemption certification', short: 'Permit exemption', code: 'EX', icon: 'check',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/297',
  formUrls: ['https://www.cityofwiggins.gov/DocumentCenter/View/294', 'https://www.cityofwiggins.gov/DocumentCenter/View/297'],
  intro: "Some repairs and renovations don't need a construction permit. This certification tells City Hall your project meets every exemption rule, and City Hall approves it. There's no fee.",
  detect: /\b(permit exemption|exemption certification|exempt(ion)? from (a |the |needing a )?(construction |building )?permit|(do|would|will) i (need|have to get) a (construction |building )?permit (to|for)\b.{0,40}\b(repair\w*|replac\w*|re-?roof\w*|roof\w*|paint\w*|repaint\w*|siding|shingles?|floor\w*|carpet|cabinets?|counter\w*|drywall|sheetrock|windows?|doors?|gutters?|renovat\w*|fix\w*|updat\w*)|(minor|small) (repair|renovation)s?\b.{0,30}\b(without|no|need) (a )?permit|without a permit\b.{0,30}\b(repair|renovat|fix|re-?roof|replac)\w*)/i,
  addressField: 'property_address', descriptionField: 'description',
  sections: SECTIONS, asks: ASKS, derive, contact, fee, check, parse,
  fillable: ['contractor_license'],
  review: 'Read the job description against each exemption criterion: anything that enlarges the building, changes its use, touches structural members, or adds plumbing fixtures, circuits or HVAC is not exempt. For staff: flood zone, and on commercial work a licensed contractor (or a valid owner exception) and the contractor\'s signature.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is reviewing your certification'],
    in_review: ['Under review', 'Planning & Building is checking that the work is exempt'],
    issued: ['Approved', 'City Hall approved your exemption. Keep a copy at the job site.'],
    denied: ['Not approved', 'This work needs a construction permit. Ask for one in the chat.'],
  },
  steps: [['submitted', 'Submitted'], ['in_review', 'Review'], ['issued', 'Approved']],
  issue: {
    noun: 'approval', title: 'CONSTRUCTION PERMIT EXEMPTION', numberLabel: 'Approval number', action: 'Approve exemption', post: true, inspections: null,
    after: 'The work described is exempt from a construction permit under Section 4.4.1 of the City of Wiggins Land Development Code. Keep a copy at the job site. Any work beyond what is described here, or that does not meet every exemption criterion, needs a construction permit.',
    rows: (app, label) => {
      const d = app.data;
      return [
        ['Job address', app.screen?.matchedAddress || d.property_address], ['Property', typeLabel(d.property_type)],
        ['Job description', d.description], ['Owner', `${d.owner_name || ''}${d.owner_phone ? ` · ${d.owner_phone}` : ''}`],
        ['Contractor', d.builder === 'owner' ? `Owner${d.owner_exemption ? ` (${label(OWNER_EXCEPTIONS, d.owner_exemption)})` : ''}` : `${d.contractor_name || ''}${d.contractor_license ? ` · MS # ${d.contractor_license}` : ''}`],
        ['Certified by', d.signature_name],
      ];
    },
  },
  nextSteps: ['Planning & Building reviews your certification.', "When it's approved, download the approval and keep a copy at the job site.",
    "If City Hall finds the work isn't exempt, they'll tell you to apply for a construction permit instead."],
  copyKeys: /^(owner_|contractor_|applicant_role|contact_pref|builder)/,
});
