'use strict';
// The board F kit (live/kits/agent-board-f, its README.md): the Agent tab as it was before Layout 5 (DECISION 2026-10-14a),
// saved to open on its own against the fake bridge. It must never ship to a trading PC and nothing on the live page may load
// it: not in nt8/install-files.json (install.ps1 and update-pc.ps1 copy exactly that list), and no live page, script or style
// names it. Its page loads its own copies of the tab's files, never the live ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const root = path.join(__dirname, '..');
const KIT = 'live/kits/agent-board-f';
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('the board F kit is not installed on a PC: nt8/install-files.json lists none of it', () => {
  const m = JSON.parse(read('nt8', 'install-files.json'));
  const all = [...m.addons, ...m.www.map(f => f.from), ...m.www.map(f => f.to)];
  assert.ok(m.www.length > 0 && m.addons.length > 0, 'the list is read');
  for (const f of all) assert.doesNotMatch(f, /kits|board-f/, f + ' is a kit file');
  assert.doesNotMatch(read('nt8', 'install-files.json'), /kits|board-f/);
  for (const f of ['nt8/install.ps1', 'nt8/update-pc.ps1']) assert.doesNotMatch(read(f), /kits[\\/]|board-f/, f + ' names no kit');
});

test('nothing on the live page loads the kit: no live page, script or style names it', () => {
  const live = path.join(root, 'live'), found = [];
  for (const f of fs.readdirSync(live)) {
    if (!/\.(html|js|css)$/.test(f)) continue;
    if (/kits\/|board-f/.test(fs.readFileSync(path.join(live, f), 'utf8'))) found.push('live/' + f);
  }
  for (const f of fs.readdirSync(path.join(live, 'fonts'))) if (/\.css$/.test(f) && /kits\/|board-f/.test(read('live', 'fonts', f))) found.push('live/fonts/' + f);
  assert.deepEqual(found, [], 'live files that name the kit');
});

test('the kit stands alone: its page loads its own copies of the tab, the shared parts from live/, and no dashes', () => {
  const html = read(KIT, 'agent.html');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(x => x[1]), styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map(x => x[1]);
  for (const own of ['agent-core.js', 'agent-helper.js', 'agent.js']) assert.ok(scripts.includes(own), own + ' from the kit');
  for (const own of ['agent.css', 'agent-fonts.css']) assert.ok(styles.includes(own), own + ' from the kit');
  for (const u of scripts.concat(styles)) {
    if (!u.includes('/')) { assert.ok(fs.existsSync(path.join(root, KIT, u)), u + ' is in the kit'); continue; }
    assert.ok(fs.existsSync(path.join(root, KIT, u)), u + ' resolves from the kit');
    assert.doesNotMatch(u, /agent/, u + ': the tab\'s own files come from the kit, never live/');
  }
  for (const m of read(KIT, 'agent-fonts.css').matchAll(/url\("([^"]+)"\)/g)) assert.ok(fs.existsSync(path.join(root, KIT, m[1])), m[1] + ' resolves from the kit');
  for (const f of ['README.md', 'board-f-1366x768.png', 'board-f-1920x1080.png']) assert.ok(fs.existsSync(path.join(root, KIT, f)), f);
  for (const f of ['agent.html', 'agent-fonts.css', 'README.md']) assert.doesNotMatch(read(KIT, f), /[\u2013\u2014]/, f + ': no em or en dashes');
});
