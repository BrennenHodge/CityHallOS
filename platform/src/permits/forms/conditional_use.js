// The conditional use permit application (Wiggins Planning Commission). A conditional use is one the zoning district
// allows only after a public hearing, such as a daycare, church or small business in a residential area. The owner's
// signature (and the agent affidavit, when someone else presents the request) must be notarized, so the app collects
// everything online and the resident brings or uploads the notarized signature page.
import { ZONES_UNSURE, defineForm, f, matches, notaryAsk, ownerAndApplicant, ownerAsks, party, propertyDetails, signAsk, signFields } from '../engine.js';

export const REP_ROLES = [['owner', 'The property owner'], ['applicant', 'The applicant'], ['other', 'Someone else']];
export const DOC_KINDS = [['deed', 'Warranty deed'], ['site_plan', 'Site plan (stamped)'], ['floor_plan', 'Floor plans and elevations'], ['location_map', 'Location map'], ['other', 'Other document']];

// Someone other than the owner presents the request, so the owner signs the agent affidavit.
const AGENT = { rep_role: ['applicant', 'other'] };
// The "nothing new" answers given by the choice buttons.
const NO_BUILD = 'None';
const NO_CHANGES = 'None';
const NONE_LIKE = /^\s*(none|no|n\/?a|nothing|not applicable)\b/i;

// The Planning Commission's findings (Standards of Review A-G): [key, label, short name, chat prompt, explain].
export const STANDARDS = [
  ['std_safety', 'A. The use will not endanger public health or safety', 'public health and safety',
    'Now the Planning Commission\'s questions. Before it can approve a conditional use, it has to find that the use meets 7 standards, and your answers help it decide. A few sentences each is plenty.\n\nFirst: how will your use stay safe for neighbors and the public?',
    'Tell the Planning Commission why the use is safe for neighbors and the public: no dangerous materials, no unusual noise, fumes or crowds, and it will meet fire and building codes. Example: "The daycare will be licensed by the Mississippi State Department of Health, with smoke detectors, two exits and a fenced play yard. No hazardous materials are used or stored."'],
  ['std_need', 'B. The use is reasonably needed for public health or general welfare, for example by helping the area work well or providing a needed service', 'community need',
    '2 of 7: How does the community benefit? For example, is it a service people nearby need, or does it bring jobs?',
    'Explain how Wiggins benefits: a service people nearby need, something the area is missing, or jobs. Example: "Both daycares in Wiggins have waiting lists. Working parents on the north side need care close to home, and the daycare will employ three people."'],
  ['std_values', 'C. The use will not substantially hurt the value of neighboring property', 'neighboring property values',
    '3 of 7: Why won\'t it lower the value of the properties around it?',
    'Say why neighbors\' property values won\'t drop: the building keeps its look, the lot will be kept up, and activity is quiet and limited to set hours. Example: "The house will look the same from the street. There is no outdoor sign, and parking fits in the existing driveway."'],
  ['std_harmony', 'D. The use fits the scale, size, lot coverage, density and character of the neighborhood', 'fits the neighborhood',
    '4 of 7: How does it fit the size and feel of the neighborhood?',
    'Compare your plan with what is around it: the size of buildings, how much of the lot is covered, how many people will be there, and the look of the area. Example: "No new buildings. The use stays inside the existing 1,800 sq ft house, which is the same size as the other homes on the street."'],
  ['std_plan', 'E. The use generally conforms with the comprehensive plan and other official plans', 'comprehensive plan',
    '5 of 7: How does it fit the city\'s comprehensive plan? If you\'re not sure, tell me what you know about the area and why this use belongs there.',
    'The comprehensive plan is the city\'s long-range plan for how land in Wiggins should be used. City Hall can show it to you. Say how your use fits it, or describe the area and why the use belongs there. Example: "The plan calls for neighborhood services near homes. This lot is on a busy street a few blocks from downtown, next to a church and an insurance office."'],
  ['std_services', 'F. The site is well located for roads, water, fire and police protection, waste disposal and similar services', 'roads and public services',
    '6 of 7: Is the site well served by roads, city water and sewer, garbage pickup, and fire and police?',
    'Say how the site is served: the street it is on, city water and sewer, garbage pickup, and how close the fire station is. Example: "The property is on Highway 49 with city water and sewer and weekly garbage pickup. The fire station is half a mile away."'],
  // The city's form reads "will create undue traffic congestion"; the finding the commission makes is that it will not.
  ['std_traffic', 'G. The use will not create undue traffic congestion or a traffic hazard', 'traffic',
    'Last one: how much traffic will it bring, and where will people park?',
    'Estimate how many cars a day the use will bring, when, where they will park, and why it is safe. Example: "About 10 parents drop off between 6 and 8 am and pick up between 4 and 6 pm. The circular driveway holds 4 cars, so no one parks on the street."'],
];

const SECTIONS = [
  { id: 'request', title: 'Proposed use', fields: [
    f('proposed_use', 'The proposed use of this property', 'longtext', { required: 'Describe how you want to use the property.', placeholder: 'e.g. A home daycare for up to 12 children, Monday to Friday, 6 am to 6 pm',
      explain: 'A conditional use is a use the zoning district allows only with Planning Commission approval, such as a daycare, church or small business in a residential area. Describe what you want to do: what the business or activity is, the hours, how many people will come and go, and any employees.' }),
    f('existing_use', 'Existing use', 'text', { required: 'Say how the property is used today.', placeholder: 'e.g. Single-family home, or vacant lot' }),
    f('zoning', 'Zoning district the property is in', 'select', { options: ZONES_UNSURE, required: 'Choose the zoning district, or "Not sure".',
      explain: 'Every lot in Wiggins is in a zoning district (R-1 is single-family residential, C-2 is general commercial, and so on). Each district lists the uses allowed outright and the uses allowed only as a conditional use. If you don\'t know the district, choose "Not sure" and the Land Code Administrator will confirm it.' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('property_address', 'Property address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address of the property.' }),
    f('parcel_number', 'Tax parcel number', 'text', { optional: true, help: 'On your property tax bill or the county tax parcel card. Leave blank if you don\'t know it.',
      explain: 'The tax parcel number identifies the lot in Stone County\'s property records. It is printed on the property tax bill, the deed, or the county tax parcel card. If you don\'t have it, leave it blank and City Hall looks it up.' }),
    ...propertyDetails(),
    f('new_structures', 'What buildings or structures will be built?', 'longtext', { required: 'Say what will be built, or "None".', placeholder: 'e.g. None, or a 20 × 30 ft fellowship hall behind the church' }),
    f('other_changes', 'What other changes will be made to the property?', 'longtext', { required: 'List any other changes, or "None".', placeholder: 'e.g. Add a 6-space gravel parking area and a privacy fence along the back line' }),
  ] },
  { id: 'owner', title: 'Owner & applicant', fields: ownerAndApplicant() },
  { id: 'hearing', title: 'Public hearing', fields: [
    f('rep_role', 'Who will present this application at the public hearing?', 'select', { options: REP_ROLES, required: 'Tell us who will present the application at the public hearing.',
      explain: 'The Planning Commission holds a public hearing on every conditional use request. Someone needs to be there to explain it and answer questions: the owner, the applicant, or someone else such as a contractor, engineer or attorney. If it is not the owner, the owner signs an affidavit naming that person as their agent.' }),
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
  { id: 'proposal', fields: ['proposed_use'], ai: true, prompt: 'Tell me what you\'d like to use the property for. Include what the business or activity is, the hours, and about how many people will come and go.' },
  { id: 'property_address', fields: ['property_address'], prompt: "What's the street address of the property?" },
  { id: 'parcel_number', fields: ['parcel_number'], optional: true, prompt: "Do you know the tax parcel number? It's on the property tax bill. If not, tap \"I don't know\" and City Hall will look it up.", choices: [['__skip', "I don't know"]] },
  { id: 'zoning', fields: ['zoning'], prompt: 'Do you know the zoning district? If not, choose "Not sure" and the Land Code Administrator will confirm it.', choices: ZONES_UNSURE },
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
  { id: 'new_structures', fields: ['new_structures'], prompt: 'Will you build anything new for this use? If so, what and about how big?', choices: [[NO_BUILD, 'Nothing new']] },
  { id: 'other_changes', fields: ['other_changes'], prompt: 'Any other changes to the property, like parking, a driveway, fencing, lighting or a sign?', choices: [[NO_CHANGES, 'No other changes']] },
  ...STANDARDS.map(([key, , , prompt]) => ({ id: key, fields: [key], ai: true, prompt })),
  { id: 'deed', fields: [], upload: ['deed'], done: (d, files) => files.some((x) => x.kind === 'deed') || !!d.bring_deed,
    prompt: 'Now the attachments. First, a copy of the warranty deed for the property. A phone photo is fine.', choices: [['__bring', "I'll bring it to City Hall"]] },
  { id: 'site_plan', fields: [], upload: ['site_plan'], done: (d, files, asked) => files.some((x) => x.kind === 'site_plan') || asked.includes('site_plan'),
    prompt: 'Next, the site plan: the city\'s site plan application and checklist, with plans stamped by a Professional Engineer or Architect showing the property lines, buildings, parking and driveways.', choices: [['__skip', "I'll add it later"]] },
  { id: 'floor_plan', when: { new_structures: { not: NO_BUILD } }, fields: [], upload: ['floor_plan'], done: (d, files, asked) => files.some((x) => x.kind === 'floor_plan') || asked.includes('floor_plan'),
    prompt: 'For the new building, upload the floor plans and elevations (drawings of each side).', choices: [['__skip', "I'll add them later"]] },
  { id: 'location_map', fields: [], upload: ['location_map'], done: (d, files, asked) => files.some((x) => x.kind === 'location_map') || asked.includes('location_map'),
    prompt: 'Last document: a location map showing where the property is, such as a map printout with the property marked.', choices: [['__skip', "I'll add it later"]] },
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
  if (d.rep_role === 'applicant' && d.applicant_role !== 'other') add('error', 'rep_role', 'You said the owner is filling out this application, so there is no separate applicant. Choose the owner or someone else to present at the hearing.');
  if (!has(d.frontage) && !has(d.lot_size)) add('warning', 'frontage', 'Add the lot frontage and depth, or the size of the property. They are on the deed, plat or tax records.');
  if (!has(d.existing_structures)) add('warning', 'existing_structures', 'List the buildings on the property now, or say it is vacant.');
  for (const [k, label, short] of STANDARDS) {
    if (has(d[k]) && String(d[k]).trim().length < 25) add('warning', k, `Your answer to standard ${label[0]} (${short}) is very short. Add a sentence or two so the Planning Commission can make its finding.`);
  }
  if (!has(d.zoning) || d.zoning === 'unknown') add('info', 'zoning', 'Zoning district not given. The Land Code Administrator will confirm it and whether this use is allowed there as a conditional use.');
  if (!has(d.parcel_number)) add('warning', 'parcel_number', 'Add the tax parcel number if you have it. Otherwise City Hall looks it up, which can slow the review.');

  if (!kinds.has('deed')) {
    if (d.bring_deed) add('warning', 'files', 'The warranty deed will be brought to City Hall. The application is complete once it is received.');
    else add('error', 'files', 'Attach a copy of the warranty deed, or check that you will bring it to City Hall.');
  }
  if (!kinds.has('site_plan')) add('warning', 'files', 'Attach the site plan application, checklist and plans stamped by a Professional Engineer or Architect. The application is not complete without them.');
  const building = has(d.new_structures) && !NONE_LIKE.test(d.new_structures);
  if (building && !kinds.has('floor_plan')) add('warning', 'files', 'Attach floor plans and elevations of the new building or structure.');
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
  kind: 'conditional_use', title: 'Conditional use permit application', short: 'Conditional use', code: 'CU', icon: 'store',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/286',
  intro: 'A conditional use permit lets you use a property for something its zoning allows only with approval, like a daycare, church or small business in a residential area. The request goes to a public hearing before the Wiggins Planning Commission.',
  detect: /\b(conditional|special)[\s-]use\b|\b(run|open|operate|start|have)\b.{0,40}\b(business|daycare|day care|child ?care|church|salon|shop|store|office|bed and breakfast|b&b)\b.{0,40}\b(residential|my (house|home)|out of (my|the) (house|home)|in (a|my) neighborhood|zoned (residential|r-?\d))\b|\bhome[\s-](business|occupation|daycare)\b/i,
  addressField: 'property_address', descriptionField: 'proposed_use',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, derive, check, parse,
  fillable: ['parcel_number', 'subdivision', 'lot', 'block'],
  review: 'Compare the uploaded deed with the owner name and property address, and check that the site plan is stamped by a Professional Engineer or Architect and shows the proposed use, parking and driveways. For staff: whether the use is listed as a conditional use in this zoning district, whether each standard (A-G) is actually addressed, parking and traffic, and floodplain.',
  statuses: {
    submitted: ['Submitted', 'The Land Code Administrator is checking that it is complete'],
    in_review: ['Scheduled for Planning Commission', 'The Planning Commission will hold a public hearing'],
    issued: ['Approved', 'The conditional use was approved'], closed: ['Closed', 'This application is closed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Hearing'], ['issued', 'Decision']],
  issue: {
    noun: 'approval', title: 'CONDITIONAL USE APPROVAL', numberLabel: 'Approval number', action: 'Record approval', post: false, inspections: null,
    after: 'Keep this letter and follow any conditions of approval. Before you build or change anything on the property, apply for a construction permit (and a sign permit for any sign). Ask City Hall whether you need a certificate of occupancy before opening.',
    rows: (app, label) => {
      const d = app.data;
      return [
        ['Property', app.screen?.matchedAddress || d.property_address], ['Tax parcel', d.parcel_number], ['Zoning district', label(ZONES_UNSURE, d.zoning)],
        ['Conditional use', d.proposed_use], ['New buildings', d.new_structures], ['Other changes', d.other_changes], ['Owner', d.owner_name],
      ];
    },
  },
  nextSteps: ['The Land Code Administrator checks that the application and attachments are complete.', "You'll be told how to pay the $200 filing fee.",
    'Print the signature page, have the owner sign it in front of a notary, and bring it to City Hall or upload a photo.',
    'The Planning Commission sets a public hearing date, and City Hall gives public notice of the hearing.',
    'At the hearing, you or your representative explain the request, and neighbors can speak.',
    'The Planning Commission makes its recommendation, and you get the decision here.'],
  copyKeys: /^(owner_|applicant_|rep_|contact_pref)/,
});
