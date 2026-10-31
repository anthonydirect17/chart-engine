'use strict';
// Chart 1.40.0 and ChartBridge 0.6.10 (Anthony 2026-10-30): what reaches The Desk. C-B: a fill or order event The Desk rejects inside a
// 200 answer is kept with its reason (rejected_fills.jsonl, rejected_orders.jsonl), counted in /diag with the file's name, and shown on
// the Account page. Made-up numbers only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AC = require('../live/accounts.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('1.40.0 C-B: what The Desk did not store, counted with the file it is kept in', () => {
  const L = AC.deskSendLines({ desk: { postFills: true, rejectedByDesk: 2, setAside: 1, rejectedFile: 'rejected_fills.jsonl' }, orderRecord: { on: true, rejectedByDesk: 1, setAside: 0, rejectedFile: 'rejected_orders.jsonl' } });
  assert.deepEqual(L.warn, [
    '2 fills The Desk did not store since ChartBridge started: kept with The Desk\'s reason in rejected_fills.jsonl (next to config.txt).',
    '1 fill The Desk called malformed: set aside in rejected_fills.jsonl (next to config.txt).',
    '1 order event The Desk did not store since ChartBridge started: kept with The Desk\'s reason in rejected_orders.jsonl (next to config.txt).']);
  assert.deepEqual(AC.deskSendLines({ desk: { postFills: true, rejectedByDesk: 0, setAside: 0 } }).warn, []);
  assert.deepEqual(AC.deskSendLines(null).warn, [], '/diag not read: nothing said');
  assert.deepEqual(AC.deskSendLines({ desk: { rejectedByDesk: 1, rejectedFile: '../x' } }).warn[0].includes('rejected_fills.jsonl'), true, 'a file name it cannot trust: the known one');
  assert.deepEqual(AC.deskSendLines({ orderRecord: { on: false, rejectedByDesk: 3 } }).warn, [], 'the order record off: nothing about it');
});

test('1.40.0 C-C: postFills off on this PC: a plain warning first; on, or /diag silent: none (the default is not changed)', () => {
  assert.deepEqual(AC.deskSendLines({ desk: { postFills: false, rejectedByDesk: 0 } }).warn, ['This PC does not send fills to The Desk: its trades are missing from The Desk\'s stats.']);
  assert.equal(AC.deskSendLines({ desk: { postFills: false, rejectedByDesk: 1 } }).warn[0], 'This PC does not send fills to The Desk: its trades are missing from The Desk\'s stats.');
  assert.deepEqual(AC.deskSendLines({ desk: { postFills: true } }).warn, []);
  assert.deepEqual(AC.deskSendLines({ desk: {} }).warn, [], 'not said: nothing guessed');
  assert.match(read('nt8/ChartBridge.cs'), /public static bool PostFills = false;/, 'the default stays off');
});

test('0.6.10 C-B: ChartBridge keeps each item The Desk rejects inside a 200, before the batch leaves the queue', () => {
  const cb = read('nt8/ChartBridge.cs'), rec = read('nt8/ChartBridgeOrderRecord.cs');
  assert.match(cb, /NoteRejectedSafe\(text, batch\);[^\n]*\n\s*Remove\(batch\);/);
  assert.match(rec, /NoteRejectedSafe\(text, batch\);[^\n]*\n\s*Remove\(batch\);/);
  /* 0.6.10 (review): an odd escape in The Desk's reason keeps the raw text; a file that cannot be written reaches NoteRejectedSafe */
  assert.match(cb, /string reason = why\.Success \? ReasonText\(why\.Groups\[1\]\.Value\)/);
  assert.match(cb, /internal static string ReasonText\(string raw\)\s*\{\s*try \{ return Regex\.Unescape\(raw\); \}\s*catch \(ArgumentException\) \{ return raw; \}/);
  assert.match(cb, /\n\s*File\.AppendAllLines\(file, lines\);/);
  /* 0.6.10 (review): the keeping can never send the accepted batch again: caught, logged, counted in /diag */
  for (const src of [cb, rec]) {
    assert.match(src, /internal static bool NoteRejectedSafe\(string text, string\[\] batch\)\s*\{\s*try \{ NoteRejected\(text, batch\); return true; \}\s*catch \(Exception ex\)\s*\{\s*Interlocked\.Increment\(ref keepRejectedFailed\);/);
    assert.match(src, /\\"keepRejectedFailed\\":\" \+ Interlocked\.Read\(ref keepRejectedFailed\)/);
    assert.equal((src.match(/[^e]NoteRejected\(text, batch\)/g) || []).length, 1, 'only NoteRejectedSafe calls NoteRejected');
  }
  assert.match(cb, /internal static int KeepRejected\(string rejectedList, string\[\] batch, string file\)/);
  assert.match(rec, /ChartBridgeDesk\.KeepRejected\(m\.Groups\[1\]\.Value, batch, SetAsideFile\)/);
  assert.match(cb, /,\\"rejectedFile\\":\\"rejected_fills\.jsonl\\"/);
  assert.match(rec, /,\\"rejectedFile\\":\\"rejected_orders\.jsonl\\"/);
  assert.match(read('live/accounts.js'), /const diag = Promise\.resolve\(\)\.then\(\(\) => env\.fetch\('\/diag'/);
});
