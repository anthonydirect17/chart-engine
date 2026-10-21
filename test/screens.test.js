'use strict';
// Chart 1.34.0 (Anthony 2026-10-20): Screens (live/screens.js): the saved windows as read, each placed on the screen that holds
// its middle, the window.open features. Made-up screen sizes.
const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('../live/screens.js');

const three = [{ left: 0, top: 0, width: 1920, height: 1040 }, { left: 1920, top: 0, width: 1920, height: 1040 }, { left: -1920, top: 0, width: 1920, height: 1040 }];

test('clean: one per layout, whole numbers, nothing too small or broken', () => {
  const set = SC.clean({ at: 5, windows: [{ layout: ' Main ', x: 0.4, y: 0, w: 1920, h: 1040 }, { layout: 'Main', x: 9, y: 9, w: 900, h: 600 }, { layout: 'Tiny', x: 0, y: 0, w: 100, h: 100 },
    { layout: 'Bad', x: 'a', y: 0, w: 900, h: 600 }, null, { layout: 'Second', x: 1920, y: 0, w: 1920, h: 1040 }] });
  assert.deepEqual(set, { at: 5, windows: [{ layout: 'Main', x: 0, y: 0, w: 1920, h: 1040 }, { layout: 'Second', x: 1920, y: 0, w: 1920, h: 1040 }] });
  assert.deepEqual(SC.clean(null), { at: 0, windows: [] });
  assert.deepEqual(SC.clean({ windows: 'x' }), { at: 0, windows: [] });
});

test('place: on the screen that holds the window\'s middle, kept inside it; none: null', () => {
  assert.deepEqual(SC.place({ x: 1920, y: 0, w: 1920, h: 1040 }, three), { left: 1920, top: 0, width: 1920, height: 1040 });
  assert.deepEqual(SC.place({ x: -1930, y: -8, w: 1936, h: 1056 }, three), { left: -1920, top: 0, width: 1920, height: 1040 }, 'a maximized window\'s edges are past the screen');
  assert.deepEqual(SC.place({ x: 3000, y: 500, w: 1200, h: 800 }, three), { left: 2640, top: 240, width: 1200, height: 800 }, 'its bottom right kept on the screen');
  assert.equal(SC.place({ x: 5000, y: 0, w: 1000, h: 800 }, three), null, 'its screen is not connected');
  assert.equal(SC.place({ x: 0, y: 0, w: 1000, h: 800 }, []), null);
});

test('onScreen, features, screenNo, url', () => {
  assert.deepEqual(SC.onScreen(three[0], 1000, 800), { left: 460, top: 120, width: 1000, height: 800 });
  assert.deepEqual(SC.onScreen(three[0], 4000, 3000), { left: 0, top: 0, width: 1920, height: 1040 });
  assert.equal(SC.features({ left: -1920, top: 0, width: 1920, height: 1040 }), 'popup,left=-1920,top=0,width=1920,height=1040');
  assert.equal(SC.screenNo({ x: -1920, y: 0, w: 1920, h: 1040 }, three), 1, 'the screens from left to right');
  assert.equal(SC.screenNo({ x: 1920, y: 0, w: 1920, h: 1040 }, three), 3);
  assert.equal(SC.screenNo({ x: 9000, y: 0, w: 1920, h: 1040 }, three), 0);
  assert.equal(SC.url('My Layout'), '?layout=My%20Layout');
});

/* 1.35.0 (Anthony 2026-10-21: all windows open on the main monitor in Brave) */
test('1.35.0: Brave Shields\' made-up window places are seen, and the page says exactly what to allow', () => {
  // Brave with fingerprinting blocked: screenX/Y and availLeft/Top 0 to 8, the screen the size of the window (brave-core 13737)
  const brave = { brave: true, screenX: 5, screenY: 3, outerW: 1924, outerH: 1043, innerW: 1920, innerH: 1040, screenW: 1926, screenH: 1044, availLeft: 2, availTop: 7, hasDetails: true, permission: 'granted' };
  assert.equal(SC.spoofed(brave), true);
  assert.equal(SC.spoofed(Object.assign({}, brave, { brave: false })), false, 'only Brave: a headless or full-screen window looks alike and is real');
  /* review 4: Brave in F11 full screen at 0, 0 on the main monitor looks alike; window management granted and three screens listed: real */
  assert.equal(SC.spoofed(Object.assign({}, brave, { screens: 3 })), false, 'more than one real screen listed: not made up');
  assert.equal(SC.spoofed(Object.assign({}, brave, { screens: 1 })), true, 'one screen listed: still made up');
  assert.deepEqual(SC.check(Object.assign({}, brave, { screens: 3 })).codes, [], 'F11 on a three-screen PC with window management granted: nothing to allow');
  const r = SC.check(brave);
  assert.equal(r.ok, false);
  assert.deepEqual(r.codes, ['spoofed']);
  assert.match(r.lines[0], /^Brave's Shields are hiding where this window is \(it reports 5, 3 and a screen the size of the window\)/);
  assert.match(r.lines.join(' '), /Shields icon \(the lion\).*turn Shields down for this site.*"Allow all fingerprinting"/);
  assert.match(r.lines.join(' '), /Window management: Allow/);
  assert.match(r.lines.join(' '), /Pop-ups and redirects: Allow/);
  assert.match(r.lines.join(' '), /Save these screens again/);
  // a real window on the second of three screens, toolbars and all: not made up
  const real = { brave: true, screenX: 1920, screenY: 0, outerW: 1920, outerH: 1040, innerW: 1920, innerH: 951, screenW: 1920, screenH: 1080, availLeft: 1920, availTop: 0, hasDetails: true, permission: 'granted' };
  assert.equal(SC.spoofed(real), false);
  assert.deepEqual(SC.check(real), { ok: true, codes: [], lines: [] });
  // on the main screen at its top left, but with a toolbar: not made up either
  assert.equal(SC.spoofed(Object.assign({}, real, { screenX: 0, availLeft: 0 })), false);
  assert.deepEqual(SC.check(Object.assign({}, real, { permission: 'denied' })).codes, ['denied']);
  assert.deepEqual(SC.check(Object.assign({}, real, { hasDetails: false })).codes, ['noDetails']);
  const ask = SC.check(Object.assign({}, real, { permission: 'prompt' }));
  assert.deepEqual([ask.ok, ask.codes], [true, ['ask']]);
  assert.deepEqual(SC.check(Object.assign({}, real, { popupsBlocked: true })).codes, ['popups']);
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'live', 'workspace.js'), 'utf8');
  assert.match(src, /if \(chk\.codes\.includes\('spoofed'\)\) \{ scMsg = \{ text: 'Not saved: the browser is hiding where the windows are/, 'made-up places are never saved');
});
