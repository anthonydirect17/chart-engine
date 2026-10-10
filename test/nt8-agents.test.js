'use strict';
// Guards on the agent channel's source (nt8/ChartBridgeAgents.cs, ChartBridge 0.5.0). NinjaTrader cannot run here; the behaviour
// is checked under Mono in nt8/check/AgentHarness.cs (inside npm run check:orders). These check where the order calls are, that
// every entry passes the owner lock, the hard ceiling, the secret, and the hooks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const nt8 = path.join(__dirname, '..', 'nt8');
const strip = t => t.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '').replace(/([;{})])\s*\/\/.*$/, '$1')).join('\n');
const read = f => fs.readFileSync(path.join(nt8, f), 'utf8');
const acode = strip(read('ChartBridgeAgents.cs'));
const ocode = strip(read('ChartBridgeOrders.cs'));
const ccode = strip(read('ChartBridgeCopier.cs'));
const main = strip(read('ChartBridge.cs'));

// Every body of a method with this name (any class in the file).
function bodies(code, name) {
  const out = [], re = new RegExp('\\b(?:public|private|internal)\\s+(?:static\\s+)?[\\w<>\\[\\], ]+\\s' + name + '\\(', 'g');
  let m;
  while ((m = re.exec(code))) {
    const i = code.indexOf('{', m.index);
    let depth = 0, end = code.length;
    for (let j = i; j < code.length; j++) { if (code[j] === '{') depth++; else if (code[j] === '}' && --depth === 0) { end = j + 1; break; } }
    out.push(code.slice(m.index, end));
  }
  assert.ok(out.length > 0, name + ' not found');
  return out.join('\n');
}

test('0.5.0 agents: the new file ships, is compile-checked and harnessed', () => {
  assert.ok(JSON.parse(read('install-files.json')).addons.includes('nt8/ChartBridgeAgents.cs'));
  for (const f of ['check.sh', 'orders.sh']) assert.match(read(path.join('check', f)), /ChartBridgeBot\.cs ChartBridgeAgents\.cs ChartBridgeStrategies\.cs/);
  assert.match(read(path.join('check', 'orders.sh')), /check\/AgentHarness\.cs/);
  assert.match(read(path.join('check', 'OrdersHarness.cs')), /Section\("agents \(0\.5\.0\)", AgentHarness\.Run\);/);
  assert.match(main, /public const string Version = "0\.5\.[0-3]";/);   // 0.5.1: the accounts follow NinjaTrader, on top of 0.5.0; 0.5.3: the agents' MNQ cap
  assert.ok(!/(^|[\s(=,+:?])\$"/m.test(acode) && !/\?\.\w/.test(acode) && !/\bnameof\(/.test(acode), 'C# 5');
});

test('0.5.0 agents: order calls only where the contract allows; never a market entry, never a flatten call', () => {
  let rest = acode;
  for (const f of ['SendCancel', 'StepFlatten', 'SendClose', 'SendStop']) rest = rest.replace(bodies(acode, f), '');
  for (const re of [/\.Submit\s*\(/, /\.CreateOrder\s*\(/, /\.Change\s*\(/, /\.Cancel\s*\(/, /\.Flatten\s*\(/, /CancelAllOrders/, /\bAtm\w*\./])
    assert.ok(!re.test(rest), 'order call outside SendCancel, StepFlatten, SendClose and SendStop: ' + re);
  assert.ok(!/\.Flatten\s*\(|\.Change\s*\(/.test(acode), 'never NinjaTrader\'s Flatten, never a change');
  // the one order it creates itself is the flatten's market close, under the order lock, after reading both positions again
  const close = bodies(acode, 'SendClose');
  assert.equal((close.match(/\.CreateOrder\(/g) || []).length, 1);
  assert.match(close, /OrderType\.Market/);
  assert.match(close, /lock \(ChartBridgeOrders\.AgentPlaceLock\)[\s\S]*AgentListed[\s\S]*AgentEffective[\s\S]*AgentMayFill[\s\S]*\.CreateOrder\(/);
  assert.match(close, /qty > Math\.Min\(Math\.Abs\(p1\), Math\.Abs\(p2\)\)\) return null;/, 'never more than either reading shows');
  // a cancel of its own entry only (never a stop or a target), resent every 3 s while it works, or every order there in a
  // flatten of a pair it owns
  assert.match(bodies(acode, 'Cancel'), /!IsMyEntry\(o\)\) return false;/);
  // review A4: never while the account is not Connected; every 3 s, from the 10th try every 30 s
  assert.match(bodies(acode, 'ResendCancels'), /acc\.Connection\.Status != ConnectionStatus\.Connected\) continue;/);
  assert.match(bodies(acode, 'ResendCancels'), /double every = kv\.Value\.Tries >= ChartBridgeAgents\.CancelSlowAfter \? ChartBridgeAgents\.CancelSlowMs : ChartBridgeAgents\.FlatRetryMs;\s*if \(now - kv\.Value\.LastMs >= every\)/);
  // review A1 and A2: nothing sent while the market is shut; the pair asked again before every close, never more than its trade
  const step = bodies(acode, 'StepFlatten');
  // the 0.5.2 review: the calendar's closures and halts too (ChartBridgeCme.Closed), as check 7
  assert.match(step, /DateTime etShut = NowEt\(\);\s*bool shut = ChartBridgeAgents\.MarketShut\(etShut\) \|\| ChartBridgeCme\.Closed\(etShut\);/);
  assert.match(step, /if \(!OwnsContract\(j\.Root, inst, a\)\) \{ DropJob\(j, key, a\); continue; \}\s*int cap = CloseCap\(j\.Root, inst, j\);[\s\S]*qty = Math\.Min\(qty, cap\);\s*if \(qty > 0\)/);
  // review A C1: the stop placed again over a shut market is a stop (never a market order), under the order lock, re-read first
  const restop = bodies(acode, 'SendStop');
  assert.equal((restop.match(/\.CreateOrder\(/g) || []).length, 1);
  assert.match(restop, /OrderType\.StopMarket, OrderEntry\.Manual, TimeInForce\.Gtc/);
  assert.match(restop, /lock \(ChartBridgeOrders\.AgentPlaceLock\)[\s\S]*AgentListed[\s\S]*AgentEffective[\s\S]*\.CreateOrder\(/);
  assert.match(step, /!ChartBridgeOrders\.AgentFreshLast\(j\.Root, ChartBridgeAgents\.TradingFreshMs, out lastPx\)/, 'no leg cancelled while the market is not trading');
  // review D4 and E3: helloed set at the hello as before; agentState waits for welcomeSent, set only after the welcome is queued
  const hello = bodies(acode, 'OnHello');
  const w = hello.indexOf('ToAgent(WelcomeJson(served));');
  assert.ok(hello.indexOf('helloed = true; welcomeSent = false;') > 0 && hello.indexOf('helloed = true; welcomeSent = false;') < w && w < hello.indexOf('welcomeSent = true;'), 'welcomeSent set after the welcome');
  assert.match(bodies(acode, 'SendState'), /lock \(Sync\) c = helloed && welcomeSent \? client : null;/);
  // review A C3: agentState is built before StateLock is taken; the lock only compares and sends
  const send = bodies(acode, 'SendState');
  assert.ok(send.indexOf('string json = StateJson();') > 0 && send.indexOf('string json = StateJson();') < send.indexOf('lock (StateLock)'), 'the state is built outside StateLock');
  // contract section 10: an agent entry's protective exit is named for the agent; its legs keep v2's names (the entry's tag)
  assert.match(bodies(ocode, 'PlaceLegs'), /agentOf != null \? "CB#" \+ br\.Tag \+ " ag:" \+ agentOf \+ " protect f" \+ filled\.ToString\(CultureInfo\.InvariantCulture\) : "CB#" \+ br\.Tag \+ " exit" \+ mark/);
  assert.match(bodies(acode, 'SendCancel'), /try \{ o\.Account\.Cancel\(new\[\] \{ o \}\); \}\s*catch \(Exception ex\)/);
  assert.match(bodies(acode, 'StepFlatten'), /may\.Where\(o => o != j\.Close && \(j\.Owned \|\| \(IsMine\(o\) && !\(IsReStop\(o\) && \(p1 != 0 \|\| p2 != 0\)\)\)\)\)/, 'a pair it does not own: only its own orders, never its stop placed again over a position');
  // every entry goes through ChartBridgeOrders.PlaceAgentEntry: the page's order path with the agent as its source
  assert.match(bodies(acode, 'Place'), /ChartBridgeOrders\.PlaceAgentEntry\(Id, text, out placed\)/);
  assert.match(bodies(acode, 'Place'), /string why = Checks\(p, forAccount, forAccount != null, out acct\);/, 'every check again at the moment of placing, and the account they validated is the one used');
  for (const f of ['SetMode', 'SetKill', 'SetAccount', 'SetRules']) assert.match(bodies(acode, f), /lock \(PlaceGate\) return \w+Locked\(d\);/, f + ' waits for a placement under way');
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) \{ string agentWhy = ChartBridgeAgents\.PlacingProblem\(agent, kind, isBuy, price, limitPx, tick\);/, 'the order path asks the agent at the last moment');
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null && \(\(kind != "limit" && kind != "stopLimit"\) \|\| strategyBody != null \|\| bracketBody == null\)\) return/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null && \(stopTicks < 1 \|\| targetTicks < 1\)\) return "every agent entry needs a stop and a target";/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) cap = AgentEntryCap\(agent, root, out capWhy\);/);   // 0.5.3 review: same cap, its words named
  assert.match(bodies(acode, 'AgentEntryCap'), /int own = ChartBridgeAgents\.CapFor\(agent, root\), conf = AgentCap\(root\);\s*if \(conf < own\) \{[^}]*return conf; \}[\s\S]*return own;/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) name = "CB#" \+ tag \+ " ag:" \+ agent \+ " s" \+ stopTicks \+ " t" \+ targetTicks;/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /TimeInForce\.Day/);
});

test('0.5.0 agents: the owner lock is in the one choke point for page, bot and agent entries, and in the copier\'s Eligible', () => {
  const place = bodies(ocode, 'PlaceOrderLocked');
  const at = place.indexOf('ChartBridgeAgents.EntryCheck(');
  assert.ok(at > 0 && at < place.indexOf('account.Submit('), 'checked before the order is sent');
  assert.ok(at < place.indexOf('CreateOrder('), 'and before it is made');
  assert.match(place, /string ownerWhy = pageReduces \? null : ChartBridgeAgents\.EntryCheck\(agent != null \? "agent:" \+ agent : bot \? "bot" : "page", account, root\);\s*if \(ownerWhy != null\) return ownerWhy;/);
  assert.match(place, /pageReduces = pn \* along > 0 && pe \* along > 0 && rq <= Math\.Min\(Math\.Abs\(pn\), Math\.Abs\(pe\)\);/, 'only an order that reduces by both readings passes as an exit');
  const elig = bodies(ccode, 'Eligible');
  assert.ok(elig.indexOf('ChartBridgeAgents.EntryCheck("copier", a, fRoot)') > 0, 'the copier\'s entries ask too');
  // PlaceAgentEntry is the page's own strict reading and quote-only check
  assert.match(bodies(acode, 'PlaceAgentEntry'), /TopLevel\("order", text, out bracketBody, out why\);\s*if \(why == null\) why = QuoteOnly\(top, null\);\s*return why \?\? PlaceOrder\(top, bracketBody, null, null, false, agentId, out placed\);/);
});

test('0.5.0 agents: the hard ceiling is a constant; the secret is never logged; every start is shadow', () => {
  const ceil = bodies(acode, 'HardCeiling');
  assert.match(ceil, /case "NQ": return 2;\s*case "ES": return 2;\s*case "MNQ": return 20;\s*case "MES": return 20;\s*default: return 0;/);
  assert.match(bodies(acode, 'CapFor'), /Math\.Min\(HardCeiling\(root\), a\.MaxQtyFor\(root\)\)/);
  assert.ok(!/Log\([^;]*\+\s*(secret|given|givenSecret|s)\b(?!\.)/.test(bodies(acode, 'LoadSecret')), 'the secret is never logged');
  assert.match(bodies(acode, 'SecretMatches'), /diff \|= s\[i\] \^ given\[i\];/);
  assert.match(acode, /private string mode = "shadow";/);
  assert.match(bodies(acode, 'Start'), /mode = "shadow";/);
  assert.ok(!/trading = false|Enabled = true|ChartBridgeSwitches\.Note\(/.test(acode), 'never turns a switch on or off');
});

test('0.5.3 agents: the shipped MNQ cap of 20 is the agents\' own: maxQty.MNQ caps the page, the bot and the copier only', () => {
  assert.match(bodies(acode, 'ShippedConfigCap'), /return \(root \?\? ""\)\.ToUpperInvariant\(\) == "MNQ" \? 20 : 0;/, 'MNQ 20; nothing ships for any other root');
  assert.match(bodies(acode, 'AgentCap'), /int s = ChartBridgeAgents\.ShippedConfigCap\(root\); return s > 0 \? s : CapFor\(root\);/, 'MNQ never reads maxQty.MNQ; other roots as the page');
  assert.match(bodies(ocode, 'CapFor'), /return MaxQty\.TryGetValue\(root \?\? "", out n\) \? n : DefaultMaxQty;/, 'the page\'s, the bot\'s and the copier\'s cap is unchanged');
  assert.match(ocode, /public const int MaxActionsPerSecond = 10, DefaultMaxQty = 1;/);
  const place = bodies(ocode, 'PlaceOrderLocked');
  assert.match(place, /int cap = CapFor\(root\), pos = /, 'gate 3 starts from the page\'s cap');
  assert.match(place, /if \(agent != null\) cap = AgentEntryCap\(agent, root, out capWhy\);/, 'gate 3: an agent entry takes its own cap');
  assert.match(place, /int held = isBuy \? \(posNow < 0 && posEff < 0 \? Math\.Min\(-posNow, -posEff\) : 0\) : \(posNow > 0 && posEff > 0 \? Math\.Min\(posNow, posEff\) : 0\);/, 're-review L1: held is gate 3\'s own reading of the other side (0 once a fill made it no exit)');
  assert.match(place, /if \(exitOf != null\) \{ string ew; int ec = AgentExitCap\(exitOf, root, held, out ew\); if \(ec > cap\) \{ cap = ec; capWhy = ew; \} \}\s*if \(exitOf == null && qty > cap\) return "qty "/, 'a page exit from an agent\'s position skips the per-order qty check; its position count is held to the agent\'s cap, never below the page\'s');
  assert.match(place, /PendingOrders\(account, inst, out pendBuy, out pendSell, out loneBuy, out loneSell\);[\s\S]*?if \(exitOf != null && \(long\)loneSide \+ qty > held\)\s*return "this exit would close "/, 're-review M1: an exit with the page\'s exits still working closes at most the position');
  assert.match(place, /an exit closes at most the position[^\n]*\n\s*long worst = [^\n]*\n\s*if \(worst > cap\)/, 'the position count still applies to every order, exits too');
  assert.match(bodies(ocode, 'PendingOrders'), /if \(grp == null\) \{ if \(IsBuy\(o\)\) \{ buys \+= left; loneBuys \+= left; \} else \{ sells \+= left; loneSells \+= left; \} continue; \}/, 'lone: orders that are no bracket leg or merged set');
  assert.match(place, /string exitOf = pageReduces \? ChartBridgeAgents\.OwnerAgent\(account\.Name, root\) : null;/, 'only an exit (pageReduces) of an agent\'s pair');
  assert.match(bodies(acode, 'AgentEntryCap'), /int own = ChartBridgeAgents\.CapFor\(agent, root\), conf = AgentCap\(root\);/, 'the agent\'s rule and the hard ceiling still apply');
  assert.match(bodies(acode, 'AgentExitCap'), /int a = AgentEntryCap\(owner, root, out w\);[\s\S]*return Math\.Max\(a, held\);/, 'an exit: the agent\'s cap, or the position when larger');
  assert.match(bodies(acode, 'CapWords'), /return rule < ceil \? "agent " \+ id \+ "'s maxQty for " \+ root : "the hard ceiling of " \+ ceil \+ " for " \+ root;/, 'the words name the agent\'s rule or the hard ceiling');
  assert.ok(!/in config\.txt/.test(bodies(acode, 'CapWords')), 'never maxQty.MNQ in config.txt for an agent\'s own cap');
  assert.match(place, /" is over the " \+ root \+ " cap of " \+ cap \+ " \(" \+ capWhy \+ "\)"/, 'the words name the cap that applied');
  assert.equal((ocode + acode + ccode).match(/\bAgentCap\(/g).length, 3, 'AgentCap: its definition, AgentEntryCap (gate 3 and plan check 4) and welcome.rules only');
  assert.match(main, /else ChartBridgeOrders\.ReadConfig\(key, val\);[^\n]*\n\s*\}\s*ChartBridgeAgents\.NoteConfigCaps\(\);/, 'said once at config load, after every line is read');
  assert.match(bodies(acode, 'NoteConfigCaps'), /if \(Ids\(\)\.Count == 0\) return;[\s\S]*ChartBridgeServer\.Log\("config\.txt: maxQty\.MNQ = " \+ n \+ " caps the page's, the bot's and the copier's MNQ orders only; agents use their own MNQ cap of "/);
  assert.ok(!/MaxQty\[|MaxQty\.(Add|Remove|Clear)/.test(bodies(acode, 'NoteConfigCaps') + bodies(acode, 'AgentCap')), 'nothing in config is changed');
});

test('0.5.0 agents: the hooks in ChartBridge.cs', () => {
  assert.match(main, /if \(path == "\/agent" \|\| path\.StartsWith\("\/agent\/", StringComparison\.Ordinal\)\) \{ await ChartBridgeAgents\.Serve\(ctx, path, token\); return; \}/);
  const handle = main.slice(main.indexOf('private static async Task Handle('));
  assert.ok(handle.indexOf('ChartBridgeAccess.IsLoopback(remote)') < handle.indexOf('ChartBridgeAgents.Serve('), 'the address check comes first');
  assert.match(main, /else if \(ChartBridgeAgents\.ReadConfig\(key, val\)\) \{ \}/);
  assert.match(main, /ChartBridgeBot\.Start\(\);[^\n]*\n\s*ChartBridgeAgents\.Start\(\);/);
  assert.match(main, /ChartBridgeAgents\.Stop\(\);/);
  assert.match(main, /try \{ ChartBridgeAgents\.OnExec\(account, inst, side, qty, price, orderId, json\); \} catch/);
  assert.match(main, /try \{ ChartBridgeAgents\.OnPosition\(a, e\); \} catch/);
  assert.match(main, /if \(ChartBridgeAgents\.Enabled\) b\.Append\(",\\"agents\\":"\)\.Append\(ChartBridgeAgents\.DiagJson\(\)\);/);
  assert.match(main, /",\\"order_id\\":" \+ CbJson\.Str\(orderId\) \+ FillBy\(account, orderId, order\) \+ "\}";/, 'fills to The Desk: "by" only when known');
  assert.match(bodies(main, 'FillBy'), /if \(order != null\) \{ try \{ string own = ChartBridgeV3\.SourceOf\(order\);/, 'the execution\'s own order first (no scan)');
  assert.match(bodies(main, 'FillBy'), /return by == null \? "" : ",\\"by\\":" \+ CbJson\.Str\(by\);/, 'no by key at all when unknown');
});
