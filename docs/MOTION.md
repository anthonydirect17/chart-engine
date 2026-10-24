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

## Allowed motion on the Agent tab (Layout 5, chart 1.23.0)

The Agent tab does not use the kit. Its motion is two things only (DECISION 2026-10-14a and the lead's rulings):

| what | how | stops |
|---|---|---|
| The border light (`ag-orbit`) | pure CSS: thin strips along a lit panel's border turning one small conic gradient (below) | Motion Off, reduced motion |
| The grid canvas (`live/agent-grid.js`) | one 2D canvas in the grid panel only: the five steps feed a point-cloud sphere inside identity-disc rings, lines funnel into the decision; an orange beam only for a few seconds after a plan arrives | Motion Off, reduced motion, a hidden window, the tab closed: then no frame is scheduled and one still frame shows |

The grid canvas is the tab's one frame loop and the only module there allowed `requestAnimationFrame` (`test/agent.test.js`
says so for that file alone): at most 30 frames a second, at most 1.5 device pixels per CSS pixel, sizes read only when the
canvas changes size, what does not move drawn once per size on a canvas of its own, no shadow blur and no filter. It is never
over the chart and never on an order surface. Nothing in the tab rezzes in or flickers when it opens.

## House style V2: smooth where nothing is live (chart 1.39.0)

Anthony, 2026-10-24: "smooth everywhere where possible as far as we can go". The V2 feel (The Desk's, one ease
`cubic-bezier(.22, 1, .36, 1)`) comes to the chart page and the Markup Studio where no live value shows and no order is
asked: menus and popovers fade in as they open, a dialog that asks nothing about orders fades in, the top bar's own buttons
ease their hover and lift 1 px, the PIN card fades in once, the Studio's buttons and tabs ease, and a tab bar's gold ink
slides to the chosen tab (`ChartMotion.syncInk(bar, { key })`, the `.v2-ink` span in motion.css). R3 holds as written above:
no motion on the order ticket, the order bar, Armed, Flatten, the order dialogs (the group entry, Flatten every account,
Order Strategies), the tape, the quote board, the account panels, positions, P&L or the chart. Every control takes its click
on the first frame, while it is still fading or rising in. Each page's V2 rules sit inside
`@media (prefers-reduced-motion: no-preference)` and under `:root:not(.motion-off)`, so the system's reduced motion or the
page's Less motion turns them all off; the ink is then placed at once. `test/v2-theme.test.js` and `npm run smoke:v2` check it.

## Allowed motion: the Agents panel's Drone sky (chart 1.38.0)

The Agents panel (`live/agents-sky.js`, Anthony approved the "Drone sky" concept on 2026-10-23) does not use the kit. It is
one 2D canvas, the panel's own frame loop, and nothing else in the panel moves (its CSS has no transition and no animation):

| what | how | stops |
|---|---|---|
| The background | very faint, slow code rain (digits and signs) and drifting dust, behind everything | as below |
| The drones | a slow hover, a turning lens, a dashed (SHADOW) ring turning | as below |
| A look | the look laser once per new look (a seat's decision, a live agent's LOOK), lighting the bars it crosses | as below |
| A pass, an exit | one pulse ring; the feed line under the canvas types the reason in (a decode effect) | as below |
| A trade | the tether to its entry with a light packet running along it; a stop that moves flashes once where it lands | as below |
| Anthony's entry | his "A" beacon drops onto the price once | as below |

It stops (no frame scheduled at all) while the panel is hidden (another view open over the layout, another panel maximized
over it, scrolled away), and while the window is in the background; the workspace's once-a-second render wakes it when it can
be seen again. At most 30 frames a second; reduced motion (the Windows setting or the page's Less motion) is calm motion: at
most 15 frames a second, everything at about a third of the speed, the feed text at once. The canvas covers whole device pixels
(the chart's 1.37.0 snap). Nothing replays: what the data held when the panel opened is shown as it stands; only its newest act
plays, once.

R3 still holds inside it: the figures (position, open R, today's R, spend, the stop and entry levels) are drawn as they are on
every frame, the moment the page knows them; nothing counts up, eases in or slides to its value. A stop that moves is drawn at
its new price at once (the flash is on top of it, never on the way to it). The panel sends nothing.
`npm run smoke:agents-strip` checks the pace (at most 30 a second, 15 calm), the stops (another view, a panel maximized over
it, the window in the background) and the frame time.

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

`npm run perf:agent` (R5, `test/perf-agent.mjs`): the Agent tab's flowing light (pure CSS, not the kit) and, since 1.23.0, its
grid canvas, while its agent is in a trade over a busy tape, Motion Full and Off taking turns. It holds the chart's gates (a chart's frame p95 under 4 ms, all
charts per frame under 8 ms) and keeps the light's cost (with the grid canvas: Motion Off stops both) to at most 4 ms on the
frame interval p95 over Motion Off's. `npm run smoke:agent-l5` checks the grid canvas's pace (at most 30 frames a second), its
pixel ratio (at most 1.5) and its pauses (Motion Off, reduced motion, the tab closed).

## Keeping it cheap on a big page (the Bot tab)

What the Bot tab learned (`live/bot.css`, `live/bot.js`): a `.motion-atmo` glow under a whole screen is painted again
with every piece that moves over it, so give its `::before` a layer of its own (`will-change: transform`); while a scene
plays, give the moving pieces layers of their own too (a class on the root until the scene's `onDone`), and take them
away at rest; read a canvas's size at a scene's first and last frames only (a layout read in every frame is a forced
layout); and never put a backdrop blur over a live chart.

What the Agent tab's light learned (`live/agent.css`, review of fc3101a): a border light drawn as a conic gradient whose angle
is an animated custom property is painted again every frame over the whole panel, and a blur over it costs more still; turn
a small gradient with a transform instead, inside thin strips that clip it to the border (only their pixels are drawn), and
soften the halo with a mask, not a filter. What Layout 5 learned (1.23.0, perf:agent against main, Motion Full): a gradient on the tab's
own ground (the preview's glow and horizon grid) cost about 10 % of the frames under the moving light, even the glow alone and
even on a layer of its own (worse there); a solid ground cost nothing, and the grid canvas, paused or running, cost nothing
measurable. Fade a colour only on the elements that draw with it: an inherited custom property
in a transition restyles every element under it, every frame; register it as not inherited, or crossfade two copies by
opacity.
