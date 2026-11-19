'use strict';
// Release 1 (Anthony's rulings of 2026-11-18): the voice-4 files ship in this repo (live/voice) and install with the page into
// ChartBridge's www\voice, ChartBridge's default voice folder. Every call ChartBridge can play has its file; each is mono 16-bit
// PCM WAV at 48000 Hz; live/voice/README.txt holds each file's sha256.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p));

// The calls ChartBridge can play: the names in ChartBridgeVoice (ChartBridge.cs) and the bot's Say calls (ChartBridgeBot.cs).
function calls() {
  const cb = read('nt8', 'ChartBridge.cs').toString('utf8');
  const start = cb.indexOf('public static class ChartBridgeVoice'), end = cb.indexOf('public static class ChartBridgeClock');
  assert.ok(start > 0 && end > start, 'ChartBridgeVoice found');
  const body = cb.slice(start, end);
  const out = new Set();
  for (const m of body.matchAll(/"([A-Z][a-z]+(?:[A-Z][a-z]+)*(?:Filled|Closed|Set))"/g)) out.add(m[1]);
  const bot = read('nt8', 'ChartBridgeBot.cs').toString('utf8');
  for (const m of bot.matchAll(/ChartBridgeVoice\.Say\([^;]*?,\s*"([A-Za-z]+)"\)/g)) out.add(m[1]);
  return [...out].sort();
}

function wavInfo(buf) {
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  let i = 12, fmt = null, data = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString('ascii', i, i + 4), size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(i + 8), channels: buf.readUInt16LE(i + 10), rate: buf.readUInt32LE(i + 12), bits: buf.readUInt16LE(i + 22) };
    if (id === 'data') data = size;
    i += 8 + size + (size % 2);
  }
  return { fmt, data };
}

test('every call ChartBridge can play has its voice file, listed in install-files.json for www\\voice', () => {
  const c = calls();
  assert.deepEqual(c, ['BotNotClosed', 'BreakEvenSet', 'LongFilled', 'PositionClosed', 'ShortFilled', 'StopFilled', 'TargetFilled', 'TargetOneFilled', 'TargetTwoFilled']);
  const www = JSON.parse(read('nt8', 'install-files.json').toString('utf8')).www;
  const voice = www.filter(w => w.from.startsWith('live/voice/'));
  for (const name of c) {
    assert.ok(voice.some(w => w.from === 'live/voice/' + name + '.wav' && w.to === 'voice/' + name + '.wav'), name + ' is installed to voice/' + name + '.wav');
    assert.ok(fs.existsSync(path.join(root, 'live', 'voice', name + '.wav')), name + '.wav is in the repo');
  }
  assert.equal(voice.length, c.length, 'no other voice file');
  assert.match(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), /^\*\.wav binary$/m, 'WAV files are binary to git (never line-ending converted)');
});

test('each voice file is mono 16-bit PCM WAV at 48000 Hz, as the voice-4 set', () => {
  for (const name of calls()) {
    const { fmt, data } = wavInfo(read('live', 'voice', name + '.wav'));
    assert.deepEqual(fmt, { format: 1, channels: 1, rate: 48000, bits: 16 }, name);
    const secs = data / (48000 * 2);
    assert.ok(secs > 0.8 && secs < 4, name + ': ' + secs.toFixed(2) + ' s');
  }
});

test('live/voice/README.txt holds every file\'s words, bytes and sha256, and they match', () => {
  const readme = read('live', 'voice', 'README.txt').toString('utf8');
  for (const name of calls()) {
    const buf = read('live', 'voice', name + '.wav');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const line = readme.split('\n').find(l => l.startsWith(name + '.wav'));
    assert.ok(line, name + ' has a line');
    assert.ok(line.includes(sha), name + ': sha256 ' + sha);
    assert.ok(line.includes(' ' + buf.length + ' bytes'), name + ': ' + buf.length + ' bytes');
  }
  assert.match(readme, /en-GB-SoniaNeural/);
  assert.ok(!/[\u2013\u2014]/.test(readme), 'plain hyphens only');
});

test('ChartBridge\'s default voice folder is www\\voice; a voiceFolder line still wins; voice stays off by default', () => {
  const cb = read('nt8', 'ChartBridge.cs').toString('utf8');
  assert.match(cb, /public static string FolderNow \{ get \{ return Folder \?\? DefaultFolder\(\); \} \}/);
  assert.match(cb, /try \{ return Path\.Combine\(ChartBridgeConfig\.WwwFolder, "voice"\); \}/);
  assert.match(cb, /if \(key == "voiceFolder"\) \{ if \(!string\.IsNullOrWhiteSpace\(val\)\) Folder = val\.Trim\(\); return true; \}/);
  assert.match(cb, /On = false; Folder = null;/);
  assert.ok(!/sounds_voice4"\)/.test(cb), 'the old default folder is gone from the code');
});
