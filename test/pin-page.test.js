'use strict';
// Guards on the page side of ChartBridge 0.3.2's PIN (live/pin.js, live/live.js): the unlock lives in memory only,
// only the standalone page uses it, and ChartLive.mount (The Desk) never shows or needs the PIN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const pin = read('live/pin.js'), live = read('live/live.js');
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');

test('pin.js keeps the unlock in memory only: no storage, cookies or URL bar', () => {
  const c = code(pin);
  for (const re of [/localStorage/, /sessionStorage/, /document\.cookie/, /indexedDB/, /history\.(push|replace)State/, /location\.(href|hash|search)\s*=/, /console\./])
    assert.ok(!re.test(c), 'pin.js must not use ' + re);
  assert.match(c, /let token = null;/);
  // the token only leaves in the unlock header and the WebSocket URL, both to ChartBridge itself
  assert.match(c, /headers\[HEADER\] = token/);
  assert.match(c, /'unlock=' \+ encodeURIComponent\(token\)/);
  assert.match(c, /credentials: 'same-origin'/);
});

test('pin.js asks for the PIN again only when ChartBridge says the unlock is gone, never because it does not answer', () => {
  const ws = code(pin).slice(code(pin).indexOf('function wsUrl('), code(pin).indexOf('const headers = () =>'));
  assert.match(ws, /if \(s === 'none' \|\| s === 'set'\) relock\(/);
  // review B1: while the pad is back, the page keeps its token and asks again every 2 s, closing the pad by itself
  const relock = code(pin).slice(code(pin).indexOf('function relock('), code(pin).indexOf('function wsUrl('));
  assert.ok(!/token = null/.test(relock), 'relock keeps the token');
  assert.match(relock, /setInterval\([\s\S]*r\.body\.unlocked\) \{ close\(\); finish\(\); \}[\s\S]*\}, 2000\);/);
  // review S2/M5: any answer but 200 and 404 is an 'error', which keeps the unlock
  assert.match(code(pin), /if \(r\.status !== 200\) return 'error';/);
  assert.match(ws, /else \{[^}]*\n?[\s\S]*resolve\(withUnlock\(\)\);\s*\}/);
  assert.ok(!/8765/.test(code(pin)), 'no hard-coded port (review N2)');
  assert.match(ws, /\}, \(\) => resolve\(withUnlock\(\)\)\);/, 'a failed status call (ChartBridge restarting) keeps the unlock');
  // a wrong PIN: a message, nothing counted
  assert.ok(!/attempt|tries|lockout|wrongCount/i.test(code(pin)), 'no attempt counting in the page either');
});

test('live.js: only the standalone page uses the PIN; ChartLive.mount never does', () => {
  assert.match(live, /const PIN = PAGE \? window\.ChartBridgePin \|\| null : null;/);
  assert.match(live, /const WS_URL = opt\.wsUrl \|\| \(PIN \? \(\) => PIN\.wsUrl\(pageWsUrl\(\)\) : pageWsUrl\(\)\);/);
  // 1.12.0: the sign-in is TradeCore's (live/trade.js), created only on the page (TRADING), with the page's PIN
  assert.match(read('live/trade.js'), /env\.fetch\('\/session', \{ cache: 'no-store', headers: PIN \? PIN\.headers\(\) : \{\} \}\)/);
  assert.match(live, /const T = !TRADING \? null : TC\.create\(\{\n\s+LP, prefs, pin: PIN,/);
  assert.match(live, /function mount\(container, options\) \{ return start\(container, options \|\| \{\}, false\); \}/);
  assert.match(live, /if \(window\.ChartBridgePin\) window\.ChartBridgePin\.gate\(\)\.then\(boot\); else boot\(\);/, 'the page starts only after the unlock');
  assert.match(live, /const boot = \(\) => \{ if \(!window\.TradeCore\) \{[^\n]*return; \} start\(document\.body, \{\}, true\); \};/, 'and with its order logic (trade.js, fetched when an older single.html did not load it)');
  assert.equal((live.match(/ChartBridgePin/g) || []).length, 3, 'ChartBridgePin used only in the page boot and the PAGE line');
  // the host page and EMBED.md never load pin.js
  assert.ok(!/pin\.js/.test(read('test/embed-host.html')));
  const vendor = read('live/EMBED.md').split('## Mount')[0];
  assert.ok(!/pin\.js|pin\.css/.test(vendor), 'EMBED.md: pin.js and pin.css are not files to vendor');
  // the single chart page and the workspace load pin.js before live.js
  for (const f of ['live/single.html', 'live/index.html']) {
    const html = read(f);
    assert.ok(html.indexOf('src="pin.js"') > 0 && html.indexOf('src="pin.js"') < html.indexOf('src="live.js"'), f);
  }
});
