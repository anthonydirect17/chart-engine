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
  assert.match(main, /public const string Version = "0\.(5\.[0-8]|6\.[0-7])";/);   // 0.6.7: the bench, no hedging always on, a group's own rules optional; 0.6.6: the firm's limits on entries, riskAlert, firmMinimum, copierFollowerRemove; 0.6.5: each member's own rules and the risk percent; 0.6.4: no false no-trade-record alarm, the alarm cleared, Merge on an off follower; 0.6.3: the audit fixes (a missed reset caught up, closes not seen, files that survive a power cut, the kill switch kept); 0.6.2: group stand-downs and league seats; 0.6.1: a group's type and default hero; 0.6.0: group trading (seats); 0.5.8: groups and accountState; 0.5.7: the plan id, the TradeLost hold, None and the daily reset; 0.5.1: the accounts follow NinjaTrader, on top of 0.5.0; 0.5.3: the agents' MNQ cap; 0.5.4: the window while exposed; 0.5.5: the accounts line and unknown keys; 0.5.6: the time check
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
  assert.match(bodies(acode, 'Place'), /ChartBridgeOrders\.PlaceAgentEntry\(Id, p\.Id, text, out placed\)/);
  assert.match(bodies(acode, 'Place'), /string why = Checks\(p, forAccount, forAccount != null, out acct\);/, 'every check again at the moment of placing, and the account they validated is the one used');
  for (const f of ['SetMode', 'SetKill', 'SetRules']) assert.match(bodies(acode, f), /lock \(PlaceGate\) return \w+Locked\(d\);/, f + ' waits for a placement under way');
  assert.match(bodies(acode, 'SetAccount'), /lock \(PlaceGate\)\s*\{\s*why = SetAccountLocked\(d\);\s*if \(why == null\) dropped = ChartBridgeBranches\.Chosen\("agent:" \+ Id\);/, 'SetAccount waits for a placement under way (0.6.3: and drops a pending reset under the same lock)');
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) \{ string agentWhy = ChartBridgeAgents\.PlacingProblem\(agent, account\.Name, kind, isBuy, price, limitPx, tick\);/, 'the order path asks the agent at the last moment');
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null && \(\(kind != "limit" && kind != "stopLimit"\) \|\| strategyBody != null \|\| bracketBody == null\)\) return/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null && \(stopTicks < 1 \|\| targetTicks < 1\)\) return "every agent entry needs a stop and a target";/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) cap = AgentEntryCap\(agent, root, out capWhy\);/);   // 0.5.3 review: same cap, its words named
  assert.match(bodies(acode, 'AgentEntryCap'), /int own = ChartBridgeAgents\.CapFor\(agent, root\), conf = AgentCap\(root\);\s*if \(conf < own\) \{[^}]*return conf; \}[\s\S]*return own;/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) \{ name = "CB#" \+ tag \+ " ag:" \+ agent \+ " s" \+ stopTicks \+ " t" \+ targetTicks;/);
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
  assert.match(bodies(acode, 'PlaceAgentEntry'), /TopLevel\("order", text, out bracketBody, out why\);\s*if \(why == null\) why = QuoteOnly\(top, null\);\s*return why \?\? PlaceOrder\(top, bracketBody, null, null, false, agentId, planId, out placed\);/);   // 0.5.7: planId
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
  assert.match(main, /else ChartBridgeServer\.Log\("config\.txt: " \+ key \+ " is not a ChartBridge setting; the line does nothing"\);\s*\}\s*ChartBridgeAgents\.NoteConfigCaps\(\);/, 'said once at config load, after every line is read (0.5.5: after the unknown-key line)');
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

test('0.5.7 agents: planId on an agent\'s orders to a v3 page, kept in the day file as a line older ChartBridges skip', () => {
  const acc = strip(read('ChartBridgeAccounts.cs')), harness = read(path.join('check', 'AgentHarness.cs'));
  assert.match(acc, /string plan = orderJson\.Contains\(",\\"planId\\":"\) \? "" : PlanIdOf\(o\);\s*bool tradable[^\n]*\s*return orderJson\.Substring\(0, orderJson\.Length - 1\) \+ by \+ plan \+/, 'ForPage adds planId (with by and tradable)');
  assert.match(bodies(acode, 'PlanIdField'), /AgentOf\(o\) == null\) return "";/, 'only an agent\'s orders');
  assert.match(ocode, /if \(agent != null\) \{ name = "CB#" \+ tag \+ " ag:" \+ agent[^\n]*ChartBridgeAgents\.NotePlan\(tag, agentPlan\); \}/, 'noted before the order exists, so its first message carries it');
  assert.match(acode, /PlaceAgentEntry\(Id, p\.Id, text, out placed\)/);
  assert.match(acode, /internal const string TagPlanPrefix = "#tagplan\\t";/, 'a "#" line: a comment to a ChartBridge before 0.5.7');
  assert.match(bodies(acode, 'LoadDay'), /ReadTagPlan\(line, out tagOfPlan, out tagPlanId\)\) \{ if \(first \|\| !tagPlans\.ContainsKey\(tagOfPlan\)\) tagPlans\[tagOfPlan\] = tagPlanId; continue; \}\s*if \(line\.Length == 0 \|\| line\.StartsWith\("#"\)\) continue;/, 'read before the comment skip; a malformed one falls to it');
  assert.match(bodies(acode, 'SaveDayLocked'), /lines\.Add\(TagPlanPrefix \+ kv\.Key/);
  assert.match(harness, /PlanIdOnOrders\(\);/); assert.match(harness, /LostHeldInFlatten\(\);/);
});

test('0.5.7 agents: the lost-trade error is held while its own flatten job runs on that root, never dropped', () => {
  const lost = bodies(acode, 'TradeLost'), rep = bodies(acode, 'RepeatTradeLost');
  assert.match(lost, /held = HoldLocked\(root, Now\(\)\);[\s\S]*if \(held\) HeldLost\[root\] = text;/);
  assert.match(lost, /if \(held\) \{[^\n]*return; \}\s*Log\(text\); AgentLog\(text\); ChartBridgeOrders\.AgentAlarm\(text\);/, 'held: no alarm');
  // review of #47: only a job that owns the pair, and 30 s at most
  assert.match(acode, /private bool FlattenRunsLocked\(string root\) \{ return Flats\.Values\.Any\(j => j\.Root == root && j\.Owned\); \}/);
  assert.match(bodies(acode, 'HoldLocked'), /return now - since < ChartBridgeAgents\.LostHoldMaxMs;/);
  assert.match(acode, /public const double LostHoldMaxMs = 30000;/);
  assert.match(rep, /if \(flat\) \{[^\n]*HeldLost\.Remove\(root\);[\s\S]*else if \(HoldLocked\(root, now\)\) \{ \}[\s\S]*else if \(wasHeld\) \{ HeldLost\.Remove\(root\);[^\n]*LostTrades\[root\] = now;/, 'flat: forgotten; job: held; job gone or 30 s: raised');
});

test('0.5.7 None and the daily reset (DECISION 2026-10-14e): ChartBridge runs it without a page; one place for an exception; harnessed', () => {
  const acc = strip(read('ChartBridgeAccounts.cs'));
  assert.match(main, /try \{ ChartBridgeBranches\.Poll\(\); \} catch \(Exception ex\) \{ Log\("daily reset error: " \+ ex\.Message\); \} \}, null, 2000, 2000\);/, 'on the 2 s poll timer');
  assert.match(main, /ChartBridgeCopier\.Start\(\);[^\n]*\n\s*try \{ ChartBridgeBranches\.Poll\(\); \}/, '0.6.3 (audit C1): and once at start, every branch loaded');
  assert.match(acc, /public static void Poll\(\) \{ if \(!HarnessManual\) Check\(\); \}/);
  assert.match(acc, /public const string None = "-";/);
  assert.match(acc, /public static bool KeepThroughReset\(string branch, string account\) \{ return false; \}/, 'the one place an exception would go; none yet');
  assert.match(bodies(acc, 'Check'), /string day = DueDay\(et\);[\s\S]*if \(doneDay == day\) return;\s*if \(!inBreak && \(doneDay == null \|\| string\.CompareOrdinal\(doneDay, day\) > 0\)\) return;[\s\S]*WriteDay\(day, null\);\s*Run\(day, missed, null\);/, 'in the break, or a missed break caught up; once per day, saved before it runs');
  assert.match(acc, /if \(a == null\) return name \+ " is not in NinjaTrader yet";/, '0.6.3 (review HIGH 1): an account not listed is not known, never idle');
  assert.match(read(path.join('check', 'BotHarness.cs')), /0\.6\.3 C1: the clock jumps from 16:30 to 19:00/);
  assert.match(acode, /private string account = ChartBridgeBranches\.None;/);
  assert.match(bodies(acode, 'AccountConflict'), /if \(ChartBridgeBranches\.IsNone\(acct\)\) return null;/, 'None clashes with nobody');
  for (const f of ['BotHarness.cs', 'AgentHarness.cs', 'CopierHarness.cs']) assert.match(read(path.join('check', f)), /0\.5\.7 reset/, f);
});

test('0.6.0 group trading: one plan, each seat through PlaceAgentEntry on its own account and size, never PlaceLock across seats', () => {
  const place = bodies(acode, 'Place'), seats = bodies(acode, 'PlaceSeatsLocked');
  assert.match(place, /lock \(PlaceGate\)[\s\S]*string why = Checks\(p, forAccount, forAccount != null, out acct\);[\s\S]*if \(seats\)\s*\{\s*why = PlaceSeatsLocked\(p, out placed\);/, 'every check again under the gate, then seat by seat');
  assert.match(seats, /if \(p\.Outs\[i\] != null\) continue;/, 'a seat that sits out gets nothing');
  assert.match(seats, /CbJson\.Str\(seat\)[\s\S]*p\.Sizes\[i\]\.ToString\(CultureInfo\.InvariantCulture\)/, 'that seat\'s account and its own size');
  assert.match(seats, /try \{ why = ChartBridgeOrders\.PlaceAgentEntry\(Id, p\.Id, text, out o\); \}\s*catch \(Exception ex\)/, 'each in its own try, with the plan\'s id');
  assert.ok(!/AgentPlaceLock|PlaceLock\)/.test(seats), 'PlaceLock is taken by PlaceOrder per seat, never held across seats (its plans file write runs outside it)');
  assert.match(seats, /if \(why == null && o\.OrderState == OrderState\.Rejected\) why = "NinjaTrader rejected its entry";/);
  assert.ok(!/\.Submit\s*\(|\.CreateOrder\s*\(/.test(seats), 'no order call of its own');
  const checks = bodies(acode, 'Checks');
  assert.match(checks, /outs\[i\] = benchNow\.Contains\(seats\[i\]\) \|\| benchFresh\.Contains\(seats\[i\]\) \? "benched" : p\.Sizes\[i\] == 0 \? "its size is 0 \(no room for 1 contract\)" : AccountProblemFor\(seats\[i\], true\);/, 'Q1 b: size 0, not tradable or not connected: that seat sits out (0.6.7: a benched seat too)');
  assert.match(checks, /outs\[i\] = ChartBridgeAgents\.EntryCheck\("agent:" \+ Id, a, root\) \?\? ChartBridgeGroups\.EntryCheck\("agent:" \+ Id, a, root, p\.Side == "buy", p\.Sizes\[i\], true, false\);/, 'Q1 b: the owner lock and the one-direction check per seat');
  assert.match(checks, /if \(outs\.All\(x => x != null\)\)\s*return "no seat of "/, 'refused only when no seat can take it');
  assert.match(bodies(acode, 'GroupPlanProblem'), /if \(p\.SeatsRev != rev\) return "the group changed; size again";/, 'a stale seatsRev refuses the whole plan');
  assert.match(checks, /open = Seats\.Values\.Any\(x => x\.openTag != null \|\| x\.Sticky\.Count > 0\);/, 'one at a time across every seat');
  assert.match(checks, /trades = TradesLocked\(\);/, 'Q3 a: maxTrades per plan');
  assert.match(bodies(acode, 'UnitsLocked'), /SeatOfTag\.ContainsKey\(t8\) && PlanOfTag\.TryGetValue\(t8, out pid\) \? "plan\\t" \+ pid : kv\.Key;/, 'a group\'s plan is one trade; any other trade counts by itself, as before');
  assert.match(bodies(acode, 'LossesLocked'), /v\.All\(x => !double\.IsNaN\(x\)\) && v\.Sum\(\) < 0/, 'a loss once every seat closed, when their sum is below 0');
});

test('0.6.0 group trading: every single-account field is a seat\'s; the owner lock, the clash rules and the entry seat count every seat', () => {
  const seat = acode.slice(acode.indexOf('private sealed class Seat'), acode.indexOf('// ---------------------------------------------------------- state (under Sync)'));
  for (const f of ['public string openTag, openRoot;', 'public Instrument openInst;', 'public int ledQty;', 'public double ledCash, ledAvg;', 'LostTrades', 'HeldLost', 'HeldSince', 'public readonly HashSet<string> Sticky', 'public readonly Dictionary<string, FlatJob> Flats', 'AgainstSince'])
    assert.ok(seat.includes(f), 'a seat\'s own: ' + f);
  const agentState = acode.slice(acode.indexOf('// ---------------------------------------------------------- state (under Sync)'), acode.indexOf('public string Account { get'));
  for (const f of [/\bopenTag\b/, /\bledQty\b/, /\bSticky\b/, /Dictionary<string, FlatJob> Flats/, /\bLostTrades\b/]) assert.ok(!f.test(agentState), 'no single-account field left on the agent: ' + f);
  assert.match(bodies(acode, 'OwnerAgent'), /if \(a\.OwnsOn\(account, root\)\) return a\.Id;/);
  assert.match(bodies(acode, 'EntryCheck'), /if \(!ag\.IsEntrySeat\(account\.Name\)\) return "agent " \+ id \+ " trades its own account "/, 'a seat it trades now; never one that left the group');
  assert.match(bodies(acode, 'AgentOfAccount'), /if \(a\.Claims\(name\)\) return a\.Id;/);
  assert.match(bodies(acode, 'AccountConflict'), /foreach \(string seat in SeatNames\(\)\) \{ string w = AccountConflict\(seat\); if \(w != null\) return w; \}/);
  assert.match(bodies(ccode, 'Eligible'), /string seat = ChartBridgeAgents\.AccountTakenWhy\(a\.Name, "the copier"\);[^\n]*\n\s*if \(seat != null\) \{ label = "agent"; why = seat; return null; \}/, 'the copier never copies to a seat');
  assert.match(strip(read('ChartBridgeGroups.cs')), /if \(id != null\) \{ string taken = ChartBridgeAgents\.JoinRefusal\(name, id\); if \(taken != null\) return taken; \}/, 'joining a group an agent trades');
  for (const f of ['OnExec', 'OnPosition']) assert.match(bodies(acode, f), /HasSeat\(|SeatFor\(account\)|acct/, f + ' per seat');
  assert.match(bodies(acode, 'FlattenRunsLocked'), /return Flats\.Values\.Any\(j => j\.Root == root && j\.Owned\);/, 'a seat\'s own jobs');
});

test('0.6.0 group trading: the contract fields; the day file\'s #seat lines read before the comment skip (an older ChartBridge skips them)', () => {
  assert.match(acode, /\{ "plan", new\[\] \{[^}]*"confidence", "seatsRev", "sizes" \} \}/);
  assert.match(acode, /\{ "flatten", new\[\] \{ "type", "account" \} \}/);
  assert.match(acode, /\{ "agentAccount", new\[\] \{ "type", "cid", "agent", "account", "group", "keepMode", "league" \} \}/);
  assert.match(acode, /internal const string SeatPrefix = "#seat\\t";/);
  const load = bodies(acode, 'LoadDay');
  assert.ok(load.indexOf('ReadSeatLine(line,') > 0 && load.indexOf('ReadSeatLine(line,') < load.indexOf('if (line.Length == 0 || line.StartsWith("#")) continue;'), '#seat read before the comment skip');
  assert.match(bodies(acode, 'SaveDayLocked'), /lines\.Add\(SeatPrefix \+ kv\.Key \+ "\\t" \+ kv\.Value\);/);
  assert.match(bodies(acode, 'SaveGroup'), /"group\\t" \+ gid/, 'agent-<id>-account.txt group<TAB><id> (an older ChartBridge stands the agent down on it)');
  assert.match(bodies(acode, 'SeatsWelcomeFields'), /",\\"group\\":"[\s\S]*",\\"seats\\":"[\s\S]*",\\"seatsRev\\":"/);
  assert.match(bodies(acode, 'AnswerJson'), /\(account != null \? ",\\"account\\":" \+ CbJson\.Str\(account\) : ""\)/, 'answer.account only for one seat of a group plan');
});

test('0.6.0 fix round 1: accountState for every seat followed; not connected stops a fan-out; JoinRefusal again under the save; a private check build', () => {
  assert.match(bodies(acode, 'SendAccountState'), /List<string> accts = AllSeats\(\)\.Select\(x => x\.Name\)\.ToList\(\);/, 'a seat that left while holding his trade keeps its accountState until flat');
  const pp = acode.slice(acode.indexOf('public string PlacingProblem(string acct)'), acode.indexOf('private string StateJson()'));
  assert.match(pp, /lock \(Sync\) \{ m = mode; k = killed; on = client != null && helloed; bd = build; gid = groupId; lg = league; \}[\s\S]*if \(!on\) return "agent " \+ Id \+ " is not connected: nothing more is placed";/, 'asked per seat under PlaceLock (PlaceOrderLocked), only the agent\'s Sync taken');
  const ag = strip(read('ChartBridgeGroups.cs')), body = ag.slice(ag.indexOf('private static string AccountGroup('), ag.indexOf('private static string AccountLimits('));
  /* 0.6.7 (reviews L1, L2): AccountGroup decides inside ChangeAndSave(true, ...), whose decide runs under GroupEntryLock, PlaceLock
     and SaveLock, before the membership is written */
  const lk = body.indexOf('ChangeAndSave(true, next =>'), again = body.indexOf('ChartBridgeAgents.JoinRefusal(name, id, false)'), save = body.indexOf('}, next => HeldWords(name, a), out inEffect);');
  assert.ok(lk > 0 && again > lk && again < save, 'JoinRefusal again under PlaceLock and SaveLock, before the membership is saved');
  const cs = ag.slice(ag.indexOf('private static string ChangeAndSave('), ag.indexOf('private static string GroupSave('));
  const pe = cs.indexOf('Monitor.Enter(ChartBridgeOrders.GroupPlaceLock, ref p)'), se = cs.indexOf('Monitor.Enter(SaveLock, ref sv)'), dc = cs.indexOf('why = decide(next);'), wr = cs.indexOf('err = WriteWhole(FilePath, text)'), px = cs.indexOf('Monitor.Exit(ChartBridgeOrders.GroupPlaceLock); p = false;');
  assert.ok(pe > 0 && se > pe && dc > se && px > dc && wr > px, 'ChangeAndSave: PlaceLock, then SaveLock, then the decision; PlaceLock let go before the write');
  assert.match(bodies(acode, 'JoinRefusal'), /if \(refresh\) RefreshFiles\(\);/, 'no file read under the locks');
  assert.match(read(path.join('check', 'check.sh')), /-out:"\$\{CHARTBRIDGE_CHECK_DLL:-\/tmp\/chartbridge-check\.dll\}"/, 'check:nt8 builds to a private path when CHARTBRIDGE_CHECK_DLL is set');
});

test('0.6.2 (SPEC CE-2): group stand-downs gate entries only; league seats are Sim only, read fresh at every gate', () => {
  const pp = acode.slice(acode.indexOf('public string PlacingProblem(string acct)'), acode.indexOf('private string GroupNowForLatch()'));
  assert.match(pp, /ChartBridgeAgents\.StandDownRefusal\(bd, ChartBridgeGroups\.GroupOf\(acct\)\)/, 'per seat under PlaceLock: the seat\'s own group');
  assert.match(pp, /if \(lg\) \{ Account a = FindAccount\(acct\); if \(gid != null \|\| a == null \|\| !ChartBridgeBot\.IsSim\(a\)\) return LeagueRefusal; \}/, 'a league seat: Sim read fresh at placement');
  const ch = bodies(acode, 'Checks');
  const latch = ch.indexOf('string latch = LatchProblem();'), check3 = ch.indexOf('if (!r.Roots.Contains(root))');
  assert.ok(latch > 0 && latch < check3, 'check 2: the stand-down before any other plan check');
  assert.match(ch, /if \(lg && \(grp \|\| !SeatSim\(acct\)\)\) return LeagueRefusal;/, 'check 2: a league seat on a Sim account only');
  assert.match(acode, /private string LeagueRefusal \{ get \{ return "agent " \+ Id \+ " is a league seat: Sim accounts only"; \} \}/, 'the refusal text');
  assert.match(bodies(acode, 'SaveLeague'), /"league\\t" \+ nm/, 'saved as league<TAB><account> (an older ChartBridge stands the agent down on it)');
  assert.match(acode, /\{ "standDown", new\[\] \{ "type", "group", "kind", "why" \} \}/, 'the agent raises only');
  assert.ok(!/"standDownClear"|"clearStandDown"/.test(acode.slice(acode.indexOf('AgentKeys'), acode.indexOf('public bool Busy()'))), 'the agent has no clear message');
  assert.match(acode, /\{ "agentStandDownClear", new\[\] \{ "type", "cid", "build", "group" \} \}/, 'the page clears');
  const om = bodies(acode, 'OnPageMessage'), rate = om.indexOf('RateOk(client.Actions)'), clear = om.indexOf('if (type == "agentStandDownClear")');
  assert.ok(rate > 0 && clear > rate, 'the clear is counted in gate 7, after the sign-in and v3 gates');
  assert.match(bodies(acode, 'StandDown'), /return sd \?\? LatchProblem\(\) \?\? AccountConflict\(\);/, 'the backstop cancels a stood-down agent\'s entries');
  const flat = acode.slice(acode.indexOf('private int StartFlatten(string why, bool byRules, string onlySeat)'), acode.indexOf('public string OnPage('));
  assert.ok(!/StandDownRefusal|LatchProblem/.test(flat), 'never the flatten');
  const g = strip(read('ChartBridgeGroups.cs')), del = g.slice(g.indexOf('private static string GroupDelete('), g.indexOf('private static void ForgetHighs('));
  assert.ok(del.indexOf('ChartBridgeAgents.GroupDeleted(id)') > del.indexOf('string err = Save(next);'), 'a deleted group\'s stand-downs go under its save');
  assert.match(bodies(acode, 'WriteStandDowns'), /"standDown\\t" \+ s\.Build \+ "\\t" \+ s\.Group \+ "\\t" \+ s\.At\.ToString\("0", CultureInfo\.InvariantCulture\) \+ "\\t" \+ s\.Kind \+ "\\t" \+ s\.Why/);
});
