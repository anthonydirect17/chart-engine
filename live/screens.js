/*
 * Screens: the workspace's windows put back on their screens (chart 1.34.0, Anthony 2026-10-20: "do I need to re-open and
 * arrange each screen as is every time I start up"; his pick: a button in The Desk).
 *
 * Save these screens: every workspace window open now (each answers on the BroadcastChannel "chartbridge-screens-v1" with
 * its layout and where it is) is kept in this browser as { layout, x, y, w, h } (screen pixels, the browser's own
 * multi-screen coordinates). Open my screens: the saved ones not open now, each opened at its place (the browser's window
 * placement on all screens, asked once), each unlocked by the PIN of the window that opened it (live/pin.js, openChild).
 * A saved window whose screen is not connected now opens on the opening window's screen, and the note says so.
 *
 *   clean(raw)                 -> { at, windows: [{ layout, x, y, w, h }] }   (a saved set as read; one per layout)
 *   place(win, screens)        -> { left, top, width, height } on the screen that holds the window's middle (kept inside
 *                                 it), or null when no screen does. screens: [{ left, top, width, height }] (available area)
 *   onScreen(screen, w, h)     -> { left, top, width, height } in the middle of that screen at that size (kept inside)
 *   features(p)                -> the window.open features: "popup,left=..,top=..,width=..,height=.."
 *   screenNo(win, screens)     -> 1, 2, 3 ... (the screens from left to right), or 0 when none holds it
 *   url(layout)                -> "?layout=<name>"
 *   check(info)                -> { ok, codes: [...], lines: [...] }: what stops the windows going to their screens, and exactly
 *                                 what Anthony must allow (1.35.0). info: { brave, screenX, screenY, outerW, outerH, innerW,
 *                                 innerH, screenW, screenH, availLeft, availTop, hasDetails, permission, popupsBlocked, screens
 *                                 (how many screens getScreenDetails lists when granted, else null) }
 *   spoofed(info)              -> true when Brave reports this window's place as made up (its Shields' fingerprinting
 *                                 protection: screenX/Y and availLeft/Top a few pixels from 0, the screen the size of the window)
 *
 * 1.35.0 (Anthony 2026-10-21, "all windows open on the main monitor" in Brave): Brave's Shields, with fingerprinting blocked
 * (its default on many sites), report window.screenX and screenY as a small random number (0 to 8), screen.availLeft and
 * availTop the same, the screen as the size of the window, screen.isExtended false, and place a window.open child relative to
 * those made-up numbers (brave-core pull 13737, the kBraveBlockScreenFingerprinting work). So Save these screens kept every
 * window at about 0, 0 (the main screen) and Open my screens put them all there. The page cannot see through it: it says so
 * and lists what to allow (Shields down, or fingerprinting allowed, for this page; Window management; Pop-ups), and refuses
 * to save made-up places.
 *
 * No DOM; it also loads in Node for test/screens.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Screens = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEY = 'live-screens-v1';
  const CHANNEL = 'chartbridge-screens-v1';
  const MIN_W = 320, MIN_H = 240;
  const int = v => (typeof v === 'number' && isFinite(v) ? Math.round(v) : null);

  function clean(raw) {
    const out = { at: raw && typeof raw.at === 'number' && isFinite(raw.at) ? raw.at : 0, windows: [] };
    const seen = new Set();
    for (const w of raw && Array.isArray(raw.windows) ? raw.windows : []) {
      if (!w || typeof w.layout !== 'string') continue;
      const layout = w.layout.trim().slice(0, 40);
      const x = int(w.x), y = int(w.y), ww = int(w.w), h = int(w.h);
      if (!layout || seen.has(layout) || x === null || y === null || ww === null || h === null || ww < MIN_W || h < MIN_H) continue;
      seen.add(layout);
      out.windows.push({ layout, x, y, w: ww, h });
    }
    return out;
  }
  const holds = (s, px, py) => px >= s.left && px < s.left + s.width && py >= s.top && py < s.top + s.height;
  function inside(s, left, top, width, height) {
    const w = Math.max(MIN_W, Math.min(width, s.width)), h = Math.max(MIN_H, Math.min(height, s.height));
    return { left: Math.max(s.left, Math.min(left, s.left + s.width - w)), top: Math.max(s.top, Math.min(top, s.top + s.height - h)), width: w, height: h };
  }
  function place(win, screens) {
    const s = (screens || []).find(x => x && holds(x, win.x + win.w / 2, win.y + win.h / 2));
    return s ? inside(s, win.x, win.y, win.w, win.h) : null;
  }
  const onScreen = (s, w, h) => inside(s, s.left + Math.round((s.width - Math.min(w, s.width)) / 2), s.top + Math.round((s.height - Math.min(h, s.height)) / 2), w, h);
  const features = p => 'popup,left=' + p.left + ',top=' + p.top + ',width=' + p.width + ',height=' + p.height;
  function screenNo(win, screens) {
    const list = (screens || []).filter(Boolean).slice().sort((a, b) => a.left - b.left || a.top - b.top);
    const i = list.findIndex(s => holds(s, win.x + win.w / 2, win.y + win.h / 2));
    return i + 1;
  }
  const url = layout => '?layout=' + encodeURIComponent(layout);

  const near = (v, most) => typeof v === 'number' && isFinite(v) && v >= 0 && v <= most;
  function spoofed(i) {
    if (!i || i.brave !== true) return false;   // only Brave does this (a headless or full-screen window looks alike, and is real)
    /* review 4: a real Brave window in F11 full screen at 0, 0 on the main monitor looks alike too; when window management is
       granted and the browser lists more than one screen, the screens are real (Shields would show one), so it is not made up */
    if (typeof i.screens === 'number' && i.screens > 1) return false;
    const R = 8;   // Brave's made-up offset is 0 to 8 px
    return near(i.screenX, R) && near(i.screenY, R) && near(i.availLeft, R) && near(i.availTop, R) &&
      near(i.screenW - i.innerW, R) && near(i.screenH - i.innerH, R) && near(i.outerH - i.innerH, R) && i.innerW > 0;
  }
  const BRAVE_STEPS = [
    'In Brave, on this page: click the Shields icon (the lion) at the right end of the address bar, then either turn Shields down for this site, or open Advanced controls and set Fingerprinting to "Allow all fingerprinting".',
    'Allow window management: click the icon at the left end of the address bar, Site settings, then Window management: Allow (brave://settings/content/windowManagement lists it).',
    'Allow pop-ups: the same Site settings, Pop-ups and redirects: Allow.',
    'Reload every trading window, put each on its screen, then Save these screens again (the places saved while Shields hid them are all near the main screen).',
  ];
  function check(i) {
    const codes = [], lines = [];
    const info = i || {};
    if (spoofed(info)) {
      codes.push('spoofed');
      lines.push('Brave\'s Shields are hiding where this window is (it reports ' + info.screenX + ', ' + info.screenY +
        ' and a screen the size of the window), so windows can only be saved and opened on the main screen.');
      lines.push(...BRAVE_STEPS);
    }
    if (!info.hasDetails) {
      codes.push('noDetails');
      lines.push('This browser does not offer window placement on other screens (getScreenDetails): use Chrome, Edge or Brave 100 or newer.');
    } else if (info.permission === 'denied') {
      codes.push('denied');
      lines.push('Window management is blocked for this page: click the icon at the left end of the address bar, Site settings, Window management: Allow, then reload.');
    } else if (info.permission === 'prompt' && !codes.includes('spoofed')) {
      codes.push('ask');
      lines.push('The first Open my screens asks to manage windows on all your displays: Allow it.');
    }
    if (info.popupsBlocked) { codes.push('popups'); lines.push('The browser blocked the extra windows: allow pop-ups for this page (Site settings, Pop-ups and redirects: Allow), then click Open my screens again.'); }
    return { ok: !codes.some(c => c !== 'ask'), codes, lines };
  }
  return { KEY, CHANNEL, clean, place, onScreen, features, screenNo, url, spoofed, check, BRAVE_STEPS };
}));
