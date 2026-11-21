'use strict';
// chart 1.61.0 (Anthony 2026-11-20: "Right now, the desk is the only thing with its own browser icon - I would like our charts and
// legion to both have their own unique icons so I can tell them apart when clicking"): the chart page's and Legion's tab icons,
// inline SVG (base64, so no address shows in a page file), each the exact file in docs/icons/, in the house colours, distinct from
// each other and from The Desk's two gold bars.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const iconOf = html => {
  const all = [...html.matchAll(/<link rel="icon" href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)">/g)];
  assert.equal(all.length, 1, 'one tab icon');
  return Buffer.from(all[0][1], 'base64').toString('utf8');
};

test('the chart page and Legion each have their own inline tab icon, the files in docs/icons', () => {
  const chart = iconOf(read('live/index.html')), legion = iconOf(read('live/legion.html'));
  assert.equal(chart, read('docs/icons/chart.svg').trim());
  assert.equal(legion, read('docs/icons/legion.svg').trim());
  assert.notEqual(chart, legion);
  for (const svg of [chart, legion]) {
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 16 16">/, 'drawn on a 16 px grid');
    assert.match(svg, /fill="#0A0908" stroke="#C9A55C"/, 'black, with The Desk\'s gold edge');
    assert.deepEqual([...new Set(svg.match(/#[0-9A-Fa-f]{6}/g))].sort(), ['#0A0908', '#C9A55C', '#E2C687'], 'only The Desk\'s black and golds');
    assert.doesNotMatch(svg, /<(image|use|script|foreignObject)|href=/, 'nothing loaded from it');
  }
  assert.doesNotMatch(chart + legion, /M7 4v16M17 4v16/, 'neither is The Desk\'s two bars');
  // the page head has nothing loaded from the internet for it (the address is only inside the base64)
  for (const f of ['live/index.html', 'live/legion.html']) assert.doesNotMatch(read(f), /https?:\/\/(?!localhost)/, f);
});
