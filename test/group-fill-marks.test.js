'use strict';
// Chart 1.40.0 (Anthony 2026-10-30): with a group as the ticket's account, ONE fill mark per group fill (the members' fills of one side
// within 2 s), at the members' average price with the contracts summed; the hover lists each account's own fill. A single account's
// chart is unchanged. Made-up accounts and prices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OT = require('../live/order-ticket.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const F = (t, account, side, qty, price) => ({ t, account, side, qty, price, root: 'MNQ' });

test('1.40.0: a group fill is one mark at the members\' average, the contracts summed; each member\'s own fill kept for the hover', () => {
  const fills = [F(100, 'SIM-A', 'buy', 4, 25000), F(100.4, 'SIM-B', 'buy', 2, 25000.5), F(101.2, 'SIM-C', 'buy', 1, 25001), F(102.5, 'SIM-D', 'buy', 2, 25002),
    F(160, 'SIM-A', 'sell', 4, 25010), F(160.3, 'SIM-B', 'sell', 2, 25010.25)];
  const m = OT.groupFillMarks(fills, ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], 2);
  assert.equal(m.length, 3, 'SIM-D 2.5 s after the first fill is a group fill of its own (the 2 s window)');
  assert.deepEqual([m[0].side, m[0].qty, m[0].t, m[0].account], ['buy', 7, 100, 'group']);
  assert.equal(m[0].price, (4 * 25000 + 2 * 25000.5 + 25001) / 7);
  assert.deepEqual(m[0].members, [{ account: 'SIM-A', qty: 4, price: 25000 }, { account: 'SIM-B', qty: 2, price: 25000.5 }, { account: 'SIM-C', qty: 1, price: 25001 }]);
  assert.deepEqual([m[2].side, m[2].qty], ['sell', 6]);
  assert.equal(OT.groupFillWords(m[2], p => p.toFixed(2)), 'Group sell 6 @ 25010.08: SIM-A 4 @ 25010.00, SIM-B 2 @ 25010.25');
});

test('1.40.0: only the group\'s current members count; a side never mixes; the open-trade rule works on the group\'s marks', () => {
  const fills = [F(100, 'SIM-A', 'buy', 1, 25000), F(100.5, 'SIM-X', 'buy', 9, 24000), F(100.6, 'SIM-B', 'sell', 1, 25000.25)];
  const m = OT.groupFillMarks(fills, ['SIM-A', 'SIM-B'], 2);
  assert.deepEqual(m.map(x => [x.side, x.qty]), [['buy', 1], ['sell', 1]], 'SIM-X (not a member now, say it left the group) is never drawn on the group\'s chart');
  assert.deepEqual(OT.groupFillMarks(fills, [], 2), []);
  const open = OT.openEntryFills(OT.groupFillMarks([F(100, 'SIM-A', 'buy', 2, 25000), F(100.2, 'SIM-B', 'buy', 1, 25001)], ['SIM-A', 'SIM-B'], 2), 3);
  assert.equal(open.length, 1, 'Fills hidden: the open trade\'s group mark stays');
});

test('1.40.0: the chart uses them only for a group on a host\'s chart; the workspace hands the members over; the hover is the chart\'s tooltip', () => {
  const live = read('live/live.js'), ws = read('live/workspace.js');
  assert.match(live, /const acc = account\(\), grp = HOST && \/\^group:\/\.test\(acc\) && Array\.isArray\(HT\.members\);/);
  assert.match(live, /: \[\.\.\.fills\.values\(\)\]\.filter\(f => f\.root === D\.root && f\.account === acc\);/, 'a single account: as before');
  assert.match(live, /groupFillTip\(pt\)/);
  assert.match(ws, /members: on && core\.isGroup\(acct\) \? \(\(core\.groupOf\(acct\) \|\| \{\}\)\.members \|\| \[\]\)\.slice\(\) : null/);
});
