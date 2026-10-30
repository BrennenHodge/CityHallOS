// The variance application (Wiggins Planning Commission). A variance lets an owner depart from a Land Development Code
// rule, such as a setback, height or parking requirement, when something about the property makes the rule a hardship.
// The city's posted PDF text stops after page 2; the remaining pages follow the other Planning Commission forms (owner
// signature and agent affidavit, both notarized, applicant signature, required attachments), so they are modeled the same way.
import { ZONES_UNSURE, defineForm, f, matches, notaryAsk, ownerAndApplicant, ownerAsks, party, propertyDetails, signAsk, signFields } from '../engine.js';

export const VARIANCE_TYPES = [['front_setback', 'Front setback'], ['side_setback', 'Side setback'], ['rear_setback', 'Rear setback'], ['lot_width', 'Lot width'],
  ['lot_area', 'Lot area'], ['lot_coverage', 'Lot coverage'], ['building_height', 'Building height'], ['parking', 'Parking requirements'], ['buffer', 'Buffer'],
  ['sign_size', 'Sign size / height'], ['sign_placement', 'Sign placement'], ['off_premise_sign', 'Off-premise sign'], ['other', 'Other']];
export const REP_ROLES = [['owner', 'The property owner'], ['applicant', 'The applicant'], ['other', 'Someone else']];
export const DOC_KINDS = [['deed', 'Warranty deed'], ['site_plan', 'Site plan showing the variance'], ['location_map', 'Location map'], ['photo', 'Photos'], ['other', 'Other document']];

// Someone other than the owner presents the request, so the owner signs the agent affidavit.
const AGENT = { rep_role: ['applicant', 'other'] };
const NO_BUILD = 'None';
const NONE_LIKE = /^\s*(none|no|n\/?a|nothing|not applicable)\b/i;
const SETBACKS = ['front_setback', 'side_setback', 'rear_setback'];
const SIGNS = ['sign_size', 'sign_placement', 'off_premise_sign'];

// Keywords for reading a typed list of variance types without the AI.
const TYPE_WORDS = {
  front_setback: /\bfront\b/, side_setback: /\bside\b/, rear_setback: /\b(rear|back)\b/, lot_width: /\bwidth\b|\bwide\b/,
  lot_area: /\blot (area|size)\b|\btoo small\b/, lot_coverage: /\bcoverage\b/, building_height: /\b(height|tall|taller|high|higher)\b/,
  parking: /\bpark(ing)?\b/, buffer: /\bbuffer\b/, sign_size: /\b(size|height|big|bigger|tall|taller|large|larger)\b/,
  sign_placement: /\b(placement|place|location|where)\b/, off_premise_sign: /\boff[\s-]?(premise|premises|site)\b|\bbillboard\b/,
};

const SECTIONS = [
  { id: 'request', title: 'Variance requested', fields: [
    f('variance_types', 'Variance requested (check all that apply)', 'multi', { options: VARIANCE_TYPES, required: 'Choose at least one type of variance.',
      explain: 'Each type is a Land Development Code rule you are asking to depart from. Setbacks are the minimum distances from a building to the front, side and rear property lines. Lot width and lot area are the minimum size of a lot. Lot coverage is how much of the lot buildings may cover. Buffers are planted or open strips required between different uses. Sign variances cover a sign\'s size, height or location, or a sign on a property other than the business it advertises (off-premise).' }),
    f('variance_other', 'Other variance requested', 'text', { when: { variance_types: { has: 'other' } }, required: 'Describe the other variance you are asking for.' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('property_address', 'Property address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address of the property.' }),
    f('parcel_number', 'Tax parcel number', 'text', { optional: true, help: 'On your property tax bill or the county tax parcel card. Leave blank if you don\'t know it.',
      explain: 'The tax parcel number identifies the lot in Stone County\'s property records. It is printed on the property tax bill, the deed, or the county tax parcel card. If you don\'t have it, leave it blank and City Hall looks it up.' }),
    f('zoning', 'Zoning district', 'select', { options: ZONES_UNSURE, required: 'Choose the zoning district, or "Not sure".',
      explain: 'Every lot in Wiggins is in a zoning district (R-1 is single-family residential, C-2 is general commercial, and so on). The district sets the setbacks, height limits and other rules a variance departs from. If you don\'t know it, choose "Not sure" and the Land Code Administrator will confirm it.' }),
    f('existing_use', 'Existing use', 'text', { half: true, required: 'Say how the property is used today.', placeholder: 'e.g. Single-family home' }),
    f('proposed_use', 'Proposed use', 'text', { half: true, required: 'Say how the property will be used.', placeholder: 'e.g. Single-family home' }),
    ...propertyDetails(),
  ] },
  { id: 'reason', title: 'Reason for the request', fields: [
    f('new_structures', 'What buildings or structures will be built?', 'longtext', { required: 'Say what will be built, or "None".', placeholder: 'e.g. A 20 × 24 ft carport on the east side of the house' }),
    f('variance_aspects', 'What parts of your plan need a variance?', 'longtext', { required: 'Describe what part of your plan needs a variance.', placeholder: 'e.g. The carport would be 4 ft from the east property line. The R-1 side setback is 10 ft, so I need a 6 ft variance.',
      explain: 'Say which rule your plan doesn\'t meet, what the rule requires, and what you want instead, with numbers if you can. Example: "The carport would be 4 feet from the east property line. The R-1 side setback is 10 feet, so I am asking for a 6-foot variance."' }),
    f('variance_reason', 'Why is a variance needed to reasonably use the property?', 'longtext', { required: 'Explain why a variance is needed to reasonably use the property.',
      explain: 'The Planning Commission can grant a variance when something special about your property, such as an odd shape, a narrow or shallow lot, a slope, a ditch or an easement, makes following the rule a real hardship. Wanting more room or saving money usually isn\'t enough on its own, and a hardship you created yourself doesn\'t count. Say what is different about your lot, and that the variance is the smallest change that works. Example: "The lot is only 50 feet wide, narrower than most on the street, and a drainage easement runs along the west side. A 10-foot setback on the east leaves no room for a carport. Two neighbors\' carports already sit about 5 feet from the line."' }),
  ] },
  { id: 'owner', title: 'Owner & applicant', fields: ownerAndApplicant() },
  { id: 'hearing', title: 'Public hearing', fields: [
    f('rep_role', 'Who will present this application at the public hearing?', 'select', { options: REP_ROLES, required: 'Tell us who will present the application at the public hearing.',
      explain: 'The Planning Commission holds a public hearing on every variance request. Someone needs to be there to explain it and answer questions: the owner, the applicant, or someone else such as a contractor, engineer or attorney. If it is not the owner, the owner signs an affidavit naming that person as their agent.' }),
    ...party('rep', 'Representative at the hearing', { when: { rep_role: 'other' }, required: true, reach: true }),
  ] },
  { id: 'documents', title: 'Documents', fields: [
    f('files', 'Attachments', 'files', { kinds: DOC_KINDS }),
    f('bring_deed', "I'll bring the warranty deed to City Hall instead", 'check'),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: [
    f('agent_designation', 'Agent affidavit: I, the property owner, designate the representative named above as my agent to represent this application to the Wiggins Planning Commission, legally and fully acting on my behalf.', 'check', { when: AGENT,
      required: 'The owner must name the representative as their agent, or choose the owner to present at the hearing.',
      explain: 'When someone other than the owner presents the request, the owner signs this affidavit (in front of a notary, on the printed signature page) so the Planning Commission knows that person speaks for the owner.' }),
    ...signFields({
      notary: true,
      certify: 'I certify that the information in this application is true and correct. If I am the owner, I authorize this application to the Wiggins Planning Commission. If I am the applicant, I am applying with the owner\'s permission.',
    }),
  ] },
];

// Who presents the request, by name, for the chat.
const repName = (d) => (d.rep_role === 'other' ? d.rep_name || 'your representative' : d.applicant_name || 'the applicant');

const owner = ownerAsks();
const ASKS = [
  { id: 'proposal', fields: ['variance_aspects'], ai: true, prompt: 'Tell me about your plans and which rule gets in the way. For example: "I want to build a carport 4 feet from my side property line, but the rule is 10 feet."' },
  { id: 'variance_types', fields: ['variance_types'], ai: true, prompt: 'Which rules do you need a variance from? Pick all that apply.', choices: VARIANCE_TYPES },
  { id: 'variance_other', when: { variance_types: { has: 'other' } }, fields: ['variance_other'], prompt: 'What other rule do you need a variance from?' },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the street address of the property?" },
  { id: 'parcel_number', fields: ['parcel_number'], optional: true, prompt: "Do you know the tax parcel number? It's on the property tax bill. If not, tap \"I don't know\" and City Hall will look it up.", choices: [['__skip', "I don't know"]] },
  { id: 'zoning', fields: ['zoning'], prompt: 'Do you know the zoning district? If not, choose "Not sure" and the Land Code Administrator will confirm it.', choices: ZONES_UNSURE },
  { id: 'uses', fields: ['existing_use', 'proposed_use'], ai: true, prompt: 'How is the property used now, and how will it be used after? For example, "a home, and still a home".' },
  { id: 'new_structures', fields: ['new_structures'], prompt: 'What will you build? Give the size if you know it.', choices: [[NO_BUILD, 'Nothing new']] },
  { id: 'variance_reason', fields: ['variance_reason'], ai: true, prompt: 'This is the most important question. Why do you need the variance to reasonably use your property? What about your lot, like its shape, size, slope or an easement, makes the rule hard to follow?' },
  // Owner and applicant, plus the applicant's mailing address when the first answer didn't include it.
  ...owner.slice(0, 2),
  { id: 'applicant_mailing', when: { applicant_role: 'other' }, fields: ['applicant_address', 'applicant_city', 'applicant_state', 'applicant_zip'], ai: true, prompt: "What's your mailing address, including city, state and ZIP?" },
  ...owner.slice(2),
  { id: 'rep_role', when: { applicant_role: 'other' }, fields: ['rep_role'], prompt: 'The Planning Commission holds a public hearing on every request. Who will be there to present it and answer questions?', choices: [['owner', 'The owner'], ['applicant', 'I will'], ['other', 'Someone else']] },
  { id: 'rep_role_owner', when: { applicant_role: 'owner' }, fields: ['rep_role'], prompt: 'The Planning Commission holds a public hearing on every request. Will you present it there yourself, or will someone else?', choices: [['owner', 'I will'], ['other', 'Someone else']] },
  { id: 'rep', when: { rep_role: 'other' }, fields: ['rep_name'], ai: true, prompt: "What's the name of the person who will present it? Add their phone number or email if you have it." },
  { id: 'rep_contact', when: { rep_role: 'other' }, fields: ['rep_phone'], alt: ['rep_cell', 'rep_email'], ai: true, prompt: (d) => `What's a phone number or email for ${d.rep_name || 'them'}?` },
  { id: 'rep_mailing', when: { rep_role: 'other' }, fields: ['rep_address', 'rep_city', 'rep_state', 'rep_zip'], ai: true, prompt: (d) => `What's ${d.rep_name ? `${d.rep_name}'s` : 'their'} mailing address, including city, state and ZIP?` },
  { id: 'location', fields: ['street_side', 'between_streets'], optional: true, ai: true, prompt: 'Which side of the street is the property on, and which cross streets is it between? For example, "north side, between Pine St and Magnolia Dr".', choices: [['__skip', 'Skip']] },
  { id: 'subdivision', fields: ['subdivision', 'lot', 'block'], optional: true, ai: true, prompt: "Is the property in a subdivision? If so, what's the subdivision name, lot and block? They're on your deed.", choices: [['__skip', 'No, or not sure']] },
  { id: 'lot', fields: ['frontage', 'lot_depth'], alt: ['lot_size'], ai: true, prompt: 'How big is the lot? Give the width along the street and the depth in feet, like "100 by 150", or the size in acres. It\'s on your deed, plat or tax records.' },
  { id: 'existing_structures', fields: ['existing_structures'], prompt: "What buildings are on the property now? For example, \"a one-story house and a shed\".", choices: [['None (vacant lot)', "None, it's vacant"]] },
  { id: 'deed', fields: [], upload: ['deed'], done: (d, files) => files.some((x) => x.kind === 'deed') || !!d.bring_deed,
    prompt: 'Now the attachments. First, a copy of the warranty deed for the property. A phone photo is fine.', choices: [['__bring', "I'll bring it to City Hall"]] },
  { id: 'site_plan', fields: [], upload: ['site_plan'], done: (d, files, asked) => files.some((x) => x.kind === 'site_plan') || asked.includes('site_plan'),
    prompt: 'Next, a site plan: a drawing of the lot showing the property lines, the buildings (existing and new), and the distances the variance is about, like how far the carport is from the side line. A neat hand drawing with measurements is a good start.', choices: [['__skip', "I'll add it later"]] },
  { id: 'location_map', fields: [], upload: ['location_map', 'photo', 'other'], done: (d, files, asked) => files.some((x) => x.kind === 'location_map') || asked.includes('location_map'),
    prompt: 'Last, a location map showing where the property is, such as a map printout with the property marked. Photos of the spot help too.', choices: [['__skip', "I'll add it later"]] },
  { id: 'agent_designation', when: AGENT, fields: ['agent_designation'], prompt: (d) => `Because ${repName(d)} will present the request, the owner has to name them as the agent in a short affidavit. Does ${d.owner_name || 'the owner'} designate ${repName(d)} to act for them before the Planning Commission?`, choices: [['yes', 'Yes, the owner agrees']] },
  { ...notaryAsk, prompt: (d) => (matches(AGENT, d) ? "The owner's signature and the agent affidavit both have to be notarized. After you submit, print the signature pages (the PDF button), have the owner sign them in front of a notary, then bring them to City Hall or upload a photo here. Okay?" : notaryAsk.prompt) },
  signAsk(),
];

// Fills values that follow from other answers. Only fills blanks, so anything the applicant typed wins.
function derive(out) {
  const w = Number(out.frontage); const dp = Number(out.lot_depth);
  if (w > 0 && dp > 0 && (out.lot_size == null || out.lot_size === '')) out.lot_size = `About ${Math.round(w * dp).toLocaleString()} sq ft`;
  if ((out.proposed_use == null || out.proposed_use === '') && out.existing_use && /\b(same|no change|still)\b/i.test(out.existing_use)) out.proposed_use = out.existing_use;
  return out;
}

function check(d, ctx, { add, has }) {
  const kinds = new Set((ctx.files || []).map((x) => x.kind));
  const types = Array.isArray(d.variance_types) ? d.variance_types : [];
  if (d.rep_role === 'applicant' && d.applicant_role !== 'other') add('error', 'rep_role', 'You said the owner is filling out this application, so there is no separate applicant. Choose the owner or someone else to present at the hearing.');
  if (types.some((t) => SETBACKS.includes(t)) && has(d.variance_aspects) && !/\d/.test(d.variance_aspects)) {
    add('warning', 'variance_aspects', 'Give the distances for the setback variance: how far the building will be from the property line, and what the rule requires.');
  }
  if (has(d.variance_reason) && String(d.variance_reason).trim().length < 40) add('warning', 'variance_reason', 'Your reason for the variance is very short. Explain what about the property makes the rule a hardship. This is what the Planning Commission decides on.');
  if (has(d.variance_reason) && /\b(cheaper|cost(s)? (less|too much)|save money|more room|bigger|want(ed)? more)\b/i.test(d.variance_reason) && !/\b(lot|shape|narrow|shallow|slope|ditch|easement|drain|irregular|odd|corner|tree|creek|flood)\b/i.test(d.variance_reason)) {
    add('info', 'variance_reason', 'The reason given is mostly about cost or wanting more space. Variances are usually granted for conditions of the property itself, such as its shape, size or slope. Staff may ask for more.');
  }
  if (!has(d.frontage) && !has(d.lot_size)) add('warning', 'frontage', 'Add the lot frontage and depth, or the size of the property. They are on the deed, plat or tax records.');
  if (types.includes('lot_width') && !has(d.frontage)) add('warning', 'frontage', 'Add the lot frontage. A lot width variance is measured from it.');
  if (types.includes('lot_area') && !has(d.lot_size)) add('warning', 'lot_size', 'Add the size of the property. A lot area variance is measured from it.');
  if (!has(d.existing_structures)) add('warning', 'existing_structures', 'List the buildings on the property now, or say it is vacant.');
  if (!has(d.zoning) || d.zoning === 'unknown') add('info', 'zoning', 'Zoning district not given. The Land Code Administrator will confirm it and the rule the variance departs from.');
  if (!has(d.parcel_number)) add('warning', 'parcel_number', 'Add the tax parcel number if you have it. Otherwise City Hall looks it up, which can slow the review.');

  if (!kinds.has('deed')) {
    if (d.bring_deed) add('warning', 'files', 'The warranty deed will be brought to City Hall. The application is complete once it is received.');
    else add('error', 'files', 'Attach a copy of the warranty deed, or check that you will bring it to City Hall.');
  }
  if (!kinds.has('site_plan')) add('warning', 'files', `Attach a site plan showing the property lines, the buildings, and ${types.some((t) => SIGNS.includes(t)) ? 'where the sign will go and its size' : 'the distances the variance is about'}.`);
  if (!kinds.has('location_map')) add('warning', 'files', 'Attach a location map showing where the property is.');
  if (has(d.new_structures) && NONE_LIKE.test(d.new_structures) && types.some((t) => SETBACKS.includes(t) || t === 'building_height' || t === 'lot_coverage')) {
    add('info', 'new_structures', 'A setback, height or lot coverage variance was requested, but nothing new will be built. If it is for an existing building, say so in the reason.');
  }

  const sc = ctx.screen;
  if (sc?.flood?.checked && sc.flood.sfha) {
    add('warning', 'property_address', `FEMA maps show this property in flood zone ${sc.flood.zone}. New construction will also need a floodplain development permit, and a variance cannot waive flood elevation rules.`);
  }
}

// Answers the generic reader can't place: several variance types typed at once, side of the street and cross streets,
// subdivision lot and block, lot size.
const num = (s) => Number(String(s).replace(/,/g, ''));
const parse = {
  variance_types: (t) => {
    const low = t.toLowerCase();
    const sign = /\bsign|billboard/.test(low);
    const building = /\b(building|house|home|garage|carport|roof|structure)\b/.test(low);
    const hits = VARIANCE_TYPES.filter(([v, l]) => {
      if (v !== 'other' && low.includes(l.toLowerCase())) return true;
      if (!TYPE_WORDS[v]?.test(low)) return false;
      // Size and placement words mean a sign variance only when a sign is mentioned, and height means the building's
      // height unless it's only about a sign.
      if (SIGNS.includes(v)) return sign;
      if (v === 'building_height') return !sign || building;
      return true;
    }).map(([v]) => v);
    return hits.length ? { variance_types: hits } : {};
  },
  location: (t) => {
    const side = t.match(/\b(north|south|east|west)\b/i);
    const btw = t.match(/\bbetween\s+(.+?)\.?\s*$/i);
    return { street_side: side?.[1].toLowerCase(), between_streets: btw?.[1] };
  },
  subdivision: (t) => {
    const lot = t.match(/\blot\s*(?:#|no\.?|number)?\s*([\w-]+)/i);
    const block = t.match(/\bblock\s*(?:#|no\.?|number)?\s*([\w-]+)/i);
    const name = t.replace(lot?.[0] || '', '').replace(block?.[0] || '', '').replace(/\b(subdivision|it'?s|the|in|is|yes)\b|[,;.]/gi, ' ').replace(/\s+/g, ' ').trim();
    return { subdivision: name || undefined, lot: lot?.[1], block: block?.[1] };
  },
  lot: (t) => {
    const out = {};
    const wl = t.match(/(\d[\d,]*(?:\.\d+)?)\s*(?:'|ft|feet|foot)?\s*(?:x|×|by)\s*(\d[\d,]*(?:\.\d+)?)/i);
    if (wl) { out.frontage = num(wl[1]); out.lot_depth = num(wl[2]); }
    const size = t.match(/(\d+\/\d+|\d[\d,]*(?:\.\d+)?)\s*(acres?|ac\b|sq\.?\s*ft|square feet)/i);
    if (size) out.lot_size = size[0];
    return out;
  },
};

export default defineForm({
  kind: 'variance', title: 'Variance application', short: 'Variance', code: 'VA', icon: 'ruler',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/290',
  intro: 'A variance lets you depart from a zoning rule, like building closer to a property line or taller than allowed, when something about your property makes the rule a hardship. The request goes to a public hearing before the Wiggins Planning Commission.',
  detect: /\bvariances?\b|\b(closer|nearer)\b.{0,30}\b(property|lot|side|rear|back|front) ?line\b|\bsetback\b.{0,40}\b(too|less|smaller|reduce|waive|exception|closer)\b|\b(too|less|smaller|reduce|waive|exception)\b.{0,40}\bsetback\b|\b(taller|higher|bigger)\b.{0,30}\bthan (allowed|the (code|rule|ordinance) allows|permitted)\b/i,
  addressField: 'property_address', descriptionField: 'variance_aspects',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, derive, check, parse,
  fillable: ['parcel_number', 'subdivision', 'lot', 'block'],
  review: 'Compare the uploaded deed with the owner name and property address, and check that the site plan actually shows the property lines and the distances or dimensions the variance is about. For staff: the Land Development Code section(s) the variance departs from, the amount of relief requested, whether the hardship comes from the property itself rather than the owner\'s choices, and floodplain.',
  statuses: {
    submitted: ['Submitted', 'The Land Code Administrator is checking that it is complete'],
    in_review: ['Scheduled for Planning Commission', 'The Planning Commission will hold a public hearing'],
    issued: ['Approved', 'The variance was approved'], closed: ['Closed', 'This application is closed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Hearing'], ['issued', 'Decision']],
  issue: {
    noun: 'approval', title: 'VARIANCE APPROVAL', numberLabel: 'Approval number', action: 'Record approval', post: false, inspections: null,
    after: 'The variance covers only what was approved here, with any conditions. Keep this letter, and apply for a construction permit (or sign permit) before starting work.',
    rows: (app, label) => {
      const d = app.data;
      const types = (d.variance_types || []).map((k) => (k === 'other' ? d.variance_other || 'Other' : label(VARIANCE_TYPES, k))).join(', ');
      return [
        ['Property', app.screen?.matchedAddress || d.property_address], ['Tax parcel', d.parcel_number], ['Zoning district', label(ZONES_UNSURE, d.zoning)],
        ['Variance', types], ['Details', d.variance_aspects], ['Construction', d.new_structures], ['Owner', d.owner_name],
      ];
    },
  },
  nextSteps: ['The Land Code Administrator checks that the application and attachments are complete.', "You'll be told how to pay the $200 filing fee.",
    'Print the signature page, have the owner sign it in front of a notary, and bring it to City Hall or upload a photo.',
    'The Planning Commission sets a public hearing date, and City Hall gives public notice of the hearing.',
    'At the hearing, you or your representative explain the request, and neighbors can speak.',
    'The Planning Commission makes its decision or recommendation, and you get the result here.'],
  copyKeys: /^(owner_|applicant_|rep_|contact_pref)/,
});
