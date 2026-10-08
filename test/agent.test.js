'use strict';
// The Agent tab's logic (live/agent-core.js, chart page 1.17.0; ChartBridge 0.5.0's agent channel, contract AGENT_CHANNEL
// v1): the agents and the picker, a proposal's life and its countdown to expiresAt, the feed of notes and plans, the rule
// form checked against the contract's allowed values, the account chooser, the agent's orders by `by: "agent:<id>"`, and
// the one copilot-key handler shared by the Bot tab and every agent. The agent here is the made-up "Demo Agent" (id demo);
// accounts are made up (Sim101, SIM-AG1, EVAL-A, SIM-F1).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const AC = require('../live/agent-core.js');
const BC = require('../live/bot-core.js');
const ACC = require('../live/accounts.js');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const T0 = Date.UTC(2026, 9, 8, 14, 0, 0);   // 10:00 New York

const RULES = { roots: 'NQ,MNQ', maxQty: { NQ: 2, MNQ: 20 }, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: null, maxLosses: null };
const agent = o => Object.assign({ type: 'agent', agent: 'demo', name: 'Demo Agent', build: 'sample-build-1', enabled: true, connected: true, mode: 'shadow', account: 'SIM-AG1', sim: true,
  rules: RULES, position: null, pnlToday: 0, trades: 0, losses: 0, killed: false, standDown: null, owns: false, lastBeatMs: 400, lastPlan: null }, o || {});
const proposal = o => Object.assign({ type: 'agentProposal', agent: 'demo', id: 'p1', at: T0, account: 'SIM-AG1', sim: true, root: 'MNQ', side: 'buy', kind: 'limit', price: 25400, qty: 2,
  stopTicks: 16, targetTicks: 32, expireSec: 600, riskDollars: 16, setup: 'Sample pullback', reason: 'Sample: a made-up reason', confidence: 0.62, expiresAt: T0 + 600000,
  state: 'open', seenAt: null, answeredAt: null }, o || {});

test('versions and the tab with no agent: an older ChartBridge says 0.5.0 or later', () => {
  assert.deepEqual(AC.parseVersion('fake-0.4.0'), [0, 4, 0]);
  assert.ok(AC.atLeast('0.5.0', '0.5.0') && AC.atLeast('0.5.1', '0.5.0') && AC.atLeast('fake-0.5.0', '0.5.0'));
  assert.ok(!AC.atLeast('0.4.3', '0.5.0') && !AC.atLeast('', '0.5.0'));
  assert.equal(AC.offText({ v3: null }), 'Connecting to ChartBridge...');
  assert.equal(AC.offText({ v3: false, version: '0.3.8' }), 'No agents on this ChartBridge (0.5.0 or later).');
  assert.equal(AC.offText({ v3: true, version: '0.4.3', trading: { enabled: true } }), 'No agents on this ChartBridge (0.5.0 or later).');
  assert.match(AC.offText({ v3: true, version: '0.5.0', trading: { enabled: true }, agents: 0 }), /none is named in its config\.txt/);
  assert.equal(AC.offText({ v3: true, version: '0.5.0', trading: { enabled: true }, agents: 1 }), '');
  assert.ok(AC.validId('manrae') && AC.validId('demo') && AC.validId('a1') && !AC.validId('1a') && !AC.validId('Demo') && !AC.validId('toolongagentid') && !AC.validId(''));
});

test('agents: kept by id, the picker keeps the choice while it is known, else the first', () => {
  const s = AC.createAgents();
  assert.equal(s.update({ type: 'agent', agent: 'Bad Id' }), null);
  const r1 = s.update(agent({ agent: 'manrae', name: 'Manrae' }));
  assert.equal(r1.prev, null);
  s.update(agent());
  const r2 = s.update(agent({ mode: 'copilot' }));
  assert.equal(r2.prev.mode, 'shadow'); assert.equal(r2.next.mode, 'copilot');
  assert.deepEqual(s.ids(), ['demo', 'manrae']);
  assert.equal(AC.pickAgent(s.ids(), 'manrae'), 'manrae');
  assert.equal(AC.pickAgent(s.ids(), 'gone'), 'demo');
  assert.equal(AC.pickAgent([], 'gone'), '');
  assert.equal(AC.agentName({ agent: 'demo' }), 'demo');
});

test('the strip: name, build, heartbeat, mode, SIM or LIVE, account, position, P&L, trades, losses, owner lock', () => {
  const orders = [{ id: 'NT1', by: 'agent:demo', account: 'SIM-AG1', root: 'MNQ', state: 'working', role: 'entry' }];
  const m = AC.stripModel(agent({ mode: 'copilot', owns: true, trades: 2, losses: 1, pnlToday: -12.5, rules: Object.assign({}, RULES, { maxTrades: 6, maxLosses: 3 }) }), orders, p => p.toFixed(2));
  assert.equal(m.name, 'Demo Agent'); assert.equal(m.build, 'sample-build-1'); assert.equal(m.mode, 'Copilot'); assert.equal(m.beat, '0.4 s ago');
  assert.equal(m.account, 'SIM-AG1'); assert.equal(m.accountMark, 'SIM'); assert.equal(m.pnl, '-$12.50'); assert.equal(m.pnlTone, 'neg');
  assert.equal(m.trades, '2 of 6'); assert.equal(m.losses, '1 of 3'); assert.equal(m.owns, 'owns SIM-AG1 MNQ'); assert.equal(m.position, 'Flat');
  const p = AC.stripModel(agent({ owns: true, position: { root: 'NQ', qty: -2, avgPrice: 25410.25 }, sim: false, account: 'EVAL-A' }), [], p => p.toFixed(2));
  assert.equal(p.position, 'Short 2 NQ @ 25410.25'); assert.equal(p.owns, 'owns EVAL-A NQ'); assert.equal(p.accountMark, 'LIVE'); assert.equal(p.trades, '0'); assert.equal(p.pnl, '$0.00');
  assert.equal(AC.stripModel(agent({ owns: false })).owns, '');
  assert.equal(AC.stripModel(agent({ connected: false })).beat, '-');
  assert.equal(AC.statusText(agent({ standDown: '3 losing trades today' })), 'Stood down: 3 losing trades today');
  assert.equal(AC.statusText(agent({ killed: true, standDown: 'x' })), 'Kill switch on: no agent orders');
  assert.equal(AC.statusText(agent({ connected: false })), 'Not connected: no agent program running');
  assert.equal(AC.agentAccount({}).name, 'Sim101'); assert.equal(AC.agentAccount({}).mark, '');
  const withPlan = AC.stripModel(agent({ lastPlan: { action: 'plan', at: T0, side: 'sell', qty: 1, root: 'NQ', setup: 'Sample fade', result: 'refused: outside the entry window' } }));
  assert.equal(withPlan.last, 'Last plan 10:00 Sell 1 NQ · Sample fade: refused: outside the entry window');
});

test('notices between two agent messages: entry, exit, stand-down, heartbeat, kill, mode, account', () => {
  const a = agent(), n = (x, y) => AC.noticesFrom(x, y, p => String(p)).map(z => z.kind + ':' + z.level);
  assert.deepEqual(n(a, agent({ position: { root: 'MNQ', qty: 2, avgPrice: 25400 } })), ['entry:']);
  assert.deepEqual(n(agent({ position: { root: 'MNQ', qty: 2, avgPrice: 25400 } }), agent({ position: null, pnlToday: 32 })), ['exit:']);
  assert.deepEqual(n(a, agent({ standDown: 'x', connected: false })), ['standDown:red', 'heartbeat:red']);
  assert.deepEqual(n(a, agent({ killed: true, mode: 'auto' })), ['kill:red', 'mode:amber']);
  assert.deepEqual(n(a, agent({ account: 'EVAL-A', sim: false })), ['account:amber']);
  assert.deepEqual(n(null, a), []);
});

test('proposals: shown once (agentSeen), answered once (agentAnswer), ended with its state; keyed by agent and id', () => {
  const P = AC.createProposals();
  assert.equal(P.update({ type: 'agentProposal', agent: 'demo' }).act, 'none');
  assert.equal(P.update(proposal()).act, 'show');
  assert.equal(P.update(proposal({ agent: 'manrae', at: T0 + 5 })).act, 'show', 'the same id from another agent is another proposal');
  assert.deepEqual(P.shown('demo', 'p1', T0 + 120.4), { type: 'agentSeen', agent: 'demo', id: 'p1', at: T0 + 120 });
  assert.equal(P.shown('demo', 'p1', T0 + 300), null, 'agentSeen once');
  assert.equal(P.update(proposal({ seenAt: T0 + 120 })).act, 'update');
  assert.deepEqual(P.answer('demo', 'p1', 'accept', T0 + 1500, 'c1').msg, { type: 'agentAnswer', cid: 'c1', agent: 'demo', id: 'p1', answer: 'accept', at: T0 + 1500 });
  assert.match(P.answer('demo', 'p1', 'reject', T0 + 1600).error, /Already answered/);
  P.refused('demo', 'p1');
  assert.ok(P.answer('demo', 'p1', 'reject', T0 + 1700).msg, 'after a refusal it can be answered again');
  assert.match(P.answer('demo', 'p1', 'maybe', T0).error, /accept or reject/);
  assert.match(P.answer('demo', 'nope', 'accept', T0).error, /No proposal/);
  assert.deepEqual(P.open().map(p => p.agent), ['demo', 'manrae']);
  assert.deepEqual(P.open('manrae').map(p => p.agent), ['manrae']);
  const end = P.update(proposal({ state: 'expired' }));
  assert.equal(end.act, 'end'); assert.equal(end.why, 'expired');
  assert.equal(P.update(proposal({ state: 'expired' })).act, 'none');
  assert.match(P.answer('demo', 'p1', 'accept', T0).error, /expired/);
  assert.equal(P.update(proposal({ id: 'late', state: 'withdrawn' })).act, 'none', 'ended before it showed here: nothing to show');
  assert.equal(P.clear().length, 1);
  assert.equal(P.open().length, 0);
  for (const s of ['accepted', 'rejected', 'withdrawn', 'not answered', 'expired']) assert.ok(AC.endText(s, 'Demo Agent', 'SIM-AG1').length > 5);
});

test('proposal countdown to expiresAt: minutes and seconds, Accept closes 5 s before, then expired', () => {
  assert.deepEqual(AC.countdown(T0 + 272000, T0), { ms: 272000, text: '4:32', late: false, over: false });
  assert.equal(AC.countdown(T0 + 5000, T0).late, false);
  assert.equal(AC.countdown(T0 + 4999, T0).late, true);
  assert.equal(AC.countdown(T0 + 4200, T0).text, '0:05');
  assert.deepEqual(AC.countdown(T0, T0 + 10), { ms: 0, text: '0:00', late: true, over: true });
  assert.equal(AC.countdown(undefined, T0).text, '-');
  const P = AC.createProposals();
  P.update(proposal({ expiresAt: T0 + 4000 }));
  assert.match(P.answer('demo', 'p1', 'accept', T0).error, /Too late to accept/);
  assert.ok(P.answer('demo', 'p1', 'reject', T0).msg, 'Reject still goes in the last 5 s');
  const lp = AC.legPrices(proposal(), 0.25);
  assert.deepEqual(lp, { stop: 25396, target: 25408 });
  assert.deepEqual(AC.legPrices(proposal({ side: 'sell', kind: 'stopLimit', price: 25390, limitPrice: 25388 }), 0.25), { stop: 25392, target: 25380 });
});

test('feed: notes and plans newest first, repeats dropped, a plan id replaced by its result, the caps', () => {
  const F = AC.createFeed();
  assert.ok(F.note({ type: 'agentNote', agent: 'demo', at: T0, kind: 'look', text: 'Sample look' }));
  assert.ok(!F.note({ type: 'agentNote', agent: 'demo', at: T0, kind: 'look', text: 'Sample look' }), 'a page that signs in again gets the last 200 again: no repeat');
  assert.ok(!F.note({ type: 'agentNote', agent: 'demo', at: T0, kind: 'shout', text: 'x' }), 'only the five kinds');
  F.note({ type: 'agentNote', agent: 'demo', at: T0 + 2000, kind: 'thinking', text: 'Sample thinking' });
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'p1', at: T0 + 1000, action: 'plan', side: 'buy', qty: 2, root: 'MNQ', setup: 'Sample pullback', result: 'proposed' });
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'p1', at: T0 + 1000, action: 'plan', side: 'buy', qty: 2, root: 'MNQ', setup: 'Sample pullback', result: 'placed' });
  F.plan({ type: 'agentPlan', agent: 'manrae', id: 'p1', at: T0 + 3000, action: 'skip', reason: 'Sample skip', result: 'skipped' });
  const it = F.items('demo');
  assert.deepEqual(it.map(x => x.type + ':' + (x.m.kind || x.m.result)), ['note:thinking', 'plan:placed', 'note:look']);
  assert.deepEqual(F.items('demo', 'plans').length, 1);
  assert.deepEqual(F.items('demo', 'thinking').length, 1);
  assert.deepEqual(F.counts('manrae'), { notes: 0, plans: 1 });
  for (let i = 0; i < 260; i++) F.note({ type: 'agentNote', agent: 'demo', at: T0 + 10000 + i, kind: 'status', text: 'n' + i });
  for (let i = 0; i < 70; i++) F.plan({ type: 'agentPlan', agent: 'demo', id: 'q' + i, at: T0 + 10000 + i, action: 'skip', result: 'skipped' });
  assert.deepEqual(F.counts('demo'), { notes: 200, plans: 50 });
  assert.equal(F.items('demo', 'notes')[0].m.text, 'n259');
  assert.equal(AC.planLine({ action: 'plan', side: 'sell', qty: 1, root: 'NQ', result: 'refused: outside the entry window' }).tone, 'bad');
  assert.equal(AC.planLine({ action: 'plan', side: 'sell', qty: 1, root: 'NQ', result: 'refused: outside the entry window' }).result, 'refused: outside the entry window');
  assert.equal(AC.planLine({ action: 'skip', setup: 'Sample', result: 'skipped' }).title, 'Skipped · Sample');
  assert.equal(AC.planLine({ action: 'plan', side: 'buy', qty: 2, root: 'MNQ', result: 'shadow' }).tone, 'shadow');
});

test('rules: read in every shape the contract leaves open; the panel lines', () => {
  const r = AC.parseRules(RULES);
  assert.deepEqual(r.roots, ['NQ', 'MNQ']); assert.deepEqual(r.maxQty, { NQ: 2, MNQ: 20 }); assert.equal(r.maxTrades, null);
  const flat = AC.parseRules({ roots: ['MNQ'], maxQtyMNQ: 5, entryFrom: '09:45', entryUntil: '11:00', flatAt: '11:30', maxExpireSec: 600, maxTrades: 0, maxLosses: 3 });
  assert.deepEqual(flat.maxQty, { MNQ: 5 }); assert.equal(flat.maxTrades, null); assert.equal(flat.maxLosses, 3);
  assert.equal(AC.parseRules(null), null);
  const lines = Object.fromEntries(AC.rulesLines(RULES));
  assert.equal(lines['Size at most'], '2 NQ, 20 MNQ'); assert.equal(lines['Entry lives'], 'at most 30 min'); assert.equal(lines['Trades a day'], 'no limit');
  assert.equal(AC.durationText(90), '1 min 30 s');
  const f = AC.rulesForm(RULES);
  assert.deepEqual(f.roots, ['NQ', 'MNQ']); assert.equal(f.maxQty.ES, '2'); assert.equal(f.maxQty.MES, '20'); assert.equal(f.maxTrades, '0');
});

test('rules change: flat keys exactly as the contract (section 7), checked against section 3\'s allowed values', () => {
  const a = agent(), ctx = { roots: ['NQ', 'MNQ', 'ES', 'MES'] };
  const form = o => Object.assign(AC.rulesForm(RULES), o || {});
  const ok = AC.rulesChange(a, form({ roots: ['MNQ', 'NQ'], maxQty: { NQ: '1', MNQ: '10', ES: '2', MES: '20' }, maxTrades: '6', maxLosses: '3' }), ctx, 'c9');
  assert.deepEqual(ok.msg, { type: 'agentRules', cid: 'c9', agent: 'demo', roots: 'NQ,MNQ', maxQtyNQ: 1, maxQtyMNQ: 10, entryFrom: '09:45', entryUntil: '15:00', flatAt: '15:55', maxExpireSec: 1800, maxTrades: 6, maxLosses: 3 });
  assert.deepEqual(Object.keys(ok.msg).filter(k => typeof ok.msg[k] === 'object'), [], 'flat: no nesting');
  const err = o => AC.rulesChange(a, form(o), ctx).error || '';
  assert.match(err({}), /Nothing to change/);
  assert.match(err({ roots: [] }), /at least one root/);
  assert.match(AC.rulesChange(a, form({ roots: ['ES'] }), { roots: ['NQ', 'MNQ'] }).error, /ES is not traded/);
  assert.match(err({ maxQty: { NQ: '3', MNQ: '20' } }), /NQ must be a whole number from 1 to 2/);
  assert.match(err({ maxQty: { NQ: '2', MNQ: '21' } }), /MNQ must be a whole number from 1 to 20/);
  assert.match(err({ maxQty: { NQ: '0', MNQ: '20' } }), /from 1 to 2/);
  assert.match(err({ maxQty: { NQ: '1.5', MNQ: '20' } }), /from 1 to 2/);
  assert.ok(AC.rulesChange(a, form({ roots: ['MNQ'], maxQty: { NQ: '99', MNQ: '20' }, maxTrades: '5' }), ctx).msg, 'a root not chosen is not checked or sent');
  assert.equal(AC.rulesChange(a, form({ roots: ['MNQ'], maxTrades: '5' }), ctx).msg.maxQtyNQ, undefined);
  assert.match(err({ entryFrom: '9:45' }), /New York time/);
  assert.match(err({ entryFrom: '09:29' }), /09:30 at the earliest/);
  assert.ok(AC.rulesChange(a, form({ entryFrom: '09:30' }), ctx).msg);
  assert.match(err({ entryFrom: '15:00' }), /start before they end/);
  assert.match(err({ flatAt: '15:00' }), /after new entries end/);
  assert.match(err({ flatAt: '16:00' }), /15:59 at the latest/);
  assert.ok(AC.rulesChange(a, form({ flatAt: '15:59' }), ctx).msg);
  assert.match(err({ maxExpireSec: '59' }), /from 60 to 1800/);
  assert.match(err({ maxExpireSec: '1801' }), /from 60 to 1800/);
  assert.ok(AC.rulesChange(a, form({ maxExpireSec: '60' }), ctx).msg);
  assert.match(err({ maxTrades: '51' }), /1 to 50/);
  assert.match(err({ maxLosses: '21' }), /1 to 20/);
  assert.match(err({ maxLosses: '-1' }), /1 to 20/);
  assert.equal(AC.rulesChange(a, form({ maxTrades: '', maxLosses: '20' }), ctx).msg.maxTrades, 0, 'empty is none (0)');
  assert.equal(AC.rulesChange(a, form({ maxTrades: '50' }), ctx).msg.maxTrades, 50);
  // only while flat with no working entry and no open proposal (ChartBridge refuses it otherwise)
  assert.match(AC.rulesChange(agent({ position: { root: 'MNQ', qty: 1, avgPrice: 1 } }), form({ maxTrades: '5' }), ctx).error, /has a position/);
  assert.match(AC.rulesChange(a, form({ maxTrades: '5' }), Object.assign({ workingEntry: true }, ctx)).error, /working entry/);
  assert.match(AC.rulesChange(a, form({ maxTrades: '5' }), Object.assign({ openProposals: 1 }, ctx)).error, /open proposal/);
  assert.deepEqual(AC.rulesChangeable(a, {}), { ok: true, why: '' });
});

test('account chooser: tradable accounts, SIM first; never the bot\'s, the copier\'s or another agent\'s; LIVE asked once', () => {
  const accounts = { list: [
    { name: 'Sim101', sim: true, tradable: true, state: 'active' }, { name: 'SIM-AG1', sim: true, tradable: true, state: 'active' },
    { name: 'SIM-F1', sim: true, tradable: true, state: 'active' }, { name: 'SIM-X', sim: true, tradable: true, state: 'active' },
    { name: 'EVAL-A', sim: false, tradable: true, state: 'active' }, { name: 'EVAL-B', sim: false, tradable: false, state: 'gone' },
    { name: 'FUNDED-C', sim: false, tradable: true, state: 'active' } ] };
  const others = { bot: { enabled: true, account: 'Sim101' }, copier: { enabled: true, leader: { account: 'FUNDED-C' }, followers: [{ account: 'SIM-F1', on: false }] },
    agents: [agent(), agent({ agent: 'manrae', name: 'Manrae', account: 'SIM-X' })] };
  const a = agent({ account: 'SIM-AG1' });
  const ch = AC.accountChoices(accounts, a, others);
  assert.deepEqual(ch.map(c => c.name), ['SIM-AG1', 'SIM-F1', 'SIM-X', 'Sim101', 'EVAL-A', 'FUNDED-C']);
  const by = Object.fromEntries(ch.map(c => [c.name, c]));
  assert.equal(by['Sim101'].why, 'the bot\'s account');
  assert.equal(by['FUNDED-C'].why, 'the copier\'s leader');
  assert.equal(by['SIM-F1'].why, 'a copier follower');
  assert.equal(by['SIM-X'].why, 'Manrae\'s account');
  assert.ok(by['SIM-AG1'].current && !by['SIM-AG1'].ok);
  assert.ok(by['EVAL-A'].ok && by['EVAL-A'].mark === 'LIVE');
  assert.ok(!('EVAL-B' in by), 'a gone account is not offered');
  assert.match(AC.accountChange(a, 'Sim101', ch, {}).error, /the bot's account: an agent trades an account of its own/);
  assert.match(AC.accountChange(a, 'SIM-AG1', ch, {}).error, /already/);
  assert.match(AC.accountChange(a, 'EVAL-B', ch, {}).error, /not tradable/);
  assert.match(AC.accountChange(a, '', ch, {}).error, /Choose/);
  const live = AC.accountChange(a, 'EVAL-A', ch, {}, 'c3');
  assert.deepEqual(live.msg, { type: 'agentAccount', cid: 'c3', agent: 'demo', account: 'EVAL-A' });
  assert.equal(live.live, true); assert.equal(live.confirm, 'Demo Agent will trade LIVE account EVAL-A. Continue?');
  const off = AC.accountChoices(accounts, a, { bot: { enabled: false, account: 'Sim101' } });
  assert.equal(off.find(c => c.name === 'Sim101').why, '', 'with the bot channel off its account is free');
  assert.match(AC.accountChange(agent({ position: { root: 'MNQ', qty: 1 } }), 'EVAL-A', ch, {}).error, /choose its account when it is flat/);
  assert.match(AC.accountChange(a, 'EVAL-A', ch, { openProposals: 2 }).error, /open proposal/);
});

test('modes and kill: auto needs the account tradable; the messages', () => {
  assert.equal(AC.modesAllowed({ tradable: false, account: 'SIM-AG1' }).auto.why, 'Auto needs SIM-AG1 to be tradable in ChartBridge.');
  assert.ok(AC.modesAllowed({ tradable: true }).auto.ok && AC.modesAllowed({}).copilot.ok);
  assert.deepEqual(AC.modeMsg('demo', 'copilot', 'c1'), { type: 'agentMode', cid: 'c1', agent: 'demo', mode: 'copilot' });
  assert.equal(AC.modeMsg('demo', 'yolo'), null);
  assert.deepEqual(AC.killMsg('demo', true), { type: 'agentKill', agent: 'demo', on: true });
  assert.ok(AC.accountTradable({ list: [{ name: 'SIM-AG1', tradable: true }] }, null, 'SIM-AG1'));
  assert.ok(!AC.accountTradable({ list: [{ name: 'SIM-AG1', tradable: true, state: 'gone' }] }, null, 'SIM-AG1'));
  assert.ok(AC.accountTradable(null, { enabled: true, accounts: ['Sim101'] }, ''));
});

test('the agent\'s orders: by "agent:<id>" on its own account only; its fills claimed with the bot\'s ledger', () => {
  const a = agent();
  const mine = { id: 'NT5', by: 'agent:demo', account: 'SIM-AG1', root: 'MNQ', side: 'buy', state: 'working', role: 'entry', filled: 0 };
  assert.equal(AC.agentOfOrder(mine), 'demo');
  assert.ok(AC.isAgentMark(mine, a));
  assert.ok(!AC.isAgentMark(Object.assign({}, mine, { by: 'agent:manrae' }), a));
  assert.ok(!AC.isAgentMark(Object.assign({}, mine, { by: 'bot' }), a));
  assert.ok(!AC.isAgentMark(Object.assign({}, mine, { account: 'Sim101' }), a), 'Anthony\'s own account');
  assert.ok(!AC.isAgentMark(Object.assign({}, mine, { by: undefined }), a));
  assert.equal(AC.workingEntries([mine, Object.assign({}, mine, { id: 'NT6', role: 'stop' }), Object.assign({}, mine, { id: 'NT7', state: 'filled' })], a).length, 1);
  // BotCore's ledger with the agent's mark (1.17.0): a fill is claimed against the agent's own orders only
  const L = BC.botFillLedger(AC.isAgentMark);
  assert.ok(L.order(Object.assign({}, mine, { filled: 2, avgFill: 25400, state: 'filled' }), a));
  assert.ok(!L.claim({ id: 'X1', account: 'SIM-AG1', root: 'MNQ', side: 'sell', qty: 2, p: 25400 }), 'the other side is not this order');
  assert.ok(L.claim({ id: 'X2', account: 'SIM-AG1', root: 'MNQ', side: 'buy', qty: 2, p: 25400 }));
  const B = BC.botFillLedger();
  assert.ok(!B.order(Object.assign({}, mine, { filled: 2 }), { account: 'SIM-AG1' }), 'the bot\'s own ledger still takes only `by: "bot"`');
  assert.ok(B.order({ id: 'NT9', by: 'bot', account: 'Sim101', root: 'MNQ', side: 'buy', filled: 1, avgFill: 1 }, { account: 'Sim101' }));
  // the Account page names an agent's order plainly
  assert.equal(ACC.orderName({ side: 'buy', kind: 'limit', role: 'entry', by: 'agent:demo' }), 'Buy limit · agent demo');
  assert.equal(ACC.orderName({ side: 'sell', kind: 'stop', role: 'stop', by: 'bot' }), 'Sell stop · bot');
});

test('copilot keys: one handler answers the oldest open proposal across the bot and every agent', () => {
  const R = AC.createCopilotRouter(), done = [];
  const src = (name, list) => ({ open: () => list.map(x => ({ id: x.id, shownAt: x.at, answer: ans => { done.push(name + ':' + x.id + ':' + ans); return true; } })) });
  const bot = [], demo = [], manrae = [];
  R.add('bot', src('bot', bot)); R.add('agents', { open: () => src('demo', demo).open().concat(src('manrae', manrae).open()) });
  assert.equal(R.handle('accept'), null, 'nothing open: the event is left alone (the workspace says so)');
  bot.push({ id: 'b1', at: 2000 });
  assert.equal(R.handle('accept').source, 'bot', 'only the bot\'s open: the bot\'s, exactly as in 1.16.0');
  demo.push({ id: 'd1', at: 1000 }); manrae.push({ id: 'm1', at: 1500 });
  R.handle('reject');
  assert.deepEqual(done, ['bot:b1:accept', 'demo:d1:reject'], 'the oldest across all of them: the agent\'s, shown first');
  demo.length = 0;
  R.handle('accept');
  assert.equal(done[2], 'manrae:m1:accept');
  manrae.length = 0; bot.length = 0; bot.push({ id: 'b2', at: 3000 }); demo.push({ id: 'd2', at: 3000 });
  R.handle('accept');
  assert.equal(done[3], 'bot:b2:accept', 'a tie goes to the source added first (the Bot tab)');
  assert.equal(R.handle('maybe'), null);
  // the document's one router and its one listener: preventDefault only when something was answered
  const listeners = [];
  const doc = { addEventListener: (t, f) => listeners.push([t, f]) };
  const r1 = AC.copilotRouter(doc), r2 = AC.copilotRouter(doc);
  assert.equal(r1, r2); assert.equal(listeners.length, 1); assert.equal(listeners[0][0], 'chart-copilot-key');
  const fire = ans => { let prevented = false; listeners[0][1]({ detail: { answer: ans }, preventDefault: () => { prevented = true; } }); return prevented; };
  assert.equal(fire('accept'), false);
  let answered = '';
  r1.add('agents', { open: () => [{ id: 'd9', shownAt: 1, answer: a => { answered = a; } }] });
  assert.equal(fire('reject'), true); assert.equal(answered, 'reject');
});

test('wiring: the workspace and agent.html load the Agent tab; bot.js shares the one copilot-key handler; versions 1.17.0', () => {
  const idx = read('live', 'index.html'), pop = read('live', 'agent.html'), bot = read('live', 'bot.js'), ws = read('live', 'workspace.js');
  assert.ok(idx.indexOf('agent-core.js') > 0 && idx.indexOf('agent-core.js') < idx.indexOf('src="bot.js"'), 'agent-core.js before bot.js (the router exists when the Bot tab starts)');
  assert.ok(idx.indexOf('src="agent.js"') > idx.indexOf('src="bot.js"') && idx.indexOf('src="agent.js"') < idx.indexOf('src="workspace.js"'));
  assert.match(idx, /agent\.css/); assert.match(idx, /id="wsAgentTab"/); assert.match(idx, /id="agView"/);
  assert.match(pop, /agent-core\.js/); assert.match(pop, /AgentDesk\.create\(\{ popout: true/);
  assert.match(bot, /copilotRouter\(document\)/);
  assert.match(ws, /AgentDesk\.create/);
  assert.equal(JSON.parse(read('package.json')).version, '1.17.0');
  assert.match(read('src', 'chart-engine.js'), /const VERSION = '1\.17\.0'/);
  assert.match(read('src', 'chart-engine.js'), /^\/\*!\n \* chart-engine 1\.17\.0/);
  for (const f of ['live/agent.js', 'live/agent-core.js', 'live/agent.css', 'live/agent.html', 'docs/AGENT_TAB.md']) assert.doesNotMatch(read(f), /[–—]/, f + ': no em or en dashes');
});
