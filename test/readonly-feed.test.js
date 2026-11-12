'use strict';
/* answers 25, N-b (K16): the Account page's rows-only mount gets a feed that passes the page's state and its reading
   functions (FEED_READS, the review of 97, F8) and answers false for every other function without calling the page's
   feed. The two definitions are taken from live/workspace.js as written (a browser file with no exports). */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
const a = src.indexOf('const FEED_READS = '), b = src.indexOf('function mountLanePanel(');
assert.ok(a > 0 && b > a, 'FEED_READS and readOnlyFeed are where this test looks');
const { FEED_READS, readOnlyFeed } = new Function(src.slice(a, b) + '\nreturn { FEED_READS, readOnlyFeed };')();

test('the rows-only feed: reads pass, every other function answers false and never reaches the page\'s feed', () => {
  const called = [];
  const feed = { S: { orders: new Map() }, store: { n: 1 } };
  Object.defineProperty(feed, 'live', { enumerable: true, get: () => 'now' });
  for (const k of FEED_READS) feed[k] = (...x) => { called.push(k); return 'read ' + k + ' ' + x.join(','); };
  for (const k of ['post', 'send', 'memberBench', 'accountGroup', 'setLimit', 'flatten', 'join', 'leave']) feed[k] = () => { called.push(k); return true; };
  const ro = readOnlyFeed(feed);
  assert.ok(Object.isFrozen(ro));
  for (const k of FEED_READS) assert.strictEqual(ro[k](1, 2), 'read ' + k + ' 1,2', k);
  for (const k of ['post', 'send', 'memberBench', 'accountGroup', 'setLimit', 'flatten', 'join', 'leave']) assert.strictEqual(ro[k]({ type: 'x' }), false, k);
  assert.deepStrictEqual(called, [...FEED_READS], 'only the reading functions reached the page\'s feed');
  assert.strictEqual(ro.S, feed.S, 'the state is the page\'s own');
  assert.strictEqual(ro.live, 'now', 'a getter is read through');
  feed.S = { orders: new Map([[1, 2]]) };
  assert.strictEqual(ro.S, feed.S, 'and read fresh, not copied once');
  assert.ok(!FEED_READS.has('post') && !FEED_READS.has('memberBench') && !FEED_READS.has('accountGroup'), 'nothing that sends is a read');
});
