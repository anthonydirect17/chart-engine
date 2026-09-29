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
