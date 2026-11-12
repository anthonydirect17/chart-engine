'use strict';
// The brand (chart 1.44.0). Anthony 2026-11-06: the suite is IMPERIUM and the chart page (live/index.html, "TRADING SCREEN"
// before) is AUREUS. The top bar's wordmark is a small IMPERIUM above AUREUS, both gold, in Cinzel; Cinzel is for titles
// and headers only, bold 600 to 700; IBM Plex stays for everything else, and every price, time and live value stays IBM Plex
// Mono. The browser tab reads "Aureus · Imperium". The font is served from the page's folder, never from the internet.
// test/brand-smoke.mjs checks the same in a real page (sizes, legibility, nothing else in Cinzel) and takes screenshots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...f) => fs.readFileSync(path.join(root, ...f), 'utf8');
const www = JSON.parse(read('nt8', 'install-files.json')).www;

test('the chart page: the IMPERIUM over AUREUS wordmark where TRADING SCREEN was, and the tab title', () => {
  const html = read('live', 'index.html');
  assert.doesNotMatch(html, /TRADING SCREEN/i, 'the old title is gone from the chart page');
  assert.match(html, /<title>Aureus · Imperium<\/title>/);
  const mark = /<span class="ws-title ws-mark" role="img" aria-label="Aureus, Imperium"><span class="ws-mark-suite" aria-hidden="true">IMPERIUM<\/span><span class="ws-mark-name" aria-hidden="true">AUREUS<\/span><\/span>/;
  assert.match(html, mark);
  // first in the top bar, as the old title was, and the connection still says ChartBridge (not renamed)
  assert.match(html, /<header class="ws-top">\n(?:\s*<!--[^\n]*-->\n)?\s*<span class="ws-title ws-mark"/);
  assert.match(html, /CONNECTING · ChartBridge/);
  // the window's title: the layout, then the page and the suite; ARMED first while Armed, as before
  const js = read('live', 'workspace.js');
  assert.match(js, /\(layout \|\| W\.DEFAULT_NAME\) \+ ' · Aureus · Imperium';/);
  assert.match(js, /'ARMED · ' \+ ticketRoot\(\)/);
  assert.doesNotMatch(js, /' · Workspace'/);
});

test('Cinzel from this PC: 600 and 700, woff2, its licence beside it, installed, loaded after Plex and the tab fonts', () => {
  const css = read('live', 'fonts', 'cinzel.css');
  const faces = [...css.matchAll(/@font-face \{ font-family: "([^"]+)"; font-style: normal; font-weight: (\d+); font-display: swap; src: url\("([^"]+)"\) format\("woff2"\); \}/g)]
    .map(m => ({ family: m[1], weight: +m[2], file: m[3] }));
  assert.deepEqual(faces.map(f => f.family + ' ' + f.weight + ' ' + f.file), ['Cinzel 600 Cinzel-SemiBold.woff2', 'Cinzel 700 Cinzel-Bold.woff2']);
  const to = www.map(f => f.to);
  for (const f of ['cinzel.css', 'OFL-cinzel.txt', 'Cinzel-SemiBold.woff2', 'Cinzel-Bold.woff2']) {
    assert.ok(www.some(x => x.from === 'live/fonts/' + f && x.to === 'fonts/' + f), f + ' is installed');
    if (/woff2$/.test(f)) assert.equal(fs.readFileSync(path.join(root, 'live', 'fonts', f)).subarray(0, 4).toString('latin1'), 'wOF2', f + ' is a woff2 file');
  }
  assert.ok(to.includes('fonts/plex.css'));
  const ofl = read('live', 'fonts', 'OFL-cinzel.txt');
  assert.match(ofl, /^Copyright 2020 The Cinzel Project Authors \(https:\/\/github\.com\/NDISCOVER\/Cinzel\)$/m, 'the copyright line');
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(css, /github\.com\/NDISCOVER\/Cinzel\/blob\/master\/OFL\.txt/, 'the licence text\'s source is recorded');
  assert.doesNotMatch(css, /https?:\/\//, 'no address a browser could load');
  // the chart page loads it after Plex and the Agent tab's fonts (the order test/agent.test.js pins stays as it was)
  assert.match(read('live', 'index.html'), /<link rel="stylesheet" href="fonts\/agent-fonts\.css">\n<!--[^\n]*-->\n<link rel="stylesheet" href="fonts\/cinzel\.css">\n/);
});

test('Cinzel for the wordmark only, with a real fallback stack; the old title and every live value keep IBM Plex', () => {
  const ws = read('live', 'workspace.css');
  assert.match(ws, /--ws-title-font: "Cinzel", "Trajan Pro", Georgia, serif;/);
  // every live stylesheet names Cinzel only through the token, and the token only in the wordmark's three rules
  for (const f of fs.readdirSync(path.join(root, 'live')).filter(f => /\.css$/.test(f))) {
    const css = read('live', f).replace(/\/\*[\s\S]*?\*\//g, '');
    const named = css.replace(/--ws-title-font: "Cinzel"[^;]*;/, '');
    assert.doesNotMatch(named, /Cinzel/, f + ': Cinzel only through --ws-title-font');
    const uses = [...css.matchAll(/([^{}]+)\{[^}]*var\(--ws-title-font\)[^}]*\}/g)].map(m => m[1].trim());
    if (f === 'workspace.css') assert.deepEqual(uses, ['.ws-title.ws-mark', '.ws-mark-suite', '.ws-mark-name']);
    else if (f === 'league.css') assert.deepEqual(uses, ['.lg-word'], '1.50.0: the Colosseum\'s name, a title (never a live value)');
    else assert.deepEqual(uses, [], f + ': no Cinzel');
  }
  const rule = sel => (new RegExp('^' + sel.replace(/\./g, '\\.') + ' \\{([^}]*)\\}', 'm').exec(ws) || [])[1] || '';
  // bold 600 to 700; AUREUS never below 14px; IMPERIUM smaller but legible (10px, test/brand-smoke.mjs measures it)
  const suite = rule('.ws-mark-suite'), name = rule('.ws-mark-name');
  assert.match(suite, /font: 600 10px\/1 var\(--ws-title-font\)/);
  assert.match(name, /font: 700 17px\/1 var\(--ws-title-font\)/);
  for (const r of [suite, name]) { const m = /font: (\d+) ([\d.]+)px/.exec(r); assert.ok(+m[1] >= 600 && +m[1] <= 700, 'bold: ' + r); }
  assert.ok(+/font: \d+ ([\d.]+)px/.exec(name)[1] >= 14, 'AUREUS at 14px or more');
  assert.ok(+/font: \d+ ([\d.]+)px/.exec(suite)[1] >= 9, 'IMPERIUM at 9px or more');
  // both in the wordmark's gold (the V2 title rule, inherited); the bar stays 40 px
  assert.match(ws, /^\.ws-title \{ color: var\(--ws-gold-text\);[^}]*text-shadow: 0 0 18px var\(--ws-gold-glow\); \}$/m, 'the V2 wordmark rule: gold with its glow');
  assert.doesNotMatch(suite + name, /color:/, 'the two lines take the wordmark\'s gold');
  assert.match(ws, /^\.ws-top \{[^}]*height: 40px;/m);
  // live values stay IBM Plex Mono
  assert.match(ws, /--ws-mono: "IBM Plex Mono"/);
  assert.match(rule('.ws-clock'), /font: 600 13px var\(--ws-mono\)/);
  assert.match(rule('.ws-stat'), /var\(--ws-mono\)/);
});

test('the engine draws no title and loads no font: it stays one dependency-free file', () => {
  const src = read('src', 'chart-engine.js');
  assert.doesNotMatch(src, /Cinzel|AUREUS|IMPERIUM|TRADING SCREEN/i);
  assert.doesNotMatch(src, /\brequire\(|^import /m);
});

test('the renamed text: no em or en dashes in the files this release touches', () => {
  for (const f of ['live/index.html', 'live/workspace.css', 'live/workspace.js', 'live/fonts/cinzel.css', 'live/fonts/OFL-cinzel.txt',
    'live/kit.html', 'live/kit.css', 'docs/KIT.md', 'CHART_STYLE.md', 'test/brand.test.js', 'test/brand-smoke.mjs']) {
    assert.doesNotMatch(read(...f.split('/')), /[\u2013\u2014]/, f + ': no em or en dashes');
  }
  assert.doesNotMatch(read('live', 'kit.html'), /TRADING SCREEN|Trading screen|trading screen/, 'the kit says Aureus');
});
