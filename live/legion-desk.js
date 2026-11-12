/*
 * LegionDesk: Legion's trader desk (chart 1.49.0). The review of Praetorian (chart-engine 102, F5) found that once the Agent
 * and Bot desks are behind Praetorian's gate, everything they did for prop traders, groups and the bot on a prop account has
 * no home on the page. The coordinator's decision (reuse first): the SAME two desks, mounted a second time behind Praetorian's
 * gate turned round (AgentCore.legionLink): kill switch ON, a trader's Shadow and the acknowledgements for anyone; anything
 * else only for a trader on a prop account, a prop group or None, the bot on a prop account or None. No control is written
 * here: the desks are reused as they are (live/agent.js, live/bot.js), with two options for a second copy on one page:
 *   - keys: false   the copilot keys never reach this copy (with Praetorian's tab shown they answer Praetorian's desk only;
 *                   under Legion the Accept key is off anyway, the page's hotkey rule);
 *   - floating: false   the bot's proposal card stays inside this desk, never floats over the page.
 *
 *   const d = LegionDesk.mount(el, { v3, feed, headers, storage, storagePrefix, flatten, side });
 *   d.side('agent' | 'bot'); d.state(); d.destroy();
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
  const common = { popout: true, keys: false, v3: link, headers: o.headers, feed: o.feed, storage: o.storage, storagePrefix: o.storagePrefix };
  const agent = window.AgentDesk ? window.AgentDesk.create(Object.assign({}, common, { flatten: o.flatten, els: { view: agEl } })) : null;
  const bot = window.BotDesk ? window.BotDesk.create(Object.assign({}, common, { floating: false, els: { view: btEl } })) : null;
  let current = SIDES.includes(o.side) ? o.side : 'agent';
  function side(s) {
    if (!SIDES.includes(s)) return current;
    current = s;
    agEl.hidden = s !== 'agent'; btEl.hidden = s !== 'bot';
    for (const b of el.querySelectorAll('.lgd-seg [data-side]')) b.setAttribute('aria-pressed', String(b.dataset.side === s));
    return current;
  }
  const onClick = e => { const b = e.target.closest('.lgd-seg [data-side]'); if (b) { b.blur(); side(b.dataset.side); } };
  el.addEventListener('click', onClick);
  side(current);
  return {
    link, agent, bot, side,
    state: () => ({ side: current, linked: !!link, agent: agent ? agent.state() : null, bot: bot ? bot.state() : null }),
    destroy() { el.removeEventListener('click', onClick); try { if (bot && bot.destroy) bot.destroy(); } catch (e) { /* gone */ } try { if (agent && agent.destroy) agent.destroy(); } catch (e) { /* gone */ } },
  };
}

window.LegionDesk = { mount };
})();
