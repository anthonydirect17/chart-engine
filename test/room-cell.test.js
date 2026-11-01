'use strict';
// Chart 1.40.0 (Anthony 2026-10-29, from a screenshot): the Accounts tab's Room cell shows both limits on one line, "DD $1,800 · D $647",
// the drawdown room first, the tighter in amber; the bar shows the drawdown room. Made-up numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AC = require('../live/accounts.js');

test('1.40.0: both limits on one line, the drawdown room first, the tighter marked; the bar is the drawdown room', () => {
  const s = AC.limitState({ roomFloor: 1800.4, roomDaily: 647.2, src: {} }, null, { drawdown: 2000, dailyLoss: 1000 });
  const r = AC.roomParts(s);
  assert.equal(r.text, 'DD $1,800 · D $647');
  assert.deepEqual(r.parts.map(p => [p.k, p.tight]), [['dd', false], ['d', true]], 'the daily room is the tighter');
  assert.equal(r.bar, '1', 'the bar: the drawdown room ($200 of $2,000 used: 10%)');
  const r2 = AC.roomParts(AC.limitState({ roomFloor: 300, roomDaily: 900, src: {} }, null, { drawdown: 2000, dailyLoss: 1000 }));
  assert.deepEqual(r2.parts.map(p => [p.k, p.tight]), [['dd', true], ['d', false]]);
  assert.equal(r2.bar, '9');
});

test('1.40.0: one limit alone; none is "-"; a limit with no room known says its limit', () => {
  assert.equal(AC.roomParts(AC.limitState({ roomFloor: 1000, src: {} }, null, null)).text, 'DD $1,000');
  const d = AC.roomParts(AC.limitState({ roomDaily: 1200, src: {} }, null, null));
  assert.equal(d.text, 'D $1,200'); assert.equal(d.parts[0].tight, false, 'one limit: nothing to compare'); assert.equal(d.bar, 'n', 'no drawdown: an empty bar');
  assert.equal(AC.roomParts(AC.limitState({}, null, null)).text, '-');
  assert.equal(AC.roomParts(null).text, '-');
  assert.equal(AC.roomParts(AC.limitState({ pnlToday: 0 }, { trailing_drawdown: 15000 }, null)).text, 'DD limit $15,000');
  assert.equal(AC.roomParts(AC.limitState({ roomFloor: -40, roomDaily: 500, src: {} }, null, { drawdown: 2000 })).text, 'DD -$40 · D $500');
});

test('1.40.0: the cell keeps the hover that names each figure\'s source on every part', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'live', 'accounts.js'), 'utf8');
  assert.match(src, /ci\(p\.text, 'apg-rpart' \+ \(p\.tight \? ' apg-tight' : ''\), roomTip\)/);
  assert.match(src, /ci\('', 'apg-bar apg-b' \+ rp\.bar \+ lvl, roomTip\)/);
});
