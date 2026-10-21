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
