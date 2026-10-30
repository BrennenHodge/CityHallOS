// Every application residents can fill out online. Each replaces one of the city's PDF forms.
import construction from './construction.js';
import conditionalUse from './conditional_use.js';
import variance from './variance.js';
import rezoning from './rezoning.js';
import sign from './sign.js';
import coResidential from './co_residential.js';
import coCommercial from './co_commercial.js';
import exemption from './exemption.js';
import utilityInspection from './utility_inspection.js';
import utilitySitePlan from './utility_site_plan.js';

export const FORMS = [construction, sign, coResidential, coCommercial, exemption, utilityInspection, variance, conditionalUse, rezoning, utilitySitePlan];
export const KINDS = Object.fromEntries(FORMS.map((x) => [x.kind, x]));
export const formFor = (kind) => KINDS[kind] || null;

// Which form, if any, a resident's message is asking for. The most specific match wins (forms are listed broad to narrow
// in FORMS, so scan from the end).
export function detectForm(text) {
  for (const x of [...FORMS].reverse()) if (x.detect?.test(text)) return x.kind;
  return null;
}
