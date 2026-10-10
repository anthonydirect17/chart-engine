// Helpers for test/chart-host.html (chart 1.21.0): one chart mounted with ChartLive.mount, filling the window, with its own
// toolbar. The smokes that drove the single chart page (live/single.html, gone in 1.21.0) drive the chart here. Its
// element ids carry the mount's prefix (the first mount on a page is chart-live-1-). Sample data from the fake bridge.
export const P = 'chart-live-1-';
/** A CSS id selector for one of the chart's elements: C('tfSeg') is '#chart-live-1-tfSeg'. */
export const C = s => '#' + P + s;
/** The host page's URL on a fake bridge's port; q: { prefix, pane }. */
export const hostUrl = (port, q) => `http://localhost:${port}/test/chart-host.html` + (q ? '?' + new URLSearchParams(q) : '');
/** In the page: the chart's badge says its line is live (the single chart page's LIVE pill until 1.21.0). */
export const isLive = () => { const b = document.querySelector('[id$="-badge"]'); return !!b && b.dataset.conn === 'live'; };
export const waitLive = (p, ms = 20000) => p.waitForFunction(isLive, null, { timeout: ms });
/** The chart's own view (instrument, bars, range size), as the mount handle says. */
export const view = p => p.evaluate(() => window.liveMount.view());
