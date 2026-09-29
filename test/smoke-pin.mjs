// Smoke helpers for ChartBridge 0.3.2's PIN on the standalone page (live/pin.js). The fake bridge takes a made-up
// test PIN with --test-pin; these type it on the pad the way Anthony would (the pad's keys), in a page or a frame.
export const TEST_PIN = '2468';                 // made-up, tests only

// Wait until the page shows the chart or the PIN pad; if the pad asks for the PIN, enter it and wait for the chart.
export async function unlockIfAsked(p, pin = TEST_PIN, ms = 20000) {
  await p.waitForFunction(() => document.getElementById('connPill') || document.querySelector('.cb-pin #cbPinKeys:not([hidden])'), null, { timeout: ms });
  if (await p.$('#connPill') && !(await p.$('.cb-pin'))) return false;
  const title = await p.textContent('#cbPinTitle');
  if (title !== 'Enter PIN') throw new Error('PIN pad shows "' + title + '", expected "Enter PIN"');
  await enterPin(p, pin);
  await p.waitForFunction(() => !document.querySelector('.cb-pin') && document.getElementById('connPill'), null, { timeout: ms });
  return true;
}
export async function enterPin(p, pin) { for (const d of pin) await p.click(`.cb-pin-key[data-k="${d}"]`); }
