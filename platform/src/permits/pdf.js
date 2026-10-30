// PDFs made from an application's answers:
//   applicationPdf  the city's own fillable form, filled in (or a clean summary when the city has no template)
//   permitPdf       the issued permit, to post at the job site
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { CONSTRUCTION_TYPES, DOC_KINDS, OCCUPANCY, PLANNED_WORK, SECTIONS, matches, splitAddress } from './construction.js';

// Field names in a city's fillable PDF, by template. Worked out from each widget's position on the page.
export const TEMPLATES = {
  // City of Wiggins "Construction Permit Application", revised August 2018 (DocumentCenter/View/288).
  'wiggins-2018': {
    text: {
      DATE: 'date', 'PROJECT ex WalMart Addition': 'project_name', 'TAX PARCEL': 'parcel_number', 'JOB LOCATION': 'job_location', Other: 'construction_type_other',
      OWNER: 'owner_name', 'MAILING ADDRESS': 'owner_address', CITY: 'owner_city', STATE: 'owner_state', ZIP: 'owner_zip', PHONE: 'owner_phone', CELL: 'owner_cell', EMAIL: 'owner_email',
      CONTRACTOR: 'contractor_name', 'MS COR': 'contractor_cor', 'MAILING ADDRESS_2': 'contractor_address', CITY_2: 'contractor_city', STATE_2: 'contractor_state',
      ZIP_2: 'contractor_zip', 'Phone 2': 'contractor_phone', CELL_2: 'contractor_cell', 'Email 2': 'contractor_email',
      '0 Other': 'planned_work_other', 'NO STORIES': 'stories', 'MAX WIDTH': 'width', LENGTH: 'length', HEIGHT: 'height',
      Text1: 'area_under_roof', Text2: 'area_heated', Text3: 'area_accessory', Text4: 'area_total', Text34: 'occupancy_commercial', Text35: 'occupancy_other',
      Text36: 'setback_front', Text37: 'setback_side', Text38: 'setback_rear',
      Text39: 'dp_firm', Text40: 'dp_principal', Text41: 'dp_address', Text42: 'dp_license', Text43: 'dp_city', Text44: 'dp_state', Text45: 'dp_zip',
      Text46: 'dp_phone', Text47: 'dp_cell', Text48: 'dp_email', Text49: 'signed_date', Text53: 'valuation_text', Text50: 'signed_date',
      Text5: 'job_location', Text6: 'parcel_number', Text7: 'owner_signed_date',
    },
    description: ['DETAILED DESCRIPTION', 'Detail 2', 'Detail 3', 'Detail 4'],
    checks: {
      construction_type: { new: 'Check Box19', addition: 'Check Box20', remodel: 'Check Box21', demolition: 'Check Box22' },
      planned_work: { excavation: 'Check Box6', foundation: 'Check Box7', paving: 'Check Box8', utilities: 'Check Box9', steel_frame: 'Check Box10', wood_frame: 'Check Box15',
        electrical: 'Check Box11', plumbing: 'Check Box12', hvac: 'Check Box13', masonry: 'Check Box14', accessory: 'Check Box16', drainage: 'Check Box17', other: 'Check Box18' },
      occupancy: { single_family: 'Check Box32', multi_family: 'Check Box33', storage: 'Check Box34', garage: 'Check Box35', commercial: 'Check Box36', other: 'Check Box37' },
      zoning: { 'R-1': 'Check Box23', 'R-2': 'Check Box24', 'R-3': 'Check Box25', 'R-4': 'Check Box26', 'R-0': 'Check Box27', 'C-1': 'Check Box28', 'C-2': 'Check Box29', 'C-3': 'Check Box30', 'I-1': 'Check Box31' },
      design_pro: { architect: 'Check Box38', engineer: 'Check Box39', designer: 'Check Box40', none: 'Check Box41' },
      documents: { site_plan: 'Check Box42', foundation: 'Check Box43', floor_plan: 'Check Box44', electrical: 'Check Box45', mechanical: 'Check Box1', plumbing: 'Check Box47',
        fire_sprinkler: 'Check Box48', irrigation: 'Check Box49', landscaping: 'Check Box50', structural: 'Check Box51', specifications: 'Check Box52', other: 'Check Box53' },
      owner_exemption: { commercial_own: 'Check Box5', under_50k: 'Check Box54', remodel_under_10k: 'Check Box55', principal_residence: 'Check Box56' },
    },
    signatures: { hazmat: 'Signature1', certify: 'Signature2', owner: 'Signature4' },
  },
};

const usDate = (iso) => { const d = iso ? new Date(iso) : new Date(); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`; };
const label = (opts, v) => (opts.find(([k]) => k === v) || [])[1] || v || '';

// Breaks text into lines that fit the given widths (one width per line).
function wrap(text, font, size, widths) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > widths[Math.min(lines.length, widths.length - 1)] - 6 && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > widths.length) lines[widths.length - 1] = `${lines.slice(widths.length - 1).join(' ').slice(0, 90)}… (continued in City Hall OS)`;
  return lines.slice(0, widths.length);
}

// Values the form needs that come from other answers.
function formValues(app) {
  const d = app.data;
  const parts = splitAddress(app.screen?.matchedAddress || d.job_address);
  return {
    ...d,
    date: usDate(app.submitted_at || app.updated_at),
    job_location: app.screen?.matchedAddress || d.job_address,
    owner_address: d.owner_same_mailing && parts ? parts.street : d.owner_address,
    owner_city: d.owner_same_mailing && parts ? parts.city : d.owner_city,
    owner_state: d.owner_same_mailing && parts ? parts.state : d.owner_state,
    owner_zip: d.owner_same_mailing && parts ? parts.zip : d.owner_zip,
    valuation_text: d.valuation ? Number(d.valuation).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '',
    signed_date: d.signed_at ? usDate(d.signed_at) : '',
    owner_signed_date: d.builder === 'owner' && d.signed_at ? usDate(d.signed_at) : '',
    zoning: d.zoning === 'unknown' ? null : d.zoning,
  };
}

async function fillTemplate(bytes, tpl, app) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const v = formValues(app);
  const setText = (name, value) => {
    if (value == null || value === '') return;
    try { const fld = form.getTextField(name); fld.setFontSize(0); fld.setText(String(value)); } catch (e) { console.log('pdf field', name, e.message); }
  };
  for (const [name, key] of Object.entries(tpl.text)) {
    if (key === 'owner_signed_date' || key === 'job_location' && name === 'Text5') { if (app.data.builder !== 'owner') continue; }
    if (name === 'Text6' && app.data.builder !== 'owner') continue;
    setText(name, v[key]);
  }
  if (tpl.description) {
    const widths = tpl.description.map((n) => { try { return form.getTextField(n).acroField.getWidgets()[0].getRectangle().width; } catch { return 400; } });
    wrap(v.description, font, 9, widths).forEach((line, i) => setText(tpl.description[i], line));
  }
  const tick = (name) => { try { form.getCheckBox(name).check(); } catch (e) { console.log('pdf check', name, e.message); } };
  for (const [key, map] of Object.entries(tpl.checks)) {
    const val = key === 'documents' ? [...new Set((app.files || []).map((x) => x.kind))] : v[key];
    for (const x of Array.isArray(val) ? val : [val]) if (x && map[x] && (key !== 'owner_exemption' || app.data.builder === 'owner')) tick(map[x]);
  }
  form.updateFieldAppearances(font);

  // Signature fields can't hold text, so the typed signature is drawn on the page over each one.
  const sign = (name) => {
    try {
      const w = form.getField(name).acroField.getWidgets()[0];
      const r = w.getRectangle();
      const page = pdf.getPages().find((p) => p.ref === w.P()) || pdf.getPages()[name === 'Signature4' || name === 'Signature3' ? 2 : 1];
      page.drawText(`/s/ ${app.data.signature_name}`, { x: r.x + 4, y: r.y + 4, size: 11, font: italic, color: rgb(0.05, 0.1, 0.35) });
      page.drawText(`Signed electronically ${usDate(app.data.signed_at)}`, { x: r.x + 4, y: r.y - 6, size: 5.5, font, color: rgb(0.35, 0.38, 0.45) });
    } catch (e) { console.log('pdf signature', name, e.message); }
  };
  if (app.data.signature_name && app.data.signed_at) {
    if (app.data.hazmat_ack) sign(tpl.signatures.hazmat);
    if (app.data.certify) sign(tpl.signatures.certify);
    if (app.data.builder === 'owner' && app.data.owner_ack) sign(tpl.signatures.owner);
  }
  stamp(pdf, font, app);
  return pdf.save();
}

function stamp(pdf, font, app) {
  const text = `${app.ref ? `Application ${app.ref}` : 'Draft application'} · prepared with City Hall OS${app.submitted_at ? ` · submitted ${usDate(app.submitted_at)}` : ' · not yet submitted'}`;
  for (const page of pdf.getPages()) page.drawText(text, { x: 36, y: 14, size: 7, font, color: rgb(0.4, 0.42, 0.48) });
}

// A clean, readable application for cities with no fillable template.
async function summaryPdf(app, city) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page; let y;
  const newPage = () => { page = pdf.addPage([612, 792]); y = 750; };
  const line = (text, { f = font, size = 10, indent = 0, color = rgb(0.05, 0.07, 0.14), gap = 4 } = {}) => {
    for (const l of wrap(text, f, size, [540 - indent])) {
      if (y < 50) newPage();
      page.drawText(l, { x: 36 + indent, y, size, font: f, color }); y -= size + gap;
    }
  };
  newPage();
  line(city.name, { f: bold, size: 16 });
  line(`Construction Permit Application${app.ref ? ` · ${app.ref}` : ' · Draft'}`, { size: 12, gap: 14 });
  const d = formValues(app);
  for (const s of SECTIONS) {
    const rows = s.fields.filter((x) => matches(x.when, app.data) && x.type !== 'files').map((x) => {
      let val = app.data[x.key];
      if (x.options) val = Array.isArray(val) ? val.map((k) => label(x.options, k)).join(', ') : label(x.options, val);
      if (x.type === 'bool' || x.type === 'check') val = val === true ? 'Yes' : val === false ? 'No' : '';
      if (x.key === 'job_address') val = d.job_location;
      return [x.label, val];
    }).filter(([, val]) => val != null && val !== '');
    if (s.id === 'documents') rows.push(['Attachments', (app.files || []).map((x) => `${label(DOC_KINDS, x.kind)}: ${x.name}`).join('; ') || 'None']);
    if (!rows.length) continue;
    y -= 6; line(s.title.toUpperCase(), { f: bold, size: 9, color: rgb(0.35, 0.38, 0.45) });
    for (const [l, val] of rows) { line(`${l}: ${val}`, { size: 9.5, indent: 8, gap: 3 }); }
  }
  if (app.data.signature_name && app.data.signed_at) { y -= 10; line(`/s/ ${app.data.signature_name}   Signed electronically ${usDate(app.data.signed_at)}`, { f: bold, size: 11 }); }
  stamp(pdf, font, app);
  return pdf.save();
}

export async function applicationPdf(app, city, template) {
  const tpl = TEMPLATES[city.settings.permits?.construction?.pdfTemplate];
  if (tpl && template) {
    try { return await fillTemplate(template, tpl, app); } catch (e) { console.log('template fill failed, using summary', e.stack || e.message); }
  }
  return summaryPdf(app, city);
}

// The issued permit, sized for a letter page to post at the site.
export async function permitPdf(app, city) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const d = app.data;
  const ink = rgb(0.05, 0.07, 0.14); const muted = rgb(0.37, 0.4, 0.47);
  page.drawRectangle({ x: 24, y: 24, width: 564, height: 744, borderColor: ink, borderWidth: 3 });
  page.drawRectangle({ x: 32, y: 32, width: 548, height: 728, borderColor: ink, borderWidth: 0.8 });
  const center = (text, y, size, f = bold, color = ink) => page.drawText(text, { x: (612 - f.widthOfTextAtSize(text, size)) / 2, y, size, font: f, color });
  center(city.name.toUpperCase(), 712, 15);
  center('Planning & Building Department', 694, 11, font, muted);
  center('CONSTRUCTION PERMIT', 640, 30);
  center(`Permit No. ${app.permit_number}`, 606, 16);
  center('THIS PERMIT MUST BE POSTED AT THE JOB SITE AND VISIBLE FROM THE STREET', 582, 9, bold, rgb(0.7, 0.14, 0.09));
  let y = 540;
  const row = (k, v) => {
    if (!v) return;
    page.drawText(k.toUpperCase(), { x: 70, y, size: 8.5, font: bold, color: muted });
    const lines = wrap(v, font, 12, [380, 380, 380, 380]);
    lines.forEach((l, i) => page.drawText(l, { x: 200, y: y - i * 15, size: 12, font, color: ink }));
    y -= 15 * lines.length + 12;
  };
  row('Job address', app.screen?.matchedAddress || d.job_address);
  row('Tax parcel', d.parcel_number);
  row('Work', `${label(CONSTRUCTION_TYPES, d.construction_type)}${d.occupancy ? ` · ${label(OCCUPANCY, d.occupancy)}` : ''}${d.width && d.length ? ` · ${d.width} × ${d.length} ft` : ''}${d.area_total ? ` · ${Number(d.area_total).toLocaleString()} sq ft` : ''}`);
  row('Description', d.description);
  row('Planned work', (d.planned_work || []).map((k) => label(PLANNED_WORK, k)).join(', '));
  row('Owner', d.owner_name);
  row('Contractor', d.builder === 'owner' ? 'Owner-builder (owner certified an exception to the contractor license requirement)' : `${d.contractor_name || ''}${d.contractor_cor ? ` · MS COR ${d.contractor_cor}` : ''}`);
  row('Valuation', d.valuation ? `$${Number(d.valuation).toLocaleString()}` : '');
  row('Fee paid', app.fee_paid != null ? `$${Number(app.fee_paid).toFixed(2)}` : '');
  row('Application', app.ref);
  row('Issued', usDate(app.decided_at));
  row('Expires', 'If work does not begin within 180 days, or stops for more than 180 days, unless extended by the city.');
  if (app.conditions) row('Conditions', app.conditions);
  page.drawText('Call City Hall to schedule each required inspection before covering work.', { x: 70, y: Math.max(y - 4, 120), size: 10, font: bold, color: ink });
  if (city.settings.phone) page.drawText(`${city.settings.address || ''}  ·  ${city.settings.phone}`, { x: 70, y: Math.max(y - 20, 104), size: 10, font, color: muted });
  page.drawLine({ start: { x: 340, y: 86 }, end: { x: 540, y: 86 }, thickness: 0.8, color: ink });
  page.drawText(`Issued by ${app.issued_by || 'City of ' + city.settings.shortName}`, { x: 340, y: 72, size: 9, font, color: muted });
  return pdf.save();
}

