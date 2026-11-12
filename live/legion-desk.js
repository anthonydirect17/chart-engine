/*
 * LegionDesk: Legion's trader desk (chart 1.49.0). The review of Praetorian (chart-engine 102, F5) found that once the Agent
 * and Bot desks are behind Praetorian's gate, everything they did for prop traders, groups and the bot on a prop account has
 * no home on the page. The coordinator's decision (reuse first): the SAME two desks, mounted a second time behind Praetorian's
 * gate turned round (AgentCore.legionLink): kill switch ON, a trader's Shadow and the acknowledgements for anyone; anything
 * else only for a trader on a prop account, a prop group or None, the bot on a prop account or None. No control is written
 * here: the desks are reused as they are (live/agent.js, live/bot.js), with options for a second copy on one page:
 *   - keys: false   the copilot keys never reach this copy (with Praetorian's tab shown they answer Praetorian's desk only;
 *                   under Legion the Accept key is off anyway, the page's hotkey rule);
 *   - floating: false   the bot's proposal card stays inside this desk, never floats over the page;
 *   - embedded: true    (the review of 103, a F-B1 and b F3) no Pop out and nothing of the page's own (its top bar, the Bot
 *                   tab's card, the corner line, the alert band); the desk counts as shown only while show(true) says so,
 *                   and a proposal is acknowledged (agentSeen, botSeen) only while its card is really on screen;
 *   - keyPrefix     (a F-B8) its own names for what it keeps in this browser, so a reload never mixes the two copies.
 *
 *   const d = LegionDesk.mount(el, { v3, feed, headers, storage, storagePrefix, flatten, side, shown });
 *   d.show(on)   the fold (or Legion's tab) opened or closed: call it every time; it starts closed unless shown: true;
 *   d.side('agent' | 'bot'); d.state(); d.destroy()   (destroy also takes the gate off the feed).
 *
 * v3: the window's v3 feed (AF in live/workspace.js): the desk is handed AgentCore.legionLink(v3), never the feed itself. With
 * no feed, or no AgentCore, the desks get no connection at all (the careful side). Builder 1 mounts it once, folded, in
 * Legion Setup (build answers 23); nothing else in Legion changes for it. Its tests: test/legion-desk.test.js and
 * test/legion-desk-smoke.mjs.
 */
(function () {
'use strict';
if (typeof window === 'undefined' || typeof document === 'undefined') return;
const SIDES = ['agent', 'bot'];
const KEY_PREFIX = 'legion-';   // the review of 103, a F-B8: 'legion-live-agent-chosen-v1' and the like, never Praetorian's

function mount(el, opts) {
  const o = opts || {};
  if (!el) return null;
  const AC = window.AgentCore || null;
  const link = AC && typeof AC.legionLink === 'function' && o.v3 ? AC.legionLink(o.v3, o.onHear) : null;
  el.classList.add('lgd');
  el.innerHTML =
    '<div class="lgd-head">' +
      '<span class="ws-seg lgd-seg" role="group" aria-label="Legion\'s trader desk">' +
        '<button type="button" data-side="agent" aria-pressed="true">Agents</button><button type="button" data-side="bot" aria-pressed="false">Bot</button>' +
      '</span>' +
      '<span class="lgd-note">Prop accounts and groups only. Your personal account and Sim are on Praetorian.</span>' +
    '</div>' +
    '<section class="ag-view lgd-agent" aria-label="Legion\'s agent desk"></section>' +
    '<section class="bt-view lgd-bot" aria-label="Legion\'s bot desk" hidden></section>';
  const agEl = el.querySelector('.lgd-agent'), btEl = el.querySelector('.lgd-bot');
  const common = { embedded: true, keyPrefix: KEY_PREFIX, keys: false, v3: link, headers: o.headers, feed: o.feed, storage: o.storage, storagePrefix: o.storagePrefix };
  const agent = window.AgentDesk ? window.AgentDesk.create(Object.assign({}, common, { flatten: o.flatten, els: { view: agEl } })) : null;
  const bot = window.BotDesk ? window.BotDesk.create(Object.assign({}, common, { floating: false, els: { view: btEl } })) : null;
  let current = SIDES.includes(o.side) ? o.side : 'agent', open = o.shown === true;
  /* each desk is shown only while the desk is open AND its side is the one picked */
  function sync() {
    if (agent && typeof agent.showTab === 'function') agent.showTab(open && current === 'agent');
    if (bot && typeof bot.showTab === 'function') bot.showTab(open && current === 'bot');
    for (const d of [agent, bot]) if (open && d && typeof d.seenCheck === 'function') d.seenCheck();   // on screen now: acknowledge what shows
  }
  function side(s) {
    if (!SIDES.includes(s)) return current;
    current = s;
    agEl.hidden = s !== 'agent'; btEl.hidden = s !== 'bot';
    for (const b of el.querySelectorAll('.lgd-seg [data-side]')) b.setAttribute('aria-pressed', String(b.dataset.side === s));
    sync();
    return current;
  }
  function show(on) { open = on === true; sync(); return open; }
  const onClick = e => { const b = e.target.closest('.lgd-seg [data-side]'); if (b) { b.blur(); side(b.dataset.side); } };
  el.addEventListener('click', onClick);
  side(current);
  return {
    link, agent, bot, side, show,
    state: () => ({ side: current, shown: open, linked: !!link, agent: agent ? agent.state() : null, bot: bot ? bot.state() : null }),
    destroy() {
      el.removeEventListener('click', onClick);
      try { if (bot && bot.destroy) bot.destroy(); } catch (e) { /* gone */ }
      try { if (agent && agent.destroy) agent.destroy(); } catch (e) { /* gone */ }
      try { if (link && typeof link.close === 'function') link.close(); } catch (e) { /* gone */ }   // the review of 103, b F7
    },
  };
}

window.LegionDesk = { mount };
})();
