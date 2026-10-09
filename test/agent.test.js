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
  assert.equal(live.live, true);
  assert.equal(live.confirm, 'Demo Agent is in Shadow: it will trade LIVE account EVAL-A once you put it in Copilot or Auto. The agent goes to Shadow when its account changes. Continue?');
  assert.equal(AC.accountChange(agent({ mode: 'auto' }), 'EVAL-A', ch, {}).confirm, 'Demo Agent is in Auto: it will trade LIVE account EVAL-A once it is back in Auto. The agent goes to Shadow when its account changes. Continue?', 'the question names the mode (review S5)');
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

/* the copilot keys' router: a fake clock, a made-up bot proposal list and two agents' lists */
function routerRig() {
  let t = 100000;
  const R = AC.createCopilotRouter(() => t), done = [], bot = [], ag = [], view = { focus: '' };
  const entry = (who, x) => ({ id: x.id, agent: who === 'bot' ? undefined : who, shownAt: x.at, answered: !!x.answered, expiresAt: x.exp === undefined ? t + 600000 : x.exp,
    answer: ans => { if (x.answered) return false; x.answered = ans; done.push(who + ':' + x.id + ':' + ans); return true; } });
  R.add('bot', { open: () => bot.map(x => entry('bot', x)) });
  R.add('agents', { kind: 'agents', open: () => ag.map(x => entry(x.agent, x)), focus: () => view.focus });
  return { R, done, bot, ag, view, at: () => t, advance: ms => { t += ms; } };
}

test('copilot keys, the bot alone: exactly 1.16.0 (the oldest bot proposal; nothing open leaves the event alone)', () => {
  const g = routerRig();
  assert.equal(g.R.handle('accept').act, 'none', 'nothing open: the workspace says "no copilot proposal to answer here"');
  g.bot.push({ id: 'b2', at: g.at() - 50 }, { id: 'b1', at: g.at() - 100 });
  assert.equal(g.R.handle('accept').entry.id, 'b1', 'the oldest, even with two bot proposals open, and even one just shown');
  assert.deepEqual(g.done, ['bot:b1:accept']);
  assert.equal(g.R.handle('reject').entry.id, 'b1', 'answered and waiting: it stays the target (the bot\'s own card says "Already answered")');
  assert.deepEqual(g.done, ['bot:b1:accept'], 'nothing else answered');
  assert.equal(g.R.handle('maybe').act, 'none');
});

test('copilot keys, the bot\'s card arming (1 s after it shows) or not whole in the window: the key answers nothing', () => {
  const R = AC.createCopilotRouter(() => 5000), done = [];
  let ready = false;
  R.add('bot', { open: () => [{ id: 'b1', shownAt: 4900, ready, answer: ans => { done.push(ans); return true; } }] });
  assert.deepEqual(R.handle('accept'), { act: 'say', text: AC.KEY_SAY.arming });
  assert.deepEqual(done, [], 'a press while it arms does nothing, and is not kept');
  ready = true;
  assert.equal(R.handle('accept').act, 'answer');
  assert.deepEqual(done, ['accept'], 'armed: answered once');
});

test('copilot keys, B1: a double press never answers a second, different proposal', () => {
  // the Agent tab on demo: demo's proposal answered by the first press; the second press within 1 s answers nothing
  const g = routerRig();
  g.view.focus = 'demo';
  g.ag.push({ agent: 'demo', id: 'k1', at: g.at() - 3000 }, { agent: 'demo', id: 'k3', at: g.at() - 2000 }, { agent: 'demotwo', id: 'k2', at: g.at() - 2500 });
  assert.equal(g.R.handle('accept').entry.id, 'k1');
  g.advance(80);
  const second = g.R.handle('accept');
  assert.deepEqual([second.act, second.text], ['say', AC.KEY_SAY.locked], 'the keys rest 1 s after an answer');
  assert.deepEqual(g.done, ['demo:k1:accept']);
  g.advance(1000);
  assert.equal(g.R.handle('accept').entry.id, 'k1', '(a) answered and waiting, it is still the target: never the next one');
  assert.deepEqual(g.done, ['demo:k1:accept'], 'k3 and demotwo\'s k2 untouched');
  // elsewhere with two agents' proposals open: neither press answers anything
  const h = routerRig();
  h.ag.push({ agent: 'demo', id: 'k1', at: h.at() - 3000 }, { agent: 'demotwo', id: 'k2', at: h.at() - 2500 });
  assert.deepEqual(h.R.handle('accept'), { act: 'say', text: 'More than one proposal is open: click the one you mean' });
  h.advance(60);
  assert.equal(h.R.handle('accept').act, 'say');
  assert.deepEqual(h.done, []);
  // (c) a proposal on screen under 1 s is never answered by a key
  const f = routerRig();
  f.ag.push({ agent: 'demo', id: 'n1', at: f.at() - 400 });
  assert.deepEqual(f.R.handle('accept'), { act: 'say', text: AC.KEY_SAY.fresh });
  f.advance(700);
  assert.equal(f.R.handle('accept').entry.id, 'n1');
});

test('copilot keys, S1 and N1: the tab answers its agent only; elsewhere exactly one open is answered; never the last 5 s', () => {
  const g = routerRig();
  g.view.focus = 'demotwo';
  g.ag.push({ agent: 'demo', id: 'old1', at: g.at() - 9000 }, { agent: 'demotwo', id: 'new1', at: g.at() - 2000 });
  g.bot.push({ id: 'b1', at: g.at() - 10000 });
  assert.equal(g.R.handle('accept').entry.id, 'new1', 'the shown agent\'s, not the older ones elsewhere');
  const e = routerRig();
  e.view.focus = 'demo';
  e.bot.push({ id: 'b1', at: e.at() - 10000 });
  assert.match(e.R.handle('accept').text, /only demo's proposals/, 'the tab open with none of its agent\'s: nothing answered, said');
  assert.deepEqual(e.done, [], 'the bot\'s proposal (not shown on the Agent tab) untouched');
  // the tab open on its "no agents" card (focus true): the bot's proposal, hidden there, is never answered by a key
  const z = routerRig();
  z.view.focus = true;
  z.bot.push({ id: 'b1', at: z.at() - 10000 });
  assert.equal(z.R.handle('accept').act, 'say');
  assert.equal(z.R.handle('reject').act, 'say');
  assert.deepEqual(z.done, [], 'nothing answered while the tab is open with no agent shown');
  // elsewhere: one open in all (an agent's) is answered; one agent's and one bot's: none
  const one = routerRig();
  one.ag.push({ agent: 'demo', id: 'only', at: one.at() - 2000 });
  assert.equal(one.R.handle('reject').entry.id, 'only');
  const mix = routerRig();
  mix.ag.push({ agent: 'demo', id: 'a1', at: mix.at() - 2000 }); mix.bot.push({ id: 'b1', at: mix.at() - 5000 });
  assert.equal(mix.R.handle('accept').text, AC.KEY_SAY.many);
  assert.deepEqual(mix.done, []);
  // N1: the last 5 s (and no expiry at all) are never a key's
  const l = routerRig();
  l.ag.push({ agent: 'demo', id: 'late', at: l.at() - 9000, exp: l.at() + 4000 });
  assert.equal(l.R.handle('reject').text, AC.KEY_SAY.late);
  const n = routerRig();
  n.ag.push({ agent: 'demo', id: 'noexp', at: n.at() - 9000, exp: null });
  assert.equal(n.R.handle('accept').text, AC.KEY_SAY.late);
  const tab = routerRig();
  tab.view.focus = 'demo';
  tab.ag.push({ agent: 'demo', id: 'late', at: tab.at() - 9000, exp: tab.at() + 3000 }, { agent: 'demo', id: 'fine', at: tab.at() - 5000 });
  assert.equal(tab.R.handle('accept').entry.id, 'fine', 'in the tab the oldest not in its last 5 s');
  assert.deepEqual(l.done.concat(n.done), []);
});

test('copilot keys: the document\'s one router and its one listener; what it says goes back on the event', () => {
  const listeners = [];
  const doc = { addEventListener: (t, f) => listeners.push([t, f]) };
  const r1 = AC.copilotRouter(doc), r2 = AC.copilotRouter(doc);
  assert.equal(r1, r2); assert.equal(listeners.length, 1); assert.equal(listeners[0][0], 'chart-copilot-key');
  const fire = ans => { const e = { detail: { answer: ans }, prevented: false, preventDefault() { this.prevented = true; } }; listeners[0][1](e); return e; };
  assert.equal(fire('accept').prevented, false, 'nothing open: left alone');
  let answered = '';
  r1.add('agents', { kind: 'agents', open: () => [{ id: 'd9', agent: 'demo', shownAt: Date.now() - 5000, expiresAt: Date.now() + 60000, answer: a => { answered = a; } },
    { id: 'd8', agent: 'demotwo', shownAt: Date.now() - 6000, expiresAt: Date.now() + 60000, answer: a => { answered = a; } }] });
  const e = fire('reject');
  assert.ok(e.prevented); assert.equal(e.detail.said, AC.KEY_SAY.many); assert.equal(answered, '');
});

test('S3: a second click confirms within 4 s, but never one under 400 ms after the first (a double-click)', () => {
  assert.equal(BC.confirmStep(null, 1000), 'arm');
  const armed = { at: 1000, until: 1000 + BC.CONFIRM_MS };
  assert.equal(BC.confirmStep(armed, 1000 + 120), 'ignore');
  assert.equal(BC.confirmStep(armed, 1000 + 399), 'ignore');
  assert.equal(BC.confirmStep(armed, 1000 + 400), 'confirm');
  assert.equal(BC.confirmStep(armed, 1000 + 3999), 'confirm');
  assert.equal(BC.confirmStep(armed, 1000 + 4000), 'arm', 'after 4 s it starts again');
  const bot = read('live', 'bot.js'), ag = read('live', 'agent.js');
  assert.equal((bot.match(/BC\.confirmStep\(/g) || []).length, 2, 'the Bot tab: Auto and the release');
  assert.equal((ag.match(/BC\.confirmStep\(/g) || []).length, 2, 'the Agent tab: Auto and the release');
});

test('S2 and N5: a refused duplicate keeps its own line; Accept needs an expiry', () => {
  const F = AC.createFeed();
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'p1', at: 1000, action: 'plan', side: 'buy', qty: 2, root: 'MNQ', result: 'proposed' });
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'p1', at: 2000, action: 'plan', side: 'sell', qty: 1, root: 'MNQ', result: 'refused: plan id p1 was used today' });
  assert.deepEqual(F.items('demo', 'plans').map(x => x.m.result.split(':')[0]), ['refused', 'proposed']);
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'r1', at: 3000, action: 'plan', result: 'refused: x' });
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'r1', at: 3000, action: 'plan', result: 'refused: x' });
  assert.equal(F.counts('demo').plans, 3, 'a repeat of a refused one replaces it (a page that signs in again)');
  const P = AC.createProposals();
  P.update(proposal({ expiresAt: undefined }));
  assert.match(P.answer('demo', 'p1', 'accept', T0).error, /No expiry known/);
  assert.ok(P.answer('demo', 'p1', 'reject', T0).msg, 'Reject still goes');
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
  for (const f of ['live/agent.js', 'live/agent-core.js', 'live/agent.css', 'live/agent.html', 'docs/AGENT_TAB.md']) assert.doesNotMatch(read(f), /[\u2013\u2014]/, f + ': no em or en dashes');
});

test('ChartBridge 0.5.0 as built (agent-channel 4d4a81f): every status line naming an agent is that agent\'s notice', () => {
  const ids = ['demo', 'demotwo'];
  /* the texts as nt8/ChartBridgeAgents.cs on origin/agent-channel 4d4a81f writes them (about lines 2339, 2347, 2436, 2584) */
  const lines = {
    lost: 'agent demo had an open trade on SIM-AG1 MNQ and its legs are gone; ChartBridge no longer treats the position as the agent\'s: flatten or protect it by hand',
    noRecord: 'agent demo holds 1 on SIM-AG1 MNQ with no trade record (ChartBridge restarted); only its own stop protects it: ChartBridge keeps that stop and closes the position at its flat time; check NinjaTrader',
    noLonger: 'SIM-AG1 MNQ is no longer agent demo\'s: ChartBridge did not close it',
    rest: 'SIM-AG1 MNQ: agent demo\'s 1 closed; the rest (2) is not agent demo\'s: ChartBridge did not close it',
    flatTime: 'demo flattened at 15:55 by its rules',
    prefixed: 'Agent demo: NOT FLAT 10 s after its flatten (flat time): MNQ on SIM-AG1 still shows 1; act in NinjaTrader now',
    cancel: 'Agent demo: the cancel of its entry CB#o12 ag:demo s16 t32 on SIM-AG1 is still not confirmed after 10 tries (the kill switch); ChartBridge tries again every 30 s; cancel it in NinjaTrader now',
  };
  for (const [k, t] of Object.entries(lines)) assert.equal(AC.statusAgent(t, ids), 'demo', k + ': ' + t);
  assert.equal(AC.statusAgent('SIM-AG2 NQ is no longer agent demotwo\'s: ChartBridge did not close it', ids), 'demotwo', 'never the shorter id inside a longer one');
  assert.equal(AC.statusAgent('AGENT DEMO had an open trade', ids), 'demo', 'any case');
  assert.equal(AC.statusAgent('demonstration of nothing', ids), '');
  assert.equal(AC.statusAgent('EVAL-B is gone (disconnected for 10 s): entries wait until it is back', ids), '', 'an account line is no agent\'s');
  assert.equal(AC.statusAgent(null, ids), '');
});

test('the kill switch on: a second press within 1 s is the same press (a double click sends agentKill once)', () => {
  assert.equal(AC.KILL_REPEAT_MS, 1000);
  assert.ok(!AC.killOnRepeat(undefined, 5000), 'the first press');
  assert.ok(AC.killOnRepeat(5000, 5000) && AC.killOnRepeat(5000, 5999), 'within 1 s');
  assert.ok(!AC.killOnRepeat(5000, 6000), '1 s later it is a new press');
  assert.ok(!AC.killOnRepeat(5000, 4000), 'a clock gone back never blocks the kill switch');
});

test('1.17.0 as built: who owns a pair, the page exit that passes, ChartBridge\'s words; the feed shows a held count as given', () => {
  const ag = [agent({ owns: true, account: 'SIM-AG1', position: { root: 'MNQ', qty: 2, avgPrice: 1 } }), agent({ agent: 'demotwo', owns: true, account: 'SIM-AG2' })];
  const orders = [{ id: 'NT1', by: 'agent:demotwo', account: 'SIM-AG2', root: 'NQ', state: 'working', role: 'stop' }];
  assert.equal(AC.pairOwner(ag, orders, 'SIM-AG1', 'MNQ'), 'demo');
  assert.equal(AC.pairOwner(ag, orders, 'SIM-AG1', 'NQ'), '');
  assert.equal(AC.pairOwner(ag, orders, 'SIM-AG2', 'NQ'), 'demotwo', 'its own working leg there');
  assert.equal(AC.pairOwner([agent({ owns: false, position: { root: 'MNQ', qty: 2 } })], [], 'SIM-AG1', 'MNQ'), '', 'only while ChartBridge says it owns');
  assert.ok(AC.pageExitPasses({ kind: 'market', side: 'sell', qty: 2 }, 2));
  assert.ok(!AC.pageExitPasses({ kind: 'limit', side: 'sell', qty: 1, price: 1 }, 2));
  assert.ok(!AC.pageExitPasses({ kind: 'market', side: 'sell', qty: 3 }, 2));
  assert.ok(!AC.pageExitPasses({ kind: 'market', side: 'buy', qty: 1 }, 2));
  assert.ok(!AC.pageExitPasses({ kind: 'market', side: 'sell', qty: 1, bracket: { stop: 8, target: 8 } }, 2));
  assert.ok(!AC.pageExitPasses({ kind: 'market', side: 'sell', qty: 1 }, 0));
  assert.equal(AC.lockText('SIM-AG1', 'MNQ', 'demo'), 'SIM-AG1 MNQ belongs to agent demo: use Flatten, or move its stop or target');
  const held = 'refused: qty must be a whole number from 1 to 20 (maxQty.MNQ) (and 3 more refused plans in the second before, not shown)';
  assert.equal(AC.planLine({ action: 'plan', side: 'buy', qty: 99, root: 'MNQ', result: held }).result, held.replace(/^refused: /, 'refused: '), 'shown as is');
  const F = AC.createFeed();
  F.plan({ type: 'agentPlan', agent: 'demo', id: 'h', at: 1, action: 'plan', result: held });
  assert.equal(F.items('demo')[0].m.result, held);
  assert.deepEqual(AC.parseRules({ roots: ['NQ', 'MNQ'], maxQty: { NQ: 2, MNQ: 20 }, maxTrades: null }).roots, ['NQ', 'MNQ'], 'roots as a list (as built)');
});

/* ======================================================================== board F: the light, the drawer, the trail, the room */
test('the light: watching, a look, his thinking, a plan, a rules check, placed; each on its panels, in its colour', () => {
  const L = o => AC.lightState(Object.assign({ agent: agent({ mode: 'copilot' }), notes: [], plans: [], open: [], ends: [], workingEntry: false, exits: [], openPnl: null, now: T0 }, o));
  let s = L({});
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.step, s.fast, s.lapMs], ['watch', 'screen', '#5df2ff', ['pipe'], 0, false, 13000]);
  s = L({ notes: [{ kind: 'look', text: 'Sample look', at: T0 - 5000 }] });
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.step], ['look', 'eyes', '#8f7bff', ['pipe', 'stream'], 1], 'a look: the tracker and the stream, violet');
  assert.equal(L({ notes: [{ kind: 'look', text: 'old', at: T0 - AC.LIGHT_HOLD.look - 1 }] }).phase, 'watch', 'a look older than its hold: watching again');
  s = L({ notes: [{ kind: 'look', at: T0 - 9000, text: 'a' }, { kind: 'thinking', at: T0 - 2000, text: 'b' }] });
  assert.deepEqual([s.phase, s.tone, s.color, s.step], ['think', 'judgment', '#c81fe0', 2], 'the newest wins: his thinking, deeper magenta');
  assert.equal(L({ notes: [{ kind: 'lesson', at: T0 - 1000, text: 'x' }, { kind: 'status', at: T0, text: 'y' }] }).phase, 'watch', 'a lesson or a status is not a decision');
  s = L({ open: [Object.assign(proposal(), { answered: '' })], notes: [{ kind: 'look', at: T0 + 1, text: 'later look' }] });
  assert.deepEqual([s.phase, s.tone, s.panels, s.step, s.said], ['plan', 'judgment', ['pipe', 'prop'], 2, 'A plan is waiting for you'], 'an open proposal holds the light on the plan');
  s = L({ open: [Object.assign(proposal(), { answered: 'accept' })] });
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.step], ['check', 'checks', '#ffd23f', ['acct', 'prop'], 3], 'accepted, waiting for ChartBridge: his rules being checked, on the account and the proposal');
  s = L({ workingEntry: true });
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.step], ['placed', 'bridge', '#3dff9a', ['prop', 'chart'], 4]);
  s = L({ plans: [{ action: 'plan', id: 'sh', at: T0 - 3000, result: 'shadow', setup: 'S' }] });
  assert.deepEqual([s.phase, s.tone, s.panels], ['plan', 'judgment', ['pipe', 'prop']], 'a Shadow plan');
});

test('the light: outcomes (passed, rejected, expired, refused, a go) and a trade in profit or under water', () => {
  const L = o => AC.lightState(Object.assign({ agent: agent({ mode: 'copilot' }), now: T0 }, o));
  let s = L({ plans: [{ action: 'skip', id: 'k', at: T0 - 1000, result: 'skipped', setup: 'Sample breakout' }] });
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.said], ['passed', 'passed', '#ff8a2a', ['prop', 'stream'], 'He passed: Sample breakout']);
  for (const st of ['rejected', 'expired', 'withdrawn', 'not answered']) {
    s = L({ plans: [{ action: 'plan', id: 'p1', at: T0 - 9000, result: 'proposed' }], ends: [{ id: 'p1', state: st, at: T0 - 1000 }] });
    assert.deepEqual([s.phase, s.tone], ['passed', 'passed'], st + ': orange');
  }
  s = L({ plans: [{ action: 'plan', id: 'p1', at: T0 - 9000, result: 'proposed' }], ends: [{ id: 'p1', state: 'accepted', at: T0 - 1000 }] });
  assert.deepEqual([s.phase, s.tone], ['go', 'bridge'], 'accepted: a go');
  s = L({ plans: [{ action: 'plan', id: 'r', at: T0 - 1000, result: 'refused: outside its trading hours' }] });
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.step, s.said], ['refused', 'no', '#ff3b5c', ['acct', 'prop'], 3, 'Refused by ChartBridge: outside its trading hours'], 'a hard no: red, on his rules');
  assert.equal(L({ plans: [{ action: 'plan', id: 'r', at: T0 - AC.LIGHT_HOLD.outcome - 1, result: 'refused: x' }] }).phase, 'watch', 'an outcome holds 30 s');
  const pos = { root: 'MNQ', qty: 2, avgPrice: 25390 };
  s = L({ agent: agent({ position: pos }), openPnl: 24 });
  assert.deepEqual([s.phase, s.tone, s.color, s.panels, s.fast, s.lapMs, s.step], ['trade', 'bridge', '#3dff9a', ['chart', 'pnl'], true, 9000, 4], 'in profit: green on the chart and the P&L, the faster lap');
  assert.equal(L({ agent: agent({ position: pos }), openPnl: 0 }).tone, 'bridge', 'at zero: green');
  s = L({ agent: agent({ position: pos }), openPnl: -12 });
  assert.deepEqual([s.phase, s.tone, s.color, s.said], ['trade', 'no', '#ff3b5c', 'In a trade, long 2 MNQ'], 'under water: red, and the words say only the facts (no "in profit", no "under water")');
  assert.equal(L({ agent: agent({ position: pos }), openPnl: 24 }).said, 'In a trade, long 2 MNQ');
  assert.deepEqual([L({ agent: agent({ position: pos }), openPnl: null }).tone, L({ agent: agent({ position: pos }), openPnl: null }).said], ['screen', 'In a trade, long 2 MNQ'], 'P&L not known: cyan, never guessed');
  assert.equal(L({ agent: agent({ position: pos, killed: true }), openPnl: -1 }).phase, 'trade', 'a position shows even with the kill switch on (its stop and target stay)');
  s = L({ exits: [{ at: T0 - 2000, pnl: 32 }] });
  assert.deepEqual([s.phase, s.tone, s.panels, s.said], ['exit', 'bridge', ['pipe', 'pnl'], 'Out of the trade: +$32.00'], 'a flat exit: back on the tracker, green for a gain');
  assert.equal(L({ exits: [{ at: T0 - 2000, pnl: -16 }] }).tone, 'no', 'red for a loss');
  assert.deepEqual([L({ agent: agent({ killed: true }) }).phase, L({ agent: agent({ killed: true }) }).panels], ['stopped', ['acct']]);
  assert.match(L({ agent: agent({ standDown: 'two losing trades' }) }).said, /^Stood down: two losing trades/);
  assert.deepEqual([L({ agent: agent({ connected: false }) }).phase, L({ agent: agent({ connected: false }) }).panels], ['quiet', []], 'not connected: no light');
  assert.deepEqual(AC.lightState(null).panels, []);
  for (const t of ['screen', 'eyes', 'judgment', 'checks', 'bridge', 'passed', 'no']) assert.match(AC.LIGHT[t], /^#[0-9a-f]{6}$/);
  assert.deepEqual(AC.LAP_MS, { slow: 13000, fast: 9000 });
});

test('the stream\'s drawer: his record, only what the channel carries', () => {
  const o = { fmtPx: p => p.toFixed(2), tick: () => 0.25 };
  const plan = { agent: 'demo', id: 'cp1', at: T0, action: 'plan', root: 'MNQ', side: 'buy', kind: 'limit', price: 25390, qty: 2, stopTicks: 16, targetTicks: 32, expireSec: 600, riskDollars: 16, setup: 'Sample pullback', reason: 'Sample: a made-up reason', confidence: 0.64, result: 'proposed' };
  let r = AC.decisionRecord({ type: 'plan', m: plan, end: { state: 'accepted', react: ' in 1.3 s' }, proposal: { seenAt: T0 + 1000, answeredAt: T0 + 2300, expiresAt: T0 + 600000 } }, o);
  const f = Object.fromEntries(r.facts);
  assert.equal(r.words, 'Sample: a made-up reason');
  assert.equal(r.tone, 'bridge');
  assert.equal(f.Entry, 'Buy 2 MNQ, limit 25390.00');
  assert.equal(f.Stop, '16 ticks, 25386.00'); assert.equal(f.Target, '32 ticks, 25398.00');
  assert.equal(f.Risk, '$16.00, reward 2.00 to 1'); assert.equal(f['Entry lives'], '10 min'); assert.equal(f.Confidence, '0.64');
  assert.equal(f['His rules'], 'passed ChartBridge\'s checks'); assert.equal(f.Proposal, 'Accepted');
  assert.match(f['You answered'], /in 1\.3 s$/);
  for (const k of Object.keys(f)) assert.ok(!/for and against|notebook|cost|eyes|judgment/i.test(k), 'nothing the channel does not carry: ' + k);
  r = AC.decisionRecord({ type: 'plan', m: Object.assign({}, plan, { result: 'refused: qty must be a whole number from 1 to 20 (maxQty.MNQ)' }) }, o);
  assert.equal(r.tone, 'no'); assert.equal(Object.fromEntries(r.facts)['His rules'], 'refused by ChartBridge: qty must be a whole number from 1 to 20 (maxQty.MNQ)');
  assert.ok(!r.facts.some(x => x[0] === 'Proposal'), 'no proposal line for a plan that never was one');
  r = AC.decisionRecord({ type: 'plan', m: { agent: 'demo', id: 's', at: T0, action: 'skip', setup: null, reason: 'Sample: no level', root: null, side: null, result: 'skipped' } }, o);
  assert.deepEqual([r.tag, r.tone, r.title, r.words], ['PASS', 'passed', 'He passed', 'Sample: no level']);
  assert.ok(!r.facts.some(x => x[0] === 'Setup'), 'a field it does not carry is left out');
  r = AC.decisionRecord({ type: 'note', m: { kind: 'notebook', text: 'line one\nline two', at: T0 } }, o);
  assert.deepEqual([r.tag, r.pre, r.words], ['NOTEBOOK', true, 'line one\nline two']);
  assert.equal(AC.rowTone({ type: 'note', m: { kind: 'look' } }).tone, 'eyes');
  r = AC.decisionRecord({ type: 'exit', m: { root: 'MNQ', dir: 1, qty: 2, pIn: 25390, pOut: 25398, tIn: T0, tOut: T0 + 26 * 60000, pnl: 32 } }, o);
  assert.deepEqual([r.tag, r.tone, Object.fromEntries(r.facts).Result, Object.fromEntries(r.facts).Held], ['EXIT', 'bridge', '+$32.00 before fees', '26 min']);
  r = AC.decisionRecord({ type: 'fill', m: { side: 'sell', qty: 1, root: 'MNQ', p: 25400, at: T0, account: 'SIM-AG1' } }, o);
  assert.equal(r.title, 'Sold 1 MNQ at 25400.00');
});

test('the session trail, the room and the Motion switch', () => {
  const T = AC.sessionTrail(RULES, Date.UTC(2026, 9, 8, 16, 50, 0), [{ at: Date.UTC(2026, 9, 8, 14, 5, 0), mark: 'F', tone: 'bridge', title: 'a fill' }, { at: Date.UTC(2026, 9, 8, 21, 0, 0), mark: 'X', tone: 'no' }]);
  assert.equal(T.from, '09:45'); assert.equal(T.to, '15:55');
  assert.deepEqual(T.hours.map(h => h.label), ['09:45', '11:00', '12:00', '13:00', '14:00', '15:00', '15:55']);
  assert.equal(T.nowPct, Math.round((12 * 60 + 50 - 585) / 370 * 10000) / 100, '12:50 New York');
  assert.equal(T.marks.length, 1, 'a fill outside the session is left out');
  assert.equal(T.marks[0].pct, Math.round(20 / 370 * 10000) / 100);
  const lines = AC.roomLines({ roomDrawdownWhy: 'NinjaTrader does not report a trailing drawdown for this account' }, ACC.limitState({ roomDrawdown: null, roomDailyLoss: null, pnlToday: -100 }, { daily_loss_limit: 600 }));
  assert.deepEqual(lines.map(l => [l.key, l.room, l.limit, l.leftPct]), [['dd', null, null, null], ['dl', 500, 600, 83]]);
  assert.deepEqual([lines[0].why, lines[0].said], ['not reported', 'NinjaTrader does not report a trailing drawdown for this account'], 'never estimated: "not reported", ChartBridge\'s words kept for the tooltip');
  assert.ok(!AC.roomLines({}, null).some(l => /target/i.test(l.label)), 'the channel carries no profit target');
  const mem = new Map(), st = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(AC.motionPref(st), 'full');
  assert.equal(AC.setMotionPref(st, 'off'), 'off'); assert.equal(AC.motionPref(st), 'off'); assert.equal(mem.get(AC.MOTION_KEY), 'off');
  const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(AC.motionPref(bad), 'full'); assert.equal(AC.setMotionPref(bad, 'off'), 'off', 'blocked storage: kept for the page only');
  assert.equal(AC.motionPref(null), 'full');
});

test('board F wiring: fonts from this PC, the light in CSS only, no keydown on the document, no ChartMotion, no motion on figures', () => {
  const css = read('live', 'agent.css'), js = read('live', 'agent.js'), fonts = read('live', 'fonts', 'agent-fonts.css');
  for (const page of ['index.html', 'agent.html']) assert.match(read('live', page), /<link rel="stylesheet" href="fonts\/agent-fonts\.css">/);
  const to = JSON.parse(read('nt8', 'install-files.json')).www.map(f => f.to);
  for (const f of ['agent-fonts.css', 'OFL-agent.txt', 'ChakraPetch-Regular.woff2', 'ChakraPetch-Medium.woff2', 'ChakraPetch-SemiBold.woff2', 'ChakraPetch-Bold.woff2', 'JetBrainsMono-Regular.woff2', 'JetBrainsMono-SemiBold.woff2']) {
    assert.ok(to.includes('fonts/' + f), f + ' installed');
    if (/woff2$/.test(f)) { assert.equal(fs.readFileSync(path.join(root, 'live', 'fonts', f)).subarray(0, 4).toString('latin1'), 'wOF2'); assert.match(fonts, new RegExp(f.replace('.', '\\.'))); }
  }
  assert.match(read('live', 'fonts', 'OFL-agent.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.doesNotMatch(css + fonts, /fonts\.(googleapis|gstatic)\.com/);
  assert.match(css, /@property --ag-pc \{ syntax: '<color>'/);
  /* the light is cheap (review of fc3101a): turned by a transform on the compositor, never a gradient painted again each frame,
     and no blur filter */
  assert.match(css, /@keyframes ag-orbit \{ to \{ transform: rotate\(360deg\); \} \}/);
  assert.doesNotMatch(css, /--ag-ang|filter: blur/, 'no animated angle property and no blur');
  assert.match(css, /\.ag-edge > b \{[^}]*will-change: transform, opacity;/);
  assert.match(css, /\.ag-light \{[^}]*container-type: size;/);
  assert.doesNotMatch(css, /ag-slide/, 'the drawer appears at once (R3: it shows prices, risk and P&L)');
  assert.doesNotMatch(css.replace(/@keyframes ag-orbit[^\n]*/, ''), /@keyframes/, 'the light is the only animation in the tab');
  assert.match(css, /prefers-reduced-motion: reduce/); assert.match(css, /\.ag-view\.ag-still \.ag-light \{ display: none !important; \}/);
  assert.match(css, /--f-body: "IBM Plex Sans"/, 'the hybrid: IBM Plex Sans for body text (already loaded by plex.css)');
  assert.match(css, /--f-ui: "Chakra Petch"/); assert.match(css, /--f-num: "JetBrains Mono"/);
  for (const page of ['index.html', 'agent.html']) assert.match(read('live', page), /href="fonts\/plex\.css">\n<!--[^\n]*-->\n<link rel="stylesheet" href="fonts\/agent-fonts\.css">/, page + ': Plex and the tab\'s fonts');
  assert.match(css, /#c81fe0/); assert.doesNotMatch(css + js + read('live', 'agent-core.js'), /#ff4fd8/i, 'the old Judgment pink is gone');
  assert.doesNotMatch(js, /requestAnimationFrame|setInterval/, 'no per-frame script for the light');
  assert.doesNotMatch(js, /document\.addEventListener\('keydown'/, 'no keydown handler on the document');
  assert.doesNotMatch(js, /ChartMotion\.|window\.ChartMotion|data-in=|data-count=/, 'the ChartMotion kit is not used on the Agent tab');
  assert.match(js, /data-agans="accept" data-no-motion/); assert.match(js, /data-k="sPnl"/);
  for (const f of ['live/agent.css', 'live/fonts/agent-fonts.css', 'live/fonts/OFL-agent.txt']) assert.doesNotMatch(read(...f.split('/')), /[\u2013\u2014]/, f + ': no em or en dashes');
});
