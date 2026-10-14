// Smoke helpers for ChartBridge 0.3.2's PIN on ChartBridge's own page (live/pin.js: the workspace; the single chart page
// until chart 1.22.0, and in an older checkout). The fake bridge takes a made-up
// test PIN with --test-pin; these type it on the pad the way Anthony would (the pad's keys), in a page or a frame.
export const TEST_PIN = '2468';                 // made-up, tests only

// Wait until the page is live (the workspace's #wsConn) or shows its chart (an older page's #connPill) or the PIN pad;
// if the pad asks for the PIN, enter it and wait for the page.
export async function unlockIfAsked(p, pin = TEST_PIN, ms = 20000) {
  // the workspace's #wsConn is in its HTML from the start, so only its LIVE state means no pad is coming
  await p.waitForFunction(() => (document.getElementById('wsConn') && document.getElementById('wsConn').classList.contains('live')) || document.getElementById('connPill') || document.querySelector('.cb-pin #cbPinKeys:not([hidden])'), null, { timeout: ms });
  if (!(await p.$('.cb-pin'))) return false;
  const title = await p.textContent('#cbPinTitle');
  if (title !== 'Enter PIN') throw new Error('PIN pad shows "' + title + '", expected "Enter PIN"');
  await enterPin(p, pin);
  await p.waitForFunction(() => !document.querySelector('.cb-pin') && (document.getElementById('wsConn') || document.getElementById('connPill')), null, { timeout: ms });
  return true;
}
export async function enterPin(p, pin) { for (const d of pin) await p.click(`.cb-pin-key[data-k="${d}"]`); }

// DECISION 2026-10-14e (chart 1.25.0): the order ticket starts on None (no Sim101 fallback). A smoke that trades from the ticket
// without picking an account first calls this once on its browser: every page then starts as if Anthony had picked Sim101 on
// this PC just now (live-account-v1 and its time live-account-at-v1), unless the page's storage already has a pick.
// test/orders-smoke.mjs drives None itself and never calls it.
export function ticketOnSim101(browser) {
  const add = async ctx => {
    await ctx.addInitScript(() => { try { if (localStorage.getItem('live-account-v1') === null) { localStorage.setItem('live-account-v1', JSON.stringify('Sim101')); localStorage.setItem('live-account-at-v1', String(Date.now())); } } catch (e) { /* no storage here (about:blank) */ } });
    return ctx;
  };
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async o => add(await newContext(o));
  browser.newPage = async o => (await add(await newContext(o))).newPage();
  return browser;
}
