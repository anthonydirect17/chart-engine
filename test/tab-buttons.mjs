// Chart 1.35.0 moved the Bot tab to a panel; 1.36.0 (Anthony 2026-10-22: "get rid of the bot panel and merge it into this") removed
// that panel: the Bot's button (#wsBotTab, the Bot desk's own) is in the top bar on any layout with no Agents strip (the smokes'
// layouts), while a view is open, and while it carries its red alert; on a layout with an Agents strip the strip's bot card opens
// the Bot view. The smokes that opened or closed the Bot view with a click on its top-bar button use these.
async function inSight(page) {
  const id = '#wsBotTab';
  if (await page.isVisible(id)) return id;
  if (await page.$('.ws-panel.agents [data-card="bot"]')) return null;   // a layout with an Agents strip: its bot card
  await page.waitForSelector(id, { state: 'visible', timeout: 15000 });
  return id;
}
export async function toggleTab(page, which) {
  if (which !== 'bot') throw new Error('toggleTab: only the Bot');
  const id = await inSight(page);
  if (id) await page.click(id); else await page.click('.ws-panel.agents [data-card="bot"] .as-name');
}
/** the Bot's button in sight (the top bar) */
export async function tabBtn(page, which) {
  if (which !== 'bot') throw new Error('tabBtn: only the Bot');
  return (await inSight(page)) || '#wsBotTab';
}
