// 1.16.0 (Anthony): the trading pages load nothing from the internet. Every file installed on a trading PC (the www list of
// nt8/install-files.json) refers to no http(s) address but this PC's own (localhost, 127.0.0.1); IBM Plex is served from the
// page's own folder (live/fonts), with its licence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const www = JSON.parse(fs.readFileSync(path.join(root, 'nt8', 'install-files.json'), 'utf8')).www;
const LICENCE = 'live/fonts/OFL.txt';                   // the SIL Open Font License text: never loaded by a page

test('no file in the www list refers to an http(s) address other than this PC', () => {
  let checked = 0;
  for (const f of www) {
    if (/\.woff2$/.test(f.from) || f.from === LICENCE) continue;
    const text = fs.readFileSync(path.join(root, f.from), 'utf8');
    for (const m of text.matchAll(/https?:\/\/([^/\s"'`)<>:]*)/gi)) {
      assert.ok(/^(localhost|127\.0\.0\.1)$/i.test(m[1]), f.from + ' refers to ' + m[0]);
    }
    // a protocol-relative address loads from the internet too
    assert.ok(!/(?:src|href)\s*=\s*["']\/\//i.test(text) && !/url\(\s*["']?\/\//i.test(text), f.from + ' has a protocol-relative address');
    checked++;
  }
  assert.ok(checked >= 15, 'the page files were read: ' + checked);
});

test('IBM Plex from the page folder: every weight the pages use, its licence, installed, no Google Fonts link', () => {
  const css = fs.readFileSync(path.join(root, 'live', 'fonts', 'plex.css'), 'utf8');
  const want = { 'IBM Plex Mono': [400, 500, 600], 'IBM Plex Sans': [400, 500, 600], 'IBM Plex Sans Condensed': [500, 600, 700] };
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(m => ({
    family: /font-family:\s*"([^"]+)"/.exec(m[1])[1], weight: +/font-weight:\s*(\d+)/.exec(m[1])[1], file: /url\("([^"]+)"\)/.exec(m[1])[1] }));
  for (const [family, weights] of Object.entries(want)) assert.deepStrictEqual(faces.filter(f => f.family === family).map(f => f.weight).sort(), weights, family);
  const to = www.map(f => f.to);
  for (const f of faces) {
    const file = path.join(root, 'live', 'fonts', f.file);
    assert.strictEqual(fs.readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2', f.file + ' is a woff2 file');
    assert.ok(to.includes('fonts/' + f.file), f.file + ' is installed');
  }
  assert.ok(to.includes('fonts/plex.css') && to.includes('fonts/OFL.txt'), 'the stylesheet and the licence are installed');
  assert.match(fs.readFileSync(path.join(root, LICENCE), 'utf8'), /SIL Open Font License, Version 1\.1/);
  assert.ok(!fs.existsSync(path.join(root, 'live', 'single.html')), '1.21.0: the single chart page is gone');
  for (const page of ['index.html']) {
    const html = fs.readFileSync(path.join(root, 'live', page), 'utf8');
    assert.ok(!/fonts\.(googleapis|gstatic)\.com/.test(html), page + ' has no Google Fonts link');
    assert.match(html, /<link rel="stylesheet" href="fonts\/plex\.css">/, page + ' loads the PC\'s fonts');
  }
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /^\*\.woff2 binary$/m, 'woff2 files are binary to git (no line-ending change)');
});
