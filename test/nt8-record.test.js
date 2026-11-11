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
    /* ChartBridgeStrategies.cs: the next build changes it (the bar trail), before its version is bumped */
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
  };
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.8 file');
});

test('0.6.11: the add-on files this release does not touch are the 0.6.10 files, byte for byte (while ChartBridge is 0.6.11)', () => {
  if (!/public const string Version = "0\.6\.11";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.11 changed ChartBridge.cs (the version, the trade's time to the bar trail, its feed drop), ChartBridgeOrders.cs and
  // ChartBridgeStrategies.cs (the bar trail) and ChartBridgeBars.cs (the narrower 1 second request); every other add-on file is
  // the one Anthony compiled for 0.6.10
  const want = {
    'ChartBridgeAccounts.cs': 'fafc11f2257267a41d26863401261f92c8468d260de4d144a3b2d00b787e01ad',
    'ChartBridgeAgents.cs': '87f8f18b0f806ec3693aae385ec4228659df0bf8e93a267e4db871084d766e73',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeTicks.cs': '83d962030e993e40280de8a8348da87baafdc661b56b9091da0e46137152cabe',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeBars.cs', 'ChartBridgeOrders.cs', 'ChartBridgeStrategies.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.10 file');
});

test('0.6.12: the add-on files this release does not touch are the 0.6.11 files, byte for byte (while ChartBridge is 0.6.12)', () => {
  if (!/public const string Version = "0\.6\.12";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.12 changed ChartBridge.cs (the version, an execution handed to the Order Strategies) and ChartBridgeStrategies.cs (a fill's
  // session from its own execution, session: only for a bar trail); every other add-on file is the one Anthony compiled for 0.6.11
  const want = {
    'ChartBridgeAccounts.cs': 'fafc11f2257267a41d26863401261f92c8468d260de4d144a3b2d00b787e01ad',
    'ChartBridgeAgents.cs': '87f8f18b0f806ec3693aae385ec4228659df0bf8e93a267e4db871084d766e73',
    'ChartBridgeBars.cs': 'f214ccf22eccee42168bc5efc2b09215fbddba48fd2c660e52a1f7831595b91f',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': 'e1baf6f7237c5b0ce32cc3abdd6a227b3f98344aa44f94e3f49bc72841b291ac',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeTicks.cs': '83d962030e993e40280de8a8348da87baafdc661b56b9091da0e46137152cabe',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeStrategies.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.11 file');
});

test('0.6.13: the add-on files this release does not touch are the 0.6.12 files, byte for byte (while ChartBridge is 0.6.13)', () => {
  if (!/public const string Version = "0\.6\.13";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.13 changed ChartBridge.cs (the version, the gate asks BarsTicket.MayStart before a request goes out), ChartBridgeBars.cs
  // (BarsTicket.MayStart and NotStarted) and ChartBridgeTicks.cs (the morning catch-up before 09:15, the raw deleted once packed);
  // every other add-on file is the one Anthony compiled for 0.6.12 (hashes from main 06af027)
  const want = {
    'ChartBridgeAccounts.cs': 'fafc11f2257267a41d26863401261f92c8468d260de4d144a3b2d00b787e01ad',
    'ChartBridgeAgents.cs': '87f8f18b0f806ec3693aae385ec4228659df0bf8e93a267e4db871084d766e73',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': 'e1baf6f7237c5b0ce32cc3abdd6a227b3f98344aa44f94e3f49bc72841b291ac',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeBars.cs', 'ChartBridgeTicks.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.12 file');
});

test('0.6.14: the add-on files this release does not touch are the 0.6.13 files, byte for byte (while ChartBridge is 0.6.14)', () => {
  if (!/public const string Version = "0\.6\.14";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.14 changed ChartBridge.cs (the version) and ChartBridgeTicks.cs (the tick day check rule, Anthony 2026-11-03); every other
  // add-on file is the one compiled for 0.6.13 (hashes from main 37b3a91)
  const want = {
    'ChartBridgeAccounts.cs': 'fafc11f2257267a41d26863401261f92c8468d260de4d144a3b2d00b787e01ad',
    'ChartBridgeAgents.cs': '87f8f18b0f806ec3693aae385ec4228659df0bf8e93a267e4db871084d766e73',
    'ChartBridgeBars.cs': 'a0bea9224dac8e2fb2dc33664d4e74159cde7c3a3f888bdfe6c92ea42b99fc9a',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': 'e1baf6f7237c5b0ce32cc3abdd6a227b3f98344aa44f94e3f49bc72841b291ac',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeTicks.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.13 file');
});

test('0.6.15: the add-on files this release does not touch are the 0.6.14 files, byte for byte; ChartBridge.cs and ChartBridgeTicks.cs change only in comments and the version (while ChartBridge is 0.6.15)', () => {
  if (!/public const string Version = "0\.6\.15";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.15 (Anthony 2026-11-03: everything is built from the ticks) retires the 1 second pull in ChartBridgeBars.cs; ChartBridge.cs
  // changes only its version and comments, ChartBridgeTicks.cs only comments (the tick capture and its final pull are the 0.6.14
  // code); every other add-on file, the whole order path among them, is the one compiled for 0.6.14 (hashes from main 91222fb)
  const want = {
    'ChartBridgeAccounts.cs': 'fafc11f2257267a41d26863401261f92c8468d260de4d144a3b2d00b787e01ad',
    'ChartBridgeAgents.cs': '87f8f18b0f806ec3693aae385ec4228659df0bf8e93a267e4db871084d766e73',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': 'e1baf6f7237c5b0ce32cc3abdd6a227b3f98344aa44f94e3f49bc72841b291ac',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  // the code lines only (comment lines and trailing comments left out, the version emptied), as nt8-ticks.test.js strips them
  const codeOnly = src => src.replace(/\r/g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1').replace(/\s+$/, '')).filter(l => l.length > 0).join('\n')
    .replace(/public const string Version = "[0-9.]+";/, 'public const string Version = "";');
  const code = {
    'ChartBridge.cs': 'd99231ee25cfe0a56d2ae1e9c71eb7976ba5badb07d71b669dd532d832c7804d',
    'ChartBridgeTicks.cs': '776a93d3cc8b5c21dae588307b2e1d00e8a303c9902cb6f1b9a7447f91cbf16f',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f] && !code[f]).sort(), ['ChartBridgeBars.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.14 file');
  for (const [f, h] of Object.entries(code)) assert.strictEqual(crypto.createHash('sha256').update(codeOnly(read(f))).digest('hex'), h, f + ': the 0.6.14 code (comments and the version only changed)');
});

test('0.6.16: prop accounts: every add-on file but ChartBridge.cs, ChartBridgeAccounts.cs and ChartBridgeAgents.cs is the 0.6.15 file, byte for byte, the order path among them; the order, group, copier, bot, strategy and merge harnesses too (while ChartBridge is 0.6.16)', () => {
  if (!/public const string Version = "0\.6\.16";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.16 (Anthony 2026-11-10 and 2026-11-11: agents trade the prop accounts) touches the config reader and the files helper
  // (ChartBridge.cs), the reset's one exception and the accounts message (ChartBridgeAccounts.cs) and the agent's saved Auto
  // (ChartBridgeAgents.cs). The order path (ChartBridgeOrders.cs), groups, the copier, the bot, strategies and Merge are the
  // files compiled for 0.6.15 (hashes from main 70a95bb), so no manual order, hotkey, group entry, copied order or bot order
  // can behave differently.
  const want = {
    'ChartBridgeBars.cs': '7a9de59769499d804767461f67f8442c7a44a04b8b8bfae8cf6f4879b5186664',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': 'e1baf6f7237c5b0ce32cc3abdd6a227b3f98344aa44f94e3f49bc72841b291ac',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeTicks.cs': 'def1e998f0e49dda1287d5422a6375ea8152646f62e86bc0c34d34b219cb7851',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeAccounts.cs', 'ChartBridgeAgents.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.15 file');
  // the harnesses the plan names stay as they were: the existing order and group checks pass unchanged
  const harness = {
    'check/OrdersHarness.cs': '9467dda85c9cf43848d34ccc9c7d8482df41eaabe38b75e1e2511651c032c807',
    'check/GroupsHarness.cs': 'c9b37698b0c2643a28545b0631d2f820558f06bd8994056d8a10cce08c97a27a',
    'check/CopierHarness.cs': 'a14a4b5d06029af0932b53bc5e288c23d38ede2ba2e38577955b19435d1b74da',
    'check/BotHarness.cs': '3c386b128226e817f8c88e17174c6ff64a8826e86878cb4b07908cf78872487d',
    'check/StrategiesHarness.cs': '735be80f3fe11fba6ad72bab5efc115ef1b78bca13025374990c3c3f5fd428cf',
    'check/MergeHarness.cs': '23af52cfc7de7310e70a521fedb190180a8ef28710ad97d66970d52053c3c3cf',
    'check/IntegrationHarness.cs': '1bdca6796709285b9252d0929f66a5cd9216765c2aff6001dca61b68d7d38c96',
    'check/Nt8Stubs.cs': 'e5aa806364ceb7470d845238e6ee3adc552525f4171784be5caeaa46569777c1',
  };
  for (const [f, h] of Object.entries(harness)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.15 file');
});

test('0.6.17: Kill all for the prop accounts: every add-on file but ChartBridge.cs (its version) and ChartBridgeAgents.cs is the 0.6.16 file, byte for byte, the order path among them; the order, group, copier, bot, strategy and merge harnesses too (while ChartBridge is 0.6.17)', () => {
  if (!/public const string Version = "0\.6\.17";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  // 0.6.17 adds one page message to the agent channel (ChartBridgeAgents.cs): its flatten is the agent's own, as the flat
  // time's. The order path (ChartBridgeOrders.cs), the accounts and the reset (ChartBridgeAccounts.cs), groups, the copier, the
  // bot, strategies and Merge are the files compiled for 0.6.16.
  const want = {
    'ChartBridgeAccounts.cs': 'a4a777575ab85bb10de21e9da32b7d785e6d5b17e1484ec280e41baab7d22da3',
    'ChartBridgeBars.cs': '7a9de59769499d804767461f67f8442c7a44a04b8b8bfae8cf6f4879b5186664',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': 'e1baf6f7237c5b0ce32cc3abdd6a227b3f98344aa44f94e3f49bc72841b291ac',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeTicks.cs': 'def1e998f0e49dda1287d5422a6375ea8152646f62e86bc0c34d34b219cb7851',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeAgents.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.16 file');
  const codeOnly = src => src.replace(/\r/g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1').replace(/\s+$/, '')).filter(l => l.length > 0).join('\n')
    .replace(/public const string Version = "[0-9.]+";/, 'public const string Version = "";');
  assert.strictEqual(crypto.createHash('sha256').update(codeOnly(read('ChartBridge.cs'))).digest('hex'), '23d9603f53f0e3dd79af59b20560b2a361230ee2c3f147528a762413481311ba', 'ChartBridge.cs: the 0.6.16 code (the version and its comment only changed)');
  const harness = {
    'check/OrdersHarness.cs': '9467dda85c9cf43848d34ccc9c7d8482df41eaabe38b75e1e2511651c032c807',
    'check/GroupsHarness.cs': 'c9b37698b0c2643a28545b0631d2f820558f06bd8994056d8a10cce08c97a27a',
    'check/CopierHarness.cs': 'a14a4b5d06029af0932b53bc5e288c23d38ede2ba2e38577955b19435d1b74da',
    'check/BotHarness.cs': '3c386b128226e817f8c88e17174c6ff64a8826e86878cb4b07908cf78872487d',
    'check/StrategiesHarness.cs': '735be80f3fe11fba6ad72bab5efc115ef1b78bca13025374990c3c3f5fd428cf',
    'check/MergeHarness.cs': '23af52cfc7de7310e70a521fedb190180a8ef28710ad97d66970d52053c3c3cf',
    'check/IntegrationHarness.cs': '1bdca6796709285b9252d0929f66a5cd9216765c2aff6001dca61b68d7d38c96',
    'check/Nt8Stubs.cs': 'e5aa806364ceb7470d845238e6ee3adc552525f4171784be5caeaa46569777c1',
  };
  for (const [f, h] of Object.entries(harness)) assert.strictEqual(crypto.createHash('sha256').update(read(f).replace(/\r/g, '')).digest('hex'), h, f + ' is the 0.6.16 file');
});

test('0.6.18: entry rules per trader: ChartBridgeOrders.cs differs from 0.6.17 in exactly two lines, the two that ask the agent\'s rules; every other add-on file but ChartBridge.cs (its version) and ChartBridgeAgents.cs is the 0.6.17 file byte for byte (while ChartBridge is 0.6.18)', () => {
  if (!/public const string Version = "0\.6\.18";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  const want = {
    'ChartBridgeAccounts.cs': 'a4a777575ab85bb10de21e9da32b7d785e6d5b17e1484ec280e41baab7d22da3',
    'ChartBridgeBars.cs': '7a9de59769499d804767461f67f8442c7a44a04b8b8bfae8cf6f4879b5186664',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeGroups.cs': '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeTicks.cs': 'def1e998f0e49dda1287d5422a6375ea8152646f62e86bc0c34d34b219cb7851',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeAgents.cs', 'ChartBridgeOrders.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(sha(read(f).replace(/\r/g, '')), h, f + ' is the 0.6.17 file');
  const codeOnly = src => src.replace(/\r/g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1').replace(/\s+$/, '')).filter(l => l.length > 0).join('\n')
    .replace(/public const string Version = "[0-9.]+";/, 'public const string Version = "";');
  assert.strictEqual(sha(codeOnly(read('ChartBridge.cs'))), '23d9603f53f0e3dd79af59b20560b2a361230ee2c3f147528a762413481311ba', 'ChartBridge.cs: the 0.6.17 code (the version and its comment only changed)');
  // the order path: the two lines that refused every agent market entry and every agent entry with no target now ask the agent's
  // rules (ChartBridgeAgents.MayMarket, MayNoTarget); with those two lines left out the file is the 0.6.17 file
  const lines = read('ChartBridgeOrders.cs').replace(/\r/g, '').split('\n');
  const asks = lines.map((l, i) => (/ChartBridgeAgents\.May(Market|NoTarget)\(agent\)/.test(l) ? i : -1)).filter(i => i >= 0);
  assert.strictEqual(asks.length, 2, 'two lines ask the rules');
  assert.match(lines[asks[0]], /^\s*if \(agent != null && \(\(kind != "limit" && kind != "stopLimit" && !\(kind == "market" && ChartBridgeAgents\.MayMarket\(agent\)\)\) \|\| strategyBody != null \|\| bracketBody == null\)\) return "an agent's entry is a limit or a stop-limit with a stop and a target";/);
  assert.match(lines[asks[1]], /^\s*if \(agent != null && \(stopTicks < 1 \|\| \(targetTicks < 1 && !ChartBridgeAgents\.MayNoTarget\(agent\)\)\)\) return "every agent entry needs a stop and a target";/, 'a stop always');
  assert.strictEqual(sha(lines.filter((l, i) => !asks.includes(i)).join('\n')), 'fb1cfabc8a3e26c89f39a95514e3e642b5ae76eba585213b01fa11c944e9342a', 'ChartBridgeOrders.cs: every other line is the 0.6.17 line');
  const harness = {
    'check/OrdersHarness.cs': '9467dda85c9cf43848d34ccc9c7d8482df41eaabe38b75e1e2511651c032c807',
    'check/GroupsHarness.cs': 'c9b37698b0c2643a28545b0631d2f820558f06bd8994056d8a10cce08c97a27a',
    'check/CopierHarness.cs': 'a14a4b5d06029af0932b53bc5e288c23d38ede2ba2e38577955b19435d1b74da',
    'check/BotHarness.cs': '3c386b128226e817f8c88e17174c6ff64a8826e86878cb4b07908cf78872487d',
    'check/StrategiesHarness.cs': '735be80f3fe11fba6ad72bab5efc115ef1b78bca13025374990c3c3f5fd428cf',
    'check/MergeHarness.cs': '23af52cfc7de7310e70a521fedb190180a8ef28710ad97d66970d52053c3c3cf',
    'check/IntegrationHarness.cs': '1bdca6796709285b9252d0929f66a5cd9216765c2aff6001dca61b68d7d38c96',
    'check/Nt8Stubs.cs': 'e5aa806364ceb7470d845238e6ee3adc552525f4171784be5caeaa46569777c1',
  };
  for (const [f, h] of Object.entries(harness)) assert.strictEqual(sha(read(f).replace(/\r/g, '')), h, f + ' is the 0.6.17 file');
});

test('0.6.19: the day\'s profit stop: only ChartBridgeAgents.cs changed; every other add-on file but ChartBridge.cs (its version) is the 0.6.18 file byte for byte, the groups and the order path included', () => {
  if (!/public const string Version = "0\.6\.19";/.test(read('ChartBridge.cs'))) return;   // a later release may change them
  const sha = t => crypto.createHash('sha256').update(t).digest('hex');
  const want = {
    'ChartBridgeAccounts.cs': 'a4a777575ab85bb10de21e9da32b7d785e6d5b17e1484ec280e41baab7d22da3',
    'ChartBridgeBars.cs': '7a9de59769499d804767461f67f8442c7a44a04b8b8bfae8cf6f4879b5186664',
    'ChartBridgeBot.cs': '33ca2af1f1867f14ab188f659ad63210933801b62c951234255972111fef84b1',
    'ChartBridgeCopier.cs': 'bb90a637610b3b56236c6cfba014c1a1db40110f2b821bbeecf7778f2f4e6e49',
    'ChartBridgeMerge.cs': '7aa31e37d38c1875eb236e1575d20f49ed31c1e2c08fc9d265d5aa7e0a32952c',
    'ChartBridgeOrderRecord.cs': 'de33b77a1d774d2ce8d11a5f3a8e927f1ff085c7d8f47259ff6a542d18ccc1f1',
    'ChartBridgeOrders.cs': '8e15e56a06b1f2597b5ff1ecebccba724b27a019819fa691b9f0a30c16bfaffd',
    'ChartBridgePin.cs': '8c6b28abf30cc716b7175fa3c1fd4e1cb9ca0c9407a19a03357830028481e3eb',
    'ChartBridgeStops.cs': 'f2d74c58a904a5ba448ca5ebceb05f25b01d55642ddfdf1323b0c7dbf95f5d3c',
    'ChartBridgeStrategies.cs': '968179e96aa887424b9df26148f8ae65bc3c60238f6f9de90f238e7781ab9193',
    'ChartBridgeTape.cs': 'b5150cf7dbea2244da11d49511d163b4666a2403b9e21ebd10ea44a25da87fd1',
    'ChartBridgeTicks.cs': 'def1e998f0e49dda1287d5422a6375ea8152646f62e86bc0c34d34b219cb7851',
    'ChartBridgeV3.cs': '4ea9774ee3d30e619d1b849965b68565c24eed8f276194deaf93ee23242261dc',
  };
  const addons = JSON.parse(read('install-files.json')).addons.map(f => f.replace(/^nt8\//, ''));
  assert.deepStrictEqual(addons.filter(f => !want[f]).sort(), ['ChartBridge.cs', 'ChartBridgeAgents.cs', 'ChartBridgeGroups.cs'], 'every add-on file is checked or named as changed');
  for (const [f, h] of Object.entries(want)) assert.strictEqual(sha(read(f).replace(/\r/g, '')), h, f + ' is the 0.6.18 file');
  // The review of 88 and its second look (F6, D2; B4: pinned by the exact diff, never by stripping lines): ChartBridgeGroups.cs
  // gains only the profit side of the day's number. Every added line and every changed line is listed here word for word;
  // undone, the file is the 0.6.18 file byte for byte, so the loss side (Realized and every room) cannot change unseen.
  const undo = (text, added, changed) => {
    let lines = text.replace(/\r/g, '').split('\n');
    for (const [now, was] of changed) {
      assert.strictEqual(lines.filter(l => l === now).length, 1, 'a changed line is there once: ' + now.trim().slice(0, 80));
      lines = lines.map(l => (l === now ? was : l));
    }
    for (const a of added) {
      const at = lines.indexOf(a);
      assert.ok(at >= 0, 'an added line is there: ' + a.trim().slice(0, 80));
      lines.splice(at, 1);
    }
    return lines.join('\n');
  };
  const groupsAdded = ["            // 0.6.19 (the review of 88, F6): the day's number for a PROFIT stop (realized plus open). After a late start (ChartBridge", "            // started after 18:02 ET) the realized part is the LARGER of ChartBridge's own figure and NinjaTrader's (Realized keeps the", "            // smaller, right for a loss limit); null, with ProfitWhy, when it is not known. Read by the agents' day stop only.", "            public double? ProfitPnl;", "            public string ProfitWhy;", "            // D2: in the first second after 18:00 ET, before the groups' tick rolls the day start, NinjaTrader's realized may", "            // still be yesterday's: while a day start of another session is held, the profit side is not known (never latched)", "            public const string RollPendingWhy = \"the new session's day start is not read yet (18:00 ET)\";", "            double? profitReal = null;   // F6", "            string profitWhy = null;     // the review of 88's second look (D2)", "            n.ProfitPnl = profitReal.HasValue && n.Unrealized.HasValue ? profitReal.Value + n.Unrealized.Value : (double?)null;", "            n.ProfitWhy = n.ProfitPnl.HasValue ? null : profitWhy ?? (profitReal.HasValue ? \"NinjaTrader gives no open P&L for this account\" : realWhy);"];
  const groupsChanged = [["                if (!late) { n.Realized = comp; realSrc = \"computed\"; profitReal = comp; }", "                if (!late) { n.Realized = comp; realSrc = \"computed\"; }"], ["                else if (ntReal.HasValue) { n.Realized = Math.Min(comp, ntReal.Value); realSrc = ntReal.Value < comp ? \"ninjatrader\" : \"computed\"; profitReal = Math.Max(comp, ntReal.Value); }", "                else if (ntReal.HasValue) { n.Realized = Math.Min(comp, ntReal.Value); realSrc = ntReal.Value < comp ? \"ninjatrader\" : \"computed\"; }"], ["            else if (ntReal.HasValue) { n.Realized = ntReal; realSrc = \"ninjatrader\"; realWhy = null; if (mark == null || mark.Session == n.Session) profitReal = ntReal; else profitWhy = Numbers.RollPendingWhy; }", "            else if (ntReal.HasValue) { n.Realized = ntReal; realSrc = \"ninjatrader\"; realWhy = null; }"]];
  assert.strictEqual(sha(undo(read('ChartBridgeGroups.cs'), groupsAdded, groupsChanged)), '95baae61b5c8d135d0a1b84e5a0c7fd13e63ff936d22da76170259bc2e4610ff', 'ChartBridgeGroups.cs: the 0.6.18 file but for the listed profit-side lines');
  for (const [now, was] of groupsChanged) assert.strictEqual(now.replace(/ profitReal = [^;]+; \}$/, ' }').replace(/ if \(mark == null \|\| mark\.Session == n\.Session\) profitReal = ntReal; else profitWhy = Numbers\.RollPendingWhy; \}$/, ' }'), was, 'a changed line only adds the profit side: ' + was.trim());
  const codeOnly = src => src.replace(/\r/g, '').split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1').replace(/\s+$/, '')).filter(l => l.length > 0).join('\n')
    .replace(/public const string Version = "[0-9.]+";/, 'public const string Version = "";');
  // the review of 90 (N6): the saved Auto file's second header line now says Auto ends at 17:00 ET (words only)
  const headerNow = '"# while this file names the agent\'s account and its trading day, Auto comes back once after a restart when flat; Auto ends at 17:00 ET and this file goes with it"';
  const header18 = '"# while this file names the agent\'s account, Auto is kept through the 17:00 ET reset and comes back once after a restart when flat"';
  assert.ok(read('ChartBridge.cs').includes(headerNow));
  assert.strictEqual(sha(codeOnly(read('ChartBridge.cs').replace(headerNow, header18))), '23d9603f53f0e3dd79af59b20560b2a361230ee2c3f147528a762413481311ba', 'ChartBridge.cs: the 0.6.17 code still (the version and its comment only changed)');
  // the flatten is the trader's own (ChartBridgeAgents.cs): the groups file has no word of the day stop
  assert.ok(!/dayStop|DayStop|daystop/.test(read('ChartBridgeGroups.cs')) && !/dayStop|DayStop|daystop/.test(read('ChartBridgeOrders.cs')), 'nothing of the day stop in the groups or the order path');
  const harness = {
    'check/OrdersHarness.cs': '9467dda85c9cf43848d34ccc9c7d8482df41eaabe38b75e1e2511651c032c807',
    'check/CopierHarness.cs': 'a14a4b5d06029af0932b53bc5e288c23d38ede2ba2e38577955b19435d1b74da',
    'check/BotHarness.cs': '3c386b128226e817f8c88e17174c6ff64a8826e86878cb4b07908cf78872487d',
    'check/StrategiesHarness.cs': '735be80f3fe11fba6ad72bab5efc115ef1b78bca13025374990c3c3f5fd428cf',
    'check/MergeHarness.cs': '23af52cfc7de7310e70a521fedb190180a8ef28710ad97d66970d52053c3c3cf',
    'check/IntegrationHarness.cs': '1bdca6796709285b9252d0929f66a5cd9216765c2aff6001dca61b68d7d38c96',
    'check/Nt8Stubs.cs': 'e5aa806364ceb7470d845238e6ee3adc552525f4171784be5caeaa46569777c1',
  };
  for (const [f, h] of Object.entries(harness)) assert.strictEqual(sha(read(f).replace(/\r/g, '')), h, f + ' is the 0.6.18 file');
  // GroupsHarness.cs gains only the checks of the profit side (F6, D2), listed word for word
  assert.strictEqual(sha(undo(read('check/GroupsHarness.cs'), ["        ChartBridgeGroups.Numbers pn = ChartBridgeGroups.Read(\"SIM-B\", simB, false);", "        Check(pn.Realized == -400 && pn.ProfitPnl == -150 && pn.ProfitWhy == null,", "              \"0.6.19 (the review of 88, F6): for a PROFIT stop the larger of the two (-100), plus open (-50): \" + pn.ProfitPnl + \"; the loss side keeps the smaller: \" + pn.Realized);", "        pn = ChartBridgeGroups.Read(\"SIM-B\", simB, false);", "        Check(!pn.ProfitPnl.HasValue && (pn.ProfitWhy ?? \"\").Contains(\"started mid-session\"), \"F6: no NinjaTrader realized after a late start: the profit side is not known, with why: \" + pn.ProfitWhy);", "        // D2 (the review of 88's second look): 18:00:00, before the tick rolls the day start: NinjaTrader's realized may still be", "        // yesterday's, so the profit side is not known (and never latched); the loss side reads as before", "        simB.Items[AccountItem.RealizedProfitLoss] = 700;", "        ClockEt(2026, 10, 16, 18, 0);", "        pn = ChartBridgeGroups.Read(\"SIM-B\", simB, false);", "        Check(!pn.ProfitPnl.HasValue && pn.ProfitWhy == ChartBridgeGroups.Numbers.RollPendingWhy && pn.Realized == 700,", "              \"D2: in the second after 18:00 before the day start rolls: no profit figure (\" + pn.ProfitWhy + \"); the loss side as before: \" + pn.Realized);", "        simB.Items[AccountItem.RealizedProfitLoss] = 0;"], [])), 'c9b37698b0c2643a28545b0631d2f820558f06bd8994056d8a10cce08c97a27a', 'check/GroupsHarness.cs: the 0.6.18 file but for the listed checks');
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

test('0.6.9 to 0.6.14: the 1 second bars; retired in 0.6.15 (Anthony 2026-11-03: everything from the ticks), the 1-minute bars and the gate as they were', () => {
  const b = read('ChartBridgeBars.cs');
  for (const gone of ['private static bool Plan1s(', 'private static Outcome Fetch1s(', 'BuildSeconds(', 'class SecondsBuilder', 'public static class ChartBridgeBars1sQueue', '"/api/bars-1s"', 'Rows1sPerPart', 'DefaultRoots1s']) assert.ok(!b.includes(gone), 'gone: ' + gone);
  // the window and the time limit the tick file's final pull shares, unchanged
  assert.match(b, /public static TimeSpan StartMargin1s = TimeSpan\.FromMinutes\(10\);/);
  assert.match(body(b, 'public static bool In1sWindow('), /return tod >= new TimeSpan\(16, 15, 0\) && tod < TimeSpan\.FromHours\(18\);/);
  assert.match(b, /public static int Request1sTimeoutMs = 180000;/);
  // the 1-minute bars: the same request through the gate and the same message
  assert.match(body(b, 'private static Outcome Fetch('), /ChartBridgeServer\.GateBars\(j\.Key, inst, fromNt, toNt, RequestTimeoutMs, stopping, t\);/);
  assert.match(b, /\.Append\(",\\"tf\\":\\"1m\\",\\"stamp\\":\\"open\\",\\"bars\\":\["\);/);
  assert.match(b, /"\/api\/bars"\);/);
  assert.match(read('check/BarsHarness.cs'), /Retired1s\(dir\);/);
  const cb = read('ChartBridge.cs');
  assert.match(cb, /: new BarsPeriod \{ BarsPeriodType = BarsPeriodType\.Tick, Value = 1, MarketDataType = MarketDataType\.Last \};/);
});

test('0.6.9: PROTOCOL documents the three, with versions; the CHANGELOG says what changed and what did not', () => {
  const p = read('PROTOCOL.md');
  for (const h of ['### 1 second bars to The Desk (0.6.9 to 0.6.14, contract v2; retired in 0.6.15)', '### The order record to The Desk (0.6.9)', '### The decision id of a group entry (0.6.9)']) assert.ok(p.includes(h), h);
  for (const k of ['`POST /api/order-events`', '`/api/bars-1s`', '`decision_id`', '`bv`', '`sv`', '`sides.method`', '`setRows`', '`quote`', '`change`', '`start`, `seq`', 'decisions.txt', 'bars1s/']) assert.ok(p.includes(k), k);
  const cl = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const sec = cl.split('\n## ').find(x => /^ChartBridge 0\.6\.9 /.test(x)) || '';   // 1.39.1: no longer the newest entry
  assert.match(sec, /^ChartBridge 0\.6\.9 \(2026-10-24\)/);
  assert.match(sec, /\*\*Needs a recompile \(F5\)\*\*/);
  for (const f of ['ChartBridgeOrderRecord.cs', 'check/RecordHarness.cs', 'PROTOCOL.md']) assert.doesNotMatch(read(f), /[–—]/, f + ': no em or en dashes');
});
