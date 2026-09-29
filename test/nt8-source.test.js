'use strict';
// Guards on the NinjaTrader add-on source. It cannot run here, so these check the code itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridge.cs'), 'utf8');
// drop comments (whole-line, and trailing after ; { } or )) without touching "http://" inside strings
const code = src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');

test('ChartBridge is read only: no order placement, change, cancel or flatten calls', () => {
  const forbidden = [/\.Submit\s*\(/, /\.CreateOrder\s*\(/, /\.Change\s*\(/, /\.Flatten\s*\(/, /\.CancelAllOrders\s*\(/,
    /\bAtm\w*\.\w+\s*\(/, /\.Cancel\s*\(\s*new\s+\[\]/, /\bOrderAction\./, /\bStartAtmStrategy\b/];
  for (const re of forbidden) assert.ok(!re.test(code), 'found forbidden call: ' + re);
});

test('the per-client send loop never runs inline (0.1.0 deadlock)', () => {
  assert.match(code, /Task\.Run\(\(\) => client\.SendLoop\(\)\)/);
  assert.ok(!/=\s*client\.SendLoop\(\)/.test(code), 'SendLoop called inline');
});

test('fill events read the instrument from e.Execution (ExecutionEventArgs has no Instrument)', () => {
  assert.ok(!/\be\.Instrument\b/.test(code.slice(code.indexOf('OnExecutionUpdate('))), 'e.Instrument used in OnExecutionUpdate');
});

test('the web server listens on localhost only', () => {
  const prefixes = code.match(/Prefixes\.Add\(([^)]*)\)/g) || [];
  assert.ok(prefixes.length > 0);
  for (const p of prefixes) assert.match(p, /http:\/\/localhost:/);
});

test('C# 5 only: no string interpolation or null-conditional operators', () => {
  assert.ok(!/\$"/.test(code), 'string interpolation');
  assert.ok(!/\?\.\w/.test(code), 'null-conditional ?.');
});

test('fills arrive two ways (event and a 2 second poll), each delivered once', () => {
  assert.match(code, /pollTimer = new System\.Threading\.Timer\(delegate \{ try \{ PollExecutions\(\); \}/);
  assert.match(code, /, null, 2000, 2000\)/);
  const onExec = code.slice(code.indexOf('private static void OnExecutionUpdate('));
  assert.match(onExec, /if \(!FirstTime\(ExecKey\(/, 'the event must skip executions the poll already delivered');
  const catchUp = code.slice(code.indexOf('private static int CatchUp('), code.indexOf('private static void PollExecutions('));
  assert.ok(catchUp.length > 0 && catchUp.length < 2000, 'CatchUp not found');
  assert.match(catchUp, /if \(!FirstTime\(ExecKey\(/, 'the poll must skip executions the event already delivered');
});

test('order and position events are only counted, never acted on', () => {
  const on = code.slice(code.indexOf('private static void OnOrderUpdate('), code.indexOf('private static string DiagJson('));
  assert.ok(!/Send|Queue|Deliver/.test(on), 'order/position handlers must only count');
});

test('/diag is served, and the clock re-anchors to the PC clock', () => {
  assert.match(code, /if \(path == "\/diag"\) \{ ServeText\(ctx, DiagJson\(\), "application\/json"\); return; \}/);
  assert.match(code, /RecheckEveryMs = 5000, StepIfOffByMs = 50/);
  assert.ok(!/ClockAnchor/.test(code), 'the fixed 0.1.x clock anchor is gone');
});

test('fills go to The Desk only when postFills is on', () => {
  const deliver = code.slice(code.indexOf('private static void Deliver('), code.indexOf('private static int CatchUp('));
  assert.ok(deliver.length > 0 && deliver.length < 1200, 'Deliver not found');
  assert.match(deliver, /if \(!ChartBridgeConfig\.PostFills\) return;[\s\S]*ChartBridgeDesk\.Queue\(desk\)/);
  assert.match(code, /public static bool PostFills = false;/);
});

test('The Desk queue: 10 s timeout, atomic file, clean reload, no duplicates, bad fills set aside', () => {
  const desk = code.slice(code.indexOf('public static class ChartBridgeDesk'), code.indexOf('public static class ChartBridgeServer'));
  assert.match(desk, /await Task\.WhenAny\(call, Task\.Delay\(TimeoutMs\)\)/);
  assert.match(desk, /req\.Abort\(\)/);
  assert.match(desk, /File\.Replace\(tmp, File_, null\)/);
  assert.match(desk, /PendingList\.Clear\(\); PendingSet\.Clear\(\);/);
  assert.match(desk, /if \(PendingSet\.Add\(fillJson\)\)/);
  assert.match(desk, /rejected_fills\.jsonl/);
  assert.ok(!/QueueToday/.test(code));
});

test('a failed start does not leave timers or account subscriptions behind', () => {
  const start = code.slice(code.indexOf('public static bool Start()'), code.indexOf('public static void Stop()'));
  assert.match(start, /catch \(Exception ex\)[\s\S]*pollTimer\.Dispose\(\)[\s\S]*Unwatch\(\);/);
});
