/*!
 * City Hall OS: guided applications (construction permit, variance, sign permit, certificate of occupancy, ...).
 * Loaded by embed.js when a resident starts or resumes an application. The chat panel grows into a full-screen
 * workspace laid out like a dashboard: the sections on the left, the application in the middle, filling in as the
 * resident answers, and the conversation on the right. On a phone the conversation and the application are tabs. Residents can ask what anything means at any point; the assistant answers and
 * then repeats the question. Every answer is saved as it is given, so the application can be finished later from
 * the same secret link, or from My applications after signing in with a phone number.
 * Everything form-specific (fields, statuses, steps, what gets issued) comes from the form's schema.
 */
(() => {
  if (window.__chosPermit) return;

  // Where each status sits on the progress tracker, by the tracker's step keys.
  function stepAt(steps, status) {
    const at = (k) => steps.findIndex(([key]) => key === k);
    const first = (...ks) => ks.map(at).find((i) => i >= 0) ?? -1;
    return ({ draft: -1, withdrawn: -1, submitted: first('submitted'), needs_info: first('submitted'), fees_due: first('complete', 'submitted'),
      in_review: first('in_review'), denied: first('in_review'), issued: steps.length - 1, closed: steps.length - 1 })[status] ?? -1;
  }

  const CSS = `
  .panel { transition: right .5s cubic-bezier(.2,.8,.2,1), bottom .5s cubic-bezier(.2,.8,.2,1), width .5s cubic-bezier(.2,.8,.2,1), height .5s cubic-bezier(.2,.8,.2,1), border-radius .5s; }
  .root.permit:not(.page) .panel { right: 0; bottom: 0; width: 100vw; height: 100vh; height: 100dvh; border-radius: 0; }
  .root.permit.page .panel { position: fixed; inset: 0; z-index: 2147483001; width: auto; height: auto; border-radius: 0; animation: grow .4s cubic-bezier(.2,.8,.2,1); }
  @keyframes grow { from { opacity: .4; transform: scale(.97); } }
  .root.permit { --field: #d9d5ca; --canvas: #f4f3ee; }

  /* Top bar */
  .root.permit .head { background: #fff; color: var(--ink); border-bottom: 1px solid var(--line); padding: 10px 14px 10px 16px; min-height: 62px; }
  .root.permit .head .avatar { width: 38px; height: 38px; background: color-mix(in srgb, var(--brand) 12%, #fff); color: var(--brand); }
  .root.permit .head h2 { font-size: 15.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .root.permit .head .tools { gap: 8px; }
  .root.permit .icon-btn:hover { background: var(--soft); }
  .head .sub2 { margin: 1px 0 0; font-size: 12.5px; color: var(--muted); opacity: 1; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .head .sub2 b { color: var(--ink); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: 12px; }
  .saved { display: inline-flex; gap: 4px; align-items: center; }
  .pill { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; font-weight: 650; background: var(--soft); color: var(--ink); white-space: nowrap; }
  .pill.live { background: color-mix(in srgb, var(--brand) 12%, #fff); color: var(--brand); }
  .pill.warn { background: #fff1d6; color: #8a5100; } .pill.ok { background: #e2f3ea; color: #0f7a55; } .pill.bad { background: #fde8e6; color: #b42318; }
  .head .tbtn { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; font-weight: 600; font-size: 13px; }
  .head .tbtn:hover { border-color: var(--brand); color: var(--brand); }
  .hbar { height: 3px; background: var(--soft); }
  .hbar i { display: block; height: 100%; background: var(--brand); transition: width .6s ease; }

  /* Workspace: sections rail, the application, the assistant */
  .ws { flex: 1; min-height: 0; display: grid; grid-template-columns: 264px minmax(0, 1fr) minmax(360px, 410px); grid-template-areas: "rail sheet chat"; background: var(--canvas); }
  .ws-rail { grid-area: rail; min-height: 0; overflow-y: auto; border-right: 1px solid var(--line); background: var(--paper); padding: 18px 12px 14px; display: flex; flex-direction: column; gap: 16px; }
  .ws-sheet { grid-area: sheet; min-height: 0; overflow-y: auto; background: var(--canvas); scroll-behavior: smooth; }
  .ws-chat { grid-area: chat; display: flex; flex-direction: column; min-height: 0; border-left: 1px solid var(--line); background: #fff; }
  .ws-tabs, .ws-dock { display: none; }

  /* Assistant */
  .chat-h { display: flex; gap: 10px; align-items: center; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  .chat-h .spark { width: 32px; height: 32px; flex: none; border-radius: 10px; display: grid; place-items: center; background: var(--brand); color: #fff; }
  .chat-h b { display: block; font-size: 14px; } .chat-h small { display: block; color: var(--muted); font-size: 12px; line-height: 1.3; }
  .ws-chat .log { padding: 18px 16px; gap: 12px; }
  .ws-chat .msg { max-width: 92%; }
  .ws-chat .bot { background: var(--canvas); border-color: transparent; }
  .ws-chat .composer { border-top: 0; padding: 8px 14px; }
  .ws-chat .composer textarea { background: #fff; border-color: var(--field); }
  .ws-chat .foot { padding: 0 16px 12px; }
  .askhint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .opts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .opt { border: 1px solid var(--field); background: #fff; border-radius: 999px; padding: 7px 13px; font-size: 13.5px; cursor: pointer; text-align: left; line-height: 1.3; font-weight: 550; }
  .opt:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
  .opt:disabled { opacity: .45; cursor: default; }
  .btn:disabled { opacity: .5; cursor: default; }
  .opt.long { border-radius: 12px; width: 100%; }

  /* Sections rail */
  .rail-prog { display: flex; gap: 12px; align-items: center; padding: 0 8px; }
  .ring { width: 52px; height: 52px; flex: none; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(var(--brand) calc(var(--p) * 1%), #e5e2d8 0); }
  .ring span { width: 42px; height: 42px; border-radius: 50%; background: var(--paper); display: grid; place-items: center; font-size: 12.5px; font-weight: 750; font-variant-numeric: tabular-nums; }
  .rail-prog b { display: block; font-size: 14px; } .rail-prog small { display: block; color: var(--muted); font-size: 12px; line-height: 1.35; }
  .eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .rail-nav { display: grid; gap: 2px; }
  .rail-nav .eyebrow { padding: 0 8px 6px; }
  .rn { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 10px; align-items: center; width: 100%; text-align: left; border: 0; background: none; padding: 7px 8px; border-radius: 10px; cursor: pointer; font-size: 13.5px; font-weight: 550; color: var(--ink); }
  .rn:hover { background: var(--soft); }
  .rn.on { background: #fff; box-shadow: 0 0 0 1px var(--line), 0 1px 3px rgba(11,19,36,.06); font-weight: 650; }
  .rn b { width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center; background: #ebe8de; font-size: 11.5px; font-weight: 700; }
  .rn.done b { background: var(--brand); color: #fff; } .rn.err b { background: #fde8e6; color: #b42318; }
  .rn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rn small { font-size: 11.5px; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
  .rail-card { background: #fff; border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; display: grid; gap: 3px; }
  .rail-card .v { font-weight: 650; font-size: 14px; line-height: 1.35; }
  .rail-card .big { font-size: 21px; font-weight: 750; letter-spacing: -.01em; }
  .rail-card small { color: var(--muted); font-size: 12px; line-height: 1.4; }
  .rail-card .badges { margin-top: 4px; }
  .rail-help { margin-top: auto; font-size: 12.5px; color: var(--muted); padding: 0 8px; line-height: 1.45; }
  .rail-help a { color: var(--brand); font-weight: 650; text-decoration: none; }

  /* The application */
  .sheet { max-width: 800px; margin: 0 auto; padding: 26px 28px 80px; display: grid; gap: 16px; }
  .page-h h1 { font-size: 24px; margin: 3px 0 0; letter-spacing: -.02em; line-height: 1.2; }
  .tip { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
  .tip .qhelp { margin: 0; flex: none; pointer-events: none; }
  .sum-inline, .steps { display: none; }
  .summary { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 14px 16px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 18px; }
  .summary .v { font-weight: 650; font-size: 14.5px; line-height: 1.35; }
  .summary .big { font-size: 19px; font-weight: 750; text-align: right; }
  .summary .r { text-align: right; }
  .summary small { color: var(--muted); font-size: 12px; }
  .summary > :last-child:nth-child(odd) { grid-column: 1 / -1; }
  .steps { gap: 6px; overflow-x: auto; position: sticky; top: 0; z-index: 2; background: var(--canvas); padding: 8px 0; margin: -8px 0; scrollbar-width: none; }
  .steps::-webkit-scrollbar { display: none; }
  .step { flex: none; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 5px 12px 5px 6px; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--ink); }
  .step b { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; background: var(--soft); font-size: 11px; }
  .step.on { border-color: var(--brand); box-shadow: 0 0 0 1px var(--brand); }
  .step.done b { background: var(--brand); color: #fff; }
  .step.err b { background: #fde8e6; color: #b42318; }
  .sec { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px 22px 22px; display: grid; gap: 18px; scroll-margin-top: 16px; box-shadow: 0 1px 2px rgba(11,19,36,.03); }
  .sec-h { display: flex; align-items: center; gap: 10px; padding-bottom: 14px; margin: 0 -22px; padding-left: 22px; padding-right: 22px; border-bottom: 1px solid #efece4; }
  .sec-h h2 { margin: 0; font-size: 16px; letter-spacing: -.01em; flex: 1; }
  .sec-h .n { width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--soft); display: grid; place-items: center; font-size: 12px; font-weight: 700; }
  .sec-h .cnt { font-size: 12px; color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
  .sec.done .sec-h .n { background: var(--brand); color: #fff; }
  .sec.done .sec-h .cnt { color: #0f7a55; }
  .grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 18px 16px; }
  .fld { grid-column: span 6; display: grid; gap: 7px; align-content: start; border-radius: 10px; transition: background .6s, box-shadow .6s; }
  .fld.half { grid-column: span 3; }
  .fld > .lbl { font-size: 13.5px; font-weight: 600; color: var(--ink); display: flex; align-items: center; gap: 6px; line-height: 1.35; }
  .fld > .lbl label { cursor: pointer; }
  .fld .hint { color: var(--muted); font-size: 12.5px; line-height: 1.4; margin-top: -3px; }
  .fld small { color: var(--muted); font-size: 12px; }
  .fld input[type=text], .fld input[type=email], .fld input[type=tel], .fld input[type=number], .fld textarea, .fld select {
    width: 100%; height: 44px; border: 1px solid var(--field); border-radius: 10px; padding: 0 12px; background: #fff; outline: none; font-size: 14.5px; transition: border-color .15s, box-shadow .15s; }
  .fld textarea { height: auto; min-height: 88px; padding: 10px 12px; resize: vertical; line-height: 1.45; }
  .fld input:hover:not(:disabled), .fld textarea:hover:not(:disabled), .fld select:hover:not(:disabled) { border-color: #c4bfb1; }
  .fld input:focus, .fld textarea:focus, .fld select:focus { border-color: var(--brand); box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 16%, transparent); }
  .fld input:disabled, .fld textarea:disabled, .fld select:disabled { background: var(--paper); color: var(--ink); }
  .fld input::placeholder, .fld textarea::placeholder { color: #9aa1ad; }
  .fld.flash { background: color-mix(in srgb, var(--brand) 9%, #fff); box-shadow: 0 0 0 8px color-mix(in srgb, var(--brand) 9%, #fff); }
  .fld .money { position: relative; } .fld .money span { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); }
  .fld .money input { padding-left: 24px; }
  .qhelp { display: inline-grid; place-items: center; width: 20px; height: 20px; flex: none; border-radius: 50%; border: 0; background: var(--soft); color: var(--muted); font-size: 11.5px; font-weight: 800; cursor: pointer; padding: 0; }
  .qhelp:hover { background: color-mix(in srgb, var(--brand) 14%, #fff); color: var(--brand); }
  .linkq { border: 0; background: none; color: var(--brand); font-weight: 600; cursor: pointer; padding: 0; font-size: 12.5px; justify-self: start; }
  .addr { position: relative; }
  .composer { position: relative; }
  .addr-sug { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 30; background: #fff; border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 14px 34px rgba(11,19,36,.16); overflow: hidden; }
  .composer .addr-sug { top: auto; bottom: calc(100% + 6px); left: 10px; right: 10px; }
  .addr-sug button { display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left; padding: 10px 12px; border: 0; background: none; cursor: pointer; font-size: 14px; color: var(--ink); }
  .addr-sug button svg { flex: none; margin-top: 2px; color: var(--muted); }
  .addr-sug button.on, .addr-sug button:hover { background: var(--soft); }
  .addr-sug button small { display: block; color: var(--muted); font-size: 12px; margin-top: 1px; }
  .addr-sug .note { padding: 7px 12px; font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); background: var(--paper); }
  .addr-ok { color: #0f7a55 !important; display: flex; gap: 5px; align-items: center; }
  .seg { display: flex; flex-wrap: wrap; gap: 8px; }
  .seg.many { display: grid; grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)); }
  .seg.many button.wide { grid-column: 1 / -1; }
  .seg button { min-height: 40px; border: 1px solid var(--field); background: #fff; border-radius: 10px; padding: 7px 14px; cursor: pointer; font-size: 14px; font-weight: 550; transition: border-color .15s, background .15s; }
  .seg button:hover:not(:disabled):not(.on) { border-color: var(--brand); color: var(--brand); }
  .seg button.on { background: var(--brand); border-color: var(--brand); color: #fff; }
  .seg button:disabled { cursor: default; }
  .seg.yn { display: inline-grid; grid-auto-flow: column; grid-auto-columns: minmax(92px, 1fr); gap: 4px; padding: 4px; border: 1px solid var(--field); border-radius: 12px; background: var(--paper); justify-self: start; }
  .seg.yn button { border: 0; min-height: 36px; border-radius: 8px; background: transparent; }
  .seg.yn button.on { background: var(--brand); }
  .radio { display: grid; gap: 8px; }
  .radio button { text-align: left; border: 1px solid var(--field); background: #fff; border-radius: 12px; padding: 11px 13px; cursor: pointer; font-size: 14px; display: flex; gap: 10px; line-height: 1.4; }
  .radio button:hover:not(:disabled) { border-color: #c4bfb1; }
  .radio button i { flex: none; width: 18px; height: 18px; border-radius: 50%; border: 2px solid var(--field); margin-top: 1px; }
  .radio button.on { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 6%, #fff); box-shadow: 0 0 0 1px var(--brand); }
  .radio button.on i { border-color: var(--brand); background: radial-gradient(var(--brand) 42%, transparent 48%); }
  .chk { display: flex; gap: 11px; align-items: flex-start; font-size: 14px; line-height: 1.5; cursor: pointer; padding: 12px 14px; border: 1px solid var(--field); border-radius: 12px; background: #fff; }
  .chk:has(input:checked) { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 6%, #fff); }
  .chk input { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--brand); flex: none; }
  .sig input { font-family: "Brush Script MT", "Segoe Script", "Lucida Handwriting", cursive; font-size: 24px !important; height: 52px !important; }
  .issue { font-size: 12.5px; display: flex; gap: 6px; align-items: flex-start; line-height: 1.4; }
  .issue svg { flex: none; margin-top: 2px; }
  .issue.error { color: #b42318; } .issue.warning { color: #8a5100; } .issue.info { color: var(--muted); }
  .issue .ai { font-size: 10px; font-weight: 700; padding: 0 5px; border-radius: 4px; background: #efebff; color: #5b3fd1; flex: none; margin-top: 1px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: var(--soft); }
  .badge.ok { background: #e2f3ea; color: #0f7a55; } .badge.warn { background: #fff1d6; color: #8a5100; } .badge.bad { background: #fde8e6; color: #b42318; }
  details.more summary { cursor: pointer; font-size: 12.5px; color: var(--muted); }
  details.more ul { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--muted); }
  .files { display: grid; gap: 6px; }
  .file { display: flex; gap: 10px; align-items: center; padding: 9px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); font-size: 13.5px; }
  .file .k { font-size: 11px; font-weight: 700; color: var(--brand); text-transform: uppercase; letter-spacing: .03em; }
  .file a { color: inherit; text-decoration: none; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file button { border: 0; background: none; cursor: pointer; color: var(--muted); padding: 2px; }
  .drop { display: grid; gap: 10px; padding: 14px; border: 1.5px dashed var(--field); border-radius: 12px; background: var(--paper); }
  .uprow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .uprow select { width: auto !important; flex: 1; min-width: 160px; }
  .uprow .btn { height: 44px; }
  .final { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px 22px 22px; display: grid; gap: 14px; scroll-margin-top: 16px; }
  .final .row2 { display: flex; gap: 8px; flex-wrap: wrap; }
  .final .row2 .btn { height: 44px; padding: 0 16px; font-size: 14px; }
  .issues-box { display: grid; gap: 8px; padding: 12px 14px; border-radius: 12px; background: var(--paper); border: 1px solid var(--line); }
  .issues-box h3 { margin: 0; font-size: 13.5px; }
  .issues-box button.go { border: 0; background: none; color: var(--brand); font-weight: 600; cursor: pointer; padding: 0; font-size: 12.5px; }
  .track { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; }
  .track div { display: grid; gap: 5px; font-size: 11.5px; color: var(--muted); font-weight: 600; }
  .track i { height: 6px; border-radius: 99px; background: var(--soft); }
  .track .on i { background: var(--brand); } .track .on { color: var(--ink); }
  .status-card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 18px; display: grid; gap: 12px; }
  .status-card .refno { font-family: "JetBrains Mono", ui-monospace, monospace; font-weight: 700; font-size: 20px; }
  .tl2 { display: grid; gap: 8px; font-size: 13px; }
  .tl2 div { display: grid; grid-template-columns: 14px 1fr; gap: 8px; } .tl2 i { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); margin-top: 6px; }
  .corr { background: #fff7e8; border: 1px solid #f5d9a6; border-radius: 14px; padding: 14px 16px; display: grid; gap: 6px; font-size: 13.5px; }
  .corr ul { margin: 0; padding-left: 18px; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: sp .8s linear infinite; display: inline-block; }
  @keyframes sp { to { transform: rotate(360deg); } }

  /* Laptop: no rail; the progress, property and fee move into the application. */
  @media (max-width: 1199px) {
    .ws { grid-template-columns: minmax(0, 1fr) minmax(340px, 390px); grid-template-areas: "sheet chat"; }
    .ws-rail { display: none; }
    .sum-inline { display: block; }
    .steps { display: flex; }
    .sec, .final { scroll-margin-top: 60px; }
  }

  /* Phone: the assistant and the application are two tabs. */
  @media (max-width: 900px) {
    .root.permit.page .panel { height: 100dvh; }
    .root.permit .head { min-height: 56px; padding: 8px 8px 8px 12px; gap: 10px; }
    .root.permit .head .avatar { width: 34px; height: 34px; border-radius: 10px; }
    .root.permit .head h2 { font-size: 15px; }
    .root.permit .head .tools { gap: 4px; }
    .head .tbtn { width: 38px; padding: 0; justify-content: center; }
    .head .tbtn .lbl { display: none; }
    .ws { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr) auto; grid-template-areas: "tabs" "main" "dock"; }
    .ws-tabs { grid-area: tabs; display: block; padding: 8px 12px; background: #fff; border-bottom: 1px solid var(--line); }
    .ws-tabs > div { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; padding: 3px; border-radius: 12px; background: var(--soft); }
    .ws-tabs button { height: 38px; border: 0; border-radius: 9px; background: transparent; font-weight: 650; font-size: 14px; color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .ws-tabs button.on { background: #fff; color: var(--ink); box-shadow: 0 1px 3px rgba(11,19,36,.14); }
    .ws-tabs button .pct { font-size: 11.5px; font-weight: 700; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--brand) 12%, #fff); color: var(--brand); }
    .ws-tabs button .pct:empty { display: none; }
    .ws-sheet, .ws-chat { grid-area: main; }
    .ws[data-tab="chat"] .ws-sheet, .ws[data-tab="form"] .ws-chat { display: none; }
    .ws[data-tab="form"] .ws-dock { display: flex; }
    .ws-dock:empty { display: none !important; }
    .ws-dock { grid-area: dock; gap: 12px; align-items: center; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: #fff; border-top: 1px solid var(--line); }
    .ws-dock .dp { flex: 1; min-width: 0; font-size: 12.5px; color: var(--muted); display: grid; gap: 5px; }
    .ws-dock .dp b { color: var(--ink); }
    .ws-dock .mini { height: 5px; border-radius: 9px; background: var(--soft); overflow: hidden; } .ws-dock .mini i { display: block; height: 100%; background: var(--brand); }
    .ws-dock .btn { height: 44px; padding: 0 16px; font-size: 14.5px; border-radius: 12px; }
    .ws-chat { border-left: 0; }
    .chat-h { display: none; }
    .ws-chat .log { padding: 14px 12px; }
    .ws-chat .foot { padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
    .sheet { padding: 16px 12px 28px; gap: 14px; }
    .page-h h1 { font-size: 20px; }
    .sec, .final { padding: 14px 16px 18px; border-radius: 14px; gap: 16px; scroll-margin-top: 58px; }
    .sec-h { margin: 0 -16px; padding: 0 16px 12px; }
    .steps { margin: -8px -12px; padding: 8px 12px; }
    .summary { padding: 12px 14px; }
    /* Thumb-sized choices, and 16px text so phones don't zoom into fields. */
    .opt { padding: 10px 14px; font-size: 15px; }
    .seg button { min-height: 46px; font-size: 15px; }
    .seg.yn { justify-self: stretch; }
    .seg.yn button { min-height: 40px; }
    .radio button, .chk { font-size: 15px; padding: 13px 14px; }
    .fld input[type=text], .fld input[type=email], .fld input[type=tel], .fld input[type=number], .fld textarea, .fld select { font-size: 16px; height: 48px; }
    .fld textarea { height: auto; }
    .composer textarea { font-size: 16px; }
    .final .row2 .btn { flex: 1; justify-content: center; height: 48px; }
  }
  @media (max-width: 560px) {
    .fld.half { grid-column: span 6; }
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
    const S = { showErrors: false, id: o.permit?.id || null, token: o.permit?.token || null, kind: o.kind || 'construction', app: null, schema: null, msgs: [], busy: false, tab: 'chat', pending: {}, typed: {}, place: null, drawing: false, saveTimer: 0, savedAt: null, saving: false, reviewing: false, closed: false, poll: 0, signIn: null };
    const $ = (s) => root.querySelector(s);
    const link = () => `${o.origin}/${city}/#permit=${S.id}.${S.token}`;
    let STATUS = {};

    async function call(path, { method = 'GET', body, form } = {}) {
      const res = await fetch(`${api}/permits${path}`, {
        method, headers: { 'X-Permit-Token': S.token || '', ...(o.account?.token() ? { 'X-Resident-Token': o.account.token() } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
      say(a.prompt, { ask: a.id, choices: a.choices, upload: a.upload, hint: S.msgs.filter((m) => m.ask).length < 2 });
      keyboard(a);
    }

    // The phone keyboard that fits the answer: number pad for amounts, phone pad for phone numbers.
    function keyboard(a) {
      const input = $('#pInput'); if (!input) return;
      if (a?.input) input.setAttribute('inputmode', a.input); else input.removeAttribute('inputmode');
      input.placeholder = a?.choices && !a.input ? 'Tap an answer, or ask a question…' : 'Answer, or ask a question…';
    }

    /* ---------------- Layout ---------------- */

    function frame() {
      root.classList.add('permit');
      document.documentElement.style.overflow = 'hidden';
      const panel = root.querySelector('.panel');
      panel.innerHTML = `
        <header class="head">
          <div class="avatar">${icon(S.schema?.icon || 'file', 20)}</div>
          <div style="min-width:0;flex:1"><h2 id="pTitle">${esc(S.schema?.title || 'Application')}</h2><p class="sub2" id="pSub"></p></div>
          <div class="tools" style="gap:6px">
            <button class="tbtn" id="pLater" title="Save it and finish later">${icon('send', 15)}<span class="lbl">Finish later</span></button>
            <button class="tbtn" id="pPdf" title="Download a printable copy">${icon('file', 15)}<span class="lbl">Print</span></button>
            <button class="icon-btn" id="pMin" aria-label="Back to the chat" title="Back to the chat">${icon('x')}</button>
          </div>
        </header>
        <div class="hbar"><i id="pBar" style="width:0"></i></div>
        <div class="ws" id="ws" data-tab="${S.tab}">
          <div class="ws-tabs"><div role="tablist"><button data-tab="chat" role="tab">${icon('chat', 15)} Assistant</button><button data-tab="form" role="tab">${icon('file', 15)} Application <span class="pct" id="pPct"></span></button></div></div>
          <aside class="ws-rail" id="pRail" aria-label="Sections"></aside>
          <section class="ws-sheet" id="pSheetWrap"><div class="sheet" id="pSheet"><div style="padding:40px;text-align:center;color:var(--muted)"><span class="spin"></span></div></div></section>
          <section class="ws-chat">
            <div class="chat-h"><span class="spark">${icon('chat', 17)}</span><div><b>Assistant</b><small>Fills in the form as you answer. Ask what anything means.</small></div></div>
            <div class="log" id="pLog" aria-live="polite"></div>
            <form class="composer" id="pForm">
              <textarea id="pInput" rows="1" placeholder="Answer, or ask a question…" aria-label="Your answer or question" enterkeyhint="send"></textarea>
              <button class="send" type="submit" aria-label="Send">${icon('send')}</button>
            </form>
            <div class="foot"><span>Answers save automatically</span><span>Emergency? Call <a href="tel:911">911</a></span></div>
          </section>
          <div class="ws-dock" id="pDock"></div>
        </div>`;
      $('#pMin').onclick = close;
      $('#pPdf').onclick = openPdf;
      $('#pLater').onclick = finishLater;
      root.querySelectorAll('.ws-tabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
      $('#pRail').addEventListener('click', onSheetClick);
      $('#pDock').addEventListener('click', (e) => { if (e.target.closest('[data-tab]')) setTab('chat'); else onSheetClick(e); });
      let spying = 0;
      $('#pSheetWrap').addEventListener('scroll', () => { cancelAnimationFrame(spying); spying = requestAnimationFrame(spy); }, { passive: true });
      const input = $('#pInput');
      input.addEventListener('input', () => {
        input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`;
        // While the chat is asking for the property address, suggest addresses as they type.
        if (S.app?.editable && S.app.ask?.fields?.includes(S.schema.addressField)) addrSuggest(input, (text, place) => { input.value = ''; input.style.height = ''; me(text); send({ text, place }, true); });
        else if (A.input === input) addrClose();
      });
      input.addEventListener('keydown', (e) => {
        if (A.input === input && addrKey(e)) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#pForm').requestSubmit(); }
      });
      input.addEventListener('blur', () => { if (A.input === input) addrClose(); });
      $('#pForm').onsubmit = (e) => { e.preventDefault(); addrClose(); const v = input.value.trim(); if (!v || S.busy) return; input.value = ''; input.style.height = ''; send({ text: v }); };
      $('#pLog').addEventListener('click', onChatClick);
      const sheet = $('#pSheet');
      sheet.addEventListener('input', onFieldInput);
      sheet.addEventListener('change', onFieldChange);
      sheet.addEventListener('click', onSheetClick);
      sheet.addEventListener('keydown', (e) => {
        if (!e.target.dataset?.addr) return;
        if (A.input === e.target && addrKey(e)) return;
        if (e.key === 'Enter') { e.preventDefault(); addrClose(); addrCommit(e.target); }
      });
      sheet.addEventListener('focusout', (e) => {
        if (S.drawing || !e.target.dataset?.key) return;
        if (e.target.dataset.addr) { addrClose(); addrCommit(e.target); return; }
        flush();
      });
      setTab(S.tab);
    }

    function drawTitle() {
      const t = $('#pTitle'); if (t) t.textContent = innerWidth <= 900 ? S.schema.short : S.schema.title;
      const av = root.querySelector('.head .avatar'); if (av) av.innerHTML = icon(S.schema.icon || 'file', 20);
    }

    function setTab(t) {
      S.tab = t;
      $('#ws').dataset.tab = t;
      root.querySelectorAll('.ws-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    }

    const PILL = { draft: '', needs_info: 'warn', fees_due: 'warn', issued: 'ok', closed: 'ok', denied: 'bad', withdrawn: '' };
    const statusPill = (st) => `<span class="pill ${PILL[st] ?? 'live'}">${esc((STATUS[st] || [st])[0])}</span>`;

    function drawHead() {
      const a = S.app; if (!a) return;
      $('#pSub').innerHTML = `${statusPill(a.status)}${a.ref ? `<b>${esc(a.ref)}</b>` : ''}${a.editable && (S.saving || S.savedAt) ? `<span class="saved" id="pSaved">${S.saving ? 'Saving…' : `${icon('check', 12)} Saved`}</span>` : ''}`;
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
          ${m.suggest && i >= last - 1 ? `<div class="opts"><button class="opt" data-switch="${esc(m.suggest.kind)}">${icon('file', 14)} Start a ${esc(m.suggest.title.toLowerCase())}</button></div>` : ''}
          ${m.hint && live ? '<div class="askhint">Not sure what to put? Ask me, like "what does this mean?"</div>' : ''}
        </div>`;
      }).join('');
      log.scrollTop = log.scrollHeight;
    }

    function onChatClick(e) {
      const c = e.target.closest('[data-choice]');
      if (c && !c.disabled) { me(c.textContent.trim()); send({ choice: c.dataset.choice, ask: c.dataset.ask }, true); return; }
      const u = e.target.closest('[data-upload]');
      if (u) { pickFile(u.dataset.upload); return; }
      const sw = e.target.closest('[data-switch]');
      if (sw) { close(); o.openForm?.(sw.dataset.switch); return; }
      const act = e.target.closest('[data-pact]');
      if (act) sheetAction(act.dataset.pact, act);
    }

    // "What does this mean?" from the form: the assistant answers in the chat, from the field's explanation and city documents.
    function askAbout(key) {
      const f = S.schema.sections.flatMap((x) => x.fields).find((x) => x.key === key);
      if (!f || S.busy) return;
      setTab('chat');
      send({ text: `What does "${f.label.replace(/\?$/, '')}" mean, and what should I put?`, about: key });
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
        if (v.reply) say(v.reply, v.suggest ? { suggest: v.suggest } : {});
        if (v.screenNote) sayScreen(v.screenNote);
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
    const val = (k) => (k in S.typed ? S.typed[k] : k in S.pending ? S.pending[k] : S.app.data[k]);
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
          ? `<div class="seg ${f.options.length > 6 ? 'many' : ''}" role="radiogroup">${f.options.map(([o, l]) => `<button type="button" class="${v === o ? 'on' : ''} ${l.length > 14 ? 'wide' : ''}" data-set="${f.key}" data-v="${esc(o)}" ${dis}>${esc(l)}</button>`).join('')}</div>`
          : `<select id="${id}" data-key="${f.key}" ${dis}><option value="">Choose…</option>${f.options.map(([o, l]) => `<option value="${esc(o)}" ${v === o ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`; break;
        case 'radio': input = `<div class="radio">${f.options.map(([o, l]) => `<button type="button" class="${v === o ? 'on' : ''}" data-set="${f.key}" data-v="${esc(o)}" ${dis}><i></i><span>${esc(l)}</span></button>`).join('')}</div>`; break;
        case 'multi': input = `<div class="seg">${f.options.map(([o, l]) => `<button type="button" class="${(v || []).includes(o) ? 'on' : ''}" data-toggle="${f.key}" data-v="${esc(o)}" ${dis}>${esc(l)}</button>`).join('')}</div>`; break;
        case 'bool': input = `<div class="seg yn" role="radiogroup">${[[true, 'Yes'], [false, 'No']].map(([o, l]) => `<button type="button" class="${v === o ? 'on' : ''}" data-set="${f.key}" data-v="${o}" ${dis}>${l}</button>`).join('')}</div>`; break;
        case 'check': return `<div class="fld" data-f="${f.key}"><label class="chk"><input type="checkbox" data-key="${f.key}" ${v ? 'checked' : ''} ${dis}><span>${esc(f.label)}</span></label>${f.explain && S.app.editable ? `<button type="button" class="linkq" data-help="${f.key}">What does this mean?</button>` : ''}${issues.map(issueHtml).join('')}</div>`;
        case 'money': input = `<div class="money"><span>$</span><input id="${id}" type="text" inputmode="decimal" data-key="${f.key}" value="${v != null ? esc(Number(v).toLocaleString()) : ''}" ${dis}></div>`; break;
        case 'number': input = `<input id="${id}" type="number" inputmode="decimal" min="0" step="any" data-key="${f.key}" value="${v ?? ''}" ${dis}>`; break;
        case 'signature': input = `<div class="sig"><input id="${id}" type="text" data-key="${f.key}" value="${esc(v ?? '')}" placeholder="Your full name" autocomplete="name" ${dis}></div>${S.app.data.signed_at ? `<small>Signed electronically ${new Date(S.app.data.signed_at).toLocaleString()}</small>` : ''}`; break;
        case 'files': return filesHtml(f);
        case 'address': input = `<div class="addr"><input id="${id}" type="text" data-key="${f.key}" data-addr="1" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || 'Start typing the street address')}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" ${dis}></div>`; break;
        default: input = `<input id="${id}" type="${f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text'}" data-key="${f.key}" value="${esc(v ?? '')}" placeholder="${esc(f.placeholder || '')}" ${f.type === 'state' ? 'maxlength="2"' : ''} autocomplete="${{ email: 'email', phone: 'tel', zip: 'postal-code' }[f.type] || 'off'}" ${dis}>`;
      }
      const q = S.app.editable ? `<button type="button" class="qhelp" data-help="${f.key}" aria-label="What does ${esc(f.label)} mean?" title="What does this mean?">?</button>` : '';
      const labelTag = ['select', 'radio', 'multi', 'bool'].includes(f.type) ? `<div class="lbl">${esc(f.label)}${q}</div>` : `<div class="lbl"><label for="${id}">${esc(f.label)}</label>${q}</div>`;
      return `<div class="fld ${span}" data-f="${f.key}">${labelTag}${f.help ? `<div class="hint">${esc(f.help)}</div>` : ''}${input}${f.type === 'address' ? addrNote(v) : ''}${issues.map(issueHtml).join('')}</div>`;
    }

    // Under the address: what the map screen found, quietly, instead of chat messages.
    function addrNote(v) {
      const sc = S.app.screen;
      if (!v || !sc || S.app.data[S.schema.addressField] !== v) return '';
      if (sc.jurisdiction?.checked) return sc.jurisdiction.inCity ? `<small class="addr-ok">${icon('check', 12)} Found on the map, inside ${esc(o.cityName.replace(/^(City|Town|Village) of /i, ''))} city limits${sc.flood?.zone ? ` · flood zone ${esc(sc.flood.zone)}` : ''}</small>` : '';
      return '<small>We couldn\'t place this exact address on the map. That\'s fine: City Hall will confirm it. Picking a suggestion while you type helps.</small>';
    }

    function filesHtml(f) {
      const files = S.app.files || [];
      const issues = issuesFor(['files']);
      return `<div class="fld" data-f="files"><div class="lbl">Attachments</div>
        <div class="drop"><div class="files">${files.map((x) => `<div class="file"><span class="k">${esc(kindLabel(x.kind))}</span><a href="#" data-open-file="${esc(x.id)}">${esc(x.name)}</a>
          ${S.app.editable ? `<button data-del-file="${esc(x.id)}" aria-label="Remove ${esc(x.name)}">${icon('x', 14)}</button>` : ''}</div>`).join('') || `<small>No attachments yet.${f.help ? ` ${esc(f.help)}` : ''} A phone photo is fine.</small>`}</div>
        ${S.app.editable ? `<div class="uprow"><select id="pKind" data-nokey>${f.kinds.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select>
          <button class="btn" type="button" data-pact="upload">${icon('camera', 15)} Upload a PDF or photo</button></div>` : ''}</div>
        ${issues.map(issueHtml).join('')}</div>`;
    }

    const answered = (f) => {
      const x = f.type === 'files' ? S.app.files.length : val(f.key);
      return x != null && x !== '' && x !== false && x !== 0 && !(Array.isArray(x) && !x.length);
    };
    function sectionDone(sec) {
      const fields = sec.fields.filter(shown);
      const keys = fields.map((f) => f.key);
      const errs = (S.app.checks || []).filter((i) => i.level === 'error' && keys.includes(i.field));
      const filled = fields.some(answered);
      return { done: filled && !errs.length, err: errs.length > 0 && filled && (S.showErrors || S.app.status === 'needs_info'), n: fields.filter(answered).length, of: fields.length };
    }

    // The property and the fee: cards in the rail on a wide screen, one summary box in the application otherwise.
    function propertyHtml() {
      const a = S.app; const sc = a.screen; const addr = S.schema.addressField;
      if (!addr) return '';
      const badges = [];
      if (sc?.jurisdiction?.checked) badges.push(sc.jurisdiction.inCity ? `<span class="badge ok">${icon('check', 12)} Inside city limits</span>` : `<span class="badge bad">${icon('alert', 12)} Outside city limits?</span>`);
      if (sc?.flood?.checked && sc.flood.zone) badges.push(`<span class="badge ${sc.flood.sfha ? 'warn' : 'ok'}">Flood zone ${esc(sc.flood.zone)}</span>`);
      return `<div class="eyebrow">Property</div><div class="v">${esc(sc?.matchedAddress || a.data[addr] || 'Address not given yet')}</div>
        ${badges.length ? `<div class="badges">${badges.join('')}</div>` : ''}
        ${sc?.jurisdiction?.checked || sc?.flood?.checked ? '<small>Screened with U.S. Census and FEMA maps. City Hall makes the official determinations.</small>' : ''}`;
    }
    function feeHtml() {
      const a = S.app;
      const fee = a.fee_assessed != null ? { total: a.fee_assessed, assessed: true } : a.fee;
      const amount = fee && !fee.total && !fee.assessed ? 'No fee' : fee ? `$${Number(fee.total).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '';
      const note = fee?.assessed ? (a.fee_paid != null ? 'Paid' : 'Due') : fee ? `${a.fee.lines?.[1]?.label?.startsWith('Doubled') ? 'Doubled: work already started. ' : ''}From the published fee schedule. City Hall confirms it.` : 'Shown once the application has what the fee is based on.';
      return `<div class="eyebrow">${fee?.assessed ? 'Fee' : 'Estimated fee'}</div>${amount ? `<div class="big">${amount}</div>` : ''}<small>${esc(note)}</small>
        ${!fee?.assessed && a.fee?.notes?.length ? `<details class="more"><summary>Other fees that may apply</summary><ul>${a.fee.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}`;
    }
    function summaryHtml() {
      const prop = propertyHtml();
      return `<div class="sum-inline"><div class="summary" style="grid-template-columns:${prop ? 'minmax(0,1.4fr) minmax(0,1fr)' : '1fr'}">${prop ? `<div style="display:grid;gap:3px;align-content:start">${prop}</div>` : ''}<div style="display:grid;gap:3px;align-content:start">${feeHtml()}</div></div></div>`;
    }

    // The rail beside the application on a wide screen: overall progress, the sections, the property and the fee.
    function drawRail() {
      const el = $('#pRail'); if (!el) return;
      const a = S.app; const secs = S.schema.sections;
      const st = secs.map(sectionDone);
      const done = st.filter((x) => x.done).length;
      const pct = a.editable ? a.progress : 100;
      const prop = propertyHtml();
      el.innerHTML = `
        <div class="rail-prog"><div class="ring" style="--p:${pct}"><span>${pct}%</span></div>
          <div><b>${a.editable ? `${done} of ${secs.length} sections` : esc((STATUS[a.status] || [a.status])[0])}</b><small>${a.editable ? 'Answers save as you go' : a.ref ? esc(a.ref) : ''}</small></div></div>
        <nav class="rail-nav"><div class="eyebrow">Sections</div>
          ${secs.map((s, i) => `<button class="rn ${st[i].done ? 'done' : ''} ${st[i].err ? 'err' : ''}" data-jump="${s.id}"><b>${st[i].done ? icon('check', 13) : i + 1}</b><span>${esc(s.title)}</span><small>${st[i].n}/${st[i].of}</small></button>`).join('')}
          ${a.editable ? `<button class="rn" data-jump="final"><b>${icon('send', 12)}</b><span>${a.status === 'needs_info' ? 'Resubmit' : 'Check & submit'}</span><small></small></button>` : ''}
        </nav>
        ${prop ? `<div class="rail-card">${prop}</div>` : ''}
        <div class="rail-card">${feeHtml()}</div>
        <div class="rail-help">Questions? Ask the assistant${o.phone ? `, or call City Hall at <a href="tel:${esc(o.phone.replace(/[^\d+]/g, ''))}">${esc(o.phone)}</a>` : ''}.</div>`;
    }

    // On a phone, under the application: how far along it is and a way back to the chat.
    function drawDock() {
      const el = $('#pDock'); if (!el) return;
      const a = S.app;
      el.innerHTML = a.editable ? `<div class="dp"><span><b>${a.progress}%</b> complete</span><div class="mini"><i style="width:${a.progress}%"></i></div></div>
        <button class="btn primary" data-tab="chat">${icon('chat', 16)} Continue in chat</button>` : '';
    }

    // Highlights the section being read, in the rail and in the section chips.
    function spy() {
      const wrap = $('#pSheetWrap'); if (!wrap || !S.schema || !S.app) return;
      const top = wrap.getBoundingClientRect().top + 90;
      let cur = S.schema.sections[0]?.id;
      for (const s of S.schema.sections) { const n = $(`#sec-${s.id}`); if (n && n.getBoundingClientRect().top <= top) cur = s.id; }
      const fin = $('#sec-final');
      if (fin && (fin.getBoundingClientRect().top <= top || wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 8)) cur = 'final';
      root.querySelectorAll('.rn[data-jump], .step[data-jump]').forEach((b) => b.classList.toggle('on', b.dataset.jump === cur));
      const chip = $('.steps .step.on'); const bar = chip?.parentNode;
      if (chip && (chip.offsetLeft < bar.scrollLeft || chip.offsetLeft + chip.offsetWidth > bar.scrollLeft + bar.clientWidth)) bar.scrollTo({ left: chip.offsetLeft - 12, behavior: 'smooth' });
    }

    function statusHtml() {
      const a = S.app;
      if (a.status === 'draft') return '';
      const [label, sub] = STATUS[a.status] || [a.status, ''];
      const steps = S.schema.steps;
      const at = stepAt(steps, a.status);
      const iss = S.schema.issue;
      const corr = a.status === 'needs_info' && a.corrections;
      return `<div class="status-card">
        <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
          <div><div style="font-size:12px;color:var(--muted);font-weight:650">APPLICATION</div><div class="refno">${esc(a.ref || '')}</div></div>
          <div style="text-align:right"><b>${esc(label)}</b><div style="font-size:12.5px;color:var(--muted)">${esc(sub)}</div></div>
        </div>
        ${!['denied', 'withdrawn'].includes(a.status) ? `<div class="track">${steps.map(([, l], i) => `<div class="${i <= at ? 'on' : ''}"><i></i>${esc(l)}</div>`).join('')}</div>` : ''}
        ${corr ? `<div class="corr"><b>City Hall asked for these changes${corr.by ? ` (${esc(corr.by)})` : ''}:</b><ul>${(corr.items || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${corr.message ? `<div>${esc(corr.message)}</div>` : ''}<div>Update the application below, then tap <b>Resubmit</b>.</div></div>` : ''}
        ${a.status === 'fees_due' && a.payment ? `<div class="corr" style="background:#eef6f1;border-color:#cde6d8"><b>How to pay</b><div>${esc(a.payment)}</div></div>` : ''}
        ${['issued', 'closed'].includes(a.status) ? `<div class="row2" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" data-pact="permit-pdf">${icon('file', 15)} Download ${esc(iss.noun)} ${esc(a.permit_number || '')}</button></div>` : ''}
        ${iss.inspections && (a.status === 'issued' || (a.status === 'in_review' && iss.noun === 'certificate')) ? `<div class="issues-box"><h3>Request an inspection</h3>
          <div class="uprow"><select id="pInsType">${iss.inspections.map((x) => `<option>${esc(x)}</option>`).join('')}</select><input type="text" id="pInsDate" placeholder="Preferred day" style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;width:150px">
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
      return `<div class="final" id="sec-final">
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
        <small style="color:var(--muted)">The AI check reads your answers and attachments the way City Hall staff would. It never approves anything; ${esc(S.schema.department)} staff review every application.</small>
      </div>`;
    }

    function drawSheet(flashKeys = []) {
      const el = $('#pSheet'); if (!el || !S.app) return;
      const active = shadow.activeElement;
      const key = active?.dataset?.key; let sel = null;
      try { sel = key ? [active.selectionStart, active.selectionEnd] : null; } catch { sel = null; }
      const secs = S.schema.sections;
      S.drawing = true;
      const st = secs.map(sectionDone);
      el.innerHTML = `
        <div class="page-h"><div class="eyebrow">${esc(o.cityName)} · ${esc(S.schema.department)}</div><h1>${esc(val('project_name') || S.schema.title)}</h1></div>
        ${S.app.editable ? '<div class="tip"><span class="qhelp">?</span><span>Answer in the chat or type here. Tap <b>?</b> next to any question to ask what it means.</span></div>' : ''}
        ${statusHtml()}
        ${summaryHtml()}
        ${S.app.editable ? `<nav class="steps">${secs.map((s, i) => `<button class="step ${st[i].done ? 'done' : ''} ${st[i].err ? 'err' : ''}" data-jump="${s.id}"><b>${st[i].done ? '✓' : i + 1}</b>${esc(s.title)}</button>`).join('')}</nav>` : ''}
        ${secs.map((s, i) => `<section class="sec ${st[i].done ? 'done' : ''}" id="sec-${s.id}"><div class="sec-h"><span class="n">${st[i].done ? icon('check', 14) : i + 1}</span><h2>${esc(s.title)}</h2><span class="cnt">${st[i].n} of ${st[i].of}</span></div><div class="grid">${s.fields.filter(shown).map(fieldHtml).join('')}</div></section>`).join('')}
        ${finalHtml()}`;
      drawRail(); drawDock();
      if (key) {
        const n = el.querySelector(`[data-key="${key}"]`);
        if (n) { n.focus({ preventScroll: true }); if (sel) try { n.setSelectionRange(...sel); } catch { /* not a text input */ } }
      }
      S.drawing = false;
      // Keep the address suggestions open across a redraw while the resident is still typing.
      if (A.el && A.input && !A.input.isConnected) {
        const n = el.querySelector('[data-addr]');
        if (n && shadow.activeElement === n) { A.input = n; addrDraw(); } else addrClose();
      }
      spy();
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
      const addr = !!S.schema.addressField && S.schema.addressField in sent;
      const place = addr ? S.place : null;
      if (addr) S.place = null;
      try {
        const v = await call(`/${S.id}`, { method: 'PATCH', body: { data: sent, ...(place ? { place } : {}) } });
        for (const k of keys) if (S.pending[k] === sent[k]) delete S.pending[k];
        const last = S.msgs[S.msgs.length - 1];
        setApp(v);
        if (addr && v.screenNote) {
          const moving = v.ask && last?.role === 'bot' && last.ask && last.ask !== v.ask.id;
          sayScreen(v.screenNote, !moving);
          if (moving) askMsg(v.ask);
        } else {
          // A new address the map couldn't place: the old "I found …" message no longer applies.
          if (addr && S.msgs.some((m) => m.screen)) { S.msgs = S.msgs.filter((m) => !m.screen); saveMsgs(); drawChat(); }
          if (v.ask) syncAsk(v.ask);
        }
      } catch (err) {
        say(`I couldn't save that: ${err.message}`);
      }
      S.saving = Object.keys(S.pending).length > 0; S.savedAt = Date.now(); drawHead();
    }

    // One map-screen message at a time: a corrected address replaces the earlier one instead of piling up.
    // beforeAsk: the address was changed in the form while the chat waits on another question, so the note goes
    // above that question and its answer buttons stay live.
    function sayScreen(text, beforeAsk = false) {
      S.msgs = S.msgs.filter((m) => !m.screen);
      const last = S.msgs[S.msgs.length - 1];
      if (beforeAsk && last?.role === 'bot' && last.ask) { S.msgs.splice(-1, 0, { role: 'bot', text, screen: true }); saveMsgs(); drawChat(); }
      else say(text, { screen: true });
    }

    // When a form edit answers the question the chat is waiting on, move the chat along too.
    function syncAsk(a) {
      const last = S.msgs[S.msgs.length - 1];
      if (last?.role === 'bot' && last.ask && last.ask !== a.id) { say('Thanks, I see that in the form.'); askMsg(a); }
    }

    /* ---------------- Address suggestions ---------------- */

    // Suggestions while the resident types the property address, in the form or in the chat, centered on City Hall.
    // A picked address is saved with its map location; typed text is saved when they leave the field, so a
    // half-typed address is never saved or screened.
    const A = { el: null, input: null, items: [], on: -1, seq: 0, timer: 0, session: null, onPick: null, note: null, provider: null };
    const newSession = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}${Math.random()}`.replace('.', ''));

    function addrSuggest(input, onPick) {
      A.input = input; A.onPick = onPick; A.note = null;
      clearTimeout(A.timer);
      const q = input.value.trim();
      if (q.length < 3) { addrClose(); return; }
      A.timer = setTimeout(async () => {
        const seq = ++A.seq;
        A.session ||= newSession();
        try {
          const res = await fetch(`${api}/permits/address?${new URLSearchParams({ q, session: A.session })}`);
          const d = await res.json();
          if (seq !== A.seq || A.input !== input) return;
          A.items = d.suggestions || []; A.on = -1; A.provider = d.provider;
          addrDraw();
        } catch { /* typing still works without suggestions */ }
      }, 180);
    }

    function addrDraw() {
      const input = A.input;
      const host = input?.isConnected && input.closest('.addr, .composer');
      if (!host) { addrClose(); return; }
      if (!A.el || A.el.parentNode !== host) {
        A.el?.remove();
        A.el = document.createElement('div'); A.el.className = 'addr-sug'; A.el.setAttribute('role', 'listbox');
        A.el.addEventListener('mousedown', (e) => e.preventDefault());
        A.el.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) addrPick(A.items[+b.dataset.i]); });
        host.appendChild(A.el);
      }
      const typedNumber = /^\s*\d/.test(input.value);
      const note = A.note || (!A.items.length
        ? (typedNumber ? 'Keep typing the street name. Or just finish the address and press Enter.' : 'Start with the house number, like 113 First St N.')
        : A.provider === 'google' ? 'Powered by Google' : "Don't see it? Finish typing it and press Enter.");
      A.el.innerHTML = `${A.items.map((s, i) => `<button type="button" role="option" data-i="${i}" class="${i === A.on ? 'on' : ''}" aria-selected="${i === A.on}">${icon('pin', 15)}<span>${esc(s.main)}<small>${esc(s.secondary || '')}${s.needsNumber ? ' · add the house number' : ''}${s.miles != null ? ` · ${s.miles} mi` : ''}</small></span></button>`).join('')}<div class="note">${esc(note)}</div>`;
      input.setAttribute('aria-expanded', 'true');
    }

    function addrClose() {
      clearTimeout(A.timer); A.seq++;
      A.el?.remove(); A.el = null; A.items = []; A.on = -1;
      A.input?.setAttribute?.('aria-expanded', 'false');
    }

    // Arrow keys, Enter and Escape in the suggestion list. Returns true when the key was used.
    function addrKey(e) {
      if (!A.el || !A.items.length) { if (e.key === 'Escape' && A.el) { addrClose(); return true; } return false; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        A.on = (A.on + (e.key === 'ArrowDown' ? 1 : -1) + A.items.length + 1) % (A.items.length + 1);
        if (A.on === A.items.length) A.on = -1;
        addrDraw(); return true;
      }
      if (e.key === 'Enter' && A.on >= 0) { e.preventDefault(); addrPick(A.items[A.on]); return true; }
      if (e.key === 'Escape') { addrClose(); return true; }
      return false;
    }

    function addrPick(s) {
      if (!s) return;
      const input = A.input;
      if (s.needsNumber) {
        // A street without a house number: put it in and let them add the number in front.
        input.value = s.text; input.focus(); input.setSelectionRange(0, 0);
        if (input.dataset.key) S.typed[input.dataset.key] = s.text;
        A.items = []; A.note = 'Now type the house number at the start.'; addrDraw();
        return;
      }
      const place = s.placeId ? { placeId: s.placeId, session: A.session } : s.lat != null ? { lat: s.lat, lon: s.lon } : null;
      A.session = null;
      const done = A.onPick;
      addrClose();
      done?.(s.text, place);
    }

    // Saves what's in the sheet's address field when the resident leaves it or presses Enter.
    function addrCommit(input) {
      const k = input.dataset.key;
      if (!(k in S.typed)) return;
      const v = input.value.trim();
      delete S.typed[k];
      if (v !== (S.app.data[k] || '')) { S.place = null; edit(k, v || null); }
      flush();
    }

    function onFieldInput(e) {
      const k = e.target.dataset.key; if (!k) return;
      if (e.target.type === 'checkbox') return;
      if (e.target.dataset.addr) {
        S.typed[k] = e.target.value;
        addrSuggest(e.target, (text, place) => { delete S.typed[k]; e.target.value = text; S.place = place; edit(k, text); flush(); });
        return;
      }
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
      const help = e.target.closest('[data-help]');
      if (help) { e.preventDefault(); askAbout(help.dataset.help); return; }
      const jump = e.target.closest('[data-jump]');
      if (jump) { setTab('form'); $(`#sec-${jump.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
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
      else if (a === 'sign-in') startSignIn();
      else if (a === 'resend' && S.signIn?.phone) { const ph = S.signIn.phone; S.signIn = { step: 'phone' }; signInStep(ph); }
      else if (a === 'copy-link') { navigator.clipboard?.writeText(link()); say('Link copied. Keep it private: anyone with it can open your application.'); if (S.app.ask) askMsg(S.app.ask); }
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
      say('Checking your application the way City Hall staff would: required answers, the numbers, and whether your documents match what you entered…');
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
        const next = S.schema.nextSteps || [];
        say(`**Submitted.** Your reference number is **${v.ref}**.${next.length ? `\n\nWhat happens next:\n${next.map((x) => `- ${x}`).join('\n')}` : ''}${S.schema.notary ? '\n\n**Next for you:** tap **Print**, sign the signature page in front of a notary, then bring it to City Hall or upload a photo of it here.' : ''}\n\nWe'll contact you by ${({ email: 'email', sms: 'text message', call: 'phone' })[v.data.contact_pref] || 'email'} at each step. You can also type **${v.ref}** in the chat any time to check the status.`);
        watch();
      } catch (err) {
        if (err.data?.checks) { setApp({ ...S.app, checks: err.data.checks }); say(`${err.message} They're marked in red in the form.`); } else say(err.message);
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
            if (v.status === 'needs_info') say(`The automated completeness check found ${v.corrections?.items?.length || 'a few'} thing${v.corrections?.items?.length === 1 ? '' : 's'} to fix before staff review:\n${(v.corrections?.items || []).map((x) => `- ${x}`).join('\n')}\n\nYour answers are saved. Fix these in the form, then tap **Resubmit**.`);
          }
        } catch { /* try again */ }
      }, 4000);
    }

    async function finishLater() {
      await flush();
      if (innerWidth <= 900) setTab('chat');
      if (o.account?.signedIn()) {
        say(`Your answers are saved to your account (**${esc(o.account.profile().phone)}**). Open **My applications** in the chat on any phone or computer to pick up where you left off.`, {
          buttons: `<button class="opt" data-pact="copy-link">${icon('copy', 14)} Copy link</button>`,
        });
        return;
      }
      say('Your answers are saved on this device. To finish on any phone or computer, save it to your phone number: I\'ll text you a code, no password needed.', {
        buttons: `${o.account ? `<button class="opt" data-pact="sign-in">${icon('phone', 14)} Save with my phone number</button>` : ''}<button class="opt" data-pact="copy-link">${icon('copy', 14)} Copy link</button>`,
      });
    }

    // Sign in from inside the application: phone number, then the texted code, both typed in the chat.
    function startSignIn() {
      S.signIn = { step: 'phone' };
      say("What's your cell phone number?");
      keyboard({ input: 'tel' });
      $('#pInput').placeholder = 'Your cell number';
      $('#pInput')?.focus();
    }

    async function signInStep(v) {
      const st = S.signIn;
      if (/^(cancel|stop|never ?mind|no)$/i.test(v)) { S.signIn = null; say('No problem. Your answers are still saved on this device.'); keyboard(S.app.ask); return; }
      S.busy = true; S.msgs.push({ role: 'bot', pending: true }); drawChat();
      try {
        if (st.step === 'phone') {
          const r = await o.account.sendCode(v);
          S.signIn = { step: 'code', phone: v };
          S.msgs.pop();
          say(`I texted a 6-digit code to **${esc(r.phone)}**. Type it here.${r.devCode ? ` (Test mode, no texts are sent: your code is **${r.devCode}**.)` : ''}`, { buttons: `<button class="opt" data-pact="resend">Send a new code</button>` });
          keyboard({ input: 'numeric' }); $('#pInput').placeholder = '6-digit code';
        } else {
          const profile = await o.account.verify(st.phone, v);
          S.signIn = null;
          S.msgs.pop();
          const fresh = await call(`/${S.id}`);
          setApp(fresh);
          say(`You're signed in as **${esc(profile.phone)}**. This application is saved to your account. Find it any time under **My applications** in the chat.`);
          keyboard(S.app.ask);
          if (S.app.ask) askMsg(S.app.ask);
        }
      } catch (err) {
        S.msgs.pop();
        if (err.status === 503) { S.signIn = null; S.wantLink = true; say(`${err.message} Type your email and I'll send you a link instead, or copy it now.`, { buttons: `<button class="opt" data-pact="copy-link">${icon('copy', 14)} Copy link</button>` }); } else say(err.message);
      }
      S.busy = false; drawChat();
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
      list.unshift({ id: S.id, token: S.token, kind: S.kind, title: S.schema?.short || null, ref: S.app?.ref || null, status: S.app?.status || 'draft', progress: S.app?.progress || 0, address: S.app?.screen?.matchedAddress || (S.schema?.addressField && S.app?.data?.[S.schema.addressField]) || null, at: Date.now() });
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
      const loadSchema = async (kind) => {
        S.schema = await fetch(`${api}/permits/schema/${encodeURIComponent(kind)}`, { cache: 'no-cache' }).then((r) => r.json());
        STATUS = S.schema.statuses || {};
        S.kind = kind;
        drawTitle();
      };
      if (!S.id) {
        await loadSchema(S.kind);
        const prev = (local.get('list') || []).find((x) => x.status !== 'draft' && x.status !== 'withdrawn');
        const v = await call('', { method: 'POST', body: { kind: S.kind, opening: o.opening || '', convoId: o.convoId || null, copyFrom: prev ? { id: prev.id, token: prev.token } : null } });
        S.id = v.id; S.token = v.token;
        S.app = v; remember();
        drawHead(); drawSheet(v.changed || Object.keys(v.data));
        const wide = innerWidth > 900;
        say(`I'll help you fill out the **${S.schema.title.toLowerCase()}** for the ${o.cityName.replace(/^the /i, '')}.${S.schema.intro ? ` ${S.schema.intro}` : ''}\n\nI'll ask one thing at a time and fill in the city's form ${wide ? 'beside this chat' : 'on the Application tab'} as we go. If anything is confusing, just ask, like "what does this mean?" or "where do I find that?"${v.reused ? `\n\nI reused your contact details from **${esc(v.reused)}**. Change anything that's different.` : ''}${o.account?.signedIn() ? `\n\nYou're signed in, so this is saved to your account as you go.` : ''}\n\nNothing is sent to City Hall until you tap **Submit**.`);
        if (v.reply) say(v.reply);
        askMsg(v.ask);
      } else {
        const v = await call(`/${S.id}`);
        await loadSchema(v.kind || 'construction');
        S.app = v; remember();
        // Earlier versions posted a map note for every keystroke in the address; keep none of those.
        S.msgs = (local.get(`${S.id}:msgs`) || []).filter((m) => !/^I couldn't match that address on federal maps/.test(m.text || ''));
        drawHead(); drawSheet();
        if (!S.msgs.length || o.fresh) {
          if (v.status === 'draft') { say(`Welcome back to your **${S.schema.short.toLowerCase()}** application. It's **${v.progress}%** complete, and everything you entered is saved.`); askMsg(v.ask); }
          else if (v.status === 'needs_info') { say(`City Hall asked for a few changes to **${v.ref}**:\n${(v.corrections?.items || []).map((x) => `- ${x}`).join('\n')}\n\nYour answers are saved. Fix these in the form, then tap **Resubmit**.`); }
          else say(`Here's the latest on **${v.ref}**: ${STATUS[v.status]?.[0] || v.status}. ${STATUS[v.status]?.[1] || ''}.`);
        } else if (local.get(`${S.id}:seen`) && local.get(`${S.id}:seen`) !== v.status) {
          // City Hall acted since the last visit: say what changed before anything else.
          const [label, sub] = STATUS[v.status] || [v.status, ''];
          say(v.status === 'issued' ? `Good news: your ${esc(S.schema.short.toLowerCase())} was ${S.schema.issue.noun === 'approval' ? 'approved' : 'issued'} (**${v.permit_number}**). Download it on the Application tab.${S.schema.issue.post ? ' Print it and post it where it can be seen.' : ''}`
            : v.status === 'needs_info' ? `City Hall asked for a few changes to **${v.ref}**:\n${(v.corrections?.items || []).map((x) => `- ${x}`).join('\n')}\n\nFix these in the form, then tap **Resubmit**.`
              : v.status === 'fees_due' ? `**${v.ref}** is complete. The fee is **$${Number(v.fee_assessed).toFixed(2)}**. ${v.payment || ''}`
                : `Update on **${v.ref}**: ${label}. ${sub}.`);
        } else drawChat();
      }
    } catch (err) {
      say(`Sorry, the application couldn't load (${err.message}). Please try again, or call City Hall${o.phone ? ` at ${o.phone}` : ''}.`);
    }

    // Typed email or phone after "finish later" goes to the link, not the application.
    const form = $('#pForm');
    const submitHandler = form.onsubmit;
    form.onsubmit = (e) => {
      e.preventDefault();
      const input = $('#pInput'); const v = input.value.trim();
      if (S.signIn && v && !S.busy) { input.value = ''; me(S.signIn.step === 'code' ? '••••••' : v); signInStep(v); return; }
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
