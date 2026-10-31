// ChartBridge 0.6.9 (Anthony 2026-10-24, Phase 2 of his stats suite): the order record, the decision id of a group entry and the
// 1 second bars ship, are compile-checked and harnessed, are documented, and change no order path (recording only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'nt8', f), 'utf8');
const body = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, start); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } return src.slice(i); };

test('0.6.9: the order record ships with the add-on, is compile-checked and harnessed, and never touches an order', () => {
  assert.ok(JSON.parse(read('install-files.json')).addons.includes('nt8/ChartBridgeOrderRecord.cs'));
  for (const f of ['check/check.sh', 'check/orders.sh']) assert.match(read(f), /ChartBridgeStrategies\.cs ChartBridgeOrderRecord\.cs ChartBridgeGroups\.cs ChartBridgeStops\.cs check\/Nt8Stubs\.cs/);
  assert.match(read('check/orders.sh'), /check\/RecordHarness\.cs/);
  assert.match(read('check/OrdersHarness.cs'), /Section\("order record \(0\.6\.9\)", RecordHarness\.Run\)/);
  const src = read('ChartBridgeOrderRecord.cs');
  assert.doesNotMatch(src, /\.(Submit|Change|Cancel|Flatten|CreateOrder)\(/);
  assert.match(src, /"\/api\/order-events"/);
  const observe = body(src, 'public static void Observe(');
  assert.doesNotMatch(observe, /File\.|Flush\(|Save|EventJson\(|WebRequest/, 'the event thread only enqueues');
  assert.match(src, /public static int Cap = 20000;/);
  assert.match(src, /if \(code == 404\)[\s\S]{0,1200}noDeskUntil = ChartBridgeTime\.NowUtcMs\(\) \+ NoDeskRetryMs;/, 'a 404 keeps the events and offers them again');
  const cb = read('ChartBridge.cs');
  assert.match(cb, /try \{ ChartBridgeOrders\.OnOrderUpdate\(a, e\); \} catch[^\n]*\n\s*try \{ ChartBridgeStops\.Observe\(a, e\); \} catch[^\n]*\n\s*try \{ ChartBridgeOrderRecord\.Observe\(a, e\); \} catch/, 'after the order path and the stop record, never in their way');
  assert.match(cb, /else if \(ChartBridgeOrderRecord\.ReadConfig\(key, val\)\) \{ \}/);
  assert.match(cb, /b\.Append\(",\\"orderRecord\\":"\)\.Append\(ChartBridgeOrderRecord\.DiagJson\(\)\);/);
  assert.match(cb, /try \{ ChartBridgeOrderRecord\.Flush\(\); \} catch \(Exception\) \{ \} try \{ ChartBridgeDecisions\.SaveIfDirty\(\); \} catch \(Exception\) \{ \}/, 'decisions.txt saved by the account timer itself (postOrders off too)');
  assert.doesNotMatch(observe, /RemoveAt\(|PendingList/, 'the event thread never moves the waiting lines');
  assert.match(src, /\.Append\(",\\"nt_order_id\\":"\)/);
});

test('0.6.9: recording only: the order files and the stop record are the 0.6.8 files, byte for byte (while ChartBridge is 0.6.9)', () => {
  if (!/public const string Version = "0\.6\.9";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  const want = {
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    // ChartBridgeOrders.cs: changed for 0.6.10 (the Placing mark, Sunday 11-01 item 10); the record code in it is untouched
    'ChartBridgeCopier.cs': 'dc9ee92ee64c98effc74cc4aa6cc4f5965ba50746c5fbd2c48b795334decaceb',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeAgents.cs': 'e8d50518b699546240e3ab570168e1bb82edd2960951f1cda98d020ee5d5ecf2',
    'ChartBridgeStrategies.cs': '588a308895185587f795276a0479d41c9ebc1843bd53ad6d7c06c8aa935d386a',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
  };
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.8 file');
});

test('0.6.10: the files this release does not touch are still the 0.6.8 files, byte for byte (while ChartBridge is 0.6.10)', () => {
  if (!/public const string Version = "0\.6\.10";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.10 changed ChartBridgeOrders.cs (the Placing mark), ChartBridgeCopier.cs and ChartBridgeAgents.cs (the account lifecycle);
  // the order record code is untouched (the 0.6.9 guards above still hold)
  const want = {
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeStrategies.cs': '588a308895185587f795276a0479d41c9ebc1843bd53ad6d7c06c8aa935d386a',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
  };
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.8 file');
});

test('0.6.9: the decision id: the group entry\'s PlaceOrder call unchanged, set and cleared around it, noted before Submit', () => {
  const g = read('ChartBridgeGroups.cs');
  const loop = body(g, 'private static string GroupPlaceLocked(');
  assert.match(loop, /ChartBridgeDecisions\.Begin\(decision, s\.Account\);[^\n]*\n\s*try \{ why = MergeFreezeWhy\("order", one, null\) \?\? PlaceOrder\(one, bracketBody, cid != null \? cid \+ ":" \+ \(i \+ 1\) : null, strategyBody\); \}\n\s*catch \(Exception ex\) \{ why = "ChartBridge error: " \+ ex\.Message; \}\n\s*finally \{ ChartBridgeDecisions\.End\(\); \}/);
  assert.match(body(g, 'public static void NoteNewOrder('), /ChartBridgeDecisions\.NoteCreated\(a, o\);/);
  const rec = read('ChartBridgeOrderRecord.cs');
  assert.match(body(rec, 'public static void NoteCreated('), /string d = current;\s*if \(d == null \|\| o == null \|\| a == null\) return;/, 'a thread-local read for every other order');
  assert.match(read('ChartBridge.cs'), /FillBy\(account, orderId, order\) \+ ChartBridgeDecisions\.FillField\(account, orderId, order\) \+ "\}";/);
  assert.match(body(rec, 'public static string FillField('), /return d == null \? "" : ",\\"decision_id\\":" \+ CbJson\.Str\(d\);/, 'no key at all on any other fill');
  assert.match(read('check/GroupsHarness.cs'), /DecisionIds\(\);/);
});

test('0.6.9: the 1 second bars: NQ and MNQ, through the gate, only 16:15 to 18:00 ET on weekdays and on the weekend, their own path and queue', () => {
  const b = read('ChartBridgeBars.cs');
  assert.match(b, /private static string\[\] DefaultRoots1s\(\) \{ return new string\[\] \{ "NQ", "MNQ" \}; \}/);
  assert.match(body(b, 'private static bool Plan1s('), /nowEt = NowEt\(\);[^\n]*\n\s*if \(!In1sStartWindow\(nowEt\)\) \{ state1s = "waiting: 1 second bars go 16:15 to 18:00 ET/);
  assert.match(body(b, 'private static bool Plan1s('), /if \(!In1sStartWindow\(NowEt\(\)\)\)[^\n]*\n\s*Outcome o = Fetch1s\(j, stopping\);/, 'the clock read again right before a request');
  assert.match(b, /public static TimeSpan StartMargin1s = TimeSpan\.FromMinutes\(10\);/);
  assert.match(body(b, 'public static bool In1sWindow('), /return tod >= new TimeSpan\(16, 15, 0\) && tod < TimeSpan\.FromHours\(18\);/);
  assert.match(body(b, 'private static bool Plan1s('), /return true;   \/\/ one a pass/);
  assert.match(body(b, 'private static Outcome Fetch1s('), /ChartBridgeServer\.GateBars\("1s " \+ j\.Key, inst, fromNt, toNt, Request1sTimeoutMs, stopping, t, bars => BuildSeconds\(bars, fromMs, toMs\)\)/);
  assert.match(b, /"\/api\/bars-1s"/);
  assert.match(body(b, 'public static void Flush(Func<bool> stopping)\n        {\n            if (!ChartBridgeBars.OneSecondOn)'), /if \(!ChartBridgeBars\.In1sWindow\(/, 'the sends keep the same window');
  assert.match(read('check/BarsHarness.cs'), /OneSecondWindow\(\);/);
  assert.match(b, /public static int Rows1sPerPart = 1500;/);
  const cb = read('ChartBridge.cs');
  assert.match(cb, /: new BarsPeriod \{ BarsPeriodType = BarsPeriodType\.Tick, Value = 1, MarketDataType = MarketDataType\.Last \};/);
  assert.match(read('check/BarsHarness.cs'), /OneSecondSession\(dir\);/);
});

test('0.6.9: PROTOCOL documents the three, with versions; the CHANGELOG says what changed and what did not', () => {
  const p = read('PROTOCOL.md');
  for (const h of ['### 1 second bars to The Desk (0.6.9, contract v2)', '### The order record to The Desk (0.6.9)', '### The decision id of a group entry (0.6.9)']) assert.ok(p.includes(h), h);
  for (const k of ['`POST /api/order-events`', '`/api/bars-1s`', '`decision_id`', '`bv`', '`sv`', '`sides.method`', '`setRows`', '`quote`', '`change`', '`start`, `seq`', 'decisions.txt', 'bars1s/']) assert.ok(p.includes(k), k);
  const cl = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const sec = cl.split('\n## ').find(x => /^ChartBridge 0\.6\.9 /.test(x)) || '';   // 1.39.1: no longer the newest entry
  assert.match(sec, /^ChartBridge 0\.6\.9 \(2026-10-24\)/);
  assert.match(sec, /\*\*Needs a recompile \(F5\)\*\*/);
  for (const f of ['ChartBridgeOrderRecord.cs', 'check/RecordHarness.cs', 'PROTOCOL.md']) assert.doesNotMatch(read(f), /[–—]/, f + ': no em or en dashes');
});
