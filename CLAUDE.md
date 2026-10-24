# chart-engine: notes for Claude sessions

- This is Anthony's chart, locked as the charting standard for every project on 2026-09-29.
  `CHART_STYLE.md` is the spec; keep it and the code in step. Do not "improve" the look or the feel
  (the `motion` time constants) unless Anthony asks.
- House style V2 lives in Drive (`claude/design/HOUSE_STYLE_V2.md`, from 2026-10-24, the whole system):
  one dark theme, black and charcoal with gold trim (gold also for the logo, wordmark and active-nav bar;
  no crimson), green/red only for trade sides and P&L, IBM Plex Sans / Condensed / Mono. Candle colours
  stay Anthony's choice (the "Black and gold" preset is optional). Motion is smooth everywhere, but a live
  value is never eased or counted up and no animation delays an order action.
- Anthony's writing style: no em dashes or en dashes in prose (docs, UI copy, commit messages).
- The engine is one dependency-free file, `src/chart-engine.js`, usable as a `<script>` or from Node.
  Keep it that way.
- Before pushing: `npm test` must pass; run `npm run smoke` for anything that touches drawing or input
  and look at the screenshots in `test/out/`.
- Every release: a `CHANGELOG.md` entry, and the version bumped in `package.json` and the file header /
  `VERSION` in `src/chart-engine.js`.
- Sample data (`demo/sample-feed.js`) is fake and must stay labelled as sample data wherever it shows.
- Ask Anthony before anything uncertain; Anthony does not want guessing.
