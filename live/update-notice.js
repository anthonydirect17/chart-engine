/*
 * "Update ready: reload when flat" (the per-PC updater, nt8/update-pc.ps1). Only ChartBridge's own page loads this (the
 * workspace, live/index.html; the single chart page did too until chart 1.21.0); a chart mounted elsewhere does not.
 *
 * The updater writes update.json next to the page files. This page reads it when it opens and then about once a
 * minute (no cache) and compares:
 *   - the page build it started with, and when the files were installed: a newer build, or an install finished after
 *     this page began loading (on any read), means new page files are on disk. While update.json says 'installing'
 *     the page says "Page files are being updated: do not reload yet" and takes no build from it; 'installing' for
 *     over two minutes, or 'interrupted', means the install was cut off: "Page update cut off", never "reload". The page keeps running the code it loaded, so an open trade is never disturbed; it only
 *     says "Update ready: reload when flat".
 *   - ChartBridge: "ChartBridge x.y.z ready to install (flat, then F5)" when the updater has staged a newer one, and
 *     "ChartBridge x.y.z copied: press F5 when flat" once Anthony has copied it and not compiled it yet. 1.16.0: that note
 *     goes as soon as the ChartBridge this page is connected to (its hello version, told by the page's own connections
 *     through ChartUpdateNotice.bridge) is x.y.z or newer, not at the updater's next run. Display only.
 * It never reloads the page, never opens anything, and sits on the status line at the bottom: it never covers the
 * order bar, the chart or anything of the live trade, and never moves them (it takes no room of its own on the line;
 * a smoke sweeps 700 to 1920 px). Nothing is sent anywhere. When an install was cut off and could not be finished,
 * it says so ("Page update cut off: run update-pc.ps1 status"). Two stops come first and in the warning colour: "DO NOT
 * press F5: ChartBridge files are mixed" (an -InstallChartBridge that failed half way and could not put the old
 * files back) and "Updater stopped" (the scheduled task's copy failed its own check). Commands name the task's copy
 * of update-pc.ps1 (README: Keep this PC up to date).
 */
(function () {
  'use strict';
  /* ---------------- the pure part (unit tested in Node: test/update-notice.test.js) */
  /** [major, minor, patch] of version text ("0.3.8", "fake-0.3.4"), or null when it names none. */
  function versionOf(v) { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')); return m ? [+m[1], +m[2], +m[3]] : null; }
  /** Whether version text v is at least `want`; false when either names no version. */
  function atLeast(v, want) {
    const a = versionOf(v), b = versionOf(want);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  }
  /** Whether "ChartBridge `copied` copied: press F5" still applies, given the connected ChartBridge's hello version
      (`connected`, '' or null before a hello): it goes once the connected one is that version or newer. */
  function f5Pending(copied, connected) { return !!copied && !atLeast(connected, copied); }
  const core = { versionOf, atLeast, f5Pending };
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') { module.exports = core; return; }

  const POLL_MS = 60000, SLOW_MS = 600000;       // once a minute; every 10 minutes while there is no update.json
  const STUCK_MS = 120000;                        // an install takes seconds; "installing" for 2 minutes means cut off
  const started = (performance && performance.timeOrigin) || Date.now();
  let base = null, timer = 0, el = null, pageNew = false, shown = { text: '', forms: [''], tip: '' };
  let lastU = null, connected = '';                // the last update.json read; the connected ChartBridge's hello version

  function style() {
    if (document.getElementById('updNoticeStyle')) return;
    const s = document.createElement('style');
    s.id = 'updNoticeStyle';
    // in the page's own place for it (the workspace's top bar, data-update-host). A long text ends in "...", and a shorter
    // form is picked when it fits. (1.21.0: the single chart page's spot on its status line went with that page.)
    s.textContent = '[data-update-host] .upd-note { display: block; max-width: 100%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--info, #7FB2FF); }' +
      '[data-update-host] .upd-note .upd-vis::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 6px; vertical-align: 1px; }' +
      '[data-update-host] .upd-note.upd-stop { color: var(--warn, #E0B45A); font-weight: 600; }' +
      '[data-update-host] .upd-note .upd-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }';
    document.head.appendChild(s);
  }

  /* The notice lives in the page's own place for it: an element with data-update-host, the workspace's top bar. */
  function spot() {
    if (el && el.isConnected) return el;
    const host = document.querySelector('[data-update-host]');
    if (!host) return null;
    style();
    el = document.createElement('span');
    el.className = 'upd-note';
    el.id = 'updNote';
    el.hidden = true;
    // what a screen reader says: the whole text, changed only when it changes (the visible form is refitted, unread)
    el.innerHTML = '<span class="upd-vis" aria-hidden="true"></span><span class="upd-sr" role="status"></span>';
    host.appendChild(el);
    return el;
  }

  function messages(u) {
    const parts = [], tips = [];
    const page = u && u.page, cb = (u && u.chartBridge) || {};
    const st = (page && page.state) || '';
    // 'installing' for over two minutes is not an install running now: the run was cut off (a power loss or a lid)
    const cut = st === 'interrupted' || (st === 'installing' && Date.now() - (+page.installedAt || 0) > STUCK_MS);
    const cmd = 'update-pc.ps1 (the task\'s copy, README: Keep this PC up to date)';
    let stop = false;
    if (cb.mixed) {
      stop = true;
      parts.push(['DO NOT press F5: ChartBridge files are mixed. Run update-pc.ps1 status and report', 'DO NOT press F5: ChartBridge files mixed']);
      tips.push('Installing ChartBridge failed half way and the old files could not all be put back: AddOns holds new and old ChartBridge files. Do not press F5 and do not compile. Run ' + cmd + ' status and report what it says.');
    }
    if (u && u.updater && u.updater.stopped) {
      stop = true;
      parts.push(['Updater stopped: run update-pc.ps1 status', 'Updater stopped']);
      tips.push('The scheduled update did nothing: its copy of update-pc.ps1 failed its own check. Run ' + cmd + ' status; it says how to register again.');
    }
    if (cut) {
      parts.push(['Page update cut off: run update-pc.ps1 status', 'Page update cut off']);
      tips.push('An install of new page files was cut off. Do not reload. When flat, run ' + cmd + ' status (and repair if it says so).');
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
    if (cb.mixed) {
      // nothing about F5 or a ChartBridge to install while the files are mixed
    } else if (f5Pending(cb.copied, connected)) {
      parts.push(['ChartBridge ' + cb.copied + ' copied: press F5 when flat', 'ChartBridge ' + cb.copied + ': F5 when flat']);
      tips.push('NinjaTrader > New > NinjaScript Editor > F5 while flat, then check /diag shows ' + cb.copied + '.');
    } else if (cb.ready) {
      parts.push(['ChartBridge ' + cb.ready + ' ready to install (flat, then F5)', 'ChartBridge ' + cb.ready + ' ready']);
      tips.push('When flat: ' + cmd + ' -InstallChartBridge, then F5 in the NinjaScript Editor. Nothing installs by itself.');
    }
    // the whole text first, then shorter forms, the page's part first: the one that fits the status line is shown
    const forms = [];
    for (let n = 0; n <= parts.length; n++) forms.push(parts.map((p, i) => p[i < n ? 1 : 0]).join(' · '));
    return { text: forms[0], forms, tip: tips.join('\n'), stop };
  }

  function show(m) {
    shown = m;
    const node = spot();
    if (!node) return;
    const vis = node.firstChild, sr = node.lastChild;
    node.title = [m.text, m.tip].filter(Boolean).join('\n');
    node.hidden = !m.text;
    node.classList.toggle('upd-stop', !!m.stop);
    if (sr.textContent !== m.text) sr.textContent = m.text;
    // a narrow window: a shorter form when the whole text does not fit in the room the status line has left
    for (const f of m.forms || [m.text]) { if (vis.textContent !== f) vis.textContent = f; if (node.hidden || node.scrollWidth <= node.clientWidth + 1) break; }
  }

  function schedule(ms) { clearTimeout(timer); timer = setTimeout(check, ms); }

  function check() {
    return fetch('update.json', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then(u => { schedule(POLL_MS); lastU = u; const m = messages(u); show(m); return m; },
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
  /* A page's connection had ChartBridge's hello (live.js, the workspace): its version. The F5 note goes at once when it
     is the copied version or newer (and comes back if a later hello is older); nothing is fetched or sent. */
  function bridge(version) {
    const v = typeof version === 'string' ? version : '';
    if (v === connected) return;
    connected = v;
    if (lastU) { try { show(messages(lastU)); } catch (e) { /* the notice never breaks its caller's hello */ } }
  }
  window.ChartUpdateNotice = Object.assign({ checkNow: check, bridge }, core);
  check();
})();
