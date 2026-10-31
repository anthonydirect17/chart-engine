'use strict';
// Chart 1.40.0, C-A (Anthony 2026-10-30): "Update floors from The Desk" never lowers ChartBridge's floor, or sends one The Desk does
// not say is on net P&L, without Anthony's own tick in that confirm. The Desk's GET /api/chart-floors carries `basis` per account
// (thedesk/chart_floors.py: "net" or "gross", from its prop progress); a row with none is treated as not known. Made-up accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AC = require('../live/accounts.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('1.40.0 C-A: a floor lower than ChartBridge\'s, or not known to be on net P&L, needs Anthony\'s tick; a higher net one does not', () => {
  const desk = { accounts: [
    { account: 'EVAL-A', floor: 49600, basis: 'net', source: 'x' },     // higher, net: goes
    { account: 'EVAL-B', floor: 48000, basis: 'net', source: 'x' },     // lower: tick
    { account: 'EVAL-C', floor: 49900, basis: 'gross', source: 'x' },   // gross: tick
    { account: 'EVAL-D', floor: 49900, source: 'x' }] };                // no basis: tick
  const acc = n => ({ name: n, floor: 49000, rules: { drawdownType: 'eod' } });
  const plan = AC.floorPlan(desk, ['EVAL-A', 'EVAL-B', 'EVAL-C', 'EVAL-D'].map(acc), a => a.rules);
  const by = Object.fromEntries(plan.send.map(r => [r.account, r]));
  assert.equal(by['EVAL-A'].tick, '');
  assert.equal(by['EVAL-B'].lower, true);
  assert.equal(by['EVAL-B'].tick, 'lower than ChartBridge\'s $49,000.00');
  assert.equal(by['EVAL-C'].tick, 'The Desk worked it out on gross P&L (no commission set)');
  assert.equal(by['EVAL-D'].tick, 'The Desk does not say whether it is on net P&L');
  const p2 = AC.floorPlan({ accounts: [{ account: 'EVAL-E', floor: 49600, basis: 'net' }] }, [{ name: 'EVAL-E', floor: null, rules: { drawdownType: 'eod' } }], a => a.rules);
  assert.match(p2.send[0].tick, /ChartBridge's floor is not known/);
});

test('1.40.0 C-A: Send sends only the floors that need no tick, and the ticked ones; ChartBridge keeps its refusal below the starting floor', () => {
  const src = read('live/accounts.js');
  assert.match(src, /const go = plan\.send\.filter\(r => !r\.tick \|\| ticked\.has\(r\.account\)\);/);
  assert.match(src, /data-act="floor-tick"/);
  assert.match(read('nt8/ChartBridgeGroups.cs'), /is below the starting floor/);
});
