// Meeting secretary: boards, meetings, agendas, minutes and action items for a city's public bodies.
//
//   Staff submit agenda items, the clerk accepts and orders them, and a person with meetings.approve publishes the agenda.
//   Recordings go to R2 and are transcribed with Workers AI Whisper; the AI drafts minutes from the transcript or
//   the clerk's typed notes. The clerk edits the draft and a person approves it. Nothing is published without approval.
//   Published agendas and approved minutes are added to the knowledge base, so the AI City Clerk can cite them.
//
// Routes live under /api/{city}/meetings (see meetingsRoute). Data lives in the city store (meetings-store.js).
import Anthropic from '@anthropic-ai/sdk';
import { Buffer } from 'node:buffer';
import { chunkText } from './ingest.js';
import { CLAUDE_MODEL, WORKERS_AI_MODEL } from './assistant.js';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);
const uid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const clean = (v, max = 300) => (v == null || v === '' ? null : String(v).trim().slice(0, max));
const httpError = (status, message) => Object.assign(new Error(message), { status });

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const MP3_SEGMENT = 2 * 1024 * 1024; // about two minutes of a typical meeting recording
const PART_SIZE = 25 * 1024 * 1024; // R2 multipart parts must be at least 5 MiB, except the last
const MAX_SEGMENT = 12 * 1024 * 1024;

const MEETING_KINDS = { regular: 'Regular', special: 'Special', work_session: 'Work session' };
const ITEM_TYPES = { consent: 'Consent', action: 'Action', discussion: 'Discussion', public_hearing: 'Public hearing', report: 'Report' };
const BOARD_KINDS = ['council', 'board', 'commission', 'committee', 'authority', 'other'];
const MEMBER_ROLES = ['presiding', 'vice', 'member', 'clerk', 'attorney', 'staff'];
const ACTION_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];

/* ---------------- Public notice rules ---------------- */

// Mississippi Open Meetings Act, Miss. Code Ann. §§ 25-41-1 to 25-41-17:
//
//   § 25-41-13(1)(a)  Bodies that meet on a schedule set by statute need no further notice for those meetings. Notice of
//                     the place, date, hour and subject matter of any recessed, adjourned, interim or called special
//                     meeting must be posted within one (1) hour after the meeting is called, in a prominent place in the
//                     building where the body normally meets, and a copy made part of the minutes.
//   § 25-41-13(1)(b)  (added by H.B. 1116, 2017) The notice of a called special meeting must also be posted on the body's
//                     website, if it has one it can update, at least one (1) hour before the meeting. Municipalities under
//                     25,000 people (most recent federal census) are exempt from the website requirement.
//   § 25-41-13(2)     Bodies without a statutory schedule record the times and places of their regular meetings in their
//                     minutes; meetings on that recorded schedule need no further notice.
//   § 25-41-11(1)     Minutes must be recorded within a reasonable time, not more than thirty (30) days after the meeting
//                     recesses or adjourns, and must show members present and absent; the date, time and place; an
//                     accurate record of any final actions; and a record, by individual member, of any votes taken.
//
// The Act sets no deadline for posting a regular meeting's agenda, so `regularHours` is the city's own policy
// (its rules of procedure); 72 hours is a common practice and a starting point. Work sessions held off the
// recorded schedule are called special meetings for notice purposes, so they default to the special rule.
// Every value is a per-city setting under Meetings > Notice rules.
export function defaultRules(state) {
  if (state === 'MS') {
    return {
      regularHours: 72, specialHours: 1, workSessionHours: 1, postWithinHours: 1, minutesDays: 30,
      basis: 'Mississippi Open Meetings Act, Miss. Code Ann. § 25-41-13 (notice) and § 25-41-11 (minutes within 30 days). ' +
        'The regular agenda deadline is city policy; state law sets none.',
    };
  }
  return { regularHours: 72, specialHours: 24, workSessionHours: 24, postWithinHours: null, minutesDays: 30,
    basis: "Defaults only. Set these to your state's open meetings law and the city's rules of procedure." };
}

const RULE_KEYS = ['regularHours', 'specialHours', 'workSessionHours', 'postWithinHours', 'minutesDays'];
async function rulesFor(city, store) {
  return { ...defaultRules(city.state), ...((await store.meetings('settings')) || {}) };
}
const requiredHours = (rules, kind) => ({ regular: rules.regularHours, special: rules.specialHours, work_session: rules.workSessionHours }[kind] ?? 0);

/* ---------------- Local time ---------------- */

// Minutes the time zone is ahead of UTC at a given moment.
function tzOffset(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((x) => [x.type, Number(x.value)]));
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - date.getTime()) / 60000);
}

// "2026-11-03T18:00" in the city's time zone, as a UTC Date.
export function localToUtc(local, tz) {
  const [d, t = '00:00'] = local.split('T');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi] = t.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  let guess = wall;
  for (let i = 0; i < 2; i++) guess = wall - tzOffset(new Date(guess), tz) * 60000;
  return new Date(guess);
}

// The city's current wall time, "YYYY-MM-DDTHH:MM".
function localNow(tz, at = new Date()) {
  return new Date(at.getTime() + tzOffset(at, tz) * 60000).toISOString().slice(0, 16);
}

const wall = (local) => { const [d, t = '00:00'] = local.split('T'); return new Date(`${d}T${t}:00Z`); };
const longDate = (local) => wall(local).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeOf = (local) => wall(local).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
const fmtHours = (h) => (Math.abs(h) < 48 ? `${Math.round(h * 10) / 10} hours` : `${Math.round(h / 24 * 10) / 10} days`);
const isoLocal = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s || '');

/* ---------------- Deadlines and warnings ---------------- */

// What the clerk should know about a meeting right now, most urgent first.
export function meetingWarnings(m, rules, tz, at = new Date()) {
  const out = [];
  if (m.status === 'cancelled') return out;
  const start = localToUtc(m.starts_at, tz);
  const need = requiredHours(rules, m.kind);
  const due = new Date(start.getTime() - need * 3600e3);
  const special = m.kind !== 'regular';
  if (m.agenda_status !== 'published' && !m.agenda_published_at && start > at) {
    const left = (due - at) / 3600e3;
    if (left < 0) out.push({ level: 'error', code: 'agenda_late', text: `The agenda should have been published ${fmtHours(-left)} ago (${need} hours before a ${MEETING_KINDS[m.kind].toLowerCase()} meeting).` });
    else if (left < 48) out.push({ level: 'warn', code: 'agenda_due', text: `Publish the agenda within ${fmtHours(left)} to meet the ${need}-hour notice rule.` });
  }
  if (m.agenda_late) out.push({ level: 'warn', code: 'published_late', text: 'The agenda was published later than the notice rule allows.' });
  if (special && !clean(m.purpose)) out.push({ level: 'warn', code: 'no_subject', text: 'Notice of a special meeting must state its subject matter (Miss. Code Ann. § 25-41-13(1)(a)). Add the purpose.' });
  if (special && rules.postWithinHours != null && m.called_at && !m.agenda_published_at) {
    const called = new Date(m.called_at);
    const by = new Date(called.getTime() + rules.postWithinHours * 3600e3);
    const posted = m.notice_posted_at ? new Date(m.notice_posted_at) : null;
    if (posted ? posted > by : at > by) out.push({ level: 'error', code: 'notice_late', text: `Notice must be posted within ${rules.postWithinHours} hour after a special meeting is called.` });
  }
  if (start < at && m.status !== 'postponed' && m.minutes_status !== 'approved' && !m.minutes_approved_at) {
    const days = (at - start) / 864e5;
    const left = rules.minutesDays - days;
    if (left < 0) out.push({ level: 'error', code: 'minutes_late', text: `Minutes are ${Math.ceil(-left)} days past the ${rules.minutesDays}-day limit.` });
    else if (left <= 10) out.push({ level: 'warn', code: 'minutes_due', text: `Minutes are due within ${Math.ceil(left)} days.` });
  }
  if (m.submitted) out.push({ level: 'info', code: 'submitted', text: `${m.submitted} submitted ${m.submitted === 1 ? 'item is' : 'items are'} waiting for the clerk.` });
  return out;
}

/* ---------------- Agenda and minutes text ---------------- */

function meetingTitle(m) {
  return m.title || `${m.board} ${MEETING_KINDS[m.kind].toLowerCase()} meeting`;
}

// The published agenda, in the order the clerk set. Markdown, so the knowledge base splits it by item.
export function renderAgenda(city, m, items, files, origin) {
  const lines = [
    `# ${m.board}: Agenda`,
    `${MEETING_KINDS[m.kind]} meeting, ${longDate(m.starts_at)}, at ${timeOf(m.starts_at)}${m.location ? `. ${m.location}` : ''}. ${city.name}, ${city.settings.state}.`,
  ];
  if (m.title) lines.push(m.title);
  if (m.kind !== 'regular' && m.purpose) lines.push(`This ${MEETING_KINDS[m.kind].toLowerCase()} meeting was called to consider: ${m.purpose}`);
  lines.push('', '## Call to order and roll call');
  let n = 1;
  const consent = items.filter((i) => i.type === 'consent');
  const fileLine = (i) => {
    const f = files.filter((x) => x.item_id === i.id);
    return f.length ? `Attachments: ${f.map((x) => `[${x.file_name}](${origin}/api/${city.slug}/meetings/files/${x.id})`).join(', ')}` : '';
  };
  const itemBlock = (i, num) => [
    `## ${num}. ${i.title}`,
    `${ITEM_TYPES[i.type]} item${i.presenter ? `, presented by ${i.presenter}` : ''}${i.department ? ` (${i.department})` : ''}.`,
    i.description || '',
    i.recommended_action ? `Recommended action: ${i.recommended_action}` : '',
    fileLine(i),
  ].filter(Boolean).join('\n\n');
  const blocks = [];
  if (consent.length) {
    n += 1;
    blocks.push(`## ${n}. Consent agenda\n\nThese items are approved together by one motion unless a member asks to consider one separately.`);
    consent.forEach((i, k) => blocks.push(itemBlock(i, `${n}.${k + 1}`).replace(/^## /, '### ')));
  }
  for (const i of items.filter((x) => x.type !== 'consent')) { n += 1; blocks.push(itemBlock(i, n)); }
  lines.push('', ...blocks.flatMap((b) => [b, '']), `## ${n + 1}. Adjourn`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const names = (a) => (Array.isArray(a) ? a.map((x) => clean(x, 120)).filter(Boolean) : []);
const list = (a) => (a.length ? a.join(', ') : 'none');

// Minutes in the usual municipal format, from the structured draft. § 25-41-11 asks for members present and absent;
// the date, time and place; final actions; and each member's vote.
export function renderMinutes(city, m, d, members) {
  const voting = members.filter((x) => x.voting);
  const present = names(d.present);
  const out = [
    `# ${m.board}: Minutes`,
    `${MEETING_KINDS[m.kind]} meeting, ${longDate(m.starts_at)}${m.location ? `, ${m.location}` : ''}. ${city.name}, ${city.settings.state}.`,
    '',
    '## Call to order',
    `The ${MEETING_KINDS[m.kind].toLowerCase()} meeting of the ${m.board} was called to order${d.called_to_order ? ` at ${d.called_to_order}` : ''}${d.presiding ? ` by ${d.presiding}` : ''}.` +
      (m.kind !== 'regular' && m.purpose ? ` The meeting was called to consider: ${m.purpose}` : ''),
    '',
    '## Attendance',
    `Present: ${list(present)}.`,
    `Absent: ${list(names(d.absent))}.`,
  ];
  if (names(d.also_present).length) out.push(`Also present: ${list(names(d.also_present))}.`);
  if (voting.length && present.length) {
    const here = voting.filter((v) => present.some((p) => p.toLowerCase().includes(v.name.toLowerCase()) || v.name.toLowerCase().includes(p.toLowerCase()))).length;
    out.push(`${here} of ${voting.length} voting members were present${here > voting.length / 2 ? ', a quorum' : ''}.`);
  }
  for (const [k, it] of (Array.isArray(d.items) ? d.items : []).entries()) {
    out.push('', `## ${it.agenda_number || k + 1}. ${clean(it.title, 200) || 'Item'}`);
    if (clean(it.summary, 4000)) out.push(clean(it.summary, 4000).replace(/([^.!?:)\]])$/, '$1.'));
    for (const mo of Array.isArray(it.motions) ? it.motions : []) {
      const yes = names(mo.yes); const no = names(mo.no); const abstain = names(mo.abstain);
      const who = [mo.moved_by && `moved by ${clean(mo.moved_by, 120)}`, mo.seconded_by && `seconded by ${clean(mo.seconded_by, 120)}`].filter(Boolean).join(', ');
      out.push('', `Motion: ${clean(mo.motion, 1000) || 'Motion'}${who ? `, ${who}` : ''}.`);
      const tally = [`${yes.length} yes${yes.length ? ` (${yes.join(', ')})` : ''}`, `${no.length} no${no.length ? ` (${no.join(', ')})` : ''}`];
      if (abstain.length) tally.push(`${abstain.length} abstaining (${abstain.join(', ')})`);
      const result = { carried: 'The motion carried.', failed: 'The motion failed.', tabled: 'The item was tabled.', withdrawn: 'The motion was withdrawn.' }[mo.result]
        || 'Result: [clerk to confirm].';
      out.push(`Vote: ${tally.join(', ')}${mo.unanimous ? ', unanimous' : ''}. ${result}`);
    }
  }
  if (clean(d.public_comments, 4000)) out.push('', '## Public comments', clean(d.public_comments, 4000));
  const actions = Array.isArray(d.actions) ? d.actions : [];
  if (actions.length) {
    out.push('', '## Action items');
    for (const a of actions) out.push(`- ${clean(a.title, 300)}${a.assignee_name ? ` (${clean(a.assignee_name, 120)})` : ''}${a.due_date ? `, due ${clean(a.due_date, 40)}` : ''}`);
  }
  out.push('', '## Adjournment', `There being no further business, the meeting was adjourned${d.adjourned_at ? ` at ${d.adjourned_at}` : ''}.`);
  return out.join('\n');
}

// When the AI can't draft (or there is nothing to draft from), the clerk still gets the meeting's outline.
function skeleton(m, items, members) {
  return {
    called_to_order: null, presiding: members.find((x) => x.role === 'presiding')?.name || null,
    present: [], absent: [], also_present: [],
    items: items.map((i, k) => ({ agenda_number: k + 1, title: i.title, summary: '[Clerk: summarize the discussion.]', motions: [] })),
    actions: [], adjourned_at: null,
  };
}

/* ---------------- AI: transcription and drafting ---------------- */

async function whisper(env, bytes, prompt) {
  const audio = Buffer.from(bytes).toString('base64');
  const input = { audio, task: 'transcribe', language: 'en', vad_filter: true, ...(prompt ? { initial_prompt: prompt.slice(0, 800) } : {}) };
  const r = await env.AI.run(WHISPER_MODEL, input);
  return String(r?.text || '').replace(/\s+/g, ' ').trim();
}

// MP3 can be cut on any byte: decoders resynchronize on the next frame. Start each later segment on a frame header.
function mp3Align(bytes) {
  for (let i = 0; i < Math.min(bytes.length - 1, 8192); i++) {
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) return bytes.subarray(i);
  }
  return bytes;
}

const MINUTES_SCHEMA = {
  type: 'object',
  properties: {
    called_to_order: { type: ['string', 'null'] }, presiding: { type: ['string', 'null'] },
    present: { type: 'array', items: { type: 'string' } }, absent: { type: 'array', items: { type: 'string' } },
    also_present: { type: 'array', items: { type: 'string' } },
    items: { type: 'array', items: { type: 'object', properties: {
      agenda_number: { type: ['integer', 'null'] }, title: { type: 'string' }, summary: { type: 'string' },
      motions: { type: 'array', items: { type: 'object', properties: {
        motion: { type: 'string' }, moved_by: { type: ['string', 'null'] }, seconded_by: { type: ['string', 'null'] },
        yes: { type: 'array', items: { type: 'string' } }, no: { type: 'array', items: { type: 'string' } },
        abstain: { type: 'array', items: { type: 'string' } }, unanimous: { type: 'boolean' },
        result: { type: 'string', enum: ['carried', 'failed', 'tabled', 'withdrawn', 'unclear'] },
      }, required: ['motion', 'moved_by', 'seconded_by', 'yes', 'no', 'abstain', 'unanimous', 'result'] } },
    }, required: ['agenda_number', 'title', 'summary', 'motions'] } },
    public_comments: { type: ['string', 'null'] },
    actions: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, assignee_name: { type: ['string', 'null'] }, due_date: { type: ['string', 'null'] }, agenda_number: { type: ['integer', 'null'] },
    }, required: ['title', 'assignee_name', 'due_date', 'agenda_number'] } },
    adjourned_at: { type: ['string', 'null'] },
  },
  required: ['called_to_order', 'presiding', 'present', 'absent', 'also_present', 'items', 'public_comments', 'actions', 'adjourned_at'],
};

function minutesPrompt(city, m, members, items) {
  return `You draft meeting minutes for the City Clerk of the ${city.name}, ${city.settings.state}. The clerk reviews and edits every draft, and only a person approves minutes.

Return only JSON with these fields: called_to_order (time, e.g. "6:02 PM"), presiding (name), present, absent, also_present (staff and officials who are not members), items (one per agenda item or business taken up, in order: agenda_number, title, summary, motions), public_comments, actions (follow-up work assigned to staff: title, assignee_name, due_date as YYYY-MM-DD or null, agenda_number), adjourned_at.

For each motion: the motion's wording, moved_by, seconded_by, and the vote by member name in yes, no and abstain. If the vote was unanimous by voice ("all in favor", "motion carries unanimously"), list every voting member who was present as yes and set unanimous to true. result is carried, failed, tabled, withdrawn, or unclear.

Rules:
- Use only what the source says. Never invent a motion, a second, a vote or an attendee. If something is unclear, leave it null or empty and set result to "unclear".
- Write member names exactly as they appear in the roster.
- Summaries are short, neutral and in the past tense: what was presented and decided, not who said what word for word.
- Do not include closed (executive) session discussion beyond the motion to enter it and any final action.
- The meeting was held on ${m.starts_at.slice(0, 10)}. Write due dates as YYYY-MM-DD; a date said without a year is the next such date after the meeting.

Meeting: ${meetingTitle(m)}, ${MEETING_KINDS[m.kind]} meeting, ${longDate(m.starts_at)} at ${timeOf(m.starts_at)}${m.location ? `, ${m.location}` : ''}.${m.purpose ? ` Purpose: ${m.purpose}.` : ''}
Roster: ${members.length ? members.map((x) => `${x.name}${x.seat ? ` (${x.seat})` : ''}${x.role !== 'member' ? `, ${x.role}` : ''}${x.voting ? '' : ', non-voting'}`).join('; ') : 'not entered'}.
Published agenda:
${items.length ? items.map((i, k) => `${k + 1}. ${i.title} (${ITEM_TYPES[i.type]})${i.recommended_action ? ` — recommended: ${i.recommended_action}` : ''}`).join('\n') : 'none'}`;
}

function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The AI did not return minutes');
  return JSON.parse(s.slice(a, b + 1));
}

async function complete(env, system, user, { schema, maxTokens = 4000 } = {}) {
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({ model: CLAUDE_MODEL, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] });
    return { text: msg.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), model: CLAUDE_MODEL };
  }
  const r = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens,
    ...(schema ? { response_format: { type: 'json_schema', json_schema: schema } } : {}),
  });
  const out = r?.response ?? r?.choices?.[0]?.message?.content ?? '';
  return { text: typeof out === 'string' ? out : JSON.stringify(out), model: WORKERS_AI_MODEL };
}

// Long transcripts are condensed in parts first (motions, votes and assignments kept verbatim), then drafted.
const PART_CHARS = 14000;
async function draftWithAi(env, city, m, members, items, source) {
  const system = minutesPrompt(city, m, members, items);
  let text = source;
  const big = !env.ANTHROPIC_API_KEY && text.length > PART_CHARS * 1.3;
  if (big) {
    const parts = [];
    for (let i = 0; i < text.length; i += PART_CHARS) parts.push(text.slice(i, i + PART_CHARS));
    const notes = [];
    for (const [k, part] of parts.entries()) {
      const r = await complete(env, `You take notes for a city clerk. From this part of a meeting transcript, list in plain bullets: who was present or absent if stated, each agenda item taken up, what was presented, every motion with who moved and seconded it, every vote by member name and the result, public comments, and any work assigned to staff with deadlines. Keep names exactly as spoken. Do not invent anything.`,
        `Part ${k + 1} of ${parts.length}:\n\n${part}`, { maxTokens: 1500 });
      notes.push(`Notes from part ${k + 1}:\n${r.text}`);
    }
    text = notes.join('\n\n');
  }
  const r = await complete(env, system, `Source (${big ? "notes condensed from the meeting transcript" : 'meeting record'}):\n\n${text.slice(0, env.ANTHROPIC_API_KEY ? 400000 : 30000)}`,
    { schema: MINUTES_SCHEMA });
  return { draft: parseJson(r.text), model: r.model };
}

// Things the clerk should double-check before approving: names not on the roster, motions without a second, unclear votes.
function checks(d, members) {
  const out = [];
  const known = members.map((x) => x.name.toLowerCase());
  const onRoster = (n) => !known.length || known.some((k) => k.includes(n.toLowerCase()) || n.toLowerCase().includes(k.split(' ').pop()));
  for (const it of d.items || []) {
    for (const mo of it.motions || []) {
      const where = `"${clean(it.title, 80)}"`;
      if (!mo.moved_by) out.push(`${where}: who made the motion is not in the source.`);
      if (!mo.seconded_by) out.push(`${where}: no second recorded.`);
      if (mo.result === 'unclear' || !mo.result) out.push(`${where}: the vote result is unclear.`);
      for (const n of [mo.moved_by, mo.seconded_by, ...names(mo.yes), ...names(mo.no)].filter(Boolean)) {
        if (!onRoster(n)) out.push(`${where}: "${n}" is not on the board's roster.`);
      }
    }
  }
  return [...new Set(out)].slice(0, 30);
}

/* ---------------- Knowledge base ---------------- */

// Published agendas and approved minutes become official, current documents in the knowledge base. A meeting keeps
// one document of each kind, replaced when the agenda is amended or corrected minutes are approved.
async function publishToKnowledge(store, city, m, kind, text, actor, origin) {
  const field = kind === 'agenda' ? 'agenda_doc_id' : 'minutes_doc_id';
  const title = `${m.board} ${kind}: ${MEETING_KINDS[m.kind].toLowerCase()} meeting of ${longDate(m.starts_at)}`;
  const asOf = m.starts_at.slice(0, 10);
  const existing = m[field] && (await store.documentRow(m[field]));
  if (existing) {
    await store.updateDocument(existing.id, { title, as_of: asOf, verification: 'verified_current', visibility: 'public' }, actor);
    await store.indexDocument(existing.id, chunkText(text), text.length, actor, kind === 'agenda' ? 'Published the amended agenda as' : 'Published corrected minutes as');
    return existing.id;
  }
  const id = uid('d');
  await store.createDocument({
    id, title, category: 'Meetings & Minutes', source_url: `${origin}/${city.slug}/meetings#${m.id}`, authority: 'official-city', visibility: 'public',
    verification: 'verified_current', as_of: asOf, file_key: null, file_name: null, mime: 'text/markdown', bytes: 0,
    notes: `Published from Meetings. Change it there: edits made here are replaced the next time the ${kind} is published.`,
  }, actor);
  await store.indexDocument(id, chunkText(text), text.length, actor);
  await store.meetings('setDocument', m.id, field, id);
  return id;
}

/* ---------------- Notifications ---------------- */

// NOTIFY HOOK: when platform/src/notify.js is on main, send the assignee an email here:
//   notify(env, store, city, { entityType: 'action_item', entityId: action.id, to: action.assignee_email,
//     msg: { subject: `Action item: ${action.title}`, text: `${action.board}, ${action.meeting_starts_at}. Due ${action.due_date || 'no date'}.` } })
// Until then assignments are visible on the assignee's Action items list in the dashboard.
async function notifyAssignee(_env, _store, _city, _action) {}

/* ---------------- Routes ---------------- */

export async function meetingsRoute({ request, env, url, city, store, me, path }) {
  const m = request.method;
  const [a, b, c, d] = path;

  // Public: residents see published agendas and approved minutes only.
  if (a === 'public' && m === 'GET') {
    if (b) {
      const meeting = await store.meetings('publicGet', b);
      if (!meeting || (!meeting.agenda_published && !meeting.minutes_approved && meeting.starts_at < localNow(city.timezone).slice(0, 10))) return fail(404, 'Meeting not found');
      return json({ meeting }, 200, { 'Cache-Control': 'public, max-age=60' });
    }
    const s = city.settings;
    return json({
      city: { slug: city.slug, name: city.name, shortName: s.shortName, state: s.state, phone: s.phone, address: s.address, brandColor: s.brandColor, assistantName: s.assistantName, publicSite: s.publicSite },
      now: localNow(city.timezone), boards: (await store.meetings('boards')).map(({ id, name, schedule, location }) => ({ id, name, schedule, location })),
      meetings: await store.meetings('publicList', { today: localNow(city.timezone).slice(0, 10) }),
    }, 200, { 'Cache-Control': 'public, max-age=60' });
  }
  if (a === 'files' && b && !c && m === 'GET') return downloadFile(env, store, b, me);

  if (!me) return fail(401, 'Please sign in');
  const need = (perm) => { if (!me.can(perm)) throw httpError(403, "Your role doesn't allow this"); };
  const body = async () => request.json().catch(() => ({}));

  // Notice rules.
  if (a === 'settings') {
    if (m === 'GET') { need('meetings.view'); return json({ rules: await rulesFor(city, store), defaults: defaultRules(city.state) }); }
    if (m === 'PUT') { need('settings.edit'); return saveRules(await body(), city, store, me); }
  }

  // Boards and members.
  if (a === 'boards') {
    if (!b && m === 'GET') { need('meetings.view'); return json({ boards: await store.meetings('boards', { includeInactive: true }) }); }
    if (!b && m === 'POST') { need('meetings.manage'); return saveBoard(await body(), null, store, me); }
    if (b && !c && m === 'PATCH') { need('meetings.manage'); return saveBoard(await body(), b, store, me); }
    if (b && c === 'members' && !d && m === 'POST') { need('meetings.manage'); return saveMember({ ...(await body()), board_id: b }, null, store, me); }
  }
  if (a === 'members' && b && m === 'PATCH') { need('meetings.manage'); return saveMember(await body(), b, store, me); }

  // Action items.
  if (a === 'actions') {
    if (!b && m === 'GET') {
      need('meetings.view');
      const mine = url.searchParams.get('mine');
      if (mine && !me.staffId) return json({ actions: [] });
      return json({ actions: await store.meetings('actions', { status: url.searchParams.get('status') || null, open: url.searchParams.get('open') === '1', assigneeId: mine ? me.staffId : null }) });
    }
    if (b && m === 'PATCH') return updateAction(await body(), b, env, city, store, me);
  }

  if (a === 'files' && b && !c && m === 'DELETE') {
    const f = await store.meetings('file', b);
    if (!f) return fail(404, 'File not found');
    const item = f.item_id && (await store.meetings('item', f.item_id));
    if (!me.can('meetings.manage') && !(item && ownItem(item, me) && item.status === 'submitted')) throw httpError(403, "Your role doesn't allow this");
    await store.meetings('deleteFile', b, me.actor);
    await env.FILES.delete(f.file_key);
    return json({ ok: true });
  }

  // Meetings.
  if (!a && m === 'GET') { need('meetings.view'); return listMeetings(url, city, store); }
  if (!a && m === 'POST') { need('meetings.manage'); return createMeeting(await body(), city, store, me); }
  if (!a) return fail(404, 'Not found');

  const meeting = await store.meetings('row', a);
  if (!meeting) return fail(404, 'Meeting not found');
  const id = a;

  if (!b && m === 'GET') { need('meetings.view'); return meetingDetail(id, city, store); }
  if (!b && m === 'PATCH') { need('meetings.manage'); return updateMeeting(await body(), meeting, city, store, me); }

  if (b === 'items') {
    if (!c && m === 'POST') { need('meetings.submit'); return addItem(await body(), meeting, store, me); }
    if (c === 'order' && m === 'POST') {
      need('meetings.manage');
      const ids = (await body()).order;
      if (!Array.isArray(ids)) return fail(400, 'Send the new order as a list of item ids');
      try { await store.meetings('orderItems', id, ids.map(String), me.actor); } catch (e) { return fail(400, e.message); }
      return meetingDetail(id, city, store);
    }
    if (c && !d && m === 'PATCH') return updateItem(await body(), c, meeting, store, me);
    if (c && d === 'files' && m === 'POST') return attachFile(request, env, city, store, meeting, c, me);
  }

  if (b === 'agenda') {
    if (c === 'ready' && m === 'POST') { need('meetings.manage'); await store.meetings('setAgendaStatus', id, 'ready', me.actor); return meetingDetail(id, city, store); }
    if (c === 'draft' && m === 'POST') { need('meetings.manage'); await store.meetings('setAgendaStatus', id, 'draft', me.actor); return meetingDetail(id, city, store); }
    if (c === 'preview' && m === 'GET') { need('meetings.view'); return json({ text: await agendaText(city, store, id, url.origin) }); }
    if (c === 'publish' && m === 'POST') { need('meetings.approve'); return publishAgenda(await body(), meeting, city, store, me, url.origin); }
  }

  if (b === 'recording') {
    need('meetings.manage');
    if (!c && m === 'POST') return startRecording(await body(), env, city, store, meeting, me);
    if (c && !d && m === 'PUT') return uploadPart(request, env, store, c, url);
    if (c && d === 'complete' && m === 'POST') return finishRecording(await body(), env, store, c, me);
  }
  if (b === 'transcribe' && m === 'POST') { need('meetings.manage'); return transcribe(request, env, url, city, store, meeting, me); }
  if (b === 'transcript' && m === 'PUT') {
    need('meetings.manage');
    await store.meetings('saveTranscript', id, clean((await body()).text, 1_000_000) || '', me.actor);
    return meetingDetail(id, city, store);
  }
  if (b === 'notes' && m === 'PUT') {
    need('meetings.manage');
    await store.meetings('saveNotes', id, clean((await body()).notes, 200_000), me.actor);
    return meetingDetail(id, city, store);
  }

  if (b === 'minutes') {
    if (c === 'draft' && m === 'POST') { need('meetings.manage'); return draftMinutes(await body(), env, city, store, meeting, me); }
    if (!c && m === 'PUT') {
      need('meetings.manage');
      const text = clean((await body()).text, 500_000);
      if (!text) return fail(400, 'The minutes are empty');
      try { await store.meetings('saveMinutesDraft', id, { text }, me.actor); } catch (e) { return fail(409, e.message); }
      return meetingDetail(id, city, store);
    }
    if (c === 'approve' && m === 'POST') { need('meetings.approve'); return approveMinutes(meeting, city, store, me, url.origin); }
    if (c === 'reopen' && m === 'POST') { need('meetings.manage'); await store.meetings('reopenMinutes', id, me.actor); return meetingDetail(id, city, store); }
  }

  if (b === 'actions' && m === 'POST') { need('meetings.manage'); return addAction(await body(), meeting, env, city, store, me); }
  if (b === 'history' && m === 'GET') { need('meetings.view'); return json({ events: await store.audit({ entityType: 'meeting', entityId: id, limit: 200 }) }); }
  return fail(404, 'Not found');
}

const ownItem = (item, me) => !!me.user && item.submitted_by_id === me.user.id;

/* ---------------- Handlers ---------------- */

async function saveRules(b, city, store, me) {
  const current = await rulesFor(city, store);
  const next = { ...current };
  for (const k of RULE_KEYS) {
    if (!(k in b)) continue;
    if (b[k] === null || b[k] === '') { if (k === 'postWithinHours') next[k] = null; continue; }
    const v = Number(b[k]);
    if (!Number.isFinite(v) || v < 0 || v > (k === 'minutesDays' ? 365 : 24 * 60)) return fail(400, `Enter a valid number for ${k}`);
    next[k] = v;
  }
  const { basis, ...stored } = next;
  const { basis: _b, ...before } = current;
  await store.meetings('saveSettings', stored, before, me.actor);
  return json({ rules: await rulesFor(city, store), defaults: defaultRules(city.state) });
}

async function saveBoard(b, id, store, me) {
  const p = {};
  if (!id || 'name' in b) { p.name = clean(b.name, 120); if (!p.name) return fail(400, 'Enter a name'); }
  if ('kind' in b) p.kind = BOARD_KINDS.includes(b.kind) ? b.kind : 'board';
  for (const [k, max] of [['description', 1000], ['schedule', 300], ['location', 300]]) if (k in b) p[k] = clean(b[k], max);
  if ('active' in b) p.active = b.active ? 1 : 0;
  try {
    const board = await store.meetings('saveBoard', id, p, me.actor);
    return board ? json({ board }, id ? 200 : 201) : fail(404, 'Board not found');
  } catch (e) {
    return fail(/UNIQUE/.test(e.message) ? 409 : 400, /UNIQUE/.test(e.message) ? 'A board with that name already exists' : e.message);
  }
}

async function saveMember(b, id, store, me) {
  const p = {};
  if (!id) { p.board_id = b.board_id; }
  if (!id || 'name' in b) { p.name = clean(b.name, 120); if (!p.name) return fail(400, 'Enter a name'); }
  if ('seat' in b) p.seat = clean(b.seat, 120);
  if ('role' in b) p.role = MEMBER_ROLES.includes(b.role) ? b.role : 'member';
  if ('voting' in b) p.voting = b.voting ? 1 : 0;
  if ('staff_id' in b) p.staff_id = clean(b.staff_id, 20);
  if ('term_ends' in b) p.term_ends = clean(b.term_ends, 20);
  if ('active' in b) p.active = b.active ? 1 : 0;
  if ('sort' in b) p.sort = Number(b.sort) || 0;
  try {
    const member = await store.meetings('saveMember', id, p, me.actor);
    return member ? json({ member }, id ? 200 : 201) : fail(404, 'Member not found');
  } catch (e) { return fail(400, e.message); }
}

async function listMeetings(url, city, store) {
  const rules = await rulesFor(city, store);
  const today = localNow(city.timezone).slice(0, 10);
  const when = url.searchParams.get('when');
  const meetings = await store.meetings('list', {
    from: when === 'upcoming' ? today : null, to: when === 'past' ? today : null, boardId: url.searchParams.get('board') || null,
  });
  const at = new Date();
  return json({
    now: localNow(city.timezone), rules,
    meetings: meetings.map((m) => ({ ...m, warnings: meetingWarnings(m, rules, city.timezone, at) })),
    boards: await store.meetings('boards'),
  });
}

async function meetingDetail(id, city, store) {
  const found = await store.meetings('get', id);
  if (!found) return fail(404, 'Meeting not found');
  const rules = await rulesFor(city, store);
  const m = found.meeting;
  const start = localToUtc(m.starts_at, city.timezone);
  const need = requiredHours(rules, m.kind);
  return json({
    ...found, rules, now: localNow(city.timezone),
    deadlines: {
      agendaBy: localNow(city.timezone, new Date(start.getTime() - need * 3600e3)), agendaHours: need,
      minutesBy: localNow(city.timezone, new Date(start.getTime() + rules.minutesDays * 864e5)).slice(0, 10),
    },
    warnings: meetingWarnings({ ...m, submitted: found.items.filter((i) => i.status === 'submitted').length }, rules, city.timezone),
  });
}

function meetingInput(b, city, partial) {
  const p = {};
  if (!partial || 'board_id' in b) p.board_id = clean(b.board_id, 20);
  if (!partial || 'kind' in b) p.kind = MEETING_KINDS[b.kind] ? b.kind : 'regular';
  if (!partial || 'starts_at' in b) {
    p.starts_at = clean(b.starts_at, 16);
    if (!isoLocal(p.starts_at)) throw httpError(400, 'Enter the date and time as YYYY-MM-DDTHH:MM');
  }
  for (const [k, max] of [['title', 200], ['location', 300], ['purpose', 2000]]) if (!partial || k in b) p[k] = clean(b[k], max);
  for (const k of ['called_at', 'notice_posted_at']) {
    if (!(k in b)) continue;
    // Entered as the city's local time; stored as UTC.
    const v = clean(b[k], 30);
    p[k] = !v ? null : isoLocal(v) ? localToUtc(v, city.timezone).toISOString() : Number.isNaN(Date.parse(v)) ? null : new Date(v).toISOString();
  }
  if (partial && 'status' in b) {
    if (!['scheduled', 'held', 'cancelled', 'postponed'].includes(b.status)) throw httpError(400, 'Invalid status');
    p.status = b.status;
  }
  return p;
}

async function createMeeting(b, city, store, me) {
  const p = meetingInput(b, city, false);
  const board = p.board_id && (await store.meetings('board', p.board_id));
  if (!board) return fail(400, 'Choose a board');
  if (!p.location) p.location = board.location;
  // A special meeting is "called" when it is scheduled, unless the clerk says otherwise.
  if (p.kind !== 'regular' && !p.called_at) p.called_at = new Date().toISOString();
  const meeting = await store.meetings('create', p, me.actor);
  return json({ meeting }, 201);
}

async function updateMeeting(b, meeting, city, store, me) {
  const p = meetingInput(b, city, true);
  if (p.board_id && !(await store.meetings('board', p.board_id))) return fail(400, 'Choose a board');
  await store.meetings('update', meeting.id, p, me.actor);
  return meetingDetail(meeting.id, city, store);
}

function itemInput(b, partial) {
  const p = {};
  if (!partial || 'title' in b) { p.title = clean(b.title, 300); if (!p.title) throw httpError(400, 'Enter a title'); }
  if (!partial || 'type' in b) p.type = ITEM_TYPES[b.type] ? b.type : 'action';
  for (const [k, max] of [['description', 5000], ['presenter', 160], ['department_id', 60], ['recommended_action', 1000]]) if (!partial || k in b) p[k] = clean(b[k], max);
  return p;
}

async function addItem(b, meeting, store, me) {
  if (meeting.status === 'cancelled') return fail(400, 'This meeting was cancelled');
  const p = itemInput(b, false);
  // The clerk's own additions go straight onto the agenda; everyone else's wait for the clerk.
  p.status = me.can('meetings.manage') && b.status !== 'submitted' ? 'accepted' : 'submitted';
  return json({ item: await store.meetings('addItem', meeting.id, p, me.actor) }, 201);
}

async function updateItem(b, itemId, meeting, store, me) {
  const item = await store.meetings('item', itemId);
  if (!item || item.meeting_id !== meeting.id) return fail(404, 'Item not found');
  const manage = me.can('meetings.manage');
  const own = ownItem(item, me) && me.can('meetings.submit');
  if (!manage && !own) throw httpError(403, "Your role doesn't allow this");
  const p = itemInput(b, true);
  if ('status' in b) {
    const allowed = manage ? ['accepted', 'returned', 'withdrawn', 'submitted'] : ['withdrawn', 'submitted'];
    if (!allowed.includes(b.status)) throw httpError(403, 'Only the clerk can accept or return agenda items');
    p.status = b.status;
    if ('review_note' in b) p.review_note = clean(b.review_note, 1000);
  }
  if (!manage && item.status === 'accepted') return fail(409, 'This item is on the agenda. Ask the clerk to change it.');
  return json({ item: await store.meetings('updateItem', itemId, p, me.actor) });
}

async function attachFile(request, env, city, store, meeting, itemId, me) {
  const item = await store.meetings('item', itemId);
  if (!item || item.meeting_id !== meeting.id) return fail(404, 'Item not found');
  if (!me.can('meetings.manage') && !(ownItem(item, me) && me.can('meetings.submit'))) throw httpError(403, "Your role doesn't allow this");
  const form = await request.formData().catch(() => null);
  const files = form ? form.getAll('file').filter((f) => typeof f === 'object' && f.size) : [];
  if (!files.length) return fail(400, 'Attach a file');
  const saved = [];
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) return fail(400, `${f.name} is larger than 50 MB`);
    const id = uid('f');
    const key = `${city.id}/meetings/${meeting.id}/${id}/${f.name.replace(/[^\w.-]+/g, '_')}`;
    await env.FILES.put(key, await f.arrayBuffer(), { httpMetadata: { contentType: f.type || 'application/octet-stream' } });
    saved.push(await store.meetings('addFile', { id, meeting_id: meeting.id, item_id: itemId, kind: 'attachment', file_key: key, file_name: f.name.slice(0, 200), mime: f.type, bytes: f.size }, me.actor));
  }
  return json({ files: saved.map(({ file_key, upload_id, ...f }) => f) }, 201);
}

async function downloadFile(env, store, id, me) {
  const found = await store.meetings('fileAccess', id);
  if (!found || (!found.public && !me?.can('meetings.view'))) return fail(404, 'File not found');
  const obj = await env.FILES.get(found.file.file_key);
  if (!obj) return fail(404, 'File not found');
  return new Response(obj.body, {
    headers: {
      'Content-Type': found.file.mime || 'application/octet-stream', 'Content-Length': String(obj.size),
      'Content-Disposition': `inline; filename="${found.file.file_name.replace(/"/g, '')}"`,
      'Cache-Control': found.public ? 'public, max-age=3600' : 'private, no-store', ...CORS,
    },
  });
}

async function agendaText(city, store, id, origin) {
  const { meeting, items, files } = await store.meetings('get', id);
  return renderAgenda(city, meeting, items.filter((i) => i.status === 'accepted'), files.filter((f) => f.kind === 'attachment'), origin);
}

async function publishAgenda(b, meeting, city, store, me, origin) {
  if (meeting.status === 'cancelled') return fail(400, 'This meeting was cancelled');
  const { items } = await store.meetings('get', meeting.id);
  if (!items.some((i) => i.status === 'accepted')) return fail(400, 'Add at least one item to the agenda before publishing');
  const rules = await rulesFor(city, store);
  const need = requiredHours(rules, meeting.kind);
  const start = localToUtc(meeting.starts_at, city.timezone);
  const hoursBefore = (start - Date.now()) / 3600e3;
  const problems = [];
  if (hoursBefore < need) {
    problems.push(hoursBefore < 0 ? `The meeting started ${fmtHours(-hoursBefore)} ago.`
      : `Only ${fmtHours(hoursBefore)} before the meeting; the rule for a ${MEETING_KINDS[meeting.kind].toLowerCase()} meeting is ${need} hours.`);
  }
  if (meeting.kind !== 'regular' && rules.postWithinHours != null && meeting.called_at && !meeting.agenda_published_at
    && (Date.now() - Date.parse(meeting.called_at)) / 3600e3 > rules.postWithinHours) {
    problems.push(`Notice of a called meeting must be posted within ${rules.postWithinHours} hour after it is called (Miss. Code Ann. § 25-41-13(1)(a)).`);
  }
  if (meeting.kind !== 'regular' && !clean(meeting.purpose)) return fail(400, 'State the purpose of this special meeting before publishing; the notice must give its subject matter.');
  // Publishing late is the approver's call, but they have to see the warning and say so.
  if (problems.length && !b.acknowledgeLate) return fail(409, `This agenda is late. ${problems.join(' ')}`, { late: true, problems });
  const text = await agendaText(city, store, meeting.id, origin);
  const updated = await store.meetings('publishAgenda', meeting.id, { text, late: problems.length > 0, lateReason: problems.join(' ') + (clean(b.reason, 500) ? ` Reason given: ${clean(b.reason, 500)}` : '') }, me.actor);
  const board = (await store.meetings('board', meeting.board_id)).name;
  await publishToKnowledge(store, city, { ...updated, board }, 'agenda', text, me.actor, origin);
  return meetingDetail(meeting.id, city, store);
}

async function startRecording(b, env, city, store, meeting, me) {
  const name = clean(b.file_name, 200);
  const bytes = Number(b.bytes) || 0;
  if (!name || !bytes) return fail(400, 'Send the file name and size');
  if (bytes > 5 * 1024 ** 3) return fail(400, 'Recordings can be up to 5 GB');
  const mime = clean(b.mime, 120) || 'application/octet-stream';
  if (!/^(audio|video)\//.test(mime) && !/\.(mp3|m4a|wav|aac|ogg|oga|opus|flac|webm|mp4|mov|m4v|mkv|wma)$/i.test(name)) return fail(400, 'Upload an audio or video file');
  const id = uid('f');
  const key = `${city.id}/meetings/${meeting.id}/${id}/${name.replace(/[^\w.-]+/g, '_')}`;
  const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: mime } });
  await store.meetings('addFile', { id, meeting_id: meeting.id, kind: 'recording', file_key: key, file_name: name, mime, bytes, upload_id: upload.uploadId, status: 'uploading' }, me.actor);
  return json({ fileId: id, partSize: PART_SIZE, parts: Math.max(1, Math.ceil(bytes / PART_SIZE)) }, 201);
}

async function uploadPart(request, env, store, fileId, url) {
  const f = await store.meetings('file', fileId);
  if (!f || f.status !== 'uploading') return fail(404, 'Upload not found');
  const n = Number(url.searchParams.get('part'));
  if (!Number.isInteger(n) || n < 1 || n > 10000) return fail(400, 'Invalid part number');
  const part = await env.FILES.resumeMultipartUpload(f.file_key, f.upload_id).uploadPart(n, await request.arrayBuffer());
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function finishRecording(b, env, store, fileId, me) {
  const f = await store.meetings('file', fileId);
  if (!f || f.status !== 'uploading') return fail(404, 'Upload not found');
  const parts = (Array.isArray(b.parts) ? b.parts : []).map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }));
  if (!parts.length) return fail(400, 'No parts were uploaded');
  const obj = await env.FILES.resumeMultipartUpload(f.file_key, f.upload_id).complete(parts);
  const file = await store.meetings('completeFile', fileId, obj.size, me.actor);
  const { file_key, upload_id, ...rest } = file;
  return json({ file: rest, transcribe: /mpeg|mp3/i.test(file.mime || '') || /\.mp3$/i.test(file.file_name) ? 'server' : 'browser',
    segments: Math.max(1, Math.ceil(obj.size / MP3_SEGMENT)) });
}

// One segment per call. MP3 recordings are read from R2 in byte ranges; other formats are decoded in the
// dashboard into 16 kHz WAV segments and sent as the request body.
async function transcribe(request, env, url, city, store, meeting, me) {
  const { members } = await store.meetings('get', meeting.id);
  const prompt = `${city.name} ${meeting.kind.replace('_', ' ')} meeting of the ${(await store.meetings('board', meeting.board_id)).name}. ${members.map((x) => x.name).join(', ')}.`;
  let seq; let total; let bytes; let source; let fileId = clean(url.searchParams.get('fileId'), 20);
  if ((request.headers.get('Content-Type') || '').includes('json')) {
    const b = await request.json();
    const f = await store.meetings('file', clean(b.fileId, 20));
    if (!f || f.meeting_id !== meeting.id || f.kind !== 'recording' || f.status !== 'ready') return fail(404, 'Recording not found');
    total = Math.max(1, Math.ceil(f.bytes / MP3_SEGMENT));
    seq = Number(b.seq) || 0;
    if (seq < 0 || seq >= total) return fail(400, 'Invalid segment');
    const obj = await env.FILES.get(f.file_key, { range: { offset: seq * MP3_SEGMENT, length: Math.min(MP3_SEGMENT, f.bytes - seq * MP3_SEGMENT) } });
    if (!obj) return fail(404, 'Recording not found');
    bytes = new Uint8Array(await obj.arrayBuffer());
    if (seq > 0) bytes = mp3Align(bytes);
    source = f.file_name;
    fileId = f.id;
  } else {
    seq = Number(url.searchParams.get('seq'));
    total = Number(url.searchParams.get('total'));
    if (!Number.isInteger(seq) || !Number.isInteger(total) || seq < 0 || seq >= total || total > 2000) return fail(400, 'Send seq and total');
    bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SEGMENT) return fail(400, 'Audio segments must be under 12 MB');
    source = clean(url.searchParams.get('source'), 200) || 'the recording';
  }
  let text;
  try {
    text = await whisper(env, bytes, prompt);
  } catch (e) {
    console.log('whisper failed', e.message);
    return fail(502, `Transcription failed on segment ${seq + 1} of ${total}. Try again to resume from there.`, { seq, total });
  }
  const updated = await store.meetings('appendTranscript', meeting.id, { seq, total, text, source, fileId }, me.actor);
  return json({ seq, total, text, done: seq + 1 >= total, words: (updated.transcript || '').split(/\s+/).filter(Boolean).length });
}

// Due dates the model resolved to the wrong year ("November 20" read as 2022) move to the first such date after the meeting.
function dueAfter(due, startsAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due || '')) return null;
  const held = startsAt.slice(0, 10);
  if (due >= held) return due;
  const year = Number(held.slice(0, 4));
  const same = `${year}${due.slice(4)}`;
  return same >= held ? same : `${year + 1}${due.slice(4)}`;
}

async function draftMinutes(b, env, city, store, meeting, me) {
  const source = b.source === 'notes' ? 'notes' : 'transcript';
  if (source === 'notes' && 'notes' in b) await store.meetings('saveNotes', meeting.id, clean(b.notes, 200_000), me.actor);
  const { meeting: m, members, items } = await store.meetings('get', meeting.id);
  if (m.minutes_status === 'approved') return fail(409, 'These minutes are approved. Reopen them to make corrections.');
  const text = source === 'notes' ? m.notes : m.transcript;
  if (!clean(text)) return fail(400, source === 'notes' ? 'Type your meeting notes first' : 'Upload and transcribe the recording first, or draft from typed notes');
  const agenda = items.filter((i) => i.status === 'accepted');
  let draft; let model; let error = null;
  try {
    ({ draft, model } = await draftWithAi(env, city, m, members, agenda, text));
  } catch (e) {
    console.log('minutes draft failed', e.stack || e.message);
    error = 'The AI could not draft these minutes, so this is the outline from the agenda. Fill it in from your notes.';
    draft = skeleton(m, agenda, members);
    model = null;
  }
  const minutes = renderMinutes(city, m, draft, members);
  const suggestions = { model, error, checks: error ? [] : checks(draft, members),
    actions: (draft.actions || []).map((x) => ({ title: clean(x.title, 300), assignee_name: clean(x.assignee_name, 120), due_date: dueAfter(x.due_date, m.starts_at) })).filter((x) => x.title) };
  await store.meetings('saveMinutesDraft', m.id, { text: minutes, source: source === 'notes' ? "clerk's notes" : 'transcript', suggestions }, me.actor);
  return meetingDetail(m.id, city, store);
}

async function approveMinutes(meeting, city, store, me, origin) {
  if (meeting.minutes_status !== 'draft') return fail(400, meeting.minutes_status === 'approved' ? 'These minutes are already approved' : 'There is no draft to approve');
  const updated = await store.meetings('approveMinutes', meeting.id, me.actor);
  const board = (await store.meetings('board', meeting.board_id)).name;
  const text = `${updated.minutes_approved}\n\nApproved for publication by ${me.actor.name} on ${updated.minutes_approved_at.slice(0, 10)}.`;
  await publishToKnowledge(store, city, { ...updated, board }, 'minutes', text, me.actor, origin);
  return meetingDetail(meeting.id, city, store);
}

function actionInput(b, partial) {
  const p = {};
  if (!partial || 'title' in b) { p.title = clean(b.title, 300); if (!p.title) throw httpError(400, 'Describe the action item'); }
  for (const [k, max] of [['details', 2000], ['assignee_id', 20], ['item_id', 20]]) if (!partial || k in b) p[k] = clean(b[k], max);
  if (!partial || 'due_date' in b) {
    p.due_date = clean(b.due_date, 10);
    if (p.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.due_date)) throw httpError(400, 'Enter the due date as YYYY-MM-DD');
  }
  if ('status' in b) { if (!ACTION_STATUSES.includes(b.status)) throw httpError(400, 'Invalid status'); p.status = b.status; }
  return p;
}

async function addAction(b, meeting, env, city, store, me) {
  let action;
  try { action = await store.meetings('addAction', meeting.id, actionInput(b, false), me.actor); } catch (e) { return fail(e.status || 400, e.message); }
  if (action.assignee_id) await notifyAssignee(env, store, city, action);
  return json({ action }, 201);
}

async function updateAction(b, id, env, city, store, me) {
  const before = await store.meetings('action', id);
  if (!before) return fail(404, 'Action item not found');
  const manage = me.can('meetings.manage');
  // The person an action item is assigned to can update its status; the clerk can change anything.
  if (!manage && !(me.staffId && before.assignee_id === me.staffId && me.can('meetings.view'))) throw httpError(403, "Your role doesn't allow this");
  let p;
  try { p = actionInput(b, true); } catch (e) { return fail(e.status || 400, e.message); }
  if (!manage) p = 'status' in p ? { status: p.status } : {};
  let action;
  try { action = await store.meetings('updateAction', id, p, me.actor); } catch (e) { return fail(400, e.message); }
  if (action.assignee_id && action.assignee_id !== before.assignee_id) await notifyAssignee(env, store, city, action);
  return json({ action });
}
