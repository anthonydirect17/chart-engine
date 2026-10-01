'use strict';
// Trading hotkeys (1.11.0): combo text, the refused list, duplicates, storage cleaning, Flatten all's instruments.
const test = require('node:test');
const assert = require('node:assert/strict');
const OT = require('../live/order-ticket.js');

const ev = (code, mods, key) => Object.assign({ code, key: key !== undefined ? key : code.replace(/^Key|^Digit/, '').toLowerCase(), ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, mods || {});
const none = { buy: '', sell: '', be: '', close: '', flattenAll: '' };

test('hotkeyCombo: the physical key with the modifiers in a fixed order', () => {
  assert.equal(OT.hotkeyCombo(ev('KeyB', { altKey: true })), 'Alt+B');
  assert.equal(OT.hotkeyCombo(ev('KeyB', { shiftKey: true, ctrlKey: true, altKey: true }, 'B')), 'Ctrl+Alt+Shift+B');
  assert.equal(OT.hotkeyCombo(ev('Digit1', { shiftKey: true }, '!')), 'Shift+1');      // Shift never changes the key
  assert.equal(OT.hotkeyCombo(ev('Numpad1', {}, '1')), 'Num1');
  assert.equal(OT.hotkeyCombo(ev('NumpadAdd', {}, '+')), 'Num+');
  assert.equal(OT.hotkeyCombo(ev('F9', { ctrlKey: true }, 'F9')), 'Ctrl+F9');
  assert.equal(OT.hotkeyCombo(ev('BracketLeft', {}, '[')), '[');
  assert.equal(OT.hotkeyCombo(ev('KeyQ', { metaKey: true })), 'Meta+Q');
  assert.equal(OT.hotkeyCombo(ev('ShiftLeft', { shiftKey: true }, 'Shift')), '');       // a modifier alone
  assert.equal(OT.hotkeyCombo(ev('ControlRight', { ctrlKey: true }, 'Control')), '');
  assert.equal(OT.hotkeyCombo(ev('AltLeft', { altKey: true }, 'Alt')), '');
  assert.equal(OT.hotkeyCombo({ code: '', key: 'b', altKey: true }), 'Alt+B');          // no code: the letter
  assert.equal(OT.hotkeyCombo(null), '');
  assert.equal(OT.hotkeyCombo(ev('Space', {}, ' ')), 'Space');                          // a combo, refused below
});

test('parseHotkey reads the text back', () => {
  assert.deepEqual(OT.parseHotkey('Ctrl+Shift+Num+'), { ctrl: true, alt: false, shift: true, meta: false, key: 'Num+' });
  assert.deepEqual(OT.parseHotkey('B'), { ctrl: false, alt: false, shift: false, meta: false, key: 'B' });
  assert.equal(OT.parseHotkey(5), null);
});

test('hotkeyRefused: the browser and Windows keys, the chart keys, other keys; allowed ones pass', () => {
  for (const c of ['Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+T', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+R', 'F5', 'Ctrl+F5', 'Ctrl+L', 'Ctrl+P', 'Ctrl+S', 'Ctrl+F',
    'Ctrl+H', 'Ctrl+J', 'Ctrl+D', 'Ctrl+Q', 'Ctrl+Shift+N', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+Delete', 'F1', 'F3', 'F6', 'F7', 'F11', 'F12', 'Shift+F12',
    'Alt+F4', 'Alt+Tab', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Home', 'Alt+D', 'Alt+E', 'Alt+F', 'Escape', 'Tab', 'Shift+Tab', 'Meta+B', 'Ctrl+Meta+1',
    'Ctrl+Shift+W', 'Ctrl+1', 'Ctrl+9', 'Ctrl+0', 'F10'])
    assert.notEqual(OT.hotkeyRefused(c), '', c + ' should be refused');
  // the chart's own keys, with and without modifiers as the chart reads them
  for (const c of ['A', 'Shift+A', 'Ctrl+A', 'Alt+A', '=', 'Shift+=', 'Ctrl+=', '-', 'Shift+-', 'Num+', 'Num-', 'Ctrl+Num-', '/', 'Shift+/', 'Num/', 'End', 'Ctrl+End',
    'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'])
    assert.notEqual(OT.hotkeyRefused(c), '', c + ' (the chart\'s) should be refused');
  // keys that are not hotkey keys
  for (const c of ['Space', 'Enter', 'NumpadEnter', 'ArrowUp', 'PageDown', 'Home', 'Insert', 'ContextMenu', 'IntlBackslash'])
    assert.notEqual(OT.hotkeyRefused(c), '', c + ' should be refused');
  // allowed: other letters, digits, F-keys and the numpad, with or without Ctrl, Alt, Shift; plain keys the chart does not use
  for (const c of ['B', 'Alt+B', 'Ctrl+B', 'Ctrl+Alt+Shift+B', 'Shift+S', '1', 'Alt+1', 'Shift+1', 'F2', 'F8', 'Ctrl+F9', 'Shift+F8', 'Num1', 'Ctrl+Num5', 'Num*', 'Num.',
    'Ctrl+/', 'Alt+Num/', '[', ';', 'Alt+W', 'Ctrl+Alt+W', 'Ctrl+F2'])
    assert.equal(OT.hotkeyRefused(c), '', c + ' should be allowed');
  assert.equal(OT.hotkeyRefused('Ctrl+W'), 'Ctrl+W is kept by the browser (it closes the tab).');
  assert.equal(OT.hotkeyRefused('Shift+A'), 'Shift+A is the chart\'s: A fits the price axis.');
  assert.equal(OT.hotkeyRefused('Meta+B'), 'The Windows key is kept by Windows.');
  assert.equal(OT.hotkeyRefused(''), 'Press a key.');
});

test('hotkeyRefused, 1.12.0 (the 1.11.0 review): more the browser keeps, each with its reason; near ones still allowed', () => {
  const more = { 'Ctrl+Shift+C': 'opens the developer tools', 'Ctrl+O': 'opens a file', 'Ctrl+U': 'shows the page source', 'Ctrl+G': 'finds the next match',
    'Ctrl+K': 'searches from the address bar', 'Ctrl+E': 'searches from the address bar', 'Ctrl+Shift+B': 'shows or hides the bookmarks bar',
    'Ctrl+Shift+O': 'opens the bookmarks', 'Alt+Shift+I': 'opens the feedback form' };
  for (const [c, why] of Object.entries(more)) assert.equal(OT.hotkeyRefused(c), c + ' is kept by the browser (it ' + why + ').');
  for (const c of ['F4', 'Shift+F4', 'Alt+Shift+F4']) assert.equal(OT.hotkeyRefused(c), 'F4 is kept by the browser (it opens the address bar list).', c);
  assert.equal(OT.hotkeyRefused('Ctrl+F4'), 'Ctrl+F4 is kept by the browser (it closes the tab).');
  assert.equal(OT.hotkeyRefused('Alt+F4'), 'Alt+F4 is kept by the browser (it closes the window).');
  for (const c of ['Alt+C', 'Ctrl+Alt+C', 'Shift+O', 'Alt+U', 'Alt+G', 'Alt+K', 'Ctrl+Alt+E', 'Ctrl+Alt+B', 'Alt+I', 'Shift+I'])
    assert.equal(OT.hotkeyRefused(c), '', c + ' should still be allowed');
  // a saved key that is refused now is cleaned away on read (the next load), the others kept
  assert.deepEqual(OT.cleanHotkeys({ buy: 'Ctrl+K', sell: 'Alt+S', be: 'F4', close: 'Alt+C', flattenAll: 'Ctrl+Shift+O' }), { buy: '', sell: 'Alt+S', be: '', close: 'Alt+C', flattenAll: '' });
});

test('hotkeyRefused with the event: a layout where another key gives a chart key', () => {
  assert.equal(OT.hotkeyRefused('Q', ev('KeyQ', {}, 'a')), 'Q gives "a" on this keyboard, one of the chart\'s own keys.');   // AZERTY
  assert.notEqual(OT.hotkeyRefused('Shift+7', ev('Digit7', { shiftKey: true }, '/')), '');                                     // German "/"
  assert.equal(OT.hotkeyRefused('Ctrl+Shift+7', ev('Digit7', { shiftKey: true, ctrlKey: true }, '/')), '');                   // "/" with Ctrl is not the chart's
  assert.ok(OT.isChartKey(ev('Numpad1', {}, 'End')));                                  // NumLock off: the numpad 1 is End
  assert.ok(!OT.isChartKey(ev('KeyB', { altKey: true }, 'b')));
});

test('hotkeyFromEvent: a modifier alone is held, the Windows key and a duplicate are refused', () => {
  assert.deepEqual(OT.hotkeyFromEvent(ev('KeyB', { altKey: true }), none, 'buy'), { combo: 'Alt+B', error: '', held: false });
  const alone = OT.hotkeyFromEvent(ev('ControlLeft', { ctrlKey: true }, 'Control'), none, 'buy');
  assert.equal(alone.combo, ''); assert.ok(alone.held); assert.equal(alone.error, 'Ctrl alone is not a hotkey: hold it and press a key.');
  assert.equal(OT.hotkeyFromEvent(ev('MetaLeft', { metaKey: true }, 'Meta'), none, 'buy').error, 'The Windows key is kept by Windows.');
  const keys = Object.assign({}, none, { sell: 'Alt+S' });
  assert.equal(OT.hotkeyFromEvent(ev('KeyS', { altKey: true }), keys, 'buy').error, 'Alt+S is already Sell MKT. Clear it there first.');
  assert.equal(OT.hotkeyFromEvent(ev('KeyS', { altKey: true }), keys, 'sell').error, '');   // the same action again is fine
  assert.match(OT.hotkeyFromEvent(ev('KeyW', { ctrlKey: true }), none, 'close').error, /kept by the browser/);
  assert.match(OT.hotkeyFromEvent(ev('Escape', {}, 'Escape'), none, 'close').error, /Escape is kept/);
});

test('cleanHotkeys: never throws, keeps only allowed combos once, every action listed', () => {
  assert.deepEqual(OT.cleanHotkeys(null), none);
  assert.deepEqual(OT.cleanHotkeys('x'), none);
  assert.deepEqual(OT.cleanHotkeys([1, 2]), none);
  assert.deepEqual(OT.cleanHotkeys({ buy: 'Alt+B', sell: 'Ctrl+W', be: 5, close: 'Alt+B', flattenAll: 'F9', extra: 'Alt+X' }),
    { buy: 'Alt+B', sell: '', be: '', close: '', flattenAll: 'F9' });
  assert.deepEqual(OT.cleanHotkeys({ buy: 'A', sell: 'Meta+S', be: 'x'.repeat(40), close: 'Space', flattenAll: 'Shift+F' }), Object.assign({}, none, { flattenAll: 'Shift+F' }));
  const hostile = {}; Object.defineProperty(hostile, 'buy', { get() { throw new Error('no'); }, enumerable: true });
  assert.deepEqual(OT.cleanHotkeys(hostile), none);
  assert.equal(OT.hotkeyAction({ buy: 'Alt+B', sell: '' }, 'Alt+B'), 'buy');
  assert.equal(OT.hotkeyAction({ buy: 'Alt+B', sell: '' }, ''), '');
  assert.equal(OT.hotkeyAction(none, 'Alt+B'), '');
  assert.deepEqual(OT.HOTKEY_ACTIONS.map(a => a.name), ['Buy MKT', 'Sell MKT', 'B/E', 'Close', 'Flatten all']);
});

test('flattenAllRoots: one per instrument of the account with a position or a working order', () => {
  const orders = [
    { id: '1', account: 'Sim101', root: 'ES', state: 'working' },
    { id: '2', account: 'Sim101', root: 'MNQ', state: 'partFilled' },
    { id: '3', account: 'Sim101', root: 'NQ', state: 'filled' },          // not working
    { id: '4', account: 'DEMO-EVAL', root: 'MES', state: 'working' },     // another account
    { id: '5', account: 'Sim101', root: 'MNQ', state: 'working' },
  ];
  const positions = new Map([['Sim101|NQ', { qty: 0 }], ['Sim101|MES', { qty: -2 }], ['DEMO-EVAL|ES', { qty: 1 }], ['Sim101|CL', { qty: 1 }]]);
  const ROOTS = ['MNQ', 'NQ', 'MES', 'ES'];
  assert.deepEqual(OT.flattenAllRoots(orders, positions, 'Sim101', null, ROOTS), ['MNQ', 'MES', 'ES', 'CL']);
  assert.deepEqual(OT.flattenAllRoots(orders, positions, 'Sim101', r => ROOTS.includes(r), ROOTS), ['MNQ', 'MES', 'ES']);
  assert.deepEqual(OT.flattenAllRoots(orders, positions, 'DEMO-EVAL', null, ROOTS), ['MES', 'ES']);
  assert.deepEqual(OT.flattenAllRoots([], new Map(), 'Sim101', null, ROOTS), []);
  assert.deepEqual(OT.flattenAllRoots(null, null, 'Sim101'), []);
});
