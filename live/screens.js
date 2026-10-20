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
  return { KEY, CHANNEL, clean, place, onScreen, features, screenNo, url };
}));
