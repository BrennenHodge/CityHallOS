/* City Hall OS marketing site — interactions */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id, cls = '') => `<svg class="icon ${cls}"><use href="#i-${id}"/></svg>`;
  const now = () => new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

  /* ---------------- Nav ---------------- */

  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggle = $('#navToggle');
  const menu = $('#mobileMenu');
  const setMenu = (open) => {
    menu.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    toggle.innerHTML = icon(open ? 'x' : 'menu');
  };
  toggle.addEventListener('click', () => setMenu(!menu.classList.contains('is-open')));
  $$('a', menu).forEach((a) => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  $('#year').textContent = new Date().getFullYear();

  /* ---------------- Reveal on scroll ---------------- */

  if ('IntersectionObserver' in window && !reduceMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    $$('.reveal').forEach((el) => io.observe(el));
  } else {
    $$('.reveal').forEach((el) => el.classList.add('is-visible'));
  }

  /* ---------------- Hero animation ---------------- */

  const hero = $('#heroVisual');
  if (hero) {
    const steps = $$('.hv-step', hero);
    const typingBubble = $('[data-typing]', hero);
    const hvStatus = $('#hvStatus');
    const bars = [1, 2, 3, 4].map((n) => $('#hvp' + n));
    const setStatus = (cls, label, bar) => {
      hvStatus.className = 'status ' + cls;
      hvStatus.textContent = label;
      bars.forEach((b, i) => b.classList.toggle('is-on', i < bar));
    };
    const show = (n) => steps.forEach((el) => { if (+el.dataset.step <= n) el.classList.add('is-on'); });

    const final = () => {
      steps.forEach((el) => el.classList.add('is-on'));
      typingBubble.classList.remove('is-typing');
      setStatus('resolved', 'Resolved', 4);
    };

    if (reduceMotion) {
      final();
    } else {
      const timeline = [
        [600, () => show(1)],
        [1500, () => { show(2); typingBubble.classList.add('is-typing'); }],
        [2800, () => typingBubble.classList.remove('is-typing')],
        [4200, () => show(4)],
        [5300, () => show(5)],
        [6300, () => { show(6); setStatus('new', 'New', 1); }],
        [7700, () => setStatus('assigned', 'Assigned', 2)],
        [9000, () => setStatus('progress', 'In progress', 3)],
        [10400, () => { setStatus('resolved', 'Resolved', 4); show(8); }],
      ];
      const LOOP = 15000;
      let timers = [];
      const run = () => {
        steps.forEach((el) => el.classList.remove('is-on'));
        setStatus('new', 'New', 0);
        timers = timeline.map(([t, fn]) => setTimeout(fn, t));
        timers.push(setTimeout(run, LOOP));
      };
      run();
      document.addEventListener('visibilitychange', () => {
        timers.forEach(clearTimeout);
        if (!document.hidden) run();
      });
    }
  }

  /* ---------------- Roles ---------------- */

  const ROLES = {
    clerk: {
      title: 'Stop answering the same question twenty times a day.',
      body: 'The AI City Clerk handles routine questions and paperwork so your team can focus on residents who truly need a person.',
      points: [
        ['chat', 'Fewer repeat calls', 'Office hours, trash days and form requests answered instantly.'],
        ['inbox', 'Complete requests', 'Every request arrives with details, photos and history attached.'],
        ['mail', 'Drafted correspondence', 'Replies and follow-ups prepared for you to review and send.'],
        ['users', 'Clean hand-offs', 'Escalations come with a summary, so nobody starts from scratch.'],
      ],
    },
    mayor: {
      title: 'See everything happening at City Hall, at a glance.',
      body: 'Get real operational visibility: what came in, who has it, what is overdue and where your team is stretched thin.',
      points: [
        ['chart', 'Workload by department', 'Open, overdue and resolved requests for every department.'],
        ['search', 'Recurring issues', 'Spot the streets, questions and processes that keep coming up.'],
        ['file', 'Reports for council', 'Clear performance numbers you can share at the next meeting.'],
        ['spark', 'More capacity, same budget', 'Expand services without adding headcount.'],
      ],
    },
    dept: {
      title: 'Clear assignments. Complete information.',
      body: 'Public works, code enforcement, permitting and utilities each get their own queue of organized, ready-to-act work.',
      points: [
        ['inbox', 'Department queues', 'Requests routed to you automatically, based on your rules.'],
        ['pin', 'Location and photos', 'Exact addresses and photos from residents, right in the request.'],
        ['bell', 'Automatic updates', 'Change a status and the resident is notified for you.'],
        ['history', 'Notes and history', 'Internal notes and a full activity timeline on every request.'],
      ],
    },
    resident: {
      title: 'Get help without knowing who to call.',
      body: 'Residents describe what they need in their own words. City Hall OS figures out the department, the form and the next step.',
      points: [
        ['clock', 'Open 24/7', 'Answers and reports any time, from phone or computer.'],
        ['book', 'Trustworthy answers', 'Every answer points to the official town source.'],
        ['tag', 'A tracking number', 'Each request gets an ID residents can check anytime.'],
        ['bell', 'Status updates', 'Residents hear back when work is assigned and resolved.'],
      ],
    },
    biz: {
      title: 'Navigate permits and licenses with confidence.',
      body: 'Local businesses and contractors get clear requirements and complete applications the first time.',
      points: [
        ['file', 'Requirements explained', 'Which permit or license you need and why, in plain English.'],
        ['check', 'Document checklists', 'Know exactly what to bring before you apply.'],
        ['search', 'Completeness checks', 'Catch missing information before it delays a review.'],
        ['calendar', 'Renewal reminders', 'Never miss a license renewal date again.'],
      ],
    },
  };

  const rolePanel = $('#rolePanel');
  const renderRole = (key) => {
    const r = ROLES[key];
    rolePanel.innerHTML = `
      <h3>${r.title}</h3>
      <p>${r.body}</p>
      <div class="role-points">
        ${r.points.map(([ic, b, s]) => `<div class="role-point"><span class="icon-wrap">${icon(ic)}</span><div><b>${b}</b><span>${s}</span></div></div>`).join('')}
      </div>`;
  };
  const roleTabs = $$('.role-tab');
  roleTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      roleTabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      renderRole(tab.dataset.role);
    });
    tab.addEventListener('keydown', (e) => {
      const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      const next = roleTabs[(i + dir + roleTabs.length) % roleTabs.length];
      next.focus(); next.click();
    });
  });
  renderRole('clerk');

  /* ---------------- Contact form ---------------- */

  const contact = $('#contactForm');
  $$('[data-plan]').forEach((a) => a.addEventListener('click', () => { $('#cPlan').value = a.dataset.plan; }));
  contact.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!contact.checkValidity()) { contact.reportValidity(); return; }
    const btn = $('button[type="submit"]', contact);
    btn.disabled = true;
    const endpoint = contact.dataset.endpoint;
    if (endpoint) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(new FormData(contact))),
        });
        if (!res.ok) throw new Error('Request failed');
      } catch (err) {
        btn.disabled = false;
        alert('Sorry, something went wrong sending your request. Please try again.');
        return;
      }
    }
    contact.classList.add('is-sent');
  });

  /* =========================================================
     Live demo — resident chat + staff console
     ========================================================= */

  const log = $('#rLog');
  if (!log) return;
  const chipsEl = $('#rChips');
  const rForm = $('#rForm');
  const rText = $('#rText');
  const inboxEl = $('#inbox');
  const detailEl = $('#detail');

  const STATUS = {
    new: 'New', info: 'Needs info', assigned: 'Assigned', progress: 'In progress',
    approval: 'Awaiting approval', resolved: 'Resolved', closed: 'Closed', triage: 'Needs a human',
  };

  const STARTERS = [
    "There's a big pothole on Main St near the elementary school",
    'When is trash pickup on Oak Street?',
    'Do I need a permit to build a fence?',
    'When is the next town board meeting?',
    'Can I have a food truck at our church fall festival?',
  ];

  const REPORTS = [
    { re: /(pot ?hole|sinkhole|road (is )?damaged|crack(ed)? (in the )?(road|street))/, noun: 'pothole', type: 'Pothole', category: 'Street maintenance', dept: 'Public Works', assignee: 'Marcus Hill', chips: ['Main St & School Rd', 'Not sure, near the school entrance'] },
    { re: /(street ?light|light (is )?(out|broken)|lamp ?post)/, noun: 'streetlight outage', type: 'Streetlight out', category: 'Street lighting', dept: 'Public Works', assignee: 'Tony Greer', chips: ['Pine St & 3rd Ave', 'In front of 410 Elm St'] },
    { re: /(missed|wasn'?t picked|not picked|skipped).*(trash|garbage|pickup|recycl)|(trash|garbage|recycling).*(missed|wasn'?t picked|not picked|skipped)/, noun: 'missed pickup', type: 'Missed collection', category: 'Sanitation', dept: 'Sanitation', assignee: 'Rhonda Ellis', chips: ['214 Oak Street', 'Corner of Oak & Birch'] },
    { re: /(leak|water main|flood|broken pipe|hydrant|no water)/, noun: 'water leak', type: 'Water leak', category: 'Water & sewer', dept: 'Water & Sewer', assignee: 'Luis Ortega', chips: ['Cypress Ln & 5th St', 'Near 88 Magnolia Ave'] },
    { re: /(tree|limb|branch)/, noun: 'fallen tree', type: 'Fallen tree / limb', category: 'Right-of-way', dept: 'Public Works', assignee: 'Marcus Hill', chips: ['Church St by the park', 'Near 12 Willow Way'] },
    { re: /(stop sign|street sign|sign (is )?(down|missing|damaged|knocked))/, noun: 'damaged sign', type: 'Damaged sign', category: 'Traffic signs', dept: 'Public Works', assignee: 'Tony Greer', chips: ['Main St & 2nd Ave', 'Near the post office'] },
  ];

  const nextMeeting = () => {
    // First and third Tuesday of each month
    const d = new Date(); d.setHours(0, 0, 0, 0);
    for (let i = 0; i < 70; i++) {
      const c = new Date(d); c.setDate(d.getDate() + i);
      if (c.getDay() === 2) {
        const nth = Math.ceil(c.getDate() / 7);
        if (nth === 1 || nth === 3) return c.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      }
    }
    return 'the first Tuesday of next month';
  };

  const ANSWERS = {
    trash: {
      text: 'Oak Street is in <b>Zone B</b>, which is collected every <b>Tuesday</b>. Please have carts at the curb by 6:00 AM. Recycling is picked up every other Tuesday, and holiday weeks shift collection by one day.',
      source: 'Sanitation Collection Schedule 2026 · Zone B',
      chips: ['My trash was missed this week', 'What are City Hall hours?'],
    },
    fence: {
      text: 'Yes, in most cases. In residential zones, a <b>Fence Permit ($25)</b> is required for fences over 4 ft in a front yard or over 6 ft in a side or rear yard. Fences can\'t be built inside a utility easement. Applications are reviewed within 5 business days.',
      source: 'Code of Ordinances §14-212 · Fences and walls',
      chips: ['Where do I get the application?'],
    },
    form: {
      text: 'You can download the <b>Fence Permit Application (Form BP-07)</b> from the town website or pick one up at City Hall, 100 Main Street. Include a simple sketch showing where the fence will go.',
      source: 'Form BP-07 · Fence Permit Application',
    },
    permit: {
      text: 'Most building work, including additions, decks, roofs and sheds over 120 sq ft, needs a building permit from the Building & Permitting office. Tell me what you\'re planning and I\'ll find the specific requirements.',
      source: 'Code of Ordinances §14-101 · Permits required',
      chips: ['Do I need a permit to build a fence?'],
    },
    meeting: {
      text: () => `The Board of Aldermen meets the first and third Tuesday of each month at <b>6:00 PM</b> in the Council Chamber at City Hall. The next meeting is <b>${nextMeeting()}</b>. Agendas are posted at least 72 hours in advance.`,
      source: '2026 Board of Aldermen Meeting Calendar',
    },
    hours: {
      text: 'City Hall is open <b>Monday–Friday, 8:00 AM–5:00 PM</b> and closed on state holidays. The front desk is at (601) 555-0100. I\'m available 24/7 for questions and reports.',
      source: 'Town of Cedar Bend · Office hours & contacts',
    },
    bill: {
      text: 'Water and sewer bills are due on the <b>15th of each month</b>. You can pay online through the utility portal, by mail, or in person at City Hall. I can\'t see or change account balances. For billing questions, call Utility Billing at (601) 555-0110.',
      source: 'Utility Billing Policy · Section 3',
    },
  };

  let S; // demo state

  const seed = () => ([
    {
      id: 'CB-1041', title: 'Records request: 2025 street paving contracts', type: 'Public records', category: 'Records',
      dept: 'City Clerk', status: 'approval', priority: 'Normal', location: '—', resident: 'R. Whitfield (email)',
      assignee: 'Dana Reyes', channel: 'Email', created: 'Today 9:14 AM', mine: false,
      summary: 'Requests copies of all 2025 paving contracts and bids. AI located 6 potentially responsive documents. 1 is flagged as possibly containing exempt bid information. Needs clerk review before release.',
      timeline: [
        { t: 'Request received by email and logged by AI', at: 'Today 9:14 AM', k: 'ai' },
        { t: 'AI identified 6 documents, flagged 1 for review', at: 'Today 9:15 AM', k: 'ai' },
        { t: 'Routed to Dana Reyes for approval', at: 'Today 9:15 AM' },
      ],
    },
    {
      id: 'CB-1040', title: 'Business license renewal: Delta Flowers & Gifts', type: 'Business license', category: 'Licensing',
      dept: 'City Clerk', status: 'info', priority: 'Normal', location: '120 Main St', resident: 'K. Brooks',
      assignee: 'Dana Reyes', channel: 'Web chat', created: 'Yesterday 4:02 PM', mine: false,
      summary: 'Annual renewal submitted. Certificate of insurance is missing. AI requested it from the applicant automatically.',
      timeline: [
        { t: 'Renewal application started in web chat', at: 'Yesterday 4:02 PM', k: 'ai' },
        { t: 'AI flagged missing certificate of insurance', at: 'Yesterday 4:05 PM', k: 'ai' },
        { t: 'Reminder sent to applicant', at: 'Yesterday 4:05 PM', k: 'ai' },
      ],
    },
    {
      id: 'CB-1039', title: 'Streetlight out: Pine St & 3rd Ave', type: 'Streetlight out', category: 'Street lighting',
      dept: 'Public Works', status: 'assigned', priority: 'Normal', location: 'Pine St & 3rd Ave', resident: 'M. Carter',
      assignee: 'Tony Greer', channel: 'Phone', created: 'Yesterday 11:40 AM', mine: false,
      summary: 'Caller reports the streetlight on the northeast corner has been out for 3 nights. Pole number not provided.',
      timeline: [
        { t: 'Logged from phone call by front desk', at: 'Yesterday 11:40 AM' },
        { t: 'AI suggested Public Works · Street lighting', at: 'Yesterday 11:40 AM', k: 'ai' },
        { t: 'Assigned to Tony Greer', at: 'Yesterday 1:12 PM' },
      ],
    },
  ]);

  /* ----- Mobile tabs ----- */

  const tabRes = $('#tabRes');
  const tabStaff = $('#tabStaff');
  const paneRes = $('#paneRes');
  const paneStaff = $('#paneStaff');
  const staffBadge = $('#staffBadge');
  const resBadge = $('#resBadge');
  let activeTab = 'res';
  const setTab = (which) => {
    activeTab = which;
    tabRes.setAttribute('aria-selected', String(which === 'res'));
    tabStaff.setAttribute('aria-selected', String(which === 'staff'));
    paneRes.toggleAttribute('hidden-mobile', which !== 'res');
    paneStaff.toggleAttribute('hidden-mobile', which !== 'staff');
    const b = which === 'res' ? resBadge : staffBadge;
    b.classList.remove('show'); b.textContent = '0';
  };
  const bumpBadge = (which) => {
    if (activeTab === which) return;
    const b = which === 'res' ? resBadge : staffBadge;
    b.textContent = String(+b.textContent + 1);
    b.classList.add('show');
  };
  tabRes.addEventListener('click', () => setTab('res'));
  tabStaff.addEventListener('click', () => setTab('staff'));
  setTab('res');

  /* ----- Resident chat ----- */

  const scrollLog = () => { log.scrollTop = log.scrollHeight; };

  const addBubble = (cls, html) => {
    const el = document.createElement('div');
    el.className = 'bubble ' + cls;
    el.innerHTML = html;
    log.appendChild(el);
    scrollLog();
    return el;
  };

  const say = async (html, opts = {}) => {
    S.busy = true;
    const typing = addBubble('ai typing', '<i></i><i></i><i></i>');
    typing.setAttribute('aria-label', 'AI City Clerk is typing');
    await wait(opts.delay || 750);
    typing.remove();
    const src = opts.source ? `<div><span class="source-chip">${icon('book')}${esc(opts.source)}</span></div>` : '';
    addBubble(opts.cls || 'ai', html + src);
    S.busy = false;
  };

  const setChips = (list) => {
    chipsEl.innerHTML = '';
    (list || []).forEach((label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = label;
      b.addEventListener('click', () => handleInput(label));
      chipsEl.appendChild(b);
    });
  };

  const starterChips = () => {
    const left = STARTERS.filter((s) => !S.used.has(s));
    return left.length ? left : ['What are City Hall hours?', 'How do I pay my water bill?'];
  };

  const detect = (text) => {
    const t = text.toLowerCase();
    if (/(gas leak|smell gas|smell of gas|fire|smoke|emergency|injur|bleeding|car (crash|accident)|wreck|power line|unconscious|\b911\b|someone (is )?hurt)/.test(t)) return { kind: 'emergency' };
    for (const r of REPORTS) if (r.re.test(t)) return { kind: 'report', rpt: r };
    if (/(application|form)/.test(t) && S.lastAnswer === 'fence') return { kind: 'answer', key: 'form' };
    if (/fence/.test(t)) return { kind: 'answer', key: 'fence' };
    if (/(trash|garbage|pick ?up|recycl|sanitation)/.test(t)) return { kind: 'answer', key: 'trash' };
    if (/(meeting|council|aldermen|board|agenda)/.test(t)) return { kind: 'answer', key: 'meeting' };
    if (/(water bill|pay my|utility bill|\bbill\b|payment)/.test(t)) return { kind: 'answer', key: 'bill' };
    if (/(permit|shed|deck|addition|renovat|build)/.test(t)) return { kind: 'answer', key: 'permit' };
    if (/(hours|open|close|closed|holiday|phone number|contact)/.test(t)) return { kind: 'answer', key: 'hours' };
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t)) return { kind: 'greet' };
    return { kind: 'unknown' };
  };

  const handleInput = async (raw) => {
    const text = raw.trim();
    if (!text || S.busy) return;
    S.used.add(text);
    setChips([]);
    addBubble('me', esc(text));

    // In the middle of a service-request conversation
    if (S.flow) return continueFlow(text);

    const intent = detect(text);
    if (intent.kind === 'emergency') {
      await say(`${icon('alert')}<span><b>If anyone is in danger, call 911 now.</b> For a gas smell, leave the area first and then call 911 from a safe place. Emergencies aren't handled through this chat or filed as regular requests.</span>`, { cls: 'alert', delay: 400 });
      setChips(starterChips());
      return;
    }
    if (intent.kind === 'greet') {
      await say("Hi there! I can answer questions about town services, help you report a problem, or find the right form. What do you need?");
      setChips(starterChips());
      return;
    }
    if (intent.kind === 'answer') {
      const a = ANSWERS[intent.key];
      S.lastAnswer = intent.key;
      await say(typeof a.text === 'function' ? a.text() : a.text, { source: a.source, delay: 900 });
      S.answered++;
      renderKpis(['kAnswered']);
      setChips((a.chips || []).filter((c) => !S.used.has(c)).concat(starterChips()).slice(0, 4));
      return;
    }
    if (intent.kind === 'report') {
      const r = intent.rpt;
      S.flow = { step: 'location', rpt: r, first: text, photo: false };
      const mentionsPlace = /(\b(st|street|rd|road|ave|avenue|ln|lane|dr|drive|hwy)\b|school|park|church|near)/i.test(text);
      await say(mentionsPlace
        ? `Thanks for reporting this. I'll send it to <b>${r.dept}</b>. To get the crew to the right spot, what's the nearest cross street or address?`
        : `I can report this ${r.noun} to <b>${r.dept}</b> right now. Where is it? An address or cross street works best.`);
      setChips(r.chips);
      return;
    }

    // Unknown: don't guess, hand to a person.
    await say("I couldn't find a verified answer to that in Cedar Bend's official sources, so I won't guess. I've sent your question to the <b>City Clerk's office</b>. A staff member will reply right here, usually within one business day.", { delay: 1000 });
    createRequest({
      type: 'Resident question', category: 'General inquiry', dept: 'City Clerk', status: 'triage', priority: 'Normal',
      title: `Question: “${text.length > 70 ? text.slice(0, 67) + '…' : text}”`,
      location: '—', assignee: 'Dana Reyes',
      summary: `Resident asked: “${text}”. No approved source answers this, so AI did not respond with policy. A suggested reply is drafted below for staff to review.`,
      draft: /food truck|vendor/i.test(text)
        ? 'Hi! This is Dana with the Cedar Bend Clerk\'s office. Food trucks at a private event on church property need a Temporary Vendor Permit ($35), plus a copy of the truck\'s health inspection. I can email you the form. Just reply here or call us at (601) 555-0100.'
        : 'Hi! This is Dana with the Cedar Bend Clerk\'s office. Thanks for your question. I looked into it and here\'s what you need to know: … Feel free to call us at (601) 555-0100 if you have other questions.',
      timeline: [
        { t: 'Question received in web chat', at: now(), k: 'ai' },
        { t: 'No approved source found. AI declined to answer', at: now(), k: 'ai' },
        { t: 'Sent to human triage: City Clerk', at: now() },
      ],
    });
    setChips(starterChips());
  };

  const continueFlow = async (text) => {
    const f = S.flow;
    const r = f.rpt;
    if (f.step === 'location') {
      f.location = text.replace(/^not sure,?\s*/i, '').replace(/^near\s+/i, 'Near ');
      if (!f.location) f.location = text;
      f.step = 'photo';
      await say(`Got it: <b>${esc(f.location)}</b>. A photo helps the crew know what to bring. Would you like to add one?`);
      setChips(['Attach a photo', 'Skip']);
      return;
    }
    if (f.step === 'photo') {
      if (/attach|photo|yes|pic/i.test(text)) {
        f.photo = true;
        addBubble('me', `${icon('camera', 'icon-sm')} <span class="mono">IMG_2041.jpg</span>`).style.cssText = 'display:flex;gap:8px;align-items:center';
      }
      f.step = 'contact';
      await say(`${f.photo ? 'Photo attached. ' : ''}Last question: how should we send you updates on this request?`);
      setChips(['Email me at jordan.p@example.com', 'Text me at (601) 555-0142', 'No updates, thanks']);
      return;
    }
    if (f.step === 'contact') {
      const noUpdates = /no update/i.test(text);
      const contactInfo = noUpdates ? 'Jordan P. (no updates requested)' : 'Jordan P. · ' + text.replace(/^(email|text) me at\s*/i, '');
      S.flow = null;
      const all = (f.first + ' ' + f.location).toLowerCase();
      const high = /(school|hospital|leak|flood|hydrant|intersection|stop sign)/.test(all);
      const priority = high ? 'High' : 'Normal';
      const why = /school/.test(all) ? ' (school zone)' : high ? ' (safety)' : '';
      const req = createRequest({
        type: r.type, category: r.category, dept: r.dept, status: 'new', priority,
        title: `${r.type}: ${f.location}`,
        location: f.location, assignee: r.assignee, resident: contactInfo, mine: true, notify: !noUpdates,
        summary: `Resident reports a ${r.noun} at ${f.location}${/school/.test(all) ? ', near the elementary school' : ''}. ${f.photo ? 'Photo attached.' : 'No photo provided.'} Suggested category: ${r.category}. Suggested priority: ${priority}${why}. Suggested assignee: ${r.assignee}.`,
        timeline: [
          { t: 'Reported by resident in web chat', at: now(), k: 'ai' },
          { t: `AI categorized as ${r.category}, priority ${priority}`, at: now(), k: 'ai' },
          { t: `Routed to ${r.dept} queue by routing rule`, at: now(), k: 'ai' },
        ],
      });
      await say(`${icon('check')}<span>Request <b class="mono">#${req.id}</b> created and sent to <b>${r.dept}</b>. ${noUpdates ? 'You can check its status anytime' : 'We\'ll send you updates, and you can check status anytime'} at cedarbend.gov/track.</span>`, { cls: 'sys', delay: 900 });
      await wait(500);
      await say('Is there anything else I can help you with?', { delay: 500 });
      setChips(starterChips());
    }
  };

  rForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = rText.value;
    rText.value = '';
    handleInput(v);
  });

  /* ----- Staff console ----- */

  const createRequest = (data) => {
    const req = Object.assign({
      id: 'CB-' + S.nextId++, channel: 'Web chat', created: 'Today ' + now(), resident: 'Web chat visitor', mine: false,
    }, data);
    if (req.status === 'triage') req.mine = true;
    S.requests.unshift(req);
    S.selected = req.id;
    S.freshId = req.id;
    renderInbox();
    renderDetail();
    renderKpis(['kOpen', req.status === 'triage' ? 'kHuman' : null]);
    bumpBadge('staff');
    return req;
  };

  const actionsFor = (r) => {
    const short = r.dept;
    switch (r.status) {
      case 'new': return [
        { label: `Assign to ${r.assignee}`, primary: true, to: 'assigned', note: `Assigned to ${r.assignee} by Dana Reyes`, msg: `Your request #${r.id} has been assigned to the ${short} team.` },
        { label: 'Request more info', to: 'info', note: 'Asked resident for more details', msg: `Quick question about #${r.id}: can you tell us which side of the street it's on?` },
      ];
      case 'info': return [{ label: 'Mark info received', primary: true, to: 'assigned', note: 'Missing information received', msg: `Thanks! We have what we need for #${r.id}. It's with the ${short} team.` }];
      case 'assigned': return [{ label: 'Start work', primary: true, to: 'progress', note: `${r.assignee} started work`, msg: `A ${short} crew is working on #${r.id} at ${r.location}.` }];
      case 'progress': return [{ label: 'Mark resolved', primary: true, to: 'resolved', note: `Resolved by ${r.assignee}`, msg: `Good news: #${r.id} has been resolved. Thanks for helping keep Cedar Bend in great shape!` }];
      case 'approval': return [{ label: 'Approve release', primary: true, to: 'resolved', note: 'Dana Reyes approved release of 5 documents. 1 withheld as exempt.' }];
      case 'triage': return [{ label: 'Approve & send reply', primary: true, to: 'resolved', note: 'Dana Reyes reviewed the draft and replied to the resident', reply: true }];
      case 'resolved': return [{ label: 'Close request', to: 'closed', note: 'Request closed' }];
      default: return [];
    }
  };

  const applyAction = async (r, a) => {
    const prevHuman = humanCount();
    r.status = a.to;
    r.timeline.push({ t: a.note, at: now(), k: a.to === 'resolved' || a.to === 'closed' ? 'done' : '' });
    if (a.to === 'resolved') S.resolved++;
    const changed = ['kOpen', a.to === 'resolved' ? 'kResolved' : null, humanCount() !== prevHuman ? 'kHuman' : null];
    renderInbox();
    renderDetail();
    renderKpis(changed);

    if (!r.mine) return;
    if (a.reply) {
      const text = ($('#draftReply') && $('#draftReply').value.trim()) || r.draft;
      r.timeline[r.timeline.length - 1].t += ': “' + (text.length > 60 ? text.slice(0, 57) + '…' : text) + '”';
      renderDetail();
      addBubble('update', `${icon('user')}<span><b>Dana Reyes · City Clerk</b><br>${esc(text)}</span>`);
      bumpBadge('res');
    } else if (a.msg && r.notify !== false) {
      addBubble('update', `${icon('bell')}<span><b>Update on #${r.id}:</b> ${esc(a.msg)}</span>`);
      bumpBadge('res');
    }
  };

  const humanCount = () => S.requests.filter((r) => r.status === 'triage' || r.status === 'approval').length;
  const openCount = () => S.requests.filter((r) => r.status !== 'resolved' && r.status !== 'closed').length;

  const renderKpis = (changed = []) => {
    const vals = { kOpen: openCount(), kHuman: humanCount(), kAnswered: S.answered, kResolved: S.resolved };
    Object.entries(vals).forEach(([id, v]) => {
      const el = $('#' + id);
      el.textContent = v;
      if (changed.includes(id)) {
        el.classList.add('bump');
        setTimeout(() => el.classList.remove('bump'), 1400);
      }
    });
    $('#sideCount').textContent = vals.kOpen;
    $('#inboxCount').textContent = vals.kOpen + ' open';
  };

  const renderInbox = () => {
    $$('.inbox-row', inboxEl).forEach((el) => el.remove());
    S.requests.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'inbox-row' + (r.id === S.selected ? ' selected' : '') + (r.id === S.freshId ? ' fresh' : '');
      b.setAttribute('aria-pressed', String(r.id === S.selected));
      b.innerHTML = `
        <div class="r1"><span class="rid">#${r.id} · ${esc(r.channel)}</span><span class="status ${r.status}">${STATUS[r.status]}</span></div>
        <div class="rt">${esc(r.title)}</div>
        <div class="rm"><span>${esc(r.dept)}</span><span>·</span><span>${r.priority === 'High' ? '<b style="color:var(--red)">High</b>' : 'Normal'}</span>${r.timeline.some((t) => t.k === 'ai') ? `<span>·</span><span class="ai-badge">${icon('spark')}AI</span>` : ''}</div>`;
      b.addEventListener('click', () => { S.selected = r.id; S.freshId = null; renderInbox(); renderDetail(); });
      inboxEl.appendChild(b);
    });
    S.freshId = null;
  };

  const renderDetail = () => {
    const r = S.requests.find((x) => x.id === S.selected);
    if (!r) {
      detailEl.innerHTML = `<div class="detail-empty">${icon('inbox')}Select a request to see the AI summary, details and activity timeline.</div>`;
      return;
    }
    const actions = actionsFor(r);
    detailEl.innerHTML = `
      <div class="d-head">
        <span class="rid">#${r.id} · ${esc(r.channel)} · ${esc(r.created)}</span>
        <h5>${esc(r.title)}</h5>
        <span class="status ${r.status}">${STATUS[r.status]}</span>
      </div>
      <div class="ai-box"><div class="lbl">${icon('spark')}AI summary</div>${esc(r.summary)}</div>
      <dl class="fields">
        <dt>Department</dt><dd>${esc(r.dept)}</dd>
        <dt>Category</dt><dd>${esc(r.category)}</dd>
        <dt>Priority</dt><dd>${esc(r.priority)}</dd>
        <dt>Location</dt><dd>${esc(r.location)}</dd>
        <dt>Assigned to</dt><dd>${esc(r.status === 'new' ? 'Unassigned (suggested: ' + r.assignee + ')' : r.assignee)}</dd>
        <dt>Resident</dt><dd>${esc(r.resident)}</dd>
      </dl>
      ${r.status === 'triage' ? `
        <div class="field" style="gap:6px">
          <label for="draftReply" class="d-sec-title">Suggested reply · review before sending</label>
          <textarea id="draftReply" style="height:120px;font-size:.82rem;line-height:1.45">${esc(r.draft)}</textarea>
        </div>` : ''}
      ${actions.length ? `<div class="d-actions">${actions.map((a, i) => `<button type="button" data-a="${i}" class="${a.primary ? 'primary' : ''}">${a.primary ? icon('check', 'icon-sm') : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}
      <div class="d-sec-title">Activity</div>
      <ol class="timeline">${r.timeline.map((t) => `<li class="${t.k || ''}">${esc(t.t)}<small>${esc(t.at)}${t.k === 'ai' ? ' · AI City Clerk' : ''}</small></li>`).join('')}</ol>`;
    $$('[data-a]', detailEl).forEach((btn) => btn.addEventListener('click', () => applyAction(r, actions[+btn.dataset.a])));
  };

  /* ----- Init / reset ----- */

  const init = () => {
    S = { requests: seed(), nextId: 1042, selected: null, freshId: null, answered: 0, resolved: 0, used: new Set(), flow: null, busy: false, lastAnswer: null };
    log.innerHTML = '';
    addBubble('ai', "Hi! I'm the AI City Clerk for the Town of Cedar Bend. Ask me a question, or tell me about a problem and I'll get it to the right people.");
    setChips(STARTERS);
    renderInbox();
    renderDetail();
    renderKpis();
    [staffBadge, resBadge].forEach((b) => { b.classList.remove('show'); b.textContent = '0'; });
  };

  $('#demoReset').addEventListener('click', init);
  init();
})();
