'use strict';
// Chart 1.40.0, C-D (Anthony 2026-10-30): a trade tag on a group goes to the members that trade with it: never a benched member, never a
// copier follower (on or off). Made-up accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../live/workspace.js');

test('1.40.0 C-D: a group\'s trade tag leaves out its benched members and every copier follower', () => {
  const g = { id: 'g1', members: ['SIM-A', 'SIM-B', 'SIM-C', 'SIM-D'], benched: ['SIM-B'] };
  const copier = { followers: [{ account: 'SIM-D', on: false }, { account: 'SIM-X', on: true }] };
  assert.deepEqual(W.groupTagMembers(g, copier), ['SIM-A', 'SIM-C']);
  assert.deepEqual(W.groupTagMembers(g, null), ['SIM-A', 'SIM-C', 'SIM-D'], 'the copier not known: only the bench left out');
  assert.deepEqual(W.groupTagMembers({ members: ['SIM-A'] }, null), ['SIM-A'], 'a ChartBridge with no bench: every member');
  assert.deepEqual(W.groupTagMembers(null, null), []);
  const src = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  assert.match(src, /return g \? W\.groupTagMembers\(g, AF\.S\.copier\) : \[\];/);
});
