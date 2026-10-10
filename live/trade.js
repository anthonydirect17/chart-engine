/*
 * TradeCore: the order logic of the order ticket, in one place (chart 1.12.0). The workspace's order ticket
 * (live/workspace.js, index.html) calls these very functions (the single chart page's order bar did too until chart
 * 1.21.0, when that page went), so there is one order path: what Buy MKT, Sell MKT, B/E, Flatten (Close), Cancel all, Flatten all, a
 * chart click and a drag send, and every check before it, is written once, here. It is the 1.11.0 code of live.js moved
 * out unchanged, with the chart's instrument, last price, Qty box and account picker read through `env`.
 *
 *   TradeCore.create(env)        the order logic for one ChartBridge connection (no DOM; it also loads in Node for tests)
 *   TradeCore.wire($, core, ui)  the order bar's controls (Armed, Account, Qty, Buy, Sell, the bracket, Flatten or Close,
 *                                B/E, Cancel all, the state row) wired to it; `$(id)` finds each control by its 1.11.0 id
 *
 * The page asks; ChartBridge decides: every safety gate is enforced there (nt8/PROTOCOL.md, Orders). The page checks its
 * own inputs (trading on, Armed, connected, the account shown, the qty cap, a price to click) so a slip is caught before
 * anything is sent, and it keeps within ChartBridge's 10 order actions a second (6 a second for Cancel all).
 *
 * env (all functions unless noted):
 *   send(obj)            write one message on the connection (only called while open() is true)
 *   open()               the connection is open
 *   sock()               the connection itself (sign-in checks it is still the same one)
 *   root()               the instrument orders are for (the chart's, or the ticket's)
 *   lastPrice()          its last price, or null
 *   qty()                the Qty shown (NaN when none)
 *   pickerAccount()      the account the picker shows (orders go only when it is the order account)
 *   wantedAccount()      the account to start on when trading comes on (LivePrefs.orderAccount)
 *   tick(root), served(root), fmt(price)
 *   flash(text, level)   a note ('', 'warn' or 'error')
 *   later(fn, ms)        a timer the host clears on destroy
 *   changed()            render the order state (bar, chart lines)
 *   armed(on)            Armed changed: the host shows it
 *   applied(pick, cameOn) after a `trading` message: the host's account picker and note
 *   lost(account)        the connection dropped (the order account it was on)
 *   syncAccounts()       put the picker back on the order account
 *   batch(), unsent()    render the Cancel all line and the note of what was not sent
 *   positionChanged()    a position message (the host marks fills)
 *   armBlocked()         '' or why Armed cannot come on here (the workspace: only the ticket's window arms)
 *   confirmNoStop(root, go)  1.13.0: the first order with no stop after a page load asks "No stop: send anyway?" in the
 *                        page; the host shows its dialog and calls go() on Send (then false: nothing is asked again
 *                        this page load). Returns false when it cannot ask here (a click forwarded from another window).
 *                        The question must not be modal: Close and Flatten all work while it is open.
 *   dropNoStop()         F2 review: close an open NO STOP question, its order not sent (Close, Flatten all and Armed
 *                        going off call it; the answer is also bound to the instrument, account and Armed it was asked in)
 *   flattened(root)      a Close or Flatten (root) or Flatten all (null) was pressed here, for other windows (optional)
 *   strategy()           1.16.0 (optional): the active Order Strategy, { name, wire } (wire: The Desk's strategy as
 *                        OrderStrategies.toWire gives it), or null for the bracket; used only while `switches.strategies`
 *   merged(m)            1.16.0 (optional): ChartBridge's `merge` result arrived (the host shows it)
 *   destroyed()          the host went away
 *   prefs, LP            LivePrefs (the saved bracket, qty and presets) and its module
 *   pin, fetch, framed, framedReason, now
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TradeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const OT = typeof self !== 'undefined' && self.OrderTicket ? self.OrderTicket : require('./order-ticket.js');
/* 1.16.0: Order Strategies, entry types and Merge (live/order-strategies.js); a page that does not load it has none */
const OS = typeof self !== 'undefined' && self.OrderStrategies ? self.OrderStrategies : typeof require === 'function' ? require('./order-strategies.js') : null;
/* 1.17.0: AgentCore's pageExitPasses, the one test of an exit on an agent's pair (agent-core.js loads after this file in
   index.html, so it is looked up when needed; with none loaded no agent owns anything and nothing asks) */
const agentCore = () => (typeof self !== 'undefined' && self.AgentCore) || (typeof require === 'function' ? require('./agent-core.js') : null);
const ORDER_ACTIONS = ['order', 'change', 'cancel', 'flatten', 'plan', 'merge'];   // what ChartBridge counts, 10 a second at most (plan: 0.3.8; merge: 0.4.0)
const CANCEL_CHUNK = 6, CANCEL_GAP = 1100, CANCEL_AGAIN = 5000;
const BE_LIMIT = 10;
const RATE_REFUSAL = /order actions/i;
const FLATTEN_KEEP = 3000;                                         // a refusal this soon after a Flatten is about it

function create(env) {
  const LP = env.LP, prefs = env.prefs, ROOTS = LP.ROOTS;
  const flash = (text, level) => env.flash(text, level);
  const later = (fn, ms) => env.later(fn, ms);
  const now = typeof env.now === 'function' ? env.now : () => performance.now();
  const open = () => !!env.open();
  const root = () => env.root();
  const lastPrice = () => env.lastPrice();
  const tickOf = r => env.tick(r);
  const fmt = p => env.fmt(p);
  const served = r => env.served(r);
  const FRAMED = !!env.framed;
  const FRAMED_REASON = env.framedReason || 'This chart is inside another page (a frame), so it cannot trade.';
  const PIN = env.pin || null;

  const TR = {
    v2: false, enabled: false, reason: '', accounts: [], maxQty: {}, maxBracketTicks: 0, version: '', signInStarted: false,
    armed: false,                        // never saved: Armed is off after every page load
    account: '',
    orders: new Map(),                   // id -> latest order message (working ones; finished ones are dropped)
    positions: new Map(),                // 'account|root' -> { qty, avgPrice }
    /* 1.16.0 (protocol v3): ChartBridge's switches (all off unless the window's v3 connection says on: setSwitches), its
       managed strategies by entry id (`managed`), and the last Merge result per 'account|root' (`merge`). This connection
       stays a v2 page (it never sends `client`); those three come from the window's v3 connection (live/accounts.js) */
    switches: OS ? OS.cleanSwitches(null) : {}, managed: new Map(), merges: new Map(),
  };
  const sw = k => !!OS && TR.switches[k] === true;
  let v3sw = null;                                    // the switches the window's v3 connection last read (null: none)
  /* The bracket's cap (1.13.0): 200 ticks for ChartBridge before 0.3.7, none for 0.3.7 and newer unless config.txt sets
     maxBracketTicks. Read as saved (up to OT.NO_CAP) and cut to the cap once ChartBridge says which it is. */
  const cap = () => OT.bracketCap(TR.version, TR.maxBracketTicks);
  const brackets = {};
  for (const r of ROOTS) brackets[r] = OT.cleanBracket(prefs.bracket(r), OT.NO_CAP);
  const recap = () => { for (const r of ROOTS) brackets[r] = OT.cleanBracket(brackets[r], cap()); };
  /* 1.10.0: the qty picked last per root (1 to 9), the bracket preset picked per root, and the bracket unit. */
  const qtys = {};
  for (const r of ROOTS) qtys[r] = prefs.qty(r);
  const BK = { sel: {}, unit: prefs.bracketUnit(), presets: OT.cleanBracketPresets(prefs.raw.get(LP.KEYS.bracketPresets), OT.NO_CAP) };
  for (const r of ROOTS) BK.sel[r] = prefs.bracketSel(r);
  const sameAction = OT.repeatGuard(400);
  let cidSeq = 0;
  const newCid = () => 'p' + Date.now().toString(36) + '-' + (++cidSeq);
  const tradeMode = () => TR.v2 && TR.enabled;

  function send(obj) {
    if (!open()) return;
    env.send(obj);
    if (ORDER_ACTIONS.includes(obj.type)) actionSent();
  }

  /* Sign in: read the session token from GET /session (same origin as this page) and send auth. */
  function signIn() {
    TR.signInStarted = true;
    if (FRAMED) { applyTrading({ enabled: false, reason: FRAMED_REASON }); return; }
    const sock = env.sock();
    env.fetch('/session', { cache: 'no-store', headers: PIN ? PIN.headers() : {} })
      .then(r => r.ok ? r.text() : Promise.reject(new Error('GET /session answered ' + r.status)))
      .then(body => {
        let token = null;
        try { const j = JSON.parse(body); token = typeof j === 'string' ? j : j && j.token; } catch (e) { token = body.trim(); }
        if (!token) throw new Error('no token in GET /session');
        if (sock === env.sock()) send({ type: 'auth', token });
      })
      .catch(e => {
        if (sock !== env.sock()) return;
        if (!PIN) { applyTrading({ enabled: false, reason: 'Could not sign in to ChartBridge (' + e.message + '). Open the chart from ChartBridge itself to trade.' }); return; }
        /* With the PIN (0.3.2): ask ChartBridge again in 2 s. Still unlocked: sign in again. The unlock is gone: drop
           the connection, and the reconnect shows the PIN pad. */
        applyTrading({ enabled: false, reason: 'Signing in to ChartBridge for orders again (' + e.message + ')' });
        later(() => {
          if (env.destroyed() || sock !== env.sock()) return;
          PIN.check().then(st => {
            if (env.destroyed() || sock !== env.sock()) return;
            if (st === 'none' || st === 'set') { try { sock.close(); } catch (err) { /* already closed */ } }
            else signIn();
          });
        }, 2000);
      });
  }
  function applyTrading(t) {
    TR.v2 = true;
    TR.enabled = !!t.enabled && !FRAMED;
    TR.reason = FRAMED ? FRAMED_REASON : t.enabled ? '' : (t.reason || 'Trading is not enabled in ChartBridge.');
    TR.accounts = Array.isArray(t.accounts) ? t.accounts.slice() : [];
    TR.maxQty = t.maxQty || {};
    TR.maxBracketTicks = Number.isInteger(t.maxBracketTicks) && t.maxBracketTicks > 0 ? t.maxBracketTicks : 0;   // 0.3.7: only when config.txt sets it
    if (OS) TR.switches = OS.cleanSwitches(TR.enabled ? v3sw : null);   // 1.16.0: the v3 connection's switches; off with trading off
    recap();
    // a Cancel all under way stops for what ChartBridge would refuse: all of it while trading is off, and the orders of
    // an account no longer on its list (review 2 S1; they cannot be cancelled from the page then)
    if (!TR.enabled) batchStop(() => true, 'trading went off (' + TR.reason.replace(/\.$/, '') + ')');
    else batchStop(e => !TR.accounts.includes(e.account), 'the account is no longer a trade account in ChartBridge');
    const was = TR.account, cameOn = TR.enabled && !was;           // trading comes on: a load, a PIN entry, a reconnect
    const pick = LP.orderAccount(TR.accounts, TR.enabled ? env.wantedAccount() : '');
    TR.account = TR.enabled ? pick.account : '';                   // no order account while trading is off
    if (cameOn || !TR.enabled || TR.account !== was) setArmed(false);   // Armed always starts off; never restored
    env.changed();
    env.applied(pick, cameOn);
  }
  function lost(reason) {
    TR.signInStarted = false;
    if (!TR.v2) return;
    batchStop(() => true, 'the connection to ChartBridge dropped');   // before the orders are cleared: count what was still working
    TR.enabled = false; TR.reason = reason; TR.orders.clear(); announced.clear(); TR.positions.clear();
    if (OS) TR.switches = OS.cleanSwitches(null);
    TR.managed.clear(); TR.merges.clear();                         // ChartBridge sends the managed ones again after auth
    const was = TR.account;
    TR.account = '';                                               // the tab's account stays with the host (syncAccounts)
    env.lost(was);
    setArmed(false); env.changed(); env.syncAccounts();
  }
  /* ChartBridge 0.5.1: what each working order last said in a message of its own (never one sent `again` after a snapshot):
     the note for an update compares with this, so a re-send that read ahead of NinjaTrader's own message never swallows
     that message's note. An again re-send only seeds an order it has no entry for (one a new orders list left out, its own
     message already shown), so its next move reads "Moved". Dropped with TR.orders' entries (finished, reconnect, a new
     orders list). */
  const announced = new Map();
  function onOrder(o) {
    if (!served(o.root)) return;
    const prev = announced.get(o.id) || null;
    const ev = OT.orderEvent(o, prev, fmt);
    if (OT.isWorking(o)) TR.orders.set(o.id, o); else TR.orders.delete(o.id);
    if (!OT.isWorking(o)) announced.delete(o.id);
    else if (o.again !== true || !announced.has(o.id)) announced.set(o.id, o);   // an again re-send only seeds a missing entry (after a new orders list)
    if (ev) flash(ev.text, ev.level === 'error' ? 'error' : '');
    if (!OT.isWorking(o) && unsent.delete(o.id)) env.unsent();
    env.changed();
  }
  /** ChartBridge's `hello`: protocol v2 carries `trading`; sign in. */
  function hello(m) {
    TR.version = m && typeof m.version === 'string' ? m.version : '';   // 0.3.7 and newer: no 200-tick cap on the page
    recap();
    if (m && m.trading) { applyTrading(m.trading); signIn(); }
  }
  /** A message from ChartBridge about trading; true when it was one. */
  function message(m) {
    switch (m && m.type) {
      case 'trading': applyTrading(m); if (!TR.signInStarted) signIn(); return true;
      case 'orders': TR.orders.clear(); announced.clear(); for (const o of m.list || []) if (served(o.root)) { TR.orders.set(o.id, o); announced.set(o.id, o); } unsentCheck(); env.changed(); return true;
      case 'order': onOrder(m); return true;
      case 'position': TR.positions.set(m.account + '|' + m.root, { qty: +m.qty || 0, avgPrice: +m.avgPrice || 0 }); env.changed(); if (env.positionChanged) env.positionChanged(); return true;
      case 'reject': if (!onRefused(m)) flash('Refused by ChartBridge: ' + m.reason, 'error'); env.changed(); return true;
      /* 1.16.0 (protocol v3): a managed strategy's state, and a Merge's result (each shown plainly by the host) */
      case 'managed': if (!OS || typeof m.id !== 'string') return true;
        if (m.state === 'done') TR.managed.delete(m.id); else TR.managed.set(m.id, m);
        env.changed(); return true;
      case 'merge': if (!OS || typeof m.account !== 'string' || typeof m.root !== 'string') return true;
        TR.merges.set(m.account + '|' + m.root, m);
        { const l = OS.mergeLine(m); flash(l.text, l.level); }
        if (typeof env.merged === 'function') env.merged(m);
        env.changed(); return true;
    }
    return false;
  }

  const capNow = () => OT.maxQtyFor(TR, root());
  const qtyNow = () => env.qty();

  /* Everything that sends an order action goes through here: trading enabled, Armed on, connected, data loaded.
     `armed` false (Flatten and Flatten all only; Anthony 2026-10-01, "Flatten is never blocked"): every check but Armed. */
  function ready(armed) {
    if (FRAMED) { flash(FRAMED_REASON, 'error'); return false; }
    if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return false; }
    if (!TR.armed && armed !== false) { flash('Armed is off: nothing was sent. Turn Armed on to trade.', 'warn'); return false; }
    if (!open()) { flash('Not connected to ChartBridge: nothing was sent.', 'error'); return false; }
    if (!TR.account) { flash('No account yet: nothing was sent.', 'warn'); return false; }   // 1.8.0: never blocked by a view loading
    if (env.pickerAccount() !== TR.account) { env.syncAccounts(); flash('Nothing was sent: the account shown was not the order account. The picker is back on ' + TR.account + '; click again to act on ' + TR.account + '.', 'error'); return false; }
    return true;
  }
  /* NO STOP (1.13.0, Anthony): the first order after a page load that would open or add with no stop asks first, in the
     page ("No stop: send anyway?"); after Send, the others of that page load go as before. Flatten, Close, Flatten all,
     B/E and cancels never ask. `again` sends it once Anthony says Send. */
  let noStopOk = false;
  function allowNoStop() { noStopOk = true; }
  function dropNoStop() { if (typeof env.dropNoStop === 'function') env.dropNoStop(); }
  let armGen = 0;                                          // counts Armed going off: an answer is for one arming only
  function sendOrder(side, kind, price, again) {
    if (!ready()) return;
    const R = root();
    // a price order needs the last price to be a limit or a stop (OT.placeKind): until one is known, only market orders
    if (kind !== 'market' && !(lastPrice() > 0)) { flash('No price yet: nothing was sent. Market orders and Flatten work.', 'warn'); return; }
    // 1.16.0: a stop-limit or an MIT entry only while ChartBridge says orderTypes is on (it refuses them otherwise)
    if ((kind === 'stopLimit' || kind === 'mit') && !sw('orderTypes')) { flash('Not sent: stop-limit and MIT orders are off in ChartBridge (orderTypes = off in config.txt).', 'warn'); return; }
    const qty = qtyNow(), bad = OT.checkQty(qty, capNow(), R);
    if (bad) { flash('Not sent: ' + bad, 'error'); return; }
    const b = OT.cleanBracket(brackets[R], cap()), pos = TR.positions.get(TR.account + '|' + R);
    /* 1.17.0 (ChartBridge 0.5.0's owner lock): on a pair an AI agent owns, the only order the page may send is an exit at
       market that only reduces (no bracket, no strategy): a resting limit, stop or MIT could outlive the position and open
       one with no stop. Said before sending, in ChartBridge's own words; Flatten and moving its stop or target still work. */
    const owner = typeof env.agentOwner === 'function' ? env.agentOwner(TR.account, R) : '';
    if (owner) {
      const pq = pos && pos.qty ? pos.qty : 0, AG = agentCore();
      // a reducing order never carries a bracket or a strategy (ChartBridge refuses them there): the exit as sent
      if (!AG || !AG.pageExitPasses({ kind, side, qty }, pq)) {
        flash('Not sent: ' + TR.account + ' ' + R + ' belongs to agent ' + owner + ': use Flatten, or move its stop or target.', 'error');
        return;
      }
    }
    const reduces = !OT.bracketAllowed(side, pos && pos.qty);          // ChartBridge refuses a bracket on a reducing order
    /* 1.16.0: the active Order Strategy goes with the entry in place of the bracket (only while ChartBridge says strategies
       is on); never on an order that reduces (ChartBridge refuses it there, as a bracket). Checked here by ChartBridge's own
       rules first (OS.checkWire), so a strategy it would refuse is not sent. */
    const strat = sw('strategies') && typeof env.strategy === 'function' ? env.strategy() : null;
    if (strat && !reduces) {
      const why = OS.checkWire(strat.wire, TR.maxBracketTicks);
      if (why) { flash('Not sent: strategy ' + strat.name + ': ' + why, 'error'); return; }
    }
    const hasStop = strat ? true : b.stop > 0;                         // a strategy always has its stop
    // a reversal (sell 3 while long 1) opens a position too: asked as an entry (F2 review); it still takes no bracket
    if (OT.opensPosition(side, pos && pos.qty, qty) && !hasStop && !noStopOk && typeof env.confirmNoStop === 'function') {
      const go = again || (() => sendOrder(side, kind, price));
      /* the answer is for this instrument and account while Armed (the F2 re-review): a Send after the instrument or the
         account changed, or after Armed went off (even if armed again), sends nothing */
      const asked = { root: R, account: TR.account, gen: armGen };
      const send = () => {
        if (!TR.armed || armGen !== asked.gen || root() !== asked.root || TR.account !== asked.account) {
          flash('Not sent: that question was for ' + asked.root + ' on ' + asked.account + (TR.armed && armGen === asked.gen ? ', and the order bar is on ' + root() + ' on ' + TR.account + ' now.' : ' while Armed; Armed went off since.'), 'warn');
          return;
        }
        noStopOk = true; go();
      };
      if (env.confirmNoStop(R, send) === false) flash('No stop on ' + R + ': nothing was sent. Set a stop, or send it from the order ticket\'s window to be asked.', 'warn');
      return;
    }
    if (!sameAction.call(null, [side, kind, price, qty].join('|'), now())) { flash('Ignored a repeat click within 0.4 s.', 'warn'); return; }
    const msg = { type: 'order', cid: newCid(), account: TR.account, root: R, side, kind, qty };
    if (kind !== 'market') msg.price = price;
    /* 1.16.0 (lead's default): a stop-limit entry's limit is at its stop (limitOffset 0): it never fills worse than the
       stop price */
    if (kind === 'stopLimit') msg.limitOffset = 0;
    if (strat && !reduces) msg.strategy = Object.assign({}, strat.wire);
    else if ((b.stop > 0 || b.target > 0) && !reduces) msg.bracket = { stop: b.stop, target: b.target };   // JSON numbers, 0 = none
    send(msg);
    sentCid = msg.cid;
    const kt = OS ? OS.KIND_TEXT[kind] || kind : kind === 'market' ? 'MKT' : kind === 'limit' ? 'LMT' : 'STP';
    flash('Sent ' + side.toUpperCase() + ' ' + kt + ' ' + qty + ' ' + R +
      (kind === 'market' ? '' : ' @ ' + fmt(price)) + (msg.strategy ? ' with strategy ' + strat.name : msg.bracket ? ' with bracket ' + b.stop + ' / ' + b.target + ' ticks'
        : reduces && strat ? ' (no strategy: it reduces the position)' : reduces && (b.stop > 0 || b.target > 0) ? ' (no bracket: it reduces the position)' : '') + ' · ' + TR.account, '');
  }
  /** A click on a chart at a price (Shift+click buys, Shift+right click and Ctrl+click sell): a limit or a stop by the
      last price, as the order bar's chart has always placed it. */
  function placeAt(side, price) { sendOrder(side, OT.placeKind(side, price, lastPrice()), price); }
  /** The cid of the last order sent (a forwarded order's refusal is matched by it). */
  let sentCid = '';
  /**
   * A click on a chart whose kind the chart worked out from its own price (1.12.0, the workspace: the chart may be in
   * another window, with a fresher price than this one). Sent as the chart says only when this side's own price says the
   * same; when it has no recent price or says otherwise, nothing is sent and the note says why (never a flipped kind).
   * Returns the order's cid when one was sent.
   */
  function placeChecked(side, kind, price) {
    sentCid = '';
    if (!ready()) return '';
    const R = root(), last = lastPrice();
    /* 1.16.0: a stop-limit or an MIT (an entry-type modifier held, orderTypes on) is checked by the side of the market it
       rests on, as a limit (MIT) or a stop (stop-limit) */
    const typed = OS && (kind === 'stopLimit' || kind === 'mit');
    if (kind !== 'limit' && kind !== 'stop' && !typed) { flash('No price on that chart yet: nothing was sent. Market orders and Flatten work.', 'warn'); return ''; }
    if (!(last > 0)) { flash('Not sent: the order ticket has no recent ' + R + ' price to check the click against. Click again in a moment.', 'warn'); return ''; }
    const mine = OT.placeKind(side, price, last), want = typed ? OS.baseKind(kind) : kind;
    if (typed && kind === 'mit' && Math.abs(price - last) < 1e-9) { flash('Not sent: at the last price an MIT would trigger at once. Use ' + (side === 'sell' ? 'Sell' : 'Buy') + ' MKT.', 'warn'); return ''; }
    if (mine !== want) { flash('Not sent: the chart and the order ticket see ' + R + ' differently (the chart: ' + side.toUpperCase() + ' ' + (typed ? OS.KIND_TEXT[kind] : kind === 'limit' ? 'LMT' : 'STP') + ', the ticket: ' + (typed ? OS.KIND_TEXT[OS.kindFor(mine, kind === 'stopLimit' ? 'limit' : 'stop')] : mine === 'limit' ? 'LMT' : 'STP') + ' by ' + fmt(last) + '). Click again.', 'warn'); return ''; }
    sendOrder(side, kind, price, () => placeChecked(side, kind, price));
    return sentCid;
  }

  /*
   * B/E (1.10.0, Anthony): one change per working ChartBridge stop leg of this account and instrument, to the average
   * price on the tick grid, rounded toward safety (OT.breakEvenPrice). Only when the last price is past it on the
   * profitable side (ChartBridge would refuse a stop through the market). Stops placed in NinjaTrader are never touched;
   * a leg already at break-even or past it is left (moving it would loosen it). Needs Armed, like every order action.
   * Paced (Anthony 2026-10-01): as many changes go at once as ChartBridge's 10 a second allows (counting the order
   * actions of the last 1.1 s), the rest as soon as it allows, so one click always finishes. Before each later chunk
   * the page must still be Armed, connected and signed in, and the last price still past break-even, else the rest is
   * not sent; a leg no longer a working ChartBridge stop behind break-even (or in a Cancel all) is skipped. A note
   * says what happened. A click while a run is under way sends nothing.
   */
  let beRun = null;                                                // { account, root, be, qty, queue: [id], sent, skipped, notes }
  function breakEven() {
    if (!ready()) return;
    if (beRun) { flash('B/E under way on ' + beRun.account + ' ' + beRun.root + ': ' + beRun.queue.length + ' left. Nothing new was sent.', 'warn'); return; }
    const account = TR.account, R = root(), pos = TR.positions.get(account + '|' + R);
    if (!pos || !pos.qty) { flash('B/E: no open position on ' + account + ' ' + R + '. Nothing was sent.', 'warn'); env.changed(); return; }
    const be = OT.breakEvenPrice(pos.avgPrice, pos.qty, tickOf(R));
    if (be === null) { flash('B/E: the position has no average price yet. Nothing was sent.', 'warn'); return; }
    const last = lastPrice();
    if (!(last > 0)) { flash('No price yet: nothing was sent.', 'warn'); return; }
    if (!OT.breakEvenAllowed(pos.qty, be, last)) { flash('Price is not past break-even yet; the stop stays.', 'warn'); return; }
    const legs = OT.breakEvenLegs([...TR.orders.values()], account, R, pos.qty, be);
    const ids = legs.ids.filter(id => !inCancelAll(id)), inCancel = legs.ids.length - ids.length;
    const plural = (n, w) => n + ' ' + w + (n > 1 ? 's' : '');
    const notes = (legs.done ? ' ' + plural(legs.done, 'stop') + ' already at break-even or past it left as ' + (legs.done > 1 ? 'they are' : 'it is') + '.' : '') +
      (inCancel ? ' ' + plural(inCancel, 'stop') + ' in the Cancel all under way left.' : '') +
      (legs.other ? ' ' + plural(legs.other, 'stop') + ' placed in NinjaTrader left alone.' : '');
    if (!ids.length) { flash('B/E: no ChartBridge stop to move; nothing was sent.' + notes, 'warn'); env.changed(); return; }
    const t = now(), recent = actionTimes.filter(x => x > t - CANCEL_GAP).length;
    if (!sameAction('be|' + account + '|' + R + '|' + be, t)) { flash('Ignored a repeat click within 0.4 s.', 'warn'); return; }
    const chunks = OT.paceChunks(ids, recent, BE_LIMIT), first = chunks[0];
    for (const id of first) send({ type: 'change', id, price: be });
    const left = ids.length - first.length;
    flash('Moving ' + plural(ids.length, 'stop') + ' to break-even ' + fmt(be) + ' · ' + account + '.' +
      (left ? ' ' + first.length + ' now, ' + left + ' as ChartBridge\'s 10 a second allows.' : '') + notes, '');
    if (!left) return;
    beRun = { account, root: R, be, qty: pos.qty, queue: ids.slice(first.length), sent: first.length, skipped: 0, notes };
    bePump();
  }
  /* The rest of a paced B/E: each later chunk once the budget allows, re-checked before it goes (see breakEven). */
  function bePump() {
    const r = beRun;
    if (!r) return;
    const t = now(), recent = actionTimes.filter(x => x > t - CANCEL_GAP).length;
    const room = OT.paceChunks(r.queue, recent, BE_LIMIT)[0].length;
    if (room) {
      const why = FRAMED || !TR.enabled ? 'trading went off' : !open() ? 'the connection to ChartBridge dropped' :
        !TR.armed ? 'Armed went off' : root() !== r.root ? 'the instrument changed' : !OT.breakEvenAllowed(r.qty, r.be, lastPrice()) ? 'the last price is no longer past break-even' : '';
      if (why) { beDone(r.queue.length + ' not sent: ' + why + '.'); return; }
      let n = 0;
      while (r.queue.length && n < room) {
        const id = r.queue.shift(), o = TR.orders.get(id);
        const behind = o && OT.isWorking(o) && o.role === 'stop' && typeof o.price === 'number' && (r.qty > 0 ? o.price < r.be : o.price > r.be);
        if (!behind || inCancelAll(id)) { r.skipped++; continue; }
        send({ type: 'change', id, price: r.be }); r.sent++; n++;
      }
    }
    if (!r.queue.length) { beDone(''); return; }
    const oldest = actionTimes.find(x => x > t - CANCEL_GAP);
    later(() => { if (beRun === r) bePump(); }, Math.max(20, (oldest === undefined ? t : oldest) + CANCEL_GAP - t));
  }
  function beDone(notSent) {
    const r = beRun;
    beRun = null;
    const skipped = r.skipped ? ' ' + r.skipped + ' skipped: no longer a working stop behind break-even.' : '';
    flash('B/E: ' + r.sent + ' change' + (r.sent === 1 ? '' : 's') + ' sent to break-even ' + fmt(r.be) + ' · ' + r.account + ' ' + r.root + '.' +
      skipped + (notSent ? ' ' + notSent : '') + r.notes, skipped || notSent ? 'warn' : '');
  }

  /** The working orders of one account and instrument (the chart's lines). */
  function working(account, r) { return [...TR.orders.values()].filter(o => o.account === account && o.root === r && OT.isWorking(o)); }

  /*
   * Cancel all (review 2 S1, S2, N1; review 3 S1, S4, N1): one cancel per order id (a bracket leg takes its pair), sent
   * while fewer than 6 order actions of any kind (orders, changes, cancels, Flatten) went out in the last 1.1 s:
   * ChartBridge refuses more than 10 a second, and this leaves Anthony 4 for his own clicks (Flatten above all). The
   * ids are the working orders of the account and instrument shown at Anthony's click, after ready(). From then on
   * the rest go out by id whatever Armed, the picker or the instrument show: Anthony asked for those cancels, a cancel
   * only takes an order away, and each goes to that order's own account. Nothing is locked while they go out: Armed,
   * the picker, the instrument and Flatten all work. Each click is its own queue and the newest click goes first, so a
   * Cancel all on the account shown never waits behind an earlier one on another account (review 3 S1). The state
   * row says "Cancelling on EVAL-1 MNQ: 12 left" until the last one is sent, in the warning color while that account
   * or instrument is not the one shown. Each send skips an id that is no longer working (filled, cancelled, or taken
   * by Flatten). A Cancel all adds only the ids not queued and not cancelled in the last 5 s (a second click sends
   * nothing new); a cancel ChartBridge refused can be sent again at once (review 3 N1). It stops only for what
   * ChartBridge would refuse: the connection drops, trading goes off, or the account leaves ChartBridge's list. Then a
   * note that stays until Anthony dismisses it, or until those orders are no longer working, names the account, the
   * instrument and how many cancels were not sent.
   */
  let batch = null;                                                // { groups: [{ account, root, queue: [id] }] (oldest click first), timer }
  const unsent = new Map();                                        // id -> { account, root, why }: for the note
  let flattenMiss = '';                                            // a refused Flatten that was not sent again: for the note
  const actionTimes = [];                                          // when the last order actions went out (any kind)
  function actionSent() { actionTimes.push(now()); if (actionTimes.length > 64) actionTimes.shift(); }
  const cancelSent = new Map();                                    // id -> when its cancel went out (a second click sends it again only after 5 s)
  const inCancelAll = id => batchItems().some(e => e.id === id) || (cancelSent.has(id) && now() - cancelSent.get(id) < CANCEL_AGAIN);
  const batchItems = () => batch ? batch.groups.flatMap(g => g.queue.map(id => ({ id, account: g.account, root: g.root }))) : [];
  function cancelAll() {
    if (!ready()) return;
    const account = TR.account, R = root(), pos = TR.positions.get(account + '|' + R), t = now();
    const ids = OT.cancelAllIds([...TR.orders.values()], account, R, pos ? pos.qty : 0);
    const keptNote = ids.kept ? ' Kept ' + ids.kept + ' order' + (ids.kept > 1 ? 's' : '') + ' protecting the open position (cancel those one by one, or Flatten).' : '';
    if (!ids.length) { flash('Nothing to cancel on ' + account + ' ' + R + '.' + keptNote, ''); return; }
    for (const [id, at] of cancelSent) if (at < t - CANCEL_AGAIN) cancelSent.delete(id);
    const queued = new Set(batchItems().map(e => e.id));
    const fresh = ids.filter(id => !queued.has(id) && !cancelSent.has(id));
    const left = ids.filter(id => queued.has(id)).length;
    if (!fresh.length) { flash((left ? 'Still cancelling on ' + account + ' ' + R + ': ' + left + ' left.' : 'Those cancels went out a moment ago.') + ' Nothing new to send.' + keptNote, 'warn'); return; }
    const running = !!batch;
    if (!batch) batch = { groups: [], timer: false };
    batch.groups.push({ account, root: R, queue: fresh });         // the newest click goes first (cancelPump)
    flash((running ? 'Added ' + fresh.length + ' to the cancels under way, first in line, on ' : 'Cancelling ' + fresh.length + ' order' + (fresh.length > 1 ? 's' : '') + ' on ') + account + ' ' + R + '.' + keptNote, '');
    cancelPump();                                                  // as many as the pace allows now, the rest in turn
  }
  function cancelPump() {
    const b = batch;
    if (!b) return;
    const t = now();
    while (actionTimes.length && actionTimes[0] <= t - CANCEL_GAP) actionTimes.shift();
    for (;;) {
      while (b.groups.length && !b.groups[b.groups.length - 1].queue.length) b.groups.pop();
      if (!b.groups.length || actionTimes.length >= CANCEL_CHUNK) break;
      if (!open() || !TR.enabled) { batchStop(() => true, 'the connection to ChartBridge dropped'); return; }
      const id = b.groups[b.groups.length - 1].queue.shift();      // the newest click's first
      if (!TR.orders.has(id)) continue;                            // no longer working: nothing to send
      send({ type: 'cancel', id });                                // counted in actionTimes by send
      cancelSent.set(id, t);
    }
    if (!b.groups.length) batch = null;
    else if (!b.timer) { b.timer = true; later(() => { b.timer = false; if (batch === b) cancelPump(); }, Math.max(20, actionTimes[0] + CANCEL_GAP - t)); }
    env.batch();
  }
  /* Take cancels out of the batch. With `why`, those still working go to the note (not sent); without it (Flatten,
     the x) they are taken care of another way. */
  function batchStop(match, why) {
    if (!batch) return;
    let out = 0;
    for (const g of batch.groups) {
      const keep = [];
      for (const id of g.queue) {
        const e = { id, account: g.account, root: g.root };
        if (!match(e)) { keep.push(id); continue; }
        out++;
        if (why && TR.orders.has(id)) unsent.set(id, { account: g.account, root: g.root, why });
      }
      g.queue = keep;
    }
    if (!out) return;
    if (why) env.unsent();
    batch.groups = batch.groups.filter(g => g.queue.length);
    if (!batch.groups.length) batch = null;
    env.batch();
  }
  const countBy = (list, key) => { const g = new Map(); for (const e of list) { const k = key(e); g.set(k, (g.get(k) || 0) + 1); } return g; };
  /* The batch line in the state row: in the warning color while cancels go out for an account or instrument that is
     not the one shown (review 3 S2). */
  function batchLine(shownRoot) {
    const items = batchItems(), g = countBy(items.slice().reverse(), e => e.account + ' ' + e.root);
    const text = g.size ? 'Cancelling on ' + [...g].map(([k, n]) => k + ': ' + n + ' left').join(', ') + ' (6 a second).' : '';
    return { text, away: items.some(e => e.account !== TR.account || e.root !== shownRoot) };
  }
  /* The note for cancels (or a Flatten) that were not sent: it stays until dismissed, or until those orders are no
     longer working. */
  function unsentNote() {
    const g = countBy(unsent.values(), e => e.account + ' ' + e.root + '|' + e.why);
    const text = [flattenMiss].concat(!g.size ? [] : [...g].map(([k, n]) => {
      const [where, why] = k.split('|');
      return n + ' cancel' + (n > 1 ? 's' : '') + ' on ' + where + (n > 1 ? ' were' : ' was') + ' not sent: ' + why + '.';
    }).concat('Those orders may still be working. Check them, then Cancel all again on that account and instrument (or in NinjaTrader).')).filter(Boolean).join('\n');
    return { show: !!g.size || !!flattenMiss, text };
  }
  function dismissUnsent() { unsent.clear(); flattenMiss = ''; env.unsent(); }
  /* After a full orders list: an unsent cancel whose order is no longer working needs no note. The orders of an account
     ChartBridge no longer allows are not in that list, so those stay. */
  function unsentCheck() {
    let changed = false;
    for (const [id, e] of unsent) if (TR.accounts.includes(e.account) && !TR.orders.has(id)) { unsent.delete(id); changed = true; }
    if (changed) env.unsent();
  }
  /*
   * Flatten is never blocked (review 3 S4). It goes out at once, and takes its account and instrument off a Cancel all
   * under way (ChartBridge's Flatten cancels those itself, so no "No working order" follows). If ChartBridge refuses it
   * for the rate (more than 10 order actions a second), it is sent once more 1.1 s later; otherwise the note says it was
   * not sent. A second Flatten finds the account flat, so sending it twice is harmless.
   *   - The Flatten button and Close ('here'): sent again while the same account and instrument are still shown and
   *     trading is on (1.11.0).
   *   - Flatten all, the window's Flatten all and a Close for another instrument ('all'): every root is kept, not only
   *     the last one (1.12.0, the 1.11.0 review), and each refused one is sent again while trading is on and the account
   *     is still a trade account.
   * A refusal for the rate carries no order id (a flatten has none), so the refusals are matched to the newest Flattens
   * sent in the last 3 s not matched yet (ChartBridge refuses the ones past its 10 a second, the latest). Refusals that
   * come within the 1.1 s wait join that one retry.
   */
  let flattens = [];                                               // { account, root, at, again, kind, hit }: sent in the last 3 s
  let retry = null;                                                // { list: [flatten] } waiting its 1.1 s
  function sendFlatten(account, R, again, kind) {
    send({ type: 'flatten', account, root: R });
    batchStop(e => e.account === account && e.root === R);
    const t = now();
    flattens = flattens.filter(f => t - f.at <= FLATTEN_KEEP);
    flattens.push({ account, root: R, at: t, again: !!again, kind: kind || 'here', hit: false });
  }
  /* A refusal from ChartBridge. Returns true when handled here (a Flatten or a Cancel all's cancel sent again), else the
     page shows it. */
  const requeued = new Set();                                      // batch cancels already sent again once after a rate refusal
  function onRefused(m) {
    const wasBatch = typeof m.id === 'string' && cancelSent.has(m.id);
    if (typeof m.id === 'string') cancelSent.delete(m.id);         // a refused cancel can go again at once (review 3 N1)
    /* A Cancel all's cancel refused for the rate (the page keeps 6 in 1.1 s, but a busy PC can deliver two of its
       seconds close together): it goes again once, first in line, at the pace. */
    const o = wasBatch && TR.orders.get(m.id);
    if (o && RATE_REFUSAL.test(m.reason || '') && !requeued.has(m.id)) {
      requeued.add(m.id);
      if (!batch) batch = { groups: [], timer: false };
      batch.groups.push({ account: o.account, root: o.root, queue: [m.id] });
      flash('ChartBridge refused a cancel for the rate (more than 10 order actions a second): it goes again in turn.', 'warn');
      cancelPump();
      return true;
    }
    if (m.id || m.cid || !RATE_REFUSAL.test(m.reason || '')) return false;
    const t = now();
    let f = null;
    for (let i = flattens.length - 1; i >= 0; i--) { const x = flattens[i]; if (!x.hit && !x.again && t - x.at <= FLATTEN_KEEP) { f = x; break; } }
    if (!f) return false;                                          // a Flatten sent again and refused again: shown as ChartBridge said
    f.hit = true;
    if (!retry) { retry = { list: [] }; later(flattenAgain, CANCEL_GAP); }
    retry.list.push(f);
    const where = retryWhere(retry.list);
    flash('ChartBridge refused Flatten for ' + where + ' (more than 10 order actions a second): sending ' + (retry.list.length > 1 ? 'them' : 'it') + ' again in 1 s.', 'warn');
    return true;
  }
  /* "Sim101 MNQ", or "Sim101 MNQ, NQ" (one account, in the order sent), or "Sim101 MNQ, EVAL-1 ES" */
  function retryWhere(list) {
    const accts = [...new Set(list.map(f => f.account))];
    return accts.map(a => a + ' ' + list.filter(f => f.account === a).map(f => f.root).join(', ')).join(', ');
  }
  function flattenAgain() {
    const r = retry;
    retry = null;
    if (!r) return;
    const on = open() && TR.enabled, sentAgain = [], missed = [];
    for (const f of r.list) {
      const ok = on && (f.kind === 'here' ? TR.account === f.account && root() === f.root : TR.accounts.includes(f.account));
      if (ok) { sendFlatten(f.account, f.root, true, f.kind); sentAgain.push(f); } else missed.push(f);
    }
    if (sentAgain.length) flash('Flatten sent again for ' + retryWhere(sentAgain) + '.', 'warn');
    if (missed.length) {
      const one = missed.length === 1, why = !on ? 'trading went off.' : one && missed[0].kind === 'here' ? 'the account or instrument shown changed.'
        : missed.every(f => f.kind === 'here') ? 'the account or instrument shown changed.' : 'the account is no longer a trade account in ChartBridge.';
      flattenMiss = 'Flatten for ' + retryWhere(missed) + (one ? ' was' : ' were') + ' refused by ChartBridge (more than 10 order actions a second) and not sent again: ' +
        why + (one ? ' The position may still be open.' : ' Those positions may still be open.') + ' Flatten again.';
      env.unsent();
    }
  }

  /* The Flatten button, and the Close hotkey (1.11.0): this account and instrument. Works while disarmed (Anthony
     2026-10-01: Flatten is never blocked); every other check of ready() stays. `other`: a Close for another instrument
     than the one shown (the ticket's "Also open" line). */
  /* An open NO STOP question never holds up Close or Flatten all (F2 review): they act at once and the question goes,
     its order not sent. */
  /* every other window drops its question too (the workspace passes it on): r, or every instrument for null */
  const flattened = r => { if (typeof env.flattened === 'function') env.flattened(r); };
  function flattenHere(other) {
    try { dropNoStop(); flattened(other || root()); } catch (e) { /* never in the way of the flatten */ }
    if (!ready(false)) return;
    const R = other || root();
    if (!sameAction(other ? 'flatten|' + other : 'flatten', now())) return;
    sendFlatten(TR.account, R, false, other ? 'all' : 'here');     // takes its orders off a Cancel all; sent again once if refused for the rate
    flash('Flatten sent for ' + TR.account + ' ' + R + ': cancel its orders, close the position at market.', '');
  }
  /*
   * The Agent tab's "Flatten and turn him off?" Yes (chart 1.20.0, DECISION 2026-10-09 v): one Flatten (sendFlatten, as the
   * Flatten button) for the agent's own account and root, whatever account the ticket shows. Needs what Flatten needs but
   * Armed and the picker's account (the agent's account is not the ticket's): trading on, connected. ChartBridge checks the
   * account as for any Flatten, and lets it pass the agent's owner lock (an exit). true when it was sent.
   */
  function flattenAgent(account, R) {
    if (FRAMED) { flash(FRAMED_REASON, 'error'); return false; }
    if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return false; }
    if (!open()) { flash('Not connected to ChartBridge: nothing was sent.', 'error'); return false; }
    if (typeof account !== 'string' || !account || !ROOTS.includes(R)) { flash('Nothing was sent: the agent\'s account or instrument is not known.', 'error'); return false; }
    if (!sameAction('flatten|' + account + '|' + R, now())) return false;
    sendFlatten(account, R, false, 'agent');
    flash('Flatten sent for ' + account + ' ' + R + ' (the agent\'s): cancel its orders, close the position at market.', '');
    return true;
  }
  /*
   * Flatten all (1.11.0, the hotkey; Anthony 2026-10-01): one flatten (sendFlatten, as the Flatten button) per instrument
   * of the order account with a position or a working order, whatever instrument is shown. Needs what the Flatten
   * button needs: every check of ready() but Armed. Within ChartBridge's 10 order actions a second: what fits now goes at once, the rest as soon
   * as it allows (paced like B/E). Once pressed it finishes, like Cancel all: a later flatten goes to the account named
   * at the press while connected and trading is on and that account is still a trade account; otherwise the note says
   * which were not sent. A press while a run is under way sends nothing.
   */
  let faRun = null;                                                // { account, queue: [root], sent: [root] }
  function flattenAll() {
    try { dropNoStop(); flattened(null); } catch (e) { /* never in the way of the flatten */ }
    if (!ready(false)) return;
    const account = TR.account;
    if (faRun) { flash('Flatten all under way on ' + faRun.account + ': ' + faRun.queue.join(', ') + ' left. Nothing new was sent.', 'warn'); return; }
    const roots = OT.flattenAllRoots([...TR.orders.values()], TR.positions, account, served, ROOTS);
    if (!roots.length) { flash('Flatten all: no position or working order on ' + account + '. Nothing was sent.', ''); return; }
    const t = now();
    if (!sameAction('flattenAll|' + account, t)) return;
    const recent = actionTimes.filter(x => x > t - CANCEL_GAP).length;
    const first = OT.paceChunks(roots, recent, BE_LIMIT)[0];
    for (const r of first) sendFlatten(account, r, false, 'all');
    const rest = roots.slice(first.length);
    flash(first.length ? 'Flatten all sent for ' + account + ': ' + first.join(', ') + ' (cancel their orders, close their positions at market).' +
      (rest.length ? ' ' + rest.join(', ') + ' as ChartBridge\'s 10 a second allows.' : '')
      : 'Flatten all for ' + account + ': ' + rest.join(', ') + ' as ChartBridge\'s 10 a second allows.', '');
    if (!rest.length) return;
    faRun = { account, queue: rest, sent: first.slice() };
    faPump();
  }
  function faPump() {
    const r = faRun;
    if (!r) return;
    const t = now(), recent = actionTimes.filter(x => x > t - CANCEL_GAP).length;
    const room = OT.paceChunks(r.queue, recent, BE_LIMIT)[0].length;
    if (room) {
      const why = FRAMED || !TR.enabled ? 'trading went off' : !open() ? 'the connection to ChartBridge dropped' :
        !TR.accounts.includes(r.account) ? r.account + ' is no longer a trade account in ChartBridge' : '';
      if (why) {                                                   // a note that stays until dismissed, as for a Flatten not sent
        faRun = null;
        flattenMiss = 'Flatten all on ' + r.account + ': ' + (r.sent.length ? r.sent.join(', ') + ' sent; ' : '') + r.queue.join(', ') + ' not sent: ' + why + '. Those positions may still be open. Flatten again.';
        env.unsent(); flash(flattenMiss, 'error');
        return;
      }
      for (const R of r.queue.splice(0, room)) { sendFlatten(r.account, R, false, 'all'); r.sent.push(R); }
    }
    if (!r.queue.length) { faRun = null; flash('Flatten all sent for ' + r.account + ': ' + r.sent.join(', ') + ' (cancel their orders, close their positions at market).', ''); return; }
    const oldest = actionTimes.find(x => x > t - CANCEL_GAP);
    later(() => { if (faRun === r) faPump(); }, Math.max(20, (oldest === undefined ? t : oldest) + CANCEL_GAP - t));
  }

  /* Chart actions (only while Armed): drag an order's label to move it, its x to cancel it. */
  const notShown = id => { const o = TR.orders.get(id); if (o && o.account === TR.account) return false; flash(o ? 'Not sent: that order is not on ' + TR.account + '.' : 'Not sent: that order is no longer working.', o ? 'error' : 'warn'); env.changed(); return true; };
  function moveOrder(id, price) {
    if (!ready()) { env.changed(); return; }
    if (notShown(id)) return;
    /* An order in a Cancel all under way (queued, or its cancel just sent) is not moved: Cancel all wins and cancels
       it (Anthony 2026-09-30), and no change goes out that could cross its cancel. The line goes back. */
    if (inCancelAll(id)) { env.changed(); flash('Not moved: order ' + id + ' is in the Cancel all under way, which cancels it.', 'warn'); return; }
    send({ type: 'change', id, price });
    flash('Moving order ' + id + ' to ' + fmt(price), '');
  }
  function cancelOrder(id) {
    if (!ready()) return;
    if (notShown(id)) return;
    send({ type: 'cancel', id });
    batchStop(x => x.id === id);                                   // sent now, not again with a Cancel all under way
    flash('Cancelling order ' + id, '');
  }

  /*
   * Planned stop and target (ChartBridge 0.3.8, Anthony's ATM rule 2026-10-01): a resting entry's stop and target are
   * ticks from its fill. Dragging a planned line sends `plan` with the new distance (whole ticks, at least 1); its x
   * removes it (null); "+SL" / "+TP" on the entry adds it at the bracket's distance shown. The gates of a leg's drag:
   * ready() (trading on, Armed, connected, the account shown), the order on that account, not in a Cancel all.
   */
  function planTarget(entryId) {
    if (!ready()) { env.changed(); return null; }
    if (notShown(entryId)) return null;
    if (inCancelAll(entryId)) { env.changed(); flash('Not changed: order ' + entryId + ' is in the Cancel all under way, which cancels it.', 'warn'); return null; }
    const o = TR.orders.get(entryId);
    if (!o.planned) { env.changed(); flash('Not sent: order ' + entryId + ' has no planned stop and target (ChartBridge 0.3.8 or newer, a resting entry).', 'warn'); return null; }
    return o;
  }
  const whichKey = w => (w === 'stop' ? 'stopTicks' : 'targetTicks'), whichName = w => (w === 'stop' ? 'stop' : 'target');
  function sendPlan(o, which, ticks, said) {
    send({ type: 'plan', cid: newCid(), id: o.id, [whichKey(which)]: ticks });
    flash(said, '');
  }
  /* `from`: the entry price the chart drew the line from (a move of the entry may still wait for its answer), so the
     distance sent is the one the chart showed (F2 review) */
  function planMove(planId, price, from) {
    const p = OT.planIdOf(planId); if (!p) return;
    const o = planTarget(p.entry); if (!o) return;
    const r = OT.planDrag(o, p.which, price, tickOf(o.root), from);
    if (r.error) { env.changed(); flash(r.error, 'warn'); return; }
    if (r.ticks > cap()) { env.changed(); flash('Not sent: ' + r.ticks + ' ticks is more than ChartBridge takes (' + cap() + ').', 'warn'); return; }
    sendPlan(o, p.which, r.ticks, 'Planned ' + whichName(p.which) + ' of order ' + o.id + ': ' + r.ticks + ' ticks from the fill.');
  }
  function planRemove(planId) {
    const p = OT.planIdOf(planId); if (!p) return;
    const o = planTarget(p.entry); if (!o) return;
    sendPlan(o, p.which, null, 'Removing the planned ' + whichName(p.which) + ' of order ' + o.id + '.');
  }
  function planAdd(entryId, which) {
    if (which !== 'stop' && which !== 'target') return;
    const o = planTarget(entryId); if (!o) return;
    const t = OT.cleanBracket(brackets[o.root], cap())[which];
    if (!(t > 0)) { flash('Not sent: the bracket ' + whichName(which) + ' for ' + o.root + ' is 0. Set it in the bracket boxes, then click +' + (which === 'stop' ? 'SL' : 'TP') + ' again.', 'warn'); return; }
    sendPlan(o, which, t, 'Planned ' + whichName(which) + ' added to order ' + o.id + ': ' + t + ' ticks from the fill.');
  }
  /** What a chart of root r shows for one account: the working orders, each resting entry's planned lines (0.3.8), and on
      an entry what can be added ("+SL", "+TP"). */
  function chartOrders(account, r) {
    const out = [];
    for (const o of working(account, r)) {
      // 1.16.0: a strategy's entry has no planned lines to drag (ChartBridge refuses `plan` on it: cancel and place again)
      const pl = o.by === 'strategy' ? { lines: [], adds: [] } : OT.plannedLines(o, tickOf(r));
      out.push(pl.adds.length && o.planned ? Object.assign({}, o, { adds: pl.adds }) : o);
      for (const l of pl.lines) out.push(l);
    }
    return out;
  }

  /*
   * Merge (1.16.0, ChartBridge 0.4.0 with merge = on; PROTOCOL.md "Merge stops and targets"): the stops and targets of this
   * account's position on this instrument become one stop and one target set at the first leg's prices. ChartBridge does
   * the swap and decides every refusal (an entry working, the position changing, ...); the page sends one `merge` with
   * what B/E needs (Armed, connected, the account shown) and shows the result (`merge`: merged, restored or failed).
   */
  function merge() {
    if (!sw('merge')) { flash('Merge is off in ChartBridge (merge = off in config.txt). Nothing was sent.', 'warn'); return; }
    if (!ready()) return;
    const account = TR.account, R = root(), pos = TR.positions.get(account + '|' + R);
    if (!pos || !pos.qty) { flash('Merge: no open position on ' + account + ' ' + R + '. Nothing was sent.', 'warn'); return; }
    if (!sameAction('merge|' + account + '|' + R, now())) { flash('Ignored a repeat click within 0.4 s.', 'warn'); return; }
    TR.merges.delete(account + '|' + R);                           // the line shows this merge's answer when it comes
    send({ type: 'merge', cid: newCid(), account, root: R });
    flash('Merge sent for ' + account + ' ' + R + ': ChartBridge joins the stops and targets into one set at the first leg\'s prices.', '');
    env.changed();
  }
  /**
   * 1.16.0: ChartBridge's switches as the window's v3 connection read them (its `trading.switches`), or null when it has
   * none (an older ChartBridge, not signed in, dropped). They count only while this connection's trading is on.
   */
  function setSwitches(s) {
    v3sw = s && typeof s === 'object' ? Object.assign({}, s) : null;
    if (!OS) return;
    TR.switches = OS.cleanSwitches(TR.enabled ? v3sw : null);
    env.changed();
  }
  /**
   * 1.16.0: Cancel on the Account page's Working orders tab (cancelFromList on; PROTOCOL.md "Cancel from the Working orders
   * tab"): one order by its id, on any watched account, sent on this connection like every order action (the one order
   * path, counted in the 10 a second). ChartBridge checks it is an exit on a watched, Connected account (the OCO rule).
   * True when it went out.
   */
  function cancelFromList(id, cid) {
    if (!sw('cancelFromList') || typeof id !== 'string' || !id || typeof cid !== 'string' || !open()) return false;
    send({ type: 'cancel', cid, id, from: 'list' });
    return true;
  }
  /** 1.16.0: the v3 connection dropped: its managed states and Merge results go (ChartBridge sends them again) */
  function v3Lost() { TR.managed.clear(); TR.merges.clear(); setSwitches(null); }
  /** The managed strategies of one account and instrument (1.16.0), oldest entry first. */
  function managedOf(account, r) { return [...TR.managed.values()].filter(m => m.account === account && m.root === r); }

  function setArmed(on) {
    const v = !!on && TR.enabled && !(on && env.armBlocked && env.armBlocked());
    TR.armed = v;
    if (!v) { armGen++; dropNoStop(); }                    // Armed off: an open NO STOP question goes (F2 re-review)
    env.armed(v);
    env.changed();
  }
  /** The account picked in the picker while trading is on: the order account (Armed goes off, as before). */
  function pickAccount(a) {
    TR.account = a;
    if (TR.armed) { setArmed(false); flash('Armed turned off: the account changed.', 'warn'); }
  }

  /* ---------------- the bracket (1.10.0): ticks per root, the preset picked per root, the unit; saved one field at a time */
  /* typed bracket ticks are saved after a pause, each field on its own (a ratio changes the target with the stop) */
  const bracketSaved = { stop: LP.debounce(r => prefs.setBracketField(r, 'stop', brackets[r].stop), 350),
    target: LP.debounce(r => prefs.setBracketField(r, 'target', brackets[r].target), 350) };
  const fmtUnit = (ticks, r) => BK.unit === 'pt' ? String(Math.round(ticks * tickOf(r) * 1e6) / 1e6) : String(ticks);
  /* The preset picked for a root, as shown: a ratio or a saved preset only while the stop and target still match it. */
  function bracketSelShown(r) {
    const sel = BK.sel[r] || 'custom', br = brackets[r] || { stop: 0, target: 0 }, k = OT.ratioOf(sel);
    if (k !== null) return OT.ratioBracket(br.stop, k, cap()).target === br.target ? sel : 'custom';
    if (sel.startsWith('p:')) {
      const pr = BK.presets.find(x => x.name === sel.slice(2));
      return pr && pr.stop === br.stop && pr.target === br.target ? sel : 'custom';
    }
    return 'custom';
  }
  /* Bracket ticks per root: saved as typed (whole ticks 0 to 200, or points on the tick grid; anything else waits),
     and at once on Enter or leaving the box, where points round to the nearest tick. Each save writes one field. */
  const typedTicks = (text, r) => {
    const v = String(text).trim();
    if (BK.unit === 't') return /^\d+$/.test(v) && +v <= cap() ? +v : null;
    if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return null;
    const t = +v / tickOf(r), n = Math.round(t);
    return Math.abs(t - n) < 1e-6 && n <= cap() ? n : null;
  };
  const committedTicks = (text, r) => {
    const v = String(text).trim();
    if (BK.unit === 't' || v === '') return v;                     // cleanBracket rounds and caps, as before 1.10.0
    return Math.round(+v / tickOf(r));
  };
  /* Set one field for root r. A ratio picked keeps the target linked to the stop; typing the target, or the stop of a
     saved preset, makes it Custom. `now`: save at once (a commit), else after a pause (typing). */
  function setBracket(r, k, ticks, saveNow) {
    const sel = bracketSelShown(r), ratio = OT.ratioOf(sel);
    brackets[r] = OT.cleanBracket(Object.assign({}, brackets[r], { [k]: ticks }), cap());
    const fields = [k];
    if (k === 'stop' && ratio !== null) {
      const linked = OT.ratioBracket(brackets[r].stop, ratio, cap());
      if (Math.round(brackets[r].stop * ratio) > cap()) flash('Target capped at ' + cap() + ' ticks, the most ChartBridge takes.', 'warn');
      brackets[r].target = linked.target; fields.push('target');
    } else if (sel !== 'custom') { BK.sel[r] = 'custom'; prefs.setBracketSel(r, 'custom'); }
    for (const f of fields) {
      if (saveNow) { bracketSaved[f].cancel(); prefs.setBracketField(r, f, brackets[r][f]); }
      else bracketSaved[f](r);
    }
  }
  function setUnit(u) { BK.unit = u === 'pt' ? 'pt' : 't'; prefs.setBracketUnit(BK.unit); }
  function setQty(r, v) { if (Number.isInteger(v) && v >= 1 && v <= OT.QTY_CHOICES) { qtys[r] = v; prefs.setQty(r, v); } }
  /* The preset select: a ratio sets the target from the stop; a saved preset sets both; Delete removes the saved preset
     shown. ('save' is the host's: it asks for a name, then savePreset.) */
  const readPresets = () => { BK.presets = OT.cleanBracketPresets(prefs.raw.get(LP.KEYS.bracketPresets), OT.NO_CAP); };
  const pickSel = (r, v) => { BK.sel[r] = v; prefs.setBracketSel(r, v); };
  function pickPreset(r, v) {
    const shown = bracketSelShown(r);
    readPresets();
    if (v === 'delete') {
      const name = shown.startsWith('p:') ? shown.slice(2) : '';
      const next = BK.presets.filter(x => x.name !== name);
      if (name && prefs.raw.set(LP.KEYS.bracketPresets, next)) { BK.presets = next; flash('Deleted bracket preset ' + name + '. The stop and target stay as they are.', ''); }
      pickSel(r, 'custom');
    } else if (v.startsWith('p:')) {
      const pr = BK.presets.find(x => x.name === v.slice(2));
      if (!pr) { flash('That bracket preset is gone (deleted in another window).', 'warn'); pickSel(r, 'custom'); }
      else {
        brackets[r] = OT.cleanBracket(pr, cap());
        for (const f of ['stop', 'target']) { bracketSaved[f].cancel(); prefs.setBracketField(r, f, brackets[r][f]); }
        pickSel(r, v);
      }
    } else if (OT.ratioOf(v) !== null) {
      const k = OT.ratioOf(v);
      if (Math.round(brackets[r].stop * k) > cap()) flash('Target capped at ' + cap() + ' ticks, the most ChartBridge takes.', 'warn');
      brackets[r] = OT.ratioBracket(brackets[r].stop, k, cap());          // the target follows the stop
      for (const f of ['stop', 'target']) { bracketSaved[f].cancel(); prefs.setBracketField(r, f, brackets[r][f]); }
      pickSel(r, v);
    } else pickSel(r, 'custom');
  }
  /** Save the stop and target shown under a name (the default "12/24t"); false when not saved. */
  function savePreset(r, typed) {
    const br = brackets[r], name = OT.bracketPresetName(typed) || OT.defaultPresetName(br.stop, br.target);
    readPresets();
    const list = BK.presets.slice(), same = list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
    if (same < 0 && list.length >= OT.BRACKET_PRESET_MAX) { flash('Not saved: ' + OT.BRACKET_PRESET_MAX + ' bracket presets is the most. Delete one first.', 'warn'); return false; }
    const pr = { name, stop: br.stop, target: br.target };
    if (same >= 0) list[same] = pr; else list.push(pr);
    if (!prefs.raw.set(LP.KEYS.bracketPresets, list)) { flash('Not saved: this browser blocks site storage.', 'error'); return false; }
    BK.presets = OT.cleanBracketPresets(list, OT.NO_CAP);
    pickSel(r, 'p:' + name);
    flash((same >= 0 ? 'Replaced' : 'Saved') + ' bracket preset ' + name + ': ' + br.stop + ' / ' + br.target + ' ticks.', '');
    return true;
  }
  /** Anything typed but not yet saved, saved now (page closing), or dropped (destroy). */
  const flushBrackets = () => { bracketSaved.stop.flush(); bracketSaved.target.flush(); };
  const cancelBrackets = () => { bracketSaved.stop.cancel(); bracketSaved.target.cancel(); };

  return {
    TR, brackets, qtys, BK, cap, framed: FRAMED, allowNoStop, noStopAsked: () => !noStopOk,
    planMove, planRemove, planAdd, chartOrders, framedReason: FRAMED_REASON, tradeMode,
    hello, message, lost, signIn, applyTrading,
    ready, sendOrder, placeAt, placeChecked, lastCid: () => sentCid, breakEven, cancelAll, flattenHere, flattenAgent, flattenAll, moveOrder, cancelOrder, setArmed, pickAccount,
    merge, managedOf, switchOn: sw, setSwitches, v3Lost, cancelFromList,
    working, inCancelAll, batchLine, unsentNote, dismissUnsent,
    fmtUnit, bracketSelShown, typedTicks, committedTicks, setBracket, setUnit, setQty, pickPreset, savePreset, readPresets, flushBrackets, cancelBrackets,
    /** for tests (test/order-account.test.js): the inner steps, run on their own */
    _t: { batchStop, unsentCheck, actionSent, sendFlatten, onRefused, get batch() { return batch; } },
    /** for tests: the order actions sent in the last 1.1 s, and whether a B/E, Flatten all or Flatten retry is under way */
    busy: () => ({ be: !!beRun, flattenAll: !!faRun, retry: retry ? retry.list.map(f => f.account + ' ' + f.root) : [], recent: actionTimes.filter(x => x > now() - CANCEL_GAP).length }),
  };
}

/*
 * The order ticket's controls wired to a core (the workspace's ticket; the single chart page's bar shared it until 1.21.0). `$(id)`
 * finds a control by its 1.11.0 id (obar, armBtn, armText, oAcct, oQty, oQtyCap, buyMkt, sellMkt, bPreset, bSaveBox,
 * bSaveName, bSaveOk, bSaveNo, bStop, bTarget, bUnit, flattenBtn, beBtn, cancelAllBtn, oPos, oLegs, oOther, oAcctNote,
 * oCancel, oOff, unsentBar, unsentText, unsentClose). A control marked data-keep stays on while trading is off.
 * ui: root() the instrument shown; flash(text, level); render() the host's whole order render (it calls bar.render);
 * listen(target, type, fn) (removed on destroy); pickViewAccount(a) (a pick while trading is off); accountPicked(a) (a
 * pick while trading is on, after the core took it); clearAccountNote(); lastPrice(); pointValue(root); precision();
 * U (ChartEngine.util); ticket (true: every pick and button hands the focus back, the ticket's rule).
 */
function wire($, core, ui) {
  const { TR, BK, brackets, qtys } = core;
  const flash = (t, l) => ui.flash(t, l);
  const U = ui.U;
  /* 1.11.0 (Anthony 2026-10-01): after a pick in an order bar select, or Enter in a bracket box, the focus leaves it,
     so the hotkeys work at once (they never fire while a box or select has the focus). */
  const handBack = el => { if (el && document.activeElement === el) el.blur(); };

  $('armBtn').addEventListener('click', e => {
    if (ui.ticket) handBack(e.currentTarget);
    if (core.framed) { flash(core.framedReason, 'error'); return; }
    if (!TR.enabled) { flash(TR.reason || 'Trading is not enabled.', 'error'); return; }
    const blocked = !TR.armed && ui.armBlocked ? ui.armBlocked() : '';
    if (blocked) { flash(blocked, 'warn'); return; }
    core.setArmed(!TR.armed);
    if (TR.armed) ui.clearAccountNote();                            // it said "Armed is off" (review S2)
    flash(TR.armed ? 'Armed: one click places an order on ' + TR.account + ', with no confirmation.' : 'Armed off.', TR.armed ? 'warn' : '');
  });
  $('oAcct').addEventListener('change', e => {
    handBack(e.target);
    if (!core.tradeMode()) { ui.pickViewAccount(e.target.value); return; }   // trading off: it only picks whose fills are marked
    core.pickAccount(e.target.value);
    ui.clearAccountNote();
    ui.render();
    ui.accountPicked(TR.account);
  });
  $('oQty').addEventListener('change', () => {
    handBack($('oQty'));
    core.setQty(ui.root(), +$('oQty').value);
    ui.render();
  });
  /* Order buttons act on a real mouse or touch click only: a key press (Enter or Space on a focused button,
     e.detail 0) never sends an order, and the button gives up focus after a click. */
  const pointerOnly = fn => e => { e.currentTarget.blur(); if (e.detail === 0) { flash('Order buttons work by click only, not by keyboard.', 'warn'); return; } fn(e); };
  $('buyMkt').addEventListener('click', pointerOnly(() => core.sendOrder('buy', 'market', null)));
  $('sellMkt').addEventListener('click', pointerOnly(() => core.sendOrder('sell', 'market', null)));
  for (const [id, k] of [['bStop', 'stop'], ['bTarget', 'target']]) {
    $(id).addEventListener('input', e => {
      const n = core.typedTicks(e.target.value, ui.root());
      if (n === null) return;
      core.setBracket(ui.root(), k, n, false);
      renderBracket(ui.root());
    });
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });   // commits (change), focus back
    $(id).addEventListener('change', e => {
      const r = ui.root();
      core.setBracket(r, k, core.committedTicks(e.target.value, r), true);
      e.target.value = core.fmtUnit(brackets[r][k], r);
      renderBracket(r);
      if (ui.ticket) handBack(e.target);                           // a spinner's step commits too: the focus comes back
    });
  }
  $('bUnit').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) handBack(b);
    if (!b || b.dataset.v === BK.unit) return;
    for (const id of ['bStop', 'bTarget']) if (document.activeElement === $(id)) $(id).blur();   // commit what was typed, in the old unit
    core.setUnit(b.dataset.v);
    renderBracket(ui.root(), true);
  });
  /* The preset select: a ratio sets the target from the stop; a saved preset sets both; Save current... names the
     stop and target as they are; Delete removes the saved preset shown. */
  function closeSaveBox() { $('bSaveBox').hidden = true; $('bPreset').hidden = false; }
  $('bPreset').addEventListener('focus', () => { core.readPresets(); renderBracket(ui.root()); });
  $('bPreset').addEventListener('change', e => {
    const r = ui.root(), v = e.target.value;
    if (v === 'save') {
      core.readPresets();
      const br = brackets[r];
      $('bSaveName').value = OT.defaultPresetName(br.stop, br.target);
      $('bPreset').hidden = true; $('bSaveBox').hidden = false;
      $('bSaveName').focus(); $('bSaveName').select();
    } else core.pickPreset(r, v);
    if (v !== 'save') handBack(e.target);                          // Save current... moves the focus to the name box
    bpreKey = '';
    renderBracket(r, true);
  });
  function savePreset() {
    const r = ui.root();
    if (!core.savePreset(r, $('bSaveName').value)) return;
    closeSaveBox(); bpreKey = ''; renderBracket(r);
  }
  $('bSaveOk').addEventListener('click', savePreset);
  $('bSaveNo').addEventListener('click', e => { closeSaveBox(); renderBracket(ui.root()); if (ui.ticket) handBack(e.currentTarget); });
  $('bSaveName').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); savePreset(); if (ui.ticket) handBack(e.target); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSaveBox(); renderBracket(ui.root()); if (ui.ticket) handBack(e.target); }
  });
  /* another tab saved or deleted a preset, or picked one */
  ui.listen(window, 'storage', e => {
    if (e.key === ui.prefix + ui.LP.KEYS.bracketPresets) { core.readPresets(); renderBracket(ui.root()); }
  });
  $('flattenBtn').addEventListener('click', pointerOnly(() => core.flattenHere()));
  $('beBtn').addEventListener('click', pointerOnly(core.breakEven));
  $('cancelAllBtn').addEventListener('click', pointerOnly(core.cancelAll));
  $('unsentClose').addEventListener('click', () => core.dismissUnsent());

  /* ---------------- render: the bar's own part of the order state (the host adds the chart's lines) */
  function syncTradeAccounts() {
    const sel = $('oAcct');
    sel.replaceChildren(...TR.accounts.map(a => new Option(a, a)));
    sel.value = TR.account;
    sel.disabled = !TR.accounts.length;                            // enabled again after a trading-off spell with no accounts (review 2, S1); never locked by a Cancel all (review 2 S1)
  }
  function render() {
    const bar = $('obar'); bar.hidden = false;
    const on = TR.enabled, r = ui.root(), cap = OT.maxQtyFor(TR, r);
    for (const el of bar.querySelectorAll('button, input, select')) if (el !== $('oAcct') && !el.hasAttribute('data-keep')) el.disabled = !on;   // the account picker works with trading off too (it drives the fills); nothing is locked by a Cancel all (review 2 S1)
    renderQty(r, cap);
    for (const id of ['buyMkt', 'sellMkt', 'beBtn', 'cancelAllBtn']) $(id).classList.toggle('is-off', !TR.armed);   // dimmed while disarmed; a click says why (Flatten works disarmed, so it never dims: Anthony 2026-10-01)
    $('oOff').textContent = on ? '' : 'Trading off: ' + TR.reason;
    $('oOff').hidden = on;
    renderBracket(r);
    renderBreakEven(r, on);
    renderBatch();                                                 // its color follows the account and instrument shown
    renderPositionInfo();
  }
  /* Qty (1.10.0): a select 1 to 9; the choices over the root's cap are off, and the cap is shown beside it. The qty
     picked last for this root stays picked even over the cap, so a click says why it is not sent (checkQty). */
  function renderQty(r, cap) {
    const q = $('oQty'), opts = OT.qtyOptions(cap);
    for (const o of opts) q.options[o.n - 1].disabled = !o.ok;
    q.value = String(qtys[r] || 1);
    const capped = cap < OT.QTY_CHOICES;
    $('oQtyCap').textContent = capped ? 'max ' + cap : '';
    q.title = r + ' cap ' + cap + ' (maxQty in ChartBridge)' + (capped ? ': ' + (cap + 1) + ' and up are off' : '');
  }
  /* Bracket (1.10.0): the preset select, the stop and target boxes in ticks or points, and the unit toggle. */
  let bpreKey = '';
  function renderBracket(r, force) {                   // force: the boxes too while one has the focus (a preset or unit picked)
    const br = brackets[r] || { stop: 0, target: 0 }, pt = BK.unit === 'pt', tick = ui.tick(r);
    for (const [id, k, what] of [['bStop', 'stop', 'stop'], ['bTarget', 'target', 'target']]) {
      const el = $(id);
      el.step = pt ? String(tick) : '1'; el.max = pt ? String(core.cap() * tick) : String(core.cap());
      if (force || document.activeElement !== el) el.value = core.fmtUnit(br[k], r);
      el.setAttribute('aria-label', 'Bracket ' + what + ' for ' + r + ' in ' + (pt ? 'points' : 'ticks') + ', 0 for none');
      el.title = (what === 'stop' ? 'Stop' : 'Target') + ', ' + (pt ? 'points' : 'ticks') + ' from the fill (0 = none)' + (pt ? ': ' + br[k] + ' ticks' : '');
    }
    for (const b of $('bUnit').children) b.setAttribute('aria-pressed', String(b.dataset.v === BK.unit));
    const ns = $('bNoStop');                             // NO STOP (1.13.0, Anthony): the stop box is 0
    if (ns && ns.hidden !== (br.stop > 0)) ns.hidden = br.stop > 0;
    const shown = core.bracketSelShown(r), sel = $('bPreset');
    const key = BK.presets.map(x => x.name + '|' + x.stop + '|' + x.target).join(',') + '#' + (shown.startsWith('p:') ? shown : '') + '#' + BK.unit + tick;
    if (key !== bpreKey) {
      bpreKey = key;
      const opt = (v, text) => new Option(text, v);
      const list = [opt('custom', 'Custom')].concat(OT.BRACKET_RATIOS.map(x => opt(x.id, x.id)));
      if (BK.presets.length) {
        const g = document.createElement('optgroup'); g.label = 'Saved';
        for (const x of BK.presets) g.append(opt('p:' + x.name, x.name));
        list.push(g);
      }
      list.push(opt('save', 'Save current...'));
      if (shown.startsWith('p:')) list.push(opt('delete', 'Delete ' + shown.slice(2)));
      sel.replaceChildren(...list);
    }
    if (sel.value !== shown) sel.value = shown;
  }
  /* B/E (1.10.0): on only with a position on this account and instrument and a ChartBridge stop leg on its closing side. */
  function renderBreakEven(r, on) {
    const btn = $('beBtn'), pos = on ? TR.positions.get(TR.account + '|' + r) : null;
    const legs = pos && pos.qty ? OT.breakEvenLegs(TR.orders.values(), TR.account, r, pos.qty, null) : null;
    const ok = !!legs && legs.ids.length > 0;
    btn.disabled = !on || !ok;
    btn.title = ok ? 'Move the ChartBridge stop' + (legs.ids.length > 1 ? 's' : '') + ' of this position to break-even (the average price, rounded a tick toward safety)'
      : 'B/E needs an open position here with a ChartBridge stop working';
  }
  /* The batch line in the state row (core.batchLine). */
  function renderBatch() {
    const el = $('oCancel'), b = core.batchLine(ui.root());
    if (el.textContent !== b.text) { el.textContent = b.text; el.title = b.text; }
    el.classList.toggle('away', b.away);
  }
  function renderUnsent() {
    const n = core.unsentNote();
    $('unsentBar').hidden = !n.show;
    $('unsentText').textContent = n.text;
  }
  /* Position and other accounts in the bar (P&L refreshes with the status line). */
  let posKey = null;                                   // what the state row shows now: it is written only when that changes
  function renderPositionInfo() {
    const el = $('oPos'), other = $('oOther'), legsEl = $('oLegs');
    if (!TR.v2 || !TR.enabled) { if (posKey !== '') { posKey = ''; el.textContent = ''; other.textContent = ''; legsEl.textContent = ''; } return; }
    const r = ui.root(), pos = TR.positions.get(TR.account + '|' + r), dp = ui.precision();
    const last = pos && pos.qty ? ui.lastPrice() : null;
    const key = [r, TR.account, pos ? pos.qty + '@' + pos.avgPrice : '', last, dp, ui.pointValue(r), TR.orders.size, [...TR.orders.values()].map(o => o.id + o.state + o.qty + o.filled + o.price).join(), [...TR.positions].map(([k, v]) => k + v.qty).join()].join('|');
    if (key === posKey) return;
    posKey = key;
    /* The position (1.13.0, Anthony: a calm block in the house style): a LONG 4 / SHORT 2 tag in its side's color, the
       average price, and the open P&L, the dollars first and the most prominent; "Flat" when flat. Labels in the sans
       face, prices in tabular mono; the P&L keeps its place on the right, so nothing moves as the numbers change. */
    if (pos && pos.qty) {
      const pnl = U.openPnl(pos.qty, pos.avgPrice, last, ui.pointValue(r));
      const cls = pnl.points > 0 ? 'profit' : pnl.points < 0 ? 'loss' : '';
      const mk = (tag, c, t) => { const x = document.createElement(tag); x.className = c; x.textContent = t; return x; };
      const pl = mk('span', 'pz-pnl ' + cls, '');
      if (pnl.dollars !== null) pl.append(mk('b', '', U.fmtMoney(pnl.dollars)), mk('span', 'pz-pt', U.fmtSigned(pnl.points, dp) + ' pt'));
      else pl.append(mk('b', '', U.fmtSigned(pnl.points, dp) + ' pt'));
      el.replaceChildren(mk('span', 'pz-side ' + (pos.qty > 0 ? 'long' : 'short'), (pos.qty > 0 ? 'LONG ' : 'SHORT ') + Math.abs(pos.qty)),
        mk('span', 'pz-at', ' at ' + U.fmtPrice(pos.avgPrice, dp)), pl);
      el.className = 'oinfo pz';
    } else { el.textContent = 'Flat'; el.className = 'oinfo pz flat'; }
    /* stop and target cover, one quiet line (a filled-in-pieces entry has one pair per fill): "Stop 4/4 · Target 4/4",
       a gap in the warning color ("NO STOP on 1") */
    const legs = pos && pos.qty ? OT.legSummary(TR.orders.values(), TR.account, r, pos.qty) : null, pline = OT.protectionLine(legs);
    legsEl.textContent = pline.text;
    legsEl.classList.toggle('uncovered', !!legs && legs.level === 'error');
    legsEl.classList.toggle('over', !!legs && legs.level === 'warn');
    legsEl.title = legs ? legs.text + ' (' + legs.stopLegs + ' stop and ' + legs.targetLegs + ' target order' + (legs.stopLegs + legs.targetLegs === 1 ? '' : 's') + ' working)' +
      (legs.stopsShort ? '. Stops cover less than the position.' : legs.level === 'warn' ? '. More than the position: if it all fills, the position reverses.' : '') : '';
    /* Other accounts on this instrument, by name (review S3): a live trade on another account is never only a count.
       In the warning color while one has a position; on one line (cut short, the whole text in its tooltip). */
    const others = new Map(), of = a => others.get(a) || others.set(a, { pos: 0, n: 0 }).get(a);
    for (const [k, v] of TR.positions) { const a = k.slice(0, k.lastIndexOf('|')); if (v.qty && k.endsWith('|' + r) && a !== TR.account) of(a).pos = v.qty; }
    for (const o of TR.orders.values()) if (o.root === r && o.account !== TR.account && OT.isWorking(o)) of(o.account).n++;
    const parts = [...others].map(([a, x]) => a + ': ' + [x.pos ? (x.pos > 0 ? 'LONG ' : 'SHORT ') + Math.abs(x.pos) : '', x.n ? x.n + ' order' + (x.n > 1 ? 's' : '') : ''].filter(Boolean).join(', '));
    other.textContent = parts.length ? 'Other accounts on ' + r + ': ' + parts.join(' · ') : '';
    other.title = other.textContent;
    other.classList.toggle('live', [...others.values()].some(x => x.pos));
  }
  return { render, renderBatch, renderUnsent, renderPositionInfo, renderBracket, syncTradeAccounts, handBack };
}

return { create, wire, ORDER_ACTIONS, CANCEL_CHUNK, CANCEL_GAP, CANCEL_AGAIN, BE_LIMIT, FLATTEN_KEEP };
});
