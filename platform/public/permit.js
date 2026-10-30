/*!
 * City Hall OS: guided permit application.
 * Loaded by embed.js when a resident starts or resumes an application. The chat panel grows into a full-screen
 * workspace: the conversation on the left, the application on the right, filling in as the resident answers.
 * Every answer is saved as it is given, so the application can be finished later from the same secret link.
 */
(() => {
  if (window.__chosPermit) return;

  const STATUS = {
    draft: ['Draft', 'Not submitted yet'], submitted: ['Submitted', 'Planning & Building is checking that it is complete'],
    needs_info: ['Changes requested', 'Update the items below and resubmit'], fees_due: ['Complete · fee due', 'Review starts once the fee is paid'],
    in_review: ['Under review', 'The Land Code Administrator is reviewing zoning, floodplain and code requirements'],
    issued: ['Permit issued', 'Print it and post it at the job site'], closed: ['Closed', 'Final inspection passed'],
    denied: ['Not approved', 'Contact City Hall about your options'], withdrawn: ['Withdrawn', 'This application was withdrawn'],
  };
  const STEPS = [['submitted', 'Submitted'], ['complete', 'Complete'], ['paid', 'Fee paid'], ['in_review', 'Review'], ['issued', 'Issued']];
  const STEP_AT = { draft: -1, submitted: 0, needs_info: 0, fees_due: 1, in_review: 3, issued: 4, closed: 4, denied: 3, withdrawn: -1 };
  const INSPECTIONS = ['Footing / foundation', 'Slab', 'Framing', 'Electrical rough-in', 'Plumbing rough-in', 'Mechanical', 'Final'];

  const CSS = `
  .panel { transition: right .5s cubic-bezier(.2,.8,.2,1), bottom .5s cubic-bezier(.2,.8,.2,1), width .5s cubic-bezier(.2,.8,.2,1), height .5s cubic-bezier(.2,.8,.2,1), border-radius .5s; }
  .root.permit:not(.page) .panel { right: 12px; bottom: 12px; width: calc(100vw - 24px); height: calc(100vh - 24px); border-radius: 18px; }
  .root.permit.page .panel { position: fixed; inset: 0; z-index: 2147483001; width: auto; height: auto; border-radius: 0; animation: grow .4s cubic-bezier(.2,.8,.2,1); }
  @keyframes grow { from { opacity: .4; transform: scale(.97); } }
  .ws { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(330px, 420px) 1fr; background: var(--paper); }
  .ws-chat { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--paper); }
  .ws-sheet { min-height: 0; overflow-y: auto; background: #f6f4ee; scroll-behavior: smooth; }
  .ws-tabs { display: none; }
  .head .sub2 { font-size: 12px; opacity: .85; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .saved { display: inline-flex; gap: 4px; align-items: center; }
  .hbar { height: 4px; background: rgba(255,255,255,.18); }
  .hbar i { display: block; height: 100%; background: #4ade80; transition: width .6s ease; }
  .head .tbtn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 11px; border-radius: 10px; border: 1px solid rgba(255,255,255,.28); background: transparent; color: #fff; cursor: pointer; font-weight: 600; font-size: 13px; }
  .head .tbtn:hover { background: rgba(255,255,255,.12); }
  .opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .opt { border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 7px 12px; font-size: 13.5px; cursor: pointer; text-align: left; line-height: 1.3; font-weight: 550; }
  .opt:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
  .opt:disabled { opacity: .45; cursor: default; }
  .btn:disabled { opacity: .5; cursor: default; }
  .opt.long { border-radius: 12px; width: 100%; }
  .sheet { max-width: 860px; margin: 0 auto; padding: 22px 26px 60px; display: grid; gap: 16px; }
  .sheet h1 { font-size: 22px; margin: 0; letter-spacing: -.02em; }
  .sheet .lede { color: var(--muted); font-size: 13.5px; margin: 2px 0 0; }
  .steps { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; position: sticky; top: 0; z-index: 2; background: #f6f4ee; padding-top: 6px; }
  .step { flex: none; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 5px 11px 5px 7px; font-size: 12.5px; font-weight: 600; cursor: pointer; color: var(--ink); }
  .step b { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; background: var(--soft); font-size: 10.5px; }
  .step.done b { background: var(--brand); color: #fff; }
  .step.err b { background: #fde8e6; color: #b42318; }
  .sec { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px; display: grid; gap: 14px; scroll-margin-top: 50px; }
  .sec-h { display: flex; align-items: center; gap: 10px; }
  .sec-h h2 { margin: 0; font-size: 15.5px; }
  .sec-h .n { width: 24px; height: 24px; border-radius: 8px; background: var(--soft); display: grid; place-items: center; font-size: 12px; font-weight: 700; }
  .sec.done .sec-h .n { background: var(--brand); color: #fff; }
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px 14px; }
  .fld { grid-column: span 6; display: grid; gap: 5px; border-radius: 10px; transition: background .6s, box-shadow .6s; }
  .fld.half { grid-column: span 3; }
  .fld.third { grid-column: span 2; }
  .fld > label, .fld > .lbl { font-size: 12.5px; font-weight: 650; color: #2d3748; }
  .fld small { color: var(--muted); font-size: 12px; }
  .fld input[type=text], .fld input[type=email], .fld input[type=tel], .fld input[type=number], .fld textarea, .fld select {
    width: 100%; border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; background: var(--paper); outline: none; font-size: 14px; }
  .fld input:focus, .fld textarea:focus, .fld select:focus { border-color: var(--brand); background: #fff; }
  .fld textarea { min-height: 70px; resize: vertical; }
  .fld.flash { background: color-mix(in srgb, var(--brand) 10%, #fff); box-shadow: 0 0 0 6px color-mix(in srgb, var(--brand) 10%, #fff); }
  .fld .money { position: relative; } .fld .money span { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--muted); }
  .fld .money input { padding-left: 22px; }
  .seg { display: flex; flex-wrap: wrap; gap: 6px; }
  .seg button { border: 1px solid var(--line); background: var(--paper); border-radius: 10px; padding: 7px 11px; cursor: pointer; font-size: 13.5px; font-weight: 550; }
  .seg button.on { background: var(--brand); border-color: var(--brand); color: #fff; }
  .radio { display: grid; gap: 6px; }
  .radio button { text-align: left; border: 1px solid var(--line); background: var(--paper); border-radius: 12px; padding: 10px 12px; cursor: pointer; font-size: 13.5px; display: flex; gap: 10px; }
  .radio button i { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line); margin-top: 2px; }
  .radio button.on { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 7%, #fff); }
  .radio button.on i { border-color: var(--brand); background: radial-gradient(var(--brand) 45%, transparent 50%); }
  .chk { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; line-height: 1.45; cursor: pointer; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }
  .chk input { margin-top: 3px; width: 17px; height: 17px; accent-color: var(--brand); flex: none; }
  .sig input { font-family: "Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive; font-size: 24px !important; padding: 6px 12px !important; }
  .issue { font-size: 12.5px; display: flex; gap: 6px; align-items: flex-start; line-height: 1.4; }
  .issue.error { color: #b42318; } .issue.warning { color: #8a5100; } .issue.info { color: var(--muted); }
  .issue .ai { font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 4px; background: #efebff; color: #5b3fd1; flex: none; margin-top: 1px; }
  .summary { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; display: grid; gap: 10px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--soft); }
  .badge.ok { background: #e2f3ea; color: #0f7a55; } .badge.warn { background: #fff1d6; color: #8a5100; } .badge.bad { background: #fde8e6; color: #b42318; }
  .fee { display: grid; gap: 4px; font-size: 13px; }
  .fee .tot { font-size: 20px; font-weight: 750; letter-spacing: -.01em; }
  .files { display: grid; gap: 6px; }
  .file { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); font-size: 13px; }
  .file .k { font-size: 11px; font-weight: 700; color: var(--brand); text-transform: uppercase; letter-spacing: .03em; }
  .file a { color: inherit; text-decoration: none; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file button { border: 0; background: none; cursor: pointer; color: var(--muted); padding: 2px; }
  .uprow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .uprow select { width: auto !important; }
  .final { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px; display: grid; gap: 12px; }
  .final .row2 { display: flex; gap: 8px; flex-wrap: wrap; }
  .issues-box { display: grid; gap: 8px; padding: 12px 14px; border-radius: 12px; background: var(--paper); border: 1px solid var(--line); }
  .issues-box h3 { margin: 0; font-size: 13.5px; }
  .issues-box button.go { border: 0; background: none; color: var(--brand); font-weight: 600; cursor: pointer; padding: 0; font-size: 12.5px; }
  .track { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; }
  .track div { display: grid; gap: 5px; font-size: 11.5px; color: var(--muted); font-weight: 600; }
  .track i { height: 6px; border-radius: 99px; background: var(--soft); }
  .track .on i { background: var(--brand); } .track .on { color: var(--ink); }
  .status-card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px; display: grid; gap: 12px; }
  .status-card .refno { font-family: "JetBrains Mono", ui-monospace, monospace; font-weight: 700; font-size: 20px; }
  .tl2 { display: grid; gap: 8px; font-size: 13px; }
  .tl2 div { display: grid; grid-template-columns: 14px 1fr; gap: 8px; } .tl2 i { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); margin-top: 6px; }
  .corr { background: #fff7e8; border: 1px solid #f5d9a6; border-radius: 14px; padding: 14px 16px; display: grid; gap: 6px; font-size: 13.5px; }
  .corr ul { margin: 0; padding-left: 18px; }
  .linkbox { display: flex; gap: 6px; } .linkbox input { flex: 1; font-size: 12px !important; font-family: ui-monospace, monospace; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: sp .8s linear infinite; display: inline-block; }
  @keyframes sp { to { transform: rotate(360deg); } }
  @media (max-width: 900px) {
    .root.permit:not(.page) .panel { right: 0; bottom: 0; width: 100vw; height: 100vh; border-radius: 0; }
    .ws { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .ws-tabs { display: flex; gap: 4px; padding: 8px 10px; background: #fff; border-bottom: 1px solid var(--line); }
    .ws-tabs button { flex: 1; height: 36px; border-radius: 10px; border: 1px solid var(--line); background: var(--paper); font-weight: 650; cursor: pointer; font-size: 13.5px; }
    .ws-tabs button.on { background: var(--ink); border-color: var(--ink); color: #fff; }
    .ws[data-tab="chat"] .ws-sheet, .ws[data-tab="form"] .ws-chat { display: none; }
    .ws-chat { border-right: 0; }
    .sheet { padding: 14px 12px 50px; }
    .fld.half, .fld.third { grid-column: span 3; }
    .head .tbtn .lbl { display: none; }
  }`;

  async function mount(o) {
    const { root, api, cfg, esc, md, icon, city } = o;
    const shadow = root.getRootNode();
    if (!shadow.querySelector('#chos-permit-css')) {
      const st = document.createElement('style'); st.id = 'chos-permit-css'; st.textContent = CSS; shadow.appendChild(st);
    }
    const LS = `chos:${city}:permit:`;
    const local = {
      get(k) { try { return JSON.parse(localStorage.getItem(LS + k)); } catch { return null; } },
      set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    };
    const S = { showErrors: false, id: o.permit?.id || null, token: o.permit?.token || null, app: null, schema: null, msgs: [], busy: false, tab: 'chat', pending: {}, saveTimer: 0, savedAt: null, saving: false, reviewing: false, closed: false, poll: 0 };
    const $ = (s) => root.querySelector(s);
    const link = () => `${o.origin}/${city}/#permit=${S.id}.${S.token}`;

    async function call(path, { method = 'GET', body, form } = {}) {
      const res = await fetch(`${api}/permits${path}`, {
        method, headers: { 'X-Permit-Token': S.token || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: form || (body ? JSON.stringify(body) : undefined),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { data });
      return data;
    }

    const saveMsgs = () => local.set(`${S.id}:msgs`, S.msgs.slice(-80));
    const say = (text, extra = {}) => { S.msgs.push({ role: 'bot', text, ...extra }); saveMsgs(); drawChat(); };
    const me = (text) => { S.msgs.push({ role: 'user', text }); saveMsgs(); drawChat(); };
    function askMsg(a) {
      if (!a) return;
      say(a.prompt, { ask: a.id, choices: a.choices, upload: a.upload });
    }

    /* ---------------- Layout ---------------- */

    function frame() {
      root.classList.add('permit');
      document.documentElement.style.overflow = 'hidden';
      const panel = root.querySelector('.panel');
      panel.innerHTML = `
        <header class="head">
          <div class="avatar">${icon('file', 20)}</div>
          <div style="min-width:0"><h2>Construction permit application</h2><p class="sub2" id="pSub"></p></div>
          <div class="tools" style="gap:6px">
            <button class="tbtn" id="pLater" title="Get a link to finish later">${icon('send', 15)}<span class="lbl">Finish later</span></button>
            <button class="tbtn" id="pPdf" title="See the application as the city's PDF form">${icon('file', 15)}<span class="lbl">PDF</span></button>
            <button class="icon-btn" id="pMin" aria-label="Back to the chat" title="Back to the chat">${icon('x')}</button>
          </div>
        </header>
        <div class="hbar"><i id="pBar" style="width:0"></i></div>
        <div class="ws" id="ws" data-tab="${S.tab}">
          <div class="ws-tabs"><button data-tab="chat">Assistant</button><button data-tab="form">Application <span id="pPct"></span></button></div>
          <section class="ws-chat">
            <div class="log" id="pLog" aria-live="polite"></div>
            <form class="composer" id="pForm">
              <textarea id="pInput" rows="1" placeholder="Type your answer…" aria-label="Your answer"></textarea>
              <button class="send" type="submit" aria-label="Send">${icon('send')}</button>
            </form>
            <div class="foot"><span>Answers save automatically</span><span>Emergency? Call <a href="tel:911">911</a></span></div>
          </section>
          <section class="ws-sheet" id="pSheetWrap"><div class="sheet" id="pSheet"><div style="padding:40px;text-align:center;color:var(--muted)"><span class="spin"></span></div></div></section>
        </div>`;
      $('#pMin').onclick = close;
      $('#pPdf').onclick = openPdf;
      $('#pLater').onclick = finishLater;
      root.querySelectorAll('.ws-tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
      const input = $('#pInput');
      input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#pForm').requestSubmit(); } });
      $('#pForm').onsubmit = (e) => { e.preventDefault(); const v = input.value.trim(); if (!v || S.busy) return; input.value = ''; input.style.height = ''; send({ text: v }); };
      $('#pLog').addEventListener('click', onChatClick);
      const sheet = $('#pSheet');
      sheet.addEventListener('input', onFieldInput);
      sheet.addEventListener('change', onFieldChange);
      sheet.addEventListener('click', onSheetClick);
      sheet.addEventListener('focusout', (e) => { if (e.target.dataset?.key) flush(); });
      setTab(S.tab);
    }

    function setTab(t) {
      S.tab = t;
      $('#ws').dataset.tab = t;
      root.querySelectorAll('.ws-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    }

    function drawHead() {
      const a = S.app; if (!a) return;
      const [label] = STATUS[a.status] || [a.status];
      $('#pSub').innerHTML = `<span>${a.ref ? `<b>${esc(a.ref)}</b> · ` : ''}${esc(label)}</span>${a.editable && (S.saving || S.savedAt) ? `<span>·</span><span class="saved" id="pSaved">${S.saving ? 'Saving…' : `${icon('check', 12)} Saved`}</span>` : ''}`;
      $('#pBar').style.width = `${a.status === 'draft' || a.status === 'needs_info' ? a.progress : 100}%`;
      $('#pPct').textContent = a.editable ? `${a.progress}%` : '';
    }

    /* ---------------- Conversation ---------------- */

    function drawChat() {
      const log = $('#pLog'); if (!log) return;
      const last = S.msgs.length - 1;
      log.innerHTML = S.msgs.map((m, i) => {
        if (m.role === 'user') return `<div class="msg user">${esc(m.text)}</div>`;
        if (m.pending) return '<div class="msg bot"><span class="typing"><i></i><i></i><i></i></span></div>';
        const live = i === last && S.app?.editable && !S.busy;
        const long = (m.choices || []).some(([, l]) => l.length > 40);
        return `<div class="msg bot">${md(m.text)}
          ${m.choices ? `<div class="opts">${m.choices.map(([v, l]) => `<button class="opt ${long ? 'long' : ''}" data-choice="${esc(v)}" data-ask="${esc(m.ask)}" ${live ? '' : 'disabled'}>${esc(l)}</button>`).join('')}</div>` : ''}
          ${m.upload && live ? `<div class="opts">${m.upload.map((k) => `<button class="opt" data-upload="${esc(k)}">${icon('camera', 14)} ${esc(kindLabel(k))}</button>`).join('')}</div>` : ''}
          ${m.buttons && i === last ? `<div class="opts">${m.buttons}</div>` : ''}
        </div>`;
      }).join('');
      log.scrollTop = log.scrollHeight;
    }

    function onChatClick(e) {
      const c = e.target.closest('[data-choice]');
      if (c && !c.disabled) { me(c.textContent.trim()); send({ choice: c.dataset.choice, ask: c.dataset.ask }, true); return; }
      const u = e.target.closest('[data-upload]');
      if (u) { pickFile(u.dataset.upload); return; }
      const act = e.target.closest('[data-pact]');
      if (act) sheetAction(act.dataset.pact, act);
    }

    async function send(body, already) {
      if (S.busy) return;
      if (!already && body.text) me(body.text);
      await flush();
      S.busy = true;
      S.msgs.push({ role: 'bot', pending: true }); drawChat();
      try {
        const v = await call(`/${S.id}/message`, { method: 'POST', body: { ask: body.ask || S.app.ask?.id, ...body } });
        S.msgs.pop();
        setApp(v, v.changed);
        if (v.reply) say(v.reply);
        askMsg(v.ask);
      } catch (err) {
        S.msgs.pop(); say(err.message);
      }
      S.busy = false; drawChat();
      $('#pInput')?.focus();
    }

    /* ---------------- The application sheet ---------------- */

    const fieldLabel = (k) => S.schema.sections.flatMap((x) => x.fields).find((f) => f.key === k)?.label || k;
    const kindLabel = (k) => (S.schema?.docKinds.find(([v]) => v === k) || [])[1] || k;
    const val = (k) => (k in S.pending ? S.pending[k] : S.app.data[k]);
    function shown(f) {
      if (!f.when) return true;
      return Object.entries(f.when).every(([k, v]) => {
        const x = val(k);
        if (Array.isArray(v)) return v.includes(x);
        if (v && typeof v === 'object' && 'not' in v) return x != null && x !== '' && x !== v.not;
        if (v && typeof v === 'object' && 'has' in v) return Array.isArray(x) && x.includes(v.has);
        if (v === true) return x != null && x !== '' && x !== false && !(Array.isArray(x) && !x.length);
        return x === v;
      });
    }
    const issuesFor = (keys) => allIssues().filter((i) => keys.includes(i.field));
    function allIssues() {
      const a = S.app;
      const ai = (a.review?.issues || []).filter((i) => !a.review.stale);
      // Required-answer errors wait until the resident checks or submits, so unanswered questions aren't shown as mistakes.
      return [...(a.checks || []).filter((i) => i.level !== 'error' || S.showErrors || a.status === 'needs_info'), ...ai];
    }
    const ISSUE_ICON = { error: 'alert', warning: 'alert', info: 'check' };
    const issueHtml = (i) => `<div class="issue ${i.level}">${i.source === 'ai' ? '<span class="ai">AI</span>' : icon(ISSUE_ICON[i.level], 13)}<span>${esc(i.message)}</span></div>`;

    function fieldHtml(f) {
      const v = val(f.key);
      const ro = !S.app.editable;
      const dis = ro ? 'disabled' : '';
      const issues = issuesFor([f.key]).filter((i) => i.field !== 'files');
      const span = f.half ? 'half' : '';
      const id = `f-${f.key}`;
      let input;
      switch (f.type) {
        case 'longtext': input = `<textarea id="${id}" data-key="${f.key}" ${dis} placeholder="${esc(f.placeholder || '')}">${esc(v ?? '')}</textarea>`; break;
        case 'select': input = f.options.length <= 6 || f.key === 'zoning'
          ? `<div class="seg" role="radiogroup">${f.options.map(([o, l]) => `<button type="button" class="${v === o ? 'on' : ''}" data-set="${f.key}" data-v="${esc(o)}" ${dis}>${esc(l)}</button>`).join('')}</div>`
          : `<select id="${id}" data-key="${f.key}" ${dis}><option value="">Choose…</option>${f.options.map(([o, l]) => `<option value="${esc(o)}" ${v === o ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`; break;
        case 'radio': input = `<div class="radio">${f.options.map(([o, l]) => `<button type="button" class="${v === o ? 'on' : ''}" data-set="${f.key}" data-v="${esc(o)}" ${dis}><i></i><span>${esc(l)}</span></button>`).join('')}</div>`; break;
        case 'multi': input = `<div class="seg">${f.options.map(([o, l]) => `<button type="button" class="${(v || []).includes(o) ? 'on' : ''}" data-toggle="${f.key}" data-v="${esc(o)}" ${dis}>${esc(l)}</button>`).join('')}</div>`; break;
        case 'bool': input = `<div class="seg">${[[true, 'Yes'], [false, 'No']].map(([o, l]) => `<button type="button" class="${v === o ? 'on' : ''}" data-set="${f.key}" data-v="${o}" ${dis}>${l}</button>`).join('')}</div>`; break;
        case 'check': return `<div class="fld" data-f="${f.key}"><label class="chk"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''} ${dis}><span>${esc(f.label)}</span></label>${issues.map(issueHtml).join('')}</div>`;
        case 'money': input = `<div class="money"><span>$</span><input id="${id}" type="text" inputmode="decimal" data-key="${f.key}" value="${v != null ? esc(Number(v).toLocaleString()) : ''}" ${dis}></div>`; break;
        case 'number': input = `<input id="${id}" type="number" inputmode="decimal" min="0" step="any" data-key="${f.key}" value="${v ?? ''}" ${dis}>`; break;
        case 'signature': input = `<div class="sig"><input id="${id}" type="text" data-key="${f.key}" value="${esc(v ?? '')}" placeholder="Your full name" autocomplete="name" ${dis}></div>${S.app.data.signed_at ? `<small>Signed electronically ${new Date(S.app.data.signed_at).toLocaleString()}</small>` : ''}`; break;
        case 'files': return filesHtml(f);
        default: input = `<input id="${id}" type="${f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}" data-key="${f.key}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.type === 'state' ? 'maxlength="2"' : ''} autocomplete="${{ email: 'email', phone: 'tel', zip: 'postal-code' }[f.type] || 'off'}" ${dis}>`;
      }
      const labelTag = ['select', 'radio', 'multi', 'bool'].includes(f.type) ? `<div class="lbl">${esc(f.label)}</div>` : `<label for="${id}">${esc(f.label)}</label>`;
      return `<div class="fld ${span}" data-f="${f.key}">${labelTag}${input}${f.help ? `<small>${esc(f.help)}</small>` : ''}${issues.map(issueHtml).join('')}</div>`;
    }

    function filesHtml(f) {
      const files = S.app.files || [];
      const issues = issuesFor(['files']);
      return `<div class="fld" data-f="files"><div class="lbl">Attachments</div>
        <div class="files">${files.map((x) => `<div class="file"><span class="k">${esc(kindLabel(x.kind))}</span><a href="#" data-open-file="${esc(x.id)}">${esc(x.name)}</a>
          ${S.app.editable ? `<button data-del-file="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">${icon('x', 14)}</button>` : ''}</div>`).join('') || '<small>No attachments yet. Proof of ownership is required. Plans are usually needed for new buildings and additions.</small>'}</div>
        ${S.app.editable ? `<div class="uprow"><select id="pKind" data-nokey>${f.kinds.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select>
          <button class="btn" type="button" data-pact="upload">${icon('camera', 15)} Upload a PDF or photo</button></div>` : ''}
        ${issues.map(issueHtml).join('')}</div>`;
    }

    function sectionDone(sec) {
      const keys = sec.fields.filter(shown).map((f) => f.key);
      const errs = (S.app.checks || []).filter((i) => i.level === 'error' && keys.includes(i.field));
      const filled = sec.fields.filter(shown).some((f) => f.type === 'files' ? S.app.files.length : val(f.key) != null && val(f.key) !== '');
      return { done: filled && !errs.length, err: errs.length > 0 && filled && (S.showErrors || S.app.status === 'needs_info') };
    }

    function summaryHtml() {
      const a = S.app;
      const sc = a.screen;
      const badges = [];
      if (sc?.jurisdiction?.checked) badges.push(sc.jurisdiction.inCity ? `<span class="badge ok">${icon('check', 12)} Inside city limits</span>` : `<span class="badge bad">${icon('alert', 12)} Outside city limits?</span>`);
      if (sc?.flood?.checked && sc.flood.zone) badges.push(`<span class="badge ${sc.flood.sfha ? 'warn' : 'ok'}">Flood zone ${esc(sc.flood.zone)}</span>`);
      const fee = a.fee_assessed != null ? { total: a.fee_assessed, assessed: true } : a.fee;
      return `<div class="summary">
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1;min-width:220px"><div style="font-size:12px;color:var(--muted);font-weight:650;text-transform:uppercase;letter-spacing:.05em">Job site</div>
            <div style="font-weight:650;font-size:15px">${esc(sc?.matchedAddress || a.data.job_address || 'Address not given yet')}</div>
            ${badges.length ? `<div class="badges" style="margin-top:6px">${badges.join('')}</div>` : ''}
            ${sc?.jurisdiction?.checked || sc?.flood?.checked ? '<small style="display:block;margin-top:6px;color:var(--muted)">Screened automatically with U.S. Census and FEMA maps. City Hall makes the official determinations.</small>' : ''}</div>
          <div class="fee" style="min-width:190px"><div style="font-size:12px;color:var(--muted);font-weight:650;text-transform:uppercase;letter-spacing:.05em">${fee?.assessed ? 'Permit fee' : 'Estimated permit fee'}</div>
            ${fee ? `<div class="tot">$${Number(fee.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>${fee.assessed ? (a.fee_paid != null ? '<small>Paid</small>' : '<small>Due</small>') : `<small>${esc(a.fee.lines?.[1]?.label?.startsWith('Doubled') ? 'Doubled: work already started. ' : '')}From the published fee schedule. City Hall confirms the final amount.</small>`}` : '<small>Shown once you enter the valuation.</small>'}</div>
        </div>
        ${!fee?.assessed && a.fee?.notes?.length ? `<details><summary style="cursor:pointer;font-size:12.5px;color:var(--muted)">Other fees that may apply</summary><ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--muted)">${a.fee.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
      </div>`;
    }

    function statusHtml() {
      const a = S.app;
      if (a.status === 'draft') return '';
      const [label, sub] = STATUS[a.status] || [a.status, ''];
      const at = STEP_AT[a.status];
      const corr = a.status === 'needs_info' && a.corrections;
      return `<div class="status-card">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
          <div><div style="font-size:12px;color:var(--muted);font-weight:650">APPLICATION</div><div class="refno">${esc(a.ref || '')}</div></div>
          <div style="text-align:right"><b>${esc(label)}</b><div style="font-size:12.5px;color:var(--muted)">${esc(sub)}</div></div>
        </div>
        ${!['denied', 'withdrawn'].includes(a.status) ? `<div class="track">${STEPS.map(([, l], i) => `<div class="${i <= at ? 'on' : ''}"><i></i>${l}</div>`).join('')}</div>` : ''}
        ${corr ? `<div class="corr"><b>City Hall asked for these changes${corr.by ? ` (${esc(corr.by)})` : ''}:</b><ul>${(corr.items || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${corr.message ? `<div>${esc(corr.message)}</div>` : ''}<div>Update the application below, then tap <b>Resubmit</b>.</div></div>` : ''}
        ${a.status === 'fees_due' && a.payment ? `<div class="corr" style="background:#eef6f1;border-color:#cde6d8"><b>How to pay</b><div>${esc(a.payment)}</div></div>` : ''}
        ${['issued', 'closed'].includes(a.status) ? `<div class="row2" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-pact="permit-pdf">${icon('file', 15)} Download permit ${esc(a.permit_number || '')}</button></div>` : ''}
        ${a.status === 'issued' ? `<div class="issues-box"><h3>Request an inspection</h3>
          <div class="uprow"><select id="pInsType">${INSPECTIONS.map((x) => `<option>${esc(x)}</option>`).join('')}</select><input type="text" id="pInsDate" placeholder="Preferred day" style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;width:150px">
          <button class="btn" data-pact="inspect">${icon('send', 14)} Request</button></div></div>` : ''}
        ${(a.events || []).length ? `<details><summary style="cursor:pointer;font-size:12.5px;color:var(--muted)">History</summary><div class="tl2" style="margin-top:8px">${a.events.slice().reverse().map((e) => `<div><i></i><span><b>${esc(e.note || (STATUS[e.status] || [e.status])[0])}</b><br><small style="color:var(--muted)">${new Date(e.at).toLocaleString()}</small></span></div>`).join('')}</div></details>` : ''}
      </div>`;
    }

    function finalHtml() {
      const a = S.app;
      if (!a.editable) return '';
      const errs = (a.checks || []).filter((i) => i.level === 'error');
      const aiErr = (a.review?.issues || []).filter((i) => i.level === 'error');
      const reviewed = a.review && !a.review.stale;
      return `<div class="final" id="pFinal">
        <div class="sec-h"><span class="n">${icon('check', 14)}</span><h2>${a.status === 'needs_info' ? 'Resubmit' : 'Check & submit'}</h2></div>
        ${errs.length ? `<div class="issues-box"><h3>${errs.length} thing${errs.length === 1 ? '' : 's'} still needed</h3>${errs.map((i) => `<div class="issue error">${icon('alert', 13)}<span>${esc(i.message)} ${i.field ? `<button class="go" data-go="${esc(i.field)}">Go to it</button>` : ''}</span></div>`).join('')}</div>`
          : '<div class="issue info" style="font-size:13.5px;color:#0f7a55">' + icon('check', 14) + '<span>All required answers are in.</span></div>'}
        ${reviewed && aiErr.length ? `<div class="issues-box"><h3>The AI check found ${aiErr.length} thing${aiErr.length === 1 ? '' : 's'} City Hall would likely send back</h3>${aiErr.map(issueHtml).join('')}
          <label class="fld" style="margin-top:4px"><span class="lbl">Fixed these, or want to explain? Add a note for City Hall (optional)</span><textarea data-key="applicant_note" placeholder="e.g. The deed is in my late father's name; probate papers attached.">${esc(val('applicant_note') || '')}</textarea></label></div>` : ''}
        ${reviewed && !aiErr.length ? `<div class="issue info" style="font-size:13.5px">${icon('check', 14)}<span>AI check done${(a.review.issues || []).length ? ': see the notes on each section' : ': nothing City Hall would send back'}.</span></div>` : ''}
        <div class="row2">
          <button class="btn" data-pact="check" ${S.reviewing ? 'disabled' : ''}>${S.reviewing ? '<span class="spin"></span> Checking…' : `${icon('search', 15)} Check my application`}</button>
          <button class="btn primary" data-pact="submit" ${errs.length || S.reviewing ? 'disabled' : ''}>${icon('send', 15)} ${a.status === 'needs_info' ? 'Resubmit application' : 'Submit application'}</button>
        </div>
        <small style="color:var(--muted)">The AI check reads your answers and attachments the way a permit technician would. It never approves anything; Planning &amp; Building staff review every application.</small>
      </div>`;
    }

    function drawSheet(flashKeys = []) {
      const el = $('#pSheet'); if (!el || !S.app) return;
      const active = shadow.activeElement;
      const key = active?.dataset?.key; let sel = null;
      try { sel = key ? [active.selectionStart, active.selectionEnd] : null; } catch { sel = null; }
      const secs = S.schema.sections;
      el.innerHTML = `
        <div><h1>${esc(val('project_name') || 'Construction permit application')}</h1><p class="lede">${esc(o.cityName)} · Planning &amp; Building${S.app.editable ? ' · Answer in the chat, or fill in anything here directly.' : ''}</p></div>
        ${statusHtml()}
        ${summaryHtml()}
        ${S.app.editable ? `<nav class="steps">${secs.map((s, i) => { const st = sectionDone(s); return `<button class="step ${st.done ? 'done' : ''} ${st.err ? 'err' : ''}" data-jump="${s.id}"><b>${st.done ? '✓' : i + 1}</b>${esc(s.title)}</button>`; }).join('')}</nav>` : ''}
        ${secs.map((s, i) => { const st = sectionDone(s); return `<section class="sec ${st.done ? 'done' : ''}" id="sec-${s.id}"><div class="sec-h"><span class="n">${st.done ? '✓' : i + 1}</span><h2>${esc(s.title)}</h2></div><div class="grid">${s.fields.filter(shown).map(fieldHtml).join('')}</div></section>`; }).join('')}
        ${finalHtml()}`;
      if (key) {
        const n = el.querySelector(`[data-key="${key}"]`);
        if (n) { n.focus({ preventScroll: true }); if (sel) try { n.setSelectionRange(...sel); } catch { /* not a text input */ } }
      }
      const flash = flashKeys.map((k) => el.querySelector(`[data-f="${k}"]`)).filter(Boolean);
      if (flash.length) {
        flash.forEach((n) => n.classList.add('flash'));
        setTimeout(() => flash.forEach((n) => n.classList.remove('flash')), 1400);
        if (!key) flash[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    /* ---------------- Editing in the sheet ---------------- */

    function edit(k, v) {
      S.pending[k] = v;
      S.app.data[k] = v;
      S.saving = true; drawHead();
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(flush, 700);
    }

    async function flush() {
      clearTimeout(S.saveTimer);
      const keys = Object.keys(S.pending);
      if (!keys.length) return;
      const sent = { ...S.pending };
      try {
        const v = await call(`/${S.id}`, { method: 'PATCH', body: { data: sent } });
        for (const k of keys) if (S.pending[k] === sent[k]) delete S.pending[k];
        const addr = 'job_address' in sent;
        setApp(v);
        if (addr && v.screenNote) say(v.screenNote);
        if (v.ask) syncAsk(v.ask);
      } catch (err) {
        say(`I couldn't save that: ${err.message}`);
      }
      S.saving = Object.keys(S.pending).length > 0; S.savedAt = Date.now(); drawHead();
    }

    // When a form edit answers the question the chat is waiting on, move the chat along too.
    function syncAsk(a) {
      const last = S.msgs[S.msgs.length - 1];
      if (last?.role === 'bot' && last.ask && last.ask !== a.id) { say('Thanks, I see that in the form.'); askMsg(a); }
    }

    function onFieldInput(e) {
      const k = e.target.dataset.key; if (!k) return;
      if (e.target.type === 'checkbox') return;
      let v = e.target.value;
      if (e.target.closest('.money')) v = v.replace(/[^\d.]/g, '');
      edit(k, v);
    }
    function onFieldChange(e) {
      const k = e.target.dataset.key; if (!k) return;
      if (e.target.type === 'checkbox') { edit(k, e.target.checked); flush(); return; }
      if (e.target.tagName === 'SELECT') { edit(k, e.target.value || null); flush(); }
    }

    function onSheetClick(e) {
      const set = e.target.closest('[data-set]');
      if (set && !set.disabled) {
        const k = set.dataset.set; let v = set.dataset.v;
        if (v === 'true') v = true; else if (v === 'false') v = false;
        edit(k, val(k) === v ? null : v); drawSheet(); flush(); return;
      }
      const tog = e.target.closest('[data-toggle]');
      if (tog && !tog.disabled) {
        const k = tog.dataset.toggle; const cur = new Set(val(k) || []);
        cur.has(tog.dataset.v) ? cur.delete(tog.dataset.v) : cur.add(tog.dataset.v);
        edit(k, [...cur]); drawSheet(); return;
      }
      const jump = e.target.closest('[data-jump]');
      if (jump) { $(`#sec-${jump.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const go = e.target.closest('[data-go]');
      if (go) { const n = $(`[data-f="${go.dataset.go}"]`); if (n) { n.scrollIntoView({ behavior: 'smooth', block: 'center' }); n.querySelector('input, textarea, button')?.focus({ preventScroll: true }); } return; }
      const of = e.target.closest('[data-open-file]');
      if (of) { e.preventDefault(); openBlob(`/${S.id}/files/${of.dataset.openFile}`); return; }
      const df = e.target.closest('[data-del-file]');
      if (df) { removeFile(df.dataset.delFile); return; }
      const act = e.target.closest('[data-pact]');
      if (act) sheetAction(act.dataset.pact, act);
    }

    async function sheetAction(a) {
      if (a === 'upload') pickFile($('#pKind')?.value || 'other');
      else if (a === 'check') runCheck();
      else if (a === 'submit') submit();
      else if (a === 'permit-pdf') openBlob(`/${S.id}/permit.pdf`);
      else if (a === 'inspect') {
        try {
          const v = await call(`/${S.id}/inspections`, { method: 'POST', body: { type: $('#pInsType').value, date: $('#pInsDate').value } });
          setApp(v); say(`Inspection request sent: **${$('#pInsType')?.value || 'Inspection'}**. City Hall will call to confirm the time.`);
        } catch (err) { say(err.message); }
      } else if (a === 'send-link') sendLink();
      else if (a === 'copy-link') { navigator.clipboard?.writeText(link()); say('Link copied. Keep it private: anyone with it can open your application.'); }
    }

    /* ---------------- Files ---------------- */

    function pickFile(kind) {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'application/pdf,image/*';
      inp.onchange = async () => {
        const file = inp.files[0]; if (!file) return;
        if (file.size > 15 * 1024 * 1024) { say('That file is larger than 15 MB. Please choose a smaller one, or take a photo of it.'); return; }
        me(`📎 ${file.name}`);
        S.busy = true; S.msgs.push({ role: 'bot', pending: true }); drawChat();
        const fd = new FormData(); fd.append('file', file); fd.append('kind', kind);
        try {
          const v = await call(`/${S.id}/files`, { method: 'POST', form: fd });
          S.msgs.pop(); setApp(v, ['files']);
          say(v.reply || 'Attached.');
          askMsg(v.ask);
        } catch (err) { S.msgs.pop(); say(err.message); }
        S.busy = false; drawChat();
      };
      inp.click();
    }

    async function removeFile(fid) {
      try { setApp(await call(`/${S.id}/files/${fid}`, { method: 'DELETE' })); } catch (err) { say(err.message); }
    }

    async function openBlob(path) {
      const w = window.open('', '_blank');
      try {
        const res = await fetch(`${api}/permits${path}`, { headers: { 'X-Permit-Token': S.token } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not open the file');
        const url = URL.createObjectURL(await res.blob());
        if (w) w.location = url; else location.href = url;
      } catch (err) { w?.close(); say(err.message); }
    }

    async function openPdf() { await flush(); openBlob(`/${S.id}/pdf`); }

    /* ---------------- Check, submit, finish later ---------------- */

    async function runCheck() {
      await flush();
      S.showErrors = true;
      S.reviewing = true; drawSheet();
      say('Checking your application the way a permit technician would: required answers, the numbers, and whether your documents match what you entered…');
      try {
        const v = await call(`/${S.id}/check`, { method: 'POST' });
        setApp(v, Object.keys(v.filled || {}));
        const errs = v.checks.filter((i) => i.level === 'error');
        const ai = (v.review?.issues || []);
        const aiErr = ai.filter((i) => i.level === 'error');
        const warn = [...v.checks.filter((i) => i.level === 'warning'), ...ai.filter((i) => i.level === 'warning')];
        const lines = [];
        const filled = Object.entries(v.filled || {});
        if (filled.length) lines.push(`I found ${filled.map(([k, x]) => `the **${fieldLabel(k).toLowerCase()}** (${x})`).join(' and ')} on your documents and filled ${filled.length === 1 ? 'it' : 'them'} in.`);
        if (errs.length) lines.push(`**${errs.length} required item${errs.length === 1 ? ' is' : 's are'} missing:**\n${errs.map((i) => `- ${i.message}`).join('\n')}`);
        if (aiErr.length) lines.push(`**City Hall would likely send this back for:**\n${aiErr.map((i) => `- ${i.message}`).join('\n')}`);
        if (warn.length) lines.push(`**Worth a look:**\n${warn.slice(0, 6).map((i) => `- ${i.message}`).join('\n')}`);
        if (!v.reviewed) lines.push("The AI part of the check isn't available right now, but the required-answer checks ran.");
        if (!errs.length && !aiErr.length) lines.push('Everything City Hall needs is here. Tap **Submit application** when you are ready.');
        say(lines.join('\n\n'), !errs.length ? { buttons: `<button class="opt" data-pact="submit">${icon('send', 14)} Submit application</button>` } : {});
      } catch (err) { say(err.message); }
      S.reviewing = false; drawSheet();
      if (innerWidth <= 900) setTab('chat');
    }

    async function submit() {
      await flush();
      S.showErrors = true;
      S.busy = true; drawSheet();
      try {
        const v = await call(`/${S.id}/submit`, { method: 'POST' });
        setApp(v);
        remember();
        say(`**Submitted.** Your reference number is **${v.ref}**.\n\nWhat happens next:\n- Planning & Building checks that it's complete.\n- You'll get the permit fee and how to pay.\n- The Land Code Administrator reviews zoning, floodplain and code requirements.\n- When it's approved, you download the permit here and post it at the job site.\n\nWe'll contact you by ${({ email: 'email', sms: 'text message', call: 'phone' })[v.data.contact_pref] || 'email'} at each step. You can also type **${v.ref}** in the chat any time to check the status.`);
        watch();
      } catch (err) {
        if (err.data?.checks) { setApp({ ...S.app, checks: err.data.checks }); say(`${err.message} They're marked in red on the right.`); } else say(err.message);
      }
      S.busy = false; drawSheet(); drawChat();
    }

    // The automated completeness check runs right after submission; show its result if it sends the application back.
    function watch() {
      let n = 0;
      clearInterval(S.poll);
      S.poll = setInterval(async () => {
        if (S.closed || ++n > 12) { clearInterval(S.poll); return; }
        try {
          const v = await call(`/${S.id}`);
          if (v.status !== S.app.status) {
            clearInterval(S.poll);
            setApp(v);
            if (v.status === 'needs_info') say(`The automated completeness check found ${v.corrections?.items?.length || 'a few'} thing${v.corrections?.items?.length === 1 ? '' : 's'} to fix before staff review:\n${(v.corrections?.items || []).map((x) => `- ${x}`).join('\n')}\n\nYour answers are saved. Fix these on the right, then tap **Resubmit**.`);
          }
        } catch { /* try again */ }
      }, 4000);
    }

    async function finishLater() {
      await flush();
      const c = S.app.data;
      const hasContact = c.owner_email || c.applicant_email || c.contractor_email || c.owner_phone || c.owner_cell;
      say(`Your answers are saved. ${hasContact ? 'I can send you a link to pick up where you left off.' : "Want a link to finish later? Type your email or cell number and I'll send it."} You can also copy it now.`, {
        buttons: `${hasContact ? `<button class="opt" data-pact="send-link">${icon('send', 14)} Send me the link</button>` : ''}<button class="opt" data-pact="copy-link">${icon('copy', 14)} Copy link</button>`,
      });
      S.wantLink = !hasContact;
      if (innerWidth <= 900) setTab('chat');
    }

    async function sendLink(target = {}) {
      try {
        const { results } = await call(`/${S.id}/send-link`, { method: 'POST', body: target });
        const r = results?.[0];
        if (r?.status === 'sent') say(`Sent. Check your ${r.channel === 'email' ? 'email' : 'texts'} for the link.`);
        else say(`Messages aren't switched on for ${o.cityName} yet, so here's your link. Bookmark it or copy it somewhere safe:`, { buttons: `<button class="opt" data-pact="copy-link">${icon('copy', 14)} Copy link</button>` });
      } catch (err) { say(err.message); }
    }

    /* ---------------- State ---------------- */

    function setApp(v, changed = []) {
      const keepPending = { ...S.pending };
      S.app = { ...S.app, ...v, data: { ...v.data, ...keepPending } };
      if (v.review && S.app.review) S.app.review.stale = false;
      remember();
      local.set(`${S.id}:seen`, S.app.status);
      drawHead();
      drawSheet(changed || []);
    }

    // The device keeps a list of its applications, so the chat can offer to continue one.
    function remember() {
      const list = (local.get('list') || []).filter((x) => x.id !== S.id);
      list.unshift({ id: S.id, token: S.token, ref: S.app?.ref || null, status: S.app?.status || 'draft', progress: S.app?.progress || 0, address: S.app?.screen?.matchedAddress || S.app?.data?.job_address || null, at: Date.now() });
      local.set('list', list.slice(0, 10));
      o.onChange?.(list[0]);
    }

    function close() {
      S.closed = true; clearInterval(S.poll); flush();
      root.classList.remove('permit');
      document.documentElement.style.overflow = '';
      o.onClose?.();
    }

    /* ---------------- Start ---------------- */

    frame();
    try {
      S.schema = await fetch(`${api}/permits/schema`, { cache: 'no-cache' }).then((r) => r.json());
      if (!S.id) {
        const prev = (local.get('list') || []).find((x) => x.status !== 'draft' && x.status !== 'withdrawn');
        const v = await call('', { method: 'POST', body: { opening: o.opening || '', convoId: o.convoId || null, copyFrom: prev ? { id: prev.id, token: prev.token } : null } });
        S.id = v.id; S.token = v.token;
        S.app = v; remember();
        drawHead(); drawSheet(v.changed || Object.keys(v.data));
        say(`I'll help you prepare your construction permit application for ${o.cityName}. I'll ask one thing at a time and fill in the city's form on the right as we go. You can also type straight into the form.${prev ? `\n\nI reused your contact${v.data.contractor_name ? ' and contractor' : ''} details from **${prev.ref || 'your last application'}**. Change anything that's different.` : ''}\n\nNothing is sent to City Hall until you tap **Submit**.`);
        if (v.reply) say(v.reply);
        askMsg(v.ask);
      } else {
        const v = await call(`/${S.id}`);
        S.app = v; remember();
        S.msgs = local.get(`${S.id}:msgs`) || [];
        drawHead(); drawSheet();
        if (!S.msgs.length || o.fresh) {
          if (v.status === 'draft') { say(`Welcome back. Your application is **${v.progress}%** complete, and everything you entered is saved.`); askMsg(v.ask); }
          else if (v.status === 'needs_info') { say(`City Hall asked for a few changes to **${v.ref}**:\n${(v.corrections?.items || []).map((x) => `- ${x}`).join('\n')}\n\nYour answers are saved. Fix these on the right, then tap **Resubmit**.`); }
          else say(`Here's the latest on **${v.ref}**: ${STATUS[v.status]?.[0] || v.status}. ${STATUS[v.status]?.[1] || ''}.`);
        } else if (local.get(`${S.id}:seen`) && local.get(`${S.id}:seen`) !== v.status) {
          // City Hall acted since the last visit: say what changed before anything else.
          const [label, sub] = STATUS[v.status] || [v.status, ''];
          say(v.status === 'issued' ? `Good news: permit **${v.permit_number}** has been issued. Download it on the Application tab, print it and post it at the job site.`
            : v.status === 'needs_info' ? `City Hall asked for a few changes to **${v.ref}**:\n${(v.corrections?.items || []).map((x) => `- ${x}`).join('\n')}\n\nFix these on the right, then tap **Resubmit**.`
              : v.status === 'fees_due' ? `**${v.ref}** is complete. The permit fee is **$${Number(v.fee_assessed).toFixed(2)}**. ${v.payment || ''}`
                : `Update on **${v.ref}**: ${label}. ${sub}.`);
        } else drawChat();
      }
    } catch (err) {
      say(`Sorry, the permit application couldn't load (${err.message}). Please try again, or call City Hall${o.phone ? ` at ${o.phone}` : ''}.`);
    }

    // Typed email or phone after "finish later" goes to the link, not the application.
    const form = $('#pForm');
    const submitHandler = form.onsubmit;
    form.onsubmit = (e) => {
      e.preventDefault();
      const input = $('#pInput'); const v = input.value.trim();
      if (S.wantLink && v && (/@/.test(v) || v.replace(/\D/g, '').length >= 10)) {
        S.wantLink = false; input.value = ''; me(v);
        sendLink(/@/.test(v) ? { email: v } : { phone: v });
        return;
      }
      S.wantLink = false;
      submitHandler(e);
    };
    $('#pInput')?.focus();
  }

  window.__chosPermit = { mount };
})();
