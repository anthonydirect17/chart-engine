# Motion kit (ChartMotion)

`live/motion.js` and `live/motion.css` are our own small motion kit for the chart page's panels (the Bot tab), The Desk
and the Markup Studio. One file of script, one of styles, no dependencies, no build step.

## Never on order surfaces (R3)

**The kit must never be used on anything that trades or shows money at risk:**

* the order ticket, and every button, field and warning in it
* the chart's order lines, order drags and the chart itself (`.chart-live`)
* fills and fill marks
* Flatten
* position and P&L figures, anywhere they are live
* the copier
* Accounts warnings (room used, daily loss, any alert)
* any live trading panel

Those must show the truth the moment it changes, with nothing easing in or counting up. The kit has no hook into
the chart engine and never runs inside the chart's draw loop (R5). It only touches DOM panels and its own small
canvases.

As a second line of defense, a scene whose root sits inside `.chart-live`, a ticket (`tk-*` classes), Flatten
(`.ws-flat`) or any element marked `data-no-motion` is shown in its final state at once, and pieces inside a
`data-no-motion` element are left alone. Mark any trading part of a page you build with `data-no-motion`.

## Loading it

| Page | How |
|---|---|
| Chart page and workspace | `<link rel="stylesheet" href="motion.css">` and `<script src="motion.js"></script>`. Both are in `nt8/install-files.json`, so the PC updater ships them. |
| The Desk | Vendor both files next to the chart files (`public/vendor/chart-engine/`), from the same chart-engine commit, and load them with `<link>` and `<script defer>`. The script sets `window.ChartMotion`. From an ES module: `import '/vendor/chart-engine/motion.js'` then use `window.ChartMotion`. |
| Markup Studio | `<script src="motion.js">` in `live/markup.html` (the Studio serves `live/`). |
| Node (tests) | `require('./live/motion.js')`. |

## The motion language

| Rule | What it means |
|---|---|
| M1 One clock | A scene is drawn from its progress, 0 to 1. Pause, scrub, step back and reduced motion all use the same drawing. |
| M2 Staggered arrivals | Each piece has its own window of the scene's time, and the windows overlap (frame 0 to 0.35, badge 0.25 to 0.45, text 0.3 to 0.6). `stagger()` hands them out. |
| M3 Four curves | `ease.out` for arrivals, `ease.inOut` for moves, `ease.in` for exits, `ease.back` (c1 = 1.4) for stamps only. |
| M4 Count up | Numbers count up to their value in tabular digits, with sign, prefix and decimals. |
| M5 Timing tokens | fast 150 ms (hover, tooltips: fade and rise 4 px), base 250 ms (toasts, panels: rise 20 px), slow 400 ms. CSS: `--motion-fast`, `--motion-base`, `--motion-slow`. |
| M6 Atmosphere | `.motion-atmo` puts a soft glow and a faint grid behind a scene, in the host page's colors. |
| M7 Cheap | One animation loop for every running scene, and none while nothing moves. A frame step is capped at 50 ms. Canvases at most 2x device pixels. A style or text is written only when it changes. |
| M8 Reduced motion | The Windows setting (prefers reduced motion) or the page setting shows every scene in its final state at once and sets the CSS tokens to 0. |
| R4 Never blocks input | A click inside a running scene, or any key, finishes the scene at once. The click or key still does what it does. |
| At rest | If the script fails or motion is off, everything is visible. Start states are set only when a scene begins, and each element's own styles and text are put back exactly at the end. |

## Scenes

Mark the pieces of a panel, then play the panel:

```html
<div class="card motion-atmo" id="botPanel">
  <h3 data-in="0,.3">Bot panel</h3>
  <span class="stamp">L2 Ready</span>
  <div data-in=".2,.5">Trades <span data-count="12" data-in=".3,.75">12</span> of 30</div>
  <div class="meter"><i data-grow=".2,.6" style="width:40%"></i></div>
  <canvas id="curve" data-in=".1,.9"></canvas>
</div>
```

```js
const run = ChartMotion.scene(document.getElementById('botPanel'), { ms: 1100 });
run();            // finish now (draws the end)
run.seek(0.5);    // pause at the middle; seek again to step back
run.play();       // carry on from there
run.done();       // true once it ended
```

| Attribute | Piece |
|---|---|
| `data-in="a,b"` | rises in over the window: fades in and moves up from `data-rise` px (default 12) |
| `data-grow="a,b"` | a bar grows from its left end (set `transform-origin` for another end) |
| `data-count="1284.5"` | counts up over its `data-in` window; `data-dec`, `data-sign`, `data-pre`, `data-suf`, `data-from` |
| `.stamp` or `data-stamp="a,b"` | lands big and settles with the overshoot curve (default window 0.12 to 0.42) |
| `canvas` with `_draw(p)` | its `_draw` is called with the eased progress of its `data-in` window |

Put the final text in a count element (`+$1,284.50`): it shows at rest and is put back at the end. Start a scene in
the same task that renders the panel, before the browser paints, so the panel never flashes in its final state first.
A new scene on the same root finishes the old one; a root taken out of the page finishes its scene.

Moves use the separate CSS `translate` and `scale` properties, so an element's own `transform` (the stamp's tilt)
is kept.

## The rest of the API

| Call | What it does |
|---|---|
| `ChartMotion.ease.out / inOut / in / back` | the four curves |
| `ChartMotion.seg(p, a, b)` | where p is inside the window [a, b], as 0 to 1 |
| `ChartMotion.stagger(list, { start, step, span, attr })` | windows for a list (a count or elements); with `attr: 'in'` each element gets its `data-in` |
| `ChartMotion.formatNumber(v, { dec, sign, prefix, suffix })` | `+$1,284.50`, `-$42.5`; zero never gets a sign |
| `ChartMotion.countTo(el, to, { ms, from, dec, sign, prefix, suffix })` | counts one element up on the shared clock |
| `ChartMotion.timeline(draw, { ms })` | any drawing of progress 0 to 1 on the shared clock, with the same controls as a scene |
| `ChartMotion.setText(el, text)` | writes text only when it changed |
| `ChartMotion.fitCanvas(canvas)` | sizes a canvas to its box at up to 2x device pixels, resizing only on change |
| `ChartMotion.setReducedMotion(true or false)` | the page setting, saved in `localStorage` as `motion-reduced-v1`; puts `motion-off` on `<html>` |
| `ChartMotion.reduced()` | true while motion is off (Windows setting or page setting) |
| `ChartMotion.MS` | `{ fast: 150, base: 250, slow: 400, scene: 1100 }` |

## CSS classes

| Class | Use |
|---|---|
| `.motion-tip` | tooltips and hover cards: add `.motion-out` to hide (fade and drop 4 px, fast) |
| `.motion-panel` | toasts and panels: add `.motion-out` to hide (fade and drop 20 px, base) |
| `.motion-atmo` | the glow and grid behind a scene; set `--motion-glow`, `--motion-glow-2`, `--motion-grid` to change its colors |
| `.motion-num` | tabular digits (every `data-count` has them already) |

Both `.motion-tip` and `.motion-panel` are shown at rest: only `.motion-out`, which the page adds, hides them.

## Tests

`node --test test/motion.test.js` (part of `npm test`): the curves, windows, number formatting, the one clock, finish
on input, reduced motion, nothing scheduled while idle, and order surfaces left alone, with a fake clock and a tiny fake
page.

`npm run smoke:motion` (Chromium, `test/motion-smoke.mjs` on `test/motion-host.html`): the kit as a plain script and
as a module import, a scene's start and end states in a real page, a click during a scene, reduced motion (page and
system), and no animation frame while idle. Screenshots `test/out/motion-mid.png` and `motion-end.png`.

`npm run smoke:bot` (the Bot tab, `test/bot-smoke.mjs`): a click during the Bot tab's entrance acts at once and finishes
it (R4); the kill switch, the mode, position and P&L, the chart and the copilot pop-ups are never animated, even
mid-entrance (R3); Less motion in Settings shows the Bot tab in its final state at once.

`npm run perf:bot` (R5, `test/perf-bot.mjs`): the Bot tab's entrance and a Library build full screen played over and over
while the tab's live chart draws a busy tape. It holds the chart's gates (a chart's frame p95 under 4 ms, all charts per
frame under 8 ms), keeps the kit's own loop under 4 ms at p95, and checks that the kit never runs inside a chart's frame.

## Keeping it cheap on a big page (the Bot tab)

What the Bot tab learned (`live/bot.css`, `live/bot.js`): a `.motion-atmo` glow under a whole screen is painted again
with every piece that moves over it, so give its `::before` a layer of its own (`will-change: transform`); while a scene
plays, give the moving pieces layers of their own too (a class on the root until the scene's `onDone`), and take them
away at rest; read a canvas's size at a scene's first and last frames only (a layout read in every frame is a forced
layout); and never put a backdrop blur over a live chart.
