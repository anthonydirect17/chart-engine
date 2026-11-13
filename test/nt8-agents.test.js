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
  assert.match(main, /public const string Version = "0\.(5\.[0-8]|6\.([0-9]|1[0-9]|2[012]))";/);   // 0.6.21: the pick, profitToday, the roster reader tightened; 0.6.20: the roster served; 0.6.19: the day's profit stop; 0.6.18: entry rules per trader (market entry, no target); 0.6.17: Kill all for the prop accounts; 0.6.16: prop accounts (Auto kept through the reset and one restore after a restart, prop only); 0.6.15: the 1 second pull retired; 0.6.14: the tick day check rule; 0.6.13: the tick day's morning catch-up, the raw deleted once packed; 0.6.12: the bar trail follow-ups; 0.6.10: the account lifecycle (remove-only for an account NinjaTrader no longer lists, Hide leaves the group); 0.6.9: the stats suite's Phase 2 (1 second bars, the order record, decision ids; recording only); 0.6.8: the minute book (the history path only); 0.6.7: the bench, no hedging always on, a group's own rules optional; 0.6.6: the firm's limits on entries, riskAlert, firmMinimum, copierFollowerRemove; 0.6.5: each member's own rules and the risk percent; 0.6.4: no false no-trade-record alarm, the alarm cleared, Merge on an off follower; 0.6.3: the audit fixes (a missed reset caught up, closes not seen, files that survive a power cut, the kill switch kept); 0.6.2: group stand-downs and league seats; 0.6.1: a group's type and default hero; 0.6.0: group trading (seats); 0.5.8: groups and accountState; 0.5.7: the plan id, the TradeLost hold, None and the daily reset; 0.5.1: the accounts follow NinjaTrader, on top of 0.5.0; 0.5.3: the agents' MNQ cap; 0.5.4: the window while exposed; 0.5.5: the accounts line and unknown keys; 0.5.6: the time check
  assert.ok(!/(^|[\s(=,+:?])\$"/m.test(acode) && !/\?\.\w/.test(acode) && !/\bnameof\(/.test(acode), 'C# 5');
});

test('0.5.0 agents: order calls only where the contract allows; a market entry only by its own rules (0.6.18), never a flatten call', () => {
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
  // the review of 0.6.17 (F2): on a pair it owns, every order there unless the job is own orders only (Kill all), then only its own
  assert.match(bodies(acode, 'StepFlatten'), /may\.Where\(o => o != j\.Close && \(j\.Owned \? \(!j\.OwnOnly \|\| IsMine\(o\)\) : \(IsMine\(o\) && !\(IsReStop\(o\) && \(p1 != 0 \|\| p2 != 0\)\)\)\)\)/, 'a pair it does not own: only its own orders, never its stop placed again over a position');
  // every entry goes through ChartBridgeOrders.PlaceAgentEntry: the page's order path with the agent as its source
  assert.match(bodies(acode, 'Place'), /ChartBridgeOrders\.PlaceAgentEntry\(Id, p\.Id, text, out placed\)/);
  assert.match(bodies(acode, 'Place'), /string why = Checks\(p, forAccount, forAccount != null, out acct\);/, 'every check again at the moment of placing, and the account they validated is the one used');
  for (const f of ['SetKill', 'SetRules']) assert.match(bodies(acode, f), /lock \(PlaceGate\) return \w+Locked\(d\);/, f + ' waits for a placement under way');
  // 0.6.21 (the review of 93, FIX 2 and 3): SetMode works out the picked file's sha256 before the gate, then takes it
  assert.match(bodies(acode, 'SetMode'), /PickCheckTimed\(held, out sha\);[\s\S]*lock \(PlaceGate\) return SetModeLocked\(d, held, sha, shaBad\);/, 'SetMode waits for a placement under way (the roster read before it)');
  assert.match(bodies(acode, 'SetAccount'), /lock \(PlaceGate\)\s*\{\s*why = SetAccountLocked\(d\);\s*if \(why == null\) dropped = ChartBridgeBranches\.Chosen\("agent:" \+ Id\);/, 'SetAccount waits for a placement under way (0.6.3: and drops a pending reset under the same lock)');
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null\) \{ string agentWhy = ChartBridgeAgents\.PlacingProblem\(agent, account\.Name, kind, isBuy, price, limitPx, tick\);/, 'the order path asks the agent at the last moment');
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null && \(\(kind != "limit" && kind != "stopLimit" && !\(kind == "market" && ChartBridgeAgents\.MayMarket\(agent\)\)\) \|\| strategyBody != null \|\| bracketBody == null\)\) return/);
  assert.match(bodies(ocode, 'PlaceOrderLocked'), /if \(agent != null && \(stopTicks < 1 \|\| \(targetTicks < 1 && !ChartBridgeAgents\.MayNoTarget\(agent\)\)\)\) return "every agent entry needs a stop and a target";/);
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
  assert.match(main, /",\\"order_id\\":" \+ CbJson\.Str\(orderId\) \+ FillBy\(account, orderId, order\) \+ ChartBridgeDecisions\.FillField\(account, orderId, order\) \+ "\}";/, 'fills to The Desk: "by" only when known (0.6.9: and "decision_id" only on a fill of a group entry)');
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
  assert.match(main, /try \{ ChartBridgeBranches\.Poll\(\); \} catch \(Exception ex\) \{ Log\("daily reset error: " \+ ex\.Message\); \} try \{ ChartBridgeGroups\.LanePoll\(\); \} catch \(Exception ex\) \{ Log\("lane rule error: " \+ ex\.Message\); \} \}, null, 2000, 2000\);/, 'on the 2 s poll timer (0.6.22: the lane rule after it, in its own try)');
  assert.match(main, /ChartBridgeCopier\.Start\(\);[^\n]*\n\s*try \{ ChartBridgeBranches\.Poll\(\); \}/, '0.6.3 (audit C1): and once at start, every branch loaded');
  assert.match(acc, /public static void Poll\(\) \{ if \(!HarnessManual\) Check\(\); \}/);
  assert.match(acc, /public const string None = "-";/);
  // 0.6.16: the one place now holds its one exception: an agent whose every seat is prop and whose saved Auto names this account
  const keep = bodies(acc, 'KeepThroughReset');
  assert.match(keep, /if \(!PersonalNamed \|\| branch == null \|\| !branch\.StartsWith\("agent:", StringComparison\.Ordinal\)\) return false;/, 'no personalAccount line, the bot and the copier: never');
  assert.match(keep, /return seats\.Count > 0 && seats\.All\(x => IsProp\(x\)\) && ag\.SavedAutoOn\(account\);/, 'only every seat prop, and only from the saved file');
  assert.equal((acode.match(/KeepThroughReset\(/g) || []).length, 1, 'asked in one place, the agent\'s reset');
  // Anthony 2026-11-11: Auto ends with the trading day. The reset switches it off and removes the saved Auto BEFORE it asks, so
  // nothing is kept through the reset; and a restore counts only inside the trading day the Auto was set in
  assert.match(bodies(acode, 'ResetToNone'), /string acct = Account;\s*EndAutoAtReset\(\);[^\n]*\n\s*if \(NoneNow\(\)\) return null;\s*if \(ChartBridgeBranches\.KeepThroughReset\(/, 'Auto off first, then the reset every branch has (0.6.22: the same test in two steps, so a kept lane trader is said)');
  assert.match(bodies(acode, 'ResetToNone'), /if \(GroupNow\(\) && ChartBridgeBranches\.LaneGroupKept\("agent:" \+ Id, KeyNow\(\)\)\) \{[^\n]*Log\(/, '0.6.22 (A3): a lane trader kept through the reset is said once');
  const end = bodies(acode, 'EndAutoAtReset');
  // the review of 90 (N4, the coordinator's ruling): every agent in Auto, on every kind of account, flat or not
  assert.match(end, /lock \(Sync\) \{ auto = mode == "auto"; autoDay = null; \}[\s\S]*if \(!fileThere && !auto\) return false;\s*if \(auto\)\s*\{/, 'N4: no exception for the personal account, Sim or a mixed group');
  assert.ok(!/KillScope|IsProp|PersonalNamed/.test(end), 'N4: it asks no account kind');
  // the review of 90 (F4): the Auto's trading day in memory, compared on every pass and in every plan check
  assert.match(bodies(acode, 'AutoDayEnded'), /string now = ChartBridgeBranches\.DueDay\(NowEt\(\)\); lock \(Sync\) return mode == "auto" && autoDay != now;/);
  assert.match(bodies(acode, 'EndAutoIfDayEnded'), /if \(!AutoDayEnded\(\)\) return false;\s*lock \(PlaceGate\)\s*\{\s*if \(!AutoDayEnded\(\)\) return false;\s*EndAutoAtReset\(\);/);
  assert.match(acode, /TryRestoreAuto\(\);[^\n]*\n\s*EndAutoIfDayEnded\(\);/, 'F4: every pass');
  assert.match(acode, /if \(k\) return "the kill switch is on \(release it on the Agent tab\)";[\s\S]{0,300}if \(EndAutoIfDayEnded\(\)\) return "the trading day ended \(17:00 ET\): Auto is off for agent "/, 'F4: every plan check, before anything is placed');
  assert.match(bodies(acode, 'SetModeLocked'), /if \(m == "auto" && old != "auto"\) autoDay = ChartBridgeBranches\.DueDay\(NowEt\(\)\);/, 'F4: the day Auto is set in');
  assert.match(end, /lock \(Sync\) mode = "shadow";\s*CancelUnfilled\("the trading day ended \(17:00 ET\): Auto is off"\);/);
  assert.match(end, /DropAutoIntent\("the trading day ended \(17:00 ET\)"\);/);
  assert.ok(!/StartFlatten|\.Submit\s*\(|\.CreateOrder\s*\(/.test(end), 'it closes nothing: a position keeps its stop, its target and its flat time');
  assert.match(bodies(acode, 'TryRestoreAuto'), /if \(no == null && SavedAutoDay\(\) != ChartBridgeBranches\.DueDay\(NowEt\(\)\)\) no = "its saved Auto is from an earlier trading day/, 'a restore only inside the same trading day');
  assert.match(bodies(acode, 'SyncAutoIntent'), /File\.AppendAllText\(AutoFile, AutoDayPrefix \+ ChartBridgeBranches\.DueDay\(NowEt\(\)\) \+ "\\n" \+ AutoPickPrefix/, 'the day is saved with the Auto (0.6.21: and the pick it was armed with)');
  assert.ok(!/KeepThroughReset/.test(read('ChartBridgeOrders.cs') + read('ChartBridgeGroups.cs')), 'the order path and the groups never ask; the bot and the copier ask as before and get no');
  assert.match(bodies(acc, 'Check'), /string day = DueDay\(et\);[\s\S]*if \(doneDay == day\) return;\s*if \(!inBreak && \(doneDay == null \|\| string\.CompareOrdinal\(doneDay, day\) > 0\)\) return;[\s\S]*WriteDay\(day, null\);\s*Run\(day, missed, null\);/, 'in the break, or a missed break caught up; once per day, saved before it runs');
  assert.match(acc, /if \(a == null\) return name \+ " is not in NinjaTrader yet";/, '0.6.3 (review HIGH 1): an account not listed is not known, never idle');
  assert.match(read(path.join('check', 'BotHarness.cs')), /0\.6\.3 C1: the clock jumps from 16:30 to 19:00/);
  assert.match(acode, /private string account = ChartBridgeBranches\.None;/);
  assert.match(bodies(acode, 'AccountConflict'), /if \(ChartBridgeBranches\.IsNone\(acct\)\) return null;/, 'None clashes with nobody');
  for (const f of ['BotHarness.cs', 'AgentHarness.cs', 'CopierHarness.cs']) assert.match(read(path.join('check', f)), /0\.5\.7 reset/, f);
});

test('0.6.16 prop accounts: every new branch passes through IsProp; nothing is prop until the personal account is picked on the page', () => {
  const acc = strip(read('ChartBridgeAccounts.cs'));
  // the one predicate: no pick, the personal account itself, Backtest or Playback, Sim, or not listed: not prop
  const isProp = bodies(acc, 'IsProp');
  assert.match(isProp, /string p = personal;\s*if \(p == null \|\| string\.IsNullOrEmpty\(name\) \|\| IsNone\(name\)\) return false;/, 'no pick: nothing is prop');
  assert.match(isProp, /if \(string\.Equals\(name, p, StringComparison\.OrdinalIgnoreCase\)\) return false;/, 'the personal account is never prop');
  assert.match(isProp, /if \(ChartBridgeOrders\.IsNeverTradable\(name\)\) return false;/, 'Backtest and Playback are never prop');
  assert.match(isProp, /if \(same\.Count == 0\) return false;\s*return same\.All\(a => !ChartBridgeBot\.IsSim\(a\) && !ChartBridgeAccounts\.IsSim\(a\)\);/, 'not listed, or Sim by either test: not prop');
  // Anthony 2026-11-11: a one-time pick on the chart page, nothing typed into a file by hand: no config.txt key
  assert.ok(!/personalAccount/.test(main) && !/ReadConfig|ResetConfig/.test(acc.slice(acc.indexOf('public static class ChartBridgeBranches'))), 'no config.txt line names it');
  assert.match(acc, /ChartBridgeBranches\.LoadPersonal\(\);[^\n]*\n\s*StartNow\(ChartBridgeTime\.NowUtcMs\(\)\);/, 'read at start, before the agents');
  assert.match(main, /type == "accountUnarchive" \|\| type == "accountPersonal"\)[^\n]*\n\s*ChartBridgeAccounts\.OnMessage\(client, type, text\);/);
  const set = bodies(acc, 'SetPersonal');
  assert.match(set, /List<string> auto = ChartBridgeAgents\.InAuto\(\);\s*if \(auto\.Count > 0\) return "agent "/, 'never while an agent is in Auto');
  assert.match(set, /if \(same\.Count == 0\) return name \+ " is not in NinjaTrader now/);
  assert.match(set, /if \(same\.Any\(x => ChartBridgeBot\.IsSim\(x\) \|\| ChartBridgeAccounts\.IsSim\(x\)\)\) return name \+ " is a Sim account/);
  assert.match(set, /ChartBridgeAgents\.PersonalChanged\(\);/, 'every saved Auto goes with a change of the pick');
  assert.match(acc, /string why = ChartBridgeV3\.Gate\(client\);[\s\S]*if \(why == null && type == "accountPersonal"\)/, 'behind the same gate as every account message: a signed-in page of ChartBridge\'s own');
  // the name is never written to the Output window
  for (const f of ['LoadPersonal', 'SetPersonal']) assert.ok(!/ChartBridgeServer\.Log\([^;]*\+ (personal|name|p)\b/.test(bodies(acc, f)), f + ': the Output line never carries the name');
  assert.match(acc, /"\],\\"personalNamed\\":"\)\.Append\(ChartBridgeBranches\.PersonalNamed \? "true" : "false"\)/);
  assert.match(acc, /b\.Append\(",\\"personal\\":"\)\.Append\(ChartBridgeBranches\.IsPersonal\(name\) \? "true" : "false"\)\s*\.Append\(",\\"prop\\":"\)\.Append\(ChartBridgeBranches\.IsProp\(name\) \? "true" : "false"\);/);
  // the page: the pick asks first, then one message; nothing else on the page sends it
  const pg = fs.readFileSync(path.join(__dirname, '..', 'live', 'accounts.js'), 'utf8');
  assert.match(pg, /accountPersonal: name => S\.personalNamed !== null && send\(\{ type: 'accountPersonal', cid: cid\(\), account: name \}\),/);
  assert.match(pg, /accountPersonalClear: \(\) => S\.personalNamed !== null && send\(\{ type: 'accountPersonal', cid: cid\(\), clear: true \}\),/);
  assert.match(pg, /else if \(a === 'personal-yes'\) \{\s*const q = P\.personalAsk; P\.personalAsk = null;\s*if \(q && q\.account === id\) \{ if \(q\.clear\) F\.accountPersonalClear\(\); else F\.accountPersonal\(id\); \}/, 'only the confirm row\'s Yes sends it');
  assert.match(pg, /typeof a\.personal !== 'boolean' \|\| a\.sim \|\| !canAct \? ''/, 'never offered on a Sim account, or with an older ChartBridge');
  // the agent: the file is written only behind PersonalNamed and AllSeatsProp (IsProp for every seat)
  assert.match(bodies(acode, 'AllSeatsProp'), /return seats\.Count > 0 && seats\.All\(x => ChartBridgeBranches\.IsProp\(x\)\);/);
  assert.equal((acode.match(/ChartBridgeFiles\.SaveAutoIntent\(/g) || []).length, 1, 'one place writes the file');
  assert.match(bodies(acode, 'SyncAutoIntent'), /if \(m == "auto" && ChartBridgeBranches\.PersonalNamed && AllSeatsProp\(\)\)\s*\{\s*string err = ChartBridgeFiles\.SaveAutoIntent\(AutoFile, "agent " \+ Id, KeyNow\(\)\);/);
  // the start: the file is read only with the line; the mode is still Shadow first
  assert.match(bodies(acode, 'Start'), /mode = "shadow";[\s\S]*string intent = ChartBridgeBranches\.PersonalNamed \? ChartBridgeFiles\.AutoIntent\(AutoFile\) : null;\s*lock \(Sync\) autoRestorePending = intent != null;/);
  // the one restore: under PlaceGate; no line, the kill switch, another account, a seat not known (waits), not prop, not flat: no Auto
  const tr = bodies(acode, 'TryRestoreAuto');
  assert.match(tr, /lock \(PlaceGate\)/);
  assert.match(tr, /if \(!ChartBridgeBranches\.PersonalNamed\) no = [^\n]*\n\s*else if \(k\) no = "the kill switch is on";/);
  assert.match(tr, /else if \(string\.IsNullOrEmpty\(intent\) \|\| intent != key\) no = /);
  assert.match(tr, /if \(seats\.Any\(x => ChartBridgeBranches\.UnknownWhy\(FindAccount\(x\), x\) != null\)\) return;/, 'a seat not known yet: this pass does not decide');
  assert.match(tr, /List<string> notProp = seats\.Where\(x => !ChartBridgeBranches\.IsProp\(x\)\)\.ToList\(\);/);
  assert.match(tr, /List<string> busy = seats\.Where\(x => !ChartBridgeBranches\.Idle\(FindAccount\(x\)\)\)\.ToList\(\);/);
  assert.match(tr, /if \(notProp\.Count > 0\) no = [^\n]*\n\s*else if \(busy\.Count > 0 \|\| Exposed\(\)\) no = [^\n]*\n\s*else \{ string why = AutoProblem\(\); if \(why != null\) no = why; \}/);
  assert.equal((acode.match(/mode = "auto";/g) || []).length, 1, 'the restore is the only place ChartBridge itself sets Auto');
  assert.match(tr, /if \(no != null\)\s*\{\s*DropAutoIntent\(/, 'a no removes the file: one try per start');
  assert.match(tr, /lock \(Sync\) \{ mode = "auto"; autoRestorePending = false; autoDay = ChartBridgeBranches\.DueDay\(NowEt\(\)\); autoPick = savedPick; autoPickSha = savedSha; \}/);
  // saved and removed with the page's changes, and removed by the kill switch
  assert.match(bodies(acode, 'SetModeLocked'), /SyncAutoIntent\("the mode changed to " \+ m\);/);
  assert.match(bodies(acode, 'SetKillLocked'), /return KillLocked\(on\);/);
  assert.match(bodies(acode, 'KillLocked'), /DropAutoIntent\("the kill switch is on"\);/);
  assert.match(bodies(acode, 'SetAccountLocked'), /SyncAutoIntent\("its account changed"\);/);
  assert.match(bodies(acode, 'SetGroupLocked'), /SyncAutoIntent\("its account changed"\);/);
  assert.match(bodies(acode, 'GoNone'), /DropAutoIntent\("its account is None"\);/);
  // no new order call: the saved Auto places, cancels and flattens nothing
  for (const f of ['SyncAutoIntent', 'DropAutoIntent', 'TryRestoreAuto', 'SavedAutoOn']) assert.ok(!/\.Submit\s*\(|\.CreateOrder\s*\(|\.Cancel\s*\(|Flatten|PlaceAgentEntry|PlaceOrder/.test(bodies(acode, f)), f + ' touches no order');
  // the harness: a no-setting install, the personal account and a Sim account get the 0.6.15 result
  const h = read(path.join('check', 'AgentHarness.cs'));
  for (const s of ['PropAccounts();', 'no setting: the 17:00 reset puts the agent on None, as before', 'no setting: every start is Shadow, the file is not even read', ': a restart from Auto is Shadow', ': the 17:00 reset puts the agent on None, as before', 'prop: the 17:00 reset switches Auto off (Shadow), removes the saved Auto and takes the account to None as for every branch', 'prop: holding a trade at the reset: it stays on its account with its stop and target, and Auto is off all the same', 'prop: a saved Auto from an earlier trading day is not restored and is removed', 'prop: a position at the start: Shadow, the file removed, the pages told'])
    assert.ok(h.includes(s), s);
  assert.ok(!/[\u2013\u2014]/.test(h + read('ChartBridgeAgents.cs') + read('ChartBridgeAccounts.cs')), 'no en or em dashes');
});

test('0.6.17 Kill all for the prop accounts: only agents whose every account is prop; the kill switch and Shadow first, then its own flatten', () => {
  assert.match(acode, /\{ "agentKillAllProp", new\[\] \{ "type", "cid" \} \},/, 'no agent key: it is every agent on prop accounts');
  const all = bodies(acode, 'PageKillAllProp');
  assert.match(all, /if \(!ChartBridgeBranches\.PersonalNamed\) return "Kill all acts on prop accounts only/, 'no personal account picked: refused, nothing done');
  assert.match(all, /foreach \(ChartBridgeAgent a in All\(\)\)\s*\{[^\n]*\n\s*try\s*\{\s*string words = a\.KillProp\(\);[\s\S]*?\}\s*catch \(Exception ex\) \{ failed\.Add\(a\.Id\);/, 'one agent that throws never stops the others (the review\'s N3)');
  assert.match(all, /else if \(a\.KillMixed\(\)\) mixed\.Add\(a\.Id\);/, 'an agent on the personal account and prop accounts is named, loudly (N1)');
  assert.match(all, /Only the traders' own orders were cancelled: an order placed by hand, the bot's or the copier's stays and can still fill/, 'the status line says a hand order stays (F2)');
  assert.ok(!/ChartBridgeBot|ChartBridgeCopier|ChartBridgeOrders\.|Flatten|Cancel\(/.test(all), 'it reaches the bot, the copier and the order path nowhere');
  const one = bodies(acode, 'KillProp');
  assert.match(one, /lock \(PlaceGate\)/);
  // the coordinator's ruling on the review of 88's second look (B1): a group holding ANY prop account is stopped
  assert.match(one, /List<string> scope = seats\.Where\(x => KillScope\(x\)\)\.ToList\(\);\s*bool inScope = scope\.Count > 0;/, 'any account in scope');
  // the review of 90 (F3): or a saved Auto waits (no seats yet), never on the personal account
  assert.match(one, /if \(personal \|\| \(!inScope && !saved\)\) return null;/, 'never the personal account; else in scope, or a saved Auto waiting');
  assert.match(one, /try \{ saved = saved \|\| File\.Exists\(AutoFile\) \|\| File\.Exists\(ChartBridgeFiles\.BackupOf\(AutoFile\)\); \} catch \(Exception\) \{ saved = true; \}/);
  // the review of 90 (N1): the kill switch and Shadow FIRST, the flatten (its own orders only) after, in its own try
  assert.match(one, /string err = KillLocked\(true\);[\s\S]*mode = "shadow";[\s\S]*DropAutoIntent\("Kill all \(prop accounts\)"\);[\s\S]*if \(inScope\)\s*\{\s*try\s*\{\s*if \(FlattenFaultForCheck == Id\) throw new InvalidOperationException\("a fault made by the harness"\);\s*foreach \(string x in scope\) roots \+= StartFlatten\("Kill all \(prop accounts\)", false, x, false, true\);[^\n]*\n\s*\}\s*catch \(Exception ex\) \{ flatErr = ex\.Message; \}/, 'the kill switch and Shadow, then the flatten');
  assert.ok(one.indexOf('KillLocked(true)') < one.indexOf('StartFlatten('), 'N1: in that order');
  // the review of 0.6.17: F1 (scope for a kill: an unlisted account is in), F2 (own orders only), N2 (never the action rate)
  const scope = bodies(acode, 'KillScope');
  assert.match(scope, /if \(!ChartBridgeBranches\.PersonalNamed \|\| ChartBridgeBranches\.IsPersonal\(name\)\) return false;/);
  assert.match(scope, /if \(ChartBridgeOrders\.IsNeverTradable\(name\)\) return false;/);
  assert.match(scope, /Account listed = FindAccount\(name\);\s*return listed == null \|\| !\(ChartBridgeBot\.IsSim\(listed\) \|\| ChartBridgeAccounts\.IsSim\(listed\)\);/, 'not listed: in scope');
  assert.match(acode, /List<Order> others = may\.Where\(o => o != j\.Close && \(j\.Owned \? \(!j\.OwnOnly \|\| IsMine\(o\)\) : \(IsMine\(o\) && !\(IsReStop\(o\) && \(p1 != 0 \|\| p2 != 0\)\)\)\)\)\.ToList\(\);/, 'own orders only when the job says so; every other flatten as before');
  assert.strictEqual((acode.match(/, false, true\);/g) || []).length, 3, 'only Kill all, the day\'s profit stop (0.6.19) and the day\'s loss stop (0.6.22) ask for own orders only');
  assert.match(acode, /if \(type == "agentKillAllProp"\) \{ why = PageKillAllProp\(\);[^\n]*\n\s*if \(!RateOk\(client\.Actions\)\)/, 'Kill all is handled before the action rate gate');
  for (const s of ['kill all F2: the hand order is not cancelled and still works', 'kill all F1 A: the account is not listed', 'kill all F1 B: and a plan is refused, nothing placed', 'kill all F1 C: a group with a member NinjaTrader no longer lists', 'kill all N1:', 'kill all N2: sent right after, it is carried out'])
    assert.ok(read(path.join('check', 'AgentHarness.cs')).includes(s), s);
  assert.match(one, /DropAutoIntent\("Kill all \(prop accounts\)"\);/);
  assert.ok(!/\.Submit\s*\(|\.CreateOrder\s*\(|PlaceOrder|PlaceAgentEntry/.test(one), 'no order call of its own: the close is the agent\'s flatten job, as at the flat time');
  assert.equal((acode.match(/KillProp\(\)/g) || []).length, 2, 'defined once, called once');
  assert.match(acode, /if \(type == "agentKillAllProp"\) \{ why = PageKillAllProp\(\);/);
  const h = read(path.join('check', 'AgentHarness.cs'));
  for (const s of ['kill all, no personal account picked: refused', 'kill all: the personal account and a prop account the agent does not trade: no order, no cancel', 'kill all: an agent on a Sim account is not touched', 'kill all: an agent on the personal account: not killed, not flattened, still in Auto', 'kill all: released: Auto stays off until it is set on the page'])
    assert.ok(h.includes(s), s);
  // until chart 1.44.6 no page sent it; the Board's KILL ALL AGENTS is as it was
  const fsx = require('node:fs');
  // chart 1.45.0: the Legion tab (live/fleet.js) is the one page file that sends it (asked first; test/fleet.test.js), through the
  // connection workspace.js builds for it; since 1.46.0 the gate on that connection is FleetCore.maySend (fleet.js), so
  // workspace.js names the message once, in its comment, and builds nothing; no other page file names it
  for (const f of fsx.readdirSync(path.join(__dirname, '..', 'live')).filter(f => f.endsWith('.js')))
    assert.strictEqual(fsx.readFileSync(path.join(__dirname, '..', 'live', f), 'utf8').includes('agentKillAllProp'), f === 'fleet.js' || f === 'workspace.js', f);
  assert.strictEqual((fsx.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8').match(/agentKillAllProp/g) || []).length, 1, 'workspace.js: one comment, nothing that builds the message');
  assert.match(fsx.readFileSync(path.join(__dirname, '..', 'live', 'workspace.js'), 'utf8'), /post: m => legionGate\(m\) === true && AF\.post\(m\) === true \}/, 'and the gate (captured once from the frozen FleetCore) is in front of every post');
});

test('0.6.19 the day\'s profit stop: the plan\'s dayStopDollars, the smaller of it and the consistency mark off a funded account, the trader\'s own flatten, a stand-down until the roll', () => {
  assert.match(acode, /"confidence", "seatsRev", "sizes", "dayStopDollars", "dayLossDollars" \} \},/, 'a plan may carry it; no other message does (0.6.22: dayLossDollars beside it)');
  assert.strictEqual((acode.match(/"dayStopDollars"/g) || []).length, 2, 'the key is named twice: the plan\'s keys and where the plan is read');
  assert.match(acode, /if \(p\.BadDayStop \|\| \(p\.DayStopText != null && !\(p\.DayStop > 0 && p\.DayStop <= ChartBridgeAgents\.DayStopMax\)\)\)\s*return "dayStopDollars must be dollars above 0/, 'dollars above 0, bounded');
  const note = bodies(acode, 'NoteDayStop');
  assert.match(note, /double v = p\.DayStopText != null \? p\.DayStop : 0, was;\s*lock \(Sync\) \{ was = dayStop; dayStop = v; \}/, 'the placed plan sets it; a placed plan with none clears it');
  assert.strictEqual((acode.match(/NoteDayStop\(/g) || []).length, 3, 'set in two places only: a plan placed in auto, and an accepted proposal placed');
  const mark = bodies(acode, 'DayMark');
  assert.match(mark, /if \(plan > 0\) \{ m = plan;/);
  assert.match(mark, /if \(stage != "funded" && n != null && n\.R != null && n\.R\.Consistency > 0 && n\.R\.Target > 0\)/, 'the consistency mark only off a funded account, and only with both numbers');
  assert.match(mark, /double c = Math\.Round\(n\.R\.Consistency \/ 100\.0 \* n\.R\.Target, 2\);\s*if \(c > 0 && \(m == 0 \|\| c < m\)\)/, 'the smaller of the two');
  const check = bodies(acode, 'CheckDayStop');
  assert.match(check, /double\? day = DayNumber\(n, x\.Name, mark\);\s*if \(!\(mark > 0\) \|\| !day\.HasValue \|\| day\.Value < mark - 1e-9\) continue;/, 'no mark, or a number not known: no check');
  // the review of 88 (F5): every account it follows is latched when reached, flat or not; the flatten only where it holds something
  assert.match(check, /Latch\(x\.Name, mark, from, day\.Value\);\s*if \(!roots\.Any\(y => x\.Owns\(y\)\)\) continue;/, 'latched first, then only an account it holds something on');
  assert.match(acode.slice(acode.indexOf('private double? DayNumber('), acode.indexOf('private bool Latch(')), /if \(n\.ProfitPnl\.HasValue\) return n\.ProfitPnl;/, 'F6: the profit side of the day\'s number');
  assert.match(acode.slice(acode.indexOf('private double? DayNumber('), acode.indexOf('private bool Latch(')), /lock \(Sync\) fresh = DayUnknownSaid\.Add\(name\);/, 'F6/N7: not known is said once a session');
  assert.ok(!/\.Pnl\b/.test(check + bodies(acode, 'DayStopRefusal')), 'F6: the day stop never reads the loss side\'s figure');
  assert.match(check, /StartFlatten\("Agent " \+ Id \+ ": " \+ DayStopWords \+ [^\n]*, true, x\.Name, false, true\);/, 'its own flatten, on that account only, its own orders only');
  assert.ok(!/PlaceOrder|Submit\(|\.Cancel\(|Flatten\(new|GroupCancel/.test(check.replace(/StartFlatten\(/g, '')), 'the check itself places and cancels nothing: the flatten job does, as at the flat time');
  assert.match(acode, /CheckDayStop\(seats, roots\);[^\n]*\n\s*CheckDayLoss\(seats, roots\);[^\n]*\n\s*if \(flatHours\) StartFlatten\(/, 'checked every pass, before the flat time\'s own flatten');
  assert.match(acode, /if \(lossWhy != null\) return lossWhy;[\s\S]{0,400}string dayWhy = DayStopRefusal\(p, grp \? \(IEnumerable<string>\)seats : new\[\] \{ acct \}\);\s*if \(dayWhy != null\) return dayWhy;/, 'plan check 9b: no new entry on an account already at its mark');
  const refusal = bodies(acode, 'DayStopRefusal');
  assert.match(refusal, /if \(p != null && p\.DayStopText != null\) plan = p\.DayStop;/, 'the plan\'s own value counts for it');
  assert.match(refusal, /string was = ChartBridgeAgents\.DayReachedWords\(today, name\);\s*if \(was != null\) return was;/, 'F5: reached once this session, by any trader: refused whatever the plan names');
  assert.match(refusal, /if \(mark > 0 && day\.HasValue && day\.Value >= mark - 1e-9\)\s*\{\s*Latch\(name, mark, from, day\.Value\);/, 'F5: a refusal latches too');
  assert.ok(!/DayReached\.Remove|DayReached\.Clear\(\)/.test(acode.replace(/internal static void ForgetDayReachedForCheck\(\)[^\n]*/, '')), 'F5: no plan clears a latch');
  assert.ok(!/lossStandDown|StartFlatten|mode =/.test(refusal), 'a refusal only: no stand-down, no flatten, no mode change');
  assert.match(bodies(acode, 'RollDay'), /lossStandDown = null;\s*dayStop = 0;/, 'the 18:00 roll clears both');
  assert.match(acode, /if \(dayStop > 0\) lines\.Add\(DayStopPrefix \+ dayStop\.ToString\("0\.##", CultureInfo\.InvariantCulture\)\);/, 'saved only while set');
  assert.match(acode, /internal const string DayStopPrefix = "#daystop\\t";/, 'a comment line to a ChartBridge before 0.6.19');
  assert.match(acode, /\(dayStop > 0 \? ",\\"dayStop\\":" \+ CbJson\.Num\(dayStop\) : ""\) \+ \(dayLoss > 0 \? ",\\"dayLoss\\":" \+ CbJson\.Num\(dayLoss\) : ""\) \+ "\}";/, 'agentState carries it only when set (0.6.22: dayLoss the same way)');
  assert.match(acode, /if \(dayStop > 0\) b\.Append\(",\\"dayStop\\":"\)\.Append\(CbJson\.Num\(dayStop\)\);/, 'and the pages\' agent message, only when set');
  const h = read('check/AgentHarness.cs');
  assert.match(h, /DayStop\(\);/);
  for (const part of ['day stop: the plan\'s dollar value', 'day stop: a plan with no value clears the one before it, and nothing is checked while it holds nothing', 'day stop: the consistency mark on an account that is not funded'])
    assert.ok(h.includes('Part("' + part + '"'), part);
  const p = read('PROTOCOL.md');
  assert.ok(p.includes("### The day's profit stop (0.6.19)") && p.includes('`dayStopDollars`') && p.includes('#daystop<TAB><dollars>'));
});

test('0.6.20 the roster: GET /roster serves the Lab\'s files read only, each checked, never the folder\'s path', () => {
  const main = read('ChartBridge.cs');
  assert.match(main, /if \(path == "\/roster"\) \{ ChartBridgeRoster\.Serve\(ctx\); return; \}/, 'one route');
  assert.match(acode, /if \(key == "rosterFolder"\) \{ ChartBridgeRoster\.FolderSetting = \(val \?\? ""\)\.Trim\(\); return true; \}/);
  assert.match(bodies(acode, 'ResetConfig'), /ChartBridgeRoster\.FolderSetting = "";/, 'a load without the line has none');
  const ro = acode.slice(acode.indexOf('public static class ChartBridgeRoster'));
  assert.match(ro, /if \(ctx\.Request\.Headers\["Host"\] != "localhost:" \+ ChartBridgeConfig\.Port\) \{ Answer\(ctx, 403\); return; \}/, 'by the localhost name only');
  assert.match(ro, /d\.GetFiles\("\*\.json", SearchOption\.TopDirectoryOnly\)/, 'never a subfolder');
  assert.match(ro, /\(d\.Attributes & FileAttributes\.ReparsePoint\) != 0/, 'the folder is no link');
  assert.match(ro, /\(f\.Attributes & FileAttributes\.ReparsePoint\) != 0/, 'a file is no link');
  assert.ok(!/(File|Directory)\.(Create|Write|Delete|Move|Copy|Append|Replace)|FileMode\.(Create|Append|Truncate|OpenOrCreate)|FileAccess\.(Write|ReadWrite)/.test(ro), 'it writes nothing');
  assert.match(ro, /new FileStream\(f\.FullName, FileMode\.Open, FileAccess\.Read, FileShare\.ReadWrite \| FileShare\.Delete\)/, 'read only, never holding the file');
  assert.ok(!/Submit|CreateOrder|Cancel\(|Flatten|PlaceOrder/.test(ro), 'it touches no order');
  assert.ok(!/Log\(|AgentLog\(/.test(ro), 'it logs nothing (never the folder\'s path)');
  // the path goes to the folder read and to the two pure checks of its own shape (0.6.21), and nowhere else
  assert.ok(!/FolderSetting\)|folder\)/.test(ro.replace(/new DirectoryInfo\(folder\)/g, '').replace(/Path\.IsPathRooted\(folder\)/g, '').replace(/DrivePath\(folder\)/g, '').replace(/FolderProblem\(folder\)/g, '').replace(/static (bool|string) (DrivePath|FolderProblem)\(string folder\)/g, '')), 'the path goes nowhere but the read');
});

test('0.6.21: the pick (a name, saved, sent, refused in Auto and while exposed), accountState\'s profit side, the roster reader tightened', () => {
  assert.match(acode, /\{ "agentPick", new\[\] \{ "type", "cid", "agent", "file" \} \},/, 'the page message takes exactly these keys');
  assert.match(acode, /if \(type == "agentPick"\) return SetPick\(d\);/);
  const set = acode.slice(acode.indexOf('private string SetPickLocked'), acode.indexOf('// ---------------------------------------------------------- start and stop') > acode.indexOf('private string SetPickLocked') ? acode.indexOf('// ---------------------------------------------------------- start and stop') : acode.indexOf('private string SetPickLocked') + 3000);
  const order = ['if (m == "auto") return "agent " + Id + " is in Auto', 'if (Exposed()) return "agent " + Id + " has a position, a working entry or a proposal: the pick changes when it is flat"', 'if (bad != null) return name + " cannot be picked: " + bad;', 'WriteWhole(PickFile'].map(x => set.indexOf(x));
  assert.ok(order.every(i => i >= 0) && order.join() === order.slice().sort((x, y) => x - y).join(), 'Auto, exposed and the roster\'s own check all come before the save: ' + order.join());
  // the review of 93, FIX 3: the roster file is read before the gate (with a time limit), the gate taken only to check and swap
  assert.match(bodies(acode, 'SetPick'), /bad = ChartBridgeRoster\.PickCheckTimed\(name, out sha\);[\s\S]*lock \(PlaceGate\) return SetPickLocked\(name, bad\);/, 'the roster read outside the placement gate, the swap under it');
  assert.ok(!/Submit|CreateOrder|PlaceAgentEntry|StartFlatten|mode = /.test(set), 'setting the pick places, flattens and changes no mode');
  // the agent channel cannot send it: its own key table has no such message
  const agentKeys = acode.slice(acode.indexOf('{ "agentHello", new[]'), acode.indexOf('{ "agentHello", new[]') + 2500);
  assert.ok(!agentKeys.includes('agentPick'), 'no agentPick on the agent channel');
  assert.match(acode, /if \(pick != null\) b\.Append\(",\\"pick\\":"\)\.Append\(CbJson\.Str\(pick\)\);/, 'the pages get the pick only when one is set');
  assert.match(acode, /private string PickWelcomeField\(\) \{ string p; lock \(Sync\) p = pick; return p == null \? "" : ",\\"pick\\":" \+ CbJson\.Str\(p\); \}/, 'and so does the runner');
  // ChartBridge keeps the name only: the pick's code never opens the roster file itself
  const pickCode = acode.slice(acode.indexOf('// ---------------------------------------------------------- 0.6.21: the pick'), acode.indexOf('private string SetPickLocked') + 3000);
  assert.ok(!/FolderSetting|new FileStream|ReadAllText/.test(pickCode), 'the pick\'s code reads no roster file (it asks ChartBridgeRoster.PickProblem only)');
  // accountState: the two lines in the groups file
  const g = read('ChartBridgeGroups.cs');
  assert.strictEqual((g.match(/profitToday/g) || []).length, 2, 'profitToday is named twice in the groups file: None, and an account');
  assert.match(g, /b\.Append\(",\\"profitToday\\":"\)\.Append\(Num\(n\.ProfitPnl\)\)\.Append\(",\\"profitWhy\\":"\)\.Append\(n\.ProfitWhy == null \? "null" : CbJson\.Str\(n\.ProfitWhy\)\);/, 'the very number the day\'s profit stop reads');
  // the roster reader
  const ro = acode.slice(acode.indexOf('public static class ChartBridgeRoster'));
  assert.match(ro, /public const int MaxAnswerBytes = 2 \* 1024 \* 1024;/);
  assert.match(ro, /string fmt = TopLevelFormat\(text\);\s*if \(fmt != FormatBot && fmt != FormatLineup\)/, 'the top-level format key decides (D1)');
  assert.ok(!/FormatRx|Regex\.IsMatch\(text|\.IsMatch\(text\)/.test(ro), 'no search of the whole text for the format any more');
  assert.match(ro, /bool ok = Path\.DirectorySeparatorChar == '\\\\' \? DrivePath\(folder\) : Path\.IsPathRooted\(folder\);/, 'on Windows a drive-letter full path only (D3)');
  assert.match(ro, /if \(text != null && total \+ Encoding\.UTF8\.GetByteCount\(text\) > MaxAnswerBytes\)/, 'one cap for the whole answer (D4)');
  const proto = read('PROTOCOL.md');
  for (const w of ['### The pick, and the day\'s profit side in accountState (0.6.21)', '**`agentPick`**', '`agent-<id>-pick.txt`', '**`accountState.profitToday`**', 'a HARD link in the folder is served', 'TOP-LEVEL `format`']) assert.ok(proto.includes(w), 'PROTOCOL: ' + w);
});

test('0.6.18 entry rules per trader: a market entry and an entry with no target only when that trader\'s rules allow each; a stop always', () => {
  assert.match(acode, /public bool MarketEntry, NoTarget;/);
  assert.match(acode, /"maxTrades", "maxLosses", "marketEntry", "noTarget" \} \},/);
  const checks = bodies(acode, 'Checks');
  assert.match(checks, /if \(p\.Kind != "limit" && p\.Kind != "stopLimit" && !\(p\.Kind == "market" && r\.MarketEntry\)\)\s*return "an agent's entry is a limit or a stop-limit \(/, 'market only with the rule');
  assert.match(checks, /if \(p\.StopTicks < 1 \|\| p\.TargetTicks < 0 \|\| \(p\.TargetTicks < 1 && !r\.NoTarget\)\)\s*return "every agent entry needs a stop and a target/, 'a stop always; no target only with the rule');
  assert.match(checks, /if \(p\.Kind == "market"\)\s*\{[\s\S]*bad = ChartBridgeOrders\.AgentLastPrice\(root, out last\);[\s\S]*Math\.Abs\(p\.Price - last\) > ChartBridgeAgents\.MarketMaxTicks \* tick \+ 1e-9/, 'a market plan\'s price against ChartBridge\'s own fresh last trade');
  assert.match(acode, /public const int MarketMaxTicks = 20;/);
  // off unless the page says so: an older page (no key) turns both off; the file carries a line only when on
  assert.match(acode, /if \(d\.ContainsKey\("marketEntry"\)\) \{ if \(!Bool\(d, "marketEntry", out flag\)\) return "marketEntry must be true or false"; r\.MarketEntry = flag; \}/);
  assert.match(acode, /if \(r\.MarketEntry\) lines\.Add\("marketEntry\\ton"\);/);
  assert.match(acode, /\.Append\(r\.MarketEntry \? ",\\"marketEntry\\":true" : ""\)\.Append\(r\.NoTarget \? ",\\"noTarget\\":true" : ""\);/, 'each key only when on: a trader with neither reads as in 0.6.17');
  // the order path asks the same rules, and an agent whose rules cannot be read is allowed neither
  assert.match(acode, /public static bool MayMarket\(string id\) \{ ChartBridgeAgent a = Get\(id\); return a != null && a\.RuleAllows\(true\); \}/);
  assert.match(acode, /internal bool RuleAllows\(bool market\) \{ lock \(Sync\) return rulesBroken == null && \(market \? rules\.MarketEntry : rules\.NoTarget\); \}/);
  assert.equal((ocode.match(/ChartBridgeAgents\.May(Market|NoTarget)\(agent\)/g) || []).length, 2);
  const h = read(path.join('check', 'AgentHarness.cs'));
  for (const s of ['EntryRules();', 'entry rules: by default a market plan is refused, nothing sent', 'entry rules: the order path refuses an agent\'s market order by itself', 'entry rules: filled: one stop 8 ticks under the fill, and no target', 'entry rules: no stop is refused always', 'entry rules: a page that does not send them (an older page) turns both off'])
    assert.ok(h.includes(s), s);
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
  assert.match(acode, /\{ "plan", new\[\] \{[^}]*"confidence", "seatsRev", "sizes", "dayStopDollars", "dayLossDollars" \} \}/);
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
