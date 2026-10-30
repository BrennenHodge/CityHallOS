// The sign permit application (City of Wiggins Planning and Building Department). Ground-mounted and building-mounted
// signs each have their own block; the resident says which kinds they're putting up and only those blocks are asked.
// The applicant is the main contact: often the business or the sign company, not the property owner.
import { CONTACT_PREF, YES_NO, ZONES_UNSURE, defineForm, f, has, ownerAsks, party, signAsk, signFields, splitAddress } from '../engine.js';

export const SIGN_KINDS = [['ground', 'Ground-mounted (pole or monument)'], ['building', 'Building-mounted (wall, awning, window)']];
export const LIGHTING = [['none', 'Not lit'], ['internal', 'Lit from inside (internal)'], ['external', 'Lit by outside lights (external)']];
export const BUILDING_TYPES = [['wall', 'Wall'], ['projecting', 'Projecting'], ['awning', 'Awning'], ['window', 'Window'], ['other', 'Other']];
export const ROLES = [['owner', 'I own the property'], ['lessee', 'I lease the property (tenant)'], ['contractor', "I'm the sign company or contractor"], ['other', 'Someone else']];
export const INSTALLERS = [['contractor', 'A sign company or contractor'], ['self', "We're doing it ourselves"]];
export const DOC_KINDS = [['sign_drawing', 'Sign drawing or photo with dimensions'], ['site_plan', 'Site plan showing where the sign goes'], ['other', 'Other document']];

const GROUND = { sign_kinds: { has: 'ground' } };
const BUILDING = { sign_kinds: { has: 'building' } };
const NOT_OWNER = { applicant_role: ['lessee', 'contractor', 'other'] };
const MAY_LEASE = { applicant_role: ['owner', 'contractor', 'other'] };
const NOT_CONTRACTOR = { applicant_role: ['owner', 'lessee', 'other'] };
const SIDES_SQFT = ['building_sqft_front', 'building_sqft_rear', 'building_sqft_side1', 'building_sqft_side2'];

const RIGHT_OF_WAY = 'The street right-of-way is the strip of public land along the street: the road itself plus the shoulder, ditch and sidewalk. Its edge is usually your front property line. Measure from that line to the closest part of the sign.';

const SECTIONS = [
  { id: 'applicant', title: 'Applicant', fields: [
    ...party('applicant', 'Applicant', { required: true, reach: true }),
    f('business_name', 'Name of business', 'text', { optional: true, help: 'The business the sign is for, or your company\'s name.' }),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'property', title: 'Sign location', fields: [
    f('property_address', 'Property address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address where the sign will go.' }),
    f('parcel_number', 'Parcel number', 'text', { optional: true, help: 'On the property tax bill. Leave blank if you don\'t know it.',
      explain: 'The parcel number identifies the lot in Stone County\'s property records. It is printed on the property tax bill, the deed, or the county tax parcel card. If you don\'t have it, leave it blank and City Hall looks it up.' }),
    f('zoning', 'Zoning district', 'select', { options: ZONES_UNSURE, required: 'Choose the zoning district, or "Not sure".',
      explain: 'Every lot in Wiggins is in a zoning district (R-1 is single-family residential, C-2 is general commercial, and so on). The district decides what size and kind of sign is allowed. If you don\'t know it, choose "Not sure" and City Hall will confirm it.' }),
  ] },
  { id: 'people', title: 'Owner, tenant & sign company', fields: [
    f('applicant_role', 'How are you connected to the property?', 'select', { options: ROLES, required: 'Tell us how you are connected to the property.' }),
    ...party('owner', 'Property owner', { when: NOT_OWNER, required: true, reach: true, help: 'As shown on the deed or tax records.' }),
    f('has_lessee', 'Is the property leased to a tenant?', 'bool', { when: MAY_LEASE }),
    ...party('lessee', 'Lessee (tenant)', { when: { has_lessee: true, applicant_role: ['owner', 'contractor', 'other'] }, cell: false }),
    f('installer', 'Who is making and installing the sign?', 'select', { when: NOT_CONTRACTOR, options: INSTALLERS }),
    ...party('contractor', 'Sign company or contractor', { when: { installer: 'contractor', applicant_role: ['owner', 'lessee', 'other'] }, cell: false }),
  ] },
  { id: 'signs', title: 'Signs', fields: [
    f('sign_kinds', 'Kinds of sign', 'multi', { options: SIGN_KINDS, required: 'Choose ground-mounted, building-mounted, or both.',
      explain: 'A ground-mounted sign stands on its own on the ground, on a pole, posts or a monument base. A building-mounted sign is attached to a building: painted or mounted on a wall, hanging out from the wall (projecting), on an awning, or in a window.' }),
    f('sign_installed', 'Is the sign already up?', 'bool', { required: 'Tell us whether the sign is already up.', help: 'The fee is doubled when a sign goes up before the permit.' }),
  ] },
  { id: 'ground', title: 'Ground-mounted signs', fields: [
    f('ground_count', 'Number of ground-mounted signs proposed', 'number', { when: GROUND, half: true, required: 'Enter how many ground signs you plan to put up.' }),
    f('ground_existing', 'Number of existing signs on the property', 'number', { when: GROUND, half: true, required: 'Enter how many signs are already on the property (0 if none).' }),
    f('ground_dimensions', 'Size (dimensions)', 'text', { when: GROUND, half: true, placeholder: 'e.g. 4 ft × 8 ft, two-sided' }),
    f('ground_sqft', 'Size (total sq ft, both sides)', 'number', { when: GROUND, half: true, help: 'Width × height of the sign face. Count both sides if it has two.',
      explain: 'Multiply the width by the height of the sign face, in feet. If people can read it from both sides, count both sides: a 4 by 8 foot sign is 32 sq ft, or 64 sq ft with two sides.' }),
    f('ground_height', 'Height from the ground to the top of the sign (ft)', 'number', { when: GROUND, half: true, required: 'Enter how tall the sign is, from the ground to the top.' }),
    f('ground_setback', 'Sign setback from the street right-of-way (ft)', 'number', { when: GROUND, half: true, required: 'Enter how far the sign is from the street right-of-way.', explain: RIGHT_OF_WAY }),
    f('ground_spacing', 'Distance from the closest ground-mounted sign (ft)', 'number', { when: GROUND, half: true, optional: true, help: 'On your property or next door. Leave blank if there isn\'t one nearby.' }),
    f('frontage', 'Street frontage: width of the property along the street (ft)', 'number', { when: GROUND, half: true, required: 'Enter how wide the property is along the street.' }),
    f('ground_lighting', 'Illuminated?', 'select', { when: GROUND, options: LIGHTING, required: 'Tell us whether the ground sign will be lit.',
      explain: 'Internal lighting is inside the sign, shining through the face (like a lit cabinet sign). External lighting is a separate light pointed at the sign.' }),
    f('ground_description', 'Brief description of the ground-mounted sign', 'longtext', { when: GROUND, required: 'Briefly describe the ground sign.', placeholder: 'e.g. Brick monument sign with aluminum letters reading "Pine Street Dental"' }),
  ] },
  { id: 'building', title: 'Building-mounted signs', fields: [
    f('building_count', 'Number of building-mounted signs proposed', 'number', { when: BUILDING, half: true, required: 'Enter how many building signs you plan to put up.' }),
    f('building_existing', 'Number of existing signs on the building', 'number', { when: BUILDING, half: true, required: 'Enter how many signs are already on the building (0 if none).' }),
    f('building_types', 'Type of building-mounted sign(s)', 'multi', { when: BUILDING, options: BUILDING_TYPES, required: 'Choose the type of building sign.',
      explain: 'Wall: flat on the wall. Projecting: sticks out from the wall, usually hanging from a bracket. Awning: printed on or attached to an awning. Window: painted on or hung inside a window.' }),
    f('building_types_other', 'Other type of sign', 'text', { when: { sign_kinds: { has: 'building' }, building_types: { has: 'other' } }, required: 'Describe the other type of building sign.' }),
    f('building_sqft_front', 'Front (sq ft)', 'number', { when: BUILDING, half: true, help: 'Total of all signs on that side.',
      explain: 'For each side of the building, add up the area (width × height) of every sign on that side, including signs already there. Leave a side blank if it has no signs.' }),
    f('building_sqft_rear', 'Rear (sq ft)', 'number', { when: BUILDING, half: true, optional: true }),
    f('building_sqft_side1', 'Side 1 (sq ft)', 'number', { when: BUILDING, half: true, optional: true }),
    f('building_sqft_side2', 'Side 2 (sq ft)', 'number', { when: BUILDING, half: true, optional: true }),
    f('building_lighting', 'Illuminated?', 'select', { when: BUILDING, options: LIGHTING, required: 'Tell us whether the building sign will be lit.' }),
    f('building_description', 'Brief description of the building-mounted sign', 'longtext', { when: BUILDING, required: 'Briefly describe the building sign.', placeholder: 'e.g. Lighted channel letters on the front wall reading "Main Street Cafe"' }),
  ] },
  { id: 'documents', title: 'Documents', fields: [
    f('files', 'Attachments', 'files', { kinds: DOC_KINDS }),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: signFields({
    certify: 'I certify that all information on this application is true and correct. I understand that if any changes are made to the sign(s) after I submit this application, an amended application must be submitted to and approved by the City of Wiggins. I agree that the work will be done according to the 2013 Land Development Code of the City of Wiggins, Mississippi, and the 2003 International Building Code (IBC).',
  }) },
];

const [, , ownerName, ownerMailing, ownerContact] = ownerAsks();

const ASKS = [
  { id: 'sign_kinds', fields: ['sign_kinds'], prompt: 'What kind of sign are you putting up?', choices: [['ground', 'On the ground (pole or monument)'], ['building', 'On the building (wall, awning, window)'], ['both', 'Both']] },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the street address where the sign will go?" },
  { id: 'parcel_number', fields: ['parcel_number'], optional: true, prompt: "Do you know the parcel number? It's on the property tax bill. If not, tap \"I don't know\" and City Hall will look it up.", choices: [['__skip', "I don't know"]] },
  { id: 'zoning', fields: ['zoning'], prompt: 'Do you know the zoning district? If not, choose "Not sure" and City Hall will confirm it.', choices: ZONES_UNSURE },
  { id: 'applicant_role', fields: ['applicant_role'], prompt: 'How are you connected to the property?', choices: ROLES },
  { id: 'applicant_name', fields: ['applicant_name'], prompt: "What's your full name?" },
  { id: 'business_name', fields: ['business_name'], optional: true, choices: [['__skip', 'No business name']],
    prompt: (d) => (d.applicant_role === 'contractor' ? "What's your company's name?" : "What's the name of the business the sign is for?") },
  { id: 'applicant_mailing', fields: ['applicant_address', 'applicant_city', 'applicant_state', 'applicant_zip'], ai: true, prompt: "What's your mailing address, including city, state and ZIP?" },
  { id: 'applicant_contact', fields: ['applicant_phone'], alt: ['applicant_cell', 'applicant_email'], ai: true, prompt: "What's the best phone number and email for you?" },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates about this application?', choices: CONTACT_PREF },
  { ...ownerName, when: NOT_OWNER },
  { ...ownerMailing, when: NOT_OWNER },
  { ...ownerContact, when: NOT_OWNER },
  { id: 'has_lessee', when: MAY_LEASE, fields: ['has_lessee'], choices: YES_NO,
    prompt: (d) => (d.applicant_role === 'owner' ? 'Do you lease the property to a tenant, like the business the sign is for?' : 'Does a tenant lease the property, like the business the sign is for?') },
  { id: 'lessee', when: { has_lessee: true, applicant_role: ['owner', 'contractor', 'other'] }, fields: ['lessee_name'], ai: true, prompt: "What's the tenant's name, mailing address, and phone or email?" },
  { id: 'installer', when: NOT_CONTRACTOR, fields: ['installer'], prompt: 'Who is making and installing the sign?', choices: INSTALLERS },
  { id: 'contractor', when: { installer: 'contractor', applicant_role: ['owner', 'lessee', 'other'] }, fields: ['contractor_name'], ai: true, prompt: "What's the sign company's name, phone or email, and mailing address?" },

  // Ground-mounted signs.
  { id: 'ground_count', when: GROUND, fields: ['ground_count'], prompt: 'How many ground signs will you put up?', choices: [['1', 'One'], ['2', 'Two']] },
  { id: 'ground_size', when: GROUND, fields: ['ground_sqft'], ai: true,
    prompt: (d) => `How big is the sign face? Give the width and height in feet, and say if it has one side or two. For example: "4 by 8 feet, both sides".${Number(d.ground_count) > 1 ? ' If the signs are different sizes, give each one.' : ''}` },
  { id: 'ground_height', when: GROUND, fields: ['ground_height'], prompt: 'How tall will the sign be, from the ground to the very top, in feet?' },
  { id: 'ground_setback', when: GROUND, fields: ['ground_setback'], prompt: 'How far will the sign be from the street right-of-way, in feet? That\'s the public strip along the street. Its edge is usually your front property line.' },
  { id: 'ground_spacing', when: GROUND, fields: ['ground_spacing'], optional: true, prompt: 'How far will it be from the closest other ground sign, on your property or next door, in feet?', choices: [['__skip', "There isn't one nearby"]] },
  { id: 'frontage', when: GROUND, fields: ['frontage'], prompt: 'How wide is the property along the street, in feet?' },
  { id: 'ground_existing', when: GROUND, fields: ['ground_existing'], prompt: 'How many signs are already on the property? Count any you are keeping.', choices: [['0', 'None']] },
  { id: 'ground_lighting', when: GROUND, fields: ['ground_lighting'], prompt: 'Will the ground sign be lit?', choices: LIGHTING },
  { id: 'ground_description', when: GROUND, fields: ['ground_description'], ai: true, prompt: 'Briefly describe the ground sign: what it says, what it\'s made of, and what it stands on (pole, posts or a monument base).' },

  // Building-mounted signs.
  { id: 'building_count', when: BUILDING, fields: ['building_count'], prompt: 'How many signs will go on the building?', choices: [['1', 'One'], ['2', 'Two']] },
  { id: 'building_types', when: BUILDING, fields: ['building_types'], prompt: 'What type of building sign? Tap one, or type all that apply.', choices: BUILDING_TYPES },
  { id: 'building_types_other', when: { sign_kinds: { has: 'building' }, building_types: { has: 'other' } }, fields: ['building_types_other'], prompt: 'What other type of sign is it?' },
  { id: 'building_area', when: BUILDING, fields: ['building_sqft_front'], alt: ['building_sqft_rear', 'building_sqft_side1', 'building_sqft_side2'], ai: true,
    prompt: 'How many square feet of signs will be on each side of the building? Count signs already there too. For example: "front 32, side 1 12". Leave out sides with no signs.' },
  { id: 'building_existing', when: BUILDING, fields: ['building_existing'], prompt: 'How many signs are already on the building?', choices: [['0', 'None']] },
  { id: 'building_lighting', when: BUILDING, fields: ['building_lighting'], prompt: 'Will the building sign be lit?', choices: LIGHTING },
  { id: 'building_description', when: BUILDING, fields: ['building_description'], ai: true, prompt: 'Briefly describe the building sign: what it says, what it\'s made of, and where on the building it goes.' },

  { id: 'sign_installed', fields: ['sign_installed'], prompt: 'Is the sign already up?', choices: [['no', 'No, not yet'], ['yes', "Yes, it's up"]] },
  { id: 'drawing', fields: [], upload: ['sign_drawing'], done: (d, files, asked) => files.some((x) => x.kind === 'sign_drawing') || asked.includes('drawing'),
    prompt: 'Please upload a drawing or photo of the sign that shows its size. A phone photo of a sketch is fine.', choices: [['__skip', "I'll add it later"]] },
  { id: 'site_plan', when: GROUND, fields: [], upload: ['site_plan'], done: (d, files, asked) => files.some((x) => x.kind === 'site_plan') || asked.includes('site_plan'),
    prompt: 'Now a site plan: a simple drawing of the property showing where the ground sign goes and how far it is from the street. A hand sketch is fine.', choices: [['__skip', "I'll add it later"]] },
  signAsk(' If the sign changes after you submit, you\'ll need to file an amended application.'),
];

// Copies the applicant's details to the role they said they fill (owner, tenant or sign company). Those fields are
// hidden on the form while they're copies, so they always follow the applicant's answers.
const PARTS = ['name', 'address', 'city', 'state', 'zip', 'phone', 'email'];
function copyApplicant(out, to) {
  for (const k of PARTS) if (has(out[`applicant_${k}`])) out[`${to}_${k}`] = out[`applicant_${k}`];
  if (to === 'owner' && has(out.applicant_cell)) out.owner_cell = out.applicant_cell;
}

function derive(out) {
  if (out.applicant_role === 'owner') copyApplicant(out, 'owner');
  if (out.applicant_role === 'lessee') { copyApplicant(out, 'lessee'); out.has_lessee = true; }
  if (out.applicant_role === 'contractor') {
    copyApplicant(out, 'contractor');
    if (has(out.business_name)) out.contractor_name = out.business_name;
    out.installer = 'contractor';
  }
  // A size typed on the form ("4 x 8, two-sided") fills the square footage if it's blank.
  if (!has(out.ground_sqft) && has(out.ground_dimensions)) {
    const s = signSize(String(out.ground_dimensions));
    if (s.ground_sqft > 0) out.ground_sqft = s.ground_sqft;
  }
  return out;
}

// The applicant is who City Hall contacts.
function contact(d) {
  const c = { name: d.applicant_name || null, email: d.applicant_email || null, phone: d.applicant_cell || d.applicant_phone || null };
  return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
}

// Square feet of sign area the fee is based on: the ground signs (both sides) plus every side of the building.
export function signArea(d) {
  const kinds = d.sign_kinds || [];
  const ground = kinds.includes('ground') ? Number(d.ground_sqft) || 0 : 0;
  const building = kinds.includes('building') ? SIDES_SQFT.reduce((s, k) => s + (Number(d[k]) || 0), 0) : 0;
  return { ground, building, total: Math.round((ground + building) * 100) / 100 };
}

// Published fee: $50 for the first 50 sq ft, plus $1 for each additional square foot (doubled if the sign is already up).
function fee(d, cfg) {
  const fees = cfg?.fees || {};
  const { ground, building, total: area } = signArea(d);
  if (!(area > 0)) return null;
  const base = fees.base ?? 50; const included = fees.includedSqFt ?? 50; const per = fees.perSqFt ?? 1;
  const extra = Math.max(0, Math.ceil(area - included));
  const permit = base + extra * per;
  const lines = [{ label: `Sign permit, first ${included} sq ft`, amount: base }];
  if (extra) lines.push({ label: `${extra} additional sq ft at $${per} each`, amount: extra * per });
  const doubled = d.sign_installed === true && fees.doubleIfStarted !== false;
  if (doubled) lines.push({ label: 'Doubled because the sign is already up', amount: permit });
  const parts = [ground && `${ground} sq ft ground-mounted`, building && `${building} sq ft building-mounted`].filter(Boolean).join(' + ');
  return {
    total: doubled ? permit * 2 : permit, lines,
    notes: [`Total sign area: ${area} sq ft (${parts}).`, 'City Hall confirms the fee when it reviews the application.', ...(fees.notes || [])],
    source: fees.source || null,
  };
}

function check(d, ctx, { add, need }) {
  const kinds = new Set((ctx.files || []).map((x) => x.kind));
  const ground = (d.sign_kinds || []).includes('ground');
  const building = (d.sign_kinds || []).includes('building');

  if (has(d.has_lessee) && d.has_lessee && d.applicant_role !== 'lessee') {
    need('lessee_name', "Enter the tenant's name, or answer no to the lease question.");
    if (!['lessee_phone', 'lessee_email'].some((k) => has(d[k]))) add('warning', 'lessee_phone', "Add the tenant's phone number or email.");
  }
  if (d.installer === 'contractor' && d.applicant_role !== 'contractor') {
    need('contractor_name', "Enter the sign company's name.");
    if (!['contractor_phone', 'contractor_email'].some((k) => has(d[k]))) add('warning', 'contractor_phone', "Add the sign company's phone number or email.");
  }

  if (ground) {
    if (!(Number(d.ground_sqft) > 0)) add('error', 'ground_sqft', 'Enter the total square footage of the ground sign, counting both sides if it has two.');
    if (!has(d.ground_dimensions)) add('warning', 'ground_dimensions', 'Add the sign\'s dimensions (width × height), for example 4 ft × 8 ft.');
    const sz = has(d.ground_dimensions) ? signSize(String(d.ground_dimensions)) : {};
    const one = sz.oneSide; const sq = Number(d.ground_sqft);
    const fits = (sides, count) => Math.abs(one * sides * count - sq) <= Math.max(1, sq * 0.1);
    if (one > 0 && sq > 0 && ![1, 2].some((sides) => fits(sides, 1) || fits(sides, Number(d.ground_count) || 1))) {
      add('warning', 'ground_sqft', `The total of ${sq} sq ft doesn't match the dimensions (${d.ground_dimensions}). Check the size: width × height, times two if the sign has two sides.`);
    }
    if (has(d.ground_setback) && Number(d.ground_setback) < 5) add('warning', 'ground_setback', `The sign is ${d.ground_setback} ft from the street right-of-way. Double-check this distance. City Hall will check it against the sign rules.`);
    if (Number(d.ground_height) > 25) add('warning', 'ground_height', `The sign is ${d.ground_height} ft tall. Double-check the height. City Hall will check it against the sign rules.`);
    if (!kinds.has('site_plan')) add('warning', 'files', 'Attach a site plan showing where the ground sign goes and its distance from the street. City Hall needs it to review the sign.');
  }
  if (building) {
    const sides = SIDES_SQFT.filter((k) => Number(d[k]) > 0);
    if (!sides.length) add('error', 'building_sqft_front', 'Enter the total square footage of signs on at least one side of the building.');
  }
  if (!kinds.has('sign_drawing')) add('warning', 'files', 'Attach a drawing or photo of the sign that shows its dimensions. City Hall needs it to review the sign.');
  if (d.sign_installed) add('warning', 'sign_installed', 'The sign is already up, so the published fee schedule doubles the permit fee.');
  if (!has(d.zoning) || d.zoning === 'unknown') add('info', 'zoning', 'Zoning district not given. City Hall will confirm it.');
  if (!has(d.parcel_number)) add('info', 'parcel_number', 'No parcel number given. City Hall will look it up.');
}

// Reading answers the generic reader can't place.
const num = (s) => Number(String(s).replace(/,/g, ''));
const PHONE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

// "4 by 8 feet, both sides" → { ground_dimensions: '4 × 8 ft, two-sided', ground_sqft: 64 }. Inches are converted.
// count: number of signs, when one size is given for several. oneSide: area of one face of one sign.
export function signSize(text, count = 1) {
  const sizes = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*('|"|ft|feet|foot|in|inch|inches)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*('|"|ft|feet|foot|in|inch|inches)?/gi)];
  const twoSided = /\b(both|two|2|double)[\s-]*(sides?|sided|faces?|faced)\b|\bback[\s-]to[\s-]back\b/i.test(text);
  const total = String(text).match(/(\d[\d,]*(?:\.\d+)?)\s*(?:sq\.?\s*f(?:ee)?t|square\s*f(?:ee|oo)t|sf)\b/i);
  if (!sizes.length) return total ? { ground_sqft: num(total[1]) } : {};
  const inches = (u) => /^("|in)/i.test(u || '');
  const faces = sizes.map((m) => {
    const unitIn = inches(m[4]) || inches(m[2]);
    const w = num(m[1]) / (unitIn ? 12 : 1); const h = num(m[3]) / (unitIn ? 12 : 1);
    return { w, h, label: `${m[1]} × ${m[3]} ${unitIn ? 'in' : 'ft'}` };
  });
  const sides = twoSided ? 2 : 1;
  const each = faces.length === 1 && count > 1 ? count : 1;
  const area = faces.reduce((s, x) => s + x.w * x.h, 0) * sides * each;
  return {
    ground_dimensions: `${faces.map((x) => x.label).join(', ')}${twoSided ? ', two-sided' : ', one side'}`,
    ground_sqft: total ? num(total[1]) : Math.round(area * 100) / 100,
    oneSide: faces.length === 1 ? Math.round(faces[0].w * faces[0].h * 100) / 100 : undefined,
  };
}

// "front 32, side 1 12" → building_sqft_front 32, building_sqft_side1 12. One number alone is the front.
export function sideAreas(text) {
  const out = {};
  const parts = String(text).split(/[,;\n]|\band\b|\bplus\b/i);
  for (const p of parts) {
    let key = null; let rest = p;
    if (/\bside\s*(?:2|two)\b|\bright\b|\bsecond side\b/i.test(p)) { key = 'building_sqft_side2'; rest = p.replace(/\bside\s*(?:2|two)\b/i, ''); }
    else if (/\bside\b|\bleft\b/i.test(p)) { key = 'building_sqft_side1'; rest = p.replace(/\bside\s*(?:(?:1|one)\b)?/i, ''); }
    else if (/\bfront\b/i.test(p)) key = 'building_sqft_front';
    else if (/\b(rear|back)\b/i.test(p)) key = 'building_sqft_rear';
    const n = rest.match(/\d[\d,]*(?:\.\d+)?/);
    if (key && n) out[key] = num(n[0]);
  }
  if (!Object.keys(out).length) { const n = String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []; if (n.length === 1) out.building_sqft_front = num(n[0]); }
  return out;
}

// "Acme Signs, 601-555-1234, 12 Oak St, Wiggins, MS 39577" → name, phone, email and mailing address for one party.
function whoAndHow(prefix) {
  return (t) => {
    const out = {};
    const e = t.match(EMAIL); if (e) out[`${prefix}_email`] = e[0];
    const p = t.match(PHONE); if (p) out[`${prefix}_phone`] = p[0];
    const rest = t.replace(EMAIL, '').replace(PHONE, '');
    const a = rest.match(/\d+\s+[^,]+,\s*[^,]+,\s*[A-Za-z]{2}\.?\s+\d{5}(?:-\d{4})?/);
    const s = a && splitAddress(a[0]);
    if (s) Object.assign(out, { [`${prefix}_address`]: s.street, [`${prefix}_city`]: s.city, [`${prefix}_state`]: s.state, [`${prefix}_zip`]: s.zip });
    const name = rest.replace(a?.[0] || '', '').split(/[,;\n]/).map((x) => x.trim()).find(Boolean);
    if (name) out[`${prefix}_name`] = name.replace(/^(it'?s|it is|we use|the company is|name is|they are|their name is)\s+/i, '').replace(/[.]$/, '');
    return out;
  };
}

// Words that pick options in a multi-select answer.
const KIND_WORDS = { ground: /\b(ground|freestanding|free-standing|pole|monument|yard|post|both)\b/i, building: /\b(building|wall|awning|window|projecting|storefront|both)\b/i };
const TYPE_WORDS = { wall: /\bwall\b/i, projecting: /\bproject|\bhanging\b|\bblade\b/i, awning: /\bawning/i, window: /\bwindow/i, other: /\bother\b/i };
const pickMany = (words, t) => Object.entries(words).filter(([, re]) => re.test(t)).map(([k]) => k);

const parse = {
  sign_kinds: (t) => { const v = pickMany(KIND_WORDS, t); return v.length ? { sign_kinds: v } : {}; },
  building_types: (t) => { const v = pickMany(TYPE_WORDS, t); return v.length ? { building_types: v } : {}; },
  ground_size: (t, d) => { const { oneSide, ...out } = signSize(t, Number(d?.ground_count) || 1); return out; },
  building_area: (t) => sideAreas(t),
  lessee: whoAndHow('lessee'),
  contractor: whoAndHow('contractor'),
};

const SIGN_WORD = '(?:signs?|signage|billboard|marquee)\\b(?!\\s+(?:up\\s+for|in\\b|into\\b|off\\b|out\\b|the\\b|this\\b|that\\b|here\\b|my\\b|it\\b))';

export default defineForm({
  kind: 'sign', title: 'Sign permit application', short: 'Sign permit', code: 'SG', icon: 'sign',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/298',
  intro: 'Use this application to get a permit for a new sign in Wiggins, whether it stands on the ground (a pole or monument sign) or is mounted on a building.',
  detect: new RegExp(`\\bsign permit\\b|\\b(put(ting)?( up)?|hang(ing)?|install(ing)?|erect(ing)?|add(ing)?|new|replac(e|ing)|change|changing)\\b.{0,30}\\b${SIGN_WORD}|\\b(business|store|shop|church|monument|pole|wall|ground|neon|led|lighted|lit|electric|awning|window|yard|digital)\\s+${SIGN_WORD}`, 'i'),
  addressField: 'property_address', descriptionField: 'ground_description', nameField: 'business_name',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, derive, contact, fee, check, parse,
  fillable: ['parcel_number'],
  review: 'Compare the sign drawing with the size, height and lighting given, and the site plan with the setback from the right-of-way. For staff: sign area, height, number of signs and setback against the Land Development Code sign rules for the zoning district, and the street frontage.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is checking that it is complete'],
    in_review: ['Under review', 'The Land Code Administrator is checking the sign against the Land Development Code'],
    issued: ['Sign permit issued', 'Print the permit and keep it at the site until the final inspection'], closed: ['Closed', 'Final inspection passed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Review'], ['issued', 'Issued']],
  issue: {
    noun: 'permit', title: 'SIGN PERMIT', numberLabel: 'Permit number', action: 'Issue permit', post: true,
    after: 'Print the permit and post it at the site where it can be seen. For a ground sign, call City Hall to schedule the footing inspection before pouring concrete. Call for the final inspection when the sign is up. Any change to the sign needs an amended application.',
    inspections: ['Footing', 'Final'],
    rows: (app, label) => {
      const d = app.data;
      const kinds = d.sign_kinds || [];
      const area = signArea(d);
      return [
        ['Property address', app.screen?.matchedAddress || d.property_address], ['Parcel number', d.parcel_number], ['Zoning district', label(ZONES_UNSURE, d.zoning)],
        ['Business', d.business_name], ['Applicant', d.applicant_name], ['Property owner', d.owner_name], ['Lessee', d.has_lessee ? d.lessee_name : ''],
        ['Sign company', d.installer === 'contractor' ? d.contractor_name : d.installer === 'self' ? 'Installed by the applicant' : ''],
        ['Ground-mounted', kinds.includes('ground') ? `${d.ground_count || ''} sign(s) · ${d.ground_dimensions ? `${d.ground_dimensions} · ` : ''}${d.ground_sqft || ''} sq ft · ${d.ground_height || ''} ft tall · ${d.ground_setback ?? ''} ft from right-of-way · ${label(LIGHTING, d.ground_lighting)}` : ''],
        ['Building-mounted', kinds.includes('building') ? `${d.building_count || ''} sign(s) · ${(d.building_types || []).map((k) => (k === 'other' && d.building_types_other ? d.building_types_other : label(BUILDING_TYPES, k))).join(', ')} · ${area.building} sq ft · ${label(LIGHTING, d.building_lighting)}` : ''],
        ['Total sign area', area.total ? `${area.total} sq ft` : ''],
      ];
    },
  },
  nextSteps: ['Planning & Building checks that the application is complete.', "You'll be told the permit fee and how to pay it.",
    'The Land Code Administrator checks the sign against the Land Development Code.', "When it's approved, you download the permit and post it at the site.",
    'Call City Hall for the footing inspection (ground signs) and the final inspection when the sign is up.'],
  copyKeys: /^(applicant_|owner_|lessee_|contractor_|contact_pref|business_name)/,
});
