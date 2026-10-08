# The kit (ChartKit), version 1

`live/kit.css` and `live/kit.js` are one shared visual kit for Anthony's trading apps: the colours, the type, the
components and the light. Approved by Anthony on 2026-10-08 from three boards (the Agent tab, the trading screen and The
Desk's Today screen). `live/kit.html` is the gallery: every token, the fonts, every component in every state, the three
surfaces side by side, the armed outline, the light in each colour and the refusal on a mock ticket. It sits next to the
motion kit (`docs/MOTION.md`) and follows the same pattern: one file of styles, one of script, no dependencies, no build.

Nothing in this version moves an existing screen onto the kit. Each screen moves over in its own branch.

## Never on order surfaces

The light never goes on the order ticket, the chart's order lines, Flatten or the copier. Rule R3 of `docs/MOTION.md`
holds everywhere: numbers, prices, P&L and buttons never animate or ease. The kit puts no transition and no animation
on a number (`.kit-num`, `.kit-big`), a chip, a tag, a button, a stream row, a tab, a field or a meter; `test/kit.test.js`
reads `kit.css` to make sure. The only things that move are the light's border layers and the decision drawer's slide.
The only things that fade are the light's colour and the panel glow.

## Loading it

| Page | How |
|---|---|
| Chart page and workspace | `<link rel="stylesheet" href="kit.css">` and `<script src="kit.js"></script>`. Both are in `nt8/install-files.json` (with `kit.html`), so the PC updater ships them. |
| The Desk | Vendor `kit.css` and `kit.js` next to the chart files (`public/vendor/chart-engine/`), from the same chart-engine commit, and load them with `<link>` and `<script defer>`. The script sets `window.ChartKit`. From an ES module: `import '/vendor/chart-engine/kit.js'` then use `window.ChartKit`. |
| Markup Studio | `<link rel="stylesheet" href="kit.css">` and `<script src="kit.js">` (the Studio serves `live/`). |
| Node (tests) | `require('./live/kit.js')`. Nothing touches a page at require time. |

Put `class="kit kit-trading"`, `kit kit-desk` or `kit kit-agent` on the root of the screen. Every kit class works only
inside a `.kit` root, so the kit never leaks into the rest of a page.

## Fonts: the hybrid (locked)

| Token | Font | For |
|---|---|---|
| `--kit-head` | Chakra Petch | titles, section labels, tabs, buttons |
| `--kit-body` | IBM Plex Sans | body text |
| `--kit-mono` | JetBrains Mono | every number, with tabular digits (`.kit-num`) |

A page that may load from the internet (The Desk, the Studio) adds this link before `kit.css`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap">
```

A trading PC loads nothing from the internet (`test/offline.test.js`), so the chart page and `kit.html` use
`fonts/plex.css` instead. The stacks fall back cleanly: titles to IBM Plex Sans Condensed, numbers to IBM Plex Mono
(both served by the PC), then Segoe UI or Consolas, then the system's.

## Surfaces

| Class | Where | What changes |
|---|---|---|
| `.kit-trading` | the trading screen | Lines and labels a dim cool grey-blue (lines `rgba(120,146,166,.20)`, hot `#dfe8ef`, body `#b7c6d1`, dim `#7d8fa0`), so the chart's blue candles stay the brightest thing. Cyan only for the light, active states and key buttons. No text glow. 13 px body. |
| `.kit-desk` | The Desk, the Studio (also a plain `.kit`) | Cyan lines (`rgba(93,242,255,.20)`). Glow only on page titles, the active tab and the light. Body text 15 px. |
| `.kit-agent` | the Agent tab | The fuller glow: numbers with `.kit-glow`, the brand name, meters, the drawer title. Lines `rgba(93,242,255,.26)`. 14 px body. |

## Tokens

All on `.kit` (the desk values); the surfaces change only what the table above says. `ChartKit.TOKENS` has the same
values, and `ChartKit.tokens('trading')` gives one surface's set.

| Token | Value | Use |
|---|---|---|
| `--kit-ground` | `#010307` | the page ground, with faint radial glows (cyan blue, and purple on The Desk and the Agent tab) |
| `--kit-panel` | `rgba(0,6,12,.74)` | panels and cards |
| `--kit-drawer-bg` | `rgba(1,5,11,.97)` | the decision drawer |
| `--kit-cyan` | `#5df2ff` | the base colour: the light, active states, key buttons, links |
| `--kit-hot` | `#e8feff` (trading `#dfe8ef`) | hot text: titles, values |
| `--kit-text` | `#c9e7ec` (trading `#b7c6d1`) | body text |
| `--kit-dim` | `#7fb6c0` (trading `#7d8fa0`) | dim labels |
| `--kit-line` | `rgba(93,242,255,.20)` (trading `rgba(120,146,166,.20)`, agent `.26`) | panel lines |
| `--kit-line-soft` | `rgba(93,242,255,.10)` (trading `rgba(120,146,166,.14)`) | row lines inside a panel |
| `--kit-tint` | `rgba(93,242,255,.08)` (trading `rgba(120,146,166,.08)`) | hover and active tint, meter track |
| `--kit-meter` | `#5df2ff` (trading `#7d8fa0`) | a neutral meter |
| `--kit-purple-deep` | `#6d28d9` | accent fills (the chart's locked down candle) |
| `--kit-purple` | `#7b5cff` | accent lines |
| `--kit-purple-soft` | `#b69cff` | accent text (the chart's locked VWAP) |
| `--kit-purple-text` | `#d8ccff` | accent button text, the brand name (the chart's locked drawing colour) |
| `--kit-danger` | `#ff3b5c` | the kill switch and Flatten |
| `--kit-danger-text` | `#ffd0d8` | text on danger |
| `--kit-profit` | `#3ddc97` | money in profit on trading surfaces (the chart's locked `profit`) |
| `--kit-loss` | `#ff7a7a` | money under water on trading surfaces (the chart's locked `loss`) |
| `--kit-profit-text` | `#c9f7e3` | text on a profit chip |
| `--kit-loss-text` | `#ffd6d6` | text on a loss chip |
| `--kit-candle-up` | `#4b9cd3` | up candles (locked) |
| `--kit-candle-down` | `#6d28d9` | down candles (locked) |
| `--kit-sig-screen` | `#5df2ff` | signal: screen, watching |
| `--kit-sig-eyes` | `#8f7bff` | signal: eyes, a look |
| `--kit-sig-judgment` | `#c81fe0` | signal: judgment, a plan |
| `--kit-sig-checks` | `#ffd23f` | signal: checks, the rules |
| `--kit-sig-go` | `#3dff9a` | signal: go, ChartBridge, a fill (in profit on the Agent tab) |
| `--kit-sig-pass` | `#ff8a2a` | signal: passed, caution |
| `--kit-sig-danger` | `#ff3b5c` | signal: danger, a hard no (under water on the Agent tab) |
| `--kit-armed` | `#9b7bff` | the armed glow |
| `--kit-armed-line` | `rgba(155,123,255,.32)` | the armed outline |
| `--kit-off` | `#3a4a55` | a status dot that is off |

Purple and red are accents only: accent buttons, chips and a few text accents (the kill switch and Flatten in red; Add
panel, Reject and Alerts in purple; the brand name in purple).

Every token used as text (`ChartKit.TEXT`) has at least 4.5:1 contrast on the ground, on a panel, and on a panel over
the brightest point of the ground's glow, on all three surfaces (3:1 would do for text 24 px and up; none needs it).
The gallery shows each ratio.

## Components

| Class | What |
|---|---|
| `.kit-panel`, `.kit-panel-head` (a `<b>` title inside), `.kit-panel-body` | a panel and its header |
| `.kit-card`, `.kit-card-head`, `.kit-h` | a card, its header row, its heading |
| `.kit-title`, `.kit-label`, `.kit-brand`, `.kit-glow`, `.kit-hot`, `.kit-dim` | page title, section label, brand name, glowing value (Agent tab), hot and dim text |
| `.kit-num`, `.kit-big` (with `<small>`), `.kit-profit-text`, `.kit-loss-text` | a number (mono, tabular), a big number, money colours |
| `.kit-btn` with `.kit-btn-primary`, `.kit-btn-accent`, `.kit-btn-danger`, `.kit-btn-compact` | buttons: default, primary cyan, accent purple, danger red; 44 px tall, 34 px compact for the dense trading screen. States: hover, `:focus-visible`, `:disabled`, `aria-pressed="true"` (the kill switch on). |
| `.kit-chip` with `.kit-chip-purple`, `.kit-chip-profit`, `.kit-chip-loss`, `.kit-chip-danger`, or a colour class | chips, 11 px mono uppercase |
| `.kit-tag` with a colour class | the small tag on a stream row |
| `.kit-pill` with `.kit-dot` (`.is-off`, `.is-warn`, `.is-bad`) | a status pill with a dot |
| `.kit-tabs` with `.kit-tab` (`aria-selected`, `aria-current="page"` or `.is-on`) | tabs; the active one is cyan |
| `.kit-seg` with buttons (`aria-pressed`) | a segmented switch (the mode) |
| `.kit-rail`, `.kit-rail-brand`, `.kit-rail-item` (`aria-current="page"`) | the side rail |
| `.kit-meter` (with `.kit-meter-purple`, `.kit-meter-profit`) and an `<i style="width:40%">` | meters |
| `.kit-field` on an `<input>` or `<select>` (`.kit-field-compact`, `aria-invalid`) | fields and selects |
| `.kit-steps` with `.kit-step[data-step]` (`screen`, `eyes`, `judgment`, `checks`, `chartbridge`; `.is-done`, `.is-now`), `.kit-step-node`, `.kit-step-name`, `.kit-step-sub` | the step tracker in step colours |
| `button.kit-row` with a colour class (`aria-pressed` when its drawer is open) | a stream row, a real button |
| `.kit-drawer-host`, `.kit-drawer` with a colour class, `.kit-drawer-top`, `.kit-drawer-title`, `.kit-drawer-close`, `.kit-quote`, `.kit-fact` | the decision drawer: slides over its column, outlined in the decision colour, with a Close button |
| `.kit-keys`, `.kit-key` with a colour class (`.kit-key-armed`) | the legend key |
| `.kit-c-screen`, `-cyan`, `-eyes`, `-judgment`, `-checks`, `-go`, `-pass`, `-danger`, `-profit`, `-loss`, `-purple`, `-armed` | colour classes: set `--kit-sig` for chips, tags, keys, rows and the drawer. Never the light's colour. |

For galleries and tests, `.is-hover`, `.is-focus` and `.is-disabled` show those states without a pointer.

## The armed outline

`ChartKit.armed(panel, true)` (or the class `.kit-armed`): a soft, faded, glowing purple outline (border
`rgba(155,123,255,.32)` with a soft outer and inner purple glow), in place of today's solid purple line. It goes with
the light: an armed panel in a trade shows both.

## The light

A slow comet circling a panel's border (a conic gradient on a registered angle, `--kit-ang`, masked to the border), a
blurred halo, and a soft glow on the panel. Its colour is the registered `--kit-pc`; only the light and the panel glow
fade between colours. Paces: `decide` about 13 s a lap, `trade` about 9 s. Pure CSS: no script runs per frame.

**Anthony's rules (enforced by `ChartKit.light`, tested):**

1. Outside the Agent tab (`.kit-agent`) the light runs only while in a trade (`pace: 'trade'`), only around the panel
   showing that trade, and only on its border. Flat means no light at all. (On The Desk: around Today's trades while a
   trade is open.)
2. Never on the order ticket, order lines, Flatten or the copier. These refuse to light, with a console note
   (`ChartKit: no light here. ...`): anything marked `data-no-light` or inside one; anything inside the chart itself
   (`.chart-live`, where the order lines are), a ticket (`.tk`, `tk-*` classes), Flatten (`.ws-flat`) or the copier
   (`.apg-cop-top`, `.apg-cop-g`, `data-copier`); a panel that holds a ticket or the copier; and any button, link,
   field, chip or number. These include every order surface the motion kit refuses (`ChartMotion.NO_MOTION`).
3. R3 holds: the light is a border and a glow. Numbers inside a lit panel never change colour slowly or move.

```js
ChartKit.light(chartPanel, { on: true, color: 'profit', pace: 'trade' });   // true: lit
ChartKit.light(chartPanel, { on: true, color: 'loss', pace: 'trade' });     // the colour fades to red
ChartKit.light(chartPanel, { on: false });                                  // flat: off (never refused)
ChartKit.light(agentPanel, { on: true, color: 'judgment' });                // the Agent tab: deciding
ChartKit.whyNoLight(ticket, 'trade');                                       // the reason, or '' when it may light
```

Colours by name: `screen` (or `cyan`), `eyes`, `judgment`, `checks`, `go`, `pass` (or `caution`), `danger`, `profit`,
`loss`, `armed`; or any `#rrggbb`. On the trading screen and The Desk use `profit` and `loss`, the chart's locked colours.
An unknown colour is refused, never guessed. `light()` writes only what changed, so it is cheap to call on every P&L
update, and it makes the two layers (`.kit-orbit` and `.kit-halo`) once per panel and keeps them. The panel must be
positioned (`.kit-panel` and `.kit-card` are).

## Motion on and off

| Call | What it does |
|---|---|
| `ChartKit.motion()` | `'full'` (the default) or `'off'` |
| `ChartKit.setMotion('full' or 'off')` | the page setting, saved in `localStorage` as `kit-motion-v1` (only `off` is stored); puts `kit-motion-off` on `<html>` |
| `ChartKit.reduced()` | true when the light stands still: the page setting, the motion kit's Less motion (`motion-off` on `<html>`, from `ChartMotion.setReducedMotion`), or the system's reduced motion |

With motion off or reduced motion the orbit stops (a still arc and the glow stay), colours change at once and the drawer
appears without sliding. Every storage call is inside a try: a private window or blocked storage just means the setting
lasts for that page.

## The rest of the API

| Call | What it does |
|---|---|
| `ChartKit.lit(el)` | true while the light is on around it |
| `ChartKit.armed(el, on)` | the armed outline |
| `ChartKit.TOKENS`, `ChartKit.VARIANTS`, `ChartKit.tokens(surface)` | the colours |
| `ChartKit.TEXT` | the tokens used as text, with the smallest size each is used at |
| `ChartKit.COLORS`, `ChartKit.LAP` | the light's colours by name, its seconds per lap |
| `ChartKit.contrast(a, b)`, `ChartKit.over(top, base)`, `ChartKit.parseColor(c)`, `ChartKit.luminance(c)` | WCAG contrast and colour maths |
| `ChartKit.NO_LIGHT`, `ChartKit.HOLDS_ORDERS`, `ChartKit.NOT_A_PANEL` | the selectors the light refuses |
| `ChartKit.create({ document, storage, console, matchMedia })` | a kit on its own page (the tests pass fakes) |

## Tests

`node --test test/kit.test.js` (part of `npm test`): the light's guards (data-no-light, inside a ticket, Flatten, the
copier, a panel holding a ticket; a chart panel in a trade lights; outside the Agent tab only in a trade), the armed
outline with the light, the motion setting with storage that throws, reduced motion, the tokens against the chart's
locked palette (`test/theme.test.js` LOCKED and the engine's `buildTheme()`), contrast for every text token on every
surface, no transition or animation on numbers, chips, buttons and the rest (R3), no em or en dashes, and the files
installed.

`npm run smoke:kit` (Chromium, `test/kit-smoke.mjs` on `live/kit.html`): the gallery loads with no console error and
nothing from the internet; no horizontal scroll at 390, 1366 and 1920 px; the light circles only while lit, at 9 s in a
trade and 13 s deciding, and fades to the locked green and red; reduced motion and motion off stop the orbit and keep the
glow; the light refuses on the mock ticket, a ticket row, Flatten and the copier. Screenshots in `test/out/`:
`kit-gallery-1440.png`, `kit-trading.png`, `kit-desk.png`, `kit-agent.png`, `kit-light-profit.png`, `kit-light-loss.png`,
`kit-armed.png`. With `KIT_WEBFONTS=1` the screenshots load the web fonts first (needs the internet).
