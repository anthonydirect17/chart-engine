/*
 * Order Strategies, the shared hotkeys and the entry types (chart 1.16.0, ChartBridge 0.4.0, protocol v3). Pure parts, no
 * DOM; it also loads in Node for test/order-strategies.test.js. Works in the browser as window.OrderStrategies.
 *
 * The page asks; ChartBridge decides. Every rule here is a copy of a rule ChartBridge (nt8/PROTOCOL.md, "Order
 * Strategies (strategies = on)") or The Desk (TheDesk docs/API.md, "Desk endpoints used by the chart page") checks again,
 * so a slip is caught before anything is sent or saved:
 *   - The Desk's documents: GET/PUT /api/chart-strategies and /api/chart-hotkeys, a whole document with a `rev`, 409 on a
 *     stale rev (DeskStore below; the same guard and CORS as /api/chart-presets).
 *   - The Desk's strategy -> `order.strategy`, the flat form ChartBridge takes (toWire, PROTOCOL.md "Shared settings").
 *   - ChartBridge's own check of `order.strategy` (checkWire: shares add up to 100, t2 needs t1, bePlus below beAfter, ...).
 *   - Every hotkey in one conflict check (hotkeyConflict): the five trading keys, Merge, Maximize, the copilot's Accept and
 *     Reject, each strategy's key, and the entry-type modifiers.
 *   - The entry types (entryKind): a click or a Buy/Sell key with an entry-type modifier held places a limit-style or a
 *     stop-style entry at the price (limit, stop-limit, stop-market, MIT); with no modifier, as before (Shift+click by the
 *     side of the market, a key at market).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderStrategies = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const OT = typeof self !== 'undefined' && self.OrderTicket ? self.OrderTicket : require('./order-ticket.js');
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = v => typeof v === 'number' && Number.isInteger(v);
const exactKeys = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every(k => own(o, k));

/* ---------------- v3 switches (the `trading` message, sent to a v3 page only): a feature's controls show only when true */
const SWITCHES = ['accountChecks', 'orderTypes', 'strategies', 'merge', 'cancelFromList', 'copier', 'bot'];
/** The switches as the page reads them: only `true` is on; anything missing or odd is off. */
function cleanSwitches(s) {
  const out = {};
  for (const k of SWITCHES) out[k] = isObj(s) && s[k] === true;
  return out;
}
/** Whether the page keeps its hotkeys and strategies in The Desk: with any of the switches that need the shared keys on
    (lead's default: with all of them off the hotkeys stay this browser's, exactly as in 1.15). */
const deskSyncOn = sw => !!sw && !!(sw.strategies || sw.orderTypes || sw.merge || sw.bot);

/* ---------------- the hotkeys document (GET/PUT /api/chart-hotkeys) */
/* The five trading keys of 1.11.0, Merge and Maximize (The Desk's seven), and the copilot's one-key answers (lead's
   default: The Desk lane adds `accept` and `reject` too; no default key). */
const KEY_ACTIONS = OT.HOTKEY_ACTIONS.concat([
  { id: 'merge', name: 'Merge' }, { id: 'maximize', name: 'Maximize panel' },
  { id: 'accept', name: 'Accept (copilot)' }, { id: 'reject', name: 'Reject (copilot)' },
]);
const KEY_IDS = KEY_ACTIONS.map(a => a.id);
const keyName = id => (KEY_ACTIONS.find(a => a.id === id) || { name: id }).name;
const MODIFIERS = ['', 'Shift', 'Ctrl', 'Alt'];
const ENTRY_MODS = [{ id: 'limit', name: 'Limit' }, { id: 'stop', name: 'Stop' }];
/* The Desk's combo shape (DESK_SETTINGS_CONTRACT "Combo"): the page's hotkeyCombo text, no Meta, at most 32 characters. */
const COMBO = /^(Ctrl\+)?(Alt\+)?(Shift\+)?([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Num[0-9]|Num[-+*/.]|[-=[\];',./\\`])$/;
const isCombo = s => typeof s === 'string' && s.length <= 32 && COMBO.test(s);
/** The modifiers of a combo ('Ctrl', 'Alt', 'Shift'). */
function comboMods(c) { const p = OT.parseHotkey(c); return !p ? [] : [p.ctrl ? 'Ctrl' : '', p.alt ? 'Alt' : '', p.shift ? 'Shift' : ''].filter(Boolean); }
const usesMod = (combo, mod) => !!mod && comboMods(combo).includes(mod);

function emptyHotkeysDoc() {
  const keys = {};
  for (const id of KEY_IDS) keys[id] = '';
  return { rev: 0, keys, modifiers: { limit: '', stop: '' } };
}
/** A hotkeys document as read (The Desk's answer or this browser's copy): a key that is not a combo, or that a key before
    it already has, is ''; a modifier not in the list is ''; the stop modifier is '' when it equals the limit one. Never
    throws. */
function cleanHotkeysDoc(v) {
  const out = emptyHotkeysDoc();
  if (!isObj(v)) return out;
  if (isInt(v.rev) && v.rev >= 0 && v.rev <= 1e9) out.rev = v.rev;
  const used = new Set();
  for (const id of KEY_IDS) {
    const c = isObj(v.keys) && isCombo(v.keys[id]) ? v.keys[id] : '';
    if (c && !used.has(c)) { out.keys[id] = c; used.add(c); }
  }
  const m = isObj(v.modifiers) ? v.modifiers : {};
  out.modifiers.limit = MODIFIERS.includes(m.limit) ? m.limit : '';
  out.modifiers.stop = MODIFIERS.includes(m.stop) && m.stop !== out.modifiers.limit ? m.stop : '';
  return out;
}

/* ---------------- one conflict check for every key (the page's own rule, then The Desk's) */
/**
 * Why `combo` cannot be the key of `who` ('' when it can). `deskOnly`: The Desk's rules only (the shape, unique, no
 * entry-type modifier), not the page's list of keys the browser and the chart keep (OrderTicket.hotkeyRefused). `who` is { key: id } (one of KEY_IDS) or { strategy: id }.
 * `ctx`: { keys: { id: combo }, strategies: [{ id, name, hotkey }], modifiers: { limit, stop } }. `e`, when given, is the
 * KeyboardEvent (the chart's own keys by e.key, as OrderTicket.hotkeyRefused).
 */
function hotkeyConflict(combo, who, ctx, e, deskOnly) {
  const why = deskOnly ? '' : OT.hotkeyRefused(combo, e);
  if (why) return why;
  if (!isCombo(combo)) return combo + ' cannot be a hotkey: use a letter, a digit, an F-key, the numpad or a punctuation key.';
  const c = ctx || {}, keys = c.keys || {}, mods = c.modifiers || {};
  for (const m of ENTRY_MODS) if (usesMod(combo, mods[m.id])) return combo + ' uses ' + mods[m.id] + ', the ' + m.name + ' entry modifier: holding it changes the entry type. Pick another key, or change the modifier.';
  for (const id of KEY_IDS) if (keys[id] === combo && !(who && who.key === id)) return combo + ' is already ' + keyName(id) + '. Clear it there first.';
  for (const s of c.strategies || []) if (s && s.hotkey === combo && !(who && who.strategy === s.id)) return combo + ' is already the hotkey of strategy ' + s.name + '. Clear it there first.';
  return '';
}
/** Setting a key from a key press: { combo, error, held } (OrderTicket.hotkeyFromEvent, with every key in the check). */
function keyFromEvent(e, who, ctx) {
  const r = OT.hotkeyFromEvent(e, {}, '');
  if (!r.combo || r.error) return r;
  const why = hotkeyConflict(r.combo, who, ctx, e);
  return { combo: r.combo, error: why, held: false };
}
/** Whether a modifier can be an entry-type modifier: never one a key or a strategy's key already uses ('' when it can). */
function modifierConflict(which, mod, ctx) {
  if (!mod) return '';
  if (!MODIFIERS.includes(mod)) return 'Pick Shift, Ctrl or Alt.';
  const c = ctx || {}, mods = c.modifiers || {}, other = which === 'limit' ? 'stop' : 'limit';
  if (mods[other] === mod) return mod + ' is already the ' + (other === 'limit' ? 'Limit' : 'Stop') + ' entry modifier.';
  for (const id of KEY_IDS) if (usesMod((c.keys || {})[id], mod)) return mod + ' is in ' + keyName(id) + '\'s key (' + c.keys[id] + '): holding it would change the entry type. Change that key first.';
  for (const s of c.strategies || []) if (s && usesMod(s.hotkey, mod)) return mod + ' is in strategy ' + s.name + '\'s key (' + s.hotkey + '). Change that key first.';
  return '';
}
/** The Desk's rules for a whole hotkeys document ('' when it passes). */
function checkHotkeysDoc(doc, strategies) {
  if (!exactKeys(doc, ['rev', 'keys', 'modifiers'])) return 'The hotkeys document needs exactly rev, keys and modifiers.';
  if (!isInt(doc.rev) || doc.rev < 0 || doc.rev > 1e9) return 'rev must be a whole number from 0 to 1,000,000,000.';
  if (!exactKeys(doc.keys, KEY_IDS)) return 'keys needs exactly ' + KEY_IDS.join(', ') + '.';
  if (!exactKeys(doc.modifiers, ['limit', 'stop'])) return 'modifiers needs exactly limit and stop.';
  for (const k of ['limit', 'stop']) if (!MODIFIERS.includes(doc.modifiers[k])) return 'modifiers.' + k + ' must be "", Shift, Ctrl or Alt.';
  if (doc.modifiers.limit && doc.modifiers.limit === doc.modifiers.stop) return 'The Limit and Stop entry modifiers must differ.';
  const seen = new Map();
  for (const id of KEY_IDS) {
    const c = doc.keys[id];
    if (typeof c !== 'string') return 'keys.' + id + ' must be a combo or "".';
    if (!c) continue;
    if (!isCombo(c)) return 'keys.' + id + ' (' + c + ') is not a combo.';
    if (seen.has(c)) return c + ' is already ' + keyName(seen.get(c)) + '. Clear it there first.';
    seen.set(c, id);
    for (const m of ['limit', 'stop']) if (usesMod(c, doc.modifiers[m])) return c + ' uses ' + doc.modifiers[m] + ', an entry modifier: holding it changes the entry type.';
    const s = (strategies || []).find(x => x && x.hotkey === c);
    if (s) return c + ' is already the hotkey of strategy ' + s.name + '. Clear it there first.';
  }
  return '';
}

/* ---------------- the strategies document (GET/PUT /api/chart-strategies) */
const STRATEGY_MAX = 24, NAME_MAX = 40;
const ID_RX = /^[A-Za-z0-9_-]{1,64}$/;
const S_KEYS = ['id', 'name', 'stop', 'targets', 'breakeven', 'trail', 'hotkey'];
/* next release (Anthony's task "Strategy creator: bar trail option"): `barTrail`, { bars, offsetTicks }, the stop behind the
   low (long) or high (short) of the last `bars` completed 1 minute bars, `offsetTicks` beyond, moved only at a bar close by
   ChartBridge, never loosened. Optional: a strategy without it has no `barTrail` key at all (never null), so a document
   without bar trails is byte for byte what The Desk took before. Never with `trail` (one trail per strategy). */
const BAR_TRAIL_MAX = 50, BAR_OFFSET_MAX = 100;
/* Anthony 2026-11-01 ("It should be able to trail both, or any bar timeframe for that matter"; "Yes, an option at least"): the
   bar kind, `type` 'minute' (`size` minutes, those that divide the hour) or 'range' (`size` ticks, NinjaTrader's Range bars), both
   or neither (neither: 1 minute bars, as the first build), and `startTicks` (optional, 0 or absent: at once), the open profit in
   ticks before it starts. ChartBridge's keys: barTrailType, barTrailSize, barTrailStart. */
const BAR_TYPES = ['minute', 'range'], BAR_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60], BAR_RANGE_MAX = 400, BAR_START_MAX = 2000;
/* No type and no size: 1 minute bars (the first build's document). A type the chart does not support (tick, volume, anything
   else) is never read as minute bars: barKind says so ({ type, size, supported: false }) and the checks refuse it by name. */
const barKind = bt => {
  if (!bt || (!own(bt, 'type') && !own(bt, 'size'))) return { type: 'minute', size: 1, supported: true };
  const type = typeof bt.type === 'string' ? bt.type : String(bt.type), size = bt.size;
  const supported = (type === 'minute' && BAR_MINUTES.includes(size)) || (type === 'range' && isInt(size) && size >= 1 && size <= BAR_RANGE_MAX);
  return { type, size, supported };
};
const barKindText = bt => { const k = barKind(bt); return !k.supported ? k.size + ' ' + k.type + ' (not supported)' : k.type === 'range' ? k.size + '-range' : k.size + ' min'; };
const emptyStrategiesDoc = () => ({ rev: 0, strategies: [] });
/** A strategy name as The Desk keeps it: runs of spaces as one, trimmed. */
const strategyName = v => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const wholeIn = (v, lo, hi) => isInt(v) && v >= lo && v <= hi;
/* ChartBridge refuses a message with a backslash escape (gate 8): a name with " or \ (or a control character) could
   never be sent. */
const NAME_BAD = /["\\\u0000-\u001f\u007f]/;

/**
 * The Desk's rules for one strategy, plus what ChartBridge would refuse in its name: null when it passes, else
 * { field, text } (`field` names the editor's box: name, stop, stopType, limitOffset, t1..t3, s1..s3, beAfter, bePlus,
 * trailAfter, trailBy, trailStep, hotkey, or '' for the whole). `ctx`: { others: [the other strategies], hotkeys: the
 * hotkeys document, page: true for the editor (the keys the browser and the chart keep are refused too; The Desk checks
 * only a key's shape) } for the unique name and key rules.
 */
function checkStrategy(s, ctx) {
  const bad = (field, text) => ({ field, text });
  if (!exactKeys(s, S_KEYS) && !exactKeys(s, S_KEYS.concat(['barTrail']))) return bad('', 'A strategy needs exactly ' + S_KEYS.join(', ') + ' (and barTrail when it has a bar trail).');
  if (typeof s.id !== 'string' || !ID_RX.test(s.id)) return bad('', 'The id must be 1 to 64 letters, digits, - or _.');
  const name = strategyName(s.name);
  if (typeof s.name !== 'string' || !name || name.length > NAME_MAX) return bad('name', 'Type a name of 1 to 40 characters.');
  if (NAME_BAD.test(name)) return bad('name', 'The name cannot hold " or \\ (ChartBridge refuses them).');
  const c = ctx || {}, others = (c.others || []).filter(o => o && o.id !== s.id);
  if (others.some(o => strategyName(o.name).toLowerCase() === name.toLowerCase())) return bad('name', 'Another strategy is already called ' + name + '.');
  const st = s.stop;
  if (!exactKeys(st, ['ticks', 'type', 'limitOffsetTicks'])) return bad('stop', 'The stop needs ticks, a type and a limit offset.');
  if (!wholeIn(st.ticks, 1, 1000)) return bad('stop', 'The stop must be a whole number of ticks from 1 to 1000 (a strategy never goes in without a stop).');
  if (st.type !== 'market' && st.type !== 'limit') return bad('stopType', 'The stop is a stop market or a stop limit.');
  if (!wholeIn(st.limitOffsetTicks, 0, 100)) return bad('limitOffset', 'The limit offset must be a whole number of ticks from 0 to 100.');
  if (st.type === 'market' && st.limitOffsetTicks !== 0) return bad('limitOffset', 'A stop market has no limit offset (0).');
  const tg = s.targets;
  if (!Array.isArray(tg) || tg.length < 1 || tg.length > 3) return bad('t1', 'Set 1 to 3 targets.');
  let sum = 0;
  for (let i = 0; i < tg.length; i++) {
    const t = tg[i], n = i + 1;
    if (!exactKeys(t, ['ticks', 'sharePct'])) return bad('t' + n, 'Target ' + n + ' needs ticks and a share.');
    if (!wholeIn(t.ticks, 1, 2000)) return bad('t' + n, 'Target ' + n + ' must be a whole number of ticks from 1 to 2000.');
    if (i && t.ticks <= tg[i - 1].ticks) return bad('t' + n, 'Target ' + n + ' must be farther than target ' + i + ' (nearest first).');
    if (!wholeIn(t.sharePct, 1, 100)) return bad('s' + n, 'Target ' + n + '\'s share must be a whole percent from 1 to 100.');
    sum += t.sharePct;
  }
  if (sum !== 100) return bad('s' + tg.length, 'The target shares add up to ' + sum + '%; they must add up to 100%.');
  const be = s.breakeven;
  if (be !== null) {
    if (!exactKeys(be, ['afterTicks', 'plusTicks'])) return bad('beAfter', 'Breakeven needs after and plus ticks.');
    if (!wholeIn(be.afterTicks, 1, 2000)) return bad('beAfter', 'Breakeven after must be a whole number of ticks from 1 to 2000.');
    if (!wholeIn(be.plusTicks, 0, 100)) return bad('bePlus', 'Breakeven plus must be a whole number of ticks from 0 to 100.');
    if (be.plusTicks >= be.afterTicks) return bad('bePlus', 'Breakeven plus must be below breakeven after (the stop never goes past the price that moved it).');
  }
  const tr = s.trail;
  if (tr !== null) {
    if (!exactKeys(tr, ['startTicks', 'byTicks', 'stepTicks'])) return bad('trailAfter', 'Trailing needs start, by and step ticks.');
    for (const [k, f, w] of [['startTicks', 'trailAfter', 'starts after'], ['byTicks', 'trailBy', 'trails by'], ['stepTicks', 'trailStep', 'steps of']])
      if (!wholeIn(tr[k], 1, 2000)) return bad(f, 'Trailing ' + w + ' must be a whole number of ticks from 1 to 2000.');
  }
  if (own(s, 'barTrail')) {
    const bt = s.barTrail;
    const bk = isObj(bt) ? Object.keys(bt) : [];
    if (!isObj(bt) || !own(bt, 'bars') || !own(bt, 'offsetTicks') || bk.some(k => !['bars', 'offsetTicks', 'type', 'size', 'startTicks'].includes(k))) return bad('barTrail', 'The bar trail needs bars and offset ticks (and may have a bar type and size, and a start).');
    if (!wholeIn(bt.bars, 1, BAR_TRAIL_MAX)) return bad('barTrail', 'The bar trail must be a whole number of bars from 1 to ' + BAR_TRAIL_MAX + '.');
    if (!wholeIn(bt.offsetTicks, 0, BAR_OFFSET_MAX)) return bad('barOffset', 'The bar trail\'s offset must be a whole number of ticks from 0 to ' + BAR_OFFSET_MAX + '.');
    if (own(bt, 'type') !== own(bt, 'size')) return bad('barType', 'The bar trail\'s bar type and size go together.');
    if (own(bt, 'type') && !BAR_TYPES.includes(bt.type)) return bad('barType', 'The bar trail\'s bars are minute or range bars' + (typeof bt.type === 'string' && bt.type ? ': ' + bt.type + ' bars are not supported.' : '.'));
    if (own(bt, 'type') && bt.type === 'minute' && !BAR_MINUTES.includes(bt.size)) return bad('barSize', 'Minute bars for the bar trail are 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60 minutes.');
    if (own(bt, 'type') && bt.type === 'range' && !wholeIn(bt.size, 1, BAR_RANGE_MAX)) return bad('barSize', 'Range bars for the bar trail are a whole number of ticks from 1 to ' + BAR_RANGE_MAX + '.');
    if (own(bt, 'startTicks') && !wholeIn(bt.startTicks, 0, BAR_START_MAX)) return bad('barStart', 'The bar trail\'s start must be a whole number of ticks from 0 to ' + BAR_START_MAX + ' (0: at once).');
    if (tr !== null) return bad('barTrail', 'One trail per strategy: Trailing or Bar trail, not both.');
  }
  if (s.hotkey !== null) {
    if (!isCombo(s.hotkey)) return bad('hotkey', 'The hotkey is not a key the chart can use.');
    const hk = c.hotkeys ? cleanHotkeysDoc(c.hotkeys) : emptyHotkeysDoc();
    const why = hotkeyConflict(s.hotkey, { strategy: s.id }, { keys: hk.keys, modifiers: hk.modifiers, strategies: others }, null, !c.page);
    if (why) return bad('hotkey', why);
  }
  return null;
}
/** The Desk's rules for a whole strategies document ('' when it passes): "strategies[0] ...". */
function checkStrategiesDoc(doc, hotkeys) {
  if (!exactKeys(doc, ['rev', 'strategies'])) return 'The strategies document needs exactly rev and strategies.';
  if (!isInt(doc.rev) || doc.rev < 0 || doc.rev > 1e9) return 'rev must be a whole number from 0 to 1,000,000,000.';
  if (!Array.isArray(doc.strategies) || doc.strategies.length > STRATEGY_MAX) return 'At most ' + STRATEGY_MAX + ' strategies.';
  const ids = new Set();
  for (let i = 0; i < doc.strategies.length; i++) {
    const s = doc.strategies[i];
    if (isObj(s) && ids.has(s.id)) return 'strategies[' + i + '] id ' + s.id + ' is used twice.';
    if (isObj(s)) ids.add(s.id);
    const why = checkStrategy(s, { others: doc.strategies, hotkeys });
    if (why) return 'strategies[' + i + '] ' + why.text;
  }
  return '';
}
/** A strategies document as read: the strategies that pass The Desk's rules (in order, at most 24). Never throws. */
function cleanStrategiesDoc(v) {
  const out = emptyStrategiesDoc();
  if (!isObj(v)) return out;
  if (isInt(v.rev) && v.rev >= 0 && v.rev <= 1e9) out.rev = v.rev;
  if (!Array.isArray(v.strategies)) return out;
  const ids = new Set();
  for (const s of v.strategies) {
    if (out.strategies.length >= STRATEGY_MAX) break;
    if (!isObj(s) || ids.has(s.id)) continue;
    if (checkStrategy(s, { others: out.strategies })) continue;
    ids.add(s.id);
    out.strategies.push(s);
  }
  return out;
}
/**
 * Next release (Anthony 2026-11-01: a bar kind or size the chart does not support is said plainly, never dropped in silence):
 * the strategies of a document as read that cleanStrategiesDoc leaves out, each [{ name, text }] with the reason in The Desk's
 * words (a bar trail on tick or volume bars, a size the bar trail does not take, any other rule). Never throws.
 */
function strategiesLeftOut(v) {
  if (!isObj(v) || !Array.isArray(v.strategies)) return [];
  const kept = [], ids = new Set(), out = [];
  for (const s of v.strategies) {
    const name = isObj(s) && typeof s.name === 'string' && strategyName(s.name) ? strategyName(s.name) : 'A strategy';
    if (kept.length >= STRATEGY_MAX) { out.push({ name, text: 'Past the ' + STRATEGY_MAX + ' strategies the chart takes.' }); continue; }
    if (!isObj(s)) { out.push({ name, text: 'Not a strategy.' }); continue; }
    if (ids.has(s.id)) { out.push({ name, text: 'Its id is used twice.' }); continue; }
    const why = checkStrategy(s, { others: kept });
    if (why) { out.push({ name, text: why.text }); continue; }
    ids.add(s.id); kept.push(s);
  }
  return out;
}

/* ---------------- The Desk's strategy -> `order.strategy` (PROTOCOL.md "Shared settings", the table) */
/** The flat object ChartBridge takes. `id` and `hotkey` stay on the page; a null breakeven or trail leaves its keys out. */
function toWire(s) {
  const w = { name: strategyName(s.name), stop: s.stop.ticks, stopLimit: s.stop.type === 'limit' ? s.stop.limitOffsetTicks : null };
  s.targets.forEach((t, i) => { w['t' + (i + 1)] = t.ticks; w['t' + (i + 1) + 'Share'] = t.sharePct; });
  if (s.breakeven) { w.beAfter = s.breakeven.afterTicks; w.bePlus = s.breakeven.plusTicks; }
  if (s.trail) { w.trailAfter = s.trail.startTicks; w.trailBy = s.trail.byTicks; w.trailStep = s.trail.stepTicks; }
  if (s.barTrail) {
    const k = barKind(s.barTrail);
    w.barTrail = s.barTrail.bars; w.barTrailOffset = s.barTrail.offsetTicks; w.barTrailType = k.type; w.barTrailSize = k.size;
    if (s.barTrail.startTicks > 0) w.barTrailStart = s.barTrail.startTicks;
  }
  return w;
}
const WIRE_KEYS = ['name', 'stop', 'stopLimit', 't1', 't1Share', 't2', 't2Share', 't3', 't3Share', 'beAfter', 'bePlus', 'trailAfter', 'trailBy', 'trailStep', 'barTrail', 'barTrailOffset', 'barTrailType', 'barTrailSize', 'barTrailStart'];
/**
 * ChartBridge's check of `order.strategy` (PROTOCOL.md "Order Strategies", the key table), the same rules in the same
 * order, so the page refuses what ChartBridge would: null, or the reason. `maxBracketTicks` (0 for none): every distance
 * at most that. A strategy must be one flat object of known keys.
 */
function checkWire(s, maxBracketTicks) {
  if (!isObj(s)) return 'A strategy must be one flat object.';
  for (const k of Object.keys(s)) {
    if (!WIRE_KEYS.includes(k)) return 'Unknown key "' + k + '" in strategy.';
    if (s[k] !== null && typeof s[k] === 'object') return 'A strategy must be one flat object.';
  }
  const maxB = isInt(maxBracketTicks) && maxBracketTicks > 0 ? maxBracketTicks : 0;
  const whole = (k, min) => {
    const v = s[k];
    if (!isInt(v) || v < min) return k + ' must be a whole number of ' + min + ' or more.';
    if (maxB && v > maxB) return k + ' must be at most ' + maxB + ' (maxBracketTicks in config.txt).';
    return null;
  };
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 40) return 'The strategy needs a name of 1 to 40 characters.';
  if (NAME_BAD.test(s.name)) return 'The strategy\'s name holds " or \\ or a control character: ChartBridge refuses a message with a backslash escape.';
  let why = whole('stop', 1);
  if (why) return why;
  if (s.stopLimit !== undefined && s.stopLimit !== null && (why = whole('stopLimit', 0))) return why;
  let n = 0, sum = 0;
  for (const i of [1, 2, 3]) {
    const t = s['t' + i], sh = s['t' + i + 'Share'];
    if (t === undefined && sh === undefined) continue;
    if (n !== i - 1) return 't' + i + ' needs t' + (i - 1) + '.';
    if ((why = whole('t' + i, 1))) return why;
    if (!isInt(sh) || sh < 1 || sh > 100) return 't' + i + 'Share must be a whole percent from 1 to 100.';
    n = i; sum += sh;
  }
  if (n && sum !== 100) return 'The target shares add up to ' + sum + '; they must add up to 100.';
  if ((s.beAfter === undefined) !== (s.bePlus === undefined)) return 'beAfter and bePlus go together.';
  if (s.beAfter !== undefined) {
    if ((why = whole('beAfter', 1)) || (why = whole('bePlus', 0))) return why;
    if (s.bePlus >= s.beAfter) return 'bePlus must be below beAfter.';
  }
  const tr = ['trailAfter', 'trailBy', 'trailStep'].filter(k => s[k] !== undefined).length;
  if (tr !== 0 && tr !== 3) return 'trailAfter, trailBy and trailStep go together.';
  if (tr) for (const k of ['trailAfter', 'trailBy', 'trailStep']) if ((why = whole(k, 1))) return why;
  /* the bar trail (ChartBridge of the next build): both or neither, never with the tick trail */
  const hn = s.barTrail !== undefined, ho = s.barTrailOffset !== undefined;
  if (hn && (!isInt(s.barTrail) || s.barTrail < 1 || s.barTrail > BAR_TRAIL_MAX)) return 'barTrail must be a whole number of bars from 1 to ' + BAR_TRAIL_MAX + '.';
  if (ho && (!isInt(s.barTrailOffset) || s.barTrailOffset < 0 || s.barTrailOffset > BAR_OFFSET_MAX)) return 'barTrailOffset must be a whole number of ticks from 0 to ' + BAR_OFFSET_MAX + '.';
  if (hn !== ho) return 'barTrail and barTrailOffset go together.';
  if (hn && maxB && s.barTrailOffset > maxB) return 'barTrailOffset must be at most ' + maxB + ' (maxBracketTicks in config.txt).';
  if (hn && tr) return 'barTrail and trailAfter are refused together: one trail per strategy.';
  /* Anthony 2026-11-01: the bar kind and the start (ChartBridgeStrategies.cs ParseStrategy, the same rules) */
  const ht = s.barTrailType !== undefined, hz = s.barTrailSize !== undefined, hs = s.barTrailStart !== undefined;
  if ((ht || hz || hs) && !hn) return 'barTrailType, barTrailSize and barTrailStart need barTrail.';
  if (ht && !BAR_TYPES.includes(s.barTrailType)) return 'barTrailType must be "minute" or "range".';
  if (hz && !isInt(s.barTrailSize)) return 'barTrailSize must be a whole number.';
  if (ht !== hz) return 'barTrailType and barTrailSize go together.';
  if (ht && s.barTrailType === 'minute' && !BAR_MINUTES.includes(s.barTrailSize)) return 'barTrailSize for minute bars must be 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60.';
  if (ht && s.barTrailType === 'range' && (s.barTrailSize < 1 || s.barTrailSize > BAR_RANGE_MAX)) return 'barTrailSize for range bars must be a whole number of ticks from 1 to ' + BAR_RANGE_MAX + '.';
  if (hs && (!isInt(s.barTrailStart) || s.barTrailStart < 0 || s.barTrailStart > BAR_START_MAX)) return 'barTrailStart must be a whole number of ticks from 0 to ' + BAR_START_MAX + '.';
  if (hs && maxB && s.barTrailStart > maxB) return 'barTrailStart must be at most ' + maxB + ' (maxBracketTicks in config.txt).';
  return null;
}
/** One line for a strategy: "Stop 16 STL+2 · T1 8 50% · T2 20 50% · BE 8+1 · Trail 12/6/2". */
function describe(s) {
  if (!s) return '';
  const parts = ['Stop ' + s.stop.ticks + (s.stop.type === 'limit' ? ' STL+' + s.stop.limitOffsetTicks : '')];
  s.targets.forEach((t, i) => parts.push('T' + (i + 1) + ' ' + t.ticks + (s.targets.length > 1 ? ' ' + t.sharePct + '%' : '')));
  if (s.breakeven) parts.push('BE ' + s.breakeven.afterTicks + '+' + s.breakeven.plusTicks);
  if (s.trail) parts.push('Trail ' + s.trail.startTicks + '/' + s.trail.byTicks + '/' + s.trail.stepTicks);
  if (s.barTrail) parts.push('Bar trail ' + s.barTrail.bars + ' x ' + barKindText(s.barTrail) + (s.barTrail.offsetTicks ? ' +' + s.barTrail.offsetTicks : '') + (s.barTrail.startTicks > 0 ? ' from ' + s.barTrail.startTicks : ''));
  return parts.join(' · ');
}
/** A new strategy's id: letters and digits The Desk accepts, unique among `others`. */
function newId(others, now, rand) {
  const t = (typeof now === 'number' ? now : Date.now()).toString(36);
  for (let i = 0; ; i++) {
    const id = 's' + t + (rand ? rand() : Math.random()).toString(36).slice(2, 6) + (i || '');
    if (!(others || []).some(o => o && o.id === id)) return id;
  }
}

/* ---------------- hotkeys that fire more than the five trading keys */
/**
 * What a combo pressed does beyond the five trading keys and Maximize: 'merge', 'accept', 'reject', 'strategy:<id>' (make
 * it the active strategy), 'buy:limit', 'sell:stop' (a Buy or Sell key with an entry-type modifier held: that entry type
 * at the price under the mouse), or '' for none. `ctx`: { keys, modifiers, strategies, on: { merge, accept, strategies,
 * types } } (each part only when its switch is on).
 */
function resolveKey(combo, ctx) {
  if (!combo || !ctx) return '';
  const on = ctx.on || {}, keys = ctx.keys || {};
  if (on.merge && keys.merge === combo) return 'merge';
  if (on.accept && keys.accept === combo) return 'accept';
  if (on.accept && keys.reject === combo) return 'reject';
  if (on.strategies) { const s = (ctx.strategies || []).find(x => x && x.hotkey === combo); if (s) return 'strategy:' + s.id; }
  if (on.types) {
    const p = OT.parseHotkey(combo), mods = ctx.modifiers || {};
    if (!p) return '';
    for (const m of ENTRY_MODS) {
      const mod = mods[m.id];
      if (!mod || !usesMod(combo, mod)) continue;
      const base = (p.ctrl && mod !== 'Ctrl' ? 'Ctrl+' : '') + (p.alt && mod !== 'Alt' ? 'Alt+' : '') + (p.shift && mod !== 'Shift' ? 'Shift+' : '') + p.key;
      if (keys.buy && keys.buy === base) return 'buy:' + m.id;
      if (keys.sell && keys.sell === base) return 'sell:' + m.id;
    }
  }
  return '';
}
/**
 * The entry-type modifier held on a chart click: 'limit', 'stop' or ''. Shift and Ctrl already pick the side of a click
 * (Shift+click buys; Shift+right click and Ctrl+click sell), so only a modifier beyond them counts (lead's default: in
 * practice Alt). `mods`: { ctrl, alt, shift } of the click; `side`: what the click is ('buy' Shift+left, 'sell').
 */
function clickFamily(mods, modifiers, sideKeys) {
  const m = modifiers || {}, held = { Ctrl: !!(mods && mods.ctrl), Alt: !!(mods && mods.alt), Shift: !!(mods && mods.shift) };
  for (const k of sideKeys || []) held[k] = false;                 // the click's own key
  const hit = ENTRY_MODS.filter(x => m[x.id] && held[m[x.id]]);
  return hit.length === 1 ? hit[0].id : '';
}

/* ---------------- entry types (orderTypes = on): limit, stop-limit, stop-market, MIT */
const KIND_TEXT = { market: 'MKT', limit: 'LMT', stop: 'STP', stopLimit: 'STL', mit: 'MIT' };
/** The side of the market a priced kind rests on, as OrderTicket.placeKind names it: a limit or an MIT on the better side
    ('limit'), a stop or a stop-limit on the worse side ('stop'). */
const baseKind = k => (k === 'limit' || k === 'mit' ? 'limit' : k === 'stop' || k === 'stopLimit' ? 'stop' : '');
/**
 * The entry kind for a price: { kind } or { error }. No family: OrderTicket.placeKind, as Shift+click has always placed it.
 * Family 'limit' (fills at the price or better): a limit on the better side of the market, a stop-limit on the worse side.
 * Family 'stop' (a market order once the price trades): a stop-market on the worse side, an MIT on the better side; at the
 * last price an MIT would trigger at once, so it is refused (use the market button).
 */
function entryKind(side, price, last, family) {
  const base = OT.placeKind(side, price, last);
  if (!family) return { kind: base };
  if (!(last > 0)) return { error: 'No price yet: nothing was sent. Market orders and Flatten work.' };
  if (family === 'limit') return { kind: base === 'limit' ? 'limit' : 'stopLimit' };
  if (family === 'stop') {
    if (Math.abs(price - last) < 1e-9) return { error: 'Not sent: at the last price an MIT would trigger at once. Use ' + (side === 'sell' ? 'Sell' : 'Buy') + ' MKT.' };
    return { kind: base === 'stop' ? 'stop' : 'mit' };
  }
  return { error: 'Not sent: unknown entry type.' };
}
/** The kind a chart worked out (from its own price) turned into an entry type: the family keeps the side of the market. */
function kindFor(chartKind, family) {
  if (!family || (chartKind !== 'limit' && chartKind !== 'stop')) return chartKind;
  if (family === 'limit') return chartKind === 'limit' ? 'limit' : 'stopLimit';
  return chartKind === 'stop' ? 'stop' : 'mit';
}

/* ---------------- what ChartBridge says back: managed strategies and merges, in plain words */
/* next release: ChartBridge's word on the bar trail (`managed` `barTrail` {state, text}, only with a bar trail): on, building
   (fewer whole bars than asked yet), notProven (range bars not yet known to be NinjaTrader's own from the session open: the stop
   stays where it is, Anthony 2026-11-01), ended (the session closed: it no longer moves the stop), none (no bars for it). Every
   state but on is said on the ticket in ChartBridge's words; notProven, ended and none in the warning colour. 1.42: on the ticket
   only ChartBridge's words up to their first ": " ("not proven yet", "ended at the session close", "not running"), the whole of
   them in the line's tooltip (`tip`), as the ticket does with long text: the reason ran to 8 lines in a ticket 2 cells wide at
   1366 and was cut off by the panel. Next release (Anthony 2026-11-02): ended says just "Bar trail ended" on the ticket (its
   words up to the colon, "ended at the session close", still wrapped to 3 lines in the ticket 219 px wide at 1366 and the panel
   cut the third off); the whole reason stays in the tooltip, the line stays in the warning colour. */
const BAR_STATE_WARN = ['notProven', 'ended', 'none'];
function barTrailNote(m) {
  const b = m && m.barTrail && typeof m.barTrail === 'object' ? m.barTrail : null;
  if (!b || b.state === 'on' || typeof b.state !== 'string') return { text: '', warn: false, tip: '' };
  const full = typeof b.text === 'string' && b.text ? b.text : b.state === 'notProven' ? 'not proven yet' : b.state;
  const cut = full.indexOf(': '), t = b.state === 'ended' ? 'ended' : cut > 0 ? full.slice(0, cut) : full;
  return { text: ' · Bar trail ' + t, warn: BAR_STATE_WARN.includes(b.state), tip: t !== full ? ' · Bar trail ' + full : '' };
}
/** The ticket's line for a `managed` message: { text, level } ('' text for one that is done), and `tip` (the line with the bar
 *  trail's whole reason, for the tooltip) only when the line says less of it. */
function managedLine(m) {
  const r = managedText(m), bt = barTrailNote(m);
  if (r.text && bt.tip && r.text.endsWith(bt.text)) r.tip = r.text.slice(0, r.text.length - bt.text.length) + bt.tip;
  return r;
}
function managedText(m) {
  if (!m || m.state === 'done') return { text: '', level: '' };
  const n = Array.isArray(m.pairs) ? m.pairs.length : 0, name = typeof m.name === 'string' ? m.name : 'strategy';
  const be = n ? m.pairs.filter(p => p && p.be).length : 0, tr = n ? m.pairs.filter(p => p && p.trailing).length : 0;
  const how = n ? ': ' + n + ' pair' + (n > 1 ? 's' : '') + (be ? ', ' + be + ' at breakeven' : '') + (tr ? ', ' + tr + ' trailing' : '') : '';
  const why = typeof m.text === 'string' && m.text ? ' (' + m.text + ')' : '';
  const bt = barTrailNote(m);
  if (m.state === 'waiting') return { text: name + ': waiting for the fill' + bt.text, level: bt.warn ? 'warn' : '' };
  if (m.state === 'active') return { text: name + ' managing' + how + bt.text, level: bt.warn ? 'warn' : '' };
  if (m.state === 'resumed') return { text: name + ' resumed after a restart' + how + why + bt.text, level: 'warn' };
  if (m.state === 'unmanaged') return { text: name + ' NOT MANAGED: ' + (typeof m.text === 'string' && m.text ? m.text.replace(/\.?\s*Manage it by hand\.?$/i, '') : 'breakeven and trailing are off') + '. Manage the stop by hand.', level: 'error' };
  return { text: name + ': ' + String(m.state) + why, level: '' };
}
const MERGE_WORD = { merged: 'Merged', restored: 'Merge undone, brackets restored', failed: 'MERGE FAILED' };
/** The ticket's line for a `merge` result: { text, level }. */
function mergeLine(m) {
  if (!m) return { text: '', level: '' };
  const word = MERGE_WORD[m.result] || 'Merge: ' + String(m.result);
  const text = word + ' · ' + (m.account || '') + ' ' + (m.root || '') + (typeof m.text === 'string' && m.text ? ': ' + m.text : '');
  return { text, level: m.result === 'merged' ? '' : m.result === 'restored' ? 'warn' : 'error' };
}

/* ---------------- The Desk: the two documents, read and saved whole, a copy kept in this browser */
const DESK_KEYS = { cache: 'live-desk-cache-v1' };
const DESK_DEFAULT = 'http://localhost:8800';
const DOCS = { hotkeys: { path: '/api/chart-hotkeys', clean: cleanHotkeysDoc, what: 'hotkeys' }, strategies: { path: '/api/chart-strategies', clean: cleanStrategiesDoc, what: 'strategies' } };
/** The Desk's address: a scheme, a host and a port, no path, no trailing slash; '' when it is not one. */
function deskUrl(v) {
  const s = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '';
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+$/.test(s) && s.length <= 200 ? s : '';
}
/**
 * The Desk's two documents. o: { fetch, storage ({ getItem, setItem }), base, timeoutMs (5000) }. Each read and each save
 * keeps the document in this browser (live-desk-cache-v1), so a PC that cannot reach The Desk shows the last copy read.
 *   base()                    The Desk's address (a string or a promise of one): the page's one source, ChartBridge's
 *                             deskUrl in config.txt (AccountsPage.deskBase, from /diag); http://localhost:8800 without it
 *   url()                     the address last used (for a label)
 *   cached(which)             the last copy read ({ doc, at } or null), which = 'hotkeys' | 'strategies'
 *   read(which)               Promise of { ok, doc } or { ok: false, error, status }
 *   save(which, doc)          Promise of { ok, doc } (the stored document, rev + 1) or { ok: false, error, conflict,
 *                             status }; a 409 (another PC saved first) reads the document again, so cached() is The Desk's.
 *                             Nothing is ever saved from a guess: the caller keeps the edit and says it was not saved
 *   reach                     'unknown', 'ok' or 'down' (the last answer), and error (why it was down)
 */
function createDesk(o) {
  const st = o.storage, timeout = o.timeoutMs || 5000;
  const get = k => { try { return st ? st.getItem(k) : null; } catch (e) { return null; } };
  const set = (k, v) => { try { if (!st) return false; st.setItem(k, v); return true; } catch (e) { return false; } };
  /* leftOut: the strategies the last read or save left out ([{ name, text }], strategiesLeftOut), said on the Strategies screen */
  const desk = { reach: 'unknown', error: '', leftOut: { hotkeys: [], strategies: [] } };
  const readCache = () => { try { const v = JSON.parse(get(DESK_KEYS.cache)); return isObj(v) ? v : {}; } catch (e) { return {}; } };
  let last = DESK_DEFAULT;
  desk.url = () => last;
  const base = async () => { let v = ''; try { v = typeof o.base === 'function' ? await o.base() : ''; } catch (e) { v = ''; } last = deskUrl(v) || DESK_DEFAULT; return last; };
  desk.cached = which => {
    const c = readCache()[which];
    return isObj(c) && isObj(c.doc) ? { doc: DOCS[which].clean(c.doc), at: isInt(c.at) ? c.at : 0 } : null;
  };
  const keep = (which, doc) => { const c = readCache(); c[which] = { doc, at: Date.now() }; set(DESK_KEYS.cache, JSON.stringify(c)); };
  async function call(which, method, body) {
    const D = DOCS[which], ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : 0;
    try {
      const r = await o.fetch((await base()) + D.path, Object.assign({ method, cache: 'no-store', credentials: 'omit' }, ctl ? { signal: ctl.signal } : {},
        body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      return { status: r.status, body: j };
    } catch (e) {
      return { status: 0, error: e && e.name === 'AbortError' ? 'no answer in ' + Math.round(timeout / 1000) + ' s' : 'not reachable' };
    } finally { if (timer) clearTimeout(timer); }
  }
  const detail = r => (r.body && typeof r.body.detail === 'string' ? r.body.detail : 'The Desk answered ' + r.status + '.');
  const down = (r, what) => {
    desk.reach = 'down';
    desk.error = r.status === 0 ? 'The Desk (' + desk.url() + ') is ' + r.error + '.' : r.status === 403 ? 'The Desk refused this PC (403): it serves ' + what + ' to its own PC and the Tailscale range only.' : 'The Desk: ' + detail(r);
    return { ok: false, status: r.status, error: desk.error };
  };
  desk.read = async which => {
    const r = await call(which, 'GET');
    if (r.status !== 200 || !isObj(r.body)) return down(r, DOCS[which].what);
    desk.reach = 'ok'; desk.error = '';
    const doc = DOCS[which].clean(r.body);
    if (which === 'strategies') desk.leftOut.strategies = strategiesLeftOut(r.body);
    keep(which, doc);
    return { ok: true, doc };
  };
  desk.save = async (which, doc) => {
    const r = await call(which, 'PUT', doc);
    if (r.status === 200 && isObj(r.body)) {
      desk.reach = 'ok'; desk.error = '';
      const d = DOCS[which].clean(r.body);
      if (which === 'strategies') desk.leftOut.strategies = strategiesLeftOut(r.body);
      keep(which, d);
      return { ok: true, doc: d };
    }
    if (r.status === 409) {
      desk.reach = 'ok'; desk.error = '';
      await desk.read(which);
      return { ok: false, conflict: true, status: 409, error: 'Not saved: another PC saved the ' + DOCS[which].what + ' first (' + detail(r).replace(/\.$/, '') + '). The Desk\'s copy is loaded.' };
    }
    if (r.status === 400) { desk.reach = 'ok'; desk.error = ''; return { ok: false, status: 400, error: 'Not saved: ' + detail(r) }; }
    const d = down(r, DOCS[which].what);
    return { ok: false, status: d.status, error: 'Not saved: ' + d.error };
  };
  return desk;
}

return { SWITCHES, cleanSwitches, deskSyncOn, KEY_ACTIONS, KEY_IDS, keyName, MODIFIERS, ENTRY_MODS, isCombo, comboMods, usesMod,
  emptyHotkeysDoc, cleanHotkeysDoc, hotkeyConflict, keyFromEvent, modifierConflict, checkHotkeysDoc,
  STRATEGY_MAX, NAME_MAX, BAR_TRAIL_MAX, BAR_OFFSET_MAX, BAR_TYPES, BAR_MINUTES, BAR_RANGE_MAX, BAR_START_MAX, barKind, emptyStrategiesDoc, strategyName, checkStrategy, checkStrategiesDoc, cleanStrategiesDoc,
  toWire, WIRE_KEYS, checkWire, describe, newId, resolveKey, clickFamily, KIND_TEXT, baseKind, entryKind, kindFor,
  managedLine, barTrailNote, strategiesLeftOut, mergeLine, DESK_KEYS, DESK_DEFAULT, deskUrl, createDesk };
});
