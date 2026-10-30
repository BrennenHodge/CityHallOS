// The zoning amendment application for an individual property (Wiggins Planning Commission): asking the city to change
// the zoning district a property is in, for example from R-1 residential to C-2 commercial. The owner's signature (and
// the agent affidavit, when someone else presents the request) must be notarized, so the app collects everything online
// and the resident brings or uploads the notarized signature page.
import { ZONES, ZONES_UNSURE, defineForm, f, matches, notaryAsk, ownerAndApplicant, ownerAsks, party, propertyDetails, signAsk, signFields } from '../engine.js';

export const REP_ROLES = [['owner', 'The property owner'], ['applicant', 'The applicant'], ['other', 'Someone else']];
export const DOC_KINDS = [['deed', 'Warranty deed'], ['zoning_map', 'Zoning map with the change marked'], ['location_map', 'Location map'], ['evidence', 'Evidence for the hearing'], ['other', 'Other document']];

// Someone other than the owner presents the request, so the owner signs the agent affidavit.
const AGENT = { rep_role: ['applicant', 'other'] };
const NO_BUILD = 'None';
const NO_CHANGES = 'None';
// The answer to standard A when the request isn't about a mapping error, and answers that say "nothing".
const NOT_AN_ERROR = 'Not applicable: this request is not based on an error in the zoning map.';
const NONE_LIKE = /^\s*(none|no|n\/?a|nothing|not applicable|no changes?)\b/i;

// The Planning Commission's findings (Standards of Review A-G): [key, label, short name, chat prompt, explain].
export const STANDARDS = [
  ['std_error', 'A. If the request is because of an error in the zoning map, explain why the current zoning is wrong', 'zoning map error',
    'Now the Planning Commission\'s questions. Before it can recommend a zoning change, it has to make findings on 7 standards, and your answers help it decide. A few sentences each is plenty.\n\nFirst: is the current zoning a mistake on the map? If so, why? If not, tap the button.',
    'Sometimes a lot was given the wrong zone when the map was drawn, for example a long-time store mapped as residential. If that is your reason, explain the mistake. If not, say so; most requests are based instead on changes in the area (the next question). Example: "The building has been a grocery store since 1965, but the 2009 map shows it as R-1."'],
  ['std_changes', 'B. Changes in the area since the Official Zoning Map was adopted that support a change in zoning', 'changes in the area',
    '2 of 7: What has changed in the area since the zoning map was adopted that supports the new zone? For example, new roads, new businesses, or more traffic.',
    'Mississippi law generally allows a rezoning when the original zoning was a mistake, or when the character of the neighborhood has changed and there is a public need for the new zone. List what has changed nearby: new or widened roads, new businesses or subdivisions, other rezonings, more traffic. Example: "Highway 26 was widened to four lanes in 2019. Since then a gas station, a bank and a clinic have opened on this block, and the houses facing the highway are now hard to live in because of traffic."'],
  ['std_utilities', 'C. Are city utilities and sewer adequate for the uses allowed in the proposed zone?', 'utilities and sewer',
    '3 of 7: Do city water and sewer reach the property, and are they enough for the kinds of uses the new zone allows?',
    'Say whether the property has city water and sewer, and whether they can handle the uses the new zone allows, not just your plan. If you don\'t know, say what is there now; City Hall checks capacity. Example: "The property has city water and an 8-inch sewer line along the highway, which serves the businesses next door."'],
  ['std_character', 'D. Why the change will not hurt the character of the neighborhood or lower property values', 'neighborhood and property values',
    '4 of 7: Why won\'t the change hurt the neighborhood or lower nearby property values?',
    'Explain why the new zone fits with what is around it and won\'t lower neighbors\' property values: similar uses nearby, buffers or fences, keeping traffic off residential streets. Example: "The lots on both sides are already commercial. The back of the lot borders a church parking lot, not homes, and the driveway is on the highway."'],
  ['std_plan', 'E. How the change generally conforms with the comprehensive plan and other official plans', 'comprehensive plan',
    '5 of 7: How does the change fit the city\'s comprehensive plan? If you\'re not sure, tell me what you know about the area and why the new zone belongs there.',
    'The comprehensive plan is the city\'s long-range plan for how land in Wiggins should be used, including a future land use map. City Hall can show it to you. Say how the new zone fits it, or describe the area and why the zone belongs there. Example: "The future land use map shows this stretch of Highway 26 as commercial."'],
  ['std_services', 'F. How the proposed zone is appropriate for transportation, fire and police protection, waste disposal and similar services', 'roads and public services',
    '6 of 7: Is the site well served by roads, fire and police, and garbage pickup for the uses the new zone allows?',
    'Say how the site is served: the street it is on and how much traffic it can carry, how close the fire station is, and garbage pickup. Example: "The lot fronts Highway 26, a four-lane state highway, and is a mile from the fire station."'],
  ['std_connect', 'G. How the proposed zone physically connects to other areas already in the same zone', 'connection to the same zone',
    'Last one: does the new zone connect to land that already has that zone? For example, is the lot next door or across the street already zoned that way?',
    'The Planning Commission avoids "spot zoning": one lot zoned differently from everything around it. Say whether property next to, behind or across the street from yours already has the zone you are asking for. Example: "The lots on both sides along Highway 26 are already C-2, so this would extend the existing C-2 strip."'],
];

const SECTIONS = [
  { id: 'request', title: 'Proposed amendment', fields: [
    f('zoning', 'The property is now zoned', 'select', { options: ZONES_UNSURE, required: 'Choose the current zoning, or "Not sure".',
      explain: 'Every lot in Wiggins is in a zoning district (R-1 is single-family residential, C-2 is general commercial, and so on). The district decides what the property can be used for. If you don\'t know the current zone, choose "Not sure" and the Land Code Administrator will confirm it. The zoning map is on the city\'s website under Planning & Building.' }),
    f('proposed_zone', 'The proposed zone', 'select', { options: ZONES, required: 'Choose the zone you want the property changed to.',
      explain: 'The zone you are asking for. Pick the district that allows what you want to do. The Land Code Administrator can tell you which districts allow your use before you apply.' }),
    f('proposed_use', 'The proposed use of this property', 'longtext', { required: 'Describe how you want to use the property after the change.', placeholder: 'e.g. A small office building for an insurance agency' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('property_address', 'Property address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address of the property.' }),
    f('parcel_number', 'Tax parcel number', 'text', { optional: true, help: 'On your property tax bill or the county tax parcel card. Leave blank if you don\'t know it.',
      explain: 'The tax parcel number identifies the lot in Stone County\'s property records. It is printed on the property tax bill, the deed, or the county tax parcel card. If you don\'t have it, leave it blank and City Hall looks it up.' }),
    f('existing_use', 'Existing use', 'text', { required: 'Say how the property is used today.', placeholder: 'e.g. Single-family home, or vacant lot' }),
    ...propertyDetails(),
    f('new_structures', 'What buildings or structures will be built?', 'longtext', { required: 'Say what will be built, or "None".', placeholder: 'e.g. None for now, or a 2,400 sq ft office building' }),
    f('other_changes', 'What other changes will be made to the property?', 'longtext', { required: 'List any other changes, or "None".', placeholder: 'e.g. Pave a 10-space parking lot and add a driveway onto the highway' }),
  ] },
  { id: 'owner', title: 'Owner & applicant', fields: ownerAndApplicant() },
  { id: 'hearing', title: 'Public hearing', fields: [
    f('rep_role', 'Who will present this application at the public hearing?', 'select', { options: REP_ROLES, required: 'Tell us who will present the application at the public hearing.',
      explain: 'The Planning Commission holds a public hearing on every zoning change. Someone needs to be there to explain it and answer questions: the owner, the applicant, or someone else such as an engineer or attorney. If it is not the owner, the owner signs an affidavit naming that person as their agent.' }),
    ...party('rep', 'Representative at the hearing', { when: { rep_role: 'other' }, required: true, reach: true }),
  ] },
  { id: 'standards', title: 'Standards of review', fields: STANDARDS.map(([key, label, short, , explain]) => f(key, label, 'longtext', { required: `Answer standard ${label[0]} (${short}).`, explain })) },
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
  { id: 'proposal', fields: ['proposed_use'], ai: true, prompt: 'Tell me what you\'d like to do with the property once the zoning is changed. For example, "open a small insurance office".' },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the street address of the property?" },
  { id: 'parcel_number', fields: ['parcel_number'], optional: true, prompt: "Do you know the tax parcel number? It's on the property tax bill. If not, tap \"I don't know\" and City Hall will look it up.", choices: [['__skip', "I don't know"]] },
  { id: 'zoning', fields: ['zoning'], prompt: 'How is the property zoned now? If you\'re not sure, choose "Not sure" and the Land Code Administrator will confirm it.', choices: ZONES_UNSURE },
  { id: 'proposed_zone', fields: ['proposed_zone'], prompt: 'Which zone would you like it changed to?', choices: ZONES },
  { id: 'existing_use', fields: ['existing_use'], prompt: 'How is the property used today? For example, a home, a store, or a vacant lot.' },
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
  { id: 'new_structures', fields: ['new_structures'], prompt: 'Do you plan to build anything new? If so, what and about how big?', choices: [[NO_BUILD, 'Nothing new']] },
  { id: 'other_changes', fields: ['other_changes'], prompt: 'Any other changes to the property, like parking, a driveway, fencing or a sign?', choices: [[NO_CHANGES, 'No other changes']] },
  ...STANDARDS.map(([key, , , prompt]) => ({ id: key, fields: [key], ai: true, prompt, ...(key === 'std_error' ? { choices: [[NOT_AN_ERROR, "It's not a map error"]] } : {}) })),
  { id: 'deed', fields: [], upload: ['deed'], done: (d, files) => files.some((x) => x.kind === 'deed') || !!d.bring_deed,
    prompt: 'Now the attachments. First, a copy of the warranty deed for the property. A phone photo is fine.', choices: [['__bring', "I'll bring it to City Hall"]] },
  { id: 'zoning_map', fields: [], upload: ['zoning_map'], done: (d, files, asked) => files.some((x) => x.kind === 'zoning_map') || asked.includes('zoning_map'),
    prompt: 'Next, a copy of the city\'s latest zoning map with your property and the proposed change marked on it. The map is on the city\'s website under Planning & Building. A printout you marked up and photographed is fine.', choices: [['__skip', "I'll add it later"]] },
  { id: 'location_map', fields: [], upload: ['location_map'], done: (d, files, asked) => files.some((x) => x.kind === 'location_map') || asked.includes('location_map'),
    prompt: 'Then a location map showing where the property is, such as a map printout with the property marked.', choices: [['__skip', "I'll add it later"]] },
  { id: 'evidence', fields: [], upload: ['evidence', 'other'], done: (d, files, asked) => files.some((x) => ['evidence', 'other'].includes(x.kind)) || asked.includes('evidence'),
    prompt: 'Anything else you want the Planning Commission to see at the hearing, like photos, letters of support from neighbors, or a traffic study? Upload it here.', choices: [['__skip', 'Nothing else']] },
  { id: 'agent_designation', when: AGENT, fields: ['agent_designation'], prompt: (d) => `Because ${repName(d)} will present the request, the owner has to name them as the agent in a short affidavit. Does ${d.owner_name || 'the owner'} designate ${repName(d)} to act for them before the Planning Commission?`, choices: [['yes', 'Yes, the owner agrees']] },
  { ...notaryAsk, prompt: (d) => (matches(AGENT, d) ? "The owner's signature and the agent affidavit both have to be notarized. After you submit, print the signature pages (the PDF button), have the owner sign them in front of a notary, then bring them to City Hall or upload a photo here. Okay?" : notaryAsk.prompt) },
  signAsk(),
];

// Fills values that follow from other answers. Only fills blanks, so anything the applicant typed wins.
function derive(out) {
  const w = Number(out.frontage); const dp = Number(out.lot_depth);
  if (w > 0 && dp > 0 && (out.lot_size == null || out.lot_size === '')) out.lot_size = `About ${Math.round(w * dp).toLocaleString()} sq ft`;
  return out;
}

function check(d, ctx, { add, has }) {
  const kinds = new Set((ctx.files || []).map((x) => x.kind));
  if (has(d.proposed_zone) && d.proposed_zone === d.zoning) add('error', 'proposed_zone', `The proposed zone is the same as the current zoning (${d.zoning}). Choose the zone you want the property changed to.`);
  if (d.rep_role === 'applicant' && d.applicant_role !== 'other') add('error', 'rep_role', 'You said the owner is filling out this application, so there is no separate applicant. Choose the owner or someone else to present at the hearing.');
  // Mississippi courts uphold a rezoning on a mistake in the original zoning, or a change in the neighborhood's character
  // plus a public need. If both answers say "none", the request has nothing to stand on yet.
  const noError = !has(d.std_error) || NONE_LIKE.test(d.std_error);
  if (noError && has(d.std_changes) && NONE_LIKE.test(d.std_changes)) {
    add('warning', 'std_changes', 'A zoning change needs either a mistake in the current zoning (standard A) or changes in the area that support the new zone (standard B). Describe what has changed nearby, such as new roads, businesses or rezonings.');
  }
  for (const [k, lbl, short] of STANDARDS) {
    if (k === 'std_error' && has(d[k]) && NONE_LIKE.test(d[k])) continue;
    if (has(d[k]) && String(d[k]).trim().length < 25) add('warning', k, `Your answer to standard ${lbl[0]} (${short}) is very short. Add a sentence or two so the Planning Commission can make its finding.`);
  }
  if (!has(d.frontage) && !has(d.lot_size)) add('warning', 'frontage', 'Add the lot frontage and depth, or the size of the property. They are on the deed, plat or tax records.');
  if (!has(d.existing_structures)) add('warning', 'existing_structures', 'List the buildings on the property now, or say it is vacant.');
  if (!has(d.zoning) || d.zoning === 'unknown') add('info', 'zoning', `Current zoning not given. The Land Code Administrator will confirm it${has(d.proposed_zone) ? ` before the request to rezone to ${d.proposed_zone} goes forward` : ''}.`);
  if (!has(d.parcel_number)) add('warning', 'parcel_number', 'Add the tax parcel number if you have it. Otherwise City Hall looks it up, which can slow the review.');

  if (!kinds.has('deed')) {
    if (d.bring_deed) add('warning', 'files', 'The warranty deed will be brought to City Hall. The application is complete once it is received.');
    else add('error', 'files', 'Attach a copy of the warranty deed, or check that you will bring it to City Hall.');
  }
  if (!kinds.has('zoning_map')) add('warning', 'files', `Attach a copy of the latest zoning map with the property and the proposed change${has(d.proposed_zone) ? ` to ${d.proposed_zone}` : ''} marked on it.`);
  if (!kinds.has('location_map')) add('warning', 'files', 'Attach a location map showing where the property is.');

  const sc = ctx.screen;
  if (sc?.flood?.checked && sc.flood.sfha) {
    add('warning', 'property_address', `FEMA maps show this property in flood zone ${sc.flood.zone}. Any new building or fill will need a floodplain development permit, and the Planning Commission may ask about flooding.`);
  }
}

// Answers the generic reader can't place: side of the street and cross streets, subdivision lot and block, lot size.
const num = (s) => Number(String(s).replace(/,/g, ''));
const parse = {
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
  kind: 'rezoning', title: 'Zoning amendment application', short: 'Rezoning', code: 'RZ', icon: 'map',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/291',
  intro: 'A zoning amendment (rezoning) asks the city to change the zoning district your property is in, for example from residential to commercial. The request goes to a public hearing before the Wiggins Planning Commission.',
  detect: /\b(re-?zon\w*|zoning (amendment|change|map amendment))\b|\bchange\b.{0,30}\bzon(e|ing)\b|\bzon(e|ed|ing)\b.{0,30}\b(changed|change it|to commercial|to residential|as commercial)\b/i,
  addressField: 'property_address', descriptionField: 'proposed_use',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, derive, check, parse,
  fillable: ['parcel_number', 'subdivision', 'lot', 'block'],
  review: 'Compare the uploaded deed with the owner name and property address, and check that the marked-up zoning map shows this property and the requested zone. For staff: whether the requested zone allows the proposed use, whether the request rests on a map error or real changes in the area (standards A and B), adjacency to the same zone (spot zoning), utility capacity, and floodplain.',
  statuses: {
    submitted: ['Submitted', 'The Land Code Administrator is checking that it is complete'],
    in_review: ['Scheduled for Planning Commission', 'The Planning Commission will hold a public hearing'],
    issued: ['Approved', 'The zoning change was approved'], closed: ['Closed', 'This application is closed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Hearing'], ['issued', 'Decision']],
  issue: {
    noun: 'approval', title: 'ZONING AMENDMENT APPROVAL', numberLabel: 'Approval number', action: 'Record approval', post: false, inspections: null,
    after: 'Keep this letter. The new zone will be shown on the Official Zoning Map. Before you build or change anything on the property, apply for a construction permit (and a sign permit for any sign).',
    rows: (app, label) => {
      const d = app.data;
      return [
        ['Property', app.screen?.matchedAddress || d.property_address], ['Tax parcel', d.parcel_number],
        ['Zoning change', `${label(ZONES_UNSURE, d.zoning)} to ${label(ZONES, d.proposed_zone)}`], ['Proposed use', d.proposed_use], ['Owner', d.owner_name],
      ];
    },
  },
  nextSteps: ['The Land Code Administrator checks that the application and attachments are complete.', "You'll be told how to pay the $200 zoning amendment fee.",
    'Print the signature page, have the owner sign it in front of a notary, and bring it to City Hall or upload a photo.',
    'The Planning Commission sets a public hearing date, and City Hall gives public notice of the hearing.',
    'At the hearing, you or your representative explain the request, and neighbors can speak.',
    'The Planning Commission makes its recommendation, and you get the decision here.'],
  copyKeys: /^(owner_|applicant_|rep_|contact_pref)/,
});
