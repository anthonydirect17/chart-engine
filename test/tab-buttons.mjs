// Chart 1.35.0: the Bot tab and the agent desk left the top bar for panels of their own in + Add panel (Anthony 2026-10-21).
// Their buttons (#wsBotTab, #wsAgentTab, the desks' own) sit in that panel, or in the top bar while their view is open; with no
// room for the panel (or the panel placed already) + Add panel opens the view itself. The smokes that opened or closed a view
// with a click on its top-bar button use toggleTab: the button when it is in sight, else + Add panel (which opens the view, or
// places the panel, whose button is then clicked).
export async function toggleTab(page, which) {
  const id = which === 'bot' ? '#wsBotTab' : '#wsAgentTab', add = which === 'bot' ? 'bot' : 'agentdesk', on = which === 'bot' ? 'bt-on' : 'ag-on';
  if (await page.isVisible(id)) { await page.click(id); return; }
  await page.click('#wsAdd');
  await page.click(`#wsAddMenu [data-add="${add}"]`);
  await page.waitForTimeout(150);
  if (await page.evaluate(c => document.body.classList.contains(c), on)) return;
  await page.waitForSelector(id, { state: 'visible', timeout: 15000 });
  await page.click(id);
}
/** the panel placed (or the view opened when there is no room): the button in sight, for a test that reads it */
export async function tabBtn(page, which) {
  const id = which === 'bot' ? '#wsBotTab' : '#wsAgentTab', add = which === 'bot' ? 'bot' : 'agentdesk';
  if (await page.isVisible(id)) return id;
  await page.click('#wsAdd');
  await page.click(`#wsAddMenu [data-add="${add}"]`);
  await page.waitForSelector(id, { state: 'visible', timeout: 15000 });
  return id;
}
