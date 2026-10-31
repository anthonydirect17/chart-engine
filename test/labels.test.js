'use strict';
// Chart 1.40.0, C-E (Anthony 2026-10-30): a short label on the Accounts tab never reads as another account. Made-up accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AC = require('../live/accounts.js');

test('1.40.0 C-E: a label equal to another label or another account\'s name (ignoring case) is refused; its own name or empty is fine', () => {
  const names = ['EVAL-A', 'EVAL-B', 'SIM-A'], labels = { 'EVAL-A': 'e50' };
  assert.equal(AC.labelRefusal('EVAL-B', 'E50', labels, names), 'Label "E50" is already EVAL-A\'s label: pick another.');
  assert.equal(AC.labelRefusal('EVAL-B', 'sim-a', labels, names), 'Label "sim-a" is the name of another account (SIM-A): pick another label.');
  assert.equal(AC.labelRefusal('EVAL-A', 'e50', labels, names), '', 'its own label again');
  assert.equal(AC.labelRefusal('EVAL-B', 'eval-b', labels, names), '', 'its own name');
  assert.equal(AC.labelRefusal('EVAL-B', '  ', labels, names), '', 'empty: back to the name');
  assert.equal(AC.labelRefusal('EVAL-B', 'b25', labels, names), '');
});

test('1.40.0 C-E: the row shows the account\'s own name beside its label; the label box checks before it saves', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'live', 'accounts.js'), 'utf8');
  assert.match(src, /\(lab \? ci\(a\.name, 'mut apg-raw', a\.name\) : ''\)/);
  assert.match(src, /const no = AC\.labelRefusal\(el\.dataset\.id, t, all, known\);\n\s*if \(no\) \{ host\.note\(no, true\); el\.value = all\[el\.dataset\.id\] \|\| ''; return; \}/);
});
