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
  assert.match(desk, /lastFailed = false; \}\s*lastError = "";/, '/diag: lastError cleared after a successful send');
  assert.ok(!/QueueToday/.test(code));
});

test('a failed start does not leave timers or account subscriptions behind', () => {
  const start = code.slice(code.indexOf('public static bool Start()'), code.indexOf('public static void Stop()'));
  assert.match(start, /catch \(Exception ex\)[\s\S]*pollTimer\.Dispose\(\)[\s\S]*Unwatch\(\);/);
});

// ---- Step 2: every order path lives in ChartBridgeOrders.cs, behind its gates
const osrc = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgeOrders.cs'), 'utf8');
const ocode = osrc.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');
// every body of a function (overloads included), from its signature to its closing brace
const fnBodies = name => {
  const out = [], re = new RegExp('\\bstatic [\\w<>, ]+ ' + name + '\\(', 'g');
  let m;
  while ((m = re.exec(ocode))) {
    const start = m.index, i = ocode.indexOf('{', start);
    let depth = 0, end = ocode.length;
    for (let j = i; j < ocode.length; j++) { if (ocode[j] === '{') depth++; else if (ocode[j] === '}' && --depth === 0) { end = j + 1; break; } }
    out.push(ocode.slice(start, end));
  }
  assert.ok(out.length > 0, name + ' not found');
  return out;
};
const fnBody = name => fnBodies(name).join('\n');

test('order calls appear only in the gated functions and the bracket upkeep of ChartBridgeOrders.cs', () => {
  const fromPage = ['PlaceOrderLocked', 'ChangeOrder', 'CancelOrder', 'Flatten'];
  const upkeep = ['PlaceLegs', 'KeepPartner', 'CancelLeftoverLegs', 'CheckLegs'];
  let rest = ocode;
  for (const f of fromPage.concat(upkeep)) for (const b of fnBodies(f)) rest = rest.replace(b, '');
  for (const re of [/\.Submit\s*\(/, /\.CreateOrder\s*\(/, /\.Change\s*\(/, /\.Cancel\s*\(/, /\.Flatten\s*\(/])
    assert.ok(!re.test(rest), 'order call outside the gated functions: ' + re);
  assert.ok(!/CancelAllOrders|StartAtmStrategy|\bAtm\w*\./.test(ocode), 'no ATM or cancel-all calls');
  // only PlaceOrderLocked and PlaceLegs create orders; the rest of the upkeep only cancels or shrinks
  for (const f of ['ChangeOrder', 'PlanOrder', 'CancelOrder', 'Flatten', 'KeepPartner', 'CancelLeftoverLegs', 'CheckLegs', 'KeepBracket', 'ScanEntries'])
    assert.ok(!/\.CreateOrder\s*\(|\.Submit\s*\(/.test(fnBody(f)), f + ' creates orders');
  assert.match(fnBody('PlaceOrder'), /lock \(PlaceLock\) why = PlaceOrderLocked\(/);
  // 0.3.7: planned_brackets.txt is written outside PlaceLock, and only WritePlans touches it; NinjaTrader's paths only read memory
  assert.ok(!/WritePlans\(|File\./.test(fnBody('PlaceOrderLocked')), 'no file I/O inside PlaceLock');
  for (const f of ['KeepBracket', 'Recover', 'OrderJson', 'BracketFor', 'PlaceLegs', 'OnOrderUpdate'])
    assert.ok(!/WritePlans\(|LoadPlans|File\./.test(fnBody(f)), f + ' does file I/O');
  // legs are GTC and named for their bracket and fill increment; the upkeep touches ChartBridge's own legs only
  const legs = fnBody('PlaceLegs');
  assert.equal((legs.match(/TimeInForce\.Gtc/g) || []).length, 2);
  assert.match(legs, /"CB#" \+ br\.Tag \+ " stop" \+ mark/);
  assert.match(legs, /"CB#" \+ br\.Tag \+ " target" \+ mark/);
  assert.match(legs, /\(br\.EntryIsBuy \? sp >= last : sp <= last\)/);   // a stop through the market becomes a market exit
  // 0.3.8 (the ATM rule): legs are ticks from the actual fill; the market exit only on a recent trade through the stop
  assert.match(legs, /sp = Round\(br\.EntryIsBuy \? incPrice - br\.StopTicks \* tick : incPrice \+ br\.StopTicks \* tick, tick\);/);
  assert.match(legs, /if \(fresh && \(br\.EntryIsBuy \? sp >= last : sp <= last\)\)/);
  assert.ok(!/bool byFill|StopPx|Priced/.test(ocode), 'no price-anchored planned bracket left (0.3.7)');
  const keep = fnBody('KeepBracket');
  assert.match(keep, /if \(filled <= br\.Covered\) \{ GapSince\.Remove\(entry\); return; \}/);
  assert.match(keep, /Bracket rec = Recover\(entry, out pairs, out deferred\);\s*if \(deferred\)\s*\{\s*bool first;\s*lock \(Sync\) \{ first = !PlanDeferred\.ContainsKey\(entry\); if \(first\) PlanDeferred\[entry\] = true; \}[^\n]*\s*if \(first\)[^\n]*\s*return;\s*\}\s*lock \(Sync\)/);   // Recover reads account orders outside Sync; waits for the plan file
  // from an order event the legs are placed in full, never sized from a position read at fill time;
  // only the scan path (a gap that lasted SettleMs) reads the settled position
  assert.match(keep, /if \(fromScan\) \{ KeepBracketFromScan\(entry, br, now\); return; \}/);
  assert.match(keep, /PlaceLegs\(br, filled, inc, incPrice, where\);/);   // the event path places the full increment
  assert.ok(!/EffectivePosition/.test(keep), 'KeepBracket must not size legs from the fill-time ledger');
  // 0.3.7 final review P8: the read-finish pass places legs through the order-event path only for entries an order event
  // deferred; entries the scan found first are left to the scan path (which reads the listed position)
  assert.match(ocode, /waited = PlanDeferred\.Where\(kv => kv\.Value\)\.Select\(kv => kv\.Key\)\.ToList\(\);/);
  assert.match(fnBody('ScanEntries'), /if \(!PlanDeferred\.ContainsKey\(o\)\) PlanDeferred\[o\] = false;/);
  const scan = fnBody('KeepBracketFromScan');
  assert.match(scan, /if \(now - g\[1\] < SettleMs\) return;/);
  assert.match(scan, /int advance = steady \? inc : qty;/);   // never settles "no legs needed" on an unsteady connection
  assert.match(keep, /if \(Settled\.Contains\(entry\)\) return;/);
  assert.match(fnBody('CancelLeftoverLegs'), /IsWorking\(o\.OrderState\) \|\| !IsChartBridgeLeg\(o\)/);
  assert.match(fnBody('CancelLeftoverLegs'), /now - born < YoungMs/);
  assert.match(fnBody('CheckLegs'), /if \(!Steady\(a, now\)\) continue;[\s\S]*IsChartBridgeLeg\(o\)/);
  assert.match(fnBody('CheckLegs'), /if \(now - was\.Value < SettleMs\) return;/);
  assert.match(ocode, /SettleMs = 4000;/);
  assert.match(ocode, /SteadyMs = 30000;/);
  assert.match(fnBody('OnPositionUpdate'), /MarketPosition\.Flat && SignedPosition\(account, inst\) == 0 && Steady\(/);
});

test('bracket upkeep runs even with trading off; pages hear only about tradable accounts', () => {
  const upd = fnBody('OnOrderUpdate');
  assert.match(upd, /^[^{]*\{\s*if \(account == null \|\| e\.Order == null\) return;/);
  assert.ok(upd.indexOf('KeepBracket(o)') < upd.indexOf('if (Enabled && AccountTradable(account.Name) && root != null)'), 'upkeep before the trading check');
  assert.ok(upd.indexOf('SendToTraders(OrderJson(') < upd.indexOf('Forget(o)'), 'OrderJson before Forget (Forget drops the id)');
  assert.match(fnBody('OnPositionUpdate'), /if \(Enabled && AccountTradable\(account\.Name\) && root != null\)\s*ChartBridgeServer\.SendToTraders/);
});

test('strict messages: known keys only, bracket must be an object', () => {
  assert.match(ocode, /\{ "order", new\[\] \{ "type", "cid", "account", "root", "side", "kind", "qty", "price", "bracket" \} \}/);
  assert.match(ocode, /\{ "change", new\[\] \{ "type", "cid", "id", "price" \} \}/);
  assert.match(ocode, /\{ "plan", new\[\] \{ "type", "cid", "id", "stopTicks", "targetTicks" \} \}/);   // 0.3.8: ticks
  assert.match(ocode, /\{ "cancel", new\[\] \{ "type", "cid", "id" \} \}/);
  assert.match(ocode, /\{ "flatten", new\[\] \{ "type", "cid", "account", "root" \} \}/);
  assert.match(ocode, /BracketKeys = \{ "stop", "target" \}/);
  const top = fnBody('TopLevel');
  assert.match(top, /if \(Has\(top, "bracket"\)\) \{ why =/);
  assert.match(top, /Duplicate\(top\)/);
  assert.match(top, /Unknown\(top, allowed\)/);
});

test('every order message passes the gate first; auth checks origin and token', () => {
  const on = fnBody('OnMessage');
  assert.match(on, /if \(type == "auth"\) \{ Auth\(client, text\); return; \}\s*string why = Gate\(client\);\s*string bracketBody = null, top = why == null \? TopLevel\(type, text, out bracketBody, out why\) : null;\s*if \(why != null\) \{ Reject/);
  const gate = fnBody('Gate');
  assert.match(gate, /if \(!Enabled\) return/);
  assert.match(gate, /if \(!client\.Trader \|\| !OriginAllowed\(client\.Origin\)\) return/);
  assert.match(gate, /MaxActionsPerSecond/);
  const auth = fnBody('Auth');
  assert.match(auth, /OriginAllowed\(client\.Origin\)/);
  assert.match(auth, /SlowEquals\(given, token\)/);
  assert.match(fnBody('OriginAllowed'), /"http:\/\/localhost:" \+ ChartBridgeConfig\.Port/);
});

test('accounts: off by default, exact names only, never Backtest or Playback', () => {
  assert.match(ocode, /public static bool Enabled;/);
  assert.match(fnBody('ResetConfig'), /Enabled = false; TradeAccounts\.Clear\(\); MaxQty\.Clear\(\);/);
  assert.match(fnBody('AccountTradable'), /if \(!Enabled \|\| string\.IsNullOrEmpty\(name\) \|\| IsNeverTradable\(name\)\) return false;/);
  assert.match(fnBody('ReadConfig'), /name\.Contains\("\*"\)\) continue;/);
  assert.match(ocode, /DefaultMaxQty = 1\b/);
  for (const f of ['PlaceOrderLocked', 'Flatten']) assert.match(fnBody(f), /Account account = FindAccount\(accountName, out why\);\s*if \(account == null\) return why;/);
  const find = fnBody('FindAccount');
  assert.match(find, /if \(!AccountTradable\(name\)\)/);
  assert.match(find, /if \(status != "Connected"\)/);
  assert.match(find, /if \(!ChartBridgeServer\.EnsureWatched\(found\)\)/);
  for (const f of ['ChangeOrder', 'CancelOrder']) {
    assert.match(fnBody(f), /!AccountTradable\(o\.Account\.Name\)/);
    assert.match(fnBody(f), /ChartBridgeServer\.RootFor\(o\.Instrument\)/);
  }
  // the cap is on the position: current position (with fills not yet in it) plus orders that may fill on that side plus this order
  assert.match(fnBody('PlaceOrderLocked'), /pos = isBuyOrder\(top\) \? Math\.Max\(posNow, posEff\) : Math\.Min\(posNow, posEff\)/);   // the worse reading
  assert.match(fnBody('PendingOrders'), /MayFill\(o\.OrderState\)/);
  assert.match(fnBody('PendingOrders'), /foreach \(Order o in Ours\)/);
  assert.match(fnBody('PlaceOrderLocked'), /long worst = isBuy \? \(long\)pos \+ pendBuy \+ qty : \(long\)\(-pos\) \+ pendSell \+ qty;\s*if \(worst > cap\)/);
  assert.match(fnBody('PlaceOrderLocked'), /bool wantsLegs = stopTicks > 0 \|\| targetTicks > 0;/);
  assert.match(fnBody('PlaceOrderLocked'), /if \(wantsLegs && reduces\) return/);
  // 0.3.8: a move is never refused for its bracket (the ticks travel with the entry); a plan is ticks, 1 or more, or null
  assert.ok(!/planned stop|PlanLock|BracketFor/.test(fnBody('ChangeOrder')), 'ChangeOrder never looks at the planned bracket');
  assert.match(fnBody('TicksOf'), /if \(Int\(top, key, out v\) != 1 \|\| v < 1\) return -1;/);
  for (const f of ['ChangeOrder', 'PlanOrder']) {
    assert.match(fnBody(f), /!AccountTradable\(o\.Account\.Name\)/);
    assert.match(fnBody(f), /ChartBridgeServer\.RootFor\(o\.Instrument\)/);
  }
  // a plan change that cannot be saved changes nothing
  // a plan is set in memory with the check that no fill waits, under Sync; the file is written afterwards, outside the locks
  assert.match(fnBody('PlanOrder'), /lock \(Sync\)\s*\{\s*waiting = o\.Filled - br\.Covered;\s*if \(waiting <= 0\) \{ br\.StopTicks = newSt; br\.TargetTicks = newTt;/);
  const plan = fnBody('PlanOrder');
  assert.ok(plan.indexOf('saveErr = WritePlans();') > plan.lastIndexOf('SetPlan(br.Tag, newSt, newTt);') && plan.lastIndexOf('SetPlan(') > 0, 'the file is written after the plan is set');
  assert.ok(plan.indexOf('saveErr = WritePlans();') > plan.indexOf('lock (PlanLock)') && /\}\s*ChartBridgeServer\.Log\("planned bracket set/.test(plan), 'and after PlanLock is released');
  assert.match(fnBody('ChangeOrder'), /OrderType\.StopLimit\) return/);
  assert.match(fnBody('PlaceOrderLocked'), /PriceProblem\(root, tick, kind, isBuy, price\)/);
  assert.match(fnBody('ChangeOrder'), /PriceProblem\(/);
});

test('the main file routes order messages only to ChartBridgeOrders, and ships both files', () => {
  assert.match(code, /ChartBridgeOrders\.OnMessage\(client, type, text\)/);
  assert.match(code, /type == "auth" \|\| type == "order" \|\| type == "change" \|\| type == "plan" \|\| type == "cancel" \|\| type == "flatten"\)\s*ChartBridgeOrders\.OnMessage/);   // 0.3.7: plan
  // /session: the Host check, then (0.3.2) the PIN unlock, then the order sign-in token
  assert.match(code, /if \(path == "\/session"\)[^\n]*\n\s*\{\s*if \(ctx\.Request\.Headers\["Host"\] != "localhost:" \+ ChartBridgeConfig\.Port\) \{ ctx\.Response\.StatusCode = 403;[^\n]*\n\s*if \(!ChartBridgePin\.TokenValid\(ctx\.Request\.Headers\[ChartBridgePin\.Header\]\)\) \{ Refuse\(ctx\); return; \}[^\n]*\n\s*ServeText\(ctx, ChartBridgeOrders\.SessionJson\(\), "application\/json"\);/);
  assert.match(code, /ChartBridgeOrders\.WatchConnections\(\);\s*try \{ ChartBridgeOrders\.Resume\(\); \}/);
  assert.match(code, /ChartBridgeOrders\.UnwatchConnections\(\);/);
  assert.ok(!/Access-Control-Allow-Origin/.test(code + ocode), 'no CORS headers anywhere');
  // nt8/install.ps1 (and the updater, nt8/update-pc.ps1) copy what nt8/install-files.json lists
  const install = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'install.ps1'), 'utf8');
  assert.match(install, /nt8\\install-files\.json/);
  const addons = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nt8', 'install-files.json'), 'utf8')).addons;
  assert.ok(addons.includes('nt8/ChartBridgeOrders.cs') && addons.includes('nt8/ChartBridgePin.cs'));
  const check = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'check.sh'), 'utf8');
  assert.match(check, /ChartBridgeOrders\.cs ChartBridgePin\.cs/);
  const orders = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'orders.sh'), 'utf8');
  assert.match(orders, /ChartBridgePin\.cs[\s\S]*check\/PinHarness\.cs/);
});

test('the page cannot be framed, messages are capped, and the legs check runs', () => {
  const nf = code.slice(code.indexOf('private static void NoFraming('));
  assert.match(nf, /res\.AddHeader\("X-Frame-Options", "DENY"\);/);
  assert.match(nf, /res\.AddHeader\("Content-Security-Policy", "frame-ancestors 'none'"\);/);
  const serveText = code.slice(code.indexOf('private static void ServeText('), code.indexOf('private static void NoFraming('));
  const serveFile = code.slice(code.indexOf('private static void ServeFile('), code.indexOf('private static async Task RunClient('));
  assert.match(serveText, /NoFraming\(res\);/);
  assert.equal((serveFile.match(/NoFraming\(res\);/g) || []).length, 2, 'ServeFile: on the file and on the 404');
  assert.match(code, /private const int MaxMessageBytes = 65536;/);
  assert.match(code, /if \(size > MaxMessageBytes\) break;/);
  assert.match(code, /WebSocketCloseStatus\.MessageTooBig/);
  assert.match(code, /public static bool EnsureWatched\(Account a\)/);
  assert.match(code, /pollTimer = new System\.Threading\.Timer\(delegate \{[^\n]*ChartBridgeOrders\.CheckLegs\(\)/);
});

test('ChartBridgeOrders.cs is C# 5 too', () => {
  assert.ok(!/(^|[\s(=,+:?])\$"/m.test(ocode), 'string interpolation');   // a regex's end anchor $" inside a string is fine
  assert.ok(!/\?\.\w/.test(ocode), 'null-conditional ?.');
  assert.ok(!/\bnameof\(/.test(ocode), 'nameof');
});

// ---- 0.3.1: network access. HTTP.sys listens on every interface and matches only the Host header, so
// ChartBridge itself refuses anything not from this PC, first, on every path; and the read-only WebSocket
// takes browsers only from its own page or an allowOrigins entry.
const bodyOf = (text, signature) => {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, signature + ' not found');
  const i = text.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < text.length; j++) { if (text[j] === '{') depth++; else if (text[j] === '}' && --depth === 0) return text.slice(start, j + 1); }
  return text.slice(start);
};

test('every request is refused unless it comes from this PC, checked first, before any routing', () => {
  const handle = bodyOf(code, 'private static async Task Handle(HttpListenerContext ctx, CancellationToken token)');
  const check = handle.indexOf('if (!ChartBridgeAccess.IsLoopback(remote)) { ChartBridgeAccess.NoteRefusedAddress(remote, SafePath(ctx)); Refuse(ctx); return; }');
  assert.ok(check > 0, 'the address check is in the request handler and refuses');
  // nothing but reading the source address comes before it
  assert.match(handle, /^[^{]*\{\s*try\s*\{\s*IPEndPoint remote = RemoteOf\(ctx\);\s*if \(!ChartBridgeAccess\.IsLoopback\(remote\)\)/);
  for (const route of ['ctx.Request.Url', 'IsWebSocketRequest', 'Headers["Origin"]', '"/diag"', '"/session"', 'ServeFile(', 'ServeText(', 'AcceptWebSocketAsync(', 'RunClient(', 'DiagJson(', 'SessionJson('])
    assert.ok(handle.indexOf(route) > check, route + ' must come after the address check');
  // the handler is the only way in: the accept loop hands every request to it, and routing happens nowhere else
  const accept = bodyOf(code, 'private static async Task AcceptLoop(');
  assert.match(accept, /Task handling = Task\.Run\(\(\) => Handle\(c, token\)\);/);
  for (const re of [/\bAcceptWebSocketAsync\(/g, /\bRunClient\(ws|\bRunClient\(wsc/g, /\bServeFile\(ctx, path\)/g, /\bGetContextAsync\(/g])
    assert.equal((code.match(re) || []).length, 1, 'exactly one ' + re);
  assert.ok(accept.indexOf('GetContextAsync(') > 0, 'requests are taken only in AcceptLoop');
  // the WebSocket upgrade: address check, then the Origin check, then the upgrade
  const ws = handle.indexOf('if (path == "/ws" && ctx.Request.IsWebSocketRequest)');
  const origin = handle.indexOf('if (!ChartBridgeAccess.WsOriginAllowed(origin)) { ChartBridgeAccess.NoteRefusedOrigin(origin); Refuse(ctx); return; }');
  const upgrade = handle.indexOf('await ctx.AcceptWebSocketAsync(null)');
  assert.ok(check < ws && ws < origin && origin < upgrade, 'address check, then origin check, then the upgrade');
  // a missing or unreadable address is not loopback; mapped IPv4 is unwrapped before the test
  assert.match(bodyOf(code, 'private static IPEndPoint RemoteOf('), /try \{ return ctx\.Request\.RemoteEndPoint; \} catch \(Exception\) \{ return null; \}/);
  assert.match(code, /public static bool IsLoopback\(IPEndPoint remote\) \{ return remote != null && IsLoopback\(remote\.Address\); \}/);
  const loop = bodyOf(code, 'public static bool IsLoopback(IPAddress a)');
  assert.match(loop, /if \(a == null\) return false;/);
  assert.match(loop, /if \(a\.AddressFamily == AddressFamily\.InterNetworkV6 && a\.IsIPv4MappedToIPv6\) a = a\.MapToIPv4\(\);/);
  assert.match(loop, /catch \(Exception\) \{ return false; \}/);
  assert.match(bodyOf(code, 'private static void Refuse('), /ctx\.Response\.StatusCode = 403;/);
  // a refusal is logged at most once an hour per address
  assert.match(code, /RefusalLogEveryMs = 3600000;/);
  assert.match(bodyOf(code, 'public static void NoteRefusedAddress('), /int d = AddressLogDecision\(who, ChartBridgeTime\.NowUtcMs\(\)\);/);
  assert.match(bodyOf(code, 'public static void NoteRefusedOrigin('), /int d = OriginLogDecision\(o, ChartBridgeTime\.NowUtcMs\(\)\);/);
  assert.match(code, /AddressLog = new RefusalBudget\(\), OriginLog = new RefusalBudget\(\);/);   // separate budgets
});

test('the read-only WebSocket takes a browser only from ChartBridge\'s own page or allowOrigins', () => {
  const allowed = bodyOf(code, 'public static bool WsOriginAllowed(string origin)');
  assert.match(allowed, /if \(origin == null\) return true;/);                 // no Origin header: not a browser, still this PC only
  assert.match(allowed, /if \(o\.Length == 0 \|\| o == "null"\) return false;/);
  assert.match(allowed, /if \(o == OwnOrigin\) return true;/);
  assert.match(allowed, /return list != null && list\.Contains\(o\);/);        // exact matches only
  assert.ok(!/StartsWith|EndsWith|IndexOf|Regex|\*/.test(allowed.replace(/^[^{]*/, '')), 'no prefix, suffix or wildcard matching');
  assert.match(code, /public static string OwnOrigin \{ get \{ return "http:\/\/localhost:" \+ ChartBridgeConfig\.Port/);
  assert.match(code, /else if \(key == "allowOrigins"\) AllowOrigins = ChartBridgeAccess\.ParseOrigins\(val\);/);
  assert.match(bodyOf(code, 'public static void Load()'), /ChartBridgeOrders\.ResetConfig\(\);\s*AllowOrigins = new List<string>\(\);/);
  // /diag lists them (not secret)
  assert.match(bodyOf(code, 'private static string DiagJson()'), /b\.Append\(",\\"network\\":"\)\.Append\(ChartBridgeAccess\.DiagJson\(\)\);/);
  // trading keeps its stricter rule: an allowOrigins page can never trade
  assert.ok(!/AllowOrigins|WsOriginAllowed/.test(ocode), 'ChartBridgeOrders.cs never looks at allowOrigins');
});

test('the missing-stop alarm keeps its text and names a target lost with its stop; ChartBridge\'s own cancels do not count', () => {
  assert.match(ocode, /Alarm\(Where\(a, inst\) \+ ": the position is " \+ pos \+ " but ChartBridge's working stops cover " \+ stops \+ " contract\(s\)" \+ oco \+ "; check NinjaTrader and add a stop"\);/);
  assert.match(ocode, /"; the target was cancelled too \(OCO\)"/);
  assert.match(ocode, /"; the target was " \+ lostTarget\.FirstState \+ " and the stop was cancelled with it \(OCO\)"/);
  assert.match(ocode, /", so the position has no stop and no target"/);
  for (const f of ['CancelLeftoverLegs', 'Flatten']) {
    const b = fnBody(f);
    assert.ok(b.indexOf('NoteWeCancelSafe(') >= 0 && b.indexOf('NoteWeCancelSafe(') < b.search(/account\.(Cancel|Flatten)\(/), f + ': noted before cancelling');
    assert.ok(!/NoteWeCancel\(/.test(b), f + ': only the safe (try/catch) note before an order action');
  }
  assert.match(fnBody('CheckLegs'), /if \(cancel\.Count > 0\) \{ NoteWeCancelSafe\(\(\) => cancel, "cancel"\); account\.Cancel\(cancel\.ToArray\(\)\); \}/);
  const safe = fnBody('NoteWeCancelSafe');
  assert.match(safe, /try\s*\{[\s\S]*NoteWeCancel\(orders\(\)\);\s*\}\s*catch \(Exception ex\) \{ ChartBridgeServer\.Log\(/);
});

// ---- 0.3.2: the PIN on ChartBridge's own page (ChartBridgePin.cs). A kid lock with no lockout; it gates the own page's
// WebSocket and /session, before anything streams or signs in; nothing logs a PIN or a token.
const psrc = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'ChartBridgePin.cs'), 'utf8');
const pcode = psrc.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');

test('PIN: checked before the stream (before the WebSocket upgrade) and before /session', () => {
  const handle = bodyOf(code, 'private static async Task Handle(HttpListenerContext ctx, CancellationToken token)');
  const addr = handle.indexOf('if (!ChartBridgeAccess.IsLoopback(remote))');
  const origin = handle.indexOf('if (!ChartBridgeAccess.WsOriginAllowed(origin))');
  const pin = handle.indexOf('if (!ChartBridgePin.WsUnlocked(origin, ctx.Request.QueryString["unlock"])) { Refuse(ctx); return; }');
  const upgrade = handle.indexOf('await ctx.AcceptWebSocketAsync(null)');
  const run = handle.indexOf('await RunClient(');
  assert.ok(addr > 0 && addr < origin && origin < pin && pin < upgrade && upgrade < run, 'address, origin, PIN, then the upgrade and the stream');
  const sess = handle.indexOf('if (path == "/session")');
  const sessPin = handle.indexOf('if (!ChartBridgePin.TokenValid(ctx.Request.Headers[ChartBridgePin.Header])) { Refuse(ctx); return; }');
  assert.ok(sess > addr && sessPin > sess && sessPin < handle.indexOf('ChartBridgeOrders.SessionJson()'), '/session: the PIN before the order token');
  // the PIN endpoints come after the address check, and before the page files
  const route = handle.indexOf('if (path.StartsWith("/pin/")) { ChartBridgePin.Serve(ctx, path); return; }');
  assert.ok(route > addr && route < handle.indexOf('ServeFile(ctx, path)'), '/pin/ routed after the address check');
  // hello, execs and every stream message are only sent from RunClient, which runs only after the upgrade
  assert.equal((code.match(/client\.Send\(HelloJsonFor\(seen\)\)/g) || []).length, 1);
  assert.ok(bodyOf(code, 'private static async Task RunClient(').includes('client.Send(HelloJsonFor(seen));'));
  assert.ok(bodyOf(code, 'private static async Task RunClient(').includes('SettlementAfterHello(client, seen);'));   // 0.3.7: hello ends right
  // only the own page needs it; the comparison matches the WebSocket origin rule (trimmed, lower-cased)
  assert.match(bodyOf(pcode, 'public static bool IsOwnOrigin(string origin)'), /return origin != null && origin\.Trim\(\)\.ToLowerInvariant\(\) == ChartBridgeAccess\.OwnOrigin;/);
  assert.match(bodyOf(pcode, 'public static bool WsUnlocked(string origin, string unlock)'), /if \(!IsOwnOrigin\(origin\)\) return true;\s*return TokenValid\(unlock\);/);
});

test('PIN: salted PBKDF2-SHA256 (50,000, capped at 1,000,000), only the hash and a secret stored, tokens checked in constant time', () => {
  assert.match(pcode, /public const int DefaultIterations = 50000;/);
  assert.match(pcode, /public const int MinIterations = 1000, MaxIterations = 1000000;/);
  assert.match(pcode, /new Rfc2898DeriveBytes\(Encoding\.ASCII\.GetBytes\(pin\), salt, iterations, HashAlgorithmName\.SHA256\)/);
  assert.match(pcode, /SaltBytes = 16, HashBytes = 32, SecretBytes = 32/);
  assert.match(pcode, /new HMACSHA256\(secret\)/);
  assert.match(pcode, /RNGCryptoServiceProvider/);
  assert.ok(!/new Random\(/.test(pcode), 'no System.Random');
  const write = bodyOf(pcode, 'private static void Write(Stored s)');
  assert.match(write, /ToHex\(s\.Salt\) \+ " " \+ ToHex\(s\.Hash\) \+ " " \+ ToHex\(s\.Secret\)/);
  assert.ok(!/\bpin\b|Token/i.test(write.replace(/"[^"]*"/g, '').replace(/PinFile/g, '')), 'Write stores the hash record only');
  assert.match(bodyOf(pcode, 'private static bool TokenValid(string token, PinState st)'), /SlowEquals\(Mac\(s\.Secret, parts\[1\]\), FromHex\(parts\[2\]\)\)/);
  assert.match(bodyOf(pcode, 'private static bool Matches('), /SlowEquals\(Derive\(pin, s\.Salt, s\.Iterations\), s\.Hash\)/);
  // a PIN is exactly four ASCII digits (char.IsDigit would take other scripts' digits)
  assert.ok(!/IsDigit|\\d/.test(pcode), 'no char.IsDigit or \\d');
  // review B1: pin.txt has three states. The one copy in memory is the last good record, used only while the file
  // exists but cannot be read; it is set only from a good parse or a write and dropped whenever the file is missing,
  // so deleting pin.txt still takes effect at once.
  assert.match(pcode, /private static volatile Stored lastGood;/);
  const sets = pcode.match(/lastGood = [^;]+;/g) || [];
  assert.deepEqual([...new Set(sets)].sort(), ['lastGood = null;', 'lastGood = parsed;', 'lastGood = s;']);
  const load = bodyOf(pcode, 'private static PinState Load()');
  assert.match(load, /if \(!File\.Exists\(file\)\) \{ lastGood = null; return new PinState \{ State = FileState\.Missing \}; \}/);
  assert.match(load, /FileShare\.ReadWrite \| FileShare\.Delete/);
  assert.match(load, /catch \(Exception ex\) \{ return Broken\(/);
  assert.match(load, /if \(parsed == null\) return Broken\(/);
  // Set writes only over a missing file; Change only over one that reads; the write is flushed before the swap
  const set = bodyOf(pcode, 'public static Result Set(string pin)');
  assert.ok(set.indexOf('if (st.State != FileState.Missing) return Fail(409') > 0 && set.indexOf('if (st.State != FileState.Missing) return Fail(409') < set.indexOf('Write(s)'), 'Set writes only when pin.txt is missing');
  const change = bodyOf(pcode, 'public static Result Change(string pin, string newPin)');
  assert.ok(change.indexOf('if (st.State == FileState.Broken) return Unreadable(st);') > 0 && change.indexOf('if (st.State == FileState.Broken)') < change.indexOf('Write(n)'));
  const writeBody = bodyOf(pcode, 'private static void Write(Stored s)');
  assert.ok(writeBody.indexOf('fs.Flush(true);') > 0 && writeBody.indexOf('fs.Flush(true);') < writeBody.indexOf('File.Replace(tmp, file, null)'), 'flushed to disk before the swap');
  // /pin/status reads the file once
  const status = bodyOf(pcode, 'public static void Serve(HttpListenerContext ctx, string path)');
  assert.match(status, /PinState st = Load\(\);[^\n]*\n\s*if \(st\.State == FileState\.Broken && st\.Rec == null\) \{ Reply\(ctx, 503,/);
  assert.match(status, /bool unlocked = set && TokenValid\(req\.Headers\[Header\], st\);/);
});

test('PIN: no lockout, ever: a wrong PIN is refused and nothing is counted, delayed or blocked', () => {
  const unlock = bodyOf(pcode, 'public static Result Unlock(string pin)');
  assert.match(unlock, /if \(!Matches\(st\.Rec, pin\)\) return Fail\(403, "wrong PIN"\);/);
  assert.ok(!/Sleep|Delay|Interlocked|\+\+|--|\+=|\block\s*\(/.test(unlock), 'Unlock counts, waits or locks nothing');
  assert.ok(!/Thread\.Sleep|Task\.Delay|Interlocked|SemaphoreSlim|attempt|lockout|throttle|\bban/i.test(pcode.replace(/NO lockout/g, '')), 'no counters, delays or bans anywhere in ChartBridgePin.cs');
  // the only static state: constants, the regexes, the file lock and the iteration count for new hashes
  const statics = pcode.split('\n').filter(l => /^\s*(public|private|internal)?\s*static\s+(?!readonly\b|class\b)/.test(l) && !l.includes('(')).map(l => l.trim());
  assert.deepEqual(statics.map(x => x.trim()), ['public static int NewHashIterations = DefaultIterations;', 'private static volatile Stored lastGood;',
    'private static double brokenLoggedMs = double.NegativeInfinity;']);
  // review S2: nothing on the way to the PIN in ChartBridge.cs counts, waits or blocks either
  const handle = bodyOf(code, 'private static async Task Handle(HttpListenerContext ctx, CancellationToken token)');
  const route = handle.split('\n').filter(l => /\/pin\//.test(l)).map(l => l.trim());
  assert.deepEqual(route, ['if (path.StartsWith("/pin/")) { ChartBridgePin.Serve(ctx, path); return; }']);
  for (const [name, body] of [['Handle', handle], ['ServeText', bodyOf(code, 'public static void ServeText(HttpListenerContext ctx, int status, string text, string type)')],
    ['ChartBridgePin.Serve', bodyOf(pcode, 'public static void Serve(HttpListenerContext ctx, string path)')], ['Matches', bodyOf(pcode, 'private static bool Matches(')], ['Derive', bodyOf(pcode, 'private static byte[] Derive(')]])
    assert.ok(!/Sleep|Delay|Interlocked|\+\+|--|\+=|\block\s*\(|\.Wait\(|SemaphoreSlim|Count\b|Add\(/.test(body.replace(/Headers\["[^"]*"\]/g, '')), name + ' counts, waits or locks nothing');
  assert.ok(!/lockout|throttle|wrongPin|failedPin|pinAttempt|badPin/i.test(code + ocode), 'no PIN attempt counting anywhere in ChartBridge');
});

test('PIN endpoints: POST only, own page only (the exact orders Origin check), localhost, JSON, small bodies, strict keys', () => {
  const serve = bodyOf(pcode, 'public static void Serve(HttpListenerContext ctx, string path)');
  const order = ['if (req.HttpMethod != "POST")', 'if (req.Headers["Host"] != "localhost:" + ChartBridgeConfig.Port)', 'if (!ChartBridgeOrders.OriginAllowed(req.Headers["Origin"]))',
    'if (type != "application/json" && !type.StartsWith("application/json;"))', 'string body = ReadBody(req);', 'if (path == "/pin/status")'].map(x => serve.indexOf(x));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'checks in order before any PIN work: ' + order.join(','));
  assert.match(pcode, /public const int MaxBodyBytes = 256;/);
  assert.match(bodyOf(pcode, 'private static string ReadBody('), /if \(req\.ContentLength64 > MaxBodyBytes\) return null;/);
  assert.match(serve, /ParseFlat\(body, new string\[\] \{ "pin" \}\)/);
  assert.match(serve, /ParseFlat\(body, new string\[\] \{ "pin", "newPin" \}\)/);
  assert.match(bodyOf(pcode, 'public static bool ValidPin(string pin)'), /if \(ch < '0' \|\| ch > '9'\) return false;/);
  assert.ok(!/Access-Control/.test(pcode), 'no CORS');
  // answers go through ServeText (no-store, no framing)
  assert.match(bodyOf(pcode, 'private static void Reply('), /ChartBridgeServer\.ServeText\(ctx, status, json, "application\/json"\);/);
  assert.match(bodyOf(code, 'public static void ServeText(HttpListenerContext ctx, int status, string text, string type)'), /NoFraming\(res\);/);
});

test('PIN: nothing logs a PIN, a hash, the secret or a token; /diag says only whether a PIN is set', () => {
  // every Log(...) argument in the three files, string literals dropped: no PIN, token or key material in it
  const logArgs = text => {
    const out = [], re = /\bLog\(/g;
    let m;
    while ((m = re.exec(text))) {
      let depth = 0, j = m.index + 3;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
      out.push(text.slice(m.index + 4, j));
    }
    return out;
  };
  const all = logArgs(code).concat(logArgs(ocode), logArgs(pcode));
  assert.ok(all.length > 30);
  const secretish = /\b(pin|newPin|pins|token|given|unlock|secret|salt|hash|body|Token|Secret|Salt|Hash|Stored|Read|MakeToken|Derive|Mac|SessionJson|QueryString|Headers)\b/;
  for (const a of all) {
    const bare = a.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.ok(!secretish.test(bare), 'a Log call may carry a secret: Log(' + a + ')');
  }
  assert.ok(!/Console\.|Debug\.|Trace\./.test(pcode), 'no other output in ChartBridgePin.cs');
  // SessionJson is the only place the order token is written, and the unlock token only goes back in a PIN answer
  assert.match(pcode, /public static string DiagJson\(\) \{ return "\{\\"set\\":" \+ \(IsSet \? "true" : "false"\) \+ "\}"; \}/);
  assert.match(bodyOf(code, 'private static string DiagJson()'), /b\.Append\(",\\"pin\\":"\)\.Append\(ChartBridgePin\.DiagJson\(\)\);/);
  // the WebSocket path the page connects with is never logged (the refusal log takes AbsolutePath, no query)
  assert.match(bodyOf(code, 'private static string SafePath('), /return ctx\.Request\.Url\.AbsolutePath;/);
});

test('ChartBridgePin.cs is C# 5 too', () => {
  assert.ok(!/(^|[\s(=,+:?])\$"/m.test(pcode), 'string interpolation');
  assert.ok(!/\?\.\w/.test(pcode), 'null-conditional ?.');
  assert.ok(!/\bnameof\(/.test(pcode), 'nameof');
  assert.ok(!/\{ get; \} =/.test(pcode), 'auto-property initializers');
  assert.ok(!/\) => [^{]*;$/m.test(pcode.split('\n').filter(l => /^\s*(public|private)/.test(l)).join('\n')), 'expression-bodied members');
});

// ---- 0.3.3: the seam between the backfill and the live trades (behaviour: nt8/check/SeamHarness.cs under Mono)
test('0.3.3: held live trades are matched against the backfill on NinjaTrader times before ready', () => {
  // held with NinjaTrader's time for the trade, the backfill's basis (never the PC clock)
  assert.match(bodyOf(code, 'private static void OnMarketData('), /c\.Pending\.Add\(new SeamTick \{ Time = e\.Time, Price = e\.Price, Volume = e\.Volume, Json = json, Side = side, Method = method, QCode = ChartBridgeSides\.QCode\(cat\) \}\)/);   // 0.3.8: and its q
  // 0.3.7: the by-date tick request (0.3.3 to 0.3.4.1) is gone; tick charts get the served window (0.3.5)
  assert.ok(!/RequestTickHistory|ByDateTickLoads/.test(code), 'the by-date tick load is removed');
  // ready and the held trades under the Pending lock, only for the page's latest subscribe, only those Dedupe releases
  const ready = bodyOf(code, 'private static void MarkReady(Load L, RawBars seam)');
  assert.match(ready, /lock \(client\.Pending\)\s*\{\s*if \(!Current\(L\)\) return;\s*SeamResult r = seam != null\s*\? ChartBridgeSeam\.Dedupe\(/);
  // 0.3.4: ready and the released trades as one outbox entry (a release of any size cannot close the page)
  assert.match(ready, /foreach \(SeamTick h in r\.Release\) burst\.Add\(h\.Json\);\s*client\.SendAll\(burst\);/);
  assert.ok(!/foreach \(SeamTick h in client\.Pending\)/.test(code), 'held trades only go out through Dedupe');
  assert.match(bodyOf(code, 'private static void StartLoad('), /lock \(client\.Pending\)[^{]*\{\s*L\.Seq = \+\+client\.SubscribeSeq;\s*L\.Sub = [^;]+;\s*client\.Ready = false;\s*client\.Pending\.Clear\(\);\s*client\.Root = root;\s*client\.WantsProfile = profile;\s*\}/);   // 0.3.5: and whether it wants "profile"
  assert.match(bodyOf(code, 'private static string DiagJson()'), /b\.Append\(",\\"seams\\":"\)\.Append\(SeamsJson\(\)\);/);
  // review of 0.3.3: only trades held when NinjaTrader answered can match at T; every chunk checks the subscribe is current
  assert.match(ready, /client\.Pending, L\.HeldAtAnswer\)/);
  assert.match(bodyOf(code, 'private static void NoteAnswer('), /lock \(L\.Client\.Pending\) \{ if \(Current\(L\)\) L\.HeldAtAnswer = L\.Client\.Pending\.Count; \}/);
  assert.equal((bodyOf(code, 'private static void RequestTicks(').match(/NoteAnswer\(L\);/g) || []).length, 1);
  // re-review: the heldAtAnswer gate only at whole seconds; sub echoed as canonical digits
  assert.match(code, /if \(i < heldAtAnswer \|\| unit < Second\) \{ r\.DroppedSameTime\+\+; continue; \}/);
  assert.match(code, /long\.Parse\(sm\.Groups\[1\]\.Value, CultureInfo\.InvariantCulture\)\.ToString\(CultureInfo\.InvariantCulture\)/);
  for (const f of ['private static void SendBars(', 'private static void SendTicks(Load L, RawBars bars, int from)']) {
    const body = bodyOf(code, f);
    assert.equal((body.match(/L\.Client\.Send\(/g) || []).length, (body.match(/Current\(L\)/g) || []).length, f + ': a Current check for every send');
  }
  const orders = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'orders.sh'), 'utf8');
  assert.match(orders, /check\/SeamHarness\.cs/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'OrdersHarness.cs'), 'utf8'), /SeamHarness\.Run\(Check\);/);
});

// ---- 0.3.4: the side of every trade (behaviour: nt8/check/SidesHarness.cs under Mono, test/trade-sides.test.js)
test('0.3.4: every trade carries its side, additively, and the seam match ignores it', () => {
  assert.match(src, /^\/\/ ChartBridge 0\.3\.(4\.1|[5-9]) for NinjaTrader 8/);
  assert.match(code, /public const string Version = "0\.3\.(4\.1|[5-9])";/);
  const md = bodyOf(code, 'private static void OnMarketData(');
  // Bid and Ask updates only move the quote: nothing is sent or held for them
  const quote = md.slice(0, md.indexOf('if (type != MarketDataType.Last) return;') + 45);
  assert.match(quote, /NoteQuote\(type == MarketDataType\.Bid, e\.Price, e\.Time\);[\s\S]*if \(type != MarketDataType\.Last\) return;/);
  assert.ok(!/Send\(|Pending/.test(quote), 'a quote update sends or holds nothing');
  // the live tick keeps 0.3.3's fields in order and adds s and sm at the end
  assert.match(md, /",\\"p\\":" \+ CbJson\.Num\(e\.Price\) \+ ",\\"v\\":" \+ e\.Volume\.ToString\(CultureInfo\.InvariantCulture\) \+\s*",\\"s\\":" \+ side\.ToString\(CultureInfo\.InvariantCulture\) \+ ",\\"sm\\":" \+ method\.ToString\(CultureInfo\.InvariantCulture\) \+ ChartBridgeSides\.QJson\(cat\) \+ "\}"/);   // 0.3.8: then q, when known
  // backfill trades: t, p, v first, then s and sm
  // (0.3.5: written by AppendTrade with no string per number; WindowHarness.cs checks the text is 0.3.4's)
  assert.match(bodyOf(code, 'private static void SendTicks(Load L, RawBars bars, int from)'), /AppendTrade\(b, bars, i, et\);/);
  assert.match(bodyOf(code, 'public static void AppendTrade('), /CbJson\.AppendNum3\(b, et\.Seconds\(bars\.Time\[i\]\)\);\s*b\.Append\(','\);\s*CbJson\.AppendNum\(b, bars\.Close\[i\]\);\s*b\.Append\(','\);\s*CbJson\.AppendLong\(b, bars\.Volume\[i\]\);\s*int q = bars\.QCode != null \? ChartBridgeSides\.QOf\(bars\.QCode\[i\]\) : ChartBridgeSides\.NoQ;\s*if \(q != ChartBridgeSides\.NoQ\) \{ b\.Append\(",null,null,"\); CbJson\.AppendLong\(b, q\); \}\s*b\.Append\(']'\);/);   // 0.3.7: [t, p, v] only (the sided by-date backfill is removed); 0.3.8: [t, p, v, null, null, q] when q is known
  // the seam's match key is still price and volume only
  assert.match(code, /private static string TradeKey\(double p, long v\)/);
  assert.match(code, /public struct SeamTick\s*\{\s*public DateTime Time;\s*public double Price;\s*public long Volume;\s*public string Json;/);
  assert.match(code, /string k = TradeKey\(backPrice\[i\], backVolume\[i\]\);/);
  // 0.3.7: no Bid or Ask history is asked any more (it went with the by-date load); the release is one outbox entry
  assert.ok(!/QuoteWaitMs|L\.Waiting|RequestQuotes/.test(code), 'the quote wait and requests are gone');
  // review 2 S1: two lanes; order traffic ahead of queued market data; a draining page is not closed at 5,000
  // review 3: a page more than 5 s behind is reconnected (no entry cap); a send racing a Close is dropped quietly
  assert.match(code, /private readonly BlockingCollection<object> outbox = new BlockingCollection<object>\(new ConcurrentQueue<object>\(\)\);/);
  assert.match(code, /public const int SoftCap = 5000;\s*public const double StuckMs = 2000, MaxLagMs = 5000;/);
  assert.match(code, /if \(age > MaxLagMs\) \{ NotKeepingUp\(age\); return true; \}/);
  assert.match(code, /catch \(InvalidOperationException\) \{ \}/);
  // review 4: a close always ends the connection; the page's own bulk sends are not lag; a load queues few chunks ahead
  assert.match(bodyOf(code, 'public void Close()'), /try \{ if \(Socket != null\) Socket\.Abort\(\); \} catch \(Exception\) \{ \}/);
  assert.match(code, /long waited = Stopwatch\.GetTimestamp\(\) - q\.At - \(Interlocked\.Read\(ref bulkSpent\) - q\.Bulk\);/);
  for (const f of ['private static void SendBars(', 'private static void SendTicks(Load L, RawBars bars, int from)']) assert.match(bodyOf(code, f), /if \(!L\.Client\.WaitForBulkRoom\(\)\) return;/);
  assert.match(code, /OrderLaneTypes = \{ "hello", "trading", "orders", "order", "position", "reject", "exec", "execs", "status", "pong" \};/);
  assert.match(code, /if \(outbox\.Count >= SoftCap && Stuck\(\)\) \{ NotKeepingUp\(null\); return true; \}/);
  // review 2 S2: a reset is never a trade; a Last without a real price never reaches the order code
  const md2 = bodyOf(code, 'private static void OnMarketData(');
  assert.ok(md2.indexOf('if (e.IsReset)') < md2.indexOf('ChartBridgeOrders.NoteLast('), 'IsReset handled before NoteLast');
  assert.match(md2, /if \(e\.IsReset\)[\s\S]*?ClearQuote\(\);[\s\S]*?return;\s*\}/);
  assert.ok(md2.indexOf('if (!(e.Price > 0)) return;') >= 0 && md2.indexOf('if (!(e.Price > 0)) return;') < md2.indexOf('ChartBridgeOrders.NoteLast('), 'price checked before NoteLast');
  // 0.3.7: no request ever asks for Bid or Ask history
  assert.ok(!/MarketDataType = (type|MarketDataType\.(Bid|Ask))/.test(code), 'no Bid or Ask request');
  assert.match(bodyOf(code, 'private static string DiagJson()'), /b\.Append\(",\\"sides\\":"\)\.Append\(SidesJson\(\)\);/);
  const orders = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'orders.sh'), 'utf8');
  assert.match(orders, /check\/SidesHarness\.cs/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'OrdersHarness.cs'), 'utf8'), /SidesHarness\.Run\(Check\);/);
});

// ---- 0.3.5: the served window and the session's volume at price (behaviour: nt8/check/WindowHarness.cs under Mono)
test('0.3.5: every tick chart gets the served window by count, one request at a time; the profile comes from the session table', () => {
  assert.match(src, /^\/\/ ChartBridge 0\.3\.[5-9] for NinjaTrader 8/);   // 0.3.6 adds the daily bars on top
  assert.match(code, /public const string Version = "0\.3\.[5-9]";/);
  assert.match(bodyOf(code, 'private static string HelloJsonFor('), /\\"features\\":\[\\"liveFirst\\",\\"profile\\",\\"settlement\\",\\"htf\\",\\"weekProfile\\"\]/);   // 0.3.7 adds three
  // S6: every tick chart (liveFirst or not) gets the served window; 0.3.7: the by-date tick load is gone
  assert.match(bodyOf(code, 'private static void StartLoad('), /Window = tickHours > 0, /);
  assert.ok(!/ByDateTickLoads/.test(code));
  assert.match(bodyOf(code, 'private static void RequestTicks('), /if \(L\.Window\) \{ ServeWindow\(L\); return; \}/);
  // B2: one window request per instrument: loads wait on it; a failure is not re-asked for WindowRetryMs; two asks at most
  const serve = bodyOf(code, 'private static void ServeWindow(');
  assert.match(serve, /bool backoff = book\.WindowFailedMs >= 0 && nowMs - book\.WindowFailedMs < WindowRetryMs;/);
  assert.match(serve, /else if \(backoff\) none = true;/);
  // review 4 B1: a load never waits on a stuck gate (it goes live with the reason); S4: a gapped window is kept unless the ask can go now
  assert.match(serve, /if \(book\.WindowAsking && stuck == null\) \{ book\.WindowWaiters\.Add\(L\);/);
  assert.match(serve, /if \(stuck != null\) \{ none = true; if \(L\.Diag != null\) L\.Diag\.Error = StuckNote\(stuck\); \}/);
  assert.match(serve, /book\.CacheGap && stuck == null && !backoff && !book\.WindowAsking/);
  assert.match(bodyOf(code, 'private static bool ServeFromCache('), /view = book\.Cache\.Snapshot\(\); book\.Cache\.Served\+\+; L\.Client\.Pending\.Clear\(\);/);
  const askw = bodyOf(code, 'private static void AskWindow(');
  assert.match(askw, /new BarsRequest\(inst, count\)/);
  assert.match(askw, /GateEnqueue\(j\);/);
  // review 3 S-D: the second ask decided on the callback and queued before the gate goes on (windows before backfills)
  assert.match(askw, /round < 2;/);
  assert.match(askw, /if \(again\) AskWindow\(book, inst, gen, Math\.Min\(WindowMaxTicks, count \* 3\), round \+ 1\);\s*done\(\);/);
  // review 3 X1: a given-up request stays outstanding: nothing else goes; its late answer is dropped, not copied
  // review 4 S1: each request is claimed once (the answer or the timeout), by compare-and-swap
  assert.match(code, /private static bool Claim\(GateJob j\) \{ return Interlocked\.CompareExchange\(ref j\.State, 1, 0\) == 0; \}/);
  assert.match(bodyOf(code, 'private static void GateLoop('), /if \(!answered && Interlocked\.CompareExchange\(ref j\.State, 2, 0\) == 0\)/);
  // review 5 N2: the wait for an answer that claimed it at the limit is bounded; past it the gate shows it stuck
  assert.match(bodyOf(code, 'private static void GateLoop('), /else if \(!answered && !done\.Wait\(AnswerCopyMs, stop\)\)/);
  // review 5 N6: Stop() ends the gate's worker (joined, bounded) and cancels the backfill retries' timers
  // review 6 S2: Stop() waits only 250 ms for the worker on NinjaTrader's thread; the harness waits 5 s
  assert.match(bodyOf(code, 'public static void Stop('), /StopGate\(250\);/);
  assert.match(code, /public static void StopGate\(int joinMs = 5000\)/);
  assert.match(bodyOf(code, 'public static void StopGate('), /gateStopped = true;[\s\S]*stop\.Cancel\(\);[\s\S]*worker\.Wait\(joinMs\)/);
  // review 6 S1: after a stop nothing is queued, no worker starts, no tail goes, and a late answer is dropped uncopied
  assert.match(bodyOf(code, 'private static void GateEnqueue('), /stopped = gateStopped;[\s\S]*if \(!stopped && [^\n]*\.Add\(j\);[\s\S]*if \(stopped\) \{ Dropped\(j\); return; \}/);   // lf7 N1: its waiters answered
  assert.match(bodyOf(code, 'private static void GateKick('), /if \(gateStopped \|\| gateRunning/);
  assert.match(bodyOf(code, 'private static bool BeginTail('), /if \(gateStopped \|\| gateStuck != null/);
  assert.match(bodyOf(code, 'public static bool Start('), /StartGate\(\);/);
  assert.equal((code.match(/if \(j\.Stop\.IsCancellationRequested\) \{ try \{ req\.Dispose\(\); \} catch \(Exception\) \{ \} return; \}/g) || []).length, 3);   // window, backfill, 0.3.7 htf
  // lf7 N2, N3: a timeout after a stop never marks the gate stuck; a stop between taking a job and sending it sends nothing
  assert.match(bodyOf(code, 'private static void GateTimedOut('), /if \(j\.Stop\.IsCancellationRequested \|\| gateStopped\) return;/);
  assert.match(bodyOf(code, 'private static void GateLoop('), /lock \(GateLock\) stoppedNow = stop\.IsCancellationRequested \|\| gateStopped;\s*if \(stoppedNow\) \{ Dropped\(j\); return; \}\s*ManualResetEventSlim done/);
  // review 6 N1: only the request that made the gate stuck frees it; N2: the worker has its own thread
  assert.match(bodyOf(code, 'private static void GateUnstuck('), /if \(gateStuckJob != j\) backfills = null;/);
  assert.match(bodyOf(code, 'private static void GateKick('), /TaskCreationOptions\.LongRunning/);
  assert.match(code, /Task\.Delay\(BackfillRetryMs, ask\.Stop\)/);
  assert.match(bodyOf(code, 'private static void GateLoop('), /j\.Stop = stop;/);
  assert.doesNotMatch(bodyOf(code, 'private static void GateLoop('), /Thread\.Sleep/);
  assert.match(code, /public static int AnswerCopyMs = 30000;/);
  // review 5 S1: a queued retry waits too, and gets its state back
  assert.match(bodyOf(code, 'private static void BackfillWaits('), /book\.BackfillState\.StartsWith\("failed once", StringComparison\.Ordinal\)/);
  assert.match(bodyOf(code, 'private static void BackfillWaits('), /book\.BackfillState = book\.BackfillWaitWas \?\? "queued";/);
  assert.match(askw, /if \(!Claim\(j\)\) \{ try \{ req\.Dispose\(\); \} catch \(Exception\) \{ \} if \(LateAnswer\(j\)\) GateUnstuck\(j, "window " \+ book\.Root\); return; \}/);
  assert.match(bodyOf(code, 'private static void RunBackfill('), /if \(!Claim\(j\)\) \{ try \{ req\.Dispose\(\); \} catch \(Exception\) \{ \} if \(LateAnswer\(j\)\) GateUnstuck\(j, /);
  // review 5 (found in its race2 probe): a late answer during the marking never frees the gate before it is marked stuck
  assert.match(code, /private static bool LateAnswer\(GateJob j\) \{ return Interlocked\.CompareExchange\(ref j\.State, 4, 2\) != 2; \}/);
  assert.match(bodyOf(code, 'private static void GateLoop('), /GateTimedOut\(j\);\s*if \(Interlocked\.CompareExchange\(ref j\.State, 3, 2\) != 2\) GateUnstuck\(/);
  assert.match(askw, /j\.OnStuck = what => WindowFailed\(book, gen, StuckNote\(what\), false\);/);
  assert.ok(!/RequestQuotes/.test(serve + askw + bodyOf(code, 'private static void OnWindowAnswer(') + bodyOf(code, 'private static void FinishWindow(')), 'no quote request for a window');
  // one tick request to NinjaTrader at a time: windows first, a backfill only with nothing else out (no minute tail either)
  const next = bodyOf(code, 'private static GateJob GateNext(');
  assert.match(next, /if \(gateStuck != null\) return null;/);
  // 0.3.6: with no backfill queued, a daily bars request goes last (no minute tail out, no page loading); else as 0.3.5
  // 0.3.7: higher-timeframe requests a page asked for go there too, ahead of daily bars
  assert.match(next, /if \(GateBackfills\.Count == 0\)\s*\{[\s\S]*?if \(\(GateHtfJobs\.Count == 0 && GateBarJobs\.Count == 0\) \|\| tailsOut > 0\) return null;\s*if \(PageLoading\(\)\) \{ wait = true; return null; \}[\s\S]*?\}\s*if \(tailsOut > 0\) return null;/);
  assert.match(bodyOf(code, 'private static void RequestTicks('), /if \(!BeginTail\(\)\)/);
  // on NinjaTrader's callback thread only the copy (timed); the rest on a worker
  for (const f of ['private static void AskWindow(', 'private static void RunBackfill(']) {
    const b = bodyOf(code, f);
    assert.match(b, /Stopwatch sw = Stopwatch\.StartNew\(\);/);
    assert.match(b, /Task\.Run\(\(\) => /);
  }
  // the market data handler feeds the book and the pages under the book's lock (then Pending): snapshots are exact
  const md = bodyOf(code, 'private static void OnMarketData(');
  assert.match(md, /lock \(book\.Sync\)\s*\{\s*DateTime nowNt = book\.InTable\(e\.Time\) \? DateTime\.MinValue : NowNt\(\);[^\n]*\s*book\.OnTrade\(/);
  assert.ok(md.indexOf('book.OnTrade(') < md.indexOf('c.Pending.Add('), 'the book takes the trade before any page holds it');
  // S4: ready: the profile copied under the lock, formatted with none held; then ready, then the released trades
  const ready = bodyOf(code, 'private static void MarkReady(Load L, RawBars seam)');
  assert.match(ready, /snap = book\.Snap\(\);\s*before = new List<SeamTick>\(client\.Pending\);\s*\}/);
  assert.match(ready, /profile = snap\.Json\(L\.Sub, early\.Release\);\s*\}\s*lock \(client\.Pending\)/);
  assert.match(ready, /if \(profile != null\) burst\.Add\(profile\);\s*burst\.Add\("\{\\"type\\":\\"ready\\"/);
  // the one backfill: profileRoots only, not for a whole table, by date from the session start; one retry, then given up
  assert.match(code, /public static string\[\] ProfileRoots = new string\[\] \{ "MNQ", "NQ", "ES", "MES" \};/);
  assert.match(code, /public static bool BackfillOn = true;/);
  assert.match(bodyOf(code, 'private static void RunBackfill('), /if \(table == null \|\| table\.Whole \|\| book\.BackfillLive == null\)/);
  assert.match(bodyOf(code, 'private static void RunBackfill('), /new BarsRequest\(inst, table\.Start, /);
  const fin = bodyOf(code, 'private static void FinishBackfill(');
  assert.match(fin, /ChartBridgeSeam\.Dedupe\(raw\.Time, raw\.Close, raw\.Volume, raw\.Count, book\.BackfillLive, heldAtAnswer\)/);
  assert.match(fin, /retry = !ask\.Retry;/);
  // no older-history pull, no quote start, no 120 hour cap
  assert.ok(!/olderTicks|"more"|FillState|QuoteStart|TickHoursCap|lastWindowLoadMs/.test(code), 'the older history pull and its pieces are gone');
  assert.match(code, /int tickHours = hm\.Success \? Math\.Max\(0, Math\.Min\(48, /);
  assert.match(bodyOf(code, 'private static string DiagJson()'), /b\.Append\(",\\"books\\":"\)\.Append\(BooksJson\(\)\);/);
  const orders = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'orders.sh'), 'utf8');
  assert.match(orders, /check\/WindowHarness\.cs/);
});

test('0.3.5: a HEAD request gets headers only (HttpListener refuses a body on a HEAD reply: it was a 500 and an Output line)', () => {
  // Mono's HttpListener drops such a body quietly, so the harness (PinHarness) cannot show the old failure: the source must
  // write a body in one place only, and never for HEAD.
  for (const f of ['ChartBridge.cs', 'ChartBridgeOrders.cs', 'ChartBridgePin.cs']) {
    const c = fs.readFileSync(path.join(__dirname, '..', 'nt8', f), 'utf8');
    const writes = c.match(/OutputStream\.Write\(/g) || [];
    assert.equal(writes.length, f === 'ChartBridge.cs' ? 1 : 0, f + ': body writes');
  }
  const wb = bodyOf(code, 'private static void WriteBody(');
  assert.match(wb, /res\.ContentLength64 = body\.Length;\s*if \(!IsHead\(ctx\)\) res\.OutputStream\.Write\(body, 0, body\.Length\);\s*res\.Close\(\);/);
  assert.match(bodyOf(code, 'private static bool IsHead('), /string\.Equals\(ctx\.Request\.HttpMethod, "HEAD", StringComparison\.OrdinalIgnoreCase\)/);
});

// ---- 0.3.7: quoteHours went with the by-date tick load (removed; 0.3.5 replaced it with the served window)
test('0.3.7: the by-date tick load and its Bid and Ask history are removed; a quoteHours line is only noted', () => {
  for (const gone of ['RequestTickHistory', 'RequestQuotes', 'BeginQuotes', 'QuoteAnswered', 'QuotesOutstanding', 'QuoteWindowHours', 'ParseQuoteHours', 'ByDateTickLoads', 'ClassifyLoad', 'ContinueSides', 'NoteSides', 'LastLoadSides', 'CopyTicks', 'TickToMargin;', 'ClassifyBackfill', 'QuoteSeries', 'ContinueTickRule', 'BackfillSides', 'QuoteEndSlack'])
    assert.ok(!code.includes(gone), gone + ' is gone');
  assert.ok(!/public static int QuoteHours/.test(code), 'no quoteHours setting');
  assert.match(bodyOf(code, 'public static void Load()'), /else if \(key == "quoteHours"\) ChartBridgeServer\.Log\("config\.txt: quoteHours is no longer used/);
  const harness = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'SidesHarness.cs'), 'utf8');
  assert.ok(!/QuoteHoursCases|ByDateTickLoads/.test(harness));
  // every tick chart load goes to the served window; minute and hour charts keep their 20,000 last trades for the forming minute
  const rt = bodyOf(code, 'private static void RequestTicks(');
  assert.match(rt, /if \(L\.Window\) \{ ServeWindow\(L\); return; \}/);
  assert.match(rt, /new BarsRequest\(L\.Inst, SeamTicksBack\)/);
});

// ---- 0.3.7 data side (behaviour: nt8/check/DataHarness.cs under Mono)
test('0.3.7: settlement only from NinjaTrader, higher-timeframe bars only through the gate, the weekly profile never asks', () => {
  const note = bodyOf(code, 'public static void NoteSettlement(string root, string contract,');
  assert.match(note, /!\(price > 0\)\) return;/, 'only a real price');
  assert.match(note, /DateTime\? day = SettlementDay\(ntTime, NowNt\(\), out provisional\);/, 'every value dated from NinjaTrader\'s time on it (0.3.8: and whether it is in the 16:00 to 17:00 buffer)');
  assert.match(bodyOf(code, 'private static void PriorSettlement('), /ChartBridgeCme\.PreviousSession\(ChartBridgeCme\.CurrentSession\(/);
  assert.match(bodyOf(code, 'public static bool Start('), /LoadSettlementsSoon\(\);[^\n]*\n\s*SubscribeMarketData\(\);/);   // read off NinjaTrader's thread
  // review B2: answers built outside HtfLock, one waiter per page, the 15 s limit
  assert.match(code, /HtfTimeoutMs = 15000/);
  for (const f of ['private static void HtfAnswered(', 'private static void HtfFailed(', 'private static void HtfServe(']) {
    const b = bodyOf(code, f), lockAt = b.indexOf('lock (HtfLock)'), lockBody = b.slice(lockAt, b.indexOf('\n            }', lockAt));
    assert.ok(!/HtfJson\(|HtfBarsText\(/.test(lockBody), f + ' formats nothing under HtfLock');
  }
  assert.match(bodyOf(code, 'private static void AddWaiter('), /if \(s\.Waiters\[i\]\.Key == client\)/);
  assert.match(bodyOf(code, 'private static void SubscribeMarketData('), /MarketDataEventArgs st = md\.Settlement;/);
  const md = bodyOf(code, 'private static void OnMarketData(');
  assert.ok(md.indexOf('if (e.IsReset)') < md.indexOf('MarketDataType.Settlement'), 'a reset is never a settlement');
  // the one BarsRequest of the htf code is in HtfRun, started by the gate's worker; the request is a FreesGate job
  for (const f of ['private static void OnHtfMessage(', 'private static void HtfServe(', 'private static void HtfAsk(', 'private static void HtfAnswered(', 'private static void HtfPush(', 'private static void HtfOnTrade('])
    assert.ok(!/new BarsRequest/.test(bodyOf(code, f)), f + ' asks NinjaTrader nothing');
  assert.match(bodyOf(code, 'private static void HtfAsk('), /new GateJob \{ Kind = "htf", Root = s\.Root \+ " " \+ s\.Tf, TimeoutMs = HtfTimeoutMs, FreesGate = true \};[\s\S]*j\.Start = done => HtfRun\(/);
  assert.match(bodyOf(code, 'private static void HtfRun('), /new BarsRequest\(inst, HtfBarsBack\)/);
  for (const f of ['private static void OnWeekProfileMessage(', 'public static string WeekProfileJson('])
    assert.ok(!/BarsRequest|GateEnqueue|GateKick/.test(bodyOf(code, f)), f + ' never asks NinjaTrader');
  // the new messages are strict and documented
  assert.match(bodyOf(code, 'private static void OnHtfMessage('), /ParseStrict\(text, new\[\] \{ "type", "root", "tf" \}, new\[\] \{ "id" \}, out why\)/);
  assert.match(bodyOf(code, 'private static void OnWeekProfileMessage('), /ParseStrict\(text, new\[\] \{ "type", "root" \}, new\[\] \{ "id" \}, out why\)/);
  const proto = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'PROTOCOL.md'), 'utf8');
  for (const t of ['settlement', 'htf', 'htfBar', 'weekProfile']) assert.match(proto, new RegExp('\\| `' + t + '` \\|'), t + ' in PROTOCOL.md');
  assert.ok(!/[\u2013\u2014]/.test(proto), 'no em or en dashes in PROTOCOL.md');
});

test('0.3.8 q: the Time and Sales category comes from the side tagger\'s quote, with no request and no string made per trade', () => {
  const tag = code.slice(code.indexOf('out int method, out int cat)'), code.indexOf('public string DiagJson()', code.indexOf('out int method, out int cat)')));
  assert.match(tag, /int s = ChartBridgeSides\.Classify\(price, q \? b : double\.NaN, q \? a : double\.NaN[^\n]*\n\s*cat = q \? ChartBridgeSides\.Category\(price, b, a\) : ChartBridgeSides\.NoQ;/,
    'q is read from the very quote the side was classified by (b, a), unknown without one');
  assert.match(code, /\+ ChartBridgeSides\.QJson\(cat\) \+ "\}";/, 'the live tick ends with the q field from QJson');
  assert.match(code, /private static readonly string\[\] QFields = /, 'the five q fields are made once');
  assert.ok(!/cat\.ToString\(|QJson\([^)]*\)\.ToString|"\\"q\\":" \+/.test(code), 'no q string made per trade');
  assert.match(code, /cache\.Add\(h\.Time, h\.Price, h\.Volume, h\.QCode\)/, 'the held live trades keep their q in the served window');
  assert.match(code, /for \(int i = start; i < raw\.Count; i\+\+\) cache\.Add\(raw\.Time\[i\], raw\.Close\[i\], raw\.Volume\[i\]\);/, 'NinjaTrader\'s answer has no stored quote: unknown');
});
