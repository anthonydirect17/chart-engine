'use strict';
// The planner's rules (chart 1.62.0, live/planner-core.js): the model and its checks, the entry at Arm (decision 2 A), the bracket
// (decision 3 A), the watches from trade fixtures across minute closes (decision 13 A), the 17:00 break and an early close
// (decision 9 A), resume (decision 10 A: never taken late; a plan sent is never sent again), the send journal and the leader's
// handover with fake locks (decision 11 A), The Desk's queue. Sample prices only.
const test = require('node:test');
const assert = require('node:assert/strict');
const PC = require('../live/planner-core.js');
const CE = require('../src/chart-engine.js');

const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const UID = 'pu' + 'a'.repeat(16);
const draft = o => Object.assign({ uid: UID, root: 'MNQ', side: 'long', entry: 25000, stop: 24996, target: 25008, qty: 2, account: 'Sim101', entryType: 'limit', expiryMin: 30, grade: 'A+', tick: 0.25 }, o || {});
const ms = (h, m, s) => Date.UTC(2026, 10, 20, h, m, s || 0);   // a made-up day; minutes are whole UTC minutes

test('uids and cids: one fixed cid per plan and leg, read back from an order\'s cid', () => {
  const u = PC.newUid(() => 0.5);
  assert.match(u, /^pu[a-z0-9]{16}$/);
  assert.equal(PC.entryCid(UID), 'pl' + UID + '-e');
  assert.equal(PC.uidOfCid(PC.entryCid(UID)), UID);
  for (const c of ['p123-4', 'pl' + UID, 'pl' + UID + '-s', null]) assert.equal(PC.uidOfCid(c), '');
});

test('validate: sides of the stop and target, the tick, qty against maxQty, expiry 1 to 30, grade, one account (never a group), the bracket cap', () => {
  const ctx = { tick: 0.25, maxQty: 3, maxBracketTicks: 0, accounts: ['Sim101'] };
  assert.equal(PC.validate(draft(), ctx), '');
  assert.match(PC.validate(draft({ stop: 25001 }), ctx), /stop must be below/);
  assert.match(PC.validate(draft({ side: 'short' }), ctx), /stop must be above/);
  assert.match(PC.validate(draft({ target: 24999 }), ctx), /Target 1 must be above/);
  assert.match(PC.validate(draft({ entry: 25000.1 }), ctx), /not on the tick/);
  assert.match(PC.validate(draft({ qty: 4 }), ctx), /over ChartBridge's MNQ limit of 3/);
  assert.match(PC.validate(draft({ expiryMin: 31 }), ctx), /1 to 30 minutes/);
  assert.match(PC.validate(draft({ expiryMin: 0 }), ctx), /1 to 30 minutes/);
  assert.match(PC.validate(draft({ grade: 'C' }), ctx), /A\+, A or B/);
  assert.match(PC.validate(draft({ account: 'group:g1' }), Object.assign({}, ctx, { accounts: null })), /never a group/);
  assert.match(PC.validate(draft({ account: 'EVAL-X' }), ctx), /not a trade account/);
  assert.match(PC.validate(draft({ account: '' }), ctx), /Pick the account/);
  assert.match(PC.validate(draft(), Object.assign({}, ctx, { maxBracketTicks: 20 })), /more than ChartBridge's 20 ticks/);
  assert.equal(PC.cleanDraft(draft({ grade: undefined, expiryMin: undefined })).grade, 'A+', 'A+ unless set (decision 12 A)');
  assert.equal(PC.cleanDraft(draft({ expiryMin: undefined })).expiryMin, 30, '30 minutes unless set (decision 9 A)');
});

test('submitBody: the call log\'s fields and the plan\'s own, from the plan alone', () => {
  assert.deepEqual(PC.submitBody(draft({ contract: 'MNQ 12-26' }), 'TESTPC'), { uid: UID, root: 'MNQ', side: 'long', entry: 25000, stop: 24996, targets: [25008], size: 2, account: 'Sim101', grade: 'A+',
    plan: { uid: UID, pc: 'TESTPC', entry_type: 'limit', expiry_min: 30, qty: 2, target1: 25008, tick: 0.25, contract: 'MNQ 12-26' } });
});

test('entryFor (decision 2 A): by where the line sits against the last price at Arm', () => {
  assert.deepEqual(PC.entryFor(draft(), 25002, true), { kind: 'limit', price: 25000 }, 'a buy limit under the market');
  assert.match(PC.entryFor(draft(), 24998, true).refuse, /would fill at once/, 'a buy limit over the market: refused at Arm');
  assert.deepEqual(PC.entryFor(draft({ entryType: 'touch' }), 25002, true), { kind: 'mit', price: 25000 }, 'touch on the limit side: an MIT at the line');
  assert.deepEqual(PC.entryFor(draft({ entryType: 'touch' }), 24998, true), { kind: 'stop', price: 25000 }, 'touch on the stop side: a stop-market at the line');
  assert.match(PC.entryFor(draft({ entryType: 'touch' }), 25002, false).refuse, /MIT is off/);
  assert.match(PC.entryFor(draft({ entryType: 'touch' }), 25000, true).refuse, /at the last price/);
  assert.deepEqual(PC.entryFor(draft({ entryType: 'confirm' }), 25002, true), { kind: null, price: null }, 'a confirmation sends nothing at Arm');
  assert.deepEqual(PC.entryFor(draft({ side: 'short', stop: 25004, target: 24992 }), 24998, true), { kind: 'limit', price: 25000 }, 'a sell limit over the market');
  assert.match(PC.entryFor(draft(), null, true).refuse, /No recent MNQ price/);
  assert.match(PC.entryFor(draft({ entryType: 'touch' }), 24995.75, true).refuse, /already through the stop/, 'a last price through the stop: not armed');
  assert.match(PC.entryFor(draft({ entryType: 'confirm' }), 24995.75, true).refuse, /already through the stop/);
});

test('bracketFor (decision 3 A): ticks from the line for a resting entry, from the last price at send for the confirmation\'s market', () => {
  assert.deepEqual(PC.bracketFor(draft(), 'limit', 25010, 0.25, 0), { stop: 16, target: 32 });
  assert.deepEqual(PC.bracketFor(draft(), 'mit', 25010, 0.25, 0), { stop: 16, target: 32 });
  assert.deepEqual(PC.bracketFor(draft(), 'market', 25001, 0.25, 0), { stop: 20, target: 28 });
  assert.match(PC.bracketFor(draft(), 'market', 24996, 0.25, 0).refuse, /at or past the stop/);
  assert.match(PC.bracketFor(draft(), 'market', 25008, 0.25, 0).refuse, /past target 1/);
  assert.match(PC.bracketFor(draft(), 'market', 25001, 0.25, 24).refuse, /more than ChartBridge's 24 ticks/);
});

test('a confirmation watch: the touch, then a 1 minute close back over the line; equal does not count; the touch bar may confirm', () => {
  const w = PC.createWatch(draft({ entryType: 'confirm' }), { tick: 0.25, expiresAt: ms(14, 30) });
  assert.deepEqual(w.trade(25003, ms(14, 1, 5)), []);
  assert.deepEqual(w.trade(25000, ms(14, 1, 20)).map(e => e.kind), ['touched'], 'a trade at the line is a touch');
  assert.deepEqual(w.trade(25001, ms(14, 1, 50)), []);
  assert.deepEqual(w.trade(25002, ms(14, 2, 1)).map(e => [e.kind, e.close, e.minute]), [['confirmed', 25001, ms(14, 1)]], 'the touch minute closed over the line: it confirms');
  assert.deepEqual(w.trade(25001, ms(14, 3)), [], 'done');
  // equal does not count; a later minute that closes over the line confirms
  const v = PC.createWatch(draft({ entryType: 'confirm' }), { tick: 0.25, expiresAt: ms(14, 30) });
  v.trade(24999.75, ms(14, 1, 10)); v.trade(25000, ms(14, 1, 59));
  assert.deepEqual(v.trade(24999.5, ms(14, 2, 3)), [], 'a close at the line does not confirm');
  v.trade(25000.25, ms(14, 2, 58));
  assert.deepEqual(v.time(ms(14, 3) + 200), [], 'not before 250 ms after the boundary');
  assert.deepEqual(v.time(ms(14, 3) + 250).map(e => e.kind), ['confirmed'], 'checked 250 ms after the minute with no new trade');
  // a short: a close under the line
  const s = PC.createWatch(draft({ side: 'short', stop: 25004, target: 24992, entryType: 'confirm' }), { tick: 0.25, expiresAt: ms(14, 30) });
  assert.deepEqual(s.trade(25000.5, ms(14, 5, 1)).map(e => e.kind), ['touched']);
  assert.deepEqual(s.trade(24999.5, ms(14, 6, 2)).map(e => e.kind), [], 'the touch minute closed above the line: no');
  assert.deepEqual(s.trade(24999, ms(14, 7, 0)).map(e => e.kind), ['confirmed'], 'the next minute closed under it');
});

test('stop-through (decision 13 A): one tick beyond the stop, before the fill, ends the plan; at the stop does not', () => {
  const w = PC.createWatch(draft({ entryType: 'confirm' }), { tick: 0.25, expiresAt: ms(14, 30) });
  w.trade(24999, ms(14, 1, 1));
  assert.deepEqual(w.trade(24996, ms(14, 1, 2)), [], 'at the stop');
  assert.deepEqual(w.trade(24995.75, ms(14, 1, 3)).map(e => e.kind), ['stop_through']);
  assert.deepEqual(w.trade(25005, ms(14, 2, 3)), [], 'done: a later close back never confirms');
  const lim = PC.createWatch(draft(), { tick: 0.25, expiresAt: ms(14, 30), sent: true });
  assert.deepEqual(lim.trade(24995.75, ms(14, 4)).map(e => e.kind), ['stop_through'], 'a resting limit too: the leader cancels it');
});

test('expiry: by the clock or the next trade; the 17:00 break and an early close refuse Arm (decision 9 A)', () => {
  const w = PC.createWatch(draft({ entryType: 'confirm' }), { tick: 0.25, expiresAt: ms(14, 10) });
  assert.deepEqual(w.time(ms(14, 9, 59)), []);
  assert.deepEqual(w.time(ms(14, 10)).map(e => e.kind), ['expired']);
  const w2 = PC.createWatch(draft(), { tick: 0.25, expiresAt: ms(14, 10), sent: true });
  assert.deepEqual(w2.trade(25001, ms(14, 10, 1)).map(e => e.kind), ['expired']);
  const U = CE.util, et = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;   // New York wall seconds as the engine keeps them
  assert.equal(PC.armClosedWhy(et(2026, 11, 20, 10, 0), U.cmeClosed), '', 'a Friday morning: open');
  assert.match(PC.armClosedWhy(et(2026, 11, 19, 17, 30), U.cmeClosed), /CME is closed/, 'the 17:00 break');
  assert.match(PC.armClosedWhy(et(2026, 11, 21, 12, 0), U.cmeClosed), /CME is closed/, 'the weekend');
  assert.match(PC.armClosedWhy(et(2026, 11, 27, 13, 30), U.cmeClosed), /CME is closed/, 'the early close after Thanksgiving');
  assert.equal(PC.armClosedWhy(et(2026, 11, 27, 12, 0), U.cmeClosed), '', 'before that early close');
  assert.equal(PC.armClosedWhy(et(2026, 11, 22, 18, 30), U.cmeClosed), '', 'Sunday evening: open (overnight plans, Anthony)');
  assert.match(PC.armClosedWhy(null, U.cmeClosed), /cannot tell/);
  // an expiry The Desk cut at the 17:00 close ends the watch there
  const cut = PC.createWatch(draft({ entryType: 'confirm' }), { tick: 0.25, expiresAt: ms(22, 0) });
  assert.deepEqual(cut.time(ms(22, 0)).map(e => e.kind), ['expired']);
});

test('phaseOf and fromDesk: a plan\'s phase from its facts; viewOf what the engine draws', () => {
  const v = { seq: 12, uid: UID, root: 'MNQ', side: 'long', entry: 25000, stop: 24996, targets: [25008], size: 2, account: 'Sim101', grade: 'A', logged_at_ms: 1,
    plan: { uid: UID, pc: 'TESTPC', entry_type: 'touch', expiry_min: 10, qty: 2, target1: 25008, tick: 0.25, contract: 'MNQ 12-26' }, events: [] };
  const P = PC.fromDesk(v);
  assert.equal(P.phase, 'submitted'); assert.equal(P.entryType, 'touch'); assert.equal(P.target, 25008);
  v.events.push({ kind: 'arm', logged_at_ms: 1000, detail: { expires_at_ms: 601000 } });
  assert.deepEqual([PC.fromDesk(v).phase, PC.fromDesk(v).expiresAt, PC.fromDesk(v).armedAt], ['armed', 601000, 1000]);
  v.events.push({ kind: 'sent', logged_at_ms: 1100, detail: { cid: PC.entryCid(UID) } });
  assert.equal(PC.fromDesk(v).phase, 'working');
  v.events.push({ kind: 'filled', logged_at_ms: 1200, detail: {} });
  assert.equal(PC.fromDesk(v).phase, 'filled');
  v.events.push({ kind: 'closed', logged_at_ms: 1300, detail: {} });
  assert.deepEqual([PC.fromDesk(v).phase, PC.fromDesk(v).why], ['ended', 'closed']);
  assert.deepEqual(PC.phaseOf({ events: [{ kind: 'arm' }, { kind: 'expired' }] }), { phase: 'ended', why: 'expired' });
  const view = PC.viewOf(Object.assign(PC.fromDesk(Object.assign({}, v, { events: v.events.slice(0, 1) })), { t0: 5 }), 1000 + 4 * 60000, true);
  assert.deepEqual([view.id, view.state, view.editable, view.label, view.note, view.selected], [UID, 'armed', false, 'Plan #12 LONG TOUCH 2', 'armed · 6m left', true]);
  assert.equal(PC.viewOf(PC.cleanDraft(draft()), 0).state, 'draft');
  assert.equal(PC.viewOf(PC.cleanDraft(draft()), 0).editable, true);
  assert.equal(PC.fromDesk({ seq: 1 }), null);
});

test('reconcile: armed with nothing sent: expired, stop-through, missed (never taken late), or resume', () => {
  const P = { seq: 1, uid: UID, root: 'MNQ', side: 'long', entry: 25000, stop: 24996, target: 25008, qty: 2, account: 'Sim101', entryType: 'confirm', tick: 0.25, phase: 'armed', expiresAt: ms(14, 30), armedAt: ms(14, 0, 30), events: [] };
  assert.deepEqual(PC.reconcile(P, { now: ms(14, 31), bars: [] }).act, 'expired');
  assert.equal(PC.reconcile(P, { now: ms(14, 10), bars: [{ t: ms(14, 3), h: 25004, l: 24995.75, c: 25000 }] }).act, 'stop_through');
  assert.equal(PC.reconcile(P, { now: ms(14, 10), bars: [{ t: ms(14, 3), h: 25004, l: 24999.75, c: 25002 }] }).act, 'missed');
  assert.equal(PC.reconcile(P, { now: ms(14, 10), bars: [{ t: ms(13, 58), h: 25004, l: 24990, c: 25002 }, { t: ms(14, 3), h: 25004, l: 25001, c: 25002 }] }).act, 'resume', 'a bar before Arm does not count');
  assert.equal(PC.reconcile(Object.assign({}, P, { phase: 'submitted' }), { now: ms(14, 10) }).act, 'none');
});

test('reconcile: sent: found by cid, or after a ChartBridge restart by account, root, side, kind, price, qty; filled from the execs; else unknown, never sent again', () => {
  const P = { seq: 1, uid: UID, root: 'MNQ', side: 'long', entry: 25000, stop: 24996, target: 25008, qty: 2, account: 'Sim101', entryType: 'limit', tick: 0.25, phase: 'working', expiresAt: ms(14, 30), events: [] };
  const journal = { cid: PC.entryCid(UID), at: ms(14, 1) };
  const mine = { id: 'o5', cid: PC.entryCid(UID), account: 'Sim101', root: 'MNQ', side: 'buy', kind: 'limit', price: 25000, qty: 2, filled: 0, state: 'working', role: 'entry' };
  assert.deepEqual(PC.reconcile(P, { now: ms(14, 5), journal, orders: [mine] }), { act: 'resume_working', id: 'o5' });
  assert.deepEqual(PC.reconcile(P, { now: ms(14, 5), journal, orders: [Object.assign({}, mine, { id: 'o9', cid: undefined })] }), { act: 'resume_working', id: 'o9' }, 'after a restart');
  assert.deepEqual(PC.reconcile(P, { now: ms(14, 5), journal, orders: [Object.assign({}, mine, { id: 'o9', cid: undefined, price: 25000.25 })] }).act, 'unknown', 'another price is not it');
  assert.deepEqual(PC.reconcile(P, { now: ms(14, 32), journal, orders: [mine] }), { act: 'cancel_expired', id: 'o5', lateMs: 120000 });
  const fills = [{ id: 'X1', account: 'Sim101', root: 'MNQ', side: 'buy', qty: 1, p: 25000, u: ms(14, 2), order: 'NT1' }, { id: 'X2', account: 'Sim101', root: 'MNQ', side: 'buy', qty: 1, p: 25000, u: ms(14, 2, 1), order: 'NT1' }];
  assert.deepEqual(PC.reconcile(P, { now: ms(14, 5), journal, orders: [], execs: fills }), { act: 'filled', execs: ['X1', 'X2'], price: 25000, qty: 2, order: 'NT1' });
  assert.equal(PC.reconcile(P, { now: ms(14, 5), journal, orders: [], execs: fills.slice(0, 1) }).act, 'unknown');
  assert.equal(PC.reconcile(Object.assign({}, P, { phase: 'armed' }), { now: ms(14, 5), journal, orders: [] }).act, 'unknown', 'the journal says sent even when The Desk does not');
  // The Desk's own sent fact counts as the journal
  const P2 = Object.assign({}, P, { events: [{ kind: 'sent', at: ms(14, 1), detail: { cid: PC.entryCid(UID) } }] });
  assert.equal(PC.reconcile(P2, { now: ms(14, 5), journal: null, orders: [mine] }).act, 'resume_working');
});

test('the send journal: written before the send, read fresh, once per plan; storage blocked: no send', () => {
  const st = mem(); let t = 1000;
  const a = PC.createJournal(st, () => t), b = PC.createJournal(st, () => t);
  assert.equal(a.sentOf(UID), null);
  assert.equal(a.mark(UID, PC.entryCid(UID)), true);
  assert.deepEqual(b.sentOf(UID), { cid: PC.entryCid(UID), at: 1000 }, 'another window reads it');
  assert.equal(b.mark(UID, PC.entryCid(UID)), false, 'never a second entry');
  t += 4 * 86400000;
  const other = 'pu' + 'b'.repeat(16);
  assert.equal(a.mark(other, PC.entryCid(other)), true);
  assert.equal(a.sentOf(UID), null, 'entries older than 3 days go');
  const blocked = { getItem: () => null, setItem: () => { throw new Error('blocked'); } };
  assert.equal(PC.createJournal(blocked).mark(UID, 'x'), false);
});

test('the leader (decision 11 A): one window holds the lock; when it closes the next asking window leads; no Web Locks: none', async () => {
  const fake = () => {   // a queued Web Lock: one holder, the rest wait in order
    let held = false; const queue = [];
    const grant = () => { if (held || !queue.length) return; const q = queue.shift(); held = true; Promise.resolve(q.cb({ name: q.name })).then(() => { held = false; grant(); }); };
    return { request: (name, cb) => new Promise(res => { queue.push({ name, cb: l => { const r = cb(l); res(); return r; } }); grant(); }) };
  };
  const locks = fake(), led = [];
  const a = PC.createLeader({ locks, onLead: () => led.push('a') }), b = PC.createLeader({ locks, onLead: () => led.push('b') });
  a.start(); b.start();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(led, ['a']); assert.equal(a.isLeader(), true); assert.equal(b.isLeader(), false);
  a.close();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(led, ['a', 'b'], 'the handover is automatic');
  assert.equal(b.isLeader(), true);
  const none = PC.createLeader({ locks: null, onLead: () => led.push('x') });
  assert.equal(none.start(), false); assert.equal(none.isLeader(), false);
});

test('The Desk\'s queue: kept while The Desk does not answer, posted oldest first, a refusal dropped and counted', async () => {
  const st = mem(), q = PC.createQueue(st, () => 5, () => 0.1);
  q.add(3, 'sent', { cid: 'x' }); q.add(3, 'placed', { id: 'o1' }); q.add(3, 'bogus', {});
  assert.equal(q.items().length, 2, 'an unknown kind is not queued');
  assert.equal(await q.flush(() => 'later'), 0);
  assert.equal(q.items().length, 2);
  const seen = [];
  assert.equal(await q.flush(it => { seen.push(it.kind); return seen.length === 1 ? 'ok' : 'drop'; }), 2);
  assert.deepEqual(seen, ['sent', 'placed']);
  assert.equal(q.items().length, 0); assert.equal(q.lost(), 1);
});

test('createShared: every window reads the same plans and hears a change', () => {
  const st = mem(), heard = [];
  const chans = []; const mk = () => { const c = { onmessage: null, post: m => chans.filter(x => x !== c).forEach(x => x.onmessage && x.onmessage(m)) }; chans.push(c); return c; };
  const a = PC.createShared({ storage: st, channel: mk(), wid: 'a' }), b = PC.createShared({ storage: st, channel: mk(), wid: 'b', onMessage: m => heard.push(m) });
  a.change(s => { s.drafts[UID] = PC.cleanDraft(draft()); });
  assert.equal(b.read().drafts[UID].entry, 25000);
  assert.deepEqual(heard, [{ from: 'a', t: 'changed' }]);
});

test('overridesFor: a Flatten on the plan\'s pair, Flatten all on every open plan; never a plan not open', () => {
  const plans = [{ seq: 1, account: 'Sim101', root: 'MNQ', phase: 'working' }, { seq: 2, account: 'Sim101', root: 'NQ', phase: 'filled' }, { seq: 3, account: 'Sim101', root: 'MNQ', phase: 'submitted' }];
  assert.deepEqual(PC.overridesFor('flatten', { account: 'Sim101', root: 'MNQ' }, plans).map(x => x.seq), [1]);
  assert.deepEqual(PC.overridesFor('flatten_all', null, plans).map(x => x.seq), [1, 2]);
  assert.deepEqual(PC.overridesFor('nope', null, plans), []);
});
