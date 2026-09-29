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
  for (const f of ['ChangeOrder', 'CancelOrder', 'Flatten', 'KeepPartner', 'CancelLeftoverLegs', 'CheckLegs', 'KeepBracket', 'ScanEntries'])
    assert.ok(!/\.CreateOrder\s*\(|\.Submit\s*\(/.test(fnBody(f)), f + ' creates orders');
  assert.match(fnBody('PlaceOrder'), /lock \(PlaceLock\) return PlaceOrderLocked\(/);
  // legs are GTC and named for their bracket and fill increment; the upkeep touches ChartBridge's own legs only
  const legs = fnBody('PlaceLegs');
  assert.equal((legs.match(/TimeInForce\.Gtc/g) || []).length, 2);
  assert.match(legs, /"CB#" \+ br\.Tag \+ " stop" \+ mark/);
  assert.match(legs, /"CB#" \+ br\.Tag \+ " target" \+ mark/);
  assert.match(legs, /\(br\.EntryIsBuy \? sp >= last : sp <= last\)/);   // a stop through the market becomes a market exit
  const keep = fnBody('KeepBracket');
  assert.match(keep, /if \(filled <= br\.Covered\) \{ GapSince\.Remove\(entry\); return; \}/);
  assert.match(keep, /Bracket rec = Recover\(entry, out pairs\);\s*lock \(Sync\)/);   // Recover reads account orders outside Sync
  // from an order event the legs are placed in full, never sized from a position read at fill time;
  // only the scan path (a gap that lasted SettleMs) reads the settled position
  assert.match(keep, /if \(fromScan\) \{ KeepBracketFromScan\(entry, br, now\); return; \}/);
  assert.match(keep, /PlaceLegs\(br, filled, inc, incPrice, where\);/);   // the event path places the full increment
  assert.ok(!/EffectivePosition/.test(keep), 'KeepBracket must not size legs from the fill-time ledger');
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
  assert.match(fnBody('PlaceOrderLocked'), /if \(\(stopTicks > 0 \|\| targetTicks > 0\) && reduces\) return/);
  assert.match(fnBody('ChangeOrder'), /OrderType\.StopLimit\) return/);
  assert.match(fnBody('PlaceOrderLocked'), /PriceProblem\(root, tick, kind, isBuy, price\)/);
  assert.match(fnBody('ChangeOrder'), /PriceProblem\(/);
});

test('the main file routes order messages only to ChartBridgeOrders, and ships both files', () => {
  assert.match(code, /ChartBridgeOrders\.OnMessage\(client, type, text\)/);
  assert.match(code, /if \(path == "\/session"\)[^\n]*\n\s*\{\s*if \(ctx\.Request\.Headers\["Host"\] != "localhost:" \+ ChartBridgeConfig\.Port\) \{ ctx\.Response\.StatusCode = 403;[^\n]*\n\s*ServeText\(ctx, ChartBridgeOrders\.SessionJson\(\), "application\/json"\);/);
  assert.match(code, /ChartBridgeOrders\.WatchConnections\(\);\s*try \{ ChartBridgeOrders\.Resume\(\); \}/);
  assert.match(code, /ChartBridgeOrders\.UnwatchConnections\(\);/);
  assert.ok(!/Access-Control-Allow-Origin/.test(code + ocode), 'no CORS headers anywhere');
  const install = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'install.ps1'), 'utf8');
  assert.match(install, /ChartBridgeOrders\.cs/);
  const check = fs.readFileSync(path.join(__dirname, '..', 'nt8', 'check', 'check.sh'), 'utf8');
  assert.match(check, /ChartBridgeOrders\.cs/);
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
