// The request for inspection for utility connections (City of Wiggins form, revised January 2021). Before a utility
// company turns service on at a building that has been off for a while, repaired or newly built, the city inspects it.
// When it passes, City Hall sends the utility company an "Approval for connection of utilities" (revised 08/2022),
// which is the approval this form issues.
import { CONTACT_PREF, defineForm, f } from '../engine.js';

// The utilities on the city's form, with where the approval goes (from the approval form).
export const UTILITY_COMPANIES = [
  { value: 'prvepa', label: 'Electricity: Pearl River Valley Electric Power Association', company: 'Pearl River Valley Electric Power Association', email: 'Karen@PRVEPA.com' },
  { value: 'mpc', label: 'Electricity: Mississippi Power', company: 'Mississippi Power Company', email: 'g2mpcpermits@southernco.com' },
  { value: 'gas', label: 'Gas: CenterPoint Energy', company: 'CenterPoint Energy', email: 'ServicePermit@centerpointenergy.com' },
];
export const UTILITIES = [...UTILITY_COMPANIES.map((x) => [x.value, x.label]), ['other', 'Other']];
export const REASONS = [['off_6_months', 'The utility has been off more than 6 months'], ['repairs_new', 'Repairs or new construction'], ['utility_required', 'The utility company requires it'], ['other', 'Other']];

const GAS = { utilities: { has: 'gas' } };

const SECTIONS = [
  { id: 'utility', title: 'Utility', fields: [
    f('utilities', 'Utility to be connected', 'multi', { options: UTILITIES, required: 'Choose the utility to be connected.',
      explain: 'Pick the company that will turn the service on. Most of Wiggins gets electricity from either Pearl River Valley Electric (PRVEPA) or Mississippi Power; your last power bill shows which. Natural gas comes from CenterPoint Energy.' }),
    f('utilities_other', 'Other utility', 'text', { when: { utilities: { has: 'other' } }, required: 'Name the other utility to be connected.' }),
    f('reason', 'Reason for the inspection', 'select', { options: REASONS, required: 'Choose the reason for the inspection.' }),
    f('reason_other', 'Other reason', 'text', { when: { reason: 'other' }, required: 'Describe the reason for the inspection.' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('property_address', 'Street address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the street address of the building.' }),
    f('structure_description', 'What building is being connected?', 'text', { placeholder: 'e.g. Single-family house, mobile home, storage building with power',
      required: 'Describe the building being connected.', help: 'This is printed on the approval City Hall sends the utility company.' }),
  ] },
  { id: 'gas', title: 'Gas leak test', fields: [
    f('plumber_name', "Plumber's name", 'text', { when: GAS, required: "Enter the licensed plumber's name. It's required for gas connections." }),
    f('plumber_phone', "Plumber's phone", 'phone', { when: GAS, half: true, required: "Enter the plumber's phone number. It's required for gas connections." }),
    f('gas_test_ack', 'A licensed plumber will do a leak test on the gas piping, witnessed by a City of Wiggins Planning & Building inspector, as required by IFGC 406. Residential: natural gas 15 psi for 30 minutes, LP gas 30 psi for 30 minutes. Commercial: per IFGC 406.4.2.', 'check', {
      when: GAS, required: 'Confirm that a licensed plumber will do the gas leak test with the city inspector there.',
      explain: 'Before gas is turned on, a licensed plumber pressurizes the gas lines with air and the city inspector watches the gauge to make sure no pressure is lost, which means no leaks. IFGC 406 is the section of the International Fuel Gas Code that sets the test. For a home, natural gas lines are held at 15 psi for 30 minutes and LP (propane) lines at 30 psi for 30 minutes. Commercial tests follow IFGC 406.4.2. The plumber has to be there for the inspection.' }),
  ] },
  { id: 'contact', title: 'Contact', fields: [
    f('contact_name', 'Contact name', 'text', { required: 'Enter the name of the person the inspector should call.' }),
    f('contact_phone', 'Contact phone', 'phone', { half: true, required: 'Enter a phone number. The inspector calls to confirm the time.' }),
    f('contact_email', 'Contact email', 'email', { optional: true }),
    f('contact_pref', 'How should City Hall reach you about this request?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'schedule', title: 'Scheduling', fields: [
    f('preferred_time', 'Preferred day or time for the inspection', 'text', { placeholder: 'e.g. Weekday mornings', optional: true, help: 'The inspector calls to confirm the actual time.' }),
    f('notes', 'Notes for the inspector', 'longtext', { placeholder: 'e.g. Gate code 1234, dog in the back yard', optional: true }),
  ] },
];

const ASKS = [
  { id: 'utilities', fields: ['utilities'], ai: true, prompt: 'Which utility needs to be connected? If it\'s more than one, tell me all of them.', choices: UTILITIES },
  { id: 'utilities_other', when: { utilities: { has: 'other' } }, fields: ['utilities_other'], prompt: 'Which other utility is it?' },
  { id: 'reason', fields: ['reason'], prompt: 'Why does it need an inspection?', choices: REASONS },
  { id: 'reason_other', when: { reason: 'other' }, fields: ['reason_other'], prompt: 'What\'s the reason for the inspection?' },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the street address of the building?" },
  { id: 'structure_description', fields: ['structure_description'], prompt: 'What kind of building is it? For example, "single-family house", "mobile home" or "storage building with power".' },
  { id: 'plumber', when: GAS, fields: ['plumber_name', 'plumber_phone'], ai: true, prompt: 'Gas connections need a leak test by a licensed plumber. What\'s the plumber\'s name and phone number?' },
  { id: 'gas_test_ack', when: GAS, fields: ['gas_test_ack'], choices: [['yes', 'I understand']],
    prompt: 'The plumber pressure-tests the gas lines while the city inspector watches: for a home, 15 psi for 30 minutes on natural gas or 30 psi for 30 minutes on propane. The plumber needs to be there for the inspection. Okay?' },
  { id: 'contact_name', fields: ['contact_name'], prompt: 'Who should the inspector call to set up a time? Give me a name.' },
  { id: 'contact', fields: ['contact_phone'], ai: true, prompt: "What's the best phone number for them? Add an email too if you'd like updates by email." },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates?', choices: CONTACT_PREF },
  { id: 'preferred_time', fields: ['preferred_time'], optional: true, prompt: 'Is there a day or time that works best for the inspection? The inspector will call to confirm.', choices: [['__skip', 'Any time is fine']] },
  { id: 'notes', fields: ['notes'], optional: true, prompt: 'Anything else the inspector should know? For example, a locked gate or a dog in the yard.', choices: [['__skip', 'Nothing else']] },
];

function contact(d) {
  const c = { name: d.contact_name || null, email: d.contact_email || null, phone: d.contact_phone || null };
  return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
}

// One inspection per request, at the published individual inspection fee.
function fee(d, cfg) {
  const each = cfg?.fees?.flat ?? 65;
  return {
    total: each, lines: [{ label: cfg?.fees?.label || 'Utility connection inspection', amount: each }],
    notes: cfg?.fees?.notes || ['Pay the fee before the inspection is scheduled.'], source: cfg?.fees?.source || null,
  };
}

function check(d, ctx, { add }) {
  if (d.reason === 'repairs_new') add('info', 'reason', 'Repairs or new construction: check for an open construction permit at this address before approving the connection.');
  if ((d.utilities || []).includes('gas') && d.utilities.length === 1 && /\b(propane|lp|lpg)\b/i.test(`${d.structure_description || ''} ${d.notes || ''}`)) {
    add('info', 'utilities', 'The notes mention propane. CenterPoint supplies natural gas; confirm which gas service is being connected.');
  }
}

// Free-form answers the generic reader can't place.
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL_IN = /[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,}/i;

function utilities(text) {
  const t = text.toLowerCase();
  const out = [];
  if (/pearl river|prvepa|\bprv\b|co-?op/.test(t)) out.push('prvepa');
  if (/mississippi power|\bmpc\b|\bms power\b|southern ?co/.test(t)) out.push('mpc');
  if (/\bgas\b|centerpoint/.test(t)) out.push('gas');
  if (/^other$|\b(water|sewer|other)\b/.test(t)) out.push('other');
  return out.length ? { utilities: out } : {};
}

function reason(text) {
  const t = text.toLowerCase();
  if (/\b(\d+|six|seven|eight|nine|ten|eleven|twelve|several|many) (months|years)\b|\b(a|over a|more than a) year\b|been (off|vacant|empty)|off more than|off for|vacant|empty/.test(t)) return { reason: 'off_6_months' };
  if (/\b(repair\w*|new|construct\w*|built|build\w*|rewir\w*|remodel\w*|renovat\w*|fire|storm)\b/.test(t)) return { reason: 'repairs_new' };
  if (/\b(power|utility|gas|electric\w*) company\b|\b(they|it) (said|told|requires?)\b|\brequired\b|\bcenterpoint\b|\bprvepa\b|mississippi power/.test(t)) return { reason: 'utility_required' };
  if (/^other\b/.test(t)) return { reason: 'other' };
  return {};
}

const parse = {
  utilities: (t) => utilities(t),
  reason: (t) => reason(t),
  plumber: (t) => {
    const phone = t.match(PHONE)?.[0];
    const name = t.replace(PHONE, '').replace(/[,;]|\b(and|phone|number|is|at)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return { plumber_name: name || undefined, plumber_phone: phone };
  },
  contact: (t) => ({ contact_phone: t.match(PHONE)?.[0], contact_email: t.match(EMAIL_IN)?.[0] }),
};

const UTIL = '(power|electric\\w*|lights|gas|utilit\\w*|meter|service)';
const CONNECT = '(connect\\w*|reconnect\\w*|hook(ed|ing)?[- ]?up|turn(ed|ing)? (it |them |\\w+ )?(back )?on)';

const companyFor = (k) => UTILITY_COMPANIES.find((x) => x.value === k)?.company;

export default defineForm({
  kind: 'utility_inspection', title: 'Request for inspection: utility connections', short: 'Utility connection inspection', code: 'UI', icon: 'plug',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/296',
  intro: 'Before the power or gas company turns service on at a building that was off more than 6 months, repaired or newly built, a city inspector checks it. The inspection is $65.',
  // Needs a utility word plus a connect or inspect word, so "gas leak" alone (an emergency) or "connect me with the
  // inspector" doesn't start this form.
  detect: new RegExp([
    `\\butilit(y|ies) (re)?connection inspection`,
    `\\binspect\\w*\\b.{0,60}\\b${UTIL}\\b.{0,40}\\b${CONNECT}`,
    `\\b${UTIL}\\b.{0,40}\\b${CONNECT}.{0,60}\\binspect\\w*`,
    `\\bturn (the |my )?(power|electricity|lights|gas|utilities) back on\\b`,
    `\\bgas\\b.{0,20}\\b(leak|pressure) test\\w*`, `\\b(leak|pressure) test\\w*\\b.{0,20}\\bgas\\b`,
    `\\b(power|electric|gas|utility) company\\b.{0,30}\\b(needs?|wants?|requires?|said|asking for)\\b.{0,30}\\b(inspection|release|approval)\\b`,
  ].join('|'), 'i'),
  addressField: 'property_address', descriptionField: 'structure_description',
  sections: SECTIONS, asks: ASKS, contact, fee, check, parse,
  review: 'Check that the structure description and address are specific enough for the utility company to find the building, and for gas connections that a plumber is named. For staff: open construction permits or code cases at this address, and whether the reason fits.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is checking your request'],
    fees_due: ['Fee due', 'Pay the inspection fee so the inspection can be scheduled'],
    in_review: ['Inspection scheduled', 'The inspector will call to confirm the time'],
    issued: ['Approved for connection', 'City Hall sent the approval to your utility company'],
    denied: ['Not approved', 'The inspection found problems. Call City Hall about fixing them and a new inspection'],
  },
  steps: [['submitted', 'Submitted'], ['paid', 'Fee paid'], ['in_review', 'Inspection'], ['issued', 'Approved']],
  issue: {
    noun: 'approval', title: 'APPROVAL FOR CONNECTION OF UTILITIES', numberLabel: 'Approval number', action: 'Approve connection', post: false, inspections: null,
    after: 'City Hall sends this approval to the utility company. The structure at this address is approved for connection of the utilities listed, subject to compliance with standard construction practices, IBC 2003, IRC 2003 and any special conditions noted. Call the utility company to schedule the connection.',
    rows: (app, label) => {
      const d = app.data;
      const list = (d.utilities || []).map((k) => (k === 'other' ? d.utilities_other || 'Other' : companyFor(k) || label(UTILITIES, k)));
      return [
        ['Utility company', list.join(', ')], ['Address', app.screen?.matchedAddress || d.property_address],
        ['Structure description', d.structure_description],
        ['Contact name & tel. #', `${d.contact_name || ''}${d.contact_phone ? ` · ${d.contact_phone}` : ''}`],
        ...((d.utilities || []).includes('gas') ? [['Gas leak test', `Licensed plumber ${d.plumber_name || ''}${d.plumber_phone ? ` · ${d.plumber_phone}` : ''}, witnessed by the city inspector (IFGC 406)`]] : []),
      ];
    },
  },
  nextSteps: ['Planning & Building checks your request.', "You'll be told how to pay the inspection fee.",
    'The inspector calls you to set a time, then inspects the building.', 'If it passes, City Hall sends the approval to your utility company. Then call them to turn on service.'],
  copyKeys: /^(contact_|plumber_)/,
});
