/*
 * "Update ready: reload when flat" (the per-PC updater, nt8/update-pc.ps1). Only ChartBridge's own page loads this
 * (live/index.html); a mounted chart (The Desk) does not.
 *
 * The updater writes update.json next to the page files. This page reads it when it opens and then about once a
 * minute (no cache) and compares:
 *   - the page build it started with, and when the files were installed: a newer build, or an install finished after
 *     this page began loading (on any read), means new page files are on disk. While update.json says 'installing'
 *     the page says "Page files are being updated: do not reload yet" and takes no build from it; 'installing' for
 *     over two minutes, or 'interrupted', means the install was cut off: "Page update cut off", never "reload". The page keeps running the code it loaded, so an open trade is never disturbed; it only
 *     says "Update ready: reload when flat".
 *   - ChartBridge: "ChartBridge x.y.z ready to install (flat, then F5)" when the updater has staged a newer one, and
 *     "ChartBridge x.y.z copied: press F5 when flat" once Anthony has copied it and not compiled it yet.
 * It never reloads the page, never opens anything, and sits on the status line at the bottom: it never covers the
 * order bar, the chart or anything of the live trade, and never moves them (it takes no room of its own on the line;
 * a smoke sweeps 700 to 1920 px). Nothing is sent anywhere. When an install was cut off and could not be finished,
 * it says so ("Page update cut off: run update-pc.ps1 status").
 */
(function () {
  'use strict';
  const POLL_MS = 60000, SLOW_MS = 600000;       // once a minute; every 10 minutes while there is no update.json
  const STUCK_MS = 120000;                        // an install takes seconds; "installing" for 2 minutes means cut off
  const started = (performance && performance.timeOrigin) || Date.now();
  let base = null, timer = 0, el = null, pageNew = false, shown = { text: '', forms: [''], tip: '' };

  function style() {
    if (document.getElementById('updNoticeStyle')) return;
    const s = document.createElement('style');
    s.id = 'updNoticeStyle';
    // flex-basis 0 and a margin that cancels the status line's 16 px column gap: the notice's outer size is 0, so it
    // never wraps the line, never pushes the chart up and never moves the order bar; it only fills room that is left
    // (text-indent puts the gap back inside it). A long text ends in "...", and a shorter form is picked when it fits.
    s.textContent = '.chart-live .status .upd-note { flex: 1 1 0; min-width: 0; margin-left: -16px; text-indent: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--info); font-family: var(--sans); }' +
      '.chart-live .status .upd-note .upd-vis::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 6px; vertical-align: 1px; }' +
      '.chart-live .status .upd-note .upd-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }';
    document.head.appendChild(s);
  }

  /* The notice lives on the status line (the footer), before its read-only / trading note. */
  function spot() {
    if (el && el.isConnected) return el;
    const footer = document.querySelector('.chart-live footer.status');
    if (!footer) return null;
    style();
    el = document.createElement('span');
    el.className = 'upd-note';
    el.id = 'updNote';
    el.hidden = true;
    // what a screen reader says: the whole text, changed only when it changes (the visible form is refitted, unread)
    el.innerHTML = '<span class="upd-vis" aria-hidden="true"></span><span class="upd-sr" role="status"></span>';
    footer.insertBefore(el, footer.querySelector('.ro'));
    return el;
  }

  function messages(u) {
    const parts = [], tips = [];
    const page = u && u.page, cb = (u && u.chartBridge) || {};
    const st = (page && page.state) || '';
    // 'installing' for over two minutes is not an install running now: the run was cut off (a power loss or a lid)
    const cut = st === 'interrupted' || (st === 'installing' && Date.now() - (+page.installedAt || 0) > STUCK_MS);
    if (cut) {
      parts.push(['Page update cut off: run update-pc.ps1 status', 'Page update cut off']);
      tips.push('An install of new page files was cut off. Do not reload. When flat, run nt8\\update-pc.ps1 status (and repair if it says so).');
    } else if (st === 'installing') {
      // files are being replaced right now: not ready, and never the build this page started from
      parts.push(['Page files are being updated: do not reload yet', 'Updating page files']);
      tips.push('New page files are being written on this PC. This page keeps running what it loaded.');
    } else if (page && page.build) {
      // installed after this page began loading (on any read): what is running may be the old files, or a mix
      if (+page.installedAt > started) pageNew = true;
      if (base === null) base = page.build;
      else if (page.build !== base) pageNew = true;
    }
    if (pageNew && !cut && st !== 'installing') {   // never "reload" into a page that is being written or cut off
      parts.push(['Update ready: reload when flat', 'Update ready']);
      tips.push('New chart page files' + (page && page.version ? ' (' + page.version + ')' : '') + ' are installed on this PC. This page keeps running what it loaded; reload it when flat to use them.');
    }
    if (cb.copied) {
      parts.push(['ChartBridge ' + cb.copied + ' copied: press F5 when flat', 'ChartBridge ' + cb.copied + ': F5 when flat']);
      tips.push('NinjaTrader > New > NinjaScript Editor > F5 while flat, then check /diag shows ' + cb.copied + '.');
    } else if (cb.ready) {
      parts.push(['ChartBridge ' + cb.ready + ' ready to install (flat, then F5)', 'ChartBridge ' + cb.ready + ' ready']);
      tips.push('When flat: nt8\\update-pc.ps1 -InstallChartBridge, then F5 in the NinjaScript Editor. Nothing installs by itself.');
    }
    // the whole text first, then shorter forms, the page's part first: the one that fits the status line is shown
    const forms = [];
    for (let n = 0; n <= parts.length; n++) forms.push(parts.map((p, i) => p[i < n ? 1 : 0]).join(' · '));
    return { text: forms[0], forms, tip: tips.join('\n') };
  }

  function show(m) {
    shown = m;
    const node = spot();
    if (!node) return;
    const vis = node.firstChild, sr = node.lastChild;
    node.title = [m.text, m.tip].filter(Boolean).join('\n');
    node.hidden = !m.text;
    if (sr.textContent !== m.text) sr.textContent = m.text;
    // a narrow window: a shorter form when the whole text does not fit in the room the status line has left
    for (const f of m.forms || [m.text]) { if (vis.textContent !== f) vis.textContent = f; if (node.hidden || node.scrollWidth <= node.clientWidth + 1) break; }
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(check, ms); }

  function check() {
    return fetch('update.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(u => { schedule(POLL_MS); const m = messages(u); show(m); return m; },
        () => { schedule(base === null ? SLOW_MS : POLL_MS); return null; })   // keeps what it shows
      .catch(() => { schedule(POLL_MS); return null; });                     // polling never stops
  }

  // the footer appears once live.js has built the page (after the PIN): attach the notice then
  const attach = setInterval(() => { if (spot()) { clearInterval(attach); show(shown); } }, 1000);
  // the room on the status line changes (its messages, the window's width, the fonts): pick the form that fits again
  setInterval(() => { if (el && !el.hidden) show(shown); }, 2000);
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { if (el && !el.hidden) show(shown); });
    const watch = setInterval(() => { if (spot()) { clearInterval(watch); ro.observe(el); } }, 1000);
  }
  window.addEventListener('resize', () => { if (el && !el.hidden) show(shown); });
  window.ChartUpdateNotice = { checkNow: check };
  check();
})();
