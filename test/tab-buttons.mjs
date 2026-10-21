// Chart 1.35.0: the Bot tab left the top bar for a panel of its own in + Add panel (Anthony 2026-10-21: "the bot tab can also move
// to a panel"). Its button (#wsBotTab, the Bot desk's own) sits in that panel, or in the top bar while a view is open; with no room
// for the panel (or the panel placed already) + Add panel opens the Bot view itself. The smokes that opened or closed the Bot view
// with a click on its top-bar button use toggleTab: the button when it is in sight, else + Add panel (which opens the view, or
// places the panel, whose button is then clicked). The Agent tab is unchanged in the top bar.
export async function toggleTab(page, which) {
  if (which !== 'bot') throw new Error('toggleTab: only the Bot moved to a panel');
  const id = '#wsBotTab';
  if (await page.isVisible(id)) { await page.click(id); return; }
  await page.click('#wsAdd');
  await page.click('#wsAddMenu [data-add="bot"]');
  await page.waitForTimeout(150);
  if (await page.evaluate(() => document.body.classList.contains('bt-on'))) return;
  await page.waitForSelector(id, { state: 'visible', timeout: 15000 });
  await page.click(id);
}
/** the Bot reached from + Add panel (its panel, or the view at once when there is no room): its button in sight */
export async function tabBtn(page, which) {
  if (which !== 'bot') throw new Error('tabBtn: only the Bot moved to a panel');
  const id = '#wsBotTab';
  if (await page.isVisible(id)) return id;
  await page.click('#wsAdd');
  await page.click('#wsAddMenu [data-add="bot"]');
  await page.waitForSelector(id, { state: 'visible', timeout: 15000 });
  return id;
}
