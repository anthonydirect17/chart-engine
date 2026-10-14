// The feed delay split (chart 1.24.0, build list #77): ChartBridge 0.5.6's check of this PC's clock against a time server
// (pcClock) splits the feed delay into the clock's part and the real one; the warnings follow the real delay only; with no
// check (an older ChartBridge, or no answer) the feed shows as before. The pure parts in live/live.js (LivePrefs), and how
// the workspace and the chart's own status line use them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LivePrefs: LP } = require('../live/live.js');

const ahead = ms => ({ checked: true, offsetMs: -ms, rttMs: 38.2, atUtcMs: 1791993600000, server: 'time.windows.com' });   // the PC clock ms ahead
const none = { checked: false, why: 'no answer from time.windows.com (no answer within 2 s: offline, or UDP port 123 blocked)', server: 'time.windows.com' };

test('the split: 2026-10-12, the laptop 2310 ms ahead: "feed 2435 ms = clock +2310 ms, real 125 ms"', () => {
  assert.equal(LP.feedText(2435, ahead(2310)), '2435 ms = clock +2310 ms, real 125 ms');
  assert.deepEqual(LP.feedSplit(2435, ahead(2310)), { feed: 2435, clock: 2310, real: 125 });
  // the sign: offsetMs is the server minus the PC, so a PC ahead has a negative offset and real = feed + offsetMs
  assert.equal(LP.feedSplit(2435, { checked: true, offsetMs: -2310 }).real, 2435 + -2310);
  // a PC clock behind: the raw feed reads short (even below 0) and the clock's part is negative
  assert.equal(LP.feedText(-300, ahead(-420)), '-300 ms = clock -420 ms, real 120 ms');
  assert.equal(LP.feedText(122, ahead(-3)), '122 ms = clock -3 ms, real 125 ms');
  assert.equal(LP.feedText(125, ahead(0)), '125 ms = clock 0 ms, real 125 ms');
  // each part rounded first, so the three numbers always add up
  for (const [f, a] of [[2435.4, 2309.6], [99.5, 0.4], [10.49, -0.51], [1500.5, 1499.5]]) {
    const s = LP.feedSplit(f, ahead(a));
    assert.equal(s.feed, s.clock + s.real, f + ' ' + a);
    assert.equal(s.feed, Math.round(f));
  }
});

test('the warnings: amber from 1 s and red from 3 s of REAL delay only, and only with the clock checked', () => {
  assert.equal(LP.REAL_WARN_MS, 1000); assert.equal(LP.REAL_BAD_MS, 3000); assert.equal(LP.CLOCK_WARN_MS, 500);
  assert.equal(LP.feedLevel(2435, ahead(2310)), '', 'a late number that is the clock\'s: no colour');
  assert.equal(LP.feedLevel(5200, ahead(4900)), '', 'even 5 s, when the clock explains it');
  assert.equal(LP.feedLevel(1150, ahead(30)), 'warn', 'ship Wi-Fi: 1.1 s real is amber');
  assert.equal(LP.feedLevel(3400, ahead(-200)), 'bad', 'PC behind and 3.6 s real: red');
  assert.equal(LP.feedLevel(999, ahead(0)), '');
  assert.equal(LP.feedLevel(1000, ahead(0)), 'warn');
  assert.equal(LP.feedLevel(3000, ahead(0)), 'bad');
  assert.equal(LP.feedLevel(5000, null), '', 'no clock check (before ChartBridge 0.5.6): as before, no colour');
  assert.equal(LP.feedLevel(5000, none), '', 'no answer: no colour (the number may be the clock\'s)');
  assert.equal(LP.feedLevel(null, ahead(10)), '');
});

test('"PC clock off by N s": from 0.5 s off, either way, seconds with one decimal', () => {
  assert.equal(LP.clockWarn(ahead(2310)), 'PC clock off by 2.3 s');
  assert.equal(LP.clockWarn(ahead(-2310)), 'PC clock off by 2.3 s');
  assert.equal(LP.clockWarn(ahead(500)), 'PC clock off by 0.5 s');
  assert.equal(LP.clockWarn(ahead(499)), '');
  assert.equal(LP.clockWarn(ahead(12345)), 'PC clock off by 12.3 s');
  assert.equal(LP.clockWarn(none), '');
  assert.equal(LP.clockWarn(null), '');
  assert.equal(LP.clockWarn(undefined), '');
});

test('no clock check: the feed exactly as before ("(PC clock behind)" below 0), and the tooltip says why when ChartBridge did', () => {
  for (const c of [null, undefined, none, { checked: false }, { junk: 1 }, 'x']) {
    assert.equal(LP.feedText(2435, c), '2435 ms');
    assert.equal(LP.feedText(-40, c), '-40 ms (PC clock behind)');
    assert.equal(LP.feedText(0.4, c), '<1 ms');
    assert.equal(LP.feedText(null, c), '-');
  }
  assert.equal(LP.fmtDelay(-40), '-40 ms (PC clock behind)');
  assert.equal(LP.clockNote(null), '', 'an older ChartBridge: nothing new in the tooltip');
  assert.equal(LP.clockNote(none), 'PC clock not checked: no answer from time.windows.com (no answer within 2 s: offline, or UDP port 123 blocked). The feed delay includes any error of this PC\'s clock.');
  assert.equal(LP.clockNote({ checked: false, why: 'not checked yet', server: 'time.windows.com' }).split('.')[0], 'PC clock not checked: not checked yet');
  // with an answer: what, by whom, when, and the rule
  const n = LP.clockNote(ahead(2310), ms => (ms === 1791993600000 ? '10:40:00 ET' : '?'));
  assert.equal(n, 'PC clock: 2310 ms ahead of time.windows.com (checked by ChartBridge at 10:40:00 ET, round trip 38 ms). Feed = clock + real delay; amber from 1 s of real delay, red from 3 s.\n' +
    'PC clock off by 2.3 s: Windows can fix it (Settings, Time and language, Date and time, Sync now).');
  assert.match(LP.clockNote(ahead(-40)), /^PC clock: 40 ms behind time\.windows\.com \(checked by ChartBridge, round trip 38 ms\)\./);
  assert.ok(!/\n/.test(LP.clockNote(ahead(-40))), 'under 0.5 s: no warning line');
});

test('pcClockOf keeps only what ChartBridge 0.5.6 sends', () => {
  assert.deepEqual(LP.pcClockOf({ type: 'pcClock', checked: true, offsetMs: -2310.4, rttMs: 38.2, atUtcMs: 1, server: 'time.windows.com', extra: 1 }),
    { checked: true, offsetMs: -2310.4, rttMs: 38.2, atUtcMs: 1, server: 'time.windows.com' });
  assert.equal(LP.pcClockOf({ checked: true }), null, 'checked with no offset is nothing');
  assert.equal(LP.pcClockOf({ checked: true, offsetMs: NaN }), null);
  assert.equal(LP.pcClockOf({ checked: true, offsetMs: '5' }), null);
  assert.deepEqual(LP.pcClockOf({ checked: false, why: 'x'.repeat(500), server: null }), { checked: false, why: 'x'.repeat(200), server: '' });
  assert.equal(LP.pcClockOf(null), null);
  assert.equal(LP.pcClockOf(undefined), null);
});

test('the workspace and the chart\'s status line use it; no em or en dash in what they show', () => {
  const ws = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  assert.match(ws, /case 'hello':[^\n]*\n[^\n]*\n\s*pcClock = pcClockOf\(m\.pcClock\);/);
  assert.match(ws, /case 'pcClock': pcClock = pcClockOf\(m\); syncStats\(\); return;/);
  assert.match(ws, /const ft = feedText\(feed, pcClock\)/);
  assert.match(ws, /const lvl = feedLevel\(feed, pcClock\);/);
  // the fallbacks: a live.js older than workspace.js keeps the line as before
  assert.match(ws, /const feedText = LP\.feedText \|\| \(\(f\) => fmtDelay\(f\)\)/);
  const live = fs.readFileSync(path.join(__dirname, '..', 'live', 'live.js'), 'utf8');
  assert.match(live, /\$\('dFeed'\)\.textContent = LP\.feedText\(f, pcClock\);/);
  assert.match(live, /case 'pcClock': pcClock = LP\.pcClockOf\(m\); break;/);
  for (const t of [LP.feedText(2435, ahead(2310)), LP.clockWarn(ahead(2310)), LP.clockNote(ahead(2310)), LP.clockNote(none)]) assert.ok(!/[\u2013\u2014]/.test(t), t);
  // the colours are the house's warn and sell, set by class
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.css'), 'utf8'), /\.ws-stat b\.warn \{ color: var\(--ws-warn\); \}\s*\.ws-stat b\.bad \{ color: var\(--ws-sell\); \}/);
});
