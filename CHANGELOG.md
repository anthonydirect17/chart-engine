# Changelog

## 1.1.0 (2026-09-29)

Live trading chart, step 1 (watch only), fed by NinjaTrader 8.

- **ChartBridge** (`nt8/ChartBridge.cs`): a NinjaTrader 8 add-on that serves the live page at
  `http://localhost:8765/` and streams, over one local WebSocket, 1-minute history, the session's
  ticks, live trades with exchange timestamps, and your fills (read only). Front month for MNQ, NQ,
  MES and ES is computed from the CME roll rule, with overrides in `config.txt`. Written in C# 5 syntax
  and compile-checked against stand-in types (`npm run check:nt8`). Protocol: `nt8/PROTOCOL.md`.
- **Live page** (`live/`): instrument switcher; 15s, 30s, 1m, 5m, 15m, 1h and range bars with a size
  per instrument; prior-day, overnight and value-area levels; session VWAP; your fills on the chart;
  a delay readout (exchange to NinjaTrader, and NinjaTrader to the chart); glide Smooth / Fast / Off;
  trend lines and price lines saved per instrument; reconnects on its own.
- Engine: `setMotion`, `setPriceFormat`, `setCountdown`, `setMarkers`, drawing tools
  (`setTool('trend' | 'hline')`, `setDrawings`, `getDrawings`, `on('drawings')`, Delete and Escape keys),
  and time labels that work for irregular bars such as range bars.
- `test/fake-bridge.mjs` speaks the same protocol with sample data, so the page is testable without
  NinjaTrader; `npm run smoke:live` drives it in Chromium.

## 1.0.0 (2026-09-29)

First release, extracted from the Chart lab prototype (v0) that Anthony approved on 2026-09-29
("that is such a fantastic chart. Thats what I want to actually trade on").

- The Custom engine from Chart lab, now a reusable module with a public API (`create`, `setBars`,
  `update`, `setLevels`, `setTrades`, `setLayers`, `setTheme`, events). Motion, layout and drawing
  are unchanged from the approved lab.
- Candles default to Carolina blue (bull) and deep purple (bear), per Anthony.
- New Colors panel (`mountThemePanel`): presets, bull / bear / VWAP pickers, saved per browser.
- Trade marks now use the house trade colors: entry by side (green long, red short), connector and
  chip by result (green profit, red loss), so they never depend on the candle colors.
- Text in candle colors (legend change, tags) is lightened or flipped automatically to stay readable.
- Sessions and regular hours are configurable, including 24/7 markets; daily bars get month and date
  labels, for the crypto mid-term charts.
- Lightweight Charts and the engine switch are gone; the lab comparison is decided.
- Unit tests (Node) and a Chromium smoke test.
