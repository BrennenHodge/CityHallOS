// Who hears about service requests, and when:
// - staff, when a request comes in (by each request type's routing rule) and when one sits unassigned;
// - residents, when their request is received and when its status changes.
// Messages go through notify.js, which records every one in the city's outbox, sent or not.
import { notify } from './notify.js';
import { afterHours } from './hours.js';

const STATUS_WORDS = {
  new: 'received', needs_info: 'waiting on more information', assigned: 'assigned to a staff member', in_progress: 'being worked on',
  awaiting_review: 'being reviewed', resolved: 'resolved', closed: 'closed',
};
const STALE_HOURS = 4;

// An email address or a US phone number from what the resident typed as contact details.
export function residentContact(contact) {
  const text = String(contact || '');
  const email = (text.match(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i) || [])[0] || null;
  const digits = text.replace(/[^\d]/g, '');
  const phone = digits.length === 10 || (digits.length === 11 && digits.startsWith('1')) ? digits : null;
  return email || phone ? { email, phone, pref: email ? 'email' : 'sms' } : null;
}

const origin = (env) => env.APP_ORIGIN || 'https://app.cityhallos.com';
const trackLink = (env, city) => `${origin(env)}/${city.slug}/`;

async function tellStaff(env, city, store, r, people, { subject, body, sms }) {
  for (const p of people) {
    if (!p.email && !p.phone) continue;
    await notify(env, store, city, {
      entityType: 'request', entityId: r.ref, to: { email: p.email, phone: p.phone, pref: p.notify_pref === 'sms' && p.phone ? 'sms' : p.email ? 'email' : 'sms' },
      msg: { subject, body, sms, link: `${origin(env)}/#/requests`, linkLabel: 'Open the request' },
    });
  }
}

export async function requestCreated(env, city, store, id) {
  const r = await store.getRequest(id);
  if (!r) return;
  const closed = afterHours(city);
  const urgent = ['high', 'urgent'].includes(r.priority);
  await tellStaff(env, city, store, r, await store.routing(r.type_key, closed), {
    subject: `${urgent ? 'Urgent: ' : ''}New request ${r.ref}: ${r.category}`,
    body: `${r.summary || r.description}\n\nRouted to ${r.department}${r.assignee ? ` and assigned to ${r.assignee}` : ''}.${closed ? ' It came in after office hours.' : ''}`,
    sms: `${urgent ? 'URGENT ' : ''}New ${r.category.toLowerCase()} ${r.ref}${r.location ? ` at ${r.location}` : ''}.`,
  });
  // Residents who texted already got the number in the conversation.
  const to = r.source === 'sms' ? null : residentContact(r.contact);
  if (to) {
    await notify(env, store, city, {
      entityType: 'request', entityId: r.ref, to,
      msg: {
        subject: `We received your report: ${r.ref}`,
        body: `Thank you for reporting this to the ${city.name}. Your ${r.category.toLowerCase()} report${r.location ? ` at ${r.location}` : ''} is with ${r.department}, and its number is ${r.ref}.\n\nWe'll let you know when its status changes. You can also check on it any time by asking our AI City Clerk about ${r.ref}.`,
        sms: `We received your ${r.category.toLowerCase()} report. Your number is ${r.ref}. We'll text you when it's updated.`,
        link: trackLink(env, city), linkLabel: 'Check on your request',
      },
    });
  }
}

export async function requestUpdated(env, city, store, before, after) {
  if (!after || before.status === after.status) return;
  const to = residentContact(after.contact);
  if (!to) return;
  const word = STATUS_WORDS[after.status] || after.status.replace(/_/g, ' ');
  await notify(env, store, city, {
    entityType: 'request', entityId: after.ref, to,
    msg: {
      subject: `Your request ${after.ref} is ${word}`,
      body: `Your ${after.category.toLowerCase()} report${after.location ? ` at ${after.location}` : ''} (${after.ref}) is now ${word}.${after.status === 'needs_info' ? ` Please call City Hall${city.settings.phone ? ` at ${city.settings.phone}` : ''} so we can finish the work.` : ''}`,
      sms: `Your ${after.category.toLowerCase()} report ${after.ref} is now ${word}.`,
      link: trackLink(env, city), linkLabel: 'Check on your request',
    },
  });
}

// Run every hour: during office hours, nudges the routed staff about new requests nobody has picked up.
// Urgent ones are nudged after hours too.
export async function remindStale(env, city, store) {
  const cutoff = new Date(Date.now() - STALE_HOURS * 36e5).toISOString();
  const open = !afterHours(city);
  let sent = 0;
  for (const r of await store.staleRequests(cutoff)) {
    const urgent = ['high', 'urgent'].includes(r.priority);
    if (!open && !urgent) continue;
    await tellStaff(env, city, store, r, await store.routing(r.type_key, !open), {
      subject: `Still unassigned: ${r.ref} ${r.category}`,
      body: `${r.ref} came in ${Math.round((Date.now() - new Date(r.created_at)) / 36e5)} hours ago and nobody has picked it up yet.\n\n${r.summary || r.description}`,
      sms: `${r.ref} (${r.category.toLowerCase()}) is still unassigned after ${STALE_HOURS}+ hours.`,
    });
    await store.markReminded(r.id);
    sent++;
  }
  return sent;
}
