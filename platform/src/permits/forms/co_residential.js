// The residential certificate of occupancy application (City of Wiggins, revised 06/2022). The certificate is the
// city's OK to live in a home after it is built or renovated. Section B of the paper form (special conditions, zoning,
// use per Table 3.2) is filled in by Planning & Building, so it isn't asked here.
import { CONTACT_PREF, YES_NO, defineForm, f, has, ownerAsks, signFields } from '../engine.js';

const SAME = { owner_same_mailing: false };

const SECTIONS = [
  { id: 'building', title: 'Building', fields: [
    f('property_address', 'Building address', 'address', { placeholder: 'Street address in Wiggins', required: 'Enter the address of the building.' }),
    f('permit_number', 'Construction permit number', 'text', { optional: true, help: "It's on your construction permit. Leave blank if you don't have one.",
      explain: 'The construction permit number is printed on the permit City Hall issued for building or renovating the home. It lets the inspector pull up the plans and earlier inspections. If you don\'t have it, leave it blank and City Hall looks it up by address.' }),
    f('work_complete', 'Is all construction finished?', 'bool', { required: 'Tell us whether all construction is finished.', help: 'The final inspection is scheduled once all construction and renovation is done.' }),
    f('already_occupied', 'Has anyone already moved in?', 'bool', { required: 'Tell us whether anyone has already moved in.', help: 'The fee is doubled when a home is lived in before the certificate is issued.' }),
  ] },
  { id: 'owner', title: 'Owner', fields: [
    f('owner_name', 'Owner of building', 'text', { required: "Enter the building owner's name.", help: 'As shown on the deed or tax records.' }),
    f('owner_same_mailing', "Owner's mailing address is the building address", 'bool', { required: "Tell us whether the owner's mailing address is the building address." }),
    f('owner_address', 'Building owner address', 'text', { when: SAME, required: "Enter the owner's mailing address." }),
    f('owner_city', 'City', 'text', { when: SAME, half: true, required: 'Enter the city.' }),
    f('owner_state', 'State', 'state', { when: SAME, half: true, required: 'Enter the state.' }),
    f('owner_zip', 'ZIP', 'zip', { when: SAME, half: true, required: 'Enter the ZIP code.' }),
    f('owner_phone', 'Phone', 'phone', { half: true, reach: 'owner' }),
    f('owner_cell', 'Cell', 'phone', { half: true, optional: true }),
    f('owner_email', 'Email', 'email', { optional: true }),
    f('contact_pref', 'How should City Hall reach you about this application?', 'select', { options: CONTACT_PREF }),
  ] },
  { id: 'sign', title: 'Certify & sign', fields: signFields({
    certify: 'I certify that the information on this application is true and correct, and that the building will be ready for the final inspection when I ask City Hall to schedule it.',
  }) },
];

const [, , , ownerMailing] = ownerAsks();

const ASKS = [
  { id: 'property_address', fields: ['property_address'], prompt: "What's the address of the home that needs the certificate of occupancy?" },
  { id: 'permit_number', fields: ['permit_number'], optional: true, prompt: "What's the construction permit number? It's on your construction permit. If you don't have one, tap \"I don't have one\".", choices: [['__skip', "I don't have one"]] },
  { id: 'work_complete', fields: ['work_complete'], prompt: 'Is all the construction finished?', choices: [['yes', "Yes, it's all done"], ['no', 'Not yet']] },
  { id: 'already_occupied', fields: ['already_occupied'], prompt: 'Has anyone already moved in?', choices: YES_NO },
  { id: 'owner_name', fields: ['owner_name'], prompt: "Who owns the home? Give the owner's full name as it appears on the deed." },
  { id: 'owner_same_mailing', fields: ['owner_same_mailing'], prompt: (d) => `Is the owner's mailing address the same as the home's address${d.property_address ? ` (${d.property_address})` : ''}?`, choices: YES_NO },
  { ...ownerMailing, when: SAME },
  { id: 'owner_contact', fields: ['owner_phone'], alt: ['owner_cell', 'owner_email'], ai: true, prompt: "What's the best phone number and email for the owner?" },
  { id: 'contact_pref', fields: ['contact_pref'], prompt: 'How would you like City Hall to reach you with updates, like when to expect the inspection?', choices: CONTACT_PREF },
  { id: 'sign', fields: ['certify', 'signature_name'], prompt: 'Last step. Review the application, then type your full name to sign it. By signing you certify the information is true and correct and the home will be ready for the final inspection when you ask for it.' },
];

// Published fee: $25, doubled if the home is already lived in.
function fee(d, cfg) {
  const fees = cfg?.fees || {};
  const base = fees.flat ?? 25;
  const doubled = d.already_occupied === true && fees.doubleIfStarted !== false;
  const lines = [{ label: 'Residential certificate of occupancy', amount: base }];
  if (doubled) lines.push({ label: 'Doubled because the home is already lived in', amount: base });
  return { total: doubled ? base * 2 : base, lines, notes: ['City Hall confirms the fee when it reviews the application.', ...(fees.notes || [])], source: fees.source || null };
}

function check(d, ctx, { add }) {
  if (d.work_complete === false) add('warning', 'work_complete', 'The final inspection can only be scheduled once all construction is finished. You can submit now, then call Planning & Building when the work is done.');
  if (d.already_occupied) add('warning', 'already_occupied', 'Someone has already moved in, so the published fee schedule doubles the fee.');
  if (!has(d.permit_number)) add('info', 'permit_number', 'No construction permit number given. City Hall will look up the permit for this address.');
}

export default defineForm({
  kind: 'co_residential', title: 'Residential certificate of occupancy', short: 'Residential CO', code: 'CO', icon: 'home',
  department: 'planning-building', formUrl: 'https://www.cityofwiggins.gov/DocumentCenter/View/289',
  intro: 'A certificate of occupancy is the city\'s OK to live in a home after it is built or renovated. It is issued after the home passes a final inspection.',
  detect: /\bresidential (certificate of occupancy|c\.?o\.?)(?=\W|$)|\b(certificate of occupancy|occupancy (certificate|permit))\b|\bc\.?o\.?\s+(inspection|for (my|the|our|a) (new )?(house|home|residence|duplex|mobile home|manufactured home))\b|\b(move|moving) in(to)? (my|our|the) (new(ly built)?|finished|remodeled|renovated) (house|home)\b/i,
  addressField: 'property_address',
  sections: SECTIONS, asks: ASKS, fee, check,
  fillable: ['permit_number'],
  review: 'Check that the construction permit number matches a permit for this address and owner. For staff: open permits and passed inspections, zoning, use per Table 3.2, and any special conditions.',
  statuses: {
    submitted: ['Submitted', 'Planning & Building is checking the application and setting the fee'],
    fees_due: ['Complete · fee due', 'Pay the fee at City Hall. The inspection is scheduled after that'],
    in_review: ['Inspection', 'Call Planning & Building to schedule the final inspection once all construction is finished'],
    issued: ['Certificate issued', 'Your certificate of occupancy is ready'], closed: ['Closed', 'This application is closed'],
  },
  steps: [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Inspection'], ['issued', 'Certificate']],
  issue: {
    noun: 'certificate', title: 'CERTIFICATE OF OCCUPANCY', numberLabel: 'Certificate number', action: 'Issue certificate', post: true,
    after: 'Keep this certificate with your property records. Post it in a visible place in the home.',
    inspections: ['Final / CO inspection'],
    rows: (app) => {
      const d = app.data;
      return [
        ['Building address', app.screen?.matchedAddress || d.property_address], ['Use', 'Residential'], ['Owner', d.owner_name],
        ['Construction permit', d.permit_number],
      ];
    },
  },
  nextSteps: ['Planning & Building checks that the application is complete and sets the fee.', "Pay the fee at City Hall. You'll be told the amount.",
    'When all construction is finished, call Planning & Building at (228) 385-2350 ext. 103 to schedule the final inspection.',
    'Once the inspection passes, Planning & Building issues your certificate of occupancy.'],
  copyKeys: /^(owner_|contact_pref)/,
});
