'use strict';
// No font from another host (chart 1.44.0, Anthony 2026-11-06: "bundle Plex too"). Every page and stylesheet in this repo
// takes its fonts from live/fonts (IBM Plex, the Agent tab's fonts, Cinzel), never from Google Fonts or any other host: no
// <link> (stylesheet, preconnect, preload) to another host, no @import or url() of an outside address, no font host named
// in what a browser reads. Comments are not read (a stylesheet may record where its files came from); the smokes' own
// guards in test/*.mjs are not pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'node_modules', 'out']);
const FONT_HOSTS = /\b(fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|p\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|use\.fontawesome\.com|fonts\.cdnfonts\.com)\b/i;
const LOCAL = /^(localhost|127\.0\.0\.1)$/i;
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (/\.(html|css)$/.test(e.name)) out.push(p);
  }
  return out;
}
const pages = files(root);
const code = (f, text) => /\.css$/.test(f) ? text.replace(/\/\*[\s\S]*?\*\//g, '') : text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const host = u => { const m = /^(?:https?:)?\/\/([^/:?#"'\s)]+)/i.exec(u); return m ? m[1] : null; };

test('every page and stylesheet was read', () => {
  const rel = pages.map(f => path.relative(root, f).split(path.sep).join('/'));
  for (const f of ['index.html', 'live/index.html', 'live/markup.html', 'live/kit.html', 'live/agent.html', 'live/fonts/plex.css', 'live/fonts/cinzel.css', 'live/fonts/agent-fonts.css', 'live/workspace.css']) assert.ok(rel.includes(f), f + ' is checked');
});

test('no page or stylesheet names a font host or loads a font, stylesheet or preconnect from another host', () => {
  for (const f of pages) {
    const name = path.relative(root, f), text = code(f, fs.readFileSync(f, 'utf8'));
    assert.doesNotMatch(text, FONT_HOSTS, name + ' names a font host');
    for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
      const href = (/\bhref\s*=\s*["']([^"']*)["']/i.exec(m[0]) || [])[1] || '', h = host(href);
      assert.ok(!h || LOCAL.test(h), name + ': ' + m[0] + ' loads from another host');
      assert.doesNotMatch(m[0], /\brel\s*=\s*["'][^"']*\b(preconnect|dns-prefetch)\b/i, name + ': ' + m[0] + ' (a preconnect is only for another host)');
    }
    for (const m of text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) { const h = host(m[1]); assert.ok(!h || LOCAL.test(h), name + ': @import ' + m[1]); }
    for (const m of text.matchAll(/url\(\s*["']?([^"')\s]+)/gi)) { const h = host(m[1]); assert.ok(!h || LOCAL.test(h), name + ': url(' + m[1] + ')'); }
    for (const m of text.matchAll(/@font-face\s*\{([^}]*)\}/gi)) assert.match(m[1], /src:\s*url\("(?:\.\.\/)*[\w.-]+(?:\/[\w.-]+)*\.woff2"\) format\("woff2"\)/, name + ': a font face from a file in this repo');
  }
});

test('the Markup Studio and the demo page take IBM Plex from live/fonts, the same families and weights as before', () => {
  assert.match(fs.readFileSync(path.join(root, 'live', 'markup.html'), 'utf8'), /<link rel="stylesheet" href="fonts\/plex\.css">/);
  assert.match(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), /<link rel="stylesheet" href="live\/fonts\/plex\.css">/);
  assert.match(fs.readFileSync(path.join(root, 'tools', 'markup_studio.py'), 'utf8'), /'\.woff2': 'font\/woff2'/, 'the Studio serves the woff2 files with their type');
  const src = fs.readFileSync(path.join(root, 'live', 'fonts', 'SOURCE.txt'), 'utf8');
  const crypto = require('node:crypto');
  for (const f of fs.readdirSync(path.join(root, 'live', 'fonts')).filter(f => /^(IBMPlex|Cinzel)[\w-]*\.woff2$/.test(f))) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'live', 'fonts', f))).digest('hex');
    assert.match(src, new RegExp('^    ' + sha + '  ' + f.replace('.', '\\.') + '$', 'm'), f + ': its SHA-256 in SOURCE.txt');
  }
  assert.match(src, /Copyright © 2017 IBM Corp\. with Reserved Font Name "Plex"/);
  assert.match(src, /Copyright 2020 The Cinzel Project Authors/);
  assert.doesNotMatch(src, /[\u2013\u2014]/, 'SOURCE.txt: no em or en dashes');
});
