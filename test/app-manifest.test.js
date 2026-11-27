'use strict';
// chart 1.61.0 (plan step 7): the workspace installs as an app window, Aureus Imperium with the gold A. The manifest and
// the icons are plain page files that ChartBridge serves with no-cache like every other, so a later icon or name change
// reaches the installed app by itself. No service worker: nothing may keep an old copy of the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p));
const pngSize = buf => {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
};

test('the manifest names the app and stays relative (no host, no port)', () => {
  const text = read('live', 'manifest.json').toString('utf8');
  const m = JSON.parse(text);
  assert.equal(m.name, 'Aureus Imperium');
  assert.equal(m.short_name, 'Aureus');
  assert.equal(m.display, 'standalone');
  for (const k of ['id', 'start_url', 'scope']) assert.equal(m[k], './', k);
  assert.doesNotMatch(text, /:\/\/|localhost|127\.0\.0\.1|[\u2013\u2014]/);
});

test('every icon is there at its size, and on the install list', () => {
  const m = JSON.parse(read('live', 'manifest.json').toString('utf8'));
  const www = JSON.parse(read('nt8', 'install-files.json').toString('utf8')).www;
  const listed = f => www.some(x => x.from === `live/${f}` && x.to === f);
  const seen = new Set();
  for (const icon of m.icons) {
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(icon.type, 'image/png');
    assert.deepEqual(pngSize(read('live', icon.src)), [w, h], icon.src);
    assert.ok(listed(icon.src), icon.src + ' is installed');
    seen.add(`${w} ${icon.purpose}`);
  }
  for (const k of ['192 any', '512 any', '512 maskable']) assert.ok(seen.has(k), k);
  assert.deepEqual(pngSize(read('live', 'icons', 'favicon-32.png')), [32, 32]);
  assert.ok(listed('icons/favicon-32.png') && listed('manifest.json'));
});

test('the workspace links the manifest and the favicon, and ChartBridge serves both types with no-cache', () => {
  const html = read('live', 'index.html').toString('utf8');
  assert.match(html, /<link rel="manifest" href="manifest\.json">/);
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="icons\/favicon-32\.png">/);
  const cs = read('nt8', 'ChartBridge.cs').toString('utf8');
  assert.match(cs, /ext == "\.json" \? "application\/json"/);
  assert.match(cs, /ext == "\.png" \? "image\/png"/);
  assert.match(cs, /res\.AddHeader\("Cache-Control", "no-cache"\);/);
});

test('no service worker on any page', () => {
  for (const f of fs.readdirSync(path.join(root, 'live')).filter(n => /\.(html|js)$/.test(n))) {
    assert.doesNotMatch(read('live', f).toString('utf8'), /serviceWorker/, f);
  }
});
