// The construction permit application (City of Wiggins form, revised August 2018). Every answer is stored once, under
// one key, and everything else (the city's fillable PDF, page 3 owner certification, the review packet, notifications)
// reads it from there.
import { CONTACT_PREF, ZONES_UNSURE, YES_NO, defineForm, f, has, signFields, tieredFee } from '../engine.js';

export const CONSTRUCTION_TYPES = [['new', 'New construction'], ['addition', 'Addition'], ['remodel', 'Remodel / alteration'], ['demolition', 'Demolition'], ['other', 'Other']];
export const PLANNED_WORK = [['excavation', 'Excavation'], ['foundation', 'Foundation'], ['paving', 'Paving'], ['utilities', 'Utilities'], ['electrical', 'Electrical'],
  ['plumbing', 'Plumbing'], ['hvac', 'HVAC / mechanical'], ['steel_frame', 'Steel frame'], ['masonry', 'Masonry'], ['wood_frame', 'Wood frame'],
  ['accessory', 'Accessory structure'], ['drainage', 'Underground drainage'], ['other', 'Other']];
export const OCCUPANCY = [['single_family', 'Single family'], ['multi_family', 'Multi-family'], ['storage', 'Storage'], ['garage', 'Garage / carport'],
  ['commercial', 'Commercial'], ['other', 'Other']];
const ZONING = ZONES_UNSURE.filter(([k]) => k !== 'A-R');
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
const DP = { design_pro: ['architect', 'engineer', 'designer'] };

const SECTIONS = [
  { id: 'project', title: 'Project', fields: [
    f('description', 'Detailed description of the work', 'longtext', { placeholder: 'e.g. Build a 24 × 30 ft detached two-car garage behind the house' }),
    f('project_name', 'Project name', 'text', { placeholder: 'e.g. Smith detached garage', help: 'A short name for the project. Optional.', optional: true }),
    f('construction_type', 'Construction type', 'select', { options: CONSTRUCTION_TYPES }),
    f('construction_type_other', 'Describe the other type of work', 'text', { when: { construction_type: 'other' }, optional: true }),
    f('planned_work', 'Planned work (check all that apply)', 'multi', { options: PLANNED_WORK }),
    f('planned_work_other', 'Other planned work', 'text', { when: { planned_work: { has: 'other' } }, optional: true }),
    f('work_started', 'Has any of the work already started?', 'bool', { help: 'Fees are doubled when construction has already begun.' }),
  ] },
  { id: 'property', title: 'Property', fields: [
    f('job_address', 'Job address', 'address', { placeholder: 'Street address in Wiggins' }),
    f('parcel_number', 'Tax parcel number', 'text', { help: 'On your property tax bill or the county tax parcel card. Leave blank if you don\'t know it.',
      explain: 'The tax parcel number identifies the lot in Stone County\'s property records. It is printed on the property tax bill, the deed, or the county tax parcel card. If you don\'t have it, leave it blank and City Hall looks it up.' }),
  ] },
  { id: 'owner', title: 'Owner & contact', fields: [
    f('applicant_role', 'Who is filling out this application?', 'select', { options: [['owner', 'The property owner'], ['contractor', 'The contractor'], ['other', 'Someone else for the owner']] }),
    f('applicant_name', 'Your full name', 'text', { when: { applicant_role: 'other' } }),
    f('applicant_phone', 'Your phone', 'phone', { when: { applicant_role: 'other' } }),
    f('applicant_email', 'Your email', 'email', { when: { applicant_role: 'other' }, optional: true }),
    f('owner_name', 'Property owner', 'text', { help: 'As shown on the deed or tax records.' }),
    f('owner_same_mailing', "Owner's mailing address is the job address", 'bool'),
    f('owner_address', 'Owner mailing address', 'text', { when: { owner_same_mailing: false } }),
    f('owner_city', 'City', 'text', { when: { owner_same_mailing: false }, half: true }),
    f('owner_state', 'State', 'state', { when: { owner_same_mailing: false }, half: true }),
    f('owner_zip', 'ZIP', 'zip', { when: { owner_same_mailing: false }, half: true }),
    f('owner_phone', 'Owner phone', 'phone', { half: true }),
    f('owner_cell', 'Owner cell', 'phone', { half: true, optional: true }),
    f('owner_email', 'Owner email', 'email'),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'builder', title: "Who's building it", fields: [
    f('builder', 'Who will do the work?', 'select', { options: [['contractor', 'A licensed contractor'], ['owner', 'The owner (owner-builder)']] }),
    f('contractor_name', 'Contractor', 'text', { when: { builder: 'contractor' } }),
    f('contractor_cor', 'MS Certificate of Responsibility (COR) number', 'text', { when: { builder: 'contractor' }, help: 'Issued by the Mississippi State Board of Contractors.',
      explain: 'A Certificate of Responsibility (COR) is the license number the Mississippi State Board of Contractors gives commercial contractors. Residential contractors have a similar license number. Your contractor can give it to you; it is also on the Board\'s website (msboc.us).' }),
    f('contractor_address', 'Contractor mailing address', 'text', { when: { builder: 'contractor' } }),
    f('contractor_city', 'City', 'text', { when: { builder: 'contractor' }, half: true }),
    f('contractor_state', 'State', 'state', { when: { builder: 'contractor' }, half: true }),
    f('contractor_zip', 'ZIP', 'zip', { when: { builder: 'contractor' }, half: true }),
    f('contractor_phone', 'Contractor phone', 'phone', { when: { builder: 'contractor' }, half: true }),
    f('contractor_cell', 'Contractor cell', 'phone', { when: { builder: 'contractor' }, half: true, optional: true }),
    f('contractor_email', 'Contractor email', 'email', { when: { builder: 'contractor' } }),
    f('owner_exemption', 'Owner-builder exception that applies', 'radio', { when: { builder: 'owner' }, options: EXEMPTIONS,
      explain: 'Mississippi law requires a licensed contractor for most construction, except when the owner does the work on their own property in one of these situations. Pick the one that matches your project. If none fits, a licensed contractor must do the work.' }),
    f('owner_ack', 'I have read the Owner\'s Construction Permit Responsibilities, I am familiar with the applicable codes, ordinances and state laws, the work must pass city inspections, and the Building Official may require a licensed contractor', 'check', { when: { builder: 'owner' }, required: "Read and accept the Owner's Construction Permit Responsibilities." }),
  ] },
  { id: 'building', title: 'Building', fields: [
    f('stories', 'Stories', 'number', { half: true }),
    f('width', 'Max width (ft)', 'number', { half: true }),
    f('length', 'Length (ft)', 'number', { half: true }),
    f('height', 'Height (ft)', 'number', { half: true }),
    f('area_under_roof', 'Under roof (sq ft)', 'number', { half: true }),
    f('area_heated', 'Heated / cooled (sq ft)', 'number', { half: true, optional: true }),
    f('area_accessory', 'Accessory (sq ft)', 'number', { half: true, optional: true }),
    f('area_total', 'Total (sq ft)', 'number', { half: true }),
    f('occupancy', 'Occupancy', 'select', { options: OCCUPANCY, explain: 'Occupancy means how the building will be used once it is finished: a home, a garage, storage, a business and so on. It decides which building code rules apply.' }),
    f('occupancy_commercial', 'Commercial use', 'text', { when: { occupancy: 'commercial' } }),
    f('occupancy_other', 'Other use', 'text', { when: { occupancy: 'other' } }),
  ] },
  { id: 'zoning', title: 'Zoning & setbacks', fields: [
    f('zoning', 'Zoning district', 'select', { options: ZONING, explain: 'Every lot in Wiggins is in a zoning district (R-1 is single-family residential, C-2 is general commercial, and so on). The district sets what can be built and how far from the property lines. If you don\'t know it, choose "Not sure" and the Land Code Administrator will confirm it.' }),
    f('setback_front', 'Front setback (ft)', 'number', { half: true, help: 'Distance from the building to the front property line.',
      explain: 'A setback is the distance from the building to a property line. Measure from the closest part of the new building to the front, side and rear lines of your lot.' }),
    f('setback_side', 'Side setback (ft)', 'number', { half: true }),
    f('setback_rear', 'Rear setback (ft)', 'number', { half: true }),
  ] },
  { id: 'design', title: 'Design professional', fields: [
    f('design_pro', 'Design professional', 'select', { options: [['architect', 'Architect'], ['engineer', 'Engineer'], ['designer', 'Designer'], ['none', 'Not applicable']] }),
    f('dp_firm', 'Firm', 'text', { when: DP, half: true }),
    f('dp_principal', 'Named principal', 'text', { when: DP, half: true }),
    f('dp_license', 'License number', 'text', { when: DP, half: true }),
    f('dp_address', 'Mailing address', 'text', { when: DP }),
    f('dp_city', 'City', 'text', { when: DP, half: true }),
    f('dp_state', 'State', 'state', { when: DP, half: true }),
    f('dp_zip', 'ZIP', 'zip', { when: DP, half: true }),
    f('dp_phone', 'Phone', 'phone', { when: DP, half: true }),
    f('dp_email', 'Email', 'email', { when: DP }),
  ] },
  { id: 'cost', title: 'Valuation', fields: [
    f('valuation', 'Total contract price or valuation of the work', 'money', { help: 'Materials and labor. The permit fee is based on this amount.',
      explain: 'The valuation is what the whole job costs: the contract price if you hired a contractor, or the value of materials plus labor if you do the work yourself. The permit fee is calculated from this number.' }),
  ] },
  { id: 'documents', title: 'Documents', fields: [
    f('files', 'Attachments', 'files', { kinds: DOC_KINDS }),
    f('bring_ownership_proof', "I'll bring proof of ownership to City Hall instead", 'check'),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: signFields({
    hazmat: true,
    certify: 'I certify that I have read this application, the information is true and correct, I will comply with all applicable codes, ordinances and state laws, and I am the owner or authorized to act as the owner\'s agent for this work.',
  }) },
];

const ASKS = [
  { id: 'project', fields: ['description'], ai: true, prompt: 'Tell me about your project. What are you building or changing? Size and use help, like "a 24 by 30 foot detached garage".' },
  { id: 'construction_type', fields: ['construction_type'], prompt: 'What type of work is it?', choices: CONSTRUCTION_TYPES },
  { id: 'job_address', fields: ['job_address'], prompt: "What's the street address of the property where the work will be done?" },
  { id: 'parcel_number', fields: ['parcel_number'], optional: true, prompt: "Do you know the tax parcel number? It's on the property tax bill. If not, tap \"I don't know\" and City Hall will look it up.", choices: [['__skip', "I don't know"]] },
  { id: 'work_started', fields: ['work_started'], prompt: 'Has any of the work already started?', choices: YES_NO },
  { id: 'applicant_role', fields: ['applicant_role'], prompt: 'Are you the property owner?', choices: [['owner', "Yes, I'm the owner"], ['contractor', "I'm the contractor"], ['other', "I'm applying for the owner"]] },
  { id: 'applicant', when: { applicant_role: 'other' }, fields: ['applicant_name', 'applicant_phone'], ai: true, prompt: "What's your name, and a phone number or email where City Hall can reach you?" },
  { id: 'owner_name', fields: ['owner_name'], prompt: (d) => (d.applicant_role === 'owner' ? "What's your full name, as it appears on the deed?" : "What's the property owner's full name, as it appears on the deed?") },
  { id: 'owner_same_mailing', fields: ['owner_same_mailing'], prompt: (d) => `Is the owner's mailing address the same as the job address${d.job_address ? ` (${d.job_address})` : ''}?`, choices: YES_NO },
  { id: 'owner_mailing', when: { owner_same_mailing: false }, fields: ['owner_address', 'owner_city', 'owner_state', 'owner_zip'], ai: true, prompt: "What's the owner's mailing address, including city, state and ZIP?" },
  { id: 'owner_contact', fields: ['owner_phone'], alt: ['owner_cell', 'owner_email'], ai: true, prompt: (d) => (d.applicant_role === 'owner' ? "What's the best phone number and email for you?" : "What's the owner's phone number and email?") },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates about this application?', choices: CONTACT_PREF },
  { id: 'builder', fields: ['builder'], prompt: 'Will a licensed contractor do the work, or will the owner do it as an owner-builder?', choices: [['contractor', 'Licensed contractor'], ['owner', 'Owner-builder']] },
  { id: 'contractor', when: { builder: 'contractor' }, fields: ['contractor_name'], ai: true, prompt: "What's the contractor's company name and Mississippi Certificate of Responsibility (COR) number?" },
  { id: 'contractor_contact', when: { builder: 'contractor' }, fields: ['contractor_phone'], alt: ['contractor_cell', 'contractor_email'], ai: true, prompt: "What's the contractor's phone, email and mailing address?" },
  { id: 'owner_exemption', when: { builder: 'owner' }, fields: ['owner_exemption'], prompt: 'Mississippi requires a licensed contractor unless the owner meets one of these exceptions. Which one applies?', choices: EXEMPTIONS },
  { id: 'owner_ack', when: { builder: 'owner' }, fields: ['owner_ack'], prompt: "As an owner-builder you may be financially responsible for injuries to workers, for withholding taxes, and for structural defects for years after construction, and the Building Official can require a licensed contractor if the work isn't up to code. Do you accept these responsibilities?", choices: [['yes', 'I accept'], ['no', "I'll use a contractor"]] },
  { id: 'size', when: { construction_type: BUILDS }, fields: ['stories', 'width', 'length'], ai: true, prompt: 'How big will it be? Give the number of stories, the width and length, and the height in feet.' },
  { id: 'occupancy', when: { construction_type: { not: 'demolition' } }, fields: ['occupancy'], prompt: 'How will the building be used?', choices: OCCUPANCY },
  { id: 'area', when: { construction_type: BUILDS }, fields: ['area_heated'], prompt: (d) => `${d.area_under_roof ? `That's about ${Number(d.area_under_roof).toLocaleString()} sq ft under roof. ` : ''}How much of it will be heated or cooled, in square feet?`, choices: [['0', 'None']] },
  { id: 'zoning', fields: ['zoning'], prompt: 'Do you know the zoning district? If not, choose "Not sure" and the Land Code Administrator will confirm it.', choices: ZONING },
  { id: 'setbacks', when: { construction_type: BUILDS }, fields: ['setback_front', 'setback_side', 'setback_rear'], ai: true, prompt: 'How far will the building be from the front, side and rear property lines, in feet?' },
  { id: 'design_pro', fields: ['design_pro'], prompt: 'Did an architect, engineer or designer prepare the plans?', choices: [['architect', 'Architect'], ['engineer', 'Engineer'], ['designer', 'Designer'], ['none', 'Not applicable']] },
  { id: 'design_detail', when: DP, fields: ['dp_firm'], ai: true, prompt: "What's the firm, the named principal, license number, and their phone or email?" },
  { id: 'valuation', fields: ['valuation'], prompt: "What's the total contract price, or the estimated value of the work including materials and labor?" },
  { id: 'ownership_proof', fields: [], upload: ['ownership_proof'], done: (d, files) => files.some((x) => x.kind === 'ownership_proof') || !!d.bring_ownership_proof,
    prompt: 'Please upload proof of ownership: a deed or the tax parcel card. A phone photo is fine.', choices: [['__bring', "I'll bring it to City Hall"]] },
  { id: 'plans', when: { construction_type: BUILDS }, fields: [], upload: ['site_plan', 'floor_plan', 'foundation', 'structural', 'electrical', 'plumbing', 'mechanical', 'other'],
    done: (d, files, asked) => files.some((x) => x.kind !== 'ownership_proof') || asked.includes('plans'),
    prompt: 'Now your plans. At minimum, a site plan showing the building and its distance to each property line. Add floor, foundation or other plans if you have them.', choices: [['__skip', "I'll add plans later"]] },
  { id: 'hazmat_ack', fields: ['hazmat_ack'], prompt: 'If there is lead, asbestos or other hazardous material on the site, will you follow MDEQ rules to remove it properly?', choices: [['yes', 'Yes, I agree']] },
  { id: 'sign', fields: ['certify', 'signature_name'], prompt: 'Last step. Review the application, then type your full name to sign it. By signing you certify the information is true and correct and that you are the owner or authorized to act for the owner.' },
];

// Fills values that follow from other answers. Only fills blanks, so anything the applicant typed wins.
function derive(out) {
  const blank = (k) => out[k] == null || out[k] === '';
  if (out.applicant_role === 'contractor' && blank('builder')) out.builder = 'contractor';
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
function contact(d) {
  const role = d.applicant_role;
  const pick = (name, email, phone) => ({ name: name || null, email: email || null, phone: phone || null });
  const c = role === 'contractor' ? pick(d.contractor_name, d.contractor_email, d.contractor_cell || d.contractor_phone)
    : role === 'other' ? pick(d.applicant_name, d.applicant_email, d.applicant_phone)
      : pick(d.owner_name, d.owner_email, d.owner_cell || d.owner_phone);
  return { ...c, pref: d.contact_pref || (c.email ? 'email' : c.phone ? 'sms' : null) };
}

function fee(d, cfg) {
  const fees = cfg?.fees;
  const permit = tieredFee(d.valuation, fees?.tiers);
  if (permit == null) return null;
  const doubled = !!(d.work_started && fees.doubleIfStarted);
  const total = doubled ? permit * 2 : permit;
  const lines = [{ label: `Construction permit (valuation $${Number(d.valuation).toLocaleString()})`, amount: permit }];
  if (doubled) lines.push({ label: 'Doubled because work has already started', amount: permit });
  if (fees.planReviewShare) lines.push({ label: `Plan review deposit: ${Math.round(fees.planReviewShare * 100)}% of the permit fee, paid with the application and applied to the permit`, amount: null, note: Math.round(total * fees.planReviewShare * 100) / 100 });
  return { total, lines, notes: fees.notes || [], source: fees.source || null };
}

function check(d, ctx, { add, need }) {
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
    const v = Number(d.valuation) || 0;
    const res = RESIDENTIAL.includes(d.occupancy);
    if (d.owner_exemption === 'remodel_under_10k' && (d.construction_type !== 'remodel' || v >= 10000)) {
      add('error', 'owner_exemption', `The "residential remodel under $10,000" exception doesn't fit ${d.construction_type ? `a ${(CONSTRUCTION_TYPES.find(([k]) => k === d.construction_type) || [])[1].toLowerCase()} project` : 'a project'} valued at $${v.toLocaleString()}. Choose another exception or a licensed contractor.`);
    }
    if (d.owner_exemption === 'under_50k' && v >= 50000) add('error', 'owner_exemption', `The "under $50,000" exception doesn't fit a project valued at $${v.toLocaleString()}.`);
    if (d.owner_exemption === 'commercial_own' && d.occupancy && d.occupancy !== 'commercial') add('warning', 'owner_exemption', 'The commercial exception was chosen, but the occupancy is not commercial.');
    if (d.owner_exemption === 'principal_residence' && d.occupancy && !res) add('warning', 'owner_exemption', 'The principal-residence exception was chosen for a project that is not residential.');
  }

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
  if (!has(d.parcel_number)) add('warning', 'parcel_number', 'Add the tax parcel number if you have it. Otherwise City Hall looks it up, which can slow the review.');
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
  if (sc?.flood?.checked && sc.flood.sfha) {
    add('warning', 'job_address', `FEMA maps show this property in flood zone ${sc.flood.zone}. A floodplain development permit and elevation information will likely be required.`);
  }
}

// Answers the generic reader can't place: a free-form project description, building dimensions, setbacks.
const num = (s) => Number(String(s).replace(/,/g, ''));
export function dims(text) {
  const out = {};
  const wl = text.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)/i);
  if (wl) { out.width = num(wl[1]); out.length = num(wl[2]); }
  const st = text.match(/(\d+|one|two|three)[\s-]*(?:story|stories|storey|floors?)\b/i);
  if (st) out.stories = { one: 1, two: 2, three: 3 }[st[1].toLowerCase()] || num(st[1]);
  else if (/\bsingle[\s-]story\b/i.test(text)) out.stories = 1;
  const h = text.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)?\s*(?:tall|high)\b|\bheight\D{0,12}(\d+(?:\.\d+)?)/i);
  if (h) out.height = num(h[1] || h[2]);
  return out;
}

// Keyword reading of a project description. The AI does this better; this keeps working without it.
function describe(text) {
  const t = text.toLowerCase();
  const out = { description: text.trim(), ...dims(text) };
  if (/\b(tear down|demolish|demolition|demo)\b/.test(t)) out.construction_type = 'demolition';
  else if (/\b(add(ing)? (a |an )?(room|addition|on)|addition|extend|expand)\b/.test(t)) out.construction_type = 'addition';
  else if (/\b(remodel|renovat|alter|repair|replace|convert|finish)\w*/.test(t)) out.construction_type = 'remodel';
  else if (/\b(build|new|construct|put up|install|erect)\w*/.test(t)) out.construction_type = 'new';
  if (/\b(garage|carport)\b/.test(t)) out.occupancy = 'garage';
  else if (/\b(shed|storage|barn|workshop)\b/.test(t)) out.occupancy = 'storage';
  else if (/\b(duplex|apartment|triplex|fourplex|multi-?family)\b/.test(t)) out.occupancy = 'multi_family';
  else if (/\b(store|office|restaurant|shop|business|commercial|warehouse|church)\b/.test(t)) out.occupancy = 'commercial';
  else if (/\b(house|home|residence|bedroom|bathroom|kitchen|porch|deck)\b/.test(t)) out.occupancy = 'single_family';
  if (/\b(detached|accessory|shed|carport)\b/.test(t)) out.planned_work = ['accessory'];
  return out;
}

const parse = {
  project: (t) => describe(t),
  size: (t) => dims(t),
  area: (t) => { const n = /\b(none|no|zero)\b/i.test(t) ? 0 : t.match(/\d[\d,]*/) ? num(t.match(/\d[\d,]*/)[0]) : undefined; return n === undefined ? {} : { area_heated: n }; },
  setbacks: (t) => {
    const out = {};
    for (const k of ['front', 'side', 'rear']) { const m = t.match(new RegExp(`${k}\\D{0,12}(\\d+(?:\\.\\d+)?)|(\\d+(?:\\.\\d+)?)\\s*(?:'|ft|feet)?\\s*(?:from the |on the |to the )?${k}`, 'i')); if (m) out[`setback_${k}`] = num(m[1] || m[2]); }
    if (!Object.keys(out).length) { const n = t.match(/\d+(?:\.\d+)?/g) || []; if (n.length >= 3) Object.assign(out, { setback_front: num(n[0]), setback_side: num(n[1]), setback_rear: num(n[2]) }); }
    return out;
  },
  contractor: (t) => {
    const cor = t.match(/\b(?:cor|certificate)[^\d]{0,20}(\d[\w-]{2,})/i) || t.match(/#\s*(\d[\w-]{2,})/);
    const name = t.replace(cor?.[0] || '', '').replace(/[,;.]+\s*$|\b(and|with)\s*$/i, '').trim();
    return { contractor_name: name || undefined, contractor_cor: cor?.[1] };
  },
  design_detail: (t) => ({ dp_firm: t }),
  owner_ack: (t) => (/^(i accept|yes|y|accept|i do|ok|okay)\b/i.test(t) ? { owner_ack: true } : /contractor|^no\b/i.test(t) ? { builder: 'contractor', owner_ack: null, owner_exemption: null } : {}),
};

export default defineForm({
  kind: 'construction', title: 'Construction permit application', short: 'Construction permit', code: 'BP', icon: 'build',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/288',
  intro: 'A construction permit is required to build, add on to, remodel or tear down a building in Wiggins.',
  detect: /\b(build|construct|put up|erect|add(ing)? (on|an? addition|a room)|addition|remodel|renovat\w*|demolish|tear down|pour (a )?slab)\b.*\b(garage|carport|shed|house|home|addition|room|porch|deck|building|barn|workshop|slab|structure|office|store|church|duplex|bedroom|bathroom|kitchen)\b|\b(building|construction) permit\b/i,
  addressField: 'job_address', descriptionField: 'description', nameField: 'project_name',
  sections: SECTIONS, docKinds: DOC_KINDS, asks: ASKS, derive, contact, fee, check, parse,
  fillable: ['parcel_number', 'contractor_cor', 'dp_license'],
  review: 'Compare uploaded documents with the answers: owner name and property address on the proof of ownership, and whether a "site plan" actually shows the building and property lines. For staff: zoning setbacks for the district, floodplain, whether plans are adequate, valuation reasonableness.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is checking that it is complete'],
    in_review: ['Under review', 'The Land Code Administrator is reviewing zoning, floodplain and code requirements'],
    issued: ['Permit issued', 'Print it and post it at the job site'], closed: ['Closed', 'Final inspection passed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Review'], ['issued', 'Issued']],
  issue: {
    noun: 'permit', title: 'CONSTRUCTION PERMIT', numberLabel: 'Permit number', action: 'Issue permit', post: true,
    after: 'Print the permit and post it at the job site where it can be seen from the street. Call City Hall to schedule each required inspection before covering any work.',
    inspections: ['Footing / foundation', 'Slab', 'Framing', 'Electrical rough-in', 'Plumbing rough-in', 'Mechanical', 'Final'],
    rows: (app, label) => {
      const d = app.data;
      return [
        ['Job address', app.screen?.matchedAddress || d.job_address], ['Tax parcel', d.parcel_number],
        ['Work', `${label(CONSTRUCTION_TYPES, d.construction_type)}${d.occupancy ? ` · ${label(OCCUPANCY, d.occupancy)}` : ''}${d.width && d.length ? ` · ${d.width} × ${d.length} ft` : ''}${d.area_total ? ` · ${Number(d.area_total).toLocaleString()} sq ft` : ''}`],
        ['Description', d.description], ['Planned work', (d.planned_work || []).map((k) => label(PLANNED_WORK, k)).join(', ')], ['Owner', d.owner_name],
        ['Contractor', d.builder === 'owner' ? 'Owner-builder (owner certified an exception to the contractor license requirement)' : `${d.contractor_name || ''}${d.contractor_cor ? ` · MS COR ${d.contractor_cor}` : ''}`],
        ['Valuation', d.valuation ? `$${Number(d.valuation).toLocaleString()}` : ''],
      ];
    },
    expires: 'If work does not begin within 180 days, or stops for more than 180 days, unless extended by the city.',
  },
  nextSteps: ['Planning & Building checks that the application is complete.', "You'll be told the permit fee and how to pay it.",
    'The Land Code Administrator reviews zoning, floodplain and code requirements.', "When it's approved, you download the permit and post it at the job site."],
  copyKeys: /^(owner_|contractor_|applicant_|contact_pref|dp_|design_pro|builder)/,
});
